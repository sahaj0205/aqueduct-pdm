"""The detection pipeline as a narrowing funnel, measured from outside.

WHAT THIS IS FOR. Every dashboard in this industry shows what alarmed. The
interesting question is the opposite one: of everything the building reported, what
did the system decline to judge, and on what grounds? That is where a fault detection
system earns its keep, because the way these systems fail in the field is not missing
faults, it is crying wolf until nobody opens the screen. This project's false alarm
rate is one finding per 604 healthy machine-days, and the reason is not a cleverer
detector -- it is eight successive refusals to judge. None of them were visible.

THE FUNNEL, and it is honest about changing units three times:

    1  readings              samples the building reported
    2  evaluable instants    when rules were allowed to run at all
    3  rule evaluations      rule x instant pairs attempted
    4  inputs trusted        of those, the ones with believable readings
    5  rule fired            of those, the ones that said something is wrong
    6  sustained             of those, the ones that held long enough to count
    7  baseline coverage     points with a fitted expectation to compare against
    8  degradation confirmed failure modes past their changepoint
    9  prediction published  modes the remaining-life model would answer for
   10  advisory raised       findings that reached the operator, and demotions

Stages 1-6 count readings and rule evaluations, 7 counts points, 8 and 9 count
failure modes, 10 counts findings. A drawing that ran one bar smoothly into the next
would be claiming 34,560 readings become 4 findings by attrition. They do not; they
become 4 findings by being aggregated into a different kind of object. Each stage
declares its unit so the picture can break where the kind changes.

EVERY DROP REASON IS THE ENGINE'S OWN WORD. The rule statuses come from RuleStatus,
the suppression conditions from the same expression the rule engine gates on. Nothing
here re-derives a threshold or invents a category, so any number in a trace can be
followed to the line that produced it. That is the difference between a trace and a
summary.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd
import psycopg
from rdflib import Graph

from analytics.rules.evaluate import (
    MODE_SWITCH_DELAY_MINUTES,
    OCCUPANCY_DELAY_MINUTES,
    RULE_DELAY_MINUTES,
    episodes,
    run_rules,
    suppression_mask,
    sustained,
)
from analytics.rules.mode import SIGNALS, Mode, classify_frame
from analytics.rules.readings import effective_quality_frame, signal_frames
from analytics.rules.registry import class_closure, to_uri
from model.loader import local_name

INTERVAL_S = 300


@dataclass
class Stage:
    """One narrowing, with everything that did not get through and why."""

    ordinal: int
    stage: str
    unit: str
    entered: int
    passed: int
    dropped: dict[str, int] = field(default_factory=dict)
    detail: dict = field(default_factory=dict)


def _counts(series: pd.Series) -> dict[str, int]:
    return {str(k): int(v) for k, v in Counter(series.dropna()).items()}


def air_side_modes(values: pd.DataFrame, quality: pd.DataFrame, flags: pd.DataFrame):
    """The air handler's operating mode at every instant, as the rules see it."""
    signals, signal_quality, signal_flags = signal_frames(
        values, quality, flags, SIGNALS
    )
    return classify_frame(
        signals, effective_quality_frame(signal_quality, signal_flags)
    )


