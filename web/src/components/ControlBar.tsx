import { useEffect, useRef } from "react";

import {
  SPEEDS,
  addDays,
  daysBetween,
  eraAt,
  faultsActiveAt,
  momentAtPosition,
  momentAtSeverity,
  positionInEra,
  step,
} from "../lib/clock.ts";
import type { Speed } from "../lib/clock.ts";
import type { ClockRange, InjectedFault } from "../types.ts";
import styles from "./ControlBar.module.css";

/**
 * The clock, and everything that moves it.
 *
 * Persistent across every screen, because every screen shows one moment and they must
 * all show the SAME moment. Holding this in one place is what stops the queue and the
 * building drawing disagreeing about what day it is.
 *
 * The scrubber moves in days. Everything it drives is computed once a day, so a finer
 * control would slide without changing anything on screen, which teaches a viewer that
 * the control does nothing.
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
   * ONLY — which fault is in which run, and where its severity rungs fall. The bar
   * works without it, in dates alone, and nothing on the operator's side of the
   * dashboard reads it.
   */
  faults: InjectedFault[] | null;
}

export function ControlBar({ range, clock, onChange, faults }: Props) {
  const era = eraAt(range, clock.at);
  const active = faults ? faultsActiveAt(faults, clock.at) : [];

  // One interval, restarted whenever the speed changes or play stops. Kept in a ref
  // rather than in state because the tick must not itself cause a re-render loop.
  const tick = useRef<number | null>(null);
  useEffect(() => {
    if (!clock.playing) return;
    tick.current = window.setInterval(() => {
      const next = step(range, clock.at, clock.speed);
      // Stopping at the end of a run rather than rolling into the next one: two runs
      // are two simulations of the same building, and rolling would empty and refill
      // the queue for no reason a viewer could see.
      onChange({ ...clock, at: next.at, playing: !next.atEnd });
    }, 1000);
    return () => {
      if (tick.current !== null) window.clearInterval(tick.current);
    };
  }, [clock, range, onChange]);

  const set = (at: Date) => onChange({ ...clock, at });

  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <button
          className={styles.play}
          onClick={() => onChange({ ...clock, playing: !clock.playing })}
          disabled={!era}
        >
          {clock.playing ? "❚❚ pause" : "▶ play"}
        </button>

        <div className={styles.speeds}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={s === clock.speed ? styles.speedOn : styles.speed}
              onClick={() => onChange({ ...clock, speed: s })}
            >
              {s}d/s
            </button>
          ))}
        </div>

        <div className={styles.stamp}>
          <span className={styles.date}>
            {clock.at.toISOString().slice(0, 10)}
          </span>
          <span className={styles.muted}>
            {era ? `run of ${era.era}` : "between runs"}
            {era && ` · day ${daysBetween(new Date(era.t_from), clock.at) + 1} of ${era.days}`}
          </span>
        </div>

        <div className={styles.nudge}>
          <button onClick={() => set(step(range, clock.at, -7).at)}>−7d</button>
          <button onClick={() => set(step(range, clock.at, -1).at)}>−1d</button>
          <button onClick={() => set(step(range, clock.at, 1).at)}>+1d</button>
          <button onClick={() => set(step(range, clock.at, 7).at)}>+7d</button>
        </div>

        <select
          className={styles.select}
          value={era ? era.era : ""}
          onChange={(e) => {
            const chosen = range.eras.find((x) => x.era === Number(e.target.value));
            if (chosen) set(new Date(chosen.t_from));
          }}
        >
          {range.eras.map((e) => (
            <option key={e.era} value={e.era}>
              run of {e.era} · {e.days}d · {e.assets.length} machines
            </option>
          ))}
        </select>
      </div>

      {era && (
        <input
          className={styles.scrub}
          type="range"
          min={0}
          max={1000}
          value={Math.round(positionInEra(era, clock.at) * 1000)}
          onChange={(e) => set(momentAtPosition(era, Number(e.target.value) / 1000))}
          aria-label="position in this run"
        />
      )}

      {faults && (
        <div className={styles.row}>
          <span className={styles.key}>answer key</span>
          <select
            className={styles.select}
            value=""
            onChange={(e) => {
              const f = faults.find((x) => x.scenario_id === e.target.value);
              // Jumping to a fault lands one day BEFORE it was injected, not on the
              // day itself. The interesting thing to watch is the system not knowing
              // yet, and landing on the onset skips it.
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
            <span className={styles.muted}>
              nothing injected at this moment
            </span>
          )}
        </div>
      )}

      {!faults && (
        <div className={styles.muted}>
          The reveal service is not running, so the bar has dates but no fault names.
          Start it with <code>make reveal</code>. Nothing else on this dashboard needs
          it.
        </div>
      )}
    </div>
  );
}
