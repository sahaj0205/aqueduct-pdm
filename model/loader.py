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

BRICK = Namespace("https://brickschema.org/schema/Brick#")

# Our own namespace root. The LBNL files carry no absolute base URI of their
# own, so we have to supply one; this host does not need to resolve.
AQUEDUCT_ROOT = "https://aqueduct-pdm.local/"

SDAHU = Namespace(AQUEDUCT_ROOT + "sdahu#")
CHILLER = Namespace(AQUEDUCT_ROOT + "chiller#")

# The prefix both LBNL files use for their own entities.
SOURCE_PREFIX = "bldg"


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

# Two class URIs in the published files are miscased. Brick class URIs are
# case-sensitive, and the correctly-cased spelling of each is also used in the
# same corpus for the same concept, so left alone these two nodes would be
# invisible to any query that filters on the class.
#   Speed_status            -- SDAHU fan speeds; chiller uses Speed_Status
#   Water_temperature_Sensor -- CT_SW_TEMP_1; towers 2 and 3 use ..._Temperature_...
CLASS_SPELLING_REPAIRS: dict[URIRef, URIRef] = {
    BRICK["Speed_status"]: BRICK["Speed_Status"],
    BRICK["Water_temperature_Sensor"]: BRICK["Water_Temperature_Sensor"],
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
    """Rewrite the miscased class URIs listed in CLASS_SPELLING_REPAIRS.

    Returns what was changed so the caller can print it -- this is a repair to
    third-party data and should never happen silently.
    """
    offenders = [
        (subject, obj)
        for subject, _, obj in graph.triples((None, RDF.type, None))
        if obj in CLASS_SPELLING_REPAIRS
    ]
    repaired = []
    for subject, wrong in offenders:
        right = CLASS_SPELLING_REPAIRS[wrong]
        graph.remove((subject, RDF.type, wrong))
        graph.add((subject, RDF.type, right))
        repaired.append((subject, wrong, right))
    return repaired


def load_source_graphs() -> dict[str, Graph]:
    """Each source system as its own graph, already namespace-relocated."""
    return {source.key: _relocate_namespace(_parse_source(source), source) for source in SOURCES}


def load_merged_graph() -> tuple[Graph, list[tuple[URIRef, URIRef, URIRef]]]:
    """The one graph every downstream layer queries.

    Returns the merged graph and the list of class-spelling repairs applied.
    """
    merged = Graph()
    merged.bind("brick", BRICK)
    for source in SOURCES:
        merged.bind(source.key, source.namespace)

    for graph in load_source_graphs().values():
        for triple in graph:
            merged.add(triple)

    repairs = _repair_class_spellings(merged)
    return merged, repairs


def class_census(graph: Graph) -> dict[URIRef, Counter]:
    """For each brick: class, how many instances each source system holds."""
    census: dict[URIRef, Counter] = defaultdict(Counter)
    for subject, _, obj in graph.triples((None, RDF.type, None)):
        census[obj][system_of(subject) or "unknown"] += 1
    return census


def cross_system_triples(graph: Graph) -> list[tuple[URIRef, URIRef, URIRef]]:
    """Triples whose subject and object sit in different source systems.

    Zero of these means the AHU and the chiller plant are disconnected graphs
    and no traversal can get from one to the other.
    """
    found = []
    for subject, predicate, obj in graph:
        if not isinstance(obj, URIRef):
            continue
        left, right = system_of(subject), system_of(obj)
        if left and right and left != right:
            found.append((subject, predicate, obj))
    return found


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
    print(f"  distinct brick classes {len(census)}")

    print("\n=== class-spelling repairs applied ===")
    if not repairs:
        print("  none")
    for subject, wrong, right in repairs:
        print(f"  {local_name(subject):<16} {local_name(wrong)} -> {local_name(right)}")

    print("\n=== distinct brick: classes across both systems ===")
    print(f"  {'class':<52}{'sdahu':>7}{'chiller':>9}")
    for klass in sorted(census, key=local_name):
        counts = census[klass]
        print(
            f"  brick:{local_name(klass):<46}"
            f"{counts.get('sdahu', 0) or '.':>7}{counts.get('chiller', 0) or '.':>9}"
        )

    print("\n=== connectivity between the two systems ===")
    crossing = cross_system_triples(merged)
    print(f"  triples linking sdahu to chiller: {len(crossing)}")
    for subject, predicate, obj in crossing:
        print(f"    {local_name(subject)} {local_name(predicate)} {local_name(obj)}")

    fused_total, collisions = _collision_count()
    print("\n=== what a single shared namespace would have done ===")
    print(
        f"  triples if both files share one namespace: {fused_total} (vs {len(merged)} kept apart)"
    )
    print(f"  local names present in both systems: {collisions or 'none'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
