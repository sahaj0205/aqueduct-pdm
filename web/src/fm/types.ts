/**
 * The facility-manager platform's data contract.
 *
 * WHAT THIS FILE IS FOR. Every shape here is what a future endpoint will return. The
 * screens import only from this file and from `data/client.ts` / `data/mutations.ts`;
 * they never see the seed. When the backend lands, those two files swap their function
 * bodies for `fetch` calls and nothing in `screens/` or `components/` changes.
 *
 * `| null` means the same thing everywhere: the system declines to say. It is never
 * "we forgot". Every nullable field has a sibling carrying the reason, and the UI is
 * obliged to render the reason rather than an empty cell.
 *
 * THE REFUSAL IS A UNION, NOT A NULLABLE. `Rul` is either published or refused-with-a-
 * reason. Modelling it as `p50: number | null` would let a screen render a blank; a
 * discriminated union makes the compiler insist the refusal branch is drawn.
 *
 * NO CLOCK. This is a live operations tool, not a replay of stored history. Every read
 * answers "as of now"; history that a screen needs (a health trend, a residual series,
 * a track record) is returned as a time series inside that screen's own payload rather
 * than driven by a global "as of" the whole app pivots on.
 */

/* ------------------------------------------------------------------ vocabulary */

/** The four severity tiers. Never red-amber-green — see design/tokens.css. */
export type Tier = "critical" | "high" | "medium" | "low";

/** Health quantises onto the same four: 85+ / 70-84 / 50-69 / under 50. */
export type HealthBand = "healthy" | "watch" | "degraded" | "critical";

/** Stage 10's verdict. `ambiguous` is a real answer, not a fallback. */
export type FaultClass = "sensor" | "equipment" | "control" | "ambiguous";

/** Both orderings are computed server-side. The worklist never sorts client-side. */
export type WorklistOrder = "priority" | "deadline";

/** How much of the evidence behind a row survived the quality layer. */
export type EvidenceQuality = "clean" | "partial" | "degraded";

export type AdvisoryStatus = "open" | "scheduled" | "dismissed" | "done";

/* ------------------------------------------------------------------- vantage */

/**
 * Which run of the building the platform is looking at, and where inside it "now" is.
 *
 * WHY THIS EXISTS AT ALL, given the product deliberately has no clock. The backend does
 * not hold one continuous building history — it holds several independent 120-day
 * simulation runs, each placed in its own calendar year so that two runs never write the
 * same instrument at the same instant. So "now" is not a global fact; it is a property
 * of whichever run is being served.
 *
 * A DEPLOYMENT CONTROL, NOT A PRODUCT FEATURE. A real installation pins exactly one
 * vantage in configuration and the facility manager never sees this. It is surfaced here
 * because this build serves several runs out of one database and a reviewer needs to be
 * able to reach them. That is why it sits in the shell's utility bar rather than in the
 * navigation.
 */
export interface Vantage {
  id: string;
  /** Short label for the control itself. */
  label: string;
  /** The calendar year the run occupies. */
  era: number;
  /** The instant inside the run that the platform treats as the present. */
  as_of: string;
  /** What is going on in this run — shown under the label so the choice means something. */
  note: string;
  /** False until this run's analytics have been computed and loaded. */
  available: boolean;
}

/* ------------------------------------------------------------------- screen 1 */

export interface Overview {
  generated_at: string;
  assets_total: number;
  buckets: Record<HealthBand, number>;
  /** Assets with no failure mode scored in this run. They belong to no band, and
   *  leaving them out of the counts entirely would make the building look smaller
   *  than it is. */
  unscored: number;
  /** The energy term of cost-of-waiting, summed across open advisories. */
  attributable_waste: {
    kwh_per_day: number;
    usd_per_day: number;
    horizon_days: number;
  };
  blind_spots: {
    points_total: number;
    /** Instruments with no fresh reading in the last expected interval. */
    stale: number;
    /** Columns that never meant what their name said. Stage 2 knows these by name. */
    defective_at_source: number;
  };
  /** New since the last 24 hours. */
  changes: {
    new_advisories: number;
    newly_predicted: number;
    resolved: number;
  };
  worst: {
    asset_id: string;
    asset_name: string;
    health: number;
    mode_label: string;
  } | null;
  open_total: number;
  unpriced_total: number;
  sensor_advisories_total: number;
}

/* ------------------------------------------------------------------- topology */

/** One box on the plant drawing. `x`/`y` are on a 0-100 grid, laid out server-side. */
export interface TopoNode {
  id: string;
  label: string;
  kind: string;
  health: number | null;
  band: HealthBand | null;
  open_advisories: number;
  x: number;
  y: number;
  /** Zones are drawn differently — they are consumers, not plant. */
  is_zone: boolean;
  occupants: number;
}

