"""Turn LBNL's discrete fault severity levels into continuous degradation.

The source data has no degradation in it. Each faulted file holds one fixed
severity for a whole year, and the health and remaining-life layers both need
equipment that starts healthy and slides toward failure. This module builds that
slide, without inventing any measurements.

THE IDEA. At a given instant the faulted run and the fault-free run differ by
some amount -- call that the fault contribution. It is a real measured
difference between two real runs at the same instant, under the same weather and
the same control decisions. Everything except the fault cancels out of it. So a
trajectory can be built by taking the fault-free signal and adding a growing
fraction of that contribution:

    output(t) = faultfree(t) + blend(progress(t), contributions at t)

The weather and control variation in the output is therefore the genuine
variation of the fault-free run, unsmoothed and unmodelled. Only the fault's
magnitude is interpolated. That is what "interpolate the fault contribution, not
the whole signal" means, and it is what keeps every scenario honest: no value
here is generated from a model of how equipment degrades.

Run it directly to build and store every scenario:

    uv run python -m simulator.trajectory
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import yaml

from ingestion.lbnl_loader import (
    affine_conversion,
    load_manifest,
    read_segment,
    resample_segment,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
SCENARIO_DIR = REPO_ROOT / "simulator" / "scenarios"
MANIFEST_DIR = REPO_ROOT / "ingestion" / "manifests"

COPY_SQL = "COPY app.measurements (time, point_id, value_si) FROM STDIN (FORMAT BINARY)"

# How many control points shape the degradation rate over the active window.
# Enough that the rate visibly speeds up and slows down the way real fouling
# does, few enough that the curve stays smooth at plot scale rather than looking
# like noise. Every one is drawn from the scenario's seed.
RATE_KNOTS = 24

# Spread of the rate multiplier at each knot. 0.35 gives roughly a factor of two
# between the slowest and fastest stretches of a trajectory, which is visible
# without ever threatening monotonicity -- the draws are strictly positive, so
# the cumulative curve can flatten but never reverse.
RATE_LOG_SIGMA = 0.35


@dataclass(frozen=True)
class Scenario:
    """One scenario manifest, validated."""

    scenario_id: str
    system: str
    target_asset: str
    fault_mode: str
    description: str
    profile: str
    source_start: datetime
    span_days: int
    pre_onset_days: int
    duration_to_failure_days: int
    severity_ceiling: float
    seed: int
    onset: datetime
    baseline_file: str
    waypoints: tuple[dict, ...]
    degradation_indicator: str | None

    @property
    def is_fault_free(self) -> bool:
        return not self.waypoints

    @property
    def scenario_start(self) -> datetime:
        return self.onset - timedelta(days=self.pre_onset_days)

    @property
    def scenario_end(self) -> datetime:
        return self.scenario_start + timedelta(days=self.span_days)

    @property
    def failure(self) -> datetime:
        return self.onset + timedelta(days=self.duration_to_failure_days)

    @property
    def time_shift(self) -> timedelta:
        """Scenario time minus source time. A whole number of days by construction."""
        return self.scenario_start - self.source_start


class ScenarioError(RuntimeError):
    """A scenario manifest is missing, malformed, or internally inconsistent."""


def load_scenario(path: Path) -> Scenario:
    """Read and validate one scenario manifest.

    Validation is deliberately strict. A scenario that is silently wrong about
    when its fault starts would corrupt every accuracy number computed against
    it later, and nothing downstream would be able to tell.
    """
    raw = yaml.safe_load(path.read_text())
    try:
        scenario = Scenario(
            scenario_id=raw["scenario_id"],
            system=raw["system"],
            target_asset=raw["target_asset"],
            fault_mode=raw["fault_mode"],
            description=raw["description"].strip(),
            profile=raw["profile"],
            source_start=datetime.fromisoformat(raw["source_start"]),
            span_days=int(raw["span_days"]),
            pre_onset_days=int(raw["pre_onset_days"]),
            duration_to_failure_days=int(raw["duration_to_failure_days"]),
            severity_ceiling=float(raw["severity_ceiling"]),
            seed=int(raw["seed"]),
            onset=datetime.fromisoformat(raw["onset"]),
            baseline_file=raw["baseline_file"],
            waypoints=tuple(raw.get("waypoints") or ()),
            degradation_indicator=raw.get("degradation_indicator"),
        )
    except KeyError as exc:
        raise ScenarioError(f"{path.name} is missing required key {exc}") from exc

    if scenario.profile not in ("progressive", "step", "none"):
        raise ScenarioError(f"{path.name}: profile must be progressive, step or none")
    if not 0.0 < scenario.severity_ceiling <= 1.0 and not scenario.is_fault_free:
        raise ScenarioError(f"{path.name}: severity_ceiling must be in (0, 1]")
    if scenario.pre_onset_days <= 0:
        raise ScenarioError(
            f"{path.name}: pre_onset_days must be positive -- the baseline layer has to "
            "see healthy equipment before the fault starts, or it learns the fault as normal"
        )
    if scenario.pre_onset_days + scenario.duration_to_failure_days > scenario.span_days:
        raise ScenarioError(
            f"{path.name}: fault reaches failure at day "
            f"{scenario.pre_onset_days + scenario.duration_to_failure_days} but the span is "
            f"only {scenario.span_days} days"
        )
    if scenario.time_shift % timedelta(days=1) != timedelta(0):
        raise ScenarioError(
            f"{path.name}: scenario start is {scenario.time_shift} after the source start, "
            "which is not a whole number of days -- the shift must preserve time of day or "
            "the occupancy schedule lands at the wrong hour"
        )
    return scenario


def load_scenarios() -> list[Scenario]:
    """Every scenario manifest, ordered by the time it occupies."""
    paths = sorted(SCENARIO_DIR.glob("*.yaml"))
    if not paths:
        raise ScenarioError(f"No scenario manifests in {SCENARIO_DIR}")
    return sorted((load_scenario(p) for p in paths), key=lambda s: s.scenario_start)


def progress_curve(scenario: Scenario, index: pd.DatetimeIndex) -> np.ndarray:
    """How far along the path from healthy to failed the fault is, per timestamp.

    Zero before onset, one at failure and after. Between the two it climbs on an
    irregular but never-decreasing path: a set of positive rate multipliers is
    drawn from the scenario's seed, interpolated across the window, and
    accumulated. Because every multiplier is strictly positive the result can
    flatten but can never go backwards, which is the monotonicity the
    remaining-life maths assumes.

    A step fault ignores all of that and jumps straight to one at onset.
    """
    stamps = index.to_pydatetime()
    out = np.zeros(len(index), dtype="float64")
    if scenario.is_fault_free:
        return out

    after_onset = np.array([t >= scenario.onset for t in stamps])
    if scenario.profile == "step":
        out[after_onset] = 1.0
        return out

    active = np.array([scenario.onset <= t < scenario.failure for t in stamps])
    out[after_onset & ~active] = 1.0
    if not active.any():
        return out

    rng = np.random.default_rng(scenario.seed)
    knots = rng.lognormal(mean=0.0, sigma=RATE_LOG_SIGMA, size=RATE_KNOTS)
    n_active = int(active.sum())
    rates = np.interp(
        np.linspace(0.0, 1.0, n_active),
        np.linspace(0.0, 1.0, RATE_KNOTS),
        knots,
    )
    climb = np.cumsum(rates)
    out[active] = climb / climb[-1]
    return out


def blend_contributions(
    baseline: pd.DataFrame,
    faulted: list[pd.DataFrame],
    progress: np.ndarray,
    ceiling: float,
) -> pd.DataFrame:
    """Add a growing share of the measured fault contribution to the clean signal.

    `faulted` is ordered mildest first. The progress value is mapped onto that
    ladder, so progress 0 sits at the fault-free run, 0.5 halfway up, and 1.0 at
    the worst waypoint the ceiling allows. Between two rungs the two measured
    contributions are mixed in proportion.

    Every contribution is a difference between two real runs at the same instant,
    so weather, occupancy and control response cancel out of it and only the
    fault's effect remains. Adding it back onto the real fault-free signal is
    what preserves the variation that makes the output look like a building
    rather than like a curve.
    """
    n_levels = len(faulted)
    position = np.clip(progress * ceiling, 0.0, 1.0) * n_levels
    lower = np.floor(position).astype(int)
    lower = np.clip(lower, 0, n_levels - 1)
    frac = position - lower
    # At the very top of the ladder there is no rung above to mix with.
    at_ceiling = position >= n_levels
    frac[at_ceiling] = 1.0
    lower[at_ceiling] = n_levels - 1

    out = baseline.copy()
    for column in baseline.columns:
        base = baseline[column].to_numpy(dtype="float64")
        # Column 0 is the fault-free run, so its contribution is identically zero.
        ladder = np.zeros((len(base), n_levels + 1), dtype="float64")
        for level, frame in enumerate(faulted, start=1):
            ladder[:, level] = frame[column].to_numpy(dtype="float64") - base
        low = np.take_along_axis(ladder, lower[:, None], axis=1)[:, 0]
        high = np.take_along_axis(ladder, (lower + 1)[:, None], axis=1)[:, 0]
        out[column] = base + (1.0 - frac) * low + frac * high
    return out


def _read_window(scenario: Scenario, manifest: dict, filename: str) -> pd.DataFrame:
    """One file's rows for this scenario's source window, resampled."""
    timestamps = manifest["timestamps"]
    source_root = REPO_ROOT / manifest["source_root"]
    columns = [p["column"] for p in manifest["points"]]
    window = (
        scenario.source_start,
        scenario.source_start + timedelta(days=scenario.span_days),
    )
    frame = read_segment(
        source_root / filename,
        timestamps["column"],
        int(timestamps["native_interval_s"]),
        columns,
        window,
    )
    return resample_segment(
        frame, manifest["points"], timestamps["column"], int(timestamps["resample_interval_s"])
    )


def synthesise(scenario: Scenario, manifest: dict) -> tuple[pd.DataFrame, np.ndarray]:
    """Build one scenario's measurements, still in the source unit and source time.

    Returns the frame and the progress curve, so the caller can record where the
    fault actually reached without recomputing it.
    """
    baseline = _read_window(scenario, manifest, scenario.baseline_file)
    if baseline.empty:
        raise ScenarioError(f"{scenario.scenario_id}: baseline window is empty")

    scenario_index = baseline.index + scenario.time_shift
    progress = progress_curve(scenario, scenario_index)

    if scenario.is_fault_free:
        return baseline, progress

    faulted = []
    for waypoint in scenario.waypoints:
        frame = _read_window(scenario, manifest, waypoint["file"])
        if not frame.index.equals(baseline.index):
            raise ScenarioError(
                f"{scenario.scenario_id}: {waypoint['file']} does not share the baseline's "
                "timestamps, so the fault contribution would be a difference between "
                "different moments"
            )
        faulted.append(frame)

    # Two rungs holding identical data are not two rungs. LBNL publishes some
    # single runs under several severity names -- all four coi_leakage files are
    # the same bytes, and so are all four oa_bias files -- and a ladder built from
    # those would look like it had four levels while interpolating between a value
    # and itself. That produces a trajectory which appears to walk a ladder and in
    # fact jumps straight to full severity, with nothing to reveal it.
    for i in range(len(faulted) - 1):
        if faulted[i].equals(faulted[i + 1]):
            raise ScenarioError(
                f"{scenario.scenario_id}: waypoint levels {i + 1} and {i + 2} "
                f"({scenario.waypoints[i]['file']} and {scenario.waypoints[i + 1]['file']}) "
                "hold identical data over this window, so they are not distinct severities. "
                "Check the source files -- LBNL publishes some runs under several severity "
                "names -- and reduce the manifest to the levels that genuinely differ."
            )

    return blend_contributions(baseline, faulted, progress, scenario.severity_ceiling), progress


def write_measurements(
    conn: psycopg.Connection, scenario: Scenario, manifest: dict, frame: pd.DataFrame
) -> int:
    """Convert to SI, move into scenario time, and stream into the hypertable."""
    offset_hours = int(manifest["timestamps"]["source_utc_offset_hours"])
    stamps = (
        (frame.index + scenario.time_shift)
        .tz_localize(timezone(timedelta(hours=offset_hours)))
        .tz_convert("UTC")
    )
    py_stamps = stamps.to_pydatetime()

    written = 0
    with conn.cursor() as cur, cur.copy(COPY_SQL) as copy:
        copy.set_types(["timestamptz", "text", "float8"])
        for point in manifest["points"]:
            column = point["column"]
            if column not in frame:
                continue
            scale, offset = affine_conversion(point["unit_native"], point["unit_si"])
            values = frame[column].to_numpy(dtype="float64") * scale + offset
            point_id = point["point_id"]
            missing = np.isnan(values)
            for stamp, value, absent in zip(py_stamps, values, missing, strict=True):
                copy.write_row((stamp, point_id, None if absent else value))
            written += len(values)
    return written


def source_tz(manifest: dict) -> timezone:
    """The fixed offset the source timestamps are expressed in.

    A fixed offset rather than a named zone, for the reason recorded in the
    loader: simulation output has no daylight saving step, so a named zone would
    make the spring-forward hour non-existent and the autumn hour ambiguous.
    """
    return timezone(timedelta(hours=int(manifest["timestamps"]["source_utc_offset_hours"])))


def to_utc(naive: datetime, manifest: dict) -> datetime:
    """Read a naive scenario timestamp as source-local and convert it to UTC.

    Every timestamp in a scenario manifest is naive and means local time at the
    site, matching the source CSVs. The database stores UTC. Skipping this
    conversion does not fail loudly -- it silently shifts everything by the
    offset, which shows up as a fault contribution that is not zero before onset.
    """
    return naive.replace(tzinfo=source_tz(manifest)).astimezone(UTC)


def clear_span(conn: psycopg.Connection, scenario: Scenario, manifest: dict) -> int:
    """Delete anything already stored in this scenario's span, so reruns replace.

    Scoped to the points this system owns as well as the time range, because two
    scenarios on different systems may legitimately occupy the same span.
    """
    point_ids = [p["point_id"] for p in manifest["points"]]
    start = to_utc(scenario.scenario_start, manifest) - timedelta(days=1)
    end = to_utc(scenario.scenario_end, manifest) + timedelta(days=1)
    return conn.execute(
        "DELETE FROM app.measurements WHERE point_id = ANY(%s) AND time >= %s AND time < %s",
        (point_ids, start, end),
    ).rowcount


def record_groundtruth(conn: psycopg.Connection, scenario: Scenario, manifest: dict) -> None:
    """Write the answer key: what fault was injected, into what, and when.

    This is the only function in the project that writes schema groundtruth, and
    it runs on a different connection from everything else -- the privileged one.
    Every layer that detects, scores, baselines, predicts or diagnoses connects
    as a role with all access to this schema revoked, so none of them can read
    what is written here even by accident. That separation is the whole basis of
    the accuracy claim in AI_LOG.md D-02.
    """
    source_files = ", ".join([scenario.baseline_file] + [w["file"] for w in scenario.waypoints])
    conn.execute(
        """
        INSERT INTO groundtruth.scenarios
            (scenario_id, system, source_file, is_fault_free, t_start, t_end, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (scenario_id) DO UPDATE SET
            system = EXCLUDED.system, source_file = EXCLUDED.source_file,
            is_fault_free = EXCLUDED.is_fault_free, t_start = EXCLUDED.t_start,
            t_end = EXCLUDED.t_end, notes = EXCLUDED.notes
        """,
        (
            scenario.scenario_id,
            scenario.system,
            source_files,
            scenario.is_fault_free,
            to_utc(scenario.scenario_start, manifest),
            to_utc(scenario.scenario_end, manifest),
            scenario.description,
        ),
    )

    conn.execute(
        "DELETE FROM groundtruth.fault_events WHERE scenario_id = %s", (scenario.scenario_id,)
    )
    if scenario.is_fault_free:
        return

    top = scenario.waypoints[-1]
    conn.execute(
        """
        INSERT INTO groundtruth.fault_events
            (scenario_id, asset_id, fault_mode, severity_level, t_onset, t_failure, params)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            scenario.scenario_id,
            scenario.target_asset,
            scenario.fault_mode,
            str(top.get("label", top["file"])),
            to_utc(scenario.onset, manifest),
            to_utc(scenario.failure, manifest),
            psycopg.types.json.Jsonb(
                {
                    "profile": scenario.profile,
                    "severity_ceiling": scenario.severity_ceiling,
                    "duration_to_failure_days": scenario.duration_to_failure_days,
                    "seed": scenario.seed,
                    "waypoints": [
                        {"level": i, "file": w["file"], "label": w.get("label")}
                        for i, w in enumerate(scenario.waypoints, start=1)
                    ],
                }
            ),
        ),
    )


