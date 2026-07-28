import type { ReactNode } from "react";

import { Unit } from "./Stat.tsx";
import styles from "./Bridge.module.css";

/**
 * Two figures with the distance between them stated, rather than left to be worked out.
 *
 * WHY IT EXISTS. Two screens make the same shape of argument. The landing screen compares
 * what leaving the work alone costs against what doing it costs. The sensor-or-machine
 * screen compares what the same symptom costs to fix when it is blamed on the instrument
 * against what it costs when it is blamed on the machine. In both cases the number that
 * matters is not either figure, it is the gap — and in both cases a reader was previously
 * expected to divide two numbers in their head.
 *
 * THE RATIO IS PASSED IN ALREADY DECIDED, including which direction it points and whether
 * it is alarming. This component does no arithmetic at all, because the two callers
 * compute their ratio from different quantities under different rules — the landing screen
 * inverts the fraction when the work costs more than the consequence, which is meaningless
 * for a comparison of two repair bills for the same fault.
 */

export interface BridgeRatio {
  /** Already formatted — "8.6", "154", "3.16". The × is added here. */
  label: string;
  /** What the ratio means, in words. Line breaks are honoured. */
  note: string;
  /** Alarm colours the figure red. Use only where the gap is bad news. */
  alarming?: boolean;
}

interface Props {
  left: ReactNode;
  right: ReactNode;
  /** Null suppresses the middle entirely — see the callers for when that happens. */
  ratio: BridgeRatio | null;
  /** Spans the full width underneath, for a caveat qualifying all three. */
  footnote?: ReactNode;
}

export function Bridge({ left, right, ratio, footnote }: Props) {
  return (
    <section className={styles.bridge}>
      <div className={styles.side}>{left}</div>

      {ratio && (
        <div className={styles.gap}>
          <span className={styles.rule} aria-hidden="true" />
          <span className={ratio.alarming ? styles.ratioBad : styles.ratio}>
            {ratio.label}
            <Unit>×</Unit>
          </span>
          <span className={styles.note}>
            {ratio.note.split("\n").map((line, i) => (
              <span key={line}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </span>
          <span className={styles.rule} aria-hidden="true" />
        </div>
      )}

      <div className={styles.side}>{right}</div>

      {footnote && <p className={styles.footnote}>{footnote}</p>}
    </section>
  );
}
