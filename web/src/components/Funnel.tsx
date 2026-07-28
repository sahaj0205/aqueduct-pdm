import type { TraceStage } from "../types.ts";
import styles from "./Funnel.module.css";

/**
 * The detection pipeline as ten narrowings, with what was dropped at each and why.
 *
 * THE BARS ARE LOGARITHMIC. The first stage counts about 235,000 readings and the last
 * counts four findings. On a linear scale every bar after the second is a single pixel,
 * which would make the picture look like the pipeline throws everything away at once —
 * the opposite of what it does.
 *
 * THE BAR BREAKS WHERE THE UNIT CHANGES, and this is the point of the whole component.
 * Seven kinds of thing are counted down ten stages, so the unit changes six times:
 * readings, instants, evaluations, firings, points, failure modes, findings.
 * A funnel drawn as one continuous taper would be claiming 235,000 readings turn into
 * four findings by attrition. They do not: they turn into four findings by being
 * aggregated into a different kind of object, and the two are different claims.
 *
 * WHY THE CLEAN COLUMN MATTERS MORE THAN THE FAULTED ONE. A funnel narrowing on a
 * broken machine shows a system doing its job. The same machine on the same day of the
 * year with nothing wrong — same weather, same occupancy, because every run reads the
 * same source year shifted by whole years — is what shows the job being done WELL. The
 * rules still fire on healthy equipment; every one of those firings dies at the
 * persistence requirement.
 */

interface Props {
  stages: TraceStage[];
  clean: TraceStage[] | null;
  cleanAsOf: string | null;
  selected: number | null;
  onSelect: (ordinal: number | null) => void;
}

/** Log scale with a floor, so a zero-passed stage still draws something to point at. */
function width(value: number, max: number): number {
  if (max <= 0) return 2;
  const scaled = Math.log10(Math.max(value, 1) + 1) / Math.log10(max + 1);
  return Math.max(2, scaled * 100);
}

export function Funnel({ stages, clean, cleanAsOf, selected, onSelect }: Props) {
  const max = Math.max(...stages.map((s) => s.entered), 1);
  const cleanBy = new Map((clean ?? []).map((s) => [s.ordinal, s]));

  return (
    <div className={styles.funnel}>
      <div className={styles.header}>
        <span>stage</span>
        <span className={styles.r}>in</span>
        <span className={styles.r}>out</span>
        <span>what got through</span>
        <span className={styles.r}>
          {cleanAsOf ? `clean ${cleanAsOf.slice(0, 10)}` : "no clean twin"}
        </span>
      </div>

      {stages.map((stage, i) => {
        const previous = stages[i - 1];
        const unitChanged = previous !== undefined && previous.unit !== stage.unit;
        const twin = cleanBy.get(stage.ordinal);
        const isOpen = selected === stage.ordinal;
        // Zero-valued reasons are noise: a stage can carry a reason that did not bite
        // on this particular day, and printing "0" beside it invites the reader to
        // wonder what they are looking at.
        const reasons = Object.entries(stage.dropped).filter(([, n]) => n > 0);

        return (
          <div key={stage.ordinal}>
            {unitChanged && (
              <div className={styles.break}>
                <span>
                  now counting {stage.unit}, not {previous.unit}
                </span>
              </div>
            )}
            <button
              className={isOpen ? styles.rowOn : styles.row}
              onClick={() => onSelect(isOpen ? null : stage.ordinal)}
            >
              <span className={styles.name}>
                <span className={styles.ord}>{stage.ordinal}</span>
                {stage.stage}
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
                  <span
                    className={
                      twin.passed === 0 && stage.passed > 0 ? styles.cleanZero : undefined
                    }
                  >
                    {twin.passed.toLocaleString()}
                  </span>
                ) : (
                  "—"
                )}
              </span>
            </button>
            {reasons.length > 0 && (
              <div className={styles.reasons}>
                {reasons.map(([reason, n]) => (
                  <span key={reason} className={styles.reason}>
                    <strong>{n.toLocaleString()}</strong> {reason}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
