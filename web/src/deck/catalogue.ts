/**
 * Everything the deck knows, frozen.
 *
 * WHY FROZEN AND NOT FETCHED. The deck is presented on a laptop in a room, sometimes with
 * no network and never with the platform's API running. A presentation that renders an
 * error because a database is asleep is a presentation that has failed in front of the one
 * audience it was built for. So every number here was captured once, from the real system,
 * and now travels with the build — exactly the decision the walkthrough's snapshot.ts made.
 *
 * WHERE EVERY BLOCK CAME FROM is recorded above it. Three sources, and the distinction
 * matters because it says what can drift:
 *
 *   REPO      read out of a file in this repository. Cannot drift without a diff.
 *   DB        captured from the running database on the office box, 2026-08-01, by the
 *             queries recorded in web/scripts/make-deck-catalogue.ts.
 *   STORY     re-exported from web/src/story/snapshot.ts, which came from the same
 *             database. Imported rather than copied so the two artefacts can never
 *             disagree about the machine they both describe.
 *
 * NOTHING HERE IS ILLUSTRATIVE. There is no rounded-for-the-slide number, no
 * representative example, and no placeholder that survived. If a figure could not be
 * obtained it is absent and the slide says so — a deck about whether a system can be
 * trusted cannot itself contain invented evidence.
 */

import { SNAPSHOT } from "../story/snapshot.ts";

/* ============================================================== the plant  [DB, STORY] */

export interface AssetRow {
  id: string;
  name: string;
  brickClass: string;
  replacementUsd: number;
  points: number;
}

/**
 * DB: select asset_id, name, brick_class, replacement_cost_usd from app.assets
 *     select asset_id, count(*) from app.points group by asset_id
 *
 * The point counts sum to 107, which is the figure the walkthrough's provenance block
 * reports independently — they are counted from different queries and agree.
 */
export const ASSETS: readonly AssetRow[] = [
  { id: "chiller-1", name: "Water-cooled chiller 1", brickClass: "brick:Chiller", replacementUsd: 320000, points: 9 },
  { id: "chiller-2", name: "Water-cooled chiller 2", brickClass: "brick:Chiller", replacementUsd: 320000, points: 9 },
  { id: "chiller-3", name: "Water-cooled chiller 3", brickClass: "brick:Chiller", replacementUsd: 320000, points: 9 },
  { id: "ct-1", name: "Cooling tower 1", brickClass: "brick:Cooling_Tower", replacementUsd: 95000, points: 7 },
  { id: "ct-2", name: "Cooling tower 2", brickClass: "brick:Cooling_Tower", replacementUsd: 95000, points: 7 },
  { id: "ct-3", name: "Cooling tower 3", brickClass: "brick:Cooling_Tower", replacementUsd: 95000, points: 7 },
  {
    id: "chw-plant-1",
    name: "Chilled water plant (loops, pumps, bypass valve)",
    brickClass: "brick:Chilled_Water_System",
    replacementUsd: 450000,
    points: 29,
  },
  {
    id: "ahu-1",
    name: "AHU-1 single-duct VAV air handling unit",
    brickClass: "brick:AHU",
    replacementUsd: 85000,
    points: 30,
  },
] as const;

/* ========================================================= the scenarios  [REPO, DB] */

export interface ScenarioRow {
  id: string;
  /** Which machine the fault was injected on. */
  asset: string;
  faultMode: string;
  /** Plain-language name for the room. */
  title: string;
  description: string;
  /** "progressive" climbs to failure; "step" jumps at onset; "none" is a clean control. */
  profile: "progressive" | "step" | "none";
  /** The window of the 2018 source year this scenario reads. */
  sourceStart: string;
  /** GROUND TRUTH: the day the fault begins, in scenario time. Hidden from the pipeline. */
  onset: string;
  /** GROUND TRUTH: the day it is fully degraded. Equal to onset for a step fault. */
  failure: string | null;
  daysToFailure: number;
  preOnsetDays: number;
  spanDays: number;
  seed: number;
  indicator: string;
  sourceFile: string;
  /** The severity rungs the source publishes for this fault, mildest first. */
  ladder: readonly { level: number; file: string; label: string }[];
}

/**
 * REPO: simulator/scenarios/*.yaml — every field below is the manifest verbatim.
 * DB:   groundtruth.fault_events supplied t_onset and t_failure as actually written,
 *       which is why onset here carries 06:00 and the manifest reads 00:00 — the manifest
 *       is in local scenario time and the stored event is in UTC.
 *
 * EIGHT SCENARIOS, SIX WITH A FAULT. The two clean runs are not filler: they are the bed
 * the false-alarm rate is measured on. A precision figure computed only over faulty data
 * would have nothing to be wrong about.
 */
