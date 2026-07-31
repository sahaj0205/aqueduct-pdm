/**
 * The whole journey, drawn small — where we have been, where we are, and what is left.
 *
 * WHY A MAP AND NOT A LIST. The running record began as a column of text, which told you
 * what had been produced but not what shape the thing had. This is drawn from the SAME
 * rectangles the camera flies between, so the panel is a scale drawing of the canvas the
 * audience is actually moving through: the descent down the left through the opening act,
 * then the serpentine of the pipeline, turning at each row. Watching the path fill in is
 * watching the system get built, which a list of table names cannot convey.
 *
 * It costs nothing to keep true. Every coordinate comes from `SCENES`, so a scene moved in
 * the script moves here, and a scene added appears here, with no second layout to maintain.
 */

import { type Box, centreOf, union } from "./camera.ts";
import { SCENES } from "./scenes.ts";
import styles from "./Minimap.module.css";

/** Breathing room around the drawing, in world units, so nothing touches the edge. */
const PAD = 260;

export function Minimap({ current }: { current: number }) {
  // The closing pull-out's rectangle is the union of all the others, so including it would
  // make the map a drawing of one enormous box containing everything.
  const drawn = SCENES.filter((s) => s.id !== "map");
  const bounds = union(drawn.map((s) => s.box));
  const view = {
    x: bounds.x - PAD,
    y: bounds.y - PAD,
    w: bounds.w + PAD * 2,
    h: bounds.h + PAD * 2,
  };

  const centres = drawn.map((s) => centreOf(s.box));
  // The route, in running order. Drawn to the current position only — the path ahead is
  // deliberately not shown, because the shape of what is coming is the thing the walkthrough
  // is revealing and a map that gave it away would spoil its own ending.
  const travelled = centres
    .slice(0, Math.min(current, drawn.length - 1) + 1)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ");

  const box = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });

  return (
    <svg
      className={styles.map}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="img"
      aria-label={`Scene ${current + 1} of ${drawn.length} on the walkthrough's path`}
    >
      {/* Every scene, whether reached or not, so the extent of the journey is visible from
          the first screen — you can see how much there is without being told. */}
      {drawn.map((scene, i) => (
        <rect
          key={scene.id}
          {...box(scene.box)}
          rx={40}
          className={
            i < current ? styles.past : i === current ? styles.now : styles.ahead
          }
        />
      ))}

      {travelled && <path d={travelled} className={styles.route} />}

      {centres[Math.min(current, centres.length - 1)] && (
        <circle
          cx={centres[Math.min(current, centres.length - 1)]!.x}
          cy={centres[Math.min(current, centres.length - 1)]!.y}
          r={110}
          className={styles.here}
        />
      )}
    </svg>
  );
}
