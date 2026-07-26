"""Turn degradation indicators into one health number per asset per day.

Three things happen here, in order, and the order matters.

First the indicator is clamped so it can only get worse. Equipment health slides
one way until somebody repairs it, but real readings jitter, so the raw number
wobbles up and down. The prediction maths downstream assumes a one-directional
slide; if the line bounces, the fit either breaks or produces a slope that means
nothing. The clamp happens AFTER onset detection, never before -- a clamped
series is monotone by construction, and a changepoint detector run on it would
be finding a change the clamp put there.

Then each mode's indicator is mapped onto 0 to 100, where 100 is the value the
asset was commissioned at and 0 is the failure threshold from
app.failure_modes. That mapping is the reason the rationale column in that table
is mandatory: half health means half the distance to a number somebody has
physically justified, and if the threshold is arbitrary then so is every health
score derived from it.

Finally the asset's own health is the MINIMUM across its modes, never the mean.
A chiller with a perfect compressor and a condenser at 10 percent is a chiller
about to fail, and averaging those to 55 describes a machine that does not
exist. Every mode's contribution is kept alongside so the number can always be
explained.

Run with `make health`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from itertools import pairwise

import numpy as np
import pandas as pd
import psycopg
from scipy.optimize import isotonic_regression

from analytics.health.changepoint import Onset, cusum
from analytics.health.modes import FailureMode

log = logging.getLogger("health")

# Health is computed once per day. The indicators arrive every five minutes,
# which is far finer than degradation moves and would make the health line a
# noise plot. A daily median also survives a few hours of missing data without
# the day disappearing.
BUCKET = "1D"

# A day needs at least this many indicator samples before its median is trusted.
# A day represented by three readings taken during a start-up transient is not a
# measurement of that day.
MIN_SAMPLES_PER_BUCKET = 6


@dataclass(frozen=True)
class ModeHealth:
    """One failure mode's daily trajectory on one asset."""

    asset_id: str
    mode: FailureMode
    raw: pd.Series  # daily median of the indicator
    monotonic: pd.Series  # after the one-directional clamp
    health: pd.Series  # 0 to 100
    onset: Onset

    @property
    def mode_id(self) -> str:
        return self.mode.mode_id

    @property
    def final_health(self) -> float:
        return float(self.health.iloc[-1]) if len(self.health) else float("nan")


@dataclass(frozen=True)
class AssetHealth:
    """The roll-up, and everything it was rolled up from."""

    asset_id: str
    health: pd.Series  # minimum across modes, per day
    weakest: pd.Series  # which mode produced that minimum
    modes: list[ModeHealth] = field(default_factory=list)


# ---------------------------------------------------------------------------
# daily aggregation
# ---------------------------------------------------------------------------


def to_daily(series: pd.Series) -> pd.Series:
    """Daily median of an indicator, dropping days with too little evidence."""
    if series.empty:
        return pd.Series(dtype=float)
    grouped = series.resample(BUCKET)
    daily = grouped.median()
    return daily[grouped.size() >= MIN_SAMPLES_PER_BUCKET].dropna()


# ---------------------------------------------------------------------------
# monotonicity
# ---------------------------------------------------------------------------


