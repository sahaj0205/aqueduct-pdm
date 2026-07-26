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
 * Thresholds at 70 and 40 are presentational and carry no analytical weight: nothing
 * downstream branches on them and no number in the system changes if they move. They
 * exist so an operator can find the bad rows without reading every digit.
 */
export function healthBand(health: number | null): "none" | "ok" | "warn" | "bad" {
  if (health === null) return "none";
  if (health >= 70) return "ok";
  if (health >= 40) return "warn";
  return "bad";
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
