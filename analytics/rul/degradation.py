"""Fit a stochastic degradation process to a confirmed-degrading failure mode.

This is the model the remaining-life estimate is built on. Everything upstream
reduced a machine to one number per failure mode per day; this turns that
sequence into two parameters -- how fast it is going and how erratically -- from
which a distribution over failure dates follows in closed form.

TWO PROCESSES, CHOSEN PER MODE BY THE CONFIG TABLE

A Wiener process with drift is Brownian motion tilted downhill:

    X(t) = x0 + mu*t + sigma*W(t)

mu is the average rate of decay per day and sigma is how far an individual day
strays from that average. Increments over disjoint intervals are independent and
normally distributed, which means a day may move backwards. That is the right
model for an indicator that is a noisy READOUT of a hidden state rather than the
state itself -- excess fan power tells you about bearing wear, but it also tells
you how well the baseline happened to fit today's operating point.

A Gamma process is the alternative for the modes where the physical quantity can
only accumulate: deposit on a condenser tube, dust in a filter, refrigerant that
has left the circuit. Its increments are Gamma-distributed and therefore strictly
positive, so it can never forecast spontaneous recovery. Which one each mode uses
is the degradation_process column of app.failure_modes, not a decision in this
file, for the same reason the thresholds are not in this file.

BOTH ARE FITTED FROM THE SAME TWO STATISTICS, which is worth knowing before
reading further. Total rise over total elapsed time gives the rate; the scaled
sum of squared departures from that rate gives the spread. For the Wiener process
those are mu and sigma directly. For the Gamma process they determine the shape
and scale, because a Gamma process has mean rate shape*scale and variance rate
shape*scale^2. The two models therefore agree exactly on how fast the machine is
degrading and disagree only about the SHAPE of the uncertainty -- which is what
the first-passage calculation in checkpoint 5.2 consumes.

THE PRIOR

mu is also given a prior and updated as data arrives, so early predictions are
pulled toward a defensible default instead of chasing three days of noise. The
prior says: absent any intervention this mode reaches its failure threshold in
about a year. It is deliberately weak -- worth exactly one week of observations --
so that by the time onset is confirmed the data already dominates it.

NO LOOKAHEAD. Everything here is computed from the daily indicator up to an
as-of date and nothing later, including the onset detection and the monotone
clamp, both of which are re-run on the truncated series rather than read back
from storage. A posterior that narrows because the clamp already knew how the
run ended would narrow for no reason.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import psycopg
from scipy.special import gammaln

from analytics.health.changepoint import Onset, cusum
from analytics.health.index import enforce_monotonic
from analytics.health.modes import FailureMode

log = logging.getLogger("rul.degradation")

# The prior on mu is centred on "this mode reaches its failure threshold in one
# year if nobody intervenes". A year rather than an equipment service life
# because the thresholds in app.failure_modes are maintenance triggers, not
# end-of-life: a condenser reaches its cleaning threshold in a season or two,
# not in the twenty-three years ASHRAE gives the chiller around it.
PRIOR_HORIZON_DAYS = 365.0

# How much observation the prior is worth. Seven days, so one week of data has
# the same weight as the prior and a month of data outweighs it four to one.
# Expressed in days rather than as a variance because the natural scale for
# uncertainty about mu is sigma itself, which differs by three orders of
# magnitude across these modes -- a fan power residual in watts against a
# temperature residual in kelvin. Any fixed variance would be a strong prior on
# one mode and a vacuous one on another.
PRIOR_EQUIVALENT_DAYS = 7.0

# Below this many increments neither parameter means anything: sigma estimated
# from a handful of daily steps has a sampling error comparable to itself. This
# is a numerical floor for the fit, NOT the policy on when a prediction may be
# published -- that is checkpoint 5.3's refusal layer, which owns the
# configurable sample minimum.
MIN_INCREMENTS = 10

# How many trailing days the reported current level is taken over. The level is
# the median across this window, not the most recent value, because the most
# recent value is the least reliable point in the whole series: the isotonic clamp
# has no data after it to outvote it with, so a single excursion lands there at
# full size. app.failure_modes summaries already use a trailing median for the
# same reason. Seven days is long enough that one bad day cannot move it and short
# enough that the level still tracks a fault developing over weeks.
LEVEL_WINDOW_DAYS = 7

# Floor on the fitted spread, so a mode whose clamped series is perfectly flat
# cannot divide by zero on its way to an infinitely confident prediction.
MIN_SIGMA = 1e-9

SECONDS_PER_DAY = 86400.0


# ---------------------------------------------------------------------------
# what was observed, as of a date
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Observation:
    """One mode's history on one asset as it looked on a given day.

    Deliberately carries the failed cases too -- an empty post-onset series with
    an undetected onset is a legitimate value here. The refusal layer needs to
    say WHICH precondition failed, and it cannot do that if this returns None.
    """

    asset_id: str
    mode: FailureMode
    as_of: datetime
    raw: pd.Series  # daily indicator up to as_of, unmodified
    monotonic: pd.Series  # centred on the commissioning mean, then clamped
    post_onset: pd.Series  # the clamped series from onset forward
    onset: Onset
    window_days: float  # how long we have been watching, in days

    @property
    def confirmed(self) -> bool:
        return self.onset.detected and len(self.post_onset) > 1


def observe(
    asset_id: str,
    mode: FailureMode,
    raw_daily: pd.Series,
    reference_end: datetime,
    as_of: datetime,
    resets: list[datetime] | None = None,
    onset: Onset | None = None,
) -> Observation:
    """Replay the health pipeline using only data up to as_of.

    Truncates the daily indicator at as_of and then redoes, on that truncated
    series alone, both steps that checkpoint 4.4 performs: detect whether
    degradation has been confirmed, and clamp the series so it cannot un-happen.

    Both are recomputed rather than read back from app.health_state on purpose.
    The stored versions were produced over the whole run, so the clamp at day 20
    already reflects what happened on day 100. Fitting a trend to that and
    reporting that the trend got more certain over time would be measuring the
    clamp's foreknowledge, not the accumulation of evidence.

    An already-confirmed onset can be passed in, and then it is used rather than
    re-detected. Once a change has been confirmed it stays confirmed: a live system
    does not un-declare a fault, or quietly slide the date it started, because a
    week later the cumulative sum would have preferred a different day. Measured
    over these runs the detector's estimate is in fact stable once it fires, so
    this changes no number here -- it removes the possibility.

    The post-onset window starts at the later of the confirmed onset and the most
    recent repair, because a condenser cleaned after it started fouling is
    fouling again from the cleaning, not from the original onset.
    """
    observed = raw_daily[raw_daily.index <= as_of].dropna().sort_index()
    if observed.empty:
        return Observation(
            asset_id, mode, as_of, observed, observed, observed,
            Onset(False, None, None, float("nan"), float("nan"), 0.0, 0), 0.0,
        )

    window_days = (observed.index[-1] - observed.index[0]).total_seconds() / SECONDS_PER_DAY
    if onset is None:
        onset = cusum(observed, reference_end)
    if np.isnan(onset.reference_mean) or not onset.detected:
        empty = pd.Series(dtype=float)
        return Observation(
            asset_id, mode, as_of, observed, empty, empty, onset, window_days
        )

    past = [t for t in (resets or []) if t <= as_of]
    monotonic = enforce_monotonic(observed - onset.reference_mean, past)
    start = max([onset.t_onset, *past]) if past else onset.t_onset
    return Observation(
        asset_id=asset_id,
        mode=mode,
        as_of=as_of,
        raw=observed,
        monotonic=monotonic,
        post_onset=monotonic[monotonic.index >= start],
        onset=onset,
        window_days=window_days,
    )


# ---------------------------------------------------------------------------
# the sufficient statistics both processes share
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Increments:
    """Day-to-day steps of the post-onset series, and the totals they sum to."""

    x0: float  # where the indicator sat at onset
    t0: datetime  # when onset was confirmed to have begun
    t_last: datetime
    x_last: float
    steps: np.ndarray  # change in the indicator, per interval
    spans: np.ndarray  # length of each interval, in days

    @property
    def count(self) -> int:
        return len(self.steps)

    @property
    def total_days(self) -> float:
        return float(self.spans.sum())

    @property
    def total_rise(self) -> float:
        return float(self.steps.sum())

    @property
    def zero_fraction(self) -> float:
        """Share of intervals where the clamp held the value exactly flat."""
        return float((self.steps == 0.0).mean()) if self.count else float("nan")


def increments(series: pd.Series) -> Increments | None:
    """Split a post-onset series into its steps. None if there is nothing to fit.

    Intervals are measured in days rather than assumed to be one day apart,
    because a day whose indicator had too few samples was dropped by the health
    index and leaves a two-day gap. Treating that gap as one step would say the
    machine moved twice as fast that day.
    """
    clean = series.dropna().sort_index()
    if len(clean) < MIN_INCREMENTS + 1:
        return None
    stamps = clean.index.to_numpy()
    spans = np.diff(stamps).astype("timedelta64[s]").astype(float) / SECONDS_PER_DAY
    if not np.all(spans > 0):
        return None
    return Increments(
        x0=float(clean.iloc[0]),
        t0=clean.index[0].to_pydatetime(),
        t_last=clean.index[-1].to_pydatetime(),
        x_last=float(clean.iloc[-1]),
        steps=np.diff(clean.to_numpy(dtype=float)),
        spans=spans,
    )


def trailing_level(series: pd.Series) -> float:
    """Where the indicator is now: the median over the trailing week.

    A robust reading of the present state rather than the newest number. See
    fit_degradation for why the newest number is the wrong one to use.
    """
    clean = series.dropna().sort_index()
    if clean.empty:
        return float("nan")
    cutoff = clean.index[-1] - pd.Timedelta(days=LEVEL_WINDOW_DAYS)
    window = clean[clean.index > cutoff]
    return float((window if len(window) else clean.tail(1)).median())


def moments(inc: Increments) -> tuple[float, float]:
    """The rate and the spread, by maximum likelihood for the Wiener process.

    The rate is total rise divided by total elapsed days. For a Wiener process
    that IS the maximum likelihood estimate of mu, and it depends only on the two
    endpoints -- every path between them is equally likely, so the days in the
    middle carry no information about the drift. That is a property of the model
    worth being aware of: it makes the rate robust to a single bad day and blind
    to the shape of the trajectory.

    The spread is the average squared departure from that rate, each interval
    divided by its own length because a two-day step is expected to stray twice
    as far as a one-day step. Unlike the rate, this uses every point.
    """
    rate = inc.total_rise / inc.total_days if inc.total_days > 0 else 0.0
    departures = inc.steps - rate * inc.spans
    variance = float(np.mean(departures**2 / inc.spans))
    return rate, max(np.sqrt(variance), MIN_SIGMA)


# ---------------------------------------------------------------------------
# the two processes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProcessFit:
    """A fitted degradation process, in whichever of the two forms was declared.

    mu and sigma are always populated and always mean the same thing -- rate per
    day and one-day spread -- so the estimator downstream can read them without
    branching. shape and scale are the Gamma process's own parameters and are
    None for a Wiener fit.
    """

    process: str  # "wiener" or "gamma"
    mu: float  # rate, in indicator units per day
    sigma: float  # spread of a one-day increment
    shape: float | None  # Gamma process shape, per day
    scale: float | None  # Gamma process scale, in indicator units
    log_likelihood: float
    increments: Increments
    fallback_reason: str | None = None  # set when gamma was declared but refused

    @property
    def samples(self) -> int:
        return self.increments.count

    @property
    def total_days(self) -> float:
        return self.increments.total_days


def fit_wiener(inc: Increments) -> ProcessFit:
    """Maximum likelihood fit of Brownian motion with drift to the increments."""
    mu, sigma = moments(inc)
    departures = inc.steps - mu * inc.spans
    log_likelihood = float(
        -0.5 * np.sum(np.log(2.0 * np.pi * sigma**2 * inc.spans))
        - np.sum(departures**2 / (2.0 * sigma**2 * inc.spans))
    )
    return ProcessFit("wiener", mu, sigma, None, None, log_likelihood, inc)


def fit_gamma(inc: Increments) -> ProcessFit:
    """Fit a Gamma process by moments, or fall back to Wiener if it cannot hold.

    A Gamma process has mean rate shape*scale and one-day variance shape*scale^2,
    so the two statistics computed above pin both parameters down: the scale is
    the variance divided by the rate, and the shape is what is left over. This is
    a method-of-moments fit and not maximum likelihood, deliberately. The
    likelihood cannot be used here because the monotone clamp produces intervals
    that are EXACTLY zero, and the Gamma density at zero is either zero or
    infinite depending on the shape -- the likelihood is not merely hard to
    maximise, it is degenerate. Dropping the flat intervals to rescue the
    likelihood would drop the evidence that the machine stopped moving, which is
    precisely the evidence that ought to widen a prediction.

    A Gamma process cannot represent a mode that is not rising, so a
    non-positive rate falls back to Wiener with the reason recorded rather than
    silently reporting parameters that do not exist.
    """
    mu, sigma = moments(inc)
    if mu <= 0.0:
        fit = fit_wiener(inc)
        return ProcessFit(
            "wiener", fit.mu, fit.sigma, None, None, fit.log_likelihood, inc,
            fallback_reason="declared gamma, but the post-onset rate is not positive",
        )

    scale = sigma**2 / mu
    shape = mu / scale
    # Reported for comparability with the Wiener fit, over the positive intervals
    # only, with the count of intervals it had to leave out stated alongside.
    positive = inc.steps > 0
    log_likelihood = float("nan")
    if positive.any():
        y = inc.steps[positive]
        a = shape * inc.spans[positive]
        log_likelihood = float(
            np.sum(
                (a - 1.0) * np.log(y)
                - y / scale
                - gammaln(a)
                - a * np.log(scale)
            )
        )
    return ProcessFit("gamma", mu, sigma, shape, scale, log_likelihood, inc)


def fit_process(inc: Increments, process: str) -> ProcessFit:
    """Fit whichever process app.failure_modes declared for this mode."""
    if process == "gamma":
        return fit_gamma(inc)
    if process == "wiener":
        return fit_wiener(inc)
    raise ValueError(f"unknown degradation process {process!r}")


# ---------------------------------------------------------------------------
# the prior and its update
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Posterior:
    """Belief about the degradation rate after seeing the data."""

    mean: float
    sd: float
    prior_mean: float
    prior_sd: float
    evidence_days: float  # elapsed post-onset time the update was given
    precision: float  # 1 / sd^2, the quantity that actually accumulates

    @property
    def relative_sd(self) -> float:
        return self.sd / self.mean if self.mean else float("inf")

    @property
    def z(self) -> float:
        """How many posterior standard deviations the rate sits above zero.

        The number checkpoint 5.3 refuses on: a rate the model cannot separate
        from no degradation at all must not become a failure date.
        """
        return self.mean / self.sd if self.sd > 0 else float("inf")


@dataclass(frozen=True)
class Anchor:
    """Everything that is decided ONCE, when degradation is first confirmed.

    A prior that is re-derived from each day's data is not a prior, and a process
    whose shape is re-chosen every day is not one process. Both are fixed here, at
    the first moment a fit becomes possible, and then carried forward unchanged
    while the belief about the rate is updated against them. That is what makes
    the accumulated precision -- and therefore the narrowing of the interval -- a
    property of the model rather than an accident of refitting.

    It is also how a live system behaves. You confirm degradation, you record what
    you believed at that moment, and from then on you update. You do not go back
    and revise the starting point every time a day passes.
    """

    onset: Onset
    prior_mean: float
    prior_sd: float
    sigma: float  # the process spread, one number for one process
    shape: float | None  # Gamma process shape, fixed at confirmation
    sigma_floor: float  # smallest spread the data was allowed to claim


def prior_rate(threshold: float) -> float:
    """Prior mean rate: this mode reaches its threshold in about a year.

    A year rather than an equipment service life, because the thresholds in
    app.failure_modes are maintenance triggers and not end-of-life -- a condenser
    reaches its cleaning threshold in a season or two, not in the twenty-three
    years ASHRAE gives the chiller around it.
    """
    return threshold / PRIOR_HORIZON_DAYS


def anchor_at(
    mode: FailureMode, onset: Onset, fit: ProcessFit
) -> Anchor:
    """Fix the prior and the process shape from the first fittable window.

    The prior WIDTH is the fitted spread over the square root of
    PRIOR_EQUIVALENT_DAYS, which makes the prior worth exactly that many days of
    observation whatever the mode is measured in -- a fan power residual in watts
    and a temperature residual in kelvin differ by three orders of magnitude here,
    and no fixed variance could be weak for both.

    Two earlier versions of this were wrong and both are worth recording. Scaling
    the width by the COMMISSIONING spread instead made the prior worth
    PRIOR_EQUIVALENT_DAYS times the ratio of the two spreads squared, which on a
    fast fault whose degradation is far noisier than its healthy baseline came to
    several thousand days: the bypass leakage fault measured at 0.438 kW/ton per
    day was dragged back to 0.021, a factor of twenty-one, by a prior claiming the
    machine would take a year to fail. Scaling it by the fitted spread but
    RE-DERIVING it at every point in time was the other error -- it makes the
    starting point of the update move, so the interval can widen even though more
    evidence has arrived.

    The spread is floored at the commissioning spread, and that floor is the
    honest part of the whole file. The monotone clamp upstream removes real
    variance: measured over these runs it deflates the day-to-day spread by
    between 2.9 and 61 times. A day cannot truthfully claim to be quieter than the
    same indicator was on the same equipment when nobody thought anything was
    wrong, so it is not allowed to. Without the floor a perfectly flat clamped
    series reports zero spread, and the belief about its rate collapses onto the
    prior mean with unbounded confidence: on the second chiller of the bypass run
    that produced a rate ten million standard deviations from zero out of a series
    that had not moved at all.
    """
    floor = max(onset.reference_sigma, MIN_SIGMA)
    if not np.isfinite(floor):
        floor = MIN_SIGMA
    spread = max(fit.sigma, floor)
    return Anchor(
        onset=onset,
        prior_mean=prior_rate(mode.failure_threshold),
        prior_sd=spread / np.sqrt(PRIOR_EQUIVALENT_DAYS),
        sigma=spread,
        shape=fit.shape,
        sigma_floor=floor,
    )


def update_wiener(fit: ProcessFit, anchor: Anchor) -> Posterior:
    """Sequential conjugate normal update of the drift, one day at a time.

    Each day's increment is a noisy observation of the rate: expected value the
    rate times the length of the interval, variance the spread squared times that
    length. A normal prior updated by a normal observation gives a normal
    posterior, so the entire history collapses into two running numbers -- a mean
    and a precision, precision being one over the variance.

    The loop is the point. Each day ADDS its own precision to the total and
    nothing is ever recomputed from scratch. Every term added is positive, so the
    total can only grow and the standard deviation can only fall. The belief about
    the rate therefore narrows as the run goes on by construction, not because the
    data happened to cooperate. Written as a loop rather than the closed form it
    collapses to, because the accumulation IS the claim being made.

    The spread comes from the anchor and is the same number every day, because a
    Wiener process has one spread. Two rejected alternatives, both of which I built
    and measured first:

    Re-estimating the spread on the whole window at every point in time is the
    honest batch answer but it is not an update. On an accelerating fault the
    spread grows faster than the extra days shrink it, and the standard deviation
    of the rate went 0.0074, then 0.0032, then back up to 0.0053 on the coil valve
    leak. Those numbers are not wrong about the data -- they say the trajectory got
    more erratic -- they are just three unrelated fits printed in a row.

    Re-estimating it from the data available at each STEP is worse, and it is worth
    saying why because it looks more principled than it is. The first increment has
    no scatter of its own, so its spread falls to the floor, which is small; a
    small spread means an enormous weight; and the whole estimate ends up pinned to
    day one. On the bypass leakage fault that dragged a measured 0.438 kW/ton per
    day down to 0.054, because day one got roughly eight hundred times the weight
    of day thirty.

    The spread is plugged in rather than given its own prior. With thirty or more
    daily increments its sampling error is around one over the square root of twice
    that, near thirteen percent, small beside the uncertainty in the rate at the
    same point. The real cost is different and worth stating plainly: the spread is
    fixed from the FIRST fittable window, so if the trajectory later turns out to
    be much noisier than its opening weeks, the interval in checkpoint 5.2 is too
    narrow by that factor. The current-window maximum-likelihood spread is reported
    alongside so the gap is visible rather than buried.
    """
    inc = fit.increments
    mean = anchor.prior_mean
    precision = 1.0 / anchor.prior_sd**2
    variance = anchor.sigma**2
    for step, span in zip(inc.steps, inc.spans, strict=True):
        weight = span / variance
        mean = (precision * mean + step / variance) / (precision + weight)
        precision += weight

    return Posterior(
        mean=mean,
        sd=float(1.0 / np.sqrt(precision)),
        prior_mean=anchor.prior_mean,
        prior_sd=anchor.prior_sd,
        evidence_days=inc.total_days,
        precision=float(precision),
    )


def update_gamma(fit: ProcessFit, anchor: Anchor) -> Posterior:
    """Conjugate inverse-gamma update of the Gamma process scale.

    With the shape held at the value fixed when degradation was confirmed, the
    only unknown is the scale, and the conjugate prior for a Gamma scale is an
    inverse gamma. The update is as plain as it gets: the first parameter gains
    the shape times the elapsed days, the second gains the total rise. Both only
    ever increase, which is where the narrowing comes from. The rate is the shape
    times the scale, so the belief about the rate follows from the belief about the
    scale.

    The prior parameters are placed so that this posterior's MEAN is arithmetically
    identical to the Wiener one -- the prior acts as PRIOR_EQUIVALENT_DAYS of
    pseudo-observation during which the indicator rose at the prior rate, and the
    answer is the total rise over the total time including those days. Switching a
    mode's declared process therefore changes the SHAPE of the uncertainty and not
    its strength or its centre, which is what makes the two genuinely comparable
    alternatives rather than two different amounts of optimism. What differs is the
    spread, and in checkpoint 5.2 the first-passage law that spread feeds.

    The relative spread is one over the square root of the accumulated first
    parameter, which falls as the run goes on. It is reported as infinite until
    that parameter clears two, because an inverse gamma has no finite variance
    below there and a number would be a fiction.
    """
    if anchor.shape is None or anchor.shape <= 0.0:
        return update_wiener(fit, anchor)

    inc = fit.increments
    shape = anchor.shape
    # a0 and b0 chosen so the posterior mean below reduces exactly to
    # (prior rise over the pseudo-days + observed rise) / (pseudo-days + observed
    # days), matching the Wiener update term for term.
    a_n = shape * (PRIOR_EQUIVALENT_DAYS + inc.total_days) + 1.0
    b_n = anchor.prior_mean * PRIOR_EQUIVALENT_DAYS + inc.total_rise

    mean = shape * b_n / (a_n - 1.0)
    relative = 1.0 / np.sqrt(a_n - 2.0) if a_n > 2.0 else float("inf")
    return Posterior(
        mean=mean,
        sd=mean * relative,
        prior_mean=anchor.prior_mean,
        prior_sd=anchor.prior_sd,
        evidence_days=inc.total_days,
        precision=float(a_n),
    )


def update(fit: ProcessFit, anchor: Anchor) -> Posterior:
    if fit.process == "gamma":
        return update_gamma(fit, anchor)
    return update_wiener(fit, anchor)


# ---------------------------------------------------------------------------
# the whole thing, per mode
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Degradation:
    """A fitted degradation model for one mode on one asset as of one date."""

    asset_id: str
    mode: FailureMode
    as_of: datetime
    observation: Observation
    fit: ProcessFit
    posterior: Posterior
    anchor: Anchor
    level: float  # how far the indicator has travelled from its commissioned value

    @property
    def mode_id(self) -> str:
        return self.mode.mode_id

    @property
    def remaining(self) -> float:
        """How much of the threshold is left to travel. Negative once past it."""
        return self.mode.failure_threshold - self.level


def fit_degradation(
    observation: Observation,
    anchor: Anchor | None = None,
    level_floor: float | None = None,
) -> Degradation | None:
    """Fit and update in one step. None when there is nothing fittable yet.

    Pass the anchor from an earlier point in time to continue an existing belief;
    leave it out and one is created from this window, which is what happens at the
    first moment a fit becomes possible.

    THE CURRENT LEVEL IS NOT THE LAST VALUE, and getting that wrong cost two
    rounds of wrong answers here.

    The monotone clamp upstream is a BATCH smoother: isotonic regression fits the
    whole window at once and revises its own earlier points when new data arrives,
    so the value it reports for the most recent day is not a non-decreasing
    function of how much data it has been shown. Read one date at a time that gave
    a mode whose distance to threshold went 28.1, then -46.6, then +30.1 over three
    consecutive weeks -- a machine that failed and then unfailed. Holding the level
    at its running maximum fixes the direction and breaks something else: the last
    point of an isotonic fit is the least reliable point in it, because there is no
    later data to outvote an excursion sitting there, so the running maximum
    promptly locked in a 257 watt transient on a fan whose threshold is 89 and
    declared it failed for the rest of the run.

    So the level is the MEDIAN over the trailing LEVEL_WINDOW_DAYS of the clamped
    series, and then held at its running maximum. The median cannot be moved by one
    excursion; the running maximum keeps the premise of the clamp, which is that
    degradation does not un-happen. Both are needed and neither is sufficient.

    Returns None only for the arithmetic reasons -- no confirmed onset, or too few
    post-onset steps for a rate and a spread to mean anything. It does NOT judge
    whether the answer is good enough to publish; that judgement, and the specific
    reason to give a user instead of a number, is checkpoint 5.3.
    """
    if not observation.confirmed:
        return None
    inc = increments(observation.post_onset)
    if inc is None:
        return None
    fit = fit_process(inc, observation.mode.degradation_process)
    used = anchor or anchor_at(observation.mode, observation.onset, fit)
    level = trailing_level(observation.post_onset)
    if level_floor is not None:
        level = max(level, level_floor)
    return Degradation(
        asset_id=observation.asset_id,
        mode=observation.mode,
        as_of=observation.as_of,
        observation=observation,
        fit=fit,
        posterior=update(fit, used),
        anchor=used,
        level=level,
    )


def replay(
    asset_id: str,
    mode: FailureMode,
    raw_daily: pd.Series,
    reference_end: datetime,
    as_ofs: list[datetime],
    resets: list[datetime] | None = None,
) -> list[Degradation | None]:
    """Walk forward through time, updating one belief rather than refitting many.

    This is the difference between "posterior updating as new data arrives" and
    "three separate fits printed next to each other". The onset, the prior and the
    Gamma shape are settled at the first point where a fit is possible and then
    carried; only the evidence accumulates. Every entry therefore sees strictly
    more data than the one before it and strictly more accumulated precision, so
    the interval cannot widen.

    The highest level reached so far is carried too, so the reported distance to
    the threshold only ever closes. See fit_degradation for why that is necessary
    and not merely tidy.

    Entries before degradation is confirmed come back as None, in order, so the
    caller can see when the model started having anything to say.
    """
    anchor: Anchor | None = None
    level_floor: float | None = None
    out: list[Degradation | None] = []
    for as_of in as_ofs:
        observation = observe(
            asset_id,
            mode,
            raw_daily,
            reference_end,
            as_of,
            resets,
            onset=anchor.onset if anchor else None,
        )
        entry = fit_degradation(observation, anchor, level_floor)
        if entry is not None:
            if anchor is None:
                anchor = entry.anchor
            level_floor = entry.level
        out.append(entry)
    return out


# ---------------------------------------------------------------------------
# reading the daily indicator back
# ---------------------------------------------------------------------------


def load_daily_indicator(
    conn: psycopg.Connection,
    asset_id: str,
    mode_id: str,
    t_from: datetime,
    t_to: datetime,
) -> pd.Series:
    """The raw daily indicator the health index stored, for one mode and window.

    Reads indicator_raw and not indicator_monotonic. The clamped column is a
    function of the whole run, so replaying an as-of date against it would leak
    the end of the run into the beginning; the raw daily median is a statistic of
    its own day and nothing else.
    """
    rows = conn.execute(
        "SELECT time, indicator_raw FROM app.health_state "
        " WHERE asset_id = %s AND mode_id = %s AND time >= %s AND time < %s "
        "   AND indicator_raw IS NOT NULL "
        " ORDER BY time",
        (asset_id, mode_id, t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.Series(dtype=float)
    frame = pd.DataFrame(rows, columns=["time", "value"])
    return pd.Series(
        frame["value"].to_numpy(dtype=float),
        index=pd.DatetimeIndex(frame["time"]),
    )


def snapshots(t_from: datetime, t_to: datetime, count: int = 3) -> list[datetime]:
    """Evenly spaced as-of dates across a window, ending at its last day.

    Used to replay a run: the same model refitted at several points in time to
    show what it would have said then. The last snapshot is the end of the window
    rather than one step short of it, so the final answer is the one the run
    actually supports.
    """
    span = (t_to - t_from).total_seconds() / SECONDS_PER_DAY
    fractions = [(i + 1) / count for i in range(count)]
    return [t_from + timedelta(days=span * f) for f in fractions]
