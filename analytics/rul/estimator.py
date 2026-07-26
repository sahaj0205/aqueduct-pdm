"""Turn a fitted degradation process into a distribution over failure dates.

Failure is defined here as FIRST PASSAGE: the first moment the degradation
indicator touches the failure threshold in app.failure_modes. Not the average
level, not the level at some horizon -- the first touch, because equipment that
crosses a threshold and comes back has still crossed it, and the maintenance
decision was already triggered.

For a Wiener process this distribution is known in closed form. Starting a
distance `a` below the threshold with drift mu and diffusion sigma, the time to
first touch is Inverse Gaussian with mean a/mu and shape a^2/sigma^2, and its
cumulative distribution is two normal terms:

    F(t) = Phi((mu*t - a) / (sigma*sqrt(t)))
           + exp(2*mu*a / sigma^2) * Phi(-(mu*t + a) / (sigma*sqrt(t)))

That is implemented directly below rather than simulated, for two reasons. It is
exact, and -- more importantly -- it stays correct when mu is NEGATIVE, which a
simulation of the mean case would quietly skip past.

THE DEFECT IS THE POINT. When mu is at or below zero the machine is not heading
for the threshold, and the total probability of ever reaching it is not one: it is
exp(2*mu*a/sigma^2), which goes to zero as the drift goes down. The first-passage
distribution is therefore DEFECTIVE, with the missing mass sitting at infinity.
The belief about mu from checkpoint 5.1 is a normal distribution, so it always
puts some weight on non-positive drift, and the honest predictive distribution
inherits that missing mass. If the ninetieth percentile falls in it, then the
model genuinely cannot bound the failure date and says so instead of producing a
number. That is not a special case bolted on; it falls out of the arithmetic.

HOW THE INTERVAL IS PRODUCED. The uncertainty about mu is carried into the
first-passage law by integrating over it:

    P(fail by t) = integral over mu of  F(t | mu) * posterior(mu)  d mu

evaluated by Gauss-Hermite quadrature, which is exact for smooth integrands
against a normal weight and, unlike sampling, gives the same answer every time it
runs. The quantiles come from inverting that mixture. So the interval IS the
model's output: there is no point estimate anywhere in this file, and nothing is
padded by a factor chosen to make the band look right. The consequence is that the
band can be embarrassingly wide, and when it is, that is the answer.

Run with `make rul`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
import psycopg
from scipy.optimize import brentq
from scipy.special import log_ndtr, ndtr

from analytics.rul.degradation import Degradation

log = logging.getLogger("rul.estimator")

# The three quantiles reported. P50 is the date to plan around, P10 is how soon
# this could bite, P90 is how long it might hold out.
QUANTILES = (0.10, 0.50, 0.90)

# How far ahead the model is willing to look. Ten years. An HVAC chiller's
# service life is around twenty-three years by ASHRAE's own tables, so a
# threshold crossing predicted beyond ten is not a maintenance decision anybody
# will act on -- it is indistinguishable from "not in the foreseeable future",
# which is what the estimate reports instead of a number.
MAX_HORIZON_DAYS = 3650.0

# Nodes for the integration over the belief about the drift. Gauss-Hermite
# converges geometrically on smooth integrands, and the first-passage
# distribution is smooth in the drift, so this is far more than needed; it is
# cheap and removes any question of quadrature error mattering.
QUADRATURE_NODES = 61

# Shortest interval the root-finder will consider. Below a tenth of a day the
# question is not a maintenance question.
MIN_HORIZON_DAYS = 0.1

_NODES, _RAW_WEIGHTS = np.polynomial.hermite.hermgauss(QUADRATURE_NODES)
# Normalised so the weights sum to one and the quadrature is a plain expectation
# against the normal belief rather than against exp(-x^2).
_WEIGHTS = _RAW_WEIGHTS / np.sqrt(np.pi)


# ---------------------------------------------------------------------------
# the closed-form first-passage law
# ---------------------------------------------------------------------------


def first_passage_cdf(
    days: float, distance: float, mu: np.ndarray | float, sigma: float
) -> np.ndarray:
    """Probability the threshold has been touched within `days`.

    `distance` is how far the indicator still has to climb. Vectorised over mu so
    the whole quadrature is one call.

    The second term carries a growing exponential multiplied by a vanishing normal
    tail, and evaluating those separately overflows for perfectly ordinary inputs:
    a drift of 0.3 across a distance of 3 with a spread of 0.7 already puts the
    exponent near 4, and larger cases run away. Both are therefore combined in log
    space through log_ndtr, so the product is computed as a single exponential of a
    sum and stays finite wherever the answer is finite.
    """
    mu = np.asarray(mu, dtype=float)
    if days <= 0.0:
        return np.zeros_like(mu)
    if distance <= 0.0:
        # Already at or past the threshold. It was touched before we looked.
        return np.ones_like(mu)

    spread = sigma * np.sqrt(days)
    reached = ndtr((mu * days - distance) / spread)
    overshot = np.exp(
        2.0 * mu * distance / sigma**2
        + log_ndtr(-(mu * days + distance) / spread)
    )
    return np.clip(reached + overshot, 0.0, 1.0)


def reachability(distance: float, mu: np.ndarray | float, sigma: float) -> np.ndarray:
    """Probability the threshold is EVER touched, given this drift.

    One for positive drift -- Brownian motion with an upward tilt reaches every
    level above it eventually, with certainty. Less than one for negative drift,
    and this is the quantity that makes the prediction defective. It is the limit
    of the cumulative distribution as time goes to infinity.

    Written as a single clipped exponential rather than a branch on the sign of the
    drift. Selecting between branches with np.where evaluates BOTH of them, so the
    positive-drift case still computed a growing exponential and overflowed on
    ordinary inputs. Clipping the exponent at zero gives exactly one for positive
    drift, which is the right answer there anyway.
    """
    mu = np.asarray(mu, dtype=float)
    if distance <= 0.0:
        return np.ones_like(mu)
    return np.exp(np.minimum(2.0 * mu * distance / sigma**2, 0.0))


# ---------------------------------------------------------------------------
# integrating the belief about the drift into it
# ---------------------------------------------------------------------------


def predictive_cdf(
    days: float, distance: float, sigma: float, mean: float, sd: float
) -> float:
    """First-passage probability with the uncertainty about the drift folded in.

    Averages the closed-form law over the normal belief about the drift, using
    quadrature nodes placed where that belief has its mass. This is the step the
    checkpoint calls propagating the posterior: a single drift would give a
    confident narrow band, and averaging over the drifts we actually think are
    plausible is what widens it honestly.
    """
    if sd <= 0.0:
        return float(first_passage_cdf(days, distance, mean, sigma)[()])
    drifts = mean + np.sqrt(2.0) * sd * _NODES
    return float(np.sum(_WEIGHTS * first_passage_cdf(days, distance, drifts, sigma)))


def predictive_reachability(
    distance: float, sigma: float, mean: float, sd: float
) -> float:
    """Total probability the threshold is ever reached, over the belief on drift.

    The ceiling every quantile has to fit under. If this is 0.8 then there is no
    ninetieth percentile of the failure date, because there is a one-in-five
    chance there is no failure date at all.
    """
    if sd <= 0.0:
        return float(reachability(distance, mean, sigma)[()])
    drifts = mean + np.sqrt(2.0) * sd * _NODES
    return float(np.sum(_WEIGHTS * reachability(distance, drifts, sigma)))


def quantile(
    q: float, distance: float, sigma: float, mean: float, sd: float
) -> float | None:
    """Days until the given quantile of the failure date. None if unbounded.

    The mixture cumulative distribution rises with time, so the quantile is found
    by bisection on it. Returns None in the two cases where the answer does not
    exist rather than inventing one: when the total probability of ever failing
    sits below the quantile asked for, and when the crossing is real but further
    away than the horizon this module will look.
    """
    if distance <= 0.0:
        return 0.0
    if predictive_reachability(distance, sigma, mean, sd) <= q:
        return None

    def shortfall(days: float) -> float:
        return predictive_cdf(days, distance, sigma, mean, sd) - q

    if shortfall(MAX_HORIZON_DAYS) < 0.0:
        return None
    if shortfall(MIN_HORIZON_DAYS) > 0.0:
        return MIN_HORIZON_DAYS
    return float(brentq(shortfall, MIN_HORIZON_DAYS, MAX_HORIZON_DAYS, xtol=1e-4))


# ---------------------------------------------------------------------------
# one estimate
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RulEstimate:
    """Remaining useful life for one failure mode on one asset, as of one date."""

    asset_id: str
    mode_id: str
    as_of: datetime
    distance: float  # how far the indicator still has to travel
    p10: float | None  # days
    p50: float | None
    p90: float | None
    mu_hat: float  # posterior mean drift, indicator units per day
    sigma_hat: float  # process spread, the one the interval was computed with
    n_samples: int
    reachability: float  # probability the threshold is ever reached at all

    @property
    def width(self) -> float | None:
        """P10 to P90 span in days, or None if either end is unbounded."""
        if self.p10 is None or self.p90 is None:
            return None
        return self.p90 - self.p10

    @property
    def bounded(self) -> bool:
        return self.p90 is not None

    @property
    def failure_date(self) -> datetime | None:
        """The P50 as a calendar date, which is what a planner actually wants."""
        if self.p50 is None:
            return None
        return self.as_of + timedelta(days=self.p50)


def estimate(degradation: Degradation) -> RulEstimate:
    """First-passage quantiles for one fitted mode.

    The drift and its spread come from the belief built in checkpoint 5.1; the
    diffusion is the anchored process spread, the same number that belief was
    formed against, so the two halves of the interval cannot disagree about how
    noisy the machine is. The distance is measured from where the clamped
    indicator has actually got to, not from where it started, which is what makes
    the estimate shrink as the machine degrades rather than only as the fit
    improves.
    """
    post = degradation.posterior
    sigma = degradation.anchor.sigma
    distance = degradation.remaining
    quantiles = [
        quantile(q, distance, sigma, post.mean, post.sd) for q in QUANTILES
    ]
    return RulEstimate(
        asset_id=degradation.asset_id,
        mode_id=degradation.mode_id,
        as_of=degradation.as_of,
        distance=distance,
        p10=quantiles[0],
        p50=quantiles[1],
        p90=quantiles[2],
        mu_hat=post.mean,
        sigma_hat=sigma,
        n_samples=degradation.fit.samples,
        reachability=predictive_reachability(distance, sigma, post.mean, post.sd),
    )


def soonest(estimates: list[RulEstimate]) -> RulEstimate | None:
    """The asset's own remaining life: whichever mode gets there first.

    The same weakest-link rule the health index uses. An asset is not the average
    of its failure modes, it is however long until the first one of them needs
    attention, and averaging a compressor with ten years left against a condenser
    with three weeks describes a machine that does not exist.

    A mode whose failure date is unbounded cannot be the soonest, so it is skipped
    -- but if EVERY mode is unbounded the answer is that the asset has no bounded
    failure date, which comes back as nothing.
    """
    bounded = [e for e in estimates if e.p50 is not None]
    return min(bounded, key=lambda e: e.p50) if bounded else None


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------


def write_estimates(
    conn: psycopg.Connection,
    estimates: list[RulEstimate],
    t_from: datetime,
    t_to: datetime,
) -> int:
    """Replace the stored history for these modes over this window.

    Deleted and rewritten rather than merged, like every derived table here: a row
    left behind describes a threshold or a baseline that may no longer exist. The
    full per-date history is kept rather than only the latest estimate, because
    the single most convincing thing this system can show a human is the interval
    narrowing as evidence arrives, and that is only visible if every intermediate
    answer was written down.
    """
    if not estimates:
        return 0
    keys = sorted({(e.asset_id, e.mode_id) for e in estimates})
    with conn.cursor() as cur:
        for asset_id, mode_id in keys:
            cur.execute(
                "DELETE FROM app.rul_estimates "
                " WHERE asset_id = %s AND mode_id = %s "
                "   AND as_of >= %s AND as_of < %s",
                (asset_id, mode_id, t_from, t_to),
            )
        cur.executemany(
            "INSERT INTO app.rul_estimates (asset_id, mode_id, as_of, p10, p50, "
            "  p90, n_samples, mu_hat, sigma_hat) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            [
                (
                    e.asset_id, e.mode_id, e.as_of, e.p10, e.p50, e.p90,
                    e.n_samples, e.mu_hat, e.sigma_hat,
                )
                for e in estimates
            ],
        )
    return len(estimates)


def daily_as_ofs(t_from: datetime, t_to: datetime, step_days: int = 1) -> list[datetime]:
    """Every date the estimate should be recomputed at, across a run.

    Daily by default. The fit is linear in the number of days so a full run costs
    nothing, and a daily history is what lets the interval be animated rather than
    shown at three arbitrary points.
    """
    out: list[datetime] = []
    cursor = t_from
    while cursor < t_to:
        out.append(cursor)
        cursor += timedelta(days=step_days)
    return out
