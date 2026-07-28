import type { DiagnosisCase } from "../types.ts";
import { CLASS_COLOUR } from "../lib/format.ts";
import styles from "./Reconciliation.module.css";

/**
 * One fault's working: what the classifier saw, what it tested, and what it concluded.
 *
 * The three evidence lines are the layer's own output, not a summary written here. They
 * say which physical relations were violated and by how much, what a single biased
 * sensor would explain if you assumed one, and whether the trouble stays inside the
 * relations that sensor can reach. Together they are the whole discrimination: a
 * measurement that is wrong makes every relation it touches wrong by a consistent
 * amount, and a machine that is failing does not.
 */

interface Props {
  side: DiagnosisCase;
}

export function Reconciliation({ side }: Props) {
  const colour = CLASS_COLOUR[side.fault_class as keyof typeof CLASS_COLOUR] ?? "#57534e";
  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <span className={styles.badge} style={{ background: colour }}>
          {side.fault_class}
        </span>
        <div>
          <h3>{side.title}</h3>
          <span className={styles.muted}>
            {side.fault_id} · {side.asset_id} · as of {side.as_of.slice(0, 10)}
          </span>
        </div>
      </div>

      <p className={styles.reason}>{side.class_reason || "no reason recorded"}</p>

      <h4>The classifier&rsquo;s working</h4>
      <ul className={styles.evidence}>
        {side.evidence.length ? (
          side.evidence.map((line) => {
            const [label, ...rest] = line.split(":");
            return (
              <li key={line}>
                <span className={styles.label}>{label?.trim()}</span>
                <span>{rest.join(":").trim()}</span>
              </li>
            );
          })
        ) : (
          <li className={styles.muted}>nothing recorded</li>
        )}
      </ul>

      {side.intervention && (
        <>
          <h4>What this dispatches</h4>
          <div className={styles.dispatch}>
            <div className={styles.money}>
              ${side.intervention.effort_usd.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div>
              <div>{side.intervention.description}</div>
              <div className={styles.muted}>
                {side.intervention.duration_hours} h ·{" "}
                {side.intervention.skills.join(", ") || "no skill recorded"}
                {side.intervention.parts.length > 0 &&
                  ` · ${side.intervention.parts.join(", ")}`}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
