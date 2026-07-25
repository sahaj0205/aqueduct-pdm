"""Typed traversal over the semantic model, and the asset-level edge cache.

The five queries in model/queries/ are the interface to the graph. This module
wraps each one in a function that takes real Python values and returns typed
rows, so nothing above this layer writes SPARQL or handles rdflib terms.

It also flattens the graph into app.asset_edges. Every layer above needs to join
topology against measurements, health and faults in one SQL statement, and a
SPARQL round trip per row would make that unusable.

Run it directly to rebuild the edge cache and print the verification report:

    uv run python -m model.graph
"""

from __future__ import annotations

import os
from collections import Counter, deque
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import psycopg
import yaml
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF

from model.loader import (
    BRICK,
    MVN,
    REPO_ROOT,
    ModelSourceError,
    load_merged_graph,
    local_name,
    system_of,
)

QUERY_DIR = Path(__file__).resolve().parent / "queries"
MANIFEST_DIR = REPO_ROOT / "ingestion" / "manifests"
MANIFEST_SYSTEMS = ("sdahu", "chiller")

# Which Brick predicates become rows in app.asset_edges, and the name each is
# stored under. Both are walked in the direction the predicate points.
EDGE_RELATIONS: tuple[tuple[str, URIRef], ...] = (
    ("feeds", BRICK["feeds"]),
    ("hasPart", BRICK["hasPart"]),
)


@dataclass(frozen=True)
class PointRow:
    """One reading belonging to an asset or one of its parts."""

    point: URIRef
    point_class: URIRef | None
    holder: URIRef
    design_value: float | None


@dataclass(frozen=True)
class AssetRow:
    """One asset reached by a traversal, with how many hops away it is."""

    asset: URIRef
    asset_class: URIRef | None
    hops: int


@dataclass(frozen=True)
class FaultRow:
    """An upstream asset carrying an open fault."""

    asset: URIRef
    asset_class: URIRef | None
    fault: str
    hops: int


@dataclass(frozen=True)
class ConstraintRow:
    """One physical constraint and the readings it is computed from."""

    constraint: URIRef
    label: str | None
    expression: str
    points: tuple[URIRef, ...]


@dataclass(frozen=True)
class AssetEdge:
    """One row of app.asset_edges."""

    from_asset: str
    to_asset: str
    relation: str
    hop_distance: int


@cache
def load_query(name: str) -> str:
    """Read a .rq file. Cached because the rule engine will call these in loops."""
    path = QUERY_DIR / f"{name}.rq"
    if not path.exists():
        raise ModelSourceError(f"Query file missing: {path}")
    return path.read_text()


def _as_float(term) -> float | None:
    return float(term) if isinstance(term, Literal) else None


def _hops_from(graph: Graph, start: URIRef, predicate: URIRef, reverse: bool) -> dict[URIRef, int]:
    """Shortest hop count from `start` to every node reachable along `predicate`.

    Breadth-first, so the first time a node is seen is by its shortest path. This
    exists because SPARQL property paths report reachability without path length,
    and the distance is what lets root cause search prefer a near cause over a
    far one. Cycles terminate naturally -- a node already seen is never queued
    again -- so this stays correct if a future model closes a water loop.
    """
    seen: dict[URIRef, int] = {}
    queue: deque[tuple[URIRef, int]] = deque([(start, 0)])
    while queue:
        node, depth = queue.popleft()
        neighbours = graph.subjects(predicate, node) if reverse else graph.objects(node, predicate)
        for neighbour in neighbours:
            if not isinstance(neighbour, URIRef) or neighbour in seen or neighbour == start:
                continue
            seen[neighbour] = depth + 1
            queue.append((neighbour, depth + 1))
    return seen


def _traverse(
    graph: Graph, asset: URIRef, query: str, variable: str, reverse: bool
) -> list[AssetRow]:
    """Run a reachability query, then annotate each row with its hop distance.

    The query result is the authority on membership -- it is the artifact under
    review and the thing the rule engine will read. The breadth-first walk only
    supplies distances. They are two independent implementations of the same
    traversal, so a disagreement means one of them is wrong, and this raises
    rather than quietly returning a row with a made-up distance.
    """
    rows = graph.query(query, initBindings={"asset": asset})
    reached = {getattr(row, variable): getattr(row, f"{variable}_class") for row in rows}
    hops = _hops_from(graph, asset, BRICK["feeds"], reverse=reverse)

    missing = set(reached) - set(hops)
    if missing:
        raise ModelSourceError(
            f"{variable} traversal from {local_name(asset)} disagrees with the hop walk: "
            f"SPARQL reached {sorted(local_name(n) for n in missing)} and the walk did not"
        )
    return sorted(
        (AssetRow(node, klass, hops[node]) for node, klass in reached.items()),
        key=lambda row: (row.hops, local_name(row.asset)),
    )


