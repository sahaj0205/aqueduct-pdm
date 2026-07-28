import type { TraceStage } from "../types.ts";
import styles from "./StageDetail.module.css";

/**
 * One stage opened: what it was given, what it threw away and why, and what it produced.
 *
 * The evidence comes from what the layer itself recorded while running — which rules
 * were evaluated, which failure modes are past their changepoint, which readings have a
 * fitted baseline, which faults reached the queue. It is not a summary written here.
 */

interface Props {
  stage: TraceStage;
  clean: TraceStage | null;
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === null || value === undefined) return "none";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "none";
    return entries.map(([k, v]) => `${k}: ${renderValue(v)}`).join(" · ");
  }
  return String(value);
}

export function StageDetail({ stage, clean }: Props) {
  const reasons = Object.entries(stage.dropped).filter(([, n]) => n > 0);
  const evidence = Object.entries(stage.detail);
  const kept = stage.entered > 0 ? (stage.passed / stage.entered) * 100 : 0;

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h3>
          <span className={styles.ord}>{stage.ordinal}</span>
          {stage.stage}
        </h3>
        <span className={styles.muted}>
          counting {stage.unit} · {stage.entered.toLocaleString()} in ·{" "}
          {stage.passed.toLocaleString()} out · {kept.toFixed(1)}% through
        </span>
      </div>

      {clean && (
        <p className={styles.compare}>
          On the same day of the year with nothing wrong, this stage passed{" "}
          <strong>{clean.passed.toLocaleString()}</strong> of{" "}
          {clean.entered.toLocaleString()}.
          {clean.passed === 0 && stage.passed > 0 && (
            <> Nothing at all got through on the healthy machine.</>
          )}
        </p>
      )}

      {reasons.length > 0 && (
        <>
          <h4>What did not get through, and why</h4>
          <table className={styles.table}>
            <tbody>
              {reasons.map(([reason, n]) => (
                <tr key={reason}>
                  <td className={styles.n}>{n.toLocaleString()}</td>
                  <td>{reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {evidence.length > 0 && (
        <>
          <h4>What this layer recorded</h4>
          <table className={styles.table}>
            <tbody>
              {evidence.map(([key, value]) => (
                <tr key={key}>
                  <td className={styles.k}>{key}</td>
                  <td>{renderValue(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {reasons.length === 0 && evidence.length === 0 && (
        <p className={styles.muted}>
          This stage dropped nothing and recorded no evidence on this day. Everything
          that arrived went through.
        </p>
      )}
    </section>
  );
}