def rule_stages(
    graph: Graph,
    asset_id: str,
    brick_class: str,
    values: pd.DataFrame,
    quality: pd.DataFrame,
    flags: pd.DataFrame,
    modes: pd.Series,
    points,
    off_state: str,
) -> list[Stage]:
    """Stages 1 to 6: from raw samples to findings that held long enough to report.

    The rule engine is run once and its own per-instant verdicts are counted. It is
    not re-implemented here and no threshold is re-derived -- the point of a trace is
    to say what happened, and a trace that recomputed its subject could disagree with
    it.
    """
    samples = int(values.notna().to_numpy().sum())
    instants = len(values)

    suppression = suppression_mask(modes, INTERVAL_S, off_state=off_state)
    evaluable = int(suppression.evaluable.sum())

    # Why each suppressed instant was suppressed. Tested in the same order the gate
    # applies them and attributed to the first that bites, so the reasons sum to the
    # number suppressed rather than double-counting an instant that fails two tests.
    idle = modes == off_state
    unknown = (~idle) & (modes == Mode.UNKNOWN.value)
    settling_start = (
        (~idle) & (~unknown)
        & (suppression.since_occupied < OCCUPANCY_DELAY_MINUTES)
    )
    settling_switch = (
        (~idle) & (~unknown) & (~settling_start)
        & (suppression.since_mode_switch < MODE_SWITCH_DELAY_MINUTES)
    )
    gate_dropped = {
        "machine idle": int(idle.sum()),
        f"settling, under {OCCUPANCY_DELAY_MINUTES} min since it started":
            int(settling_start.sum()),
        f"settling, under {MODE_SWITCH_DELAY_MINUTES} min since the mode changed":
            int(settling_switch.sum()),
        "operating mode could not be determined": int(unknown.sum()),
    }

    outcomes = run_rules(
        graph, asset_id, brick_class, values, quality, flags, modes, points,
        interval_s=INTERVAL_S, off_state=off_state,
    )

    stages = [
        Stage(1, "readings", "readings", samples, samples,
              detail={"instants": instants, "points": len(values.columns),
                      "interval_seconds": INTERVAL_S}),
        Stage(2, "evaluable instants", "instants", instants, evaluable,
              dropped={k: v for k, v in gate_dropped.items() if v},
              detail={"modes seen": _counts(modes)}),
    ]

    if outcomes.empty:
        stages += [
            Stage(3, "rule evaluations", "evaluations", 0, 0,
                  detail={"note": "no rule is registered for this equipment class"}),
            Stage(4, "inputs trusted", "evaluations", 0, 0),
            Stage(5, "rule fired", "evaluations", 0, 0),
            Stage(6, "sustained", "episodes", 0, 0),
        ]
        return stages

    by_status = _counts(outcomes["status"])
    attempted = len(outcomes)
    untrusted = by_status.get("insufficient_data_quality", 0)
    missing = by_status.get("input_missing", 0)
    trusted = attempted - untrusted - missing
    fired = int(outcomes["fired"].sum())

    held = sustained(outcomes, interval_s=INTERVAL_S)
    reported = held[held["reported"]] if "reported" in held else held.iloc[0:0]
    found = episodes(reported) if len(reported) else pd.DataFrame()

    stages += [
        Stage(3, "rule evaluations", "evaluations", evaluable * _rule_count(outcomes),
              attempted,
              dropped={"rule does not apply in this operating mode":
                       max(0, evaluable * _rule_count(outcomes) - attempted)},
              detail={"rules run": sorted(outcomes["rule_id"].unique().tolist())}),
        Stage(4, "inputs trusted", "evaluations", attempted, trusted,
              dropped={k: v for k, v in
                       {"reading not trusted by the quality layer": untrusted,
                        "an input the rule needs was absent": missing}.items() if v}),
        Stage(5, "rule fired", "evaluations", trusted, fired,
              dropped={"nothing wrong at this instant": max(0, trusted - fired)},
              detail={"by rule": _counts(outcomes.loc[outcomes["fired"], "rule_id"])}),
        Stage(6, "sustained", "firings", fired, int(reported["reported"].sum())
              if len(reported) else 0,
              dropped={f"held under {RULE_DELAY_MINUTES} min, so not a fault":
                       max(0, fired - (int(reported["reported"].sum())
                                       if len(reported) else 0))},
              detail={"episodes": 0 if found.empty else len(found),
                      "rules reporting": [] if found.empty
                      else sorted(found["rule_id"].unique().tolist())}),
    ]
    return stages


def _rule_count(outcomes: pd.DataFrame) -> int:
    return int(outcomes["rule_id"].nunique()) if len(outcomes) else 0


