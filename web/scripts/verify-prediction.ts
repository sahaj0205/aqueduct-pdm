/**
 * Check the prediction screen's claims against the live API and the answer key.
 *
 * Two claims are made here and they pull in opposite directions: that the interval
 * closes as evidence accumulates, and that the model is nonetheless late every time.
 * Both are checkable, and a screen that made the first without the second would be a
 * sales pitch.
 *
 *     API=http://127.0.0.1:8000 REVEAL=http://127.0.0.1:8002 npm run verify:prediction
 */

import process from "node:process";

import { narrowing, toEpoch } from "../src/lib/chart.ts";
import type { AnswerKey, RulExplanation, RulHistory } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";
const REVEAL = process.env.REVEAL ?? "http://127.0.0.1:8002";
const ASSET = "ahu-1";
const MODE = "coil-valve-leak-by";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function get<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

async function main() {
  let history: RulHistory;
  try {
    history = await get<RulHistory>(BASE, `/assets/${ASSET}/rul-history`);
  } catch (cause) {
    console.error(`cannot reach ${BASE} — start it with \`make api\`. ${cause}`);
    process.exit(2);
  }

  const points = history.modes[MODE] ?? [];
  console.log(`\n${ASSET} / ${MODE}: ${points.length} estimates\n`);
  check("the flagship series is present", points.length > 50, `${points.length}`);

  console.log("what the model does well");
  const band = points.map((p) => ({
    t: toEpoch(p.as_of),
    p10: p.p10,
    p50: p.p50,
    p90: p.p90,
    width: p.width,
    n: p.n_samples,
  }));
  const close = narrowing(band);
  check(
    "the interval closes over the run",
    close.percentClosed !== null && close.percentClosed > 90,
    `${close.percentClosed?.toFixed(1)}% over ${close.bounded} bounded estimates`,
  );
  check(
    "and it does NOT close monotonically, which is stated rather than smoothed",
    close.monotone === false,
    `monotone=${close.monotone}`,
  );

  console.log("\nthe eight steps resolve");
  const last = points[points.length - 1]!;
  const explanation = await get<RulExplanation>(
    BASE,
    `/prediction/explain?asset_id=${ASSET}&mode_id=${MODE}&as_of=${encodeURIComponent(last.as_of)}`,
  );
  check("all eight steps returned", explanation.steps.length === 8, `${explanation.steps.length}`);
  check(
    "every step carries a real value, not a placeholder",
    explanation.steps.every((s) => s.value.length > 0 && !s.value.includes("undefined")),
  );
  check(
    "every step names where it is stored",
    explanation.steps.every((s) => s.source.includes(".") || s.source.includes("app.")),
  );
  check(
    "step 1 reaches an actual residual rather than reporting none",
    !explanation.steps[0]!.value.startsWith("no residual"),
    explanation.steps[0]!.value,
  );
  check(
    "the threshold carries its physical justification",
    explanation.threshold_rationale.length > 40,
  );

  console.log("\nand what it does badly");
  let key: AnswerKey | null = null;
  try {
    key = await get<AnswerKey>(REVEAL, "/reveal/scenarios");
  } catch {
    key = null;
  }
  if (!key) {
    console.log("  (skipped — the reveal service is not running, which is allowed)");
  } else {
    const era = points[0]!.as_of.slice(0, 4);
    const fault = key.faults.find(
      (f) => f.asset_id === ASSET && f.t_onset.slice(0, 4) === era,
    );
    check("the answer key has a failure date for this run", fault?.t_failure != null);
    if (fault?.t_failure) {
      const truth = toEpoch(fault.t_failure);
      const bounded = points.filter((p) => p.p50 !== null);
      const late = bounded.filter(
        (p) => toEpoch(p.as_of) + (p.p50 as number) * 86_400_000 > truth,
      );
      check(
        "every bounded estimate predicts failure LATER than it happened",
        late.length === bounded.length,
        `${late.length} of ${bounded.length}`,
      );
      const final = bounded[bounded.length - 1]!;
      const errorDays = Math.round(
        (toEpoch(final.as_of) + (final.p50 as number) * 86_400_000 - truth) / 86_400_000,
      );
      console.log(
        `        actual failure ${fault.t_failure.slice(0, 10)}; last prediction puts it ` +
          `${errorDays} days later`,
      );
      check("the final error is late, not early", errorDays > 0, `${errorDays} days`);
    }
  }

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
