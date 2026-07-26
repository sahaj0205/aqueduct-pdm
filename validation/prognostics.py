"""Score the remaining-life predictions: does the interval mean what it says?

A prediction interval is a promise about how often it will be wrong. A P10-to-P90
band claims to contain the truth eight times in ten, and if it contains the truth
ten times in ten the band is too wide to plan around, while five times in ten means
the number on the screen is not the number the maths computed. Neither failure is
visible from a single prediction, or from a plot of a band narrowing. It only shows
up by counting.

TWO DIFFERENT FAILURE DATES, AND THEY ARE NOT INTERCHANGEABLE

The answer key records `t_failure`: the date the injected fault reached its terminal
severity, which is the last rung of the measured severity ladder. That is the ground
truth and it is the one this section leads with.

The model predicts something else. It predicts when a specific degradation indicator
will cross a specific threshold, and that threshold was chosen for a physical reason
recorded next to it in `app.failure_modes` -- three kelvin of condenser approach, half
a kilowatt per ton of efficiency lost. Those two events are related but they are not
the same event and on these runs they differ by weeks. Coverage is therefore reported
against both, labelled, because a band that misses the answer key's date while hitting
the crossing it was fitted to predict is a differently wrong thing from a band that
misses both.

WHY MOST OF THE ESTIMATES CANNOT BE CALIBRATED AT ALL

Only two of the six injected faults have a configured degradation mode that names
them. A chilled-water bypass valve leaking past its seat produces no mode of its own;
neither does a drifting thermometer, and neither does a damper jammed at an angle. The
platform still publishes remaining-life numbers on those runs -- for whatever mode
happens to be degrading on the machine -- but calibrating a fan-bearing prediction
against the date a thermometer's bias reached its terminal value is comparing two
unrelated things and getting a number out of it. The matched population is reported as
the headline and the unmatched one beside it, with the difference stated.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from validation.detect import Window, windows
from validation.groundtruth import FaultEvent
from validation.metrics import EXCLUDED_SCENARIOS, affected_assets

# Fraction of the true remaining life the prediction is allowed to be out by. Twenty
# percent is the conventional alpha in the prognostics accuracy literature and is kept
# rather than tuned, precisely so the number below can be compared against published
# results instead of only against itself.
ALPHA = 0.20

# Where along the fault's life the accuracy is checked. Fractions of the way from
# injection to terminal severity. One is left out deliberately: at the failure date the
# true remaining life is zero, so a plus-or-minus-twenty-percent band around it has
# zero width and every prediction fails it by construction. That is a property of the
# metric, not of the model.
LAMBDAS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)

# Which configured degradation mode names each injected fault, and where nothing does.
#
# This is the map that decides whether a remaining-life number is a prediction ABOUT the
# injected fault or merely a prediction made DURING it. Only the first kind can be
# calibrated. The four absences are each a real gap and are listed rather than skipped:
# three of them are faults this project detects but has no wear model for, and the
# fourth is held out on purpose.
MODE_FOR_FAULT: dict[str, tuple[str | None, str]] = {
    "cooling_coil_valve_leakage": (
        "coil-valve-leak-by",
        (
            "the mode's indicator is the supply air temperature residual against a shut "
            "valve, which is what leaked chilled water moves"
        ),
    ),
    "condenser_fouling": (
        "chiller-condenser-fouling",
        (
            "the mode's indicator is the condenser leaving-water residual against the "
            "heat-rejection baseline, which is what scale on the tubes moves"
        ),
    ),
    "bypass_valve_leakage": (
        None,
        (
            "no configured mode names this fault. Leaked chilled water returns to the "
            "chiller as a warmer return temperature, which the efficiency mode picks up as "
            "cost and the condenser mode picks up not at all, so neither is a model of the "
            "valve wearing out"
        ),
    ),
    "supply_air_temperature_sensor_drift": (
        None,
        (
            "no configured mode names this fault, and there should not be one -- a sensor "
            "losing calibration is not a machine wearing out, and giving it a wear model "
            "would mean predicting the remaining life of a thermometer's error"
        ),
    ),
    "outdoor_air_damper_stuck": (
        None,
        (
            "no configured mode names this fault. It is also a step: the damper is jammed "
            "at injection and reaches terminal severity the same instant, so there is no "
            "remaining life to predict"
        ),
    ),
    "cooling_tower_fouling": (
        None,
        "held out by design. No failure mode is configured for the cooling tower",
    ),
}


@dataclass(frozen=True)
class Estimate:
    """One remaining-life estimate as the platform published it."""

    asset_id: str
    mode_id: str
    as_of: datetime
    p10: float | None
    p50: float | None
    p90: float | None
    n_samples: int

    @property
    def bounded(self) -> bool:
        return self.p10 is not None and self.p90 is not None

    def window_dates(self) -> tuple[datetime, datetime] | None:
        """The calendar window the band actually names, or nothing if unbounded."""
        if self.p10 is None or self.p90 is None:
            return None
        return (
            self.as_of + timedelta(days=self.p10),
            self.as_of + timedelta(days=self.p90),
        )


def load_estimates(conn: psycopg.Connection) -> list[Estimate]:
    """Every estimate ever published, from app.rul_estimates.

    Read back rather than recomputed, and the difference from the onset case matters.
    The onset column in app.health_state stores a retrospective estimate, which is the
    wrong quantity for measuring how much warning an operator got. These rows are not
    like that: each one is exactly what the system published on that date from data
    available on that date, which is the thing being calibrated.
    """
    rows = conn.execute(
        """
        SELECT asset_id, mode_id, as_of, p10, p50, p90, n_samples
          FROM app.rul_estimates
         WHERE mode_id IS NOT NULL
         ORDER BY asset_id, mode_id, as_of
        """
    ).fetchall()
    return [
        Estimate(
            asset_id=r[0], mode_id=r[1], as_of=r[2],
            p10=r[3], p50=r[4], p90=r[5], n_samples=r[6],
        )
        for r in rows
    ]


def crossing_dates(conn: psycopg.Connection) -> dict[tuple[str, str, int], datetime]:
    """When each mode's clamped indicator first reached its own failure threshold.

    This is the event the remaining-life model is actually predicting, as distinct from
    the answer key's terminal-severity date. Keyed by machine, mode and calendar year,
    because the scenario runs occupy separate eras and the year is enough to tell them
    apart.
    """
    rows = conn.execute(
        """
        SELECT h.asset_id, h.mode_id,
               EXTRACT(YEAR FROM h.time)::int AS yr,
               min(h.time) AS first_cross
          FROM app.health_state h
          JOIN app.failure_modes m ON m.mode_id = h.mode_id
         WHERE h.mode_id IS NOT NULL
           AND h.indicator_monotonic >= m.failure_threshold
         GROUP BY 1, 2, 3
        """
    ).fetchall()
    return {(r[0], r[1], r[2]): r[3] for r in rows}


@dataclass(frozen=True)
class ThresholdReach:
    """How far one mode's indicator actually travelled toward its own failure point.

    The number that decides how to read every coverage figure below it. A mode whose
    indicator gets 16 percent of the way to its threshold during a run that the answer
    key calls a failure has not failed by the model's own definition, and a prediction
    interval that puts the crossing hundreds of days out is CORRECT about the event it
    was fitted to predict while missing the answer key's date completely. Without this
    column the coverage figure looks like a broken model; with it, most of the gap turns
    out to be two different events being compared.
    """

    asset_id: str
    mode_id: str
    year: int
    threshold: float
    peak_indicator: float
    lowest_health: int | None

    @property
    def fraction_of_threshold(self) -> float:
        return 0.0 if self.threshold == 0.0 else self.peak_indicator / self.threshold

    @property
    def reached(self) -> bool:
        return self.fraction_of_threshold >= 1.0


def threshold_reach(conn: psycopg.Connection) -> dict[tuple[str, str, int], ThresholdReach]:
    """Per machine, mode and run, the furthest the clamped indicator ever got."""
    rows = conn.execute(
        """
        SELECT h.asset_id, h.mode_id, EXTRACT(YEAR FROM h.time)::int AS yr,
               m.failure_threshold, max(h.indicator_monotonic), min(h.health)
          FROM app.health_state h
          JOIN app.failure_modes m ON m.mode_id = h.mode_id
         WHERE h.mode_id IS NOT NULL AND h.indicator_monotonic IS NOT NULL
         GROUP BY 1, 2, 3, 4
        """
    ).fetchall()
    return {
        (r[0], r[1], r[2]): ThresholdReach(
            asset_id=r[0], mode_id=r[1], year=r[2], threshold=float(r[3]),
            peak_indicator=float(r[4]),
            lowest_health=None if r[5] is None else int(r[5]),
        )
        for r in rows
    }


def scenario_of(as_of: datetime, run_windows: list[Window]) -> str | None:
    """Which run a date belongs to. The eras are years apart, so this is unambiguous."""
    for window in run_windows:
        if window.t_from <= as_of < window.t_to + timedelta(days=1):
            return window.scenario_id
    return None


# ---------------------------------------------------------------------------
# 5. interval calibration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Calibration:
    """Coverage of one machine-and-mode's prediction interval on one run."""

    scenario_id: str
    asset_id: str
    mode_id: str
    matched: bool
    reference: str
    target: date
    in_horizon: int
    bounded: int
    covered: int
    late: int
    early: int
    unbounded_reason: str
    reach: ThresholdReach | None = None

    @property
    def coverage(self) -> float | None:
        return self.covered / self.bounded if self.bounded else None


