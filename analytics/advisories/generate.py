"""Assemble one advisory per open fault: what, why, who it hits, and what it costs.

An advisory is the only thing in this project a human is asked to read, so
everything the platform knows about a fault has to arrive in one object, with the
numbers attached rather than referred to. The layout below is the argument a
technician would want made to them, in order:

    what is wrong          asset, failure mode, fault class, health
    when it fails          the prediction interval, or the reason there is none
    why we believe it      the signals, their actual values, and how far they moved
    who it reaches         upstream causes, downstream assets, zones, occupants
    how urgent             severity, from the rate of decline and what it serves
    what it is worth       cost of inaction over the cost of acting
    what to do             the intervention, its duration, skills, parts and cost

TWO RULES THIS MODULE HOLDS TO, AND THEY COST SOMETHING

First, every number is traceable to a computation on measured data. The excess
kilowatts come from the mode's own indicator multiplied by a coefficient measured
on a fault-free run; the hours come from the observed duty in the window; the rate
comes from the semantic model; the probability of failing inside the horizon comes
from the first-passage distribution the remaining-life layer already published.
Nothing is scaled to look reasonable. Where a number cannot be computed -- a mode
with no electrical cost, a prediction the refusal layer declined -- the advisory
says so and the priority falls back to what it does know, which is why
`cost_basis` is a required field on every advisory rather than a nicety.

Second, an advisory never invents a prediction. If checkpoint 5.3 refused to
publish a remaining-life number, this layer reports the refusal and its specific
reason in the place where the interval would have gone. A maintenance planner
reading "likely to fail in 40 to 120 days" and a planner reading "cannot bound
this: the drift is 0.8 standard deviations from zero" make different decisions,
and collapsing the second into a vague version of the first is the single easiest
way to make this whole system untrustworthy.

WATER IS NOT PRICED, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT

The cost of inaction here is electricity and consequential repair, with no water
term. Cooling tower makeup water is the one place a fault in this building would
consume water, and neither LBNL dataset publishes a makeup flow -- the towers ship
a fan speed, a fan power, a circulating flow and two temperatures, and circulating
flow is water going round the loop, not water bought. No rule and no failure mode
in this project produces a water quantity. Rather than convert an evaporation
estimate into litres and call it traceable, the water term is absent and stated.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import psycopg
from rdflib import Graph, URIRef

from analytics.diagnosis.rootcause import Attribution, Ranked
from model.graph import downstream_assets, upstream_assets
from model.loader import MVN, local_name

log = logging.getLogger("advisories.generate")

# The planning horizon everything economic is quoted over. A quarter, because that
# is the period a maintenance budget is actually set and reviewed on, so "what does
# it cost to do nothing" is a question with a decision attached rather than an
# abstraction. It is also short enough that the observed duty in the window is a
# fair predictor of the duty over the horizon, which a one-year figure would not be
# for a cooling fault measured in summer.
HORIZON_DAYS = 90.0

# Weights on the four severity inputs. They sum to one and the split is deliberate:
# the two the system MEASURED -- how fast health is falling and how soon the
# prediction says it fails -- carry 0.7 between them, and the two that are business
# context carry 0.3. Criticality and headcount should shade a ranking, not decide
# it; a tier 1 asset that is not degrading is not urgent, and a tier 3 asset three
# weeks from failure is.
SEVERITY_WEIGHTS = {
    "slope": 0.35,
    "urgency": 0.35,
    "criticality": 0.15,
    "occupancy": 0.15,
}

# Health points per day at which the decline term saturates. One point a day takes
# a machine from new to failed in a financial quarter, which is about as fast as
# anything in this building degrades -- the coil leak, the steepest of them, runs
# at 1.27. Anything at or above this is simply "as fast as it gets".
SLOPE_SATURATES_AT = 1.0

# Days of health history the slope is fitted over. Twenty-eight, so the number
# reports the current rate of decline rather than the average since onset: a fault
# that has plateaued should stop being urgent, and one that has just accelerated
# should become urgent within a month rather than after the whole history has been
# dragged round.
SLOPE_WINDOW_DAYS = 28

# Floor on the effort denominator, in dollars. Priority is a ratio and a job that
# costs nothing would make it infinite. Nothing in the intervention library is
# actually free -- the cheapest is 1.5 technician-hours -- so this never binds
# today; it is here so that adding a zero-duration row later produces a large
# number rather than an exception.
MIN_EFFORT_USD = 1.0

# Quality score below which a reading is not shown to a technician as evidence.
# Fifty, matching the gate the rule engine and the fault classifier already use, so
# the three layers cannot disagree about what "untrusted" means.
#
# This filter catches readings that cannot be believed AT A MOMENT: a sensor that has
# stopped moving, left its physical envelope, or gone quiet. It is not the filter that
# catches a column which never meant what its name said -- that is app.points.usable,
# applied alongside it, and the two are genuinely independent. The air handler's supply
# air static pressure proves the point: it averages 89.5 out of 100 and passes this
# gate comfortably, because its readings are consistent, punctual and inside their
# envelope. They are simply recorded in inches of water in 20 of the 21 source files
# and in Pascals in the other, so the stitched series is meaningless. No per-sample
# quality score can see that, and it took the usable flag to exclude it.
MIN_TRUSTED_QUALITY = 50

# When health and the prediction flatly contradict each other, the advisory withholds
# the prediction. These two numbers define "flatly": health saying the machine still
# has more than half its life left, against a prediction saying the failure threshold
# is reached inside a tenth of the planning horizon.
#
# WHY THIS GATE HAS TO EXIST HERE. Health and remaining life read the same daily
# indicator through different smoothing -- health through an isotonic clamp fitted
# over the whole run, the prediction through a trailing seven-day median held at its
# running maximum. On a clean indicator the two agree. On one with rare enormous
# outliers they do not, and the air handler's fan indicator is exactly that: over the
# last five weeks of the 2038 run it reads between 3.4 and 7.5 watts on 30 of 34 days
# against an 88.9 watt failure threshold, with isolated single-day excursions to 245,
# 406 and 178.6 watts. The clamp reads that as a machine at 33.2 watts, health 63,
# barely degrading -- which is right. The running maximum latched onto the excursions
# and concluded the threshold was already crossed, publishing a median time to failure
# of zero days.
#
# Publishing both numbers side by side and letting the reader choose is not an option:
# the zero-day prediction was worth 68,400 USD of expected replacement cost and put
# that advisory first in the whole queue. So the advisory refuses the prediction and
# says which two numbers disagreed. That is the same instinct as the refusal layer in
# checkpoint 5.3 -- decline rather than publish something the system's own other
# measurement refutes -- applied to a contradiction 5.3 cannot see, because 5.3 only
# ever looks at one of the two.
CONTRADICTION_HEALTH_ABOVE = 50
CONTRADICTION_P50_WITHIN_DAYS = HORIZON_DAYS / 10.0

EQUIPMENT = "equipment"


# ---------------------------------------------------------------------------
# which class belongs to which fault
# ---------------------------------------------------------------------------


def classify_fault(
    source: str,
    asset_id: str,
    indicator_expression: str | None,
    diagnosis_class: str,
    diagnosis_reason: str,
    diagnosis_subject: str | None,
) -> tuple[str, str]:
    """Attach a fault class to ONE fault, not to the whole asset.

    The classifier from checkpoint 5.4 answers per asset per window: it sweeps the
    physical relations and reports what is wrong with the machine. That is the right
    question for it to answer and the wrong granularity to hand to an advisory,
    because an asset can carry two unrelated faults at once. On the 2038 air handler
    run the classifier says SENSOR, correctly -- the supply air thermometer is
    drifting -- and the supply fan's bearings are ALSO wearing out, which has nothing
    to do with the thermometer. Labelling the bearing wear a sensor fault would send
    somebody with a reference probe to a worn bearing.

    So the class is decided per fault, by which detector found it:

      A RULE firing takes the asset's class directly. A rule reports a symptom with
      no independent physical trend behind it -- the valve is saturated, and why is
      exactly the question the classifier answers.

      A FAILURE MODE is equipment degradation by construction. The health layer
      measured a physical quantity trending toward a threshold and the changepoint
      detector confirmed the onset; that is a statement about the machine.

      UNLESS the mode's own indicator reads the very measurement the classifier
      accuses. Then the trend may be an artefact of the lying instrument rather than
      the machine, and the mode inherits the sensor verdict. This is not a corner
      case here: the cooling coil leak-by indicator is computed from the supply air
      temperature residual, which is precisely the point drifting on that run, so on
      that run the leak-by trend genuinely is suspect and says so.
    """
    if source != "failure_mode":
        return diagnosis_class, diagnosis_reason

    reads = (indicator_expression or "").replace("@asset", asset_id)
    if diagnosis_subject and diagnosis_subject in reads:
        return diagnosis_class, (
            f"this mode's degradation indicator is computed from "
            f"{diagnosis_subject}, which is the measurement the isolation sweep "
            f"holds responsible, so the trend may be the instrument rather than the "
            f"machine — {diagnosis_reason}"
        )
    if diagnosis_class == EQUIPMENT:
        # The isolation sweep already agrees, so quote it rather than paraphrasing.
        return EQUIPMENT, diagnosis_reason
    return EQUIPMENT, (
        f"a confirmed degradation trend on a physical quantity, so this is the "
        f"machine changing. The isolation sweep on this asset returned "
        f"{diagnosis_class}"
        + (f" against {diagnosis_subject}" if diagnosis_subject else "")
        + ", which this mode's indicator does not read, so that verdict is about a "
          "different fault on the same asset and does not carry over to this one"
    )


# ---------------------------------------------------------------------------
# site economics and asset facts, out of the semantic model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Economics:
    """The site-wide rates every advisory prices its work against."""

    electricity_usd_per_kwh: float
    labour_usd_per_hour: float

    @property
    def basis(self) -> str:
        return (
            f"{self.electricity_usd_per_kwh:.3f} USD/kWh and "
            f"{self.labour_usd_per_hour:.2f} USD/technician-hour, both asserted on "
            f"the site node in the semantic model"
        )


def site_economics(graph: Graph) -> Economics:
    """Read the tariff and labour rate from the graph, refusing to default them.

    Deliberately raises rather than falling back to a hardcoded rate. A cost of
    inaction computed against a made-up tariff is exactly the kind of number this
    module exists to not produce, and a missing rate is a modelling error that
    should stop the run rather than silently change every priority in the queue.
    """
    rates = {}
    for name, prop in (
        ("electricity_usd_per_kwh", "electricityTariffUSDPerKWh"),
        ("labour_usd_per_hour", "labourRateUSDPerHour"),
    ):
        values = [float(o) for _s, o in graph.subject_objects(MVN[prop])]
        if len(values) != 1:
            raise ValueError(
                f"expected exactly one mvn:{prop} in the semantic model, found "
                f"{len(values)}"
            )
        rates[name] = values[0]
    return Economics(**rates)


@dataclass(frozen=True)
class AssetFacts:
    """What the model says about one asset, beyond its readings."""

    asset_id: str
    name: str
    brick_class: str
    criticality_tier: int
    replacement_cost_usd: float | None
    repair_cost_usd: float | None
    occupants_served: int


def _machine_nodes(graph: Graph, nodes: tuple[URIRef, ...]) -> tuple[URIRef, ...]:
    """An asset's nodes, machines before anything else.

    A node carrying mvn:criticalityTier is a piece of equipment somebody owns and
    maintains. The air handler's five occupied zones map to the same database asset
    -- they hold its zone temperature sensors -- and they carry occupancy but no
    tier, which is exactly the distinction needed here.
    """
    tiered = [n for n in nodes if graph.value(n, MVN["criticalityTier"]) is not None]
    return tuple(tiered) + tuple(n for n in nodes if n not in set(tiered))


def _first_value(graph: Graph, nodes: tuple[URIRef, ...], prop: str):
    """The property's value on whichever of an asset's nodes carries it.

    Machine nodes are consulted first, and that ordering is load-bearing rather than
    tidy. Occupancy is now asserted on the air handler AND on each of its five zones,
    and the zones map to the same database asset, so an arbitrary iteration order
    returned 40 occupants for a unit serving 200 -- a fifth of the real figure,
    feeding straight into the severity score. Preferring the node with a criticality
    tier picks the machine every time.
    """
    for node in _machine_nodes(graph, nodes):
        value = graph.value(node, MVN[prop])
        if value is not None:
            return value
    return None


def asset_facts(
    conn: psycopg.Connection, graph: Graph, nodes: dict[str, tuple[URIRef, ...]]
) -> dict:
    """Join what the database knows about each asset to what the graph knows.

    Two sources because they hold different things and neither is complete. The
    database has the identity, the name and the criticality tier; the graph has the
    repair cost, which never made it into a column, and the occupant count. Reading
    both and merging here means nothing above this has to know which fact lives
    where.
    """
    rows = conn.execute(
        "SELECT asset_id, name, brick_class, criticality_tier, replacement_cost_usd "
        "  FROM app.assets ORDER BY asset_id"
    ).fetchall()
    out = {}
    for asset_id, name, brick_class, tier, replacement in rows:
        owned = nodes.get(asset_id, ())
        repair = _first_value(graph, owned, "repairCostUSD")
        occupants = _first_value(graph, owned, "occupantsServed")
        out[asset_id] = AssetFacts(
            asset_id=asset_id,
            name=name,
            brick_class=brick_class,
            criticality_tier=int(tier),
            replacement_cost_usd=None if replacement is None else float(replacement),
            repair_cost_usd=None if repair is None else float(repair),
            occupants_served=0 if occupants is None else int(occupants),
        )
    return out


# ---------------------------------------------------------------------------
# the graph trace
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Impact:
    """Who is downstream of a fault, ending in a number of people."""

    assets: tuple[str, ...]  # database assets fed by this one
    zones: tuple[str, ...]  # occupied spaces reached
    occupants: int
    hops_to_furthest: int

    @property
    def summary(self) -> str:
        if not self.zones and not self.assets:
            return "nothing downstream: this asset is the end of the chain"
        parts = []
        if self.assets:
            parts.append(f"{len(self.assets)} asset(s) ({', '.join(self.assets)})")
        if self.zones:
            parts.append(f"{len(self.zones)} zone(s) ({', '.join(self.zones)})")
        return f"{' and '.join(parts)}, {self.occupants} occupants"


def downstream_impact(
    graph: Graph,
    nodes: tuple[URIRef, ...],
    mapping: dict[URIRef, str],
    facts: dict[str, AssetFacts],
    asset_id: str,
) -> Impact:
    """Everything this asset delivers to, and the headcount at the end of it.

    Traverses downstream from EVERY graph node belonging to the asset and unions the
    results, then sorts what comes back into two kinds: nodes the database models as
    assets, which is who else's equipment is affected, and occupied zones, which is
    who else's PEOPLE are affected. The second is the one that belongs in an advisory
    a human reads.

    Every node, not one, because the database models a machine as a single asset and
    the graph models it as its parts, and the parts are what the pipes and ducts are
    attached to. The air handler is eleven nodes; the chilled water loop arrives at
    exactly one of them, the cooling coil, and the supply air leaves from a different
    one. Tracing from a single chosen node found nothing upstream of the air handler
    at all, which is wrong in the most dangerous way available -- it reads as a
    building where nothing feeds anything.

    Occupants are summed from the zones actually reached rather than taken from the
    asset's own total, so a fault traced to part of a building reports the part. The
    asset total is used only when the traversal reaches no zone at all -- which is
    the case for every chiller here, since the chilled water loop terminates at the
    coil and the graph does not carry it on into the zones the coil serves.
    """
    reached = _union_traversal(graph, nodes, downstream_assets)
    assets, zones = [], []
    occupants = 0
    for row in reached:
        other = mapping.get(row.asset)
        if other is not None and other != asset_id:
            assets.append(other)
        served = graph.value(row.asset, MVN["occupantsServed"])
        if "Zone" in local_name(row.asset):
            zones.append(local_name(row.asset))
            occupants += 0 if served is None else int(served)

    if not zones:
        # No zone in reach. Fall back to the asset's declared headcount, which for
        # the plant equipment here is the whole building, and say so in the summary
        # by reporting zero zones alongside a non-zero occupant count.
        occupants = facts[asset_id].occupants_served

    return Impact(
        assets=tuple(sorted(set(assets))),
        zones=tuple(sorted(set(zones))),
        occupants=occupants,
        hops_to_furthest=max((r.hops for r in reached), default=0),
    )


@dataclass(frozen=True)
class Trace:
    """The graph either side of a fault: what could have caused it, what it hits."""

    upstream: tuple[tuple[str, int], ...]  # (asset, hops), whether faulted or not
    cause: Attribution | None
    impact: Impact

    @property
    def upstream_summary(self) -> str:
        if not self.upstream:
            return "nothing upstream: nothing feeds this asset"
        near = ", ".join(f"{a} at {h} hops" for a, h in self.upstream[:4])
        tail = "" if len(self.upstream) <= 4 else f", and {len(self.upstream) - 4} more"
        return f"{near}{tail}"


def _union_traversal(graph: Graph, nodes: tuple[URIRef, ...], walk) -> list:
    """Run a traversal from every node of an asset, keeping each result once.

    Keyed on the reached node so a node found from two different starts is not
    double-counted, and keeping the shortest hop count, which is the distance that
    matters for preferring a near cause to a far one.
    """
    best: dict[URIRef, object] = {}
    for node in nodes:
        for row in walk(graph, node):
            current = best.get(row.asset)
            if current is None or row.hops < current.hops:
                best[row.asset] = row
    return sorted(best.values(), key=lambda row: row.hops)


def trace(
    graph: Graph,
    nodes: tuple[URIRef, ...],
    mapping: dict[URIRef, str],
    facts: dict[str, AssetFacts],
    asset_id: str,
    cause: Attribution | None,
) -> Trace:
    """Both directions at once, because an advisory needs both to be actionable.

    Upstream answers "could this be somebody else's fault", and is listed whether or
    not anything up there is actually faulted -- an operator deciding whether to
    believe a diagnosis wants to see what the alternatives were. Downstream answers
    "who suffers if I leave it", which is what turns severity into a priority and
    what makes taking the asset out of service a schedulable decision.
    """
    seen: dict[str, int] = {}
    for row in _union_traversal(graph, nodes, upstream_assets):
        other = mapping.get(row.asset)
        if other is not None and other != asset_id:
            seen[other] = min(row.hops, seen.get(other, 1 << 30))
    return Trace(
        upstream=tuple(sorted(seen.items(), key=lambda pair: (pair[1], pair[0]))),
        cause=cause,
        impact=downstream_impact(graph, nodes, mapping, facts, asset_id),
    )


# ---------------------------------------------------------------------------
# contributing signals
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Signal:
    """One measurement behind a fault, with what it was and what it became."""

    point_id: str
    label: str
    unit: str
    reference: float  # mean over the commissioning window
    observed: float  # mean over the advisory window
    sigma: float  # spread over the commissioning window

    @property
    def moved(self) -> float:
        return self.observed - self.reference

    @property
    def sigmas(self) -> float:
        return 0.0 if self.sigma <= 0.0 else self.moved / self.sigma

    @property
    def line(self) -> str:
        return (
            f"{self.point_id:<28} {self.observed:>10.3f} {self.unit:<8} was "
            f"{self.reference:>9.3f}   moved {self.moved:+.3f} "
            f"({self.sigmas:+.1f} sigma)"
        )


def contributing_signals(
    conn: psycopg.Connection,
    asset_id: str,
    window: tuple[datetime, datetime],
    reference: tuple[datetime, datetime],
    limit: int = 6,
) -> tuple[list[Signal], int, int]:
    """The asset's readings that moved most, in units of their own quiet spread.

    Every point on the asset is compared between the advisory's window and a
    reference window, and ranked by how many of its own reference standard
    deviations it shifted. That normalisation is what makes a 200 W fan power move
    and a 2 K temperature move comparable enough to rank, and it is the same device
    the residual and constraint layers use.

    Reading raw measurements rather than residuals is deliberate here even though
    residuals are the better signal for detection. An advisory has to be checkable
    against the building automation system a technician can actually open, and that
    system shows raw values. The residuals are what the DIAGNOSIS rests on and they
    are reported by the diagnosis layer's own evidence; these are what the
    technician can go and look at.

    TWO FILTERS, ANSWERING TWO DIFFERENT QUESTIONS.

    `app.points.usable` asks whether the column means what its name says at all. It
    is a fact about the source dataset, decided once, and three of this building's
    107 points fail it -- the outdoor airflow that is a constant design figure rather
    than a measurement, and the two supply air static pressure points whose unit
    differs between the fault-free source file and the 20 fault files, so that every
    stitched trajectory splices two conventions together. No per-row processing can
    repair that, so those points are excluded here by construction rather than by
    each consumer noticing.

    The quality score asks whether a particular reading can be believed right now,
    and answers per sample. Both windows must average at or above the trusted
    threshold.

    Neither subsumes the other, and supply air static pressure is exactly the case
    that proves it: it scores 89.5 on average and sails through the quality gate,
    because its readings are consistent, punctual and inside their physical envelope
    -- they are simply in the wrong unit. Ranked on movement it then reads as a 386
    sigma shift, the largest mover on the asset, and it led the evidence list of every
    air handler advisory. A reading can be entirely trustworthy and still be
    meaningless.

    Exclusions are counted and returned so they appear in the report rather than
    happening quietly.
    """
    rows = conn.execute(
        """
        WITH observed AS (
            SELECT m.point_id, avg(m.value_si) AS mean,
                   avg(m.quality_score) AS quality
              FROM app.measurements m
              JOIN app.points p ON p.point_id = m.point_id
             WHERE p.asset_id = %(asset)s
               AND m.time >= %(obs_from)s AND m.time < %(obs_to)s
             GROUP BY 1
        ), quiet AS (
            SELECT m.point_id, avg(m.value_si) AS mean, stddev_samp(m.value_si) AS sd,
                   avg(m.quality_score) AS quality
              FROM app.measurements m
              JOIN app.points p ON p.point_id = m.point_id
             WHERE p.asset_id = %(asset)s
               AND m.time >= %(ref_from)s AND m.time < %(ref_to)s
             GROUP BY 1
        )
        SELECT o.point_id, p.name, p.unit_si, q.mean, o.mean, q.sd,
               least(coalesce(o.quality, 0), coalesce(q.quality, 0)) AS quality,
               p.usable, p.unusable_reason
          FROM observed o
          JOIN quiet q ON q.point_id = o.point_id
          JOIN app.points p ON p.point_id = o.point_id
         WHERE q.sd IS NOT NULL AND q.sd > 0
        """,
        {
            "asset": asset_id,
            "obs_from": window[0], "obs_to": window[1],
            "ref_from": reference[0], "ref_to": reference[1],
        },
    ).fetchall()

    signals: list[Signal] = []
    unusable_count = 0
    untrusted_count = 0
    for pid, name, unit, ref, obs, sd, quality, usable, unusable_reason in rows:
        if not usable:
            log.debug("%s excluded from advisory signals: %s", pid, unusable_reason)
            unusable_count += 1
            continue
        if float(quality) < MIN_TRUSTED_QUALITY:
            log.debug("%s excluded from advisory signals: quality %.1f", pid, quality)
            untrusted_count += 1
            continue
        signals.append(
            Signal(point_id=pid, label=name, unit=unit,
                   reference=float(ref), observed=float(obs), sigma=float(sd))
        )
    return (
        sorted(signals, key=lambda s: -abs(s.sigmas))[:limit],
        unusable_count,
        untrusted_count,
    )


# ---------------------------------------------------------------------------
# the remaining-life sentence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Prognosis:
    """What the remaining-life layer said, including when it declined to say."""

    p10: float | None
    p50: float | None
    p90: float | None
    as_of: datetime | None
    n_samples: int | None
    refusal: str | None

    @property
    def bounded(self) -> bool:
        return self.p10 is not None and self.p90 is not None and self.p50 is not None

    @property
    def sentence(self) -> str:
        """The one line a planner reads. Never a padded point estimate."""
        if self.refusal is not None:
            return f"no prediction: {self.refusal}"
        if not self.bounded:
            return (
                "no prediction: the model does not bound the crossing, so there may "
                "be no failure date at all"
            )
        if self.p90 <= 0.0:
            # Every quantile at zero is not a prediction of failure tomorrow, it is a
            # statement that the indicator has already crossed the threshold. Rendered
            # as "0 to 0 days, median 0" it reads like a broken calculation, and an
            # operator would reasonably distrust the rest of the advisory with it.
            return (
                f"the failure threshold has ALREADY been reached, as of "
                f"{self.as_of:%Y-%m-%d}, on {self.n_samples} post-onset samples. This "
                f"is not a forecast: there is no remaining life left to predict"
            )
        return (
            f"likely to fail in {self.p10:.0f} to {self.p90:.0f} days, median "
            f"{self.p50:.0f}, from {self.n_samples} post-onset samples as of "
            f"{self.as_of:%Y-%m-%d}"
        )

    def probability_by(self, days: float) -> float | None:
        """Chance of crossing the threshold within `days`, from the stored quantiles.

        Interpolated across the three published quantiles rather than recomputed
        from the first-passage distribution, and that is a deliberate choice with a
        cost. app.rul_estimates stores P10, P50 and P90 and not the distribution
        they came from, so an exact CDF would mean refitting the process here -- and
        an advisory that refits is an advisory that can disagree with the
        remaining-life page it is supposed to be summarising. Agreement with what the
        system already published matters more here than the last few percent of
        accuracy, so the interpolation is linear in days between the quantiles, flat
        outside them.
        """
        if not self.bounded:
            return None
        return float(
            np.interp(days, [self.p10, self.p50, self.p90], [0.10, 0.50, 0.90])
        )


def withhold_if_contradicted(
    forecast: Prognosis, health: int | None
) -> tuple[Prognosis, str | None]:
    """Drop a prediction the asset's own health score refutes, and say why.

    Two of the system's own published numbers describe the same thing: how far this
    mode has travelled toward failure. Health says it directly; the median time to
    failure says it by implication. When they disagree by the whole range -- health
    reporting most of a life left while the prediction reports the threshold already
    reached -- at least one of them is wrong, and nothing in the advisory layer can
    tell which. The safe answer is neither, so the prediction is withheld with the
    contradiction stated, and the advisory carries on with health, severity and the
    energy penalty, all of which are unaffected.

    Withheld rather than flagged-and-published, because the prediction is not merely
    displayed: it feeds the consequential term of the cost of inaction, and a spurious
    zero-day forecast is worth the asset's entire replacement cost. Left in, it put
    the least degraded mode in this building at the top of the priority queue.

    The prediction is what gets dropped rather than health because health is the more
    robust of the two here -- an isotonic fit over the whole window against a running
    maximum that any single outlier latches permanently.
    """
    if (
        health is None
        or forecast.p50 is None
        or health <= CONTRADICTION_HEALTH_ABOVE
        or forecast.p50 > CONTRADICTION_P50_WITHIN_DAYS
    ):
        return forecast, None

    reason = (
        f"withheld: the health index puts this mode at {health} of 100, meaning most "
        f"of its life remains, while the first-passage estimate puts the failure "
        f"threshold {forecast.p50:.0f} days away. Those two cannot both be true. They "
        f"read the same daily indicator through different smoothing -- health through "
        f"an isotonic clamp, the estimate through a running maximum that any single "
        f"outlier latches onto permanently -- and this indicator carries rare "
        f"excursions of fifty times its normal value. Neither number is published "
        f"until that is resolved"
    )
    note = f"the remaining-life estimate for this mode was WITHHELD, not missing: {reason}"
    return (
        Prognosis(None, None, None, forecast.as_of, forecast.n_samples, reason),
        note,
    )


def prognosis(
    conn: psycopg.Connection,
    asset_id: str,
    mode_id: str | None,
    as_of: datetime,
    refusal: str | None = None,
) -> Prognosis:
    """The latest published remaining-life estimate on or before `as_of`.

    Reads what checkpoint 5.2 committed rather than recomputing it, so the advisory
    queue, the remaining-life chart and the API all quote the same three numbers.
    A mode with no row is not an error: it means either the refusal layer declined
    to publish for this mode, or the fault is a rule firing rather than a
    degradation trend and has no remaining-life notion at all.
    """
    if mode_id is None:
        return Prognosis(None, None, None, None, None,
                         refusal or "this finding is not a degradation trend, so it "
                                    "has no remaining-life estimate")
    row = conn.execute(
        "SELECT p10, p50, p90, as_of, n_samples FROM app.rul_estimates "
        " WHERE asset_id = %s AND mode_id = %s AND as_of <= %s "
        " ORDER BY as_of DESC LIMIT 1",
        (asset_id, mode_id, as_of),
    ).fetchone()
    if row is None:
        return Prognosis(None, None, None, None, None,
                         refusal or "no estimate was published for this mode up to "
                                    "this date")
    p10, p50, p90, stamp, n = row
    return Prognosis(
        p10=None if p10 is None else float(p10),
        p50=None if p50 is None else float(p50),
        p90=None if p90 is None else float(p90),
        as_of=stamp,
        n_samples=int(n),
        refusal=refusal,
    )


# ---------------------------------------------------------------------------
# severity
# ---------------------------------------------------------------------------


def health_slope(
    conn: psycopg.Connection, asset_id: str, mode_id: str | None, as_of: datetime
) -> tuple[float, int]:
    """Health points lost per day, by least squares over the recent history.

    Returns the slope as a POSITIVE number when health is falling, because every
    other severity input counts upward as things get worse and mixing the sign
    conventions inside the weighted sum is how a severity score ends up rewarding
    decline. Also returns how many days it was fitted over, so a slope from four
    points is distinguishable from one from twenty-eight.
    """
    if mode_id is None:
        return 0.0, 0
    rows = conn.execute(
        "SELECT time, health FROM app.health_state "
        " WHERE asset_id = %s AND mode_id = %s AND health IS NOT NULL "
        "   AND time <= %s ORDER BY time DESC LIMIT %s",
        (asset_id, mode_id, as_of, SLOPE_WINDOW_DAYS),
    ).fetchall()
    if len(rows) < 3:
        return 0.0, len(rows)
    times = np.array([(r[0] - rows[-1][0]).total_seconds() / 86400.0 for r in rows])
    health = np.array([float(r[1]) for r in rows])
    slope = float(np.polyfit(times, health, 1)[0])
    return max(0.0, -slope), len(rows)


@dataclass(frozen=True)
class Severity:
    """How urgent this is, and each of the four things that made it so."""

    score: float
    slope_per_day: float
    slope_days: int
    urgency: float
    criticality_tier: int
    occupants: int
    terms: dict[str, float]

    @property
    def basis(self) -> str:
        return "  ".join(
            f"{name}={value:.3f}*{SEVERITY_WEIGHTS[name]}"
            for name, value in self.terms.items()
        )


def severity(
    slope: tuple[float, int],
    forecast: Prognosis,
    facts: AssetFacts,
    max_occupants: int,
) -> Severity:
    """Combine rate of decline, time to failure, criticality and headcount.

    Each term is put on nought to one before weighting, because they are measured in
    incompatible things -- points per day, days, a tier, a headcount -- and a
    weighted sum of raw values would be dominated by whichever happened to have the
    largest units.

    The urgency term is the one worth reading carefully. It comes from the
    prediction, not from the health score: a machine at health 20 that has stopped
    moving is not urgent, and a machine at health 80 falling fast is. When there is
    no prediction the term is zero rather than a guess, which means a refused
    advisory is ranked on its rate of decline and what it serves, and can still
    reach the top of the queue on those alone -- it just cannot borrow urgency from
    a prediction that was never made.
    """
    slope_per_day, slope_days = slope
    p50 = forecast.p50
    terms = {
        "slope": min(1.0, slope_per_day / SLOPE_SATURATES_AT),
        "urgency": 0.0 if p50 is None else max(0.0, 1.0 - p50 / HORIZON_DAYS),
        "criticality": (4 - facts.criticality_tier) / 3.0,
        "occupancy": 0.0 if max_occupants <= 0
                     else facts.occupants_served / max_occupants,
    }
    score = sum(SEVERITY_WEIGHTS[name] * value for name, value in terms.items())
    return Severity(
        score=min(1.0, max(0.0, score)),
        slope_per_day=slope_per_day,
        slope_days=slope_days,
        urgency=terms["urgency"],
        criticality_tier=facts.criticality_tier,
        occupants=facts.occupants_served,
        terms=terms,
    )


# ---------------------------------------------------------------------------
# what it costs to do nothing, and what it costs to act
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Intervention:
    """The recommended job, out of app.intervention_library."""

    intervention_id: str
    description: str
    duration_hours: float
    skills: tuple[str, ...]
    parts: tuple[str, ...]
    parts_cost_usd: float
    basis: str
    matched_on_class: bool

    def effort_usd(self, economics: Economics) -> float:
        return self.duration_hours * economics.labour_usd_per_hour + self.parts_cost_usd


def recommend(
    conn: psycopg.Connection, fault_id: str, fault_class: str | None
) -> Intervention | None:
    """The intervention for this fault, preferring one written for this fault class.

    The class-specific lookup is where the sensor-versus-equipment discrimination
    stops being an academic result. A saturated cooling valve blamed on the sensor
    is ninety minutes with a reference probe; the same reading blamed on the coil is
    six hours of survey. Same fault id, same evidence, twelve times the labour, and
    the only thing choosing between them is checkpoint 5.4.

    Returns None rather than a placeholder when nothing matches, so a fault with no
    recorded response is visible as a gap in the library instead of arriving with an
    invented recommendation attached.
    """
    row = conn.execute(
        "SELECT intervention_id, description, duration_hours, skills, parts, "
        "       cost_usd, basis, applies_to_class "
        "  FROM app.intervention_library "
        " WHERE applies_to_fault = %s "
        "   AND (applies_to_class = %s OR applies_to_class IS NULL) "
        " ORDER BY applies_to_class NULLS LAST LIMIT 1",
        (fault_id, fault_class),
    ).fetchone()
    if row is None:
        return None
    ident, description, hours, skills, parts, cost, basis, matched = row
    return Intervention(
        intervention_id=ident,
        description=description,
        duration_hours=float(hours),
        skills=tuple(skills),
        parts=tuple(parts),
        parts_cost_usd=float(cost),
        basis=basis,
        matched_on_class=matched is not None,
    )


def duty_fraction(
    conn: psycopg.Connection, asset_id: str, window: tuple[datetime, datetime]
) -> float:
    """Fraction of the window the asset was actually running.

    An excess-power penalty is only paid while the machine is on, and these machines
    are off a great deal -- the air handler is occupied 53.8 percent of the time and
    a lag chiller runs far less than that. Costing a fault at 24 hours a day would
    overstate every advisory on the queue by roughly a factor of two, uniformly, so
    it would not even have the decency to change the ranking.

    Runs off whichever point actually indicates duty for this asset: compressor
    power for a chiller, the occupancy schedule for an air handler. Falls back to
    the whole window when neither exists, which is conservative in the direction of
    overstating cost and is reported as such by the caller.
    """
    for point, threshold in (
        (f"{asset_id}.power", 1000.0),
        (f"{asset_id}.occupancy", 0.5),
        (f"{asset_id}.fan_power", 100.0),
    ):
        row = conn.execute(
            "SELECT count(*) FILTER (WHERE value_si > %s)::float / "
            "       nullif(count(*), 0) FROM app.measurements "
            " WHERE point_id = %s AND time >= %s AND time < %s",
            (threshold, point, window[0], window[1]),
        ).fetchone()
        if row is not None and row[0] is not None:
            return float(row[0])
    return 1.0


@dataclass(frozen=True)
class CostOfInaction:
    """Dollars of doing nothing for the horizon, and where each dollar came from."""

    energy_usd: float
    consequential_usd: float
    excess_kw: float
    duty: float
    probability_of_failure: float | None
    basis: str
    priceable: bool

    @property
    def total_usd(self) -> float:
        return self.energy_usd + self.consequential_usd


def cost_of_inaction(
    indicator: float | None,
    penalty_kw_per_unit: float | None,
    penalty_basis: str | None,
    duty: float,
    forecast: Prognosis,
    facts: AssetFacts,
    economics: Economics,
) -> CostOfInaction:
    """Expected dollars over the horizon if nobody acts. Two terms, both traceable.

    ENERGY. The mode's current indicator times the kilowatts one unit of it wastes
    -- a coefficient measured on a fault-free run and recorded in app.failure_modes
    next to its own arithmetic -- times the hours the machine actually runs over the
    horizon, times the site tariff. Held flat at today's indicator rather than
    projected along the degradation trend, which understates it for an accelerating
    fault; projecting would mean integrating the drift over the horizon and would
    make the number depend on a fit the refusal layer may have declined to publish.

    CONSEQUENTIAL. The chance of reaching the failure threshold inside the horizon,
    read off the published prediction interval, times what failing costs over
    repairing: replacement cost minus repair cost. That difference is the real
    penalty for waiting -- the repair is owed either way, and running a machine to
    failure is what converts it into a purchase.

    Both terms go to zero honestly. A mode with no electrical cost contributes no
    energy term, a fault with no prediction contributes no consequential term, and
    the basis string says which happened so a small number is never mistaken for a
    cheap fault. When BOTH are absent the result is marked unpriceable rather than
    returned as zero dollars, because zero is a claim -- it says the fault is free to
    ignore -- and a saturated cooling valve serving two hundred people is not free to
    ignore just because this building does not meter what it costs.
    """
    reasons: list[str] = []
    priced_terms = 0

    if indicator is None or penalty_kw_per_unit is None:
        excess_kw = 0.0
        energy = 0.0
        reasons.append(
            "no energy term: "
            + (
                "this mode has no electrical cost recorded, deliberately"
                if penalty_kw_per_unit is None
                else "no indicator value available"
            )
        )
    else:
        priced_terms += 1
        excess_kw = abs(indicator) * penalty_kw_per_unit
        hours = HORIZON_DAYS * 24.0 * duty
        energy = excess_kw * hours * economics.electricity_usd_per_kwh
        reasons.append(
            f"energy: {abs(indicator):.3f} indicator units x "
            f"{penalty_kw_per_unit:g} kW/unit = {excess_kw:.3f} kW, over "
            f"{hours:.0f} running hours ({duty * 100:.1f}% duty x {HORIZON_DAYS:.0f} "
            f"days) at {economics.electricity_usd_per_kwh:.3f} USD/kWh"
        )
        if penalty_basis:
            reasons.append(f"coefficient basis: {_first_sentence(penalty_basis)}")

    probability = forecast.probability_by(HORIZON_DAYS)
    exposure = None
    if facts.replacement_cost_usd is not None and facts.repair_cost_usd is not None:
        exposure = max(0.0, facts.replacement_cost_usd - facts.repair_cost_usd)
    if probability is None or exposure is None:
        consequential = 0.0
        reasons.append(
            "no consequential term: "
            + (
                "no prediction interval was published, so the chance of reaching "
                "failure inside the horizon is unknown"
                if probability is None
                else "this asset has no replacement or repair cost in the model"
            )
        )
    else:
        priced_terms += 1
        consequential = probability * exposure
        reasons.append(
            f"consequential: {probability * 100:.1f}% chance of crossing the "
            f"threshold within {HORIZON_DAYS:.0f} days x "
            f"{exposure:,.0f} USD of replacement over repair"
        )

    if priced_terms == 0:
        reasons.append(
            "NOT PRICEABLE: neither term could be computed, so this advisory carries "
            "no cost of inaction and cannot be ranked by one. It is ranked by "
            "severity instead, and that is reported rather than hidden behind a zero"
        )

    return CostOfInaction(
        energy_usd=energy,
        consequential_usd=consequential,
        excess_kw=excess_kw,
        duty=duty,
        probability_of_failure=probability,
        basis="; ".join(reasons),
        priceable=priced_terms > 0,
    )


def _first_sentence(text: str, limit: int = 170) -> str:
    """First sentence of a basis string, without breaking on a decimal point.

    Naively splitting on a full stop cuts "roughly 2.5 percent" into "roughly 2",
    which is how a rationale turns into a wrong number in a report. A sentence end
    is a full stop followed by a space.
    """
    head = text.split(". ")[0].rstrip(".")
    return head if len(head) <= limit else head[:limit].rsplit(" ", 1)[0] + "..."


# ---------------------------------------------------------------------------
# the advisory
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Advisory:
    """Everything known about one open fault, in the order a human reads it."""

    # what is wrong
    asset_id: str
    asset_name: str
    fault_id: str
    fault_title: str
    fault_source: str
    mode_id: str | None
    fault_class: str
    fault_class_reason: str
    health: int | None
    window: tuple[datetime, datetime]

    # when it fails
    forecast: Prognosis

    # why we believe it
    signals: tuple[Signal, ...]
    # Two exclusion counts, not one, because they answer different questions: the
    # first is source data that does not mean what it says, the second is readings
    # that cannot be believed right now. See contributing_signals.
    signals_excluded_unusable: int
    signals_excluded_untrusted: int
    diagnosis_evidence: tuple[str, ...]

    # who it reaches
    trace: Trace

    # how urgent, what it is worth, what to do
    severity: Severity
    cost: CostOfInaction
    effort_usd: float
    intervention: Intervention | None
    consequential: bool
    demoted_from: float | None
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def signals_excluded(self) -> int:
        return self.signals_excluded_unusable + self.signals_excluded_untrusted

    @property
    def priority(self) -> float | None:
        """Dollars saved per dollar spent, or None when the cost cannot be priced.

        None rather than zero, and the distinction is load-bearing. Zero says the
        fault is free to ignore. None says nobody knows what it costs, which is a
        different instruction to an operator and puts the advisory in the part of the
        queue that is ranked on severity instead.
        """
        if not self.cost.priceable:
            return None
        return self.cost.total_usd / max(MIN_EFFORT_USD, self.effort_usd)

    @property
    def cost_basis(self) -> str:
        return self.cost.basis


def build(
    conn: psycopg.Connection,
    graph: Graph,
    nodes: dict[str, URIRef],
    mapping: dict[URIRef, str],
    facts: dict[str, AssetFacts],
    economics: Economics,
    ranked: Ranked,
    window: tuple[datetime, datetime],
    reference: tuple[datetime, datetime],
    diagnosis_class: str,
    diagnosis_reason: str,
    diagnosis_subject: str | None,
    diagnosis_evidence: tuple[str, ...] = (),
    refusal: str | None = None,
) -> Advisory:
    """Assemble one advisory. Every field is populated from a query or a computation.

    The order of the work follows the order of the argument the advisory makes,
    because several later steps need earlier answers: severity needs the prediction,
    the cost of inaction needs the prediction and the duty, and the priority needs
    both the cost and the intervention that sets the effort.
    """
    fault = ranked.fault
    asset = facts[fault.asset_id]
    mode_id = fault.fault_id if fault.source == "failure_mode" else None

    mode_row = (
        conn.execute(
            "SELECT indicator_unit, penalty_kw_per_unit, penalty_basis, "
            "       failure_threshold, indicator_expression "
            "  FROM app.failure_modes WHERE mode_id = %s",
            (mode_id,),
        ).fetchone()
        if mode_id
        else None
    )
    fault_class, fault_class_reason = classify_fault(
        source=fault.source,
        asset_id=fault.asset_id,
        indicator_expression=None if mode_row is None else mode_row[4],
        diagnosis_class=diagnosis_class,
        diagnosis_reason=diagnosis_reason,
        diagnosis_subject=diagnosis_subject,
    )
    health_row = (
        conn.execute(
            "SELECT health, indicator_monotonic FROM app.health_state "
            " WHERE asset_id = %s AND mode_id = %s AND time <= %s "
            " ORDER BY time DESC LIMIT 1",
            (fault.asset_id, mode_id, window[1]),
        ).fetchone()
        if mode_id
        else None
    )
    health = None if health_row is None or health_row[0] is None else int(health_row[0])
    indicator = None if health_row is None else health_row[1]

    forecast = prognosis(conn, fault.asset_id, mode_id, window[1], refusal)
    forecast, contradiction = withhold_if_contradicted(forecast, health)
    duty = duty_fraction(conn, fault.asset_id, window)
    max_occupants = max((f.occupants_served for f in facts.values()), default=0)

    cost = cost_of_inaction(
        indicator=indicator,
        penalty_kw_per_unit=None if mode_row is None else mode_row[1],
        penalty_basis=None if mode_row is None else mode_row[2],
        duty=duty,
        forecast=forecast,
        facts=asset,
        economics=economics,
    )
    intervention = recommend(conn, fault.fault_id, fault_class)
    signals, excluded_unusable, excluded_untrusted = contributing_signals(
        conn, fault.asset_id, window, reference
    )

    # Health and the remaining-life estimate are computed from two different
    # smoothings of the same indicator -- health from the isotonic-clamped series,
    # the prediction from a trailing median that is then held at its running maximum
    # -- and on a spiky indicator the two can disagree flatly about whether the
    # machine has already failed. Putting both numbers side by side in one advisory
    # is what makes that visible, so when they contradict each other the advisory
    # says so rather than printing the pair and leaving the reader to notice.
    notes: list[str] = []
    if contradiction is not None:
        notes.append(contradiction)
    if intervention is None:
        notes.append(
            "no intervention recorded in app.intervention_library for this fault -- "
            "effort cannot be priced, so the priority below is the cost of inaction "
            "alone"
        )

    return Advisory(
        asset_id=fault.asset_id,
        asset_name=asset.name,
        fault_id=fault.fault_id,
        fault_title=fault.title,
        fault_source=fault.source,
        mode_id=mode_id,
        fault_class=fault_class,
        fault_class_reason=fault_class_reason,
        health=health,
        window=window,
        forecast=forecast,
        signals=tuple(signals),
        signals_excluded_unusable=excluded_unusable,
        signals_excluded_untrusted=excluded_untrusted,
        diagnosis_evidence=diagnosis_evidence,
        trace=trace(
            graph, nodes[fault.asset_id], mapping, facts, fault.asset_id,
            ranked.attribution,
        ),
        severity=severity(
            health_slope(conn, fault.asset_id, mode_id, window[1]),
            forecast, asset, max_occupants,
        ),
        cost=cost,
        effort_usd=(
            MIN_EFFORT_USD if intervention is None
            else intervention.effort_usd(economics)
        ),
        intervention=intervention,
        consequential=ranked.consequential,
        demoted_from=ranked.own_priority if ranked.consequential else None,
        notes=tuple(notes),
    )


def effective_priority(
    advisory: Advisory, advisories: list[Advisory]
) -> float | None:
    """The priority an advisory ends up with once demotion is applied.

    The demotion arithmetic lives in the cross-asset layer and is re-applied here
    rather than reused from it, because an advisory's economic priority is not known
    until its intervention has been priced, which happens after the cross-asset pass
    has already run on severity. Same function, same 40 percent and same clamp under
    the cause, applied to the number that now exists.

    An unpriced advisory has no priority to demote, so it comes back None and its
    demotion is applied to its severity in `queue` instead. Demoting nothing to 40
    percent of nothing would silently lose the fact that it was demoted at all.
    """
    from analytics.diagnosis.rootcause import demote

    if advisory.priority is None or advisory.trace.cause is None:
        return advisory.priority
    cause_key = advisory.trace.cause.cause.key
    causes = {
        (a.asset_id, a.fault_id): a.priority
        for a in advisories
        if a.priority is not None
    }
    return demote(advisory.priority, causes.get(cause_key, 0.0))


def rank_key(advisory: Advisory, advisories: list[Advisory]) -> tuple:
    """Sort key placing priced advisories above unpriced ones.

    Two tiers, not one number, because a priority in dollars-per-dollar and a
    severity on nought to one are not the same quantity and averaging them would
    invent a comparison. Priced advisories rank first, on money; unpriced ones follow,
    on severity, which is the most the system honestly knows about them. An operator
    reading the queue sees the boundary and knows the second group is ordered on how
    bad the fault is rather than on what it costs.
    """
    from analytics.diagnosis.rootcause import demote

    priority = effective_priority(advisory, advisories)
    if priority is not None:
        return (0, -priority, advisory.asset_id, advisory.fault_id)
    severity_rank = advisory.severity.score
    if advisory.trace.cause is not None:
        causes = {(a.asset_id, a.fault_id): a.severity.score for a in advisories}
        severity_rank = demote(
            severity_rank, causes.get(advisory.trace.cause.cause.key, 0.0)
        )
    return (1, -severity_rank, advisory.asset_id, advisory.fault_id)


def queue(advisories: list[Advisory]) -> list[Advisory]:
    """The operator's queue: priced by money, then unpriced by severity."""
    return sorted(advisories, key=lambda a: rank_key(a, advisories))


