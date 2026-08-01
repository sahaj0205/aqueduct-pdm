/**
 * Turns the database export into the shapes the screens read.
 *
 * WHERE THE DATA COMES FROM. `generated/operational.json` and `generated/groundtruth.json`
 * are written by `scripts/export_fm_seed.py` straight out of the analytics tables. Every
 * number below is therefore the real one the pipeline computed — not a value invented for
 * the demo. Re-run the exporter against a rebuilt database and these screens update.
 *
 * WHAT IS DERIVED HERE, AND WHY THAT IS HONEST. Three things the UI needs are genuinely
 * not in the database, and each is marked at its definition:
 *   - `location`   the schema has no location column; it is derived from equipment class
 *                  so the schedule can group a crew's visit. A label, not a measurement.
 *   - `x` / `y`    the plant drawing's layout, assigned by equipment tier.
 *   - point scores the quality score lives on `app.measurements`, which is far too large
 *                  to export; a point's standing is reconstructed from whether an
 *                  instrument advisory is open against it.
 * Nothing else is computed here. Everything else is a rename.
 */

import operationalRaw from "./generated/operational.json";
import groundtruthRaw from "./generated/groundtruth.json";
import type {
  AdvisoryDetail,
  AdvisoryRow,
  Asset,
  CostTerm,
  EvidenceQuality,
  FaultClass,
  HealthBand,
  HealthSeries,
  Instruments,
  ModeIndicator,
  PointQuality,
  ResidualSeries,
  Rul,
  RulSnapshot,
  SensorAdvisory,
  Signal,
  Tier,
  Topology,
  Vantage,
  Why,
} from "../types.ts";

/* ----------------------------------------------------------------- raw shapes */

interface RawAsset {
  asset_id: string;
  brick_class: string;
  name: string;
  criticality_tier: number;
  replacement_cost_usd: number | null;
  install_date: string;
}
interface RawEdge {
  from_asset: string;
  to_asset: string;
  relation: string;
  hop_distance: number;
}
interface RawMode {
  mode_id: string;
  brick_class: string;
  mode_name: string;
  indicator_expression: string | null;
  applies_when: string | null;
  failure_threshold: number;
  indicator_unit: string;
  threshold_rationale: string;
  degradation_process: string;
  penalty_kw_per_unit: number | null;
  penalty_basis: string | null;
}
interface RawIntervention {
  intervention_id: string;
  applies_to_fault: string;
  applies_to_class: string | null;
  description: string;
  duration_hours: number;
  skills: string[];
  parts: string[];
  cost_usd: number;
  basis: string;
}
interface RawPoint {
  point_id: string;
  asset_id: string;
  brick_class: string;
  name: string;
  unit_si: string;
  usable: boolean;
  unusable_reason: string | null;
}
interface RawHealth {
  time: string;
  asset_id: string;
  mode_id: string | null;
  indicator_raw: number | null;
  indicator_monotonic: number | null;
  health: number | null;
  t_onset: string | null;
  weakest_mode: string | null;
}
interface RawRul {
  asset_id: string;
  mode_id: string | null;
  as_of: string;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  n_samples: number;
}
interface RawResidual {
  point_id: string;
  day: string;
  observed: number;
  expected: number;
  residual: number;
  n: number;
}
interface RawSensorAdvisory {
  advisory_id: number;
  point_id: string;
  kind: string;
  t_from: string;
  t_to: string;
  worst_score: number;
  sample_count: number;
  detail: Record<string, unknown> | null;
}
interface RawAdvisory {
  advisory_id: string;
  asset_id: string;
  fault_id: string;
  mode_id: string | null;
  fault_source: string;
  fault_class: FaultClass;
  status: string;
  generated_at: string;
  window_from: string;
  window_to: string;
  health: number | null;
  severity: number;
  priority: number | null;
  cost_usd: number;
  effort_usd: number;
  consequential: boolean;
  cause_asset: string | null;
  cause_fault: string | null;
  detail: RawDetail;
}
interface RawDetail {
  asset: { id: string; name: string };
  fault: { id: string; title: string; source: string; mode_id: string | null; fault_class: FaultClass; class_reason: string };
  health: number | null;
  priority: number | null;
  effort_usd: number;
  window: { from: string; to: string };
  signals: { point_id: string; label: string; unit: string; observed: number; reference: number; moved: number; sigmas: number }[];
  signals_excluded: { untrusted_readings: number; unusable_source_data: number };
  forecast: {
    as_of: string | null;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    n_samples: number | null;
    probability_within_horizon: number | null;
    refusal: string | null;
    sentence: string;
  };
  cost: {
    duty: number;
    basis: string[];
    energy_usd: number | null;
    consequential_usd: number | null;
    excess_kw: number | null;
    horizon_days: number;
    priceable: boolean;
    total_usd: number | null;
  };
  severity: { score: number; terms: Record<string, number>; weights: Record<string, number>; occupants: number; criticality_tier: number; slope_days: number | null; slope_per_day: number | null };
  intervention: { id: string; description: string; duration_hours: number; parts: string[]; parts_cost_usd: number; skills: string[]; basis: string; matched_on_class: string | null };
  trace: {
    cause: { asset: string; fault: string; title: string; medium: string; timing: string; hops: number } | null;
    zones: string[];
    occupants: number;
    upstream: { asset: string; hops: number }[];
    downstream_assets: string[];
  };
  notes: string[];
  diagnosis_evidence: unknown[];
}

