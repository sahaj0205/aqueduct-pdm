/**
 * The "pick" scene's text: what is being picked, and why.
 *
 * THE MACHINE ITSELF DOES NOT LIVE HERE. Chiller-1 is the flying element rendered once in
 * Story.tsx, positioned at CHILLER1_REST while the plant scene has the camera and eased to
 * CHILLER1_EXPLODED — a box inside this scene's own rectangle — once this scene does. This
 * component only carries the words that explain what the audience is watching happen
 * beside it.
 */

import type { Scene } from "./scenes.ts";
import { SNAPSHOT } from "./snapshot.ts";
import stationStyles from "./Station.module.css";

export function Pick({
  scene,
  index,
  beat,
  current,
}: {
  scene: Scene;
  index: number;
  beat: number;
  current: boolean;
}) {
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

      {current && beat >= 1 && (
        <dl className={stationStyles.figures}>
          <div className={stationStyles.figure}>
            <dt>asset</dt>
            <dd>{SNAPSHOT.asset.asset_id}</dd>
          </div>
          <div className={stationStyles.figure}>
            <dt>instrument</dt>
            <dd>{SNAPSHOT.point.point_id}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
