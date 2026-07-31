/**
 * The drawings that sit inside a stage's card.
 *
 * NOT EVERY STAGE GETS ONE, and that restraint is the design. A picture on all thirteen
 * would be thirteen things to decode on top of thirteen explanations, and the ones that
 * added nothing would teach the audience to stop looking at the ones that do. These are the
 * six where a drawing says something words genuinely struggle with:
 *
 *   gap        the distance between what happened and what should have happened
 *   climb      a number walking toward a line that has a physical argument behind it
 *   gauge      how far along a one-way journey this machine has travelled
 *   scales     two costs whose whole point is that they are wildly unequal
 *   fan        three dates that are one answer, not three, and the refusal that precedes it
 *
 * EVERY ONE IS DRAWN FROM THE SNAPSHOT. None is an illustration of the idea in general;
 * each is this machine, on this day, with the numbers the rest of the card quotes. A
 * diagram that showed a tidier curve than the data would be the most persuasive lie in the
 * whole walkthrough.
 *
 * Hand-rolled SVG in a fixed viewBox rather than a charting library, for the same reason as
 * the reading's own history: these are drawn partially as beats land, and a library that
 * renders a finished chart in one pass has no way to do that.
 */

import { SNAPSHOT as S } from "./snapshot.ts";
import styles from "./Art.module.css";

/** Which drawing a scene asks for. */
export type ArtKind = "gap" | "climb" | "gauge" | "scales" | "fan";

const W = 1100;
// Deliberately short. A card is a fixed height, and every unit the drawing takes is a unit
// the text above it loses — so these are sized to sit alongside the words, not to dominate.
const H = 130;

/* ------------------------------------------------------------------ small helpers */

const span = (values: number[]) => {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return { lo, hi, range: hi - lo || 1 };
};

/* ------------------------------------------------------------------- the drawings */

/** Observed against expected, with the gap between them shaded. */
function Gap({ shown }: { shown: number }) {
  const rows = S.baseline.residuals.slice(-160);
  if (rows.length < 2) return null;
  const { lo, range } = span([...rows.map((r) => r.observed), ...rows.map((r) => r.expected)]);
  const x = (i: number) => (i / (rows.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / range) * H;

  const observed = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(r.observed)}`).join(" ");
  const expected = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(r.expected)}`).join(" ");
  // The shaded area between the two lines: out along the expected curve, back along the
  // observed one. That enclosed region IS the residual, which is what the next stage
  // consumes — so the drawing and the pipeline are showing the same quantity.
  const band =
    `${rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(r.expected)}`).join(" ")} ` +
    `${rows
      .map((_, i) => {
        const j = rows.length - 1 - i;
        return `L${x(j)},${y(rows[j]!.observed)}`;
      })
      .join(" ")} Z`;

  return (
    <svg className={styles.art} viewBox={`0 -14 ${W} ${H + 34}`} role="img"
         aria-label="What the machine produced, against what the healthy model expected">
      {shown >= 2 && <path d={band} className={styles.band} />}
      <path d={expected} className={styles.expected} />
      {shown >= 1 && <path d={observed} className={styles.observed} />}
      <text x={0} y={-2} className={styles.key}>— expected</text>
      <text x={150} y={-2} className={styles.keyObserved}>— observed</text>
      {shown >= 2 && <text x={330} y={-2} className={styles.keyGap}>▨ the gap that carries forward</text>}
    </svg>
  );
}

/** The indicator walking toward the value at which the fault counts as failed. */
function Climb({ shown }: { shown: number }) {
  const rows = S.health.daily;
  if (rows.length < 2) return null;
  const threshold = S.indicator.threshold;
  const hi = Math.max(threshold * 1.12, ...rows.map((r) => r.monotonic));
  const x = (i: number) => (i / (rows.length - 1)) * W;
  const y = (v: number) => H - (v / hi) * H;
  const line = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(r.monotonic)}`).join(" ");
  const last = rows[rows.length - 1]!;

  return (
    <svg className={styles.art} viewBox={`0 -14 ${W} ${H + 34}`} role="img"
         aria-label={`The indicator at ${last.monotonic}, against a failure threshold of ${threshold}`}>
      {shown >= 1 && (
        <>
          <line x1={0} y1={y(threshold)} x2={W} y2={y(threshold)} className={styles.threshold} />
          <text x={W} y={y(threshold) - 12} textAnchor="end" className={styles.thresholdLabel}>
            fails at {threshold} {S.indicator.unit}
          </text>
        </>
      )}
      <path d={line} className={styles.climb} />
      <circle cx={x(rows.length - 1)} cy={y(last.monotonic)} r={9} className={styles.head} />
      <text x={x(rows.length - 1) - 14} y={y(last.monotonic) - 16} textAnchor="end" className={styles.headLabel}>
        {last.monotonic} {S.indicator.unit}
      </text>
    </svg>
  );
}

