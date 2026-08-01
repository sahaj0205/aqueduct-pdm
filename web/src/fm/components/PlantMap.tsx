import { useNavigate } from "react-router-dom";

import * as C from "../lib/chartTheme.ts";
import type { Topology, TopoNode } from "../types.ts";
import styles from "./PlantMap.module.css";

const BAND_PAINT: Record<string, { fill: string; stroke: string; text: string }> = {
  healthy: C.NODE.healthy,
  watch: C.NODE.watch,
  degraded: C.NODE.degraded,
  critical: C.NODE.critical,
};

const NODE_W = 19;
const NODE_H = 13;
const ZONE_W = 12;
const ZONE_H = 7.5;

/** Splits a label onto two lines at the nearest word boundary to its midpoint, so a
 *  name like "Condenser Pump 1" fits the box instead of the browser breaking it
 *  mid-word wherever the flex layout happens to squeeze it. */
function wrapLabel(label: string): [string, string | null] {
  if (label.length <= 10) return [label, null];
  const words = label.split(" ");
  if (words.length === 1) return [label, null];
  let bestSplit = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ").length;
    const right = words.slice(i).join(" ").length;
    const diff = Math.abs(left - right);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = i;
    }
  }
  return [words.slice(0, bestSplit).join(" "), words.slice(bestSplit).join(" ")];
}

/**
 * The plant, drawn once. Fixed layout rather than a force-directed graph — eight real
 * assets and five zones is small enough to hand-place, and a hand-placed diagram never
 * jitters between reloads the way a physics-based layout does.
 *
 * Zones and the chilled-water loop are drawn differently from real equipment: they
 * carry no health of their own and are not clickable into an asset page. Demoting a
 * downstream symptom is meant to be spatially obvious here — the cause and the symptom
 * sit on the same drawing, connected by the edge that explains why.
 */
export function PlantMap({ topology }: { topology: Topology }) {
  const navigate = useNavigate();

  const byId = new Map(topology.nodes.map((n) => [n.id, n]));

  return (
    <div className={styles.wrap}>
      <svg className={styles.svg} viewBox="0 0 100 100" role="img" aria-label="Plant topology">
        {topology.edges.map((e, i) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={C.hairlineStrong}
              strokeWidth={0.28}
              strokeOpacity={0.45}
            />
          );
        })}

        {topology.nodes.map((n) => (
          <Node key={n.id} node={n} onSelect={() => navigate(`/fm/assets/${n.id}`)} />
        ))}
      </svg>

      <div className={styles.legend}>
        {(["healthy", "watch", "degraded", "critical"] as const).map((band) => (
          <span key={band} className={styles.legendItem}>
            <span
              className={styles.legendSwatch}
              style={{ background: BAND_PAINT[band]!.fill, border: `1px solid ${BAND_PAINT[band]!.stroke}` }}
            />
            {band[0]!.toUpperCase() + band.slice(1)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Node({ node, onSelect }: { node: TopoNode; onSelect: () => void }) {
  if (node.kind === "Loop") {
    return (
      <g>
        <rect
          x={node.x - 15}
          y={node.y - 1.5}
          width={30}
          height={3}
          rx={1.5}
          fill={C.sunken}
          stroke={C.hairlineStrong}
          strokeWidth={0.3}
        />
        <text x={node.x} y={node.y + 4.5} textAnchor="middle" fontSize={2.6} fill={C.inkFaint} className={styles.label}>
          {node.label}
        </text>
      </g>
    );
  }

  if (node.is_zone) {
    return (
      <g>
        <rect
          x={node.x - ZONE_W / 2}
          y={node.y - ZONE_H / 2}
          width={ZONE_W}
          height={ZONE_H}
          rx={1.5}
          fill={C.paper}
          stroke={C.hairline}
          strokeDasharray="1.2 1"
          strokeWidth={0.35}
        />
        <text x={node.x} y={node.y - 0.6} textAnchor="middle" fontSize={2.5} fill={C.ink} className={styles.label}>
          {node.label}
        </text>
        <text x={node.x} y={node.y + 2.3} textAnchor="middle" fontSize={2.1} fill={C.inkFaint} className={styles.label}>
          {node.occupants} occ.
        </text>
      </g>
    );
  }

  const paint = BAND_PAINT[node.band ?? "healthy"] ?? C.NODE.unknown;
  const [line1, line2] = wrapLabel(node.label);
  const nameY = line2 ? node.y - 3.2 : node.y - 1.8;

  return (
    <g className={styles.node} onClick={onSelect}>
      <rect
        x={node.x - NODE_W / 2}
        y={node.y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={1.5}
        fill={paint.fill}
        stroke={paint.stroke}
        strokeWidth={0.5}
      />
      <text x={node.x} y={nameY} textAnchor="middle" fontSize={2.1} fontWeight={500} fill={paint.text} className={styles.label}>
        {line1}
      </text>
      {line2 && (
        <text x={node.x} y={nameY + 2.5} textAnchor="middle" fontSize={2.1} fontWeight={500} fill={paint.text} className={styles.label}>
          {line2}
        </text>
      )}
      <text x={node.x} y={node.y + 4.2} textAnchor="middle" fontSize={2} fill={paint.text} className={styles.label}>
        {node.health !== null ? `health ${Math.round(node.health)}` : "—"}
      </text>
      {node.open_advisories > 0 && (
        <g>
          <circle cx={node.x + NODE_W / 2 - 1.2} cy={node.y - NODE_H / 2 + 1.2} r={1.6} fill={C.critical} />
          <text
            x={node.x + NODE_W / 2 - 1.2}
            y={node.y - NODE_H / 2 + 1.7}
            textAnchor="middle"
            fontSize={1.9}
            fill={C.onFill}
            className={styles.label}
          >
            {node.open_advisories}
          </text>
        </g>
      )}
    </g>
  );
}
