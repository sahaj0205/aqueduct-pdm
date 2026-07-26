"""Decide whether a remaining-life estimate is worth publishing, and say why not.

Every layer below this one will produce a number if you ask it to. The fitter will
fit a rate to noise, the estimator will turn that rate into a confident-looking
date, and nothing in either of them is capable of declining. This module is the
only place in the project that says no.

That matters more than it sounds. A maintenance team that receives a failure date
will act on it -- order a part, book a crew, take a machine offline. A date derived
from a machine that is not actually degrading costs exactly as much as a real one
and buys nothing, and after a few of those nobody believes any of the dates. So the
question this module asks is not "can a number be computed" but "is there enough
evidence that stating it is better than admitting we do not know".

Four conditions, checked in this order, first one wins:

  1. No confirmed onset. Nothing may be projected before a changepoint detector
     has established that something changed. A trend fitted to a flat noisy line
     still has a slope, and that slope still yields a date.
  2. Too few observations since onset. A rate and a spread from a handful of days
     have sampling errors comparable to themselves.
  3. The rate cannot be told apart from zero. This is the one that does the real
     work here -- see below.
  4. The interval is wider than we have been watching. If forty days of
     observation produce a window three hundred days wide, the window is not an
     answer; the observation itself was more informative.

The order is not arbitrary: each condition presupposes the ones above it. Asking
whether a rate is significant is meaningless if no change has been confirmed, and
asking whether an interval is too wide is meaningless if there is no interval.

WHY THE THIRD ONE MATTERS MOST. Two known false alarms come into this layer from
upstream, and both are caught here and nowhere else. The changepoint detector fires
twice on chillers with nothing wrong with them, because a baseline fitted in May
leaves a small systematic residual by September and a small sustained shift is
exactly what a cumulative sum is built to find. And the monotone clamp holds the
air handler's fan indicator at a level its recent readings no longer support, so
the health index shows a fan that has degraded and stopped. Both produce a rate
whose belief straddles zero. Neither is filtered by counting samples or by
inspecting the interval; both are filtered by asking whether the machine is
measurably moving at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from analytics.health.changepoint import MIN_REFERENCE_SAMPLES
from analytics.rul.degradation import Degradation, Observation
from analytics.rul.estimator import RulEstimate

log = logging.getLogger("rul.refusal")

# The single code every refusal carries, so a consumer can branch on "did we get a
# prediction" without enumerating reasons, and then read the reason for the detail.
INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True)
class Policy:
    """The thresholds a prediction has to clear. Configurable, with defaults.

    min_post_onset_samples is 21 rather than the 200 the checkpoint suggests, and
    the change is deliberate. 200 was written for a rate that samples faster than
    this pipeline does: the indicators arrive every five minutes but the health
    index aggregates them to one value per day, because degradation does not move
    on a five-minute timescale and a daily median survives a few hours of missing
    data. No run in this dataset is longer than 117 days, so a 200-sample minimum
    could never be satisfied by any asset and would refuse every prediction the
    system will ever make -- which is a refusal layer that has stopped being a
    layer and become an off switch. 21 daily observations is chosen to match
    COMMISSIONING_DAYS, the window the baselines are fitted on and the changepoint
    detector takes its reference from: we require as much evidence that a machine
    is failing as we required to establish what healthy looked like in the first
    place. Counted in observations rather than elapsed days on purpose, so a
    fortnight with half its days missing does not qualify.

    significance_z is 1.96, the two-sided 95 percent normal cutoff. A one-sided
    test would be 1.645 and would be defensible, since every indicator in this
    project is written so that only upward movement is degradation. The stricter of
    the two is used because this is a gate on speaking, and the cost of staying
    quiet about a real fault for another week is far below the cost of a confident
    wrong date.

    max_width_ratio compares the P10-to-P90 span against how long the asset has
    been observed. At 1.0 an interval may be at most as wide as the observation
    behind it.
    """

    min_post_onset_samples: int = 21
    significance_z: float = 1.96
    max_width_ratio: float = 1.0


DEFAULT_POLICY = Policy()


@dataclass(frozen=True)
class Refusal:
    """Why no number was produced. Carries the numbers that produced the decision."""

    code: str
    reason: str  # stable slug, safe to branch on
    detail: str  # one sentence for a human, with the figures in it

    def __str__(self) -> str:
        return f"{self.reason}: {self.detail}"


@dataclass(frozen=True)
class Verdict:
    """The published answer for one mode on one asset at one date, or the refusal.

    Exactly one of `estimate` and `refusal` is set. Both are kept on the same object
    rather than returning a union, because a consumer almost always wants to render
    one or the other in the same place -- the interval, or the sentence explaining
    its absence.

    `withheld` carries the estimate that WOULD have been published, when one was
    computed and then refused. It exists so a refusal can be audited rather than
    taken on trust: somebody asking "what were you going to say?" gets an answer,
    and the before-and-after comparison that shows this layer earning its place is
    computable. Nothing downstream may render it as a prediction.
    """

    asset_id: str
    mode_id: str
    as_of: object
    estimate: RulEstimate | None
    refusal: Refusal | None
    withheld: RulEstimate | None = None

    @property
    def published(self) -> bool:
        return self.estimate is not None

    @property
    def either(self) -> RulEstimate | None:
        """The estimate whether or not it was published. Audit use only."""
        return self.estimate if self.estimate is not None else self.withheld

    @property
    def reason(self) -> str:
        return "published" if self.refusal is None else self.refusal.reason


def _refuse(
    observation: Observation,
    mode_id: str,
    reason: str,
    detail: str,
    withheld: RulEstimate | None = None,
) -> Verdict:
    return Verdict(
        asset_id=observation.asset_id,
        mode_id=mode_id,
        as_of=observation.as_of,
        estimate=None,
        refusal=Refusal(INSUFFICIENT_EVIDENCE, reason, detail),
        withheld=withheld,
    )


def adjudicate(
    observation: Observation,
    degradation: Degradation | None,
    estimate: RulEstimate | None,
    policy: Policy = DEFAULT_POLICY,
) -> Verdict:
    """Publish the estimate, or refuse it with the specific reason and figures.

    Takes all three layers' outputs because each condition needs a different one:
    onset lives on the observation, the sample count and the rate on the fitted
    degradation, and the interval on the estimate. Passing them separately rather
    than reaching through one to another keeps this module a pure decision with no
    ability to recompute anything and quietly disagree with what was stored.
    """
    mode_id = observation.mode.mode_id

    # ---- 1. has anything been confirmed to have changed? -------------------
    onset = observation.onset
    if onset.reference_sigma != onset.reference_sigma:  # NaN
        return _refuse(
            observation, mode_id, "no_commissioning_reference",
            f"only {onset.samples} daily values of this indicator exist so far, "
            f"against the {MIN_REFERENCE_SAMPLES} the commissioning window needs "
            f"before it can say what healthy looks like -- with no baseline mean "
            f"there is nothing to measure a change against and no spread to judge "
            f"its size by",
        )
    if not onset.detected:
        return _refuse(
            observation, mode_id, "onset_not_confirmed",
            f"the cumulative-sum detector has not confirmed a change: it reached "
            f"{onset.peak_statistic:.2f} of its decision interval over "
            f"{onset.samples} days, and nothing is projected forward until it "
            f"passes 1.00",
        )

    # ---- 2. is there enough of it? -----------------------------------------
    available = len(observation.post_onset)
    if degradation is None:
        return _refuse(
            observation, mode_id, "too_few_samples",
            f"degradation was confirmed but only {available} daily observations "
            f"have accumulated since, too few to estimate a rate and a spread at "
            f"all (minimum {policy.min_post_onset_samples})",
        )
    samples = degradation.fit.samples
    if samples < policy.min_post_onset_samples:
        return _refuse(
            observation, mode_id, "too_few_samples",
            f"{samples} daily observations since onset, against a minimum of "
            f"{policy.min_post_onset_samples} -- the same three weeks the "
            f"baselines and the changepoint reference are built from",
        )

    # ---- 3. is the machine measurably moving? ------------------------------
    post = degradation.posterior
    if post.z < policy.significance_z:
        return _refuse(
            observation, mode_id, "drift_not_significant",
            f"the degradation rate is {post.mean:.5g} plus or minus {post.sd:.5g} "
            f"{degradation.mode.indicator_unit} per day, which is {post.z:.2f} "
            f"standard deviations from zero and so cannot be told apart from a "
            f"machine that is not degrading at all (needs "
            f"{policy.significance_z:.2f})",
            withheld=estimate,
        )

    # ---- 4. is the answer narrower than the question? ---------------------
    if estimate is None:
        return _refuse(
            observation, mode_id, "no_interval",
            "the rate is significant but no first-passage interval could be "
            "computed, which should not happen and is a defect if it does",
        )
    observed = observation.window_days
    if estimate.width is None:
        bound = "no upper bound at all" if estimate.p90 is None else "unbounded"
        return _refuse(
            observation, mode_id, "interval_wider_than_observation",
            f"the interval has {bound}: there is a "
            f"{(1.0 - estimate.reachability) * 100:.1f} percent chance this mode "
            f"never reaches its threshold, so the ninetieth percentile of the "
            f"failure date does not exist",
            withheld=estimate,
        )
    if estimate.width > policy.max_width_ratio * observed:
        return _refuse(
            observation, mode_id, "interval_wider_than_observation",
            f"the P10 to P90 span is {estimate.width:.0f} days after watching this "
            f"asset for {observed:.0f}, so the prediction is vaguer than the "
            f"observation behind it and saying nothing is more informative",
            withheld=estimate,
        )

    return Verdict(
        asset_id=observation.asset_id,
        mode_id=mode_id,
        as_of=observation.as_of,
        estimate=estimate,
        refusal=None,
    )


def published(verdicts: list[Verdict]) -> list[RulEstimate]:
    """Just the estimates that cleared the policy.

    What the asset roll-up must be computed over. Rolling up across refused modes
    is how the air handler ended checkpoint 5.2 reporting that it had already
    failed, on the strength of a fan indicator whose rate sat half a standard
    deviation from zero.
    """
    return [v.estimate for v in verdicts if v.estimate is not None]
