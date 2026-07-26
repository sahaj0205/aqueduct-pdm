"""The answer key, and the reconstruction of when each fault was at its mildest.

THE ONLY MODULE IN THIS PROJECT THAT READS SCHEMA GROUNDTRUTH. It connects as the
admin role. Nothing else in validation/ opens that credential; they take their
labels from the dataclasses below, which are plain values with no live connection
behind them, so a metric function cannot accidentally reach back into the answer
key to help itself.

WHY SEVERITY LEVEL 1 NEEDS RECONSTRUCTING AT ALL

The LBNL datasets publish each fault at a small number of discrete severities --
condenser fouling at 95% and 65% heat transfer retained, bypass leakage at 25%,
50% and 75%. The simulator turns those rungs into a continuous slide by mixing
consecutive measured runs in proportion, so at any instant the injected fault sits
somewhere on that ladder. `groundtruth.fault_events` records where the trajectory
ENDED (its terminal severity label) but not when it passed each rung, because the
rung crossings are a property of the trajectory rather than of the fault.

So the crossing is recomputed here, from the same seeded curve the simulator used.
The severity-1 window of a scenario is the stretch from injection until the
trajectory first reaches the SECOND measured rung. Inside it, the fault's effect
on every signal is bounded above by LBNL's mildest published case for that fault.
That window is where detection is genuinely hard, and it is the only window this
project reports detection accuracy over.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ingestion.lbnl_loader import load_manifest
from simulator.trajectory import (
    MANIFEST_DIR,
    Scenario,
    load_scenarios,
    progress_curve,
    to_utc,
)


def admin_dsn() -> str:
    """The only credential permitted to read the answer key. Validation only."""
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


# ---------------------------------------------------------------------------
# the labels
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScenarioLabel:
    """One simulation run, and whether a fault was injected into it."""

    scenario_id: str
    system: str
    is_fault_free: bool
    t_start: datetime | None
    t_end: datetime | None
    notes: str


@dataclass(frozen=True)
class FaultEvent:
    """One injected fault: what, where, when it started and when it failed."""

    scenario_id: str
    asset_id: str
    fault_mode: str
    terminal_severity: str
    t_onset: datetime
    t_failure: datetime | None
    profile: str
    n_levels: int
    level_labels: tuple[str, ...]

    @property
    def mildest_label(self) -> str:
        """LBNL's own name for the mildest measured case of this fault."""
        return self.level_labels[0] if self.level_labels else "unknown"


def load_answer_key() -> tuple[dict[str, ScenarioLabel], list[FaultEvent]]:
    """Every run and every injected fault, as values. VALIDATION PATH ONLY."""
    with psycopg.connect(admin_dsn()) as conn:
        runs = conn.execute(
            "SELECT scenario_id, system, is_fault_free, t_start, t_end, "
            "       coalesce(notes, '') "
            "  FROM groundtruth.scenarios ORDER BY scenario_id"
        ).fetchall()
        events = conn.execute(
            "SELECT scenario_id, asset_id, fault_mode, severity_level, t_onset, "
            "       t_failure, params "
            "  FROM groundtruth.fault_events ORDER BY t_onset"
        ).fetchall()

    labels = {
        row[0]: ScenarioLabel(
            scenario_id=row[0], system=row[1], is_fault_free=row[2],
            t_start=row[3], t_end=row[4], notes=row[5],
        )
        for row in runs
    }
    faults = []
    for scenario, asset, mode, severity, onset, failure, params in events:
        waypoints = tuple((params or {}).get("waypoints") or ())
        faults.append(
            FaultEvent(
                scenario_id=scenario, asset_id=asset, fault_mode=mode,
                terminal_severity=severity, t_onset=onset, t_failure=failure,
                profile=str((params or {}).get("profile", "unknown")),
                n_levels=len(waypoints),
                level_labels=tuple(str(w.get("label", "")) for w in waypoints),
            )
        )
    return labels, faults


# ---------------------------------------------------------------------------
# where severity level 1 ends
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SeverityWindow:
    """The stretch of a run during which the fault never exceeded level 1."""

    scenario_id: str
    scored: bool
    t_from: datetime | None
    t_to: datetime | None
    n_levels: int
    grid_samples: int
    reason: str

    @property
    def days(self) -> float:
        if self.t_from is None or self.t_to is None:
            return 0.0
        return (self.t_to - self.t_from).total_seconds() / 86400.0


