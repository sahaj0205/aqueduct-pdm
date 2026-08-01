import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Panel } from "../../design/Panel.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import * as C from "../lib/chartTheme.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import tableStyles from "../components/table.module.css";
import { getSchedule } from "../data/client.ts";
import { useData } from "../data/useData.ts";
import { dateShort, plural, usd } from "../lib/format.ts";
import type { ScheduleItem } from "../types.ts";
import styles from "./Schedule.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function inSeasonBlock(block: string | null, dateIso: string | null): boolean {
  if (!block || !dateIso) return false;
  const [start, end] = block.split("-");
  const startIdx = MONTHS.indexOf(start!);
  const endIdx = MONTHS.indexOf(end!);
  const m = new Date(dateIso).getUTCMonth();
  if (startIdx <= endIdx) return m >= startIdx && m <= endIdx;
  return m >= startIdx || m <= endIdx;
}

export function Schedule() {
  const { data, loading, error } = useData(getSchedule);

  return (
    <div>
      <ScreenHead
        sub="The point of predictive maintenance is turning unplanned repairs into planned ones. This is the plan."
        why="Jobs sharing a trade and a mechanical room are grouped into one visit — one crew dispatch instead of four. A job flagged with a season block cannot be done in that window even though the model says it is due; the tower fill service, for instance, cannot happen during peak cooling season."
      >
        Upcoming work
      </ScreenHead>

      {loading && <EmptyState title="Loading the schedule…" />}
      {error && <EmptyState title="Could not load the schedule">{error}</EmptyState>}

      {data && (
        <>
          {data.months.length > 0 && (
            <Panel title="Next 90 days">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.months} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                  <CartesianGrid stroke={C.CHART.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.CHART.tick }} axisLine={{ stroke: C.CHART.axis }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: C.CHART.tick }} axisLine={{ stroke: C.CHART.axis }} tickLine={false} width={30} />
                  <Tooltip
                    formatter={(v: number, name: string) => [name === "cost_usd" ? usd(v) : `${v} h`, name === "cost_usd" ? "Cost" : "Hours"]}
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: C.hairlineStrong }}
                  />
                  <Bar dataKey="hours" fill={C.info} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          )}

          {data.batches.length > 0 && (
            <Panel title="Crew batches" sub="Jobs that share a trade and a mechanical room, grouped into one visit.">
              {data.batches.map((b) => (
                <div key={b.batch_id} className={styles.batch}>
                  <div className={styles.batchHead}>
                    <span className={styles.batchTitle}>
                      {b.trade} · {b.location}
                    </span>
                    <span className={styles.batchMeta}>
                      {dateShort(b.window_start)} – {dateShort(b.window_end)}
                    </span>
                  </div>
                  {b.items.map((item) => (
                    <ItemRow key={item.advisory_id} item={item} />
                  ))}
                  <span className={styles.batchSaved}>
                    {b.total_hours} h · {usd(b.total_cost_usd)} · {plural(b.trips_saved, "trip")} saved
                  </span>
                </div>
              ))}
            </Panel>
          )}

          {data.singles.length > 0 && (
            <Panel title="Standalone jobs" flush>
              <div className={tableStyles.wrap}>
                <div className={tableStyles.scroll}>
                  <table className={tableStyles.table}>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Job</th>
                        <th>Trade</th>
                        <th>Hours</th>
                        <th>Cost</th>
                        <th>Act by</th>
                        <th>Dispatch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.singles.map((item) => (
                        <tr key={item.advisory_id}>
                          <td className={tableStyles.primary}>
                            {item.asset_name}
                            <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>{item.location}</div>
                          </td>
                          <td className={tableStyles.faint}>{item.job}</td>
                          <td className={tableStyles.faint}>{item.trade}</td>
                          <td className={tableStyles.num}>{item.hours}</td>
                          <td className={tableStyles.num}>{usd(item.cost_usd)}</td>
                          <td className={tableStyles.num}>
                            {item.act_by ? dateShort(item.act_by) : "—"}
                            {inSeasonBlock(item.season_block, item.act_by) && (
                              <span className={styles.seasonWarn}>blocked in {item.season_block}</span>
                            )}
                          </td>
                          <td className={tableStyles.faint}>
                            {item.work_order_status ? (
                              <span className={styles.dispatched}>
                                {item.work_order_status} — {item.assignee}
                              </span>
                            ) : (
                              "not yet dispatched"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Panel>
          )}

          {data.batches.length === 0 && data.singles.length === 0 && (
            <EmptyState title="Nothing to schedule" good>
              No open advisory currently has a costed repair job.
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}

function ItemRow({ item }: { item: ScheduleItem }) {
  return (
    <div className={styles.item}>
      <span>
        {item.asset_name} — {item.job}
        {item.work_order_status && (
          <span className={styles.dispatched}>
            {" "}
            · {item.work_order_status} — {item.assignee}
          </span>
        )}
      </span>
      <span>
        {item.act_by ? dateShort(item.act_by) : "no estimate"}
        {inSeasonBlock(item.season_block, item.act_by) && <span className={styles.seasonWarn}>blocked in {item.season_block}</span>}
      </span>
    </div>
  );
}
