"""Running rules over a time series, with APAR's transient suppression.

The rules assume steady state. An air handler is not in steady state for the
first hour after it starts, nor for the first hour after the economizer hands
over to mechanical cooling -- during those the mixing box, the coil and the duct
are all still settling, and mass and energy do not balance across them. Rules
evaluated there do not detect faults; they detect the changeover.

NISTIR 7365 handles this four ways, and all four are implemented here:

    1. an exponentially weighted moving average of every input, rather than the
       raw sample, so a single noisy reading cannot trip a rule
    2. the average is RESET at every mode switch, so the new mode's average never
       carries a memory of the old mode's conditions
    3. a delay at the start of occupancy, and a second delay after every mode
       switch, during which no rule is evaluated at all
    4. a minimum time the condition must hold before the fault is reported

Without these the rules fire at every economizer changeover, which is the single
most common reason air handler fault detection gets switched off by the people
who have to answer the alarms.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from rdflib import Graph

from analytics.rules.mode import Mode
from analytics.rules.registry import (
    Reading,
    RegisteredRule,
    RuleStatus,
    evaluate_rule,
    rules_for_class,
)

# ---------------------------------------------------------------------------
# APAR's suppression parameters, from the reference implementation
# ---------------------------------------------------------------------------

OCCUPANCY_DELAY_MINUTES = 90  # occ_dly
MODE_SWITCH_DELAY_MINUTES = 60  # mode_dly
RULE_DELAY_MINUTES = 60  # rule_dly

# EWMA smoothing constant. NISTIR 7365 publishes lambda = 0.1, applied once per
# control scan. A building automation scan is of the order of a minute, while
# this data arrives every five, so using 0.1 directly would smooth over five
# times as much wall-clock time as intended. The constant is converted instead
# to preserve the time constant: a per-minute 0.1 leaves 0.9 of the old average
# after a minute, so after five minutes it leaves 0.9^5, and the equivalent
# per-sample constant is one minus that.
EWMA_LAMBDA_PER_MINUTE = 0.1


def lambda_for_interval(interval_s: int) -> float:
    """Convert the published per-minute smoothing constant to this cadence."""
    minutes = interval_s / 60.0
    return 1.0 - (1.0 - EWMA_LAMBDA_PER_MINUTE) ** minutes


def ewma_with_resets(values: pd.Series, lam: float, reset: pd.Series) -> pd.Series:
    """Exponentially weighted moving average, restarted wherever reset is true.

    A plain moving average carries the old mode's conditions across a changeover
    and takes several samples to forget them, which is exactly the interval the
    suppression delays are trying to protect. Restarting the average at the
    switch means the first sample of a new mode IS the average, and it grows a
    memory from there.

    Written as an explicit loop rather than pandas' own ewm because that has no
    notion of a reset, and segmenting the series to apply it piecewise costs more
    than the loop saves.
    """
    raw = values.to_numpy(dtype="float64")
    flags = reset.to_numpy(dtype=bool)
    out = np.empty_like(raw)
    running = np.nan
    for i in range(raw.size):
        sample = raw[i]
        if flags[i] or not np.isfinite(running) or not np.isfinite(sample):
            running = sample
        else:
            running = sample * lam + running * (1.0 - lam)
        out[i] = running
    return pd.Series(out, index=values.index, name=values.name)


@dataclass(frozen=True)
class Suppression:
    """Which instants are quiet enough for a steady-state rule to be believed."""

    evaluable: pd.Series  # bool per instant
    since_occupied: pd.Series  # minutes
    since_mode_switch: pd.Series  # minutes


def suppression_mask(
    modes: pd.Series, interval_s: int, off_state: str = Mode.UNOCCUPIED.value
) -> Suppression:
    """Work out where rules may be evaluated at all.

    Whether the machine is running is taken from the mode itself: anything other
    than `off_state` means it is. Both clocks restart together when it starts,
    because starting is also a mode switch, and the longer of the two delays is
    what actually governs there.

    `off_state` is a parameter rather than a constant so the same suppression
    applies to equipment with no notion of occupancy. An air handler is off when
    nobody is in the building; a chiller is off when it is not running. The
    settling physics is identical -- neither machine is in balance for the first
    hour after it starts -- so the machinery is shared and only the name of the
    idle state differs.
    """
    step_minutes = interval_s / 60.0
    occupied = modes != off_state

    # Minutes since the current occupied block began.
    block = (occupied != occupied.shift()).cumsum()
    since_occupied = occupied.groupby(block).cumcount() * step_minutes
    since_occupied = since_occupied.where(occupied, 0.0)

    # Minutes since the mode last changed.
    switched = modes != modes.shift()
    switch_block = switched.cumsum()
    since_switch = modes.groupby(switch_block).cumcount() * step_minutes

    evaluable = (
        occupied
        & (since_occupied >= OCCUPANCY_DELAY_MINUTES)
        & (since_switch >= MODE_SWITCH_DELAY_MINUTES)
        & (modes != Mode.UNKNOWN.value)
    )
    return Suppression(evaluable, since_occupied, since_switch)


def smooth_inputs(
    values: pd.DataFrame, points: Sequence[str], modes: pd.Series, interval_s: int
) -> pd.DataFrame:
    """Average every input the rules read, resetting at each mode switch."""
    lam = lambda_for_interval(interval_s)
    switched = modes != modes.shift()
    switched.iloc[0] = True
    return pd.DataFrame(
        {
            point: ewma_with_resets(values[point], lam, switched)
            for point in points
            if point in values.columns
        },
        index=values.index,
    )


def run_rules(
    graph: Graph,
    asset_id: str,
    brick_class: str,
    values: pd.DataFrame,
    quality: pd.DataFrame,
    flags: pd.DataFrame,
    modes: pd.Series,
    points: Sequence[str],
    interval_s: int = 300,
    off_state: str = Mode.UNOCCUPIED.value,
) -> pd.DataFrame:
    """Evaluate every applicable rule at every instant that is quiet enough.

    Returns one row per rule per evaluated instant, before the persistence
    requirement is applied. Quality and flags come from the RAW readings, not the
    smoothed ones -- an average of a value nobody trusts is still untrustworthy,
    and the quality layer scored the samples, not the average.
    """
    applicable: list[RegisteredRule] = rules_for_class(graph, brick_class)
    if not applicable:
        return pd.DataFrame()

    suppression = suppression_mask(modes, interval_s, off_state)
    smoothed = smooth_inputs(values, points, modes, interval_s)

    # Pull everything into plain arrays once. Building a dict of readings per
    # instant out of DataFrame lookups is the difference between seconds and
    # tens of minutes across a year.
    columns = [p for p in points if p in smoothed.columns]
    smooth_arrays = {p: smoothed[p].to_numpy() for p in columns}
    quality_arrays = {
        p: (quality[p].to_numpy() if p in quality.columns else np.full(len(values), np.nan))
        for p in columns
    }
    flag_arrays = {
        p: (flags[p].to_numpy() if p in flags.columns else np.full(len(values), None))
        for p in columns
    }

    stamps = values.index
    mode_values = modes.to_numpy()
    evaluable = suppression.evaluable.to_numpy()

    records: list[dict] = []
    for i in np.flatnonzero(evaluable):
        readings = {
            point: Reading(
                value=None if np.isnan(smooth_arrays[point][i]) else float(smooth_arrays[point][i]),
                quality=(
                    None
                    if not np.isfinite(quality_arrays[point][i])
                    else int(quality_arrays[point][i])
                ),
                flags=flag_arrays[point][i] if isinstance(flag_arrays[point][i], dict) else None,
            )
            for point in columns
        }
        stamp = stamps[i]
        mode = mode_values[i]
        for registered in applicable:
            outcome = evaluate_rule(registered, asset_id, stamp, readings, mode)
            if outcome.status is RuleStatus.MODE_NOT_APPLICABLE:
                continue
            records.append(
                {
                    "at": stamp,
                    "rule_id": outcome.rule_id,
                    "mode": mode,
                    "status": outcome.status.value,
                    "fired": outcome.fired,
                    "severity": outcome.severity,
                    "cost_amount": outcome.cost.amount if outcome.cost else None,
                    "cost_unit": outcome.cost.unit.value if outcome.cost else None,
                    "detail": outcome.detail,
                }
            )
    return pd.DataFrame.from_records(records)


def sustained(outcomes: pd.DataFrame, interval_s: int = 300) -> pd.DataFrame:
    """Keep only firings that held continuously for APAR's rule delay.

    A rule that is briefly true during a gust or a setpoint change is not a
    fault. Each rule's firings are grouped into unbroken stretches and a stretch
    is reported only once it has lasted rule_dly.

    Note that a stretch is broken by any evaluated instant where the rule did not
    fire, but NOT by the gaps where evaluation was suppressed -- a fault does not
    stop existing because the unit changed mode, and requiring an hour of
    uninterrupted evaluated samples would mean almost nothing ever qualified.
    """
    if outcomes.empty:
        return outcomes.assign(reported=[])

    needed = RULE_DELAY_MINUTES * 60 // interval_s
    out = []
    for rule_id, group in outcomes.sort_values("at").groupby("rule_id", sort=False):
        fired = group["fired"].to_numpy()
        block = np.cumsum(~fired)
        held = pd.Series(fired).groupby(block).cumsum().to_numpy()
        marked = group.copy()
        marked["consecutive"] = held
        marked["reported"] = fired & (held >= needed)
        marked["rule_id"] = rule_id
        out.append(marked)
    return pd.concat(out).sort_values("at")


def episodes(reported: pd.DataFrame) -> pd.DataFrame:
    """Collapse sustained firings into one row per continuous fault episode."""
    if reported.empty or not reported["reported"].any():
        return pd.DataFrame(columns=["rule_id", "t_from", "t_to", "samples", "peak_severity"])
    rows = []
    for rule_id, group in reported[reported["reported"]].groupby("rule_id", sort=False):
        group = group.sort_values("at")
        gaps = group["at"].diff() > pd.Timedelta(hours=6)
        for _, episode in group.groupby(gaps.cumsum()):
            rows.append(
                {
                    "rule_id": rule_id,
                    "t_from": episode["at"].iloc[0],
                    "t_to": episode["at"].iloc[-1],
                    "samples": len(episode),
                    "peak_severity": episode["severity"].max(),
                }
            )
    return pd.DataFrame(rows).sort_values(["rule_id", "t_from"])
