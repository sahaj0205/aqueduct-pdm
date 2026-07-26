"""Decide whether a fault is a fault of its own or the shadow of one upstream.

Every layer before this one looks at one machine at a time. That is the right way
to detect, and the wrong way to dispatch. A chiller that has lost capacity sends
warm chilled water down the loop; the air handler's coil then cannot reach its
supply air setpoint however far it opens its valve; and the air handler, examined
on its own evidence, is failing. Send someone to the air handler and they will
find a coil that is working perfectly and a valve doing everything it was asked.
The machine that needs attention is two hops upstream and looks, from the air
handler's point of view, like nothing at all.

Two independent things have to be true before this module will call a fault a
consequence of another, and keeping them separate is the point of the design.

    1. TOPOLOGY -- the suspected cause has to sit upstream of the symptom in THIS
       building. That is answered by the semantic model, through
       open_faults_upstream.rq, and it is a fact about how the pipes are
       connected rather than an opinion about physics. If somebody re-plumbs the
       plant, the .ttl changes and this answer changes with it.

    2. MECHANISM -- the upstream failure mode has to be one that can actually
       produce this downstream symptom. That is answered by the declarative map
       below, and it is a physical claim, written down once, in one place, where
       it can be argued with.

Neither alone is enough. Two faults on connected assets are constantly a
coincidence -- a fan bearing wearing out on the air handler has nothing to do
with the chiller upstream of it, however firmly the graph joins them. And a
mechanism that is real in general is irrelevant if the two machines are not
connected in this particular building.

WHAT GETS ADMITTED TO THE MAP, AND WHY THAT RULE MATTERS

A cause must be a fault that degrades the MEDIUM the downstream asset consumes.
Here the medium is chilled water and the property that matters is its
temperature. A chiller losing capacity, or losing refrigerant charge, or fouled
badly enough to be short of capacity, all send warmer water than the coil was
sized for, and that reaches the air handler. A chiller burning more electricity
per ton of cooling does not: it is still making the water, it is just paying more
for it, and an air handler downstream cannot tell and does not care. Efficiency
loss is therefore NOT in the map, and neither are the two chiller rules that
detect surplus lift and surplus power -- they report a cost, not a degraded
medium. Without that admission rule this table degenerates into a list of
opinions about which faults feel related.

DEMOTE, DO NOT HIDE

A consequential advisory is ranked below its cause and stays in the queue, with
the upstream link shown next to it. Suppressing it outright would be the tidier
output and it is the wrong behaviour, because this inference can be wrong in a
way the operator can see and the system cannot. The cross-asset chain rests on a
graph edge and a claimed mechanism; the symptom may simply have its own separate
cause that happened to start in the same week. An operator who once opens a
suppressed advisory and finds a genuine independent fault underneath it stops
trusting the ranking, and after that they read the raw alarm list instead and
every layer in this project is wasted. A demoted advisory costs a line of screen
space. A hidden one costs the operator's belief that the queue is complete.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

import psycopg
from rdflib import Graph, URIRef

from model.graph import open_faults_upstream
from model.loader import local_name

log = logging.getLogger("diagnosis.rootcause")

# How much of its own priority a consequential advisory keeps. A symptom must
# stop competing with its own cause for the top of the queue, so the cut has to
# be large; it must also still outrank routine low-value work, because it might
# be a genuine independent fault, so the cut cannot be to nothing. At 0.4 a
# symptom whose own priority is more than two and a half times a piece of routine
# work still ranks above that work after being demoted. The value is a placement,
# not a fitted number -- see the judgement call in the checkpoint report.
DEMOTION_FACTOR = 0.4

# A demoted advisory is additionally forced this far below its own cause's
# priority. Multiplying by DEMOTION_FACTOR alone does not guarantee the symptom
# lands under the cause -- a severe symptom fed by a mild cause can still come
# out on top of it -- and "ranked below its cause" is the property this module
# exists to provide, so it is enforced rather than hoped for.
CAUSE_MARGIN = 0.05

# How long a cause may go unobserved and still be used to explain a symptom.
#
# A fault is open from the day it is detected until the day somebody repairs it,
# and app.maintenance_events -- the table that records a repair -- is empty for
# every asset here, so nothing detected in this project has ever been closed. A
# condenser fouled in July is certainly still fouled in September. So the two
# findings do NOT have to be observed on overlapping days for one to explain the
# other; requiring that would mean a cause stops being able to explain anything
# the moment its own sensor coverage lapses, which is backwards.
#
# What does have to hold is that the belief in the cause is current. Thirty days
# is placed against the shortest run-to-failure in this project -- the coil leak
# at 45 days -- so a month of silence still sits inside the same failure episode
# that produced the evidence. Past that the cause has to be re-confirmed before it
# is allowed to excuse another machine, because a stale attribution is worse than
# none: it sends nobody anywhere.
MAX_EVIDENCE_AGE_DAYS = 30.0


# ---------------------------------------------------------------------------
# what an open fault is
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OpenFault:
    """One unresolved finding about one asset, from whichever layer found it.

    Deliberately flat and detector-agnostic. The rule engine reports episodes, the
    health layer reports confirmed degradation, and the classifier reports a fault
    class; cross-asset reasoning has to range over all of them, so they arrive here
    reduced to the four things it needs -- which asset, what the finding is called,
    when it was open, and how bad it is.
    """

    asset_id: str
    fault_id: str  # a failure mode id or a rule id -- whatever named it
    source: str  # "failure_mode" or "rule"
    title: str
    t_from: datetime
    t_to: datetime
    severity: float  # 0 to 1, comparable across detectors
    detail: str = ""

    @property
    def key(self) -> tuple[str, str]:
        return (self.asset_id, self.fault_id)


@dataclass(frozen=True)
class Concurrency:
    """Whether a cause was believable at the time a symptom was seen.

    Two numbers rather than one boolean, because they say different things and an
    operator needs both. `overlap_days` is how long the two were observed together
    -- direct evidence. `evidence_age_days` is how long the cause had gone
    unobserved before the symptom started, and it is zero whenever the windows
    genuinely overlap. An attribution resting on three-week-old evidence is still
    worth making and is not the same claim as one resting on simultaneous
    observation, so the difference is carried through to the advisory rather than
    collapsed here.
    """

    overlap_days: float
    evidence_age_days: float

    @property
    def simultaneous(self) -> bool:
        return self.overlap_days > 0.0

    @property
    def summary(self) -> str:
        if self.simultaneous:
            return f"observed together for {self.overlap_days:.1f} days"
        return (
            f"the cause was last observed {self.evidence_age_days:.1f} days before "
            f"the symptom began, and nothing has repaired it since"
        )


def concurrency(symptom: OpenFault, cause: OpenFault) -> Concurrency | None:
    """Whether `cause` could have been in force when `symptom` appeared.

    Fails in two directions. A cause that only began AFTER the symptom was last
    seen cannot have produced it -- that is causality, not a threshold. And a cause
    whose last evidence is older than MAX_EVIDENCE_AGE_DAYS is not current enough to
    be leaned on, however plausible the mechanism.
    """
    if cause.t_from > symptom.t_to:
        return None
    overlap = max(
        0.0,
        (min(symptom.t_to, cause.t_to) - max(symptom.t_from, cause.t_from)).total_seconds()
        / 86400.0,
    )
    age = (
        0.0
        if overlap > 0.0
        else max(0.0, (symptom.t_from - cause.t_to).total_seconds() / 86400.0)
    )
    if age > MAX_EVIDENCE_AGE_DAYS:
        return None
    return Concurrency(overlap_days=overlap, evidence_age_days=age)


# ---------------------------------------------------------------------------
# the plausibility map
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Propagation:
    """One claim that an upstream failure can produce a downstream symptom."""

    cause: str  # upstream fault id
    symptom: str  # downstream fault id
    medium: str  # what carries the effect from one to the other
    mechanism: str  # the physical chain, in one sentence


# Small on purpose. Every row is a physical claim that somebody has to be willing
# to defend, and a map that tries to be exhaustive stops being reviewable.
#
# All six rows are the same chain -- a chiller that cannot make cold enough water,
# and an air handler coil that consequently cannot reach its supply air setpoint --
# entered once per (cause detector, symptom detector) pair, because the two ends
# are each detected by more than one thing and the map is keyed on what the
# detectors are called rather than on some intermediate notion of a fault.
#
# DELIBERATELY ABSENT, each for a stated reason:
#   chiller-efficiency-loss      costs power, not capacity. The water still leaves
#                                at setpoint, so nothing reaches the air handler.
#   chiller-excess-lift          same: a condenser-side cost, not a warm supply.
#   chiller-kw-per-ton-residual  same.
#   -> coil-valve-leak-by        WARM chilled water makes supply air warmer. This
#                                symptom is supply air COLDER than it should be, so
#                                an upstream capacity loss suppresses it rather than
#                                causing it. Linking these two would be backwards.
#   -> fan-bearing-degradation   excess fan shaft power at matched airflow. Nothing
#                                on the water side can produce it.
PROPAGATIONS: tuple[Propagation, ...] = (
    Propagation(
        cause="chiller-condenser-fouling",
        symptom="apar-20",
        medium="chilled water supply temperature",
        mechanism=(
            "deposit on the condenser tubes forces a higher condensing temperature, "
            "which costs the compressor capacity as well as power, so chilled water "
            "leaves warmer than the coil downstream was sized for and the coil valve "
            "runs to fully open without reaching supply air setpoint"
        ),
    ),
    Propagation(
        cause="chiller-condenser-fouling",
        symptom="apar-16",
        medium="chilled water supply temperature",
        mechanism=(
            "the same loss of capacity, seen earlier and more mildly: warmer water "
            "means less temperature drop across the coil than its valve position "
            "implies it should be delivering"
        ),
    ),
    Propagation(
        cause="chiller-refrigerant-loss",
        symptom="apar-20",
        medium="chilled water supply temperature",
        mechanism=(
            "a short charge reduces the refrigerant mass the compressor can move, so "
            "the plant runs out of capacity before it runs out of command and chilled "
            "water drifts above setpoint, leaving the coil valve saturated"
        ),
    ),
    Propagation(
        cause="chiller-refrigerant-loss",
        symptom="apar-16",
        medium="chilled water supply temperature",
        mechanism=(
            "the same shortfall at lower severity, showing as too little cooling "
            "across the coil rather than a fully saturated valve"
        ),
    ),
    Propagation(
        cause="chiller-capacity-shortfall",
        symptom="apar-20",
        medium="chilled water supply temperature",
        mechanism=(
            "the plant is measured to be above its own water setpoint with the "
            "compressor already at full command, which is the direct statement that "
            "the coil is being fed water warmer than it needs, whatever caused it"
        ),
    ),
    Propagation(
        cause="chiller-capacity-shortfall",
        symptom="apar-16",
        medium="chilled water supply temperature",
        mechanism=(
            "the same measured shortfall, reaching the coil as too small a "
            "temperature drop rather than as a saturated valve"
        ),
    ),
)


def mechanisms_for(symptom_id: str) -> dict[str, Propagation]:
    """Every upstream fault id that could produce this symptom, keyed by cause."""
    return {p.cause: p for p in PROPAGATIONS if p.symptom == symptom_id}


# ---------------------------------------------------------------------------
# reading confirmed degradation out of the database
# ---------------------------------------------------------------------------


def open_failure_modes(
    conn: psycopg.Connection, window: tuple[datetime, datetime]
) -> list[OpenFault]:
    """Failure modes with a confirmed onset and a health score below full, in window.

    Reads what the health layer already committed rather than recomputing it, so the
    advisory queue and the health page can never disagree about which modes are open.
    A mode qualifies only if the changepoint detector confirmed its onset -- an
    indicator drifting without confirmation is exactly what checkpoint 5.3 refuses to
    publish, and it must not reach an operator through this door either.

    Severity is the distance the mode has travelled toward failure: health 100 is
    zero, health 0 is one. That puts a rule episode's severity and a degradation
    fault's severity in the same units, which is what lets one queue hold both.
    """
    rows = conn.execute(
        """
        WITH latest AS (
            SELECT h.asset_id, h.mode_id, h.time, h.health, h.t_onset,
                   h.indicator_monotonic,
                   row_number() OVER (PARTITION BY h.asset_id, h.mode_id
                                      ORDER BY h.time DESC) AS rn
              FROM app.health_state h
             WHERE h.mode_id IS NOT NULL
               AND h.t_onset IS NOT NULL
               AND h.time >= %(t_from)s AND h.time < %(t_to)s
        )
        SELECT l.asset_id, l.mode_id, m.mode_name, m.indicator_unit,
               l.t_onset, l.time, l.health, l.indicator_monotonic, m.failure_threshold
          FROM latest l
          JOIN app.failure_modes m ON m.mode_id = l.mode_id
         WHERE l.rn = 1 AND l.health IS NOT NULL AND l.health < 100
         ORDER BY l.asset_id, l.mode_id
        """,
        {"t_from": window[0], "t_to": window[1]},
    ).fetchall()

    out: list[OpenFault] = []
    for asset, mode, name, unit, onset, last, health, indicator, threshold in rows:
        out.append(
            OpenFault(
                asset_id=asset,
                fault_id=mode,
                source="failure_mode",
                title=name,
                t_from=max(onset, window[0]),
                t_to=last,
                severity=(100.0 - float(health)) / 100.0,
                detail=(
                    f"health {int(health)}, indicator {indicator:.3f} of "
                    f"{float(threshold):.3f} {unit}, degradation confirmed "
                    f"{onset:%Y-%m-%d}, last scored {last:%Y-%m-%d}"
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# topology
# ---------------------------------------------------------------------------


def nodes_by_asset(mapping: dict[URIRef, str]) -> dict[str, tuple[URIRef, ...]]:
    """Invert the node-to-asset map, because traversal starts from graph nodes.

    One database asset is several graph nodes: the air handler is modelled as a
    coil, two fans, three dampers and five zones, and only ONE of those -- the
    cooling coil -- is on the receiving end of the chilled water loop. Traversing
    from the wrong node finds nothing upstream, so every node of the asset is used
    as a start and the results are unioned.
    """
    out: dict[str, list[URIRef]] = {}
    for node, asset in mapping.items():
        out.setdefault(asset, []).append(node)
    return {a: tuple(sorted(n, key=local_name)) for a, n in out.items()}


def faulted_nodes(
    nodes: dict[str, tuple[URIRef, ...]], faults: Iterable[OpenFault]
) -> dict[URIRef, tuple[str, ...]]:
    """Which graph nodes to mark as carrying which open faults.

    A fault is marked on EVERY node of its asset. The alternative -- guessing which
    part of the machine a fault belongs to -- would need a mapping from failure mode
    to graph node that nothing in the model supplies, and getting it wrong would
    silently break the traversal rather than fail. Marking the whole asset is the
    honest reading of what the detectors actually claim: they name an asset.
    """
    out: dict[URIRef, list[str]] = {}
    for fault in faults:
        for node in nodes.get(fault.asset_id, ()):
            out.setdefault(node, []).append(fault.fault_id)
    return {node: tuple(ids) for node, ids in out.items()}


@dataclass(frozen=True)
class Reach:
    """An upstream asset carrying an open fault, and how far away it is."""

    asset_id: str
    fault_id: str
    hops: int


def upstream_open_faults(
    graph: Graph,
    nodes: dict[str, tuple[URIRef, ...]],
    mapping: dict[URIRef, str],
    asset_id: str,
    faults: Sequence[OpenFault],
) -> list[Reach]:
    """Open faults on assets that feed this one, nearest first.

    Runs open_faults_upstream.rq from every graph node belonging to `asset_id`, with
    the other assets' faults asserted into a throwaway copy of the graph. Results are
    unioned across the start nodes and the shortest hop count is kept, so an upstream
    asset reached by two different internal paths is reported once at its true
    distance. The asset's own faults are excluded -- a machine cannot be upstream of
    itself, and self-attribution would let a fault explain away its own symptom.
    """
    others = [f for f in faults if f.asset_id != asset_id]
    marks = faulted_nodes(nodes, others)
    if not marks:
        return []

    nearest: dict[tuple[str, str], int] = {}
    for start in nodes.get(asset_id, ()):
        for row in open_faults_upstream(graph, start, marks):
            upstream = mapping.get(row.asset)
            if upstream is None or upstream == asset_id:
                continue
            key = (upstream, row.fault)
            if row.hops < nearest.get(key, 1 << 30):
                nearest[key] = row.hops
    return sorted(
        (Reach(a, f, h) for (a, f), h in nearest.items()),
        key=lambda r: (r.hops, r.asset_id, r.fault_id),
    )


# ---------------------------------------------------------------------------
# attribution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Attribution:
    """A symptom, the upstream fault held to have caused it, and the argument."""

    symptom: OpenFault
    cause: OpenFault
    propagation: Propagation
    hops: int
    concurrency: Concurrency

    @property
    def explanation(self) -> str:
        return (
            f"{self.cause.asset_id} is {self.hops} hops upstream on the chilled water "
            f"path and has {self.cause.title.lower()} open; "
            f"{self.propagation.mechanism}. {self.concurrency.summary}"
        )


def attribute(
    graph: Graph,
    mapping: dict[URIRef, str],
    faults: Sequence[OpenFault],
) -> dict[tuple[str, str], Attribution]:
    """For each open fault, the nearest upstream fault that plausibly explains it.

    Three conditions, all required. The candidate has to be upstream in the graph;
    the pair has to appear in the plausibility map; and the cause has to have been
    in force, and still currently believed, when the symptom appeared. Ties are
    broken by hop distance first and then by the cause's severity, so a chiller two
    hops away is preferred to a cooling tower four hops away that would explain the
    same thing -- the near cause is the one to send somebody to, and if it is itself
    consequential on the far one this same pass will say so.
    """
    nodes = nodes_by_asset(mapping)
    by_key = {f.key: f for f in faults}
    out: dict[tuple[str, str], Attribution] = {}

    for symptom in faults:
        mechanisms = mechanisms_for(symptom.fault_id)
        if not mechanisms:
            continue
        reachable = upstream_open_faults(graph, nodes, mapping, symptom.asset_id, faults)
        candidates: list[tuple[int, float, Attribution]] = []
        for reach in reachable:
            propagation = mechanisms.get(reach.fault_id)
            cause = by_key.get((reach.asset_id, reach.fault_id))
            if propagation is None or cause is None:
                continue
            when = concurrency(symptom, cause)
            if when is None:
                log.debug(
                    "%s is upstream of %s and the mechanism holds, but it was not in "
                    "force when the symptom appeared",
                    cause.key, symptom.key,
                )
                continue
            candidates.append(
                (
                    reach.hops,
                    -cause.severity,
                    Attribution(symptom, cause, propagation, reach.hops, when),
                )
            )
        if candidates:
            out[symptom.key] = min(candidates, key=lambda c: (c[0], c[1]))[2]
    return out


# ---------------------------------------------------------------------------
# ranking
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ranked:
    """One advisory's place in the queue, and whether it was moved."""

    fault: OpenFault
    priority: float  # after demotion
    own_priority: float  # what it would have been on its own evidence
    attribution: Attribution | None

    @property
    def consequential(self) -> bool:
        return self.attribution is not None

    @property
    def demotion(self) -> float:
        """How much priority the demotion cost, in the priority's own units."""
        return self.own_priority - self.priority


