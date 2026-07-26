"""Evaluate the physical constraints the semantic model declares.

Checkpoint 2.2 attached mvn:constrainedBy statements to the Brick graph, each
carrying an mvn:residualExpression: a piece of arithmetic over point identifiers
that ought to come out at zero if the building is obeying physics. This module
reads those expressions out of the graph, evaluates them against the measurements
and stores what is left over.

A rule and a residual answer different questions, and the difference is the point
of having both. A rule says a machine is behaving badly. A residual says a set of
readings cannot all be true at the same time, without yet saying which of them is
lying. That is exactly the input the sensor-versus-equipment discrimination in
Task 5 needs: a failed sensor breaks every constraint it appears in and leaves
every other one alone, while a failed machine drags whole groups of constraints
together.

NOTHING ABOUT THE PHYSICS LIVES HERE. The expressions, the points they read and
which assets they belong to are all in model/extensions.ttl. Adding a constraint
is a triple in the model, not a change to this file.

Run with `make residuals`.
"""

from __future__ import annotations

import argparse
import ast
import logging
import sys
import time
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd
import psycopg

from analytics.rules.readings import resolve_dsn
from model.graph import constraint_members
from model.loader import load_merged_graph, local_name, system_of

log = logging.getLogger("constraints")

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

# Spans to evaluate, matching the quality scorer so every residual has a scored
# input to go with it. Stated from the public layout of the ingestion manifests,
# never read from schema groundtruth.
DEFAULT_SPANS: tuple[tuple[str, str, str], ...] = (
    ("lbnl-fault-free", "2018-01-01T06:00:00+00:00", "2019-01-01T06:00:00+00:00"),
    ("scenario-era", "2036-01-01T00:00:00+00:00", "2040-01-01T00:00:00+00:00"),
)

# Which span the normalisation baseline is taken from. It has to be a period with
# no injected fault, or the scale would be inflated by the very deviations the
# normalised value is meant to expose.
BASELINE_SPAN = DEFAULT_SPANS[0]

# A constraint is only meaningful while its equipment is running. A mixing box
# that is switched off has no airflow, so its "mixed air temperature" is just the
# temperature of still air in a box and balances nothing. Each entry lists points
# that must all exceed their threshold for the instant to be evaluated.
#
# Chillers carry a power test as well as a status test because chiller-1's status
# point reads 1 for the entire year -- on its own it would never gate anything.
RUN_GATES: dict[str, tuple[tuple[str, float], ...]] = {
    "MixedAirBalance": (("ahu-1.sf_status", 0.5),),
    "CoilEnergyBalance": (("ahu-1.sf_status", 0.5),),
    "ChillerEnergyBalance_1": (("chiller-1.status", 0.5), ("chiller-1.power", 1000.0)),
    "ChillerEnergyBalance_2": (("chiller-2.status", 0.5), ("chiller-2.power", 1000.0)),
    "ChillerEnergyBalance_3": (("chiller-3.status", 0.5), ("chiller-3.power", 1000.0)),
}

# The unit each expression comes out in. Not declared in the model -- 2.2 gave the
# constraints expressions but no units -- so it is recorded here and reported
# alongside the raw residual so the number stays interpretable.
UNITS: dict[str, str] = {
    "MixedAirBalance": "degC",
    "CoilEnergyBalance": "degC",
    "ChillerEnergyBalance_1": "watt",
    "ChillerEnergyBalance_2": "watt",
    "ChillerEnergyBalance_3": "watt",
}

# Scaling from median absolute deviation to a standard-deviation equivalent for
# normally distributed data. Standard constant, not a tuning knob.
MAD_TO_SIGMA = 1.4826

# Floor on the estimated spread, so a constraint that happens to be almost
# perfectly satisfied across the baseline cannot produce enormous normalised
# values from rounding noise.
MIN_SCALE = 1e-9


# ---------------------------------------------------------------------------
# parsing the expressions
# ---------------------------------------------------------------------------