export interface TopoEdge {
  from: string;
  to: string;
  /** What flows. Root-cause reasoning needs this: a cause must degrade the medium
   *  consumed. */
  medium: string;
}

export interface Topology {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

/* -------------------------------------------------------------------- assets */

export interface Asset {
  asset_id: string;
  name: string;
  kind: string;
  /** Mechanical room / floor. Drives crew batching on the schedule screen. */
  location: string;
  health: number | null;
  band: HealthBand | null;
  weakest_mode: string | null;
  weakest_mode_label: string | null;
  open_advisories: number;
  occupants_served: number;
  replacement_cost_usd: number | null;
  /** Commissioned, in service since. */
  in_service: string;
}

/* ------------------------------------------------------------------- screen 2 */

/**
 * One row of the worklist.
 *
 * Grouped by asset at assembly: the worst advisory is the row, and `sibling_count`
 * says how many others are folded behind it. Ten alerts on one chiller is one problem.
 */
export interface AdvisoryRow {
  advisory_id: string;
  asset_id: string;
  asset_name: string;
  location: string;
  fault_id: string;
  /** Plain name, from the `failure_modes.plain_name` column. */
  fault_title: string;
  /** One clause of physics, from `failure_modes.physics_clause`. */
  physics_clause: string;
  fault_class: FaultClass;
  health: number | null;
  band: HealthBand | null;
  /** 0..1. Two measured terms carry 0.7, two context terms carry 0.3. */
  severity: number;
  tier: Tier;
  /** USD saved per USD spent. null means the cost of waiting could not be computed. */
  priority: number | null;
  cost_of_waiting_usd: number | null;
  cost_of_acting_usd: number;
  /** The pessimistic date, or null when the prediction refused. */
  act_by: string | null;
  /** Days between the optimistic and pessimistic date. This is the confidence. */
  band_width_days: number | null;
  /** Days of post-onset evidence. The other half of the confidence. */
  evidence_days: number;
  evidence_quality: EvidenceQuality;
  excluded_readings: number;
  /** Demoted beneath an upstream cause. Never hidden. */
  consequential: boolean;
  cause_advisory_id: string | null;
  cause_asset_name: string | null;
  occupants_affected: number;
  zones_affected: string[];
  status: AdvisoryStatus;
  first_seen: string;
  sibling_count: number;
  /** True when this row is the parent of demoted children. */
  has_children: boolean;
  /** Consequential rows demoted beneath this one. Nested for display, never hidden. */
  children: AdvisoryRow[];
}

export interface Worklist {
  generated_at: string;
  order: WorklistOrder;
  /** Rows with a computable cost, ranked on money. Consequential rows are nested under
   *  their cause rather than ranked independently. */
  priced: AdvisoryRow[];
  /** Rows without one, ranked on severity. Never shown as $0.00. */
  unpriced: AdvisoryRow[];
  unpriced_note: string;
  /** Dismissed in the last 30 days, so a dismissal is never a silent disappearance. */
  recently_dismissed: (AdvisoryRow & { dismissed_reason: string; dismissed_note: string; dismissed_at: string })[];
}

/**
 * Every open, published remaining-life window on one shared axis — purely a
 * re-rendering of numbers stage 9 already publishes, laid out for comparison instead
 * of one advisory at a time. Days are relative to now, not calendar dates, so they
 * plot directly on a 0..horizon axis.
 */
export interface HorizonRow {
  advisory_id: string;
  asset_id: string;
  asset_name: string;
  fault_title: string;
  tier: Tier;
  p10_days: number;
  p50_days: number;
  p90_days: number;
}

/** A refused prediction never gets a band — not a wide one, none at all — so it is
 *  listed separately rather than omitted silently. */
export interface HorizonUnestimated {
  advisory_id: string;
  asset_name: string;
  fault_title: string;
  reason: string;
}

export interface Horizon {
  generated_at: string;
  horizon_days: number;
  rows: HorizonRow[];
  unestimated: HorizonUnestimated[];
}

/* ------------------------------------------------------------------- screen 3 */

export interface HealthPoint {
  t: string;
  /** Raw indicator mapped to 0-100. Stored so the clamp can be audited. */
  raw: number | null;
  /** After the monotonic clamp. The number the rest of the system uses. */
  clamped: number | null;
  /** False where judgement was suppressed. Drawn as a labelled gap, not a hole. */
  evaluated: boolean;
  suppressed_reason: string | null;
}

export interface RepairEvent {
  t: string;
  note: string;
  by: string;
}

export interface HealthSeries {
  asset_id: string;
  mode_id: string;
  mode_label: string;
  threshold_note: string;
  points: HealthPoint[];
  /** The onset date. "Decline began here", and the system will defend it. */
  onset: string | null;
  repairs: RepairEvent[];
  commissioning: { from: string; to: string };
}

/** Stored per reading: what a healthy machine would have read, and what it did. */
export interface ResidualPoint {
  t: string;
  observed: number;
  expected: number;
  sigma: number;
}

export interface ResidualSeries {
  point_id: string;
  label: string;
  unit: string;
  baseline: string;
  drivers: string[];
  points: ResidualPoint[];
}

/** One day's remaining-life estimate. Stacked, these are the fan chart. */
export interface RulSnapshot {
  t: string;
  p10_days: number;
  p50_days: number;
  p90_days: number;
  samples: number;
}

/** A per-failure-mode indicator, so an asset shows every way it is wearing out. */
export interface ModeIndicator {
  mode_id: string;
  mode_label: string;
  physics_clause: string;
  unit: string;
  current: number;
  threshold: number;
  threshold_rationale: string;
  health: number;
  band: HealthBand;
  /** True for the mode that produced the asset's health — health is the minimum. */
  governing: boolean;
}

export interface AssetDetail {
  asset: Asset;
  health: HealthSeries;
  modes: ModeIndicator[];
  residual: ResidualSeries | null;
  rul_history: RulSnapshot[];
  advisories: AdvisoryRow[];
  /** Instruments attached to this machine, with their quality scores. */
  points: PointQuality[];
}

/* --------------------------------------------------------------- advisory detail */

/**
 * The prediction, or the specific reason there is not one.
 *
 * Four gates: confirmed onset, 21 days of post-onset evidence, a rate of decline
 * measurably above zero, and a range no wider than the observation behind it.
 */
export type Rul =
  | {
      published: true;
      p10: string;
      p50: string;
      p90: string;
      width_days: number;
      evidence_days: number;
      samples: number;
      /** How much narrower than the first published estimate. The trust story. */
      first_width_days: number;
    }
  | {
      published: false;
      gate: "onset" | "evidence" | "rate" | "width";
      reason: string;
      /** What would have to be true. Printed where the date would have gone. */
      needs: string;
    };

/** One contributing signal, with its healthy reference beside it. */
export interface Signal {
  point_id: string;
  label: string;
  unit: string;
  observed: number;
  reference: number;
  moved: number;
  /** Movement in units of this point's own spread over the healthy window. */
  sigmas: number;
  quality: number;
}

/**
 * The why panel. Exists to answer "it's just hot outside" before it is asked.
 *
 * `evaluation` records which mode the machine was judged in, for how long, and which
 * conditions the baseline already accounts for — so weather and load are shown as
 * already-regressed-out rather than left for the reader to wonder about.
 */
export interface Why {
  signals: Signal[];
  onset: string | null;
  drift_days: number;
  evaluation: {
    mode_label: string;
    hours_judged: number;
    windows: number;
    hours_suppressed: number;
    /** The baseline's inputs. Anything here is already accounted for. */
    drivers: string[];
  };
  ruled_out: { factor: string; how: string }[];
  compared_to: { from: string; to: string; note: string };
  fault_class: FaultClass;
  fault_class_reason: string;
  /** A recovered sensor bias, when the diagnosis thinks the instrument is lying. */
  bias_estimate: { point_id: string; label: string; k: number; unit: string } | null;
  excluded: { total: number; condemned: number; unusable_source: number };
}

/** One line of the cost arithmetic, tagged with where its value came from. */
export interface CostTerm {
  label: string;
  value: string;
  provenance: "measured" | "configured" | "handbook";
  note: string;
}

export interface Costing {
  horizon_days: number;
  waiting: {
    total_usd: number | null;
    energy_usd: number | null;
    consequential_usd: number | null;
    terms: CostTerm[];
  };
  acting: {
    total_usd: number;
    hours: number;
    trade: string;
    parts_usd: number;
    labour_rate_usd: number;
    basis: string;
    /** What to open, what to look at. */
    checklist: string[];
  };
  priority: number | null;
  unpriced_reason: string | null;
}

export interface AdvisoryDetail {
  row: AdvisoryRow;
  rul: Rul;
  why: Why;
  costing: Costing;
  /** Set when this row was demoted beneath an upstream cause. */
  consequential: {
    cause_advisory_id: string;
    cause_asset_name: string;
    cause_fault_title: string;
    mechanism: string;
  } | null;
  /** Symptoms demoted beneath this row. Nested in the worklist, never hidden. */
  children: AdvisoryRow[];
  /** Every advisory ever raised on this machine, and what was found. */
  history: { t: string; event: string; note: string }[];
  work_order: WorkOrder | null;
}

/* ------------------------------------------------------------------- write-backs */

export type DismissReason =
  | "already_scheduled"
  | "known_and_accepted"
  | "false_alarm_suspected"
  | "other";

export interface WorkOrder {
  work_order_id: string;
  advisory_id: string;
  asset_id: string;
  asset_name: string;
  job: string;
  trade: string;
  hours: number;
  cost_usd: number;
  status: "raised" | "scheduled" | "done";
  raised_at: string;
  scheduled_for: string | null;
  done_at: string | null;
  assignee: string | null;
  found: string | null;
}

/* ------------------------------------------------------------------- screen 6 */

export interface ScheduleItem {
  advisory_id: string;
  work_order_id: string | null;
  asset_id: string;
  asset_name: string;
  location: string;
  job: string;
  trade: string;
  hours: number;
  cost_usd: number;
  /** The pessimistic date. Null rows are scheduled on severity instead. */
  act_by: string | null;
  tier: Tier;
  /** Set when the job may not be done in the month it falls in. */
  season_block: string | null;
  scheduled_for: string | null;
  /** Who a work order (if any) has been assigned to, and its status. */
  assignee: string | null;
  work_order_status: WorkOrder["status"] | null;
}

/** Jobs that share a trade and a mechanical room. One visit instead of four. */
export interface CrewBatch {
  batch_id: string;
  location: string;
  trade: string;
  items: ScheduleItem[];
  total_hours: number;
  total_cost_usd: number;
  window_start: string;
  window_end: string;
  trips_saved: number;
}

export interface Schedule {
  generated_at: string;
  horizon_days: number;
  batches: CrewBatch[];
  /** Jobs that batch with nothing. */
  singles: ScheduleItem[];
  /** Month buckets for the calendar strip. */
  months: { month: string; label: string; hours: number; cost_usd: number; count: number }[];
}

/* ------------------------------------------------------------------- screen 7 */

export type RecordOutcome =
  | "confirmed"
  | "not_found"
  | "dismissed_then_failed"
  | "in_progress"
  | "open";

export interface RecordEntry {
  advisory_id: string;
  asset_name: string;
  fault_title: string;
  raised: string;
  actioned: string | null;
  outcome: RecordOutcome;
  /** What the technician wrote down. The loop closing. */
  found: string | null;
  health_before: number | null;
  health_after: number | null;
  /** Health climbing after a recorded repair is the confirmation, without a label. */
  recovered: boolean | null;
  spend_usd: number | null;
  avoided_usd: number | null;
  dismissed_reason: string | null;
}

export interface FieldRecord {
  raised: number;
  actioned: number;
  confirmed: number;
  not_found: number;
  dismissed_then_failed: number;
  open: number;
  spend_usd: number;
  avoided_usd: number;
  /** Only counts closed jobs where health actually recovered. */
  avoided_basis: string;
  /** confirmed / (confirmed + not_found) — among advisories a technician actually went
   *  and checked, how often the system was right. Null until at least one case has
   *  been verified in the field; never a modelled or held-out-label figure. */
  hit_rate: number | null;
  /** How many verified cases the hit rate is computed over — the n behind the %. */
  verified_n: number;
  entries: RecordEntry[];
}

/* ------------------------------------------------------------------- screen 8 */

export interface PointQuality {
  point_id: string;
  label: string;
  asset_id: string;
  asset_name: string;
  unit: string;
  /** Composite = the worst of the five, never the average. */
  score: number;
  checks: {
    timeliness: number;
    completeness: number;
    range: number;
    plausibility: number;
    staleness: number;
  };
  worst_check: string;
  last_seen: string;
  status: "ok" | "watch" | "bad" | "defective_at_source";
  /** Required when status is defective_at_source. The written reason. */
  note: string | null;
}

export interface SensorAdvisory {
  advisory_id: string;
  point_id: string;
  label: string;
  asset_id: string;
  asset_name: string;
  location: string;
  since: string;
  score: number;
  worst_check: string;
  verdict: string;
  recommended: string;
  hours: number;
  cost_usd: number;
  /** Advisories on machines that this instrument's evidence feeds. */
  blocks: string[];
  status: AdvisoryStatus;
}

export interface Instruments {
  points: PointQuality[];
  advisories: SensorAdvisory[];
  coverage: {
    points_total: number;
    assets_covered: number;
    assets_total: number;
    ok: number;
    watch: number;
    bad: number;
    defective_at_source: number;
  };
}

/* -------------------------------------------------------------- configuration */

/** Read-only "show working" material: the failure modes and the job library. */
export interface FailureModeConfig {
  mode_id: string;
  plain_name: string;
  physics_clause: string;
  applies_to: string;
  expression: string;
  threshold: number;
  unit: string;
  threshold_rationale: string;
  kw_per_unit: number | null;
}

export interface InterventionConfig {
  intervention_id: string;
  job: string;
  fault_id: string;
  fault_class: FaultClass;
  trade: string;
  hours: number;
  parts_usd: number;
  basis: string;
  checklist: string[];
  season_block: string | null;
}
