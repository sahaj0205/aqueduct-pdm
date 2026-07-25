"""Load the LBNL Brick models for the AHU and the chiller plant.

LBNL publishes each system as its own Turtle file. As published they are two
disconnected graphs that both declare the same relative namespace
(``@prefix bldg: <bldg-59#>``), so merging them naively fuses any two entities
that happen to share a local name. This module gives each system its own
namespace, merges them into one graph, and reports what it found.

Run it directly to produce the verification report:

    uv run python -m model.loader
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from rdflib import Graph, Namespace, URIRef
from rdflib.namespace import RDF

REPO_ROOT = Path(__file__).resolve().parent.parent
TTL_DIR = REPO_ROOT / "data" / "raw" / "ttl"
MODEL_DIR = REPO_ROOT / "model"

BRICK = Namespace("https://brickschema.org/schema/Brick#")

# Our own namespace root. The LBNL files carry no absolute base URI of their
# own, so we have to supply one; this host does not need to resolve.
AQUEDUCT_ROOT = "https://aqueduct-pdm.local/"

SDAHU = Namespace(AQUEDUCT_ROOT + "sdahu#")
CHILLER = Namespace(AQUEDUCT_ROOT + "chiller#")

# Our own additions: MVN is the extension vocabulary and the constraint
# instances, SITE is the equipment nodes we author that LBNL does not ship --
# currently the two water loops that join the systems together.
MVN = Namespace(AQUEDUCT_ROOT + "mvn#")
SITE = Namespace(AQUEDUCT_ROOT + "site#")

# The prefix both LBNL files use for their own entities. Unrelated to SITE
# above, despite Brick convention also using "bldg" for building instances.
SOURCE_PREFIX = "bldg"

# Loaded after the LBNL sources, in this order. These are ours, written by hand,
# and use absolute URIs, so they need none of the relocation the LBNL files do.
EXTENSION_FILES = ("extensions.ttl", "building_extensions.ttl")

# The three Brick predicates that describe topology rather than metadata. Used
# to decide which statements count as connecting two parts of the building.
TOPOLOGY_PREDICATES = (BRICK["feeds"], BRICK["hasPart"], BRICK["hasPoint"])


@dataclass(frozen=True)
class SourceModel:
    """One LBNL Turtle file and the namespace we relocate its entities into."""

    key: str
    filename: str
    namespace: Namespace
    description: str


SOURCES: tuple[SourceModel, ...] = (
    SourceModel(
        key="sdahu",
        filename="LBNL_FDD_Data_Sets_SDAHU_ttl.ttl",
        namespace=SDAHU,
        description="single-duct VAV air handling unit",
    ),
    SourceModel(
        key="chiller",
        filename="LBNL_FDD_Data_Sets_chiller_plant.ttl",
        namespace=CHILLER,
        description="water-cooled chiller plant",
    ),
)

SYSTEM_BY_NAMESPACE = {str(source.namespace): source.key for source in SOURCES}
SYSTEM_BY_NAMESPACE[str(SITE)] = "site"
SYSTEM_BY_NAMESPACE[str(MVN)] = "mvn"

# Class names in the published files that are not Brick classes, where the
# replacement is the same for every node carrying them. All four were checked
# against the published Brick 1.3 ontology: the wrong form is absent from it and
# the right form is present. Brick class URIs are compared exactly, so left alone
# these nodes are invisible to any query that filters on class.
#   Speed_status             -- SDAHU fan speeds; the chiller file spells it right
#   Water_temperature_Sensor -- CT_SW_TEMP_1; towers 2 and 3 spell it right
#   Electrical_Power_Sensor  -- 16 nodes; Brick calls it Electric_Power_Sensor
CLASS_SPELLING_REPAIRS: dict[URIRef, URIRef] = {
    BRICK["Speed_status"]: BRICK["Speed_Status"],
    BRICK["Water_temperature_Sensor"]: BRICK["Water_Temperature_Sensor"],
    BRICK["Electrical_Power_Sensor"]: BRICK["Electric_Power_Sensor"],
}

# Nodes whose class has to be decided one node at a time, because the published
# class is either wrong about what the node measures or too vague to be
# actionable. Keyed by (system, local name) so there is no ambiguity about which
# file the node came from. These mirror exactly the corrections applied to the
# database by scripts/fix_point_labels.sql and to the source-column mapping in
# the ingestion manifests -- graph, manifest and table must agree or a rule
# written against one will silently disagree with the data it reads.
NODE_CLASS_REPAIRS: dict[tuple[str, str], URIRef] = {
    # Secondary loop supply and return are swapped in the source. The column
    # named SW holds the warm return (11.97 degC over July) and RW holds the cold
    # supply (7.14 degC, matching the correctly-labelled primary supply at 7.19).
    ("chiller", "CWL_SEC_SW_TEMP"): BRICK["Chilled_Water_Return_Temperature_Sensor"],
    ("chiller", "CWL_SEC_RW_TEMP"): BRICK["Chilled_Water_Supply_Temperature_Sensor"],
    # The chiller-level condenser water pair is not swapped, but "supply" means
    # the opposite thing here than it does at plant level. Entering and leaving
    # are Brick's own unambiguous alternatives and cannot be read two ways.
    ("chiller", "CHL_SWCD_TEMP_1"): BRICK["Leaving_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CHL_SWCD_TEMP_2"): BRICK["Leaving_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CHL_SWCD_TEMP_3"): BRICK["Leaving_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CHL_RWCD_TEMP_1"): BRICK["Entering_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CHL_RWCD_TEMP_2"): BRICK["Entering_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CHL_RWCD_TEMP_3"): BRICK["Entering_Condenser_Water_Temperature_Sensor"],
    # Supply_Water_Temperature_Setpoint is not a Brick class, and unlike the
    # class-level repairs above it has no single replacement: the source uses one
    # class for two different fluids, so each node needs the class for its own.
    ("chiller", "CWL_PRI_SW_TEMPSPT"): BRICK["Supply_Chilled_Water_Temperature_Setpoint"],
    ("chiller", "CT_SW_TEMPSPT"): BRICK["Supply_Condenser_Water_Temperature_Setpoint"],
    # The outdoor air pair in the chiller file is swapped -- found in checkpoint
    # 1.4 and already un-swapped in the ingestion manifest, but the graph still
    # carried the published classes, which was the last place the model and the
    # database disagreed. The column named OA_TEMP holds wet bulb (the temperature
    # a wet thermometer reads, always at or below air temperature and the limit a
    # cooling tower works against); the one named OA_TEMP_WB holds dry bulb, and
    # matches the AHU's own air temperature to within 0.33 degF.
    ("chiller", "OA_TEMP"): BRICK["Outside_Air_Wet_Bulb_Temperature_Sensor"],
    ("chiller", "OA_TEMP_WB"): BRICK["Outside_Air_Temperature_Sensor"],
    # Fourteen readings the source types with a class that is real but too vague
    # to select on: a query for chilled water supply temperature would miss the
    # primary loop, and one for condenser water flow would miss every tower.
    #
    # Naming rule applied here, and the only exception to it. Water temperatures
    # are classed from the LOOP's point of view -- supply is the cold water going
    # to the load, return is the warm water coming back -- because that reading
    # agrees between the plant-level points and the towers. The chiller's own
    # condenser pair above is the exception, classed entering and leaving,
    # because there the loop convention and the machine's own convention
    # disagree and Brick offers unambiguous alternatives. Every assignment below
    # was checked against the July data, not inferred from the column name.
    ("chiller", "CWL_PRI_SW_TEMP"): BRICK["Chilled_Water_Supply_Temperature_Sensor"],
    ("chiller", "CWL_PRI_RW_TEMP"): BRICK["Chilled_Water_Return_Temperature_Sensor"],
    ("chiller", "CDWL_SW_TEMP"): BRICK["Supply_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CDWL_RW_TEMP"): BRICK["Return_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CDWL_CW_FLOW"): BRICK["Condenser_Water_Flow_Sensor"],
    ("chiller", "CT_SW_TEMP_1"): BRICK["Supply_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_SW_TEMP_2"): BRICK["Supply_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_SW_TEMP_3"): BRICK["Supply_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_RW_TEMP_1"): BRICK["Return_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_RW_TEMP_2"): BRICK["Return_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_RW_TEMP_3"): BRICK["Return_Condenser_Water_Temperature_Sensor"],
    ("chiller", "CT_FLOW_1"): BRICK["Condenser_Water_Flow_Sensor"],
    ("chiller", "CT_FLOW_2"): BRICK["Condenser_Water_Flow_Sensor"],
    ("chiller", "CT_FLOW_3"): BRICK["Condenser_Water_Flow_Sensor"],
}


class ModelSourceError(RuntimeError):
    """A source Brick file is missing or cannot be parsed."""


def local_name(term: URIRef) -> str:
    """The part of a URI after the final # or /."""
    text = str(term)
    for separator in ("#", "/"):
        if separator in text:
            return text.rsplit(separator, 1)[1]
    return text


