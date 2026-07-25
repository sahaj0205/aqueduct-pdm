"""Score every reading for trustworthiness, and report broken instruments.

Everything downstream of this file -- the rule engine, the baselines, the health
index, the remaining-life estimate -- treats a number in app.measurements as a
fact about a machine. That is only safe if something has already asked whether
the number can be believed. This module is that something.

Each reading gets five scores from 0 to 100, over a trailing window:

    timeliness    did samples arrive at the cadence app.points declares?
    completeness  of the samples that arrived, how many carried a value?
    range         was the value inside the physically possible envelope?
    plausibility  did it change faster than the physics allows?
    staleness     did it move at all, when it should have?

The composite written to app.measurements.quality_score is the MINIMUM of the
five, not their mean. A reading that is timely, complete, smooth and moving but
physically impossible is not 80% trustworthy; it is worthless. Averaging would
score it 80 and sail past the rule engine's quality gate, which is the exact
failure this layer exists to prevent.

Every window is TRAILING -- the score at time t uses only data at or before t.
The rule engine consumes these scores, and a rule that fires at t on evidence
that includes t+1 cannot be run in production.

Findings about instruments go to app.sensor_advisories, as episodes rather than
per-sample rows. That table says a sensor is broken. It never says a machine is
broken; distinguishing those two is the whole point of the separation.

Run with `make quality`. Safe to re-run: each span replaces its own scores and
its own advisories.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import yaml
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
BOUNDS_PATH = REPO_ROOT / "ingestion" / "manifests" / "point_bounds.yaml"

log = logging.getLogger("quality")


# --------------------------------------------------------------------------
# tuning constants
# --------------------------------------------------------------------------

# Trailing window for timeliness, completeness, range and plausibility. All four
# are per-sample properties, so the window only sets how long one bad sample
# keeps depressing the score. Three hours is long enough that a single glitch is
# still visible when an operator looks, and short enough that the score recovers
# within a shift once the sensor does.
SHORT_WINDOW_MINUTES = 180

# Trailing window for staleness. Far longer, because "has not moved" is only
# suspicious over a long stretch: measured on the fault-free year, 50% of
# three-hour windows on the secondary chilled water supply temperature are
# perfectly flat during normal operation, against 28% of day-long ones. A
# three-hour flatline test on this building would be almost all false alarms.
STALE_WINDOW_MINUTES = 1440

# A condition must hold this long before it becomes an advisory. Six consecutive
# samples at the 300 s cadence. Below this, one noisy sample raises a ticket.
ADVISORY_MIN_MINUTES = 30

# Staleness score below which a still-moving sensor is called stale. 40 means the
# reading moved less than 40% of the minimum movement its class expects.
STALE_ADVISORY_BELOW = 40

# How much of the staleness window must have been spent running before the window
# can be judged. Staleness looks only at the samples taken while the equipment
# was actually on, so this is the minimum evidence needed to call a reading dead.
#
# 0.25 of a day-long window is six hours of running. It is set low deliberately:
# the air handler shuts down every night, so an earlier version of this gate that
# required the asset to run for the WHOLE window never scored a single AHU point
# in a year -- no 24-hour window ever qualified, and the two dead points the
# manifest already documents went unreported.
MIN_LIVE_FRACTION = 0.25

# A gap larger than this starts a new run rather than counting as a dropout.
# Trajectories and scenarios occupy separate eras of simulated time with months
# of nothing in between; that emptiness is how the data is laid out, not a sensor
# that stopped reporting. Anything shorter is a real hole inside a run.
RUN_GAP_HOURS = 24

# Slack around a bound, as a fraction of the envelope width. Used for two things
# that are really the same question -- is this value at, or past, the end of its
# scale, allowing for floating point noise?
#
# It is needed because zero-bounded quantities in this dataset arrive fractionally
# below zero: the return fan reports -2.2e-16 W when it is off, the return air
# flow -1.9e-07 m3/s. Those are zero. Without the slack, every one of them is a
# range violation, and the first run of this scorer raised 3,223 out-of-range
# samples on a fan that was simply switched off.
#
# 1e-6 of the envelope is a millionth of the way past a bound -- far too small to
# swallow a real excursion, since a genuinely broken sensor reads -999 or 32767,
# not minus one ten-millionth.
BOUND_TOLERANCE_FRACTION = 1e-6

# Spans scored by default, and why each one.
#
# Neither is read from schema groundtruth -- this module connects as app_rw and
# cannot. They are stated here from the public layout of the ingestion manifests:
# each trajectory occupies a 365-day era, index 0 first, and the synthesised
# scenarios follow from 2036 onwards.
DEFAULT_SPANS: tuple[tuple[str, str, str], ...] = (
    # Trajectory index 0 of both manifests, which is the LBNL fault-free run.
    # This is the false-positive bed: anything flagged here is flagged on data
    # with no injected fault at all.
    ("lbnl-fault-free", "2018-01-01T06:00:00+00:00", "2019-01-01T06:00:00+00:00"),
    # Everything the trajectory synthesiser wrote. The rule engine, health index
    # and remaining-life estimate all run over these.
    ("scenario-era", "2036-01-01T00:00:00+00:00", "2040-01-01T00:00:00+00:00"),
)

DIMENSIONS = ("timeliness", "completeness", "range", "plausibility", "staleness")


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Bounds:
    """The effective envelope for one point, after overrides are merged in."""

    point_id: str
    asset_id: str
    brick_class: str
    unit_si: str
    interval_s: int
    expected_min: float | None
    expected_max: float | None
    max_roc_per_min: float | None
    flatline_epsilon: float | None
    score_staleness: bool


@dataclass(frozen=True)
class PointScores:
    """The five dimensions for one point over one run, plus the evidence.

    The evidence fields are the per-sample conditions the advisory extractor
    needs. They are returned alongside rather than recomputed, because deriving
    an advisory from the rolling score would stretch every episode by the length
    of the window.
    """

    frame: pd.DataFrame
    values: pd.Series
    present: pd.Series
    out_of_range: pd.Series
    staleness_scored: pd.Series
    spread: pd.Series


class QualityConfigError(RuntimeError):
    """Raised when the bounds file and the point catalogue disagree."""


def libpq_dsn(url: str) -> str:
    """Strip SQLAlchemy's driver tag so psycopg accepts the URL."""
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def resolve_dsn() -> str:
    """Connect as the restricted role. Never the admin one.

    This module is part of the detection path, so it must be unable to read
    schema groundtruth. Using APP_RW_DATABASE_URL is what makes that a property
    the database enforces rather than a promise this file makes.
    """
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("APP_RW_DATABASE_URL")
    if not url:
        sys.exit("APP_RW_DATABASE_URL is not set. Copy .env.example to .env.")
    return libpq_dsn(url)


