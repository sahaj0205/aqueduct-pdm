"""Ask which single sensor, if biased, would explain everything that looks wrong.

This is the reconciliation half of sensor-versus-equipment discrimination. The
idea is old and simple. Write down every relation between measurements that ought
to hold. Observe which of them stopped holding. Then ask: is there one sensor such
that assuming it reads consistently wrong makes all of them hold again? If yes,
that sensor is the suspect and the machine is probably fine. If no single sensor
does it, the measurements are telling the truth and the machine is not.

WHAT COUNTS AS A RELATION, AND WHY THERE ARE TWO KINDS

The obvious source is the physical constraints from checkpoint 3.5 -- mixed air
must sit between outdoor and return air, the coil cannot cool below its water
temperature. Those alone are not enough, and finding out why is most of the work
in this module.

Supply air temperature participates in exactly ONE of them, the coil energy
balance. A single relation containing a single suspect can always be reconciled by
biasing that suspect: one equation, one unknown, one solution, no way to be wrong.
So on the constraint set alone the supply air sensor is UNFALSIFIABLE, and both a
drifting supply air sensor and a leaking coil valve -- which present identically,
as supply air deviating from setpoint -- come out as "a sensor bias explains it".

The second source fixes that: the condition-normalised baselines from checkpoint
4.1 are relations too. A baseline says this point should read what these driver
points predict, so observed minus expected is a residual that ought to sit at zero
exactly like a constraint residual, and it is already stored that way. Supply air
temperature is the target of two of them, which takes it from one relation to
three and makes it falsifiable. Measured over these runs, that is what separates
the two faults:

    relation                              d/d(sa_temp)   drift    leak
    CoilEnergyBalance                          -1        -2.54   -0.24
    sa_temp.coil-effectiveness                 +1        +3.50   -0.10
    sa_temp.shut-valve-supply-air              +1        +2.07   -0.75

One bias of about +2.7 K reproduces all three drift figures, against a true
injected bias of +2.22 K. For the leak the three disagree in SIGN, so no single
number can produce them and the reconciliation fails -- which is the answer.

SENSITIVITIES ARE DIFFERENTIATED, NOT DERIVED BY HAND

How much a relation moves per unit of bias on a point is its partial derivative,
and these expressions are not all linear -- the coil balance multiplies valve
position by a temperature difference, so its sensitivity to mixed air temperature
depends on where the valve is. Rather than hand-deriving partials per constraint,
which would need redoing every time somebody edits the .ttl, each one is obtained
by nudging that point's values and re-evaluating the compiled expression. Central
differences, at every instant, averaged over the window: the linearisation about
the operating point the asset was actually at.

SPARSITY IS THE PREFERENCE, NOT A REGULARISER BOLTED ON

Two solves are run. An explicit sweep of every single-point hypothesis, which is
the sparsest correction possible -- exactly one non-zero -- and is what produces
the evidence a human reads. And a least-squares fit over all points at once with
an L1 penalty, to check whether the correction WANTS to concentrate on one point
or genuinely needs several. A fault needing several sensors to be simultaneously
wrong is not a sensor fault.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd
import psycopg

from analytics.rules.constraints import Constraint, load_constraints
from analytics.rules.constraints import load_points as load_constraint_points

log = logging.getLogger("diagnosis.isolation")

# How far a relation's mean has to move before it counts as violated, in units of
# its own spread during the reference period. Deliberately measured against the
# full spread of individual residuals rather than the standard error of the mean:
# with several thousand samples the standard error is a hundredth of a kelvin and
# every relation on every run would read as significantly violated. Requiring the
# mean to move by more than the noise it sits in means we only act on violations
# that would be visible in a plot. Measured over these runs this cleanly separates
# the drifting sensor at 2.1 from the leaking valve at 0.2.
MIN_SHIFT_SIGMA = 1.0

# Step for the numerical derivative, as a fraction of each point's own spread over
# the window. The expressions are polynomial, so central differences at this size
# are exact to many digits; the only reason not to go smaller is float precision.
DERIVATIVE_STEP_FRACTION = 1e-3

# Absolute floor on that step, for a point that does not move at all over the
# window. Without it a constant input would give a zero step and a divide by zero
# rather than the correct answer, which is that we cannot see its sensitivity.
MIN_DERIVATIVE_STEP = 1e-6

# A hypothesis is only falsifiable if the suspect appears in at least this many
# relations. With one, the bias has as many free parameters as equations and can
# always absorb whatever it sees. This is the number that made the difference
# between the two faults being distinguishable and not.
MIN_RELATIONS_TO_FALSIFY = 2

# A hypothesis has to remove at least this much of the total violation to count as
# an explanation at all. Without it, a point that moves nothing gets a bias of
# essentially zero, changes nothing, is trivially "consistent with every relation",
# and wins by default -- which is how the leaking valve first came out with mixed
# air temperature as its best suspect on the strength of explaining 0 percent.
MIN_EXPLAINED = 0.5

# Weight on the L1 penalty in the multi-point solve, relative to the norm of the
# violation being explained. Small enough that a genuine two-sensor fault would
# still be found, large enough that noise-level corrections are driven to exactly
# zero rather than left as a spray of tiny non-zeros.
SPARSITY_WEIGHT = 0.05

# Iterations of coordinate descent for that solve. The problem is a handful of
# variables and strictly convex apart from the kink at zero, so it converges in a
# few dozen; this is a generous cap, not a tuned value.
SPARSITY_ITERATIONS = 500


class IsolationError(RuntimeError):
    """The isolation problem cannot be posed over this window."""


# ---------------------------------------------------------------------------
# relations: constraints and baseline residuals, in one shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Relation:
    """One thing that ought to hold, and how far off it is.

    `sensitivity` maps a point id to how much this relation's residual moves per
    unit of bias on that point. A point the relation reads but whose sensitivity
    could not be established is listed in `opaque` instead, so it is visible as a
    gap rather than silently treated as having no effect.
    """

    relation_id: str
    kind: str  # "constraint" or "baseline"
    unit: str
    sensitivity: dict[str, float]
    reference_mean: float
    reference_sigma: float
    observed_mean: float
    samples: int
    opaque: tuple[str, ...] = ()

    @property
    def shift(self) -> float:
        """How far the residual's mean has moved since the reference period."""
        return self.observed_mean - self.reference_mean

    @property
    def shift_sigma(self) -> float:
        """That shift in units of the relation's own reference spread."""
        if self.reference_sigma <= 0:
            return 0.0
        return self.shift / self.reference_sigma

    @property
    def violated(self) -> bool:
        return abs(self.shift_sigma) >= MIN_SHIFT_SIGMA

    @property
    def points(self) -> tuple[str, ...]:
        return tuple(self.sensitivity)


