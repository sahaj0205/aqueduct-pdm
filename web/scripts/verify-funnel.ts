/**
 * Check the engine funnel against the real trace, outside a browser.
 *
 * The funnel is an accounting statement: everything that arrives at a stage either
 * passes or is dropped for a named reason, and the reasons must add up. A funnel whose
 * numbers do not balance is worse than no funnel, because it looks authoritative while
 * misattributing one suppression mechanism to another — which is precisely the error
 * this screen exists to make impossible, and which happened once already in this
 * project's own notes.
 *
 *     API=http://127.0.0.1:8000 npm run verify:funnel
 */

import process from "node:process";

import type { MachineTrace, TraceStage } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";
const MACHINES = ["ahu-1", "chiller-1", "chiller-2", "chiller-3"];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

function dropped(stage: TraceStage): number {
  return Object.values(stage.dropped).reduce((a, b) => a + b, 0);
}

async function main() {
  // The busiest day, found rather than assumed, so the funnel under test has something
  // in it. A day where nothing happened would pass every check below vacuously.
  const eras = await get<{ eras: { t_from: string; t_to: string }[] }>("/clock/eras");
  let best = { at: eras.eras[0]!.t_to, count: -1 };
  for (const era of eras.eras) {
    for (
      let d = new Date(era.t_from);
      d <= new Date(era.t_to);
      d = new Date(d.getTime() + 7 * 86400000)
    ) {
      const iso = d.toISOString();
      const open = await get<{ length: number }[]>(
        `/advisories?status=open&as_of=${encodeURIComponent(iso)}`,
      );
      if (open.length > best.count) best = { at: iso, count: open.length };
    }
  }

  console.log(`\nthe engine on ${best.at.slice(0, 10)}\n`);

  const traces: MachineTrace[] = [];
  for (const id of MACHINES) {
    try {
      traces.push(await get<MachineTrace>(
        `/engine/trace?asset_id=${encodeURIComponent(id)}&as_of=${encodeURIComponent(best.at)}`,
      ));
    } catch {
      console.log(`  (${id} has no trace this day, which is a fact about the run)`);
    }
  }
  check("at least one machine has a trace", traces.length > 0);

  console.log("\nthe funnel is an accounting statement");
  for (const trace of traces) {
    for (const stage of trace.stages) {
      check(
        `${trace.asset_id} ${stage.ordinal} ${stage.stage}: nothing passes that did not enter`,
        stage.passed <= stage.entered,
        `${stage.passed} of ${stage.entered}`,
      );
    }
    // Stages 1 and 3 carry a reason that can be zero on a given day, and stage 10's
    // candidates are a set union rather than a subtraction, so the exact-balance check
    // applies to the stages that genuinely subtract.
    for (const stage of trace.stages.filter((s) => [2, 4, 5, 6].includes(s.ordinal))) {
      check(
        `${trace.asset_id} ${stage.ordinal} ${stage.stage}: reasons account for every drop`,
        dropped(stage) === stage.entered - stage.passed,
        `${dropped(stage)} named vs ${stage.entered - stage.passed} dropped`,
      );
    }
  }

  console.log("\nunits change, and only where they should");
  for (const trace of traces) {
    const units = trace.stages.map((s) => s.unit);
    const changes = units.filter((u, i) => i > 0 && u !== units[i - 1]).length;
    check(
      `${trace.asset_id} the unit changes ${changes} times down the funnel`,
      changes >= 3,
      units.join(" -> "),
    );
    const perStage = new Map<number, Set<string>>();
    for (const s of trace.stages) {
      perStage.set(s.ordinal, (perStage.get(s.ordinal) ?? new Set()).add(s.unit));
    }
    check(
      `${trace.asset_id} no stage reports two different units`,
      [...perStage.values()].every((set) => set.size === 1),
    );
  }

  console.log("\nthe clean comparison");
  for (const trace of traces) {
    if (!trace.clean) {
      console.log(`  (${trace.asset_id} has no fault-free counterpart for this day)`);
      continue;
    }
    check(
      `${trace.asset_id} the clean twin is the same day of the year`,
      trace.clean_as_of !== null &&
        trace.clean_as_of.slice(5, 10) === trace.as_of.slice(5, 10),
      `${trace.as_of.slice(0, 10)} vs ${trace.clean_as_of?.slice(0, 10)}`,
    );
    check(
      `${trace.asset_id} the clean twin has the same ten stages`,
      trace.clean.length === trace.stages.length,
    );
    const fired = trace.stages.find((s) => s.ordinal === 5);
    const sustained = trace.stages.find((s) => s.ordinal === 6);
    const cleanFired = trace.clean.find((s) => s.ordinal === 5);
    const cleanSustained = trace.clean.find((s) => s.ordinal === 6);
    console.log(
      `        ${trace.asset_id}: fired ${fired?.passed.toLocaleString()} vs ` +
        `${cleanFired?.passed.toLocaleString()} clean · ` +
        `sustained ${sustained?.passed.toLocaleString()} vs ` +
        `${cleanSustained?.passed.toLocaleString()} clean`,
    );
  }

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
