"""What the air handler is trying to do right now.

Nearly every air-side fault rule is only meaningful in some operating modes. A
cooling coil that is fully open is normal on a hot afternoon and alarming when
the outside air is at 5 degC and the economizer should be doing the work for
free. Evaluating rules without knowing the mode is the single largest source of
false alarms in air handler fault detection, which is why the APAR rules in the
next checkpoint are organised by mode rather than by symptom.

Five modes, from the control signals:

    unoccupied                             nobody is in the building
    heating                                the unit cannot reach its supply
                                           setpoint and needs heat added
    free cooling                           cooling with outside air alone
    mechanical cooling with economizer     the chiller is running AND the unit is
                                           taking extra outside air to help
    mechanical cooling without economizer  the chiller is running on the minimum
                                           outside air the building needs to
                                           breathe

A sixth value, unknown, exists for instants where a control signal is missing or
too untrustworthy to read. It is not a mode the equipment can be in; it is this
module declining to guess, which matters because a wrong mode silently sends a
rule down the wrong branch.

THIS AIR HANDLER HAS NO HEATING COIL. The LBNL single-duct unit is instrumented
with a chilled water valve and nothing else -- heat is added downstream at the
terminal boxes, which the dataset does not instrument either. So heating is
inferred as a DEMAND rather than observed as an action: the cooling coil is shut
and the air arriving at the coil is already colder than the supply setpoint, so
the only way the setpoint gets met is if something further down adds heat.
"""

from __future__ import annotations

from enum import Enum

import numpy as np
import pandas as pd


class Mode(str, Enum):
    """The five operating modes, plus an explicit refusal to guess."""

    UNOCCUPIED = "unoccupied"
    HEATING = "heating"
    FREE_COOLING = "free_cooling"
    MECHANICAL_COOLING_WITH_ECONOMIZER = "mechanical_cooling_with_economizer"
    MECHANICAL_COOLING_NO_ECONOMIZER = "mechanical_cooling_without_economizer"
    UNKNOWN = "unknown"


# The points the classification reads, by the role it uses them for.
SIGNALS: dict[str, str] = {
    "occupancy": "ahu-1.occupancy",
    "fan_status": "ahu-1.sf_status",
    "cooling_valve": "ahu-1.chw_valve",
    "outside_air_damper": "ahu-1.oa_damper",
    "mixed_air_temp": "ahu-1.ma_temp",
    "supply_air_setpoint": "ahu-1.sa_temp_spt",
}

# --------------------------------------------------------------------------
# thresholds, all measured from the fault-free year rather than assumed
# --------------------------------------------------------------------------

# Valve position above which the chiller is doing real work. The valve reads a
# hair above zero from float noise even when shut, and 1% of a valve's travel
# moves no meaningful amount of water.
COOLING_VALVE_OPEN = 0.01

# The outdoor air damper position the control holds when it is NOT economizing --
# the minimum fresh air the building needs for ventilation. Read straight off the
# data rather than assumed: across the occupied hours of the fault-free year the
# damper sits at exactly 0.10 for 33,615 samples, with the next most common
# position two orders of magnitude rarer. It is a hard control floor, not a
# tendency.
MINIMUM_OUTSIDE_AIR = 0.10

# How far above that floor the damper must be before the unit counts as
# economizing. 0.02 clears the handful of samples that jitter to 0.11 and 0.12
# around the floor without swallowing any genuine economizer action, which runs
# to 1.0.
ECONOMIZER_MARGIN = 0.02

# How far below the supply setpoint the mixed air must sit before the unit counts
# as needing heat. Without a deadband the mode would chatter every time the mixed
# air brushed the setpoint. 0.5 degC is under a tenth of the range the mixed air
# covers in a year and comfortably larger than the sensor's own jitter.
HEATING_DEADBAND_C = 0.5

# Quality below which a control signal is not trusted and the mode is unknown.
# Matches the rule registry's default, deliberately: a mode derived from a
# reading the rules themselves would refuse is worth no more than the reading.
MIN_SIGNAL_QUALITY = 70