# ---------------------------------------------------------------------------
# persistence
# ---------------------------------------------------------------------------


def advisory_id(advisory: Advisory) -> str:
    """Deterministic identifier, so re-running updates rather than accumulates."""
    return f"{advisory.asset_id}|{advisory.fault_id}|{advisory.window[1]:%Y%m%d}"


def as_payload(advisory: Advisory, priority: float | None) -> dict:
    """The advisory as JSON, in the shape the API serves and the UI renders.

    Written out field by field rather than by reflecting over the dataclass, so the
    published shape is a deliberate contract that changes only when somebody edits
    this function. A generic dump would make every internal rename a breaking API
    change, and would silently start publishing any field added for internal use.
    """
    cause = advisory.trace.cause
    intervention = advisory.intervention
    return {
        "asset": {"id": advisory.asset_id, "name": advisory.asset_name},
        "fault": {
            "id": advisory.fault_id,
            "title": advisory.fault_title,
            "source": advisory.fault_source,
            "mode_id": advisory.mode_id,
            "fault_class": advisory.fault_class,
            "class_reason": advisory.fault_class_reason,
        },
        "health": advisory.health,
        "window": {
            "from": advisory.window[0].isoformat(),
            "to": advisory.window[1].isoformat(),
        },
        "forecast": {
            "sentence": advisory.forecast.sentence,
            "p10": advisory.forecast.p10,
            "p50": advisory.forecast.p50,
            "p90": advisory.forecast.p90,
            "as_of": None if advisory.forecast.as_of is None
                     else advisory.forecast.as_of.isoformat(),
            "n_samples": advisory.forecast.n_samples,
            "refusal": advisory.forecast.refusal,
            "probability_within_horizon": advisory.forecast.probability_by(HORIZON_DAYS),
        },
        "signals": [
            {
                "point_id": s.point_id, "label": s.label, "unit": s.unit,
                "observed": s.observed, "reference": s.reference,
                "moved": s.moved, "sigmas": s.sigmas,
            }
            for s in advisory.signals
        ],
        "signals_excluded": {
            "unusable_source_data": advisory.signals_excluded_unusable,
            "untrusted_readings": advisory.signals_excluded_untrusted,
        },
        "diagnosis_evidence": list(advisory.diagnosis_evidence),
        "trace": {
            "upstream": [{"asset": a, "hops": h} for a, h in advisory.trace.upstream],
            "downstream_assets": list(advisory.trace.impact.assets),
            "zones": list(advisory.trace.impact.zones),
            "occupants": advisory.trace.impact.occupants,
            "cause": None if cause is None else {
                "asset": cause.cause.asset_id,
                "fault": cause.cause.fault_id,
                "title": cause.cause.title,
                "hops": cause.hops,
                "medium": cause.propagation.medium,
                "mechanism": cause.propagation.mechanism,
                "timing": cause.concurrency.summary,
            },
        },
        "severity": {
            "score": advisory.severity.score,
            "terms": advisory.severity.terms,
            "weights": SEVERITY_WEIGHTS,
            "slope_per_day": advisory.severity.slope_per_day,
            "slope_days": advisory.severity.slope_days,
            "criticality_tier": advisory.severity.criticality_tier,
            "occupants": advisory.severity.occupants,
        },
        "cost": {
            "horizon_days": HORIZON_DAYS,
            "total_usd": advisory.cost.total_usd,
            "energy_usd": advisory.cost.energy_usd,
            "consequential_usd": advisory.cost.consequential_usd,
            "excess_kw": advisory.cost.excess_kw,
            "duty": advisory.cost.duty,
            "priceable": advisory.cost.priceable,
            "basis": advisory.cost.basis.split("; "),
        },
        "effort_usd": advisory.effort_usd,
        "priority": priority,
        "intervention": None if intervention is None else {
            "id": intervention.intervention_id,
            "description": intervention.description,
            "duration_hours": intervention.duration_hours,
            "skills": list(intervention.skills),
            "parts": list(intervention.parts),
            "parts_cost_usd": intervention.parts_cost_usd,
            "basis": intervention.basis,
            "matched_on_class": intervention.matched_on_class,
        },
        "notes": list(advisory.notes),
    }


