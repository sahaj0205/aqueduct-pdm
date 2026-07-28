import { useEffect, useRef, useState } from "react";

import {
  SPEEDS,
  addDays,
  daysBetween,
  eraAt,
  faultsActiveAt,
  momentAtSeverity,
  step,
} from "../lib/clock.ts";
import type { Speed } from "../lib/clock.ts";
import type { ClockRange, InjectedFault } from "../types.ts";
import { Timeline } from "./Timeline.tsx";
import styles from "./ControlBar.module.css";

/**
 * The clock, and everything that moves it.
 *
 * Persistent across every screen, because every screen shows one moment and they must
 * all show the SAME moment. Holding this in one place is what stops the queue and the
 * building drawing disagreeing about what day it is.
 *
 * WHAT CHANGED IN R3, and why it mattered more than it looks. This bar had eleven
 * controls in a row — play, four speeds, four nudges, two dropdowns — plus an unlabelled
 * grey slider, and it is the one component visible on every screen of the demonstration.
 * The date it was showing was set at the same size as the buttons around it, so the most
 * important piece of state in the application was also the hardest thing on the bar to
 * find. It is now the largest thing here, and the run is drawn rather than implied.
 *
 * THE ANSWER KEY IS BEHIND A SWITCH, and this is the substantive change. The bar used to
 * carry a "jump to a fault" dropdown listing every injected fault with its onset date,
 * and chips naming whatever was running right now — the ground truth, sitting in the
 * operator's chrome, on every screen, at all times. This project's central claim is that
 * nothing on the detection path can see that data. Printing it along the bottom of every
 * screen undercuts the claim before a viewer reads a word of it.
 *
 * Closed, this bar shows dates and nothing else. Opened, deliberately, it shows the
 * spans and the jump control and says in as many words that it is reading the answer
 * key. The demonstration keeps the affordance; the default state keeps the claim.
 */

export interface ClockState {
  at: Date;
  playing: boolean;
  speed: Speed;
}

interface Props {
  range: ClockRange;
  clock: ClockState;
  onChange: (next: ClockState) => void;
  /**
   * The answer key, or null when the reveal service is not running. Used for LABELS
   * ONLY, and only once the demo drawer is open. The bar works without it, in dates
   * alone, and nothing on the operator's side of the dashboard reads it.
   */
  faults: InjectedFault[] | null;
}

/** Past this far down the page the bar is in the way rather than in use. */
const COLLAPSE_AFTER = 150;
/**
 * How far you must travel in one direction before the bar changes its mind.
 *
 * WHY THIS IS SO MUCH LARGER THAN IT LOOKS LIKE IT NEEDS TO BE. Collapsing the bar
 * removes about ninety pixels from the document, everything below it slides up, and the
 * browser fires a scroll event for a movement the reader did not make. Read as intent
 * that looks like scrolling the other way, so the bar expands, the ninety pixels come
 * back, and it reads as scrolling down again — a loop that makes the page shudder in
 * place and feel stuck, which is exactly what it did.
 *
 * The threshold has to exceed the height the collapse itself removes, or the bar's own
 * animation keeps re-triggering it.
 */
const INTENT = 120;
/** After a flip the layout is still settling; events in this window are not intent. */
const SETTLE_MS = 300;