def constraint_sensitivities(
    constraint: Constraint, values: pd.DataFrame
) -> dict[str, float]:
    """Mean partial derivative of a constraint residual w.r.t. each point it reads.

    Evaluates the compiled expression three times per point -- unperturbed is not
    needed, only plus and minus a step -- and averages the central difference over
    every instant in the window. Averaging rather than taking a single operating
    point matters for the coil balance, whose sensitivity to mixed air temperature
    is one minus the valve position and therefore changes through the day.
    """
    columns = [p for p in constraint.points if p in values.columns]
    if len(columns) != len(constraint.points):
        missing = set(constraint.points) - set(columns)
        raise IsolationError(f"{constraint.constraint_id}: no readings for {missing}")

    base = {
        f"_p{i}": values[p].to_numpy(dtype=float)
        for i, p in enumerate(constraint.points)
    }
    out: dict[str, float] = {}
    for index, point_id in enumerate(constraint.points):
        column = base[f"_p{index}"]
        spread = float(np.nanstd(column))
        step = max(spread * DERIVATIVE_STEP_FRACTION, MIN_DERIVATIVE_STEP)
        with np.errstate(divide="ignore", invalid="ignore"):
            up = dict(base, **{f"_p{index}": column + step})
            down = dict(base, **{f"_p{index}": column - step})
            high = np.asarray(eval(constraint.code, {"__builtins__": {}}, up), float)
            low = np.asarray(eval(constraint.code, {"__builtins__": {}}, down), float)
        slope = (high - low) / (2.0 * step)
        finite = np.isfinite(slope)
        # A point already counted once keeps the first sensitivity: a repeated
        # identifier in an expression is one variable, and summing would double it.
        if point_id not in out:
            out[point_id] = float(np.mean(slope[finite])) if finite.any() else 0.0
    return out


