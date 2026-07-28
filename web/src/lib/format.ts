/**
 * Turning API rows into the exact strings the queue shows.
 *
 * A separate pure module rather than logic inside the components, for one reason
 * that matters more than tidiness: this project has no test suite by deliberate
 * decision, so the only way to check what the dashboard will display is to run the
 * same functions against the live API and read the output. scripts/verify-queue.ts
 * does exactly that. Formatting buried in JSX could only be verified by looking at a
 * browser, and "I looked at it" is not a verification anybody can repeat.
 *
 * Every function here is total: it takes nulls and returns something an operator can
 * read. None of them invents a number.
 */

import type { AdvisorySummary } from "../types.ts";

/** USD, no decimals. Cents on a five-figure estimate are false precision. */
export function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * The priority cell. "unpriced" rather than a dash, and never 0.00 standing in.
 *
 * The distinction is the one the API is careful about: a null priority means the cost
 * of inaction could not be computed, which is not the same claim as a priority of
 * zero. Zero says the work is not worth doing. Unpriced says nobody knows, and the
 * row is ranked on severity instead.
 */
export function priorityLabel(advisory: AdvisorySummary): string {
  return advisory.priority === null ? "unpriced" : advisory.priority.toFixed(2);
}

/**
 * The remaining-life countdown.
 *
 * Returns a short cell value and a longer band. When there is no prediction the cell
 * is an em dash and the band names WHY, because the reason is the actionable part:
 * "withheld, health and the estimate contradict each other" and "this finding is not
 * a degradation trend" call for completely different responses from an operator, and
 * a shared blank cell would hide both.
 */
export function countdown(advisory: AdvisorySummary): {
  value: string;
  band: string;
  bounded: boolean;
} {
  const { p10, p50, p90 } = advisory;
  if (p50 === null || p10 === null || p90 === null) {
    return { value: "—", band: shortRefusal(advisory.why), bounded: false };
  }
  if (p90 <= 0) {
    return { value: "now", band: "threshold already reached", bounded: true };
  }
  return {
    value: `${Math.round(p50)} d`,
    band: `${Math.round(p10)}–${Math.round(p90)} d`,
    bounded: true,
  };
}

/**
 * The tail of a refusal sentence, without the "no prediction:" preamble.
 *
 * The full sentence is correct and long; the queue has one line. Truncation keeps the
 * first clause, which is always the reason, and the whole sentence stays available in
 * the row's title attribute and on the detail view.
 */
export function shortRefusal(why: string): string {
  const stripped = why.replace(/^no prediction:\s*/i, "").replace(/^withheld:\s*/i, "");
  const clause = stripped.split(/[,.]/)[0] ?? stripped;
  return clause.length > 58 ? `${clause.slice(0, 55).trimEnd()}…` : clause;
}

/** Health as a cell. Null is "n/a" and not 0 — a rule firing has no health score. */
export function healthLabel(health: number | null): string {
  return health === null ? "n/a" : String(health);
}

/**
 * Which severity band a health score falls in, for colouring only.
 *
 * FOUR TIERS, AND THE BOUNDARIES COME FROM DESIGN_SEMANTIC.md: 85 and above is healthy,
 * 70 to 84 is watch, 50 to 69 is degraded, below 50 is critical. They are the same four
 * tiers a severity badge uses, deliberately — a health number and a severity badge in the
 * same row must never disagree about how bad something is.
 *
 * CHANGED FROM BEFORE: thresholds at 70 and 40 producing three bands called ok, warn and
 * bad. Those were invented here; these come from the specification, and the NAMES changed
 * with them because "ok" and "bad" describe a feeling while "healthy" and "critical" name
 * a tier that exists elsewhere in the system.
 *
 * Presentational only: nothing downstream branches on the result.
 */
export type HealthBand = "none" | "healthy" | "watch" | "degraded" | "critical";

export function healthBand(health: number | null): HealthBand {
  if (health === null) return "none";
  if (health >= 85) return "healthy";
  if (health >= 70) return "watch";
  if (health >= 50) return "degraded";
  return "critical";
}

/** One queue row, fully resolved. */
export interface QueueRow {
  rank: number;
  advisory: AdvisorySummary;
  priority: string;
  countdown: ReturnType<typeof countdown>;
  health: string;
  healthBand: ReturnType<typeof healthBand>;
  cost: string;
  effort: string;
  /** Set when this advisory is a consequence of an upstream fault. */
  upstream: { asset: string; fault: string } | null;
}

