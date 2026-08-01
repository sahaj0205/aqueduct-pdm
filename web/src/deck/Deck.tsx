/**
 * The deck: a presentation of the whole system, for somebody deciding whether it is worth
 * having.
 *
 * WHAT THIS IS NOT. It is not the walkthrough at /story. That artefact is a camera move
 * through one continuous world, told from the point of view of a single measurement
 * travelling the pipeline, and it exists to make the mechanism feel inevitable. This one
 * answers a different question — is this thing any good — and the answer to that is
 * structural, not cinematic. So there is no camera here, no world, no beat machine and no
 * flying. One slide fills the screen. Everything on it is visible at once. The presenter
 * talks.
 *
 * WHY EVERY SLIDE IS MOUNTED AND ONLY ONE IS SHOWN. Fifty slides is nothing to a browser,
 * and keeping them mounted means moving between them is a class change rather than a mount
 * — no layout thrash, no flash of unstyled figure, and a figure that has already measured
 * itself does not measure itself again when you come back to it.
 *
 * THE DECK OWNS THE WHOLE VIEWPORT and scrolls nowhere. It is projected into a room. A
 * scroll bar appearing mid-sentence because one slide is two pixels too tall is a real
 * failure, and a fixed stage with hidden overflow removes the possibility. The verifier
 * measures every slide against the stage box for exactly this reason.
 *
 * EVERY WORD COMES FROM deck.ts. Nothing on screen is written in this file.
 */

import { useCallback, useEffect, useState } from "react";

import { Panel } from "./Panel.tsx";
import { Rail } from "./Rail.tsx";
import { Slide } from "./Slide.tsx";
import { type PanelRef, SLIDES, SLIDE_COUNT } from "./deck.ts";
import styles from "./Deck.module.css";

export function Deck() {
  const [at, setAt] = useState(0);
  /** The drawer, or null. Held here rather than in a slide so Escape can always close it. */
  const [panel, setPanel] = useState<PanelRef | null>(null);

  const go = useCallback((to: number) => {
    setAt(Math.max(0, Math.min(SLIDE_COUNT - 1, to)));
    // Moving slide always closes the drawer. A panel left open across a slide change would
    // be annotating something that is no longer on screen.
    setPanel(null);
  }, []);

  /*
   * Keyboard, on the window rather than on a focused element.
   *
   * A presenter clicks a panel chip, then presses the right arrow. If the handler lived on
   * a focusable stage, focus would still be on the chip and the arrow would do nothing —
   * which on a projector reads as the deck having frozen. Listening on the window means the
   * keys work no matter what was last touched.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          go(at + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          go(at - 1);
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(SLIDE_COUNT - 1);
          break;
        case "Escape":
          // Closes the drawer if one is open; otherwise does nothing, deliberately. There is
          // no "exit" for a presentation.
          setPanel(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, go]);

  return (
    <div className={styles.stage}>
      <div className={`${styles.deck} ${panel ? styles.shifted : ""}`}>
        {SLIDES.map((slide, index) => (
          <Slide
            key={slide.id}
            slide={slide}
            index={index}
            current={index === at}
            narrowed={panel !== null}
            onOpenPanel={setPanel}
          />
        ))}
      </div>

      <Panel open={panel} onClose={() => setPanel(null)} />

      <Rail at={at} onGo={go} />

      {/* What is on screen now, for a screen reader. The visual change is a class swap,
          which announces nothing on its own. */}
      <p className={styles.announce} aria-live="polite">
        {SLIDES[at]?.title}
      </p>
    </div>
  );
}