def constraint_relations(
    conn: psycopg.Connection,
    asset_ids: set[str],
    reference: tuple[datetime, datetime],
    window: tuple[datetime, datetime],
) -> list[Relation]:
    """Every stored constraint residual that touches these assets, as a Relation.

    Violation is always measured as a SHIFT against a reference window, never as a
    departure from zero. The constraints here deliberately do not close at zero --
    the chiller energy balance is documented as being out by about 99 kW because the
    source simulation's reported power disagrees with its own thermal terms -- so an
    absolute test would be meaningless.

    THE REFERENCE WINDOW MUST BE SEASON-MATCHED, and the caller is responsible for
    choosing one. It is emphatically NOT the commissioning window at the start of the
    same run, which is what this first did. The coil-leak run starts in late February
    and the fault is fully developed by May, so comparing the two put the mixed air
    balance out by -2.36 K, about two of its own sigmas, and every bit of that was
    the seasons changing: outdoor air is a term in that relation and February in
    Chicago does not resemble June. Season-matched against the fault-free run the
    same shift is +0.03 K. A diagnosis layer that mistakes spring for a fault will
    blame a sensor for the weather.
    """
    out: list[Relation] = []
    for constraint in load_constraints():
        touched = {p.split(".", 1)[0] for p in constraint.points}
        if not touched & asset_ids:
            continue

        stored = conn.execute(
            "SELECT time, residual FROM app.constraint_residuals "
            " WHERE constraint_id = %s "
            "   AND ((time >= %s AND time < %s) OR (time >= %s AND time < %s)) "
            " ORDER BY time",
            (constraint.constraint_id, reference[0], reference[1],
             window[0], window[1]),
        ).fetchall()
        if not stored:
            continue
        frame = pd.DataFrame(stored, columns=["time", "residual"]).set_index("time")
        ref = frame.loc[(frame.index >= reference[0]) & (frame.index < reference[1])]
        obs = frame.loc[(frame.index >= window[0]) & (frame.index < window[1])]
        if len(ref) < 2 or obs.empty:
            continue

        values, _quality = load_constraint_points(
            conn, list(constraint.points), window[0], window[1]
        )
        if values.empty:
            continue
        try:
            sensitivity = constraint_sensitivities(constraint, values)
        except IsolationError as exc:
            log.warning("%s", exc)
            continue

        out.append(
            Relation(
                relation_id=constraint.constraint_id,
                kind="constraint",
                unit=constraint.unit,
                sensitivity=sensitivity,
                reference_mean=float(ref["residual"].mean()),
                reference_sigma=float(ref["residual"].std(ddof=1)),
                observed_mean=float(obs["residual"].mean()),
                samples=len(obs),
            )
        )
    return out


