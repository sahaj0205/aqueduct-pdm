"""Evaluate the degradation indicator of every failure mode in the config table.

A machine does not simply "get worse". A chiller fouls its condenser, or loses
refrigerant charge, or slides in compressor efficiency, and those are three
different numbers reaching failure at three different values. Rolling them into
one score before measuring them separately throws away the only information that
says which repair to order.

Each mode is a row in app.failure_modes carrying a small arithmetic expression.
This module reads those rows, resolves them against the assets their Brick class
covers, evaluates them over a window, and reports how far each indicator has
travelled toward its failure threshold. NO FAILURE MODE IS DEFINED IN THIS FILE.
Adding one is an INSERT, which is the whole point of the table.

TWO SIGN CONVENTIONS MATTER AND ARE ENFORCED ELSEWHERE. Every indicator is
written so that larger is worse and zero is healthy, and every threshold is a
positive number reached from below. The health index in checkpoint 4.4 maps
indicator onto 0 to 100 and cannot do that if some modes count up and others
count down.

Run with `make modes`.
"""

from __future__ import annotations

import ast
import logging
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd
import psycopg

from analytics.baselines.fit import _taxonomy
from analytics.rules.registry import class_closure, to_uri

log = logging.getLogger("modes")

# Standing in for the asset being evaluated, so one row serves three chillers.
ASSET_TOKEN = "@asset"

