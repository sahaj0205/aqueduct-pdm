/**
 * The API contract, mirrored in TypeScript.
 *
 * Hand-written rather than generated from the OpenAPI schema. That is a deliberate
 * trade for a project this size: a generator adds a build step and a large file
 * nobody reads, and these are the only nine endpoints there will ever be. The cost
 * is that a field renamed in api/models.py has to be renamed here too, and the
 * compiler will say so.
 *
 * `| null` appears on a lot of fields and means the same thing everywhere: the
 * system declines to say. It is never "we forgot". Every nullable field has a
 * sibling carrying the reason, and the UI is obliged to render the reason rather
 * than an empty cell — a blank tells an operator nothing, and worse, it looks like
 * a bug in the dashboard rather than a considered refusal by the model.
 */

export type FaultClass = "sensor" | "equipment" | "control" | "ambiguous";

export interface AdvisorySummary {
  advisory_id: string;
  asset_id: string;
  asset_name: string;
  fault_id: string;
  fault_title: string;
  fault_class: FaultClass;
  mode_id: string | null;
  status: string;
  health: number | null;
  severity: number;
  /** USD saved per USD spent. null means the cost of inaction could not be computed. */
  priority: number | null;
  cost_usd: number;
  effort_usd: number;
  consequential: boolean;
  cause_asset: string | null;
  cause_fault: string | null;
  /** The remaining-life sentence, or the specific reason there is none. */
  why: string;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  generated_at: string;
}

export interface SiteSummary {
  assets: number;
  advisories: number;
  consequential: number;
  unpriced: number;
  by_class: Partial<Record<FaultClass, number>>;
  worst_health: number | null;
  worst_health_asset: string | null;
  total_cost_of_inaction_usd: number;
  total_effort_usd: number;
  horizon_days: number;
  generated_at: string | null;
}

export interface AssetSummary {
  asset_id: string;
  name: string;
  brick_class: string;
  criticality_tier: number;
  replacement_cost_usd: number | null;
  occupants_served: number;
  health: number | null;
  weakest_mode: string | null;
  health_as_of: string | null;
  open_advisories: number;
}

/* ------------------------------------------------------------------------- *
 * The advisory detail payload.
 *
 * Mirrors `as_payload` in analytics/advisories/generate.py, which is the single
 * place the published shape is decided. The API passes this through as an opaque
 * object on purpose — re-declaring forty nested fields in Pydantic AND here would
 * be two contracts to keep in step instead of one — so this interface is the only
 * place the shape is written down for the frontend, and it is the file to change
 * when that function changes.
 * ------------------------------------------------------------------------- */

export interface Signal {
  point_id: string;
  label: string;
  unit: string;
  observed: number;
  reference: number;
  moved: number;
  /** Movement in units of the point's own spread over the reference window. */
  sigmas: number;
}

export interface AdvisoryPayload {
  asset: { id: string; name: string };
  fault: {
    id: string;
    title: string;
    source: "failure_mode" | "rule";
    mode_id: string | null;
    fault_class: FaultClass;
    class_reason: string;
  };
  health: number | null;
  window: { from: string; to: string };
  forecast: {
    sentence: string;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    as_of: string | null;
    n_samples: number | null;
    /** Non-null means no interval may be drawn. The chart must honour this. */
    refusal: string | null;
    probability_within_horizon: number | null;
  };
  signals: Signal[];
  signals_excluded: { unusable_source_data: number; untrusted_readings: number };
  diagnosis_evidence: string[];
  trace: {
    upstream: { asset: string; hops: number }[];
    downstream_assets: string[];
    zones: string[];
    occupants: number;
    cause: {
      asset: string;
      fault: string;
      title: string;
      hops: number;
      medium: string;
      mechanism: string;
      timing: string;
    } | null;
  };
  severity: {
    score: number;
    terms: Record<string, number>;
    weights: Record<string, number>;
    slope_per_day: number;
    slope_days: number;
    criticality_tier: number;
    occupants: number;
  };
  cost: {
    horizon_days: number;
    total_usd: number;
    energy_usd: number;
    consequential_usd: number;
    excess_kw: number;
    duty: number;
    priceable: boolean;
    basis: string[];
  };
  effort_usd: number;
  priority: number | null;
  intervention: {
    id: string;
    description: string;
    duration_hours: number;
    skills: string[];
    parts: string[];
    parts_cost_usd: number;
    basis: string;
    matched_on_class: boolean;
  } | null;
  notes: string[];
}

export interface AdvisoryDetail {
  advisory_id: string;
  asset_id: string;
  fault_id: string;
  status: string;
  generated_at: string;
  window_from: string;
  window_to: string;
  detail: AdvisoryPayload;
}

export interface RulPoint {
  as_of: string;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** p90 - p10 in days. null when either end is unbounded. */
  width: number | null;
  mu_hat: number;
  sigma_hat: number;
  n_samples: number;
}

export interface RulHistory {
  asset_id: string;
  modes: Record<string, RulPoint[]>;
  failure_threshold: Record<string, number>;
  indicator_unit: Record<string, string>;
}

export interface HealthPoint {
  time: string;
  mode_id: string | null;
  health: number | null;
  indicator_raw: number | null;
  indicator_monotonic: number | null;
  t_onset: string | null;
  weakest_mode: string | null;
}

