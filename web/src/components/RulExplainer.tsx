import type { RulExplanation } from "../types.ts";
import styles from "./RulExplainer.module.css";

/**
 * The eight steps from a raw instrument reading to a remaining-life interval.
 *
 * Every figure here is read from where the pipeline stored it, not recomputed. A screen
 * that recomputed the chain to describe it could disagree with the chain, and then a
 * viewer has two answers and no way to tell which one the system used. Each step names
 * the table it came from for exactly that reason.
 *
 * This is the screen that turns "the model says 32 days" from an assertion into
 * something a sceptical reader can follow and check.
 */

interface Props {
  explanation: RulExplanation;
}

export function RulExplainer({ explanation }: Props) {
  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h3>How this number was arrived at</h3>
        <span className={styles.muted}>
          {explanation.asset_id} · {explanation.mode_id} · as of{" "}
          {explanation.as_of.slice(0, 10)} · {explanation.degradation_process} process
        </span>
      </div>

      {explanation.refused && (
        <p className={styles.refused}>
          The model declines to bound the crossing here. That is an answer, not a gap:
          the drift cannot be separated from zero, so there may be no failure date at all.
        </p>
      )}

      <ol className={styles.steps}>
        {explanation.steps.map((step) => (
          <li key={step.ordinal}>
            <div className={styles.name}>
              <span className={styles.ord}>{step.ordinal}</span>
              {step.name}
            </div>
            <div className={styles.what}>{step.what_it_does}</div>
            <div className={styles.value}>{step.value}</div>
            <div className={styles.source}>{step.source}</div>
          </li>
        ))}
      </ol>

      <p className={styles.rationale}>
        <strong>Why the threshold is {explanation.failure_threshold} {explanation.indicator_unit}.</strong>{" "}
        {explanation.threshold_rationale}
      </p>
    </section>
  );
}
