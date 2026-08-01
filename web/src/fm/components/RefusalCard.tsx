import type { Rul } from "../types.ts";
import styles from "./RefusalCard.module.css";

const GATE_LABEL: Record<Extract<Rul, { published: false }>["gate"], string> = {
  onset: "Onset not yet confirmed",
  evidence: "Not enough post-onset evidence",
  rate: "Rate of decline not established",
  width: "Range would be wider than the evidence supports",
};

/**
 * The designed "no prediction" object. A refusal is not an empty cell — printing
 * nothing where a date belongs reads as a bug, or worse, as "nothing to worry about".
 * This card is deliberately as prominent as a published estimate would have been.
 */
export function RefusalCard({ rul }: { rul: Extract<Rul, { published: false }> }) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>No remaining-life estimate — {GATE_LABEL[rul.gate]}</div>
      <p className={styles.reason}>{rul.reason}</p>
      <div className={styles.needs}>
        <span className={styles.needsLabel}>Needs:</span>
        <span>{rul.needs}</span>
      </div>
    </div>
  );
}
