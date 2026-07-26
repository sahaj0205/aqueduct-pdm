"""Run every scenario through the whole detection path and record what fired, when.

This is the "end to end" half of the harness. Nothing here reads the answer key and
nothing here is told which runs are faulted: every window gets identical treatment,
and the labels are attached afterwards in validation/metrics.py. That separation is
not cosmetic -- a harness that branched on `is_fault_free` while detecting would be
able to flatter itself, and no amount of care in the metric functions could undo it.

WHAT COUNTS AS A DETECTION, AND WHY IT IS RECOMPUTED RATHER THAN READ BACK

Two detectors reach an operator in this project, and both are re-run here:

  RULE FIRINGS -- the six APAR air-side rules and the three chiller performance
  rules, after the sustain filter that requires a condition to hold for an hour
  before it is reported. Nothing persists these, so they have to be recomputed.

  CONFIRMED DEGRADATION -- a failure mode whose changepoint detector has confirmed
  that its indicator left the commissioning baseline. app.health_state does persist
  these, but it stores only the ESTIMATED onset: the changepoint detector looks
  back and says "this began on the 3rd", and that retrospective date is what the
  health page shows. An operator did not learn anything on the 3rd. They learned
  when the cumulative-sum statistic crossed its decision interval, which is days
  later and is not written down anywhere. Scoring lead time against the estimated
  onset would credit this system with warning it never gave, so the health layer is
  re-run and the CONFIRMATION instant is used instead.

WHAT IS DELIBERATELY NOT COUNTED

The data-quality layer raises its own advisories -- a sensor stuck at one value, a
reading outside its physical envelope, a point that has gone silent. Those are not
equipment-fault detections and they are not scored here in either direction, for or
against. `groundtruth.fault_events` contains no labels for instrument failure, so
there is nothing to score them against, and folding them into the false-alarm rate
would charge the fault detector for findings that were correct about a different
question.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import psycopg

REPO_ROOT = Path(__file__).resolve().parents[1]
for extra in (REPO_ROOT, REPO_ROOT / "scripts"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

# Imported from scripts/ on purpose. `chiller_state` is the definition of "this
# machine is running" that checkpoint 3.4 verified the chiller rules against -- status
# on, real power draw and real flow, all three, because the status point alone reads 1
# all year on chiller 1. `load_window` is the join that brings the plant supply-air
# setpoint alongside one chiller's own points, which the capacity rule needs. Copying
# either into this file would create a second definition free to drift from the one
# the rules were shown to work with, and the harness would then be scoring something
# subtly different from what the project ships.
from run_chiller_rules import CHILLERS, OFF, chiller_state, load_window

from analytics.baselines.fit import (
    RUNS,
    asset_classes,
    commissioning_window,
)
from analytics.health.index import maintenance_resets, mode_health
from analytics.health.modes import (
    indicators_for_asset,
    load_failure_modes,
    modes_for_class,
)
from analytics.rules import apar, chiller  # noqa: F401 - importing registers them
from analytics.rules.apar import POINTS_USED
from analytics.rules.chiller import points_used
from analytics.rules.evaluate import (
    episodes,
    run_rules,
    suppression_mask,
    sustained,
)
from analytics.rules.mode import SIGNALS, classify_frame
from analytics.rules.readings import (
    effective_quality_frame,
    load_asset_readings,
    signal_frames,
)
from analytics.rules.registry import registered_rules

RULE = "rule"
FAILURE_MODE = "failure_mode"

# The LBNL fault-free year, evaluated alongside the eight synthesised runs.
#
# This window is the most valuable false-alarm evidence in the project and the least
# like the rest of it: 365 days of real measured output from LBNL's fault-free
# reference simulation, with nothing synthesised into it and no trajectory imposed on
# it. A rule that fires here is firing on a building that was working.
#
# It carries one asymmetry that has to be stated wherever its numbers appear. The
# health layer is only run over the eight scenario windows, so this year is scored
# for RULE firings only and contributes no confirmed-degradation detections. Fixing
# that would mean declaring a commissioning window inside 2018 and adding the year to
# the run list, which changes what the health layer has computed rather than measuring
# it, so the asymmetry is reported instead.
LBNL_YEAR = (
    "lbnl-fault-free-year",
    ("ahu-1", *CHILLERS),
    "2018-01-01T06:00:00+00:00",
    "2019-01-01T06:00:00+00:00",
)

RULES_ONLY = frozenset({LBNL_YEAR[0]})


@dataclass(frozen=True)
class Window:
    """One evaluation window: a run of the plant, and which assets have data in it."""

    scenario_id: str
    assets: tuple[str, ...]
    t_from: datetime
    t_to: datetime

    @property
    def days(self) -> int:
        return (self.t_to - self.t_from).days


def windows() -> list[Window]:
    """Every window the harness evaluates, in calendar order."""
    out = [
        Window(label, tuple(assets), datetime.fromisoformat(a), datetime.fromisoformat(b))
        for label, assets, a, b in (LBNL_YEAR, *RUNS)
    ]
    return sorted(out, key=lambda w: w.t_from)


@dataclass(frozen=True)
class Finding:
    """One thing the platform said about one asset in one run.

    A finding is the unit an operator disposes of: "the cooling coil valve has been
    saturating" is one finding whether it saturated on nine separate afternoons or
    one continuous fortnight. `active_days` keeps the day-level detail underneath,
    because the detection metrics are scored per asset-day and the false-alarm rate
    needs both -- how many things landed in the inbox, and how much of the calendar
    they covered.
    """

    scenario_id: str
    asset_id: str
    source: str
    fault_id: str
    title: str
    first_seen: datetime
    active_days: frozenset[date]
    episodes: int
    peak_severity: float
    detail: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.scenario_id, self.asset_id, self.fault_id)


def _rule_titles() -> dict[str, str]:
    return {r.rule_id: r.description for r in registered_rules()}


def _days_covered(t_from: pd.Timestamp, t_to: pd.Timestamp) -> set[date]:
    """Every calendar day an episode touches, inclusive of both ends."""
    return {
        stamp.date()
        for stamp in pd.date_range(t_from.normalize(), t_to.normalize(), freq="1D")
    }


def _findings_from_episodes(
    scenario_id: str, asset_id: str, found: pd.DataFrame, titles: dict[str, str]
) -> list[Finding]:
    """Collapse one asset's rule episodes into one finding per rule."""
    out: list[Finding] = []
    for rule_id, group in found.groupby("rule_id", sort=True):
        days: set[date] = set()
        for row in group.itertuples(index=False):
            days |= _days_covered(row.t_from, row.t_to)
        out.append(
            Finding(
                scenario_id=scenario_id, asset_id=asset_id, source=RULE,
                fault_id=str(rule_id), title=titles.get(str(rule_id), str(rule_id)),
                first_seen=group["t_from"].min().to_pydatetime(),
                active_days=frozenset(days), episodes=len(group),
                peak_severity=float(group["peak_severity"].max()),
                detail=(
                    f"{len(group)} sustained episodes over {len(days)} days, "
                    f"{int(group['samples'].sum())} reported samples, peak severity "
                    f"{group['peak_severity'].max():.2f}"
                ),
            )
        )
    return out


