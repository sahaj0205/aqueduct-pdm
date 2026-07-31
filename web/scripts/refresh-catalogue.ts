/**
 * Refresh only the CONFIGURATION half of the snapshot, leaving the captured moment alone.
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM make-snapshot.ts. The snapshot holds two kinds of thing
 * whose availability differs by hours. The catalogue — the instruments a machine reports
 * through, the named ways it is known to fail and the value each counts as failed at, the
 * priced jobs that fix them — is configuration, readable the moment the schema is applied.
 * The moment — a fortnight of readings, the fitted baseline's residuals, that day's health
 * and prediction — needs a complete ingest and every analytics stage behind it.
 *
 * So there are long stretches, such as a database part-way through a rebuild, where the
 * catalogue is perfectly readable and the moment is not. `npm run snapshot` insists on both
 * and refuses to write anything if it cannot have them, which is the right call for it: a
 * half-capture written over a good one would replace real readings with empty arrays and
 * nothing on screen would say so. This script exists for the other half of that problem —
 * updating what CAN be read, and provably not touching what cannot.
 *
 * IT REWRITES EXACTLY THREE KEYS and copies the rest of the file through byte for byte.
 *
 *   npm run snapshot:catalogue        (needs `make db-up`; does NOT need a loaded database)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..");
const OUT = join(process.cwd(), "src", "story", "snapshot.json");

const ASSET = "chiller-1";

/** The keys this script is allowed to touch. Anything else is copied through untouched. */
const OWNED = ["inventory", "provenance", "validation"] as const;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const E = env();

