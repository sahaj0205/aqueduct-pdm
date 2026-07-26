/**
 * Typed access to the API, over the dev-server proxy.
 *
 * Every call goes to a same-origin /api path, so nothing here knows a hostname and
 * no request is cross-origin. See vite.config.ts.
 */

import type {
  AdvisoryDetail,
  AdvisorySummary,
  AssetSummary,
  GraphResult,
  HealthSeries,
  RulHistory,
  SiteSummary,
} from "./types.ts";

const BASE = "/api";

/**
 * One fetch, with the failure path treated as seriously as the success path.
 *
 * A dashboard that renders an empty table when the API is down is worse than one
 * that says the API is down: the empty table reads as "nothing is wrong with the
 * building", which is the single most dangerous thing this screen could imply. So a
 * non-2xx or a network error throws, and the caller shows the message.
 */
async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`);
  } catch (cause) {
    throw new Error(
      `cannot reach the API at ${BASE}${path} — is it running? Start it with ` +
        `\`make api\`. (${String(cause)})`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} from ${path}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
}

export const api = {
  advisories: (status = "open") =>
    get<AdvisorySummary[]>(`/advisories?status=${encodeURIComponent(status)}`),
  summary: () => get<SiteSummary>("/advisories/summary"),
  assets: () => get<AssetSummary[]>("/assets"),
  advisory: (id: string) =>
    get<AdvisoryDetail>(`/advisories/${encodeURIComponent(id)}`),
  rulHistory: (assetId: string) =>
    get<RulHistory>(`/assets/${encodeURIComponent(assetId)}/rul-history`),
  downstream: (assetId: string) =>
    get<GraphResult>(`/graph/downstream/${encodeURIComponent(assetId)}`),
  health: (assetId: string, from: string, to: string) =>
    get<HealthSeries>(
      `/assets/${encodeURIComponent(assetId)}/health` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
};