def demote(own: float, cause_priority: float) -> float:
    """Cut a symptom's priority, and force it under its cause's.

    Two mechanisms rather than one because they do different jobs. The multiplier
    expresses that a consequence is worth less attention than a cause in general.
    The clamp against the cause guarantees the specific ordering this module
    promises. When the cause has no positive priority the clamp is skipped -- there
    is nothing to sit under, and clamping to zero or below would hide the symptom,
    which is the behaviour this whole module is arranged to avoid.
    """
    cut = own * DEMOTION_FACTOR
    if cause_priority <= 0.0:
        return cut
    return min(cut, cause_priority * (1.0 - CAUSE_MARGIN))


def rank(
    faults: Sequence[OpenFault],
    priorities: dict[tuple[str, str], float],
    attributions: dict[tuple[str, str], Attribution],
) -> list[Ranked]:
    """Order the queue, demoting every consequential advisory below its cause.

    `priorities` is supplied by the caller rather than computed here: this module
    knows about topology and mechanism and has no business deciding what a fault is
    worth. Checkpoint 6.2 passes in a cost of inaction; the verification for this
    checkpoint passes in severity.

    Chains are resolved by recursion, so if a cooling tower causes a chiller fault
    which in turn causes an air handler symptom, the air handler is demoted below the
    chiller's ALREADY DEMOTED priority rather than below its undemoted one. Without
    that a two-step chain could leave the last symptom outranking the middle link.
    The visiting set makes a cycle in the attribution graph terminate at the raw
    priority instead of recursing forever -- a cycle should be impossible, since the
    graph edge is directional, but a silent hang would be a poor way to find out.
    """
    own = {f.key: priorities.get(f.key, f.severity) for f in faults}
    resolved: dict[tuple[str, str], float] = {}

    def effective(key: tuple[str, str], visiting: frozenset) -> float:
        if key in resolved:
            return resolved[key]
        attribution = attributions.get(key)
        if attribution is None or key in visiting:
            value = own[key]
        else:
            cause_key = attribution.cause.key
            cause = (
                effective(cause_key, visiting | {key})
                if cause_key in own
                else own.get(cause_key, 0.0)
            )
            value = demote(own[key], cause)
        resolved[key] = value
        return value

    ranked = [
        Ranked(
            fault=fault,
            priority=effective(fault.key, frozenset()),
            own_priority=own[fault.key],
            attribution=attributions.get(fault.key),
        )
        for fault in faults
    ]
    return sorted(ranked, key=lambda r: (-r.priority, r.fault.asset_id, r.fault.fault_id))
