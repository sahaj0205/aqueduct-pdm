"""The rule registry: what a rule is, and which equipment each one applies to.

A rule is registered against a BRICK CLASS, never against an asset id and never
against an enum this project invented:

    @rule(id="apar-1", applies_to="brick:Air_Handling_Unit",
          modes=[Mode.HEATING], min_input_quality=70, persistence_minutes=15)
    def supply_air_too_cold(ctx: RuleContext) -> Verdict:
        ...

That choice is the whole point of the file. With rules keyed to asset ids,
adding a third piece of equipment means editing detection, health and
remaining-life code. Keyed to class, a new machine is a .ttl entry plus a rule
registration and nothing here changes -- dispatch already knows how to match a
class it has never seen, because the matching is a graph query rather than a
lookup table.

Matching goes through Brick's own taxonomy, so the example above fires on an
asset the LBNL model types as brick:AHU: Brick declares those two equivalent.
The same mechanism means a rule written for brick:Chiller covers a
brick:Centrifugal_Chiller without being told about it.

THE QUALITY GATE IS ENFORCED HERE, NOT IN THE RULES. Every reading a rule looks
at goes through RuleContext, which refuses to hand over a value scored below the
rule's min_input_quality and returns insufficient_data_quality instead. A rule
physically cannot fire on a reading it was not allowed to see, so a dead sensor
cannot be reported as a broken machine by a rule author who forgot to check.
The same mechanism records the actual values a rule read, so every outcome
carries the evidence without the rule having to assemble it.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS

from model.loader import BRICK, local_name

# ---------------------------------------------------------------------------
# what a rule reports
# ---------------------------------------------------------------------------


class RuleStatus(str, Enum):
    """Why a rule produced the answer it did.

    Distinguishing NOT_FIRED from INSUFFICIENT_DATA_QUALITY matters enormously
    downstream: the first says the equipment looks fine, the second says nobody
    knows. Collapsing them into a boolean would let a building full of dead
    sensors report a clean bill of health.
    """

    FIRED = "fired"
    NOT_FIRED = "not_fired"
    INSUFFICIENT_DATA_QUALITY = "insufficient_data_quality"
    INPUT_MISSING = "input_missing"
    MODE_NOT_APPLICABLE = "mode_not_applicable"


class CostUnit(str, Enum):
    """What a rule's consequence is measured in.

    Three units because the faults have three different kinds of consequence and
    forcing them into one currency this early would bury the reasoning. Money
    conversion belongs in the advisory layer, where tariffs live.
    """

    ENERGY_KWH = "kWh"
    WATER_LITRES = "L"
    COMFORT_DEGREE_HOURS = "degC-h"


@dataclass(frozen=True)
class CostEstimate:
    """What this fault is costing, per hour of it continuing."""

    unit: CostUnit
    amount: float
    basis: str  # plain-language statement of how the number was arrived at


@dataclass(frozen=True)
class InputReading:
    """One value a rule actually looked at, as it looked at it."""

    point_id: str
    role: str  # what the rule calls it, e.g. "mixed air temperature"
    value: float
    quality: int


@dataclass(frozen=True)
class Verdict:
    """What a rule body returns. The framework adds the evidence around it."""

    fired: bool
    severity: float = 0.0  # 0..1 contribution toward the asset's degradation
    cost: CostEstimate | None = None
    detail: str = ""


@dataclass(frozen=True)
class RuleOutcome:
    """One evaluation of one rule against one asset at one instant."""

    rule_id: str
    asset_id: str
    at: datetime
    status: RuleStatus
    severity: float
    cost: CostEstimate | None
    inputs: tuple[InputReading, ...]
    detail: str
    mode: str | None

    @property
    def fired(self) -> bool:
        return self.status is RuleStatus.FIRED


@dataclass(frozen=True)
class Reading:
    """A point's value and how far it can be trusted, as the scorer left it.

    `flags` is the quality layer's breakdown of WHY the composite is what it is:
    the dimensions scoring below 100, by name. It is carried alongside the
    composite because some rules need to know the reason and not just the number
    -- see effective_quality below.
    """

    value: float | None
    quality: int | None
    flags: dict[str, int] | None = None


# The one quality dimension that does not mean the reading is wrong.
#
# A reading can score badly for five reasons. Four of them -- it never arrived,
# it arrived empty, it is outside what is physically possible, it moved faster
# than physics allows -- say the NUMBER cannot be believed. Staleness says
# something different: the number stopped changing. A stuck sensor still reports
# a perfectly valid value, and a stuck damper really is sitting at the position
# it reports.
#
# That distinction is what lets a rule whose whole purpose is to catch a seized
# actuator read the very point whose immobility is the symptom. Without it the
# quality layer suppresses exactly the rule that was going to explain it.
STALENESS = "staleness"


def effective_quality(reading: Reading, staleness_is_evidence: bool) -> int | None:
    """The trust score a rule should judge this reading by.

    Normally the composite the quality layer wrote. For a rule that treats a
    motionless reading as its evidence, the composite is recomputed across the
    other four dimensions only, so a point marked down purely for not moving is
    still readable while one that is genuinely out of range is still refused.
    """
    if not staleness_is_evidence or reading.flags is None:
        return reading.quality
    others = [score for name, score in reading.flags.items() if name != STALENESS]
    return 100 if not others else min(others)


# ---------------------------------------------------------------------------
# the context a rule sees
# ---------------------------------------------------------------------------


class InsufficientQuality(Exception):
    """Raised when a rule asks for a reading it is not allowed to trust."""

    def __init__(self, point_id: str, quality: int | None, required: int):
        self.point_id = point_id
        self.quality = quality
        self.required = required
        super().__init__(
            f"{point_id} scored {quality} against a required {required}"
        )


class InputMissing(Exception):
    """Raised when a rule asks for a point that has no reading at this instant."""

    def __init__(self, point_id: str):
        self.point_id = point_id
        super().__init__(f"{point_id} has no reading")


class RuleContext:
    """The only way a rule may reach a measurement.

    Every read is checked against the rule's minimum quality and recorded. A rule
    that wants to look at the mixed air temperature asks for it by point id and
    either gets a trustworthy number or does not run -- there is no third path,
    and no way for a rule to peek at a value it has been refused.
    """

    def __init__(
        self,
        asset_id: str,
        at: datetime,
        readings: Mapping[str, Reading],
        mode: str | None,
        min_input_quality: int,
        staleness_is_evidence: frozenset[str] = frozenset(),
    ):
        self.asset_id = asset_id
        self.at = at
        self.mode = mode
        self._readings = readings
        self._min_quality = min_input_quality
        self._staleness_ok = staleness_is_evidence
        self._seen: list[InputReading] = []

    def value(self, point_id: str, role: str) -> float:
        """Fetch a reading, or refuse to let the rule continue."""
        reading = self._readings.get(point_id)
        if reading is None or reading.value is None:
            raise InputMissing(point_id)
        quality = effective_quality(reading, point_id in self._staleness_ok)
        if quality is None or quality < self._min_quality:
            # Record it before raising, so the outcome can name the point that
            # blocked the rule rather than just saying something was untrusted.
            self._seen.append(InputReading(point_id, role, reading.value, quality or 0))
            raise InsufficientQuality(point_id, quality, self._min_quality)
        self._seen.append(InputReading(point_id, role, reading.value, quality))
        return reading.value

    def optional(self, point_id: str, role: str) -> float | None:
        """Fetch a reading the rule can do without. Quality is still enforced."""
        reading = self._readings.get(point_id)
        if reading is None or reading.value is None:
            return None
        return self.value(point_id, role)

    @property
    def inputs(self) -> tuple[InputReading, ...]:
        return tuple(self._seen)


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RegisteredRule:
    """A rule and the conditions under which it is allowed to run."""

    rule_id: str
    applies_to: str  # a Brick class, prefixed form, e.g. "brick:AHU"
    fn: Callable[[RuleContext], Verdict]
    modes: tuple[str, ...] = ()
    min_input_quality: int = 70
    persistence_minutes: int = 15
    description: str = ""
    # Points this rule may read even when the quality layer marked them down for
    # not moving. Declared per rule and per point, never globally, so the
    # exemption is visible at the top of the rule that needs it.
    staleness_is_evidence: tuple[str, ...] = ()

    @property
    def applies_to_uri(self) -> URIRef:
        return to_uri(self.applies_to)


_REGISTRY: dict[str, RegisteredRule] = {}


def rule(
    id: str,  # shadows the builtin; the checkpoint specifies this keyword name
    applies_to: str,
    modes: Iterable[object] = (),
    min_input_quality: int = 70,
    persistence_minutes: int = 15,
    staleness_is_evidence: Iterable[str] = (),
):
    """Register a rule against a Brick class.

    modes are opaque here on purpose. The registry knows nothing about what an
    air handler's operating modes are, which is what lets the same registry hold
    chiller rules that have no notion of an economizer. Whatever the caller
    passes is compared by its string form against the mode supplied at
    evaluation time; an empty list means the rule applies in every mode.

    persistence_minutes is recorded but not enforced here. Holding a condition
    open across time is transient suppression, which lives in the evaluation
    driver; this field is where it reads the requirement from.

    staleness_is_evidence names points this rule may read even when the quality
    layer marked them down purely for not changing. It exists for rules that
    detect a seized actuator or a frozen sensor, where a motionless reading is
    the symptom rather than an obstacle -- without it the quality gate suppresses
    precisely the rule that was going to explain the flag. It is declared per
    rule and per point so the exemption is visible at the top of the rule that
    claims it, and it never waives the other four quality dimensions: a reading
    that is out of range or impossibly fast is still refused.
    """

    def register(fn: Callable[[RuleContext], Verdict]) -> Callable[[RuleContext], Verdict]:
        if id in _REGISTRY:
            raise ValueError(f"duplicate rule id {id!r}, already registered")
        if not 0 <= min_input_quality <= 100:
            raise ValueError(f"{id}: min_input_quality must be 0..100")
        _REGISTRY[id] = RegisteredRule(
            rule_id=id,
            applies_to=applies_to,
            fn=fn,
            modes=tuple(_mode_name(m) for m in modes),
            min_input_quality=min_input_quality,
            persistence_minutes=persistence_minutes,
            description=(fn.__doc__ or "").strip().split("\n")[0],
            staleness_is_evidence=tuple(staleness_is_evidence),
        )
        return fn

    return register


def _mode_name(mode: object) -> str:
    return mode.value if isinstance(mode, Enum) else str(mode)


def registered_rules() -> tuple[RegisteredRule, ...]:
    """Every rule registered so far, in registration order."""
    return tuple(_REGISTRY.values())


def clear_registry() -> None:
    """Drop every registration. Only for demonstration entry points."""
    _REGISTRY.clear()


# ---------------------------------------------------------------------------
# dispatch, through the Brick taxonomy
# ---------------------------------------------------------------------------


def to_uri(prefixed: str) -> URIRef:
    """Turn "brick:AHU" into the full Brick URI."""
    if prefixed.startswith("brick:"):
        return BRICK[prefixed.split(":", 1)[1]]
    return URIRef(prefixed)


def class_closure(graph: Graph, cls: URIRef) -> set[URIRef]:
    """The class itself and every class it is a kind of.

    Walks rdfs:subClassOf upward and owl:equivalentClass in both directions.
    Both directions are needed because equivalence is symmetric by definition but
    Brick only asserts it once -- the file says Air_Handling_Unit is equivalent
    to AHU and never the reverse, and rdflib does no reasoning of its own, so an
    asset typed AHU would otherwise never match a rule written for
    Air_Handling_Unit.

    Breadth-first, and a class already seen is never queued again, so the cycle
    that equivalence pairs inevitably create terminates.
    """
    seen = {cls}
    queue: deque[URIRef] = deque([cls])
    while queue:
        node = queue.popleft()
        neighbours = set(graph.objects(node, RDFS.subClassOf))
        neighbours |= set(graph.objects(node, OWL.equivalentClass))
        neighbours |= set(graph.subjects(OWL.equivalentClass, node))
        for neighbour in neighbours:
            if isinstance(neighbour, URIRef) and neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    return seen


def rules_for_class(graph: Graph, brick_class: str) -> list[RegisteredRule]:
    """Every registered rule that applies to equipment of this Brick class.

    This is the dispatch the checkpoint asks for, and it contains no mention of
    any particular equipment. A rule matches when the class it was registered
    against appears anywhere in the asset's class ancestry, so adding a fourth
    kind of machine needs a .ttl entry and a rule, and not a line here.
    """
    ancestry = class_closure(graph, to_uri(brick_class))
    return [r for r in _REGISTRY.values() if r.applies_to_uri in ancestry]


def asset_class_from_graph(graph: Graph, asset_id: str, declared: str) -> str:
    """Confirm the catalogue's class for an asset against the graph, and return it.

    The class the database records and the class the graph records are two
    independent statements about the same machine, so a disagreement means one of
    them is wrong and this raises rather than silently preferring either. The
    graph models an air handler as many nodes -- coil, fan, dampers, five zones --
    so the test is that SOME node belonging to this asset carries the declared
    class, not that every node does.
    """
    from model.graph import node_to_asset_id

    mapping, _ = node_to_asset_id(graph)
    types = {
        local_name(t)
        for node, owner in mapping.items()
        if owner == asset_id
        for t in graph.objects(node, RDF.type)
    }
    if local_name(to_uri(declared)) not in types:
        raise ValueError(
            f"{asset_id} is recorded as {declared} but no graph node belonging to "
            f"it carries that class; the graph has {sorted(types)}"
        )
    return declared


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------


def evaluate_rule(
    registered: RegisteredRule,
    asset_id: str,
    at: datetime,
    readings: Mapping[str, Reading],
    mode: str | None = None,
) -> RuleOutcome:
    """Run one rule against one asset at one instant.

    The rule body is only reached if the mode allows it, and it can only reach
    readings that clear its quality bar. Whatever it returns is wrapped together
    with the readings it actually consulted.
    """

    def outcome(status: RuleStatus, verdict: Verdict, inputs) -> RuleOutcome:
        return RuleOutcome(
            rule_id=registered.rule_id,
            asset_id=asset_id,
            at=at,
            status=status,
            severity=verdict.severity,
            cost=verdict.cost,
            inputs=inputs,
            detail=verdict.detail,
            mode=mode,
        )

    if registered.modes and _mode_name(mode) not in registered.modes:
        return outcome(
            RuleStatus.MODE_NOT_APPLICABLE,
            Verdict(False, detail=f"applies in {', '.join(registered.modes)}; mode is {mode}"),
            (),
        )

    ctx = RuleContext(
        asset_id,
        at,
        readings,
        mode,
        registered.min_input_quality,
        frozenset(registered.staleness_is_evidence),
    )
    try:
        verdict = registered.fn(ctx)
    except InsufficientQuality as refused:
        return outcome(
            RuleStatus.INSUFFICIENT_DATA_QUALITY,
            Verdict(
                False,
                detail=(
                    f"{refused.point_id} scored {refused.quality} against the "
                    f"{refused.required} this rule requires, so no conclusion was "
                    f"drawn about the equipment"
                ),
            ),
            ctx.inputs,
        )
    except InputMissing as missing:
        return outcome(
            RuleStatus.INPUT_MISSING,
            Verdict(False, detail=f"{missing.point_id} has no reading at this instant"),
            ctx.inputs,
        )

    return outcome(
        RuleStatus.FIRED if verdict.fired else RuleStatus.NOT_FIRED, verdict, ctx.inputs
    )


def evaluate_asset(
    graph: Graph,
    asset_id: str,
    brick_class: str,
    at: datetime,
    readings: Mapping[str, Reading],
    mode: str | None = None,
) -> list[RuleOutcome]:
    """Run every rule that applies to this asset's class."""
    return [
        evaluate_rule(registered, asset_id, at, readings, mode)
        for registered in rules_for_class(graph, brick_class)
    ]


