/**
 * Every read the facility-manager platform performs.
 *
 * THIS FILE IS THE API SEAM. Each export is what a future `GET` will return — the
 * comment above it names the endpoint it stands in for. Screens call these and never
 * touch `adapt.ts` or `store.ts` directly, so replacing a body with `fetch(...)` is the
 * whole migration, one function at a time.
 *
 * WHAT IT COMPOSES. Base data comes from `adapt.ts`, which reads a real export of the
 * analytics tables. Anything a human did — dismissed, scheduled, repaired — comes from
 * `store.ts` and is merged on top here. That is exactly the split the backend will have:
 * pipeline-written tables plus human-written ones.
 */

import {
  VANTAGES,
  advisoryDetailFor,
  advisoryRowsFor,
  assetsFor,
  healthSeriesFor,
  instrumentsFor,
  modeIndicatorsFor,
  residualFor,
  rulHistoryFor,
  topologyFor,
  validationFor,
} from "./adapt.ts";
import type { ValidationEntry } from "./adapt.ts";
import { store } from "./store.ts";
import type {
  AdvisoryDetail,
  AdvisoryRow,
  Asset,
  AssetDetail,
  CrewBatch,
  FieldRecord,
  Horizon,
  Instruments,
  Overview,
  RecordEntry,
  RulSnapshot,
  Schedule,
  ScheduleItem,
  Topology,
  Vantage,
  Worklist,
  WorklistOrder,
} from "../types.ts";

const LATENCY_MS = 90;
const HORIZON_DAYS = 90;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function vid(): string {
  return store.state.vantageId;
}

/** Base rows with any human-set status layered on. */
function rows(): AdvisoryRow[] {
  const overlay = store.state.status;
  return advisoryRowsFor(vid()).map((r) => ({ ...r, status: overlay.get(r.advisory_id) ?? r.status }));
}

function openOrScheduled(r: AdvisoryRow): boolean {
  return r.status === "open" || r.status === "scheduled";
}

/* ------------------------------------------------------------------- GET /fm/vantages */

export async function getVantages(): Promise<{ vantages: Vantage[]; selected: Vantage }> {
  const selected = VANTAGES.find((v) => v.id === vid()) ?? VANTAGES[0]!;
  return delay({ vantages: VANTAGES, selected });
}

/* ------------------------------------------------------------------- GET /fm/overview */

export async function getOverview(): Promise<Overview> {
  const assets = assetsFor(vid());
  const live = rows().filter(openOrScheduled);
  // Same rule as the worklist: a symptom only stops counting on its own when its cause
  // is present to absorb it.
  const topLevel = live.filter((r) => !r.consequential || !r.cause_advisory_id);
  const instruments = instrumentsFor(vid());

  const buckets: Overview["buckets"] = { healthy: 0, watch: 0, degraded: 0, critical: 0 };
  for (const a of assets) if (a.band) buckets[a.band]++;

  // Only the energy term, and only where it could be computed at all.
  const energyUsd = live.reduce((sum, r) => sum + (r.cost_of_waiting_usd ?? 0), 0);
  const usdPerDay = energyUsd / HORIZON_DAYS;

  const scored = assets.filter((a): a is Asset & { health: number } => a.health !== null);
  const worst = [...scored].sort((a, b) => a.health - b.health)[0];

  return delay({
    generated_at: new Date().toISOString(),
    assets_total: assets.length,
    buckets,
    unscored: assets.filter((a) => a.band === null).length,
    attributable_waste: {
      kwh_per_day: Math.round((usdPerDay / 0.128) * 10) / 10,
      usd_per_day: Math.round(usdPerDay * 100) / 100,
      horizon_days: HORIZON_DAYS,
    },
    blind_spots: {
      points_total: instruments.coverage.points_total,
      stale: instruments.coverage.bad + instruments.coverage.watch,
      defective_at_source: instruments.coverage.defective_at_source,
    },
    changes: { new_advisories: 0, newly_predicted: 0, resolved: store.state.recordHistory.length },
    worst: worst
      ? {
          asset_id: worst.asset_id,
          asset_name: worst.name,
          health: worst.health,
          mode_label: worst.weakest_mode_label ?? "",
        }
      : null,
    open_total: topLevel.length,
    unpriced_total: topLevel.filter((r) => r.priority === null).length,
    sensor_advisories_total: instruments.advisories.filter(
      (s) => !store.state.acknowledgedSensors.has(s.advisory_id),
    ).length,
  });
}

