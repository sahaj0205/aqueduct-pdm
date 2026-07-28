import { Term } from "../design/Term.tsx";
import type { TraceStage } from "../types.ts";
import styles from "./Funnel.module.css";

/**
 * The detection pipeline as ten refusals, each one written as a sentence.
 *
 * WHAT THIS SCREEN IS FOR. The false-alarm rate this project quotes is not the product of
 * a cleverer detector. It is the product of ten successive refusals to judge, and before
 * this table existed not one of them was visible anywhere.
 *
 * WHAT R6 CHANGED. The stages were named after the code that produces them — "evaluable
 * instants", "inputs trusted", "sustained" — and a reader who did not already know the
 * pipeline could not tell what any row had done. Every stage now leads with a plain
 * question or claim and carries one sentence saying what actually happened inside it,
 * with the reasons folded into that sentence rather than listed as fragments underneath.
 * The internal name is kept beside it, quietly, because it is what the trace table
 * actually stores and somebody checking the database needs it.
 *
 * THE BARS ARE LOGARITHMIC, and the row above them now says so. The first stage counts
 * three hundred thousand readings and the last counts four findings. On a straight scale
 * every bar after the second is a single pixel, which would make the picture look like
 * the pipeline throws everything away at once — the opposite of what it does.
 *
 * THE BAR BREAKS WHERE THE UNIT CHANGES, and the break now shows the arithmetic. Seven
 * kinds of thing are counted down ten stages, so the unit changes six times. At one of
 * those breaks the number goes UP — twenty-two thousand moments become sixty-six thousand
 * evaluations, because three separate rules are run against each one — and a funnel drawn
 * as one continuous taper would be hiding a multiplication inside what looks like a
 * narrowing.
 *
 * WHY THE CLEAN COLUMN IS THE POINT. A funnel narrowing on a broken machine shows a
 * system doing its job. The same machine on the same day of the year with nothing wrong —
 * same weather, same occupancy, because every run reads the same source year shifted by
 * whole years — is what shows the job being done WELL. The rules DO fire on healthy
 * equipment: eighty-nine times on the day this was written. Every one of those firings
 * dies at the persistence requirement one stage later. That pair of rows is the argument,
 * so a stage where the healthy machine passed nothing and the faulted one passed
 * something is marked rather than left to be noticed.
 */

interface Props {
  stages: TraceStage[];
  clean: TraceStage[] | null;
  cleanAsOf: string | null;
  selected: number | null;
  onSelect: (ordinal: number | null) => void;
}

/**
 * Plain language for each stage, keyed by the name the trace table stores.
 *
 * A stage renamed server-side falls through to its stored name rather than to a blank,
 * so the table degrades to what it used to be instead of losing a row.
 */
export const PLAIN: Record<string, { name: string; what: string }> = {
  readings: {
    name: "Every reading taken",
    what: "Ten instruments on this machine, sampled every five minutes, all day long.",
  },
  "evaluable instants": {
    name: "Was the machine even running?",
    what:
      "Nothing can be judged while a chiller is switched off, or while it is still " +
      "settling down after starting up.",
  },
  "rule evaluations": {
    name: "Every rule, against every moment",
    what:
      "Each surviving moment is offered to every rule written for this class of " +
      "machine. This is where the count goes up rather than down.",
  },
  "inputs trusted": {
    name: "Is the reading behind it trustworthy?",
    what:
      "An evaluation is refused outright when a reading it depends on is frozen, " +
      "stale, out of range or missing — never averaged in and hoped for.",
  },
  "rule fired": {
    name: "Did anything actually look wrong?",
    what:
      "Almost always nothing is, and the rule says so. This single stage refuses more " +
      "than all the others put together.",
  },
  sustained: {
    name: "Did it keep looking wrong?",
    what:
      "A rule that trips for a few minutes and stops was noise. This stage makes the " +
      "complaint hold before it counts as anything.",
  },
  "baseline coverage": {
    name: "Is there a healthy baseline to compare against?",
    what:
      "Drift can only be measured where normal behaviour was fitted first, and most " +
      "readings in this building have no baseline at all.",
  },
  "degradation confirmed": {
    name: "Is it genuinely degrading, or just bad today?",
    what:
      "A failure mode counts only once its trend has a confirmed break point. One bad " +
      "value is not a trend.",
  },
  "prediction published": {
    name: "Can a date be put on it?",
    what:
      "The model either publishes a range for when this fails, or refuses to and " +
      "records the reason it refused.",
  },
  "advisory raised": {
    name: "Is it worth telling somebody?",
    what: "What reaches the work queue as a job somebody can actually be sent to do.",
  },
};

/** Log scale with a floor, so a zero-passed stage still draws something to point at. */
function width(value: number, max: number): number {
  if (max <= 0) return 2;
  const scaled = Math.log10(Math.max(value, 1) + 1) / Math.log10(max + 1);
  return Math.max(2, scaled * 100);
}

/**
 * The sentence for what a stage threw away.
 *
 * Reasons were printed as a strip of "N reason" fragments under each row. Read as a list
 * they are noise; read as a sentence they are the stage's justification, which is the
 * thing this screen exists to show.
 */