# ---------------------------------------------------------------------------
# demonstration entry point
#
# Run with:  uv run python -m analytics.rules.registry
#
# Registers throwaway rules and shows dispatch resolving them against the real
# assets purely by Brick class. Nothing here is imported by the rest of the
# project; the actual rules arrive in the next checkpoint.
# ---------------------------------------------------------------------------


def _demo() -> int:
    from datetime import UTC

    import psycopg

    from analytics.rules.readings import resolve_dsn
    from model.loader import load_merged_graph

    # A trivial rule, registered against the LONG spelling of the air handler
    # class. The assets in this building are typed brick:AHU, so this only ever
    # matches if dispatch is genuinely consulting Brick's taxonomy.
    @rule(
        id="demo-supply-air-above-setpoint",
        applies_to="brick:Air_Handling_Unit",
        min_input_quality=70,
        persistence_minutes=15,
    )
    def supply_air_above_setpoint(ctx: RuleContext) -> Verdict:
        """Supply air is warmer than it is being asked to be."""
        supply = ctx.value("ahu-1.sa_temp", "supply air temperature")
        setpoint = ctx.value("ahu-1.sa_temp_spt", "supply air temperature setpoint")
        excess = supply - setpoint
        return Verdict(
            fired=excess > 1.0,
            severity=min(1.0, max(0.0, excess / 10.0)),
            cost=CostEstimate(
                CostUnit.COMFORT_DEGREE_HOURS,
                max(0.0, excess),
                "degrees above setpoint, held for an hour",
            ),
            detail=f"supply air {supply:.2f} degC against a setpoint of {setpoint:.2f} degC",
        )

    # A second rule on a different class, to show that dispatch separates them.
    @rule(id="demo-chiller-running", applies_to="brick:Chiller", min_input_quality=70)
    def chiller_running(ctx: RuleContext) -> Verdict:
        """Chiller is drawing power."""
        power = ctx.value("chiller-1.power", "chiller electrical power")
        return Verdict(fired=power > 1000.0, detail=f"{power / 1000:.1f} kW")

    graph, _ = load_merged_graph()
    print("=== registered rules ===")
    for registered in registered_rules():
        print(
            f"  {registered.rule_id:<32} applies_to={registered.applies_to:<28} "
            f"min_quality={registered.min_input_quality} "
            f"persistence={registered.persistence_minutes}min"
        )

    with psycopg.connect(resolve_dsn()) as conn:
        assets = conn.execute(
            "SELECT asset_id, brick_class FROM app.assets ORDER BY asset_id"
        ).fetchall()

        print("\n=== dispatch: which rules apply to which asset, resolved by class ===")
        print(f"  {'asset':<14}{'brick_class':<30}{'rules that apply'}")
        for asset_id, brick_class in assets:
            confirmed = asset_class_from_graph(graph, asset_id, brick_class)
            matched = rules_for_class(graph, confirmed)
            names = ", ".join(r.rule_id for r in matched) or "-"
            print(f"  {asset_id:<14}{confirmed:<30}{names}")

        print("\n=== why brick:AHU matches a rule written for brick:Air_Handling_Unit ===")
        closure = class_closure(graph, to_uri("brick:AHU"))
        print(f"  class ancestry of brick:AHU: {sorted(local_name(c) for c in closure)}")
        print(f"  contains Air_Handling_Unit -> {to_uri('brick:Air_Handling_Unit') in closure}")

        print("\n=== the quality gate ===")
        stamp = conn.execute(
            "SELECT max(time) FROM app.measurements WHERE point_id = 'ahu-1.sa_temp'"
        ).fetchone()[0]
        rows = conn.execute(
            "SELECT point_id, value_si, quality_score FROM app.measurements "
            " WHERE time = %s AND point_id IN ('ahu-1.sa_temp','ahu-1.sa_temp_spt')",
            (stamp,),
        ).fetchall()
        good = {p: Reading(v, q) for p, v, q in rows}
        ahu_rule = _REGISTRY["demo-supply-air-above-setpoint"]

        for label, readings in (
            ("real readings, as scored", good),
            (
                "same instant, supply air sensor scored 12",
                {**good, "ahu-1.sa_temp": Reading(good["ahu-1.sa_temp"].value, 12)},
            ),
        ):
            result = evaluate_rule(ahu_rule, "ahu-1", stamp.replace(tzinfo=UTC), readings)
            print(f"\n  {label}")
            print(f"    status   : {result.status.value}")
            print(f"    fired    : {result.fired}")
            print(f"    detail   : {result.detail}")
            for reading in result.inputs:
                print(
                    f"    input    : {reading.point_id:<22} {reading.role:<34} "
                    f"value={reading.value:>8.2f} quality={reading.quality}"
                )
            if result.cost:
                print(
                    f"    cost     : {result.cost.amount:.2f} {result.cost.unit.value} "
                    f"({result.cost.basis})"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(_demo())
