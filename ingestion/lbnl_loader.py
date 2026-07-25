"""Load the LBNL FDD datasets into app.assets, app.points and app.measurements.

Everything specific to a dataset lives in the YAML manifests in
ingestion/manifests/. Adding a system, a sensor or a degradation scenario is a
manifest edit, not a change to this file.

Two transformations happen on the way in, both of them deliberate:

  1. Downsampling. The source is one sample per minute, which is 1.3 billion
     measurements across all 45 files. Each manifest names a resample interval
     (300 s) and a per-point aggregation.

  2. Trajectory stitching. No single LBNL run degrades over time -- each holds
     one fixed fault severity for a whole year. This loader splits a target
     year into consecutive windows and takes each window from a progressively
     worse severity file, starting from the fault-free run. The result is one
     continuous series per fault mode that starts healthy and gets worse, which
     is what the health and remaining-life layers need. Because every source
     file shares the same weather, the seasonal signal stays continuous across
     the joins.

Run with `make load`. Safe to re-run: each trajectory deletes its own time
window before writing it.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pint
import psycopg
import yaml
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = REPO_ROOT / "ingestion" / "manifests"

log = logging.getLogger("lbnl_loader")
_UREG = pint.UnitRegistry()


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------


def libpq_dsn(url: str) -> str:
    """Turn a SQLAlchemy-style URL into one libpq accepts.

    The .env file carries `postgresql+psycopg://...` so that SQLAlchemy in the
    API layer and psycopg here can share one variable. libpq rejects the
    `+psycopg` driver tag, so strip it.
    """
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def resolve_dsn() -> str:
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("APP_RW_DATABASE_URL")
    if not url:
        sys.exit(
            "APP_RW_DATABASE_URL is not set. Copy .env.example to .env and fill it in."
        )
    return libpq_dsn(url)


def load_manifest(path: Path) -> dict:
    manifest = yaml.safe_load(path.read_text())
    root = REPO_ROOT / manifest["source_root"]
    if not root.is_dir():
        sys.exit(f"{path.name}: source_root {root} does not exist. Download the dataset first.")
    manifest["_root"] = root
    manifest["_path"] = path
    return manifest


# --------------------------------------------------------------------------
# unit conversion
# --------------------------------------------------------------------------


def affine_conversion(unit_native: str, unit_si: str) -> tuple[float, float]:
    """Reduce a unit conversion to a multiply and an add.

    Every conversion this project needs is affine -- degF to degC has an
    offset, the rest are pure scalings. Asking pint for the converted value of
    two known inputs recovers the scale and the offset, after which 80 million
    values can be converted with one numpy multiply instead of 80 million pint
    calls. Two points 100 apart are used rather than 0 and 1 to keep the
    subtraction well conditioned.
    """
    at_0 = _UREG.Quantity(0.0, unit_native).to(unit_si).magnitude
    at_100 = _UREG.Quantity(100.0, unit_native).to(unit_si).magnitude
    return (at_100 - at_0) / 100.0, at_0


# --------------------------------------------------------------------------
# catalogue tables
# --------------------------------------------------------------------------


def upsert_assets(conn: psycopg.Connection, manifest: dict) -> int:
    rows = [
        (
            a["asset_id"],
            a["brick_class"],
            a["name"],
            a["criticality_tier"],
            a.get("replacement_cost_usd"),
            a.get("install_date"),
        )
        for a in manifest["assets"]
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO app.assets (asset_id, brick_class, name, criticality_tier,
                                    replacement_cost_usd, install_date)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (asset_id) DO UPDATE SET
                brick_class          = EXCLUDED.brick_class,
                name                 = EXCLUDED.name,
                criticality_tier     = EXCLUDED.criticality_tier,
                replacement_cost_usd = EXCLUDED.replacement_cost_usd,
                install_date         = EXCLUDED.install_date
            """,
            rows,
        )
    return len(rows)


