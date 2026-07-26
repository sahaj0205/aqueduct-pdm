"""Fit what a healthy air handler does, as a function of what is being asked of it.

Static thresholds are the documented cause of false-positive fatigue in building
fault detection. The reason is simple: almost every quantity worth watching moves
far more with operating conditions than with equipment health. A supply fan
drawing 900 watts is alarming at half airflow and unremarkable at full airflow,
and a fixed limit fires on the hot afternoon rather than on the failing bearing.
Fitting expected performance against the drivers and watching the leftover is what
turns "the number is high" into "the number is high for these conditions".

Two air-handler baselines are fitted here. Both are physics-form: the terms come
from the equation the equipment actually obeys, not from throwing polynomials at
the data, so the coefficients mean something and the model does not fly apart
just outside the range it was fitted on.

THIS MODULE IS DELIBERATELY AIR-HANDLER-SPECIFIC. Checkpoint 4.2 generalises it.

WHAT IT IS ALLOWED TO KNOW. The fit window is a commissioning window: three
weeks of operation the operator asserts was healthy. That is an ordinary
operational input -- in a real building it is "the unit was serviced on this
date" -- and it is supplied here as configuration in AHU_SPANS below. It says
nothing about what fault is coming, or whether one is coming at all; the clean
run carries exactly the same declaration as the faulted ones. Nothing in this
module reads schema groundtruth, and nothing reads the onset, fault mode or
severity waypoints out of the scenario manifests. It should be said plainly that
the windows below coincide with the pre-onset period of each scenario, because
that is how the scenarios were built.

Run through `make baselines`, which invokes analytics.baselines.residual.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd
import psycopg

from analytics.rules.readings import effective_quality_frame

log = logging.getLogger("baselines")

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

# The air handler's four 120-day runs and the commissioning window at the start
# of each. Stated here as configuration for the reason given in the module
# docstring. Dates are the extent of the data, which is visible from the
# measurements themselves.
COMMISSIONING_DAYS = 21

AHU_SPANS: tuple[tuple[str, str, str], ...] = (
    ("ahu_cooling_valve_leakage", "2036-02-25T00:00:00+00:00", "2036-06-24T00:00:00+00:00"),
    ("ahu_oa_damper_stuck", "2037-01-27T00:00:00+00:00", "2037-05-27T00:00:00+00:00"),
    ("ahu_sat_sensor_drift", "2038-05-27T00:00:00+00:00", "2038-09-24T00:00:00+00:00"),
    ("clean_ahu", "2039-05-27T00:00:00+00:00", "2039-09-24T00:00:00+00:00"),
)

# Chilled water supply temperature, degC. THE AIR HANDLER DOES NOT MEASURE IT.
# The LBNL single-duct dataset publishes 30 columns and not one is water side --
# the coil is instrumented with a valve position and nothing else. The coil model
# needs a cold-side temperature to have a driving temperature difference at all,
# so a constant design value stands in for it.
#
# This costs very little, because the effectiveness coefficients rescale to
# absorb whatever value is chosen. Sweeping it from 4 to 8 degC moves the fit
# R-squared by less than 0.003 and the residual spread by 0.02 K. 6.7 degC is the
# standard design chilled water supply temperature for commercial coils, and the
# chiller plant in this same project holds its own primary supply setpoint at
# 6.67 to 6.74 degC, which is the closest thing to a corroborating measurement
# available.
#
# The rejected alternative was joining the chiller plant's measured supply
# temperature. Two of the four air-handler runs predate the chiller data
# entirely, and the two datasets are independent LBNL simulations of different
# buildings, so the join would assert a water connection that does not exist.
CHILLED_WATER_SUPPLY_C = 6.7

# The supply fan is running when its speed command is off its stop. NOT
# ahu-1.sf_status, which despite its name is not a fan status: it is byte for
# byte identical to ahu-1.occupancy across all 138,240 samples of the record,
# and the fan runs during morning pull-down while it still reads zero -- 7,686
# samples, 5.6 percent of the record. Gating on it would drop every start-up and
# every after-hours run out of the fit.
RUN_GATE_POINT = "ahu-1.sf_speed_cmd"
RUN_GATE_THRESHOLD = 0.05

# Readings this untrustworthy are excluded from the FIT, so a dead sensor cannot
# define what healthy looks like. Residuals are still computed for them later and
# stored with the low score attached, so the exclusion is visible rather than
# silent. Matches the gate the rule engine uses.
MIN_FIT_QUALITY = 70

# A fit on fewer points than this is not reported as a baseline. Three weeks of
# five-minute data is around 3,300 running samples, so this is a floor against a
# window that is mostly missing, not a real constraint.
MIN_FIT_SAMPLES = 200

# The coil model cannot be identified if the valve never moves: every
# effectiveness term is multiplied by valve position, so a window with the valve
# always shut has no information about coil authority at all.
MIN_VALVE_RANGE = 0.10

# Floor on the fitted spread, so a baseline that happens to fit almost perfectly
# cannot turn rounding noise into enormous normalised values.
MIN_SCALE = 1e-9

# Every point the two air-handler baselines read, plus the run gate.
AHU_POINTS: tuple[str, ...] = (
    "ahu-1.sa_temp",
    "ahu-1.ma_temp",
    "ahu-1.sa_flow",
    "ahu-1.chw_valve",
    "ahu-1.sf_power",
    "ahu-1.sf_speed_cmd",
)

BASELINE_FAN_POWER = "ahu-1.sf_power.fan-similarity"
BASELINE_SUPPLY_AIR_TEMP = "ahu-1.sa_temp.coil-effectiveness"


class BaselineError(RuntimeError):
    """A baseline could not be fitted from the window it was given."""


# ---------------------------------------------------------------------------
# the fitted object
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Baseline:
    """One fitted model, and everything needed to judge and reuse it."""

    baseline_id: str
    target: str  # point id the model predicts
    drivers: tuple[str, ...]  # point ids it predicts from
    terms: tuple[str, ...]  # human-readable name of each coefficient
    coefficients: np.ndarray
    unit: str
    r_squared: float
    residual_sd: float  # standard deviation of the fit errors; also the scale
    centre: float  # robust centre of the fit errors, subtracted before scaling
    samples: int
    fit_from: datetime
    fit_to: datetime

    def describe(self) -> str:
        return "  ".join(
            f"{name}={value:+.4g}"
            for name, value in zip(self.terms, self.coefficients, strict=True)
        )


# ---------------------------------------------------------------------------
# physics forms
#
# Each of these turns the measured drivers into the design matrix of a model
# that is linear in its coefficients but not in its inputs. Linear in the
# coefficients means ordinary least squares solves it exactly, with no starting
# guess and no chance of landing in a local minimum; non-linear in the inputs is
# what lets the terms be the actual physics.
# ---------------------------------------------------------------------------

FAN_TERMS = ("a_speed^3", "b_speed^2*flow", "c_speed*flow^2")


def fan_power_terms(flow: np.ndarray, speed: np.ndarray) -> np.ndarray:
    """Design matrix for fan power under the fan similarity laws.

    A fan's power is not a function of airflow alone. The affinity law that says
    power goes as the cube of airflow only holds along a FIXED system curve, and
    this is a variable-air-volume unit whose system curve moves every time a
    terminal box modulates. Measured on this data, airflow alone explains between
    15 and 55 percent of fan power depending on the window, and the fitted cubic
    coefficient comes out negative, which is physically impossible.

    The similarity laws in their general form say the dimensionless power
    coefficient is a function of the flow coefficient, airflow divided by speed.
    Writing that function as a quadratic and clearing the denominators gives
    power as a sum of three terms, each of total degree three in speed and
    airflow jointly:

        P = a*N^3 + b*N^2*Q + c*N*Q^2

    That is the form below. It measures R-squared of 0.977 to 0.989 with a
    residual spread of 21 to 26 watts across all four windows.

    No intercept. At zero speed the fan is stopped and draws nothing, and a
    fitted constant would let the model claim otherwise. Enforcing it costs
    0.0008 of R-squared.
    """
    return np.column_stack([speed**3, speed**2 * flow, speed * flow**2])


COIL_TERMS = (
    "valve_authority",
    "valve_curvature",
    "flow_dilution",
    "fan_temp_rise_K",
)


def supply_air_terms(
    mixed_air: np.ndarray, valve: np.ndarray, flow: np.ndarray
) -> np.ndarray:
    """Design matrix for the cooling coil, in effectiveness-NTU form.

    A cooling coil is a heat exchanger, and the standard way to describe one is
    its effectiveness: the fraction of the available temperature difference it
    actually delivers. The available difference is between the air arriving at
    the coil and the water inside it, so

        T_mixed - T_supply = effectiveness * (T_mixed - T_water) - fan_rise

    The effectiveness itself is not constant. It rises as the valve opens and
    admits more water, and it falls as airflow rises, because faster air spends
    less time against the tubes. Every effectiveness term below is multiplied by
    valve position, which forces effectiveness to zero when the valve is shut --
    a closed valve delivers no cooling, and a model free to disagree with that
    would hide the coil-leak fault this baseline exists to expose.

    The fourth term is a constant temperature rise across the supply fan, which
    sits downstream of the coil and adds its own heat to the air. Measured with
    the valve shut it is 0.50 to 0.55 K in winter. It is fitted rather than
    computed from fan power, because the published fan wattage and the published
    airflow are not on consistent scales in this dataset and the computed rise
    comes out roughly six times too small.

    The structure matters as much as the fit. Because the driving temperature
    difference enters multiplicatively, the model cannot predict cooling when
    there is nothing to cool with, and its errors do not grow without bound when
    the mixed air temperature moves outside the fitted range.
    """
    drive = mixed_air - CHILLED_WATER_SUPPLY_C
    return np.column_stack(
        [
            valve * drive,
            valve * valve * drive,
            valve * flow * drive,
            -np.ones_like(valve),
        ]
    )


# ---------------------------------------------------------------------------
# loading and gating
# ---------------------------------------------------------------------------


def load_ahu_frame(
    conn: psycopg.Connection, t_from: datetime, t_to: datetime
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Every point the air-handler baselines need, with usable quality scores.

    Returns the values and a quality frame in which the staleness dimension has
    been discounted. Staleness says a reading stopped changing, not that it is
    wrong: the supply fan sitting at full command for two hours is scored badly
    for not moving, and it is still a correct statement of where the fan is.
    Every reading below 70 in these windows is below 70 for staleness alone, so
    judging on the raw composite would throw away real operating points.
    """
    points = [*AHU_POINTS, RUN_GATE_POINT]
    rows = conn.execute(
        "SELECT time, point_id, value_si, quality_score, quality_flags "
        "  FROM app.measurements "
        " WHERE point_id = ANY(%s) AND time >= %s AND time < %s",
        (sorted(set(points)), t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.DataFrame(), pd.DataFrame()

    frame = pd.DataFrame(
        rows, columns=["time", "point_id", "value_si", "quality_score", "quality_flags"]
    )
    values = frame.pivot_table(
        index="time", columns="point_id", values="value_si", dropna=False
    ).sort_index()
    quality = frame.pivot_table(
        index="time", columns="point_id", values="quality_score", dropna=False
    ).sort_index()
    flags = frame.pivot(
        index="time", columns="point_id", values="quality_flags"
    ).sort_index()
    return values, effective_quality_frame(quality, flags)


def running(values: pd.DataFrame) -> pd.Series:
    """True where the supply fan is turning. See RUN_GATE_POINT on why not status."""
    if RUN_GATE_POINT not in values.columns:
        raise BaselineError(f"run gate needs {RUN_GATE_POINT}, which was not loaded")
    return (values[RUN_GATE_POINT] > RUN_GATE_THRESHOLD).fillna(False)


def usable_for_fit(
    values: pd.DataFrame, quality: pd.DataFrame, needed: tuple[str, ...]
) -> pd.Series:
    """Running, complete, and trustworthy enough to define what healthy means."""
    mask = running(values)
    for point in needed:
        if point not in values.columns:
            raise BaselineError(f"no readings for {point}")
        mask &= values[point].notna()
        if point in quality.columns:
            mask &= (quality[point] >= MIN_FIT_QUALITY).fillna(False)
    return mask


# ---------------------------------------------------------------------------
# fitting
# ---------------------------------------------------------------------------


def _solve(
    baseline_id: str,
    target: str,
    drivers: tuple[str, ...],
    terms: tuple[str, ...],
    design: np.ndarray,
    observed: np.ndarray,
    unit: str,
    t_from: datetime,
    t_to: datetime,
) -> Baseline:
    """Ordinary least squares plus the statistics needed to judge the result.

    The centre is a median and the scale is the plain standard deviation of the
    fit errors, and mixing the two that way is deliberate. The median guards the
    offset: a handful of start-up transients would drag a mean off zero and put a
    permanent bias into every residual measured against it.

    The scale does NOT use a median absolute deviation, which is what the
    constraint residuals in checkpoint 3.5 use. These error distributions are
    extremely peaked -- measured kurtosis runs from 30 to 250 against 3 for a
    normal distribution -- because they mix two regimes. In steady operation the
    model is very accurate, and in the minutes after a fan start it is not. A
    median absolute deviation sees only the steady regime and reports a spread of
    0.55 watts where the standard deviation reports 24. Normalising on the
    robust number would make every ordinary morning start-up a fifty-sigma event
    and drown any real drift underneath it.

    The reason 3.5 goes the other way is that it has no fitted model, so it has
    no fit-error scale available and has to estimate spread from the raw
    residuals themselves, where a single excursion really would dominate.
    """
    if len(observed) < MIN_FIT_SAMPLES:
        raise BaselineError(
            f"{baseline_id}: {len(observed)} usable samples, below the "
            f"{MIN_FIT_SAMPLES} needed to fit"
        )
    coefficients, *_ = np.linalg.lstsq(design, observed, rcond=None)
    predicted = design @ coefficients
    errors = observed - predicted

    total = float(np.sum((observed - observed.mean()) ** 2))
    r_squared = 1.0 - float(np.sum(errors**2)) / total if total > 0 else float("nan")

    return Baseline(
        baseline_id=baseline_id,
        target=target,
        drivers=drivers,
        terms=terms,
        coefficients=coefficients,
        unit=unit,
        r_squared=r_squared,
        residual_sd=max(float(errors.std(ddof=len(coefficients))), MIN_SCALE),
        centre=float(np.median(errors)),
        samples=len(observed),
        fit_from=t_from,
        fit_to=t_to,
    )


FAN_DRIVERS = ("ahu-1.sa_flow", "ahu-1.sf_speed_cmd")
COIL_DRIVERS = ("ahu-1.ma_temp", "ahu-1.chw_valve", "ahu-1.sa_flow")


def fit_fan_power(
    values: pd.DataFrame, quality: pd.DataFrame, t_from: datetime, t_to: datetime
) -> Baseline:
    """Fan electrical power against airflow and fan speed."""
    mask = usable_for_fit(values, quality, ("ahu-1.sf_power", *FAN_DRIVERS))
    rows = values[mask]
    design = fan_power_terms(
        rows["ahu-1.sa_flow"].to_numpy(), rows["ahu-1.sf_speed_cmd"].to_numpy()
    )
    return _solve(
        BASELINE_FAN_POWER,
        "ahu-1.sf_power",
        FAN_DRIVERS,
        FAN_TERMS,
        design,
        rows["ahu-1.sf_power"].to_numpy(),
        "watt",
        t_from,
        t_to,
    )


def fit_supply_air_temp(
    values: pd.DataFrame, quality: pd.DataFrame, t_from: datetime, t_to: datetime
) -> Baseline:
    """Supply air temperature against mixed air, valve position and airflow.

    Fitted on the cooling the coil delivers -- mixed air temperature minus supply
    air temperature -- rather than directly on supply air temperature. They carry
    the same information, but supply air temperature is a controlled variable
    held near its setpoint, so in a winter window it barely varies and an
    R-squared measured against it is dominated by how flat the controller keeps
    it rather than by how good the model is. The coil duty has real range in
    every window, so the statistic means the same thing in all of them.
    """
    mask = usable_for_fit(values, quality, ("ahu-1.sa_temp", *COIL_DRIVERS))
    rows = values[mask]
    valve = rows["ahu-1.chw_valve"].to_numpy()
    if valve.size and float(valve.max() - valve.min()) < MIN_VALVE_RANGE:
        raise BaselineError(
            f"{BASELINE_SUPPLY_AIR_TEMP}: valve position spans only "
            f"{valve.max() - valve.min():.3f} in this window, so coil authority "
            "cannot be identified"
        )
    design = supply_air_terms(
        rows["ahu-1.ma_temp"].to_numpy(), valve, rows["ahu-1.sa_flow"].to_numpy()
    )
    duty = (rows["ahu-1.ma_temp"] - rows["ahu-1.sa_temp"]).to_numpy()
    return _solve(
        BASELINE_SUPPLY_AIR_TEMP,
        "ahu-1.sa_temp",
        COIL_DRIVERS,
        COIL_TERMS,
        design,
        duty,
        "degC",
        t_from,
        t_to,
    )


def fit_ahu_baselines(
    values: pd.DataFrame, quality: pd.DataFrame, t_from: datetime, t_to: datetime
) -> list[Baseline]:
    """Both air-handler baselines from one commissioning window."""
    return [
        fit_fan_power(values, quality, t_from, t_to),
        fit_supply_air_temp(values, quality, t_from, t_to),
    ]


# ---------------------------------------------------------------------------
# prediction
# ---------------------------------------------------------------------------


def predict(baseline: Baseline, values: pd.DataFrame) -> pd.Series:
    """What the baseline says the target point should read, at every instant.

    The coil model predicts how much cooling the coil delivers, so its prediction
    is converted back to a supply air temperature by subtracting that cooling
    from the measured mixed air temperature. The fan model predicts watts
    directly.
    """
    if baseline.baseline_id == BASELINE_FAN_POWER:
        design = fan_power_terms(
            values["ahu-1.sa_flow"].to_numpy(), values["ahu-1.sf_speed_cmd"].to_numpy()
        )
        return pd.Series(design @ baseline.coefficients, index=values.index)

    if baseline.baseline_id == BASELINE_SUPPLY_AIR_TEMP:
        mixed = values["ahu-1.ma_temp"].to_numpy()
        design = supply_air_terms(
            mixed,
            values["ahu-1.chw_valve"].to_numpy(),
            values["ahu-1.sa_flow"].to_numpy(),
        )
        return pd.Series(mixed - design @ baseline.coefficients, index=values.index)

    raise BaselineError(f"no prediction rule for baseline {baseline.baseline_id}")
