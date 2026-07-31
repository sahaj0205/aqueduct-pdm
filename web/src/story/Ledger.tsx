/**
 * The running record: everything the system has produced so far, and which stage produced it.
 *
 * WHAT IT IS FOR. The handoff line on each card shows one link — what arrived, what is left
 * behind. That is enough to follow a single step but not enough to feel the thing being
 * built: by stage nine a viewer has watched nine screens and has no way to see that eight
 * results are now stacked up underneath the one being discussed. This panel is that stack,
 * growing a row at a time, so the pipeline reads as accumulation rather than as a sequence
 * of unrelated screens.
 *
 * IN SCREEN SPACE, NOT ON THE CANVAS, for the same reason as the progress rail: it has to
 * stay in one place while the camera moves, and it must not consume room inside any card.
 * The camera measures it and frames scenes into the width that is left, so it can never
 * cover what it is annotating.
 *
 * IT APPEARS ONLY ONCE THERE IS SOMETHING IN IT. Through the opening act nothing has been
 * produced yet, and an empty panel captioned "what we have so far" would be answering a
 * question nobody has asked, while taking width away from the scenes that need it most.
 */

import { forwardRef } from "react";

import type { LedgerEntry } from "./scenes.ts";
import styles from "./Ledger.module.css";

/**
 * How many rows are shown before the older ones are summarised.
 *
 * The panel is a fixed height, so a list that grows past it would either scroll — which
 * nobody will do mid-presentation — or run off the bottom. Eight covers the pipeline comfortably at the point it matters most; anything older is counted rather than dropped,
 * so the record never understates what has been built.
 */
const ROWS = 8;

export const Ledger = forwardRef<HTMLDivElement, { entries: LedgerEntry[]; current: number }>(
  function Ledger({ entries, current }, ref) {
    const shown = entries.slice(-ROWS);
    const hidden = entries.length - shown.length;
    const produced = entries.filter((e) => e.wrote !== null).length;

    /*
     * ALWAYS THE SAME ELEMENT, collapsed to no width when there is nothing to show, rather
     * than swapping between an empty placeholder and the real panel. The camera observes
     * this node to know how much width to leave free, and swapping the element out from
     * under it left the observer watching a node no longer in the document — so the panel
     * appeared, the camera never widened its idea of the taken space, and the cards were
     * drawn straight underneath it.
     */
    return (
      <aside
        ref={ref}
        className={`${styles.panel} ${entries.length === 0 ? styles.empty : ""}`}
        aria-label="What the system has produced so far"
      >
        <header className={styles.head}>
          <span className={styles.title}>what we have so far</span>
          <span className={styles.count}>
            {produced} of {entries.length} stages left something
          </span>
        </header>

        <ol className={styles.list}>
          {hidden > 0 && <li className={styles.earlier}>and {hidden} earlier</li>}
          {shown.map((e) => (
            <li
              key={e.id}
              className={`${styles.row} ${e.index === current ? styles.fresh : ""} ${
                e.wrote === null ? styles.nothing : ""
              }`}
            >
              <span className={styles.num}>{String(e.index + 1).padStart(2, "0")}</span>
              <span className={styles.body}>
                <span className={styles.stage}>{e.stage}</span>
                <span className={styles.wrote}>
                  {e.wrote ?? "nothing — this stage only ever refuses"}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </aside>
    );
  },
);
