/**
 * Verify the fan chart's data, through the same module the chart renders from.
 *
 * Verification for checkpoint 6.5. What matters about this chart is a property of the
 * data, not of the pixels: the prediction interval has to close as evidence
 * accumulates, and a refused prediction must produce no band at all. Both are checked
 * here against the live API using src/lib/chart.ts — the same functions RulFanChart
 * calls — so the claim "the fan chart narrows" is checkable by somebody who did not
 * look at my screen.
 *
 * What this cannot check is the drawing: that the band is shaded, that the threshold
 * line is dashed amber, that the crossing window is a red region. A screenshot is the
 * only check for those.
 *
 *     API=http://127.0.0.1:8000 npm run verify:detail
 */

import {
  chartWindow,
  crossingWindow,
  fanBand,
  indicatorSeries,
  narrowing,
} from "../src/lib/chart.ts";
import type {
  AdvisoryDetail,
  AdvisorySummary,
  HealthSeries,
  RulHistory,
} from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

function bar(width: number, scale: number): string {
  return "█".repeat(Math.max(1, Math.round(width / scale)));
}

/**
 * TWO KINDS OF FINDING, KEPT APART ON PURPOSE.
 *
 * `failures` are the chart misrepresenting its data: a band drawn for a refused
 * prediction, or a closing percentage computed from fewer than two bounded intervals.
 * Those are defects in this checkpoint and they fail the run.
 *
 * `widening` is a series whose interval does not close. That is a property of the
 * remaining-life model from checkpoint 5.2, not of the chart, and 5.2 already recorded
 * it as an honest partial failure. Treating it as a failure here would be scoring this
 * checkpoint on somebody else's work; hiding it would be worse. So it is reported
 * loudly and separately, with the number.
 */
const failures: string[] = [];
const widening: string[] = [];
const narrowingReport: string[] = [];
const refused: string[] = [];
const incomparable: string[] = [];
const advisories = await get<AdvisorySummary[]>("/advisories?status=open");