def points_of_asset(graph: Graph, asset: URIRef) -> list[PointRow]:
    """Every reading on this asset or any of its parts."""
    rows = graph.query(load_query("points_of_asset"), initBindings={"asset": asset})
    return sorted(
        (
            PointRow(row.point, row.point_class, row.holder, _as_float(row.design_value))
            for row in rows
        ),
        key=lambda row: (local_name(row.holder), local_name(row.point)),
    )


def upstream_assets(graph: Graph, asset: URIRef) -> list[AssetRow]:
    """Everything whose output eventually reaches this asset -- cause candidates."""
    return _traverse(graph, asset, load_query("upstream_assets"), "upstream", reverse=True)


def downstream_assets(graph: Graph, asset: URIRef) -> list[AssetRow]:
    """Everything this asset eventually delivers to -- who suffers if it fails."""
    return _traverse(graph, asset, load_query("downstream_assets"), "downstream", reverse=False)


def constraint_members(graph: Graph, constraint: URIRef | None = None) -> list[ConstraintRow]:
    """Physical constraints and their readings. All of them if none is named."""
    bindings = {"constraint": constraint} if constraint is not None else {}
    rows = graph.query(load_query("constraint_members"), initBindings=bindings)

    collected: dict[URIRef, dict] = {}
    for row in rows:
        entry = collected.setdefault(
            row.constraint,
            {
                "label": str(row.label) if row.label else None,
                "expression": str(row.expression),
                "points": set(),
            },
        )
        entry["points"].add(row.point)
    return sorted(
        (
            ConstraintRow(
                constraint=node,
                label=entry["label"],
                expression=entry["expression"].strip(),
                points=tuple(sorted(entry["points"], key=local_name)),
            )
            for node, entry in collected.items()
        ),
        key=lambda row: local_name(row.constraint),
    )


def open_faults_upstream(
    graph: Graph, asset: URIRef, open_faults: dict[URIRef, str]
) -> list[FaultRow]:
    """Which upstream assets currently carry a fault.

    The fault marks are asserted into a copy of the graph and thrown away with
    it, so no fault state ever persists into the model. `open_faults` maps an
    asset node to its fault identifier and comes from the rule engine, never from
    the groundtruth schema -- which this code cannot read.
    """
    scratch = Graph()
    for triple in graph:
        scratch.add(triple)
    for node, fault_id in open_faults.items():
        scratch.add((node, MVN["hasOpenFault"], Literal(fault_id)))

    rows = scratch.query(load_query("open_faults_upstream"), initBindings={"asset": asset})
    hops = _hops_from(scratch, asset, BRICK["feeds"], reverse=True)
    return sorted(
        (
            FaultRow(row.upstream, row.upstream_class, str(row.fault), hops[row.upstream])
            for row in rows
        ),
        key=lambda row: (row.hops, local_name(row.asset)),
    )


def node_to_asset_id(graph: Graph) -> tuple[dict[URIRef, str], list[str]]:
    """Map each equipment node to the database asset it belongs to.

    Nothing in the graph states this, and there is no rule that derives ahu-1
    from sdahu:AHU or ct-1 from chiller:Cooling_Tower_1. It is recovered instead
    through the readings: each graph point's local name is a source CSV column,
    the ingestion manifests map that column to a point_id, and app.points records
    which asset that point belongs to. So a node's asset is whichever asset its
    own readings belong to.

    Returns the mapping and a list of nodes whose readings were not unanimous, so
    an ambiguity is reported rather than silently resolved.
    """
    column_to_asset: dict[tuple[str, str], str] = {}
    for system in MANIFEST_SYSTEMS:
        manifest = yaml.safe_load((MANIFEST_DIR / f"{system}.yaml").read_text())
        for point in manifest["points"]:
            column_to_asset[(system, point["column"])] = point["asset_id"]

    mapping: dict[URIRef, str] = {}
    notes: list[str] = []
    for node in set(graph.subjects(RDF.type, None)):
        votes = Counter()
        for point in graph.objects(node, BRICK["hasPoint"]):
            asset = column_to_asset.get((system_of(point), local_name(point)))
            if asset:
                votes[asset] += 1
        if not votes:
            continue
        winner, count = votes.most_common(1)[0]
        mapping[node] = winner
        if len(votes) > 1:
            notes.append(
                f"{local_name(node)} -> {winner} ({count}/{sum(votes.values())} readings; "
                f"also {', '.join(f'{a}:{n}' for a, n in votes.items() if a != winner)})"
            )
    return mapping, notes