def configured_modes(conn: psycopg.Connection, graph: Graph, brick_class: str) -> list[str]:
    """Every failure mode declared for equipment of this class, equivalences included.

    NOT a string join on the class name, which is the obvious version and is wrong.
    app.assets calls the air handler brick:AHU and app.failure_modes registers its
    three modes against brick:Air_Handling_Unit -- Brick declares those two
    equivalent, and a string comparison finds nothing. Joined that way the trace
    reported zero modes configured beside two confirmed, which is both a false number
    and a violation of the table's own check that nothing can pass a stage it never
    entered. The class closure is the same one the rule registry dispatches on, so
    the trace and the engine agree about what applies to a machine by construction.
    """
    closure = {f"brick:{local_name(uri)}" for uri in class_closure(graph, to_uri(brick_class))}
    rows = conn.execute(
        "SELECT mode_id FROM app.failure_modes WHERE brick_class = ANY(%s) ORDER BY 1",
        (sorted(closure),),
    ).fetchall()
    return [r[0] for r in rows]


def stored_stages(
    conn: psycopg.Connection, asset_id: str, as_of: datetime,
    window: tuple[datetime, datetime], vintage: datetime | None,
    rules_reporting: list[str] | None = None,
    declared_modes: list[str] | None = None,
) -> list[Stage]:
    """Stages 7 to 10, read from what the later layers already wrote.

    These layers persist their own conclusions, so a trace of them is a query rather
    than a re-run. That is deliberate: re-running the remaining-life fit to describe
    it would risk describing something the dashboard is not showing.
    """
    total_points = conn.execute(
        "SELECT count(*) FROM app.points WHERE asset_id = %s", (asset_id,)
    ).fetchone()[0]
    with_baseline = conn.execute(
        "SELECT count(DISTINCT r.point_id) FROM app.residuals r "
        "  JOIN app.points p USING (point_id) "
        " WHERE p.asset_id = %(a)s AND r.time >= %(f)s AND r.time < %(t)s",
        {"a": asset_id, "f": window[0], "t": window[1]},
    ).fetchone()[0]
    baseline_points = [
        r[0] for r in conn.execute(
            "SELECT DISTINCT r.point_id FROM app.residuals r "
            "  JOIN app.points p USING (point_id) "
            " WHERE p.asset_id = %(a)s AND r.time >= %(f)s AND r.time < %(t)s "
            " ORDER BY 1",
            {"a": asset_id, "f": window[0], "t": window[1]},
        ).fetchall()
    ]

    declared = declared_modes or []
    modes_configured = len(declared)
    confirmed = conn.execute(
        "SELECT DISTINCT mode_id FROM app.health_state "
        " WHERE asset_id = %(a)s AND mode_id IS NOT NULL AND t_onset IS NOT NULL "
        "   AND time <= %(t)s ORDER BY 1",
        {"a": asset_id, "t": as_of},
    ).fetchall()
    confirmed_modes = [r[0] for r in confirmed]

    published = conn.execute(
        "SELECT DISTINCT ON (mode_id) mode_id, p50 FROM app.rul_estimates "
        " WHERE asset_id = %(a)s AND mode_id IS NOT NULL AND as_of <= %(t)s "
        " ORDER BY mode_id, as_of DESC",
        {"a": asset_id, "t": as_of},
    ).fetchall()
    bounded = [m for m, p50 in published if p50 is not None]
    refused = [m for m, p50 in published if p50 is None]

    raised = conn.execute(
        "SELECT fault_id, consequential FROM app.advisories "
        " WHERE asset_id = %(a)s AND window_to = %(v)s ORDER BY fault_id",
        {"a": asset_id, "v": vintage},
    ).fetchall()
    demoted = [f for f, c in raised if c]

    # What could have become an advisory: every rule that reported, and every mode
    # past its changepoint. NOT the modes with a BOUNDED prediction, which is what
    # this counted first and is wrong -- a confirmed degradation whose remaining life
    # the model declines to bound still raises an advisory, unpriced, and there are
    # days where that is the only advisory on the machine. Counting bounded
    # predictions claimed one advisory arrived from zero candidates.
    reporting = set(rules_reporting or [])
    raised_ids = {f for f, _ in raised}
    candidates = reporting | set(confirmed_modes)

    return [
        Stage(7, "baseline coverage", "points", total_points, with_baseline,
              dropped={"no baseline was fitted for this point":
                       max(0, total_points - with_baseline)},
              detail={"points with a baseline": baseline_points}),
        Stage(8, "degradation confirmed", "failure modes",
              max(modes_configured, len(confirmed_modes)), len(confirmed_modes),
              dropped={"no changepoint yet, so no trend to project":
                       max(0, modes_configured - len(confirmed_modes))},
              detail={"declared for this equipment class": declared,
                      "confirmed": confirmed_modes}),
        Stage(9, "prediction published", "failure modes",
              len(published), len(bounded),
              dropped={"model declines to bound the crossing": len(refused)},
              detail={"bounded": bounded, "refused": refused}),
        # Candidates are counted BY IDENTITY, not by number. Each rule that reported
        # and each mode past its changepoint becomes at most one advisory, so the two
        # sets can be compared against what was actually raised and anything left over
        # named. Counting them instead produced a row claiming one advisory came from
        # zero candidates, which the table refused -- see the note below on why the
        # obvious count was wrong.
        #
        # Demotion is NOT a drop and is not counted as one: a consequential advisory
        # is still on the operator's screen, ranked below the fault it was blamed on.
        # That distinction is the whole design of the cross-asset layer, and
        # collapsing it here would misreport it as suppression.
        Stage(10, "advisory raised", "findings",
              len(candidates | raised_ids), len(raised),
              dropped={"candidate raised no advisory":
                       len(candidates - raised_ids)},
              detail={"faults": sorted(raised_ids),
                      "candidates": {"rules that reported": sorted(reporting),
                                     "modes past their changepoint": confirmed_modes},
                      "raised with no candidate this trace can account for":
                          sorted(raised_ids - candidates),
                      "demoted as consequential on an upstream cause": demoted,
                      "note": "demotion is a ranking, not a suppression -- a demoted "
                              "advisory is still in the queue",
                      "advisory vintage": None if vintage is None else str(vintage)}),
    ]


