/**
 * The drawings, dispatched by kind.
 *
 * NOT EVERY SLIDE GETS ONE and that restraint is the design, the same as in the
 * walkthrough. A picture on every slide is fifty things to decode, and the ones that add
 * nothing train the room to stop looking at the ones that do. Nineteen of fifty-one slides
 * carry a figure; the rest are words because words were enough.
 *
 * EVERY VALUE IS FROM THE CATALOGUE. None of these is an illustration of the idea in
 * general — each is this plant, these scenarios, this machine on this day, with the numbers
 * the slide beside it quotes. A diagram showing a tidier curve than the data would be the
 * most persuasive lie in the whole deck.
 *
 * HAND-ROLLED SVG in a fixed viewBox, no charting library. The project takes no new
 * dependencies, and every one of these is a bespoke diagram rather than a chart of a series
 * — a library would help with two of the nineteen and be dead weight for the rest.
 */

import {
  ASSETS,
  BASELINES,
  BLEND,
  CAUSE_CHAIN,
  CHECKS,
  EDGES,
  HEALTH_TODAY,
  METRICS,
  PREDICTION,
  QUALITY,
  RULE_ENGINE,
  SCENARIOS,
  ADVISORY,
  BASELINE_SERIES,
  scenarioById,
} from "../catalogue.ts";
import type { FigureKind } from "../deck.ts";
import styles from "./figures.module.css";

const W = 620;

/** Every drawing shares one frame, so nineteen figures cannot drift apart in size. */
function Frame({
  children,
  height,
  label,
  caption,
}: {
  children: React.ReactNode;
  height: number;
  label: string;
  caption?: string;
}) {
  return (
    <figure className={styles.figure}>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label}>
        {children}
      </svg>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/* ------------------------------------------------------------------------- act 0 */

/**
 * A picture of this screen, with the part people miss called out.
 *
 * Drawn rather than described because the thing being taught is WHERE something is, and a
 * sentence about the bottom-left of the slide is a worse answer to that than a diagram of
 * the slide with the bottom-left marked. Everything is greyed except the chips row and the
 * drawer, so the eye lands on the two things this slide is about.
 */
function HowToRead() {
  const H = 250;
  const railY = H - 26;
  const chipsY = railY - 42;
  return (
    <Frame height={H + 26} label="Where the controls are: the chips row, the rail, and the drawer"
           caption="the row marked open is clickable — everything else is just a slide">
      {/* The slide itself, quiet. */}
      <rect x={0} y={0} width={W} height={H} rx={6} className={styles.screen} />

      {/* Heading and bullets, as bars — legible as "text" without being readable. */}
      <rect x={22} y={22} width={200} height={13} rx={3} className={styles.ghostStrong} />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={22} y={58 + i * 22} width={250 - i * 40} height={8} rx={3} className={styles.ghost} />
      ))}
      {/* The figure region, so the drawing shows its own layout honestly. */}
      <rect x={330} y={40} width={175} height={80} rx={4} className={styles.ghostBox} />

      {/* THE POINT OF THE DRAWING. */}
      <line x1={22} y1={chipsY - 12} x2={W - 130} y2={chipsY - 12} className={styles.gridline} />
      <text x={22} y={chipsY + 6} className={styles.openTag}>OPEN</text>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={76 + i * 84} y={chipsY - 10} width={76} height={22} rx={11}
              className={i === 0 ? styles.chipLive : styles.chipGhost} />
      ))}
      {/* A pointer resting on the first chip. An arrow with a label would need a legend;
          a cursor is the one symbol that needs no explaining. */}
      <path
        d="M 0 0 l 0 16 l 4.5 -4.5 l 3 7 l 3.5 -1.5 l -3 -6.5 l 6 -0.5 z"
        transform={`translate(102 ${chipsY + 4})`}
        className={styles.cursor}
      />

      {/* The drawer, arriving from the right. */}
      <rect x={W - 118} y={0} width={118} height={H} rx={6} className={styles.drawerGhost} />
      <rect x={W - 100} y={22} width={60} height={9} rx={3} className={styles.ghostStrong} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={W - 100} y={48 + i * 20} width={80 - (i % 2) * 22} height={7} rx={3} className={styles.ghost} />
      ))}
      <text x={W - 59} y={H + 18} textAnchor="middle" className={styles.tickSmall}>the panel</text>

      {/* The rail, so its position on screen is recognisable when they look down at it. */}
      <rect x={22} y={railY} width={W - 160} height={5} rx={2} className={styles.ghost} />
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 2 */

