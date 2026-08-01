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
import type { ResidualSeries } from "../types.ts";
import styles from "./ExpectedVsActual.module.css";

/**
 * The single most persuasive object on the trust screen: what a healthy machine would
 * have read, against what this one actually read, with the gap between them shaded.
 * The baseline already regresses out load, weather and duty — so this shape, on its
 * own, is the answer to "maybe it's just running harder lately".
 */
export function ExpectedVsActual({ series }: { series: ResidualSeries }) {
  const data = series.points.map((p) => ({
    t: new Date(p.t).getTime(),
    observed: p.observed,
    expected: p.expected,
    residual: p.observed - p.expected,
  }));

  // Computed from observed/expected alone, as literal numbers — not the recharts
  // "dataMin"/"dataMax" domain keywords, which pool across every dataKey on the axis,
  // including the invisible stacked "residual" series (values near zero) and would
  // otherwise drag the whole axis down to near-zero regardless of the real range.
  const values = data.flatMap((d) => [d.observed, d.expected]);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const pad = Math.max(0.3, (vMax - vMin) * 0.2);

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.title}>{series.label}</span>
        <span className={styles.drivers}>{series.unit}</span>
      </div>
      <div className={styles.drivers} style={{ marginBottom: 10 }}>
        Expected from: {series.drivers.join(", ")} — already regressed out.
      </div>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: C.ink }} />
          Observed
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: C.inkFaint }} />
          Expected (healthy model)
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchArea} style={{ background: C.highWash, border: `1px solid ${C.high}` }} />
          Residual
        </span>
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
            tick={{ fontSize: 11, fill: C.CHART.tick }}
            axisLine={{ stroke: C.CHART.axis }}
            tickLine={false}
            width={44}
            domain={[vMin - pad, vMax + pad]}
            tickFormatter={(v) => num(v, 1)}
            // Without this, recharts silently unions the domain with the stacked
            // "expected" area's implicit zero baseline and the axis falls back to
            // starting at 0 regardless of the literal domain above.
            allowDataOverflow
          />
          <Tooltip
            labelFormatter={(v) => dateShort(new Date(v).toISOString())}
            formatter={(value: number, name: string) => [`${value.toFixed(2)} ${series.unit}`, name]}
            contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: C.hairlineStrong }}
          />
          <Area dataKey="expected" stackId="gap" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" />
          <Area
            dataKey="residual"
            stackId="gap"
            stroke="none"
            fill={C.highWash}
            fillOpacity={0.9}
            isAnimationActive={false}
            legendType="none"
          />
          <Line dataKey="expected" stroke={C.inkFaint} strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          <Line dataKey="observed" stroke={C.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