function q<T>(sql: string): T {
  const text = execFileSync(
    "psql",
    [
      "-h", "localhost",
      "-p", E.POSTGRES_PORT ?? "5432",
      "-U", E.POSTGRES_USER ?? "postgres",
      "-d", E.POSTGRES_DB ?? "postgres",
      "-tAc", sql,
    ],
    { env: { ...process.env, PGPASSWORD: E.POSTGRES_PASSWORD ?? "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  if (text === "" || text === "null") throw new Error(`query returned nothing:\n${sql.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

/**
 * Read the scored results out of VALIDATION.md, or report their absence as an absence.
 *
 * Parsed rather than recomputed because that document is produced by a harness which runs
 * the detectors over a connection denied access to the answer key, and only afterwards opens
 * the admin credential to score what came out. Recomputing any of it here, with the key in
 * scope, would throw away the one thing that makes the numbers worth anything.
 *
 * A zero here means "not measured", which is emphatically not "measured as zero". The two
 * must never look alike on a screen shown to somebody deciding whether to trust the system.
 */
function readValidation() {
  let text: string;
  try {
    text = readFileSync(join(ROOT, "VALIDATION.md"), "utf8");
  } catch {
    return { available: false, reason: "VALIDATION.md has not been generated — run `make validate`" };
  }

  const cell = (label: string): string | null => {
    const m = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*\\*\\*([^|*]+)\\*\\*`, "i").exec(text);
    return m ? m[1]!.trim() : null;
  };
  const numOrNull = (v: string | null): number | null => {
    if (v === null) return null;
    const cleaned = v.replace(/[%\s]/g, "");
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
  };

  const precision = numOrNull(cell("precision"));
  const recall = numOrNull(cell("recall"));
  const classHit = /correct on (\d+) of (\d+) injected faults/i.exec(text);

  return {
    available: precision !== null || recall !== null,
    reason:
      precision === null && recall === null
        ? "the scoring harness last ran with no ground truth loaded, so nothing was measured"
        : null,
    precision,
    recall,
    faultClassCorrect: classHit ? Number(classHit[1]) : null,
    faultClassTotal: classHit ? Number(classHit[2]) : null,
    suppressionRefusals: (text.match(/CORRECT REFUSAL/g) ?? []).length,
    generatedAt: (/generated ([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(text) ?? [])[1] ?? null,
  };
}

function main() {
  const before = JSON.parse(readFileSync(OUT, "utf8")) as Record<string, unknown>;

  const inventory = {
    points: q(`
      select coalesce(json_agg(json_build_object(
        'point_id', point_id, 'name', name, 'unit_si', unit_si,
        'usable', usable, 'unusable_reason', unusable_reason) order by point_id), '[]'::json)
      from app.points where asset_id = '${ASSET}'`),

    modes: q(`
      select coalesce(json_agg(json_build_object(
        'mode_id', mode_id, 'mode_name', mode_name, 'failure_threshold', failure_threshold,
        'indicator_unit', indicator_unit, 'penalty_kw_per_unit', penalty_kw_per_unit) order by mode_id), '[]'::json)
      from app.failure_modes
      where brick_class = (select brick_class from app.assets where asset_id='${ASSET}')`),

    // The cost is stored already totalled, next to a written basis for the estimate — it is
    // not rebuilt here from an hourly rate, because the number the advisory quotes is this
    // one and the walkthrough must show the figure the platform actually uses.
    interventions: q(`
      select coalesce(json_agg(json_build_object(
        'fault_id', applies_to_fault, 'action', description,
        'hours', duration_hours, 'cost', cost_usd) order by intervention_id), '[]'::json)
      from app.intervention_library`),

    baselines: [] as unknown[],
  };

  const provenance = {
    assets: q<{ n: number }>(`select json_build_object('n', count(*)) from app.assets`).n,
    points: q<{ n: number }>(`select json_build_object('n', count(*)) from app.points`).n,
    scenarios: q<{ n: number }>(`select json_build_object('n', count(*)) from groundtruth.scenarios`).n,
    faultEvents: q<{ n: number }>(`select json_build_object('n', count(*)) from groundtruth.fault_events`).n,
    /*
     * APPROXIMATE ON PURPOSE. `app.measurements` is a hypertable of tens of millions of rows
     * spread over thousands of chunks, and an exact count takes a lock per chunk — enough to
     * exhaust the server's lock table and fail with "out of shared memory". This reads the
     * planner's own estimate instead. The figure is shown as scale ("measurements held"), and
     * being out by a fraction of a per cent changes nothing about the claim it supports.
     */
    measurements: q<{ n: number }>(
      `select json_build_object('n', approximate_row_count('app.measurements'))`,
    ).n,
    eras: q<{ n: number }>(`select json_build_object('n', count(*)) from groundtruth.scenarios`).n,
  };

  const after = { ...before, inventory, provenance, validation: readValidation() };

  // Prove the moment was not touched: every key this script does not own must come out
  // byte-identical to how it went in.
  const untouched = Object.keys(before).filter((k) => !(OWNED as readonly string[]).includes(k));
  const changed = untouched.filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k as keyof typeof after]),
  );
  if (changed.length > 0) {
    console.error(`refusing to write — these keys are not mine to change: ${changed.join(", ")}`);
    process.exit(1);
  }

  writeFileSync(OUT, `${JSON.stringify(after, null, 2)}\n`);

  const say = (l: string, v: unknown) => console.log(`  ${l.padEnd(30)} ${v}`);
  console.log(`\nrefreshed the catalogue for ${ASSET}\n`);
  say("instruments on this machine", (inventory.points as unknown[]).length);
  say("failure modes for its class", (inventory.modes as unknown[]).length);
  say("priced interventions", (inventory.interventions as unknown[]).length);
  say("machines in the plant", provenance.assets);
  say("instruments in the plant", provenance.points);
  say("ground-truth scenarios", provenance.scenarios);
  say("measurements held", provenance.measurements.toLocaleString("en-US"));
  say("validation", after.validation.available ? "scored" : `not measured — ${after.validation.reason}`);
  say("moment fields", `${untouched.length} carried through untouched`);
  console.log(`\nwrote ${OUT}\n`);
}

main();
