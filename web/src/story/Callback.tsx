/**
 * The line drawn from a late scene back to the earlier one that justifies it.
 *
 * WHY THIS NEEDS NO SCREEN-SPACE ARITHMETIC AT ALL. Every other kind of pointer between two
 * things on a page has to track where each one currently is on screen, because the page
 * scrolls or the layout reflows. Here both ends are just points in the same world the
 * camera already knows how to transform, so this component draws a plain line between two
 * WORLD coordinates and mounts it once, permanently, as a sibling of every scene inside the
 * transformed canvas. The camera transform that moves the scenes moves this line with them
 * for free.
 *
 * IT DOES NOT DECIDE WHEN TO SHOW ITSELF. `active` is computed in Story.tsx from the same
 * spot that decided the camera should widen to hold both scenes at once — the two are
 * driven by the same condition on purpose, so the line can never appear without the camera
 * having actually pulled back far enough to show what it is pointing at.
 */

import { type Box, centreOf } from "./camera.ts";
import styles from "./Callback.module.css";

/** Generous enough to cover any pair of scenes in this show without being recomputed. */
const SPAN = { x: -2000, y: -1000, w: 14000, h: 10000 };

export function Callback({ from, to, active }: { from: Box; to: Box; active: boolean }) {
  const a = centreOf(from);
  const b = centreOf(to);

  return (
    <svg
      className={`${styles.line} ${active ? styles.active : ""}`}
      style={{ left: SPAN.x, top: SPAN.y, width: SPAN.w, height: SPAN.h }}
      viewBox={`${SPAN.x} ${SPAN.y} ${SPAN.w} ${SPAN.h}`}
      aria-hidden="true"
    >
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      <circle cx={a.x} cy={a.y} r={14} />
      <circle cx={b.x} cy={b.y} r={14} />
    </svg>
  );
}
