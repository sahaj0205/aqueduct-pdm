/**
 * What stands in a scene's box until the scene itself is built.
 *
 * IT DRAWS THE BOX IT WAS GIVEN, at full world size, which is the only thing that makes
 * it useful rather than decorative. The framing of every scene in the show is derived
 * from these rectangles, so seeing the actual rectangle on screen — and seeing that the
 * camera has fitted it with an even margin all round — is how the camera gets checked by
 * eye before there is any content to judge it against.
 *
 * It also lists the scene's reveals and lights the ones that have been shown, so the beat
 * machine is visible at this checkpoint too: three presses light three lines, and the
 * fourth press is the one that moves the camera.
 *
 * Marked as a placeholder in the corner on purpose. A neutral grey frame with real type in
 * it is exactly the kind of thing that gets mistaken for finished work in a screenshot.
 */

import type { Scene } from "./scenes.ts";
import styles from "./Placeholder.module.css";

export function Placeholder({
  scene,
  index,
  beat,
  current,
}: {
  scene: Scene;
  index: number;
  beat: number;
  /** Whether the camera is standing here. Off-camera scenes are dimmed, not hidden. */
  current: boolean;
}) {
  return (
    <div className={`${styles.frame} ${current ? styles.current : styles.away}`}>
      <div className={styles.corner}>placeholder</div>

      <div className={styles.head}>
        <div className={styles.meta}>
          <span className={styles.num}>{String(index + 1).padStart(2, "0")}</span>
          <span className={styles.act}>act {scene.act}</span>
          {scene.module && <span className={styles.module}>{scene.module}</span>}
        </div>
        <h2 className={styles.title}>{scene.title}</h2>
      </div>

      <ol className={styles.reveals}>
        {scene.reveals.map((label, at) => (
          <li
            key={label}
            className={current && beat >= at ? styles.lit : styles.unlit}
            aria-hidden={current && beat >= at ? undefined : true}
          >
            {label}
          </li>
        ))}
      </ol>

      <div className={styles.coords}>
        {scene.box.w} &times; {scene.box.h} at {scene.box.x}, {scene.box.y}
      </div>
    </div>
  );
}
