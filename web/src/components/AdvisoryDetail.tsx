import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "../api.ts";
import { chartWindow, healthSeries } from "../lib/chart.ts";
import { usd } from "../lib/format.ts";
import type { AdvisoryDetail as Detail, HealthSeries, RulHistory } from "../types.ts";
import { FaultClassBadge } from "./FaultClassBadge.tsx";
import { RulFanChart } from "./RulFanChart.tsx";
import styles from "./AdvisoryDetail.module.css";

/**
 * One advisory in full: the argument for doing this work, in the order it is made.
 *
 * Laid out so a reader travelling top to bottom encounters the same sequence the
 * advisory layer assembles: what is wrong, when it fails, why we believe it, who it
 * reaches, what it costs, what to do. The fan chart sits first in the wide column
 * because "when does this fail and how sure are you" is the question that brought the
 * operator to this page.
 */
export function AdvisoryDetail({
  advisoryId,
  onBack,
}: {
  advisoryId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<RulHistory | null>(null);
  const [health, setHealth] = useState<HealthSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    (async () => {
      try {
        const loaded = await api.advisory(advisoryId);
        if (cancelled) return;
        setDetail(loaded);

        // The same span the chart draws, from the one function that defines it, so
        // the indicator line and the prediction band cannot be fetched over different
        // intervals. It reaches back before the advisory's own window so the flat
        // pre-onset stretch is visible -- a degradation chart that starts at the moment
        // degradation was confirmed hides the thing that makes the confirmation mean
        // anything.
        const span = chartWindow(loaded.detail);

        // Both are optional extras: an advisory renders without them, so a missing
        // remaining-life history degrades the page rather than breaking it.
        const [nextHistory, nextHealth] = await Promise.all([
          api.rulHistory(loaded.asset_id).catch(() => null),
          api.health(loaded.asset_id, span.from, span.to).catch(() => null),
        ]);
        if (cancelled) return;
        setHistory(nextHistory);
        setHealth(nextHealth);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [advisoryId]);

  if (error) {
    return (
      <>
        <button className={styles.back} onClick={onBack}>
          ← back to the queue
        </button>
        <div className="notice">{error}</div>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        <button className={styles.back} onClick={onBack}>
          ← back to the queue
        </button>
        <div className="muted">Loading the advisory…</div>
      </>
    );
  }

  const p = detail.detail;
  const trend = healthSeries(health?.series ?? [], p.fault.mode_id);
  const priority = p.priority;

  return (
    <>
      <button className={styles.back} onClick={onBack}>
        ← back to the queue
      </button>

      <div className={styles.title}>
        <h2>{p.fault.title}</h2>
        <FaultClassBadge value={p.fault.fault_class} />
      </div>
      <div className={styles.subtitle}>
        <span className={styles.mono}>{p.asset.id}</span> · {p.asset.name} ·{" "}
        <span className={styles.mono}>{p.fault.id}</span> · evidence window{" "}
        {p.window.from.slice(0, 10)} to {p.window.to.slice(0, 10)} · health{" "}
        {p.health ?? "n/a"}
      </div>

      <div className={styles.grid}>
        {/* ---------------- wide column ---------------- */}
        <div>
          <RulFanChart payload={p} history={history} health={health} />

          <div className={styles.card} style={{ marginTop: 16 }}>
            <h3>Health index trend</h3>
            <div className={styles.body} style={{ paddingLeft: 0 }}>
              {trend.length === 0 ? (
                <div className="muted" style={{ padding: "0 14px" }}>
                  No health history — this finding is a rule firing, and health is
                  scored per failure mode.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={150}>
                  <LineChart data={trend} margin={{ top: 4, right: 18, left: 4 }}>
                    <CartesianGrid stroke="#f2f0ec" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      scale="time"
                      tickFormatter={(v: number) =>
                        new Date(v).toISOString().slice(2, 10)
                      }
                      tick={{ fill: "#57534e", fontSize: 11 }}
                      stroke="#e4e0d9"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: "#57534e", fontSize: 11 }}
                      stroke="#e4e0d9"
                      width={40}
                    />
                    <Tooltip
                      labelFormatter={(v) =>
                        new Date(v as number).toISOString().slice(0, 10)
                      }
                      contentStyle={{
                        background: "#faf9f7",
                        border: "1px solid #e4e0d9",
                        fontSize: 12,
                      }}
                    />
                    {/* 100 is the commissioned condition, 0 the failure threshold, so
                        these two lines are the whole scale rather than decoration. */}
                    <ReferenceLine y={0} stroke="#b91c1c" strokeOpacity={0.5} />
                    <Line
                      type="monotone"
                      dataKey="health"
                      stroke="#1d4ed8"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      name="this mode"
                    />
                    <Line
                      type="monotone"
                      dataKey="rollup"
                      stroke="#78716c"
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                      name="asset roll-up"
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className={styles.card}>
            <h3>Evidence — measured values, and how far each moved</h3>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Measurement</th>
                  <th className={styles.num}>Observed</th>
                  <th className={styles.num}>Reference</th>
                  <th className={styles.num}>Moved</th>
                  <th className={styles.num}>σ</th>
                </tr>
              </thead>
              <tbody>
                {p.signals.map((signal) => (
                  <tr key={signal.point_id}>
                    <td>
                      <div className={styles.point}>{signal.point_id}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {signal.label} ({signal.unit})
                      </div>
                    </td>
                    <td className={styles.num}>{signal.observed.toFixed(3)}</td>
                    <td className={styles.num}>{signal.reference.toFixed(3)}</td>
                    <td
                      className={`${styles.num} ${
                        signal.moved >= 0 ? styles.up : styles.down
                      }`}
                    >
                      {signal.moved >= 0 ? "+" : ""}
                      {signal.moved.toFixed(3)}
                    </td>
                    <td className={styles.num}>
                      {signal.sigmas >= 0 ? "+" : ""}
                      {signal.sigmas.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={styles.note}>
              Reference values are the same measurement over a fault-free window at the
              same time of year. σ is movement in units of that window&rsquo;s own
              spread, which is what makes a 200 W fan residual and a 2 K temperature
              comparable. {p.signals_excluded.unusable_source_data} measurement(s)
              excluded because their source data is known defective and{" "}
              {p.signals_excluded.untrusted_readings} because the quality layer
              condemned the readings.
            </div>
            {p.diagnosis_evidence.length > 0 && (
              <div className={styles.body} style={{ paddingTop: 10 }}>
                <div className={styles.note} style={{ padding: 0, marginBottom: 4 }}>
                  What the fault classification rests on:
                </div>
                {p.diagnosis_evidence.map((line) => (
                  <div key={line} className={styles.point} style={{ padding: "2px 0" }}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---------------- narrow column ---------------- */}
        <div>
          <div className={styles.card}>
            <h3>Cost of inaction</h3>
            <div className={styles.body}>
              <div className={`${styles.big} ${styles.bad}`}>
                {p.cost.priceable ? usd(p.cost.total_usd) : "not priceable"}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
                over the next {Math.round(p.cost.horizon_days)} days
              </div>
              <dl className={styles.kv}>
                <dt>energy</dt>
                <dd>{usd(p.cost.energy_usd)}</dd>
                <dt>consequential</dt>
                <dd>{usd(p.cost.consequential_usd)}</dd>
                <dt>excess draw</dt>
                <dd>{p.cost.excess_kw.toFixed(3)} kW</dd>
                <dt>duty</dt>
                <dd>{(p.cost.duty * 100).toFixed(1)}%</dd>
                <dt>cost to act</dt>
                <dd>{usd(p.effort_usd)}</dd>
                <dt>priority</dt>
                <dd className={priority === null ? "muted" : styles.ok}>
                  {priority === null ? "unpriced" : priority.toFixed(2)}
                </dd>
              </dl>
              <ul className={styles.basis}>
                {p.cost.basis.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className={styles.card}>
            <h3>Severity</h3>
            <div className={styles.body}>
              <div className={styles.big}>{p.severity.score.toFixed(3)}</div>
              <dl className={styles.kv} style={{ marginTop: 8 }}>
                {Object.entries(p.severity.terms).map(([name, value]) => (
                  <span key={name} style={{ display: "contents" }}>
                    <dt>
                      {name} × {p.severity.weights[name] ?? "?"}
                    </dt>
                    <dd>{value.toFixed(3)}</dd>
                  </span>
                ))}
                <dt>decline</dt>
                <dd>
                  {p.severity.slope_per_day.toFixed(3)} pts/day over{" "}
                  {p.severity.slope_days} d
                </dd>
                <dt>criticality</dt>
                <dd>tier {p.severity.criticality_tier}</dd>
              </dl>
            </div>
          </div>

          <div className={styles.card}>
            <h3>Graph trace</h3>
            <div className={styles.body}>
              {p.trace.cause && (
                <div className={styles.cause}>
                  <div className={styles.who}>
                    ↳ consequential on {p.trace.cause.asset} / {p.trace.cause.fault}
                    {" · "}
                    {p.trace.cause.hops} hops upstream
                  </div>
                  <div style={{ color: "var(--text)" }}>
                    {p.trace.cause.mechanism}
                  </div>
                  <div className="muted" style={{ marginTop: 5, fontSize: 11.5 }}>
                    {p.trace.cause.timing}. This advisory is ranked below its cause but
                    is not hidden — the inference can be wrong, and only you can
                    overrule it.
                  </div>
                </div>
              )}

              <div className={styles.note} style={{ padding: 0 }}>
                Upstream — anything that could physically have caused this
              </div>
              {p.trace.upstream.length === 0 ? (
                <div className="muted">nothing feeds this asset</div>
              ) : (
                p.trace.upstream.map((hop) => (
                  <div className={styles.hop} key={hop.asset}>
                    <span className={styles.hopBadge}>{hop.hops} hops</span>
                    <span className={styles.mono}>{hop.asset}</span>
                  </div>
                ))
              )}

              <div className={styles.note} style={{ padding: "10px 0 0" }}>
                Downstream — who suffers if this is left
              </div>
              {p.trace.downstream_assets.length === 0 &&
              p.trace.zones.length === 0 ? (
                <div className="muted">nothing downstream</div>
              ) : (
                <>
                  {p.trace.downstream_assets.map((asset) => (
                    <div className={styles.hop} key={asset}>
                      <span className={styles.mono}>{asset}</span>
                    </div>
                  ))}
                  <div className={styles.occupants}>
                    <span className={styles.big}>{p.trace.occupants}</span>
                    <span className="muted">
                      occupants across {p.trace.zones.length} zone
                      {p.trace.zones.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className={styles.zones}>
                    {p.trace.zones.map((zone) => (
                      <span className={styles.zone} key={zone}>
                        {zone}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className={styles.card}>
            <h3>Recommended intervention</h3>
            <div className={styles.body}>
              {p.intervention === null ? (
                <div className="muted">
                  Nothing recorded in the intervention library for this fault, so the
                  work cannot be priced.
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 8 }}>{p.intervention.description}</div>
                  <dl className={styles.kv}>
                    <dt>duration</dt>
                    <dd>{p.intervention.duration_hours} technician-hours</dd>
                    <dt>parts cost</dt>
                    <dd>{usd(p.intervention.parts_cost_usd)}</dd>
                    <dt>total</dt>
                    <dd>{usd(p.effort_usd)}</dd>
                  </dl>
                  <div className={styles.skills}>
                    {p.intervention.skills.map((skill) => (
                      <span className={styles.chip} key={skill}>
                        {skill}
                      </span>
                    ))}
                  </div>
                  {p.intervention.parts.length > 0 && (
                    <div className={styles.skills}>
                      {p.intervention.parts.map((part) => (
                        <span className={styles.chip} key={part}>
                          {part}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.intervention.matched_on_class && (
                    <div className={styles.note} style={{ padding: "8px 0 0" }}>
                      Chosen for the <strong>{p.fault.fault_class}</strong> classification
                      specifically. The same reported symptom under a different class
                      calls for a different job at a different cost.
                    </div>
                  )}
                  <div className={styles.note} style={{ padding: "6px 0 0" }}>
                    {p.intervention.basis}
                  </div>
                </>
              )}
            </div>
          </div>

          {p.notes.length > 0 && (
            <div className={styles.card}>
              <h3>Caveats</h3>
              <div className={styles.body} style={{ paddingTop: 4 }}>
                {p.notes.map((note) => (
                  <div className={styles.caveat} key={note}>
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.card}>
            <h3>Why this class</h3>
            <div className={styles.body} style={{ fontSize: 12.5 }}>
              {p.fault.class_reason}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
