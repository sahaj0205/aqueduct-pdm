"""Score what the platform NAMED, not just what it noticed.

Detection asks whether a machine was flagged. This asks two harder questions.

FIRST, SENSOR OR EQUIPMENT. A supply air temperature reading above its setpoint is
produced by a coil that cannot cool and by a thermometer reading high, and those two
faults are indistinguishable from the symptom alone. Getting them the wrong way round
sends a technician with a wrench to a fault that needs a screwdriver and a calibration
kit, or sends a calibration technician to a machine that is genuinely failing. The
dispatch costs differ by more than three times in this project's own intervention
library, so the discrimination is worth money and not only tidiness.

SECOND, WHETHER A DEMOTED ADVISORY WAS DEMOTED FOR A TRUE REASON. The cross-asset
layer marks a downstream symptom consequential when an upstream machine has an open
fault whose mechanism could produce it, and it then ranks that advisory below its
named cause. That is an inference, and inferences are wrong sometimes. The whole
design of that layer -- demote, never hide -- is a bet on it being wrong sometimes.
This module checks whether it was.

WHAT THE ANSWER KEY CAN AND CANNOT ADJUDICATE HERE

It can say what fault was injected into which machine, so it can say whether a symptom
had a cause of its own on its own machine. That is enough to falsify a consequential
label: if the answer key injected a fault directly into the machine carrying the
symptom, then the symptom did not need an upstream explanation and the link is wrong.

It cannot adjudicate cross-asset causation in the positive direction, and the reason is
in the source data rather than in the answer key. The two LBNL systems are independent
simulations; the air handler's chilled water comes from a boundary condition inside its
own simulation, not from this chiller. So no run in this dataset contains a genuine
chiller-caused air handler symptom for the layer to get right. That absence is the whole
reason checkpoint 6.1 had to compose its target scenario, and it is stated here rather
than worked around.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[1]
for extra in (REPO_ROOT, REPO_ROOT / "scripts"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from run_rootcause import (
    COMPOSED_WINDOW,
    ERA_SHIFT_YEARS,
    FOULING_WINDOW,
    collect,
    era_shift,
)

from analytics.baselines.fit import commissioning_window
from analytics.diagnosis.classify import classify
from analytics.diagnosis.isolation import IsolationError, isolate
from analytics.diagnosis.rootcause import (
    attribute,
    open_failure_modes,
    rank,
)
from model.graph import node_to_asset_id
from validation.detect import FAILURE_MODE, Sweep, windows
from validation.groundtruth import FaultEvent
from validation.metrics import EXCLUDED_SCENARIOS, affected_assets


def verdict_text(truth: str | None, predicted: str) -> str:
    """CORRECT, WRONG, or a dash where there is no truth to compare against."""
    if truth is None:
        return "-"
    return "CORRECT" if truth == predicted else "WRONG"


SENSOR = "sensor"
EQUIPMENT = "equipment"
CONTROL = "control"
AMBIGUOUS = "ambiguous"
CLASSES = (SENSOR, EQUIPMENT, CONTROL, AMBIGUOUS)

# The true class of each injected fault, in this project's own four-class taxonomy,
# with the reason for each label. Written out because two of the six are arguable and a
# confusion matrix built on unstated labels is not a measurement of anything.
TRUE_CLASS: dict[str, tuple[str, str]] = {
    "supply_air_temperature_sensor_drift": (
        SENSOR,
        (
            "the injected fault is a bias added to one thermometer's reading. The "
            "machine is untouched"
        ),
    ),
    "cooling_coil_valve_leakage": (
        EQUIPMENT,
        (
            "chilled water passes a valve seat that is commanded shut. The valve "
            "POSITION still obeys its command, so nothing is failing to do what it is "
            "told -- what has failed is the seat, which is hardware"
        ),
    ),
    "outdoor_air_damper_stuck": (
        CONTROL,
        (
            "the damper is jammed and no longer follows its command. This project's "
            "definition of a control fault is exactly that -- an actuator that will "
            "not track what it is told -- so this is control rather than equipment, "
            "even though the jam itself is mechanical. Labelling it equipment would "
            "make the control class untestable, since it is the only fault in the set "
            "that produces an actuator-feedback gap"
        ),
    ),
    "condenser_fouling": (
        EQUIPMENT,
        (
            "scale and biofilm on the condenser tubes. No instrument and no actuator "
            "is involved"
        ),
    ),
    "bypass_valve_leakage": (
        EQUIPMENT,
        (
            "the plant bypass valve passes water it should not. Same reasoning as the "
            "coil valve: the position obeys, the seat does not"
        ),
    ),
    "cooling_tower_fouling": (
        EQUIPMENT,
        "fouled tower fill. Held out from the accuracy figures, and reported on its own",
    ),
}


# ---------------------------------------------------------------------------
# 6. sensor versus equipment
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Classification:
    """What the classifier said about one machine on one run. No labels involved."""

    scenario_id: str
    asset_id: str
    window: tuple[datetime, datetime]
    predicted: str
    confidence: str
    subject: str | None
    violated: int
    relations: int
    degrading: bool
    reason: str


@dataclass(frozen=True)
class ClassOutcome:
    """A classification with the answer key's label attached to it."""

    scenario_id: str
    asset_id: str
    injected_fault: str | None
    truth: str | None
    predicted: str
    confidence: str
    subject: str | None
    violated: int
    relations: int
    degrading: bool
    reason: str
    held_out: bool
    scoreable: bool
    skipped_reason: str

    @property
    def correct(self) -> bool | None:
        return None if self.truth is None else self.truth == self.predicted