def baseline_relations(
    conn: psycopg.Connection,
    asset_ids: set[str],
    reference: tuple[datetime, datetime],
    window: tuple[datetime, datetime],
) -> list[Relation]:
    """Every stored baseline residual for these assets, as a Relation.

    A baseline residual is observed minus expected for one point, so its derivative
    with respect to that point is exactly plus one -- no differentiation needed, and
    no fitted coefficients required to know it. That single fact is what makes this
    module work at all: it is where the extra relations on supply air temperature
    come from.

    The baseline's DRIVER points are recorded as opaque rather than differentiated.
    Their sensitivities are minus the derivative of the fitted prediction, which
    would mean refitting every baseline here to recover the coefficients. They are
    listed so the gap is visible: a bias on a driver cannot be tested through this
    relation, only through the physical constraints, and every driver in this model
    does appear in at least one of those.

    THE SPREAD IS NOT MEASURED OVER THE REFERENCE WINDOW, and that correction is
    the difference between this module working and not. A baseline's residual over
    its own commissioning window is an IN-SAMPLE fit error: those are the very
    points the coefficients were chosen to pass through, so the spread there is far
    smaller than the model's real accuracy. Using it made the drifting sensor's two
    baseline relations read as 12.7 and 12.0 of their own sigmas, and then a
    hypothesis that explained 95 percent of the violation was still rejected,
    because five percent of twelve sigma is three sigma. The honest scale is the
    baseline's own fitted residual spread, which checkpoint 4.1 already computed and
    divided the stored `normalised` column by; it is recovered here as the ratio of
    the two columns' spreads, which is exact because one is a linear transform of
    the other.
    """
    rows = conn.execute(
        "SELECT baseline_id, point_id, "
        "       avg(residual)     FILTER (WHERE time >= %s AND time < %s) AS ref_mean, "
        "       count(*)          FILTER (WHERE time >= %s AND time < %s) AS ref_n, "
        "       avg(residual)     FILTER (WHERE time >= %s AND time < %s) AS obs_mean, "
        "       count(*)          FILTER (WHERE time >= %s AND time < %s) AS obs_n, "
        "       stddev_samp(residual)   AS raw_sd, "
        "       stddev_samp(normalised) AS norm_sd "
        "  FROM app.residuals "
        " WHERE (time >= %s AND time < %s) OR (time >= %s AND time < %s) "
        " GROUP BY 1, 2",
        (
            reference[0], reference[1], reference[0], reference[1],
            window[0], window[1], window[0], window[1],
            reference[0], reference[1], window[0], window[1],
        ),
    ).fetchall()

    out: list[Relation] = []
    for bid, point_id, ref_mean, ref_n, obs_mean, obs_n, raw_sd, norm_sd in rows:
        if point_id.split(".", 1)[0] not in asset_ids:
            continue
        if not ref_n or ref_n < 2 or not obs_n or raw_sd is None or not norm_sd:
            continue
        out.append(
            Relation(
                relation_id=bid,
                kind="baseline",
                unit="",
                sensitivity={point_id: 1.0},
                reference_mean=float(ref_mean),
                reference_sigma=float(raw_sd) / float(norm_sd),
                observed_mean=float(obs_mean),
                samples=int(obs_n),
            )
        )
    return out


# ---------------------------------------------------------------------------
# feedback redundancy: a commanded actuator checks its own position sensor
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Feedback:
    """An actuator's reported position beside what it was told to do."""

    point_id: str
    command_id: str
    mean_gap: float
    max_gap: float
    samples: int


def feedback_pairs(conn: psycopg.Connection, asset_ids: set[str]) -> dict[str, str]:
    """Points that have a matching command point, by the "_cmd" naming convention.

    Brick has no way to say "this is the commanded value of that", so the pairing
    is read off the point identifiers, which this project controls and which the
    loader assigns. Keyed off the convention rather than hardcoded so a new
    actuator needs no code change.
    """
    rows = conn.execute(
        "SELECT p.point_id, c.point_id FROM app.points p JOIN app.points c "
        "    ON c.point_id = p.point_id || '_cmd' "
        " WHERE p.asset_id = ANY(%s)",
        (sorted(asset_ids),),
    ).fetchall()
    return dict(rows)