/** What one published file actually holds: a year, one fault, one fixed severity. */
function SourceFiles() {
  const rows = [
    { label: "fault-free run", sev: 0 },
    { label: "fouling, 95% retained", sev: 0.4 },
    { label: "fouling, 65% retained", sev: 1 },
  ];
  return (
    <Frame height={200} label="Each published file holds one year at one fixed fault severity"
           caption="one file · one year · one severity, held flat">
      {rows.map((r, i) => {
        const y = 44 + i * 52;
        return (
          <g key={r.label}>
            <text x={0} y={y - 10} className={styles.tick}>{r.label}</text>
            <rect x={0} y={y} width={W} height={16} rx={3}
                  className={r.sev === 0 ? styles.fileClean : styles.fileFault}
                  opacity={r.sev === 0 ? 1 : 0.4 + r.sev * 0.55} />
          </g>
        );
      })}
      <text x={0} y={196} className={styles.tick}>Jan</text>
      <text x={W} y={196} textAnchor="end" className={styles.tick}>Dec</text>
    </Frame>
  );
}

/** The severity rungs the source publishes for the fault this deck follows. */
function Ladder() {
  const s = scenarioById("chiller_condenser_fouling")!;
  const rungs = [{ level: 0, label: "healthy — the fault-free run" }, ...s.ladder];
  return (
    <Frame height={190} label="The severity rungs available for condenser fouling"
           caption="two rungs, not a slope — which is the problem">
      {rungs.map((r, i) => {
        const y = 150 - i * 52;
        return (
          <g key={r.level}>
            <line x1={0} y1={y} x2={210} y2={y} className={styles.rung} />
            <text x={222} y={y + 6} className={styles.rungLabel}>{r.label}</text>
          </g>
        );
      })}
      <line x1={8} y1={158} x2={8} y2={40} className={styles.rail} />
    </Frame>
  );
}

/** The progress value climbing 0 to 1, and what it mixes at each point. */
function Blend() {
  const s = scenarioById("chiller_condenser_fouling")!;
  const n = 90;
  const H = 150;
  // Not a straight line: the real curve accumulates positive random rate multipliers, so it
  // flattens and steepens but never reverses. Drawn from the same shape rather than a ramp,
  // because a straight line would misrepresent what the trajectory builder produces.
  const pts = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const eased = (t + 0.35 * t * Math.sin(t * 7.5)) / 1.09;
    return { x: (i / (n - 1)) * W, y: H - Math.max(0, Math.min(1, eased)) * H };
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <Frame height={214} label="Progress climbing from 0 at onset to 1 at failure"
           caption={`${s.daysToFailure} days · never decreasing · ${BLEND.rateKnots} rate points from the scenario seed`}>
      <line x1={0} y1={0} x2={W} y2={0} className={styles.gridline} />
      <line x1={0} y1={H} x2={W} y2={H} className={styles.gridline} />
      <text x={0} y={-4} className={styles.tick} dy={12}>1 · fully degraded</text>
      <text x={0} y={H + 18} className={styles.tick}>0 · onset</text>
      <path d={path} className={styles.climbLine} />
      <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r={6} className={styles.head} />
      <text x={W} y={196} textAnchor="end" className={styles.formula}>{BLEND.contribution}</text>
    </Frame>
  );
}

