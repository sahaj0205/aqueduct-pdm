/**
 * The building as a picture: where each node sits, what colour it is, and why.
 *
 * Pure, holding every number the drawing uses, for the same two reasons the schematic
 * it replaces gave: it keeps the component to shapes and text, and it means the picture
 * can be rendered and checked outside a browser. scripts/verify-twin.ts renders the real
 * component to markup, asserts the geometry and writes the SVG out.
 *
 * WHAT CHANGED FROM THE SCHEMATIC. That drawing had eleven hand-placed boxes at DATABASE
 * ASSET level, which is where the air handler is one box. This one draws the semantic
 * model — thirty-one nodes including the coil, the fans, the dampers, both water loops
 * and five occupied rooms — so the chain from a cooling tower on the roof to the people
 * in Zone 3 is visible, and clicking any of it reaches the instruments on that node.
 *
 * COLUMNS ARE COMPUTED, ROWS ARE ORDERED. The schematic argued for hand-placement so
 * that "an operator learns where the chiller is". Thirty-one hand-placed coordinate
 * pairs would break the first time the model gained a node, so the column comes from
 * how far down the flow a node sits — which is deterministic, identical on every load,
 * and is the property that argument actually needs.
 *
 * THREE CHANNELS, THREE DIFFERENT QUESTIONS, and they must not be collapsed:
 *
 *   fill    condition — remaining life if the model will bound one, else health.
 *           The slow-moving fact about the machine.
 *   border  drift — how far this node's readings have moved from what a fitted
 *           baseline expects. The fast-moving symptom. ABSENT on most nodes, because
 *           only six of a hundred and seven readings have a baseline at all.
 *   badge   what kind of fault: sensor, equipment, control. What decides which van
 *           goes out.
 *
 * A node with a green fill and a red border is a machine in good condition doing
 * something odd today. A node with a red fill and no border is one whose condition is
 * known to be bad and whose drift nobody can measure. Those are different situations
 * and one colour could not say both.
 */

import type {
  AdvisorySummary,
  FaultClass,
  TwinNode,
  TwinState,
  TwinTopology,
} from "../types.ts";
import { COLOURS, conditionBand, driftBand } from "./format.ts";
import type { NodeState } from "./format.ts";

export interface TwinBox {
  id: string;
  label: string;
  brickClass: string;
  assetId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fill: condition. Never null — "unknown" is a state, not an absence. */
  condition: NodeState;
  /** Border: drift. Null where no reading on this node has a fitted baseline. */
  drift: NodeState | null;
  health: number | null;
  rulDays: number | null;
  peakSigma: number | null;
  pointCount: number;
  /** Readings on this node that are currently reporting a value. */
  reporting: number;
  classes: FaultClass[];
  advisories: number;
  kind: "equipment" | "loop" | "zone" | "group";
}

export interface TwinEdgeLine {
  id: string;
  points: string;
  lit: boolean;
  label?: string;
}

export interface TwinPicture {
  width: number;
  height: number;
  boxes: TwinBox[];
  edges: TwinEdgeLine[];
  /**
   * Set when cross-asset reasoning has blamed a chiller for an air-side symptom, which
   * is exactly when the chilled water path stops being plumbing and becomes the
   * explanation. Carried over from the schematic because it is the visual payoff of the
   * cross-asset layer and nothing else on the dashboard shows it as a path.
   */
  chwActive: { cause: string; symptom: string; note: string } | null;
  legend: { state: NodeState; label: string }[];
  /** Stated on the drawing, because a mostly-grey picture must say why it is grey. */
  coverage: { withBaseline: number; reporting: number; nodes: number };
}

const BOX = { w: 128, h: 46 };
const GAP = { x: 46, y: 12 };
const PAD = { x: 24, y: 30 };

/** Loops are drawn wide and flat: they are a path, not a machine. */
const LOOP_H = 24;