def feedback_gaps(
    conn: psycopg.Connection,
    asset_ids: set[str],
    window: tuple[datetime, datetime],
) -> dict[str, Feedback]:
    """How far each actuator's position sits from its command over the window.

    Two uses, opposite in direction. A large gap means the actuator is not doing
    what it was told, which is a control fault and not a sensor or a wearing part.
    A small gap EXONERATES that position sensor: if isolation wants to explain a
    violation by claiming the valve reads twelve percent high, the command sitting
    within a tenth of a percent of it says otherwise.
    """
    pairs = feedback_pairs(conn, asset_ids)
    if not pairs:
        return {}
    wanted = sorted(set(pairs) | set(pairs.values()))
    values, _quality = load_constraint_points(conn, wanted, window[0], window[1])
    if values.empty:
        return {}

    out: dict[str, Feedback] = {}
    for point_id, command_id in pairs.items():
        if point_id not in values.columns or command_id not in values.columns:
            continue
        gap = (values[point_id] - values[command_id]).abs().dropna()
        if gap.empty:
            continue
        out[point_id] = Feedback(
            point_id=point_id,
            command_id=command_id,
            mean_gap=float(gap.mean()),
            max_gap=float(gap.max()),
            samples=len(gap),
        )
    return out


# ---------------------------------------------------------------------------
# the reconciliation itself
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Hypothesis:
    """One candidate: this single point reads consistently wrong by this much."""

    point_id: str
    implied_bias: float
    explained: float  # fraction of the violation this removes, 0 to 1
    worst_left: float  # largest leftover violation, in reference sigmas
    relations: tuple[str, ...]  # every relation the point participates in
    violated_relations: tuple[str, ...]  # of those, the ones actually violated
    worsened: tuple[str, ...] = ()  # relations this bias makes MORE inconsistent
    exonerated_by: str | None = None  # a feedback point that contradicts the bias

    @property
    def falsifiable(self) -> bool:
        return len(self.relations) >= MIN_RELATIONS_TO_FALSIFY

    @property
    def verdict(self) -> str:
        """Whether this hypothesis survived, and if not, why not.

        The falsification test is that applying the bias must not make any relation
        the point participates in MORE inconsistent than it already was. That test
        rather than "leaves nothing above one sigma", which was the first version and
        was wrong: the drifting sensor moves its two baseline relations by twelve of
        their own sigmas, so demanding a leftover under one sigma demands 92 percent
        accuracy per relation and rejected a hypothesis that explained 94 percent of
        everything. Getting worse is the right test because it is scale-free and it
        is what contradiction actually looks like -- on the leaking valve, a bias
        chosen to fix the shut-valve baseline pushes the coil-effectiveness baseline
        from -1.11 sigma to +2.88, flipping its sign. One bias cannot be both.

        A second requirement is that at least two VIOLATED relations agree on the
        bias, not merely that the point appears in two relations. One violated
        relation cannot corroborate anything, because every point in it explains all
        of it by construction -- the same unfalsifiability argument, applied to what
        actually moved rather than to what exists. Condenser fouling is the case that
        needs it: fouling genuinely raises compressor power, so the power baseline
        residual moves, and "the meter reads 63 kW high" is arithmetically
        indistinguishable from "the machine now draws 63 kW more" from that relation
        alone. The energy balance would be pushed to 0.95 sigma by the bias, just
        under the threshold for being called worse, so without this the fouled
        chiller came out as a faulty power meter.
        """
        if self.exonerated_by is not None:
            return "exonerated by its own command feedback"
        if self.worsened:
            return f"falsified, would make {', '.join(self.worsened)} worse"
        if not self.falsifiable:
            return f"unfalsifiable, appears in only {len(self.relations)} relation"
        if len(self.violated_relations) < MIN_RELATIONS_TO_FALSIFY:
            return (
                f"corroborated by only {len(self.violated_relations)} violated "
                f"relation, which any point in it would explain equally well"
            )
        if self.explained < MIN_EXPLAINED:
            return f"leaves {(1 - self.explained) * 100:.0f} percent unexplained"
        return "consistent with every relation it touches"

    @property
    def survives(self) -> bool:
        return self.verdict.startswith("consistent")


