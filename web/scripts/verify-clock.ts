/**
 * Check the clock's behaviour against the real era range, outside a browser.
 *
 * The clock decides what moment every screen renders, so a mistake here is a mistake
 * on every screen at once and would be invisible in a screenshot — the dashboard
 * would simply be showing a different day than it says. These are the properties that
 * have to hold, checked against the running API rather than against made-up dates.
 *
 *   npm run verify:clock      (needs `make api`)
 */

import {
  addDays,
  clampToEra,
  dayOf,
  daysBetween,
  eraAt,
  hoursOfDay,
  momentAtPosition,
  momentAtSeverity,
  positionInEra,
  step,
} from "../src/lib/clock.ts";
import type { AnswerKey, ClockRange } from "../src/types.ts";

const API = process.env.API ?? "http://127.0.0.1:8000";
const REVEAL = process.env.REVEAL ?? "http://127.0.0.1:8002";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  let range: ClockRange;
  try {
    const response = await fetch(`${API}/clock/eras`);
    if (!response.ok) throw new Error(`${response.status}`);
    range = (await response.json()) as ClockRange;
  } catch (cause) {
    console.error(`cannot reach ${API}/clock/eras — start it with \`make api\`. ${cause}`);
    process.exit(2);
  }

  console.log(`\nthe clock can stand in ${range.eras.length} runs\n`);
  for (const era of range.eras) {
    console.log(
      `  ${era.era}  ${era.t_from.slice(0, 10)} .. ${era.t_to.slice(0, 10)}  ` +
        `${String(era.days).padStart(3)}d  ${era.assets.length} machines  ` +
        `${era.queue_days} days with a queue`,
    );
  }

  console.log("\nevery run is reachable and self-consistent");
  for (const era of range.eras) {
    const first = new Date(era.t_from);
    const last = new Date(era.t_to);
    check(
      `${era.era} both edges resolve to their own run`,
      eraAt(range, first)?.era === era.era && eraAt(range, last)?.era === era.era,
    );
    check(
      `${era.era} day count matches its own dates`,
      daysBetween(first, last) + 1 === era.days,
      `${daysBetween(first, last) + 1} vs ${era.days}`,
    );
    check(
      `${era.era} scrubber round-trips`,
      daysBetween(momentAtPosition(era, positionInEra(era, last)), last) === 0,
    );
  }

  console.log("\nthe clock never leaves a run");
  for (const era of range.eras) {
    const last = new Date(era.t_to);
    const over = step(range, last, 30);
    check(
      `${era.era} stepping past the end stops at the end`,
      over.at.getTime() === last.getTime() && over.atEnd,
    );
    const first = new Date(era.t_from);
    const under = step(range, first, -30);
    check(
      `${era.era} stepping before the start stops at the start`,
      under.at.getTime() === first.getTime() && under.atEnd,
    );
  }

  console.log("\na moment between runs is pulled to the nearest edge");
  const gap = new Date("2035-01-01T00:00:00Z");
  const pulled = clampToEra(range, gap);
  check("a date before every run lands inside one", eraAt(range, pulled) !== null,
    pulled.toISOString().slice(0, 10));
  const far = new Date("2045-01-01T00:00:00Z");
  check("a date after every run lands inside one",
    eraAt(range, clampToEra(range, far)) !== null,
    clampToEra(range, far).toISOString().slice(0, 10));

  console.log("\nthe two granularities");
  const sample = new Date(range.eras[0]!.t_to);
  check("a day has 24 hourly marks", hoursOfDay(sample).length === 24);
  check("the first mark is midnight of that day",
    hoursOfDay(sample)[0]!.getTime() === dayOf(sample).getTime());
  check("stepping a day changes the day by one",
    daysBetween(sample, addDays(sample, 1)) === 1);

  console.log("\nseverity is a position on the clock");
  let key: AnswerKey | null = null;
  try {
    const response = await fetch(`${REVEAL}/reveal/scenarios`);
    if (response.ok) key = (await response.json()) as AnswerKey;
  } catch {
    key = null;
  }
  if (!key) {
    console.log("  (skipped — the reveal service is not running, which is allowed)");
  } else {
    for (const fault of key.faults) {
      const rungs = fault.ladder.length;
      const moments = fault.ladder
        .map((rung) => momentAtSeverity(fault, rung.level))
        .filter((m): m is Date => m !== null);
      const ordered = moments.every(
        (m, i) => i === 0 || m.getTime() >= moments[i - 1]!.getTime(),
      );
      const onset = new Date(fault.t_onset);
      const failure = fault.t_failure ? new Date(fault.t_failure) : null;
      const inside =
        failure === null ||
        moments.every(
          (m) => m.getTime() >= dayOf(onset).getTime() && m.getTime() <= failure.getTime(),
        );
      check(
        `${fault.scenario_id} ${rungs} rungs land in order, inside the fault's life`,
        ordered && inside,
        moments.map((m) => m.toISOString().slice(5, 10)).join(" "),
      );
      check(
        `${fault.scenario_id} every rung is a moment the clock can stand at`,
        moments.every((m) => eraAt(range, m) !== null),
      );
    }
  }

  console.log(
    failures === 0
      ? "\nevery property holds\n"
      : `\n${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