def upsert_points(conn: psycopg.Connection, manifest: dict) -> int:
    interval_s = manifest["timestamps"]["resample_interval_s"]
    rows = [
        (
            p["point_id"],
            p["asset_id"],
            p["brick_class"],
            p["name"],
            p["unit_native"],
            p["unit_si"],
            interval_s,
        )
        for p in manifest["points"]
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO app.points (point_id, asset_id, brick_class, name,
                                    unit_native, unit_si, sample_interval_s)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (point_id) DO UPDATE SET
                asset_id          = EXCLUDED.asset_id,
                brick_class       = EXCLUDED.brick_class,
                name              = EXCLUDED.name,
                unit_native       = EXCLUDED.unit_native,
                unit_si           = EXCLUDED.unit_si,
                sample_interval_s = EXCLUDED.sample_interval_s
            """,
            rows,
        )
    return len(rows)


# --------------------------------------------------------------------------
# reading source CSVs
# --------------------------------------------------------------------------


def segment_windows(
    start: date, span_days: int, count: int
) -> list[tuple[datetime, datetime]]:
    """Cut a span into `count` consecutive, non-overlapping windows.

    Each window will be filled from a different severity file, so the
    boundaries are where the fault steps worse. Remainder days are absorbed by
    the final window so the span is covered exactly.
    """
    origin = datetime(start.year, start.month, start.day)
    edges = [origin + timedelta(days=span_days * i // count) for i in range(count)]
    edges.append(origin + timedelta(days=span_days))
    return list(zip(edges[:-1], edges[1:]))


def read_segment(
    path: Path,
    ts_column: str,
    native_interval_s: int,
    columns: list[str],
    window: tuple[datetime, datetime],
) -> pd.DataFrame:
    """Read only the rows of one CSV that fall inside `window`.

    These files are 140 MB to 430 MB each and we want roughly a quarter of one.
    The timestamp grid is perfectly uniform, so the row offset of the window
    start is arithmetic: read the first data row to learn where the file
    begins, then skip directly to the offset instead of parsing and discarding
    everything before it. On the chiller files that is the difference between
    parsing 430 MB and parsing 110 MB.
    """
    t_from, t_to = window
    head = pd.read_csv(path, usecols=[ts_column], nrows=1, parse_dates=[ts_column])
    file_start = head[ts_column].iloc[0].to_pydatetime()

    step = timedelta(seconds=native_interval_s)
    skip = max(0, int((t_from - file_start) / step))
    span = int((t_to - max(t_from, file_start)) / step)
    if span <= 0:
        return pd.DataFrame(columns=[ts_column, *columns])

    frame = pd.read_csv(
        path,
        usecols=[ts_column, *columns],
        skiprows=range(1, 1 + skip),
        nrows=span,
        parse_dates=[ts_column],
    )
    # The arithmetic above assumes a gapless grid; filter anyway so a file that
    # violates that assumption produces short output rather than wrong output.
    return frame[(frame[ts_column] >= t_from) & (frame[ts_column] < t_to)]


def resample_segment(
    frame: pd.DataFrame, points: list[dict], ts_column: str, interval_s: int
) -> pd.DataFrame:
    """Collapse one-minute rows into `interval_s` buckets.

    Analog points take the mean of the bucket. On/off statuses and the
    occupancy flag take the last value instead: averaging a 0/1 status over
    five minutes yields things like 0.4, which is not a state the point is ever
    in and would break any rule testing `status = 1`.
    """
    how = {p["column"]: p.get("resample", "mean") for p in points if p["column"] in frame}
    indexed = frame.set_index(ts_column).sort_index()
    return indexed.resample(f"{interval_s}s", label="left", closed="left").agg(how)


# --------------------------------------------------------------------------
# writing measurements
# --------------------------------------------------------------------------

COPY_SQL = "COPY app.measurements (time, point_id, value_si) FROM STDIN (FORMAT BINARY)"


def write_segment(
    conn: psycopg.Connection,
    frame: pd.DataFrame,
    points: list[dict],
    utc_offset_hours: int,
    time_shift: timedelta,
) -> int:
    """Convert units, move the timestamps, and stream the result into the hypertable.

    The source timestamps are naive. Simulation output has no daylight saving
    step, so they are stamped with a fixed offset rather than a named zone --
    a named zone would make the spring-forward hour non-existent and the
    autumn hour ambiguous, and both would raise. `time_shift` moves the
    segment from the source year into the year this trajectory occupies.
    """
    if frame.empty:
        return 0

    stamps = (
        frame.index
        + time_shift
    ).tz_localize(timezone(timedelta(hours=utc_offset_hours))).tz_convert("UTC")
    py_stamps = stamps.to_pydatetime()

    written = 0
    with conn.cursor() as cur, cur.copy(COPY_SQL) as copy:
        copy.set_types(["timestamptz", "text", "float8"])
        for point in points:
            column = point["column"]
            if column not in frame:
                continue
            scale, offset = affine_conversion(point["unit_native"], point["unit_si"])
            values = frame[column].to_numpy(dtype="float64") * scale + offset
            point_id = point["point_id"]
            if pd.isna(values).any():
                for stamp, value in zip(py_stamps, values):
                    copy.write_row(
                        (stamp, point_id, None if value != value else value)
                    )
            else:
                for stamp, value in zip(py_stamps, values):
                    copy.write_row((stamp, point_id, value))
            written += len(values)
    return written


def load_trajectory(
    conn: psycopg.Connection, manifest: dict, trajectory: dict, index: int
) -> int:
    """Build and store one degradation trajectory.

    A trajectory occupies its own span of simulated time so that trajectories
    never collide on (point_id, time). Successive trajectories are shifted by
    whole 365-day blocks, which keeps the timestamp grid gapless and holds the
    seasons in place to within a couple of days.
    """
    ts_cfg = manifest["timestamps"]
    ts_column = ts_cfg["column"]
    points = manifest["points"]
    columns = [p["column"] for p in points]
    span_days = manifest["trajectory_span_days"]
    origin = date.fromisoformat(str(manifest["trajectory_start_date"]))
    shift = timedelta(days=span_days * index)

    segments = trajectory["segments"]
    windows = segment_windows(origin, span_days, len(segments))
    point_ids = [p["point_id"] for p in points]

    started = time.monotonic()
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM app.measurements
                 WHERE point_id = ANY(%s) AND time >= %s AND time < %s
                """,
                (
                    point_ids,
                    _stamp(origin, shift, ts_cfg["source_utc_offset_hours"]),
                    _stamp(
                        origin + timedelta(days=span_days),
                        shift,
                        ts_cfg["source_utc_offset_hours"],
                    ),
                ),
            )
            removed = cur.rowcount

        total = 0
        for segment, window in zip(segments, windows):
            path = manifest["_root"] / segment["file"]
            frame = read_segment(
                path, ts_column, ts_cfg["native_interval_s"], columns, window
            )
            if frame.empty:
                log.warning(
                    "  %s: segment %s produced no rows for %s..%s",
                    trajectory["trajectory_id"],
                    segment["file"],
                    window[0].date(),
                    window[1].date(),
                )
                continue
            buckets = resample_segment(frame, points, ts_column, ts_cfg["resample_interval_s"])
            total += write_segment(
                conn, buckets, points, ts_cfg["source_utc_offset_hours"], shift
            )
            log.info(
                "  %-40s %-46s %s -> %s  %8d rows",
                trajectory["trajectory_id"],
                segment["file"],
                (window[0] + shift).date(),
                (window[1] + shift).date(),
                len(buckets) * len(points),
            )

    log.info(
        "  %-40s DONE  %9d rows written, %d replaced, %.1fs",
        trajectory["trajectory_id"],
        total,
        removed,
        time.monotonic() - started,
    )
    return total


