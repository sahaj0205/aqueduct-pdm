/**
 * Every write the facility-manager platform performs.
 *
 * THREE VERBS, MATCHING THE THREE HUMAN ACTIONS THE PIPELINE CANNOT RECORD: raising a
 * work order, dismissing an advisory, and logging a completed repair. Each stands in for
 * a future `POST`/`PATCH` — the comment above it names the endpoint — and each writes to
 * the overlay in `store.ts`, never to the analytics data itself.
 *
 * The job details a work order needs (trade, hours, cost) are read from the advisory
 * rather than passed in by the caller, so a screen cannot raise a work order for work
 * the analytics layer did not actually recommend.
 */

import { advisoryDetailFor } from "./adapt.ts";
import { store } from "./store.ts";
import type { DismissReason, WorkOrder } from "../types.ts";

const LATENCY_MS = 110;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

/** POST /fm/advisories/{id}/work-order */
export async function raiseWorkOrder(
  advisoryId: string,
  opts: { assignee: string; scheduledFor: string | null },
): Promise<WorkOrder> {
  const detail = advisoryDetailFor(store.state.vantageId, advisoryId);
  if (!detail) throw new Error(`no such advisory: ${advisoryId}`);
  const wo = store.raiseWorkOrder(advisoryId, {
    assignee: opts.assignee,
    scheduledFor: opts.scheduledFor,
    assetId: detail.row.asset_id,
    assetName: detail.row.asset_name,
    job: detail.costing.acting.checklist[0] ?? detail.row.fault_title,
    trade: detail.costing.acting.trade,
    hours: detail.costing.acting.hours,
    costUsd: detail.costing.acting.total_usd,
  });
  return delay(wo);
}

/** POST /fm/advisories/{id}/dismiss */
export async function dismissAdvisory(
  advisoryId: string,
  reason: DismissReason,
  note: string,
): Promise<void> {
  store.dismissAdvisory(advisoryId, reason, note);
  return delay(undefined);
}

/** POST /fm/advisories/{id}/reopen — undoes a dismissal. */
export async function reopenAdvisory(advisoryId: string): Promise<void> {
  store.reopenAdvisory(advisoryId);
  return delay(undefined);
}

/** POST /fm/advisories/{id}/repair */
export async function recordRepair(advisoryId: string, note: string, by: string): Promise<void> {
  const detail = advisoryDetailFor(store.state.vantageId, advisoryId);
  if (!detail) throw new Error(`no such advisory: ${advisoryId}`);
  store.recordRepair(advisoryId, note, by, {
    assetName: detail.row.asset_name,
    faultTitle: detail.row.fault_title,
    raised: detail.row.first_seen,
    healthBefore: detail.row.health,
  });
  return delay(undefined);
}

/**
 * Change which run the platform is serving.
 *
 * Not an operator action — a deployment one. In a real installation the vantage is
 * pinned in configuration and this never runs.
 */
export async function selectVantage(vantageId: string): Promise<void> {
  store.selectVantage(vantageId);
  return delay(undefined);
}

/** POST /fm/instruments/{id}/acknowledge */
export async function acknowledgeSensorAdvisory(advisoryId: string): Promise<void> {
  store.acknowledgeSensorAdvisory(advisoryId);
  return delay(undefined);
}