function kindOf(node: TwinNode): TwinBox["kind"] {
  if (node.brick_class.includes("Loop")) return "loop";
  if (node.brick_class.includes("Zone")) return "zone";
  if (node.points.length === 0 && node.parent === null) return "group";
  return "equipment";
}

/**
 * How far down the flow each node sits.
 *
 * Longest path rather than shortest, so a node never sits to the left of something that
 * feeds it. Then one adjustment: a node that nothing feeds and that feeds exactly one
 * thing is a source — a pump, a cooling tower, a valve — and is placed immediately
 * before what it feeds rather than at the far left. Without that the chilled water pumps
 * land in the same column as the cooling towers, three columns away from the loop they
 * actually push water into, which is a true statement about graph depth and a misleading
 * picture of a building.
 */
export function columnsOf(topology: TwinTopology): Map<string, number> {
  const feeds = topology.edges.filter((e) => e.relation === "feeds");
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of feeds) {
    incoming.set(edge.to_node, [...(incoming.get(edge.to_node) ?? []), edge.from_node]);
    outgoing.set(edge.from_node, [...(outgoing.get(edge.from_node) ?? []), edge.to_node]);
  }

  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    // Cycles cannot occur -- the water loops are modelled in one direction precisely so
    // they cannot -- but a guard costs nothing and a stack overflow in a drawing is a
    // bad way to find out the model changed.
    if (seen.has(id)) return 0;
    const preds = incoming.get(id) ?? [];
    const value = preds.length
      ? Math.max(...preds.map((p) => resolve(p, new Set([...seen, id])) + 1))
      : 0;
    depth.set(id, value);
    return value;
  };
  for (const node of topology.nodes) resolve(node.node_id, new Set());

  // The source adjustment, applied after every depth is known so it reads the final
  // value of whatever it feeds rather than a half-computed one.
  const adjusted = new Map(depth);
  for (const node of topology.nodes) {
    const preds = incoming.get(node.node_id) ?? [];
    const succs = outgoing.get(node.node_id) ?? [];
    if (preds.length === 0 && succs.length === 1) {
      const target = depth.get(succs[0]!) ?? 1;
      adjusted.set(node.node_id, Math.max(0, target - 1));
    }
  }

  // Nodes outside the flow entirely -- the air handler's dampers and return fan, which
  // carry readings but feed nothing in the model -- sit with whatever contains them.
  for (const node of topology.nodes) {
    if (!incoming.has(node.node_id) && !outgoing.has(node.node_id) && node.parent) {
      adjusted.set(node.node_id, adjusted.get(node.parent) ?? 0);
    }
  }
  return adjusted;
}

