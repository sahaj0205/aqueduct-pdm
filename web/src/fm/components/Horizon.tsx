import { Link } from "react-router-dom";

import { EmptyState } from "./EmptyState.tsx";
import type { Horizon as HorizonData } from "../types.ts";
import styles from "./Horizon.module.css";

const TIER_VAR: Record<string, { bg: string; border: string; text: string }> = {
  critical: { bg: "var(--sev-critical-wash)", border: "var(--sev-critical)", text: "var(--sev-critical-text)" },
  high: { bg: "var(--sev-high-wash)", border: "var(--sev-high)", text: "var(--sev-high-text)" },
  medium: { bg: "var(--sev-medium-wash)", border: "var(--sev-medium)", text: "var(--sev-medium-text)" },
  low: { bg: "var(--sev-low-wash)", border: "var(--sev-low)", text: "var(--sev-low-text)" },
};

/**
 * Every open, published remaining-life window on one shared axis. Nothing here is a
 * new number — it is stage 9's own p10/p50/p90 for each advisory, laid out for
 * comparison instead of read one page at a time. Answers a question none of the other
 * screens do: what's the shape of risk across the whole building over the next
 * horizon, and what happens soonest relative to everything else.
 *
 * A refused prediction never gets a band, not a wide one — those are listed
 * separately below, with the same reason their own advisory page gives.
 */
export function Horizon({ data }: { data: HorizonData }) {
  if (data.rows.length === 0 && data.unestimated.length === 0) {
    return (
      <EmptyState title="Nothing to plot" good>
        No open advisory has a published or pending remaining-life estimate.
      </EmptyState>
    );
  }

  const axisMax = Math.max(data.horizon_days, ...data.rows.map((r) => r.p90_days), 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(axisMax * f));
  const pct = (d: number) => `${Math.min(100, Math.max(0, (d / axisMax) * 100))}%`;

  return (
    <div>
      {/* No axis when there is nothing to plot against it. An empty ruler reads as a
          chart that failed to load; the list below says plainly why each estimate is
          absent, which is the honest version of the same screen. */}
      {data.rows.length > 0 && (
        <div className={styles.axis}>
          {ticks.map((t, i) => (
            <span key={i} className={styles.tick} style={{ left: pct(t) }}>
              {t} d
            </span>
          ))}
        </div>
      )}

      {data.rows.map((row) => {
        const paint = TIER_VAR[row.tier] ?? TIER_VAR.low!;
        const rightFrac = row.p90_days / axisMax;
        const left = pct(row.p10_days);
        const width = `calc(${pct(row.p90_days)} - ${pct(row.p10_days)})`;
        const medianLeft = `${((row.p50_days - row.p10_days) / Math.max(1, row.p90_days - row.p10_days)) * 100}%`;
        // A label to the right overruns the axis once the band's own right edge gets
        // close to it — mirror it to the band's left edge instead of letting it clip.
        const labelOnLeft = rightFrac > 0.82;
        return (
          <div key={row.advisory_id} className={styles.row}>
            <Link to={`/fm/worklist/${row.advisory_id}`} className={styles.name}>
              <span className={styles.assetName}>{row.asset_name}</span>
              <span className={styles.faultName}>{row.fault_title}</span>
            </Link>
            <div className={styles.track}>
              <div className={styles.now} />
              <Link
                to={`/fm/worklist/${row.advisory_id}`}
                className={styles.band}
                style={{ left, width, background: paint.bg, borderColor: paint.border }}
                title={`${row.asset_name}: ${row.p10_days}–${row.p90_days} days, most likely ${row.p50_days}`}
              >
                <span className={styles.median} style={{ left: medianLeft, background: paint.border }} />
                <span
                  className={`${styles.bandLabel} ${labelOnLeft ? styles.bandLabelLeft : ""}`}
                  style={{ color: paint.text }}
                >
                  {row.p50_days} d
                </span>
              </Link>
            </div>
          </div>
        );
      })}

      {data.unestimated.length > 0 && (
        <div className={styles.unestimated}>
          <div className={styles.unestimatedTitle}>
            {data.unestimated.length} advisor{data.unestimated.length === 1 ? "y" : "ies"} not shown — no estimate published yet
          </div>
          {data.unestimated.map((u) => (
            <div key={u.advisory_id} className={styles.unestimatedRow}>
              <Link to={`/fm/worklist/${u.advisory_id}`}>
                {u.asset_name} — {u.fault_title}
              </Link>
              <span className={styles.unestimatedReason}>{u.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
