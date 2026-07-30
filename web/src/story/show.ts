/**
 * Where in the walkthrough we are, and what one press of the space bar does to it.
 *
 * TWO LEVELS, NOT ONE. A scene is a place the camera stands; a beat is one revelation
 * made while standing there. Scene 12 does not simply say "health is 50" — it puts up the
 * daily median, then the onset test, then the arithmetic, then the badge, and a presenter
 * needs to be able to stop between any two of those and answer a question. Collapsing the
 * two levels into a flat list of steps would work for the reveals but would leave the
 * camera with no idea which of them share a vantage point, and it would move on every
 * press.
 *
 * SO: pressing forward advances the beat. When the beats in a scene run out, and only
 * then, the camera moves. This is the whole reason the show reads as a continuous take
 * rather than as a slide change every three seconds.
 *
 * TAKES A LIST OF BEAT COUNTS, not the scenes themselves. Nothing in here needs to know
 * what a scene contains, and keeping it to numbers means the machine cannot grow an
 * opinion about scene content later.
 *
 * PURE, and deliberately so — no React, no DOM, no time. The presenter's whole path
 * through the show can therefore be walked in a script and checked: that every scene is
 * reachable, that forward and back are exact inverses, and that neither end runs off the
 * edge. A presentation that can get itself into a state with no way forward is a
 * presentation that ends early in front of an audience.
 */

/** Which scene, and how far into it. Both zero-based. */
export interface Spot {
  scene: number;
  beat: number;
}

export const START: Spot = { scene: 0, beat: 0 };

/** Beats in a scene, floored at one — a scene with nothing to reveal still gets shown. */
function beatsIn(beats: readonly number[], scene: number): number {
  return Math.max(1, beats[scene] ?? 1);
}

/** Clamp a spot onto a real scene and a real beat within it. */
export function clampSpot(beats: readonly number[], spot: Spot): Spot {
  if (beats.length === 0) return START;
  const scene = Math.min(Math.max(0, Math.trunc(spot.scene)), beats.length - 1);
  const beat = Math.min(Math.max(0, Math.trunc(spot.beat)), beatsIn(beats, scene) - 1);
  return { scene, beat };
}

/**
 * One press forward.
 *
 * Reveals the next beat, or moves to the next scene when the current one is exhausted.
 * At the very end it returns the spot unchanged rather than wrapping to the start —
 * wrapping would send a presenter who pressed once too often back to the plant diagram
 * with no obvious way to recover, and the last scene is a deliberate resting place.
 */
export function forward(beats: readonly number[], spot: Spot): Spot {
  const here = clampSpot(beats, spot);
  if (here.beat < beatsIn(beats, here.scene) - 1) {
    return { scene: here.scene, beat: here.beat + 1 };
  }
  if (here.scene < beats.length - 1) {
    return { scene: here.scene + 1, beat: 0 };
  }
  return here;
}

/**
 * One press back.
 *
 * Lands on the LAST beat of the previous scene, not its first. Back has to undo exactly
 * what forward did, and what forward did on entering this scene was leave the previous
 * one fully revealed; dropping the presenter at the start of it would silently re-hide
 * three or four facts they had already talked through.
 */
export function back(beats: readonly number[], spot: Spot): Spot {
  const here = clampSpot(beats, spot);
  if (here.beat > 0) return { scene: here.scene, beat: here.beat - 1 };
  if (here.scene > 0) {
    const previous = here.scene - 1;
    return { scene: previous, beat: beatsIn(beats, previous) - 1 };
  }
  return here;
}

/** Jump to the top of a scene. How a deep link and the scene list both arrive. */
export function jumpTo(beats: readonly number[], scene: number): Spot {
  return clampSpot(beats, { scene, beat: 0 });
}

/** Every beat of every scene, added up: how many presses the whole show takes. */
export function totalSteps(beats: readonly number[]): number {
  let sum = 0;
  for (let scene = 0; scene < beats.length; scene += 1) sum += beatsIn(beats, scene);
  return sum;
}

/**
 * How many presses in this spot is, counting from the start.
 *
 * Drives the progress readout in the presenter's heads-up display. How far through the
 * show they are is the one thing a presenter cannot judge from the screen itself, and it
 * is what tells them whether to slow down or move along.
 */
export function stepIndex(beats: readonly number[], spot: Spot): number {
  const here = clampSpot(beats, spot);
  let index = 0;
  for (let scene = 0; scene < here.scene; scene += 1) index += beatsIn(beats, scene);
  return index + here.beat;
}

/** True once a beat has been revealed — the test every scene's own reveals are gated on. */
export function shown(spot: Spot, beat: number): boolean {
  return spot.beat >= beat;
}