function refusalSentence(dropped: Record<string, number>): string | null {
  const reasons = Object.entries(dropped).filter(([, n]) => n > 0);
  if (reasons.length === 0) return null;
  const parts = reasons.map(([reason, n]) => `${n.toLocaleString()} — ${reason}`);
  return `Refused: ${parts.join("; ")}.`;
}

/**
 * What happened between two stages when the thing being counted changed.
 *
 * ONE BREAK GETS THE ARITHMETIC SPELLED OUT, and only one. Going from moments in time to
 * rule evaluations the count goes UP, because every surviving moment is handed to every
 * rule — twenty-two thousand moments become sixty-six thousand evaluations. That is the
 * break a reader is most likely to misread as the funnel inexplicably growing, so the
 * multiplier is named.
 *
 * IT IS NOT GENERALISED TO EVERY BREAK WHERE THE COUNT GROWS. The first version was, and
 * against real data it printed "2 failure modes × 2 rules = 4 findings" at the last
 * break, which is arithmetically tidy and completely untrue: those four findings are the
 * union of the faults the rules reported and the modes confirmed as degrading, and the
 * two happening to differ by a factor of two on that day is a coincidence. A sentence
 * that is only true when the numbers cooperate is worse than a plain one.
 */
function breakNote(previous: TraceStage, next: TraceStage): string {
  const from = previous.passed;
  const to = next.entered;
  if (next.unit === "evaluations" && from > 0 && to > from && to % from === 0) {
    return (
      `${from.toLocaleString()} ${previous.unit} × ${to / from} rules = ` +
      `${to.toLocaleString()} ${next.unit}`
    );
  }
  return (
    `now counting ${next.unit}, not ${previous.unit} — ` +
    `${to.toLocaleString()} of them`
  );
}

export function Funnel({ stages, clean, cleanAsOf, selected, onSelect }: Props) {
  const max = Math.max(...stages.map((s) => s.entered), 1);
  const cleanBy = new Map((clean ?? []).map((s) => [s.ordinal, s]));

  const first = stages[0];
  const last = stages[stages.length - 1];

  return (
    <div className={styles.funnel}>
      {first && last && (
        <div className={styles.claim}>
          <strong>{first.entered.toLocaleString()}</strong> {first.unit} in.{" "}
          <strong>{last.passed.toLocaleString()}</strong> {last.unit} out. Ten places this
          could have raised an alarm, and what happened at each.
          <span className={styles.scaleNote}>
            Bars are logarithmic — on a straight scale every one after the second would be
            a single pixel.
          </span>
        </div>
      )}

      <div className={styles.header}>
        <span>stage</span>
        <span className={styles.r}>in</span>
        <span className={styles.r}>out</span>
        <span className={styles.barHead}>how much got through</span>
        <span className={styles.r}>
          {cleanAsOf ? `healthy twin, ${cleanAsOf.slice(0, 10)}` : "no healthy twin"}
        </span>
      </div>

      {stages.map((stage, i) => {
        const previous = stages[i - 1];
        const unitChanged = previous !== undefined && previous.unit !== stage.unit;
        const twin = cleanBy.get(stage.ordinal);
        const isOpen = selected === stage.ordinal;
        const plain = PLAIN[stage.stage];
        const refusal = refusalSentence(stage.dropped);
        // The row where the healthy machine passed nothing and the faulted one did NOT
        // is where the fault is, and it is worth saying out loud rather than leaving to
        // be spotted in the last column.
        const isCulprit = twin !== undefined && twin.passed === 0 && stage.passed > 0;

        return (
          <div key={stage.ordinal}>
            {unitChanged && (
              <div className={styles.break}>
                <span>{breakNote(previous, stage)}</span>
              </div>
            )}

            <button
              className={isOpen ? styles.rowOn : styles.row}
              onClick={() => onSelect(isOpen ? null : stage.ordinal)}
              aria-expanded={isOpen}
            >
              <span className={styles.name}>
                <span className={styles.ord}>{stage.ordinal}</span>
                <span>
                  <span className={styles.plain}>{plain?.name ?? stage.stage}</span>
                  <span className={styles.code}>{stage.stage}</span>
                </span>
              </span>
              <span className={styles.r}>{stage.entered.toLocaleString()}</span>
              <span className={styles.r}>{stage.passed.toLocaleString()}</span>
              <span className={styles.barCell}>
                <span
                  className={styles.bar}
                  style={{ width: `${width(stage.entered, max)}%` }}
                />
                <span
                  className={stage.passed === 0 ? styles.barOutNone : styles.barOut}
                  style={{ width: `${width(stage.passed, max)}%` }}
                />
              </span>
              <span className={styles.r}>
                {twin ? (
                  <span className={isCulprit ? styles.cleanZero : undefined}>
                    {twin.passed.toLocaleString()}
                  </span>
                ) : (
                  "—"
                )}
              </span>
            </button>

            <div className={styles.says}>
              {plain && <span className={styles.what}>{plain.what}</span>}
              {refusal && <span className={styles.refusal}>{refusal}</span>}
              {isCulprit && (
                <span className={styles.culprit}>
                  Nothing at all survived this stage on the healthy machine, and{" "}
                  {stage.passed.toLocaleString()} did here. That difference is the fault
                  and nothing else — see <Term id="persistence">persistence</Term>.
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