# Days of recent history the classifier is asked about. Twenty-eight, matching the window
# the advisory layer fits its health slope over, so the project has one notion of
# "recently" rather than two. See classify_runs for why the window is recent-and-short
# rather than the whole post-onset stretch.
CLASSIFY_WINDOW_DAYS = 28

# Runs the classifier is asked about. The LBNL reference year is not among them: it has
# no scenario record and no commissioning window declared for it, so there is no healthy
# reference to isolate against.
CLASSIFIED_RUNS = frozenset({
    "ahu_cooling_valve_leakage", "ahu_oa_damper_stuck", "ahu_sat_sensor_drift",
    "chiller_condenser_fouling", "chiller_bypass_valve_leakage",
    "cooling_tower_fouling", "clean_ahu", "clean_chiller",
})


def classify_runs(
    conn: psycopg.Connection, sweep: Sweep, log=print
) -> list[Classification]:
    """Run the fault classifier once per machine per run, uniformly and label-free.

    NOTHING IN THIS FUNCTION READS THE ANSWER KEY, INCLUDING WHERE TO LOOK. An earlier
    version took the observation window's start from the injected onset, which meant the
    harness was telling the classifier when the fault began. A small leak, but a leak,
    and it would have made the accuracy figure partly a measurement of the answer key.

    THE WINDOW IS THE LAST 28 DAYS OF THE RUN, against the three-week commissioning
    window at its own start as the healthy reference. Chosen on operational grounds
    rather than by which window scored best, and that distinction matters because the two
    are not the same window. In production this classifier runs on a window ending now,
    which is what "the most recent 28 days" reproduces; and 28 matches the window the
    advisory layer already fits its health slope over, so the project has one notion of
    "recently". A longer window spanning the whole post-onset stretch of a run was tried
    and is measurably worse on the air handler -- over three months reaching from winter
    into summer, the cooling coil valve's average position drifts far enough from its
    command for a leaking valve to be reported as an actuator that will not follow
    orders. It is better on the chiller. Choosing per equipment class would be fitting
    the harness to the answer key, so one rule is used and the run it gets wrong is
    reported as wrong.

    THE REFERENCE IS EACH RUN'S OWN COMMISSIONING WINDOW, because it exists for every
    run. A fault-free run at the same time of year is the stronger choice and is what
    checkpoint 5.4 used, but two of the air-handler runs sit in late winter and early
    spring and the only fault-free air-handler run is a summer one. The check that this
    substitution does not change the answer is the coil-leak run, the one case where both
    references are available over the same 28 days: they both return EQUIPMENT.

    THE WINDOW IS NOT RESTRICTED TO SEVERITY LEVEL 1, deliberately, and it makes these
    figures easier than the detection figures. The classifier works by asking which
    relations between measurements have stopped holding; at level 1 on several of these
    runs nothing has visibly stopped holding yet, so asking it to name a fault it cannot
    see measures the detector again rather than the classifier.
    """
    degrading_assets: dict[tuple[str, str], object] = {}
    for finding in sweep.findings:
        if finding.source != FAILURE_MODE:
            continue
        key = (finding.scenario_id, finding.asset_id)
        current = degrading_assets.get(key)
        if current is None or finding.first_seen < current.first_seen:
            degrading_assets[key] = finding

    out: list[Classification] = []
    for window in windows():
        if window.scenario_id not in CLASSIFIED_RUNS:
            continue
        reference = commissioning_window(window.t_from)
        start = window.t_to - timedelta(days=CLASSIFY_WINDOW_DAYS)
        for asset_id in window.assets:
            finding = degrading_assets.get((window.scenario_id, asset_id))
            try:
                isolation = isolate(conn, {asset_id}, reference, (start, window.t_to))
            except IsolationError as exc:
                log(f"      {window.scenario_id:<30}{asset_id:<11}no relations: {exc}")
                continue
            diagnosis = classify(
                conn, asset_id, isolation,
                finding is not None,
                "" if finding is None else finding.detail,
            )
            out.append(
                Classification(
                    scenario_id=window.scenario_id, asset_id=asset_id,
                    window=(start, window.t_to),
                    predicted=diagnosis.fault_class,
                    confidence=diagnosis.confidence, subject=diagnosis.subject,
                    violated=len(isolation.violated),
                    relations=len(isolation.relations),
                    degrading=finding is not None,
                    reason=diagnosis.reason,
                )
            )
            log(f"      {window.scenario_id:<30}{asset_id:<11}"
                f"said {diagnosis.fault_class:<11}"
                f"{isolation.violated and len(isolation.violated) or 0}"
                f"/{len(isolation.relations)} relations violated")
    return out