def load_catalogue(conn: psycopg.Connection) -> list[tuple]:
    """Read every point with its asset, class, unit and expected cadence."""
    return conn.execute(
        "SELECT point_id, asset_id, brick_class, unit_si, sample_interval_s "
        "FROM app.points ORDER BY asset_id, point_id"
    ).fetchall()


def resolve_bounds(catalogue: list[tuple]) -> tuple[dict[str, Bounds], dict[str, str]]:
    """Merge the class defaults with the per-point overrides for every point.

    Raises rather than guessing in four cases, all of which mean the bounds file
    and the database have drifted apart: a point whose Brick class has no entry,
    an override naming a point that does not exist, a run_state naming one that
    does not exist, and a Brick class used with two different SI units. The last
    matters because every number in the bounds file is written in one unit -- if
    a class carried both degC and degF, `expected_max: 60` would silently mean
    two different temperatures.
    """
    config = yaml.safe_load(BOUNDS_PATH.read_text())
    defaults = config["defaults"]
    overrides = config.get("overrides") or {}
    run_state: dict[str, str] = config.get("run_state") or {}

    known = {row[0] for row in catalogue}
    unknown_override = sorted(set(overrides) - known)
    if unknown_override:
        raise QualityConfigError(
            f"{BOUNDS_PATH.name} overrides points not in app.points: {unknown_override}"
        )
    unknown_run = sorted(set(run_state.values()) - known)
    if unknown_run:
        raise QualityConfigError(
            f"{BOUNDS_PATH.name} run_state names points not in app.points: {unknown_run}"
        )

    units_per_class: dict[str, set[str]] = {}
    for _, _, brick_class, unit_si, _ in catalogue:
        units_per_class.setdefault(brick_class, set()).add(unit_si)
    mixed = {k: sorted(v) for k, v in units_per_class.items() if len(v) > 1}
    if mixed:
        raise QualityConfigError(
            f"these Brick classes carry more than one SI unit, so class-keyed "
            f"bounds are ambiguous: {mixed}"
        )

    missing = sorted({row[2] for row in catalogue} - set(defaults))
    if missing:
        raise QualityConfigError(
            f"{BOUNDS_PATH.name} has no defaults for these Brick classes: {missing}"
        )

    resolved: dict[str, Bounds] = {}
    for point_id, asset_id, brick_class, unit_si, interval_s in catalogue:
        merged = {**defaults[brick_class], **overrides.get(point_id, {})}
        resolved[point_id] = Bounds(
            point_id=point_id,
            asset_id=asset_id,
            brick_class=brick_class,
            unit_si=unit_si,
            interval_s=interval_s or 300,
            expected_min=merged.get("expected_min"),
            expected_max=merged.get("expected_max"),
            max_roc_per_min=merged.get("max_roc_per_min"),
            flatline_epsilon=merged.get("flatline_epsilon"),
            score_staleness=merged.get("staleness") == "score",
        )
    return resolved, run_state