# The only syntax an expression may contain. Everything here is arithmetic over
# names and numbers; there are no calls, no attributes, no subscripts and no
# comparisons. The expressions come from a file this project controls, but they
# are still text being turned into executable code, and a whitelist that has to
# be widened deliberately is the difference between a data file and a foothold.
ALLOWED_NODES: tuple[type, ...] = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Pow,
    ast.USub,
    ast.UAdd,
)


class ConstraintError(RuntimeError):
    """Raised when an expression in the model cannot be evaluated safely."""


@dataclass(frozen=True)
class Constraint:
    """One constraint, ready to evaluate."""

    constraint_id: str
    label: str | None
    expression: str
    points: tuple[str, ...]  # point ids in the order they were substituted
    code: object  # compiled expression over _p0, _p1, ...
    unit: str
    gates: tuple[tuple[str, float], ...]


def parse_expression(constraint_id: str, expression: str) -> tuple[object, tuple[str, ...]]:
    """Turn "{a.b} - {c.d}" into compiled code over safe variable names.

    Point identifiers contain dots and hyphens, so they cannot be Python names.
    Each brace-delimited identifier is replaced by a positional placeholder and
    the mapping is returned alongside, which also fixes the order the values have
    to be supplied in.
    """
    points: list[str] = []
    rendered = expression
    while "{" in rendered:
        start = rendered.index("{")
        end = rendered.index("}", start)
        point_id = rendered[start + 1 : end]
        if point_id not in points:
            points.append(point_id)
        rendered = rendered[:start] + f"_p{points.index(point_id)}" + rendered[end + 1 :]

    tree = ast.parse(rendered.strip(), mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED_NODES):
            raise ConstraintError(
                f"{constraint_id}: residual expression contains "
                f"{type(node).__name__}, which is not arithmetic"
            )
        if isinstance(node, ast.Name) and not node.id.startswith("_p"):
            raise ConstraintError(f"{constraint_id}: unexpected name {node.id!r}")
    return compile(tree, filename=f"<{constraint_id}>", mode="eval"), tuple(points)


def manifest_column_to_point() -> dict[tuple[str, str], str]:
    """Map a (system, source CSV column) pair to the point id the loader gave it.

    The graph names its points after the columns of the file they came from; the
    database names them after the asset they belong to. This is the dictionary
    between the two, and it comes from the ingestion manifests, which are the one
    place that mapping is actually recorded.

    Keyed on the system as well as the column, because column names are only
    unique WITHIN a file. OA_TEMP appears in both datasets and means different
    things in each -- outdoor dry bulb on the air handler, and on the chiller
    plant a column that actually holds wet bulb, which the manifest un-swaps. A
    map keyed on the column alone silently resolves the air handler's outdoor air
    temperature to the chiller plant's wet bulb.
    """
    import yaml

    from model.loader import REPO_ROOT

    mapping: dict[tuple[str, str], str] = {}
    for system in ("sdahu", "chiller"):
        path = REPO_ROOT / "ingestion" / "manifests" / f"{system}.yaml"
        for point in yaml.safe_load(path.read_text())["points"]:
            mapping[(system, point["column"])] = point["point_id"]
    return mapping


def load_constraints() -> list[Constraint]:
    """Read every constraint out of the semantic model and prepare it."""
    graph, _ = load_merged_graph()
    column_to_point = manifest_column_to_point()
    out: list[Constraint] = []
    for row in constraint_members(graph):
        constraint_id = local_name(row.constraint)
        code, points = parse_expression(constraint_id, row.expression)

        # The model DECLARES member points as graph nodes and the expression
        # NAMES them as database point ids, which are two different naming
        # systems for the same sensors -- sdahu:MA_TEMP and ahu-1.ma_temp are one
        # thermometer. The manifests are what relate them, so the two sets are
        # translated before being compared. A genuine disagreement means the
        # model describes something other than what it computes.
        declared = {
            column_to_point.get((system_of(p), local_name(p)), local_name(p))
            for p in row.points
        }
        used = set(points)
        if declared != used:
            log.warning(
                "  %s: declared members not read %s; read but not declared %s",
                constraint_id,
                sorted(declared - used) or "-",
                sorted(used - declared) or "-",
            )
        out.append(
            Constraint(
                constraint_id=constraint_id,
                label=row.label,
                expression=row.expression,
                points=points,
                code=code,
                unit=UNITS.get(constraint_id, ""),
                gates=RUN_GATES.get(constraint_id, ()),
            )
        )
    return out


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------


