import type { ReactNode } from "react";

import styles from "./Stat.module.css";

/**
 * One number, made to dominate.
 *
 * WHY IT EXISTS. The most important figure in this product — how long a machine has
 * left, what ignoring it costs — was rendered at twelve pixels in a table cell, the same
 * size as the column header above it and the footnote below it. When everything is the
 * same size, nothing is important, and the reader has to work out the hierarchy for
 * themselves every time they open a screen.
 *
 * THE CAPTION IS NOT DECORATION, it is the second of the six rules this redesign is
 * built on: every number gets a plain-English restatement. "1 per 604 machine-days" is
 * a quantity a reader has to convert before they can feel it; "cried wolf once in 604
 * days of watching a healthy machine" is one they cannot help feeling. The caption slot
 * is where that sentence goes, and a Stat without one is usually a Stat that has not
 * been thought about.
 *
 * TONE IS A CLAIM, NOT A STYLE. Passing tone="bad" says this number is alarming. Numbers
 * that are merely large — a count of assets, a horizon in days — stay neutral, because
 * colouring them spends the reader's attention on something that does not need it.
 */

export type Tone = "neutral" | "good" | "caution" | "alarm" | "info";

interface Props {
  /** Uppercase, tracked. What the number is. */
  label: ReactNode;
  /** The number itself. Kept as a node so a unit can be set smaller inside it. */
  value: ReactNode;
  /** The plain-English restatement. Rule two. */
  caption?: ReactNode;
  tone?: Tone;
  /** "hero" is the one number a screen is about. At most one per screen. */
  size?: "hero" | "normal";
  /** Renders the whole stat as a button. Used where a number opens its own evidence. */
  onClick?: () => void;
}

export function Stat({
  label,
  value,
  caption,
  tone = "neutral",
  size = "normal",
  onClick,
}: Props) {
  const body = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${styles[tone]} ${styles[size]}`}>{value}</span>
      {caption && <span className={styles.caption}>{caption}</span>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`${styles.stat} ${styles.clickable}`} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={styles.stat}>{body}</div>;
}

/**
 * The unit or qualifier that rides alongside a value at a smaller size.
 *
 * Set inside the value rather than in the label, because "48,200" and "USD" read as one
 * quantity and splitting them across two lines makes the reader reassemble it.
 */
export function Unit({ children }: { children: ReactNode }) {
  return <span className={styles.unit}>{children}</span>;
}

/** A row of stats with consistent spacing. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}