/* ------------------------------------------------------------------ GET /fm/topology */

export async function getTopology(): Promise<Topology> {
  return delay(topologyFor(vid()));
}

/* --------------------------------------------------------------------- GET /fm/assets */

export async function getAssets(): Promise<Asset[]> {
  return delay(assetsFor(vid()));
}

/* --------------------------------------------------------------- GET /fm/assets/{id} */

export async function getAssetDetail(assetId: string): Promise<AssetDetail> {
  const asset = assetsFor(vid()).find((a) => a.asset_id === assetId);
  if (!asset) throw new Error(`no such asset: ${assetId}`);
  const health = healthSeriesFor(vid(), assetId);
  const modes = modeIndicatorsFor(vid(), assetId);
  const advisories = rows().filter((r) => r.asset_id === assetId);
  const governing = modes.find((m) => m.governing)?.mode_id ?? null;

  return delay({
    asset,
    health:
      health ?? {
        asset_id: assetId,
        mode_id: "",
        mode_label: "Not scored in this run",
        threshold_note:
          "No failure mode is scored on this machine in this run, so it has no health history here.",
        points: [],
        onset: null,
        repairs: [],
        commissioning: { from: "", to: "" },
      },
    modes,
    residual: residualFor(vid(), assetId),
    rul_history: rulHistoryFor(vid(), assetId, governing),
    advisories,
    points: instrumentsFor(vid()).points.filter((p) => p.asset_id === assetId),
  });
}

/* -------------------------------------------------------------------- GET /fm/worklist */

function deadlineSort(a: AdvisoryRow, b: AdvisoryRow): number {
  if (a.act_by === null && b.act_by === null) return b.severity - a.severity;
  if (a.act_by === null) return 1;
  if (b.act_by === null) return -1;
  return a.act_by.localeCompare(b.act_by);
}

function prioritySort(a: AdvisoryRow, b: AdvisoryRow): number {
  return (b.priority ?? -Infinity) - (a.priority ?? -Infinity);
}