def _grid(scenario: Scenario, interval_s: int) -> pd.DatetimeIndex:
    """The timestamps the simulator built this scenario on, in source-local time.

    The simulator reads a window of the 2018 source year, resamples it to a fixed
    interval, shifts it forward by a whole number of years and evaluates the
    progress curve on the shifted index. That index is a uniform grid over the
    run, so it is rebuilt here from the run's own start and span rather than
    re-read from the CSVs -- which would mean parsing 21 source files to recover
    a set of timestamps that are fully determined by three integers.

    Left in source-local naive time on purpose. The scenario's injection instant
    is written in the manifest as a naive local timestamp and the progress curve
    compares against it directly, so converting to UTC here would shift the fault
    six hours and move every rung crossing with it.
    """
    periods = scenario.span_days * 86400 // interval_s
    return pd.date_range(
        scenario.scenario_start, periods=periods, freq=f"{interval_s}s"
    )


def severity_one_windows() -> dict[str, SeverityWindow]:
    """Per scenario, when the injected fault was still at or below level 1.

    Replays the scenario's own seeded progress curve and maps it onto the severity
    ladder exactly as the simulator does: progress 0 sits at the fault-free run,
    and progress 1 sits at the worst rung the ceiling allows, so multiplying by the
    number of rungs gives the position on the ladder. The severity-1 window closes
    at the first instant that position reaches 1.0, which is the moment the
    trajectory arrives at the second measured severity.

    Two cases come out of the same search rather than being special-cased:

      * A fault with only one measured rung never leaves level 1 -- the position
        reaches 1.0 only at the failure date -- so its window is the whole
        progressive span.
      * A step fault jumps to the top of the ladder at injection, so the position
        is already at or past 1.0 on the first faulted sample and the window has
        zero length. Such a scenario is excluded from the severity-1 metrics and
        reported as excluded, because it never presents a mild case to detect.
    """
    out: dict[str, SeverityWindow] = {}
    for scenario in load_scenarios():
        manifest = load_manifest(MANIFEST_DIR / f"{scenario.system}.yaml")
        interval_s = int(manifest["timestamps"]["resample_interval_s"])
        index = _grid(scenario, interval_s)

        if scenario.is_fault_free:
            out[scenario.scenario_id] = SeverityWindow(
                scenario_id=scenario.scenario_id, scored=False,
                t_from=None, t_to=None, n_levels=0, grid_samples=len(index),
                reason="fault-free run: no fault was injected, so there is no "
                       "severity to be at",
            )
            continue

        n_levels = len(scenario.waypoints)
        progress = progress_curve(scenario, index)
        rung = progress * scenario.severity_ceiling * n_levels
        reached = np.flatnonzero(rung >= 1.0)
        onset_utc = to_utc(scenario.onset, manifest)

        if len(reached) == 0:
            # Cannot happen with the current manifests -- the curve is pinned to 1.0
            # at the failure date -- but a scenario whose failure falls outside its
            # own span would land here, and silently scoring the whole run as level 1
            # would be the wrong answer rather than a missing one.
            out[scenario.scenario_id] = SeverityWindow(
                scenario_id=scenario.scenario_id, scored=False,
                t_from=None, t_to=None, n_levels=n_levels, grid_samples=len(index),
                reason="the trajectory never reaches the second severity rung "
                       "inside this run, so the level-1 boundary is undefined",
            )
            continue

        crossing = to_utc(index[int(reached[0])].to_pydatetime(), manifest)
        if crossing <= onset_utc:
            out[scenario.scenario_id] = SeverityWindow(
                scenario_id=scenario.scenario_id, scored=False,
                t_from=None, t_to=None, n_levels=n_levels, grid_samples=len(index),
                reason=f"{scenario.profile} fault: jumps straight to rung "
                       f"{n_levels} of {n_levels} at injection, so it is never "
                       f"present at level 1 and detecting it is not the hard case",
            )
            continue

        out[scenario.scenario_id] = SeverityWindow(
            scenario_id=scenario.scenario_id, scored=True,
            t_from=onset_utc, t_to=crossing, n_levels=n_levels,
            grid_samples=len(index),
            reason=(
                f"injection to the arrival of rung 2 of {n_levels}; throughout "
                f"this window the injected effect is bounded above by LBNL's "
                f"mildest published case for this fault"
                if n_levels > 1 else
                "injection to failure; this fault has one measured severity in "
                "the source data, so the whole trajectory stays at level 1"
            ),
        )
    return out