UPSERT = """
INSERT INTO app.engine_trace
    (asset_id, as_of, ordinal, stage, unit, entered, passed, dropped, detail)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (asset_id, as_of, stage) DO UPDATE SET
    ordinal = EXCLUDED.ordinal, unit = EXCLUDED.unit,
    entered = EXCLUDED.entered, passed = EXCLUDED.passed,
    dropped = EXCLUDED.dropped, detail = EXCLUDED.detail
"""


def store(
    conn: psycopg.Connection, asset_id: str, as_of: datetime, stages: list[Stage]
) -> int:
    """Write one machine's funnel for one day, replacing that day only.

    Checks the funnel's own arithmetic before the database does. The table refuses a
    stage where more things left than arrived, which is right -- it has caught two
    real accounting errors -- but it refuses it as a truncated row in a psycopg
    exception, three minutes into a run that takes hours. Raising here names the
    stage and shows both numbers, so the next one is diagnosed from the message
    rather than from the traceback.
    """
    import json

    for s in stages:
        if s.passed > s.entered:
            raise ValueError(
                f"{asset_id} {as_of:%Y-%m-%d} stage {s.ordinal} {s.stage!r}: "
                f"{s.passed} {s.unit} passed but only {s.entered} entered. "
                f"The funnel's accounting for this stage is wrong, not the data."
            )

    rows = [
        (asset_id, as_of, s.ordinal, s.stage, s.unit, s.entered, s.passed,
         json.dumps(s.dropped), json.dumps(s.detail, default=str))
        for s in stages
    ]
    with conn.transaction(), conn.cursor() as cursor:
        cursor.executemany(UPSERT, rows)
    return len(rows)
