/**
 * Render the advisory queue to the terminal, through the same code the browser uses.
 *
 * Verification for checkpoint 6.4. This project has no test suite by deliberate
 * decision, so "the dashboard shows the right thing" has to be checkable by somebody
 * other than whoever looked at their own screen. Every string below comes from
 * src/lib/format.ts — the same module the React components call — so what this prints
 * is what the table cells contain, character for character. What it cannot check is
 * layout and colour, which is what the screenshot is for.
 *
 * Run the API first, then:
 *     npm run verify                       # against http://127.0.0.1:8000
 *     API=http://127.0.0.1:8014 npm run verify
 */

import { buildRows } from "../src/lib/format.ts";
import type { AdvisorySummary, SiteSummary } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padStart(width);
}

const summary = await get<SiteSummary>("/advisories/summary");
const advisories = await get<AdvisorySummary[]>("/advisories?status=open");

console.log("=".repeat(118));
console.log("SITE SUMMARY STRIP");
console.log("=".repeat(118));
const cells: [string, string, string][] = [
  ["ASSETS", String(summary.assets), "modelled equipment"],
  [
    "OPEN ADVISORIES",
    String(summary.advisories),
    `${summary.consequential} consequential`,
  ],
  [
    "WORST HEALTH",
    String(summary.worst_health ?? "n/a"),
    summary.worst_health_asset ?? "nothing scored",
  ],
  [
    `COST OF INACTION · ${Math.round(summary.horizon_days)} d`,
    `$${Math.round(summary.total_cost_of_inaction_usd).toLocaleString("en-US")}`,
    "priced advisories only",
  ],
  [
    "COST TO ACT",
    `$${Math.round(summary.total_effort_usd).toLocaleString("en-US")}`,
    "labour and parts",
  ],
  ["UNPRICED", String(summary.unpriced), "ranked on severity"],
  [
    "BY FAULT CLASS",
    Object.entries(summary.by_class)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ") || "none",
    "",
  ],
];
for (const [label, value, note] of cells) {
  console.log(`  ${pad(label, 28)} ${pad(value, 34)} ${note}`);
}
console.log(
  `  generated ${
    summary.generated_at ? new Date(summary.generated_at).toISOString() : "never"
  }`,
);

console.log();
console.log("=".repeat(118));
console.log("ADVISORY QUEUE — exactly the cells the table renders");
console.log("=".repeat(118));
const rows = buildRows(advisories);
const firstUnpriced = rows.findIndex((row) => row.advisory.priority === null);

console.log(
  `  ${pad("#", 3)}${pad("ASSET", 13)}${pad("FAILURE MODE", 28)}${pad("CLASS", 11)}` +
    `${padStart("HEALTH", 7)}${padStart("FAILS IN", 10)}${padStart("PRIORITY", 10)}` +
    `${padStart("INACTION", 11)}`,
);
for (const [index, row] of rows.entries()) {
  if (index === firstUnpriced && firstUnpriced > 0) {
    console.log(
      "  " +
        "-".repeat(30) +
        " below here the cost of inaction could not be computed; " +
        "ranked on severity " +
        "-".repeat(10),
    );
  }
  const marker = row.upstream ? "↳" : " ";
  console.log(
    `  ${pad(String(row.rank), 3)}${pad(row.advisory.asset_id, 13)}` +
      `${pad(row.advisory.fault_id, 28)}${pad(row.advisory.fault_class, 11)}` +
      `${padStart(row.health, 7)}${padStart(row.countdown.value, 10)}` +
      `${padStart(row.priority, 10)}${padStart(row.cost, 11)}`,
  );
  console.log(
    `      ${pad("", 0)}${row.advisory.fault_title}  ` +
      `[band ${row.countdown.band}] [act ${row.effort}] [health band ${row.healthBand}]`,
  );
  if (row.upstream) {
    console.log(
      `      ${marker} DEMOTED, still in the queue — caused by ` +
        `${row.upstream.asset} / ${row.upstream.fault}`,
    );
  }
  console.log(`      why: ${row.advisory.why}`);
}

console.log();
console.log("=".repeat(118));
console.log("CHECKS");
console.log("=".repeat(118));
const consequential = rows.filter((row) => row.upstream !== null);
const priced = rows.filter((row) => row.advisory.priority !== null);
const unpriced = rows.filter((row) => row.advisory.priority === null);
const failures: string[] = [];

const pricedContiguous = rows.findIndex((r) => r.advisory.priority === null) === -1 ||
  rows.slice(0, firstUnpriced).every((r) => r.advisory.priority !== null) &&
    rows.slice(firstUnpriced).every((r) => r.advisory.priority === null);
if (!pricedContiguous) failures.push("priced and unpriced rows are interleaved");

for (const row of consequential) {
  const cause = rows.find(
    (other) =>
      other.advisory.asset_id === row.upstream!.asset &&
      other.advisory.fault_id === row.upstream!.fault,
  );
  if (!cause) {
    failures.push(`${row.advisory.advisory_id}: named cause is not in the queue`);
  } else if (cause.rank >= row.rank) {
    failures.push(
      `${row.advisory.advisory_id}: ranked ${row.rank}, at or above its cause ` +
        `at ${cause.rank}`,
    );
  }
}
if (rows.some((row) => row.priority === "0.00" && row.advisory.priority === null)) {
  failures.push("an unpriced advisory rendered as 0.00 instead of 'unpriced'");
}

console.log(`  rows rendered                 ${rows.length}`);
console.log(`  priced / unpriced             ${priced.length} / ${unpriced.length}`);
console.log(`  consequential, still visible  ${consequential.length}`);
console.log(
  `  priced rows precede unpriced  ${pricedContiguous ? "PASS" : "FAIL"}`,
);
console.log(
  `  every consequence below cause ${
    consequential.length === 0
      ? "n/a (none)"
      : failures.length === 0
        ? "PASS"
        : "FAIL"
  }`,
);
console.log(
  `  no unpriced shown as 0.00      ${
    rows.some((r) => r.advisory.priority === null && r.priority !== "unpriced")
      ? "FAIL"
      : "PASS"
  }`,
);

if (failures.length > 0) {
  console.log();
  for (const failure of failures) console.log(`  FAIL: ${failure}`);
  process.exit(1);
}
console.log("\n  all checks passed");