def _evaluable_days(evaluable: pd.Series) -> frozenset[date]:
    """Days on which the rule engine was willing to judge at least one instant.

    The denominator of every per-asset-day figure in the report, and the reason it
    is this rather than "days with readings". A chiller that never started is not
    a chiller that was correctly found healthy -- the rules skipped every instant
    of it, so there was no opportunity to raise a false alarm and crediting the day
    as a correct silence is padding. One of the three chillers in this plant runs
    about one percent of the year, and counting its idle days would have added over
    seven hundred free true negatives to the matrix.
    """
    marked = evaluable[evaluable]
    return frozenset(stamp.date() for stamp in marked.index)


def ahu_rule_findings(
    conn: psycopg.Connection, graph, window: Window
) -> tuple[list[Finding], dict[str, frozenset[date]]]:
    """The six APAR rules over the air handler, gated on operating mode."""
    if "ahu-1" not in window.assets:
        return [], {}
    values, quality, flags = load_asset_readings(
        conn, "ahu-1", window.t_from, window.t_to
    )
    if values.empty:
        return [], {}
    signals, signal_quality, signal_flags = signal_frames(
        values, quality, flags, SIGNALS
    )
    modes = classify_frame(
        signals, effective_quality_frame(signal_quality, signal_flags)
    )
    reported = sustained(
        run_rules(
            graph, "ahu-1", "brick:AHU", values, quality, flags, modes, POINTS_USED
        )
    )
    findings = _findings_from_episodes(
        window.scenario_id, "ahu-1", episodes(reported), _rule_titles()
    )
    return findings, {"ahu-1": _evaluable_days(suppression_mask(modes, 300).evaluable)}