def apply_bounds(conn: psycopg.Connection, bounds: dict[str, Bounds]) -> int:
    """Push the resolved envelope onto app.points.

    The catalogue is the interface every other layer reads, so the bounds have to
    live there and not only in this module's memory. The rule engine's cost
    estimates and the baseline fitter both need a point's plausible range without
    parsing a YAML file.
    """
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE app.points SET expected_min = %s, expected_max = %s, "
            "max_roc_per_min = %s WHERE point_id = %s",
            [
                (b.expected_min, b.expected_max, b.max_roc_per_min, b.point_id)
                for b in bounds.values()
            ],
        )
    conn.commit()
    return len(bounds)


# --------------------------------------------------------------------------
# loading one asset's readings
# --------------------------------------------------------------------------


def load_asset_frame(
    conn: psycopg.Connection, asset_id: str, t_from: datetime, t_to: datetime
) -> pd.DataFrame:
    """Every reading for one asset over one span, one column per point.

    Loaded per asset rather than per point because staleness needs the asset's
    run status alongside each reading, and pulling the whole asset at once means
    that status is already aligned on the same timestamps.
    """
    rows = conn.execute(
        "SELECT m.time, m.point_id, m.value_si "
        "  FROM app.measurements m JOIN app.points p USING (point_id) "
        " WHERE p.asset_id = %s AND m.time >= %s AND m.time < %s",
        (asset_id, t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.DataFrame()
    frame = pd.DataFrame(rows, columns=["time", "point_id", "value_si"])
    return frame.pivot_table(
        index="time", columns="point_id", values="value_si", dropna=False
    ).sort_index()


def split_runs(index: pd.DatetimeIndex) -> list[pd.DatetimeIndex]:
    """Cut a timestamp index wherever the data stops for longer than a day.

    Without this every era boundary would look like a sensor that went dark for
    eight months. Gaps shorter than the cut are left inside a run, which is what
    makes them detectable as dropouts.
    """
    if len(index) < 2:
        return []
    # Divide by a timedelta64 rather than by a hardcoded 1e9. psycopg hands back
    # microsecond-resolution timestamps and pandas keeps that resolution, so this
    # index is datetime64[us], not the datetime64[ns] that dividing raw integers
    # by a billion would assume. That assumption turned a 217-day gap into 18,749
    # seconds, no gap ever crossed the threshold, and the whole four-year scenario
    # era was treated as one continuous run.
    gaps = np.diff(index.to_numpy()) / np.timedelta64(1, "s")
    breaks = (np.flatnonzero(gaps > RUN_GAP_HOURS * 3600) + 1).tolist()
    runs = []
    for start, stop in zip([0, *breaks], [*breaks, len(index)]):
        piece = index[start:stop]
        # A run shorter than the staleness window cannot produce a staleness
        # score, but it can still be range- and rate-checked, so keep it.
        if len(piece) > 1:
            runs.append(piece)
    return runs


# --------------------------------------------------------------------------
# the five dimensions
# --------------------------------------------------------------------------


def score_point_run(
    values: pd.Series, present: pd.Series, running: pd.Series | None, bounds: Bounds
) -> PointScores:
    """Compute the five dimensions and the composite for one point over one run.

    `values` is already reindexed onto the run's complete expected grid, so a NaN
    means either the row was absent or it carried no value; `present` separates
    those two. Every rolling call is trailing and uses min_periods=1, so the
    first samples of a run are scored on what history exists rather than dropped.
    """
    interval_s = bounds.interval_s
    short_n = max(1, SHORT_WINDOW_MINUTES * 60 // interval_s)
    stale_n = max(1, STALE_WINDOW_MINUTES * 60 // interval_s)
    minutes_per_sample = interval_s / 60.0
    index = values.index

    has_value = values.notna() & present
    present_count = present.rolling(short_n, min_periods=1).sum()
    value_count = has_value.rolling(short_n, min_periods=1).sum()

    # 1. timeliness -- share of expected slots in the window that carried a row.
    timeliness = 100.0 * present.rolling(short_n, min_periods=1).mean()

    # 2. completeness -- of the rows that arrived, how many held a number.
    completeness = pd.Series(
        np.where(
            present_count.to_numpy() > 0,
            100.0 * value_count.to_numpy() / np.maximum(present_count.to_numpy(), 1.0),
            0.0,
        ),
        index=index,
    )

    # 3. range -- share of readings inside the physically possible envelope.
    if bounds.expected_min is None or bounds.expected_max is None:
        out_of_range = pd.Series(False, index=index)
        range_score = pd.Series(100.0, index=index)
    else:
        slack = BOUND_TOLERANCE_FRACTION * (bounds.expected_max - bounds.expected_min)
        in_range = has_value & values.between(
            bounds.expected_min - slack, bounds.expected_max + slack
        )
        out_of_range = has_value & ~in_range
        range_score = _share(in_range, value_count, short_n, index)

    # 4. plausibility -- share of readings whose step from the previous sample is
    #    within what thermal mass and actuator speed allow. The first sample of a
    #    run has no predecessor and is taken as plausible rather than penalised.
    if bounds.max_roc_per_min is None:
        plausibility = pd.Series(100.0, index=index)
    else:
        roc = values.diff().abs() / minutes_per_sample
        implausible = has_value & (roc > bounds.max_roc_per_min)
        plausibility = _share(has_value & ~implausible, value_count, short_n, index)

    # 5. staleness -- how far the reading moved across the long window, against
    #    the least a live sensor of this class should move. Gated in _staleness.
    scored, staleness, spread = _staleness(values, running, bounds, stale_n)

    frame = pd.DataFrame(
        {
            "timeliness": timeliness,
            "completeness": completeness,
            "range": range_score,
            "plausibility": plausibility,
            "staleness": staleness,
        },
        index=index,
    ).clip(0.0, 100.0)
    frame["composite"] = frame[list(DIMENSIONS)].min(axis=1)

    return PointScores(
        frame=frame,
        values=values,
        present=present,
        out_of_range=out_of_range,
        staleness_scored=scored,
        spread=spread,
    )


def _share(good: pd.Series, denominator: pd.Series, window: int, index) -> pd.Series:
    """Rolling percentage of good samples among those that carried a value."""
    numerator = good.rolling(window, min_periods=1).sum().to_numpy()
    denom = denominator.to_numpy()
    return pd.Series(
        np.where(denom > 0, 100.0 * numerator / np.maximum(denom, 1.0), 100.0), index=index
    )


def _staleness(
    values: pd.Series,
    running: pd.Series | None,
    bounds: Bounds,
    stale_n: int,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Score how much the reading moved, but only where flatness means something.

    The measurement is peak-to-peak movement across the window, taken over ONLY
    the samples where the owning asset was running. Everything else is masked out
    before the spread is computed, so an air handler that shuts down overnight is
    judged on its running hours rather than being credited with a flat night.
    Peak-to-peak is used rather than variance because it answers the question
    directly -- the reading moved by this much -- and a technician can compare it
    against the sensor's resolution without doing any statistics.

    Three gates, each covering a way a motionless reading can still be correct. A
    window failing any of them scores 100 and is recorded as not scored, so it can
    never raise an advisory:

      class     a setpoint, a command or an on/off state is meant to sit still.
      evidence  fewer than a quarter of the window's samples were taken while the
                asset ran, so there is not enough running behaviour to judge.
      rail      a reading parked at the end of its scale -- a closed damper at
                0.0, a stopped fan at 0 W -- is motionless for a physical reason.

    Returns the mask of windows actually scored, the score, and the spread.
    """
    index = values.index
    if not bounds.score_staleness or not bounds.flatline_epsilon:
        blank = pd.Series(np.nan, index=index)
        return pd.Series(False, index=index), pd.Series(100.0, index=index), blank

    # Keep only the readings taken while the asset was on. Masked samples become
    # NaN, and pandas' rolling max/min skip them, so the spread below is measured
    # across running time alone.
    live = values if running is None else values.where(running.fillna(0.0) >= 0.5)

    window_max = live.rolling(stale_n, min_periods=1).max()
    window_min = live.rolling(stale_n, min_periods=1).min()
    live_count = live.rolling(stale_n, min_periods=1).count()
    spread = window_max - window_min

    scored = live_count >= max(1.0, MIN_LIVE_FRACTION * stale_n)
    scored &= spread.notna()

    if bounds.expected_min is not None and bounds.expected_max is not None:
        tolerance = BOUND_TOLERANCE_FRACTION * (bounds.expected_max - bounds.expected_min)
        at_low = (window_max <= bounds.expected_min + tolerance).fillna(False)
        at_high = (window_min >= bounds.expected_max - tolerance).fillna(False)
        scored &= ~(at_low | at_high)

    ratio = (spread / bounds.flatline_epsilon).clip(0.0, 1.0)
    staleness = pd.Series(
        np.where(scored.to_numpy(), 100.0 * ratio.to_numpy(), 100.0), index=index
    )
    return scored, staleness, spread


# --------------------------------------------------------------------------
# advisories
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Advisory:
    point_id: str
    kind: str
    t_from: datetime
    t_to: datetime
    worst_score: int
    sample_count: int
    detail: dict


def _json_safe(detail: dict) -> dict:
    """Replace NaN and infinity with null.

    JSON has no NaN literal and Postgres rejects one inside jsonb. These appear
    honestly: an episode can cover a stretch where every row is absent, and the
    median of nothing is NaN. null records that the evidence was unavailable,
    which is true, rather than failing the whole write.
    """
    return {
        key: (None if isinstance(value, float) and not np.isfinite(value) else value)
        for key, value in detail.items()
    }


def _episodes(mask: pd.Series, min_samples: int) -> list[tuple[int, int]]:
    """Collapse a boolean series into contiguous runs of True, as index slices.

    An advisory is an episode, not a sample. A sensor dead for a month is one
    finding a technician acts on once, not 8,640 identical rows.
    """
    flags = mask.to_numpy(dtype=bool)
    if not flags.any():
        return []
    edges = np.diff(np.concatenate(([0], flags.astype(np.int8), [0])))
    starts = np.flatnonzero(edges == 1)
    stops = np.flatnonzero(edges == -1)
    return [(int(s), int(e)) for s, e in zip(starts, stops) if e - s >= min_samples]


def extract_advisories(scores: PointScores, bounds: Bounds) -> list[Advisory]:
    """Turn the per-sample failures into episode rows.

    Each kind is derived from the per-sample condition rather than the rolling
    score, so an episode covers when the sensor was actually misbehaving and not
    the three hours afterwards during which the window still remembers it.
    """
    interval_s = bounds.interval_s
    min_samples = max(1, ADVISORY_MIN_MINUTES * 60 // interval_s)
    index = scores.frame.index
    values = scores.values
    out: list[Advisory] = []

    def episode(kind: str, mask: pd.Series, dimension: str, detail_of) -> None:
        for start, stop in _episodes(mask, min_samples):
            window = slice(start, stop)
            worst = scores.frame[dimension].iloc[window].min()
            out.append(
                Advisory(
                    point_id=bounds.point_id,
                    kind=kind,
                    t_from=index[start].to_pydatetime(),
                    t_to=index[stop - 1].to_pydatetime(),
                    worst_score=0 if not np.isfinite(worst) else int(np.floor(worst)),
                    sample_count=int(stop - start),
                    detail=_json_safe(detail_of(window)),
                )
            )

    # dropout -- rows that never arrived, inside a run.
    missing = ~scores.present
    episode(
        "dropout",
        missing,
        "timeliness",
        lambda w: {
            "expected_interval_s": interval_s,
            "missing_samples": int(missing.iloc[w].sum()),
            "worst_timeliness": round(float(scores.frame["timeliness"].iloc[w].min()), 1),
        },
    )

    # out_of_range -- readings outside the physically possible envelope.
    def range_detail(w):
        seen = values.iloc[w]
        low, high = bounds.expected_min, bounds.expected_max
        excursion = max(
            float(low - seen.min()) if low is not None else 0.0,
            float(seen.max() - high) if high is not None else 0.0,
        )
        return {
            "unit_si": bounds.unit_si,
            "expected_min": low,
            "expected_max": high,
            "min_seen": round(float(seen.min()), 4),
            "max_seen": round(float(seen.max()), 4),
            "worst_excursion": round(excursion, 4),
        }

    episode("out_of_range", scores.out_of_range, "range", range_detail)

    # flatline and stale -- both from the staleness dimension, and only where it
    # was actually scored. flatline is the acute case: no movement whatsoever.
    staleness = scores.frame["staleness"]

    def stale_detail(w):
        return {
            "unit_si": bounds.unit_si,
            "window_minutes": STALE_WINDOW_MINUTES,
            "flatline_epsilon": bounds.flatline_epsilon,
            "min_spread": round(float(scores.spread.iloc[w].min()), 6),
            "stuck_near": round(float(values.iloc[w].median()), 4),
        }

    episode("flatline", scores.staleness_scored & (staleness <= 0.0), "staleness", stale_detail)
    episode(
        "stale",
        scores.staleness_scored & (staleness > 0.0) & (staleness < STALE_ADVISORY_BELOW),
        "staleness",
        stale_detail,
    )
    return out


# --------------------------------------------------------------------------
# writing back
# --------------------------------------------------------------------------


def write_scores(
    conn: psycopg.Connection, rows: list[tuple], t_from: datetime, t_to: datetime
) -> int:
    """Stream the composite and the failing dimensions onto app.measurements.

    Staged through a temporary table and applied with a single UPDATE ... FROM
    rather than a statement per row: at this volume the round trips dominate
    everything else. The staging column is text and cast on the way in, because
    binary COPY of jsonb would need every object adapted individually.

    THE TIME PREDICATE IS LOAD-BEARING. app.measurements is a hypertable split
    into 5,077 one-day chunks. Joining the staging table on (point_id, time)
    alone gives the planner nothing to exclude chunks by, so it plans an update
    across every chunk in the table -- all 130 million rows -- for the sake of
    268,000 of them. Measured: 296 s of execution on top of 37 s of planning.
    Repeating the span as an explicit range lets TimescaleDB discard all but the
    31 chunks involved, and the same update takes 7.8 s.

    quality_flags is left NULL wherever the composite is 100. A row with nothing
    wrong needs no explanation, and writing an all-100 object for every clean
    reading would add roughly a gigabyte of JSON that says nothing.
    """
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TEMP TABLE _q (time timestamptz, point_id text, "
            "score smallint, flags text) ON COMMIT DROP"
        )
        with cur.copy(
            "COPY _q (time, point_id, score, flags) FROM STDIN (FORMAT BINARY)"
        ) as copy:
            copy.set_types(["timestamptz", "text", "int2", "text"])
            for row in rows:
                copy.write_row(row)
        cur.execute("ANALYZE _q")
        cur.execute(
            "UPDATE app.measurements m "
            "   SET quality_score = q.score, quality_flags = q.flags::jsonb "
            "  FROM _q q "
            " WHERE m.point_id = q.point_id AND m.time = q.time "
            "   AND m.time >= %s AND m.time < %s",
            (t_from, t_to),
        )
        return cur.rowcount


def write_advisories(
    conn: psycopg.Connection,
    advisories: list[Advisory],
    point_ids: list[str],
    t_from: datetime,
    t_to: datetime,
) -> tuple[int, int]:
    """Replace the advisories for these points over this span.

    Deleted and rewritten rather than merged, for the same reason the asset edge
    cache is: these rows are derived, and a stale advisory pointing at a sensor
    that has since been fixed sends someone up a ladder for nothing.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM app.sensor_advisories "
            " WHERE point_id = ANY(%s) AND t_from >= %s AND t_from < %s",
            (point_ids, t_from, t_to),
        )
        removed = cur.rowcount
        cur.executemany(
            "INSERT INTO app.sensor_advisories "
            "  (point_id, kind, t_from, t_to, worst_score, sample_count, detail) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            [
                (
                    a.point_id,
                    a.kind,
                    a.t_from,
                    a.t_to,
                    a.worst_score,
                    a.sample_count,
                    json.dumps(a.detail),
                )
                for a in advisories
            ],
        )
    return removed, len(advisories)


def _flag_json(frame: pd.DataFrame) -> list[str | None]:
    """JSON for the dimensions below 100, or NULL when all five are at 100.

    Only the failing dimensions are listed, so the object both explains the
    composite and stays small enough to store on every row that has a problem.
    """
    rounded = frame[list(DIMENSIONS)].round().astype("int64").to_numpy()
    below = rounded < 100
    out: list[str | None] = []
    for row_value, row_below in zip(rounded, below):
        if not row_below.any():
            out.append(None)
            continue
        out.append(
            json.dumps(
                {
                    dimension: int(value)
                    for dimension, value, is_below in zip(DIMENSIONS, row_value, row_below)
                    if is_below
                }
            )
        )
    return out


# --------------------------------------------------------------------------
# driving one span
# --------------------------------------------------------------------------


def score_asset_span(
    conn: psycopg.Connection,
    asset_id: str,
    bounds: dict[str, Bounds],
    run_state: dict[str, str],
    t_from: datetime,
    t_to: datetime,
) -> tuple[int, list[Advisory]]:
    """Score every point on one asset over one span, and write the result."""
    frame = load_asset_frame(conn, asset_id, t_from, t_to)
    if frame.empty:
        return 0, []

    columns = [c for c in frame.columns if c in bounds]
    if not columns:
        return 0, []
    run_point = run_state.get(asset_id)
    interval_s = bounds[columns[0]].interval_s

    staged: list[tuple] = []
    advisories: list[Advisory] = []

    for run_index in split_runs(frame.index):
        grid = pd.date_range(
            run_index[0], run_index[-1], freq=f"{interval_s}s", tz=run_index.tz
        )
        block = frame.loc[run_index].reindex(grid)
        present = pd.Series(grid.isin(run_index), index=grid)
        running = block[run_point] if run_point in block.columns else None
        stamps = grid.to_pydatetime()
        keep = present.to_numpy()

        for point_id in columns:
            scores = score_point_run(block[point_id], present, running, bounds[point_id])
            advisories.extend(extract_advisories(scores, bounds[point_id]))

            composite = scores.frame["composite"].round().astype("int64").to_numpy()
            flags = _flag_json(scores.frame)
            staged.extend(
                (stamp, point_id, int(score), flag)
                # Rows that were never in the database cannot be updated.
                for stamp, score, flag, exists in zip(stamps, composite, flags, keep)
                if exists
            )

    with conn.transaction():
        updated = write_scores(conn, staged, t_from, t_to)
        write_advisories(conn, advisories, columns, t_from, t_to)
    # Commit per asset, not per run. The SELECT above has already opened an
    # implicit transaction, so conn.transaction() above nests inside it as a
    # savepoint and does not commit on its own -- without this the whole pass
    # would be one transaction, and the ON COMMIT DROP staging table would still
    # exist when the next asset tried to create it.
    conn.commit()
    return updated, advisories


def span_summary(
    conn: psycopg.Connection, assets: list[str], t_from: datetime, t_to: datetime
) -> tuple:
    """Read the composite distribution back out of the database.

    Deliberately measured from what was stored rather than from the scores still
    in memory. The two can differ -- the in-memory set includes grid slots that
    hold no row and so are never written -- and when they did differ, the summary
    printed 36.1 while the stored data was at 93.4. A verification number that is
    computed from the same objects it is meant to check will agree with itself
    whatever has gone wrong upstream.
    """
    return conn.execute(
        "SELECT count(*), avg(quality_score), "
        "       percentile_disc(0.01) WITHIN GROUP (ORDER BY quality_score), "
        "       percentile_disc(0.50) WITHIN GROUP (ORDER BY quality_score), "
        "       100.0 * count(*) FILTER (WHERE quality_score = 100) / count(*), "
        "       count(*) FILTER (WHERE quality_score IS NULL) "
        "  FROM app.measurements m JOIN app.points p USING (point_id) "
        " WHERE p.asset_id = ANY(%s) AND m.time >= %s AND m.time < %s",
        (assets, t_from, t_to),
    ).fetchone()


def main() -> int:
    parser = argparse.ArgumentParser(description="Score measurement quality.")
    parser.add_argument("--from", dest="t_from", help="ISO start, overrides the default spans")
    parser.add_argument("--to", dest="t_to", help="ISO end, overrides the default spans")
    parser.add_argument("--asset", action="append", help="limit to these assets")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    if bool(args.t_from) != bool(args.t_to):
        sys.exit("--from and --to must be given together")
    spans = (("custom", args.t_from, args.t_to),) if args.t_from else DEFAULT_SPANS

    started = time.monotonic()
    total_rows = 0
    total_advisories = 0

    with psycopg.connect(resolve_dsn()) as conn:
        catalogue = load_catalogue(conn)
        bounds, run_state = resolve_bounds(catalogue)
        log.info(
            "resolved bounds for %d points from %s", apply_bounds(conn, bounds), BOUNDS_PATH.name
        )
        assets = args.asset or sorted({b.asset_id for b in bounds.values()})

        for label, raw_from, raw_to in spans:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            log.info("=" * 78)
            log.info("span %s   %s .. %s", label, t_from.date(), t_to.date())
            span_started = time.monotonic()
            span_rows = 0

            for asset_id in assets:
                rows, advisories = score_asset_span(
                    conn, asset_id, bounds, run_state, t_from, t_to
                )
                span_rows += rows
                total_advisories += len(advisories)
                log.info(
                    "  %-14s %9d rows scored, %3d advisories", asset_id, rows, len(advisories)
                )

            total_rows += span_rows
            stored, mean, p01, p50, at_100, unscored = span_summary(
                conn, assets, t_from, t_to
            )
            if stored:
                log.info(
                    "  %d rows written in %.1f min   read back from the database: "
                    "%d rows, mean %.2f, p01 %d, p50 %d, %.2f%% at 100, %d unscored",
                    span_rows,
                    (time.monotonic() - span_started) / 60,
                    stored,
                    mean,
                    p01,
                    p50,
                    at_100,
                    unscored,
                )

    log.info("=" * 78)
    log.info(
        "scored %d rows and wrote %d advisories in %.1f minutes",
        total_rows,
        total_advisories,
        (time.monotonic() - started) / 60,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
