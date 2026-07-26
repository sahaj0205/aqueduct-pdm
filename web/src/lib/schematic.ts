/**
 * The plant schematic as data: where each component sits, and what colour it is.
 *
 * Pure, and holding every number the drawing uses — coordinates, colours, whether the
 * chilled water path is lit. Two reasons for that rather than computing in JSX. It
 * keeps the component to shapes and text, and it means the schematic can be rendered
 * and checked outside a browser: an SVG is text, so scripts/verify-schematic.ts renders
 * the real component to markup, asserts the structure and writes the file out.
 *
 * COLOUR IS DATA HERE, NOT DECORATION, so it lives in fill and stroke attributes
 * computed from health rather than in a CSS class. That also makes the rendered SVG
 * self-contained and viewable on its own, which a class-styled one would not be.
 *
 * THE FOUR STATES a component can be in:
 *   unknown    never scored — grey. Most of this plant, because the LBNL chiller file
 *              carries no readings for the third chiller or the cooling towers.
 *   healthy    health at or above 70 — green.
 *   degrading  40 to 69 — amber.
 *   critical   below 40 — red.
 * The two thresholds are presentational and nothing branches on them; see
 * lib/format.ts, which owns them so the queue and the schematic cannot disagree.
 */

import type { AdvisorySummary, AssetSummary, FaultClass } from "../types.ts";
import { healthBand } from "./format.ts";

export const COLOURS = {
  unknown: { fill: "#1e2833", stroke: "#3a4655", text: "#8d9bad" },
  healthy: { fill: "#16302a", stroke: "#3fb27f", text: "#8fd9bb" },
  degrading: { fill: "#332a17", stroke: "#d9a13b", text: "#e8c583" },
  critical: { fill: "#33191c", stroke: "#d95757", text: "#f0a0a0" },
} as const;

export type NodeState = keyof typeof COLOURS;

export const CLASS_COLOUR: Record<FaultClass, string> = {
  sensor: "#4f9ad8",
  equipment: "#d97a3b",
  control: "#9b6fd4",
  ambiguous: "#7d8794",
};

export interface Box {
  id: string;
  /** The database asset this box stands for, or null for a loop or a zone. */
  assetId: string | null;
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: NodeState;
  health: number | null;
  advisories: number;
  /** Fault classes open on this component, for the pinned markers. */
  classes: FaultClass[];
  kind: "equipment" | "loop" | "zone";
}

export interface Schematic {
  width: number;
  height: number;
  boxes: Box[];
  /** Polylines between boxes, as flattened point pairs. */
  edges: { id: string; points: string; lit: boolean; label?: string }[];
  /**
   * Set when cross-asset reasoning has attributed an air-side symptom to a chiller,
   * which is precisely when the chilled water path stops being plumbing and becomes
   * the explanation. Carries the sentence to print beside the lit path.
   */
  chwActive: { cause: string; symptom: string; note: string } | null;
  legend: { state: NodeState; label: string }[];
}

/* Layout. Hand-placed rather than produced by a graph layout engine: this plant has
   eleven components in a fixed topology that will not change, and a solver would
   scatter them differently on every load, which is the opposite of what a schematic is
   for. An operator learns where the chiller is on this picture. */
const W = 780;
const COL = [110, 300, 490, 670];
const ROW = { tower: 40, cdw: 128, chiller: 196, chw: 292, coil: 358, fan: 428, zone: 502 };
const BOX = { w: 132, h: 50 };
const LOOP = { w: 560, h: 26 };

function stateOf(health: number | null): NodeState {
  const band = healthBand(health);
  if (band === "none") return "unknown";
  if (band === "ok") return "healthy";
  if (band === "warn") return "degrading";
  return "critical";
}

/**
 * Build the whole picture from the two lists the dashboard already has.
 *
 * `zones` comes from the downstream graph traversal rather than being hardcoded, so a
 * building with a sixth zone gets a sixth box without an edit here.
 */