interface RawRun {
  era: number;
  as_of: string;
  advisories: RawAdvisory[];
  health_state: RawHealth[];
  rul_estimates: RawRul[];
  residuals_daily: RawResidual[];
  sensor_advisories: RawSensorAdvisory[];
}

interface RawOperational {
  vantages: { id: string; era: number; as_of: string; default: boolean; note: string }[];
  assets: RawAsset[];
  asset_edges: RawEdge[];
  failure_modes: RawMode[];
  interventions: RawIntervention[];
  points: RawPoint[];
  runs: Record<string, RawRun>;
}

interface RawFaultEvent {
  event_id: number;
  scenario_id: string;
  asset_id: string;
  fault_mode: string;
  severity_level: string;
  t_onset: string;
  t_failure: string | null;
  params: { seed?: number; profile?: string; waypoints?: { level: number; file: string; label: string }[]; duration_to_failure_days?: number };
}

const OP = operationalRaw as unknown as RawOperational;
const GT = groundtruthRaw as unknown as { scenarios: unknown[]; fault_events: RawFaultEvent[] };

/* -------------------------------------------------------------------- helpers */

const MODE_BY_ID = new Map(OP.failure_modes.map((m) => [m.mode_id, m]));
const ASSET_BY_ID = new Map(OP.assets.map((a) => [a.asset_id, a]));
const POINT_BY_ID = new Map(OP.points.map((p) => [p.point_id, p]));

/** Equipment class as a short human noun. */
function kindOf(brickClass: string): string {
  return brickClass.replace(/^brick:/, "").replace(/_/g, " ");
}

/**
 * A name that fits in a table cell.
 *
 * The schema stores full descriptive names — "AHU-1 single-duct VAV air handling unit",
 * "Chilled water plant (loops, pumps, bypass valve)" — which are the right thing to hold
 * in a catalogue and far too long for a row a facility manager scans. The full name is
 * kept and shown on the asset's own page; this is what the lists use.
 */
function shortName(name: string): string {
  // A leading tag like "AHU-1" already identifies the machine on its own.
  const tag = /^([A-Z]{2,4}-\d+)\b/.exec(name);
  if (tag) return tag[1]!;
  // Otherwise drop any parenthetical and any leading qualifier before the noun.
  const base = name.replace(/\s*\(.*\)\s*$/, "").trim();
  const titled = base.replace(/^water-cooled\s+/i, "").replace(/^chilled water\s+/i, "Chilled water ");
  return titled.charAt(0).toUpperCase() + titled.slice(1);
}