def enforce_monotonic(
    series: pd.Series, resets: list[datetime] | None = None
) -> pd.Series:
    """Force an indicator to be non-decreasing, resetting at each repair.

    Degradation should only ever get worse until someone fixes the machine. Real
    readings jitter, so wherever a value sits BELOW the one before it, this pulls
    it back up, letting the line flatten but never fall.

    It does that with isotonic regression, which finds the closest possible
    never-decreasing version of a wobbly line in a least-squares sense, rather
    than crudely clamping each point to the running maximum. The difference
    matters: a running maximum lets one bad day set a floor the line can never
    come back under, whereas isotonic regression lets a single outlier be
    outvoted by the days either side of it.

    Applied over the whole window between repairs rather than a rolling one, so
    a noisy first week does not get permanently baked in as the floor.

    Every recorded repair splits the series and each segment is fitted
    independently, because a cleaned condenser genuinely has recovered and
    holding it at its worst-ever value would keep predicting a failure that has
    already been prevented. app.maintenance_events is empty today, so in practice
    there is one segment -- but a health index that silently cannot handle repair
    is wrong in a way that would only surface in production.
    """
    if series.empty:
        return series

    boundaries = sorted(t for t in (resets or []) if series.index[0] < t <= series.index[-1])
    edges = [series.index[0], *boundaries, series.index[-1] + pd.Timedelta(BUCKET)]

    pieces: list[pd.Series] = []
    for start, end in pairwise(edges):
        segment = series[(series.index >= start) & (series.index < end)]
        if segment.empty:
            continue
        fitted = isotonic_regression(segment.to_numpy(dtype=float), increasing=True).x
        pieces.append(pd.Series(fitted, index=segment.index))
    return pd.concat(pieces) if pieces else series


# ---------------------------------------------------------------------------
# the 0 to 100 mapping
# ---------------------------------------------------------------------------


def to_health(excess: pd.Series, threshold: float) -> pd.Series:
    """Map a mode's excess over its commissioned value onto 0 to 100.

    100 where the excess is at or below zero, meaning the mode is no worse than
    when the asset was last called healthy; 0 where it has travelled the whole
    failure threshold from there; linear between. Clamped at both ends, because a
    machine better than new is still just healthy, and a machine past its
    threshold is not more failed than failed -- letting health go negative would
    let one catastrophic mode drag an asset roll-up below the scale.

    The input is an EXCESS, not the raw indicator, and that distinction is what
    makes 100 mean "baseline" rather than "the indicator happens to read zero".
    Residual-based indicators read near zero when healthy anyway, so it changes
    nothing for them. Directly measured ones do not: chilled water at full
    compressor command sits 0.2 K above setpoint on a perfectly healthy machine,
    and scoring that against an absolute zero started the clean run at 90 and
    ended it at 68 with nothing wrong.
    """
    if threshold <= 0:
        raise ValueError("failure threshold must be positive")
    scaled = 100.0 * (1.0 - excess / threshold)
    return scaled.clip(lower=0.0, upper=100.0)


# ---------------------------------------------------------------------------
# per mode
# ---------------------------------------------------------------------------


def mode_health(
    asset_id: str,
    mode: FailureMode,
    indicator: pd.Series,
    reference_end: datetime,
    resets: list[datetime] | None = None,
) -> ModeHealth | None:
    """One mode's full trajectory: daily, onset-detected, centred, clamped, scored.

    The steps are in this order for reasons that each matter.

    Onset detection runs FIRST, on the raw daily series. A clamped series is
    monotone by construction, so a changepoint detector run after the clamp would
    be finding the clamp rather than the fault.

    Centring comes next. The commissioning mean is subtracted so that zero means
    "where this mode was when somebody last called the asset healthy". The
    detector has already computed exactly that number, so it is reused rather
    than recomputed and the two can never disagree about what baseline means.

    The clamp comes last, on the centred series, so health can only fall.
    """
    daily = to_daily(indicator)
    if daily.empty:
        return None

    onset = cusum(daily, reference_end)
    if np.isnan(onset.reference_mean):
        # No usable commissioning window, so there is no baseline to score
        # against and no health number can honestly be produced. Returning None
        # rather than falling back to an assumed zero: an indicator that does not
        # read zero when healthy scored against zero produces a confident wrong
        # answer, which is how the clean chiller first came out at 68 on a mode
        # whose reference window held six days.
        return None

    monotonic = enforce_monotonic(daily - onset.reference_mean, resets)
    return ModeHealth(
        asset_id=asset_id,
        mode=mode,
        raw=daily,
        monotonic=monotonic,
        health=to_health(monotonic, mode.failure_threshold),
        onset=onset,
    )


# ---------------------------------------------------------------------------
# roll-up
# ---------------------------------------------------------------------------


