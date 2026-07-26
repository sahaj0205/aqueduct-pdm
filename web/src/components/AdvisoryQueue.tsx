import { Fragment } from "react";

import { buildRows } from "../lib/format.ts";
import type { AdvisorySummary } from "../types.ts";
import { FaultClassBadge } from "./FaultClassBadge.tsx";
import styles from "./AdvisoryQueue.module.css";

/**
 * The work queue, in the order the analytics layer put it in.
 *
 * NOT re-sorted here, and that is the most important thing about this component. The
 * ordering is a two-tier ranking decided upstream: priced advisories on expected
 * dollars saved per dollar spent, unpriced ones after them on severity, and any
 * consequential advisory forced below its own cause. A dashboard that sorted the rows
 * itself would be free to disagree with the numbers it is displaying, and the first
 * time it did, the ranking would stop being explainable.
 *
 * The boundary between the two tiers is drawn as a labelled separator row rather than
 * left implicit. An operator scanning down a priority column that suddenly reads
 * "unpriced" needs to know they have crossed into a group ordered on a different
 * quantity, or the ordering looks broken.
 */
export function AdvisoryQueue({
  advisories,
  onSelect,
}: {
  advisories: AdvisorySummary[];
  onSelect?: (advisory: AdvisorySummary) => void;
}) {
  const rows = buildRows(advisories);
  const firstUnpriced = rows.findIndex((row) => row.advisory.priority === null);

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h2>Advisory queue</h2>
        <span className={styles.hint}>
          ordered by expected USD saved per USD spent · consequential rows demoted
          below their cause, never hidden
        </span>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          No open advisories. Either the building is healthy or the queue has not been
          generated — run <code>make advisories</code>.
        </div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Asset</th>
              <th>Failure mode</th>
              <th>Class</th>
              <th style={{ textAlign: "right" }}>Health</th>
              <th style={{ textAlign: "right" }}>Fails in</th>
              <th style={{ textAlign: "right" }}>Priority</th>
              <th style={{ textAlign: "right" }}>Inaction</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // Fragment with a key, not a bare <>: each iteration can emit the tier
              // separator as well as the row, and React needs the key on whatever the
              // iteration returns.
              <Fragment key={row.advisory.advisory_id}>
                {index === firstUnpriced && firstUnpriced > 0 && (
                  <tr className={styles.tierRule}>
                    <td colSpan={9}>
                      below here the cost of inaction could not be computed — these
                      rows are ranked on severity, and an unpriced advisory is not a
                      cheap one
                    </td>
                  </tr>
                )}
                <tr
                  className={`${styles.row} ${
                    row.upstream ? styles.consequential : ""
                  }`}
                  onClick={() => onSelect?.(row.advisory)}
                  style={onSelect ? { cursor: "pointer" } : undefined}
                >
                  <td className={styles.rank}>{row.rank}</td>

                  <td className={styles.asset}>
                    <div className={styles.assetId}>{row.advisory.asset_id}</div>
                    <div className={styles.assetName}>{row.advisory.asset_name}</div>
                  </td>

                  <td className={styles.fault}>
                    <span className={styles.faultTitle}>
                      {row.advisory.fault_title}
                    </span>
                    <span className={styles.faultId}>{row.advisory.fault_id}</span>
                    {row.upstream && (
                      <div className={styles.upstream}>
                        <span className={styles.arrow}>↳ caused by</span>
                        <span className={styles.cause}>
                          {row.upstream.asset} / {row.upstream.fault}
                        </span>
                      </div>
                    )}
                  </td>

                  <td>
                    <FaultClassBadge value={row.advisory.fault_class} />
                  </td>

                  <td className={`${styles.num} ${styles[row.healthBand]}`}>
                    {row.health}
                  </td>

                  <td className={styles.num}>
                    <div className={row.countdown.bounded ? "" : styles.unpriced}>
                      {row.countdown.value}
                    </div>
                    <div className={styles.sub}>{row.countdown.band}</div>
                  </td>

                  <td
                    className={`${styles.num} ${
                      row.advisory.priority === null ? styles.unpriced : ""
                    }`}
                  >
                    {row.priority}
                  </td>

                  <td className={styles.num}>
                    {row.cost}
                    <div className={styles.sub}>act {row.effort}</div>
                  </td>

                  <td className={styles.why} title={row.advisory.why}>
                    {row.advisory.why}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
