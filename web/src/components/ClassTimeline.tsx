import { useState } from "react";

import { CLASS_COLOUR } from "../lib/format.ts";
import type { ClassChange } from "../types.ts";
import * as C from "../design/palette.ts";
import styles from "./ClassTimeline.module.css";

/**
 * How a fault's classification changed as evidence accumulated.
 *
 * WHY THIS IS HERE AT ALL. The advisory queue shows one class per fault and reads as a
 * system that was always right. It was not: on this data the drifting thermometer is
 * called EQUIPMENT for ten days and SENSOR for the last three. That is not instability
 * to be hidden — it is the reconciliation refusing to name a suspect until one biased
 * reading actually explains the violations, and a classifier that committed on day one
 * would have been confidently wrong for ten days.
 *
 * Each day is a block; hovering gives the reason recorded that day.
 */

interface Props {
  history: ClassChange[];
  faultId: string;
}

export function ClassTimeline({ history, faultId }: Props) {
  const [open, setOpen] = useState<ClassChange | null>(null);
  if (history.length === 0) return null;

  const runs: { fault_class: string; days: ClassChange[] }[] = [];
  for (const entry of history) {
    const last = runs[runs.length - 1];
    if (last && last.fault_class === entry.fault_class) last.days.push(entry);
    else runs.push({ fault_class: entry.fault_class, days: [entry] });
  }
  const changed = runs.length > 1;
  const shown = open ?? history[history.length - 1]!;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>
          {faultId} over {history.length} day{history.length === 1 ? "" : "s"}
        </span>
        <span className={styles.muted}>
          {changed
            ? `${runs.length} different answers — the classifier changed its mind`
            : "one answer throughout"}
        </span>
      </div>

      <div className={styles.track}>
        {history.map((entry) => (
          <button
            key={entry.day}
            className={entry === shown ? styles.blockOn : styles.block}
            style={{
              background:
                CLASS_COLOUR[entry.fault_class as keyof typeof CLASS_COLOUR] ?? C.inkMuted,
            }}
            title={`${entry.day.slice(0, 10)} — ${entry.fault_class}`}
            onMouseEnter={() => setOpen(entry)}
            onFocus={() => setOpen(entry)}
            onClick={() => setOpen(entry)}
          />
        ))}
      </div>

      <div className={styles.runs}>
        {runs.map((run) => (
          <span key={run.days[0]!.day} className={styles.run}>
            <span
              className={styles.dot}
              style={{
                background:
                  CLASS_COLOUR[run.fault_class as keyof typeof CLASS_COLOUR] ?? C.inkMuted,
              }}
            />
            {run.fault_class} · {run.days.length} day
            {run.days.length === 1 ? "" : "s"} from {run.days[0]!.day.slice(0, 10)}
          </span>
        ))}
      </div>

      <p className={styles.reason}>
        <span className={styles.stamp}>{shown.day.slice(0, 10)}</span>
        {shown.class_reason || "no reason recorded that day"}
      </p>
    </div>
  );
}