/** All eight scenarios, each on its own year, with onset and failure marked. */
function ScenarioGrid() {
  const rows = SCENARIOS;
  // 30, not 26: at 26 a row's title sat on the bar of the row above it. The label is drawn
  // above its own line, so the gap has to clear the bar's half-height plus the cap height.
  const H = 30;
  const height = rows.length * H + 40;
  const years = rows.map((r) => new Date(r.onset).getUTCFullYear());
  const lo = Math.min(...years);
  const hi = Math.max(...years) + 1;
  const x = (year: number, frac: number) => ((year + frac - lo) / (hi - lo)) * W;
  const dayFrac = (iso: string) => {
    const d = new Date(iso);
    return (d.getUTCMonth() * 30 + d.getUTCDate()) / 365;
  };
  return (
    <Frame height={height} label="Eight scenarios across eight years, onset and failure marked"
           caption="six faults · two clean controls · one year each">
      {rows.map((r, i) => {
        const y = 14 + i * H;
        const year = new Date(r.onset).getUTCFullYear();
        const x0 = x(year, dayFrac(r.onset));
        const x1 = r.failure ? x(new Date(r.failure).getUTCFullYear(), dayFrac(r.failure)) : x0;
        const clean = r.faultMode === "none";
        return (
          <g key={r.id}>
            <line x1={0} y1={y} x2={W} y2={y} className={styles.gridline} />
            {clean ? (
              /* Anchored to the right edge rather than to the scenario's own position: a
                 clean run has no span to sit over, and drawn at x0 the label ran off the
                 end of the figure for the two scenarios latest in the calendar. */
              <text x={W} y={y + 5} textAnchor="end" className={styles.cleanMark}>
                no fault injected
              </text>
            ) : (
              <>
                <rect x={x0} y={y - 6} width={Math.max(3, x1 - x0)} height={12} rx={3}
                      className={styles.faultSpan} />
                <circle cx={x0} cy={y} r={4} className={styles.onsetDot} />
              </>
            )}
            <text x={0} y={y - 10} className={styles.tickSmall}>{r.title}</text>
          </g>
        );
      })}
      <text x={0} y={height - 4} className={styles.tick}>{lo}</text>
      <text x={W} y={height - 4} textAnchor="end" className={styles.tick}>{hi}</text>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 3 */

/** Positions shared by both topology drawings, so adding the edges cannot move a block. */
const NODES: Record<string, { x: number; y: number; label: string }> = {
  ct: { x: 60, y: 30, label: "cooling towers ×3" },
  cdw: { x: 60, y: 100, label: "condenser loop" },
  chiller: { x: 60, y: 170, label: "chillers ×3" },
  chw: { x: 330, y: 170, label: "chilled water loop" },
  coil: { x: 330, y: 100, label: "cooling coil" },
  fan: { x: 330, y: 30, label: "supply fan" },
  zones: { x: 330, y: -40, label: "zones ×5" },
};

function Blocks({ dim = false }: { dim?: boolean }) {
  return (
    <>
      {Object.entries(NODES).map(([k, n]) => (
        <g key={k} opacity={dim ? 0.85 : 1}>
          <rect x={n.x} y={n.y + 60} width={230} height={38} rx={5} className={styles.node} />
          <text x={n.x + 115} y={n.y + 84} textAnchor="middle" className={styles.nodeLabel}>
            {n.label}
          </text>
        </g>
      ))}
    </>
  );
}

function Topology() {
  const total = ASSETS.reduce((a, b) => a + b.points, 0);
  return (
    <Frame height={280} label="The plant as eight machines, with no connections drawn"
           caption={`${ASSETS.length} machines · ${total} instruments · no connections yet`}>
      <Blocks />
    </Frame>
  );
}

function TopologyEdges() {
  // Only the edges between drawn blocks. The full model carries more; these are the ones
  // the root-cause walk in act seven actually traverses.
  const drawn: [string, string][] = [
    ["ct", "cdw"],
    ["cdw", "chiller"],
    ["chiller", "chw"],
    ["chw", "coil"],
    ["coil", "fan"],
    ["fan", "zones"],
  ];
  return (
    <Frame height={280} label="The same plant with the feeds relationships drawn in"
           caption={`${EDGES.length} connections · direction means what A does affects B`}>
      {drawn.map(([a, b]) => {
        const na = NODES[a]!;
        const nb = NODES[b]!;
        const ax = na.x + 115;
        const ay = na.y + 60;
        const bx = nb.x + 115;
        const by = nb.y + 98;
        return (
          <line key={`${a}-${b}`} x1={ax} y1={na.y > nb.y ? ay : ay + 38}
                x2={bx} y2={na.y > nb.y ? by : by - 38} className={styles.edge} />
        );
      })}
      <Blocks dim />
    </Frame>
  );
}

/** How often a reading lands, and what that totals. */
function Cadence() {
  const total = ASSETS.reduce((a, b) => a + b.points, 0);
  const steps = [
    { label: "every 5 minutes", value: "1 reading" },
    { label: "per instrument, per day", value: "288" },
    { label: `across ${total} instruments`, value: "30,816 a day" },
    { label: "in the database", value: "131,006,465" },
  ];
  return (
    <Frame height={216} label="Reading cadence and total volume"
           caption="no summarising, no sampling — every layer reads the raw stream">
      {steps.map((s, i) => {
        const y = 30 + i * 50;
        return (
          <g key={s.label}>
            <text x={0} y={y} className={styles.stepLabel}>{s.label}</text>
            <text x={W} y={y} textAnchor="end"
                  className={i === steps.length - 1 ? styles.stepBig : styles.stepValue}>
              {s.value}
            </text>
            <line x1={0} y1={y + 14} x2={W} y2={y + 14} className={styles.gridline} />
          </g>
        );
      })}
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 4 */

/** Five checks as bars, with the minimum — the one that becomes the composite — marked. */
function QualityGate() {
  // Illustrative shape is not permitted here, so the bars show each check at full marks
  // except one, which is the case the slide is about: the composite is the minimum, so a
  // single failing check decides the score no matter how good the other four are.
  const scores = [98, 100, 34, 96, 91];
  const H = 26;
  const worst = Math.min(...scores);
  return (
    <Frame height={CHECKS.length * 40 + 54} label="Five quality checks; the composite is the minimum"
           caption={`composite = ${worst} · the gate is ${QUALITY.gate}`}>
      {CHECKS.map((c, i) => {
        const y = 14 + i * 40;
        const v = scores[i]!;
        const isWorst = v === worst;
        return (
          <g key={c.id}>
            <text x={0} y={y + 10} className={styles.tickSmall}>{c.name}</text>
            <rect x={150} y={y} width={(v / 100) * (W - 200)} height={H} rx={4}
                  className={isWorst ? styles.barBad : styles.barOk} />
            <text x={W} y={y + 18} textAnchor="end"
                  className={isWorst ? styles.valueBad : styles.value}>{v}</text>
          </g>
        );
      })}
      <line x1={150 + (QUALITY.gate / 100) * (W - 200)} y1={6}
            x2={150 + (QUALITY.gate / 100) * (W - 200)} y2={CHECKS.length * 40 + 10}
            className={styles.gateLine} />
    </Frame>
  );
}

/** The hour window, and why a gap in checking does not break the stretch. */
function RuleStretch() {
  // Each cell is one check: violating, passing, or not evaluated.
  const cells = "VVVVV--VVVVVVVVPVVVV".split("");
  const cw = W / cells.length;
  return (
    <Frame height={170} label="A violation must hold for an hour; a gap does not reset it"
           caption={`${RULE_ENGINE.persistenceMinutes} minutes continuous · a gap is not a pass`}>
      {cells.map((c, i) => (
        <rect key={i} x={i * cw + 2} y={40} width={cw - 4} height={34} rx={3}
              className={c === "V" ? styles.cellViolate : c === "P" ? styles.cellPass : styles.cellGap} />
      ))}
      <text x={0} y={30} className={styles.tickSmall}>violating</text>
      <text x={5 * cw} y={104} className={styles.tickSmall}>gap — not evaluated</text>
      <text x={15 * cw} y={126} className={styles.tickSmall}>checked and passed — stretch ends here</text>
      <line x1={0} y1={82} x2={15 * cw} y2={82} className={styles.spanLine} />
      <text x={0} y={152} className={styles.tick}>the stretch survives the gap, and only the pass ends it</text>
    </Frame>
  );
}

/** The shape of a generated advisory, field by field, with the act each field came from. */
function AdvisoryCard() {
  // No advisory in the snapshot means no advisory to draw. Nothing is substituted — a
  // representative example on a slide about traceability would undo the slide.
  if (!ADVISORY) return null;
  const rows = [
    { k: "what is wrong", v: "chiller 1 · condenser fouling · equipment", act: "acts 3 & 5" },
    { k: "when it fails", v: PREDICTION.kind === "refusal" ? "refused — not enough evidence yet" : "a dated band", act: "act 6" },
    { k: "why we believe it", v: `health ${HEALTH_TODAY.value} of 100 · onset 30 May`, act: "act 5" },
    { k: "who it reaches", v: "5 zones · 200 occupants · 1 machine downstream", act: "act 3" },
    {
      k: "what it is worth",
      v: `${money(ADVISORY.cost_usd ?? 0)} against ${money(ADVISORY.effort_usd ?? 0)}`,
      act: "act 7",
    },
    { k: "what to do", v: "brush the tube bundle · 8 hours · $850 parts", act: "act 3" },
  ];
  return (
    <Frame height={rows.length * 36 + 26} label="The advisory, field by field"
           caption="one object · every field traceable to the act that produced it">
      {rows.map((r, i) => {
        const y = 20 + i * 36;
        return (
          <g key={r.k}>
            <text x={0} y={y} className={styles.fieldKey}>{r.k}</text>
            <text x={0} y={y + 16} className={styles.fieldVal}>{r.v}</text>
            <text x={W} y={y} textAnchor="end" className={styles.fieldFrom}>{r.act}</text>
            <line x1={0} y1={y + 24} x2={W} y2={y + 24} className={styles.gridline} />
          </g>
        );
      })}
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 5 */

/** Drivers in, an equation with constants, an expected value out. */
function BaselineFit() {
  const b = BASELINES.find((x) => x.id === "condenser-heat-rejection")!;
  return (
    <Frame height={230} label="A baseline: drivers in, frozen constants, expected value out"
           caption="constants fitted once on commissioning data, then frozen">
      {b.drivers.map((d, i) => (
        <g key={d}>
          <text x={0} y={30 + i * 26} className={styles.tickSmall}>{d}</text>
          <line x1={200} y1={24 + i * 26} x2={252} y2={110} className={styles.wire} />
        </g>
      ))}
      <rect x={252} y={92} width={140} height={44} rx={6} className={styles.box} />
      <text x={322} y={112} textAnchor="middle" className={styles.boxLabel}>equation</text>
      <text x={322} y={128} textAnchor="middle" className={styles.boxSub}>constants frozen</text>
      <line x1={392} y1={114} x2={452} y2={114} className={styles.wire} />
      <text x={462} y={110} className={styles.outLabel}>expected</text>
      <text x={462} y={130} className={styles.tickSmall}>{b.targetName}</text>
      <text x={0} y={200} className={styles.tick}>fitted on 21 days · 10 May to 25 June 2037</text>
    </Frame>
  );
}

/** Observed against expected, with the gap between them shaded. That gap is the residual. */
function GapBand() {
  const rows = BASELINE_SERIES.residuals.slice(-160);
  const H = 150;
  if (rows.length < 2) return null;
  const all = [...rows.map((r) => r.observed), ...rows.map((r) => r.expected)];
  const lo = Math.min(...all);
  const range = Math.max(...all) - lo || 1;
  const x = (i: number) => (i / (rows.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / range) * H;
  const line = (key: "observed" | "expected") =>
    rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(" ");
  // Out along expected, back along observed. The enclosed region IS what the next stage
  // consumes, so the picture and the pipeline show the same quantity.
  const band =
    `${line("expected")} ` +
    rows.map((_, i) => {
      const j = rows.length - 1 - i;
      return `L${x(j).toFixed(1)},${y(rows[j]!.observed).toFixed(1)}`;
    }).join(" ") + " Z";
  return (
    <Frame height={196} label="Observed against expected, with the residual shaded"
           caption="the shaded gap is what the next stage consumes">
      <path d={band} className={styles.residualBand} />
      <path d={line("expected")} className={styles.expected} />
      <path d={line("observed")} className={styles.observed} />
      <text x={0} y={178} className={styles.keyExpected}>— what a healthy machine would have done</text>
      <text x={0} y={194} className={styles.keyObserved}>— what it actually did</text>
    </Frame>
  );
}

/** The running total climbing off zero, and where the change is declared. */
function Cusum() {
  const n = 60;
  const H = 140;
  const cross = 40;
  const pts = Array.from({ length: n }, (_, i) => {
    const past = Math.max(0, i - 22);
    const v = past * past * 0.011;
    return { x: (i / (n - 1)) * W, y: H - Math.min(1, v / 5.6) * H };
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <Frame height={200} label="A running total of how far above normal the indicator sits"
           caption="the crossing is when we knew · the last zero is when it started">
      <line x1={0} y1={0} x2={W} y2={0} className={styles.thresholdLine} />
      <text x={W} y={14} textAnchor="end" className={styles.thresholdLabel}>change declared</text>
      <path d={path} className={styles.climbLine} />
      <line x1={pts[22]!.x} y1={0} x2={pts[22]!.x} y2={H} className={styles.markLine} />
      <text x={pts[22]!.x + 8} y={H - 6} className={styles.tickSmall}>onset · 30 May</text>
      <circle cx={pts[cross]!.x} cy={pts[cross]!.y} r={6} className={styles.head} />
      <text x={0} y={H + 34} className={styles.tick}>flat while nothing is wrong — it ignores noise that cancels out</text>
    </Frame>
  );
}

/** The four bands, with this machine's score marked. */
function HealthBands() {
  const value = HEALTH_TODAY.value;
  const bands = [
    { to: 50, label: "critical", cls: styles.bandCritical },
    { to: 70, label: "degraded", cls: styles.bandDegraded },
    { to: 85, label: "watch", cls: styles.bandWatch },
    { to: 100, label: "healthy", cls: styles.bandHealthy },
  ];
  const x = (v: number) => (v / 100) * W;
  return (
    <Frame height={150} label={`Health ${value} of 100`} caption={HEALTH_TODAY.arithmetic}>
      {bands.map((b, i) => {
        const from = i === 0 ? 0 : bands[i - 1]!.to;
        return (
          <g key={b.label}>
            <rect x={x(from)} y={56} width={x(b.to) - x(from)} height={30} className={b.cls} />
            <text x={(x(from) + x(b.to)) / 2} y={108} className={styles.tickSmall} textAnchor="middle">
              {b.label}
            </text>
          </g>
        );
      })}
      <line x1={x(value)} y1={40} x2={x(value)} y2={94} className={styles.needle} />
      <text x={x(value)} y={30} textAnchor="middle" className={styles.needleLabel}>{value} of 100</text>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 6 */

/** p10 to p90 as one band — or, today, the refusal that comes before it. */
function RulFan() {
  const p = PREDICTION;
  const est = p.kind === "refusal" ? p.arrivingEstimate : p;
  if (!est) return null;
  const max = est.p90 * 1.15;
  const x = (d: number) => (d / max) * W;
  return (
    <Frame height={186} label={`Between ${est.p10} and ${est.p90} days, most likely ${est.p50}`}
           caption={p.kind === "refusal" ? "today: refused. this is the estimate two days later" : undefined}>
      {p.kind === "refusal" && (
        <text x={0} y={20} className={styles.refusalNote}>
          today — no answer: {p.reason.slice(0, 70)}
        </text>
      )}
      <rect x={x(est.p10)} y={64} width={x(est.p90) - x(est.p10)} height={38} rx={7} className={styles.fanBand} />
      <line x1={x(est.p50)} y1={54} x2={x(est.p50)} y2={112} className={styles.fanMid} />
      <text x={x(est.p50)} y={46} textAnchor="middle" className={styles.fanLabel}>{est.p50} days</text>
      <text x={x(est.p10)} y={126} textAnchor="middle" className={styles.tickSmall}>{est.p10}</text>
      <text x={x(est.p90)} y={126} textAnchor="middle" className={styles.tickSmall}>{est.p90}</text>
      <text x={0} y={166} className={styles.tick}>days of life left — a band, never a single date</text>
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 7 */

/** What separates a failing instrument from a failing machine. */
function Isolation() {
  const rows = [
    { k: "control", v: "the actuator is not where its command says", note: "tested first — it breaks both other tests" },
    { k: "sensor", v: "one measurement whose bias explains all of it", note: "requires positive evidence" },
    { k: "equipment", v: "every measurement agrees, output still falls", note: "what remains — the correct default" },
    { k: "ambiguous", v: "the suspect could never have been contradicted", note: "a real outcome, not a hedge" },
  ];
  return (
    <Frame height={rows.length * 44 + 20} label="How a fault is classified"
           caption="order is load-bearing — each test assumes the ones above it">
      {rows.map((r, i) => {
        const y = 24 + i * 44;
        return (
          <g key={r.k}>
            <text x={0} y={y} className={styles.fieldKey}>{r.k}</text>
            <text x={110} y={y} className={styles.fieldVal}>{r.v}</text>
            <text x={110} y={y + 17} className={styles.tickSmall}>{r.note}</text>
            <line x1={0} y1={y + 28} x2={W} y2={y + 28} className={styles.gridline} />
          </g>
        );
      })}
    </Frame>
  );
}

/** The root-cause walk, on the one real chain the diagnosis layer produced. */
function CauseChain() {
  const steps = [
    { label: CAUSE_CHAIN.causeAsset, sub: CAUSE_CHAIN.causeTitle, cause: true },
    { label: "chilled water loop", sub: "the medium it degrades", cause: false },
    { label: CAUSE_CHAIN.symptomAsset, sub: CAUSE_CHAIN.symptomTitle, cause: false },
  ];
  return (
    <Frame height={230} label="The root-cause walk across the graph"
           caption={`${CAUSE_CHAIN.hops} hops · upstream, earlier, and a real mechanism`}>
      {steps.map((s, i) => {
        const y = 20 + i * 68;
        return (
          <g key={s.label}>
            <rect x={0} y={y} width={W} height={46} rx={6}
                  className={s.cause ? styles.causeBox : styles.box} />
            <text x={16} y={y + 20} className={s.cause ? styles.causeLabel : styles.boxLabel}>
              {s.label}{s.cause ? "  · the cause" : i === 2 ? "  · the symptom" : ""}
            </text>
            <text x={16} y={y + 37} className={styles.boxSub}>{s.sub}</text>
            {i < steps.length - 1 && (
              <line x1={W / 2} y1={y + 46} x2={W / 2} y2={y + 68} className={styles.edge} />
            )}
          </g>
        );
      })}
    </Frame>
  );
}

/** Acting against waiting, on one shared scale. */
function CostScale() {
  const act = ADVISORY?.effort_usd;
  const wait = ADVISORY?.cost_usd;
  if (act == null || wait == null) return null;
  const max = Math.max(act, wait);
  const rows = [
    { label: "cost of acting", v: act, cls: styles.barAct },
    { label: "cost of waiting", v: wait, cls: styles.barWait },
  ];
  return (
    <Frame height={190} label={`Acting costs ${money(act)}; waiting costs ${money(wait)}`}
           caption="drawn to one shared scale — normalising each separately would destroy the point">
      {rows.map((r, i) => (
        <g key={r.label}>
          <text x={0} y={i * 88 + 22} className={styles.tickSmall}>{r.label}</text>
          <rect x={0} y={i * 88 + 32} width={Math.max(3, (r.v / max) * W)} height={30} rx={5} className={r.cls} />
          <text x={Math.max(3, (r.v / max) * W) + 12} y={i * 88 + 54} className={styles.value}>
            {money(r.v)}
          </text>
        </g>
      ))}
    </Frame>
  );
}

/* ------------------------------------------------------------------------- act 8 */

/** The six numbers, with the bad one left bad. */
function ValidationBars() {
  const bars = [
    { m: METRICS.find((x) => x.id === "recall")!, pct: 76.1 },
    { m: METRICS.find((x) => x.id === "precision")!, pct: 43.7 },
    { m: METRICS.find((x) => x.id === "faultClass")!, pct: 80 },
    { m: METRICS.find((x) => x.id === "rulCoverage")!, pct: 7.7 },
  ];
  return (
    <Frame height={bars.length * 44 + 44} label="Four of the six validation numbers as bars"
           caption="the fourth should be near 80 — it is reported at what it actually is">
      {bars.map((b, i) => {
        const y = 16 + i * 44;
        const bad = b.m.verdict === "bad";
        return (
          <g key={b.m.id}>
            <text x={0} y={y + 4} className={styles.tickSmall}>{b.m.name}</text>
            <rect x={0} y={y + 12} width={(b.pct / 100) * (W - 90)} height={20} rx={4}
                  className={bad ? styles.barBad : b.m.verdict === "mixed" ? styles.barMixed : styles.barOk} />
            <text x={W} y={y + 28} textAnchor="end" className={bad ? styles.valueBad : styles.value}>
              {b.m.value}
            </text>
          </g>
        );
      })}
    </Frame>
  );
}

/* --------------------------------------------------------------------- dispatch */

const DRAWINGS: Record<FigureKind, () => JSX.Element | null> = {
  howToRead: HowToRead,
  sourceFiles: SourceFiles,
  ladder: Ladder,
  blend: Blend,
  scenarioGrid: ScenarioGrid,
  topology: Topology,
  topologyEdges: TopologyEdges,
  cadence: Cadence,
  qualityGate: QualityGate,
  ruleStretch: RuleStretch,
  advisoryCard: AdvisoryCard,
  baselineFit: BaselineFit,
  gapBand: GapBand,
  cusum: Cusum,
  healthBands: HealthBands,
  rulFan: RulFan,
  isolation: Isolation,
  causeChain: CauseChain,
  costScale: CostScale,
  validationBars: ValidationBars,
};

export function Figure({ kind }: { kind: FigureKind }) {
  const Drawing = DRAWINGS[kind];
  return <Drawing />;
}
