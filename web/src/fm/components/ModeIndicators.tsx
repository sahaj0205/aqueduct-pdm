import * as C from "../lib/chartTheme.ts";
import type { ModeIndicator } from "../types.ts";
import styles from "./ModeIndicators.module.css";

const BAND_COLOR: Record<ModeIndicator["band"], string> = {
  healthy: C.low,
  watch: C.medium,
  degraded: C.high,
  critical: C.critical,
};

/**
 * Every way this machine can fail, not just the one with an open advisory. A machine's
 * health is the minimum across these — the governing entry is marked, and every other
 * mode is shown alongside it precisely so a healthy asset doesn't look unmonitored.
 */
export function ModeIndicators({ modes }: { modes: ModeIndicator[] }) {
  return (
    <div className={styles.list}>
      {modes.map((m) => {
        const pct = Math.min(100, Math.max(0, (m.current / m.threshold) * 100));
        return (
          <div key={m.mode_id} className={`${styles.row} ${m.governing ? styles.governing : ""}`}>
            <div className={styles.top}>
              <span className={styles.name}>
                {m.mode_label}
                {m.governing && <span className={styles.governingTag}>governs health</span>}
              </span>
              <span className={styles.figures}>
                {m.current} / {m.threshold} {m.unit}
              </span>
            </div>
            <p className={styles.clause}>{m.physics_clause}</p>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${pct}%`, background: BAND_COLOR[m.band] }} />
              <div className={styles.thresholdMark} style={{ left: "100%" }} />
            </div>
            <div className={styles.figures}>
              <span>0</span>
              <span>health {m.health}</span>
            </div>
            <p className={styles.rationale}>Threshold basis: {m.threshold_rationale}</p>
          </div>
        );
      })}
    </div>
  );
}
