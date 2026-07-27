"""The building as a drawable graph: what feeds what, and what is measured where.

WHY THIS IS NOT app.asset_edges. That table answers "is A upstream of B" between
DATABASE assets, and it is the right shape for root cause search -- one indexed SQL
join instead of a SPARQL round trip per row. It is the wrong shape for a picture,
because the database models one air handler as a single asset while the graph models
its coil, its fans, its dampers and its five zones separately. Every relation inside
the air handler therefore collapses to ahu-1 -> ahu-1 and is dropped as a self-edge.
Flattened, this building is eight nodes; drawn from the graph it is thirty, and the
chain that matters -- a cooling tower, through the condenser water, through a chiller,
through the chilled water, into the coil, through the fan, to five occupied zones --
only exists in the second one.

WHAT COUNTS AS A NODE. Anything that carries flow, holds a reading, or contains
something that does. That is a deliberate superset of the flow chain: the outside air
damper feeds nothing in the model, but it has a position sensor, it is the target of
one of the injected faults, and a picture of this building that omitted it would be
lying by omission. The three grouping nodes -- the plant and its two water systems --
carry no readings and exist so the drawing can nest rather than sprawl.

TWO KINDS OF EDGE, both returned and clearly labelled. `feeds` is flow, so it is the
direction a fault travels and the direction the picture should read. `hasPart` is
containment, so it says which box a thing is drawn inside. They are not
interchangeable and neither can be derived from the other.

POINTS. A graph point and a database point are not the same object and are joined
here rather than assumed. Each graph point's local name is a column in a source CSV;
the ingestion manifests map that column to a point_id; app.points is keyed on the
point_id. The join is done through the manifests, exactly as node_to_asset_id does it,
so a graph point that never became a database column comes back with point_id None
rather than being silently dropped -- a sensor the model claims exists and the
database has no readings for is a fact worth showing, not hiding.

Nothing here reads the database or the measurement history. This is the shape of the
building, which does not change while the process runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cache

import yaml
from rdflib import Graph, URIRef
from rdflib.namespace import RDF

from model.graph import MANIFEST_DIR, MANIFEST_SYSTEMS
from model.loader import BRICK, local_name, system_of

# Flow first, containment second. The order is the order the API returns them in and
# the order a caller should prefer when both describe the same pair.
EDGE_PREDICATES = (("feeds", BRICK.feeds), ("hasPart", BRICK.hasPart))


@dataclass(frozen=True)
class TwinPoint:
    """One reading attached to one node, joined to its database identity."""

    graph_name: str          # the local name in the graph, which is the CSV column
    point_id: str | None     # the database key, or None if this never became a column
    brick_class: str
    name: str | None
    unit_si: str | None


@dataclass
class TwinNode:
    """One piece of equipment, space or loop, and everything measured on it."""

    node_id: str
    label: str
    brick_class: str
    asset_id: str | None
    parent: str | None
    points: list[TwinPoint] = field(default_factory=list)


@dataclass(frozen=True)
class TwinEdge:
    from_node: str
    to_node: str
    relation: str


@dataclass(frozen=True)
class Twin:
    nodes: list[TwinNode]
    edges: list[TwinEdge]


@cache
def _point_index() -> dict[tuple[str, str], dict]:
    """Every source column, keyed by the system and column name the graph uses.

    The same manifests node_to_asset_id reads, for the same reason: nothing in the
    graph states a point's database identity, and it is recovered through the column
    name both sides happen to share.
    """
    index: dict[tuple[str, str], dict] = {}
    for system in MANIFEST_SYSTEMS:
        manifest = yaml.safe_load((MANIFEST_DIR / f"{system}.yaml").read_text())
        for point in manifest["points"]:
            index[(system, point["column"])] = point
    return index


def _brick_class(graph: Graph, node: URIRef) -> str:
    """The node's Brick type, or its first type if somehow it has no Brick one.

    A node can carry more than one rdf:type. Only the Brick one is meaningful to a
    drawing -- it decides the icon and the colour -- so it is preferred explicitly
    rather than relying on whichever the store happens to return first.
    """
    types = list(graph.objects(node, RDF.type))
    for term in types:
        if str(term).startswith(str(BRICK)):
            return local_name(term)
    return local_name(types[0]) if types else "Thing"


def _label(node_id: str) -> str:
    """Underscores to spaces. The graph's local names are already human-ordered."""
    return node_id.replace("_", " ")


def build(graph: Graph, mapping: dict[URIRef, str]) -> Twin:
    """Every node worth drawing, every edge between them, and the readings on each.

    `mapping` is node_to_asset_id's output -- which database asset each graph node's
    readings belong to. It is passed in rather than recomputed because the API already
    holds one, and because recovering it walks every point in the graph.
    """
    points_by_holder: dict[URIRef, list[TwinPoint]] = {}
    index = _point_index()
    for holder, point in graph.subject_objects(BRICK.hasPoint):
        system = system_of(point)
        column = local_name(point)
        record = index.get((system, column)) if system else None
        points_by_holder.setdefault(holder, []).append(
            TwinPoint(
                graph_name=column,
                point_id=None if record is None else record["point_id"],
                brick_class=_brick_class(graph, point),
                name=None if record is None else record.get("name"),
                unit_si=None if record is None else record.get("unit_si"),
            )
        )

    # A node is worth drawing if it carries flow, holds a reading, or contains
    # something that does. Collected before any edge is emitted so that an edge can
    # never point at a node the caller was not given.
    keep: set[URIRef] = set(points_by_holder)
    parent_of: dict[URIRef, URIRef] = {}
    for _relation, predicate in EDGE_PREDICATES:
        for subject, obj in graph.subject_objects(predicate):
            keep.add(subject)
            keep.add(obj)
            if predicate == BRICK.hasPart:
                parent_of[obj] = subject

    nodes = [
        TwinNode(
            node_id=local_name(node),
            label=_label(local_name(node)),
            brick_class=_brick_class(graph, node),
            asset_id=mapping.get(node),
            parent=local_name(parent_of[node]) if node in parent_of else None,
            points=sorted(points_by_holder.get(node, []), key=lambda p: p.graph_name),
        )
        for node in keep
    ]

    edges = [
        TwinEdge(local_name(subject), local_name(obj), relation)
        for relation, predicate in EDGE_PREDICATES
        for subject, obj in graph.subject_objects(predicate)
        if subject in keep and obj in keep
    ]

    return Twin(
        nodes=sorted(nodes, key=lambda n: n.node_id),
        edges=sorted(edges, key=lambda e: (e.relation, e.from_node, e.to_node)),
    )