@dataclass(frozen=True)
class Isolation:
    """The whole reconciliation over one asset and one window."""

    asset_ids: tuple[str, ...]
    window: tuple[datetime, datetime]
    relations: list[Relation]
    hypotheses: list[Hypothesis]  # ranked, best explanation first
    sparse_correction: dict[str, float]
    feedback: dict[str, Feedback] = field(default_factory=dict)
    reference_feedback: dict[str, Feedback] = field(default_factory=dict)

    @property
    def violated(self) -> list[Relation]:
        return [r for r in self.relations if r.violated]

    @property
    def any_violation(self) -> bool:
        return bool(self.violated)

    @property
    def best(self) -> Hypothesis | None:
        """The strongest surviving single-sensor explanation, if there is one."""
        return next((h for h in self.hypotheses if h.survives), None)

    @property
    def sparse_support(self) -> tuple[str, ...]:
        """Points the multi-point solve gives a non-zero correction to."""
        return tuple(
            p for p, b in sorted(
                self.sparse_correction.items(), key=lambda kv: -abs(kv[1])
            )
            if abs(b) > 0.0
        )


def _system(relations: list[Relation]) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """The violation vector and sensitivity matrix, in comparable units.

    Every row is divided by that relation's own reference spread. Without this the
    chiller energy balance, whose residual is in watts and runs to six figures,
    would drown every air-side relation in kelvin and the least squares would only
    ever be about the chiller. Dividing by the spread turns each row into "how many
    of its own typical deviations has this moved", which is the only scale on which
    a kelvin and a watt are comparable.
    """
    points = sorted({p for r in relations for p in r.sensitivity})
    rhs = np.zeros(len(relations))
    matrix = np.zeros((len(relations), len(points)))
    for row, relation in enumerate(relations):
        scale = relation.reference_sigma if relation.reference_sigma > 0 else 1.0
        rhs[row] = relation.shift / scale
        for column, point_id in enumerate(points):
            matrix[row, column] = relation.sensitivity.get(point_id, 0.0) / scale
    return rhs, matrix, points


def single_bias(column: np.ndarray, rhs: np.ndarray) -> tuple[float, np.ndarray]:
    """Least-squares bias on one point, and what the violation looks like after.

    One unknown, so the normal equation is a ratio rather than a solve: the bias is
    the projection of the violation onto this point's sensitivity, divided by that
    sensitivity's own squared length.
    """
    denominator = float(column @ column)
    if denominator <= 0.0:
        return 0.0, rhs.copy()
    bias = float(column @ rhs) / denominator
    return bias, rhs - column * bias


def sparse_reconciliation(
    rhs: np.ndarray, matrix: np.ndarray, weight: float = SPARSITY_WEIGHT
) -> np.ndarray:
    """Least squares over every point at once, penalised for using more than one.

    Coordinate descent on the L1-penalised objective: repeatedly, for each point,
    remove its current contribution, fit it against what is left, and shrink the
    result toward zero by the penalty -- clamping to exactly zero when the fit is
    smaller than the penalty. That soft-thresholding step is what makes the answer
    genuinely sparse rather than merely small, which matters because the question
    being asked is how MANY sensors have to be wrong, not by how much.

    The penalty is scaled by the size of the violation being explained, so the same
    setting means the same thing on a large violation and a small one.
    """
    if matrix.size == 0:
        return np.zeros(matrix.shape[1])
    scale = float(np.linalg.norm(rhs)) or 1.0
    penalty = weight * scale
    bias = np.zeros(matrix.shape[1])
    norms = (matrix**2).sum(axis=0)
    for _ in range(SPARSITY_ITERATIONS):
        before = bias.copy()
        for column in range(matrix.shape[1]):
            if norms[column] <= 0.0:
                continue
            partial = rhs - matrix @ bias + matrix[:, column] * bias[column]
            fit = float(matrix[:, column] @ partial)
            bias[column] = np.sign(fit) * max(abs(fit) - penalty, 0.0) / norms[column]
        if np.allclose(bias, before, atol=1e-12):
            break
    return bias


