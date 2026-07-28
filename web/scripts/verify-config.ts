/**
 * Check that every configured number in this system carries a reason.
 *
 * The configuration screen's whole claim is that a threshold cannot enter this database
 * without a written physical justification beside it. That is enforced by CHECK
 * constraints, so it should be impossible to violate — which is exactly why it is worth
 * asserting from outside, because a constraint that was quietly dropped would leave the
 * screen making a claim nothing was upholding any more.
 *
 *     API=http://127.0.0.1:8000 npm run verify:config
 */

import process from "node:process";

import type { InterventionConfig, ModeConfig, RuleConfig } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";

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

async function main() {
  let rules: RuleConfig[];
  let modes: ModeConfig[];
  let interventions: InterventionConfig[];
  try {
    [rules, modes, interventions] = await Promise.all([
      get<RuleConfig[]>("/config/rules"),
      get<ModeConfig[]>("/config/modes"),
      get<InterventionConfig[]>("/config/interventions"),
    ]);
  } catch (cause) {
    console.error(`cannot reach ${BASE} — start it with \`make api\`. ${cause}`);
    process.exit(2);
  }

  console.log(
    `\n${rules.length} rules · ${modes.length} failure modes · ` +
      `${interventions.length} interventions\n`,
  );

  console.log("every threshold has a physical reason");
  const shortest = Math.min(...modes.map((m) => m.threshold_rationale.length));
  check(
    "every failure mode carries a threshold rationale",
    modes.every((m) => m.threshold_rationale.length > 40),
    `shortest is ${shortest} characters`,
  );
  check(
    "every threshold is a real positive number",
    modes.every((m) => Number.isFinite(m.failure_threshold) && m.failure_threshold > 0),
  );
  check(
    "every failure mode names the unit its threshold is in",
    modes.every((m) => m.indicator_unit.length > 0),
  );
  // The first version of this check asserted that every mode has an indicator
  // expression, and it failed -- correctly, on data that turned out to be right. One
  // mode, filter-loading, has no expression because a loaded filter is measured by the
  // pressure drop across it and neither LBNL dataset publishes one. Its threshold is
  // recorded anyway because 250 Pa is the real change-out criterion, and its rationale
  // opens by saying it is not computable in this building. So the property worth
  // asserting is not "everything is measurable" -- it is that anything unmeasurable
  // SAYS SO, in the row, rather than sitting there looking configured.
  const unmeasurable = modes.filter((m) => (m.indicator_expression ?? "").length === 0);
  check(
    "every failure mode is either measurable or says why it is not",
    unmeasurable.every((m) =>
      m.threshold_rationale.toUpperCase().includes("NOT COMPUTABLE"),
    ),
    unmeasurable.length === 0
      ? "all measurable"
      : `${unmeasurable.length} declared but not computable here: ${unmeasurable
          .map((m) => m.mode_id)
          .join(", ")}`,
  );

  console.log("\nevery cost has a basis");
  check(
    "every intervention carries a basis",
    interventions.every((i) => i.basis.length > 30),
    `shortest is ${Math.min(...interventions.map((i) => i.basis.length))} characters`,
  );
  check(
    "every intervention names at least one skill",
    interventions.every((i) => i.skills.length > 0),
  );
  check(
    "every intervention takes a positive amount of time",
    interventions.every((i) => i.duration_hours > 0),
  );

  console.log("\nthe discrimination is worth money because the library says so");
  const byFault = new Map<string, InterventionConfig[]>();
  for (const i of interventions) {
    byFault.set(i.applies_to_fault, [...(byFault.get(i.applies_to_fault) ?? []), i]);
  }
  const split = [...byFault.entries()].filter(([, list]) => list.length > 1);
  check(
    "at least one fault resolves to a different response depending on its class",
    split.length > 0,
    `${split.length} fault${split.length === 1 ? "" : "s"} do`,
  );
  for (const [fault, list] of split) {
    const costs = list.map((i) => i.duration_hours);
    console.log(
      `        ${fault}: ${list
        .map((i) => `${i.applies_to_class ?? "any"} ${i.duration_hours}h`)
        .join(" vs ")}  (${(Math.max(...costs) / Math.min(...costs)).toFixed(1)}x in hours)`,
    );
  }

  console.log("\nevery rule declares when it may run");
  check(
    "every rule has a description",
    rules.every((r) => r.description.length > 10),
  );
  check(
    "every rule is dispatched by a Brick class, not by an asset id",
    rules.every((r) => r.applies_to.startsWith("brick:")),
    [...new Set(rules.map((r) => r.applies_to))].join(", "),
  );
  check(
    "every rule sets a quality bar and a persistence requirement",
    rules.every((r) => r.min_input_quality > 0 && r.persistence_minutes > 0),
  );

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