export const SCENARIOS: readonly ScenarioRow[] = [
  {
    id: "chiller_condenser_fouling",
    asset: "chiller-1",
    faultMode: "condenser_fouling",
    title: "Condenser fouling",
    description:
      "Scale and biofilm build up on the condenser tubes, so the chiller cannot reject heat as well. It has to compress against a higher condensing temperature to shed the same load, which costs power and eventually capacity.",
    profile: "progressive",
    sourceStart: "2018-05-15",
    onset: "2036-05-31T06:00:00Z",
    failure: "2036-08-09T06:00:00Z",
    daysToFailure: 70,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 24051501,
    indicator: "chiller-1.power",
    sourceFile: "ChillerPlant.csv",
    ladder: [
      { level: 1, file: "ChillerPlant_chiller_fouling_095.csv", label: "95% heat transfer retained" },
      { level: 2, file: "ChillerPlant_chiller_fouling_065.csv", label: "65% heat transfer retained" },
    ],
  },
  {
    id: "chiller_bypass_valve_leakage",
    asset: "chw-plant-1",
    faultMode: "bypass_valve_leakage",
    title: "Bypass valve leakage",
    description:
      "The plant bypass valve does not seat, so chilled water returns to the chillers without having done any cooling and the water sent to the coils arrives warmer than it should.",
    profile: "progressive",
    sourceStart: "2018-05-15",
    onset: "2037-05-31T06:00:00Z",
    failure: "2037-06-30T06:00:00Z",
    daysToFailure: 30,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 25051501,
    indicator: "chw-plant-1.sec_supply_temp",
    sourceFile: "ChillerPlant.csv",
    ladder: [],
  },
  {
    id: "cooling_tower_fouling",
    asset: "ct-1",
    faultMode: "cooling_tower_fouling",
    title: "Cooling tower fouling",
    description:
      "Deposits on the tower fill reduce how much heat the tower can shed to the air, so the water returning to the chiller's condenser is warmer than design.",
    profile: "progressive",
    sourceStart: "2018-05-15",
    onset: "2038-05-31T06:00:00Z",
    failure: "2038-07-30T06:00:00Z",
    daysToFailure: 60,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 26051501,
    indicator: "ct-1.supply_temp",
    sourceFile: "ChillerPlant.csv",
    ladder: [],
  },
  {
    id: "ahu_cooling_valve_leakage",
    asset: "ahu-1",
    faultMode: "cooling_coil_valve_leakage",
    title: "Cooling coil valve leakage",
    description:
      "The chilled water valve does not fully close, so the coil keeps cooling air the economizer had already cooled for free. The energy is paid for twice — once making the water and again reheating the overcooled space.",
    profile: "progressive",
    sourceStart: "2018-03-01",
    onset: "2036-03-17T06:00:00Z",
    failure: "2036-05-01T06:00:00Z",
    daysToFailure: 45,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 24010301,
    indicator: "ahu-1.sa_temp",
    sourceFile: "AHU_annual.csv",
    ladder: [],
  },
  {
    id: "ahu_sat_sensor_drift",
    asset: "ahu-1",
    faultMode: "supply_air_temperature_sensor_drift",
    title: "Supply air sensor drift",
    description:
      "The supply air temperature sensor slowly reads wrong. Nothing mechanical is failing, but the controller believes the sensor and drives the valve to correct a temperature that was never there.",
    profile: "progressive",
    sourceStart: "2018-06-01",
    onset: "2038-06-17T06:00:00Z",
    failure: "2038-09-15T06:00:00Z",
    daysToFailure: 90,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 24060101,
    indicator: "ahu-1.chw_valve",
    sourceFile: "AHU_annual.csv",
    ladder: [],
  },
  {
    id: "ahu_oa_damper_stuck",
    asset: "ahu-1",
    faultMode: "outdoor_air_damper_stuck",
    title: "Outdoor air damper stuck",
    description:
      "The outdoor air damper stops responding to its command. There is nothing gradual about it, which is why it is the one scenario with no degradation at all.",
    profile: "step",
    sourceStart: "2018-02-01",
    onset: "2037-02-17T06:00:00Z",
    failure: "2037-02-17T06:00:00Z",
    daysToFailure: 0,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 24020101,
    indicator: "ahu-1.oa_damper",
    sourceFile: "AHU_annual.csv",
    ladder: [],
  },
  {
    id: "clean_chiller",
    asset: "chw-plant-1",
    faultMode: "none",
    title: "Clean chiller plant",
    description:
      "A control run with nothing wrong with it. Everything the system raises here is a false alarm by definition, which is how the false-alarm rate is measured at all.",
    profile: "none",
    sourceStart: "2018-05-15",
    onset: "2039-05-31T00:00:00Z",
    failure: null,
    daysToFailure: 0,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 27051501,
    indicator: "chiller-1.power",
    sourceFile: "ChillerPlant.csv",
    ladder: [],
  },
  {
    id: "clean_ahu",
    asset: "ahu-1",
    faultMode: "none",
    title: "Clean air handler",
    description:
      "The air-side control run, for the same purpose as the clean chiller plant: anything flagged here is something the system got wrong.",
    profile: "none",
    sourceStart: "2018-06-01",
    onset: "2039-06-17T00:00:00Z",
    failure: null,
    daysToFailure: 0,
    preOnsetDays: 21,
    spanDays: 120,
    seed: 27060101,
    indicator: "ahu-1.chw_valve",
    sourceFile: "AHU_annual.csv",
    ladder: [],
  },
] as const;

