/**
 * The animation loop that drives the camera, and the only part of the walkthrough that
 * touches the DOM every frame.
 *
 * IT DOES NOT GO THROUGH REACT, and that is the point of the file. The obvious
 * implementation holds the camera in state and lets the component re-render each frame,
 * which at sixty frames a second re-runs the whole scene tree — nineteen scenes, the
 * plant schematic, every chart — for a change that is one CSS transform on one element.
 * Instead the loop writes `style.transform` straight onto the world node. React renders
 * scene content when a beat is revealed, which is a few times a minute, and never for
 * camera movement.
 *
 * The consequence worth knowing: the camera position is not React state and cannot be
 * read during render. Nothing needs to. Anything that has to be positioned relative to
 * the world — the line drawn from one scene back to an earlier one, the comet's path —
 * is drawn INSIDE the world element in world coordinates, so the camera transform
 * carries it along for free and no screen-space arithmetic is involved.
 *
 * The loop stops itself when the camera arrives. A settled walkthrough burns no frames
 * while the presenter talks, which on a laptop driving a projector is the difference
 * between a quiet room and an audible fan.
 */

import { useEffect, useRef } from "react";

import {
  type Box,
  type Rig,
  type Viewport,
  cameraOf,
  fit,
  rigAt,
  settled,
  stepRig,
  transformOf,
} from "./camera.ts";

/**
 * The longest frame the spring will integrate in one go, in seconds.
 *
 * Frame times spike for ordinary reasons — a laptop lid closes mid-talk, or the presenter
 * switches windows — and on return the browser reports one enormous interval. The closed
 * form is stable at any timestep, so the honest result of a two-second gap is that the
 * camera is simply already where it was going, which is what an audience returning to the
 * screen should see. This ceiling exists to keep that from being computed off a garbage
 * timestamp rather than to protect the maths.
 */
const MAX_FRAME = 0.25;

/**
 * Attach the camera to a stage and a world element.
 *
 * `target` is the box the camera should be framing right now — normally the current
 * scene's box, and in later checkpoints the union of two boxes while a callback is being
 * pointed at. Change it and the camera eases there from wherever it currently is,
 * including from the middle of a previous move.
 *
 * Returns the two refs to attach: `stage` is the fixed-size window that gets measured,
 * `world` is the single element everything is drawn inside and the one that gets
 * transformed.
 */
export function useCamera(target: Box) {
  const stage = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);

  // All of this is deliberately in refs rather than state: none of it should cause a
  // render, and the animation loop has to read the newest value without being torn down
  // and rebuilt when the target changes mid-flight.
  const rig = useRef<Rig | null>(null);
  const viewport = useRef<Viewport>({ w: 0, h: 0 });
  const aim = useRef<Box>(target);
  const kick = useRef<() => void>(() => {});

  aim.current = target;

  useEffect(() => {
    const stageEl = stage.current;
    const worldEl = world.current;
    if (!stageEl || !worldEl) return;

    // Live object, not a boolean read once: a viewer who turns motion down mid-show gets
    // a camera that stops easing from the next press onward.
    const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

    let frame = 0;
    let last = 0;
    let running = false;

    const paint = () => {
      if (!rig.current) return;
      worldEl.style.transform = transformOf(cameraOf(rig.current), viewport.current);
      // The world is transparent in the stylesheet until the camera has framed something.
      // Without this there is one frame where it sits untransformed at the top-left
      // corner, which on a projector reads as the page having failed to load.
      worldEl.style.opacity = "1";
    };

    const land = (to: ReturnType<typeof fit>) => {
      rig.current = rigAt(to);
      paint();
      running = false;
    };

    const tick = (now: number) => {
      const to = fit(aim.current, viewport.current);
      if (!rig.current) {
        // First frame of the show opens already framed on scene one rather than flying in
        // from the origin, which would read as the page still loading.
        land(to);
        return;
      }
      if (stillness.matches) {
        land(to);
        return;
      }
      const dt = last === 0 ? 1 / 60 : Math.min(MAX_FRAME, (now - last) / 1000);
      last = now;
      rig.current = stepRig(rig.current, to, dt);
      paint();
      if (settled(rig.current, to)) {
        land(to);
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    kick.current = start;

    // The viewport is measured, never assumed. A projector connected mid-presentation
    // changes it, and the framing of every scene depends on it, so a resize re-frames
    // rather than leaving the scene cropped at the old aspect ratio.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      viewport.current = { w: rect.width, h: rect.height };
      start();
    });
    observer.observe(stageEl);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      running = false;
      kick.current = () => {};
    };
  }, []);

  // A new target is a new camera move. The loop is not rebuilt — it reads the target from
  // a ref — so retargeting mid-move curves the path instead of restarting it.
  useEffect(() => {
    kick.current();
  }, [target]);

  return { stage, world };
}