def asset_edges(graph: Graph, mapping: dict[URIRef, str]) -> list[AssetEdge]:
    """Flatten the graph to shortest-distance reachability between database assets.

    Walks from every mapped node and records, for each other mapped node it
    reaches, the shortest hop count between the two assets. Paths run through
    unmapped nodes -- the two water loops are equipment in the graph but not
    assets in the database -- and those hops are counted, which is why a cooling
    tower reaches the air handler at four rather than appearing not to reach it.

    Self-edges are dropped. The database models one air handler as a single asset
    while the graph models its coil, fans, dampers and five zones separately, so
    every internal relation would otherwise collapse to ahu-1 -> ahu-1.
    """
    best: dict[tuple[str, str, str], int] = {}
    for relation, predicate in EDGE_RELATIONS:
        for node, from_asset in mapping.items():
            for reached, hops in _hops_from(graph, node, predicate, reverse=False).items():
                to_asset = mapping.get(reached)
                if to_asset is None or to_asset == from_asset:
                    continue
                key = (from_asset, to_asset, relation)
                if hops < best.get(key, 1 << 30):
                    best[key] = hops
    return sorted(
        (AssetEdge(f, t, r, h) for (f, t, r), h in best.items()),
        key=lambda edge: (edge.relation, edge.hop_distance, edge.from_asset, edge.to_asset),
    )


def libpq_dsn(url: str) -> str:
    """Strip SQLAlchemy's driver suffix so psycopg accepts the URL."""
    return url.replace("postgresql+psycopg://", "postgresql://")


def resolve_dsn() -> str:
    """Read the restricted role's connection string from .env."""
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())
    url = os.environ.get("APP_RW_DATABASE_URL")
    if not url:
        raise ModelSourceError("APP_RW_DATABASE_URL is not set -- see .env.example")
    return libpq_dsn(url)


def write_asset_edges(conn: psycopg.Connection, edges: list[AssetEdge]) -> tuple[int, int]:
    """Replace the contents of app.asset_edges in one transaction.

    Deleted and rewritten rather than merged, because the table is a cache of the
    graph and a stale row is worse than a missing one: a diagnosis that follows an
    edge the model no longer contains is wrong in a way nothing would flag. The
    delete and the insert share a transaction so no reader ever sees the table
    empty.
    """
    with conn.transaction():
        removed = conn.execute("DELETE FROM app.asset_edges").rowcount
        with conn.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO app.asset_edges (from_asset, to_asset, relation, hop_distance) "
                "VALUES (%s, %s, %s, %s)",
                [(e.from_asset, e.to_asset, e.relation, e.hop_distance) for e in edges],
            )
    return removed, len(edges)


def _show(rows, render, limit: int | None = None) -> None:
    shown = rows if limit is None else rows[:limit]
    for row in shown:
        print(f"    {render(row)}")
    if limit is not None and len(rows) > limit:
        print(f"    ... {len(rows) - limit} more")