def _dsn(name: str) -> str:
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())
    url = os.environ.get(name)
    if not url:
        raise ScenarioError(f"{name} is not set -- see .env.example")
    return url.replace("postgresql+psycopg://", "postgresql://")


def build(scenario: Scenario, manifests: dict[str, dict]) -> tuple[int, int, np.ndarray]:
    """Synthesise one scenario, store its measurements, record its answer key."""
    manifest = manifests[scenario.system]
    frame, progress = synthesise(scenario, manifest)

    with psycopg.connect(_dsn("APP_RW_DATABASE_URL")) as conn, conn.transaction():
        removed = clear_span(conn, scenario, manifest)
        written = write_measurements(conn, scenario, manifest, frame)

    with psycopg.connect(_dsn("ADMIN_DATABASE_URL")) as admin, admin.transaction():
        record_groundtruth(admin, scenario, manifest)

    return written, removed, progress


def main() -> int:
    try:
        scenarios = load_scenarios()
    except ScenarioError as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 1

    manifests = {
        name: load_manifest(MANIFEST_DIR / f"{name}.yaml") for name in ("sdahu", "chiller")
    }

    print(f"{len(scenarios)} scenarios\n")
    print(f"  {'scenario':<30}{'asset':<14}{'onset':<12}{'to fail':>8}{'rows':>12}{'secs':>7}")
    total = 0
    for scenario in scenarios:
        started = datetime.now(UTC)
        written, _, progress = build(scenario, manifests)
        total += written
        elapsed = (datetime.now(UTC) - started).total_seconds()
        print(
            f"  {scenario.scenario_id:<30}{scenario.target_asset:<14}"
            f"{scenario.onset.date().isoformat():<12}"
            f"{scenario.duration_to_failure_days:>6}d{written:>12,}{elapsed:>7.1f}"
        )
        if not scenario.is_fault_free:
            reached = float(progress.max())
            if abs(reached - 1.0) > 1e-9:
                print(f"    WARNING: progress peaked at {reached:.6f}, not 1.0")

    print(f"\n  {total:,} rows written across {len(scenarios)} scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
