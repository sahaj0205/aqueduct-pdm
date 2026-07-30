/**
 * Where each asset sits inside the plant scene, and the two positions chiller-1 occupies
 * before and after it is picked out.
 *
 * WHY THIS IS ITS OWN FILE. Two things need to agree on chiller-1's resting position: the
 * plant drawing, which leaves a gap for it among the other assets, and the flying element
 * in Story.tsx, which starts there and ends at its exploded position inside the "pick"
 * scene. Writing the coordinate twice would let the two drift; this is the one place either
 * of them is allowed to read it from.
 *
 * ALL COORDINATES ARE WORLD COORDINATES, not local to any component. The plant scene's box
 * happens to sit at the world origin (see scenes.ts), so these read as if they were relative
 * to it, but nothing here assumes that — if the plant scene ever moved, only its own box in
 * scenes.ts would need to change, and every asset position below is already expressed in the
 * same space the camera works in.
 */

import type { Box } from "./camera.ts";

export interface PlantAsset {
  id: string;
  label: string;
  kind: "tower" | "chiller" | "loop" | "coil" | "zone";
  box: Box;
}

/** Every asset in the drawing except chiller-1, which flies separately. */
export const PLANT_ASSETS: readonly PlantAsset[] = [
  { id: "tower-1", label: "Cooling tower 1", kind: "tower", box: { x: 40, y: 150, w: 170, h: 130 } },
  { id: "tower-2", label: "Cooling tower 2", kind: "tower", box: { x: 240, y: 150, w: 170, h: 130 } },
  { id: "chiller-2", label: "Chiller 2", kind: "chiller", box: { x: 670, y: 150, w: 160, h: 130 } },
  { id: "chiller-3", label: "Chiller 3", kind: "chiller", box: { x: 860, y: 150, w: 160, h: 130 } },
  { id: "loop", label: "Chilled water loop", kind: "loop", box: { x: 100, y: 320, w: 900, h: 60 } },
  { id: "coil", label: "Air handler coil", kind: "coil", box: { x: 440, y: 410, w: 260, h: 60 } },
  { id: "zone-1", label: "Zone 1", kind: "zone", box: { x: 70, y: 500, w: 170, h: 60 } },
  { id: "zone-2", label: "Zone 2", kind: "zone", box: { x: 270, y: 500, w: 170, h: 60 } },
  { id: "zone-3", label: "Zone 3", kind: "zone", box: { x: 470, y: 500, w: 170, h: 60 } },
  { id: "zone-4", label: "Zone 4", kind: "zone", box: { x: 670, y: 500, w: 170, h: 60 } },
  { id: "zone-5", label: "Zone 5", kind: "zone", box: { x: 870, y: 500, w: 170, h: 60 } },
];

/** Where chiller-1 sits among the other assets before it is picked out. */
export const CHILLER1_REST: Box = { x: 470, y: 150, w: 170, h: 130 };

/** Where chiller-1 lands, exploded, inside the "pick" scene's box (1640,140,460,420). */
export const CHILLER1_EXPLODED: Box = { x: 1660, y: 160, w: 420, h: 380 };