def _prefixed(term: URIRef | None) -> str:
    """A URI as prefix:local for printing, e.g. chiller:Chiller_1."""
    if term is None:
        return "-"
    system = system_of(term)
    if system:
        return f"{system}:{local_name(term)}"
    if str(term).startswith(str(BRICK)):
        return f"brick:{local_name(term)}"
    return str(term)


def system_of(term: URIRef) -> str | None:
    """Which source system a URI belongs to, or None for brick:/rdf: terms."""
    text = str(term)
    for namespace, key in SYSTEM_BY_NAMESPACE.items():
        if text.startswith(namespace):
            return key
    return None


def _parse_source(source: SourceModel) -> Graph:
    """Parse one LBNL file, resolving its relative prefix against a stub base.

    The stub base is per-source, so the two files cannot resolve to the same
    namespace even before the rewrite below.
    """
    path = TTL_DIR / source.filename
    if not path.exists():
        raise ModelSourceError(
            f"Brick model missing: {path}\n"
            f"This is the LBNL-published semantic model for the {source.description}. "
            "It is not something to hand-author as a substitute -- re-download the "
            "LBNL FDD dataset ttl/ directory."
        )
    if path.stat().st_size == 0:
        raise ModelSourceError(f"Brick model is empty: {path}")

    graph = Graph()
    try:
        graph.parse(path, format="turtle", publicID=f"{AQUEDUCT_ROOT}{source.key}/")
    except Exception as exc:  # rdflib raises several unrelated parse types
        raise ModelSourceError(f"Brick model at {path} will not parse as Turtle: {exc}") from exc
    if len(graph) == 0:
        raise ModelSourceError(f"Brick model at {path} parsed to zero triples")
    return graph