for (const summary of advisories) {
  const detail = await get<AdvisoryDetail>(
    `/advisories/${encodeURIComponent(summary.advisory_id)}`,
  );
  const payload = detail.detail;
  const history = await get<RulHistory>(
    `/assets/${encodeURIComponent(detail.asset_id)}/rul-history`,
  ).catch(() => null);

  const span = chartWindow(payload);
  const health = await get<HealthSeries>(
    `/assets/${encodeURIComponent(detail.asset_id)}/health` +
      `?from=${span.from}&to=${span.to}`,
  ).catch(() => null);

  const mode = payload.fault.mode_id;
  const indicator = indicatorSeries(health?.series ?? [], mode);
  const band = fanBand(mode ? (history?.modes[mode] ?? []) : [], payload);
  const stats = narrowing(band);
  const crossing = crossingWindow(payload);
  const threshold = mode ? history?.failure_threshold[mode] : undefined;
  const unit = (mode ? history?.indicator_unit[mode] : undefined) ?? "";

  console.log("=".repeat(104));
  console.log(
    `${detail.advisory_id}   [${payload.fault.fault_class}]` +
      `${payload.trace.cause ? "  CONSEQUENTIAL" : ""}`,
  );
  console.log("=".repeat(104));
  console.log(`  fault            ${payload.fault.title}`);
  console.log(
    `  indicator series ${indicator.length} days` +
      (indicator.length > 0
        ? `, clamped ${indicator[0]!.clamped?.toFixed(3)} → ` +
          `${indicator[indicator.length - 1]!.clamped?.toFixed(3)} ${unit}` +
          `, threshold ${threshold ?? "none"} ${unit}`
        : " — nothing to chart"),
  );
  console.log(
    `  crossing window  ${
      crossing
        ? `${new Date(crossing.p10).toISOString().slice(0, 10)} .. ` +
          `${crossing.p90 === null ? "unbounded" : new Date(crossing.p90).toISOString().slice(0, 10)}` +
          `   P50 ${new Date(crossing.p50).toISOString().slice(0, 10)}`
        : "none — no band may be drawn"
    }`,
  );
  console.log(`  band points      ${band.length}`);

  if (payload.forecast.refusal !== null) {
    // The property that matters for a refused prediction: the chart draws NOTHING.
    const clean = band.length === 0 && crossing === null;
    console.log(`  REFUSED          ${payload.forecast.refusal.slice(0, 88)}…`);
    console.log(
      `  band suppressed  ${clean ? "PASS — no band, no crossing window" : "FAIL"}`,
    );
    refused.push(detail.advisory_id);
    if (!clean) {
      failures.push(`${detail.advisory_id}: refused but a band was produced`);
    }
    console.log();
    continue;
  }

  if (band.length === 0) {
    console.log("  no prediction history in this advisory's own window");
    console.log();
    continue;
  }

  const scale = Math.max(1, (stats.widestWidth ?? 1) / 46);
  console.log();
  console.log(
    `  ${"as_of".padEnd(12)}${"n".padStart(4)}${"P10".padStart(8)}` +
      `${"P50".padStart(8)}${"P90".padStart(10)}${"width".padStart(9)}  interval`,
  );
  const step = Math.max(1, Math.floor(band.length / 14));
  for (let i = 0; i < band.length; i += step) {
    const point = band[i]!;
    console.log(
      `  ${new Date(point.t).toISOString().slice(0, 10).padEnd(12)}` +
        `${String(point.n).padStart(4)}` +
        `${(point.p10?.toFixed(0) ?? "—").padStart(8)}` +
        `${(point.p50?.toFixed(0) ?? "—").padStart(8)}` +
        `${(point.p90?.toFixed(0) ?? "unbounded").padStart(10)}` +
        `${(point.width?.toFixed(0) ?? "—").padStart(9)}  ` +
        (point.width === null ? "(open above)" : bar(point.width, scale)),
    );
  }
  const last = band[band.length - 1]!;
  console.log(
    `  ${new Date(last.t).toISOString().slice(0, 10).padEnd(12)}` +
      `${String(last.n).padStart(4)}` +
      `${(last.p10?.toFixed(0) ?? "—").padStart(8)}` +
      `${(last.p50?.toFixed(0) ?? "—").padStart(8)}` +
      `${(last.p90?.toFixed(0) ?? "unbounded").padStart(10)}` +
      `${(last.width?.toFixed(0) ?? "—").padStart(9)}  ` +
      (last.width === null ? "(open above)" : bar(last.width, scale)),
  );

  console.log();
  console.log(
    `  widest ${stats.widestWidth?.toFixed(0)} d · narrowest ` +
      `${stats.narrowestWidth?.toFixed(0)} d · closed by ` +
      `${stats.percentClosed?.toFixed(0)}% · samples ${stats.first?.n} → ` +
      `${stats.last?.n} · monotone ${stats.monotone ? "yes" : "no"}` +
      (stats.unbounded > 0 ? ` · ${stats.unbounded} unbounded above` : ""),
  );

  // Narrowing, not MONOTONE narrowing. Each estimate is refitted from that day's
  // evidence, and a day on which the indicator did not move genuinely is weaker
  // evidence about a rate than the day before, so local widenings are the model
  // behaving correctly rather than a defect. What is asked of the chart is that the
  // interval ends materially tighter than it started, and that the chart says so.
  const closed = stats.percentClosed;
  if (stats.bounded < 2) {
    // Not a failure and not a pass: with one bounded interval there is nothing to
    // compare. chiller-2 is this case -- 83 of its 84 estimates leave the upper end
    // unbounded, because a chiller that is barely degrading may genuinely never reach
    // the threshold, and the model says so instead of inventing a date.
    console.log(
      `  NARROWS          n/a — only ${stats.bounded} bounded interval of ` +
        `${band.length}; the rest are open above`,
    );
    incomparable.push(
      `${detail.advisory_id}: ${stats.unbounded} of ${band.length} estimates leave ` +
        `the upper end unbounded`,
    );
    if (closed !== null && stats.bounded < 2 && closed !== 0) {
      failures.push(
        `${detail.advisory_id}: closing percentage computed from ` +
          `${stats.bounded} bounded interval`,
      );
    }
  } else if (closed !== null && closed > 0) {
    console.log(`  NARROWS          PASS — closed by ${closed.toFixed(0)}%`);
    narrowingReport.push(
      `${detail.advisory_id}: closed ${closed.toFixed(0)}% ` +
        `(${stats.widestWidth?.toFixed(0)} d → ${stats.last?.width?.toFixed(0)} d)`,
    );
  } else {
    console.log(
      `  DOES NOT NARROW  widened by ${(-(closed ?? 0)).toFixed(0)}% — a property of ` +
        `the model from checkpoint 5.2, not of this chart`,
    );
    widening.push(
      `${detail.advisory_id}: widened by ${(-(closed ?? 0)).toFixed(0)}% ` +
        `(${stats.first?.width?.toFixed(0)} d → ${stats.last?.width?.toFixed(0)} d)`,
    );
  }
  console.log();
}

console.log("=".repeat(104));
console.log("SUMMARY");
console.log("=".repeat(104));
console.log("  intervals that close:");
for (const line of narrowingReport) console.log(`    ${line}`);
if (widening.length > 0) {
  console.log("  intervals that do NOT close — checkpoint 5.2's known limitation,");
  console.log("  now visible on screen rather than only in a report:");
  for (const line of widening) console.log(`    ${line}`);
}
if (incomparable.length > 0) {
  console.log("  no interval to compare — the model declines to bound the crossing:");
  for (const line of incomparable) console.log(`    ${line}`);
}
console.log(
  `\n  refused predictions with the band correctly suppressed: ` +
    `${refused.length} of ${advisories.length} advisories`,
);
for (const line of refused) console.log(`    ${line}`);

// The chart's central claim needs at least one series demonstrating it, or the visual
// is unevidenced whatever the code does.
if (narrowingReport.length === 0) {
  failures.push("no series demonstrates a closing interval at all");
}

if (failures.length > 0) {
  console.log();
  for (const failure of failures) console.log(`  FAIL: ${failure}`);
  process.exit(1);
}
console.log("\n  chart checks passed: no band drawn for any refused prediction, every");
console.log("  closing percentage computed from at least two bounded intervals, and the");
console.log("  narrowing claim demonstrated by " + narrowingReport.length + " series.");
