/**
 * Chiller-1, the one element in the whole walkthrough that physically travels between two
 * scenes rather than being reframed by the camera.
 *
 * WHY THIS EXISTS AS ITS OWN COMPONENT, mounted as a sibling of every scene rather than
 * inside one of them. Both the plant scene and the "pick" scene are permanently mounted at
 * their own fixed world addresses, four hundred world units apart, and neither one is
 * allowed to unmount while the other is shown — that is the whole architecture. So the one
 * piece of content that visibly moves from the first into the second cannot belong to
 * either: it has to be a single element positioned in raw world coordinates, whose
 * position is a CSS transition rather than a camera move.
 *
 * THE CAMERA AND THIS ELEMENT MOVE AT THE SAME TIME BUT ARE NOT THE SAME MECHANISM. The
 * camera eases toward whichever scene's box it has been given, driven by the spring in
 * camera.ts. This element eases its own left/top/width/height via a CSS transition tuned to
 * a similar duration. Watched together they read as one blast — the camera dollying in while
 * the machine explodes out of the drawing — but they are two independent systems that
 * happen to have been tuned to agree, not one system driving both.
 */

import { CHILLER1_EXPLODED, CHILLER1_REST } from "./plantLayout.ts";
import { SNAPSHOT } from "./snapshot.ts";
import styles from "./Chiller1.module.css";

const PARTS = [
  { id: "housing", label: "housing", dx: -140, dy: -80 },
  { id: "condenser", label: "condenser", dx: 140, dy: -60 },
  { id: "compressor", label: "compressor", dx: -120, dy: 100 },
  { id: "instruments", label: `${SNAPSHOT.point.point_id}, and 4 more`, dx: 130, dy: 110 },
] as const;

export function Chiller1({ flown, exploded }: { flown: boolean; exploded: boolean }) {
  const box = flown ? CHILLER1_EXPLODED : CHILLER1_REST;

  return (
    <div
      className={`${styles.chiller} ${exploded ? styles.exploded : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className={styles.label}>{SNAPSHOT.asset.name}</span>
      <span className={styles.id}>{SNAPSHOT.asset.asset_id}</span>

      {PARTS.map((part) => (
        <span
          key={part.id}
          className={styles.part}
          style={{ "--dx": `${part.dx}px`, "--dy": `${part.dy}px` } as React.CSSProperties}
        >
          {part.label}
        </span>
      ))}
    </div>
  );
}
