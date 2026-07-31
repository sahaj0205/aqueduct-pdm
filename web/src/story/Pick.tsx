/**
 * The "pick" scene's text: what is being picked, and why.
 *
 * THE MACHINE ITSELF DOES NOT LIVE HERE. Chiller-1 is the flying element rendered once in
 * Story.tsx, positioned at CHILLER1_REST while the plant scene has the camera and eased to
 * CHILLER1_EXPLODED — a box inside this scene's own rectangle — once this scene does. This
 * component only carries the words that explain what the audience is watching happen
 * beside it.
 */

import { PICK_WORDS_W } from "./plantLayout.ts";
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
      {/* Constrained to the left half. The machine itself flies into the right half and is
          an opaque panel, so anything wider than this ends up underneath it. */}
      <div className={stationStyles.halfColumn} style={{ width: PICK_WORDS_W }}>
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
          <div className={stationStyles.figure}>
            <dt>reports in</dt>
            <dd>
              {SNAPSHOT.point.unit_si}
              <span className={stationStyles.from}>converted on the way in</span>
            </dd>
          </div>
          <div className={stationStyles.figure}>
            <dt>plausible range</dt>
            <dd>
              {SNAPSHOT.point.expected_min} to {SNAPSHOT.point.expected_max} {SNAPSHOT.point.unit_si}
              <span className={stationStyles.from}>anything outside is refused</span>
            </dd>
          </div>
        </dl>
      )}
      </div>
    </section>
  );
}