export function buildTwin(
  topology: TwinTopology,
  state: TwinState | null,
  advisories: AdvisorySummary[],
): TwinPicture {
  const columns = columnsOf(topology);

  // Grouping nodes carry no readings and no flow; they would be empty boxes competing
  // with the machines for attention, so they are not drawn.
  const drawn = topology.nodes.filter((n) => kindOf(n) !== "group");

  const byColumn = new Map<number, TwinNode[]>();
  for (const node of drawn) {
    const column = columns.get(node.node_id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), node]);
  }
  for (const [, nodes] of byColumn) nodes.sort((a, b) => a.node_id.localeCompare(b.node_id));

  const classesFor = (assetId: string | null): FaultClass[] =>
    assetId === null
      ? []
      : [
          ...new Set(
            advisories.filter((a) => a.asset_id === assetId).map((a) => a.fault_class),
          ),
        ];

  const boxes: TwinBox[] = [];
  let withBaseline = 0;
  let reportingTotal = 0;

  const orderedColumns = [...byColumn.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...orderedColumns.map((c) => byColumn.get(c)!.length), 1);

  for (const column of orderedColumns) {
    const nodes = byColumn.get(column)!;
    nodes.forEach((node, row) => {
      const kind = kindOf(node);
      const h = kind === "loop" ? LOOP_H : BOX.h;
      // Columns are centred against the tallest, so the flow reads across the middle of
      // the picture rather than along its top edge.
      const offset = ((tallest - nodes.length) * (BOX.h + GAP.y)) / 2;
      const asset = node.asset_id ? state?.assets[node.asset_id] : undefined;
      const scored = kind === "equipment" ? asset : undefined;

      let peak: number | null = null;
      let reporting = 0;
      for (const point of node.points) {
        const live = point.point_id ? state?.points[point.point_id] : undefined;
        if (live?.value !== undefined && live.value !== null) reporting += 1;
        if (live?.sigma !== undefined && live.sigma !== null) {
          peak = peak === null ? live.sigma : Math.abs(live.sigma) > Math.abs(peak) ? live.sigma : peak;
        }
      }
      if (peak !== null) withBaseline += 1;
      reportingTotal += reporting;

      boxes.push({
        id: node.node_id,
        label: node.label,
        brickClass: node.brick_class,
        assetId: node.asset_id,
        x: PAD.x + column * (BOX.w + GAP.x),
        y: PAD.y + offset + row * (BOX.h + GAP.y),
        w: BOX.w,
        h,
        // CONDITION IS FOR MACHINES ONLY. Every one of the five occupied rooms maps to
        // the same database asset as the air handler that serves them, because that is
        // where their thermometers live -- so colouring by asset would paint five
        // rooms with the air handler's health and claim the rooms were failing. A room
        // is a space, not a machine, and has no condition of its own. The coil, the
        // fans and the dampers DO take the air handler's condition, because they are
        // the parts that machine is made of.
        condition:
          kind === "equipment"
            ? conditionBand(asset?.rul_p50 ?? null, asset?.health ?? null)
            : "unknown",
        drift: driftBand(peak),
        health: scored?.health ?? null,
        rulDays: scored?.rul_p50 ?? null,
        peakSigma: peak,
        pointCount: node.points.length,
        reporting,
        classes: classesFor(node.asset_id),
        advisories: node.asset_id
          ? advisories.filter((a) => a.asset_id === node.asset_id).length
          : 0,
        kind,
      });
    });
  }

  const consequential = advisories.find(
    (a) => a.consequential && a.cause_asset !== null && a.cause_asset.startsWith("chiller"),
  );
  const chwActive = consequential
    ? {
        cause: consequential.cause_asset!,
        symptom: `${consequential.asset_id} / ${consequential.fault_id}`,
        note:
          `${consequential.cause_asset} is held responsible for ` +
          `${consequential.fault_id} at the air handler, across the chilled water ` +
          `loop. That advisory is demoted, not hidden.`,
      }
    : null;

  const at = new Map(boxes.map((b) => [b.id, b]));
  const edges: TwinEdgeLine[] = [];
  for (const edge of topology.edges) {
    if (edge.relation !== "feeds") continue;
    const from = at.get(edge.from_node);
    const to = at.get(edge.to_node);
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mid = (x1 + x2) / 2;
    // Orthogonal rather than straight: a diagram of a building reads as plumbing, and
    // thirty diagonal lines crossing each other reads as a graph theory exercise.
    edges.push({
      id: `${edge.from_node}->${edge.to_node}`,
      points: `${x1},${y1} ${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      lit:
        chwActive !== null &&
        (edge.from_node === "CHW_Loop" ||
          (edge.to_node === "CHW_Loop" && edge.from_node.startsWith("Chiller"))),
      label:
        chwActive !== null && edge.from_node === "CHW_Loop" ? "warm water" : undefined,
    });
  }

  const width = PAD.x * 2 + (orderedColumns.length) * (BOX.w + GAP.x);
  const height = PAD.y * 2 + tallest * (BOX.h + GAP.y);

  return {
    width,
    height,
    boxes,
    edges,
    chwActive,
    legend: [
      { state: "healthy", label: "in condition" },
      { state: "degrading", label: "degrading" },
      { state: "critical", label: "critical" },
      { state: "unknown", label: "not scored" },
    ],
    coverage: {
      withBaseline,
      reporting: reportingTotal,
      nodes: boxes.length,
    },
  };
}

export { COLOURS };
