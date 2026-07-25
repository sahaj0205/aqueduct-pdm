"""Six rules from the NIST APAR set, evaluated by operating mode.

APAR -- Air Handling Unit Performance Assessment Rules -- is 28 expert rules
derived from mass and energy balances across an air handler, published by NIST
(House, Vaezi-Nejad and Whitcomb 2001; Schein and Bushby, NISTIR 7365, 2006).
Each rule is a logical statement that, if true, means something is wrong. The
balances differ by operating mode, so a different subset applies in each.

Rule numbers, expressions and every threshold below are taken from Table 2.1 and
the reference implementation in NISTIR 7365, not reconstructed from memory.

    Tsa   supply air temperature        Tra   return air temperature
    Tma   mixed air temperature         Toa   outdoor air temperature
    Tsa,s supply air temperature set point
    ucc   cooling coil valve, 0 to 1    ud    outdoor air damper, 0 to 1
    dTsf  temperature rise across the supply fan
    dTrf  temperature rise across the return fan
    et    temperature error threshold   ecc   cooling valve threshold
    ef    outdoor air fraction threshold
    Qoa/Qsa  outdoor air fraction, computed as (Tma - Tra) / (Toa - Tra)


THE SIX IMPLEMENTED
-------------------
  6   Mode 2, cooling with outdoor air
      Tsa > Tra - dTrf + et
      Supply air is warmer than the air coming back from the space. The unit is
      economizing yet delivering air that cannot cool anything.

  7   Mode 2, cooling with outdoor air
      |Tsa - dTsf - Tma| > et
      With no coil active, supply air must equal mixed air plus the heat the fan
      itself adds. Any gap means a coil is moving energy when it should not be --
      this is the rule that sees a chilled water valve leaking through.

  16  Mode 4, mechanical cooling with minimum outdoor air
      Tsa > Tma + dTsf + et
      Air is leaving the cooling coil warmer than it arrived while the chiller is
      supposedly cooling it.

  18  Mode 4, mechanical cooling with minimum outdoor air
      for |Tra - Toa| >= dTmin:  |Qoa/Qsa - (Qoa/Qsa)min| > ef
      The fraction of outdoor air in the mix is not the minimum the unit is set
      to hold. This is the rule that sees an outdoor air damper stuck open or
      shut. It is guarded by dTmin because the fraction is a ratio of temperature
      differences and becomes meaningless when outdoor and return air are close.

  20  Mode 4, mechanical cooling with minimum outdoor air
      |ucc - 1| <= ecc
      The cooling coil valve has run to fully open and stayed there: the unit is
      out of cooling capacity, or is chasing a setpoint it cannot reach.

  27  All occupied modes
      Tma > max(Tra, Toa) + et
      Mixed air is hotter than both of the two streams that make it. No mixture
      can be hotter than its hottest ingredient, so this is a broken mixed air
      sensor or a damper doing something other than what it reports.


WHY THE OTHER TWENTY-TWO DO NOT APPLY HERE
------------------------------------------
  1, 2, 3, 4    Mode 1, heating. This air handler has no heating coil -- the
                LBNL unit carries a chilled water valve and nothing else, and
                the terminal reheat that actually adds heat is not instrumented.
                Rules 3 and 4 read uhc, which does not exist. Rules 1 and 2 are
                arithmetically evaluable but describe a unit that is actively
                heating, which this one cannot do.
  21, 22, 23    Also read uhc. Same reason.
  9, 15         Need Tco, the economizer changeover temperature. The dataset
                does not publish the changeover setpoint, and inventing one would
                make these rules test a guess rather than the equipment.
  10            Mode 3 assumes 100% outdoor air, so mixed air should equal
                outdoor air. Our Mode 3 is "damper above its minimum", which is
                not the same claim, and the rule would fire constantly.
  11, 12, 13, 14  Mode 3. Same expressions as 16, 17, 19 and 20 evaluated in a
                mode this unit spends 4.31% of the year in. They add mode
                coverage but no new physics, and Mode 3 here is the approximate
                one.
  17, 19        Applicable and supported, but redundant against the six chosen:
                17 is rule 6's expression in Mode 4, and 19 is rule 20 plus a
                supply-air condition. 19 would specifically MISS a drifting
                supply air sensor, because a drifting sensor reads at setpoint by
                construction and the extra condition never becomes true.
  24            Requires APAR's Mode 5, "unknown". Our classifier always resolves
                to one of five named modes, so Mode 5 never occurs.
  5, 8          Evaluable, but they test whether the control chose the right mode
                rather than whether the equipment is faulty.
  25            |Tsa - Tsa,s| > et assumes the unit can drive supply air to
                setpoint in both directions. This one only cools, so whenever
                mixed air sits below setpoint with the coil shut it cannot
                correct, and the rule would flag normal operation.
  26            The mirror of 27 and equally sound; dropped only to keep to six.
  28            Counts mode switches per hour. That is a control stability
                measure rather than an equipment fault, and it needs a history
                rather than an instant.

More than six qualify. Among those that do, these six were chosen to span the
modes the unit actually spends its time in and to cover the three air-side
faults this project injects: a leaking cooling coil valve (rule 7), a stuck
outdoor air damper (rule 18) and a drifting supply air sensor (rule 20).
"""

