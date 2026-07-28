import { buildTwin, ENCODINGS } from "../lib/twin-layout.ts";
import type { Encoding } from "../lib/twin-layout.ts";
import type { AdvisorySummary, TwinState, TwinTopology } from "../types.ts";
import * as C from "../design/palette.ts";
import styles from "./DigitalTwin.module.css";

/**
 * The building, drawn from the semantic model, answering one question at a time.
 *
 * Shapes and text only. Every coordinate and every colour comes from lib/twin-layout.ts
 * as a fill or stroke attribute rather than a CSS class, which is what lets
 * scripts/verify-twin.ts render this to a standalone SVG file that opens correctly on
 * its own.
 *
 * It draws the semantic model rather than the eleven database assets those are flattened
 * into — the coil, the fans, the dampers, both water loops and five occupied rooms — so
 * the chain a fault travels along is on the screen rather than implied.
 *
 * WHAT R5 CHANGED. The drawing used to carry four encodings at once: condition as the
 * fill, drift as the border's colour AND its thickness, fault class as a row of coloured
 * dots in the corner, flow as the edges — with a legend covering two of the four, placed
 * underneath the picture. A reader had to be told all of that before the drawing meant
 * anything, and the telling was in eleven-pixel grey below the fold.
 *
 * Now the fill carries whichever single question is being asked, the switch above names
 * the three questions in words rather than in jargon, and the key for the current one
 * sits ABOVE the drawing. Nothing was removed — all three encodings are one click apart,
 * and the inspector still shows every channel at once for a node actually chosen.
 *
 * THE LEGEND SWATCHES ARE DIVS, NOT INLINE SVG, and that is load-bearing rather than a
 * matter of taste. The verification script extracts the drawing by slicing from the
 * FIRST "<svg" in the rendered markup to the last "</svg>". The swatches used to be
 * inline SVG rectangles, which was harmless while the legend sat below the diagram and
 * would have silently truncated the written-out file to one twelve-pixel square now that
 * it sits above.
 */

interface Props {
  topology: TwinTopology;
  state: TwinState | null;
  advisories: AdvisorySummary[];
  selected: string | null;
  onSelect: (nodeId: string | null) => void;
  /**
   * Which question the fill answers. Optional with a default, so the verification script
   * keeps rendering the drawing it always did without being taught about a control that
   * does not exist outside a browser.
   */
  encoding?: Encoding;
  /** Omitted by the verification script, which has nowhere to put a switch. */
  onEncoding?: (next: Encoding) => void;
}

/** Roughly what fits inside a 128px box at the sizes used below. */
const LABEL_MAX = 17;
const METRIC_MAX = 19;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Everything the box stopped printing, as ONE string.
 *
 * Assembled here rather than as a series of expressions inside the <title> element,
 * because an SVG title may only contain a single text node — React warns about it, and a
 * browser given several renders the comment markup between them as visible text inside
 * the tooltip.
 */
function tooltip(box: {
  label: string;
  brickClass: string;
  health: number | null;
  rulDays: number | null;
  peakSigma: number | null;
  reporting: number;
  pointCount: number;
}): string {
  const parts = [`${box.label} · ${box.brickClass}`];
  if (box.health !== null) parts.push(`health ${box.health}`);
  if (box.rulDays !== null) parts.push(`${Math.round(box.rulDays)} days left`);
  if (box.peakSigma !== null) parts.push(`drift ${box.peakSigma.toFixed(2)}σ`);
  parts.push(`${box.reporting}/${box.pointCount} readings reporting`);
  return parts.join(" · ");
}

export function DigitalTwin({
  topology,
  state,
  advisories,
  selected,
  onSelect,
  encoding = "condition",
  onEncoding,
}: Props) {
  const plan = buildTwin(topology, state, advisories, encoding);
  const current = ENCODINGS.find((e) => e.id === encoding) ?? ENCODINGS[0]!;

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.heading}>
          <h2>The building</h2>
          <span className={styles.question}>{current.question}</span>
        </div>

        {onEncoding && (
          <div className={styles.switch} role="group" aria-label="what the colour means">
            {ENCODINGS.map((option) => (
              <button
                key={option.id}
                className={option.id === encoding ? styles.optionOn : styles.option}
                onClick={() => onEncoding(option.id)}
                title={option.question}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* The key comes BEFORE the picture. A reader who meets the drawing first has
          already decided for themselves what the colours mean by the time they reach an
          explanation underneath it. */}
      <div className={styles.legend}>
        {plan.legend.map((entry) => (
          <span key={entry.label} className={styles.key}>
            <span
              className={styles.swatch}
              style={{ background: entry.paint.fill, borderColor: entry.paint.stroke }}
            />
            {entry.label}
          </span>
        ))}
      </div>

      <p className={styles.caveat}>{plan.caveat}</p>

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
                stroke={edge.lit ? C.high : C.hairline}
                strokeWidth={edge.lit ? 2.2 : 1.2}
                strokeDasharray={edge.lit ? "5 3" : undefined}
              />
            ))}
          </g>

          {plan.boxes.map((box) => {
            const isSelected = selected === box.id;
            return (
              <g
                key={box.id}
                className={styles.node}
                onClick={() => onSelect(isSelected ? null : box.id)}
              >
                {/* Everything the box stopped printing, for a reader who wants it
                    without committing to opening the inspector. */}
                <title>{tooltip(box)}</title>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={4}
                  fill={box.paint.fill}
                  stroke={box.paint.stroke}
                  strokeWidth={1.25}
                />
                {isSelected && (
                  <rect
                    x={box.x - 3}
                    y={box.y - 3}
                    width={box.w + 6}
                    height={box.h + 6}
                    rx={6}
                    fill="none"
                    stroke={C.info}
                    strokeWidth={1.6}
                  />
                )}
                <text
                  x={box.x + 9}
                  y={box.y + (box.metric === null ? box.h / 2 + 4 : 19)}
                  fill={box.paint.text}
                  fontSize={12}
                  fontWeight={500}
                >
                  {clip(box.label, LABEL_MAX)}
                </text>
                {box.metric !== null && (
                  <text
                    x={box.x + 9}
                    y={box.y + 35}
                    fill={box.paint.text}
                    fontSize={12}
                    opacity={0.78}
                  >
                    {clip(box.metric, METRIC_MAX)}
                  </text>
                )}
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

      <p className={styles.coverage}>
        {plan.boxes.length} nodes from the semantic model · {plan.coverage.reporting}{" "}
        readings reporting · click any box for the instruments on it
      </p>
    </section>
  );
}
