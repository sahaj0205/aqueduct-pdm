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

/**
 * The four parts that fan outward once the machine comes apart.
 *
 * The offsets are kept modest and the labels short on purpose: they have to stay inside
 * the right-hand half of the "pick" scene, and a long label — the full instrument name was
 * tried first — grows past the card's edge and gets clipped.
 */
/** "chiller-1" reads as "Chiller 1", matching the labels on the machines beside it. */
const SHORT_NAME = SNAPSHOT.asset.asset_id
  .replace(/-/g, " ")
  .replace(/^./, (c) => c.toUpperCase());

const PARTS = [
  { id: "housing", label: "housing", dx: -120, dy: -110 },
  { id: "condenser", label: "condenser", dx: 120, dy: -85 },
  { id: "compressor", label: "compressor", dx: -110, dy: 115 },
  // The instrument the walkthrough follows, named without its asset prefix — the prefix is
  // already on the machine it is attached to, two lines above.
  { id: "instrument", label: SNAPSHOT.point.point_id.split(".").pop() ?? "", dx: 115, dy: 120 },
] as const;

export function Chiller1({
  flown,
  exploded,
  retired,
}: {
  flown: boolean;
  exploded: boolean;
  /**
   * True once the story has moved past the scenes that are about the machine itself.
   *
   * It fades rather than staying put. The walkthrough's rule is that scenes never unmount,
   * but this is not a scene — it is a prop that has finished its job, and leaving it lit in
   * Act I's airspace means it hangs at the top edge of later wide shots with no explanation
   * for why it is there.
   */
  retired: boolean;
}) {
  const box = flown ? CHILLER1_EXPLODED : CHILLER1_REST;

  return (
    <div
      className={`${styles.chiller} ${exploded ? styles.exploded : ""} ${retired ? styles.retired : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {/*
        At rest it has to read like the machines either side of it — same kind label, same
        short name — because it IS one of them until it is picked out. Its full name is
        twenty-two characters and wrapped to two lines inside a 190-wide slot, pushing its
        own identifier through the bottom of the box. The long name belongs to the exploded
        state, where there is room for it.
      */}
      <span className={styles.kind}>chiller</span>
      <span className={styles.label}>{exploded ? SNAPSHOT.asset.name : SHORT_NAME}</span>
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