/* ============================================== the trajectory constants  [REPO] */

/**
 * REPO: simulator/trajectory.py
 *
 * The two numbers that shape how the decline climbs. Both are drawn from the scenario's
 * own seed, so the same manifest rebuilds the same trajectory every time.
 */
export const BLEND = {
  /** How many control points shape the rate of decline across the active window. */
  rateKnots: 24,
  /**
   * Spread of the rate multiplier at each knot. 0.35 gives roughly a factor of two between
   * the slowest and fastest stretches — visible without threatening monotonicity, because
   * every draw is strictly positive so the accumulated curve can flatten but never reverse.
   */
  rateLogSigma: 0.35,
  formula: "output(t) = faultfree(t) + blend(progress(t), contributions at t)",
  contribution: "contribution(t) = faulted(t) − faultfree(t)",
} as const;

/* ================================================== the five quality checks  [REPO] */

export interface CheckRow {
  id: string;
  name: string;
  asks: string;
  windowMinutes: number;
  why: string;
}

/**
 * REPO: analytics/quality/scoring.py — the five scores, their windows, and the reasoning
 * for each window length, taken from that module's own documentation.
 *
 * THE COMPOSITE IS THE MINIMUM, NOT THE MEAN, and that is the single most important fact
 * on this list. A reading that is timely, complete, smooth and moving but physically
 * impossible is not 80 percent trustworthy; it is worthless. Averaging would score it 80
 * and sail it straight past the rule engine's gate, which is the exact failure this layer
 * exists to prevent.
 */
export const CHECKS: readonly CheckRow[] = [
  {
    id: "timeliness",
    name: "timeliness",
    asks: "Did the samples arrive at the cadence this instrument is supposed to report at?",
    windowMinutes: 180,
    why: "Three hours is long enough that a single glitch is still visible when an operator looks, and short enough that the score recovers within a shift once the sensor does.",
  },
  {
    id: "completeness",
    name: "completeness",
    asks: "Of the samples that did arrive, how many actually carried a value?",
    windowMinutes: 180,
    why: "Same window as timeliness: both are per-sample properties, so the window only sets how long one bad sample keeps depressing the score.",
  },
  {
    id: "range",
    name: "range",
    asks: "Was the value inside the physically possible envelope for this instrument?",
    windowMinutes: 180,
    why: "Bounds come from the point manifest, with a millionth-of-envelope tolerance — without it, a fan reporting −2.2e−16 watts when switched off counts as out of range, and the first run of this scorer raised 3,223 violations on a fan that was simply off.",
  },
  {
    id: "plausibility",
    name: "plausibility",
    asks: "Did it change faster than the physics of this quantity allows?",
    windowMinutes: 180,
    why: "A temperature that jumps twenty degrees between two samples did not measure anything; something in the chain dropped or corrupted it.",
  },
  {
    id: "staleness",
    name: "staleness",
    asks: "Did it move at all, at a time when it should have been moving?",
    windowMinutes: 1440,
    why: "A whole day, not three hours, and that was measured rather than guessed: on the fault-free year, 50 percent of three-hour windows on the secondary chilled water supply temperature are perfectly flat during normal operation, against 28 percent of day-long ones. A three-hour flatline test on this building would be almost all false alarms.",
  },
] as const;

export const QUALITY = {
  /** The score a reading must clear before any rule is allowed to read it. */
  gate: 70,
  /** How long a condition must hold before it becomes a sensor advisory. */
  advisoryMinMinutes: 30,
  /** Staleness score below which a still-moving sensor is called stale. */
  staleAdvisoryBelow: 40,
} as const;

/* ========================================================== the nine rules  [REPO] */

export interface RuleRow {
  id: string;
  title: string;
  appliesTo: string;
  /** When this rule is allowed to run at all. */
  mode: string;
  /** The inequality, written the way an engineer would write it. */
  test: string;
  reads: readonly string[];
  why: string;
  /** Anything unusual about how this one is gated. */
  nuance?: string;
}

/**
 * REPO: analytics/rules/apar.py and analytics/rules/chiller.py — the nine registered
 * production rules. The registry also holds apar-1, two demo rules and an "ignore"
 * fixture; those are test scaffolding and are excluded.
 *
 * APAR is a published diagnostic rule set for air handlers. These are not thresholds
 * invented for this project — they are physical relationships that must hold if the unit
 * is working, and each one names which operating mode it applies in, because a rule that
 * is true while economizing is nonsense while heating.
 */
