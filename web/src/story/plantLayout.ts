/**
 * Where each asset sits inside the plant scene, and the two positions chiller-1 occupies
 * before and after it is picked out.
 *
 * ONE COORDINATE SYSTEM, AND THIS IS THE WHOLE POINT OF THE FILE. Every number below is a
 * WORLD coordinate — the same space the camera works in and the same space every scene's
 * box is expressed in. It is not relative to the plant card, and not relative to anything
 * inside it.
 *
 * That matters because two components read these numbers and they render at different
 * levels of the tree: the plant drawing, whose asset boxes are an absolutely positioned
 * layer pinned to the plant scene's own rectangle, and chiller-1, which is mounted as a
 * sibling of every scene so it can fly out of the drawing into the next one. An earlier
 * version had the plant's assets laid out inside the card's normal flex flow while
 * chiller-1 used world coordinates, and the two systems disagreed by exactly the height of
 * the card's heading — so the machine appeared on top of the text instead of in the gap
 * left for it. Both now read from here, and the plant scene's rectangle is anchored at the
 * world origin so that local and world coordinates coincide.
 */

import type { Box } from "./camera.ts";

export interface PlantAsset {
  id: string;
  label: string;
  kind: "tower" | "chiller" | "loop" | "coil" | "zone";
  box: Box;
}

/**
 * The plant scene's rectangle, which every coordinate below sits inside.
 *
 * Anchored at the origin deliberately: it makes world coordinates and coordinates local to
 * the drawing the same numbers, which removes the single arithmetic step where the two
 * systems previously drifted apart. scenes.ts imports this rather than restating it.
 */
/*
 * SIZED SO THE CAMERA STAYS CLOSE. Framing is derived from the rectangle, so a tall card
 * pushes the camera back and shrinks every word on it. At 1400 x 960 this scene framed at
 * 0.83 and its labels rendered below thirteen pixels on a 1440-wide screen. The drawing
 * below is packed tighter so the same content fits a shorter card, which brings the
 * framing back toward 1:1.
 */
export const PLANT_BOX: Box = { x: 0, y: 0, w: 1400, h: 890 };

/**
 * The drawing occupies the LOWER portion of the card; the heading, the question and the
 * revealed lines occupy the upper portion in normal flow above it. 380 is where the text
 * reliably ends once all three lines of this scene are showing.
 */
export const DIAGRAM_TOP = 380;

/**
 * Every asset in the drawing except chiller-1, which flies separately.
 *
 * HEIGHTS ARE SET FROM THE TYPE, NOT PICKED. Each box stacks a 13px label over a 16px name
 * with 8px of padding either side, which needs 57 units before anything else; the flatter
 * boxes were 52 and clipped every name through the middle of its descenders. They are 64
 * now, and the two rows of machines 88, so there is room for the name to sit off the floor
 * of its box rather than against it.
 */
export const PLANT_ASSETS: readonly PlantAsset[] = [
  // Top row: what rejects heat, and what makes cold. Chiller-1's gap is between them.
  { id: "tower-1", label: "Cooling tower 1", kind: "tower", box: { x: 60, y: 405, w: 180, h: 88 } },
  { id: "tower-2", label: "Cooling tower 2", kind: "tower", box: { x: 270, y: 405, w: 180, h: 88 } },
  { id: "chiller-2", label: "Chiller 2", kind: "chiller", box: { x: 740, y: 405, w: 180, h: 88 } },
  { id: "chiller-3", label: "Chiller 3", kind: "chiller", box: { x: 950, y: 405, w: 180, h: 88 } },
  // The loop everything cold travels along, then the coil it feeds, then the rooms.
  { id: "loop", label: "Chilled water loop", kind: "loop", box: { x: 60, y: 520, w: 1070, h: 64 } },
  { id: "coil", label: "Air handler coil", kind: "coil", box: { x: 450, y: 610, w: 300, h: 64 } },
  { id: "zone-1", label: "Zone 1", kind: "zone", box: { x: 60, y: 700, w: 190, h: 64 } },
  { id: "zone-2", label: "Zone 2", kind: "zone", box: { x: 270, y: 700, w: 190, h: 64 } },
  { id: "zone-3", label: "Zone 3", kind: "zone", box: { x: 480, y: 700, w: 190, h: 64 } },
  { id: "zone-4", label: "Zone 4", kind: "zone", box: { x: 690, y: 700, w: 190, h: 64 } },
  { id: "zone-5", label: "Zone 5", kind: "zone", box: { x: 900, y: 700, w: 190, h: 64 } },
];

/** Where the instrument marks sit, beneath the zones. */
export const TICKS_BOX: Box = { x: 60, y: 800, w: 1070, h: 44 };

/** Where chiller-1 sits among the other assets before it is picked out. */
export const CHILLER1_REST: Box = { x: 520, y: 405, w: 190, h: 88 };

/**
 * Where chiller-1 lands, exploded, once it has been picked out.
 *
 * Sits in the RIGHT-HAND HALF of the "pick" scene's rectangle (1600, 180, 1120, 580),
 * leaving the left half for that scene's heading and figures. An earlier version placed it
 * over the whole card, and since the machine is an opaque panel it hid every word the scene
 * was trying to say. If either rectangle moves, both must move together.
 */
export const CHILLER1_EXPLODED: Box = { x: 2220, y: 280, w: 440, h: 380 };

/** How wide the words column is in the "pick" scene, before the machine's half begins. */
export const PICK_WORDS_W = 560;