def _relocate_namespace(graph: Graph, source: SourceModel) -> Graph:
    """Move every entity from the file's own prefix into the source's namespace.

    Reads the namespace actually bound to ``bldg`` rather than assuming the
    literal string ``bldg-59#``, so a re-published file with a different
    relative prefix still lands correctly.
    """
    bound = dict(graph.namespaces())
    if SOURCE_PREFIX not in bound:
        raise ModelSourceError(
            f"{source.filename} declares no '{SOURCE_PREFIX}:' prefix; found {sorted(bound)}"
        )
    origin = str(bound[SOURCE_PREFIX])

    def rename(term):
        if isinstance(term, URIRef) and str(term).startswith(origin):
            return source.namespace[str(term)[len(origin) :]]
        return term

    relocated = Graph()
    for subject, predicate, obj in graph:
        relocated.add((rename(subject), rename(predicate), rename(obj)))
    return relocated


def _repair_class_spellings(graph: Graph) -> list[tuple[URIRef, URIRef, URIRef]]:
    """Correct classes the published files get wrong.

    Applies the class-wide substitutions first, then the per-node ones, so a node
    listed in both ends up with the per-node answer. Returns every change made so
    the caller can print it -- this edits third-party data and must never happen
    silently.
    """
    repaired = []

    offenders = [
        (subject, obj)
        for subject, _, obj in graph.triples((None, RDF.type, None))
        if obj in CLASS_SPELLING_REPAIRS
    ]
    for subject, wrong in offenders:
        right = CLASS_SPELLING_REPAIRS[wrong]
        graph.remove((subject, RDF.type, wrong))
        graph.add((subject, RDF.type, right))
        repaired.append((subject, wrong, right))

    for (system, name), right in NODE_CLASS_REPAIRS.items():
        subject = next(
            (
                s
                for s in graph.subjects(RDF.type, None)
                if system_of(s) == system and local_name(s) == name
            ),
            None,
        )
        if subject is None:
            raise ModelSourceError(
                f"NODE_CLASS_REPAIRS names {system}:{name}, which is not in the graph. "
                "Either the source file changed or the entry is a typo -- a repair that "
                "silently matches nothing is worse than no repair."
            )
        for wrong in list(graph.objects(subject, RDF.type)):
            if wrong == right:
                continue
            graph.remove((subject, RDF.type, wrong))
            graph.add((subject, RDF.type, right))
            repaired.append((subject, wrong, right))

    return repaired