def roll_up(asset_id: str, modes: list[ModeHealth]) -> AssetHealth:
    """Asset health is the weakest mode, never the average.

    A chiller whose compressor is perfect and whose condenser is at 10 is a
    chiller about to fail, and the mean of those two describes a machine that
    does not exist. Taking the minimum also means the roll-up is always
    attributable: there is exactly one mode responsible for the number, and it is
    recorded next to it.

    A mode with no reading on a given day carries its last known value forward
    rather than dropping out of that day's minimum. A mode with nothing to say is
    not a mode saying the asset is healthy: the coil leak indicator is only
    defined while the valve is commanded shut, and letting it vanish on the days
    it cannot be checked made the air handler's roll-up CLIMB from 43 back to 92
    as the weather warmed and the valve stopped closing. Health that recovers
    because a test stopped running is the worst kind of wrong number. Days before
    a mode's first ever reading stay empty, because there is genuinely nothing to
    carry forward yet.
    """
    if not modes:
        empty = pd.Series(dtype=float)
        return AssetHealth(asset_id, empty, pd.Series(dtype=object), [])

    frame = pd.DataFrame({m.mode_id: m.health for m in modes}).sort_index().ffill()
    return AssetHealth(
        asset_id=asset_id,
        health=frame.min(axis=1, skipna=True).dropna(),
        weakest=frame.idxmin(axis=1, skipna=True).dropna(),
        modes=modes,
    )


# ---------------------------------------------------------------------------
# maintenance
# ---------------------------------------------------------------------------


def maintenance_resets(
    conn: psycopg.Connection, asset_id: str, mode_id: str
) -> list[datetime]:
    """Repair times that reset this mode: its own, plus whole-asset overhauls.

    A NULL mode_id in app.maintenance_events is an overhaul and resets
    everything; a specific one resets only itself, because brushing condenser
    tubes should not erase the evidence that a compressor is wearing out.
    """
    rows = conn.execute(
        "SELECT performed_at FROM app.maintenance_events "
        " WHERE asset_id = %s AND (mode_id IS NULL OR mode_id = %s) "
        " ORDER BY performed_at",
        (asset_id, mode_id),
    ).fetchall()
    return [row[0] for row in rows]


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------


def write_health(
    conn: psycopg.Connection, asset: AssetHealth, t_from: datetime, t_to: datetime
) -> int:
    """Replace this asset's health rows over this window, modes and roll-up.

    Deleted and rewritten rather than merged, like every derived table here: the
    rows are a function of the residuals and the config table, so one left behind
    describes a mode or a threshold that may no longer exist.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM app.health_state "
            " WHERE asset_id = %s AND time >= %s AND time < %s",
            (asset.asset_id, t_from, t_to),
        )
        written = 0
        for mode in asset.modes:
            onset = mode.onset.t_onset if mode.onset.detected else None
            for stamp, health in mode.health.items():
                cur.execute(
                    "INSERT INTO app.health_state (time, asset_id, mode_id, "
                    "  indicator_raw, indicator_monotonic, health, t_onset) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (
                        stamp,
                        asset.asset_id,
                        mode.mode_id,
                        _finite(mode.raw.get(stamp)),
                        _finite(mode.monotonic.get(stamp)),
                        round(float(health)),
                        onset,
                    ),
                )
                written += 1

        # The roll-up carries the earliest confirmed onset among its modes: the
        # asset started degrading when the first of its modes did.
        onsets = [m.onset.t_onset for m in asset.modes if m.onset.detected]
        asset_onset = min(onsets) if onsets else None
        for stamp, health in asset.health.items():
            cur.execute(
                "INSERT INTO app.health_state (time, asset_id, mode_id, health, "
                "  t_onset, weakest_mode) VALUES (%s, %s, NULL, %s, %s, %s)",
                (stamp, asset.asset_id, round(float(health)), asset_onset,
                 asset.weakest.get(stamp)),
            )
            written += 1
    return written


def _finite(value: float | None) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return float(value)
