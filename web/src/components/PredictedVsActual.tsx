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

import type { RulPoint } from "../types.ts";
import styles from "./PredictedVsActual.module.css";

/**
 * Where the model said the machine would fail, against when it actually did.
 *
 * THE MOST USEFUL PICTURE IN THIS PROJECT, and the least flattering. Each point is one
 * day's prediction, plotted as the failure DATE it implies rather than as a number of
 * days remaining — because a countdown always looks like it is working. A correct
 * forecaster's line walks onto the horizontal truth line and stays there. A late-biased
 * one approaches from above and never lands, and that is what this one does.
 *
 * WHY THE TRUTH LINE NEEDS A CAVEAT BESIDE IT. The answer key's failure date is the
 * moment the injected fault reached its terminal severity. The model is predicting a
 * different event: when its own indicator crosses its own physically justified
 * threshold. VALIDATION.md splits the 10.1 percent interval coverage between exactly
 * those two causes, and a chart that showed the gap without naming that distinction
 * would be reporting a modelling error where part of it is a definitional one.
 */

interface Props {
  points: RulPoint[];
  /** From the answer key. Null when the reveal service is not running. */
  actualFailure: string | null;
  modeId: string;
}

export function PredictedVsActual({ points, actualFailure, modeId }: Props) {
  const bounded = points.filter((p) => p.p50 !== null);
  const data = bounded.map((p) => {
    const made = new Date(p.as_of).getTime();
    const day = 86_400_000;
    return {
      made,
      madeLabel: p.as_of.slice(0, 10),
      predicted: made + (p.p50 as number) * day,
      low: p.p10 !== null ? made + p.p10 * day : null,
      high: p.p90 !== null ? made + p.p90 * day : null,
      n: p.n_samples,
    };
  });

  const truth = actualFailure ? new Date(actualFailure).getTime() : null;
  const last = data[data.length - 1];
  const errorDays =
    truth !== null && last ? Math.round((last.predicted - truth) / 86_400_000) : null;

  const fmt = (value: number) => new Date(value).toISOString().slice(0, 10);

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h3>Where it said the failure would be, against where it was</h3>
        <span className={styles.muted}>{modeId}</span>
      </div>

      {data.length === 0 ? (
        <p className={styles.muted}>
          No bounded estimate on this series, so there is nothing to plot. The model
          declining to answer is itself the result.
        </p>
      ) : (
        <>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="#2b3644" strokeDasharray="2 4" />
                <XAxis
                  dataKey="made"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={fmt}
                  stroke="#63707f"
                  fontSize={10}
                />
                <YAxis
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={fmt}
                  stroke="#63707f"
                  fontSize={10}
                  width={78}
                />
                <Tooltip
                  contentStyle={{
                    background: "#171e28",
                    border: "1px solid #2b3644",
                    fontSize: 11,
                  }}
                  labelFormatter={(v) => `predicted on ${fmt(Number(v))}`}
                  formatter={(value, name) => [
                    value === null || value === undefined
                      ? "unbounded"
                      : fmt(Number(value)),
                    String(name),
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="high"
                  name="optimistic end"
                  stroke="#3a4655"
                  dot={false}
                  strokeWidth={1}
                />
                <Line
                  type="monotone"
                  dataKey="low"
                  name="pessimistic end"
                  stroke="#3a4655"
                  dot={false}
                  strokeWidth={1}
                />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  name="predicted failure date"
                  stroke="#4f9ad8"
                  dot={false}
                  strokeWidth={2}
                />
                {truth !== null && (
                  <ReferenceLine
                    y={truth}
                    stroke="#3fb27f"
                    strokeWidth={1.6}
                    strokeDasharray="6 4"
                    label={{
                      value: `actually failed ${fmt(truth)}`,
                      fill: "#8fd9bb",
                      fontSize: 10,
                      position: "insideBottomRight",
                    }}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {truth === null ? (
            <p className={styles.caveat}>
              The true failure date is answer-key material and comes from the reveal
              service, which is not running. Start it with <code>make reveal</code>.
              Everything else on this screen works without it.
            </p>
          ) : (
            <p className={styles.caveat}>
              <strong>
                The blue line never reaches the green one, and that is the finding.
              </strong>{" "}
              The last prediction on this series puts failure{" "}
              <strong>{errorDays} days</strong> after it actually happened. Every
              estimate on the two series where the scored mode names the injected fault
              is late — 41 of 41 — and late is the dangerous direction, because it tells
              a planner they have time they do not have.
              <br />
              <br />
              Part of that gap is definitional rather than an error. The green line is
              when the <em>injected fault</em> reached its terminal severity. The model
              is predicting a different event: when <em>its own indicator</em> crosses
              its own threshold. On this series the indicator only ever reached 57% of
              that threshold, so the two events were never going to coincide.{" "}
              <code>VALIDATION.md</code> section 5 splits the 10.1% coverage between
              those two causes rather than reporting it as one.
            </p>
          )}
        </>
      )}
    </section>
  );
}