/** How far along a one-way journey the machine has travelled. */
function Gauge({ shown }: { shown: number }) {
  const value = S.health.value;
  const bands = [
    { to: 50, label: "critical", cls: styles.bandCritical },
    { to: 70, label: "degraded", cls: styles.bandDegraded },
    { to: 85, label: "watch", cls: styles.bandWatch },
    { to: 100, label: "healthy", cls: styles.bandHealthy },
  ];
  const x = (v: number) => (v / 100) * W;

  return (
    <svg className={styles.art} viewBox={`0 -26 ${W} 150`} role="img"
         aria-label={`Health ${value} of 100`}>
      {bands.map((b, i) => {
        const from = i === 0 ? 0 : bands[i - 1]!.to;
        return (
          <g key={b.label}>
            <rect x={x(from)} y={44} width={x(b.to) - x(from)} height={30} className={b.cls} />
            <text x={(x(from) + x(b.to)) / 2} y={100} className={styles.tick}>{b.label}</text>
          </g>
        );
      })}
      {shown >= 1 && (
        <g className={styles.fade}>
          <line x1={x(value)} y1={26} x2={x(value)} y2={82} className={styles.needle} />
          <text x={x(value)} y={14} textAnchor="middle" className={styles.needleLabel}>
            {value} of 100
          </text>
        </g>
      )}
    </svg>
  );
}

/** Two costs whose entire point is how unequal they are. */
function Scales({ shown }: { shown: number }) {
  const act = S.advisory?.effort_usd ?? 0;
  const wait = S.advisory?.cost_usd ?? 0;
  if (!act || !wait) return null;
  const max = Math.max(act, wait);
  const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const rows = [
    { label: "cost of acting", v: act, cls: styles.barAct },
    { label: "cost of waiting", v: wait, cls: styles.barWait },
  ];

  return (
    <svg className={styles.art} viewBox={`0 0 ${W} 170`} role="img"
         aria-label={`Acting costs ${money(act)}; waiting costs ${money(wait)}`}>
      {rows.map((r, i) => (
        <g key={r.label} opacity={shown >= i ? 1 : 0.15} className={styles.fade}>
          <text x={0} y={i * 88 + 26} className={styles.rowLabel}>{r.label}</text>
          <rect x={0} y={i * 88 + 40} width={Math.max(4, (r.v / max) * W)} height={34} rx={6} className={r.cls} />
          <text x={Math.max(4, (r.v / max) * W) + 16} y={i * 88 + 65} className={styles.rowValue}>
            {money(r.v)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Three dates that are one answer — or, today, the refusal that comes before it. */
function Fan({ shown }: { shown: number }) {
  const p = S.prediction;
  const est = p.kind === "refusal" ? p.arrivingEstimate : p;
  if (!est) return null;
  const max = est.p90 * 1.15;
  const x = (d: number) => (d / max) * W;

  return (
    <svg className={styles.art} viewBox={`0 -10 ${W} 160`} role="img"
         aria-label={`Between ${est.p10} and ${est.p90} days, most likely ${est.p50}`}>
      {p.kind === "refusal" && shown < 3 ? (
        <text x={W / 2} y={70} textAnchor="middle" className={styles.refusal}>
          no answer today — not enough evidence to fit a rate
        </text>
      ) : (
        <>
          <rect x={x(est.p10)} y={40} width={x(est.p90) - x(est.p10)} height={40} rx={8} className={styles.fanBand} />
          <line x1={x(est.p50)} y1={30} x2={x(est.p50)} y2={90} className={styles.fanMid} />
          <text x={x(est.p50)} y={22} textAnchor="middle" className={styles.fanLabel}>{est.p50} days, likely</text>
          <text x={x(est.p10)} y={108} textAnchor="middle" className={styles.tick}>{est.p10}</text>
          <text x={x(est.p90)} y={108} textAnchor="middle" className={styles.tick}>{est.p90}</text>
          <text x={W / 2} y={140} textAnchor="middle" className={styles.tick}>
            days of life left — a band, never a single date
          </text>
        </>
      )}
    </svg>
  );
}

const DRAWINGS: Record<ArtKind, (p: { shown: number }) => JSX.Element | null> = {
  gap: Gap,
  climb: Climb,
  gauge: Gauge,
  scales: Scales,
  fan: Fan,
};

export function Art({ kind, shown }: { kind: ArtKind; shown: number }) {
  const Drawing = DRAWINGS[kind];
  return <Drawing shown={shown} />;
}
