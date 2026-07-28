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

export function ControlBar({ range, clock, onChange, faults }: Props) {
  const era = eraAt(range, clock.at);
  const [showKey, setShowKey] = useState(false);
  const active = faults && showKey ? faultsActiveAt(faults, clock.at) : [];

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
    <div className={styles.bar}>
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
              ? `day ${daysBetween(new Date(era.t_from), clock.at) + 1} of ${era.days} in the run of ${era.era}`
              : "between runs"}
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
              title="Reveals the ground truth on the timeline. Off by default."
            >
              demo tools
            </button>
          )}
        </div>
      </div>

      {era && (
        <Timeline
          era={era}
          at={clock.at}
          onSeek={set}
          faults={showKey ? faults : null}
        />
      )}

      <div className={styles.runs}>
        <span className={styles.runsLabel}>runs</span>
        {range.eras.map((e) => (
          <button
            key={e.era}
            className={era?.era === e.era ? styles.runOn : styles.run}
            onClick={() => set(new Date(e.t_from))}
            title={`${e.days} days · ${e.assets.length} machines · ${e.queue_days} days with a queue`}
          >
            {e.era}
          </button>
        ))}
        <span className={styles.hint}>
          click or drag the track · ← → a day · shift ← → a week
        </span>
      </div>

      {showKey && faults && (
        <div className={styles.drawer}>
          <div className={styles.warn}>
            These controls read the <strong>answer key</strong> — the ground truth every
            detection screen is denied. Nothing else on this dashboard can see it.
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
              <option value="">jump to a fault…</option>
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
          The reveal service is not running, so the timeline has dates but no fault
          spans. Start it with <code>make reveal</code>. Nothing else needs it.
        </div>
      )}
    </div>
  );
}