def _calibrate(
    estimates: list[Estimate],
    scenario_id: str,
    asset_id: str,
    mode_id: str,
    matched: bool,
    reference: str,
    target: datetime,
    onset: datetime,
    reach: ThresholdReach | None,
) -> Calibration:
    """Count how often the band contained one target date, over the prediction horizon.

    Only estimates made between injection and the target count. An estimate made after
    the equipment has already reached the target is not a prediction of it -- the band
    lies entirely in the future and the target is in the past, so it can only ever miss,
    and including those would report a calibration failure that is really a scoping
    error. Roughly half of the published estimates on these runs fall after their own
    target date, because the replay continues to the end of the run.
    """
    horizon = [e for e in estimates if onset <= e.as_of <= target]
    bounded = [e for e in horizon if e.bounded]
    covered = late = early = 0
    for estimate in bounded:
        band = estimate.window_dates()
        if band is None:
            continue
        if band[0] <= target <= band[1]:
            covered += 1
        elif target < band[0]:
            # The whole band sits after the date the equipment actually got there, so
            # the model promised more time than there was. On a maintenance system this
            # is the dangerous direction of error and it is counted separately.
            late += 1
        else:
            early += 1
    return Calibration(
        scenario_id=scenario_id, asset_id=asset_id, mode_id=mode_id, matched=matched,
        reference=reference, target=target.date(), in_horizon=len(horizon),
        bounded=len(bounded), covered=covered, late=late, early=early, reach=reach,
        unbounded_reason=(
            f"{len(horizon) - len(bounded)} of {len(horizon)} estimates in the horizon "
            f"left one end of the band unbounded, so the model declined to name a "
            f"window and they cannot be scored either way"
            if len(bounded) < len(horizon) else ""
        ),
    )