def load_source_graphs() -> dict[str, Graph]:
    """Each source system as its own graph, already namespace-relocated."""
    return {source.key: _relocate_namespace(_parse_source(source), source) for source in SOURCES}


def _parse_extension(name: str) -> Graph:
    """Parse one of our own extension files."""
    path = MODEL_DIR / name
    if not path.exists():
        raise ModelSourceError(f"Extension file missing: {path}")
    graph = Graph()
    try:
        graph.parse(path, format="turtle")
    except Exception as exc:
        raise ModelSourceError(f"Extension file {path} will not parse as Turtle: {exc}") from exc
    return graph


def load_merged_graph(
    with_extensions: bool = True,
) -> tuple[Graph, list[tuple[URIRef, URIRef, URIRef]]]:
    """The one graph every downstream layer queries.

    Returns the merged graph and the list of class-spelling repairs applied.
    Pass with_extensions=False to see the LBNL data alone, which is what proves
    the two published systems are disconnected without our additions.
    """
    merged = Graph()
    merged.bind("brick", BRICK)
    merged.bind("mvn", MVN)
    merged.bind("site", SITE)
    for source in SOURCES:
        merged.bind(source.key, source.namespace)

    for graph in load_source_graphs().values():
        for triple in graph:
            merged.add(triple)

    repairs = _repair_class_spellings(merged)

    if with_extensions:
        for name in EXTENSION_FILES:
            for triple in _parse_extension(name):
                merged.add(triple)

    return merged, repairs


def class_census(graph: Graph) -> dict[URIRef, Counter]:
    """For each brick: class, how many instances each source system holds."""
    census: dict[URIRef, Counter] = defaultdict(Counter)
    for subject, _, obj in graph.triples((None, RDF.type, None)):
        census[obj][system_of(subject) or "unknown"] += 1
    return census


def cross_system_triples(graph: Graph) -> list[tuple[URIRef, URIRef, URIRef]]:
    """Topology statements whose two ends sit in different namespaces.

    Restricted to feeds/hasPart/hasPoint so that constraint-to-point links,
    which cross namespaces by design, do not drown out the structural edges.
    Zero of these on the LBNL data alone is what proves the two published
    systems are disconnected graphs.
    """
    found = []
    for subject, predicate, obj in graph:
        if predicate not in TOPOLOGY_PREDICATES or not isinstance(obj, URIRef):
            continue
        left, right = system_of(subject), system_of(obj)
        if left and right and left != right:
            found.append((subject, predicate, obj))
    return found


# Transitive isFedBy. Brick declares isFedBy as the inverse of feeds, but we do
# not load the Brick ontology and rdflib does no OWL reasoning, so asking for
# brick:isFedBy directly would return nothing. ^brick:feeds is the inverse
# written as a SPARQL property path, which needs no reasoner, and + makes it
# transitive: every asset that feeds this one, directly or through any number of
# intermediates.
UPSTREAM_SPARQL = """
PREFIX brick: <https://brickschema.org/schema/Brick#>
SELECT DISTINCT ?upstream ?upstream_class WHERE {
    ?start (^brick:feeds)+ ?upstream .
    OPTIONAL { ?upstream a ?upstream_class }
}
"""


def upstream_of(graph: Graph, start: URIRef) -> list[tuple[URIRef, URIRef | None]]:
    """Every asset reachable by walking flow backwards from `start`.

    This is the query the checkpoint gate runs: from the air handler's cooling
    coil it must reach the chillers, otherwise a coil symptom can never be
    attributed to a chiller cause.
    """
    rows = graph.query(UPSTREAM_SPARQL, initBindings={"start": start})
    return sorted(
        {(row.upstream, row.upstream_class) for row in rows},
        key=lambda pair: local_name(pair[0]),
    )


