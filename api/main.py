"""The FastAPI application: every endpoint the dashboard reads.

    uv run uvicorn api.main:app --reload --port 8000
    open http://localhost:8000/docs

Nine endpoints in four groups: assets and their instruments, time series, the
advisory queue, and graph traversal. All of them read; none computes. See
api/__init__.py for why that boundary is where it is.

TWO RULES ENFORCED HERE RATHER THAN TRUSTED

Time series come from the hourly rollup and never from app.measurements. The raw
table is not referenced anywhere in this file, which is checkable by grep, and the
reason is not only chart performance -- an endpoint that serves raw samples lets a
client walk the entire measurement history one request at a time.

Nothing reads schema groundtruth. That is enforced below the API, by the database
grants: the role this process connects as has no privileges on that schema at all,
so an endpoint that tried would fail with permission denied rather than quietly
serving the answer key to a dashboard.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from functools import cache
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from analytics.advisories.generate import HORIZON_DAYS
from api.db import connection, semantic_graph
from api.models import (
    AdvisoryDetail,
    AdvisorySummary,
    AssetDetail,
    AssetSummary,
    ClassChange,
    ClockRange,
    DiagnosisCase,
    DiagnosisPair,
    EraSummary,
    GraphNode,
    GraphResult,
    HealthPoint,
    HealthSeries,
    Intervention,
    MachineTrace,
    PointSummary,
    RulExplanation,
    RulHistory,
    RulPoint,
    RulStep,
    SiteSummary,
    TimeseriesPoint,
    TimeseriesResult,
    TraceStage,
    TwinAssetState,
    TwinEdge,
    TwinNode,
    TwinPoint,
    TwinPointState,
    TwinState,
    TwinTopology,
)
from model.graph import downstream_assets, upstream_assets
from model.loader import MVN, local_name
from model.twin import build as build_twin

app = FastAPI(
    title="Aqueduct PDM",
    version="0.1.0",
    summary="Predictive maintenance for building HVAC equipment",
    description=(
        "Read-only access to detected faults, condition-normalised health, "
        "remaining-life predictions with their refusals, cross-asset root cause, "
        "and the operator advisory queue."
    ),
)

# The Vite dev server, on both hostnames it answers to. Listed explicitly rather
# than allowing everything: this API is read-only but it is read-only over a
# building's operational data, and a wildcard origin on a service like that is a
# habit worth not forming even in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

Conn = Annotated[psycopg.Connection, Depends(connection)]


# ---------------------------------------------------------------------------
# shared fragments
# ---------------------------------------------------------------------------

# Latest asset roll-up health per asset. A window function rather than a
# correlated subquery so one pass over the table serves every asset, and keyed on
# mode_id IS NULL because that is what marks a roll-up row as opposed to a
# per-mode row.
# Health is reported AS OF THE VINTAGE OF THAT ASSET'S OWN ADVISORIES, not simply
# the newest row in the table, and this is not a detail. The database holds eight
# independent simulation runs placed in separate calendar eras, so the newest row for
# an asset belongs to whichever of its runs happens to sit latest in the calendar --
# which for the air handler is the FAULT-FREE run of 2039. Reported that way the
# asset list showed health 98 next to three open advisories, which reads as a broken
# system rather than as two views of different years. Anchoring to the window the
# advisories were computed over makes the two agree. Assets with no advisories fall
# back to their newest row, which is correct for them: nothing is claimed about them.
_LATEST_HEALTH = """
    SELECT h.asset_id, h.health, h.weakest_mode, h.time,
           row_number() OVER (PARTITION BY h.asset_id ORDER BY h.time DESC) AS rn
      FROM app.health_state h
      LEFT JOIN (SELECT asset_id, max(window_to) AS as_of
                   FROM app.advisories GROUP BY asset_id) v
             ON v.asset_id = h.asset_id
     WHERE h.mode_id IS NULL
       AND (v.as_of IS NULL OR h.time <= v.as_of)
"""

_ADVISORY_COUNTS = """
    SELECT asset_id, count(*) AS n FROM app.advisories
     WHERE status = 'open' GROUP BY asset_id