export function buildSchematic(
  assets: AssetSummary[],
  advisories: AdvisorySummary[],
  zones: string[],
): Schematic {
  const byId = new Map(assets.map((asset) => [asset.asset_id, asset]));
  const classesFor = (assetId: string): FaultClass[] => [
    ...new Set(
      advisories
        .filter((advisory) => advisory.asset_id === assetId)
        .map((advisory) => advisory.fault_class),
    ),
  ];

  const equipment = (
    assetId: string,
    label: string,
    x: number,
    y: number,
  ): Box => {
    const asset = byId.get(assetId);
    return {
      id: assetId,
      assetId,
      label,
      sub: asset ? `health ${asset.health ?? "n/a"}` : "no data",
      x,
      y,
      w: BOX.w,
      h: BOX.h,
      state: stateOf(asset?.health ?? null),
      health: asset?.health ?? null,
      advisories: asset?.open_advisories ?? 0,
      classes: classesFor(assetId),
      kind: "equipment",
    };
  };

  const loop = (id: string, label: string, y: number): Box => ({
    id,
    assetId: null,
    label,
    sub: "",
    x: COL[0]! - 6,
    y,
    w: LOOP.w,
    h: LOOP.h,
    state: "unknown",
    health: null,
    advisories: 0,
    classes: [],
    kind: "loop",
  });

  const boxes: Box[] = [
    equipment("ct-1", "Cooling tower 1", COL[0]!, ROW.tower),
    equipment("ct-2", "Cooling tower 2", COL[1]!, ROW.tower),
    equipment("ct-3", "Cooling tower 3", COL[2]!, ROW.tower),
    loop("cdw", "condenser water loop", ROW.cdw),
    equipment("chiller-1", "Chiller 1", COL[0]!, ROW.chiller),
    equipment("chiller-2", "Chiller 2", COL[1]!, ROW.chiller),
    equipment("chiller-3", "Chiller 3", COL[2]!, ROW.chiller),
    loop("chw", "chilled water loop", ROW.chw),
    equipment("ahu-1", "AHU-1 cooling coil", COL[1]!, ROW.coil),
    {
      ...equipment("ahu-1", "Supply air fan", COL[1]!, ROW.fan),
      id: "ahu-1-fan",
      sub: "supply air",
    },
  ];

  // Zones are the end of the chain and the only place people are, so they are drawn
  // small and in a row rather than as another machine. Width divides the same span the
  // loops occupy so the picture stays aligned however many there are.
  const zoneW = Math.floor((LOOP.w - (zones.length - 1) * 8) / Math.max(1, zones.length));
  zones.forEach((zone, index) => {
    boxes.push({
      id: zone,
      assetId: null,
      label: zone.replace("_", " "),
      sub: "40 occupants",
      x: COL[0]! - 6 + index * (zoneW + 8),
      y: ROW.zone,
      w: zoneW,
      h: 40,
      state: "unknown",
      health: null,
      advisories: 0,
      classes: [],
      kind: "zone",
    });
  });

  // Is the chilled water path carrying an explanation rather than just water?
  const consequential = advisories.find(
    (advisory) =>
      advisory.consequential &&
      advisory.cause_asset !== null &&
      advisory.cause_asset.startsWith("chiller"),
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

  const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
  const find = (id: string) => boxes.find((box) => box.id === id)!;
  const edges: Schematic["edges"] = [];

  for (const tower of ["ct-1", "ct-2", "ct-3"]) {
    const from = find(tower);
    edges.push({
      id: `${tower}-cdw`,
      points: `${centre(from).x},${from.y + from.h} ${centre(from).x},${ROW.cdw}`,
      lit: false,
    });
  }
  for (const chiller of ["chiller-1", "chiller-2", "chiller-3"]) {
    const to = find(chiller);
    edges.push({
      id: `cdw-${chiller}`,
      points: `${centre(to).x},${ROW.cdw + LOOP.h} ${centre(to).x},${to.y}`,
      lit: false,
    });
    edges.push({
      id: `${chiller}-chw`,
      points: `${centre(to).x},${to.y + to.h} ${centre(to).x},${ROW.chw}`,
      // Only the chiller actually blamed lights up. Lighting all three would say the
      // plant is at fault when the diagnosis named one machine.
      lit: chwActive?.cause === chiller,
    });
  }
  const coil = find("ahu-1");
  const fan = find("ahu-1-fan");
  edges.push({
    id: "chw-coil",
    points: `${centre(coil).x},${ROW.chw + LOOP.h} ${centre(coil).x},${coil.y}`,
    lit: chwActive !== null,
    label: chwActive ? "warm water" : undefined,
  });
  edges.push({
    id: "coil-fan",
    points: `${centre(coil).x},${coil.y + coil.h} ${centre(fan).x},${fan.y}`,
    lit: false,
  });
  for (const zone of zones) {
    const to = find(zone);
    edges.push({
      id: `fan-${zone}`,
      points:
        `${centre(fan).x},${fan.y + fan.h} ${centre(fan).x},${ROW.zone - 16} ` +
        `${centre(to).x},${ROW.zone - 16} ${centre(to).x},${to.y}`,
      lit: false,
    });
  }

  return {
    width: W,
    height: ROW.zone + 40 + 46,
    boxes,
    edges,
    chwActive,
    legend: [
      { state: "healthy", label: "health 70+" },
      { state: "degrading", label: "40–69" },
      { state: "critical", label: "below 40" },
      { state: "unknown", label: "never scored" },
    ],
  };
}