export const RULES: readonly RuleRow[] = [
  {
    id: "apar-6",
    title: "Supply air warmer than return air while economizing",
    appliesTo: "air handler",
    mode: "free cooling",
    test: "supply > return − ΔT_rf + ε",
    reads: ["supply air temp", "return air temp", "supply air flow"],
    why: "During free cooling the unit is supposed to be pulling in cool outdoor air. If the air it delivers is warmer than the air coming back from the space, it is heating the building with the mechanism meant to cool it — so either the dampers are not where the controller thinks, or two sensors disagree.",
  },
  {
    id: "apar-7",
    title: "Supply air does not match mixed air plus fan heat",
    appliesTo: "air handler",
    mode: "free cooling",
    test: "| supply − ΔT_sf − mixed | > ε",
    reads: ["supply air temp", "mixed air temp", "supply air flow"],
    why: "With both coils shut the only thing between the mixing box and the supply duct is the fan, so the temperature difference should be exactly the fan's own heat. Air arriving colder than that is being cooled by a coil that is supposed to be closed — which is a valve passing water.",
  },
  {
    id: "apar-16",
    title: "No cooling across the coil",
    appliesTo: "air handler",
    mode: "mechanical cooling, minimum outdoor air",
    test: "supply > mixed + ΔT_sf + ε",
    reads: ["supply air temp", "mixed air temp", "supply air flow"],
    why: "The coil is being asked to cool and the air is coming out warmer than it went in. Either no chilled water is reaching it, or the valve is not opening.",
  },
  {
    id: "apar-18",
    title: "Outdoor air fraction is not the minimum",
    appliesTo: "air handler",
    mode: "mechanical cooling, minimum outdoor air",
    test: "| (mixed − return) ÷ (outdoor − return) − minimum | > ε",
    reads: ["mixed air temp", "return air temp", "outdoor air temp", "supply air flow"],
    why: "Ventilation has a minimum the unit must hold, and hot outdoor air beyond it is air being cooled for no reason. The fraction is inferred from three temperatures rather than measured directly.",
    nuance:
      "The fraction is a ratio of temperature differences, so it explodes when return and outdoor air are at similar temperatures. Below a minimum separation the rule reports nothing rather than reporting noise.",
  },
  {
    id: "apar-20",
    title: "Cooling valve has run fully open and stayed there",
    appliesTo: "air handler",
    mode: "mechanical cooling, minimum outdoor air",
    test: "| valve − 1.0 | ≤ ε",
    reads: ["cooling valve position", "supply air temp", "supply air flow"],
    why: "A valve pinned wide open means the unit has no cooling left to give. It is either short of capacity or chasing a setpoint it cannot reach — and either way somebody upstream may be the reason.",
    nuance:
      "The condition this rule tests IS a flatline, so the quality layer would normally mark the signal stale and refuse to let the rule read the very symptom it exists to find. Staleness alone is admitted as evidence here. The other four checks still apply: a valve reading outside 0 to 1, or jumping impossibly fast, is still refused.",
  },
  {
    id: "apar-27",
    title: "Mixed air hotter than both the streams feeding it",
    appliesTo: "air handler",
    mode: "any occupied mode",
    test: "mixed > max(return, outdoor) + ε",
    reads: ["mixed air temp", "return air temp", "outdoor air temp"],
    why: "A mixture cannot be hotter than its hottest ingredient. This one is not a performance test at all — it is a physical impossibility, so when it fires either a sensor is wrong or the dampers are not where they claim to be.",
  },
  {
    id: "chiller-kw-per-ton-residual",
    title: "More power per ton of cooling than this machine's own baseline",
    appliesTo: "chiller",
    mode: "any, above a minimum evaluable load",
    test: "(actual kW − expected kW) ÷ tons > limit",
    reads: ["chilled water supply temp", "return temp", "flow", "condenser leaving temp", "power"],
    why: "The primary detector. Compares what the machine drew against what this load and this lift should have cost it, and reports the difference per ton so a big machine and a small one are judged on the same scale.",
    nuance:
      "Below a minimum load the comparison means nothing — a chiller barely running is not evidence about a chiller — so it declines to evaluate rather than reporting a residual.",
  },
  {
    id: "chiller-excess-lift",
    title: "Compressor pushing against more lift than the operating point requires",
    appliesTo: "chiller",
    mode: "any, above a minimum evaluable load",
    test: "measured lift − expected lift > limit",
    reads: ["chilled water supply temp", "return temp", "flow", "condenser entering and leaving temp"],
    why: "Lift is the temperature gap the compressor has to push against. Surplus lift at a known load points at the condenser side — a fouled bundle, or water arriving too warm from the tower.",
  },
  {
    id: "chiller-capacity-shortfall",
    title: "Chilled water above setpoint with the compressor already flat out",
    appliesTo: "chiller",
    mode: "any",
    test: "supply − setpoint > limit  AND  command ≥ full",
    reads: ["chilled water supply temp", "compressor command", "plant supply setpoint"],
    why: "The machine has run out of capacity before it ran out of command. Warm water on its own means nothing — the controller may simply not have asked for more yet — so the full-command condition is what makes it a shortfall.",
    nuance:
      "A compressor pinned at full command has by definition stopped moving, so staleness is admitted as evidence here for the same reason as the saturated cooling valve.",
  },
] as const;

/** REPO: analytics/rules/registry.py — the gate and the window every rule inherits. */
export const RULE_ENGINE = {
  /** A reading below this quality score is not shown to any rule. */
  minInputQuality: 70,
  /** How long a violation must hold continuously before it is raised. */
  persistenceMinutes: 60,
} as const;

/* ======================================================= the five baselines  [REPO] */

