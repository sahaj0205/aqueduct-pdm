import { useCallback, useRef } from "react";

import {
  DAY_MS,
  daysBetween,
  dayOf,
  momentAtPosition,
  momentAtSeverity,
  positionInEra,
} from "../lib/clock.ts";
import type { EraSummary, InjectedFault } from "../types.ts";
import styles from "./Timeline.module.css";

/**
 * The run, drawn, with the clock's position on it.
 *
 * WHAT IT REPLACED. A bare `<input type="range">` with a thousand steps and no labels.
 * It moved the clock correctly and told the viewer nothing: not how long the run was,
 * not which month they were in, not whether the interesting part was ahead of them or
 * behind. A demonstration ran by dragging a grey slider and watching numbers change
 * somewhere else on the page.
 *
 * COMPUTES NOTHING. Every position on this track comes from `positionInEra` and every
 * seek goes back through `momentAtPosition`, both of which are pure functions in
 * lib/clock.ts that `npm run verify:clock` checks in a terminal. A drawing that did its
 * own date arithmetic could disagree with the rest of the application about what day it
 * is, and the whole point of the shared clock is that nothing can.
 *
 * THE GROUND TRUTH IS OPT-IN. When `faults` is null the track shows dates and nothing
 * else — which is what an operator would ever see, and what a screenshot of the default
 * state contains. The bands only appear when somebody deliberately opens the demo
 * drawer, because this project's central claim is that the detection path never sees the
 * answer key, and a dashboard with the answer printed along the bottom of every screen
 * undercuts that before a word is read.
 */

interface Props {
  era: EraSummary;
  at: Date;
  onSeek: (at: Date) => void;
  /** Answer-key spans to draw, or null to draw a bare calendar. Opt-in. */
  faults: InjectedFault[] | null;
}

/**
 * How close to either end a month label may sit before it collides with the run's own
 * start and end dates, which are pinned there.
 *
 * Without this the axis rendered "2036Mar02-25" at the left and "2036Sep-06" at the
 * right — the month name printed straight through the date, because the first and last
 * months of a run are almost always within a few days of its edges.
 */
const EDGE_GUARD = 0.1;

/** The first of each month inside the run, minus the ones that would hit an edge date. */
function monthMarks(from: Date, to: Date): Date[] {
  const marks: Date[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1),
  );
  while (cursor.getTime() <= to.getTime()) {
    marks.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const span = to.getTime() - from.getTime();
  if (span <= 0) return marks;
  return marks.filter((m) => {
    const at = (m.getTime() - from.getTime()) / span;
    return at > EDGE_GUARD && at < 1 - EDGE_GUARD;
  });
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function Timeline({ era, at, onSeek, faults }: Props) {
  const rail = useRef<HTMLDivElement>(null);
  const from = new Date(era.t_from);
  const to = new Date(era.t_to);
  const position = positionInEra(era, at);

  /** Turn a pointer's x into a moment, via the same function the scrubber always used. */
  const seekTo = useCallback(
    (clientX: number) => {
      const box = rail.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const fraction = (clientX - box.left) / box.width;
      onSeek(momentAtPosition(era, fraction));
    },
    [era, onSeek],
  );

  /** Where a moment sits along the track, as a percentage, clamped to the run. */
  const percent = (moment: Date): number => positionInEra(era, moment) * 100;

  const spans = (faults ?? [])
    .map((fault) => {
      const onset = new Date(fault.t_onset);
      const end = fault.t_failure ? new Date(fault.t_failure) : to;
      // A fault belonging to another run has no business on this track.
      if (end.getTime() < from.getTime() || onset.getTime() > to.getTime()) return null;
      return { fault, left: percent(onset), right: percent(end) };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const day = daysBetween(from, at) + 1;

  return (
    <div className={styles.wrap}>
      <div
        ref={rail}
        className={styles.rail}
        role="slider"
        tabIndex={0}
        aria-label="position in this run"
        aria-valuemin={0}
        aria-valuemax={era.days}
        aria-valuenow={day}
        aria-valuetext={`${at.toISOString().slice(0, 10)}, day ${day} of ${era.days}`}
        onPointerDown={(e) => {
          // Capture on the rail, so a drag that leaves the element keeps seeking rather
          // than sticking wherever the pointer happened to exit.
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
        }}
        onKeyDown={(e) => {
          // Arrow keys move a day, with shift for a week — the same two steps the
          // buttons offer, so the keyboard is not a second, different clock.
          const step =
            e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          if (step === 0) return;
          e.preventDefault();
          const by = e.shiftKey ? step * 7 : step;
          onSeek(dayOf(new Date(at.getTime() + by * DAY_MS)));
        }}
      >
        <div className={styles.track} />

        {/* Answer-key spans, only ever drawn when explicitly asked for. Behind the
            handle, so the position marker is never obscured by them. */}
        {spans.map(({ fault, left, right }) => (
          <div
            key={fault.scenario_id}
            className={styles.span}
            style={{ left: `${left}%`, width: `${Math.max(right - left, 0.4)}%` }}
            title={`${fault.fault_mode.replace(/_/g, " ")} on ${fault.asset_id}`}
          >
            {fault.ladder.map((rung) => {
              const when = momentAtSeverity(fault, rung.level);
              if (!when) return null;
              const p = percent(when);
              // Positioned against the whole track, then expressed relative to this
              // span's own left edge, because the tick is a child of the span.
              const within = right > left ? ((p - left) / (right - left)) * 100 : 0;
              return (
                <span
                  key={rung.level}
                  className={styles.rung}
                  style={{ left: `${within}%` }}
                  title={`${rung.label} — rung ${rung.level}`}
                />
              );
            })}
          </div>
        ))}

        <div className={styles.elapsed} style={{ width: `${position * 100}%` }} />
        <div className={styles.handle} style={{ left: `${position * 100}%` }}>
          <span className={styles.grip} />
        </div>
      </div>

      <div className={styles.axis}>
        {monthMarks(from, to).map((mark) => (
          <span
            key={mark.toISOString()}
            className={styles.month}
            style={{ left: `${percent(mark)}%` }}
          >
            {MONTH[mark.getUTCMonth()]}
          </span>
        ))}
        <span className={styles.edge} data-side="start">
          {from.toISOString().slice(0, 10)}
        </span>
        <span className={styles.edge} data-side="end">
          {to.toISOString().slice(0, 10)}
        </span>
      </div>
    </div>
  );
}