def write_advisories(
    conn: psycopg.Connection, ordered: list[Advisory], generated_at: datetime
) -> int:
    """Replace the advisory queue in one transaction.

    Deleted and rewritten rather than merged, for the same reason app.asset_edges is:
    this table is derived output, and a stale row is worse than a missing one. An
    advisory left behind from a previous run points a technician at a fault the
    current evidence no longer supports, and nothing in the queue would mark it as
    out of date. The delete and the insert share a transaction, so no reader ever
    sees the queue empty.
    """
    import json

    rows = []
    for advisory in ordered:
        priority = effective_priority(advisory, ordered)
        cause = advisory.trace.cause
        rows.append(
            (
                advisory_id(advisory), advisory.asset_id, advisory.fault_id,
                advisory.mode_id, advisory.fault_source, advisory.fault_class,
                generated_at, advisory.window[0], advisory.window[1],
                advisory.health, advisory.severity.score, priority,
                advisory.cost.total_usd, max(MIN_EFFORT_USD, advisory.effort_usd),
                advisory.consequential,
                None if cause is None else cause.cause.asset_id,
                None if cause is None else cause.cause.fault_id,
                json.dumps(as_payload(advisory, priority)),
            )
        )
    with conn.transaction():
        conn.execute("DELETE FROM app.advisories")
        with conn.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO app.advisories (advisory_id, asset_id, fault_id, mode_id, "
                "  fault_source, fault_class, generated_at, window_from, window_to, "
                "  health, severity, priority, cost_usd, effort_usd, consequential, "
                "  cause_asset, cause_fault, detail) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                "        %s, %s, %s)",
                rows,
            )
    return len(rows)