export interface BaselineRow {
  id: string;
  form: string;
  appliesTo: string;
  target: string;
  targetName: string;
  drivers: readonly string[];
  terms: string;
  why: string;
  nuance?: string;
}

/**
 * REPO: analytics/baselines/fit.py, BASELINE_CATALOGUE.
 *
 * KEYED BY EQUIPMENT CLASS, NOT BY MACHINE. Three chillers get one entry, not three, and
 * a fourth chiller added to the building needs a row in the asset table and no change here
 * at all.
 *
 * WHY ONLY FIVE. A baseline is worth fitting exactly where the physics relating a
 * measurement to its drivers is known and the drivers are instrumented. Everywhere else it
 * would produce a confident model of nothing, which is worse than no model — it would
 * generate residuals that look like evidence.
 */
export const BASELINES: readonly BaselineRow[] = [
  {
    id: "chiller-efficiency",
    form: "chiller-efficiency",
    appliesTo: "chiller",
    target: "{asset}.power",
    targetName: "chiller electrical power",
    drivers: ["chilled water supply temp", "return temp", "flow", "condenser leaving temp"],
    terms: "intercept, part-load ratio, lift and chilled water temperature — each on its own, squared, and multiplied by each other",
    why: "How much electricity this machine should be drawing given how hard it is being asked to work and how big a temperature gap it is pushing against. None of part-load ratio, lift or delivered cooling is a sensor — all three are derived from the four water-side measurements.",
  },
  {
    id: "condenser-heat-rejection",
    form: "condenser-heat-rejection",
    appliesTo: "chiller",
    target: "{asset}.cdw_leaving_temp",
    targetName: "condenser water leaving temperature",
    drivers: ["chilled water supply temp", "return temp", "flow", "condenser entering temp"],
    terms: "the heat being rejected, and the temperature of the water arriving to carry it away",
    why: "How hot the condenser water should be leaving, given how much heat is being put into it and how cold it arrived. This is the baseline the condenser fouling story runs on: when the tubes insulate, the water leaves hotter than this model says it should.",
  },
  {
    id: "fan-similarity",
    form: "fan-similarity",
    appliesTo: "air handler",
    target: "{asset}.sf_power",
    targetName: "supply fan power",
    drivers: ["supply air flow", "fan speed command"],
    terms: "the fan laws — power against speed and airflow",
    why: "What the fan should be drawing to move this much air at this speed. Worn bearings and a fouled impeller both show up as more shaft power for the same air delivered.",
    nuance:
      "Gated on the fan's speed command being off its stop, NOT on the unit's fan status point — that point is byte-for-byte identical to occupancy across all 138,240 samples of the record, and the fan runs during morning pull-down while it still reads zero. Gating on it would drop every start-up out of the fit.",
  },
  {
    id: "coil-effectiveness",
    form: "coil-effectiveness",
    appliesTo: "air handler",
    target: "{asset}.sa_temp",
    targetName: "supply air temperature",
    drivers: ["mixed air temp", "cooling valve position", "supply air flow"],
    terms: "how much cooling the coil delivers at a given valve position and airflow",
    why: "What temperature the air should leave the coil at, given how far the valve is open and how fast the air is moving.",
  },
  {
    id: "shut-valve-supply-air",
    form: "shut-valve-supply-air",
    appliesTo: "air handler",
    target: "{asset}.sa_temp",
    targetName: "supply air temperature, valve commanded shut",
    drivers: ["mixed air temp"],
    terms: "a single constant — the heat the fan adds, and nothing else",
    why: "A second, deliberately blind model of the same measurement, restricted to moments when the valve is commanded closed. It says the coil delivers ZERO cooling, so any cooling that appears has nowhere to hide.",
    nuance:
      "This exists because the coil-effectiveness model cannot catch a leaking valve: it is driven by valve POSITION, and in this dataset a leaking valve honestly reports itself as 10 percent open — so that model explains the leak away as normal cooling from a partly open valve. Airflow was tried as a second term and rejected: it moves the fit by 0.003, which is decoration.",
  },
] as const;

/* ==================================================== the six failure modes  [DB] */

export interface ModeRow {
  id: string;
  name: string;
  brickClass: string;
  threshold: number;
  unit: string;
  rationale: string;
  computable: boolean;
}

/**
 * DB: select mode_id, brick_class, mode_name, failure_threshold, indicator_unit,
 *     threshold_rationale from app.failure_modes
 *
 * THE RATIONALE COLUMN IS MANDATORY IN THE SCHEMA, not optional, and this is why: health
 * is the distance travelled from commissioning toward this threshold, so if the threshold
 * is arbitrary then every health score derived from it is arbitrary too. Every one of
 * these six had to be justified before it could be stored.
 *
 * ONE OF THEM IS NOT COMPUTABLE IN THIS BUILDING and is stored anyway. See filter-loading.
 */