"""


# How far back a queue may have been computed and still describe "now". The replay
# writes one per day, so anything inside two days is the current one; anything older
# means this run has no queue yet. Deliberately not larger -- the gap between two runs
# in this database is a whole year, and the only thing a bigger number buys is the
# chance of serving one run's advisories against another run's clock.
_VINTAGE_HOURS = 48.0


def _vintage(conn: psycopg.Connection, as_of: datetime | None) -> datetime | None:
    """Which day's advisory queue to serve for a given moment.

    app.advisories now holds one complete queue per day, each identified by the date
    its observation window ends on. "The queue at 3 June" therefore means the rows
    from the most recent queue computed at or before 3 June -- NOT every row whose
    window ends before then, which would pile six hundred days of history into one
    response and show an advisory that had already been superseded next to the one
    that superseded it.

    With no moment given, the newest queue in the table. That keeps the plain
    /advisories call meaning "the current queue", which is what it meant when the
    table held exactly one.

    THE BOUND IS NOT OPTIONAL. Without it, "the most recent queue at or before this
    moment" walks backwards as far as the table goes, so a clock sitting in a run
    that has no queue yet is served one computed in a DIFFERENT RUN, years earlier
    and about different equipment. That was observed rather than theorised: a clock
    at 2038-09-20 came back with the queue of 2036-09-06 and three advisories that
    had nothing to do with the machine on screen. Beyond the bound the honest answer
    is that no queue exists, and an empty queue is a fact -- it is what a healthy
    building looks like.
    """
    floor = None if as_of is None else as_of - timedelta(hours=_VINTAGE_HOURS)
    row = conn.execute(
        "SELECT max(window_to) FROM app.advisories "
        " WHERE %(as_of)s::timestamptz IS NULL "
        "    OR (window_to <= %(as_of)s::timestamptz "
        "        AND window_to > %(floor)s::timestamptz)",
        {"as_of": as_of, "floor": floor},
    ).fetchone()
    return None if row is None else row[0]


def _asset_rows(conn: psycopg.Connection, asset_id: str | None = None) -> list[tuple]:
    return conn.execute(
        f"""
        WITH latest AS ({_LATEST_HEALTH}), counts AS ({_ADVISORY_COUNTS})
        SELECT a.asset_id, a.name, a.brick_class, a.criticality_tier,
               a.replacement_cost_usd, a.install_date,
               l.health, l.weakest_mode, l.time, coalesce(c.n, 0)
          FROM app.assets a
          LEFT JOIN latest l ON l.asset_id = a.asset_id AND l.rn = 1
          LEFT JOIN counts c ON c.asset_id = a.asset_id
         WHERE (%(asset)s::text IS NULL OR a.asset_id = %(asset)s::text)
         ORDER BY a.criticality_tier, a.asset_id
        """,
        {"asset": asset_id},
    ).fetchall()


def _model_value(asset_id: str, prop: str):
    """One mvn: property for an asset, read off its machine node in the graph.

    Delegates the node choice to the advisory layer's helper, which prefers a node
    carrying a criticality tier. Without that preference the air handler's occupancy
    comes back as 40 rather than 200, because its five occupied zones map to the same
    database asset and each of them asserts its own share.
    """
    from analytics.advisories.generate import _first_value

    graph, mapping = semantic_graph()
    owned = tuple(node for node, asset in mapping.items() if asset == asset_id)
    return _first_value(graph, owned, prop)


def _occupants(asset_id: str) -> int:
    value = _model_value(asset_id, "occupantsServed")
    return 0 if value is None else int(value)


def _repair_cost(asset_id: str) -> float | None:
    value = _model_value(asset_id, "repairCostUSD")
    return None if value is None else float(value)


def _summary(row: tuple) -> AssetSummary:
    return AssetSummary(
        asset_id=row[0], name=row[1], brick_class=row[2], criticality_tier=row[3],
        replacement_cost_usd=None if row[4] is None else float(row[4]),
        occupants_served=_occupants(row[0]),
        health=None if row[6] is None else int(row[6]),
        weakest_mode=row[7], health_as_of=row[8], open_advisories=row[9],
    )


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------


@app.get("/assets", response_model=list[AssetSummary], tags=["assets"])
def list_assets(conn: Conn) -> list[AssetSummary]:
    """Every piece of equipment, most critical first, with its current health."""
    return [_summary(row) for row in _asset_rows(conn)]


@app.get("/assets/{asset_id}", response_model=AssetDetail, tags=["assets"])
def get_asset(asset_id: str, conn: Conn) -> AssetDetail:
    """One asset, its economics and every instrument on it."""
    rows = _asset_rows(conn, asset_id)
    if not rows:
        raise HTTPException(status_code=404, detail=f"no asset {asset_id!r}")
    points = conn.execute(
        "SELECT point_id, name, brick_class, unit_si, expected_min, expected_max, "
        "       usable, unusable_reason "
        "  FROM app.points WHERE asset_id = %s ORDER BY point_id",
        (asset_id,),
    ).fetchall()
    base = _summary(rows[0])
    return AssetDetail(
        **base.model_dump(),
        install_date=None if rows[0][5] is None else rows[0][5].isoformat(),
        repair_cost_usd=_repair_cost(asset_id),
        points=[
            PointSummary(
                point_id=p[0], name=p[1], brick_class=p[2], unit_si=p[3],
                expected_min=p[4], expected_max=p[5],
                usable=p[6], unusable_reason=p[7],
            )
            for p in points
        ],
    )


@app.get("/assets/{asset_id}/health", response_model=HealthSeries, tags=["assets"])
def get_health(
    asset_id: str,
    conn: Conn,
    t_from: Annotated[datetime | None, Query(alias="from")] = None,
    t_to: Annotated[datetime | None, Query(alias="to")] = None,
    as_of: Annotated[
        datetime | None,
        Query(description="Truncate the series here. Same edge as `to`."),
    ] = None,
) -> HealthSeries:
    """Health over time, one series per failure mode plus the asset roll-up.

    The roll-up rows come back with mode_id null and carry weakest_mode, which names
    the failure mode that produced the minimum -- the single most useful field for a
    technician, because it turns "this chiller is at 40" into "this chiller is at 40
    because of its condenser".
    """
    rows = conn.execute(
        """
        SELECT time, mode_id, health, indicator_raw, indicator_monotonic,
               t_onset, weakest_mode
          FROM app.health_state
         WHERE asset_id = %(asset)s
           AND (%(t_from)s::timestamptz IS NULL OR time >= %(t_from)s::timestamptz)
           AND (%(t_to)s::timestamptz IS NULL OR time < %(t_to)s::timestamptz)
         ORDER BY time, mode_id NULLS FIRST
        """,
        {"asset": asset_id, "t_from": t_from, "t_to": t_to or as_of},
    ).fetchall()
    if not rows:
        raise HTTPException(
            status_code=404, detail=f"no health history for {asset_id!r} in that window"
        )
    return HealthSeries(
        asset_id=asset_id,
        modes=sorted({r[1] for r in rows if r[1] is not None}),
        series=[
            HealthPoint(
                time=r[0], mode_id=r[1],
                health=None if r[2] is None else int(r[2]),
                indicator_raw=r[3], indicator_monotonic=r[4],
                t_onset=r[5], weakest_mode=r[6],
            )
            for r in rows
        ],
    )


@app.get(
    "/assets/{asset_id}/timeseries",
    response_model=TimeseriesResult,
    tags=["assets"],
)
def get_timeseries(
    asset_id: str,
    conn: Conn,
    points: Annotated[
        str | None,
        Query(description="Comma-separated point ids. Omitted means every point."),
    ] = None,
    t_from: Annotated[datetime | None, Query(alias="from")] = None,
    t_to: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=20000)] = 5000,
) -> TimeseriesResult:
    """Hourly readings, from app.measurements_hourly and never from the raw table.

    The named points must belong to the named asset. That check is not paranoia
    about security -- the API is read-only over one building -- it is so that a
    typo in a point id returns 400 with the reason rather than an empty chart the
    caller then has to debug.
    """
    wanted = [p.strip() for p in points.split(",")] if points else None
    catalogue = dict(
        conn.execute(
            "SELECT point_id, unit_si FROM app.points WHERE asset_id = %s",
            (asset_id,),
        ).fetchall()
    )
    if not catalogue:
        raise HTTPException(status_code=404, detail=f"no asset {asset_id!r}")
    if wanted is None:
        wanted = sorted(catalogue)
    unknown = [p for p in wanted if p not in catalogue]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"{unknown} do not belong to {asset_id!r}",
        )

    rows = conn.execute(
        """
        SELECT point_id, bucket, avg_value_si, min_value_si, max_value_si,
               stddev_value_si, sample_count
          FROM app.measurements_hourly
         WHERE point_id = ANY(%(points)s)
           AND (%(t_from)s::timestamptz IS NULL OR bucket >= %(t_from)s::timestamptz)
           AND (%(t_to)s::timestamptz IS NULL OR bucket < %(t_to)s::timestamptz)
         ORDER BY bucket
         LIMIT %(limit)s
        """,
        {"points": wanted, "t_from": t_from, "t_to": t_to, "limit": limit},
    ).fetchall()

    series: dict[str, list[TimeseriesPoint]] = {p: [] for p in wanted}
    for point_id, bucket, mean, low, high, sd, count in rows:
        series[point_id].append(
            TimeseriesPoint(
                bucket=bucket, avg=mean, min=low, max=high, stddev=sd, samples=count
            )
        )
    return TimeseriesResult(
        asset_id=asset_id,
        unit_si={p: catalogue[p] for p in wanted},
        series=series,
    )


@app.get(
    "/assets/{asset_id}/rul-history", response_model=RulHistory, tags=["assets"]
)
def get_rul_history(
    asset_id: str,
    conn: Conn,
    as_of: Annotated[
        datetime | None,
        Query(description="Only estimates published at or before this moment"),
    ] = None,
) -> RulHistory:
    """Every remaining-life estimate ever published for this asset, oldest first.

    This is the endpoint the narrowing-interval chart is drawn from, and the reason
    app.rul_estimates keeps every date rather than only the latest. The width field
    is computed here rather than in the browser so the chart and any report quote the
    same number.
    """
    rows = conn.execute(
        "SELECT mode_id, as_of, p10, p50, p90, mu_hat, sigma_hat, n_samples "
        "  FROM app.rul_estimates WHERE asset_id = %(asset)s AND mode_id IS NOT NULL "
        "   AND (%(as_of)s::timestamptz IS NULL "
        "        OR as_of <= %(as_of)s::timestamptz) "
        " ORDER BY mode_id, as_of",
        {"asset": asset_id, "as_of": as_of},
    ).fetchall()
    if not rows:
        raise HTTPException(
            status_code=404, detail=f"no remaining-life history for {asset_id!r}"
        )
    modes: dict[str, list[RulPoint]] = {}
    for mode_id, published, p10, p50, p90, mu, sigma, n in rows:
        modes.setdefault(mode_id, []).append(
            RulPoint(
                as_of=published, p10=p10, p50=p50, p90=p90,
                width=None if p10 is None or p90 is None else p90 - p10,
                mu_hat=mu, sigma_hat=sigma, n_samples=n,
            )
        )
    thresholds = dict(
        conn.execute(
            "SELECT mode_id, failure_threshold FROM app.failure_modes "
            " WHERE mode_id = ANY(%s)",
            (list(modes),),
        ).fetchall()
    )
    units = dict(
        conn.execute(
            "SELECT mode_id, indicator_unit FROM app.failure_modes "
            " WHERE mode_id = ANY(%s)",
            (list(modes),),
        ).fetchall()
    )
    return RulHistory(
        asset_id=asset_id, modes=modes,
        failure_threshold={k: float(v) for k, v in thresholds.items()},
        indicator_unit=units,
    )


# ---------------------------------------------------------------------------
# advisories
# ---------------------------------------------------------------------------


@app.get("/advisories", response_model=list[AdvisorySummary], tags=["advisories"])
def list_advisories(
    conn: Conn,
    status: Annotated[
        str | None,
        Query(description="open, acknowledged or closed. Omitted means any."),
    ] = None,
    severity: Annotated[
        float | None,
        Query(ge=0.0, le=1.0, description="Minimum severity to include"),
    ] = None,
    fault_class: Annotated[str | None, Query()] = None,
    as_of: Annotated[
        datetime | None,
        Query(description="Serve the queue as it stood at this moment"),
    ] = None,
) -> list[AdvisorySummary]:
    """The operator's queue, in the order it should be worked.

    Ordered priced-first on priority, then unpriced on severity. That two-tier order
    is expressed in SQL as `priority IS NULL` ascending followed by priority
    descending and severity descending, which puts every priced row above every
    unpriced one without pretending a null priority is a number.

    `severity` filters rather than reorders. An operator narrowing to severity above
    0.5 wants fewer rows in the same order, not a different ranking.
    """
    rows = conn.execute(
        """
        SELECT v.advisory_id, v.asset_id, a.name, v.fault_id,
               v.detail #>> '{fault,title}', v.fault_class, v.mode_id, v.status,
               v.health, v.severity, v.priority, v.cost_usd, v.effort_usd,
               v.consequential, v.cause_asset, v.cause_fault,
               v.detail #>> '{forecast,sentence}', v.generated_at,
               -- #>> and not #>: the text extractor turns a JSON null into a SQL
               -- NULL, which casts cleanly, whereas casting a jsonb null to
               -- double precision is an error. A refused prediction stores JSON
               -- null in all three, so this path is the common one, not the edge.
               (v.detail #>> '{forecast,p10}')::float8,
               (v.detail #>> '{forecast,p50}')::float8,
               (v.detail #>> '{forecast,p90}')::float8
          FROM app.advisories v
          JOIN app.assets a ON a.asset_id = v.asset_id
         -- No "IS NULL OR" escape here on purpose. A null vintage means no queue
         -- was computed anywhere near this moment, and the answer to that is no
         -- rows, not every row. Written as a plain equality so the null propagates
         -- and the comparison is simply never true: an earlier version treated null
         -- as "do not filter" and served all six hundred days at once.
         WHERE v.window_to = %(vintage)s::timestamptz
           AND (%(status)s::text IS NULL OR v.status = %(status)s::text)
           AND (%(severity)s::float8 IS NULL OR v.severity >= %(severity)s::float8)
           AND (%(fault_class)s::text IS NULL
                OR v.fault_class = %(fault_class)s::text)
         ORDER BY (v.priority IS NULL), v.priority DESC, v.severity DESC, v.asset_id
        """,
        {"status": status, "severity": severity, "fault_class": fault_class,
         "vintage": _vintage(conn, as_of)},
    ).fetchall()
    return [
        AdvisorySummary(
            advisory_id=r[0], asset_id=r[1], asset_name=r[2], fault_id=r[3],
            fault_title=r[4] or r[3], fault_class=r[5], mode_id=r[6], status=r[7],
            health=None if r[8] is None else int(r[8]),
            severity=float(r[9]),
            priority=None if r[10] is None else float(r[10]),
            cost_usd=float(r[11]), effort_usd=float(r[12]),
            consequential=r[13], cause_asset=r[14], cause_fault=r[15],
            why=r[16] or "no remaining-life estimate", generated_at=r[17],
            p10=r[18], p50=r[19], p90=r[20],
        )
        for r in rows
    ]


@app.get("/advisories/summary", response_model=SiteSummary, tags=["advisories"])
def advisory_summary(
    conn: Conn,
    as_of: Annotated[
        datetime | None,
        Query(description="Summarise the queue as it stood at this moment"),
    ] = None,
) -> SiteSummary:
    """The strip along the top of the dashboard.

    Declared before /advisories/{advisory_id} on purpose: FastAPI matches routes in
    declaration order, so with the parameterised route first this path would be read
    as an advisory whose id is the word "summary" and return 404.
    """
    vintage = _vintage(conn, as_of)
    row = conn.execute(
        "SELECT count(*), count(*) FILTER (WHERE consequential), "
        "       count(*) FILTER (WHERE priority IS NULL), "
        "       coalesce(sum(cost_usd), 0), coalesce(sum(effort_usd), 0), "
        "       max(generated_at) FROM app.advisories WHERE status = 'open'"
        "   AND window_to = %(v)s::timestamptz",
        {"v": vintage},
    ).fetchone()
    by_class = dict(
        conn.execute(
            "SELECT fault_class, count(*) FROM app.advisories "
            " WHERE status = 'open' AND window_to = %(v)s::timestamptz"
            " GROUP BY 1",
            {"v": vintage},
        ).fetchall()
    )
    assets = conn.execute("SELECT count(*) FROM app.assets").fetchone()[0]
    worst = conn.execute(
        f"WITH latest AS ({_LATEST_HEALTH}) "
        "SELECT asset_id, health FROM latest WHERE rn = 1 AND health IS NOT NULL "
        " ORDER BY health LIMIT 1"
    ).fetchone()
    return SiteSummary(
        assets=assets,
        advisories=row[0], consequential=row[1], unpriced=row[2],
        by_class=by_class,
        worst_health=None if worst is None else int(worst[1]),
        worst_health_asset=None if worst is None else worst[0],
        total_cost_of_inaction_usd=float(row[3]),
        total_effort_usd=float(row[4]),
        horizon_days=HORIZON_DAYS,
        generated_at=row[5],
    )


@app.get(
    "/advisories/{advisory_id:path}",
    response_model=AdvisoryDetail,
    tags=["advisories"],
)
def get_advisory(advisory_id: str, conn: Conn) -> AdvisoryDetail:
    """One advisory in full: evidence, graph trace, cost arithmetic, recommendation.

    The `:path` converter is needed because an advisory id contains pipe characters
    and, on some clients, arrives percent-encoded in ways a plain string parameter
    rejects. It is a read-only lookup against a primary key, so a permissive
    converter costs nothing.
    """
    row = conn.execute(
        "SELECT advisory_id, asset_id, fault_id, status, generated_at, "
        "       window_from, window_to, detail FROM app.advisories "
        " WHERE advisory_id = %s",
        (advisory_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"no advisory {advisory_id!r}")
    return AdvisoryDetail(
        advisory_id=row[0], asset_id=row[1], fault_id=row[2], status=row[3],
        generated_at=row[4], window_from=row[5], window_to=row[6], detail=row[7],
    )


# ---------------------------------------------------------------------------
# graph traversal
# ---------------------------------------------------------------------------


def _traverse(conn: psycopg.Connection, asset_id: str, direction: str) -> GraphResult:
    """One direction of the feeds graph, annotated with health and advisory counts.

    Traverses from EVERY graph node belonging to the asset and unions the results,
    keeping the shortest hop count. One node is not enough: the database models a
    machine as a single asset while the graph models its parts, and the pipes attach
    to the parts. Traversing from the node called AHU alone finds nothing upstream of
    the air handler, because the chilled water loop arrives at its cooling coil.
    """
    graph, mapping = semantic_graph()
    starts = [node for node, asset in mapping.items() if asset == asset_id]
    if not starts:
        raise HTTPException(status_code=404, detail=f"no asset {asset_id!r} in the graph")

    walk = upstream_assets if direction == "upstream" else downstream_assets
    nearest: dict[str, int] = {}
    zones: set[str] = set()
    occupants = 0
    for start in starts:
        for row in walk(graph, start):
            if direction == "downstream" and "Zone" in local_name(row.asset):
                if local_name(row.asset) not in zones:
                    served = graph.value(row.asset, MVN["occupantsServed"])
                    occupants += 0 if served is None else int(served)
                zones.add(local_name(row.asset))
            other = mapping.get(row.asset)
            if other is None or other == asset_id:
                continue
            nearest[other] = min(row.hops, nearest.get(other, 1 << 30))

    if not nearest:
        return GraphResult(
            asset_id=asset_id, direction=direction, nodes=[],
            zones=sorted(zones), occupants=occupants,
        )

    facts = {
        r[0]: r for r in _asset_rows(conn)
    }
    nodes = [
        GraphNode(
            asset_id=other, name=facts[other][1], brick_class=facts[other][2],
            hops=hops,
            health=None if facts[other][6] is None else int(facts[other][6]),
            open_advisories=facts[other][9],
        )
        for other, hops in nearest.items()
        if other in facts
    ]
    return GraphResult(
        asset_id=asset_id, direction=direction,
        nodes=sorted(nodes, key=lambda n: (n.hops, n.asset_id)),
        zones=sorted(zones), occupants=occupants,
    )


@app.get("/graph/upstream/{asset_id}", response_model=GraphResult, tags=["graph"])
def graph_upstream(asset_id: str, conn: Conn) -> GraphResult:
    """Everything whose output eventually reaches this asset -- the cause candidates."""
    return _traverse(conn, asset_id, "upstream")


@app.get("/graph/downstream/{asset_id}", response_model=GraphResult, tags=["graph"])
def graph_downstream(asset_id: str, conn: Conn) -> GraphResult:
    """Everything this asset delivers to, and the occupants at the end of it."""
    return _traverse(conn, asset_id, "downstream")


# ---------------------------------------------------------------------------
# the digital twin
# ---------------------------------------------------------------------------


@cache
def _twin() -> TwinTopology:
    """The drawn building, built once.

    Cached for the process lifetime because it cannot change while the process runs:
    it is derived entirely from the Turtle files, and nothing in this API asserts a
    triple. Building it walks every point in the graph and reads both ingestion
    manifests, which is cheap once and wasteful on every request from a dashboard
    that redraws whenever its clock moves.
    """
    graph, mapping = semantic_graph()
    twin = build_twin(graph, mapping)
    return TwinTopology(
        nodes=[
            TwinNode(
                node_id=node.node_id, label=node.label, brick_class=node.brick_class,
                asset_id=node.asset_id, parent=node.parent,
                points=[
                    TwinPoint(
                        graph_name=point.graph_name, point_id=point.point_id,
                        brick_class=point.brick_class, name=point.name,
                        unit_si=point.unit_si,
                    )
                    for point in node.points
                ],
            )
            for node in twin.nodes
        ],
        edges=[
            TwinEdge(from_node=e.from_node, to_node=e.to_node, relation=e.relation)
            for e in twin.edges
        ],
        node_count=len(twin.nodes),
        edge_count=len(twin.edges),
        point_count=len({p.point_id for n in twin.nodes for p in n.points if p.point_id}),
        point_attachments=sum(len(n.points) for n in twin.nodes),
    )


@app.get("/twin/topology", response_model=TwinTopology, tags=["twin"])
def twin_topology() -> TwinTopology:
    """The building as a drawable graph: what feeds what, and what is measured where.

    Deliberately NOT served from app.asset_edges. That table flattens the graph to
    reachability between database assets, which drops every relation inside the air
    handler as a self-edge and leaves eight nodes. This returns the semantic model
    itself, where the chain from a cooling tower through the condenser water, a
    chiller, the chilled water, the coil and the fan to five occupied zones is
    actually present.

    Static for the lifetime of the process. Live values are a separate call.
    """
    return _twin()


# How far back a value may be and still be called current. The eras this database
# holds are separated by whole years, so without a bound the "latest reading at or
# before 2039-06-01" for a point that stopped reporting in 2036 is a three-year-old
# number presented as live. Twenty-four hours covers any gap inside a run and cannot
# reach across a gap between runs.
_STALE_HOURS = 24.0

# The daily tables need a longer bound than the hourly one for a reason that has
# nothing to do with staleness: health and remaining life are written once per day,
# so a clock sitting at 00:30 is already thirty minutes past a row written at 00:00
# the previous midnight, and a 24-hour bound would drop it. Two days always catches
# exactly one, never reaches the previous era.
_STALE_DAYS_HOURS = 48.0


@app.get("/twin/state", response_model=TwinState, tags=["twin"])
def twin_state(
    conn: Conn,
    as_of: Annotated[datetime, Query(description="The moment to report")],
    stale_after_hours: Annotated[
        float, Query(gt=0, le=8760, description="How old a reading may be and count")
    ] = _STALE_HOURS,
) -> TwinState:
    """Every live number the twin needs for one moment, in one call.

    ONE CALL AND NOT ONE PER NODE. A dashboard whose clock is running asks for this
    on every tick. Thirty-one nodes and a hundred and seven readings at one request
    each is thirty-one round trips per frame, so everything is fetched in four
    queries and assembled here.

    NOTHING AFTER as_of IS VISIBLE, which is the rule the whole replay rests on. Each
    query takes the most recent row at or before the moment asked for, and rejects it
    if it is older than the staleness bound -- so a machine that stopped reporting
    reads as silent rather than as frozen at its last value.

    THE COVERAGE GAP IS REPORTED, NOT HIDDEN. Only the readings a baseline was fitted
    for carry `expected` and `sigma`; every other reading comes back with a value and
    nulls. That is a real property of this system -- baselines were fitted where a
    residual drives a detection rule and nowhere else -- and points_with_baseline
    beside points_reporting says so in the response rather than leaving a caller to
    infer it from a screen full of grey.
    """
    floor = as_of - timedelta(hours=stale_after_hours)
    floor_daily = as_of - timedelta(hours=max(stale_after_hours, _STALE_DAYS_HOURS))

    values = conn.execute(
        """
        SELECT DISTINCT ON (point_id) point_id, bucket, avg_value_si
          FROM app.measurements_hourly
         WHERE bucket <= %(as_of)s AND bucket > %(floor)s
         ORDER BY point_id, bucket DESC
        """,
        {"as_of": as_of, "floor": floor},
    ).fetchall()

    residuals = conn.execute(
        """
        SELECT DISTINCT ON (point_id) point_id, baseline_id, expected, residual,
               normalised, observed, time
          FROM app.residuals
         WHERE time <= %(as_of)s AND time > %(floor)s
         ORDER BY point_id, time DESC
        """,
        {"as_of": as_of, "floor": floor},
    ).fetchall()

    health = conn.execute(
        """
        SELECT DISTINCT ON (asset_id) asset_id, time, health, weakest_mode
          FROM app.health_state
         WHERE mode_id IS NULL AND time <= %(as_of)s AND time > %(floor)s
         ORDER BY asset_id, time DESC
        """,
        {"as_of": as_of, "floor": floor_daily},
    ).fetchall()

    # Every mode's newest estimate, then the soonest one per asset is chosen below.
    # A node shows one remaining life and it should be the one that runs out first.
    rul = conn.execute(
        """
        SELECT DISTINCT ON (asset_id, mode_id) asset_id, mode_id, as_of,
               p10, p50, p90
          FROM app.rul_estimates
         WHERE mode_id IS NOT NULL AND as_of <= %(as_of)s AND as_of > %(floor)s
         ORDER BY asset_id, mode_id, as_of DESC
        """,
        {"as_of": as_of, "floor": floor_daily},
    ).fetchall()

    vintage = _vintage(conn, as_of)
    counts = dict(
        conn.execute(
            "SELECT asset_id, count(*) FROM app.advisories "
            " WHERE status = 'open' AND window_to = %(v)s::timestamptz"
            " GROUP BY 1",
            {"v": vintage},
        ).fetchall()
    )

    by_residual = {r[0]: r for r in residuals}
    points = {
        point_id: TwinPointState(
            point_id=point_id,
            value=None if value is None else float(value),
            at=bucket,
            observed=None if point_id not in by_residual else by_residual[point_id][5],
            residual_at=None if point_id not in by_residual else by_residual[point_id][6],
            expected=None if point_id not in by_residual else by_residual[point_id][2],
            residual=None if point_id not in by_residual else by_residual[point_id][3],
            sigma=None if point_id not in by_residual else by_residual[point_id][4],
            baseline_id=None if point_id not in by_residual else by_residual[point_id][1],
        )
        for point_id, bucket, value in values
    }

    soonest: dict[str, tuple] = {}
    for row in rul:
        asset_id, _mode, _published, _p10, p50, _p90 = row
        current = soonest.get(asset_id)
        if current is None or (p50 is not None and (current[4] is None or p50 < current[4])):
            soonest[asset_id] = row

    assets = {}
    for asset_id, time, score, weakest in health:
        row = soonest.get(asset_id)
        assets[asset_id] = TwinAssetState(
            asset_id=asset_id,
            health=None if score is None else int(score),
            weakest_mode=weakest,
            health_at=time,
            rul_mode=None if row is None else row[1],
            rul_p10=None if row is None else row[3],
            rul_p50=None if row is None else row[4],
            rul_p90=None if row is None else row[5],
            rul_as_of=None if row is None else row[2],
            open_advisories=counts.get(asset_id, 0),
        )
    # An asset can have a prediction or a queue without a health row inside the
    # window -- health is daily and can be missing at the very start of a run -- so
    # those are added rather than dropped.
    for asset_id in set(soonest) | set(counts):
        if asset_id in assets:
            continue
        row = soonest.get(asset_id)
        assets[asset_id] = TwinAssetState(
            asset_id=asset_id, health=None, weakest_mode=None, health_at=None,
            rul_mode=None if row is None else row[1],
            rul_p10=None if row is None else row[3],
            rul_p50=None if row is None else row[4],
            rul_p90=None if row is None else row[5],
            rul_as_of=None if row is None else row[2],
            open_advisories=counts.get(asset_id, 0),
        )

    return TwinState(
        as_of=as_of,
        advisory_vintage=vintage,
        points=points,
        assets=dict(sorted(assets.items())),
        points_reporting=len(points),
        points_with_baseline=sum(1 for p in points.values() if p.sigma is not None),
        stale_after_hours=stale_after_hours,
    )


# ---------------------------------------------------------------------------
# the clock
# ---------------------------------------------------------------------------


@app.get("/clock/eras", response_model=ClockRange, tags=["twin"])
def clock_eras(conn: Conn) -> ClockRange:
    """Where the clock may stand, and what it will find there.

    The demonstration's clock needs to know which stretches of time this database
    actually holds, and it must not learn that from the answer key -- the scenario
    manifests carry each fault's injection date, which is exactly what the operator
    view is not allowed to know. So the range is taken from the health history
    instead, which records only which days this project computed something for.

    One era per calendar year, because the simulator places every run a whole number
    of years from its 2018 source window. Two runs in the same year are on different
    equipment and share a clock.
    """
    rows = conn.execute(
        """
        SELECT extract(year FROM time)::int AS era,
               min(time), max(time),
               array_agg(DISTINCT asset_id ORDER BY asset_id)
          FROM app.health_state GROUP BY 1 ORDER BY 1
        """
    ).fetchall()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="no health history, so the clock has nowhere to stand. Run `make demo`.",
        )
    queue = dict(
        conn.execute(
            "SELECT extract(year FROM window_to)::int, count(DISTINCT window_to) "
            "  FROM app.advisories GROUP BY 1"
        ).fetchall()
    )
    eras = [
        EraSummary(
            era=int(era), t_from=t_from, t_to=t_to,
            days=(t_to.date() - t_from.date()).days + 1,
            assets=list(assets), queue_days=int(queue.get(int(era), 0)),
        )
        for era, t_from, t_to, assets in rows
    ]
    return ClockRange(
        eras=eras, t_from=min(e.t_from for e in eras), t_to=max(e.t_to for e in eras)
    )


# ---------------------------------------------------------------------------
# the engine trace
# ---------------------------------------------------------------------------

# The fault-free run every faulted day is compared against. Both clean scenarios sit in
# 2039; a day outside their span has no counterpart and the comparison is simply absent
# rather than approximated with a different time of year.
_CLEAN_ERA = 2039


def _stages(conn: psycopg.Connection, asset_id: str, as_of: datetime) -> list[TraceStage]:
    rows = conn.execute(
        "SELECT ordinal, stage, unit, entered, passed, dropped, detail "
        "  FROM app.engine_trace WHERE asset_id = %(a)s AND as_of = %(t)s "
        " ORDER BY ordinal",
        {"a": asset_id, "t": as_of},
    ).fetchall()
    return [
        TraceStage(
            ordinal=r[0], stage=r[1], unit=r[2], entered=r[3], passed=r[4],
            dropped=r[5], detail=r[6],
        )
        for r in rows
    ]


@app.get("/engine/trace", response_model=MachineTrace, tags=["engine"])
def engine_trace(
    conn: Conn,
    asset_id: Annotated[str, Query(description="Which machine")],
    as_of: Annotated[datetime, Query(description="Which day")],
) -> MachineTrace:
    """What the detection pipeline did on one machine on one day, stage by stage.

    Every other endpoint here serves what the system CONCLUDED. This one serves how it
    got there, and in particular everything it declined to conclude — a reading nobody
    trusts, a machine that is not running, an hour after a start when nothing is in
    balance, a rule briefly true during a gust. That is where the false-alarm rate
    comes from, and until this table existed none of it was visible.

    The fault-free counterpart is returned alongside where one exists. Every run in this
    database reads the same source year shifted by whole years, so the same day of the
    year in the clean run is the same weather and the same occupancy with nothing wrong.
    Without it a viewer sees a funnel narrowing and has nothing to judge it against; with
    it, the rules firing on healthy equipment and every one of those firings being killed
    by the persistence requirement is on the screen at the same time.
    """
    stages = _stages(conn, asset_id, as_of)
    if not stages:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no trace for {asset_id!r} on {as_of.date()}. The table is populated by "
                "`make engine-trace`, and a machine with no readings that day has no row."
            ),
        )

    clean: list[TraceStage] | None = None
    clean_as_of: datetime | None = None
    if as_of.year != _CLEAN_ERA:
        try:
            candidate = as_of.replace(year=_CLEAN_ERA)
        except ValueError:      # 29 February, which 2039 does not have
            candidate = None
        if candidate is not None:
            found = _stages(conn, asset_id, candidate)
            if found:
                clean = found
                clean_as_of = candidate

    return MachineTrace(
        asset_id=asset_id, as_of=as_of, stages=stages,
        clean=clean, clean_as_of=clean_as_of,
    )


# ---------------------------------------------------------------------------
# sensor versus equipment
# ---------------------------------------------------------------------------

# The pair the discrimination exists for. Both amount to "supply air is not where it
# should be" and from the symptom alone they are identical; one is a thermometer reading
# high and the other is a valve leaking past its seat. Defaults rather than constants so
# any two faults can be compared, but these two are the demonstration.
_PAIR = ("apar-20", "coil-valve-leak-by")


def _case(conn: psycopg.Connection, fault_id: str) -> DiagnosisCase | None:
    """One fault at its most-developed moment, with how it got there.

    The latest day is taken rather than a chosen one because that is where the
    classifier has the most evidence. The history alongside it is every day the fault
    was in a queue, so a class that changed is visible as a change rather than as a
    single confident answer.
    """
    rows = conn.execute(
        """
        SELECT window_to, asset_id, fault_class, detail, effort_usd
          FROM app.advisories WHERE fault_id = %s ORDER BY window_to
        """,
        (fault_id,),
    ).fetchall()
    if not rows:
        return None

    day, asset_id, fault_class, detail, effort = rows[-1]
    fault = detail.get("fault") or {}
    raw = detail.get("intervention") or {}

    def build(source: dict, cost: float) -> Intervention | None:
        if not source:
            return None
        return Intervention(
            intervention_id=source.get("id", ""),
            description=source.get("description", ""),
            duration_hours=float(source.get("duration_hours") or 0.0),
            parts=list(source.get("parts") or []),
            skills=list(source.get("skills") or []),
            parts_cost_usd=float(source.get("parts_cost_usd") or 0.0),
            basis=source.get("basis", ""),
            effort_usd=float(cost),
        )

    # The same fault on a day the classifier called it something else. This is the
    # counterfactual, and it is a real row rather than a lookup -- apar-20 reads
    # EQUIPMENT for ten days and SENSOR for three, so both dispatches were actually
    # costed by the advisory layer and can be set beside each other.
    other = next(
        (r for r in reversed(rows) if r[2] != fault_class), None
    )
    alternative = build((other[3].get("intervention") or {}), other[4]) if other else None

    intervention = build(raw, float(effort))
    return DiagnosisCase(
        asset_id=asset_id,
        fault_id=fault_id,
        title=fault.get("title", fault_id),
        as_of=day,
        fault_class=fault_class,
        class_reason=fault.get("class_reason", ""),
        evidence=list(detail.get("diagnosis_evidence") or []),
        intervention=intervention,
        alternative=alternative,
        history=[
            ClassChange(
                day=r[0],
                fault_class=r[2],
                class_reason=(r[3].get("fault") or {}).get("class_reason", ""),
            )
            for r in rows
        ],
    )


@app.get("/diagnosis/pair", response_model=DiagnosisPair, tags=["diagnosis"])
def diagnosis_pair(
    conn: Conn,
    left: Annotated[str, Query(description="Fault id")] = _PAIR[0],
    right: Annotated[str, Query(description="Fault id")] = _PAIR[1],
) -> DiagnosisPair:
    """Two faults that look the same and are not, and what telling them apart is worth.

    A supply air temperature above its setpoint is produced by a coil that cannot cool
    AND by a thermometer reading high. From the symptom alone the two are identical.
    Getting them the wrong way round sends a technician with a wrench to something that
    needs a calibration kit, or the reverse.

    THE TWO ARE FROM DIFFERENT RUNS, two years apart, and no position of the clock holds
    both. That is stated in the response rather than hidden: the alternative would be a
    screen implying these were ever seen side by side, which they were not. Each is shown
    at the last day it appeared in a queue, which is where its classifier had the most to
    work with.
    """
    one = _case(conn, left)
    two = _case(conn, right)
    # The ratio is within ONE fault, not between the two. A calibration and a valve
    # replacement are different jobs on different machines and dividing one by the
    # other answers no question anybody asked; the same symptom dispatched two ways
    # does, and that is the number the intervention library was built to produce.
    ratio = None
    for case in (one, two):
        if case and case.intervention and case.alternative:
            costs = sorted([case.intervention.effort_usd, case.alternative.effort_usd])
            if costs[0] > 0:
                ratio = round(costs[1] / costs[0], 2)
                break
    composed = bool(
        one and two and one.as_of.year != two.as_of.year
    )
    return DiagnosisPair(left=one, right=two, composed=composed, cost_ratio=ratio)


# ---------------------------------------------------------------------------
# how a remaining life is arrived at
# ---------------------------------------------------------------------------

# The indicator expression names its own source, e.g.
# "-{residual:@asset.sa_temp.shut-valve-supply-air}". Pulling the point and the baseline
# out of it is how the explainer finds the raw number the whole chain starts from,
# rather than having that mapping written down a second time here.
_RESIDUAL_REF = re.compile(r"\{residual:@asset\.([A-Za-z0-9_]+)\.([A-Za-z0-9_\-]+)\}")


def _fmt(value: float | None, digits: int = 3, unit: str = "") -> str:
    if value is None:
        return "not available"
    return f"{value:.{digits}f}{unit}"


@app.get("/prediction/explain", response_model=RulExplanation, tags=["prediction"])
def prediction_explain(
    conn: Conn,
    asset_id: Annotated[str, Query()],
    mode_id: Annotated[str, Query()],
    as_of: Annotated[datetime, Query(description="Which day's estimate to explain")],
) -> RulExplanation:
    """Walk the eight steps from a raw reading to a remaining-life interval.

    Every figure returned here is read from where the pipeline stored it, not
    recomputed. That is the point: a screen that recomputed the chain to describe it
    could disagree with the chain, and then a viewer has two answers and no way to tell
    which one the system actually used.
    """
    mode = conn.execute(
        "SELECT indicator_expression, indicator_unit, failure_threshold, "
        "       threshold_rationale, degradation_process "
        "  FROM app.failure_modes WHERE mode_id = %s",
        (mode_id,),
    ).fetchone()
    if mode is None:
        raise HTTPException(status_code=404, detail=f"no failure mode {mode_id!r}")
    expression, unit, threshold, rationale, process = mode

    estimate = conn.execute(
        "SELECT as_of, p10, p50, p90, mu_hat, sigma_hat, n_samples "
        "  FROM app.rul_estimates "
        " WHERE asset_id = %(a)s AND mode_id = %(m)s AND as_of <= %(t)s "
        " ORDER BY as_of DESC LIMIT 1",
        {"a": asset_id, "m": mode_id, "t": as_of},
    ).fetchone()
    health = conn.execute(
        "SELECT time, indicator_raw, indicator_monotonic, health, t_onset "
        "  FROM app.health_state "
        " WHERE asset_id = %(a)s AND mode_id = %(m)s AND time <= %(t)s "
        " ORDER BY time DESC LIMIT 1",
        {"a": asset_id, "m": mode_id, "t": as_of},
    ).fetchone()
    if estimate is None and health is None:
        raise HTTPException(
            status_code=404,
            detail=f"nothing scored for {asset_id!r}/{mode_id!r} at or before {as_of.date()}",
        )

    # Step 1's raw number, found by reading the expression rather than by a second
    # hardcoded mapping of mode to point.
    residual = None
    point_id = baseline_id = None
    match = _RESIDUAL_REF.search(expression or "")
    if match:
        point_id = f"{asset_id}.{match.group(1)}"
        baseline_id = f"{point_id}.{match.group(2)}"
        residual = conn.execute(
            "SELECT time, observed, expected, residual FROM app.residuals "
            " WHERE point_id = %(p)s AND baseline_id = %(b)s AND time <= %(t)s "
            " ORDER BY time DESC LIMIT 1",
            {"p": point_id, "b": baseline_id, "t": as_of},
        ).fetchone()

    p10, p50, p90 = (estimate[1], estimate[2], estimate[3]) if estimate else (None, None, None)
    mu, sigma, n = (estimate[4], estimate[5], estimate[6]) if estimate else (None, None, 0)
    raw = health[1] if health else None
    monotonic = health[2] if health else None
    onset = health[4] if health else None

    steps = [
        RulStep(
            ordinal=1, name="the reading, against what was expected",
            what_it_does=(
                "One instrument is compared with what a fitted baseline says it should "
                "read under the conditions of that moment. The gap between them is the "
                "residual, and it is what the whole chain is built on."
            ),
            value=(
                f"{point_id}: measured {_fmt(residual[1])}, expected {_fmt(residual[2])}, "
                f"gap {_fmt(residual[3])}"
                if residual
                else f"no residual stored for {point_id or 'this mode'}"
            ),
            source=f"app.residuals · baseline {baseline_id or 'unknown'}",
        ),
        RulStep(
            ordinal=2, name="turned into this failure mode's own number",
            what_it_does=(
                "Each failure mode says, in the database rather than in code, which "
                "residual measures it and which way round. Adding a mode is a row, not "
                "a code change."
            ),
            value=expression or "no expression configured",
            source="app.failure_modes.indicator_expression",
        ),
        RulStep(
            ordinal=3, name="one number per day",
            what_it_does=(
                "The day's five-minute values are reduced to their median, so a single "
                "odd afternoon cannot move the trend."
            ),
            value=_fmt(raw, 4, f" {unit}"),
            source="app.health_state.indicator_raw",
        ),
        RulStep(
            ordinal=4, name="degradation is not allowed to un-happen",
            what_it_does=(
                "Equipment does not repair itself, so the number is pulled into a "
                "never-improving shape. The prediction is fitted to THIS, not to the "
                "raw value, and the two can differ noticeably on a noisy indicator."
            ),
            value=(
                f"{_fmt(monotonic, 4, f' {unit}')}"
                + (
                    f"  (raw was {_fmt(raw, 4)}, so the clamp moved it "
                    f"{_fmt(abs((monotonic or 0) - (raw or 0)), 4)})"
                    if raw is not None and monotonic is not None
                    else ""
                )
            ),
            source="app.health_state.indicator_monotonic",
        ),
        RulStep(
            ordinal=5, name="when the decline was confirmed",
            what_it_does=(
                "Nothing is projected forward until a changepoint detector confirms the "
                "trend is real. Before this date the model refuses to answer at all."
            ),
            value=(
                f"confirmed {onset:%Y-%m-%d}"
                if onset
                else "not confirmed — nothing will be projected"
            ),
            source="app.health_state.t_onset",
        ),
        RulStep(
            ordinal=6, name="the rate of decline, and how sure",
            what_it_does=(
                "A drift process is fitted to the days since the changepoint: how fast "
                "the number is moving, and how much it wanders around that. The wander "
                "is what makes the answer an interval instead of a date."
            ),
            value=(
                f"drift {_fmt(mu, 5)} per day, spread {_fmt(sigma, 5)}, "
                f"fitted on {n} day{'' if n == 1 else 's'} of evidence"
                if estimate
                else "no fit"
            ),
            source="app.rul_estimates.mu_hat, sigma_hat, n_samples",
        ),
        RulStep(
            ordinal=7, name="how far there is to go",
            what_it_does=(
                "The mode counts as failed when its number reaches a threshold that has "
                "a physical justification recorded beside it. The question becomes: how "
                "long until a process drifting at that rate first touches that line."
            ),
            value=(
                f"threshold {threshold:.3f} {unit}, currently at "
                f"{_fmt(monotonic, 3, f' {unit}')}"
                + (
                    f" — {(monotonic / threshold * 100):.0f}% of the way"
                    if monotonic is not None and threshold
                    else ""
                )
            ),
            source="app.failure_modes.failure_threshold",
        ),
        RulStep(
            ordinal=8, name="the answer, as a range",
            what_it_does=(
                "The first time that drift is expected to touch the threshold, given as "
                "three dates rather than one: a pessimistic end, a middle, and an "
                "optimistic end. A missing end is the model declining to bound it, "
                "which is an answer and not missing data."
            ),
            value=(
                f"P10 {_fmt(p10, 1, ' days')} · P50 {_fmt(p50, 1, ' days')} · "
                f"P90 {_fmt(p90, 1, ' days')}"
                if estimate
                else "no estimate published"
            ),
            source="app.rul_estimates.p10, p50, p90",
        ),
    ]

    return RulExplanation(
        asset_id=asset_id, mode_id=mode_id,
        as_of=estimate[0] if estimate else (health[0] if health else as_of),
        indicator_unit=unit, failure_threshold=float(threshold),
        threshold_rationale=rationale, degradation_process=process,
        steps=steps, refused=estimate is not None and p50 is None,
    )
