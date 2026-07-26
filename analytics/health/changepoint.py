"""Detect when degradation actually started, per failure mode.

This exists to stop the remaining-life layer answering questions it has no
business answering. Fit a trend to a flat noisy line and you will get a slope,
and from that slope a confident date on which the equipment will fail. That
number is worse than no number, because it looks like an answer. So nothing
projects a trend until a changepoint has been confirmed here.

The method is a tabular CUSUM: a running total of how far the indicator has sat
above where it used to sit, which ignores excursions that cancel out and adds up
ones that do not. It is used rather than a threshold on the indicator itself
because the whole difficulty is that early degradation is SMALLER than the
noise. A single day half a degree high means nothing; thirty consecutive days
half a degree high is a machine that has changed, and a cumulative sum is what
separates those two cases.

CUSUM signals late by construction -- it has to accumulate evidence before it can
be sure -- so the moment it crosses is NOT the estimate of when the change began.
Both are reported: the crossing is when we knew, the last time the sum sat at
zero is when it started.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd

# Slack, in standard deviations of the reference period. The CUSUM ignores drift
# smaller than this, which is what stops it accumulating on ordinary noise. Half
# a standard deviation is the textbook value and is chosen to detect a sustained
# shift of one standard deviation quickly.
SLACK_SIGMA = 0.5

# Decision interval, in standard deviations. Crossing it declares a change. With
# a slack of 0.5, the standard tabular CUSUM design gives an in-control average
# run length of roughly 465 samples at 5.0 -- meaning on an asset that is not
# degrading, a false onset is expected about once every 465 days of daily
# samples. Chosen from that false-alarm property, not from how well it separates
# any scenario in this project.
DECISION_SIGMA = 5.0

# Floor on the reference spread, so a mode whose indicator is exactly constant
# during commissioning cannot make every later sample an infinite deviation.
MIN_SIGMA = 1e-6

# Reference statistics need enough days to mean anything. Below this the onset
# is reported as undetectable rather than guessed at.
MIN_REFERENCE_SAMPLES = 7


@dataclass(frozen=True)
class Onset:
    """What the detector concluded about one mode on one asset."""

    detected: bool
    t_onset: datetime | None  # estimated start of the change
    t_confirmed: datetime | None  # when the CUSUM crossed its decision interval
    reference_mean: float
    reference_sigma: float
    peak_statistic: float  # highest the sum reached, in decision intervals
    samples: int

    @property
    def confirmation_lag_days(self) -> float | None:
        """How long the detector took to be sure, after the change it estimates."""
        if self.t_onset is None or self.t_confirmed is None:
            return None
        return (self.t_confirmed - self.t_onset).total_seconds() / 86400.0


def cusum(
    series: pd.Series,
    reference_end: datetime,
    slack_sigma: float = SLACK_SIGMA,
    decision_sigma: float = DECISION_SIGMA,
) -> Onset:
    """One-sided upper CUSUM on an indicator series.

    Upper-sided only, because every indicator in app.failure_modes is written so
    that larger is worse. An indicator falling below where it started is a
    machine getting better than commissioned, which is not degradation and is not
    what this is looking for.

    The reference period is the commissioning window at the start of the run, the
    same window the baselines were fitted on. Its mean is what the indicator is
    compared against and its spread sets the scale, so the question the detector
    asks is "has this drifted away from where it was when somebody last called it
    healthy", which is the question maintenance actually cares about.

    Walks the series accumulating max(0, previous + deviation - slack). The
    running total stays pinned at zero while the indicator behaves and climbs
    once it does not. When it passes the decision interval a change is declared,
    and the change is estimated to have begun at the last sample where the total
    was still zero -- the point the evidence started accumulating from.
    """
    clean = series.dropna().sort_index()
    reference = clean[clean.index < reference_end]
    if len(reference) < MIN_REFERENCE_SAMPLES:
        return Onset(False, None, None, float("nan"), float("nan"), 0.0, len(clean))

    mean = float(reference.mean())
    sigma = max(float(reference.std(ddof=1)), MIN_SIGMA)
    slack = slack_sigma * sigma
    decision = decision_sigma * sigma

    values = clean.to_numpy(dtype=float)
    total = 0.0
    last_zero = 0
    peak = 0.0
    crossed: int | None = None
    onset_index: int | None = None

    for i, value in enumerate(values):
        total = max(0.0, total + (value - mean) - slack)
        if total == 0.0:
            last_zero = i
        peak = max(peak, total)
        if crossed is None and total > decision:
            crossed = i
            onset_index = last_zero

    return Onset(
        detected=crossed is not None,
        t_onset=None if onset_index is None else clean.index[onset_index].to_pydatetime(),
        t_confirmed=None if crossed is None else clean.index[crossed].to_pydatetime(),
        reference_mean=mean,
        reference_sigma=sigma,
        peak_statistic=peak / decision if decision > 0 else float("inf"),
        samples=len(clean),
    )


def cusum_track(
    series: pd.Series, reference_end: datetime, slack_sigma: float = SLACK_SIGMA
) -> pd.Series:
    """The running CUSUM itself, in decision intervals, for plotting.

    Separate from cusum() so the detector stays a small readable loop and the
    diagnostic view costs nothing when nobody is looking at it.
    """
    clean = series.dropna().sort_index()
    reference = clean[clean.index < reference_end]
    if len(reference) < MIN_REFERENCE_SAMPLES:
        return pd.Series(dtype=float)

    mean = float(reference.mean())
    sigma = max(float(reference.std(ddof=1)), MIN_SIGMA)
    slack = slack_sigma * sigma

    totals = np.empty(len(clean))
    total = 0.0
    for i, value in enumerate(clean.to_numpy(dtype=float)):
        total = max(0.0, total + (value - mean) - slack)
        totals[i] = total
    return pd.Series(totals / (DECISION_SIGMA * sigma), index=clean.index)
