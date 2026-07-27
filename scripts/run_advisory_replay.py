"""Rebuild the advisory queue once per day across every era, and keep every day.

WHY THIS EXISTS. app.advisories holds one snapshot: what the queue looked like over
one hand-picked window. That is enough to show a dashboard, and not enough to show a
dashboard MOVING. The demo has to be able to put the clock at any date and answer
"what was on the operator's screen that morning" -- an advisory appearing, climbing
the ranking as the fault develops, and its cost of inaction growing with it. That
needs one queue per day, not one queue.

The schema already allowed this and nobody had used it: app.advisories is keyed
UNIQUE (asset_id, fault_id, window_to), and advisory_id is derived from those three,
so a queue computed to a different date is a different set of rows rather than a
collision. No migration was needed, only this driver.

WHAT IS DIFFERENT FROM run_advisories.py. That script builds one queue over fixed
windows chosen to show three specific advisories in full, and writes it with
write_advisories(), which DELETES the table first -- correct for a snapshot, fatal
for an accumulating history. This one writes additively with an upsert, so a partial
run is resumable and a rerun of the same day overwrites only that day.

THE TWO WINDOWS EACH ADVISORY CARRIES.

  observation  the trailing WINDOW_DAYS ending at the as-of date, clipped to the
               start of the era. This is what the rules sweep and what the evidence
               is measured over. It moves with the clock, which is the whole point:
               an advisory dated the 3rd of June may not know what an advisory dated
               the 10th knows.

  reference    a fault-free stretch to compare against, so a signal's movement can
               be expressed in its own quiet standard deviations. Two choices are
               offered and neither is free -- see REFERENCE below.

REFERENCE. run_advisories.py uses a fault-free window at the same time of year in a
clean era, which controls for weather but only exists where a clean era covers that
day of year. Across all four eras most days have no such counterpart: the clean runs
occupy 2039-05-10 to 2039-09-23, and the 2036 and 2037 eras start in February and
January. So the default here is each era's own commissioning window -- the 21 days
before the fault was injected, which are healthy by construction and are the same
stretch the baseline layer fits on. Task 7 tested that choice against the seasonal
one and found they agree where both are available; the seasonal reference is better
where it exists, not required. Pass --reference seasonal to use it and accept that
the run covers fewer days.

COST. The dominant cost is not the rule arithmetic, it is reading the same rows over
and over: six hundred overlapping 120-day windows drawn from four eras of a few
months each. Measured before this was written, a day cost 45 seconds, of which 35
was collect() and two thirds of THAT was the database read. So each era's readings
are loaded once into memory and sliced per day. The slice is half-open on the right,
matching the SQL the loader issues, so a sliced window and a fetched window are the
same rows.

    uv run python scripts/run_advisory_replay.py --dry-run --limit-days 10
    uv run python scripts/run_advisory_replay.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_advisories import classify_assets
from run_rootcause import collect, d

from analytics.advisories.generate import (
    MIN_EFFORT_USD,
    Advisory,
    advisory_id,
    as_payload,
    asset_facts,
    build,
    effective_priority,
    queue,
    site_economics,
)
from analytics.diagnosis.classify import AMBIGUOUS, Diagnosis, Evidence
from analytics.diagnosis.isolation import IsolationError
from analytics.diagnosis.rootcause import attribute, nodes_by_asset, rank
from analytics.rules.chiller import CHILLERS
from analytics.rules.readings import load_asset_readings, resolve_dsn
from model.graph import node_to_asset_id
from model.loader import load_merged_graph

# The trailing window each day's advisory is computed over. 120 days is the span
# run_advisories.py uses for the cross-asset situation, kept identical so a replayed
# advisory and the snapshot one are computed the same way and can be compared.
WINDOW_DAYS = 120

# Every scenario manifest declares pre_onset_days: 21 -- the healthy stretch before
# the fault is injected. Reading it from the manifests would mean the replay knew
# when each fault started, which is exactly the thing the detection path is not
# allowed to know, so the number is repeated here as a constant instead. It is a
# property of how the scenarios were built, not a fact about any particular fault.
COMMISSIONING_DAYS = 21

# The five assets whose readings any advisory in this project can draw on: the air
# handler, the three chillers, and the plant whose setpoint the capacity rule joins
# against. Preloaded per era.
PRELOAD = ("ahu-1", *CHILLERS, "chw-plant-1")

# The span the two clean scenarios occupy, used only by the seasonal reference mode.
CLEAN_FROM = d("2039-05-10")
CLEAN_TO = d("2039-09-24")


class EraReadings:
    """One era's readings for every asset, fetched once and sliced per day.

    Holds three frames per asset -- values, quality scores and quality flags -- on a
    shared time index, which is what the rule engine expects. The slice is half-open
    on the right because the SQL behind load_asset_readings is (>= from, < to), and a
    replay that sliced inclusively would hand the rules one extra sample per window
    and quietly stop matching the un-cached path.
    """

    def __init__(
        self,
        conn: psycopg.Connection,
        assets: tuple[str, ...],
        t_from: datetime,
        t_to: datetime,
    ) -> None:
        self._frames: dict[str, tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]] = {}
        self.rows = 0
        for asset_id in assets:
            values, quality, flags = load_asset_readings(conn, asset_id, t_from, t_to)
            self._frames[asset_id] = (values, quality, flags)
            self.rows += len(values)

    def asset(self, asset_id: str, t_from: datetime, t_to: datetime):
        """The same three frames load_asset_readings would return for this window."""
        frames = self._frames.get(asset_id)
        if frames is None:
            return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
        values, quality, flags = frames
        if values.empty:
            return values, quality, flags
        mask = (values.index >= t_from) & (values.index < t_to)
        return values.loc[mask], quality.loc[mask], flags.loc[mask]

    def window(self, asset_id: str, t_from: datetime, t_to: datetime):
        """What load_window returns for a chiller: its readings plus the plant setpoint.

        Reproduces the join in analytics.rules.chiller.load_window rather than calling
        it, because that function reaches for the database and this class exists to
        avoid that. Same keep-list, same left join, same None when either side is empty.
        """
        values, quality, flags = self.asset(asset_id, t_from, t_to)
        plant_v, plant_q, plant_f = self.asset("chw-plant-1", t_from, t_to)
        if values.empty or plant_v.empty:
            return None
        keep = ["chw-plant-1.pri_supply_temp_spt"]
        if any(keep[0] not in frame.columns for frame in (plant_v, plant_q, plant_f)):
            return None
        return (
            values.join(plant_v[keep], how="left"),
            quality.join(plant_q[keep], how="left"),
            flags.join(plant_f[keep], how="left"),
        )


def eras(conn: psycopg.Connection) -> list[tuple[int, datetime, datetime]]:
    """Every era the health layer has scored, and how far it runs.

    Taken from app.health_state rather than from the scenario manifests on purpose.
    The manifests carry each fault's injection date, which is answer-key material the
    detection path must not read; the health table carries only which days this
    project computed something for, which is all a replay needs to know. Each era is
    a calendar year here because the simulator places every scenario a whole number
    of years from its 2018 source window, so two scenarios in the same year are on
    different equipment and belong in the same queue.
    """
    rows = conn.execute(
        "SELECT extract(year FROM time)::int AS era, min(time), max(time) "
        "  FROM app.health_state GROUP BY 1 ORDER BY 1"
    ).fetchall()
    return [(int(era), t_from, t_to) for era, t_from, t_to in rows]


def already_written(conn: psycopg.Connection) -> set[datetime]:
    """The as-of dates that already have a queue, so a killed run can be resumed."""
    rows = conn.execute("SELECT DISTINCT window_to FROM app.advisories").fetchall()
    return {row[0] for row in rows}


def write_snapshot(
    conn: psycopg.Connection, ordered: list[Advisory], generated_at: datetime
) -> int:
    """Store one day's queue without disturbing any other day's.

    The difference from write_advisories() is the whole reason this function exists:
    that one empties the table first, because it owns the single snapshot it writes.
    Here every day owns its own rows, identified by the window they end at, so the
    write is an upsert on the primary key. Rerunning a day corrects that day and
    leaves the rest of the history alone.
    """
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
    if not rows:
        return 0
    with conn.transaction(), conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO app.advisories (advisory_id, asset_id, fault_id, mode_id, "
            "  fault_source, fault_class, generated_at, window_from, window_to, "
            "  health, severity, priority, cost_usd, effort_usd, consequential, "
            "  cause_asset, cause_fault, detail) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
            "        %s, %s, %s) "
            "ON CONFLICT (advisory_id) DO UPDATE SET "
            "  mode_id = EXCLUDED.mode_id, fault_source = EXCLUDED.fault_source, "
            "  fault_class = EXCLUDED.fault_class, generated_at = EXCLUDED.generated_at, "
            "  window_from = EXCLUDED.window_from, health = EXCLUDED.health, "
            "  severity = EXCLUDED.severity, priority = EXCLUDED.priority, "
            "  cost_usd = EXCLUDED.cost_usd, effort_usd = EXCLUDED.effort_usd, "
            "  consequential = EXCLUDED.consequential, cause_asset = EXCLUDED.cause_asset, "
            "  cause_fault = EXCLUDED.cause_fault, detail = EXCLUDED.detail",
            rows,
        )
    return len(rows)


def reference_window(
    mode: str, era_from: datetime, as_of: datetime, observation: tuple[datetime, datetime]
) -> tuple[datetime, datetime] | None:
    """The fault-free stretch this day's evidence is measured against.

    commissioning: the era's own first COMMISSIONING_DAYS, healthy by construction and
      always available. Its weakness is seasonal -- a February reference against an
      August observation compares two different weather regimes, and a point that
      moves with outdoor temperature will read as having shifted when only the season
      did. The residual and health layers do not have this problem because they are
      condition-normalised; this affects the evidence ranking on the advisory only.

    seasonal: the same calendar days one or more whole years later, in a clean era.
      Controls for weather, and returns None where no clean era covers those days,
      which is most of 2036 and 2037.
    """
    if mode == "commissioning":
        return (era_from, era_from + timedelta(days=COMMISSIONING_DAYS))
    for shift in (1, 2, 3):
        try:
            start = observation[0].replace(year=observation[0].year + shift)
            end = observation[1].replace(year=observation[1].year + shift)
        except ValueError:          # 29 February in a non-leap target year
            continue
        if start >= CLEAN_FROM and end <= CLEAN_TO:
            return (start, end)
    return None


def classify_or_ambiguous(
    conn: psycopg.Connection,
    asset_ids: set[str],
    degrading: dict[str, str],
    windows: dict[str, tuple[tuple[str, str], tuple[str, str]]],
) -> dict:
    """Classify each asset, and say AMBIGUOUS where the isolation sweep cannot run.

    The sweep needs at least one constraint or baseline relation touching the asset
    inside the window, and raises when there is none. run_advisories.py never met that
    case because it runs on three windows chosen by hand; a replay walking every day of
    every era meets it constantly -- a chiller that barely ran that spring has no
    energy balance to be violated, so there is nothing to reconcile a sensor bias
    against.

    That is not a failure to be swallowed, it is a finding: with no relations there is
    no hypothesis to test, so no sensor explanation can be formed OR rejected, and
    AMBIGUOUS is the honest word for it. The schema already allows the value. Assets
    are classified one at a time so that one asset with no relations does not cost the
    others their diagnosis.
    """
    out = {}
    for asset_id in sorted(asset_ids):
        if asset_id not in windows:
            continue
        try:
            out.update(classify_assets(conn, {asset_id}, degrading, windows))
        except IsolationError as error:
            observation, _reference = windows[asset_id]
            out[asset_id] = Diagnosis(
                asset_id=asset_id,
                window=(d(observation[0]), d(observation[1])),
                fault_class=AMBIGUOUS,
                subject=None,
                confidence="weak",
                reason=(
                    "no constraint or baseline relation touches this asset over this "
                    "window, so no single-sensor hypothesis could be formed or ruled "
                    "out and the class cannot be narrowed"
                ),
                evidence=Evidence(
                    violated=f"none available -- {error}",
                    single_sensor="not attempted: no relation to reconcile against",
                    localisation="not attempted",
                    feedback="not attempted",
                    quality="not attempted",
                    sparse="not attempted",
                ),
            )
    return out


def replay_era(
    conn: psycopg.Connection,
    graph,
    mapping,
    nodes,
    facts,
    economics,
    era: int,
    era_from: datetime,
    era_to: datetime,
    reference_mode: str,
    skip: set[datetime],
    limit_days: int | None,
    start_offset: int,
    dry_run: bool,
) -> tuple[int, int, float]:
    """Every day of one era, from its first to its last, oldest first."""
    t0 = time.perf_counter()
    readings = EraReadings(conn, PRELOAD, era_from, era_to + timedelta(days=1))
    load_s = time.perf_counter() - t0
    days = (era_to.date() - era_from.date()).days + 1 - start_offset
    if limit_days is not None:
        days = min(days, limit_days)
    print(f"\n  era {era}: {era_from:%Y-%m-%d} .. {era_to:%Y-%m-%d}, {days} days")
    print(f"    preloaded {readings.rows:,} rows in {load_s:.1f}s")

    written = 0
    skipped = 0
    started = time.perf_counter()
    # Progress is reported for every day including the ones that produce nothing.
    # Most days early in an era are healthy and leave the loop in milliseconds, and a
    # batch that only printed on the days it wrote would look hung for the first
    # twenty minutes of every era.
    def report(done: int, as_of: datetime, n_advisories: int) -> None:
        rate = (time.perf_counter() - started) / done
        if done % 10 == 0 or done == days:
            print(f"    {as_of:%Y-%m-%d}  {done:>4}/{days}  "
                  f"{n_advisories} advisories  {rate:5.1f}s/day  "
                  f"eta {(days - done) * rate / 60:5.1f} min")

    for done, offset in enumerate(range(start_offset, start_offset + days), start=1):
        as_of = era_from + timedelta(days=offset)

        if as_of in skip:
            skipped += 1
            report(done, as_of, 0)
            continue
        observation = (max(era_from, as_of - timedelta(days=WINDOW_DAYS)), as_of)
        if observation[1] <= observation[0]:
            report(done, as_of, 0)
            continue
        reference = reference_window(reference_mode, era_from, as_of, observation)
        if reference is None:
            skipped += 1
            report(done, as_of, 0)
            continue

        faults = collect(conn, graph, observation, readings)
        if not faults:
            report(done, as_of, 0)
            continue
        attributions = attribute(graph, mapping, faults)
        ranked = rank(faults, {}, attributions)

        degrading = {
            f.asset_id: f"{f.fault_id} is degrading, {f.detail}"
            for f in faults if f.source == "failure_mode"
        }
        windows = {
            f.asset_id: (
                (f"{observation[0]:%Y-%m-%d}", f"{observation[1]:%Y-%m-%d}"),
                (f"{reference[0]:%Y-%m-%d}", f"{reference[1]:%Y-%m-%d}"),
            )
            for f in faults
        }
        diagnoses = classify_or_ambiguous(
            conn, {f.asset_id for f in faults}, degrading, windows
        )

        advisories: list[Advisory] = []
        for entry in ranked:
            asset_id = entry.fault.asset_id
            if asset_id not in facts or asset_id not in diagnoses:
                continue
            diagnosis = diagnoses[asset_id]
            advisories.append(
                build(
                    conn=conn, graph=graph, nodes=nodes, mapping=mapping,
                    facts=facts, economics=economics, ranked=entry,
                    window=observation, reference=reference,
                    diagnosis_class=diagnosis.fault_class,
                    diagnosis_reason=diagnosis.reason,
                    diagnosis_subject=diagnosis.subject,
                    diagnosis_evidence=tuple(diagnosis.evidence.lines()[:3]),
                )
            )
        if not advisories:
            report(done, as_of, 0)
            continue
        ordered = queue(advisories)
        if not dry_run:
            written += write_snapshot(conn, ordered, datetime.now(UTC))
        report(done, as_of, len(ordered))

    return written, skipped, time.perf_counter() - t0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild the advisory queue once per day across every era."
    )
    parser.add_argument(
        "--reference", choices=("commissioning", "seasonal"), default="commissioning",
        help="which fault-free stretch each day's evidence is measured against",
    )
    parser.add_argument(
        "--limit-days", type=int, default=None,
        help="only the first N days of each era, for timing a batch before starting it",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="compute everything and write nothing",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="skip as-of dates that already have rows",
    )
    parser.add_argument(
        "--offset-days", type=int, default=0,
        help="start this many days into each era, for timing days that have faults open",
    )
    parser.add_argument(
        "--era", type=int, default=None, help="only this era",
    )
    args = parser.parse_args()

    graph, _ = load_merged_graph()
    mapping, _notes = node_to_asset_id(graph)
    nodes = nodes_by_asset(mapping)

    started = datetime.now(UTC)
    print(f"advisory replay, {WINDOW_DAYS}-day trailing window, "
          f"{args.reference} reference")
    if args.dry_run:
        print("DRY RUN — nothing will be written")

    with psycopg.connect(resolve_dsn()) as conn:
        conn.autocommit = True
        economics = site_economics(graph)
        facts = asset_facts(conn, graph, nodes)
        skip = already_written(conn) if args.resume else set()
        if skip:
            print(f"resuming: {len(skip)} as-of dates already present")

        total_written = 0
        total_skipped = 0
        for era, era_from, era_to in eras(conn):
            if args.era is not None and era != args.era:
                continue
            written, skipped, elapsed = replay_era(
                conn, graph, mapping, nodes, facts, economics,
                era, era_from, era_to, args.reference, skip,
                args.limit_days, args.offset_days, args.dry_run,
            )
            total_written += written
            total_skipped += skipped
            print(f"    era {era} done in {elapsed / 60:.1f} min, "
                  f"{written} rows written, {skipped} days skipped")

        rows = conn.execute("SELECT count(*) FROM app.advisories").fetchone()[0]
        days = conn.execute(
            "SELECT count(DISTINCT window_to) FROM app.advisories"
        ).fetchone()[0]

    print(f"\n{'=' * 70}")
    print(f"  rows written this run   {total_written:,}")
    print(f"  days skipped            {total_skipped:,}")
    print(f"  app.advisories now      {rows:,} rows across {days:,} distinct as-of dates")
    print(f"  elapsed                 {(datetime.now(UTC) - started).total_seconds() / 60:.1f} min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
