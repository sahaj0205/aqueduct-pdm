/**
 * Check the walkthrough's camera and its beat machine outside a browser.
 *
 * These two pieces decide everything about how the walkthrough behaves and neither is
 * visible in a screenshot. A camera that overshoots, or that zooms unevenly, or that
 * diverges after the presenter's laptop sleeps, and a beat machine that can strand
 * somebody at a dead end, all look fine in a still image and all fail in front of an
 * audience. So they are written as pure arithmetic on plain objects and driven frame by
 * frame here instead.
 *
 *   npm run verify:story        (needs nothing running)
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  MAX_SCALE,
  type Camera,
  type Rig,
  type Viewport,
  cameraOf,
  centreOf,
  fit,
  rigAt,
  settled,
  stepRig,
  union,
  worldToScreen,
} from "../src/story/camera.ts";
import { BEAT_COUNTS, SCENES } from "../src/story/scenes.ts";
import {
  START,
  type Spot,
  back,
  clampSpot,
  forward,
  stepIndex,
  totalSteps,
} from "../src/story/show.ts";
import { Story } from "../src/story/Story.tsx";

const VIEWPORT: Viewport = { w: 1440, h: 900 };
const FPS = 1 / 60;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

/**
 * How far off the target can be before the difference is invisible on a screen, in pixels.
 *
 * Two things are being measured on every move and they are not the same: when the picture
 * stops changing to the eye, and when the animation loop shuts off. The second is
 * necessarily later — the loop holds a sub-pixel tolerance so it never quits mid-drift —
 * and confusing the two would mean either tuning the camera against a number the audience
 * cannot see, or believing a move is slower than it looks.
 */
const INVISIBLE_PX = 2;

/** Run a camera move to completion and report everything worth knowing about the path. */
function fly(from: Camera, to: Camera, frames = 600) {
  let rig: Rig = rigAt(from);
  let count = 0;
  let looksDone = 0;
  let overshoot = 0;
  let maxLockstepError = 0;
  const z0 = Math.log(from.scale);
  const z1 = Math.log(to.scale);

  for (let i = 0; i < frames; i += 1) {
    rig = stepRig(rig, to, FPS);
    count += 1;

    // The first frame an audience could not tell from the last one.
    if (looksDone === 0) {
      const at = cameraOf(rig);
      const offX = Math.abs(rig.x - to.x) * at.scale;
      const offY = Math.abs(rig.y - to.y) * at.scale;
      const offZoom = Math.abs(at.scale - to.scale) / to.scale;
      if (offX < INVISIBLE_PX && offY < INVISIBLE_PX && offZoom < 0.005) looksDone = count;
    }

    // Critically damped means the camera approaches from one side and stops. Any crossing
    // of the target would be the camera visibly changing its mind on a large screen.
    if (to.x !== from.x) {
      const past = from.x < to.x ? rig.x - to.x : to.x - rig.x;
      overshoot = Math.max(overshoot, past);
    }
    if (z1 !== z0) {
      const past = z0 < z1 ? rig.z - z1 : z1 - rig.z;
      overshoot = Math.max(overshoot, past);
    }

    // Every channel is driven by the same law, so the fraction of the journey completed
    // must be identical for panning and for zooming. This is what makes a long pull-out
    // read as one even push rather than as a slow start and a collapse at the end.
    if (to.x !== from.x && z1 !== z0) {
      const fracX = (rig.x - from.x) / (to.x - from.x);
      const fracZ = (rig.z - z0) / (z1 - z0);
      maxLockstepError = Math.max(maxLockstepError, Math.abs(fracX - fracZ));
    }

    if (settled(rig, to)) break;
  }
  return {
    rig,
    frames: count,
    looksDone,
    overshoot,
    maxLockstepError,
    camera: cameraOf(rig),
  };
}

