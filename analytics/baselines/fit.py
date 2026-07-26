"""Fit what healthy equipment does, as a function of what is being asked of it.

Static thresholds are the documented cause of false-positive fatigue in building
fault detection. The reason is simple: almost every quantity worth watching moves
far more with operating conditions than with equipment health. A supply fan
drawing 900 watts is alarming at half airflow and unremarkable at full airflow,
and a fixed limit fires on the hot afternoon rather than on the failing bearing.
Fitting expected performance against the drivers and watching the leftover is what
turns "the number is high" into "the number is high for these conditions".

Every baseline here is physics-form: the terms come from the equation the
equipment actually obeys, not from throwing polynomials at the data, so the
coefficients mean something and the model does not fly apart just outside the
range it was fitted on.

STRUCTURE. There is one fitter, fit_baseline, and it knows nothing about air
handlers or chillers. What differs between assets is packed into a ModelForm --
how to turn measured points into the quantities the physics is written in, what
the design matrix looks like, and when the model is valid at all. Adding a new
equipment class is a ModelForm and a BaselineSpec, not a change to the fitter.

WHAT IT IS ALLOWED TO KNOW. The fit window is a commissioning window: three
weeks of operation the operator asserts was healthy. That is an ordinary
operational input -- in a real building it is "the unit was serviced on this
date" -- and it is supplied here as configuration in RUNS below. It says nothing
about what fault is coming, or whether one is coming at all; the clean runs carry
exactly the same declaration as the faulted ones. Nothing in this module reads
schema groundtruth, and nothing reads the onset, fault mode or severity waypoints
out of the scenario manifests. It should be said plainly that the windows below
coincide with the pre-onset period of each scenario, because that is how the
scenarios were built.

Run through `make baselines`, which invokes analytics.baselines.residual.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import cache

import numpy as np
import pandas as pd
import psycopg
from rdflib import Graph

from analytics.rules.readings import effective_quality_frame
from analytics.rules.registry import class_closure, to_uri
from model.loader import load_merged_graph

log = logging.getLogger("baselines")

Roles = dict[str, np.ndarray]

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

# Every 120-day run, the assets that have data in it, and the commissioning
# window at the start of each. Stated here as configuration for the reason given
# in the module docstring. Dates are the extent of the data, which is visible
# from the measurements themselves.
COMMISSIONING_DAYS = 21

RUNS: tuple[tuple[str, tuple[str, ...], str, str], ...] = (
    ("ahu_cooling_valve_leakage", ("ahu-1",),
     "2036-02-25T00:00:00+00:00", "2036-06-24T00:00:00+00:00"),
    ("chiller_condenser_fouling", ("chiller-1", "chiller-2", "chiller-3"),
     "2036-05-10T00:00:00+00:00", "2036-09-07T00:00:00+00:00"),
    ("ahu_oa_damper_stuck", ("ahu-1",),
     "2037-01-27T00:00:00+00:00", "2037-05-27T00:00:00+00:00"),
    ("chiller_bypass_valve_leakage", ("chiller-1", "chiller-2", "chiller-3"),
     "2037-05-10T00:00:00+00:00", "2037-09-07T00:00:00+00:00"),
    ("ahu_sat_sensor_drift", ("ahu-1",),
     "2038-05-27T00:00:00+00:00", "2038-09-24T00:00:00+00:00"),
    ("cooling_tower_fouling", ("chiller-1", "chiller-2", "chiller-3"),
     "2038-05-10T00:00:00+00:00", "2038-09-07T00:00:00+00:00"),
    ("clean_ahu", ("ahu-1",),
     "2039-05-27T00:00:00+00:00", "2039-09-24T00:00:00+00:00"),
    ("clean_chiller", ("chiller-1", "chiller-2", "chiller-3"),
     "2039-05-10T00:00:00+00:00", "2039-09-07T00:00:00+00:00"),
)

# Kept so checkpoint 4.1's verification still resolves the air-handler runs.
AHU_SPANS: tuple[tuple[str, str, str], ...] = tuple(
    (label, a, b) for label, assets, a, b in RUNS if "ahu-1" in assets
)

# Chilled water supply temperature at the AIR HANDLER's coil, degC. THE AIR
# HANDLER DOES NOT MEASURE IT. The LBNL single-duct dataset publishes 30 columns
# and not one is water side -- the coil is instrumented with a valve position and
# nothing else. The coil model needs a cold-side temperature to have a driving
# temperature difference at all, so a constant design value stands in for it.
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

# Nominal chiller capacity in tons of refrigeration, used to turn delivered
# cooling into a part load ratio. THE FIT IS INVARIANT TO THIS NUMBER -- part
# load ratio is delivered tons divided by it, so changing it rescales the
# coefficients and leaves every prediction and residual identical. It is here so
# the fitted coefficients read as fractions of capacity rather than as tons.
# Observed load reaches 138 tons on chiller-1 and 154 on chiller-2, so the ratio
# occasionally exceeds one, which is normal for a plate rating.
CHILLER_DESIGN_TONS = 150.0

WATER_DENSITY = 997.0  # kg/m3
WATER_SPECIFIC_HEAT = 4184.0  # J/(kg K)
WATTS_PER_TON = 3516.85  # one ton of refrigeration

# Below this the chiller is barely loaded and every per-ton quantity is dominated
# by dividing through a small number. Matches analytics/rules/chiller.py.
MIN_EVALUABLE_TONS = 20.0

# Readings this untrustworthy are excluded from the FIT, so a dead sensor cannot
# define what healthy looks like. Residuals are still computed for them later and
# stored with the low score attached, so the exclusion is visible rather than
# silent. Matches the gate the rule engine uses.
MIN_FIT_QUALITY = 70

# A fit on fewer points than this is refused. Three weeks of five-minute data is
# a few thousand running samples, so this is a floor against a window that is
# mostly missing, not a real constraint. It does bite once: chiller-3 runs for 9
# samples in the commissioning window and is correctly refused.
MIN_FIT_SAMPLES = 200

# Floor on the fitted spread, so a baseline that happens to fit almost perfectly
# cannot turn rounding noise into enormous normalised values.
MIN_SCALE = 1e-9


class BaselineError(RuntimeError):
    """A baseline could not be fitted from the window it was given."""


# ---------------------------------------------------------------------------
# the generic pieces
# ---------------------------------------------------------------------------


def _identity_roles(roles: Roles) -> Roles:
    return roles


@dataclass(frozen=True)
class ModelForm:
    """One physics form: how to build a model, and when it is allowed to apply.

    Everything asset-specific lives in here, so the fitter below can stay generic.
    The four callables run in this order:

      derive        measured point values -> the quantities the physics is
                    written in. Lift and part load ratio are not sensors; they
                    are arithmetic over sensors, and this is where that happens.
      evaluable     which instants the model is meaningful at, beyond the run
                    gate. A chiller at three tons has a meaningless efficiency.
      fit_quantity  what to regress on, which is not always the target point. The
                    cooling coil regresses on the cooling it delivers rather than
                    on the supply air temperature it produces.
      to_target     converts a prediction of that quantity back into a prediction
                    of the target point, so the stored residual is always in the
                    units of a real sensor.
    """

    name: str
    terms: tuple[str, ...]
    unit: str
    design: Callable[[Roles], np.ndarray]
    # Points that must all exceed their threshold for the model to apply.
    gates: tuple[tuple[str, float], ...] = ()
    # Points that must all stay AT OR BELOW their threshold. Needed because some
    # models describe a component in a specific commanded state -- what the coil
    # does with its valve shut is a different model from what it does modulating.
    ceilings: tuple[tuple[str, float], ...] = ()
    derive: Callable[[Roles], Roles] = _identity_roles
    evaluable: Callable[[Roles], np.ndarray] | None = None
    fit_quantity: Callable[[np.ndarray, Roles], np.ndarray] | None = None
    to_target: Callable[[np.ndarray, Roles], np.ndarray] | None = None


@dataclass(frozen=True)
class BaselineSpec:
    """One baseline to fit, written with {asset} where the asset id goes."""

    form: ModelForm
    target: str
    drivers: Mapping[str, str]

    def resolve(self, asset_id: str) -> tuple[str, dict[str, str], tuple[str, ...]]:
        """Substitute a concrete asset into the target, drivers and gates."""
        target = self.target.format(asset=asset_id)
        drivers = {role: p.format(asset=asset_id) for role, p in self.drivers.items()}
        gates = tuple(
            p.format(asset=asset_id)
            for p, _ in (*self.form.gates, *self.form.ceilings)
        )
        return target, drivers, gates


@dataclass(frozen=True)
class Baseline:
    """One fitted model, and everything needed to judge and reuse it."""

    baseline_id: str
    asset_id: str
    form: ModelForm
    target: str  # point id the model predicts
    drivers: tuple[str, ...]  # point ids it predicts from
    driver_roles: Mapping[str, str] = field(compare=False, default_factory=dict)
    coefficients: np.ndarray = field(default_factory=lambda: np.empty(0))
    r_squared: float = float("nan")
    residual_sd: float = float("nan")  # sd of the fit errors; also the scale
    centre: float = 0.0  # robust centre of the fit errors, subtracted before scaling
    samples: int = 0
    fit_from: datetime | None = None
    fit_to: datetime | None = None

    @property
    def terms(self) -> tuple[str, ...]:
        return self.form.terms

    @property
    def unit(self) -> str:
        return self.form.unit

    def describe(self) -> str:
        return "  ".join(
            f"{name}={value:+.4g}"
            for name, value in zip(self.form.terms, self.coefficients, strict=True)
        )


# ---------------------------------------------------------------------------
# physics forms -- air handler
# ---------------------------------------------------------------------------

FAN_TERMS = ("a_speed^3", "b_speed^2*flow", "c_speed*flow^2")


def fan_power_design(roles: Roles) -> np.ndarray:
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
    flow, speed = roles["flow"], roles["speed"]
    return np.column_stack([speed**3, speed**2 * flow, speed * flow**2])


COIL_TERMS = ("valve_authority", "valve_curvature", "flow_dilution", "fan_temp_rise_K")


def coil_design(roles: Roles) -> np.ndarray:
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
    valve, flow = roles["valve"], roles["flow"]
    drive = roles["mixed_air"] - CHILLED_WATER_SUPPLY_C
    return np.column_stack(
        [valve * drive, valve * valve * drive, valve * flow * drive, -np.ones_like(valve)]
    )


def coil_fit_quantity(observed: np.ndarray, roles: Roles) -> np.ndarray:
    """Regress on the cooling the coil delivers, not on the temperature it makes.

    The two carry identical information, but supply air temperature is a
    controlled variable pinned near setpoint, so in a winter window it barely
    varies and an R-squared measured against it reports how flat the controller
    holds it rather than how good the model is. The same fit scores 0.859 against
    supply air temperature and 0.994 against coil duty in the February window.
    """
    return roles["mixed_air"] - observed


def coil_to_target(predicted: np.ndarray, roles: Roles) -> np.ndarray:
    """Turn predicted cooling back into a predicted supply air temperature."""
    return roles["mixed_air"] - predicted


FAN_SIMILARITY = ModelForm(
    name="fan-similarity",
    terms=FAN_TERMS,
    unit="watt",
    design=fan_power_design,
    # The supply fan is running when its speed command is off its stop. NOT
    # ahu-1.sf_status, which despite its name is not a fan status: it is byte for
    # byte identical to ahu-1.occupancy across all 138,240 samples of the record,
    # and the fan runs during morning pull-down while it still reads zero --
    # 7,686 samples, 5.6 percent of the record. Gating on it would drop every
    # start-up and every after-hours run out of the fit.
    gates=(("{asset}.sf_speed_cmd", 0.05),),
)

COIL_EFFECTIVENESS = ModelForm(
    name="coil-effectiveness",
    terms=COIL_TERMS,
    unit="degC",
    design=coil_design,
    gates=(("{asset}.sf_speed_cmd", 0.05),),
    fit_quantity=coil_fit_quantity,
    to_target=coil_to_target,
)


SHUT_VALVE_TERMS = ("fan_temp_rise_K",)


def shut_valve_design(roles: Roles) -> np.ndarray:
    """Design matrix for supply air temperature with the coil valve commanded shut.

    A separate model from the coil effectiveness one, restricted by its ceiling
    gate to instants where the valve is commanded closed. In that state the coil
    should do nothing at all, so the only thing between mixed air and supply air
    is the heat the fan adds, and the model is a single constant: supply air is
    mixed air plus a fixed rise.

    That is the whole point. Because the model says the coil delivers ZERO
    cooling, any cooling that appears has nowhere to hide: it shows up directly as
    supply air colder than predicted, which is what a valve that will not seat
    does. The coil effectiveness model cannot serve here, because it is driven by
    the valve POSITION, and in this dataset a leaking valve honestly reports
    itself as 10 percent open -- so that model explains the leak away as normal
    cooling from a partly open valve.

    One parameter, no airflow term. Airflow was tried and earns nothing: with the
    valve shut it moves R-squared by 0.003 to 0.099 depending on the window,
    because there is almost no variance left to explain once the coil is out of
    the picture. A term that explains a third of a percent is decoration.
    """
    return np.ones((len(roles["mixed_air"]), 1))


SHUT_VALVE_SUPPLY_AIR = ModelForm(
    name="shut-valve-supply-air",
    terms=SHUT_VALVE_TERMS,
    unit="degC",
    design=shut_valve_design,
    gates=(("{asset}.sf_speed_cmd", 0.05),),
    ceilings=(("{asset}.chw_valve_cmd", 0.02),),
    fit_quantity=coil_fit_quantity,
    to_target=coil_to_target,
)


# ---------------------------------------------------------------------------
# physics forms -- chiller
# ---------------------------------------------------------------------------

CHILLER_TERMS = (
    "intercept",
    "plr", "plr^2",
    "lift", "lift^2",
    "chws", "chws^2",
    "plr*lift", "plr*chws", "lift*chws",
)


def chiller_derive(roles: Roles) -> Roles:
    """Turn the four water-side sensors into the quantities the physics uses.

    None of part load ratio, lift or delivered cooling is a sensor. Delivered
    cooling is the chilled water flow times the temperature it gained crossing
    the evaporator, converted to tons of refrigeration; part load ratio is that
    divided by the machine's nominal capacity. Lift is the temperature gap the
    compressor has to push against -- leaving condenser water minus leaving
    chilled water -- and it is the single largest thing that changes how much
    power a healthy chiller draws, which is exactly why a fixed efficiency
    threshold flags every hot afternoon.
    """
    tons = (
        roles["chw_flow"]
        * WATER_DENSITY
        * WATER_SPECIFIC_HEAT
        * (roles["chw_return"] - roles["chw_supply"])
        / WATTS_PER_TON
    )
    derived = {
        **roles,
        "tons": tons,
        "plr": tons / CHILLER_DESIGN_TONS,
        "chws": roles["chw_supply"],
    }
    # Lift needs the leaving condenser water, which the efficiency model reads as
    # a driver and the condenser model PREDICTS. It is therefore only derivable
    # for the former, and the latter never asks for it.
    if "cdw_leaving" in roles:
        derived["lift"] = roles["cdw_leaving"] - roles["chw_supply"]
    return derived


def chiller_evaluable(roles: Roles) -> np.ndarray:
    """A barely loaded chiller has no meaningful efficiency."""
    return roles["tons"] >= MIN_EVALUABLE_TONS


def chiller_design(roles: Roles) -> np.ndarray:
    """Design matrix for chiller power against load, lift and chilled water.

    A full quadratic in the three drivers: each on its own, each squared, and
    each pair multiplied together. That is the standard shape of a manufacturer's
    chiller performance map, and the cross terms are the physics rather than
    decoration -- the power cost of an extra kelvin of lift depends on how loaded
    the machine is, which is precisely the plr*lift term.
    """
    plr, lift, chws = roles["plr"], roles["lift"], roles["chws"]
    return np.column_stack(
        [
            np.ones_like(plr),
            plr, plr * plr,
            lift, lift * lift,
            chws, chws * chws,
            plr * lift, plr * chws, lift * chws,
        ]
    )


CONDENSER_TERMS = (
    "intercept",
    "plr", "plr^2",
    "cdwe", "cdwe^2",
    "chws", "chws^2",
    "plr*cdwe", "plr*chws", "cdwe*chws",
)


def condenser_design(roles: Roles) -> np.ndarray:
    """Design matrix for the temperature the condenser water leaves at.

    This is the closest thing this plant supports to a condenser approach
    temperature, which is the textbook fouling indicator and is not measurable
    here: approach is refrigerant saturation temperature minus water temperature,
    and there is no refrigerant instrumentation anywhere in the dataset.

    What is measurable is the water side of the same heat exchanger. For a given
    load, a given entering water temperature and a given chilled water
    temperature, a clean condenser leaves the water at a predictable temperature.
    Fouling insulates the tubes, so rejecting the same heat needs a hotter
    refrigerant, condensing pressure rises, and the water leaves warmer than the
    clean machine would have left it. The residual is therefore the excess lift
    the compressor is working against, which is the consequence of fouling that
    actually costs money.

    Entering condenser water is a driver rather than an output because it is set
    by the cooling tower, not by the chiller. Holding it fixed is what stops this
    residual from moving when the TOWER fouls -- which matters, because tower
    fouling is the fault this project holds out for Task 8, and an indicator that
    moved on it would be reporting the wrong machine.
    """
    plr, cdwe, chws = roles["plr"], roles["cdw_entering"], roles["chws"]
    return np.column_stack(
        [
            np.ones_like(plr),
            plr, plr * plr,
            cdwe, cdwe * cdwe,
            chws, chws * chws,
            plr * cdwe, plr * chws, cdwe * chws,
        ]
    )


CHILLER_EFFICIENCY = ModelForm(
    name="chiller-efficiency",
    terms=CHILLER_TERMS,
    unit="watt",
    design=chiller_design,
    # Chillers carry a power test as well as a status test because chiller-1's
    # status point reads 1 for the entire year -- on its own it would never gate
    # anything. Matches the run gates in analytics/rules/constraints.py.
    gates=(("{asset}.status", 0.5), ("{asset}.power", 1000.0)),
    derive=chiller_derive,
    evaluable=chiller_evaluable,
)

CONDENSER_HEAT_REJECTION = ModelForm(
    name="condenser-heat-rejection",
    terms=CONDENSER_TERMS,
    unit="degC",
    design=condenser_design,
    gates=(("{asset}.status", 0.5), ("{asset}.power", 1000.0)),
    derive=chiller_derive,
    evaluable=chiller_evaluable,
)


# ---------------------------------------------------------------------------
# the catalogue, keyed by Brick class
# ---------------------------------------------------------------------------

# Which baselines belong to which kind of equipment. Keyed by Brick class rather
# than by asset id for the same reason the rule registry in checkpoint 3.2 is:
# three chillers get one entry, not three, and a fourth chiller added to the
# building needs a row in app.assets and nothing here.
BASELINE_CATALOGUE: dict[str, tuple[BaselineSpec, ...]] = {
    "brick:Air_Handling_Unit": (
        BaselineSpec(
            form=FAN_SIMILARITY,
            target="{asset}.sf_power",
            drivers={"flow": "{asset}.sa_flow", "speed": "{asset}.sf_speed_cmd"},
        ),
        BaselineSpec(
            form=COIL_EFFECTIVENESS,
            target="{asset}.sa_temp",
            drivers={
                "mixed_air": "{asset}.ma_temp",
                "valve": "{asset}.chw_valve",
                "flow": "{asset}.sa_flow",
            },
        ),
        BaselineSpec(
            form=SHUT_VALVE_SUPPLY_AIR,
            target="{asset}.sa_temp",
            drivers={"mixed_air": "{asset}.ma_temp"},
        ),
    ),
    "brick:Chiller": (
        BaselineSpec(
            form=CHILLER_EFFICIENCY,
            target="{asset}.power",
            drivers={
                "chw_supply": "{asset}.chw_supply_temp",
                "chw_return": "{asset}.chw_return_temp",
                "chw_flow": "{asset}.chw_flow",
                "cdw_leaving": "{asset}.cdw_leaving_temp",
            },
        ),
        BaselineSpec(
            form=CONDENSER_HEAT_REJECTION,
            target="{asset}.cdw_leaving_temp",
            drivers={
                "chw_supply": "{asset}.chw_supply_temp",
                "chw_return": "{asset}.chw_return_temp",
                "chw_flow": "{asset}.chw_flow",
                "cdw_entering": "{asset}.cdw_entering_temp",
            },
        ),
    ),
}


def asset_classes(conn: psycopg.Connection) -> dict[str, str]:
    """Brick class of every asset, straight from the relational catalogue."""
    return dict(conn.execute("SELECT asset_id, brick_class FROM app.assets").fetchall())


@cache
def _taxonomy() -> Graph:
    """Brick's own subclass and equivalence edges, vendored in checkpoint 3.2."""
    graph, _ = load_merged_graph()
    return graph


