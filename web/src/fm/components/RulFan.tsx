import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import * as C from "../lib/chartTheme.ts";
import { dateShort, num } from "../lib/format.ts";
import type { RulSnapshot } from "../types.ts";
import styles from "./RulFan.module.css";

/**
 * Successive daily remaining-life estimates, stacked so the narrowing itself is the
 * picture. Early on, thin evidence gives an enormous, nearly useless range; the same
 * machine's later estimates converge hard on a tight window.
 *
 * Linear axis, not log — a facility manager reading this is not expected to parse a
 * log scale, and the shape linear produces (a huge early spike collapsing fast) tells
 * the same story just as clearly: the estimate used to be nearly useless, and now
 * it isn't.
 */
export function RulFan({ history }: { history: RulSnapshot[] }) {
  if (history.length === 0) return null;
  const data = history.map((h) => ({
    t: new Date(h.t).getTime(),
    p10: h.p10_days,
    p50: h.p50_days,
    p90: h.p90_days,
    band: h.p90_days - h.p10_days,
    samples: h.samples,
  }));
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const firstWidth = first.p90_days - first.p10_days;
  const lastWidth = last.p90_days - last.p10_days;

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.title}>How the estimate has narrowed</span>
        <span className={styles.note}>{history.length} published estimates</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -4 }}>
          <CartesianGrid stroke={C.CHART.grid} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => dateShort(new Date(v).toISOString())}
            tick={{ fontSize: 11, fill: C.CHART.tick }}
            axisLine={{ stroke: C.CHART.axis }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[0, "dataMax"]}
            tick={{ fontSize: 11, fill: C.CHART.tick }}
            axisLine={{ stroke: C.CHART.axis }}
            tickLine={false}
            width={46}
            tickFormatter={(v) => num(v)}
            label={{ value: "days remaining", angle: -90, position: "insideLeft", fontSize: 10, fill: C.inkFaint }}
          />
          <Tooltip
            labelFormatter={(v) => dateShort(new Date(v).toISOString())}
            formatter={(value: number, name: string) =>
              name === "band" ? [null, null] : [`${num(value)} d`, name.toUpperCase()]
            }
            contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: C.hairlineStrong }}
          />
          {/* Two stacked areas, the lower one invisible — Recharts has no native range
              area, so the transparent base area only lifts the visible band off the
              axis. On a linear scale the base's implicit zero-baseline is well-defined,
              so this closes cleanly (unlike a log scale, where it isn't). */}
          <Area dataKey="p10" stackId="fan" stroke="none" fill="none" isAnimationActive={false} legendType="none" />
          <Area
            dataKey="band"
            stackId="fan"
            stroke="none"
            fill={C.infoWash}
            fillOpacity={0.9}
            isAnimationActive={false}
            legendType="none"
          />
          <Line type="monotone" dataKey="p50" stroke={C.info} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p10" stroke={C.hairlineStrong} strokeWidth={1} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p90" stroke={C.hairlineStrong} strokeWidth={1} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className={styles.stat}>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>First published width</span>
          <span className={styles.statValue}>{num(firstWidth)} d</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Current width</span>
          <span className={styles.statValue}>{num(lastWidth)} d</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Samples now</span>
          <span className={styles.statValue}>{num(last.samples)}</span>
        </div>
      </div>
    </div>
  );
}