export function ControlBar({ range, clock, onChange, faults }: Props) {
  const era = eraAt(range, clock.at);
  const [showKey, setShowKey] = useState(false);
  const active = faults && showKey ? faultsActiveAt(faults, clock.at) : [];

  /**
   * Collapsed while reading down a screen, whole again the moment you head back up.
   *
   * The bar is a hundred and thirty pixels of controls pinned to the top of every screen.
   * That is right when somebody is moving the clock and pure obstruction when they are
   * reading a table underneath it. Scrolling down past the fold shrinks it to the date
   * and the play button; scrolling up — which is what somebody reaches for when they want
   * the clock back — restores it before they arrive.
   */
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    // Where the current run of travel started, and when the bar last changed.
    let anchor = window.scrollY;
    let flippedAt = 0;
    let queued = false;

    const evaluate = () => {
      queued = false;
      const y = window.scrollY;

      // Near the top the bar is never in anybody's way, so it is never collapsed there —
      // which also means the page can never open in the shrunken state.
      if (y < COLLAPSE_AFTER) {
        setCompact(false);
        anchor = y;
        return;
      }

      // Inside the settle window the page is still moving because the bar moved it.
      if (performance.now() - flippedAt < SETTLE_MS) {
        anchor = y;
        return;
      }

      const travelled = y - anchor;
      // Travel in the other direction restarts the run, so a reversal is measured from
      // where it reversed rather than from wherever the last flip happened to leave it.
      if (Math.sign(travelled) !== 0) {
        setCompact((was) => {
          const want = travelled > 0;
          if (Math.abs(travelled) < INTENT || want === was) {
            if (Math.abs(travelled) >= INTENT) anchor = y;
            return was;
          }
          anchor = y;
          flippedAt = performance.now();
          return want;
        });
      }
    };

    // One evaluation per frame at most. A scroll handler that runs on every event does
    // layout reads at the rate the wheel fires them.
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(evaluate);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The interval reads the newest state through a ref rather than closing over it, so a
  // running clock keeps one steady timer instead of tearing it down and starting a fresh
  // thousand milliseconds on every single tick.
  const latest = useRef({ clock, range, onChange });
  latest.current = { clock, range, onChange };

  useEffect(() => {
    if (!clock.playing) return;
    const id = window.setInterval(() => {
      const { clock: c, range: r, onChange: cb } = latest.current;
      const next = step(r, c.at, c.speed);
      // Stopping at the end of a run rather than rolling into the next one: two runs are
      // two simulations of the same building, and rolling would empty and refill the
      // queue for no reason a viewer could see.
      cb({ ...c, at: next.at, playing: !next.atEnd });
    }, 1000);
    return () => window.clearInterval(id);
  }, [clock.playing]);

  const set = (at: Date) => onChange({ ...clock, at });

  return (
    <div className={compact ? styles.barCompact : styles.bar}>
      <div className={styles.top}>
        <button
          className={styles.play}
          onClick={() => onChange({ ...clock, playing: !clock.playing })}
          disabled={!era}
          aria-label={clock.playing ? "pause" : "play"}
        >
          {clock.playing ? "❚❚" : "▶"}
        </button>

        <div className={styles.stamp}>
          <span className={styles.date}>{clock.at.toISOString().slice(0, 10)}</span>
          <span className={styles.where}>
            {era
              ? `day ${daysBetween(new Date(era.t_from), clock.at) + 1} of ${era.days} in the ${era.era} recording`
              : "between recordings"}
          </span>
        </div>

        <div className={styles.right}>
          <div className={styles.nudge}>
            <button onClick={() => set(step(range, clock.at, -1).at)} title="back one day">
              −1d
            </button>
            <button onClick={() => set(step(range, clock.at, 1).at)} title="on one day">
              +1d
            </button>
          </div>

          <div className={styles.speeds} role="group" aria-label="playback speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={s === clock.speed ? styles.speedOn : styles.speed}
                onClick={() => onChange({ ...clock, speed: s })}
                title={`${s} simulated day${s === 1 ? "" : "s"} per second`}
              >
                {s}×
              </button>
            ))}
          </div>

          {faults && (
            <button
              className={showKey ? styles.keyOn : styles.key}
              onClick={() => setShowKey((v) => !v)}
              aria-expanded={showKey}
              title="Shows what was actually broken and lets you jump straight to it. Off by default, because no other screen is allowed to see it."
            >
              {showKey ? "hide the answers" : "show me the answers"}
            </button>
          )}
        </div>
      </div>

      <div className={styles.fold}>
      {era && (
        <Timeline
          era={era}
          at={clock.at}
          onSeek={set}
          faults={showKey ? faults : null}
        />
      )}

      <div className={styles.runs}>
        <span className={styles.runsLabel}>recordings</span>
        {range.eras.map((e) => (
          <button
            key={e.era}
            className={era?.era === e.era ? styles.runOn : styles.run}
            onClick={() => set(new Date(e.t_from))}
            title={`A separate recording of the same building: ${e.days} days, ${e.assets.length} machines, ${e.queue_days} days with work outstanding.`}
          >
            {e.era}
          </button>
        ))}
        <span className={styles.hint}>
          drag the bar above to move through the recording · ← → a day
        </span>
      </div>

      {showKey && faults && (
        <div className={styles.drawer}>
          <div className={styles.warn}>
            <strong>You are now looking at the answers.</strong> The faults in these
            recordings were introduced deliberately, so we know exactly what broke and
            when. The part of the system that does the detecting is not allowed to know —
            it signs in to the database as a user with no permission to read these records
            at all. Jump to any fault below to watch it being found.
          </div>

          <div className={styles.drawerRow}>
            <select
              className={styles.select}
              value=""
              onChange={(e) => {
                const f = faults.find((x) => x.scenario_id === e.target.value);
                // Landing one day BEFORE the injection, not on it. The interesting thing
                // to watch is the system not knowing yet, and landing on the onset skips
                // exactly that.
                if (f) set(addDays(new Date(f.t_onset), -1));
              }}
            >
              <option value="">jump to the day before a fault was introduced…</option>
              {faults.map((f) => (
                <option key={f.scenario_id} value={f.scenario_id}>
                  {f.fault_mode.replace(/_/g, " ")} · {f.asset_id} ·{" "}
                  {f.t_onset.slice(0, 10)}
                </option>
              ))}
            </select>

            {active.length > 0 ? (
              <div className={styles.active}>
                {active.map((f) => (
                  <span key={f.scenario_id} className={styles.chip}>
                    {f.fault_mode.replace(/_/g, " ")}
                    {f.ladder.length > 1 && (
                      <span className={styles.rungs}>
                        {f.ladder.map((r) => {
                          const when = momentAtSeverity(f, r.level);
                          return (
                            <button
                              key={r.level}
                              title={`${r.label} — jump to where the trajectory reached this rung`}
                              onClick={() => when && set(when)}
                            >
                              {r.level}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <span className={styles.none}>nothing injected at this moment</span>
            )}
          </div>
        </div>
      )}

      {!faults && (
        <div className={styles.offline}>
          The answer-key service is not running, so the timeline has dates but no fault
          spans. Start it with <code>make reveal</code>. Nothing else needs it.
        </div>
      )}
      </div>
    </div>
  );
}