def classify_frame(
    signals: pd.DataFrame, quality: pd.DataFrame | None = None
) -> pd.Series:
    """Classify every instant in a frame of control signals.

    `signals` has one column per key of SIGNALS. `quality`, if given, has the
    same shape and holds each reading's trust score; any instant where a needed
    signal falls below the bar comes back unknown.

    Vectorised rather than looped because the rule engine classifies whole
    seasons at a time -- a year at the five-minute cadence is 105,000 instants
    per asset, and the mode has to be known at every one of them before a single
    rule runs.

    The tests are applied in precedence order and the first match wins:

      1. nobody in, or the fan is off        -> unoccupied
      2. cooling coil shut, mixed air cold   -> heating
      3. cooling coil shut                   -> free cooling
      4. coil open, damper above the floor   -> mechanical cooling with economizer
      5. coil open                           -> mechanical cooling, minimum air

    Order matters at step 3: a shut coil with the damper on its floor and no
    heating demand is a unit coasting inside its deadband, and it is called free
    cooling because the honest statement is that no mechanical cooling is being
    used. That case is 107 samples in a year, 0.2% of occupied time.
    """
    index = signals.index
    missing = [name for name in SIGNALS if name not in signals.columns]
    if missing:
        raise KeyError(f"mode classification needs these signals: {missing}")

    usable = pd.Series(True, index=index)
    for name in SIGNALS:
        usable &= signals[name].notna()
        if quality is not None and name in quality.columns:
            usable &= quality[name].fillna(-1) >= MIN_SIGNAL_QUALITY

    occupied = (signals["occupancy"] >= 0.5) & (signals["fan_status"] >= 0.5)
    cooling = signals["cooling_valve"] > COOLING_VALVE_OPEN
    economizing = signals["outside_air_damper"] > MINIMUM_OUTSIDE_AIR + ECONOMIZER_MARGIN
    wants_heat = signals["mixed_air_temp"] < signals["supply_air_setpoint"] - HEATING_DEADBAND_C

    mode = np.where(
        ~occupied,
        Mode.UNOCCUPIED.value,
        np.where(
            ~cooling,
            np.where(wants_heat, Mode.HEATING.value, Mode.FREE_COOLING.value),
            np.where(
                economizing,
                Mode.MECHANICAL_COOLING_WITH_ECONOMIZER.value,
                Mode.MECHANICAL_COOLING_NO_ECONOMIZER.value,
            ),
        ),
    )
    return pd.Series(
        np.where(usable.to_numpy(), mode, Mode.UNKNOWN.value), index=index, name="mode"
    )


def classify(
    occupancy: float,
    fan_status: float,
    cooling_valve: float,
    outside_air_damper: float,
    mixed_air_temp: float,
    supply_air_setpoint: float,
) -> Mode:
    """Classify a single instant. Same logic as classify_frame, one row of it."""
    frame = pd.DataFrame(
        {
            "occupancy": [occupancy],
            "fan_status": [fan_status],
            "cooling_valve": [cooling_valve],
            "outside_air_damper": [outside_air_damper],
            "mixed_air_temp": [mixed_air_temp],
            "supply_air_setpoint": [supply_air_setpoint],
        }
    )
    return Mode(classify_frame(frame).iloc[0])


def transitions(modes: pd.Series) -> pd.DataFrame:
    """Every point at which the mode changes, with what it changed to.

    Used to check the classification against physical sense: an air handler
    should move between modes a handful of times a day as the building warms and
    the occupancy schedule turns over, not every few minutes. A high count is the
    signature of a threshold sitting inside the noise of its signal.
    """
    changed = modes.ne(modes.shift())
    changed.iloc[0] = False
    at = modes.index[changed]
    return pd.DataFrame(
        {"at": at, "from_mode": modes.shift()[changed].to_numpy(), "to_mode": modes[changed].to_numpy()}
    )