def specs_for(brick_class: str) -> tuple[BaselineSpec, ...]:
    """Every baseline declared for this class or any class it is a kind of.

    Resolved through Brick's taxonomy rather than by string equality, using the
    same closure the rule registry dispatches on. This is not pedantry: the
    database records the air handler as brick:AHU and the catalogue above is
    written against brick:Air_Handling_Unit, which Brick declares equivalent in
    one direction only. String matching silently fits nothing, which is exactly
    what it did on the first run of this checkpoint.
    """
    ancestry = class_closure(_taxonomy(), to_uri(brick_class))
    out: tuple[BaselineSpec, ...] = ()
    for declared, specs in BASELINE_CATALOGUE.items():
        if to_uri(declared) in ancestry:
            out += specs
    return out


# ---------------------------------------------------------------------------
# loading and gating
# ---------------------------------------------------------------------------


def load_points(
    conn: psycopg.Connection, point_ids: list[str], t_from: datetime, t_to: datetime
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Values and usable quality scores for a named set of points over a window.

    The quality frame returned has the staleness dimension discounted. Staleness
    says a reading stopped changing, not that it is wrong: the supply fan sitting
    at full command for two hours is scored badly for not moving, and it is still
    a correct statement of where the fan is. Every reading below 70 in these
    windows is below 70 for staleness alone, so judging on the raw composite
    would throw away real operating points.
    """
    rows = conn.execute(
        "SELECT time, point_id, value_si, quality_score, quality_flags "
        "  FROM app.measurements "
        " WHERE point_id = ANY(%s) AND time >= %s AND time < %s",
        (sorted(set(point_ids)), t_from, t_to),
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
    flags = frame.pivot(index="time", columns="point_id", values="quality_flags").sort_index()
    return values, effective_quality_frame(quality, flags)


def points_needed(spec: BaselineSpec, asset_id: str) -> list[str]:
    """Every point one baseline reads, including its run gate."""
    target, drivers, gates = spec.resolve(asset_id)
    return [target, *drivers.values(), *gates]


def gate_mask(form: ModelForm, asset_id: str, values: pd.DataFrame) -> pd.Series:
    """True where every run gate and ceiling this form declares is satisfied."""
    mask = pd.Series(True, index=values.index)
    for raw_point, threshold in form.gates:
        point = raw_point.format(asset=asset_id)
        if point not in values.columns:
            raise BaselineError(f"run gate needs {point}, which was not loaded")
        mask &= (values[point] > threshold).fillna(False)
    for raw_point, ceiling in form.ceilings:
        point = raw_point.format(asset=asset_id)
        if point not in values.columns:
            raise BaselineError(f"ceiling gate needs {point}, which was not loaded")
        mask &= (values[point] <= ceiling).fillna(False)
    return mask


def role_arrays(drivers: Mapping[str, str], values: pd.DataFrame) -> Roles:
    """Pull each driver point out under the role name the physics calls it."""
    return {role: values[point].to_numpy(dtype=float) for role, point in drivers.items()}


def applicable(
    baseline_or_spec: Baseline | BaselineSpec,
    asset_id: str,
    target: str,
    drivers: Mapping[str, str],
    values: pd.DataFrame,
    quality: pd.DataFrame | None,
) -> tuple[pd.Series, Roles]:
    """Which instants this model can be evaluated at, and the derived drivers.

    Three gates in order: the equipment is running, every reading it needs is
    present, and the physics is meaningful. When a quality frame is supplied a
    fourth applies -- every input trustworthy enough to define healthy -- which
    is used when fitting and not when predicting.
    """
    form = baseline_or_spec.form
    mask = gate_mask(form, asset_id, values)
    for point in (target, *drivers.values()):
        if point not in values.columns:
            raise BaselineError(f"no readings for {point}")
        mask &= values[point].notna()
        if quality is not None and point in quality.columns:
            mask &= (quality[point] >= MIN_FIT_QUALITY).fillna(False)

    roles = form.derive(role_arrays(drivers, values))
    if form.evaluable is not None:
        with np.errstate(invalid="ignore"):
            mask &= pd.Series(form.evaluable(roles), index=values.index).fillna(False)
    return mask, roles


# ---------------------------------------------------------------------------
# the fitter
# ---------------------------------------------------------------------------


def fit_baseline(
    conn: psycopg.Connection,
    asset_id: str,
    target_point: str,
    driver_points: Mapping[str, str],
    window: tuple[datetime, datetime],
    form: ModelForm,
) -> Baseline:
    """Fit one baseline for one asset over one window.

    This is the only fitter. It reads the points it is told to read, asks the
    model form to turn them into whatever quantities the physics is written in,
    solves ordinary least squares, and measures the result. Nothing in it knows
    what an air handler or a chiller is.

    driver_points maps a ROLE the physics uses -- "lift", "valve", "mixed_air" --
    to the point id that supplies it, which is what lets one form serve three
    chillers and would let it serve a fourth.

    Two arguments beyond the four the checkpoint named are structurally
    unavoidable: a connection, because the window has to be read from somewhere,
    and the model form, because there is no way to guess from a point id whether
    a fan similarity law or a chiller performance map is wanted.

    The centre returned is a median and the scale is the plain standard deviation
    of the fit errors, and mixing the two is deliberate. The median guards the
    offset: a handful of start-up transients would drag a mean off zero and put a
    permanent bias into every residual measured against it. The scale does NOT
    use a median absolute deviation, which is what the constraint residuals in
    checkpoint 3.5 use. These error distributions are extremely peaked --
    measured kurtosis runs from 30 to 250 against 3 for a normal distribution --
    because they mix two regimes: in steady operation the model is very accurate,
    and in the minutes after a start it is not. A median absolute deviation sees
    only the steady regime and reports a spread of 0.55 watts where the standard
    deviation reports 24. Normalising on the robust number would make every
    ordinary morning start-up a fifty-sigma event and drown any real drift
    underneath it. Checkpoint 3.5 goes the other way because it has no fitted
    model, so no fit-error scale is available and spread has to come from the raw
    residuals, where a single excursion really would dominate.
    """
    t_from, t_to = window
    baseline_id = f"{target_point}.{form.name}"

    spec = BaselineSpec(form=form, target=target_point, drivers=dict(driver_points))
    values, quality = load_points(
        conn,
        [
            target_point,
            *driver_points.values(),
            *(p.format(asset=asset_id) for p, _ in (*form.gates, *form.ceilings)),
        ],
        t_from,
        t_to,
    )
    if values.empty:
        raise BaselineError(f"{baseline_id}: no readings in {t_from} .. {t_to}")

    mask, roles = applicable(spec, asset_id, target_point, driver_points, values, quality)
    rows = mask.to_numpy()
    if rows.sum() < MIN_FIT_SAMPLES:
        raise BaselineError(
            f"{baseline_id}: {int(rows.sum())} usable samples in the window, "
            f"below the {MIN_FIT_SAMPLES} needed to fit"
        )

    fit_roles = {role: array[rows] for role, array in roles.items()}
    observed = values[target_point].to_numpy(dtype=float)[rows]
    regressand = (
        observed if form.fit_quantity is None else form.fit_quantity(observed, fit_roles)
    )

    design = form.design(fit_roles)
    coefficients, *_ = np.linalg.lstsq(design, regressand, rcond=None)
    errors = regressand - design @ coefficients

    total = float(np.sum((regressand - regressand.mean()) ** 2))
    return Baseline(
        baseline_id=baseline_id,
        asset_id=asset_id,
        form=form,
        target=target_point,
        drivers=tuple(driver_points.values()),
        driver_roles=dict(driver_points),
        coefficients=coefficients,
        r_squared=1.0 - float(np.sum(errors**2)) / total if total > 0 else float("nan"),
        residual_sd=max(float(errors.std(ddof=len(coefficients))), MIN_SCALE),
        centre=float(np.median(errors)),
        samples=int(rows.sum()),
        fit_from=t_from,
        fit_to=t_to,
    )


def fit_asset_baselines(
    conn: psycopg.Connection,
    asset_id: str,
    brick_class: str,
    window: tuple[datetime, datetime],
) -> tuple[list[Baseline], list[str]]:
    """Every baseline this asset's Brick class declares. Refusals are returned.

    A baseline that cannot be fitted is not an error to abort on -- chiller-3
    runs for nine samples in the commissioning window and genuinely cannot be
    modelled -- so the refusal is collected and reported rather than raised.
    """
    fitted: list[Baseline] = []
    refused: list[str] = []
    for spec in specs_for(brick_class):
        target, drivers, _ = spec.resolve(asset_id)
        try:
            fitted.append(
                fit_baseline(conn, asset_id, target, drivers, window, spec.form)
            )
        except BaselineError as exc:
            refused.append(str(exc))
    return fitted, refused


def commissioning_window(t_from: datetime) -> tuple[datetime, datetime]:
    return t_from, t_from + timedelta(days=COMMISSIONING_DAYS)


# ---------------------------------------------------------------------------
# prediction
# ---------------------------------------------------------------------------


def predict(baseline: Baseline, values: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """What the baseline says the target point should read, and where it applies.

    Returns the prediction alongside the mask of instants the model is valid at,
    so a caller never has to re-derive the run gate or the evaluability test that
    the model form already declares.
    """
    mask, roles = applicable(
        baseline, baseline.asset_id, baseline.target, baseline.driver_roles, values, None
    )
    with np.errstate(invalid="ignore"):
        predicted = baseline.form.design(roles) @ baseline.coefficients
        if baseline.form.to_target is not None:
            predicted = baseline.form.to_target(predicted, roles)
    return pd.Series(predicted, index=values.index), mask
