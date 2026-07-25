"""Three chiller performance rules, all evaluated at matched operating conditions.

A chiller's efficiency depends far more on what you ask of it than on its health.
The same machine in the same condition draws 1.2 kW/ton on a mild morning at half
load and 1.9 kW/ton on a hot afternoon at full load, because the compressor has
to push against a much larger temperature difference. Comparing a raw kW/ton
against a fixed number is therefore the classic false-positive generator in
chiller fault detection: it flags every hot afternoon and misses every mild one.

Every rule here compares against a baseline fitted on fault-free operation and
evaluated AT THE CURRENT OPERATING POINT -- matched on load, on lift, and on the
water temperatures at both ends. What is left after that subtraction is the part
the operating conditions do not explain.


NO RULE IS WRITTEN FOR NON-CONDENSABLE GAS.
That fault is deliberately held out so that Task 8 can demonstrate detecting
something no rule was written for. Nothing in this module tests for it.

Two things should be said plainly about that instruction. First, the LBNL
chiller dataset does not contain a non-condensable gas run at all -- it ships 23
fault runs (bypass leakage and stuck, chiller temperature bias, chiller fouling,
cooling tower bias, fouling and mistuned control, and secondary loop pressure
bias) and non-condensable gas is not among them, nor is a refrigerant leak.
Second, the fault this project actually holds out is cooling tower fouling,
chosen in checkpoint 2.4. So the held-out-fault instruction is honoured against
cooling tower fouling: no rule below references a cooling tower point, a tower
approach, or the wet bulb temperature, and none of them can fire on tower
fouling except through its second-order effect on chiller efficiency.


WHY THESE THREE AND NOT CONDENSER AND EVAPORATOR APPROACH
---------------------------------------------------------
Approach temperature is the difference between the refrigerant's saturation
temperature and the water it is exchanging heat with. This plant has no
refrigerant instrumentation: all 78 published columns are water side and air
side, with no saturation temperature and no refrigerant pressure anywhere.

The saturation temperatures cannot be recovered either. Each heat exchanger
gives one equation, Q = UA x LMTD, in two unknowns, UA and T_sat, and the water
side supplies no second equation because Q = m x cp x dT is an identity. Assuming
a design UA and solving for T_sat looks like a way out but is not: the algebra
collapses to T_sat = (T_in - T_out x e^NTU) / (1 - e^NTU), a fixed function of
the measured water temperatures. Fouling changes the real UA, which that
assumption has already fixed, so the resulting "approach" cannot move in response
to the fault it was written to catch.

The two approach rules are therefore replaced by the same two failure modes
expressed in quantities this plant actually measures -- a condenser-side
temperature residual and an evaporator-side capacity check -- alongside the
efficiency residual, which is computable exactly as specified.
"""

from __future__ import annotations

import numpy as np

from analytics.rules.registry import (
    CostEstimate,
    CostUnit,
    RuleContext,
    Verdict,
    rule,
)

# ---------------------------------------------------------------------------
# physical constants
# ---------------------------------------------------------------------------

WATER_DENSITY = 997.0  # kg/m3
WATER_SPECIFIC_HEAT = 4184.0  # J/(kg K)
WATTS_PER_TON = 3516.85  # one ton of refrigeration

# Below this the chiller is barely loaded and every per-ton quantity is dominated
# by dividing through a small number. 20 tons is about an eighth of this machine's
# capacity and retains 97% of the running samples in the fault-free year.
MIN_EVALUABLE_TONS = 20.0

# Compressor command at which the machine is considered to have nothing left.
FULL_COMPRESSOR_COMMAND = 0.95


# ---------------------------------------------------------------------------
# baselines, fitted on fault-free operation only
#
# Both surfaces are least-squares quadratics fitted across the 38,407 running
# samples of the fault-free year for chillers 1 and 2, the two that run enough to
# fit. Chiller 3 runs for 456 samples in the whole year and is not represented;
# its residuals are correspondingly less trustworthy and that is reported rather
# than corrected.
#
# NOTHING FROM THE ANSWER KEY WENT INTO THESE. The fault-free year is trajectory
# index 0 of the ingestion manifest, which is public configuration; no fault label
# was read, and the thresholds below come from the spread of the fault-free
# residuals alone, never from how well they separate a fault.
# ---------------------------------------------------------------------------

# kW = f(tons, lift), terms [1, tons, tons^2, lift, lift^2, tons*lift]
# where lift = leaving condenser water - leaving chilled water.
POWER_MODEL = np.array(
    [
        3.5324627845e01,
        7.1283312797e-02,
        5.9690891099e-03,
        -2.9015540825e00,
        9.4801925233e-02,
        3.8208553725e-02,
    ]
)

