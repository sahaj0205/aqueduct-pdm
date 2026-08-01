/**
 * Everything a human has done, layered over the data the pipeline produced.
 *
 * WHY OVERLAYS RATHER THAN A MUTABLE COPY. The advisories, health series and costs all
 * come out of `adapt.ts`, which reads a fixed export of the analytics tables — that is
 * the pipeline's output and nothing in the UI may edit it. What the UI *can* record is
 * the three things the pipeline has no way of knowing: that a work order was raised,
 * that an advisory was dismissed, that a repair was carried out. Those are kept here as
 * small maps keyed by advisory id and merged on read.
 *
 * That split is the same one the backend will need: the analytics tables are written by
 * the pipeline and read by the API, while these three are written by people. Keeping
 * them apart here means wiring the real write endpoints later touches only this file.
 */

import { DEFAULT_VANTAGE_ID } from "./adapt.ts";
import type { AdvisoryStatus, DismissReason, RecordEntry, WorkOrder } from "../types.ts";

interface DismissedRecord {
  advisory_id: string;
  reason: DismissReason;
  note: string;
  at: string;
}

interface State {
  /** Which run of the building is being served. A deployment pins exactly one. */
  vantageId: string;
  /** Advisory id → the status a human moved it to. Absent means "open", as published. */
  status: Map<string, AdvisoryStatus>;
  workOrders: Map<string, WorkOrder>;
  dismissed: DismissedRecord[];
  /** Instrument advisories a technician has been sent for. */
  acknowledgedSensors: Set<string>;
  /**
   * Closed work, built up as repairs are logged. Starts EMPTY on purpose: this build
   * has no maintenance history behind it, and inventing one would be the single most
   * misleading thing the Track Record screen could do.
   */
  recordHistory: RecordEntry[];
  version: number;
}

const state: State = {
  vantageId: DEFAULT_VANTAGE_ID,
  status: new Map(),
  workOrders: new Map(),
  dismissed: [],
  acknowledgedSensors: new Set(),
  recordHistory: [],
  version: 0,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function bump() {
  state.version += 1;
  for (const l of listeners) l();
}

export const store = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get version() {
    return state.version;
  },
  get state() {
    return state;
  },

  selectVantage(vantageId: string) {
    state.vantageId = vantageId;
    bump();
  },

  raiseWorkOrder(
    advisoryId: string,
    opts: { assignee: string; scheduledFor: string | null; assetId: string; assetName: string; job: string; trade: string; hours: number; costUsd: number },
  ): WorkOrder {
    const workOrderId = `WO-${1000 + state.workOrders.size}`;
    const wo: WorkOrder = {
      work_order_id: workOrderId,
      advisory_id: advisoryId,
      asset_id: opts.assetId,
      asset_name: opts.assetName,
      job: opts.job,
      trade: opts.trade,
      hours: opts.hours,
      cost_usd: opts.costUsd,
      status: opts.scheduledFor ? "scheduled" : "raised",
      raised_at: new Date().toISOString(),
      scheduled_for: opts.scheduledFor,
      done_at: null,
      assignee: opts.assignee || null,
      found: null,
    };
    state.workOrders.set(workOrderId, wo);
    state.status.set(advisoryId, "scheduled");
    bump();
    return wo;
  },

  dismissAdvisory(advisoryId: string, reason: DismissReason, note: string) {
    state.status.set(advisoryId, "dismissed");
    state.dismissed.push({ advisory_id: advisoryId, reason, note, at: new Date().toISOString() });
    bump();
  },

  reopenAdvisory(advisoryId: string) {
    state.status.delete(advisoryId);
    state.dismissed = state.dismissed.filter((d) => d.advisory_id !== advisoryId);
    bump();
  },

  recordRepair(
    advisoryId: string,
    note: string,
    by: string,
    meta: { assetName: string; faultTitle: string; raised: string; healthBefore: number | null },
  ) {
    const wo = [...state.workOrders.values()].find((w) => w.advisory_id === advisoryId && w.status !== "done");
    const now = new Date().toISOString();
    const found = `${note} — logged by ${by}`;
    if (wo) {
      state.workOrders.set(wo.work_order_id, { ...wo, status: "done", done_at: now, found, assignee: by });
    }
    state.status.set(advisoryId, "done");
    state.recordHistory.push({
      advisory_id: advisoryId,
      asset_name: meta.assetName,
      fault_title: meta.faultTitle,
      raised: meta.raised,
      actioned: now,
      outcome: "in_progress",
      found,
      health_before: meta.healthBefore,
      health_after: null,
      recovered: null,
      spend_usd: wo?.cost_usd ?? null,
      avoided_usd: null,
      dismissed_reason: null,
    });
    bump();
  },

  acknowledgeSensorAdvisory(advisoryId: string) {
    state.acknowledgedSensors.add(advisoryId);
    bump();
  },
};
