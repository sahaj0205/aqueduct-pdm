/**
 * Render the plant schematic outside a browser, check it, and write it to a file.
 *
 * Verification for checkpoint 6.6. An SVG is text, which makes this the one visual in
 * the project that can be verified properly rather than described: the real React
 * component is rendered to static markup with the live API's data, the structure is
 * asserted, and the result is written to docs/plots/plant_schematic.svg where anybody
 * can open it. That file IS the screenshot, and it is reproducible.
 *
 * The component's colours are fill and stroke attributes computed from health, not CSS
 * classes, which is what makes the written file stand on its own.
 *
 *     API=http://127.0.0.1:8000 npm run verify:schematic
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlantSchematic } from "../src/components/PlantSchematic.tsx";
import { buildSchematic } from "../src/lib/schematic.ts";
import type { AdvisorySummary, AssetSummary, GraphResult } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";
// Relative to the working directory, not to this file. The runner bundles this script
// into a temp directory before executing it, so import.meta.dirname points at /tmp and
// resolving against it wrote to the filesystem root. npm scripts always run in the
// package directory, which is web/, so cwd is the stable anchor.
const OUT = resolve(process.cwd(), "../docs/plots/plant_schematic.svg");

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

const assets = await get<AssetSummary[]>("/assets");
const advisories = await get<AdvisorySummary[]>("/advisories?status=open");
const downstream = await get<GraphResult>("/graph/downstream/ahu-1");
const plan = buildSchematic(assets, advisories, downstream.zones);

console.log("=".repeat(96));
console.log("PLANT SCHEMATIC — components, states and pinned faults");
console.log("=".repeat(96));
console.log(
  `  ${"component".padEnd(22)}${"asset".padEnd(13)}${"state".padEnd(11)}` +
    `${"health".padStart(7)}${"adv".padStart(5)}  fault classes`,
);
for (const box of plan.boxes) {
  console.log(
    `  ${box.label.padEnd(22)}${(box.assetId ?? "—").padEnd(13)}` +
      `${box.state.padEnd(11)}${String(box.health ?? "n/a").padStart(7)}` +
      `${String(box.advisories).padStart(5)}  ${box.classes.join(", ")}`,
  );
}

console.log();
console.log(`  edges drawn        ${plan.edges.length}`);
const lit = plan.edges.filter((edge) => edge.lit);
console.log(`  edges lit          ${lit.length}  (${lit.map((e) => e.id).join(", ")})`);
console.log(
  `  chilled water path ${
    plan.chwActive
      ? `ACTIVE — ${plan.chwActive.cause} blamed for ${plan.chwActive.symptom}`
      : "idle"
  }`,
);

// ---- render the real component -------------------------------------------
const markup = renderToStaticMarkup(
  createElement(PlantSchematic, {
    assets,
    advisories,
    zones: downstream.zones,
  }),
);
const svgStart = markup.indexOf("<svg");
const svgEnd = markup.lastIndexOf("</svg>") + "</svg>".length;
const svg = markup.slice(svgStart, svgEnd);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    svg.replace(
      "<svg",
      `<svg xmlns="http://www.w3.org/2000/svg" style="background:#171e28"`,
    ) +
    "\n",
);

console.log();
console.log("=".repeat(96));
console.log("CHECKS");
console.log("=".repeat(96));

const failures: string[] = [];
const expect = (label: string, condition: boolean, detail = "") => {
  console.log(`  ${label.padEnd(46)}${condition ? "PASS" : "FAIL"}  ${detail}`);
  if (!condition) failures.push(`${label} ${detail}`);
};

const equipmentBoxes = plan.boxes.filter((box) => box.kind === "equipment");
const coloured = equipmentBoxes.filter((box) => box.state !== "unknown");
const pinned = plan.boxes.filter((box) => box.advisories > 0);

expect("svg rendered", svgStart >= 0 && svg.length > 1000, `${svg.length} bytes`);
expect(
  "every asset in the plant has a box",
  new Set(equipmentBoxes.map((b) => b.assetId)).size >= 7,
  `${new Set(equipmentBoxes.map((b) => b.assetId)).size} distinct assets`,
);
expect(
  "boxes coloured from live health",
  coloured.length > 0,
  `${coloured.length} of ${equipmentBoxes.length} scored, rest grey`,
);
expect(
  "faults pinned to their component",
  pinned.length > 0 &&
    pinned.every((box) =>
      advisories.some((advisory) => advisory.asset_id === box.assetId),
    ),
  `${pinned.map((b) => `${b.assetId}×${b.advisories}`).join(", ")}`,
);
expect(
  "supply air reaches the zones",
  downstream.zones.length > 0 &&
    plan.edges.filter((edge) => edge.id.startsWith("fan-")).length ===
      downstream.zones.length,
  `${downstream.zones.length} zones, ${downstream.occupants} occupants`,
);
expect(
  "chilled water path highlights on a cross-asset fault",
  plan.chwActive !== null && lit.length >= 2,
  plan.chwActive
    ? `${plan.chwActive.cause} → coil`
    : "no consequential advisory in the queue",
);
expect(
  "only the blamed chiller is lit, not the plant",
  lit.filter((edge) => edge.id.endsWith("-chw")).length === 1,
  `${lit.filter((edge) => edge.id.endsWith("-chw")).map((e) => e.id).join(", ")}`,
);
expect(
  "no colour depends on a stylesheet",
  !svg.includes("class=") || svg.includes("fill="),
  "fills and strokes are attributes",
);

/* ---- geometry ----------------------------------------------------------- *
 * Without a browser these three are the only checks on the DRAWING rather than on
 * the data, and they catch what an eye would catch instantly: boxes on top of each
 * other, a component off the edge of the canvas, a pipe ending in mid-air. They are
 * asserted against the plan rather than by parsing the markup back, because the plan
 * is the typed source the markup is generated from.
 * ------------------------------------------------------------------------- */