def score_classifications(
    raw: list[Classification], events: list[FaultEvent]
) -> list[ClassOutcome]:
    """Attach the answer key's label to each classification. VALIDATION PATH ONLY.

    A classification is scoreable only where a fault was injected into that exact
    machine. Machines sharing a simulated plant with a faulted machine are carried
    through unscoreable rather than dropped, for the same reason as in the detection
    figures: the plant simulation couples them, so they can be asserted neither faulted
    nor healthy, and an exclusion that disappears from the output is indistinguishable
    from a result that was inconvenient.
    """
    injected = {
        (event.scenario_id, asset): event
        for event in events
        for asset in affected_assets(event)
    }
    faulted_runs = {event.scenario_id for event in events}

    out: list[ClassOutcome] = []
    for entry in raw:
        event = injected.get((entry.scenario_id, entry.asset_id))
        held_out = entry.scenario_id in EXCLUDED_SCENARIOS
        if event is not None:
            truth = TRUE_CLASS.get(event.fault_mode, (None, ""))[0]
            scoreable = not held_out
            skipped = (
                "held-out scenario, reported separately" if held_out else ""
            )
        else:
            truth = None
            scoreable = False
            skipped = (
                "shares a simulated plant with a faulted machine, so it can be "
                "asserted neither faulted nor healthy"
                if entry.scenario_id in faulted_runs
                else "fault-free run: nothing was injected, so there is no class to be"
            )
        out.append(
            ClassOutcome(
                scenario_id=entry.scenario_id, asset_id=entry.asset_id,
                injected_fault=None if event is None else event.fault_mode,
                truth=truth, predicted=entry.predicted, confidence=entry.confidence,
                subject=entry.subject, violated=entry.violated,
                relations=entry.relations, degrading=entry.degrading,
                reason=entry.reason, held_out=held_out, scoreable=scoreable,
                skipped_reason=skipped,
            )
        )
    return out


