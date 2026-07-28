/**
 * Check the sensor-versus-equipment pair against the live API, outside a browser.
 *
 * This screen makes a claim about money — that telling one fault from another is worth
 * a specific multiple — so the numbers behind it are worth checking rather than
 * trusting. The claim is only sound if the two dispatches compared are the SAME fault
 * on the SAME machine seen two ways; comparing two different faults' costs would give a
 * bigger number and answer no question anybody asked.
 *
 *     API=http://127.0.0.1:8000 npm run verify:diagnosis
 */

import process from "node:process";

import type { DiagnosisPair } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  let pair: DiagnosisPair;
  try {
    const response = await fetch(`${BASE}/diagnosis/pair`);
    if (!response.ok) throw new Error(`${response.status}`);
    pair = (await response.json()) as DiagnosisPair;
  } catch (cause) {
    console.error(`cannot reach ${BASE} — start it with \`make api\`. ${cause}`);
    process.exit(2);
  }

  console.log("\nthe pair\n");
  check("both halves resolved", pair.left !== null && pair.right !== null);
  if (!pair.left || !pair.right) process.exit(1);

  for (const side of [pair.left, pair.right]) {
    console.log(
      `  ${side.fault_id.padEnd(20)} ${side.fault_class.toUpperCase().padEnd(10)}` +
        ` ${side.as_of.slice(0, 10)}  ${side.history.length} days in a queue`,
    );
  }

  console.log("\nthey are genuinely different answers");
  check(
    "the two halves are classified differently",
    pair.left.fault_class !== pair.right.fault_class,
    `${pair.left.fault_class} vs ${pair.right.fault_class}`,
  );
  check(
    "both are on the same machine, so the symptom really is shared",
    pair.left.asset_id === pair.right.asset_id,
    pair.left.asset_id,
  );

  console.log("\nthe classifier showed its working");
  for (const side of [pair.left, pair.right]) {
    check(`${side.fault_id} recorded a reason`, side.class_reason.length > 20);
    check(
      `${side.fault_id} recorded its evidence`,
      side.evidence.length >= 2,
      `${side.evidence.length} lines`,
    );
    check(
      `${side.fault_id} evidence names the single-sensor test`,
      side.evidence.some((line) => line.includes("single-sensor")),
    );
  }

  console.log("\nthe composition is declared, not hidden");
  const differentRuns = pair.left.as_of.slice(0, 4) !== pair.right.as_of.slice(0, 4);
  check(
    "composed is true exactly when the two come from different runs",
    pair.composed === differentRuns,
    `composed=${pair.composed}, years ${pair.left.as_of.slice(0, 4)} and ${pair.right.as_of.slice(0, 4)}`,
  );

  console.log("\nthe money claim compares one fault with itself");
  const withAlt = [pair.left, pair.right].find((c) => c.alternative);
  check("one half was classified both ways, so a counterfactual exists", withAlt !== undefined);
  if (withAlt?.alternative && withAlt.intervention) {
    check(
      "the counterfactual is a different dispatch of the SAME fault",
      withAlt.alternative.intervention_id !== withAlt.intervention.intervention_id,
      `${withAlt.intervention.intervention_id} vs ${withAlt.alternative.intervention_id}`,
    );
    const low = Math.min(withAlt.intervention.effort_usd, withAlt.alternative.effort_usd);
    const high = Math.max(withAlt.intervention.effort_usd, withAlt.alternative.effort_usd);
    check(
      "the published ratio is those two costs and nothing else",
      pair.cost_ratio !== null && Math.abs(pair.cost_ratio - high / low) < 0.01,
      `${pair.cost_ratio} vs ${(high / low).toFixed(2)}`,
    );
    console.log(
      `        $${low.toFixed(2)} as ${withAlt.fault_class} vs $${high.toFixed(2)} the other way` +
        ` = ${pair.cost_ratio}x on the same symptom`,
    );
  }

  console.log("\nthe history is real");
  for (const side of [pair.left, pair.right]) {
    const classes = new Set(side.history.map((h) => h.fault_class));
    check(
      `${side.fault_id} history ends on the class shown`,
      side.history[side.history.length - 1]?.fault_class === side.fault_class,
    );
    console.log(
      `        ${side.fault_id}: ${[...classes].join(" and ")} across ${side.history.length} days`,
    );
  }

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
