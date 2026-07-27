/**
 * Render the twin outside a browser, check it, and write it to a file.
 *
 * Replaces verify-schematic.ts, and exists for the reason that one gave: an SVG is
 * text, which makes this the one visual in the project that can be verified properly
 * rather than described. The real React component is rendered to static markup against
 * the live API, the geometry is asserted, and the result is written to
 * docs/plots/digital_twin.svg where anybody can open it. That file IS the screenshot,
 * and it is reproducible.
 *
 * The checks are the ones a picture of a building can actually get wrong: a node drawn
 * to the left of something that feeds it, two boxes on top of each other, an edge
 * pointing at a node that was not drawn, or a colour claiming knowledge the data does
 * not support.
 *
 *     API=http://127.0.0.1:8000 npm run verify:twin
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DigitalTwin } from "../src/components/DigitalTwin.tsx";
import { buildTwin, columnsOf } from "../src/lib/twin-layout.ts";
import type { AdvisorySummary, TwinState, TwinTopology } from "../src/types.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8000";
// Relative to the working directory, not to this file: the runner bundles this script
// into a temp directory before executing it, so resolving against import.meta.dirname
// wrote to the filesystem root. npm scripts always run in web/.
const OUT = resolve(process.cwd(), "../docs/plots/digital_twin.svg");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return (await response.json()) as T;
}

async function main() {
  let topology: TwinTopology;
  let state: TwinState;
  let advisories: AdvisorySummary[];
  let at: string;
  try {
    // The busiest day in the database, found rather than assumed. The first attempt
    // used the last day of the first run and landed past the END of that run's air-side
    // scenario, so only the chillers were reporting and the picture under test was far
    // emptier than the one a demonstration would show. A drawing should be checked on a
    // day where something is happening.
    const eras = await get<{ eras: { t_from: string; t_to: string }[] }>("/clock/eras");
    let best = { at: eras.eras[0]!.t_to, count: -1 };
    for (const era of eras.eras) {
      for (let d = new Date(era.t_from); d <= new Date(era.t_to); d = new Date(d.getTime() + 7 * 86400000)) {
        const iso = d.toISOString();
        const open = await get<AdvisorySummary[]>(
          `/advisories?status=open&as_of=${encodeURIComponent(iso)}`,
        );
        if (open.length > best.count) best = { at: iso, count: open.length };
      }
    }
    at = best.at;
    [topology, state, advisories] = await Promise.all([
      get<TwinTopology>("/twin/topology"),
      get<TwinState>(`/twin/state?as_of=${encodeURIComponent(at)}`),
      get<AdvisorySummary[]>(`/advisories?status=open&as_of=${encodeURIComponent(at)}`),
    ]);
  } catch (cause) {
    console.error(`cannot reach ${BASE} — start it with \`make api\`. ${cause}`);
    process.exit(2);
  }

  const plan = buildTwin(topology, state, advisories);
  const columns = columnsOf(topology);

  console.log(`\nthe building at ${at.slice(0, 10)}\n`);
  console.log(
    `  ${topology.node_count} nodes in the model, ${plan.boxes.length} drawn, ` +
      `${plan.edges.length} flow edges`,
  );
  console.log(
    `  ${plan.coverage.reporting} readings reporting, ` +
      `${plan.coverage.withBaseline} nodes able to show drift`,
  );

  console.log("\nthe flow reads left to right");
  const feeds = topology.edges.filter((e) => e.relation === "feeds");
  const backwards = feeds.filter((e) => {
    const from = columns.get(e.from_node);
    const to = columns.get(e.to_node);
    return from !== undefined && to !== undefined && from >= to;
  });
  check(
    "no node is drawn at or left of something it feeds",
    backwards.length === 0,
    backwards.map((e) => `${e.from_node}->${e.to_node}`).join(" "),
  );

  const drawn = new Set(plan.boxes.map((b) => b.id));
  const dangling = plan.edges.filter((e) => {
    const [from, to] = e.id.split("->");
    return !drawn.has(from!) || !drawn.has(to!);
  });
  check("every drawn edge joins two drawn nodes", dangling.length === 0);

  console.log("\nnothing overlaps");
  let collisions = 0;
  for (let i = 0; i < plan.boxes.length; i += 1) {
    for (let j = i + 1; j < plan.boxes.length; j += 1) {
      const a = plan.boxes[i]!;
      const b = plan.boxes[j]!;
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        collisions += 1;
      }
    }
  }
  check("no two boxes overlap", collisions === 0, `${collisions} pairs`);
  check(
    "every box is inside the canvas",
    plan.boxes.every(
      (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= plan.width && b.y + b.h <= plan.height,
    ),
  );

  console.log("\ncolour claims only what the data supports");
  const borderedWithoutSigma = plan.boxes.filter((b) => b.drift !== null && b.peakSigma === null);
  check("no node shows drift without a measured sigma", borderedWithoutSigma.length === 0);
  const litWithoutCause = plan.edges.some((e) => e.lit) && plan.chwActive === null;
  check("the chilled water path is lit only when something is blamed on a chiller", !litWithoutCause);
  const scoredWithoutData = plan.boxes.filter(
    (b) => b.condition !== "unknown" && b.health === null && b.rulDays === null,
  );
  check(
    "no node is coloured as scored without a health or a remaining life",
    scoredWithoutData.length === 0,
    scoredWithoutData.map((b) => b.id).join(" "),
  );

  console.log("\nthe chain this project exists to show");
  const path = ["Cooling_Tower_1", "CDW_Loop", "Chiller_1", "CHW_Loop", "Cooling_Coil", "Supply_Air_Fan", "Zone_3"];
  const present = path.filter((id) => drawn.has(id));
  check(`all ${path.length} nodes of tower-to-zone are drawn`, present.length === path.length,
    present.join(" -> "));
  const ascending = path.every((id, i) => i === 0 || (columns.get(id) ?? 0) >= (columns.get(path[i - 1]!) ?? 0));
  check("and they run left to right in order", ascending,
    path.map((id) => `${id}@${columns.get(id)}`).join(" "));

  const markup = renderToStaticMarkup(
    createElement(DigitalTwin, {
      topology,
      state,
      advisories,
      selected: null,
      onSelect: () => {},
    }),
  );
  const svg = markup.slice(markup.indexOf("<svg"), markup.lastIndexOf("</svg>") + 6);
  check("the component rendered an svg", svg.startsWith("<svg"));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${svg}\n`, "utf8");
  console.log(`\nwrote ${OUT} (${svg.length.toLocaleString()} bytes)`);

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