export interface HealthSeries {
  asset_id: string;
  modes: string[];
  series: HealthPoint[];
}

export interface GraphNode {
  asset_id: string;
  name: string;
  brick_class: string;
  hops: number;
  health: number | null;
  open_advisories: number;
}

export interface GraphResult {
  asset_id: string;
  direction: string;
  nodes: GraphNode[];
  /** Occupied spaces reached. Downstream only. */
  zones: string[];
  occupants: number;
}

/* --------------------------------------------------------------------------
 * the clock, and the answer key that labels it
 * ------------------------------------------------------------------------ */

export interface EraSummary {
  era: number;
  t_from: string;
  t_to: string;
  days: number;
  assets: string[];
  /** Days inside the run with an advisory queue. Fewer than `days` is normal. */
  queue_days: number;
}

export interface ClockRange {
  eras: EraSummary[];
  t_from: string;
  t_to: string;
}

export interface Rung {
  level: number;
  label: string;
  source_file: string;
}

/**
 * One fault the answer key says was injected.
 *
 * Served by the reveal API, which runs as a separate process on a separate
 * credential. Everything here is ground truth and nothing in the operator view may
 * depend on it — the control bar uses it for labels only, and works without it.
 */
export interface InjectedFault {
  scenario_id: string;
  system: string;
  asset_id: string;
  fault_mode: string;
  terminal_severity: string;
  profile: string;
  t_onset: string;
  t_failure: string | null;
  t_start: string;
  t_end: string;
  ladder: Rung[];
  seed: number | null;
}

export interface CleanRun {
  scenario_id: string;
  system: string;
  t_start: string;
  t_end: string;
}

export interface AnswerKey {
  faults: InjectedFault[];
  clean_runs: CleanRun[];
}

/* --------------------------------------------------------------------------
 * the digital twin
 * ------------------------------------------------------------------------ */

export interface TwinPoint {
  graph_name: string;
  /** Null where the model declares a sensor that never became a stored column. */
  point_id: string | null;
  brick_class: string;
  name: string | null;
  unit_si: string | null;
}

export interface TwinNode {
  node_id: string;
  label: string;
  brick_class: string;
  /** Null for nodes the database does not model as an asset: the two water loops. */
  asset_id: string | null;
  parent: string | null;
  points: TwinPoint[];
}

export interface TwinEdge {
  from_node: string;
  to_node: string;
  /** feeds = flow, and the direction a fault travels. hasPart = containment. */
  relation: string;
}

export interface TwinTopology {
  nodes: TwinNode[];
  edges: TwinEdge[];
  node_count: number;
  edge_count: number;
  point_count: number;
  point_attachments: number;
}

export interface TwinPointState {
  point_id: string;
  value: number | null;
  at: string | null;
  /** The raw sample the residual was computed from. Subtract from THIS, not `value`. */
  observed: number | null;
  residual_at: string | null;
  expected: number | null;
  residual: number | null;
  /** Drift in units of the baseline's own spread. Null wherever expected is null. */
  sigma: number | null;
  baseline_id: string | null;
}

export interface TwinAssetState {
  asset_id: string;
  health: number | null;
  weakest_mode: string | null;
  health_at: string | null;
  rul_mode: string | null;
  rul_p10: number | null;
  rul_p50: number | null;
  rul_p90: number | null;
  rul_as_of: string | null;
  open_advisories: number;
}

export interface TwinState {
  as_of: string;
  advisory_vintage: string | null;
  points: Record<string, TwinPointState>;
  assets: Record<string, TwinAssetState>;
  points_reporting: number;
  points_with_baseline: number;
  stale_after_hours: number;
}

/* --------------------------------------------------------------------------
 * the engine trace
 * ------------------------------------------------------------------------ */

export interface TraceStage {
  ordinal: number;
  stage: string;
  /** Changes three times down the funnel. Bars must break where it does. */
  unit: string;
  entered: number;
  passed: number;
  dropped: Record<string, number>;
  detail: Record<string, unknown>;
}

export interface MachineTrace {
  asset_id: string;
  as_of: string;
  stages: TraceStage[];
  /** The same machine on the same day of the year with nothing wrong, where one exists. */
  clean: TraceStage[] | null;
  clean_as_of: string | null;
}

/* --------------------------------------------------------------------------
 * sensor versus equipment
 * ------------------------------------------------------------------------ */

export interface ClassChange {
  day: string;
  fault_class: string;
  class_reason: string;
}

export interface Intervention {
  intervention_id: string;
  description: string;
  duration_hours: number;
  parts: string[];
  skills: string[];
  parts_cost_usd: number;
  basis: string;
  effort_usd: number;
}

export interface DiagnosisCase {
  asset_id: string;
  fault_id: string;
  title: string;
  as_of: string;
  fault_class: string;
  class_reason: string;
  evidence: string[];
  intervention: Intervention | null;
  /** The same fault dispatched the other way. A real advisory, not a lookup. */
  alternative: Intervention | null;
  history: ClassChange[];
}

export interface DiagnosisPair {
  left: DiagnosisCase | null;
  right: DiagnosisCase | null;
  /** True when the two faults are from different runs and no clock position holds both. */
  composed: boolean;
  cost_ratio: number | null;
}
