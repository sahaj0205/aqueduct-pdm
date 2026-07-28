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
 * THREE QUESTIONS, ASKED ONE AT A TIME. This drawing answers three different things:
 *
 *   condition  remaining life if the model will bound one, else health. The slow-moving
 *              fact about the machine.
 *   drift      how far this node's readings have moved from what a fitted baseline
 *              expects. The fast-moving symptom, and ABSENT on most nodes, because only
 *              six of a hundred and seven readings have a baseline at all.
 *   blame      sensor, equipment or control — what decides which van goes out.
 *
 * THEY USED TO BE DRAWN SIMULTANEOUSLY, and that was the mistake this checkpoint
 * corrects. Condition was the fill, drift was the border thickness and colour, blame was
 * a row of coloured dots in the corner, and the direction of flow was the edges — four
 * encodings riding one shape, with a legend for two of them placed underneath the
 * picture. The reasoning was that a green box with a red border says something a single
 * colour cannot, which is true, and irrelevant to a reader who has not been told that
 * borders mean drift and is not going to work it out from a legend they scroll past.
 *
 * So the caller picks one. The fill carries whichever question is being asked, the
 * border is just the node's outline, and the legend for that one encoding sits ABOVE the
 * drawing where it is read before the picture rather than after it. Switching is one
 * click, and the three states are still all reachable — just never at once.
 *
 * `condition`, `drift` and `classes` remain on every box regardless of which encoding is
 * showing, because scripts/verify-twin.ts asserts against them and those assertions are
 * about the data being honest, not about which one is currently painted.
 */

import type {
  AdvisorySummary,
  FaultClass,
  TwinNode,
  TwinState,
  TwinTopology,
} from "../types.ts";
import { CLASS_PAINT } from "../design/palette.ts";
import { COLOURS, conditionBand, driftBand } from "./format.ts";
import type { NodeState } from "./format.ts";

/** Which of the three questions the drawing is currently answering. */
export type Encoding = "condition" | "drift" | "blame";

/** A resolved fill, border and text colour for one box under one encoding. */
export interface Paint {
  fill: string;
  stroke: string;
  text: string;
}

/**
 * The three encodings, each stated as the question it answers rather than as its name.
 *
 * "Drift" is a label; "which readings have moved away from normal today" is something a
 * reader can decide whether they want. The switch above the drawing shows both.
 */
export const ENCODINGS: { id: Encoding; label: string; question: string }[] = [
  {
    id: "condition",
    label: "Condition",
    question: "How much life is left in each machine?",
  },
  {
    id: "drift",
    label: "Drift",
    question: "Which readings have moved away from normal today?",
  },
  {
    id: "blame",
    label: "Blame",
    question: "Where would a technician be sent, and carrying what?",
  },
];