from __future__ import annotations

from analytics.rules.mode import Mode
from analytics.rules.registry import (
    CostEstimate,
    CostUnit,
    RuleContext,
    Verdict,
    rule,
)

# ---------------------------------------------------------------------------
# thresholds
#
# The first block is APAR's own, from the reference implementation in NISTIR
# 7365 section 5. The second is building-specific and measured, which APAR
# explicitly expects: "building operators may need to develop their own
# parameter values".
# ---------------------------------------------------------------------------

EPSILON_T = 2.0  # e_t, degC. Threshold on temperature measurement error.
EPSILON_CC = 0.02  # e_cc, cooling coil valve control signal.
EPSILON_F = 0.30  # e_f, outdoor air fraction.
DELTA_T_MIN = 5.6  # del_t_min, degC. Below this the OA fraction is meaningless.

# Supply fan temperature rise. APAR publishes 1.1 degC as a default; this unit
# measures 0.53. Taken as the difference between supply and mixed air across the
# 17,508 samples of the fault-free year where the cooling coil is shut, so no
# coil is moving heat and the whole difference is the fan. Using the published
# default instead would bias rule 7 by 0.57 degC, a quarter of its threshold, in
# the direction that hides a leaking valve.
DELTA_T_SF = 0.53

# Return fan temperature rise. Cannot be measured -- there is no temperature
# either side of the return fan -- so it is scaled from the supply fan rise by
# the ratio of the two fans' peak power, 512 W against 1622 W. It only appears in
# rule 6, where the 2.0 degC temperature threshold dominates it anyway.
DELTA_T_RF = 0.17

# Minimum outdoor air fraction, (Qoa/Qsa)min.
#
# APAR's reference implementation sets this to the minimum damper position
# divided by 100, i.e. it assumes damper position and outdoor air fraction are
# the same number. On this unit they are not, and not by a little: with the
# damper resting on its 0.10 floor the measured fraction is 0.016, six times
# smaller. Damper position and airflow are related by the pressure drop across a
# partly open blade, which is nowhere near linear.
#
# Measured as (Tma - Tra)/(Toa - Tra) over the 15,910 samples of the fault-free
# year in minimum-outdoor-air cooling where outdoor and return air differ by at
# least dTmin. The spread is very tight -- 0.0155 at the tenth percentile,
# 0.0161 at the ninetieth -- which is what makes it usable as a fixed expectation.
MIN_OA_FRACTION = 0.016

# Air properties for turning a temperature error into an energy cost.
AIR_DENSITY = 1.2  # kg/m3 at room conditions
AIR_SPECIFIC_HEAT = 1005.0  # J/(kg K)

# Points these rules read. The evaluation driver materialises only these.
POINTS_USED = (
    "ahu-1.sa_temp",
    "ahu-1.ma_temp",
    "ahu-1.ra_temp",
    "ahu-1.oa_temp",
    "ahu-1.chw_valve",
    "ahu-1.sa_flow",
)

# APAR's rule delay: how long a condition must hold before it is reported.
RULE_DELAY_MINUTES = 60


def _air_energy_kw(volume_flow: float, delta_t: float) -> float:
    """Heat carried by an air stream, in kW, for a flow in m3/s and a gap in K."""
    return AIR_DENSITY * volume_flow * AIR_SPECIFIC_HEAT * abs(delta_t) / 1000.0


def _severity(exceedance: float, scale: float) -> float:
    """How far past its threshold a rule is, squashed into 0 to 1.

    Scaled so that exceeding the threshold by the threshold again counts as full
    severity. Linear rather than anything cleverer because the health index in a
    later task is what turns these into a trend; this only has to rank two
    simultaneous faults sensibly.
    """
    return max(0.0, min(1.0, exceedance / scale))


# ---------------------------------------------------------------------------
# Mode 2 -- cooling with outdoor air
# ---------------------------------------------------------------------------


