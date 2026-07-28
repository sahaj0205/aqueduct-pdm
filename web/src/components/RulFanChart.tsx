import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  crossingWindow,
  fanBand,
  indicatorSeries,
  narrowing,
  toEpoch,
} from "../lib/chart.ts";
import type { AdvisoryPayload, HealthSeries, RulHistory } from "../types.ts";
import styles from "./RulFanChart.module.css";

/**
 * The remaining-life fan chart. Two panels, one time axis.
 *
 * See src/lib/chart.ts for why it is two panels and not one. Everything on screen is
 * prepared by that module, which is pure and checked by scripts/verify-detail.ts, so
 * the numbers here have been verified outside a browser.
 *
 * The one rule this component will not break: when the advisory carries a refusal, no
 * band is drawn. Not a wide band, not a dashed one. A refused prediction is not an
 * uncertain prediction, and any band at all would contradict the sentence printed in
 * its place.
 */
const DAY_MS = 86_400_000;

function day(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: number): string {
  return new Date(value).toISOString().slice(2, 10);
}

export function RulFanChart({
  payload,
  history,
  health,
}: {
  payload: AdvisoryPayload;
  history: RulHistory | null;
  health: HealthSeries | null;
}) {
  const modeId = payload.fault.mode_id;
  const threshold = modeId ? history?.failure_threshold[modeId] : undefined;
  const unit = (modeId ? history?.indicator_unit[modeId] : undefined) ?? "";
  const indicator = indicatorSeries(health?.series ?? [], modeId);
  const band = fanBand(modeId ? (history?.modes[modeId] ?? []) : [], payload);
  const stats = narrowing(band);
  const crossing = crossingWindow(payload);

  // A rule firing has no indicator and no threshold, so there is nothing to chart at
  // all. Saying that plainly is better than an empty pair of axes, which reads as a
  // chart that failed to load.
  if (!modeId) {
    return (
      <section className={styles.wrap}>
        <div className={styles.head}>
          <h3>Remaining life</h3>
          <div className={styles.sub}>
            no degradation indicator for this finding
          </div>
        </div>
        <div className={styles.refused}>
          <div className={styles.title}>Nothing to project</div>
          <div className={styles.body}>
            This advisory came from a physics rule, not from a degradation trend. A rule
            reports that a condition is true right now — a valve saturated, a balance
            violated — and carries no quantity accumulating toward a threshold, so there
            is no indicator to plot and no crossing to predict. The evidence below is
            what this finding rests on instead.
          </div>
        </div>
      </section>
    );
  }

  // The x axis has to cover the indicator history AND the predicted crossing window,
  // because the whole point of the picture is the gap between where the machine has
  // got to and where it is going. Padded by a few days so the last marker is not
  // clipped by the plot edge.
  const left = indicator.length > 0 ? indicator[0]!.t : toEpoch(payload.window.from);
  const rightCandidates = [
    indicator.length > 0 ? indicator[indicator.length - 1]!.t : left,
    crossing?.p90 ?? crossing?.p50 ?? left,
  ];
  const right = Math.max(...rightCandidates) + 3 * DAY_MS;

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h3>Remaining life — {payload.fault.title}</h3>
        <div className={styles.sub}>
          top: the degradation indicator against its failure threshold, with the
          predicted crossing window shaded · bottom: how the prediction interval
          changed as evidence accumulated
        </div>
      </div>

      {/* ---- panel 1: indicator, threshold, shaded crossing window ---- */}
      <div className={styles.panelLabel}>
        indicator ({unit}) · threshold {threshold ?? "?"} {unit}
      </div>
      <div className={styles.panel}>
        <ResponsiveContainer width="100%" height={190}>
          <ComposedChart data={indicator} margin={{ top: 4, right: 18, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="#f2f0ec" strokeDasharray="2 4" />
            <XAxis
              dataKey="t"
              type="number"
              domain={[left, right]}
              scale="time"
              tickFormatter={shortDay}
              tick={{ fill: "#57534e", fontSize: 11 }}
              stroke="#e4e0d9"
            />
            <YAxis
              tick={{ fill: "#57534e", fontSize: 11 }}
              stroke="#e4e0d9"
              width={52}
            />
            <Tooltip
              content={({ active, payload: hovered }) => {
                if (!active || !hovered?.length) return null;
                const point = hovered[0]!.payload as {
                  t: number;
                  raw: number | null;
                  clamped: number | null;
                };
                return (
                  <div className={styles.tooltip}>
                    <div className={styles.when}>{day(point.t)}</div>
                    <div className={styles.row}>
                      clamped {point.clamped?.toFixed(3) ?? "—"} {unit}
                    </div>
                    <div className={styles.row}>
                      raw {point.raw?.toFixed(3) ?? "—"} {unit}
                    </div>
                  </div>
                );
              }}
            />

            {/* The predicted crossing window, as a region on the calendar. Shaded
                between the pessimistic and optimistic ends, with the median marked. */}
            {crossing && (
              <ReferenceArea
                x1={crossing.p10}
                x2={crossing.p90 ?? right}
                fill="#b91c1c"
                fillOpacity={0.13}
                stroke="#b91c1c"
                strokeOpacity={0.32}
                strokeDasharray="3 3"
              />
            )}
            {crossing && (
              <ReferenceLine
                x={crossing.p50}
                stroke="#b91c1c"
                strokeOpacity={0.8}
                label={{
                  value: `P50 ${day(crossing.p50)}`,
                  fill: "#b91c1c",
                  fontSize: 10,
                  position: "insideTopRight",
                }}
              />
            )}

            {/* The threshold. The one line that makes "failure" mean anything: it is
                the value app.failure_modes records as failed, with a physical or
                economic justification stored beside it. */}
            {threshold !== undefined && (
              <ReferenceLine
                y={threshold}
                stroke="#b45309"
                strokeDasharray="6 3"
                label={{
                  value: `failure threshold ${threshold} ${unit}`,
                  fill: "#b45309",
                  fontSize: 10,
                  position: "insideTopLeft",
                }}
              />
            )}

            <Line
              type="monotone"
              dataKey="raw"
              stroke="#78716c"
              strokeWidth={1}
              dot={false}
              connectNulls
              name="raw"
            />
            <Line
              type="monotone"
              dataKey="clamped"
              stroke="#1d4ed8"
              strokeWidth={2}
              dot={false}
              connectNulls
              name="clamped"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ---- panel 2: the interval narrowing, or the refusal ---- */}
      {payload.forecast.refusal !== null ? (
        <div className={styles.refused}>
          <div className={styles.title}>No prediction interval — withheld</div>
          <div className={styles.body}>{payload.forecast.refusal}</div>
        </div>
      ) : (
        <>
          <div className={`${styles.panelLabel} ${styles.divider}`}>
            prediction interval, in days remaining, by the date the prediction was made
          </div>
          <div className={styles.panel}>
            <ResponsiveContainer width="100%" height={170}>
              <ComposedChart
                data={band}
                margin={{ top: 4, right: 18, bottom: 0, left: 4 }}
              >
                <CartesianGrid stroke="#f2f0ec" strokeDasharray="2 4" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[left, right]}
                  scale="time"
                  tickFormatter={shortDay}
                  tick={{ fill: "#57534e", fontSize: 11 }}
                  stroke="#e4e0d9"
                />
                <YAxis
                  tick={{ fill: "#57534e", fontSize: 11 }}
                  stroke="#e4e0d9"
                  width={52}
                  label={{
                    value: "days",
                    angle: -90,
                    position: "insideLeft",
                    fill: "#78716c",
                    fontSize: 10,
                  }}
                />
                <Tooltip
                  content={({ active, payload: hovered }) => {
                    if (!active || !hovered?.length) return null;
                    const point = hovered[0]!.payload as {
                      t: number;
                      p10: number | null;
                      p50: number | null;
                      p90: number | null;
                      width: number | null;
                      n: number;
                    };
                    return (
                      <div className={styles.tooltip}>
                        <div className={styles.when}>
                          predicted on {day(point.t)} · {point.n} samples
                        </div>
                        <div className={styles.row}>
                          P10 {point.p10?.toFixed(0) ?? "—"} d
                        </div>
                        <div className={styles.row}>
                          P50 {point.p50?.toFixed(0) ?? "—"} d
                        </div>
                        <div className={styles.row}>
                          P90 {point.p90?.toFixed(0) ?? "unbounded"}
                          {point.p90 !== null ? " d" : ""}
                        </div>
                        <div className={styles.row}>
                          width {point.width?.toFixed(0) ?? "—"} d
                        </div>
                      </div>
                    );
                  }}
                />

                {/* The band itself: filled from P10 up to P90, so its vertical extent
                    IS the uncertainty and the eye reads the closing directly. Drawn as
                    two stacked areas because Recharts has no native range area -- the
                    lower one is transparent and only lifts the visible one off the
                    axis. Where P90 is unbounded the stack has nothing to add and the
                    fill simply stops, which is the honest rendering of an open top. */}
                <Area
                  type="monotone"
                  dataKey="p10"
                  stackId="band"
                  stroke="none"
                  fill="none"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey={(row: { p10: number | null; p90: number | null }) =>
                    row.p90 === null || row.p10 === null ? null : row.p90 - row.p10
                  }
                  stackId="band"
                  stroke="#1d4ed8"
                  strokeOpacity={0.5}
                  fill="#1d4ed8"
                  fillOpacity={0.22}
                  isAnimationActive={false}
                  name="P10–P90"
                />
                <Line
                  type="monotone"
                  dataKey="p50"
                  stroke="#1d4ed8"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                  name="P50"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.readout}>
            <div className={styles.stat}>
              <div className={styles.k}>Estimates</div>
              <div className={styles.v}>{band.length}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.k}>Widest interval</div>
              <div className={styles.v}>
                {stats.widestWidth === null ? "—" : `${Math.round(stats.widestWidth)} d`}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.k}>Narrowest</div>
              <div className={styles.v}>
                {stats.narrowestWidth === null
                  ? "—"
                  : `${Math.round(stats.narrowestWidth)} d`}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.k}>Closed by</div>
              <div className={`${styles.v} ${stats.percentClosed !== null && stats.percentClosed > 0 ? styles.good : ""}`}>
                {stats.percentClosed === null
                  ? "—"
                  : `${Math.round(stats.percentClosed)}%`}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.k}>Samples grew</div>
              <div className={styles.v}>
                {stats.first?.n ?? "—"} → {stats.last?.n ?? "—"}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.k}>Monotone</div>
              <div className={styles.v}>{stats.monotone ? "yes" : "no"}</div>
            </div>
            {stats.unbounded > 0 && (
              <div className={styles.stat}>
                <div className={styles.k}>Unbounded above</div>
                <div className={styles.v}>{stats.unbounded}</div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