def chiller_rule_findings(
    conn: psycopg.Connection, graph, window: Window
) -> tuple[list[Finding], dict[str, frozenset[date]]]:
    """The three chiller performance rules, per chiller, gated on running state."""
    titles = _rule_titles()
    out: list[Finding] = []
    evaluable: dict[str, frozenset[date]] = {}
    for asset in CHILLERS:
        if asset not in window.assets:
            continue
        loaded = load_window(conn, asset, window.t_from, window.t_to)
        if loaded is None:
            continue
        values, quality, flags = loaded
        state = chiller_state(values, asset)
        reported = sustained(
            run_rules(
                graph, asset, "brick:Chiller", values, quality, flags, state,
                points_used(asset), off_state=OFF,
            )
        )
        out += _findings_from_episodes(
            window.scenario_id, asset, episodes(reported), titles
        )
        evaluable[asset] = _evaluable_days(
            suppression_mask(state, 300, OFF).evaluable
        )
    return out, evaluable


def degradation_findings(
    conn: psycopg.Connection, window: Window, modes, classes: dict[str, str]
) -> tuple[list[Finding], dict[str, frozenset[date]]]:
    """Failure modes whose degradation the changepoint detector confirmed in this run.

    Rebuilds each mode's daily health trajectory from the measurements, exactly as
    the health layer does, and keeps the modes where the cumulative-sum statistic
    crossed its decision interval. The finding starts at that CONFIRMATION instant,
    not at the estimated onset the detector attributes the change to -- see the
    module docstring -- and runs to the end of the window over every day the mode's
    health sits below full, which is the same "still open" test the advisory queue
    applies.
    """
    if window.scenario_id in RULES_ONLY:
        return [], {}
    _, reference_end = commissioning_window(window.t_from)
    out: list[Finding] = []
    scored: dict[str, set[date]] = {}
    for asset_id in window.assets:
        if asset_id not in classes:
            continue
        series, _skipped = indicators_for_asset(
            conn, asset_id, classes[asset_id], modes, window.t_from, window.t_to
        )
        for mode in modes_for_class(modes, classes[asset_id]):
            indicator = series.get(mode.mode_id)
            if indicator is None or indicator.empty:
                continue
            built = mode_health(
                asset_id, mode, indicator, reference_end,
                maintenance_resets(conn, asset_id, mode.mode_id),
            )
            if built is None:
                continue
            # Every day this mode produced a health number is a day the degradation
            # detector had something to say and chose not to raise it, so it belongs
            # in the denominator whether or not an onset was confirmed.
            scored.setdefault(asset_id, set()).update(
                stamp.date() for stamp in built.health.index
            )
            if not built.onset.detected:
                continue
            confirmed = built.onset.t_confirmed
            open_days = {
                stamp.date()
                for stamp, value in built.health.items()
                if stamp.to_pydatetime() >= confirmed and value < 100.0
            }
            if not open_days:
                continue
            out.append(
                Finding(
                    scenario_id=window.scenario_id, asset_id=asset_id,
                    source=FAILURE_MODE, fault_id=mode.mode_id,
                    title=mode.mode_name, first_seen=confirmed,
                    active_days=frozenset(open_days), episodes=1,
                    peak_severity=(100.0 - float(built.health.min())) / 100.0,
                    detail=(
                        f"degradation confirmed {confirmed:%Y-%m-%d}, "
                        f"{built.onset.confirmation_lag_days:.1f} days after the "
                        f"change it attributes to "
                        f"{built.onset.t_onset:%Y-%m-%d}; health falls to "
                        f"{built.health.min():.0f} over {len(open_days)} open days"
                    ),
                )
            )
    return out, {a: frozenset(d) for a, d in scored.items()}


def observed_days(
    conn: psycopg.Connection, window: Window
) -> dict[str, frozenset[date]]:
    """Per asset, the calendar days this run holds readings for.

    Not the denominator -- that is `_evaluable_days` -- but reported next to it, so
    the gap between "days of data" and "days a detector was willing to judge" is
    visible rather than buried. On the chiller plant that gap is most of the year.

    Reads the hourly rollup rather than the raw hypertable: the question is which
    days exist, one row per point per hour answers it, and at the five-minute cadence
    the same query scans twelve times as much for the same answer.
    """
    rows = conn.execute(
        """
        SELECT p.asset_id, (h.bucket AT TIME ZONE 'UTC')::date AS day
          FROM app.measurements_hourly h
          JOIN app.points p ON p.point_id = h.point_id
         WHERE p.asset_id = ANY(%(assets)s)
           AND h.bucket >= %(t_from)s AND h.bucket < %(t_to)s
           AND h.sample_count > 0
         GROUP BY 1, 2
        """,
        {
            "assets": list(window.assets),
            "t_from": window.t_from,
            "t_to": window.t_to,
        },
    ).fetchall()
    out: dict[str, set[date]] = {}
    for asset_id, day in rows:
        out.setdefault(asset_id, set()).add(day)
    return {a: frozenset(d) for a, d in out.items()}


