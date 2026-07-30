/**
 * The walkthrough: one world, one camera, nineteen scenes standing in it.
 *
 * WHAT THIS COMPONENT ACTUALLY IS. Every scene is mounted, all the time, at its own fixed
 * address inside a single transformed element. Advancing the show does not swap what is
 * rendered; it changes which box the camera is asked to frame. Nothing mounts, nothing
 * unmounts, and no scene is ever rebuilt — which is what makes the show read as one
 * continuous take, and what makes a later scene able to point back at an earlier one that
 * is still sitting there on the canvas.
 *
 * WHY EVERYTHING IS MOUNTED AT ONCE and not virtualised. It is nineteen scenes, not
 * nineteen thousand, and the browser composites the whole world as one GPU layer, so the
 * cost of a camera move is proportional to the size of the screen rather than to how much
 * is on the canvas. Mounting on demand would buy nothing and would cost the two effects
 * the show is built on: scenes visible at the edges of a wide shot, and a callback that
 * points at something already drawn.
 *
 * THE PRESENTER'S READOUT along the bottom is not decoration. It says what the next press
 * will reveal, which is the one thing they cannot get from the screen, and how far through
 * the show they are, which is what tells them whether to slow down.
 *
 * AT THIS CHECKPOINT the three scenes are placeholder frames. The camera, the beat machine
 * and the keyboard are real.
 */

import { useMemo } from "react";

import { Placeholder } from "./Placeholder.tsx";
import { BEAT_COUNTS, SCENES } from "./scenes.ts";
import { stepIndex, totalSteps } from "./show.ts";
import { useCamera } from "./useCamera.ts";
import { useShow } from "./useShow.ts";
import styles from "./Story.module.css";

export function Story() {
  const { spot, advance } = useShow(BEAT_COUNTS);

  const scene = SCENES[spot.scene] ?? SCENES[0]!;

  // The box object comes straight out of the scene table and is therefore referentially
  // stable across renders. That matters: the camera retargets when this value changes, so
  // a fresh object each render would restart the move on every beat.
  const { stage, world } = useCamera(scene.box);

  const total = useMemo(() => totalSteps(BEAT_COUNTS), []);
  const step = stepIndex(BEAT_COUNTS, spot);

  // What the next press does. Reaches into the following scene when the current one is
  // exhausted, so the readout says "the camera moves to X" rather than going blank on the
  // last beat of every scene.
  const next =
    scene.reveals[spot.beat + 1] ?? SCENES[spot.scene + 1]?.reveals[0] ?? null;
  const nextMoves = spot.beat + 1 >= scene.reveals.length && next !== null;

  return (
    <div
      className={styles.stage}
      ref={stage}
      onClick={advance}
      // Clicking anywhere advances, so the whole stage is one enormous button. Given a
      // role and a label rather than left as a bare div, because a presenter driving this
      // from a screen reader still has to be able to tell that pressing it does something.
      role="button"
      tabIndex={0}
      aria-label="Advance the walkthrough"
    >
      <div className={styles.world} ref={world}>
        {SCENES.map((each, index) => (
          <div
            key={each.id}
            className={styles.plot}
            style={{
              left: `${each.box.x}px`,
              top: `${each.box.y}px`,
              width: `${each.box.w}px`,
              height: `${each.box.h}px`,
            }}
          >
            <Placeholder
              scene={each}
              index={index}
              beat={spot.beat}
              current={index === spot.scene}
            />
          </div>
        ))}
      </div>

      <div className={styles.hud}>
        <div className={styles.where}>
          <span className={styles.act}>Act {scene.act}</span>
          <span className={styles.title}>{scene.title}</span>
        </div>

        <div className={styles.next}>
          {next ? (
            <>
              <span className={styles.nextLabel}>{nextMoves ? "next scene" : "next"}</span>
              <span className={styles.nextText}>{next}</span>
            </>
          ) : (
            <span className={styles.nextLabel}>end of the walkthrough</span>
          )}
        </div>

        <div className={styles.count}>
          <span>
            scene {spot.scene + 1}/{SCENES.length}
          </span>
          <span className={styles.dot}>&middot;</span>
          <span>
            step {step + 1}/{total}
          </span>
          <span className={styles.keys}>space &middot; &larr; &rarr;</span>
        </div>
      </div>

      {/* What has just been revealed, for a screen reader. The visual reveal is a dot
          lighting up inside a scene, which announces nothing on its own. */}
      <p className={styles.announce} aria-live="polite">
        {scene.title}. {scene.reveals[spot.beat]}
      </p>
    </div>
  );
}