def load_points(
    conn: psycopg.Connection, point_ids: list[str], t_from: datetime, t_to: datetime
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Values and quality scores for a named set of points over a window."""
    rows = conn.execute(
        "SELECT time, point_id, value_si, quality_score FROM app.measurements "
        " WHERE point_id = ANY(%s) AND time >= %s AND time < %s",
        (point_ids, t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.DataFrame(), pd.DataFrame()
    frame = pd.DataFrame(rows, columns=["time", "point_id", "value_si", "quality_score"])
    values = frame.pivot_table(
        index="time", columns="point_id", values="value_si", dropna=False
    ).sort_index()
    quality = frame.pivot_table(
        index="time", columns="point_id", values="quality_score", dropna=False
    ).sort_index()
    return values, quality


def evaluate(
    constraint: Constraint, values: pd.DataFrame, quality: pd.DataFrame
) -> pd.DataFrame:
    """Compute one constraint's residual at every instant in the frame.

    Returns the raw residual and the worst quality score among the inputs, with
    instants excluded by the run gate or missing an input dropped entirely -- a
    residual nobody can compute is absent, not zero.
    """
    missing = [p for p in constraint.points if p not in values.columns]
    if missing:
        raise ConstraintError(f"{constraint.constraint_id}: no readings for {missing}")

    namespace = {f"_p{i}": values[p].to_numpy() for i, p in enumerate(constraint.points)}
    with np.errstate(divide="ignore", invalid="ignore"):
        residual = eval(constraint.code, {"__builtins__": {}}, namespace)

    usable = np.isfinite(residual)
    for point_id in constraint.points:
        usable &= values[point_id].notna().to_numpy()
    for gate_point, threshold in constraint.gates:
        if gate_point not in values.columns:
            raise ConstraintError(
                f"{constraint.constraint_id}: run gate needs {gate_point}, which was not loaded"
            )
        usable &= (values[gate_point] > threshold).fillna(False).to_numpy()

    worst_quality = quality[list(constraint.points)].min(axis=1, skipna=False)

    return pd.DataFrame(
        {
            "time": values.index,
            "residual": residual,
            "input_quality": worst_quality.to_numpy(),
        }
    )[usable]


@dataclass(frozen=True)
class Baseline:
    """How a constraint behaves when nothing is wrong."""

    centre: float
    scale: float
    samples: int


def fit_baseline(residuals: pd.Series) -> Baseline:
    """Robust centre and spread of a constraint over fault-free operation.

    Median and median absolute deviation rather than mean and standard
    deviation. The fault-free run is fault-free by label, not by inspection -- it
    still contains startup transients and the occasional excursion -- and a
    single one of those would inflate a standard deviation enough to hide every
    real deviation measured against it afterwards.
    """
    clean = residuals.dropna()
    if clean.empty:
        return Baseline(0.0, MIN_SCALE, 0)
    centre = float(clean.median())
    mad = float((clean - centre).abs().median())
    return Baseline(centre, max(mad * MAD_TO_SIGMA, MIN_SCALE), len(clean))


def normalise(residuals: pd.Series, baseline: Baseline) -> pd.Series:
    """Restate a residual as robust standard deviations from fault-free centre."""
    return (residuals - baseline.centre) / baseline.scale


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------


def write_residuals(
    conn: psycopg.Connection,
    constraint: Constraint,
    frame: pd.DataFrame,
    t_from: datetime,
    t_to: datetime,
) -> tuple[int, int]:
    """Replace this constraint's residuals over this window.

    Deleted and rewritten rather than merged, like every other derived table in
    the project: these rows are a function of the measurements and the model, and
    a stale one describes a building that no longer exists.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM app.constraint_residuals "
            " WHERE constraint_id = %s AND time >= %s AND time < %s",
            (constraint.constraint_id, t_from, t_to),
        )
        removed = cur.rowcount
        with cur.copy(
            "COPY app.constraint_residuals "
            "  (time, constraint_id, residual, normalised, unit, input_quality) "
            "FROM STDIN (FORMAT BINARY)"
        ) as copy:
            copy.set_types(["timestamptz", "text", "float8", "float8", "text", "int2"])
            for stamp, residual, normalised, quality in frame.itertuples(
                index=False, name=None
            ):
                copy.write_row(
                    (
                        stamp,
                        constraint.constraint_id,
                        None if not np.isfinite(residual) else float(residual),
                        None if not np.isfinite(normalised) else float(normalised),
                        constraint.unit,
                        None if quality is None or not np.isfinite(quality) else int(quality),
                    )
                )
    return removed, len(frame)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate constraint residuals.")
    parser.add_argument("--from", dest="t_from")
    parser.add_argument("--to", dest="t_to")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    spans = (
        (("custom", args.t_from, args.t_to),) if args.t_from and args.t_to else DEFAULT_SPANS
    )
    constraints = load_constraints()
    log.info("%d constraints read from the semantic model", len(constraints))
    for c in constraints:
        log.info("  %-24s %d points, %s, gated on %s",
                 c.constraint_id, len(c.points), c.unit,
                 ", ".join(p for p, _ in c.gates) or "nothing")

    started = time.monotonic()
    with psycopg.connect(resolve_dsn()) as conn:
        # --- baselines, from fault-free operation only ---
        log.info("\nfitting baselines on %s", BASELINE_SPAN[0])
        baselines: dict[str, Baseline] = {}
        base_from = datetime.fromisoformat(BASELINE_SPAN[1])
        base_to = datetime.fromisoformat(BASELINE_SPAN[2])
        for constraint in constraints:
            needed = sorted({*constraint.points, *(p for p, _ in constraint.gates)})
            values, quality = load_points(conn, needed, base_from, base_to)
            if values.empty:
                baselines[constraint.constraint_id] = Baseline(0.0, MIN_SCALE, 0)
                continue
            frame = evaluate(constraint, values, quality)
            baseline = fit_baseline(frame["residual"])
            baselines[constraint.constraint_id] = baseline
            log.info(
                "  %-24s centre %+14.4f  scale %12.4f  from %7d samples  [%s]",
                constraint.constraint_id,
                baseline.centre,
                baseline.scale,
                baseline.samples,
                constraint.unit,
            )

        # --- evaluate and store every span ---
        total = 0
        for label, raw_from, raw_to in spans:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            log.info("\n%s\nspan %s   %s .. %s", "=" * 78, label, t_from.date(), t_to.date())
            for constraint in constraints:
                needed = sorted({*constraint.points, *(p for p, _ in constraint.gates)})
                values, quality = load_points(conn, needed, t_from, t_to)
                if values.empty:
                    log.info("  %-24s no readings", constraint.constraint_id)
                    continue
                frame = evaluate(constraint, values, quality)
                baseline = baselines[constraint.constraint_id]
                frame["normalised"] = normalise(frame["residual"], baseline)
                ordered = frame[["time", "residual", "normalised", "input_quality"]]
                _removed, written = write_residuals(conn, constraint, ordered, t_from, t_to)
                conn.commit()
                total += written
                log.info(
                    "  %-24s %7d rows  residual med %+12.4f  |normalised| p95 %7.2f",
                    constraint.constraint_id,
                    written,
                    frame["residual"].median(),
                    frame["normalised"].abs().quantile(0.95),
                )

    log.info("\n%s\nwrote %d residual rows in %.1f minutes",
             "=" * 78, total, (time.monotonic() - started) / 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
