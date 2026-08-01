import { useEffect, useRef, useState } from "react";

import { getVantages } from "../data/client.ts";
import { selectVantage } from "../data/mutations.ts";
import { useData } from "../data/useData.ts";
import { date } from "../lib/format.ts";
import styles from "./VantagePicker.module.css";

/**
 * Which run of the building the platform is serving.
 *
 * A DEPLOYMENT CONTROL, NOT A PRODUCT FEATURE — see the `Vantage` type for why the
 * backend has several runs rather than one continuous history. It sits in the shell's
 * utility bar rather than the navigation because a facility manager in a real
 * installation never sees it: there, exactly one vantage is pinned in configuration and
 * this control has nothing to switch between.
 *
 * Runs whose analytics have not been loaded are listed but disabled, rather than hidden.
 * Hiding them would make the dataset look smaller than it is; showing them enabled would
 * mean selecting one and quietly getting another run's numbers.
 */
export function VantagePicker() {
  const { data } = useData(getVantages);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!data) return null;
  const { vantages, selected } = data;

  return (
    <div className={styles.wrap} ref={wrap}>
      <span className={styles.label}>Run</span>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected.label} · as of {date(selected.as_of)}
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.menu} role="listbox">
          {vantages.map((v) => (
            <button
              key={v.id}
              type="button"
              role="option"
              className={styles.option}
              aria-current={v.id === selected.id}
              aria-selected={v.id === selected.id}
              disabled={!v.available}
              title={v.available ? undefined : "Analytics for this run have not been loaded into this build"}
              onClick={async () => {
                if (!v.available) return;
                await selectVantage(v.id);
                setOpen(false);
              }}
            >
              <span className={styles.optionTop}>
                <span className={styles.optionLabel}>
                  {v.label} · as of {date(v.as_of)}
                </span>
                <span className={styles.optionState}>
                  {v.id === selected.id ? "current" : v.available ? "" : "not loaded"}
                </span>
              </span>
              <span className={styles.optionNote}>{v.note}</span>
            </button>
          ))}
          <p className={styles.foot}>
            Each run is an independent 120-day simulation placed in its own calendar year, so two
            runs never write the same instrument at the same instant. A real installation pins one
            and this control does not appear.
          </p>
        </div>
      )}
    </div>
  );
}