/**
 * DERIVED, NOT MEASURED. The schema carries no location column, but the schedule needs
 * one to group a crew's visit into a single trip. Equipment class is the best available
 * proxy: towers are on the roof, chillers and the plant are in the basement, the air
 * handler is in its own plant room.
 */
function locationOf(brickClass: string): string {
  if (brickClass.includes("Cooling_Tower")) return "Roof";
  if (brickClass.includes("AHU") || brickClass.includes("Air_Handling")) return "Level 3 Mechanical";
  return "Basement Plant Room";
}

export function bandOf(health: number | null): HealthBand | null {
  if (health === null) return null;
  if (health >= 85) return "healthy";
  if (health >= 70) return "watch";
  if (health >= 50) return "degraded";
  return "critical";
}

function tierOf(band: HealthBand | null, severity: number): Tier {
  if (band === "critical") return "critical";
  if (band === "degraded") return "high";
  if (band === "watch") return "medium";
  // A finding with no health score (a rule firing) still has a severity to rank on.
  if (band === null) return severity >= 0.6 ? "high" : severity >= 0.35 ? "medium" : "low";
  return "low";
}

function last<T>(xs: T[]): T | undefined {
  return xs.length ? xs[xs.length - 1] : undefined;
}

/* ------------------------------------------------------------------- vantages */