def interval_calibration(
    estimates: list[Estimate],
    events: list[FaultEvent],
    crossings: dict[tuple[str, str, int], datetime],
    reaches: dict[tuple[str, str, int], ThresholdReach],
) -> list[Calibration]:
    """Coverage per run, machine and mode, against both definitions of failure.

    Produces up to two rows per series: one against the answer key's terminal-severity
    date and one against the date the indicator actually crossed its own threshold,
    where that happened inside the run. The `matched` flag says whether the mode being
    scored is the one that names the injected fault, which is the difference between a
    prediction about this fault and a prediction made during it.
    """
    run_windows = windows()
    by_series: dict[tuple[str, str, str], list[Estimate]] = {}
    for estimate in estimates:
        scenario_id = scenario_of(estimate.as_of, run_windows)
        if scenario_id is None:
            continue
        by_series.setdefault(
            (scenario_id, estimate.asset_id, estimate.mode_id), []
        ).append(estimate)

    out: list[Calibration] = []
    for event in events:
        if event.scenario_id in EXCLUDED_SCENARIOS or event.t_failure is None:
            continue
        if event.t_failure <= event.t_onset:
            continue
        named, _why = MODE_FOR_FAULT.get(event.fault_mode, (None, ""))
        for asset_id in affected_assets(event):
            for (scenario_id, asset, mode_id), series in sorted(by_series.items()):
                if scenario_id != event.scenario_id or asset != asset_id:
                    continue
                matched = mode_id == named
                reach = reaches.get((asset_id, mode_id, event.t_onset.year))
                out.append(
                    _calibrate(
                        series, scenario_id, asset_id, mode_id, matched,
                        "answer key terminal severity", event.t_failure, event.t_onset,
                        reach,
                    )
                )
                crossed = crossings.get((asset_id, mode_id, event.t_onset.year))
                if crossed is not None and crossed > event.t_onset:
                    out.append(
                        _calibrate(
                            series, scenario_id, asset_id, mode_id, matched,
                            "indicator crossed its own threshold", crossed,
                            event.t_onset, reach,
                        )
                    )
    return out


