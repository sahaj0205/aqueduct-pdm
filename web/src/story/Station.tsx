/**
 * What every scene looks like.
 *
 * ONE COMPONENT FOR ALL NINETEEN, driven by the row in the script rather than written out
 * scene by scene. That is a deliberate design decision and not only a shortcut: the
 * walkthrough is making the argument that thirteen stages all have the same shape — each
 * asks one question, reads what the last one wrote, and writes something of its own — and a
 * viewer learns to read that shape ONCE, in scene five, and then knows where to look for
 * the rest of the show. Nineteen bespoke layouts would hide the very regularity being
 * argued for.
 *
 * The reading's own history gets the one exception, because a number arriving over time is
 * the single thing in the walkthrough that cannot be said in a list.
 */

import { type Figure, type Scene } from "./scenes.ts";
import { SNAPSHOT } from "./snapshot.ts";
import styles from "./Station.module.css";

/**
 * The reading, drawn as a line with a bright head and a tail that fades behind it.
 *
 * WHY IT IS HAND-ROLLED SVG and not a charting library. Every chart in this walkthrough is
 * an ANIMATION — the line draws itself, the head arrives and holds — and a library that
 * renders a finished chart in one pass has no way to be shown partially. The whole point of
 * this one is that the audience watches the history accumulate and then sees where the
 * newest value landed.
 *
 * The tail is a gradient rather than a fixed number of visible points, so the history reads
 * as memory fading rather than as an arbitrary window.
 */
function History({ shown }: { shown: number }) {
  const series = SNAPSHOT.series;
  const w = 1160;
  const h = 300;
  const values = series.map((p) => p.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;

  // How much of the history has been drawn, driven by which beat we are on.
  const upTo = Math.max(2, Math.round((series.length * Math.min(shown + 1, 2)) / 2));
  const visible = series.slice(0, upTo);

  const x = (i: number) => (i / Math.max(1, series.length - 1)) * w;
  const y = (v: number) => h - ((v - lo) / span) * h;
  const path = visible.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const head = visible[visible.length - 1];
  const headIndex = visible.length - 1;

  return (
    <svg className={styles.chart} viewBox={`0 -14 ${w} ${h + 28}`} role="img"
         aria-label={`${series.length} hours of ${SNAPSHOT.point.point_id}, ending at ${SNAPSHOT.reading.v} ${SNAPSHOT.point.unit_si}`}>
      <defs>
        {/* The tail: full strength at the head, gone at the far end of the history. */}
        <linearGradient id="tail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.05" />
          <stop offset="65%" stopColor="var(--primary)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="1" />
        </linearGradient>
      </defs>
      <path d={path} fill="none" stroke="url(#tail)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      {head && (
        <>
          <circle cx={x(headIndex)} cy={y(head.v)} r={9} fill="var(--primary)" opacity={0.18} />
          <circle cx={x(headIndex)} cy={y(head.v)} r={4.5} fill="var(--primary)" />
        </>
      )}
    </svg>
  );
}

function Figures({ figures }: { figures: readonly Figure[] }) {
  return (
    <dl className={styles.figures}>
      {figures.map((f) => (
        <div key={f.label} className={styles.figure}>
          <dt>{f.label}</dt>
          <dd>
            {f.value}
            {f.from && <span className={styles.from}>{f.from}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Station({
  scene,
  index,
  beat,
  current,
  pinged = false,
}: {
  scene: Scene;
  index: number;
  beat: number;
  /** Whether the camera is standing here. Off-camera scenes are dimmed, never unmounted. */
  current: boolean;
  /** True for the moment a later scene's callback is pointing at this one. */
  pinged?: boolean;
}) {
  const isArrival = scene.id === "arrival";

  return (
    <section
      className={`${styles.station} ${current ? styles.current : styles.away} ${pinged ? styles.pinged : ""}`}
    >
      <header className={styles.head}>
        <div className={styles.meta}>
          <span className={styles.num}>{String(index + 1).padStart(2, "0")}</span>
          {scene.module && <span className={styles.module}>{scene.module}</span>}
          {scene.cadence && (
            <span
              className={`${styles.cadence} ${
                scene.cadence.includes("few minutes") ? styles.cadenceFast : ""
              }`}
            >
              {scene.cadence}
            </span>
          )}
        </div>
        <h2 className={styles.title}>{scene.title}</h2>
        {scene.asks && <p className={styles.asks}>{scene.asks}</p>}
      </header>

      {isArrival && <History shown={beat} />}

      <ol className={styles.reveals}>
        {scene.reveals.map((label, at) => (
          <li key={label} className={current && beat >= at ? styles.lit : styles.unlit}>
            {label}
          </li>
        ))}
      </ol>

      {/* Figures appear once the scene has got going, so the eye reads the sentence before
          the numbers rather than competing with them from the first frame. */}
      {scene.figures && current && beat >= 1 && <Figures figures={scene.figures} />}

      {scene.writes && (
        <footer className={styles.writes}>
          <span className={styles.writesLabel}>writes</span>
          <span className={styles.writesVal}>{scene.writes}</span>
        </footer>
      )}
    </section>
  );
}