export const MODES: readonly ModeRow[] = [
  {
    id: "chiller-condenser-fouling",
    name: "Condenser fouling",
    brickClass: "brick:Chiller",
    threshold: 3,
    unit: "degC",
    computable: true,
    rationale:
      "Fouling insulates the condenser tubes, so rejecting the same heat needs a hotter refrigerant, which raises condensing pressure and therefore the temperature gap the compressor works across. 3.0 K of excess leaving condenser water at matched load and matched entering water is roughly a 7 to 9 percent compressor power penalty at the usual 2.5 percent per kelvin, which is the point at which a tube-brush cleaning pays for itself inside one cooling season. It is also seven times the 0.42 K spread of the fitted baseline, so it cannot be reached by scatter.",
  },
  {
    id: "chiller-efficiency-loss",
    name: "Compressor efficiency loss",
    brickClass: "brick:Chiller",
    threshold: 0.536,
    unit: "kW/ton",
    computable: true,
    rationale:
      "This machine was commissioned at 1.3402 kW/ton averaged over its first three weeks. A chiller running at 1.4 times its own commissioned efficiency is buying the same cooling with 40 percent more electricity, which is the conventional economic-replacement trigger: the annual energy penalty exceeds the cost of the overhaul. 40 percent of 1.3402 is the 0.536 kW/ton of excess recorded here. Stated as an excess over the condition-matched baseline rather than as an absolute kW/ton, because the same healthy machine runs 1.2 kW/ton on a mild morning and 1.9 on a hot afternoon and an absolute limit would flag the afternoon.",
  },
  {
    id: "chiller-refrigerant-loss",
    name: "Refrigerant charge loss",
    brickClass: "brick:Chiller",
    threshold: 2,
    unit: "degC",
    computable: true,
    rationale:
      "Losing charge reduces the refrigerant mass the compressor can move, so the machine runs out of capacity before it runs out of command: chilled water drifts above setpoint while the compressor is already flat out. Measured only at full command, because below it a warm supply just means the controller has not asked for more yet. Fault-free operation at full command sits 0.22 K above setpoint on average and reaches 1.505 K at the 99th percentile, so 2.0 K is clear of normal control error and represents a plant that can no longer make its design water temperature on a design day.",
  },
  {
    id: "coil-valve-leak-by",
    name: "Cooling coil valve leak-by",
    brickClass: "brick:Air_Handling_Unit",
    threshold: 2.8,
    unit: "degC",
    computable: true,
    rationale:
      "With the valve commanded shut the coil should deliver no cooling at all, so every degree of depression below the baseline is cooling nobody asked for. 2.8 K (5 degF) across this unit's 5.0 m3/s average airflow is about 17 kW of unwanted cooling, and it is paid for twice: once at the chiller making the water, and again wherever the overcooled space is reheated back to setpoint. It is also 2.5 times the plus or minus 1.1 K supply air control tolerance in ASHRAE Guideline 36, so a coil holding this deviation has taken supply air temperature outside the band the control sequence is specified to hold.",
  },
  {
    id: "fan-bearing-degradation",
    name: "Fan and bearing degradation",
    brickClass: "brick:Air_Handling_Unit",
    threshold: 88.9,
    unit: "watt",
    computable: true,
    rationale:
      "Worn bearings and a fouled impeller both show as more shaft power for the same air delivered, so the excess is measured at matched fan speed AND matched airflow. This fan was commissioned drawing 592.4 W on average. NEMA motors are built to a 1.15 service factor, meaning 15 percent over nameplate is the continuous overload the winding is rated to survive, so 15 percent of the commissioned draw — 88.9 W — is the point past which the motor is running outside its own rating whenever the fan is at its average duty.",
  },
  {
    id: "filter-loading",
    name: "Filter loading",
    brickClass: "brick:Air_Handling_Unit",
    threshold: 250,
    unit: "pascal",
    computable: false,
    rationale:
      "NOT COMPUTABLE IN THIS BUILDING. A loaded filter is measured by the pressure drop across it, and neither published dataset carries one — the air handler ships 30 columns and none is a filter differential pressure, and there is no filter in the simulation to load. The threshold is recorded anyway because it is real: 250 Pa (1.0 inch water gauge) is the standard final-pressure change-out criterion for a MERV 13 bank, set at the point where the extra fan energy to push air through the filter exceeds the cost of replacing it. The row exists so the missing instrument is documented rather than silently absent; the nearest available proxy, fan speed required at matched airflow, was rejected because it fits at only R² 0.50 to 0.75 with a residual of 5 percent of full scale.",
  },
] as const;

/* ================================================= onset and remaining life  [REPO] */

/** REPO: analytics/health/changepoint.py */
export const ONSET = {
  /**
   * Slack, in standard deviations of the reference period. The running total ignores drift
   * smaller than this, which is what stops it accumulating on ordinary noise. Half a
   * standard deviation is the textbook value.
   */
  slackSigma: 0.5,
  /**
   * Crossing this declares a change. With a slack of 0.5 the standard design gives an
   * in-control average run length of roughly 465 samples — meaning on a machine that is not
   * degrading, a false onset is expected about once every 465 days of daily samples.
   * CHOSEN FROM THAT FALSE-ALARM PROPERTY, not from how well it separates any scenario here.
   */
  decisionSigma: 5.0,
  /** Below this many reference days the onset is reported as undetectable, not guessed. */
  minReferenceSamples: 7,
} as const;

