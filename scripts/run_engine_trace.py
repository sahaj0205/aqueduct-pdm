"""Record what the detection pipeline did, machine by machine, day by day.

Populates app.engine_trace, which is what the engine screen reads. See
analytics/trace/funnel.py for what the ten stages are and why the units change.

WHY THIS IS A SEPARATE PASS FROM THE ADVISORY REPLAY. It should not be, and that is
worth stating rather than hiding. Both walk the same days over the same windows and
both run the same rules, so tracing inside the replay would have got this for nothing.
The replay was already running against the database when this was written, and
restarting it to fold the tracing in would have thrown away the days it had finished.
The cost is one extra pass; the fix, if these are ever rebuilt from empty, is to emit
the trace from the replay loop and delete this driver.

Same reading cache as the replay, for the same reason: the windows overlap by about
99% from one day to the next, and fetching them again is two thirds of the runtime.

    uv run python scripts/run_engine_trace.py --dry-run --era 2036 --limit-days 3
    uv run python scripts/run_engine_trace.py --resume
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_advisory_replay import PRELOAD, WINDOW_DAYS, EraReadings, eras

from analytics.rules import apar, chiller  # noqa: F401 - importing registers the rules
from analytics.rules.apar import POINTS_USED
from analytics.rules.chiller import CHILLERS, OFF, chiller_state, points_used
from analytics.rules.readings import resolve_dsn
from analytics.trace.funnel import (
    air_side_modes,
    configured_modes,
    rule_stages,
    store,
    stored_stages,
)
from model.graph import node_to_asset_id
from model.loader import load_merged_graph

# Which machines get a funnel, and how each one's idle state is named. The air
# handler is idle when the building is empty; a chiller is idle when it is not
# running. Same suppression machinery either way -- neither machine is in balance for
# the first hour after it starts -- so only the name of the off state differs.
TRACED = ("ahu-1", *CHILLERS)


def vintage_for(conn: psycopg.Connection, as_of: datetime) -> datetime | None:
    """The advisory queue nearest this moment, bounded the same way the API bounds it.

    Forty-eight hours, matching api.main._vintage. Without the bound a day with no
    queue of its own would be traced against one from a different run years away, and
    stage 10 would report findings about another building.
    """
    row = conn.execute(
        "SELECT max(window_to) FROM app.advisories "
        " WHERE window_to <= %(t)s AND window_to > %(f)s",
        {"t": as_of, "f": as_of - timedelta(hours=48)},
    ).fetchone()
    return None if row is None else row[0]


def trace_day(
    conn: psycopg.Connection, graph, readings: EraReadings, asset_id: str,
    as_of: datetime, window: tuple[datetime, datetime],
) -> list:
    """One machine's whole funnel for one day. Returns the stages; stores nothing."""
    brick_class = "brick:AHU" if asset_id == "ahu-1" else "brick:Chiller"
    if asset_id == "ahu-1":
        values, quality, flags = readings.asset("ahu-1", *window)
        if values.empty:
            return []
        modes = air_side_modes(values, quality, flags)
        stages = rule_stages(
            graph, "ahu-1", "brick:AHU", values, quality, flags, modes,
            POINTS_USED, off_state="unoccupied",
        )
    else:
        loaded = readings.window(asset_id, *window)
        if loaded is None:
            return []
        values, quality, flags = loaded
        modes = chiller_state(values, asset_id)
        stages = rule_stages(
            graph, asset_id, "brick:Chiller", values, quality, flags, modes,
            points_used(asset_id), off_state=OFF,
        )

    # What the later layers receive as candidates is one finding per RULE, not one
    # per episode. Nine stretches of the same saturated valve are one thing an
    # operator disposes of, and the rule layer collapses them before an advisory is
    # built. Counting episodes here made stage 10 read "18 candidates, 4 advisories,
    # 14 raised nothing" -- which described a collapse as a rejection.
    reporting = next(
        (list(s.detail.get("rules reporting", [])) for s in stages if s.ordinal == 6), []
    )
    return stages + stored_stages(
        conn, asset_id, as_of, window, vintage_for(conn, as_of), reporting,
        configured_modes(conn, graph, brick_class),
    )


def show(asset_id: str, as_of: datetime, stages) -> None:
    print(f"\n  {asset_id}  {as_of:%Y-%m-%d}")
    print(f"    {'#':<3}{'stage':<24}{'unit':<14}{'in':>10}{'out':>10}  dropped")
    for s in stages:
        reasons = "; ".join(f"{k} {v:,}" for k, v in s.dropped.items() if v)
        print(f"    {s.ordinal:<3}{s.stage:<24}{s.unit:<14}"
              f"{s.entered:>10,}{s.passed:>10,}  {reasons}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Populate app.engine_trace.")
    parser.add_argument("--era", type=int, default=None, help="only this era")
    parser.add_argument("--limit-days", type=int, default=None)
    parser.add_argument("--offset-days", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--resume", action="store_true",
                        help="skip machine-days already traced")
    parser.add_argument("--show", action="store_true",
                        help="print the funnel for every day traced")
    args = parser.parse_args()

    graph, _ = load_merged_graph()
    node_to_asset_id(graph)

    written = 0
    started = time.perf_counter()
    with psycopg.connect(resolve_dsn()) as conn:
        conn.autocommit = True
        done: set[tuple[str, datetime]] = set()
        if args.resume:
            done = {
                (r[0], r[1]) for r in conn.execute(
                    "SELECT DISTINCT asset_id, as_of FROM app.engine_trace"
                ).fetchall()
            }
            print(f"resuming: {len(done)} machine-days already traced")

        for era, era_from, era_to in eras(conn):
            if args.era is not None and era != args.era:
                continue
            days = (era_to.date() - era_from.date()).days + 1 - args.offset_days
            if args.limit_days is not None:
                days = min(days, args.limit_days)
            t0 = time.perf_counter()
            readings = EraReadings(conn, PRELOAD, era_from, era_to + timedelta(days=1))
            print(f"\n  era {era}: {era_from:%Y-%m-%d} .. {era_to:%Y-%m-%d}, "
                  f"{days} days, {readings.rows:,} rows preloaded in "
                  f"{time.perf_counter() - t0:.1f}s")

            for n, offset in enumerate(
                range(args.offset_days, args.offset_days + days), start=1
            ):
                as_of = era_from + timedelta(days=offset)
                window = (max(era_from, as_of - timedelta(days=WINDOW_DAYS)), as_of)
                if window[1] <= window[0]:
                    continue
                for asset_id in TRACED:
                    if (asset_id, as_of) in done:
                        continue
                    stages = trace_day(
                        conn, graph, readings, asset_id, as_of, window
                    )
                    if not stages:
                        continue
                    if args.show:
                        show(asset_id, as_of, stages)
                    if not args.dry_run:
                        written += store(conn, asset_id, as_of, stages)
                if n % 10 == 0 or n == days:
                    rate = (time.perf_counter() - t0) / n
                    print(f"    {as_of:%Y-%m-%d}  {n:>4}/{days}  "
                          f"{rate:5.1f}s/day  eta {(days - n) * rate / 60:5.1f} min")

        rows = conn.execute("SELECT count(*) FROM app.engine_trace").fetchone()[0]
        span = conn.execute(
            "SELECT count(DISTINCT as_of), count(DISTINCT asset_id) FROM app.engine_trace"
        ).fetchone()

    print(f"\n{'=' * 70}")
    print(f"  rows written this run  {written:,}")
    print(f"  app.engine_trace now   {rows:,} rows, "
          f"{span[0]:,} days x {span[1]} machines")
    print(f"  elapsed                {(time.perf_counter() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