# The only syntax an indicator may contain. Arithmetic over names and numbers:
# no calls, no attributes, no subscripts, no comparisons. Same whitelist as the
# constraint evaluator in checkpoint 3.5, and for the same reason -- these
# expressions come from a table this project controls, but they are still text
# being turned into executable code, and a whitelist that has to be widened
# deliberately is the difference between a config row and a foothold.
ARITHMETIC_NODES: tuple[type, ...] = (
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

# A gate is a yes-or-no question, so it may compare. Nothing else is added: still
# no calls and no attribute access. Keeping comparisons out of the indicator
# language and confined to the gate language is why applies_when is its own
# column rather than folded into the expression.
GATE_NODES: tuple[type, ...] = (
    *ARITHMETIC_NODES,
    ast.Compare,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.Eq,
    ast.NotEq,
    ast.BoolOp,
    ast.And,
    ast.Or,
)


class ModeError(RuntimeError):
    """A failure mode in the config table cannot be evaluated."""


# ---------------------------------------------------------------------------
# reading and parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FailureMode:
    """One row of app.failure_modes, as read."""

    mode_id: str
    brick_class: str
    mode_name: str
    indicator_expression: str | None
    applies_when: str | None
    failure_threshold: float
    indicator_unit: str
    threshold_rationale: str
    degradation_process: str = "wiener"

    @property
    def computable(self) -> bool:
        return self.indicator_expression is not None


@dataclass(frozen=True)
class Reference:
    """One {point:...} or {residual:...} an expression reads."""

    kind: str  # "point" or "residual"
    identifier: str


@dataclass(frozen=True)
class CompiledMode:
    """A failure mode resolved against one concrete asset and ready to evaluate."""

    mode: FailureMode
    asset_id: str
    references: tuple[Reference, ...]
    indicator: object  # compiled expression over _r0, _r1, ...
    gate: object | None


def load_failure_modes(conn: psycopg.Connection) -> list[FailureMode]:
    """Every failure mode the database declares, in a stable order."""
    rows = conn.execute(
        "SELECT mode_id, brick_class, mode_name, indicator_expression, applies_when, "
        "       failure_threshold, indicator_unit, threshold_rationale, "
        "       degradation_process "
        "  FROM app.failure_modes ORDER BY brick_class, mode_id"
    ).fetchall()
    return [FailureMode(*row) for row in rows]


def modes_for_class(modes: list[FailureMode], brick_class: str) -> list[FailureMode]:
    """Modes that apply to this Brick class or any class it is a kind of.

    Resolved through Brick's taxonomy, like the baseline catalogue and the rule
    registry, so a mode written against brick:Air_Handling_Unit reaches an asset
    the database records as brick:AHU.
    """
    ancestry = class_closure(_taxonomy(), to_uri(brick_class))
    return [m for m in modes if to_uri(m.brick_class) in ancestry]


def _substitute(expression: str, asset_id: str) -> tuple[str, list[Reference]]:
    """Replace every {kind:identifier} with a positional placeholder.

    Identifiers contain dots and hyphens so they cannot be Python names. Each
    braced reference becomes _rN and the mapping is returned alongside, which
    also fixes the order values have to be supplied in.
    """
    references: list[Reference] = []
    rendered = expression.replace(ASSET_TOKEN, asset_id)
    while "{" in rendered:
        start = rendered.index("{")
        end = rendered.index("}", start)
        body = rendered[start + 1 : end]
        if ":" not in body:
            raise ModeError(f"reference {body!r} must be point:... or residual:...")
        kind, identifier = body.split(":", 1)
        if kind not in ("point", "residual"):
            raise ModeError(f"unknown reference kind {kind!r} in {body!r}")
        reference = Reference(kind, identifier)
        if reference not in references:
            references.append(reference)
        rendered = (
            rendered[:start] + f"_r{references.index(reference)}" + rendered[end + 1 :]
        )
    return rendered, references


def _compile(expression: str, allowed: tuple[type, ...], label: str) -> object:
    tree = ast.parse(expression.strip(), mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise ModeError(
                f"{label}: contains {type(node).__name__}, which is not permitted"
            )
        if isinstance(node, ast.Name) and not node.id.startswith("_r"):
            raise ModeError(f"{label}: unexpected name {node.id!r}")
    return compile(tree, filename=f"<{label}>", mode="eval")


def compile_mode(mode: FailureMode, asset_id: str) -> CompiledMode:
    """Resolve one mode against one asset and compile both of its expressions.

    The indicator and the gate are substituted together so they share one
    reference list, which means a point named in both is loaded once.
    """
    if mode.indicator_expression is None:
        raise ModeError(f"{mode.mode_id}: no indicator expression")

    combined = mode.indicator_expression
    if mode.applies_when:
        # Substituted as one string so the reference numbering is shared, then
        # split back apart on a separator that cannot occur in arithmetic.
        combined = f"{mode.indicator_expression}\n@@\n{mode.applies_when}"
    rendered, references = _substitute(combined, asset_id)

    if mode.applies_when:
        indicator_src, gate_src = rendered.split("\n@@\n", 1)
    else:
        indicator_src, gate_src = rendered, None

    return CompiledMode(
        mode=mode,
        asset_id=asset_id,
        references=tuple(references),
        indicator=_compile(indicator_src, ARITHMETIC_NODES, f"{mode.mode_id} indicator"),
        gate=(
            None
            if gate_src is None
            else _compile(gate_src, GATE_NODES, f"{mode.mode_id} applies_when")
        ),
    )


# ---------------------------------------------------------------------------
# loading the values an expression reads
# ---------------------------------------------------------------------------


def load_references(
    conn: psycopg.Connection,
    references: tuple[Reference, ...],
    t_from: datetime,
    t_to: datetime,
) -> pd.DataFrame:
    """Every value the expressions need, aligned on one time index.

    Measurements and baseline residuals come from two tables with two shapes, so
    each is pivoted to one column per identifier and the two are joined on time.
    An outer join, so an instant carrying a measurement but no residual survives
    with a gap rather than disappearing -- the gap then propagates through the
    arithmetic to a missing indicator, which is the honest answer.
    """
    frames: list[pd.DataFrame] = []

    points = sorted({r.identifier for r in references if r.kind == "point"})
    if points:
        rows = conn.execute(
            "SELECT time, point_id, value_si FROM app.measurements "
            " WHERE point_id = ANY(%s) AND time >= %s AND time < %s",
            (points, t_from, t_to),
        ).fetchall()
        if rows:
            frame = pd.DataFrame(rows, columns=["time", "point_id", "value_si"])
            frames.append(
                frame.pivot_table(
                    index="time", columns="point_id", values="value_si", dropna=False
                ).rename(columns=lambda c: f"point:{c}")
            )

    residuals = sorted({r.identifier for r in references if r.kind == "residual"})
    if residuals:
        rows = conn.execute(
            "SELECT time, baseline_id, residual FROM app.residuals "
            " WHERE baseline_id = ANY(%s) AND time >= %s AND time < %s",
            (residuals, t_from, t_to),
        ).fetchall()
        if rows:
            frame = pd.DataFrame(rows, columns=["time", "baseline_id", "residual"])
            frames.append(
                frame.pivot_table(
                    index="time", columns="baseline_id", values="residual", dropna=False
                ).rename(columns=lambda c: f"residual:{c}")
            )

    if not frames:
        return pd.DataFrame()
    joined = frames[0]
    for extra in frames[1:]:
        joined = joined.join(extra, how="outer")
    return joined.sort_index()


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------


def evaluate(compiled: CompiledMode, values: pd.DataFrame) -> pd.Series:
    """The indicator series for one mode on one asset.

    Instants the gate excludes are dropped rather than set to zero. A cooling
    coil whose valve is modulating is not a coil with no leak; it is a coil whose
    leak cannot be seen right now, and recording zero would tell the trend
    downstream that the machine had recovered.
    """
    namespace: dict[str, np.ndarray] = {}
    for index, reference in enumerate(compiled.references):
        column = f"{reference.kind}:{reference.identifier}"
        if column not in values.columns:
            raise ModeError(
                f"{compiled.mode.mode_id} on {compiled.asset_id}: nothing stored "
                f"for {column}"
            )
        namespace[f"_r{index}"] = values[column].to_numpy(dtype=float)

    with np.errstate(divide="ignore", invalid="ignore"):
        indicator = np.asarray(
            eval(compiled.indicator, {"__builtins__": {}}, namespace), dtype=float
        )
        keep = np.isfinite(indicator)
        if compiled.gate is not None:
            gate = eval(compiled.gate, {"__builtins__": {}}, namespace)
            keep &= np.nan_to_num(np.asarray(gate, dtype=float), nan=0.0) > 0.5

    return pd.Series(indicator, index=values.index)[keep]


@dataclass(frozen=True)
class ModeSummary:
    """What one indicator did over one window."""

    mode_id: str
    asset_id: str
    samples: int
    median: float
    p95: float
    final: float  # median over the last tenth of the window
    threshold: float
    unit: str

    @property
    def fraction_of_threshold(self) -> float:
        return self.final / self.threshold if self.threshold else float("nan")


def summarise(compiled: CompiledMode, series: pd.Series) -> ModeSummary:
    """Reduce an indicator series to the few numbers worth comparing.

    `final` is the median over the last tenth of the window rather than the last
    value, because a single sample at the end of a run is noise and the question
    being asked is where the indicator has GOT to, not what it did last.
    """
    tail = series.tail(max(1, len(series) // 10))
    return ModeSummary(
        mode_id=compiled.mode.mode_id,
        asset_id=compiled.asset_id,
        samples=len(series),
        median=float(series.median()),
        p95=float(series.quantile(0.95)),
        final=float(tail.median()),
        threshold=compiled.mode.failure_threshold,
        unit=compiled.mode.indicator_unit,
    )


def indicators_for_asset(
    conn: psycopg.Connection,
    asset_id: str,
    brick_class: str,
    modes: list[FailureMode],
    t_from: datetime,
    t_to: datetime,
) -> tuple[dict[str, pd.Series], list[str]]:
    """Every computable indicator for one asset over one window.

    Modes that cannot be computed are returned as messages rather than raised, so
    one missing baseline does not take the rest of the asset's modes down with it.
    """
    applicable = modes_for_class(modes, brick_class)
    compiled: list[CompiledMode] = []
    skipped: list[str] = []
    for mode in applicable:
        if not mode.computable:
            skipped.append(f"{mode.mode_id}: declared, no indicator in this building")
            continue
        try:
            compiled.append(compile_mode(mode, asset_id))
        except ModeError as exc:
            skipped.append(str(exc))

    references = tuple({r for c in compiled for r in c.references})
    values = load_references(conn, references, t_from, t_to)
    if values.empty:
        return {}, skipped + [f"{asset_id}: nothing stored over this window"]

    series: dict[str, pd.Series] = {}
    for entry in compiled:
        try:
            series[entry.mode.mode_id] = evaluate(entry, values)
        except ModeError as exc:
            skipped.append(str(exc))
    return series, skipped