/** REPO: analytics/health/index.py */
export const HEALTH = {
  /** Health is computed once a day; indicators arrive every five minutes. */
  bucket: "one day",
  /** A day represented by fewer readings than this is not a measurement of that day. */
  minSamplesPerBucket: 6,
} as const;

/**
 * REPO: analytics/rul/refusal.py — four conditions, checked in order, first one wins.
 * Each presupposes the ones above it, which is why the order is not arbitrary.
 */
export const REFUSALS: readonly { rank: number; reason: string; why: string }[] = [
  {
    rank: 1,
    reason: "No confirmed onset",
    why: "Nothing may be projected before something has been established to have changed. A trend fitted to a flat noisy line still has a slope, and that slope still yields a confident-looking date.",
  },
  {
    rank: 2,
    reason: "Too few observations since onset",
    why: "A rate and a spread computed from a handful of days have sampling errors comparable to themselves.",
  },
  {
    rank: 3,
    reason: "The rate cannot be told apart from zero",
    why: "The one that does the real work. Two known false alarms arrive here from upstream and both are caught here and nowhere else — a baseline fitted in May leaves a small systematic residual by September, and a small sustained shift is exactly what a cumulative sum is built to find. Neither is filtered by counting samples or by inspecting the interval; both are filtered by asking whether the machine is measurably moving at all.",
  },
  {
    rank: 4,
    reason: "The interval is wider than we have been watching",
    why: "If forty days of observation produce a window three hundred days wide, the window is not an answer — the observation itself was more informative.",
  },
] as const;

/* ======================================================= the cause chain  [DB] */

/**
 * DB: select advisory_id, asset_id, fault_id, cause_asset, cause_fault from app.advisories
 *     where cause_asset is not null
 *
 * ONE REAL CHAIN, walked end to end in act seven. This is not a constructed example: it is
 * a row the diagnosis layer wrote, and it is exactly the failure the root-cause module was
 * built for — the air handler's cooling valve runs wide open and never recovers, and the
 * reason is two hops upstream on a chiller nobody was looking at.
 */
export const CAUSE_CHAIN = {
  symptomAsset: "ahu-1",
  symptomFault: "apar-20",
  symptomTitle: "Cooling valve has run fully open and stayed there",
  causeAsset: "chiller-1",
  causeFault: "chiller-condenser-fouling",
  causeTitle: "Condenser fouling",
  advisoryId: "ahu-1|apar-20|20380924",
  hops: 2,
  path: "chiller-1 → chilled water loop → cooling coil (ahu-1)",
} as const;

/**
 * REPO: analytics/diagnosis/rootcause.py — the admission rule for the mechanism map.
 *
 * A cause must degrade the MEDIUM the downstream machine consumes. Chilled water
 * temperature is the medium here. A chiller short of capacity sends warmer water and that
 * reaches the coil. A chiller burning more electricity per ton does NOT — it is still
 * making the water, it is just paying more for it, and the air handler cannot tell and does
 * not care. Efficiency loss is therefore absent from the map, and so are the two chiller
 * rules that report surplus lift and surplus power: they report a cost, not a degraded
 * medium. Without that rule the table degenerates into a list of opinions about which
 * faults feel related.
 */
export const MECHANISM_RULE =
  "a cause must degrade the medium the downstream machine consumes — not merely cost more to run";

/* ====================================================== the topology  [REPO] */

/**
 * REPO: model/building_extensions.ttl
 *
 * The connections had to be ADDED. The published plant model ships zero flow statements —
 * 0 feeds-triples in 191 — so it says what the equipment is and nothing about what reaches
 * what. Without these edges the root-cause question cannot even be asked.
 *
 * Direction convention: A feeds B means what A does affects B.
 */
export const EDGES: readonly { from: string; to: string; kind: "feeds" | "hasPart" }[] = [
  { from: "Chiller 1", to: "Chilled water loop", kind: "feeds" },
  { from: "Chiller 2", to: "Chilled water loop", kind: "feeds" },
  { from: "Chiller 3", to: "Chilled water loop", kind: "feeds" },
  { from: "Chilled water loop", to: "Cooling coil", kind: "feeds" },
  { from: "Cooling coil", to: "Supply air fan", kind: "feeds" },
  { from: "Supply air fan", to: "Zones 1 to 5", kind: "feeds" },
  { from: "Cooling tower 1", to: "Condenser water loop", kind: "feeds" },
  { from: "Cooling tower 2", to: "Condenser water loop", kind: "feeds" },
  { from: "Cooling tower 3", to: "Condenser water loop", kind: "feeds" },
  { from: "Condenser water loop", to: "Chiller 1", kind: "feeds" },
  { from: "Condenser water loop", to: "Chiller 2", kind: "feeds" },
  { from: "Condenser water loop", to: "Chiller 3", kind: "feeds" },
] as const;

/* ============================================ what the story already knows  [STORY] */

/**
 * Re-exported rather than copied. The deck and the walkthrough describe the same machine on
 * the same day, and duplicating these numbers is how two artefacts start quietly disagreeing
 * about what the system said.
 */