export async function getWorklist(order: WorklistOrder = "priority"): Promise<Worklist> {
  const live = rows().filter(openOrScheduled);
  // A consequential row drops out of the top level ONLY when its cause is also in the
  // queue for it to nest under. If the cause is not open here, the symptom stands on its
  // own — the queue may be badly ordered, but it must never be incomplete.
  const topLevel = live.filter((r) => !r.consequential || !r.cause_advisory_id);

  const priced = topLevel.filter((r) => r.priority !== null);
  const unpriced = topLevel.filter((r) => r.priority === null);
  priced.sort(order === "priority" ? prioritySort : deadlineSort);
  unpriced.sort((a, b) => b.severity - a.severity);

  const all = rows();
  const recentlyDismissed = store.state.dismissed
    .map((d) => {
      const row = all.find((r) => r.advisory_id === d.advisory_id);
      return row
        ? { ...row, dismissed_reason: d.reason, dismissed_note: d.note, dismissed_at: d.at }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return delay({
    generated_at: new Date().toISOString(),
    order,
    priced,
    unpriced,
    unpriced_note: "Below: no cost computed — ranked on severity, not on money.",
    recently_dismissed: recentlyDismissed,
  });
}

/* --------------------------------------------------------------------- GET /fm/horizon */

function daysFromNowOf(iso: string, from: number): number {
  return Math.round((new Date(iso).getTime() - from) / 86_400_000);
}

export async function getHorizon(): Promise<Horizon> {
  const asOf = new Date(VANTAGES.find((v) => v.id === vid())?.as_of ?? Date.now()).getTime();
  const live = rows().filter((r) => openOrScheduled(r) && (!r.consequential || !r.cause_advisory_id));

  const out: Horizon["rows"] = [];
  const unestimated: Horizon["unestimated"] = [];

  for (const r of live) {
    const detail = advisoryDetailFor(vid(), r.advisory_id);
    if (detail?.rul.published) {
      out.push({
        advisory_id: r.advisory_id,
        asset_id: r.asset_id,
        asset_name: r.asset_name,
        fault_title: r.fault_title,
        tier: r.tier,
        p10_days: Math.max(0, daysFromNowOf(detail.rul.p10, asOf)),
        p50_days: Math.max(0, daysFromNowOf(detail.rul.p50, asOf)),
        p90_days: Math.max(0, daysFromNowOf(detail.rul.p90, asOf)),
      });
    } else {
      unestimated.push({
        advisory_id: r.advisory_id,
        asset_name: r.asset_name,
        fault_title: r.fault_title,
        reason: detail && !detail.rul.published ? detail.rul.reason : "No estimate published.",
      });
    }
  }
  out.sort((a, b) => a.p50_days - b.p50_days);

  return delay({ generated_at: new Date().toISOString(), horizon_days: HORIZON_DAYS, rows: out, unestimated });
}

/* -------------------------------------------------------------- GET /fm/advisories/{id} */

export async function getAdvisoryDetail(advisoryId: string): Promise<AdvisoryDetail> {
  const detail = advisoryDetailFor(vid(), advisoryId);
  if (!detail) throw new Error(`no such advisory: ${advisoryId}`);
  const wo = [...store.state.workOrders.values()].find((w) => w.advisory_id === advisoryId) ?? null;
  const status = store.state.status.get(advisoryId) ?? detail.row.status;
  return delay({ ...detail, row: { ...detail.row, status }, work_order: wo });
}

/** GET /fm/advisories/{id}/rul-history */
export async function getRulHistory(advisoryId: string): Promise<RulSnapshot[]> {
  const row = rows().find((r) => r.advisory_id === advisoryId);
  if (!row) return delay([]);
  const modes = modeIndicatorsFor(vid(), row.asset_id);
  const governing = modes.find((m) => m.governing)?.mode_id ?? null;
  return delay(rulHistoryFor(vid(), row.asset_id, governing));
}

/* -------------------------------------------------------------------- GET /fm/schedule */

function toScheduleItem(row: AdvisoryRow, detail: AdvisoryDetail | null): ScheduleItem {
  const wo = [...store.state.workOrders.values()].find((w) => w.advisory_id === row.advisory_id) ?? null;
  return {
    advisory_id: row.advisory_id,
    work_order_id: wo?.work_order_id ?? null,
    asset_id: row.asset_id,
    asset_name: row.asset_name,
    location: row.location,
    job: detail?.costing.acting.checklist[0] ?? row.fault_title,
    trade: detail?.costing.acting.trade ?? "Mechanical",
    hours: detail?.costing.acting.hours ?? 0,
    cost_usd: row.cost_of_acting_usd,
    act_by: row.act_by,
    tier: row.tier,
    season_block: null,
    scheduled_for: wo?.scheduled_for ?? null,
    assignee: wo?.assignee ?? null,
    work_order_status: wo?.status ?? null,
  };
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export async function getSchedule(): Promise<Schedule> {
  const live = rows().filter((r) => openOrScheduled(r) && r.cost_of_acting_usd > 0);
  const items = live.map((r) => toScheduleItem(r, advisoryDetailFor(vid(), r.advisory_id)));

  const groups = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = `${item.location}::${item.trade}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const batches: CrewBatch[] = [];
  const singles: ScheduleItem[] = [];
  let n = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) {
      singles.push(...group);
      continue;
    }
    const [location, trade] = key.split("::") as [string, string];
    const dates = group.map((i) => i.act_by).filter((d): d is string => d !== null).sort();
    n += 1;
    batches.push({
      batch_id: `batch-${n}`,
      location,
      trade,
      items: group,
      total_hours: group.reduce((s, i) => s + i.hours, 0),
      total_cost_usd: group.reduce((s, i) => s + i.cost_usd, 0),
      window_start: dates[0] ?? "",
      window_end: dates[dates.length - 1] ?? "",
      trips_saved: group.length - 1,
    });
  }

  const months = new Map<string, { hours: number; cost_usd: number; count: number }>();
  for (const item of items) {
    if (!item.act_by) continue;
    const d = new Date(item.act_by);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const b = months.get(key) ?? { hours: 0, cost_usd: 0, count: 0 };
    b.hours += item.hours;
    b.cost_usd += item.cost_usd;
    b.count += 1;
    months.set(key, b);
  }
  const monthRows = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      label: MONTH_LABELS[new Date(`${month}-01T00:00:00Z`).getUTCMonth()]!,
      ...v,
    }));

  return delay({
    generated_at: new Date().toISOString(),
    horizon_days: HORIZON_DAYS,
    batches,
    singles,
    months: monthRows,
  });
}

/* ---------------------------------------------------------------- GET /fm/field-record */

export async function getFieldRecord(): Promise<FieldRecord> {
  const all = rows();
  const dismissedEntries: RecordEntry[] = store.state.dismissed.map((d) => {
    const row = all.find((r) => r.advisory_id === d.advisory_id);
    return {
      advisory_id: d.advisory_id,
      asset_name: row?.asset_name ?? d.advisory_id,
      fault_title: row?.fault_title ?? "",
      raised: row?.first_seen ?? d.at,
      actioned: d.at,
      outcome: "open",
      found: null,
      health_before: row?.health ?? null,
      health_after: null,
      recovered: null,
      spend_usd: null,
      avoided_usd: null,
      dismissed_reason: d.note,
    };
  });

  const entries = [...store.state.recordHistory, ...dismissedEntries];
  const confirmed = entries.filter((e) => e.outcome === "confirmed").length;
  const notFound = entries.filter((e) => e.outcome === "not_found").length;
  const verifiedN = confirmed + notFound;

  return delay({
    raised: entries.length,
    actioned: entries.filter((e) => e.actioned !== null).length,
    confirmed,
    not_found: notFound,
    dismissed_then_failed: entries.filter((e) => e.outcome === "dismissed_then_failed").length,
    open: entries.filter((e) => e.outcome === "open" || e.outcome === "in_progress").length,
    spend_usd: entries.reduce((s, e) => s + (e.spend_usd ?? 0), 0),
    avoided_usd: entries.reduce((s, e) => s + (e.recovered ? e.avoided_usd ?? 0 : 0), 0),
    avoided_basis:
      "Counted only for closed jobs where health was observed to recover afterward — never a modelled or assumed figure.",
    hit_rate: verifiedN > 0 ? confirmed / verifiedN : null,
    verified_n: verifiedN,
    entries: entries.sort((a, b) => b.raised.localeCompare(a.raised)),
  });
}

/* ------------------------------------------------------------------ GET /fm/validation
 *
 * The answer key against what the system said. Served here because this build is a
 * benchmark with ground truth behind it; a real installation has no such endpoint, and
 * the Track Record screen shows only its field half.
 */
export async function getValidation(): Promise<ValidationEntry[]> {
  return delay(validationFor(vid()));
}

/* ----------------------------------------------------------------- GET /fm/instruments */

export async function getInstruments(): Promise<Instruments> {
  const base = instrumentsFor(vid());
  const acked = store.state.acknowledgedSensors;
  return delay({
    ...base,
    advisories: base.advisories.map((s) => ({
      ...s,
      status: acked.has(s.advisory_id) ? "done" : s.status,
    })),
  });
}
