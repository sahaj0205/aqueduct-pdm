import { healthBand, usd } from "../lib/format.ts";
import type { FaultClass, SiteSummary } from "../types.ts";
import { FaultClassBadge } from "./FaultClassBadge.tsx";
import styles from "./SummaryStrip.module.css";

/**
 * The strip along the top: what the whole site looks like in one line of cells.
 *
 * Chosen so that the two numbers a manager asks about first are adjacent — what does
 * doing nothing cost, and what does fixing it cost — because the ratio of those two
 * is what the entire queue is sorted by, and seeing them side by side is what makes
 * the ordering legible rather than mysterious.
 *
 * `unpriced` gets its own cell rather than being folded into the advisory count. It
 * says how much of the queue could not be given a cost at all, which is the honest
 * caveat on the totals beside it: those totals are the sum over the priced rows only.
 */
export function SummaryStrip({ summary }: { summary: SiteSummary }) {
  const band = healthBand(summary.worst_health);
  const classes = Object.entries(summary.by_class) as [FaultClass, number][];

  return (
    <>
      <div className={styles.strip}>
        <div className={styles.cell}>
          <div className={styles.label}>Assets</div>
          <div className={styles.value}>{summary.assets}</div>
          <div className={styles.note}>modelled equipment</div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>Open advisories</div>
          <div className={styles.value}>{summary.advisories}</div>
          <div className={styles.note}>
            {summary.consequential} consequential
          </div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>Worst health</div>
          <div className={`${styles.value} ${styles[band] ?? ""}`}>
            {summary.worst_health ?? "n/a"}
          </div>
          <div className={styles.note}>
            {summary.worst_health_asset ?? "nothing scored"}
          </div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>
            Cost of inaction · {Math.round(summary.horizon_days)} d
          </div>
          <div className={`${styles.value} ${styles.bad}`}>
            {usd(summary.total_cost_of_inaction_usd)}
          </div>
          <div className={styles.note}>priced advisories only</div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>Cost to act</div>
          <div className={styles.value}>{usd(summary.total_effort_usd)}</div>
          <div className={styles.note}>labour and parts</div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>Unpriced</div>
          <div className={styles.value}>{summary.unpriced}</div>
          <div className={styles.note}>ranked on severity</div>
        </div>

        <div className={styles.cell}>
          <div className={styles.label}>By fault class</div>
          <div className={styles.classes}>
            {classes.length === 0 ? (
              <span className={styles.note}>none</span>
            ) : (
              classes.map(([name, count]) => (
                <span key={name}>
                  <FaultClassBadge value={name} /> <span className="mono">{count}</span>
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* The vintage matters more here than in most systems. This database holds
          eight independent simulation runs in separate calendar eras, so "now" is
          not a single instant, and the health figures above are quoted as of the
          window each asset's own advisories were computed over. Stating when the
          queue was generated stops the screen implying it is live. */}
      <div className={styles.vintage}>
        Queue generated{" "}
        {summary.generated_at
          ? new Date(summary.generated_at).toLocaleString()
          : "never — run `make advisories` with --write"}
        . Health is quoted as of each asset&rsquo;s own advisory window, not wall-clock
        now.
      </div>
    </>
  );
}
