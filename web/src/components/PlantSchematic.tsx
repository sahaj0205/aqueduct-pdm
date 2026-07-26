import { buildSchematic, CLASS_COLOUR, COLOURS } from "../lib/schematic.ts";
import type { AdvisorySummary, AssetSummary } from "../types.ts";
import styles from "./PlantSchematic.module.css";

/**
 * The plant, drawn, with live data on it.
 *
 * Hand-placed SVG rather than a graph layout: eleven components in a topology that will
 * not change, and a solver would rearrange them on every load, which defeats the point
 * of a schematic. An operator learns where the chiller is on this picture.
 *
 * Every colour comes from lib/schematic.ts as a fill or stroke attribute rather than a
 * CSS class, because colour here is data — it is the health score — and because that
 * makes the rendered SVG self-contained enough to be written to a file and checked
 * without a browser, which scripts/verify-schematic.ts does.
 *
 * WHAT THE PICTURE ADDS THAT THE QUEUE CANNOT. The queue is a list, and a list cannot
 * show that the thing at the top and the thing at the bottom are joined by a pipe. Here
 * the chilled water path lights up between the chiller being blamed and the coil showing
 * the symptom, and the two are visibly one fault rather than two rows.
 */
export function PlantSchematic({
  assets,
  advisories,
  zones,
  onSelectAsset,
}: {
  assets: AssetSummary[];
  advisories: AdvisorySummary[];
  zones: string[];
  onSelectAsset?: (assetId: string) => void;
}) {
  const plan = buildSchematic(assets, advisories, zones);

  return (
    <section className={styles.wrap}>
      <div className={styles.head}>
        <h2>Plant schematic</h2>
        <span className={styles.hint}>
          cooling towers → condenser water → chillers → chilled water → coil → supply
          air → zones · boxes coloured by health, faults pinned to the component
        </span>
      </div>

      {plan.chwActive && (
        <div className={styles.alert}>
          <span className={styles.who}>chilled water path active</span> — {plan.chwActive.note}
        </div>
      )}

      <div className={styles.body}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${plan.width} ${plan.height}`}
          width={plan.width}
          height={plan.height}
          role="img"
          aria-label="Plant schematic coloured by equipment health"
        >
          <defs>
            {/* Two arrowheads: one for ordinary flow, one for a path carrying an
                active cross-asset explanation. */}
            <marker
              id="flow"
              markerWidth="7"
              markerHeight="7"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 Z" fill="#3a4655" />
            </marker>
            <marker
              id="flow-lit"
              markerWidth="8"
              markerHeight="8"
              refX="5"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#d95757" />
            </marker>
          </defs>

          {/* ---- edges first, so boxes sit on top of them ---- */}
          {plan.edges.map((edge) => (
            <polyline
              key={edge.id}
              points={edge.points}
              fill="none"
              stroke={edge.lit ? "#d95757" : "#3a4655"}
              strokeWidth={edge.lit ? 2.6 : 1.4}
              strokeDasharray={edge.lit ? "7 4" : undefined}
              markerEnd={edge.lit ? "url(#flow-lit)" : "url(#flow)"}
            />
          ))}
          {plan.edges
            .filter((edge) => edge.label)
            .map((edge) => {
              const [first] = edge.points.split(" ");
              const [x, y] = first!.split(",").map(Number);
              return (
                <text
                  key={`${edge.id}-label`}
                  x={(x ?? 0) + 8}
                  y={(y ?? 0) + 16}
                  fill="#d95757"
                  fontSize="10.5"
                  fontFamily="ui-monospace, monospace"
                >
                  {edge.label}
                </text>
              );
            })}

          {/* ---- boxes ---- */}
          {plan.boxes.map((box) => {
            const colour = COLOURS[box.state];
            const interactive = box.assetId !== null && onSelectAsset !== undefined;
            return (
              <g
                key={box.id}
                className={interactive ? styles.clickable : undefined}
                onClick={
                  interactive ? () => onSelectAsset!(box.assetId!) : undefined
                }
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={box.kind === "loop" ? 13 : 3}
                  fill={colour.fill}
                  stroke={colour.stroke}
                  strokeWidth={box.kind === "loop" ? 1 : 1.6}
                  strokeDasharray={box.kind === "loop" ? "5 4" : undefined}
                />
                <text
                  x={box.x + box.w / 2}
                  y={box.y + (box.kind === "loop" ? 17 : box.kind === "zone" ? 18 : 21)}
                  textAnchor="middle"
                  fill={box.kind === "equipment" ? colour.text : "#8d9bad"}
                  fontSize={box.kind === "equipment" ? 12 : 10.5}
                  fontFamily="system-ui, sans-serif"
                  fontWeight={box.kind === "equipment" ? 600 : 400}
                >
                  {box.label}
                </text>
                {box.sub && box.kind !== "loop" && (
                  <text
                    x={box.x + box.w / 2}
                    y={box.y + (box.kind === "zone" ? 31 : 37)}
                    textAnchor="middle"
                    fill="#8d9bad"
                    fontSize="10"
                    fontFamily="ui-monospace, monospace"
                  >
                    {box.sub}
                  </text>
                )}

                {/* Faults pinned to the component: one dot per open fault class, in the
                    same colour the queue's badge uses, plus the count. A dot rather
                    than a number alone, because the class is what decides which van
                    goes out and it should survive a glance. */}
                {box.advisories > 0 && (
                  <>
                    <circle
                      cx={box.x + box.w - 11}
                      cy={box.y + 11}
                      r={8.5}
                      fill="#d95757"
                      stroke="#10151c"
                      strokeWidth="1.5"
                    />
                    <text
                      x={box.x + box.w - 11}
                      y={box.y + 14.5}
                      textAnchor="middle"
                      fill="#10151c"
                      fontSize="10.5"
                      fontWeight="700"
                      fontFamily="system-ui, sans-serif"
                    >
                      {box.advisories}
                    </text>
                    {box.classes.map((klass, index) => (
                      <circle
                        key={klass}
                        cx={box.x + 10 + index * 9}
                        cy={box.y + box.h - 8}
                        r={3.4}
                        fill={CLASS_COLOUR[klass]}
                      />
                    ))}
                  </>
                )}
              </g>
            );
          })}

          {/* ---- legend ---- */}
          {plan.legend.map((entry, index) => (
            <g key={entry.state} transform={`translate(${12 + index * 132}, ${plan.height - 26})`}>
              <rect
                width="14"
                height="11"
                rx="2"
                fill={COLOURS[entry.state].fill}
                stroke={COLOURS[entry.state].stroke}
              />
              <text x="20" y="10" fill="#8d9bad" fontSize="10.5" fontFamily="system-ui, sans-serif">
                {entry.label}
              </text>
            </g>
          ))}
          <g transform={`translate(${12 + 4 * 132}, ${plan.height - 26})`}>
            <line x1="0" y1="6" x2="16" y2="6" stroke="#d95757" strokeWidth="2.6" strokeDasharray="7 4" />
            <text x="22" y="10" fill="#8d9bad" fontSize="10.5" fontFamily="system-ui, sans-serif">
              cross-asset fault path
            </text>
          </g>
        </svg>
      </div>
    </section>
  );
}
