/**
 * Everything held about one machine before a single reading arrives.
 *
 * WHY THIS SCENE IS DIFFERENT FROM THE OTHERS. Every other scene makes a claim in a few
 * lines. This one makes its claim by sheer inventory: here are the actual instruments, the
 * actual named ways this equipment is known to fail with the actual value each one counts
 * as failed at, and the actual priced jobs that fix them. The point being argued is that
 * none of it was learned from data — it is configuration, written down by somebody, sitting
 * in the database before the plant was ever switched on. A bulleted summary cannot make
 * that point; a list of real rows can.
 *
 * It is also what makes the scene's rectangle worth its size. It was previously four
 * bullets in a very large box, so the camera pulled a long way back to frame mostly empty
 * card.
 */

import type { Scene } from "./scenes.ts";
import { SNAPSHOT as S } from "./snapshot.ts";
import stationStyles from "./Station.module.css";
import styles from "./Inventory.module.css";

const money = (v: number | null) =>
  v === null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`;

export function Inventory({
  scene,
  index,
  beat,
  current,
  pinged,
}: {
  scene: Scene;
  index: number;
  beat: number;
  current: boolean;
  pinged: boolean;
}) {
  const { points, modes, interventions } = S.inventory;
  const usable = points.filter((p) => p.usable);
  const broken = points.filter((p) => !p.usable);

  /*
   * The inventory is empty when the committed capture predates it, or was taken while the
   * database was mid-rebuild. Saying so is the only honest option: an empty column with a
   * zero beside it looks like a machine with no instruments and no known failure modes,
   * which is a far more alarming claim than "this has not been captured yet".
   */
  const captured = points.length > 0 || modes.length > 0 || interventions.length > 0;

  // Each column arrives on its own beat, so the presenter can talk through one kind of
  // thing at a time instead of the whole wall landing at once.
  const show = (fromBeat: number) => current && beat >= fromBeat;

  return (
    <section
      className={`${stationStyles.station} ${current ? stationStyles.current : stationStyles.away} ${
        pinged ? stationStyles.pinged : ""
      }`}
    >
      <header className={stationStyles.head}>
        <div className={stationStyles.meta}>
          <span className={stationStyles.num}>{String(index + 1).padStart(2, "0")}</span>
          <span className={stationStyles.module}>{S.asset.asset_id}</span>
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

      {!captured && (
        <p className={styles.uncaptured}>
          This machine&rsquo;s inventory was not in the last capture. Run{" "}
          <code>npm run snapshot</code> against a loaded database to fill it — the columns
          below are empty because nothing was read, not because there is nothing there.
        </p>
      )}

      <div className={styles.columns}>
        {/* What it can measure at all. */}
        <div className={`${styles.col} ${show(1) ? styles.in : styles.out}`}>
          <h3 className={styles.colHead}>
            its instruments <span>{points.length}</span>
          </h3>
          <ul className={styles.list}>
            {usable.slice(0, 9).map((p) => (
              <li key={p.point_id}>
                <code>{p.point_id.replace(`${S.asset.asset_id}.`, "")}</code>
                <span className={styles.unit}>{p.unit_si}</span>
              </li>
            ))}
            {broken.map((p) => (
              <li key={p.point_id} className={styles.dead}>
                <code>{p.point_id.replace(`${S.asset.asset_id}.`, "")}</code>
                <span className={styles.unit}>unusable</span>
              </li>
            ))}
          </ul>
        </div>

        {/* The named ways it wears out, and the value each counts as failed at. */}
        <div className={`${styles.col} ${show(2) ? styles.in : styles.out}`}>
          <h3 className={styles.colHead}>
            how it fails <span>{modes.length}</span>
          </h3>
          <ul className={styles.list}>
            {modes.map((m) => (
              <li key={m.mode_id}>
                <span className={styles.name}>{m.mode_name}</span>
                <span className={styles.unit}>
                  fails at {m.failure_threshold} {m.indicator_unit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* What it costs to put each of them right. */}
        <div className={`${styles.col} ${show(3) ? styles.in : styles.out}`}>
          <h3 className={styles.colHead}>
            what fixing it costs <span>{interventions.length}</span>
          </h3>
          <ul className={styles.list}>
            {interventions.slice(0, 9).map((i) => (
              <li key={`${i.fault_id}-${i.action}`}>
                <span className={styles.name}>{i.action}</span>
                <span className={styles.unit}>
                  {i.hours ? `${i.hours} h · ` : ""}
                  {money(i.cost)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <footer className={stationStyles.writes}>
        <span className={stationStyles.writesLabel}>read from</span>
        <span className={stationStyles.writesVal}>
          app.points · app.failure_modes · app.intervention_library
        </span>
      </footer>
    </section>
  );
}