function main() {
  console.log(`\nthe script has ${SCENES.length} scenes and ${totalSteps(BEAT_COUNTS)} presses\n`);
  for (const [index, scene] of SCENES.entries()) {
    const camera = fit(scene.box, VIEWPORT);
    console.log(
      `  ${String(index + 1).padStart(2, "0")}  act ${scene.act}  ` +
        `${String(scene.box.w).padStart(4)}x${String(scene.box.h).padStart(4)} ` +
        `at ${String(scene.box.x).padStart(5)},${String(scene.box.y).padStart(5)}  ` +
        `scale ${camera.scale.toFixed(3)}  ${scene.reveals.length} beats  ${scene.title}`,
    );
  }

  console.log("\nevery scene is framed, centred, and entirely on screen");
  for (const scene of SCENES) {
    const camera = fit(scene.box, VIEWPORT);
    const middle = worldToScreen(camera, VIEWPORT, centreOf(scene.box));
    check(
      `${scene.id} sits in the middle of the viewport`,
      Math.abs(middle.x - VIEWPORT.w / 2) < 0.001 && Math.abs(middle.y - VIEWPORT.h / 2) < 0.001,
      `${middle.x.toFixed(1)}, ${middle.y.toFixed(1)}`,
    );
    const topLeft = worldToScreen(camera, VIEWPORT, { x: scene.box.x, y: scene.box.y });
    const bottomRight = worldToScreen(camera, VIEWPORT, {
      x: scene.box.x + scene.box.w,
      y: scene.box.y + scene.box.h,
    });
    check(
      `${scene.id} is not cropped by any edge`,
      topLeft.x >= -0.001 &&
        topLeft.y >= -0.001 &&
        bottomRight.x <= VIEWPORT.w + 0.001 &&
        bottomRight.y <= VIEWPORT.h + 0.001,
      `${Math.round(bottomRight.x - topLeft.x)}x${Math.round(bottomRight.y - topLeft.y)} px on screen`,
    );
  }

  console.log("\nscale falls out of how much a scene contains");
  const plant = fit(SCENES[0]!.box, VIEWPORT);
  const pick = fit(SCENES[1]!.box, VIEWPORT);
  const record = fit(SCENES[2]!.box, VIEWPORT);
  check(
    "the small scene is closer than the wide one",
    pick.scale > plant.scale && plant.scale > record.scale,
    `${pick.scale.toFixed(3)} > ${plant.scale.toFixed(3)} > ${record.scale.toFixed(3)}`,
  );
  check("the small scene is held at the zoom ceiling", pick.scale === MAX_SCALE, `${MAX_SCALE}`);
  check(
    "the widest scene pulls back past half size",
    record.scale < 0.5,
    record.scale.toFixed(3),
  );
  check(
    "a zero-sized viewport does not produce an infinite scale",
    Number.isFinite(fit(SCENES[0]!.box, { w: 0, h: 0 }).scale),
    fit(SCENES[0]!.box, { w: 0, h: 0 }).scale.toFixed(3),
  );

  console.log("\nthe long move: plant to the widest scene, panning and zooming at once");
  const out = fly(plant, record);
  check(
    "arrives",
    settled(out.rig, record),
    `${out.frames} frames, ${(out.frames * FPS).toFixed(2)}s`,
  );
  check(
    `looks finished — within ${INVISIBLE_PX}px — inside a second`,
    out.looksDone * FPS < 1.0,
    `${(out.looksDone * FPS).toFixed(2)}s`,
  );
  check(
    "and the loop shuts off shortly after, rather than spinning",
    out.frames * FPS < 1.6,
    `${(out.frames * FPS).toFixed(2)}s, ${((out.frames - out.looksDone) * FPS).toFixed(2)}s of invisible tail`,
  );
  check("never overshoots", out.overshoot <= 0, out.overshoot.toExponential(2));
  check(
    "pan and zoom stay in lockstep, so the zoom rate is even",
    out.maxLockstepError < 1e-9,
    `worst divergence ${out.maxLockstepError.toExponential(2)}`,
  );
  check(
    "stops within the zoom tolerance it documents",
    Math.abs(out.camera.scale - record.scale) / record.scale < 0.001,
    `${out.camera.scale.toFixed(5)} vs ${record.scale.toFixed(5)}`,
  );
  // What actually ships: the loop's last act is to replace the rig with one sitting on the
  // target, so the final painted frame is the framing the scene asked for rather than a
  // tolerance away from it. Panning is bit-exact. Zoom is not, and cannot be — the rig
  // carries the logarithm of the scale, so landing round-trips through log and exp and
  // comes back a couple of floating-point ulps out. That is 1e-16 of a pixel and the
  // transform is written to five decimal places anyway; it is checked rather than assumed
  // because a drifting scale would compound over a long show.
  const landed = cameraOf(rigAt(record));
  check(
    "and the landing frame is the framing that was asked for",
    landed.x === record.x &&
      landed.y === record.y &&
      Math.abs(landed.scale - record.scale) / record.scale < 1e-12,
    `scale off by ${(Math.abs(landed.scale - record.scale) / record.scale).toExponential(1)}`,
  );

  console.log("\nand back the other way, zooming in");
  const back1 = fly(record, pick);
  check(
    "arrives",
    settled(back1.rig, pick),
    `${back1.frames} frames, looks finished at ${(back1.looksDone * FPS).toFixed(2)}s`,
  );
  check("never overshoots", back1.overshoot <= 0, back1.overshoot.toExponential(2));
  check(
    "the widest move in the show still looks finished inside 1.2s",
    back1.looksDone * FPS < 1.2,
    `${(back1.looksDone * FPS).toFixed(2)}s, a ${(pick.scale / record.scale).toFixed(1)}x zoom`,
  );

  console.log("\nthe presenter's laptop went to sleep mid-move");
  let stalled = rigAt(plant);
  stalled = stepRig(stalled, record, 2.0);
  check(
    "a two-second frame lands the camera rather than throwing it into deep space",
    settled(stalled, record),
    `scale ${Math.exp(stalled.z).toFixed(5)}`,
  );
  check(
    "and nothing is NaN or infinite",
    Number.isFinite(stalled.x) && Number.isFinite(stalled.z) && Number.isFinite(stalled.vx),
  );

  console.log("\nretargeted mid-flight, which is what pressing space twice quickly does");
  let interrupted = rigAt(plant);
  for (let i = 0; i < 10; i += 1) interrupted = stepRig(interrupted, record, FPS);
  const turnedAt = { ...interrupted };
  let turnFrames = 0;
  for (let i = 0; i < 600; i += 1) {
    interrupted = stepRig(interrupted, pick, FPS);
    turnFrames += 1;
    if (settled(interrupted, pick)) break;
  }
  check(
    "ends up at the new target, not the abandoned one",
    settled(interrupted, pick),
    `${turnFrames} frames after the turn`,
  );
  check(
    "it was genuinely still moving when it was retargeted",
    Math.abs(turnedAt.vx) > 1,
    `${turnedAt.vx.toFixed(1)} px/s`,
  );

  console.log("\nturning motion off snaps instead of easing");
  const snapped = rigAt(record);
  check("the snapped camera is immediately settled", settled(snapped, record));
  check(
    "and carries no momentum into the next scene",
    snapped.vx === 0 && snapped.vy === 0 && snapped.vz === 0,
  );

  console.log("\nthe box that holds every scene at once — the final pull-out");
  const all = union(SCENES.map((scene) => scene.box));
  const everything = fit(all, VIEWPORT);
  check(
    "contains every scene",
    SCENES.every(
      (scene) =>
        scene.box.x >= all.x &&
        scene.box.y >= all.y &&
        scene.box.x + scene.box.w <= all.x + all.w &&
        scene.box.y + scene.box.h <= all.y + all.h,
    ),
    `${all.w}x${all.h} at ${all.x},${all.y}`,
  );
  check(
    "and fits on screen at a readable scale",
    everything.scale > 0.1,
    everything.scale.toFixed(3),
  );
  check("an empty list does not throw", union([]).w === 0);

  console.log("\nthe beat machine walks the whole show and comes back");
  const total = totalSteps(BEAT_COUNTS);
  check(
    "presses add up to the reveals written in the script",
    total === SCENES.reduce((sum, scene) => sum + scene.reveals.length, 0),
    `${total}`,
  );

  const path: Spot[] = [START];
  let here = START;
  for (let i = 0; i < total - 1; i += 1) {
    here = forward(BEAT_COUNTS, here);
    path.push(here);
  }
  check(
    `${total - 1} presses reach the last beat of the last scene`,
    here.scene === SCENES.length - 1 && here.beat === SCENES[SCENES.length - 1]!.reveals.length - 1,
    `scene ${here.scene + 1}, beat ${here.beat + 1}`,
  );
  check(
    "every scene is visited on the way",
    new Set(path.map((spot) => spot.scene)).size === SCENES.length,
  );
  check(
    "the step counter agrees with the number of presses at every stop",
    path.every((spot, index) => stepIndex(BEAT_COUNTS, spot) === index),
  );
  check(
    "one press too many at the end changes nothing",
    JSON.stringify(forward(BEAT_COUNTS, here)) === JSON.stringify(here),
  );

  const reverse: Spot[] = [here];
  let there = here;
  for (let i = 0; i < total - 1; i += 1) {
    there = back(BEAT_COUNTS, there);
    reverse.push(there);
  }
  check(
    "going back the same number of times returns to the very start",
    there.scene === 0 && there.beat === 0,
    `scene ${there.scene + 1}, beat ${there.beat + 1}`,
  );
  check(
    "back is the exact reverse of forward, stop for stop",
    JSON.stringify(reverse.slice().reverse()) === JSON.stringify(path),
  );
  check(
    "one press back too many at the start changes nothing",
    JSON.stringify(back(BEAT_COUNTS, START)) === JSON.stringify(START),
  );
  check(
    "stepping back into a scene lands on its last beat, not its first",
    back(BEAT_COUNTS, { scene: 1, beat: 0 }).beat === SCENES[0]!.reveals.length - 1,
    `beat ${back(BEAT_COUNTS, { scene: 1, beat: 0 }).beat + 1} of ${SCENES[0]!.reveals.length}`,
  );
  check(
    "a nonsense spot is pulled onto a real one",
    JSON.stringify(clampSpot(BEAT_COUNTS, { scene: 99, beat: 99 })) ===
      JSON.stringify({
        scene: SCENES.length - 1,
        beat: SCENES[SCENES.length - 1]!.reveals.length - 1,
      }),
  );
  check(
    "and so is a negative one",
    JSON.stringify(clampSpot(BEAT_COUNTS, { scene: -3, beat: -3 })) === JSON.stringify(START),
  );

  console.log("\nevery scene is mounted at once, in one world");
  const markup = renderToStaticMarkup(createElement(Story));
  check(
    "all three scenes are in the rendered tree together",
    SCENES.every((scene) => markup.includes(scene.title)),
  );
  check(
    "each is positioned at its own world coordinates",
    SCENES.every((scene) => markup.includes(`left:${scene.box.x}px`)),
  );
  check(
    "the readout says what the next press will do",
    markup.includes(SCENES[0]!.reveals[1]!),
  );

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