def _collision_count() -> tuple[int, list[str]]:
    """What a single-namespace merge would have cost, for the report.

    Loads both files into one shared namespace and reports the resulting triple
    count plus the local names that appear in both systems. Diagnostic only --
    nothing downstream uses this graph.
    """
    shared = Namespace(AQUEDUCT_ROOT + "shared#")
    names: dict[str, set[str]] = defaultdict(set)
    fused = Graph()
    for source in SOURCES:
        one_namespace = SourceModel(
            key=source.key,
            filename=source.filename,
            namespace=shared,
            description=source.description,
        )
        relocated = _relocate_namespace(_parse_source(source), one_namespace)
        for triple in relocated:
            fused.add(triple)
        for subject, _, _ in relocated:
            names[local_name(subject)].add(source.key)
    collisions = sorted(name for name, systems in names.items() if len(systems) > 1)
    return len(fused), collisions


def main() -> int:
    try:
        sources = load_source_graphs()
        merged, repairs = load_merged_graph()
    except ModelSourceError as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 1

    print("=== sources ===")
    for source in SOURCES:
        print(
            f"  {source.filename:<44} {len(sources[source.key]):>4} triples   -> {source.namespace}"
        )

    print("\n=== merged graph ===")
    print(f"  total triples          {len(merged)}")
    print(f"  distinct subjects      {len(set(merged.subjects()))}")
    typed = set(merged.subjects(RDF.type, None))
    print(f"  typed entities         {len(typed)}")

    census = class_census(merged)
    print(f"  distinct rdf:type values {len(census)}")

    print("\n=== class-spelling repairs applied ===")
    if not repairs:
        print("  none")
    for subject, wrong, right in repairs:
        print(f"  {local_name(subject):<16} {local_name(wrong)} -> {local_name(right)}")

    print("\n=== distinct classes across the merged graph ===")
    print(f"  {'class':<52}{'sdahu':>7}{'chiller':>9}{'site':>6}{'mvn':>5}")
    for klass in sorted(census, key=local_name):
        counts = census[klass]
        print(
            f"  {_prefixed(klass):<52}"
            f"{counts.get('sdahu', 0) or '.':>7}{counts.get('chiller', 0) or '.':>9}"
            f"{counts.get('site', 0) or '.':>6}{counts.get('mvn', 0) or '.':>5}"
        )

    print("\n=== connectivity between the two systems ===")
    lbnl_only, _ = load_merged_graph(with_extensions=False)
    print(
        f"  LBNL data alone, cross-system topology triples: {len(cross_system_triples(lbnl_only))}"
    )
    print(
        f"  brick:feeds triples in the chiller plant file:  "
        f"{sum(1 for _ in sources['chiller'].triples((None, BRICK['feeds'], None)))}"
    )
    crossing = cross_system_triples(merged)
    print(f"  after our extensions, cross-namespace topology:  {len(crossing)}")
    for subject, predicate, obj in crossing:
        print(f"    {_prefixed(subject)} {local_name(predicate)} {_prefixed(obj)}")

    print("\n=== HARD GATE: transitive isFedBy from the AHU cooling coil ===")
    coil = SDAHU["Cooling_Coil"]
    upstream = upstream_of(merged, coil)
    print(f"  query: ?start (^brick:feeds)+ ?upstream    with ?start = {_prefixed(coil)}")
    print(f"  {len(upstream)} assets upstream of the cooling coil:\n")
    print(f"    {'asset':<46}{'class':<40}")
    for node, klass in upstream:
        print(f"    {_prefixed(node):<46}{_prefixed(klass) if klass else '(untyped)':<40}")
    chillers = [node for node, klass in upstream if klass == BRICK["Chiller"]]
    print(f"\n  chillers reached: {len(chillers)} -> {[local_name(c) for c in chillers]}")
    print(f"  GATE {'PASS' if chillers else 'FAIL'}")

    print("\n=== constraints ===")
    for constraint in sorted(merged.subjects(RDF.type, MVN["Constraint"]), key=local_name):
        members = sorted(merged.objects(constraint, MVN["constrainedBy"]), key=local_name)
        print(f"  {_prefixed(constraint)}   {len(members)} points")
        for expression in merged.objects(constraint, MVN["residualExpression"]):
            print(f"    residual: {str(expression).strip()}")

    fused_total, collisions = _collision_count()
    print("\n=== what a single shared namespace would have done ===")
    print(f"  triples if both LBNL files share one namespace: {fused_total}")
    print(f"  local names present in both systems: {collisions or 'none'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
