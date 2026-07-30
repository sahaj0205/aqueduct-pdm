/**
 * The plant, drawn — every asset except chiller-1, which is a separate flying element
 * (see Chiller1.tsx) so it can travel from here into the "pick" scene without being
 * unmounted and remounted.
 *
 * WHY CHILLER-1 IS MISSING FROM THIS DRAWING. It is not missing — it sits in the gap left
 * for it at CHILLER1_REST, rendered by a component one level up in Story.tsx that also
 * knows where it flies to. Drawing it here as well would mean two elements claiming the
 * same position, and the one that is not the flying element would sit there uselessly
 * once the real one has left.
 */

import { PLANT_ASSETS } from "./plantLayout.ts";
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

      <div className={styles.diagram}>
        {PLANT_ASSETS.map((asset) => (
          <div
            key={asset.id}
            className={`${styles.asset} ${styles[asset.kind]} ${fled ? styles.fled : ""}`}
            style={{
              left: asset.box.x, top: asset.box.y, width: asset.box.w, height: asset.box.h,
              // Each asset flees toward a slightly different point away from the centre of
              // the drawing, so the scatter reads as an explosion rather than a slide.
              "--flee-x": `${(asset.box.x + asset.box.w / 2 - 620) * 0.9}px`,
              "--flee-y": `${(asset.box.y + asset.box.h / 2 - 360) * 0.9}px`,
            } as React.CSSProperties}
          >
            <span className={styles.assetKind}>{KIND_LABEL[asset.kind]}</span>
            <span className={styles.assetLabel}>{asset.label}</span>
          </div>
        ))}
      </div>

      <div className={styles.ticks} aria-label={`${total} instruments, ${unusable} unusable`}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i >= total - unusable ? styles.tickBad : styles.tickOk} />
        ))}
      </div>
    </section>
  );
}
