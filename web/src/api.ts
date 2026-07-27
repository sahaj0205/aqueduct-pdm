/**
 * Typed access to the API, over the dev-server proxy.
 *
 * Every call goes to a same-origin /api path, so nothing here knows a hostname and
 * no request is cross-origin. See vite.config.ts.
 */

import type {
  AdvisoryDetail,
  AdvisorySummary,
  AnswerKey,
  AssetSummary,
  ClockRange,
  GraphResult,
  HealthSeries,
  RulHistory,
  SiteSummary,
  TwinState,
  TwinTopology,
} from "./types.ts";

const BASE = "/api";

// The reveal service, on its own path because it is its own process on its own
// credential. Kept separate here rather than folded into BASE so that a reader of
// this file can see which calls reach the answer key -- there are exactly two, both
// below, and neither is used by anything that decides what the operator sees.
const REVEAL = "/reveal";

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

/** `?as_of=` when the clock has a position, nothing when it does not. */
function asOf(at: string | null, first = false): string {
  if (!at) return "";
  return `${first ? "?" : "&"}as_of=${encodeURIComponent(at)}`;
}

export const api = {
  advisories: (status = "open", at: string | null = null) =>
    get<AdvisorySummary[]>(
      `/advisories?status=${encodeURIComponent(status)}${asOf(at)}`,
    ),
  summary: (at: string | null = null) =>
    get<SiteSummary>(`/advisories/summary${asOf(at, true)}`),
  eras: () => get<ClockRange>("/clock/eras"),
  // The building's shape, fetched once -- it cannot change while the API runs.
  twinTopology: () => get<TwinTopology>("/twin/topology"),
  // Every live number for one moment, in one call, so a running clock costs one
  // request per tick rather than one per node.
  twinState: (at: string) =>
    get<TwinState>(`/twin/state?as_of=${encodeURIComponent(at)}`),
  assets: () => get<AssetSummary[]>("/assets"),
  advisory: (id: string) =>
    get<AdvisoryDetail>(`/advisories/${encodeURIComponent(id)}`),
  rulHistory: (assetId: string, at: string | null = null) =>
    get<RulHistory>(
      `/assets/${encodeURIComponent(assetId)}/rul-history${asOf(at, true)}`,
    ),
  downstream: (assetId: string) =>
    get<GraphResult>(`/graph/downstream/${encodeURIComponent(assetId)}`),
  health: (assetId: string, from: string, to: string) =>
    get<HealthSeries>(
      `/assets/${encodeURIComponent(assetId)}/health` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
};

/**
 * The answer key. A SEPARATE SERVICE on a separate credential, reached over its own
 * proxy path, and deliberately its own object rather than two more methods on `api`.
 * Nothing that decides what the operator sees may call these; the control bar uses
 * them for labels and degrades to dates alone when the service is not running.
 */
export const reveal = {
  scenarios: async (): Promise<AnswerKey | null> => {
    try {
      const response = await fetch(`${REVEAL}/reveal/scenarios`);
      if (!response.ok) return null;
      return (await response.json()) as AnswerKey;
    } catch {
      return null;
    }
  },
};