def main() -> int:
    from model.loader import SDAHU, _prefixed

    graph, _ = load_merged_graph()
    mapping, notes = node_to_asset_id(graph)

    print("=== graph node -> database asset ===")
    print(f"  {len(mapping)} equipment nodes mapped to {len(set(mapping.values()))} assets")
    unmapped = sorted(
        local_name(n)
        for n in set(graph.subjects(RDF.type, None))
        if n not in mapping and system_of(n) in ("sdahu", "chiller", "site")
    )
    print(f"  nodes with no readings, so no asset: {len(unmapped)}")
    for note in notes:
        print(f"  shared reading: {note}")

    coil = SDAHU["Cooling_Coil"]
    ahu = SDAHU["AHU"]
    chiller_1 = URIRef("https://aqueduct-pdm.local/chiller#Chiller_1")
    tower_1 = URIRef("https://aqueduct-pdm.local/chiller#Cooling_Tower_1")

    print("\n=== 1. points_of_asset.rq -- ?asset = sdahu:AHU ===")
    points = points_of_asset(graph, ahu)
    print(f"  {len(points)} readings, grouped by the part that holds them")
    _show(
        points,
        lambda r: (
            f"{_prefixed(r.holder):<26} {_prefixed(r.point):<22} {_prefixed(r.point_class)}"
            + (f"   design={r.design_value}" if r.design_value is not None else "")
        ),
    )

    print("\n=== 1b. points_of_asset.rq -- ?asset = chiller:Chiller_1 ===")
    points = points_of_asset(graph, chiller_1)
    print(f"  {len(points)} readings")
    _show(points, lambda r: f"{_prefixed(r.point):<28} {_prefixed(r.point_class)}")

    print("\n=== 2. upstream_assets.rq -- ?asset = sdahu:Cooling_Coil ===")
    rows = upstream_assets(graph, coil)
    print(f"  {len(rows)} assets upstream, nearest first")
    _show(rows, lambda r: f"hop {r.hops}  {_prefixed(r.asset):<44} {_prefixed(r.asset_class)}")

    print("\n=== 3. downstream_assets.rq -- ?asset = chiller:Cooling_Tower_1 ===")
    rows = downstream_assets(graph, tower_1)
    print(f"  {len(rows)} assets downstream, nearest first")
    _show(rows, lambda r: f"hop {r.hops}  {_prefixed(r.asset):<44} {_prefixed(r.asset_class)}")

    print("\n=== 4. constraint_members.rq -- ?constraint unbound ===")
    constraints = constraint_members(graph)
    print(f"  {len(constraints)} constraints")
    for row in constraints:
        print(f"    {_prefixed(row.constraint):<30} {len(row.points)} points   {row.label}")
        print(f"      {row.expression}")
    single = constraint_members(graph, MVN["MixedAirBalance"])
    print(
        f"  bound to mvn:MixedAirBalance -> {len(single)} constraint, "
        f"{len(single[0].points)} points: "
        f"{[local_name(p) for p in single[0].points]}"
    )

    print("\n=== 5. open_faults_upstream.rq -- ?asset = sdahu:Cooling_Coil ===")
    print("  no rule engine exists yet, so the fault marks below are supplied by hand.")
    print("  they are NOT read from groundtruth -- that schema is unreadable from this role.")
    faults = {chiller_1: "FAULT-0001 condenser fouling", tower_1: "FAULT-0002 fill fouling"}
    for node, fault_id in faults.items():
        print(f"    asserted: {_prefixed(node)} hasOpenFault '{fault_id}'")
    rows = open_faults_upstream(graph, coil, faults)
    print(f"  {len(rows)} faulted assets upstream of the coil:")
    _show(rows, lambda r: f"hop {r.hops}  {_prefixed(r.asset):<30} {r.fault}")
    clean = open_faults_upstream(graph, coil, {})
    print(f"  with no faults asserted -> {len(clean)} rows (must be 0)")

    print("\n=== cross-check: SPARQL reachability vs the breadth-first walk ===")
    for label, node, variable, reverse in (
        ("upstream of Cooling_Coil", coil, "upstream", True),
        ("downstream of Cooling_Tower_1", tower_1, "downstream", False),
        ("upstream of Chiller_1", chiller_1, "upstream", True),
    ):
        query = load_query(f"{'upstream' if reverse else 'downstream'}_assets")
        sparql = {getattr(r, variable) for r in graph.query(query, initBindings={"asset": node})}
        walk = set(_hops_from(graph, node, BRICK["feeds"], reverse=reverse))
        print(
            f"  {label:<32} sparql {len(sparql):>2}   walk {len(walk):>2}   "
            f"{'AGREE' if sparql == walk else 'DISAGREE ' + str(sparql ^ walk)}"
        )

    print("\n=== app.asset_edges ===")
    edges = asset_edges(graph, mapping)
    print(f"  {len(edges)} edges derived from the graph")
    print(f"    {'relation':<10}{'from':<16}{'to':<16}{'hops'}")
    for edge in edges:
        print(f"    {edge.relation:<10}{edge.from_asset:<16}{edge.to_asset:<16}{edge.hop_distance}")

    with psycopg.connect(resolve_dsn()) as conn:
        removed, written = write_asset_edges(conn, edges)
        stored = conn.execute(
            "SELECT relation, count(*), min(hop_distance), max(hop_distance) "
            "FROM app.asset_edges GROUP BY relation ORDER BY relation"
        ).fetchall()
    print(f"\n  rebuilt: {removed} rows deleted, {written} inserted")
    for relation, count, low, high in stored:
        print(f"    {relation:<10}{count} rows, hop distance {low}..{high}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