def class_matrix(outcomes: list[ClassOutcome]) -> dict[tuple[str, str], int]:
    """Counts keyed by (true class, predicted class), over the scoreable runs only."""
    matrix: dict[tuple[str, str], int] = {}
    for outcome in outcomes:
        if not outcome.scoreable or outcome.truth is None:
            continue
        key = (outcome.truth, outcome.predicted)
        matrix[key] = matrix.get(key, 0) + 1
    return matrix


def majority_baseline(outcomes: list[ClassOutcome]) -> tuple[str, int, int]:
    """What a classifier that always guessed the commonest class would score.

    Reported next to the accuracy, because with five scoreable cases and three of them
    equipment, "correct on five of five" and "correct on three of five by always saying
    equipment" are close enough that the second has to be on the page for the first to
    mean anything.
    """
    scored = [o for o in outcomes if o.scoreable and o.truth is not None]
    counts: dict[str, int] = {}
    for outcome in scored:
        counts[outcome.truth] = counts.get(outcome.truth, 0) + 1
    if not counts:
        return ("none", 0, 0)
    commonest = max(counts, key=lambda c: counts[c])
    return (commonest, counts[commonest], len(scored))


# ---------------------------------------------------------------------------
# 7. cross-asset suppression correctness
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SuppressionRun:
    """One window put through the cross-asset layer. No labels involved."""

    label: str
    scenario_id: str
    window: tuple[datetime, datetime]
    composed: bool
    open_faults: int
    demotions: tuple[tuple[str, str, str, str], ...]  # symptom asset/fault, cause
    ordering_holds: bool
    upstream_open: tuple[str, ...]


@dataclass(frozen=True)
class SuppressionCase:
    """A cross-asset run with the answer key's verdict attached."""

    label: str
    scenario_id: str
    window: tuple[datetime, datetime]
    composed: bool
    open_faults: int
    demotions: tuple[tuple[str, str, str, str], ...]
    verdict: str
    reason: str
    ordering_holds: bool


# The three windows checkpoint 6.1 verified against, reused unchanged. Two are entirely
# real; the third is the same window as the first with one extra fault composed into it,
# which is why the difference between them is attributable to that fault alone.
SITUATIONS: tuple[tuple[str, str, str, str, bool], ...] = (
    ("real concurrency, air-handler run of 2038", "ahu_sat_sensor_drift",
     "2038-05-27", "2038-09-24", False),
    ("real concurrency, air-handler run of 2036", "ahu_cooling_valve_leakage",
     "2036-05-31", "2036-06-24", False),
    ("composed: the same 2038 window plus one era-shifted chiller fault",
     "ahu_sat_sensor_drift", COMPOSED_WINDOW[0], COMPOSED_WINDOW[1], True),
)


def _d(text: str) -> datetime:
    return datetime.fromisoformat(f"{text}T00:00:00+00:00")