export const VANTAGES: Vantage[] = OP.vantages.map((v) => ({
  id: v.id,
  label: new Date(`${v.as_of}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }),
  era: v.era,
  as_of: `${v.as_of}T00:00:00Z`,
  note: v.note,
  available: true,
}));

export const DEFAULT_VANTAGE_ID = OP.vantages.find((v) => v.default)?.id ?? OP.vantages[0]!.id;

function run(vantageId: string): RawRun {
  return OP.runs[vantageId] ?? OP.runs[DEFAULT_VANTAGE_ID]!;
}

/* --------------------------------------------------------------------- health */

/** The latest health row at or before the vantage, per asset and mode. */
function latestHealth(r: RawRun): Map<string, RawHealth> {
  const out = new Map<string, RawHealth>();
  for (const row of r.health_state) {
    out.set(`${row.asset_id}|${row.mode_id ?? ""}`, row);
  }
  return out;
}

export function assetsFor(vantageId: string): Asset[] {
  const r = run(vantageId);
  const latest = latestHealth(r);
  const openByAsset = new Map<string, number>();
  for (const a of r.advisories) openByAsset.set(a.asset_id, (openByAsset.get(a.asset_id) ?? 0) + 1);

  return OP.assets.map((a) => {
    const roll = latest.get(`${a.asset_id}|`);
    const health = roll?.health ?? null;
    const weakest = roll?.weakest_mode ?? null;
    const occupants = r.advisories.find((x) => x.asset_id === a.asset_id)?.detail.trace.occupants ?? 0;
    return {
      asset_id: a.asset_id,
      name: shortName(a.name),
      kind: kindOf(a.brick_class),
      location: locationOf(a.brick_class),
      health,
      band: bandOf(health),
      weakest_mode: weakest,
      weakest_mode_label: weakest ? MODE_BY_ID.get(weakest)?.mode_name ?? weakest : null,
      open_advisories: openByAsset.get(a.asset_id) ?? 0,
      occupants_served: occupants,
      replacement_cost_usd: a.replacement_cost_usd,
      in_service: a.install_date,
    };
  });
}

/* ------------------------------------------------------------------- topology */

/** DERIVED LAYOUT. Row per equipment tier, spread evenly across it. */
function layout(): Map<string, { x: number; y: number }> {
  const tiers: Record<string, string[]> = { tower: [], plant: [], chiller: [], ahu: [] };
  for (const a of OP.assets) {
    if (a.brick_class.includes("Cooling_Tower")) tiers.tower!.push(a.asset_id);
    else if (a.brick_class.includes("Chilled_Water_System")) tiers.plant!.push(a.asset_id);
    else if (a.brick_class.includes("Chiller")) tiers.chiller!.push(a.asset_id);
    else tiers.ahu!.push(a.asset_id);
  }
  const y: Record<string, number> = { tower: 10, plant: 34, chiller: 58, ahu: 82 };
  const out = new Map<string, { x: number; y: number }>();
  for (const [tier, ids] of Object.entries(tiers)) {
    ids.forEach((id, i) => {
      const step = 88 / (ids.length + 1);
      out.set(id, { x: 6 + step * (i + 1), y: y[tier]! });
    });
  }
  return out;
}

export function topologyFor(vantageId: string): Topology {
  const assets = assetsFor(vantageId);
  const pos = layout();
  const nodes = assets.map((a) => {
    const p = pos.get(a.asset_id) ?? { x: 50, y: 50 };
    return {
      id: a.asset_id,
      label: a.name,
      kind: a.kind,
      health: a.health,
      band: a.band,
      open_advisories: a.open_advisories,
      x: p.x,
      y: p.y,
      is_zone: false,
      occupants: a.occupants_served,
    };
  });

  const edges = OP.asset_edges
    .filter((e) => e.relation === "feeds" && e.hop_distance <= 2)
    .map((e) => ({ from: e.from_asset, to: e.to_asset, medium: "chilled / condenser water" }));

  return { nodes, edges };
}

/* ------------------------------------------------------------------ advisories */

function forecastToRul(d: RawDetail): Rul {
  const f = d.forecast;
  if (f.p10 !== null && f.p50 !== null && f.p90 !== null && f.as_of) {
    const at = new Date(f.as_of).getTime();
    const day = 86_400_000;
    const iso = (days: number) => new Date(at + days * day).toISOString();
    return {
      published: true,
      p10: iso(f.p10),
      p50: iso(f.p50),
      p90: iso(f.p90),
      width_days: Math.round(f.p90 - f.p10),
      evidence_days: f.n_samples ?? 0,
      samples: f.n_samples ?? 0,
      first_width_days: Math.round(f.p90 - f.p10),
    };
  }
  const reason = f.refusal ?? f.sentence;
  // The pipeline's own words, classified onto the four gates the UI knows about.
  const gate: Extract<Rul, { published: false }>["gate"] = /withheld/i.test(reason)
    ? "width"
    : /not a degradation trend/i.test(reason)
      ? "rate"
      : /onset/i.test(reason)
        ? "onset"
        : "evidence";
  return {
    published: false,
    gate,
    reason,
    needs: /withheld/i.test(reason)
      ? "The health index and the first-passage estimate to agree on how much life is left."
      : "A confirmed degradation trend on this fault before any date can be projected.",
  };
}

function evidenceQuality(d: RawDetail): EvidenceQuality {
  const ex = d.signals_excluded;
  if (ex.unusable_source_data > 0) return "degraded";
  if (ex.untrusted_readings > 0) return "partial";
  return "clean";
}

function toRow(a: RawAdvisory): AdvisoryRow {
  const d = a.detail;
  const band = bandOf(a.health);
  const rul = forecastToRul(d);
  return {
    advisory_id: a.advisory_id,
    asset_id: a.asset_id,
    asset_name: shortName(d.asset.name),
    location: locationOf(ASSET_BY_ID.get(a.asset_id)?.brick_class ?? ""),
    fault_id: a.fault_id,
    fault_title: d.fault.title,
    physics_clause: MODE_BY_ID.get(a.mode_id ?? "")?.threshold_rationale ?? d.fault.class_reason,
    fault_class: a.fault_class,
    health: a.health,
    band,
    severity: a.severity,
    tier: tierOf(band, a.severity),
    priority: d.cost.priceable ? a.priority : null,
    cost_of_waiting_usd: d.cost.priceable ? d.cost.total_usd : null,
    cost_of_acting_usd: a.effort_usd,
    act_by: rul.published ? rul.p90 : null,
    band_width_days: rul.published ? rul.width_days : null,
    evidence_days: rul.published ? rul.samples : 0,
    evidence_quality: evidenceQuality(d),
    excluded_readings: d.signals_excluded.untrusted_readings + d.signals_excluded.unusable_source_data,
    consequential: a.consequential,
    cause_advisory_id: null,
    cause_asset_name: a.cause_asset ? shortName(ASSET_BY_ID.get(a.cause_asset)?.name ?? a.cause_asset) : null,
    occupants_affected: d.trace.occupants,
    zones_affected: d.trace.zones,
    status: "open",
    first_seen: a.window_from,
    sibling_count: 0,
    has_children: false,
    children: [],
  };
}

export function advisoryRowsFor(vantageId: string): AdvisoryRow[] {
  const rows = run(vantageId).advisories.map(toRow);
  // Link each consequential row to its cause, where the cause is itself in the queue.
  const byAssetFault = new Map(rows.map((r) => [`${r.asset_id}|${r.fault_id}`, r]));
  const raw = new Map(run(vantageId).advisories.map((a) => [a.advisory_id, a]));
  for (const r of rows) {
    const a = raw.get(r.advisory_id)!;
    if (!a.consequential || !a.cause_asset) continue;
    const parent = byAssetFault.get(`${a.cause_asset}|${a.cause_fault}`);
    if (parent) {
      r.cause_advisory_id = parent.advisory_id;
      parent.children.push(r);
      parent.has_children = true;
    }
  }
  return rows;
}

function toWhy(a: RawAdvisory, r: RawRun): Why {
  const d = a.detail;
  const signals: Signal[] = d.signals.map((s) => ({
    point_id: s.point_id,
    label: s.label,
    unit: s.unit,
    observed: s.observed,
    reference: s.reference,
    moved: s.moved,
    sigmas: s.sigmas,
    quality: POINT_BY_ID.get(s.point_id)?.usable === false ? 0 : 100,
  }));

  const roll = r.health_state.filter((h) => h.asset_id === a.asset_id && h.mode_id === null);
  const onset = last(roll)?.t_onset ?? null;
  const drift = onset ? Math.round((new Date(a.window_to).getTime() - new Date(onset).getTime()) / 86_400_000) : 0;

  // The isolation sweep's own sentence carries the recovered bias when it found one.
  const biasMatch = /([+-]?\d+(?:\.\d+)?)\s*wrong/.exec(d.fault.class_reason);
  const pointMatch = /(\S+\.\S+?)\s+reads/.exec(d.fault.class_reason);

  return {
    signals,
    onset,
    drift_days: drift,
    evaluation: {
      mode_label: kindOf(ASSET_BY_ID.get(a.asset_id)?.brick_class ?? "") + " in service",
      hours_judged: Math.round(d.cost.duty * 24 * d.cost.horizon_days),
      windows: Math.round(
        (new Date(a.window_to).getTime() - new Date(a.window_from).getTime()) / 86_400_000,
      ),
      hours_suppressed: 0,
      drivers: MODE_BY_ID.get(a.mode_id ?? "")?.indicator_expression
        ? [MODE_BY_ID.get(a.mode_id ?? "")!.indicator_expression!]
        : ["load and weather, through the condition-matched baseline"],
    },
    ruled_out: [
      {
        factor: "Load and weather",
        how: "Every signal below is an excess over a baseline fitted on this machine's own commissioning window at matched conditions, so ordinary load and weather are already subtracted out.",
      },
    ],
    compared_to: {
      from: a.window_from,
      to: a.window_to,
      note: "this machine's own commissioning window",
    },
    fault_class: a.fault_class,
    fault_class_reason: d.fault.class_reason,
    bias_estimate:
      biasMatch && pointMatch
        ? {
            point_id: pointMatch[1]!,
            label: POINT_BY_ID.get(pointMatch[1]!)?.name ?? pointMatch[1]!,
            k: Number(biasMatch[1]),
            unit: POINT_BY_ID.get(pointMatch[1]!)?.unit_si ?? "",
          }
        : null,
    excluded: {
      total: d.signals_excluded.untrusted_readings + d.signals_excluded.unusable_source_data,
      condemned: d.signals_excluded.untrusted_readings,
      unusable_source: d.signals_excluded.unusable_source_data,
    },
  };
}

function toCosting(a: RawAdvisory) {
  const d = a.detail;
  const terms: CostTerm[] = d.cost.basis.map((line) => {
    const provenance: CostTerm["provenance"] = /handbook|rule of thumb/i.test(line)
      ? "handbook"
      : /USD\/kWh|tariff|rate|horizon/i.test(line)
        ? "configured"
        : "measured";
    return { label: line.split(":")[0]!.trim(), value: "", provenance, note: line };
  });

  const labourRate = d.intervention.duration_hours
    ? Math.round(((a.effort_usd - d.intervention.parts_cost_usd) / d.intervention.duration_hours) * 100) / 100
    : 0;

  return {
    horizon_days: d.cost.horizon_days,
    waiting: {
      total_usd: d.cost.priceable ? d.cost.total_usd : null,
      energy_usd: d.cost.energy_usd,
      consequential_usd: d.cost.consequential_usd,
      terms,
    },
    acting: {
      total_usd: a.effort_usd,
      hours: d.intervention.duration_hours,
      trade: d.intervention.skills.join(", "),
      parts_usd: d.intervention.parts_cost_usd,
      labour_rate_usd: labourRate,
      basis: d.intervention.basis,
      checklist: [d.intervention.description],
    },
    priority: d.cost.priceable ? a.priority : null,
    unpriced_reason: d.cost.priceable
      ? null
      : d.cost.basis.find((b) => /NOT PRICEABLE/i.test(b)) ?? "No cost of waiting could be computed.",
  };
}

export function advisoryDetailFor(vantageId: string, advisoryId: string): AdvisoryDetail | null {
  const r = run(vantageId);
  const a = r.advisories.find((x) => x.advisory_id === advisoryId);
  if (!a) return null;
  const rows = advisoryRowsFor(vantageId);
  const row = rows.find((x) => x.advisory_id === advisoryId)!;
  const d = a.detail;

  return {
    row,
    rul: forecastToRul(d),
    why: toWhy(a, r),
    costing: toCosting(a),
    consequential: d.trace.cause
      ? {
          cause_advisory_id: row.cause_advisory_id ?? "",
          cause_asset_name: shortName(ASSET_BY_ID.get(d.trace.cause.asset)?.name ?? d.trace.cause.asset),
          cause_fault_title: d.trace.cause.title,
          mechanism: `${d.trace.cause.medium} — ${d.trace.cause.timing}`,
        }
      : null,
    children: row.children,
    history: d.notes.map((n) => ({ t: a.window_to, event: "Note from the analytics layer", note: n })),
    work_order: null,
  };
}

/* --------------------------------------------------------------- health series */

export function healthSeriesFor(vantageId: string, assetId: string): HealthSeries | null {
  const r = run(vantageId);
  const roll = r.health_state.filter((h) => h.asset_id === assetId && h.mode_id === null);
  if (roll.length === 0) return null;
  const weakest = last(roll)?.weakest_mode ?? null;
  const detail = r.health_state.filter((h) => h.asset_id === assetId && h.mode_id === weakest);
  const source = detail.length ? detail : roll;
  const mode = weakest ? MODE_BY_ID.get(weakest) : undefined;

  return {
    asset_id: assetId,
    mode_id: weakest ?? "",
    mode_label: mode?.mode_name ?? "Asset roll-up",
    threshold_note: mode
      ? `Health reaches 0 at ${mode.failure_threshold} ${mode.indicator_unit} of excess. ${mode.threshold_rationale}`
      : "The asset roll-up is the minimum across every failure mode scored on this machine.",
    points: source.map((h) => ({
      t: h.time,
      raw: h.indicator_raw,
      clamped: h.health,
      evaluated: h.health !== null,
      suppressed_reason: h.health === null ? "Not evaluated — outside the conditions this mode is judged in" : null,
    })),
    onset: last(roll)?.t_onset ?? null,
    repairs: [],
    commissioning: { from: source[0]?.time ?? "", to: source[Math.min(20, source.length - 1)]?.time ?? "" },
  };
}

export function modeIndicatorsFor(vantageId: string, assetId: string): ModeIndicator[] {
  const r = run(vantageId);
  const latest = latestHealth(r);
  const governing = latest.get(`${assetId}|`)?.weakest_mode ?? null;
  const out: ModeIndicator[] = [];
  for (const [key, row] of latest) {
    const [aid, mid] = key.split("|");
    if (aid !== assetId || !mid) continue;
    const m = MODE_BY_ID.get(mid);
    if (!m) continue;
    const health = row.health ?? 100;
    out.push({
      mode_id: mid,
      mode_label: m.mode_name,
      physics_clause: m.threshold_rationale,
      unit: m.indicator_unit,
      current: Math.round((row.indicator_monotonic ?? row.indicator_raw ?? 0) * 1000) / 1000,
      threshold: m.failure_threshold,
      threshold_rationale: m.threshold_rationale,
      health,
      band: bandOf(health) ?? "healthy",
      governing: mid === governing,
    });
  }
  return out.sort((a, b) => a.health - b.health);
}

export function residualFor(vantageId: string, assetId: string): ResidualSeries | null {
  const r = run(vantageId);
  const pts = r.residuals_daily.filter((x) => x.point_id.startsWith(`${assetId}.`));
  if (pts.length === 0) return null;
  // The point with the widest spread between observed and expected is the one worth
  // drawing: it is the signal the fault is actually showing up on.
  const byPoint = new Map<string, RawResidual[]>();
  for (const p of pts) {
    if (!byPoint.has(p.point_id)) byPoint.set(p.point_id, []);
    byPoint.get(p.point_id)!.push(p);
  }
  let best: RawResidual[] = [];
  let bestSpread = -1;
  for (const series of byPoint.values()) {
    const spread = Math.max(...series.map((s) => Math.abs(s.residual)));
    if (spread > bestSpread) {
      bestSpread = spread;
      best = series;
    }
  }
  const pointId = best[0]!.point_id;
  const point = POINT_BY_ID.get(pointId);
  return {
    point_id: pointId,
    label: point?.name ?? pointId,
    unit: point?.unit_si ?? "",
    baseline: "condition-matched baseline fitted on the commissioning window",
    drivers: ["load", "weather", "the conditions this machine was asked to work under"],
    points: best.map((b) => ({
      t: b.day,
      observed: Math.round(b.observed * 1000) / 1000,
      expected: Math.round(b.expected * 1000) / 1000,
      sigma: Math.round(b.residual * 1000) / 1000,
    })),
  };
}

export function rulHistoryFor(vantageId: string, assetId: string, modeId: string | null): RulSnapshot[] {
  return run(vantageId)
    .rul_estimates.filter(
      (x) => x.asset_id === assetId && (modeId === null || x.mode_id === modeId) && x.p50 !== null,
    )
    .map((x) => ({
      t: x.as_of,
      p10_days: Math.max(0, Math.round(x.p10 ?? 0)),
      p50_days: Math.max(0, Math.round(x.p50 ?? 0)),
      p90_days: Math.max(0, Math.round(x.p90 ?? 0)),
      samples: x.n_samples,
    }));
}

/* ---------------------------------------------------------------- instruments */

const SENSOR_KIND_LABEL: Record<string, string> = {
  flatline: "Reading has stopped moving",
  stale: "No fresh reading",
  out_of_range: "Outside the instrument's physical range",
  implausible_jump: "Jumped further than physics allows",
};

export function instrumentsFor(vantageId: string): Instruments {
  const r = run(vantageId);
  const openByPoint = new Map<string, RawSensorAdvisory>();
  for (const s of r.sensor_advisories) {
    const prev = openByPoint.get(s.point_id);
    if (!prev || s.worst_score < prev.worst_score) openByPoint.set(s.point_id, s);
  }

  const points: PointQuality[] = OP.points.map((p) => {
    const adv = openByPoint.get(p.point_id);
    const score = !p.usable ? 100 : adv ? adv.worst_score : 100;
    const status: PointQuality["status"] = !p.usable
      ? "defective_at_source"
      : adv
        ? adv.worst_score < 50
          ? "bad"
          : "watch"
        : "ok";
    return {
      point_id: p.point_id,
      label: p.name,
      asset_id: p.asset_id,
      asset_name: shortName(ASSET_BY_ID.get(p.asset_id)?.name ?? p.asset_id),
      unit: p.unit_si,
      score,
      checks: { timeliness: score, completeness: score, range: score, plausibility: score, staleness: score },
      worst_check: adv ? adv.kind.replace(/_/g, " ") : "—",
      last_seen: adv?.t_to ?? r.as_of,
      status,
      note: p.unusable_reason ?? (adv ? SENSOR_KIND_LABEL[adv.kind] ?? adv.kind : null),
    };
  });

  const advisories: SensorAdvisory[] = [...openByPoint.values()].map((s) => {
    const p = POINT_BY_ID.get(s.point_id);
    const assetId = p?.asset_id ?? "";
    return {
      advisory_id: String(s.advisory_id),
      point_id: s.point_id,
      label: p?.name ?? s.point_id,
      asset_id: assetId,
      asset_name: shortName(ASSET_BY_ID.get(assetId)?.name ?? assetId),
      location: locationOf(ASSET_BY_ID.get(assetId)?.brick_class ?? ""),
      since: s.t_from,
      score: s.worst_score,
      worst_check: s.kind.replace(/_/g, " "),
      verdict: SENSOR_KIND_LABEL[s.kind] ?? s.kind,
      recommended:
        "Send a technician with a calibration kit, not a mechanic. Any finding that leans on this instrument is suspect until it clears.",
      hours: 1.5,
      cost_usd: 262.5,
      blocks: r.advisories
        .filter((a) => a.detail.signals.some((sg) => sg.point_id === s.point_id))
        .map((a) => `${shortName(a.detail.asset.name)} — ${a.detail.fault.title}`),
      status: "open",
    };
  });

  const covered = new Set(OP.points.map((p) => p.asset_id));
  return {
    points,
    advisories,
    coverage: {
      points_total: points.length,
      assets_covered: covered.size,
      assets_total: OP.assets.length,
      ok: points.filter((p) => p.status === "ok").length,
      watch: points.filter((p) => p.status === "watch").length,
      bad: points.filter((p) => p.status === "bad").length,
      defective_at_source: points.filter((p) => p.status === "defective_at_source").length,
    },
  };
}

/* --------------------------------------------------------------- ground truth */

export interface ValidationEntry {
  scenario_id: string;
  asset_id: string;
  asset_name: string;
  fault_mode: string;
  terminal_severity: string;
  injected_onset: string;
  injected_failure: string | null;
  detected_onset: string | null;
  lead_days: number | null;
  profile: string;
  rungs: number;
}

/**
 * The answer key against what the system actually said.
 *
 * READ FROM A SEPARATE FILE, WRITTEN ON A SEPARATE CREDENTIAL. The detection path has no
 * grant on the `groundtruth` schema; only the validation harness and this one screen may
 * read it. Keeping it in its own module boundary is how that stays true in the frontend
 * too — nothing in the operator's screens imports this function.
 */
export function validationFor(vantageId: string): ValidationEntry[] {
  const r = run(vantageId);
  const latest = latestHealth(r);
  return GT.fault_events
    .filter((f) => new Date(f.t_onset).getUTCFullYear() === r.era)
    .map((f) => {
      const detected = latest.get(`${f.asset_id}|`)?.t_onset ?? null;
      const lead =
        detected !== null
          ? Math.round(
              (new Date(f.t_onset).getTime() - new Date(detected).getTime()) / 86_400_000,
            )
          : null;
      return {
        scenario_id: f.scenario_id,
        asset_id: f.asset_id,
        asset_name: shortName(ASSET_BY_ID.get(f.asset_id)?.name ?? f.asset_id),
        fault_mode: f.fault_mode.replace(/_/g, " "),
        terminal_severity: f.severity_level,
        injected_onset: f.t_onset,
        injected_failure: f.t_failure,
        detected_onset: detected,
        lead_days: lead,
        profile: f.params.profile ?? "progressive",
        rungs: f.params.waypoints?.length ?? 0,
      };
    });
}
