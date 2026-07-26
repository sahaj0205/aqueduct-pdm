"""Database access and the one shared copy of the semantic graph.

Two resources with very different costs, handled differently on purpose.

A DATABASE CONNECTION is cheap against a local Postgres, so one is opened per
request and closed with it. No pool, because a pool is a piece of state that has
to be sized, monitored and drained, and this API serves a single dashboard.

THE SEMANTIC GRAPH is not cheap: parsing three Turtle files and merging them takes
a noticeable fraction of a second, and the graph traversal endpoints would pay it
on every call. It is loaded once, lazily, on the first request that needs it, and
kept. That is safe here only because the graph is READ-ONLY in this process --
nothing in the API asserts a triple. The one place in the project that does assert
triples, the cross-asset fault marking, works on a throwaway copy for exactly this
reason.
"""

from __future__ import annotations

from collections.abc import Iterator
from functools import cache

import psycopg
from rdflib import Graph

from model.graph import node_to_asset_id, resolve_dsn


@cache
def dsn() -> str:
    """The restricted role's connection string.

    Note WHICH role: app_rw, which has no access at all to schema groundtruth. The
    API cannot serve the answer key even if somebody adds an endpoint that asks for
    it -- the query fails with permission denied rather than leaking labels into a
    dashboard.
    """
    return resolve_dsn()


def connection() -> Iterator[psycopg.Connection]:
    """One connection per request, as a FastAPI dependency."""
    with psycopg.connect(dsn()) as conn:
        yield conn


@cache
def semantic_graph() -> tuple[Graph, dict]:
    """The merged Brick graph and the graph-node-to-asset mapping, loaded once."""
    from model.loader import load_merged_graph

    graph, _ = load_merged_graph()
    mapping, _notes = node_to_asset_id(graph)
    return graph, mapping
