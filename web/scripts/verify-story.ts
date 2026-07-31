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
import {
  BEAT_COUNTS,
  SCENES,
  callbackActiveAt,
  cameraTargetFor,
  sceneById,
} from "../src/story/scenes.ts";
import {
  START,
  type Spot,
  back,
  clampSpot,
  forward,
  stepIndex,
  totalSteps,
} from "../src/story/show.ts";
import { SNAPSHOT } from "../src/story/snapshot.ts";
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
  /*
   * These used to assert a particular ORDER of scenes by scale, from when one scene was
   * 3080 units wide and framed at under half size. That scene was deliberately shrunk so
   * its type would survive the projector, and the ordering check failed for a fix that was
   * the whole point. What actually matters is the band: every card sits close enough to
   * read and none is magnified into a different design.
   */
  const carded = SCENES.filter((s) => s.id !== "map");
  const scales = carded.map((s) => fit(s.box, VIEWPORT).scale);
  check(
    "every card is framed close enough to read",
    Math.min(...scales) >= 0.6,
    `closest ${Math.max(...scales).toFixed(3)}, furthest ${Math.min(...scales).toFixed(3)}`,
  );
  check(
    "and none is blown up past the ceiling",
    Math.max(...scales) <= MAX_SCALE,
    `${Math.max(...scales).toFixed(3)} of ${MAX_SCALE}`,
  );
  check(
    "the smaller a scene's rectangle, the closer the camera gets",
    pick.scale > plant.scale,
    `${pick.scale.toFixed(3)} > ${plant.scale.toFixed(3)}`,
  );
  // Tests the CEILING ITSELF against a deliberately tiny box, rather than asserting that
  // some particular scene happens to be small. It used to name the "pick" scene, which was
  // then widened so the machine flying into it would stop covering its own text — and the
  // check failed for a layout change that was entirely correct.
  check(
    "a scene small enough to be magnified is held at the zoom ceiling",
    fit({ x: 0, y: 0, w: 200, h: 150 }, VIEWPORT).scale === MAX_SCALE,
    `capped at ${MAX_SCALE}`,
  );
  check(
    "the closing pull-out is the only shot that goes wide",
    fit(sceneById("map")!.scene.box, VIEWPORT).scale < 0.5 && Math.min(...scales) >= 0.6,
    `pull-out ${fit(sceneById("map")!.scene.box, VIEWPORT).scale.toFixed(3)} vs nearest card ${Math.min(...scales).toFixed(3)}`,
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
  // Entities are decoded before comparing. React escapes apostrophes and ampersands on the
  // way into markup, so a scene titled "someone else's fever" appears as "else&#x27;s" and a
  // naive substring test would report it missing when it is present and correct.
  const raw = renderToStaticMarkup(createElement(Story));
  const markup = raw
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  // The closing pull-out is deliberately excluded: its rectangle is the union of every
  // other scene's, so it has no card of its own — a panel drawn there would cover the whole
  // canvas. Its words are a screen-space overlay shown only while it is the current scene.
  const cardedScenes = SCENES.filter((scene) => scene.id !== "map");
  const absent = cardedScenes.filter((scene) => !markup.includes(scene.title));
  check(
    `all ${cardedScenes.length} scenes that have a card are in the rendered tree together`,
    absent.length === 0,
    absent.length ? `missing: ${absent.map((s) => s.id).join(", ")}` : `${cardedScenes.length} cards`,
  );
  // Keyed on the pull-out's dimensions, which are unique to it — its ORIGIN is shared with
  // the opening scene, so testing position alone reported a card that was never drawn.
  const mapBox = sceneById("map")!.scene.box;
  check(
    "and the pull-out has no card, so it cannot cover the show it is framing",
    !markup.includes(`width:${mapBox.w}px`),
    `${mapBox.w}x${mapBox.h} would have spanned every other scene`,
  );
  check(
    "each is positioned at its own world coordinates",
    SCENES.every((scene) => markup.includes(`left:${scene.box.x}px`)),
  );
  check(
    "the readout says what the next press will do",
    markup.includes(SCENES[0]!.reveals[1]!),
  );

  console.log("\nthe frozen moment holds together");
  const s = SNAPSHOT;
  console.log(
    `  ${s.asset.name} · ${s.mode.mode_name} · ${s.at} · health ${s.health.value}`,
  );
  check("the history is not empty", s.series.length > 0, `${s.series.length} hourly points`);
  check(
    "the history runs oldest to newest",
    s.series.every((p, i) => i === 0 || p.t >= s.series[i - 1]!.t),
  );
  check(
    "the reading we follow is the newest point in the history",
    s.reading.t === s.series[s.series.length - 1]!.t &&
      s.reading.v === s.series[s.series.length - 1]!.v,
    `${s.reading.v} ${s.point.unit_si} at ${s.reading.t}`,
  );
  check(
    "the reading falls on the moment the walkthrough stands at",
    s.reading.t.slice(0, 10) === s.at,
    `${s.reading.t.slice(0, 10)} vs ${s.at}`,
  );
  check(
    "the health on screen is what the health formula gives",
    Math.round(100 * (1 - s.health.excess / s.indicator.threshold)) === s.health.value,
    s.health.arithmetic,
  );
  check(
    "and the written arithmetic quotes the same two numbers",
    s.health.arithmetic.includes(String(s.health.excess)) &&
      s.health.arithmetic.includes(String(s.indicator.threshold)),
  );
  check(
    "the excess has not yet reached the failure threshold",
    s.health.excess < s.indicator.threshold,
    `${s.health.excess} of ${s.indicator.threshold} ${s.indicator.unit}`,
  );
  check(
    "the threshold carries its written physical justification",
    s.indicator.rationale.length > 120,
    `${s.indicator.rationale.length} characters`,
  );
  check(
    "the fault is one that only ever accumulates",
    s.indicator.process === "gamma",
    s.indicator.process,
  );
  check(
    "the energy penalty per unit is on file",
    s.indicator.penaltyKwPerUnit > 0,
    `${s.indicator.penaltyKwPerUnit} kW per ${s.indicator.unit}`,
  );
  check(
    "every instrument in the building is accounted for",
    s.instruments.total > 0 && s.instruments.unusable >= 0,
    `${s.instruments.total} total, ${s.instruments.unusable} unusable`,
  );
  check(
    "each unusable instrument carries a written reason",
    s.instruments.reasons.length === s.instruments.unusable &&
      s.instruments.reasons.every((r) => typeof r === "string" && r.length > 0),
  );
  check("decline has a recorded start", s.health.onset !== null, s.health.onset ?? "none");
  if (s.prediction.kind === "refusal") {
    check(
      "the refusal carries its reason rather than an empty estimate",
      s.prediction.reason.length > 20,
      s.prediction.reason.slice(0, 60) + "…",
    );
    check(
      "and the walkthrough can show when the answer did arrive",
      s.prediction.arrivingEstimate !== null,
      s.prediction.arrivingEstimate
        ? `p10 ${s.prediction.arrivingEstimate.p10}d · p50 ${s.prediction.arrivingEstimate.p50}d · p90 ${s.prediction.arrivingEstimate.p90}d`
        : "none",
    );
    check(
      "the arriving estimate is ordered low to high",
      !s.prediction.arrivingEstimate ||
        (s.prediction.arrivingEstimate.p10 <= s.prediction.arrivingEstimate.p50 &&
          s.prediction.arrivingEstimate.p50 <= s.prediction.arrivingEstimate.p90),
    );
  } else {
    check("the published estimate is ordered low to high",
      s.prediction.p10 <= s.prediction.p50 && s.prediction.p50 <= s.prediction.p90);
  }
  check(
    "the baseline recorded what it expected against what it saw",
    s.baseline.residuals.length > 0,
    `${s.baseline.residuals.length} rows`,
  );
  check(
    "and every residual really is the gap between those two",
    s.baseline.residuals
      .slice(0, 200)
      .every((r) => Math.abs(r.observed - r.expected - r.residual) < 0.01),
  );

  console.log("\nevery scene's type survives the scale it is framed at");
  /*
   * A scene is drawn at whatever scale the camera needs to fit its rectangle, so the size
   * type ARRIVES at on the projector is the declared size times that scale. A large
   * rectangle is therefore not a neutral choice: it pushes the camera back and shrinks
   * every word on the card. One scene shipped at 2600 wide, which framed at 0.49 and put
   * its body text on screen at about seven pixels.
   *
   * These sizes mirror the story-scoped type scale in Story.module.css. If that file
   * changes, this must change with it — there is no way to read CSS custom properties from
   * here, so the pairing is stated in both places.
   */
  const BODY_PX = 20; // --t-body-lg
  const SMALLEST_PX = 13; // --t-micro-cap, the smallest type any card uses
  const BODY_FLOOR = 15;
  const SMALLEST_FLOOR = 9;

  const typeRows = SCENES.filter((s) => s.id !== "map").map((scene) => {
    const scale = fit(scene.box, VIEWPORT).scale;
    return {
      id: scene.id,
      scale,
      body: BODY_PX * scale,
      smallest: SMALLEST_PX * scale,
    };
  });
  typeRows.sort((a, b) => a.body - b.body);
  for (const row of typeRows.slice(0, 4)) {
    console.log(
      `  ${row.id.padEnd(12)} framed at ${row.scale.toFixed(2)}  body ${row.body.toFixed(1)}px  smallest ${row.smallest.toFixed(1)}px`,
    );
  }
  const tooSmall = typeRows.filter((r) => r.body < BODY_FLOOR);
  check(
    `body text lands at ${BODY_FLOOR}px or better on every card`,
    tooSmall.length === 0,
    tooSmall.length
      ? tooSmall.map((r) => `${r.id} at ${r.body.toFixed(1)}px`).join(", ")
      : `worst is ${typeRows[0]!.id} at ${typeRows[0]!.body.toFixed(1)}px`,
  );
  const microTooSmall = typeRows.filter((r) => r.smallest < SMALLEST_FLOOR);
  check(
    `and the smallest labels stay above ${SMALLEST_FLOOR}px`,
    microTooSmall.length === 0,
    microTooSmall.length
      ? microTooSmall.map((r) => `${r.id} at ${r.smallest.toFixed(1)}px`).join(", ")
      : `worst is ${typeRows[0]!.smallest.toFixed(1)}px`,
  );

  console.log("\nthe words describe the system, not the presentation");
  /*
   * A scene's revealed lines are what the audience READS. They must be facts about the
   * plant and the platform — the thing the walkthrough is explaining — and never
   * descriptions of what the animation is doing. Several scenes originally shipped with
   * stage directions in them ("the camera closes on chiller 1", "every other asset
   * desaturates and leaves the frame"), which tells a facility manager nothing about their
   * building and states the obvious about a picture they can already see.
   */
  const STAGE_DIRECTION =
    /\bcamera\b|desaturat|leaves the frame|draw themselves|greys out|settles? into orbit|the head arrives|pulls? (all the way )?back|zooms? (in|out)|on screen|this (scene|slide)|the walkthrough|scenes ago/i;
  const offenders: string[] = [];
  for (const scene of SCENES) {
    for (const line of scene.reveals) {
      if (STAGE_DIRECTION.test(line)) offenders.push(`${scene.id}: "${line.slice(0, 60)}…"`);
    }
    if (scene.asks && STAGE_DIRECTION.test(scene.asks)) {
      offenders.push(`${scene.id} (asks): "${scene.asks.slice(0, 60)}…"`);
    }
  }
  check(
    "no scene narrates its own animation",
    offenders.length === 0,
    offenders.length ? offenders.join(" | ") : `${SCENES.length} scenes clean`,
  );

  console.log("\nthe handoff between stages only ever runs forwards");
  /*
   * Each stage states what it received and which earlier stage produced it. The walkthrough's
   * central claim about this pipeline is that nothing skips a layer and nothing reaches back
   * up, so a stage citing a LATER stage as its source would be the script contradicting the
   * thing it is arguing. That is checked here rather than trusted.
   */
  const withReads = SCENES.filter((s) => s.reads);
  const badRefs: string[] = [];
  for (const scene of withReads) {
    const here = SCENES.findIndex((s) => s.id === scene.id);
    const source = SCENES.findIndex((s) => s.id === scene.reads!.from);
    if (source < 0) badRefs.push(`${scene.id} cites "${scene.reads!.from}", which is not a scene`);
    else if (source === here) badRefs.push(`${scene.id} cites itself`);
    else if (source > here) badRefs.push(`${scene.id} cites "${scene.reads!.from}", which comes later`);
  }
  check(
    "every stage's input comes from a stage that already happened",
    badRefs.length === 0,
    badRefs.length ? badRefs.join(" | ") : `${withReads.length} stages declare where their input came from`,
  );
  check(
    "every pipeline stage says what it received, so the chain has no silent gaps",
    SCENES.filter((s) => s.act === 2).every((s) => s.reads !== undefined),
    (() => {
      const missing = SCENES.filter((s) => s.act === 2 && !s.reads).map((s) => s.id);
      return missing.length ? `missing: ${missing.join(", ")}` : "all 13 stages";
    })(),
  );

  console.log("\nthe camera travels in an orderly path, scene to scene");
  // A walkthrough is disorienting when consecutive scenes sit far apart on the canvas: the
  // camera lurches, and the audience loses track of where the new thing came from. This
  // measures every hop between consecutive scenes and reports the worst.
  let worstHop = { from: "", to: "", dist: 0 };
  const hops: number[] = [];
  for (let i = 1; i < SCENES.length; i += 1) {
    const a = centreOf(SCENES[i - 1]!.box);
    const b = centreOf(SCENES[i]!.box);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    hops.push(dist);
    // The final scene is the deliberate pull-out that frames everything at once, so its
    // centre legitimately sits far from the last station's.
    if (dist > worstHop.dist && i < SCENES.length - 1) {
      worstHop = { from: SCENES[i - 1]!.id, to: SCENES[i]!.id, dist };
    }
  }
  console.log(
    `  hops: ${hops.map((h) => Math.round(h)).join(" · ")}`,
  );
  check(
    "no hop between consecutive scenes exceeds two station pitches",
    worstHop.dist <= 3400,
    `worst is ${worstHop.from} to ${worstHop.to} at ${Math.round(worstHop.dist)} units`,
  );
  check(
    "act one descends into act two rather than leaping back across the canvas",
    (() => {
      const arrival = sceneById("arrival")!.scene;
      const ingest = sceneById("ingest")!.scene;
      const a = centreOf(arrival.box);
      const b = centreOf(ingest.box);
      // Predominantly a downward move: the vertical change should dominate the horizontal.
      return Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
    })(),
  );
  check(
    "no scene's rectangle starts left of the canvas origin",
    SCENES.every((s) => s.id === "map" || s.box.x >= 0),
    "a negative x used to bleed into the opening shot",
  );
  check(
    "the show ends on the pull-out that frames every other scene",
    SCENES[SCENES.length - 1]!.id === "map",
  );

  console.log("\nthe callback: pointing from the baseline scene back at the record scene");
  const baseline = sceneById("baseline")!.scene;
  const recordScene = sceneById("record")!.scene;

  check(
    "on any ordinary beat the camera target IS the scene's own box, by reference",
    cameraTargetFor(baseline, 0) === baseline.box && cameraTargetFor(baseline, 2) === baseline.box,
  );
  check(
    "callback is active on exactly one beat of the baseline scene",
    SCENES.filter((s) => Array.from({ length: s.reveals.length }, (_, b) => callbackActiveAt(s, b)).some(Boolean))
      .length === 1,
  );
  check(
    "and it is not active on any other scene's beats",
    SCENES.filter((s) => s.id !== "baseline").every(
      (s) => !Array.from({ length: s.reveals.length }, (_, b) => callbackActiveAt(s, b)).some(Boolean),
    ),
  );

  const cbTarget = cameraTargetFor(baseline, 4);
  check(
    "on the callback beat the camera target contains the baseline scene's own box",
    cbTarget.x <= baseline.box.x &&
      cbTarget.y <= baseline.box.y &&
      cbTarget.x + cbTarget.w >= baseline.box.x + baseline.box.w &&
      cbTarget.y + cbTarget.h >= baseline.box.y + baseline.box.h,
  );
  check(
    "and it also contains the record scene's box — the thing being pointed at",
    cbTarget.x <= recordScene.box.x &&
      cbTarget.y <= recordScene.box.y &&
      cbTarget.x + cbTarget.w >= recordScene.box.x + recordScene.box.w &&
      cbTarget.y + cbTarget.h >= recordScene.box.y + recordScene.box.h,
  );
  check(
    "calling it twice returns the identical object — the camera must not restart on re-render",
    cameraTargetFor(baseline, 4) === cameraTargetFor(baseline, 4),
  );
  check(
    "one beat before or after the callback, the target reverts to the scene's own box",
    cameraTargetFor(baseline, 3) === baseline.box && cameraTargetFor(baseline, 5) === baseline.box,
  );

  console.log("\nchiller-1: where it stands relative to being picked out");
  const pickIndex = sceneById("pick")!.index;
  const plantIndex = sceneById("plant")!.index;
  const recordIndex = sceneById("record")!.index;
  check(
    "still at rest while the plant scene has the floor",
    plantIndex < pickIndex,
    `plant is scene ${plantIndex + 1}, pick is scene ${pickIndex + 1}`,
  );
  check(
    "and picked out by the very next scene, with nothing in between",
    pickIndex === plantIndex + 1,
  );
  check(
    "every scene after the pick keeps chiller-1 exploded",
    recordIndex > pickIndex,
  );

  console.log(failures === 0 ? "\nevery property holds\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
