/**
 * The scene table: every place the camera can stand, and what gets revealed there.
 *
 * THIS FILE IS THE SCRIPT. The order of the list is the order of the show, each entry's
 * `box` is that scene's fixed address in the world, and each entry's `reveals` are the
 * presses it takes to get through it. Nothing else decides any of that — there is no
 * routing table, no separate ordering, no per-scene camera code. Adding a scene is adding
 * a row here and writing the component that draws inside its box.
 *
 * THE BOXES ARE A LAYOUT, NOT A LIST. Because the whole show lives in one coordinate
 * space, where a scene sits relative to the others is meaningful and permanent: the plant
 * is at the origin, the chosen asset's record sits to its right because that is the
 * direction the camera travels to reach it, and later checkpoints put the thirteen
 * pipeline stations on a long run beneath both, so pulling out at the end shows the whole
 * journey as one shape. Two scenes that point at each other should be near enough that a
 * camera framing both can still read them.
 *
 * SCALE IS NOT SET PER SCENE, it falls out of the box. A small box means the camera has to
 * come close; a large one means it has to pull back. That is why scene 3's box is wide
 * enough to hold eight cards in orbit and scene 2's is not — the sense of moving in and
 * out through the show is a consequence of how much each scene actually contains, so it
 * can never disagree with what is on screen.
 *
 * AT THIS CHECKPOINT THERE ARE THREE SCENES AND THEY ARE STUBS. Their titles, boxes and
 * reveal counts are the real ones from the plan; what draws inside them is a placeholder
 * frame. The three were chosen to exercise the camera in every direction it will ever
 * have to move: scene 1 sits near scale 1, scene 2 is small enough to hit the zoom
 * ceiling, and scene 3 is large enough to pull back past scale 0.5.
 */

import type { Box } from "./camera.ts";

/** Which of the three acts a scene belongs to. Shown in the presenter's readout. */
export type Act = 1 | 2 | 3;

export interface Scene {
  /** Stable, short, and URL-safe: this becomes the deep link to the scene. */
  id: string;
  act: Act;
  title: string;
  /**
   * The module of the platform this scene is about, if it is about one — the same labels
   * the pipeline write-up uses, so a viewer who has read that document recognises them.
   * Absent for the scenes that are about the building rather than about the software.
   */
  module?: string;
  /**
   * How often this stage would run in a live deployment. Stages 1 to 7 run every few
   * minutes and stages 8 to 13 once a day, and the show is meant to visibly slow down at
   * that boundary, so the cadence has to be data the presenter's readout can see.
   */
  cadence?: string;
  /** Where the scene lives in world space. Decides the camera framing entirely. */
  box: Box;
  /**
   * One label per press, in order. The count is what the show machine walks; the text is
   * what the presenter's readout shows as coming next, so they can see what the next
   * press does without having to remember the script.
   */
  reveals: readonly string[];
}

export const SCENES: readonly Scene[] = [
  {
    id: "plant",
    act: 1,
    title: "The plant",
    box: { x: 0, y: 0, w: 1240, h: 720 },
    reveals: [
      "the building, wide — two towers, three chillers, one loop, one coil, five zones",
      "107 instruments appear as ticks on the assets",
      "three strike through — defective at source, flagged with a written reason",
    ],
  },
  {
    id: "pick",
    act: 1,
    title: "The pick",
    box: { x: 1640, y: 140, w: 460, h: 420 },
    reveals: [
      "the camera dollies to chiller-1",
      "every other asset desaturates and flies out past the edges",
      "chiller-1 explodes into an exploded view of itself",
    ],
  },
  {
    id: "record",
    act: 1,
    title: "What we already know about this machine",
    box: { x: -520, y: 1120, w: 3080, h: 1680 },
    reveals: [
      "eight cards settle into orbit around the exploded chiller",
      "each flips to show what it holds",
      "none of this was learned from data — it existed before the first reading",
    ],
  },
];

/**
 * Just the beat counts, which is all the show machine takes.
 *
 * Derived rather than written down, so a scene cannot claim a different number of presses
 * than it has reveals to make.
 */
export const BEAT_COUNTS: readonly number[] = SCENES.map((scene) => scene.reveals.length);

/** The scene with this id, and where it sits in the running order. */
export function sceneById(id: string): { scene: Scene; index: number } | null {
  const index = SCENES.findIndex((scene) => scene.id === id);
  const scene = SCENES[index];
  return scene ? { scene, index } : null;
}