/**
 * Build the rows in the order the operator reads them.
 *
 * The order comes from the API and is NOT recomputed here. That is deliberate: the
 * two-tier ranking — priced rows on money, unpriced rows on severity, consequential
 * rows demoted below their own cause — is decided by the analytics layer, and a
 * dashboard that re-sorted would be free to disagree with the numbers it is
 * displaying. The rank number is just the position it arrived in.
 */
export function buildRows(advisories: AdvisorySummary[]): QueueRow[] {
  return advisories.map((advisory, index) => ({
    rank: index + 1,
    advisory,
    priority: priorityLabel(advisory),
    countdown: countdown(advisory),
    health: healthLabel(advisory.health),
    healthBand: healthBand(advisory.health),
    cost: usd(advisory.cost_usd),
    effort: usd(advisory.effort_usd),
    upstream:
      advisory.consequential && advisory.cause_asset && advisory.cause_fault
        ? { asset: advisory.cause_asset, fault: advisory.cause_fault }
        : null,
  }));
}

/* --------------------------------------------------------------------------
 * colour, which is data here and not decoration
 * ------------------------------------------------------------------------ */

/**
 * The four states a drawn component can be in, and the colour of a fault class.
 *
 * THE VALUES MOVED OUT of this file into design/palette.ts. They used to be written
 * here as literal hex codes, and so were sixty-eight others scattered across seven more
 * components, with no two files agreeing on which grey was the muted one. Colour is now
 * declared in exactly two places that name each other — design/tokens.css for anything
 * styled by CSS, design/palette.ts for anything that has to be a literal string.
 *
 * WHY THEY STILL HAVE TO BE LITERAL STRINGS rather than var(--x): scripts/verify-twin.ts
 * writes the building drawing out to a standalone .svg and opens it on its own, where a
 * custom property resolves against nothing and the drawing arrives colourless.
 *
 * Re-exported under the old names because five components import them from here.
 */
export { NODE as COLOURS, CLASS as CLASS_COLOUR } from "../design/palette.ts";

/**
 * How a drawn machine is filled. The same four tiers as health and severity, plus
 * "unknown" for a node nothing is being claimed about — DESIGN_SEMANTIC.md requires
 * assets on the plant drawing to take the health band scale, so this is that scale
 * rather than a parallel one.
 */
export type NodeState = "unknown" | "healthy" | "watch" | "degraded" | "critical";

/**
 * How a node is filled: by remaining life if there is one, otherwise by health.
 *
 * The fallback is deliberate and is the difference between a useful picture and a grey
 * one. Most machines here have a health score long before the remaining-life model
 * will bound a crossing — it refuses until a changepoint is confirmed and the drift is
 * separable from zero — so filling only on remaining life would grey out equipment
 * whose condition is perfectly well known. Remaining life is preferred where it exists
 * because "fails in three weeks" is a stronger statement than "scores 61".
 */
export function conditionBand(
  rulDays: number | null,
  health: number | null,
): NodeState {
  if (rulDays !== null) {
    if (rulDays < RUL_CRITICAL_DAYS) return "critical";
    if (rulDays < RUL_DEGRADING_DAYS) return "degraded";
    return "healthy";
  }
  const band = healthBand(health);
  return band === "none" ? "unknown" : band;
}

/* Thresholds in days. Presentational only — nothing branches on them outside this
   file. Thirty days is the shortest horizon a technician can be scheduled inside
   without disrupting other work; ninety matches the planning horizon every advisory's
   cost of inaction is already computed over, so the two agree. */
const RUL_CRITICAL_DAYS = 30;
const RUL_DEGRADING_DAYS = 90;

/**
 * How far a reading has drifted, as a band for the node's border.
 *
 * Null for the great majority of readings, and that is reported rather than filled in:
 * only six of this building's hundred and seven points have a fitted baseline, so only
 * the nodes carrying those can say anything about drift at all. A node with no border
 * is a node nothing is being claimed about.
 */
export function driftBand(sigma: number | null): NodeState | null {
  if (sigma === null) return null;
  const magnitude = Math.abs(sigma);
  if (magnitude >= 3) return "critical";
  if (magnitude >= 2) return "degraded";
  return "healthy";
}