def isolate(
    conn: psycopg.Connection,
    asset_ids: set[str],
    reference: tuple[datetime, datetime],
    window: tuple[datetime, datetime],
) -> Isolation:
    """Pose and solve the isolation problem over one asset and one window.

    Gathers every relation touching these assets from both sources, measures how
    far each has moved since commissioning, then sweeps a single-bias hypothesis
    over every point any relation reads and ranks them by how much of the violation
    each removes. Hypotheses are marked unfalsifiable when the point appears in too
    few relations to be contradicted, falsified when the bias they imply would break
    another relation the same point touches, and exonerated when the point has
    command feedback that sits far closer to it than the claimed bias.

    Returns the full picture rather than a verdict. Turning this into sensor,
    equipment, control or ambiguous is the classifier's job, because it also needs
    the localisation test and the measurement quality flags.
    """
    relations = (
        constraint_relations(conn, asset_ids, reference, window)
        + baseline_relations(conn, asset_ids, reference, window)
    )
    if not relations:
        raise IsolationError(
            f"no relations touch {sorted(asset_ids)} over "
            f"{window[0].date()} to {window[1].date()}"
        )

    feedback = feedback_gaps(conn, asset_ids, window)
    # The same gaps over the fault-free reference window. Needed because one
    # actuator in this building disagrees with its own command by half of full
    # travel on EVERY run, the fault-free one included -- the supply fan speed
    # feedback, which is the same source-data defect Task 3 recorded when it found
    # sf_status byte-identical to the occupancy schedule. An absolute gap test
    # therefore reports a control fault on a healthy air handler, and did.
    reference_feedback = feedback_gaps(conn, asset_ids, reference)
    rhs, matrix, points = _system(relations)

    hypotheses: list[Hypothesis] = []
    for column, point_id in enumerate(points):
        touching = [r for r in relations if point_id in r.sensitivity]
        bias, left = single_bias(matrix[:, column], rhs)
        before = float(rhs @ rhs)
        after = float(left @ left)
        explained = 0.0 if before <= 0.0 else max(0.0, 1.0 - after / before)

        # Only leftovers on relations this point can actually move count against
        # it. A relation it does not appear in was never its to explain.
        own = [i for i, r in enumerate(relations) if point_id in r.sensitivity]
        worst_left = max((abs(left[i]) for i in own), default=0.0)

        # A relation this bias would push further from consistency than it already
        # was. Only counted once the leftover clears the violation threshold, so
        # nudging an already-quiet relation around inside the noise is not treated
        # as a contradiction.
        worsened = tuple(
            relations[i].relation_id
            for i in own
            if abs(left[i]) > abs(rhs[i]) and abs(left[i]) >= MIN_SHIFT_SIGMA
        )

        exonerated = None
        pair = feedback.get(point_id)
        if pair is not None and abs(bias) > max(10.0 * pair.mean_gap, 1e-9):
            exonerated = pair.command_id

        hypotheses.append(
            Hypothesis(
                point_id=point_id,
                implied_bias=bias,
                explained=explained,
                worst_left=worst_left,
                worsened=worsened,
                relations=tuple(r.relation_id for r in touching),
                violated_relations=tuple(
                    r.relation_id for r in touching if r.violated
                ),
                exonerated_by=exonerated,
            )
        )

    hypotheses.sort(key=lambda h: (-h.explained, -len(h.relations)))
    sparse = sparse_reconciliation(rhs, matrix)
    return Isolation(
        asset_ids=tuple(sorted(asset_ids)),
        window=window,
        relations=relations,
        hypotheses=hypotheses,
        sparse_correction=dict(zip(points, sparse, strict=True)),
        feedback=feedback,
        reference_feedback=reference_feedback,
    )