def _stamp(day: date, shift: timedelta, utc_offset_hours: int) -> datetime:
    naive = datetime(day.year, day.month, day.day) + shift
    return naive.replace(tzinfo=timezone(timedelta(hours=utc_offset_hours)))


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def load_system(conn: psycopg.Connection, manifest: dict) -> int:
    log.info("=" * 78)
    log.info("%s  (%s)", manifest["display_name"], manifest["_path"].name)
    log.info(
        "  %d assets, %d points, %d trajectories, resampled to %ds",
        len(manifest["assets"]),
        len(manifest["points"]),
        len(manifest["trajectories"]),
        manifest["timestamps"]["resample_interval_s"],
    )
    n_assets = upsert_assets(conn, manifest)
    n_points = upsert_points(conn, manifest)
    conn.commit()
    log.info("  catalogue: %d assets, %d points upserted", n_assets, n_points)

    total = 0
    for index, trajectory in enumerate(manifest["trajectories"]):
        total += load_trajectory(conn, manifest, trajectory, index)
    log.info("  %s total: %d measurement rows", manifest["system"], total)
    return total


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    manifests = sorted(MANIFEST_DIR.glob("*.yaml"))
    if not manifests:
        sys.exit(f"no manifests found in {MANIFEST_DIR}")

    started = time.monotonic()
    grand_total = 0
    with psycopg.connect(resolve_dsn()) as conn:
        for path in manifests:
            grand_total += load_system(conn, load_manifest(path))
    log.info("=" * 78)
    log.info(
        "loaded %d measurement rows from %d manifests in %.1f minutes",
        grand_total,
        len(manifests),
        (time.monotonic() - started) / 60,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
