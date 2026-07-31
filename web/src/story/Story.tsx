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
 * EVERY SCENE IS DRIVEN BY THE SCRIPT in scenes.ts and every number on them comes from the
 * frozen snapshot, which came out of the database.
 */

import { useMemo } from "react";

import { Callback } from "./Callback.tsx";
import { Chiller1 } from "./Chiller1.tsx";
import { Inventory } from "./Inventory.tsx";
import { Pick } from "./Pick.tsx";
import { Plant } from "./Plant.tsx";
import { Station } from "./Station.tsx";
import { BEAT_COUNTS, SCENES, callbackActiveAt, cameraTargetFor, sceneById } from "./scenes.ts";
import { stepIndex, totalSteps } from "./show.ts";
import { useCamera } from "./useCamera.ts";
import { useShow } from "./useShow.ts";
import styles from "./Story.module.css";

const PICK_INDEX = sceneById("pick")!.index;
const RECORD_INDEX = sceneById("record")!.index;
const RECORD_BOX = sceneById("record")!.scene.box;

export function Story() {
  const { spot, advance } = useShow(BEAT_COUNTS);

  const scene = SCENES[spot.scene] ?? SCENES[0]!;

  // Usually the scene's own box. On the one beat that points back at an earlier scene,
  // cameraTargetFor returns a memoised union of the two, so the camera widens to hold
  // both rather than retargeting to just the current one.
  const target = cameraTargetFor(scene, spot.beat);
  const { stage, world } = useCamera(target);

  // Chiller-1 has left its resting place among the other assets from the moment the
  // presenter reaches the "pick" scene onward, and stays exploded from partway through
  // that scene onward — including on every later scene, so it does not un-explode the
  // moment the camera moves on.
  const flown = spot.scene >= PICK_INDEX;
  const exploded = flown && (spot.scene > PICK_INDEX || spot.beat >= 2);
  // Act I's last scene about the machine itself is the record; after that the story is
  // about the reading, and the prop fades rather than hanging in frame.
  const retired = spot.scene > RECORD_INDEX;

  const callbackActive = callbackActiveAt(scene, spot.beat);

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
          /*
           * The final pull-out has no card of its own. Its rectangle is the union of every
           * other scene's, so drawing a card there would put a full-canvas panel on top of
           * the entire show — its heading appeared over the opening shot. It is a camera
           * position and nothing more; its words are rendered as a fixed overlay below.
           */
          each.id === "map" ? null : (
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
            {each.id === "plant" ? (
              <Plant scene={each} index={index} beat={spot.beat} current={index === spot.scene} fled={flown} />
            ) : each.id === "record" ? (
              <Inventory
                scene={each}
                index={index}
                beat={spot.beat}
                current={index === spot.scene}
                pinged={callbackActive}
              />
            ) : each.id === "pick" ? (
              <Pick scene={each} index={index} beat={spot.beat} current={index === spot.scene} />
            ) : (
              <Station
                scene={each}
                index={index}
                beat={spot.beat}
                current={index === spot.scene}
                pinged={each.id === "record" && callbackActive}
              />
            )}
          </div>
          )
        ))}

        {/* The one element that physically travels between two scenes rather than being
            reframed by the camera. See Chiller1.tsx for why it cannot belong to either. */}
        <Chiller1 flown={flown} exploded={exploded} retired={retired} />

        {/* Mounted once, permanently, and made visible only on the beat it applies to. */}
        <Callback from={RECORD_BOX} to={scene.box} active={callbackActive} />
      </div>

      {/* The final pull-out's words, in screen space rather than on the canvas — see the
          note where its card is skipped above. Sits over the whole show at once, which is
          exactly what the scene is about. */}
      {scene.id === "map" && (
        <div className={styles.finale}>
          <h2>{scene.title}</h2>
          {scene.asks && <p className={styles.finaleAsks}>{scene.asks}</p>}
          <ol className={styles.finaleList}>
            {scene.reveals.map((label, at) => (
              <li key={label} className={spot.beat >= at ? styles.lit : styles.unlit}>
                {label}
              </li>
            ))}
          </ol>
          {scene.figures && (
            <dl className={styles.finaleFigures}>
              {scene.figures.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

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