@rule(
    id="apar-6",
    applies_to="brick:Air_Handling_Unit",
    modes=[Mode.FREE_COOLING],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def rule_6_supply_warmer_than_return(ctx: RuleContext) -> Verdict:
    """Supply air is warmer than return air while economizing."""
    supply = ctx.value("ahu-1.sa_temp", "supply air temperature")
    ret = ctx.value("ahu-1.ra_temp", "return air temperature")
    flow = ctx.value("ahu-1.sa_flow", "supply air volumetric flow")

    limit = ret - DELTA_T_RF + EPSILON_T
    excess = supply - limit
    return Verdict(
        fired=excess > 0,
        severity=_severity(excess, EPSILON_T),
        cost=CostEstimate(
            CostUnit.COMFORT_DEGREE_HOURS,
            max(0.0, supply - (ret - DELTA_T_RF)),
            "degrees by which the air delivered is warmer than the air returning, "
            "held for an hour",
        ),
        detail=(
            f"supply {supply:.2f} degC against return {ret:.2f} degC; the unit is "
            f"economizing but delivering air {supply - ret:+.2f} degC relative to "
            f"the space, moving {flow:.2f} m3/s of it"
        ),
    )


@rule(
    id="apar-7",
    applies_to="brick:Air_Handling_Unit",
    modes=[Mode.FREE_COOLING],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def rule_7_supply_does_not_match_mixed(ctx: RuleContext) -> Verdict:
    """Supply air does not equal mixed air plus fan heat with both coils shut."""
    supply = ctx.value("ahu-1.sa_temp", "supply air temperature")
    mixed = ctx.value("ahu-1.ma_temp", "mixed air temperature")
    flow = ctx.value("ahu-1.sa_flow", "supply air volumetric flow")

    # With no coil active the only thing between the mixing box and the supply
    # duct is the fan, so this difference should be the fan's own heat.
    gap = supply - DELTA_T_SF - mixed
    exceedance = abs(gap) - EPSILON_T
    cooling_through = -gap  # positive when air is being cooled it should not be

    return Verdict(
        fired=exceedance > 0,
        severity=_severity(exceedance, EPSILON_T),
        cost=CostEstimate(
            CostUnit.ENERGY_KWH,
            _air_energy_kw(flow, gap),
            "chilled water energy being spent on air the economizer was already "
            "cooling for free, for an hour at the current airflow",
        ),
        detail=(
            f"supply {supply:.2f} degC against mixed {mixed:.2f} degC plus "
            f"{DELTA_T_SF:.2f} degC of fan heat, a gap of {gap:+.2f} degC"
            + (
                f"; air is being cooled by {cooling_through:.2f} degC with the "
                f"valve shut, which is a valve passing water"
                if cooling_through > EPSILON_T
                else ""
            )
        ),
    )


# ---------------------------------------------------------------------------
# Mode 4 -- mechanical cooling with minimum outdoor air
# ---------------------------------------------------------------------------


@rule(
    id="apar-16",
    applies_to="brick:Air_Handling_Unit",
    modes=[Mode.MECHANICAL_COOLING_NO_ECONOMIZER],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def rule_16_no_cooling_across_coil(ctx: RuleContext) -> Verdict:
    """Air leaves the cooling coil warmer than it entered."""
    supply = ctx.value("ahu-1.sa_temp", "supply air temperature")
    mixed = ctx.value("ahu-1.ma_temp", "mixed air temperature")
    flow = ctx.value("ahu-1.sa_flow", "supply air volumetric flow")

    limit = mixed + DELTA_T_SF + EPSILON_T
    excess = supply - limit
    return Verdict(
        fired=excess > 0,
        severity=_severity(excess, EPSILON_T),
        cost=CostEstimate(
            CostUnit.ENERGY_KWH,
            _air_energy_kw(flow, supply - (mixed + DELTA_T_SF)),
            "cooling the coil should be delivering but is not, for an hour at the "
            "current airflow",
        ),
        detail=(
            f"supply {supply:.2f} degC against mixed {mixed:.2f} degC plus "
            f"{DELTA_T_SF:.2f} degC of fan heat: the coil is adding "
            f"{supply - mixed - DELTA_T_SF:+.2f} degC while it is meant to be cooling"
        ),
    )


@rule(
    id="apar-18",
    applies_to="brick:Air_Handling_Unit",
    modes=[Mode.MECHANICAL_COOLING_NO_ECONOMIZER],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def rule_18_outdoor_air_fraction_wrong(ctx: RuleContext) -> Verdict:
    """Outdoor air fraction is not the minimum the unit should be holding."""
    mixed = ctx.value("ahu-1.ma_temp", "mixed air temperature")
    ret = ctx.value("ahu-1.ra_temp", "return air temperature")
    outside = ctx.value("ahu-1.oa_temp", "outdoor air temperature")
    flow = ctx.value("ahu-1.sa_flow", "supply air volumetric flow")

    # The fraction is a ratio of temperature differences, so it explodes when the
    # two streams are at similar temperatures. APAR guards it with dTmin, and
    # below that the rule reports nothing rather than reporting noise.
    if abs(ret - outside) < DELTA_T_MIN:
        return Verdict(
            fired=False,
            detail=(
                f"not evaluated: return {ret:.2f} degC and outdoor {outside:.2f} degC "
                f"differ by {abs(ret - outside):.2f} degC, under the {DELTA_T_MIN} degC "
                f"needed for the outdoor air fraction to mean anything"
            ),
        )

    fraction = (mixed - ret) / (outside - ret)
    error = abs(fraction - MIN_OA_FRACTION)
    exceedance = error - EPSILON_F
    excess_fraction = max(0.0, fraction - MIN_OA_FRACTION)

    return Verdict(
        fired=exceedance > 0,
        severity=_severity(exceedance, EPSILON_F),
        cost=CostEstimate(
            CostUnit.ENERGY_KWH,
            _air_energy_kw(flow * excess_fraction, outside - ret),
            "conditioning outdoor air beyond the ventilation minimum, for an hour "
            "at the current airflow and outdoor conditions",
        ),
        detail=(
            f"outdoor air fraction {fraction:.3f} against an expected "
            f"{MIN_OA_FRACTION:.3f}, from mixed {mixed:.2f}, return {ret:.2f} and "
            f"outdoor {outside:.2f} degC"
        ),
    )


@rule(
    id="apar-20",
    applies_to="brick:Air_Handling_Unit",
    modes=[Mode.MECHANICAL_COOLING_NO_ECONOMIZER],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
    # The condition this rule tests IS a flatline: a valve pinned fully open has
    # by definition stopped moving, so the quality layer marks it stale and would
    # otherwise refuse to let the rule read the very signal that is the symptom.
    # The other four quality dimensions still apply -- a valve reading outside 0
    # to 1, or jumping impossibly fast, is still refused.
    staleness_is_evidence=["ahu-1.chw_valve"],
)
def rule_20_cooling_valve_saturated(ctx: RuleContext) -> Verdict:
    """Cooling coil valve has run fully open and stayed there."""
    valve = ctx.value("ahu-1.chw_valve", "cooling coil valve position")
    supply = ctx.value("ahu-1.sa_temp", "supply air temperature")
    flow = ctx.value("ahu-1.sa_flow", "supply air volumetric flow")

    saturated = abs(valve - 1.0) <= EPSILON_CC
    return Verdict(
        fired=saturated,
        # Saturation is a threshold the valve is either at or not, so severity
        # cannot come from how far past it the signal is. It comes instead from
        # how much cooling is riding on a valve with nothing left to give.
        severity=_severity(valve, 1.0) if saturated else 0.0,
        cost=CostEstimate(
            CostUnit.COMFORT_DEGREE_HOURS,
            max(0.0, supply - 12.88),
            "degrees the supply air sits above its design setpoint with the valve "
            "already wide open, held for an hour",
        ),
        detail=(
            f"cooling valve at {valve:.3f} of full travel, supply air "
            f"{supply:.2f} degC, {flow:.2f} m3/s: the unit has no cooling left to "
            f"give and is either short of capacity or chasing a setpoint it cannot "
            f"reach"
        ),
    )


# ---------------------------------------------------------------------------
# All occupied modes
# ---------------------------------------------------------------------------


@rule(
    id="apar-27",
    applies_to="brick:Air_Handling_Unit",
    modes=[
        Mode.HEATING,
        Mode.FREE_COOLING,
        Mode.MECHANICAL_COOLING_WITH_ECONOMIZER,
        Mode.MECHANICAL_COOLING_NO_ECONOMIZER,
    ],
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def rule_27_mixed_air_above_both_sources(ctx: RuleContext) -> Verdict:
    """Mixed air is hotter than both the return and outdoor air feeding it."""
    mixed = ctx.value("ahu-1.ma_temp", "mixed air temperature")
    ret = ctx.value("ahu-1.ra_temp", "return air temperature")
    outside = ctx.value("ahu-1.oa_temp", "outdoor air temperature")

    hottest = max(ret, outside)
    excess = mixed - (hottest + EPSILON_T)
    return Verdict(
        fired=excess > 0,
        severity=_severity(excess, EPSILON_T),
        cost=CostEstimate(
            CostUnit.COMFORT_DEGREE_HOURS,
            max(0.0, mixed - hottest),
            "degrees of impossible temperature rise across the mixing box, held "
            "for an hour",
        ),
        detail=(
            f"mixed {mixed:.2f} degC exceeds the hotter of return {ret:.2f} and "
            f"outdoor {outside:.2f} degC; a mixture cannot be hotter than its "
            f"hottest ingredient, so either the mixed air sensor is wrong or the "
            f"dampers are not where they say they are"
        ),
    )