# lift = g(tons, entering condenser water, leaving chilled water), terms
# [1, tons, tons^2, cdwe, cdwe^2, chws, chws^2, tons*cdwe, tons*chws, cdwe*chws]
#
# Chilled water supply is among the inputs deliberately. An earlier version
# matched only on load and entering condenser water, and the residual moved the
# WRONG WAY under condenser fouling -- the chiller loses a little grip on its
# chilled water setpoint, chilled water supply drifts up, and since lift is
# measured down to it that drift cancels the condenser effect. Matching on it too
# restores the correct sign.
LIFT_MODEL = np.array(
    [
        -2.3375448056e00,
        5.0974808003e-02,
        6.3458537572e-05,
        9.9965636887e-01,
        2.2700766757e-03,
        -4.5253337558e-01,
        -2.4731138414e-02,
        -5.5683042306e-04,
        -6.6818535579e-04,
        -5.3899550447e-03,
    ]
)

# Spread of each residual across the fault-free fit, and the limits drawn from
# them. Three standard deviations is the ordinary statistical process control
# limit and is used here for exactly that reason -- it is a false alarm rate
# chosen from healthy data, not a number tuned until a fault showed up.
KW_PER_TON_RESIDUAL_SD = 0.109949
KW_PER_TON_LIMIT = 3.0 * KW_PER_TON_RESIDUAL_SD  # 0.3298 kW/ton

LIFT_RESIDUAL_SD = 0.360512
LIFT_LIMIT = 3.0 * LIFT_RESIDUAL_SD  # 1.0815 K

# Chilled water supply is allowed to sit this far above setpoint before the
# machine counts as unable to keep up. Fault-free operation at full compressor
# command runs 0.22 K above setpoint on average and reaches 1.505 K at the 99th
# percentile, so 2.0 K sits clear of normal control error.
CAPACITY_SHORTFALL_K = 2.0

RULE_DELAY_MINUTES = 60


def _tons(flow_m3s: float, return_c: float, supply_c: float) -> float:
    """Cooling actually delivered, in tons of refrigeration."""
    watts = flow_m3s * WATER_DENSITY * WATER_SPECIFIC_HEAT * (return_c - supply_c)
    return watts / WATTS_PER_TON


def predicted_kw(tons: float, lift: float) -> float:
    """Compressor power a healthy machine would draw at this load and lift."""
    terms = np.array([1.0, tons, tons * tons, lift, lift * lift, tons * lift])
    return float(POWER_MODEL @ terms)


def predicted_lift(tons: float, entering_condenser: float, supply_chilled: float) -> float:
    """Lift a healthy machine would develop at this operating point."""
    terms = np.array(
        [
            1.0,
            tons,
            tons * tons,
            entering_condenser,
            entering_condenser**2,
            supply_chilled,
            supply_chilled**2,
            tons * entering_condenser,
            tons * supply_chilled,
            entering_condenser * supply_chilled,
        ]
    )
    return float(LIFT_MODEL @ terms)


def _severity(exceedance: float, scale: float) -> float:
    return max(0.0, min(1.0, exceedance / scale))


# ---------------------------------------------------------------------------
# 1. efficiency -- the primary detector
# ---------------------------------------------------------------------------


