import type { Cascade } from "../types.ts";
import styles from "./CascadeList.module.css";

/**
 * Which instrument the injected fault reached first, and in what order after it.
 *
 * Measured, not asserted. Every run in this database reads the same source year shifted
 * by whole years, so the same day of the year in the fault-free run has the same
 * weather, the same occupancy and the same control decisions with nothing wrong.
 * Subtracting one from the other leaves only the fault; each reading is then compared
 * against how much it normally moves from one day to the next, and the order they cross
 * that is the cascade.
 *
 * On the fouled chiller it reads as physics: the compressor draws more power fifty days
 * before the machine starts failing to hold the water temperature it was asked for.
 */

interface Props {
  cascade: Cascade;
}

export function CascadeList({ cascade }: Props) {
  const moved = cascade.departures.filter((d) => d.diverged_on !== null);
  const still = cascade.departures.filter((d) => d.diverged_on === null);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>{cascade.asset_id}, instrument by instrument</span>
        <span className={styles.muted}>
          against {cascade.twin_scenario} shifted +{cascade.year_shift}y ·{" "}
          {cascade.days_compared} days · {cascade.points_considered} instruments
        </span>
      </div>

      {cascade.caveats.map((caveat) => (
        <p key={caveat} className={styles.caveat}>
          {caveat}
        </p>
      ))}

      {moved.length === 0 ? (
        <p className={styles.muted}>
          No instrument on this machine departed from its fault-free twin by more than
          its own normal daily movement.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>instrument</th>
              <th className={styles.r}>first departed</th>
              <th className={styles.r}>after injection</th>
              <th className={styles.r}>peak</th>
            </tr>
          </thead>
          <tbody>
            {moved.map((d) => (
              <tr key={d.point_id}>
                <td className={styles.point}>{d.point_id}</td>
                <td className={styles.r}>{d.diverged_on}</td>
                <td className={styles.r}>
                  <strong>+{d.days_after_onset}d</strong>
                </td>
                <td className={styles.r}>{d.peak_departure}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {still.length > 0 && (
        <p className={styles.muted}>
          {still.length} instrument{still.length === 1 ? "" : "s"} never departed far
          enough to date, or never move in the fault-free run and so have no scale to be
          measured against.
        </p>
      )}

      <p className={styles.note}>
        &ldquo;Peak&rdquo; is how far the reading got from its twin at its worst, in
        multiples of how much that reading normally moves from one day to the next. The
        threshold for counting as departed is {cascade.departure_threshold}× held for{" "}
        {cascade.held_days} days — low on purpose, because this describes what the fault
        did rather than detecting it, and the interesting output is the <em>order</em>.
      </p>
    </div>
  );
}