@dataclass(frozen=True)
class CoverageRollUp:
    """Pooled coverage over one population of estimates."""

    label: str
    series: int
    bounded: int
    covered: int
    late: int
    early: int
    unbounded: int

    @property
    def coverage(self) -> float | None:
        return self.covered / self.bounded if self.bounded else None

    @property
    def late_share(self) -> float | None:
        misses = self.late + self.early
        return self.late / misses if misses else None


def coverage_rollups(calibrations: list[Calibration]) -> list[CoverageRollUp]:
    """The four populations worth quoting, pooled. Nominal coverage is 80 percent."""
    groups = (
        ("matched mode, against the answer key",
         lambda c: c.matched and c.reference.startswith("answer")),
        ("matched mode, against the indicator crossing",
         lambda c: c.matched and c.reference.startswith("indicator")),
        ("any mode on the faulted machine, against the answer key",
         lambda c: c.reference.startswith("answer")),
        ("any mode on the faulted machine, against the indicator crossing",
         lambda c: c.reference.startswith("indicator")),
    )
    out = []
    for label, keep in groups:
        picked = [c for c in calibrations if keep(c)]
        out.append(
            CoverageRollUp(
                label=label, series=len(picked),
                bounded=sum(c.bounded for c in picked),
                covered=sum(c.covered for c in picked),
                late=sum(c.late for c in picked),
                early=sum(c.early for c in picked),
                unbounded=sum(c.in_horizon - c.bounded for c in picked),
            )
        )
    return out


def uncalibratable(
    estimates: list[Estimate], events: list[FaultEvent]
) -> tuple[list[tuple[str, int, str]], int]:
    """Split every published estimate into exactly one bucket: scoreable, or why not.

    Returns the unscoreable groups and the count that IS scoreable, and the two are
    guaranteed to sum to the number of estimates published, because every estimate falls
    through exactly one branch below. That closure is the point of the function. An
    earlier version tested only some of the exclusions, so the groups it reported did not
    add up to the total and the report quoted a "scoreable" figure that double-counted
    estimates appearing under two different failure references. A coverage number whose
    denominator cannot be reconciled against the population is not a measurement.

    The order of the branches is the order the reasons dominate, so a chiller that is both
    on a fault-free run and never faulted is counted once, under the run.
    """
    run_windows = windows()
    counted: dict[str, int] = {}
    reasons: dict[str, str] = {}
    faulted = {e.scenario_id: e for e in events}
    affected: dict[str, set[str]] = {}
    for event in events:
        affected.setdefault(event.scenario_id, set()).update(affected_assets(event))

    scoreable = 0
    for estimate in estimates:
        scenario_id = scenario_of(estimate.as_of, run_windows)
        if scenario_id is None:
            key = "outside every evaluated run window"
            reasons[key] = "no run covers the date the estimate was made"
        elif scenario_id in EXCLUDED_SCENARIOS:
            key = f"on the held-out run `{scenario_id}`"
            reasons[key] = EXCLUDED_SCENARIOS[scenario_id].split(".")[0]
        elif scenario_id not in faulted:
            key = f"on the fault-free run `{scenario_id}`"
            reasons[key] = (
                "no fault was injected, so there is no failure date for a band to "
                "contain. These estimates are the remaining-life layer forecasting a "
                "failure on a machine that was working"
            )
        elif estimate.asset_id not in affected.get(scenario_id, set()):
            key = "on a machine coupled to the faulted one, not the faulted one itself"
            reasons[key] = (
                "the chiller data is a whole-plant simulation, so a machine beside the "
                "faulted one is neither faulted nor assertably healthy and has no "
                "failure date of its own to be scored against"
            )
        else:
            event = faulted[scenario_id]
            if event.t_failure is None or event.t_failure <= event.t_onset:
                key = f"on the step-fault run `{scenario_id}`"
                reasons[key] = (
                    "terminal severity is reached at injection, so remaining life is "
                    "zero from the first instant and there is nothing to predict"
                )
            elif estimate.as_of > event.t_failure:
                key = "made after the failure date they would be scored against"
                reasons[key] = (
                    "the replay continues to the end of the run, so it keeps publishing "
                    "after the fault has already reached terminal severity. A band "
                    "lying entirely in the future cannot contain a date in the past"
                )
            elif estimate.as_of < event.t_onset:
                key = "made before the fault was injected"
                reasons[key] = (
                    "the mode was already trending before anything was done to the "
                    "machine, so the estimate is a forecast of something the answer key "
                    "has no date for"
                )
            else:
                scoreable += 1
                continue
        counted[key] = counted.get(key, 0) + 1
    groups = sorted(
        ((key, n, reasons[key]) for key, n in counted.items()), key=lambda r: -r[1]
    )
    return groups, scoreable


