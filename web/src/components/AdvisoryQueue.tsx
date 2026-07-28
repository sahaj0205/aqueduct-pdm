import { Fragment, useState } from "react";

import { buildRows } from "../lib/format.ts";
import { Term } from "../design/Term.tsx";
import type { AdvisorySummary } from "../types.ts";
import { FaultClassBadge } from "./FaultClassBadge.tsx";
import styles from "./AdvisoryQueue.module.css";

/**
 * The work queue, in the order the analytics layer put it in.
 *
 * NOT re-sorted here, and that is still the most important thing about this component.
 * The ordering is a two-tier ranking decided upstream: priced advisories on expected
 * dollars saved per dollar spent, unpriced ones after them on severity, and any
 * consequential advisory forced below its own cause. A dashboard that sorted the rows
 * itself would be free to disagree with the numbers it is displaying, and the first time
 * it did, the ranking would stop being explainable.
 *
 * WHAT CHANGED IN R4.
 *
 * The identifier used to be the large text and the human name the small one — `ahu-1`
 * set above "SDAHU", `coil-valve-leak-by` above "Coil valve leak-by". That is the right
 * way round for somebody grepping logs and exactly the wrong way round for anybody else,
 * and the API has always returned both. They are swapped: the name is what you read, the
 * identifier is underneath it in monospace for when you need to quote it.
 *
 * The priority column showed a bare number — "10.59" — under the heading "Priority",
 * which is unreadable without knowing that the figure is dollars saved per dollar spent.
 * The number has not changed. The heading now says what it is, and the column stopped
 * needing an explanation.
 *
 * The "why" column was a truncated sentence with the full text hidden in a hover
 * tooltip, which is unreachable on a touchscreen and unquotable everywhere. It expands.
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
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h2>What needs doing</h2>
        <span className={styles.hint}>
          most saved per dollar spent, first · a knock-on job always sits below its cause
        </span>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <strong>No open jobs.</strong> Either the building is healthy at this moment or
          the queue has not been generated — run <code>make advisory-replay</code>.
        </div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.rankHead}>#</th>
                <th>Machine</th>
                <th>What is wrong</th>
                <th>
                  <Term id="fault-class" quiet>
                    Blame
                  </Term>
                </th>
                <th className={styles.r}>
                  <Term id="health-index" quiet>
                    Health
                  </Term>
                </th>
                <th className={styles.r}>
                  <Term id="rul" quiet>
                    Fails in
                  </Term>
                </th>
                <th className={styles.r}>Saved per $1</th>
                <th className={styles.r}>
                  <Term id="cost-of-inaction" quiet>
                    If ignored
                  </Term>
                </th>
                <th aria-label="expand" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const id = row.advisory.advisory_id;
                const isOpen = open === id;
                return (
                  // Fragment with a key, not a bare <>: each iteration can emit the tier
                  // separator and the expanded panel as well as the row, and React needs
                  // the key on whatever the iteration returns.
                  <Fragment key={id}>
                    {index === firstUnpriced && firstUnpriced > 0 && (
                      <tr className={styles.tierRule}>
                        <td colSpan={9}>
                          Below here the cost of inaction could not be computed. These
                          rows are ranked on severity instead — an unpriced job is not a
                          cheap one.
                        </td>
                      </tr>
                    )}

                    <tr
                      className={`${styles.row} ${row.upstream ? styles.consequential : ""} ${
                        isOpen ? styles.rowOpen : ""
                      }`}
                      onClick={() => onSelect?.(row.advisory)}
                      style={onSelect ? { cursor: "pointer" } : undefined}
                    >
                      <td className={styles.rank}>{row.rank}</td>

                      <td className={styles.asset}>
                        <div className={styles.primary}>{row.advisory.asset_name}</div>
                        <div className={styles.code}>{row.advisory.asset_id}</div>
                      </td>

                      <td className={styles.fault}>
                        <div className={styles.primary}>{row.advisory.fault_title}</div>
                        <div className={styles.code}>{row.advisory.fault_id}</div>
                        {row.upstream && (
                          <div className={styles.upstream}>
                            <span className={styles.arrow}>↳ knock-on from</span>{" "}
                            {row.upstream.asset} / {row.upstream.fault}
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
                          row.advisory.priority === null ? styles.unpriced : styles.saved
                        }`}
                      >
                        {row.priority}
                      </td>

                      <td className={styles.num}>
                        <div className={styles.cost}>{row.cost}</div>
                        <div className={styles.sub}>fix for {row.effort}</div>
                      </td>

                      <td className={styles.expandCell}>
                        <button
                          className={styles.expand}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "hide the reasoning" : "show the reasoning"}
                          onClick={(e) => {
                            // The row navigates to the full advisory. This button must
                            // not do that as well — it expands in place, which is what
                            // makes it useful for scanning down the queue.
                            e.stopPropagation();
                            setOpen(isOpen ? null : id);
                          }}
                        >
                          <span className={isOpen ? styles.chevOpen : styles.chev} />
                        </button>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className={styles.detail}>
                        <td colSpan={9}>
                          <div className={styles.detailBody}>
                            <p className={styles.reason}>{row.advisory.why}</p>
                            <div className={styles.detailFacts}>
                              {row.countdown.bounded && (
                                <span>
                                  Failure window <strong>{row.countdown.band}</strong> —
                                  a one-in-ten chance either side of that range, see{" "}
                                  <Term id="percentile-band">p10 / p50 / p90</Term>.
                                </span>
                              )}
                              {row.advisory.priority !== null && (
                                <span>
                                  Doing this returns{" "}
                                  <strong>{row.priority}</strong> dollars of avoided cost
                                  for every dollar spent, which is what puts it at
                                  position {row.rank}.
                                </span>
                              )}
                              <span className={styles.more}>
                                Click the row itself for the full evidence.
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
