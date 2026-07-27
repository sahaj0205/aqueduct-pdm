import { buildTwin, COLOURS } from "../lib/twin-layout.ts";
import { CLASS_COLOUR } from "../lib/format.ts";
import type { AdvisorySummary, TwinState, TwinTopology } from "../types.ts";
import styles from "./DigitalTwin.module.css";

/**
 * The building, drawn from the semantic model.
 *
 * Shapes and text only. Every coordinate and every colour comes from lib/twin-layout.ts
 * as a fill or stroke attribute rather than a CSS class, which is what lets
 * scripts/verify-twin.ts render this to a standalone SVG file that opens correctly on
 * its own.
 *
 * Replaces the plant schematic, which drew eleven database assets. This draws the model
 * those assets are flattened from — the coil, the fans, the dampers, both water loops
 * and five occupied rooms — so the chain a fault travels along is on the screen rather
 * than implied.
 */

interface Props {
  topology: TwinTopology;
  state: TwinState | null;
  advisories: AdvisorySummary[];
  selected: string | null;
  onSelect: (nodeId: string | null) => void;
}

export function DigitalTwin({ topology, state, advisories, selected, onSelect }: Props) {
  const plan = buildTwin(topology, state, advisories);

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h2>The building</h2>
        <span className={styles.muted}>
          {plan.boxes.length} nodes from the semantic model ·{" "}
          {plan.coverage.reporting} readings reporting ·{" "}
          <strong>{plan.coverage.withBaseline}</strong> nodes with a fitted baseline
        </span>
      </div>

      {/* The coverage sentence is on the drawing, not in a footnote. A picture where
          most nodes are grey has to say why, or it reads as a broken feed. */}
      <p className={styles.coverage}>
        Fill is condition — remaining life where the model will bound one, otherwise
        health. Border is drift, and only{" "}
        <strong>{plan.coverage.withBaseline} of {plan.boxes.length}</strong> nodes can
        show it: drift needs a fitted baseline, and this building has one for six of its
        hundred and seven readings. A node with no border is one nothing is being
        claimed about, not one that is fine.
      </p>

      <div className={styles.scroll}>
        <svg
          viewBox={`0 0 ${plan.width} ${plan.height}`}
          width={plan.width}
          height={plan.height}
          role="img"
          aria-label="the building as a flow diagram"
        >
          <g>
            {plan.edges.map((edge) => (
              <polyline
                key={edge.id}
                points={edge.points}
                fill="none"
                stroke={edge.lit ? "#d9a13b" : "#2b3644"}
                strokeWidth={edge.lit ? 2.2 : 1.2}
                strokeDasharray={edge.lit ? "5 3" : undefined}
              />
            ))}
          </g>

          {plan.boxes.map((box) => {
            const fill = COLOURS[box.condition];
            const border = box.drift ? COLOURS[box.drift].stroke : fill.stroke;
            const isSelected = selected === box.id;
            return (
              <g
                key={box.id}
                className={styles.node}
                onClick={() => onSelect(isSelected ? null : box.id)}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={3}
                  fill={fill.fill}
                  stroke={border}
                  /* A thick border means drift is being measured here. A thin one is
                     the node's own outline and claims nothing. */
                  strokeWidth={box.drift ? 2.4 : 1}
                />
                {isSelected && (
                  <rect
                    x={box.x - 3}
                    y={box.y - 3}
                    width={box.w + 6}
                    height={box.h + 6}
                    rx={5}
                    fill="none"
                    stroke="#4f9ad8"
                    strokeWidth={1.4}
                  />
                )}
                <text
                  x={box.x + 8}
                  y={box.y + 16}
                  fill={fill.text}
                  fontSize={11}
                  fontWeight={500}
                >
                  {box.label.length > 20 ? `${box.label.slice(0, 19)}…` : box.label}
                </text>
                {box.kind !== "loop" && (
                  <text x={box.x + 8} y={box.y + 30} fill="#8d9bad" fontSize={9.5}>
                    {box.health !== null ? `health ${box.health}` : "not scored"}
                    {box.rulDays !== null && ` · ${Math.round(box.rulDays)}d left`}
                  </text>
                )}
                {box.kind !== "loop" && (
                  <text x={box.x + 8} y={box.y + 41} fill="#63707f" fontSize={9}>
                    {box.reporting}/{box.pointCount} reading
                    {box.pointCount === 1 ? "" : "s"}
                    {box.peakSigma !== null && ` · ${box.peakSigma.toFixed(1)}σ`}
                  </text>
                )}
                {box.classes.map((klass, i) => (
                  <circle
                    key={klass}
                    cx={box.x + box.w - 9 - i * 11}
                    cy={box.y + 9}
                    r={4}
                    fill={CLASS_COLOUR[klass]}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {plan.chwActive && (
        <p className={styles.chw}>
          <strong>Chilled water path lit.</strong> {plan.chwActive.note}
        </p>
      )}

      <div className={styles.legend}>
        {plan.legend.map((entry) => (
          <span key={entry.state} className={styles.key}>
            <svg width={12} height={12}>
              <rect
                width={12}
                height={12}
                rx={2}
                fill={COLOURS[entry.state].fill}
                stroke={COLOURS[entry.state].stroke}
              />
            </svg>
            {entry.label}
          </span>
        ))}
        <span className={styles.key}>
          <svg width={12} height={12}>
            <rect
              width={12}
              height={12}
              rx={2}
              fill="none"
              stroke="#d95757"
              strokeWidth={2.4}
            />
          </svg>
          thick border = drift measured
        </span>
      </div>
    </section>
  );
}
