"""Put a class on a fault: sensor, equipment, control, or honestly unknown.

This is where the two tests are combined with the measurement quality flags into
the one word a technician acts on. Getting the word wrong wastes a visit in a
specific way: sent for equipment when it is a sensor, somebody dismantles a healthy
coil; sent for a sensor when it is equipment, somebody recalibrates a thermometer
that was telling the truth and the machine carries on failing.

THE ORDER OF THE CHECKS IS LOAD-BEARING

Control is tested first, and not for tidiness. An actuator that will not follow its
command breaks the assumptions of both other tests at once: a commanded position
that the hardware ignores appears in the physics as a measurement that lies, so the
isolation sweep offers a perfectly good sensor hypothesis for it. Measured on the
stuck-damper run, the supply air temperature sensor comes out as a surviving suspect
explaining 87 percent of the violation, which is a defensible answer to the question
isolation was asked and the wrong answer to the question that matters. The damper
position sitting 0.63 away from its own command settles it before that arises.

Then sensor, then equipment, in that order, because they are not symmetric. Sensor
requires positive evidence: a violation, one measurement whose assumed bias fits all
of it, no relation made worse, and the trouble concentrated where that measurement
can reach. Equipment is what is left when the measurements are mutually consistent
and the machine still is not performing -- which is the correct default, because
every measurement agreeing with every other while output falls IS what a worn
machine looks like.

AMBIGUOUS IS A REAL OUTCOME AND IS REACHED

The commonest way is a suspect that cannot be contradicted. A measurement appearing
in only one relation can always be blamed for that relation, so "a bias here would
explain it" carries no information -- there was never a way for it to fail. When the
only surviving hypothesis is of that kind, this says so rather than picking. That is
not a hedge; it is a statement about the instrumentation, and it is actionable in its
own right: adding one relation that contains that point converts it into a decidable
case, which is why sensor coverage belongs in the semantic model and not in a
threshold here.

WHAT THE QUALITY FLAGS ACTUALLY CONTRIBUTE, WHICH IS LESS THAN EXPECTED

Checkpoint 3.1 scores every reading for trustworthiness and raises advisories.
Those are consumed here as a caveat and cannot by themselves change a class, and
that is a finding rather than a design preference. Measured across these runs the
supply air temperature sensor draws `stale` advisories on ALL FOUR of them, the
fault-free run included, 16 times there against 8 on the run where it is genuinely
drifting. The quality layer answers "can this reading be trusted right now", which
is about dropouts and stuck values, and it is silent on whether a reading that
arrives perfectly on time is correct. Treating it as evidence of a sensor fault
would have made the fault-free run the most suspicious of the four.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import psycopg

from analytics.diagnosis.coherence import (
    Locality,
    independent_sets,
    locality,
    violated_summary,
)
from analytics.diagnosis.isolation import Feedback, Hypothesis, Isolation

log = logging.getLogger("diagnosis.classify")

SENSOR = "sensor"
EQUIPMENT = "equipment"
CONTROL = "control"
AMBIGUOUS = "ambiguous"

# How far an actuator's reported position may sit from its command, as a fraction of
# full travel, before it is called a control fault. Every actuator in this building
# tracks its command to within 0.0013 when healthy -- these are simulated actuators
# with no hysteresis -- and the stuck damper sits at 0.6272. Two orders of magnitude
# of daylight, so 0.05 is placed to be obviously clear of instrument noise rather
# than fitted to either number. On real hardware this would need to come from the
# actuator's published deadband instead.
CONTROL_GAP = 0.05

# How many times its own fault-free gap an actuator has to exceed before the gap is
# called a fault. Three, so an actuator that always tracks badly is not accused of
# newly breaking, while one that goes from tracking perfectly to ignoring its command
# is caught with enormous margin. See stuck_actuators for the actuator that forced
# this to exist.
CONTROL_GROWTH = 3.0

# Quality score below which a point's reading is treated as untrustworthy, matching
# the gate the rule engine uses in checkpoint 3.2 so the two layers cannot disagree
# about what "untrusted" means.
MIN_TRUSTED_QUALITY = 50


@dataclass(frozen=True)
class Evidence:
    """Everything the classification rests on, in a form a human can check.

    Kept as one object and returned alongside the class because a diagnosis nobody
    can audit is a diagnosis nobody will act on. Every field here is either a
    measured number or the name of a relation.
    """

    violated: str  # which relations moved, and by how much
    single_sensor: str  # the best hypothesis and what became of it
    localisation: str  # what the graph says about where the trouble sits
    feedback: str  # actuators against their commands
    quality: str  # measurement trust caveats, if any
    sparse: str  # what the multi-point solve concentrated on
    ruled_out: tuple[str, ...] = ()  # hypotheses considered and why they failed

    def lines(self) -> list[str]:
        out = [
            f"violated relations : {self.violated}",
            f"single-sensor test : {self.single_sensor}",
            f"localisation       : {self.localisation}",
            f"actuator feedback  : {self.feedback}",
            f"sparse correction  : {self.sparse}",
            f"measurement trust  : {self.quality}",
        ]
        out += [f"ruled out          : {r}" for r in self.ruled_out]
        return out


@dataclass(frozen=True)
class Diagnosis:
    """One classified fault, with the reasoning attached."""

    asset_id: str
    window: tuple[datetime, datetime]
    fault_class: str
    subject: str | None  # the point or actuator held responsible, if any
    confidence: str  # "clear" or "weak"
    reason: str  # one sentence saying why this class and not another
    evidence: Evidence
    localisation: Locality | None = None
    hypothesis: Hypothesis | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# quality flags
# ---------------------------------------------------------------------------


def untrusted_points(
    conn: psycopg.Connection,
    point_ids: list[str],
    window: tuple[datetime, datetime],
) -> dict[str, int]:
    """Points whose readings the quality layer scored below the trusted threshold.

    Read from the advisories raised in checkpoint 3.1. Returned as a caveat, never
    as a vote: see the note at the top of this module for why the advisories cannot
    discriminate a drifting sensor from a healthy one in this building.
    """
    if not point_ids:
        return {}
    rows = conn.execute(
        "SELECT point_id, min(worst_score) FROM app.sensor_advisories "
        " WHERE point_id = ANY(%s) AND t_from < %s AND t_to >= %s "
        " GROUP BY 1",
        (point_ids, window[1], window[0]),
    ).fetchall()
    return {p: int(s) for p, s in rows if s is not None and s < MIN_TRUSTED_QUALITY}


# ---------------------------------------------------------------------------
# the control check, which runs first
# ---------------------------------------------------------------------------


def stuck_actuators(
    feedback: dict[str, Feedback], reference: dict[str, Feedback]
) -> list[Feedback]:
    """Actuators tracking their command materially worse than when healthy.

    Two conditions, and the second one is not optional. The gap has to clear the
    deadband in absolute terms, AND it has to be several times what the same
    actuator's gap was over the fault-free reference window.

    The relative test is there because one actuator here fails the absolute one
    permanently. Supply fan speed sits about 0.5 of full travel from its own command
    on every single run including the fault-free one -- the same source-data defect
    Task 3 found when it discovered sf_status is byte-identical to the occupancy
    schedule. On an absolute test that made a healthy air handler a control fault,
    and because control is checked first it masked both of the faults this checkpoint
    exists to tell apart. Requiring the gap to have GROWN leaves the stuck damper
    firing at 0.612 against a reference of 0.000 and drops the fan at 0.506 against a
    reference of 0.429.
    """
    out = []
    for point_id, gap in feedback.items():
        was = reference.get(point_id)
        baseline = was.mean_gap if was is not None else 0.0
        if gap.mean_gap > CONTROL_GAP and gap.mean_gap > CONTROL_GROWTH * baseline:
            out.append(gap)
    return sorted(out, key=lambda f: -f.mean_gap)


# ---------------------------------------------------------------------------
# classification
# ---------------------------------------------------------------------------


def classify(
    conn: psycopg.Connection,
    asset_id: str,
    isolation: Isolation,
    degrading: bool,
    degrading_detail: str = "",
) -> Diagnosis:
    """Assign a class to whatever is wrong with this asset over this window.

    `degrading` comes from the health layer -- whether any failure mode on this asset
    has a confirmed, significant degradation trend. It is what lets the equipment
    branch fire when the measurements are all mutually consistent: consistency alone
    is also what a perfectly healthy machine looks like, so something has to
    distinguish "nothing wrong" from "wearing out invisibly to the constraint set",
    and that something is the degradation evidence from checkpoints 5.1 and 5.3.
    """
    every_point = sorted({p for r in isolation.relations for p in r.sensitivity})
    untrusted = untrusted_points(conn, every_point, isolation.window)
    quality_note = (
        "all participating measurements trusted"
        if not untrusted
        else "; ".join(f"{p} scored {s}" for p, s in sorted(untrusted.items()))
        + " (advisory only, does not change the class)"
    )

    stuck = stuck_actuators(isolation.feedback, isolation.reference_feedback)
    feedback_note = (
        "; ".join(
            f"{f.point_id.split('.')[-1]} vs command {f.mean_gap:.4f}"
            for f in sorted(isolation.feedback.values(), key=lambda f: -f.mean_gap)[:4]
        )
        or "no commanded actuators on this asset"
    )
    sparse_note = (
        ", ".join(
            f"{p} {isolation.sparse_correction[p]:+.3f}"
            for p in isolation.sparse_support[:3]
        )
        or "nothing"
    )

    best = isolation.best
    ranked = [h for h in isolation.hypotheses if abs(h.implied_bias) > 0.0]
    ruled_out = tuple(
        f"{h.point_id}: {h.verdict}" for h in ranked[:4] if not h.survives
    )
    where = locality(isolation.relations, best.point_id) if best else None

    def build(single: str, localisation_note: str) -> Evidence:
        return Evidence(
            violated=violated_summary(isolation.relations),
            single_sensor=single,
            localisation=localisation_note,
            feedback=feedback_note,
            quality=quality_note,
            sparse=sparse_note,
            ruled_out=ruled_out,
        )

    # ---- 1. an actuator that will not follow its command -------------------
    if stuck:
        worst = stuck[0]
        return Diagnosis(
            asset_id=asset_id,
            window=isolation.window,
            fault_class=CONTROL,
            subject=worst.point_id,
            confidence="clear",
            reason=(
                f"{worst.point_id} sits {worst.mean_gap:.3f} of full travel away from "
                f"{worst.command_id} on average and up to {worst.max_gap:.3f} at "
                f"worst, so the hardware is not doing what it is told; that is a "
                f"control fault and it is checked before the others because such an "
                f"actuator also makes a sensor hypothesis look attractive"
            ),
            evidence=build(
                "not reached -- an unresponsive actuator invalidates it",
                "not reached",
            ),
            notes=("checked before the sensor and equipment tests by design",),
        )

    # ---- 2. one measurement that explains everything ----------------------
    if isolation.any_violation and best is not None and where is not None:
        single = (
            f"{best.point_id} biased {best.implied_bias:+.3f} explains "
            f"{best.explained * 100:.0f} percent across "
            f"{len(best.relations)} relations, and makes none of them worse"
        )
        if where.localised:
            weak = best.point_id in untrusted
            return Diagnosis(
                asset_id=asset_id,
                window=isolation.window,
                fault_class=SENSOR,
                subject=best.point_id,
                confidence="weak" if weak else "clear",
                reason=(
                    f"assuming {best.point_id} reads {best.implied_bias:+.3f} wrong "
                    f"reconciles {best.explained * 100:.0f} percent of the violation "
                    f"across the {len(best.relations)} relations it appears in "
                    f"without making any of them worse, and "
                    f"{where.score * 100:.0f} percent of the violation in its "
                    f"neighbourhood is on relations it can reach -- so the "
                    f"measurement is wrong and the machine is not"
                ),
                evidence=build(single, where.verdict),
                localisation=where,
                hypothesis=best,
            )
        return Diagnosis(
            asset_id=asset_id,
            window=isolation.window,
            fault_class=AMBIGUOUS,
            subject=best.point_id,
            confidence="weak",
            reason=(
                f"a bias on {best.point_id} fits the numbers, but only "
                f"{where.score * 100:.0f} percent of the nearby violation is on "
                f"relations containing it, so coupled measurements moved as well and "
                f"a changed physical state explains the rest at least as well"
            ),
            evidence=build(single, where.verdict),
            localisation=where,
            hypothesis=best,
        )

    # ---- 3. a violation no single measurement can account for --------------
    if isolation.any_violation:
        unfalsifiable = [
            h for h in isolation.hypotheses
            if not h.falsifiable and h.explained >= 0.5 and abs(h.implied_bias) > 0.0
        ]
        independent = independent_sets(isolation.relations)
        if unfalsifiable and not independent:
            names = ", ".join(h.point_id for h in unfalsifiable[:3])
            return Diagnosis(
                asset_id=asset_id,
                window=isolation.window,
                fault_class=AMBIGUOUS,
                subject=unfalsifiable[0].point_id,
                confidence="weak",
                reason=(
                    f"the only measurements that would explain this ({names}) each "
                    f"appear in a single relation, so blaming them cannot be "
                    f"contradicted by anything and carries no information; the "
                    f"instrumentation cannot decide this case, and one more relation "
                    f"containing any of them would"
                ),
                evidence=build(
                    f"{names} would fit, but none appears in more than one relation",
                    "not decisive",
                ),
                notes=("add a relation covering these points to make this decidable",),
            )
        return Diagnosis(
            asset_id=asset_id,
            window=isolation.window,
            fault_class=EQUIPMENT,
            subject=None,
            confidence="clear",
            reason=(
                "no single measurement can be biased in a way that reconciles what "
                "is violated -- every candidate either leaves most of it standing or "
                "would push another relation it appears in further out -- so the "
                "measurements are consistent with each other and the machine is what "
                "changed"
            ),
            evidence=build(
                "no surviving single-sensor hypothesis",
                f"{independent} violated relations share no point with any other",
            ),
        )

    # ---- 4. everything consistent, but the machine is still declining -----
    if degrading:
        detail = degrading_detail or "a failure mode is confirmed to be degrading"
        return Diagnosis(
            asset_id=asset_id,
            window=isolation.window,
            fault_class=EQUIPMENT,
            subject=None,
            confidence="clear",
            reason=(
                "every physical relation still holds to within its own noise, so no "
                f"measurement is lying, and yet {detail} -- measurements that agree "
                "with each other while performance falls is what a wearing machine "
                "looks like"
            ),
            evidence=build(
                "no violation to explain, so no hypothesis was needed",
                "nothing violated anywhere",
            ),
        )

    # ---- 5. nothing to report ---------------------------------------------
    return Diagnosis(
        asset_id=asset_id,
        window=isolation.window,
        fault_class=AMBIGUOUS,
        subject=None,
        confidence="clear",
        reason=(
            "no relation is violated and no failure mode is confirmed to be "
            "degrading, so there is nothing here to classify"
        ),
        evidence=build("no violation", "nothing violated anywhere"),
        notes=("this is the expected result on a healthy asset",),
    )