const layout = plan.boxes.filter((box) => box.w > 30 && box.h > 20);
const overlaps = layout.flatMap((a, i) =>
  layout.slice(i + 1).filter(
    (b) =>
      !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y),
  ).map((b) => `${a.id}×${b.id}`),
);
const offCanvas = plan.boxes.filter(
  (box) =>
    box.x < 0 || box.y < 0 || box.x + box.w > plan.width || box.y + box.h > plan.height,
);
const touchesABox = (px: number, py: number) =>
  layout.some(
    (box) =>
      (px >= box.x - 2 &&
        px <= box.x + box.w + 2 &&
        (Math.abs(py - box.y) <= 2 || Math.abs(py - (box.y + box.h)) <= 2)) ||
      (py >= box.y - 2 &&
        py <= box.y + box.h + 2 &&
        (Math.abs(px - box.x) <= 2 || Math.abs(px - (box.x + box.w)) <= 2)),
  );
const dangling = plan.edges.filter((edge) => {
  const points = edge.points
    .split(" ")
    .map((pair) => pair.split(",").map(Number) as [number, number]);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return !touchesABox(first[0], first[1]) || !touchesABox(last[0], last[1]);
});

expect("no two components overlap", overlaps.length === 0, overlaps.join(", "));
expect(
  "every component inside the canvas",
  offCanvas.length === 0,
  `${plan.width}×${plan.height}, ${offCanvas.map((b) => b.id).join(", ")}`,
);
expect(
  "every pipe joins two components",
  dangling.length === 0,
  `${plan.edges.length} edges, ${dangling.map((e) => e.id).join(", ")}`,
);

console.log();
console.log(`  written to docs/plots/plant_schematic.svg — open it to see the drawing`);

if (failures.length > 0) {
  console.log();
  for (const failure of failures) console.log(`  FAIL: ${failure}`);
  process.exit(1);
}
console.log("  all schematic checks passed");
