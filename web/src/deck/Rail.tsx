/**
 * The presenter's readout, pinned to the bottom.
 *
 * WHAT A PRESENTER CANNOT GET FROM THE SLIDE ITSELF: which act they are in, how far
 * through it they are, and how much is left. That is all this says. It is not navigation
 * furniture for the audience — it is the thing the presenter glances at between sentences
 * to decide whether to slow down.
 *
 * The act groups are separated by a gap rather than by a colour, because colour in this
 * project is spoken for by severity and emphasis, and a third meaning for it would be one
 * too many.
 *
 * PASS 2 — the structure is real; pass 3 tunes what it reads.
 */

import { ACTS, SLIDES, SLIDE_COUNT, actOf, positionInAct } from "./deck.ts";
import styles from "./Rail.module.css";

export function Rail({ at, onGo }: { at: number; onGo: (to: number) => void }) {
  const act = actOf(at);
  const { at: within, of: inAct } = positionInAct(at);
  const next = SLIDES[at + 1];

  return (
    <div className={styles.chrome}>
      <div className={styles.rail}>
        {SLIDES.map((slide, index) => {
          const previous = SLIDES[index - 1];
          const boundary = previous !== undefined && previous.act !== slide.act;
          return (
            <button
              key={slide.id}
              type="button"
              aria-label={slide.title}
              title={slide.title}
              onClick={() => onGo(index)}
              className={`${styles.tick} ${boundary ? styles.boundary : ""} ${
                index < at ? styles.done : index === at ? styles.here : styles.ahead
              }`}
            />
          );
        })}
      </div>

      <div className={styles.hud}>
        <div className={styles.where}>
          <span className={styles.act}>
            act {ACTS.findIndex((a) => a.id === act.id)} &middot; {act.name}
          </span>
          <span className={styles.title}>{SLIDES[at]?.title}</span>
        </div>

        <div className={styles.next}>
          {next ? (
            <>
              <span className={styles.nextLabel}>next</span>
              <span className={styles.nextText}>{next.title}</span>
            </>
          ) : (
            <span className={styles.nextLabel}>end of the deck</span>
          )}
        </div>

        <div className={styles.count}>
          <span>
            {within}/{inAct} in act
          </span>
          <span className={styles.dot}>&middot;</span>
          <span>
            {at + 1}/{SLIDE_COUNT}
          </span>
          <span className={styles.keys}>&larr; &rarr;</span>
        </div>
      </div>
    </div>
  );
}