# ---------------------------------------------------------------------------
# 6. alpha-lambda accuracy
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AlphaLambdaPoint:
    """One accuracy check, at one fraction of the way through the fault's life."""

    scenario_id: str
    asset_id: str
    mode_id: str
    matched: bool
    lam: float
    as_of: date
    true_rul: float
    p50: float | None
    p10: float | None
    p90: float | None
    n_samples: int

    @property
    def error(self) -> float | None:
        return None if self.p50 is None else self.p50 - self.true_rul

    @property
    def relative_error(self) -> float | None:
        if self.p50 is None or self.true_rul <= 0.0:
            return None
        return (self.p50 - self.true_rul) / self.true_rul

    @property
    def within(self) -> bool:
        rel = self.relative_error
        return rel is not None and abs(rel) <= ALPHA

    @property
    def band_contains_truth(self) -> bool:
        if self.p10 is None or self.p90 is None:
            return False
        return self.p10 <= self.true_rul <= self.p90


def alpha_lambda(
    estimates: list[Estimate], events: list[FaultEvent]
) -> list[AlphaLambdaPoint]:
    """Is the median prediction within alpha of the truth, at each stage of the fault?

    At each fraction lambda of the way from injection to terminal severity, take the
    estimate published on that date -- or the nearest earlier one, because the platform
    only publishes on days it has enough evidence to fit -- and compare its median
    against how much life was really left. The comparison is relative, so twenty percent
    of ninety days is eighteen days of slack and twenty percent of five days is one, which
    is the point: a prediction has to get tighter in absolute terms as the end approaches
    to keep passing.
    """
    run_windows = windows()
    by_series: dict[tuple[str, str, str], list[Estimate]] = {}
    for estimate in estimates:
        scenario_id = scenario_of(estimate.as_of, run_windows)
        if scenario_id is None:
            continue
        by_series.setdefault(
            (scenario_id, estimate.asset_id, estimate.mode_id), []
        ).append(estimate)

    out: list[AlphaLambdaPoint] = []
    for event in events:
        if event.scenario_id in EXCLUDED_SCENARIOS or event.t_failure is None:
            continue
        span = (event.t_failure - event.t_onset).total_seconds()
        if span <= 0.0:
            continue
        named, _why = MODE_FOR_FAULT.get(event.fault_mode, (None, ""))
        for asset_id in affected_assets(event):
            for (scenario_id, asset, mode_id), series in sorted(by_series.items()):
                if scenario_id != event.scenario_id or asset != asset_id:
                    continue
                ordered = sorted(series, key=lambda e: e.as_of)
                for lam in LAMBDAS:
                    at = event.t_onset + timedelta(seconds=span * lam)
                    earlier = [e for e in ordered if e.as_of <= at]
                    if not earlier:
                        continue
                    pick = earlier[-1]
                    out.append(
                        AlphaLambdaPoint(
                            scenario_id=scenario_id, asset_id=asset_id,
                            mode_id=mode_id, matched=mode_id == named, lam=lam,
                            as_of=pick.as_of.date(),
                            true_rul=(
                                event.t_failure - pick.as_of
                            ).total_seconds() / 86400.0,
                            p50=pick.p50, p10=pick.p10, p90=pick.p90,
                            n_samples=pick.n_samples,
                        )
                    )
    return out


@dataclass(frozen=True)
class AlphaLambdaRollUp:
    """Hit rate at one lambda, across every series scored."""

    lam: float
    n: int
    within: int
    band_hits: int
    median_relative_error: float | None

    @property
    def hit_rate(self) -> float | None:
        return self.within / self.n if self.n else None


def alpha_lambda_rollup(
    points: list[AlphaLambdaPoint], matched_only: bool
) -> list[AlphaLambdaRollUp]:
    """Hit rate per lambda, over the matched population or over everything."""
    import statistics

    out = []
    for lam in LAMBDAS:
        picked = [
            p for p in points
            if p.lam == lam and (p.matched or not matched_only)
        ]
        errors = [p.relative_error for p in picked if p.relative_error is not None]
        out.append(
            AlphaLambdaRollUp(
                lam=lam, n=len(picked),
                within=sum(1 for p in picked if p.within),
                band_hits=sum(1 for p in picked if p.band_contains_truth),
                median_relative_error=(
                    statistics.median(errors) if errors else None
                ),
            )
        )
    return out