def run_suppression(
    conn: psycopg.Connection, graph, log=print
) -> list[SuppressionRun]:
    """Put three windows through the cross-asset layer. Reads no labels.

    The two unshifted windows are the negative cases and they matter as much as the
    positive one. Both have an upstream machine with an open fault, both have overlapping
    timing, and the plausibility map declines to link anyway because the open upstream
    fault costs power rather than capacity and cannot warm the water. A demotion layer
    that never declines to demote is indistinguishable from one that demotes everything.
    """
    mapping, _notes = node_to_asset_id(graph)

    out: list[SuppressionRun] = []
    for label, scenario_id, raw_from, raw_to, composed in SITUATIONS:
        window = (_d(raw_from), _d(raw_to))
        faults = collect(conn, graph, window)
        if composed:
            fouling = [
                f for f in open_failure_modes(
                    conn, (_d(FOULING_WINDOW[0]), _d(FOULING_WINDOW[1]))
                )
                if f.fault_id == "chiller-condenser-fouling"
            ]
            faults = faults + [era_shift(f, ERA_SHIFT_YEARS) for f in fouling]
        attributions = attribute(graph, mapping, faults)
        ranked = rank(faults, {}, attributions)

        demotions = tuple(
            (
                entry.fault.asset_id, entry.fault.fault_id,
                entry.attribution.cause.asset_id, entry.attribution.cause.fault_id,
            )
            for entry in ranked
            if entry.consequential and entry.attribution is not None
        )

        # Is every demoted advisory ranked strictly below the advisory it blames? This is
        # the mechanical half of correctness and it is independent of whether the blame
        # itself is true.
        positions = {
            (e.fault.asset_id, e.fault.fault_id): i for i, e in enumerate(ranked)
        }
        ordering_holds = all(
            positions.get((cause_asset, cause_fault), -1)
            < positions.get((symptom_asset, symptom_fault), 1 << 30)
            for symptom_asset, symptom_fault, cause_asset, cause_fault in demotions
        )

        log(f"      {label:<58}{len(faults):>3} open  {len(demotions)} demoted  "
            f"ordering {'holds' if ordering_holds else 'BROKEN'}")
        out.append(
            SuppressionRun(
                label=label, scenario_id=scenario_id, window=window, composed=composed,
                open_faults=len(faults), demotions=demotions,
                ordering_holds=ordering_holds,
                upstream_open=tuple(
                    sorted(
                        {f"{f.asset_id}/{f.fault_id}" for f in faults
                         if f.asset_id != "ahu-1"}
                    )
                ),
            )
        )
    return out


def score_suppression(
    runs: list[SuppressionRun], events: list[FaultEvent]
) -> list[SuppressionCase]:
    """Attach a verdict to each cross-asset run. VALIDATION PATH ONLY.

    The scoring rule is a falsification test, because that is the only direction this
    answer key can settle. A consequential label says "this symptom is a consequence of
    something upstream". If the answer key injected a fault DIRECTLY into the machine
    carrying the symptom, the symptom had a cause of its own and did not need an upstream
    one, so the label is wrong. If it did not, the label is unfalsified -- which is
    weaker than confirmed and is reported in those words.
    """
    injected_on = {
        (event.scenario_id, asset): event
        for event in events
        for asset in affected_assets(event)
    }

    out: list[SuppressionCase] = []
    for entry in runs:
        if not entry.demotions:
            verdict = "CORRECT REFUSAL"
            reason = (
                f"{entry.open_faults} faults open in this window, "
                f"{len(entry.upstream_open)} of them on machines other than the air "
                f"handler, and the plausibility map linked none of them. The open faults "
                f"on the water side here cost power rather than capacity, so none of them "
                f"can warm the chilled water the coil is fed with"
            )
        else:
            wrong = []
            for symptom_asset, symptom_fault, cause_asset, cause_fault in entry.demotions:
                local = injected_on.get((entry.scenario_id, symptom_asset))
                if local is not None:
                    wrong.append(
                        f"`{symptom_asset}/{symptom_fault}` was blamed on "
                        f"`{cause_asset}/{cause_fault}`, but the answer key injected "
                        f"`{local.fault_mode}` directly into {symptom_asset} on this "
                        f"run, so the symptom had a cause of its own and needed no "
                        f"upstream explanation"
                    )
            verdict = "WRONG ATTRIBUTION" if wrong else "UNFALSIFIED LINK"
            reason = (
                "; ".join(wrong) if wrong else
                "the answer key injected nothing into the machine carrying the symptom, "
                "so the link is not contradicted -- which is weaker than confirmed"
            )
        out.append(
            SuppressionCase(
                label=entry.label, scenario_id=entry.scenario_id, window=entry.window,
                composed=entry.composed, open_faults=entry.open_faults,
                demotions=entry.demotions, verdict=verdict, reason=reason,
                ordering_holds=entry.ordering_holds,
            )
        )
    return out