export const {
  asset: FOLLOWED_ASSET,
  point: FOLLOWED_POINT,
  instruments: INSTRUMENTS,
  commissioning: COMMISSIONING,
  reading: READING,
  indicator: INDICATOR,
  health: HEALTH_TODAY,
  prediction: PREDICTION,
  advisory: ADVISORY,
  provenance: PROVENANCE,
  validation: VALIDATION,
  inventory: INVENTORY,
  baseline: BASELINE_SERIES,
  at: AT,
} = SNAPSHOT;

/* ====================================================== the validation numbers */

export interface MetricRow {
  id: string;
  /** What it is called on the slide, in the room's language. */
  name: string;
  /** The figure, formatted. */
  value: string;
  /** What it means, without jargon. */
  means: string;
  /** How it was computed. */
  how: string;
  /** Whether this number is good, acceptable, or bad. Drives the colour, and nothing else. */
  verdict: "good" | "mixed" | "bad";
}

/**
 * STORY: SNAPSHOT.validation, which the validation harness wrote.
 * REPO:  validation/metrics.py and validation/report.py for what each one means.
 *
 * THE BAD ONE IS REPORTED AS BAD. Interval coverage comes out at 7.7 percent against a
 * nominal 80, and it is on the slide at that value with the reason next to it. A deck about
 * whether a system can be trusted that hides its worst number is the one that gets caught.
 */
export const METRICS: readonly MetricRow[] = [
  {
    id: "recall",
    name: "Caught what was really wrong",
    value: `${VALIDATION.recall}%`,
    means:
      "Of all the machine-days where a fault had genuinely been injected, this is the share the system flagged. It is the question a facility manager actually asks: will it tell me when something is wrong?",
    how: "Every machine on every day the data covers is labelled from the hidden answer key as faulty or healthy, then compared against what the platform raised that day. This is the true positives over everything that was truly faulty.",
    verdict: "good",
  },
  {
    id: "precision",
    name: "How much of what it raised was real",
    value: `${VALIDATION.precision}%`,
    means:
      "Of everything the system flagged, this is the share that was genuinely faulty. The rest is noise somebody has to wade through — and this number is the honest cost of the recall above it.",
    how: "Same machine-day table, read the other way: true positives over everything flagged. The two clean control scenarios are what make this measurable at all — without data containing no faults, there is nothing to be wrong about.",
    verdict: "mixed",
  },
  {
    id: "lead",
    name: "How early the warning came",
    value: `${VALIDATION.leadMedianDays} days, typically`,
    means:
      "How long before the machine actually reached its failure threshold the system first warned about it. This is the entire economic argument: a warning that arrives the day of failure is worth nothing.",
    how: `Across ${VALIDATION.leadWarnings} warnings on the injected faults, measured from first flag to the answer key's failure date. A tenth of them came with ${VALIDATION.leadP10Days} days or less, and the worst was ${VALIDATION.leadWorstDays} days.`,
    verdict: "good",
  },
  {
    id: "faultClass",
    name: "Named the right fault",
    value: `${VALIDATION.faultClassCorrect} of ${VALIDATION.faultClassTotal}`,
    means:
      "Detecting that something is wrong is not enough — a technician is dispatched against a named fault. This is how often the name was right.",
    how: `Compared against the fault the answer key says was injected. A system that always guessed the commonest fault would get ${VALIDATION.faultClassBaseline} of ${VALIDATION.faultClassTotal}, which is the baseline this has to beat to mean anything.`,
    verdict: "good",
  },
  {
    id: "rulCoverage",
    name: "Remaining-life band contained the truth",
    value: `${VALIDATION.rulCoverage}%`,
    means:
      "When the system published a range of dates for a failure, this is how often the real failure date fell inside that range. It should be around 80 percent. It is not.",
    how: "Every published interval is checked against the answer key's failure date. The band is too narrow and too confident, which means it is wrong in the most expensive direction: a planner trusting it books a crew for the wrong week.",
    verdict: "bad",
  },
  {
    id: "suppression",
    name: "Knew when to say nothing",
    value: `${VALIDATION.suppressionRefusals} refused, ${VALIDATION.suppressionWrong} wrong`,
    means:
      "How often the system declined to give a failure date because the evidence was too thin, and how often that refusal was the wrong call.",
    how: "Counted from cases where the estimator could have produced a number and the refusal layer stopped it. Both refusals here were on machines with nothing actually wrong with them.",
    verdict: "good",
  },
] as const;

/* ============================================================= derived, never authored */

export const FAULT_SCENARIOS = SCENARIOS.filter((s) => s.faultMode !== "none");
export const CLEAN_SCENARIOS = SCENARIOS.filter((s) => s.faultMode === "none");

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);
export const assetById = (id: string) => ASSETS.find((a) => a.id === id);
export const ruleById = (id: string) => RULES.find((r) => r.id === id);
export const checkById = (id: string) => CHECKS.find((c) => c.id === id);
export const baselineById = (id: string) => BASELINES.find((b) => b.id === id);
export const modeById = (id: string) => MODES.find((m) => m.id === id);
export const metricById = (id: string) => METRICS.find((m) => m.id === id);