export interface TwinBox {
  id: string;
  label: string;
  brickClass: string;
  assetId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Condition. Never null — "unknown" is a state, not an absence. */
  condition: NodeState;
  /** Drift. Null where no reading on this node has a fitted baseline. */
  drift: NodeState | null;
  /** The colours to actually draw with, resolved for whichever encoding is showing. */
  paint: Paint;
  /**
   * The one figure worth printing inside the box under the current encoding, already
   * formatted. Null on nodes the question does not apply to — a water loop has no
   * condition because it is a path rather than a machine.
   */
  metric: string | null;
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
  /** The key for the encoding currently showing, carrying its own colours. */
  legend: { paint: Paint; label: string }[];
  /**
   * One sentence saying what the current encoding can and cannot see, placed with the
   * legend above the drawing. A mostly-grey picture has to say why it is grey or it
   * reads as a broken feed, and each encoding is grey for a different reason.
   */
  caveat: string;
  /**
   * Stated on the drawing, because a mostly-grey picture must say why it is grey.
   *
   * `pointsWithBaseline` and `pointsTotal` are counted rather than quoted. The paragraph
   * this replaced asserted "six of its hundred and seven readings" as a fixed sentence;
   * checked against the running API it is a hundred and nine readings with four carrying
   * a baseline at the moment under test, so the sentence had been wrong on both numbers
   * for some time and nothing could have caught it.
   */
  coverage: {
    withBaseline: number;
    reporting: number;
    nodes: number;
    pointsWithBaseline: number;
    pointsTotal: number;
  };
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

/** What the box is filled with, for one encoding. Fill is the ONLY channel carrying it. */
function paintFor(
  encoding: Encoding,
  box: {
    kind: TwinBox["kind"];
    condition: NodeState;
    drift: NodeState | null;
    classes: FaultClass[];
  },
): Paint {
  if (encoding === "drift") {
    // Null drift is not "fine", it is "nobody is measuring this here", and it takes the
    // unknown colour for exactly that reason.
    return COLOURS[box.drift ?? "unknown"];
  }
  if (encoding === "blame") {
    // A machine can carry advisories of more than one class. The first is taken rather
    // than blending them, because a blended colour would be a fifth class that means
    // nothing, and the inspector lists all of them anyway.
    const first = box.classes[0];
    return first ? CLASS_PAINT[first] : COLOURS.unknown;
  }
  return COLOURS[box.condition];
}

/** The one figure worth printing inside the box, for one encoding. */
function metricFor(
  encoding: Encoding,
  box: {
    kind: TwinBox["kind"];
    health: number | null;
    rulDays: number | null;
    peakSigma: number | null;
    classes: FaultClass[];
  },
): string | null {
  if (box.kind === "loop") return null; // a path, not a machine — no state of its own

  if (encoding === "drift") {
    if (box.peakSigma !== null) return `${box.peakSigma.toFixed(1)}σ`;
    return "no baseline";
  }
  if (encoding === "blame") {
    if (box.classes.length === 0) return "nothing open";
    return box.classes.join(" + ");
  }
  if (box.kind !== "equipment") return "not a machine";
  // Remaining life is preferred where it exists because "fails in three weeks" is a
  // stronger statement than "scores 61".
  if (box.rulDays !== null) return `${Math.round(box.rulDays)}d left`;
  if (box.health !== null) return `${box.health}/100`;
  return "not scored";
}

/** The key for one encoding, and the honest sentence about what it cannot see. */
function keyFor(
  encoding: Encoding,
  coverage: TwinPicture["coverage"],
): { legend: TwinPicture["legend"]; caveat: string } {
  if (encoding === "drift") {
    return {
      legend: [
        { paint: COLOURS.healthy, label: "within 2σ of normal" },
        { paint: COLOURS.degraded, label: "2σ to 3σ out" },
        { paint: COLOURS.critical, label: "beyond 3σ" },
        { paint: COLOURS.unknown, label: "no fitted baseline" },
      ],
      // Every figure counted from the data in front of it. See the note on `coverage`.
      caveat:
        `Drift needs a baseline fitted from healthy operation, and at this moment ` +
        `${coverage.pointsWithBaseline} of ${coverage.pointsTotal} readings carry one — ` +
        `so ${coverage.withBaseline} of ${coverage.nodes} nodes can say anything at all ` +
        `here. Grey means nothing is being claimed, not that everything is fine.`,
    };
  }
  if (encoding === "blame") {
    return {
      legend: [
        { paint: CLASS_PAINT.sensor, label: "the instrument is wrong" },
        { paint: CLASS_PAINT.equipment, label: "the machine is wrong" },
        { paint: CLASS_PAINT.control, label: "the logic driving them is wrong" },
        { paint: CLASS_PAINT.ambiguous, label: "the evidence cannot separate them" },
        { paint: COLOURS.unknown, label: "nothing open here" },
      ],
      caveat:
        `Which van goes out. An instrument fault needs a calibration kit and a machine ` +
        `fault needs a wrench, and on the same reported symptom the two differ by more ` +
        `than three times in cost. Only machines with an open job are coloured.`,
    };
  }
  return {
    legend: [
      { paint: COLOURS.healthy, label: "in condition" },
      { paint: COLOURS.watch, label: "watch" },
      { paint: COLOURS.degraded, label: "degrading" },
      { paint: COLOURS.critical, label: "critical" },
      { paint: COLOURS.unknown, label: "not scored" },
    ],
    caveat:
      `Coloured by remaining life where the model will bound one, otherwise by health. ` +
      `Rooms and water loops are always grey: a room is a space and a loop is a path, ` +
      `and neither has a condition of its own to report.`,
  };
}

export function buildTwin(
  topology: TwinTopology,
  state: TwinState | null,
  advisories: AdvisorySummary[],
  encoding: Encoding = "condition",
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
  // Counted per READING as well as per node, because "one node can show drift" and "four
  // readings carry a baseline" are different facts and the caveat needs both.
  let pointsWithBaseline = 0;
  let pointsTotal = 0;

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
        pointsTotal += 1;
        const live = point.point_id ? state?.points[point.point_id] : undefined;
        if (live?.value !== undefined && live.value !== null) reporting += 1;
        if (live?.sigma !== undefined && live.sigma !== null) {
          pointsWithBaseline += 1;
          peak = peak === null ? live.sigma : Math.abs(live.sigma) > Math.abs(peak) ? live.sigma : peak;
        }
      }
      if (peak !== null) withBaseline += 1;
      reportingTotal += reporting;

      // Resolved before the box is assembled, because the paint and the printed figure
      // are both functions of these three and of which question is being asked.
      const facts = {
        kind,
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
            : ("unknown" as NodeState),
        drift: driftBand(peak),
        health: scored?.health ?? null,
        rulDays: scored?.rul_p50 ?? null,
        peakSigma: peak,
        classes: classesFor(node.asset_id),
      };

      boxes.push({
        id: node.node_id,
        label: node.label,
        brickClass: node.brick_class,
        assetId: node.asset_id,
        x: PAD.x + column * (BOX.w + GAP.x),
        y: PAD.y + offset + row * (BOX.h + GAP.y),
        w: BOX.w,
        h,
        ...facts,
        paint: paintFor(encoding, facts),
        metric: metricFor(encoding, facts),
        pointCount: node.points.length,
        reporting,
        advisories: node.asset_id
          ? advisories.filter((a) => a.asset_id === node.asset_id).length
          : 0,
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

  const coverage = {
    withBaseline,
    reporting: reportingTotal,
    nodes: boxes.length,
    pointsWithBaseline,
    pointsTotal,
  };
  const { legend, caveat } = keyFor(encoding, coverage);

  return { width, height, boxes, edges, chwActive, legend, caveat, coverage };
}

export { COLOURS };