def sample_count(conn: psycopg.Connection, window: Window) -> int:
    """How many readings one point of this run actually holds.

    Exists to cross-check the severity-level reconstruction. The severity-1 boundary
    is found by replaying the simulator's seeded progress curve on a rebuilt copy of
    the timestamp grid it was originally evaluated on, and the whole reconstruction
    rests on that grid having the same length as the real one. A silent mismatch
    would move every rung crossing by however far the lengths differed, so the count
    is measured and printed next to the reconstructed one rather than assumed.

    Widened by a day at each end on purpose. The run list states each window at
    midnight UTC, but the source timestamps carry a fixed six-hour offset, so a run
    declared as 25 February to 24 June actually holds readings from 06:00 on the
    first day to 05:55 on the day after the last. Counting strictly inside the
    declared window loses the final 72 samples and reports a mismatch that is an
    artefact of where the window was cut, not of the reconstruction. Widening is safe
    because the scenario eras are whole years apart, so no neighbouring run can be
    pulled in.
    """
    row = conn.execute(
        """
        SELECT count(*)
          FROM app.measurements m
         WHERE m.point_id = (
                 SELECT min(point_id) FROM app.points WHERE asset_id = %(asset)s
               )
           AND m.time >= %(t_from)s - INTERVAL '1 day'
           AND m.time <  %(t_to)s   + INTERVAL '1 day'
        """,
        {"asset": window.assets[0], "t_from": window.t_from, "t_to": window.t_to},
    ).fetchone()
    return int(row[0]) if row else 0


def _merge(
    into: dict[str, set[date]], more: dict[str, frozenset[date]]
) -> dict[str, set[date]]:
    for asset_id, days in more.items():
        into.setdefault(asset_id, set()).update(days)
    return into


@dataclass
class Sweep:
    """Everything the detection path produced, across every window."""

    findings: list[Finding]
    scored: dict[str, dict[str, frozenset[date]]]
    observed: dict[str, dict[str, frozenset[date]]]
    grid_samples: dict[str, int]

    def for_window(self, scenario_id: str) -> list[Finding]:
        return [f for f in self.findings if f.scenario_id == scenario_id]

    @property
    def scored_asset_days(self) -> int:
        return sum(len(d) for per in self.scored.values() for d in per.values())

    @property
    def observed_asset_days(self) -> int:
        return sum(len(d) for per in self.observed.values() for d in per.values())


def sweep(conn: psycopg.Connection, graph, log=print) -> Sweep:
    """Every window, every detector, one pass."""
    modes = load_failure_modes(conn)
    classes = asset_classes(conn)
    findings: list[Finding] = []
    scored: dict[str, dict[str, frozenset[date]]] = {}
    observed: dict[str, dict[str, frozenset[date]]] = {}
    grid: dict[str, int] = {}

    for window in windows():
        log(f"  {window.scenario_id:<30} {window.t_from:%Y-%m-%d} .. "
            f"{window.t_to:%Y-%m-%d}  {window.days:>4} days")
        observed[window.scenario_id] = observed_days(conn, window)
        grid[window.scenario_id] = sample_count(conn, window)

        air, air_days = ahu_rule_findings(conn, graph, window)
        water, water_days = chiller_rule_findings(conn, graph, window)
        wear, wear_days = degradation_findings(conn, window, modes, classes)
        found = air + water + wear

        judged: dict[str, set[date]] = {}
        for part in (air_days, water_days, wear_days):
            _merge(judged, part)
        # A day a finding was active must be in the denominator whatever the
        # suppression masks say, or a false positive could be raised on a day the
        # matrix does not count and would vanish from precision.
        for finding in found:
            judged.setdefault(finding.asset_id, set()).update(finding.active_days)
        scored[window.scenario_id] = {a: frozenset(d) for a, d in judged.items()}

        findings += found
        for finding in sorted(found, key=lambda f: (f.asset_id, f.fault_id)):
            log(f"      {finding.asset_id:<11}{finding.source:<14}"
                f"{finding.fault_id:<28}first seen {finding.first_seen:%Y-%m-%d}  "
                f"{len(finding.active_days):>4} active days")
        if not found:
            log("      nothing raised on any asset")
        log(f"      {sum(len(d) for d in judged.values()):>5} asset-days a detector "
            f"could judge, of "
            f"{sum(len(d) for d in observed[window.scenario_id].values()):>5} with "
            f"readings")

    return Sweep(
        findings=findings, scored=scored, observed=observed, grid_samples=grid
    )
