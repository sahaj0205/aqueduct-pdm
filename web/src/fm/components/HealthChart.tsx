import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import * as C from "../lib/chartTheme.ts";
import { Picker } from "../../design/Picker.tsx";
import { dateShort } from "../lib/format.ts";
import type { HealthSeries } from "../types.ts";
import styles from "./HealthChart.module.css";

const DAY = 86_400_000;

/**
 * The health trend — raw and clamped, an onset marker, shaded and labelled gaps where
 * judgement was suppressed, and a pin for every recorded repair.
 *
 * BOTH LINES ARE STORED FOR A REASON: the clamped line is what the rest of the system
 * acts on (health can only ever slide down between repairs); the raw line is kept so
 * that clamp can be checked against what the instruments actually reported, rather than
 * taken on faith. The toggle defaults to clamped-only because that is the number that
 * matters day to day — raw is for when someone wants to audit it.
 */
export function HealthChart({ series }: { series: HealthSeries }) {
  const [showRaw, setShowRaw] = useState(false);

  const data = series.points.map((p) => ({
    t: new Date(p.t).getTime(),
    raw: p.raw,
    clamped: p.clamped,
    evaluated: p.evaluated,
    reason: p.suppressed_reason,
  }));

  const gaps = series.points.reduce<{ from: number; to: number; reason: string }[]>((acc, p) => {
    if (!p.evaluated && p.suppressed_reason) {
      const t = new Date(p.t).getTime();
      const last = acc[acc.length - 1];
      if (last && t - last.to <= DAY * 1.5 && last.reason === p.suppressed_reason) {
        last.to = t;
      } else {
        acc.push({ from: t, to: t, reason: p.suppressed_reason });
      }
    }
    return acc;
  }, []);

  const onsetT = series.onset ? new Date(series.onset).getTime() : null;
  const commissionFrom = new Date(series.commissioning.from).getTime();
  const commissionTo = new Date(series.commissioning.to).getTime();

  return (
    <div>
      <div className={styles.head}>
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: C.ink }} />
            Clamped (acted on)
          </span>
          {showRaw && (
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: C.inkFaint, opacity: 0.7 }} />
              Raw
            </span>
          )}
        </div>
        <Picker
          label="Show"
          value={showRaw ? "both" : "clamped"}
          onChange={(v) => setShowRaw(v === "both")}
          options={[
            { id: "clamped", label: "Clamped only" },
            { id: "both", label: "Raw + clamped" },
          ]}
        />
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -4 }}>
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
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: C.CHART.tick }}
            axisLine={{ stroke: C.CHART.axis }}
            tickLine={false}
            width={34}
          />
          <ReferenceArea x1={commissionFrom} x2={commissionTo} fill={C.sunken} fillOpacity={0.6} />
          {gaps.map((g, i) => (
            <ReferenceArea
              key={i}
              x1={g.from}
              x2={g.to === g.from ? g.from + DAY * 0.5 : g.to}
              fill={C.hairlineStrong}
              fillOpacity={0.35}
            />
          ))}
          {onsetT && (
            <ReferenceLine
              x={onsetT}
              stroke={C.high}
              strokeDasharray="4 3"
              label={{ value: "Onset", position: "insideTopLeft", fontSize: 10, fill: C.highInk }}
            />
          )}
          {series.repairs.map((r, i) => (
            <ReferenceLine
              key={i}
              x={new Date(r.t).getTime()}
              stroke={C.info}
              strokeWidth={2}
              label={{ value: "Repair", position: "insideTopLeft", fontSize: 10, fill: C.infoInk }}
            />
          ))}
          <Tooltip content={<HealthTooltip repairs={series.repairs} />} />
          {showRaw && (
            <Line
              dataKey="raw"
              stroke={C.inkFaint}
              strokeWidth={1.25}
              strokeOpacity={0.7}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
          <Line
            dataKey="clamped"
            stroke={C.ink}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function HealthTooltip({
  active,
  payload,
  repairs,
}: {
  active?: boolean;
  payload?: { payload: { t: number; raw: number | null; clamped: number | null; evaluated: boolean; reason: string | null } }[];
  repairs: HealthSeries["repairs"];
}) {
  if (!active || !payload || !payload[0]) return null;
  const p = payload[0].payload;
  const repair = repairs.find((r) => Math.abs(new Date(r.t).getTime() - p.t) < DAY);
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{dateShort(new Date(p.t).toISOString())}</div>
      {!p.evaluated ? (
        <div className={styles.tooltipGap}>Not evaluated — {p.reason}</div>
      ) : (
        <>
          <div className={styles.tooltipRow}>
            <span>Clamped</span>
            <strong>{p.clamped}</strong>
          </div>
          {p.raw !== null && (
            <div className={styles.tooltipRow}>
              <span>Raw</span>
              <span>{p.raw}</span>
            </div>
          )}
        </>
      )}
      {repair && <div className={styles.tooltipGap}>Repair logged: {repair.note}</div>}
    </div>
  );
}