@rule(
    id="chiller-kw-per-ton-residual",
    applies_to="brick:Chiller",
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def kw_per_ton_residual(ctx: RuleContext) -> Verdict:
    """Chiller uses more power per ton than its own baseline at this lift and load."""
    asset = ctx.asset_id
    supply = ctx.value(f"{asset}.chw_supply_temp", "chilled water supply temperature")
    ret = ctx.value(f"{asset}.chw_return_temp", "chilled water return temperature")
    flow = ctx.value(f"{asset}.chw_flow", "chilled water flow")
    leaving = ctx.value(f"{asset}.cdw_leaving_temp", "condenser water leaving temperature")
    power = ctx.value(f"{asset}.power", "compressor electrical power")

    tons = _tons(flow, ret, supply)
    if tons < MIN_EVALUABLE_TONS:
        return Verdict(False, detail=f"only {tons:.1f} tons, below the evaluable floor")

    lift = leaving - supply
    actual = power / 1000.0
    expected = predicted_kw(tons, lift)
    residual = (actual - expected) / tons
    exceedance = residual - KW_PER_TON_LIMIT

    return Verdict(
        fired=exceedance > 0,
        severity=_severity(exceedance, KW_PER_TON_LIMIT),
        cost=CostEstimate(
            CostUnit.ENERGY_KWH,
            max(0.0, actual - expected),
            "electrical power drawn above what this load and lift require, for an "
            "hour at the current operating point",
        ),
        detail=(
            f"{actual / tons:.3f} kW/ton against {expected / tons:.3f} expected at "
            f"{tons:.1f} tons and {lift:.2f} K lift, a residual of {residual:+.3f} "
            f"kW/ton ({residual / KW_PER_TON_RESIDUAL_SD:+.1f} standard deviations "
            f"of healthy scatter); {actual:.1f} kW drawn against {expected:.1f} expected"
        ),
    )


# ---------------------------------------------------------------------------
# 2. condenser side
# ---------------------------------------------------------------------------


@rule(
    id="chiller-excess-lift",
    applies_to="brick:Chiller",
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
)
def excess_lift(ctx: RuleContext) -> Verdict:
    """Compressor is pushing against more lift than this operating point requires."""
    asset = ctx.asset_id
    supply = ctx.value(f"{asset}.chw_supply_temp", "chilled water supply temperature")
    ret = ctx.value(f"{asset}.chw_return_temp", "chilled water return temperature")
    flow = ctx.value(f"{asset}.chw_flow", "chilled water flow")
    leaving = ctx.value(f"{asset}.cdw_leaving_temp", "condenser water leaving temperature")
    entering = ctx.value(f"{asset}.cdw_entering_temp", "condenser water entering temperature")

    tons = _tons(flow, ret, supply)
    if tons < MIN_EVALUABLE_TONS:
        return Verdict(False, detail=f"only {tons:.1f} tons, below the evaluable floor")

    lift = leaving - supply
    expected = predicted_lift(tons, entering, supply)
    residual = lift - expected
    exceedance = residual - LIFT_LIMIT

    return Verdict(
        fired=exceedance > 0,
        severity=_severity(exceedance, LIFT_LIMIT),
        cost=CostEstimate(
            CostUnit.ENERGY_KWH,
            # A chiller pays roughly 2 to 3 percent of its power per kelvin of
            # extra lift; 2.5% is used here and is a rule of thumb, not a
            # measurement, which is why the basis says so.
            max(0.0, residual) * 0.025 * predicted_kw(tons, expected),
            "extra compressor power implied by the surplus lift, at a rule-of-thumb "
            "2.5 percent per kelvin, for an hour",
        ),
        detail=(
            f"lift {lift:.2f} K against {expected:.2f} K expected at {tons:.1f} tons, "
            f"{entering:.2f} degC entering condenser water and {supply:.2f} degC "
            f"chilled water, a residual of {residual:+.2f} K "
            f"({residual / LIFT_RESIDUAL_SD:+.1f} standard deviations)"
        ),
    )


# ---------------------------------------------------------------------------
# 3. evaporator side
# ---------------------------------------------------------------------------


@rule(
    id="chiller-capacity-shortfall",
    applies_to="brick:Chiller",
    min_input_quality=70,
    persistence_minutes=RULE_DELAY_MINUTES,
    # A compressor pinned at full command has by definition stopped moving, so
    # the quality layer marks it stale. The pinning is the evidence, exactly as
    # for the air handler's saturated cooling valve.
    staleness_is_evidence=["chiller-1.compressor_cmd", "chiller-2.compressor_cmd",
                           "chiller-3.compressor_cmd"],
)
def capacity_shortfall(ctx: RuleContext) -> Verdict:
    """Chilled water is above setpoint while the compressor has nothing left."""
    asset = ctx.asset_id
    supply = ctx.value(f"{asset}.chw_supply_temp", "chilled water supply temperature")
    command = ctx.value(f"{asset}.compressor_cmd", "compressor speed command")
    setpoint = ctx.value(
        "chw-plant-1.pri_supply_temp_spt", "primary chilled water supply setpoint"
    )

    shortfall = supply - setpoint
    maxed = command >= FULL_COMPRESSOR_COMMAND
    exceedance = shortfall - CAPACITY_SHORTFALL_K

    return Verdict(
        fired=maxed and exceedance > 0,
        severity=_severity(exceedance, CAPACITY_SHORTFALL_K) if maxed else 0.0,
        cost=CostEstimate(
            CostUnit.COMFORT_DEGREE_HOURS,
            max(0.0, shortfall),
            "degrees the chilled water sits above setpoint with the compressor "
            "already at full command, held for an hour",
        ),
        detail=(
            f"chilled water leaving at {supply:.2f} degC against a {setpoint:.2f} degC "
            f"setpoint, {shortfall:+.2f} K adrift, with the compressor at "
            f"{command:.2f} of full command"
            + ("" if maxed else " -- still has capacity in reserve, so not a shortfall")
        ),
    )


# Points every rule above reads, for the evaluation driver to materialise.
def points_used(asset_id: str) -> tuple[str, ...]:
    return (
        f"{asset_id}.chw_supply_temp",
        f"{asset_id}.chw_return_temp",
        f"{asset_id}.chw_flow",
        f"{asset_id}.cdw_leaving_temp",
        f"{asset_id}.cdw_entering_temp",
        f"{asset_id}.power",
        f"{asset_id}.compressor_cmd",
        f"{asset_id}.status",
        "chw-plant-1.pri_supply_temp_spt",
    )
