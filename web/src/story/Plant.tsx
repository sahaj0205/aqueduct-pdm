/**
 * The plant, drawn — every asset except chiller-1, which is a separate flying element
 * (see Chiller1.tsx) so it can travel from here into the "pick" scene without ever being
 * unmounted and remounted.
 *
 * THE DRAWING IS AN ABSOLUTE LAYER, NOT PART OF THE CARD'S FLOW. Every asset is positioned
 * from the coordinates in plantLayout.ts, which are world coordinates, and the plant
 * scene's own rectangle is anchored at the world origin so those coordinates land exactly
 * where the flying chiller expects the gap to be. Laying the drawing out in the card's
 * normal flex flow instead — which is what an earlier version did — put it below the
 * heading while chiller-1 stayed in world space, and the machine ended up drawn on top of
 * the text rather than in its slot.
 *
 * WHY CHILLER-1 LOOKS MISSING FROM THIS FILE. It is not missing; it is rendered one level
 * up, as a sibling of every scene, precisely so it can outlive this scene.
 */

import { DIAGRAM_TOP, PLANT_ASSETS, TICKS_BOX } from "./plantLayout.ts";
import type { Scene } from "./scenes.ts";
import { SNAPSHOT } from "./snapshot.ts";
import stationStyles from "./Station.module.css";
import styles from "./Plant.module.css";

const KIND_LABEL: Record<string, string> = {
  tower: "tower",
  chiller: "chiller",
  loop: "loop",
  coil: "coil",
  zone: "zone",
};

export function Plant({
  scene,
  index,
  beat,
  current,
  fled,
}: {
  scene: Scene;
  index: number;
  beat: number;
  current: boolean;
  /** True once chiller-1 has been picked out — every other asset leaves the frame. */
  fled: boolean;
}) {
  const total = SNAPSHOT.instruments.total;
  const unusable = SNAPSHOT.instruments.unusable;

  return (
    <section className={`${stationStyles.station} ${current ? stationStyles.current : stationStyles.away}`}>
      {/* The words sit in normal flow in the upper part of the card, and are given a fixed
          amount of room so they can never grow down into the drawing. */}
      <div className={styles.words} style={{ height: DIAGRAM_TOP }}>
        <header className={stationStyles.head}>
          <div className={stationStyles.meta}>
            <span className={stationStyles.num}>{String(index + 1).padStart(2, "0")}</span>
          </div>
          <h2 className={stationStyles.title}>{scene.title}</h2>
          {scene.asks && <p className={stationStyles.asks}>{scene.asks}</p>}
        </header>

        <ol className={stationStyles.reveals}>
          {scene.reveals.map((label, at) => (
            <li key={label} className={current && beat >= at ? stationStyles.lit : stationStyles.unlit}>
              {label}
            </li>
          ))}
        </ol>
      </div>

      {/* The drawing. Absolute, in world coordinates, so it and the flying chiller agree. */}
      <div className={styles.diagram}>
        {PLANT_ASSETS.map((asset) => (
          <div
            key={asset.id}
            className={`${styles.asset} ${styles[asset.kind]} ${fled ? styles.fled : ""}`}
            style={{
              left: asset.box.x, top: asset.box.y, width: asset.box.w, height: asset.box.h,
              // Each asset flees toward a slightly different point away from the centre of
              // the drawing, so the scatter reads as an explosion rather than a slide.
              "--flee-x": `${(asset.box.x + asset.box.w / 2 - 595) * 0.9}px`,
              "--flee-y": `${(asset.box.y + asset.box.h / 2 - 600) * 0.9}px`,
            } as React.CSSProperties}
          >
            <span className={styles.assetKind}>{KIND_LABEL[asset.kind]}</span>
            <span className={styles.assetLabel}>{asset.label}</span>
          </div>
        ))}

        {/* One mark per instrument in the building, the last three struck through: the
            ones already known to be broken before any analysis has run. */}
        <div
          className={`${styles.ticks} ${fled ? styles.fled : ""}`}
          style={{ left: TICKS_BOX.x, top: TICKS_BOX.y, width: TICKS_BOX.w }}
          aria-label={`${total} instruments, ${unusable} of them unusable`}
        >
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={i >= total - unusable ? styles.tickBad : styles.tickOk} />
          ))}
          <span className={styles.ticksNote}>
            {total} instruments &middot; {unusable} defective at source
          </span>
        </div>
      </div>
    </section>
  );
}
