import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { TourStep } from "../lib/tour.ts";
import styles from "./Walkthrough.module.css";

/**
 * The guided path: one claim, one sentence, and a way onward.
 *
 * WHAT IT IS FOR. Somebody meeting this system cold should not have to choose a tab and
 * hope. This drives the screen and the clock together, in the order the argument runs,
 * and says at each stop what to look at and why it matters.
 *
 * IT DRIVES THE REAL SCREENS. There is no separate presentation build and no screenshots
 * — each step navigates to the same route the tabs navigate to and moves the same shared
 * clock every screen already reads. Anything the viewer sees on the tour, they can go and
 * poke at afterwards, which is the whole reason for having an Explore mode to leave into.
 *
 * THE VIEWER IS NEVER TRAPPED. Leaving is always one click, the step counter says how
 * much is left, and arrow keys work. A guided mode that hides the exit is a slideshow
 * wearing an application as a costume.
 */

interface Props {
  steps: TourStep[];
  index: number;
  onIndex: (next: number) => void;
  onExit: () => void;
  /** Moves the shared clock. Called only for steps that name a moment. */
  onMoment: (at: Date) => void;
}

export function Walkthrough({ steps, index, onIndex, onExit, onMoment }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const step = steps[index];

  // Navigation and the clock are effects of the step, not of clicking "next" — so
  // arriving at a step by any route puts the viewer in the same place. The pathname is
  // checked first, because navigating to where you already are would otherwise push a
  // history entry on every render.
  useEffect(() => {
    if (!step) return;
    if (location.pathname !== step.to) navigate(step.to);
    if (step.at) onMoment(step.at);
    // Deliberately depends on the step alone. `onMoment` sets the clock, setting the
    // clock re-renders the shell, and a fresh handler each render would re-run this and
    // set the clock again — so listing it here would be a loop rather than correctness.
    // There is no linter in this project to tell either way; the reasoning is the check.
  }, [index, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while somebody is typing into something, and not when a modifier is held —
      // the clock's own arrow-key handling lives on the timeline.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" && index < steps.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, steps.length, onIndex, onExit]);

  if (!step) return null;
  const last = index === steps.length - 1;

  return (
    <section className={styles.bar} aria-label="walkthrough">
      <div className={styles.progress}>
        {steps.map((s, i) => (
          <button
            key={s.title}
            className={i === index ? styles.pipOn : i < index ? styles.pipDone : styles.pip}
            onClick={() => onIndex(i)}
            aria-label={`step ${i + 1}: ${s.title}`}
            aria-current={i === index}
          />
        ))}
      </div>

      <div className={styles.body}>
        <div className={styles.text}>
          <span className={styles.count}>
            Step {index + 1} of {steps.length}
          </span>
          <h2 className={styles.title}>{step.title}</h2>
          <p className={styles.say}>{step.say}</p>
        </div>

        <div className={styles.controls}>
          <button className={styles.exit} onClick={onExit}>
            Explore on my own
          </button>
          <div className={styles.moves}>
            <button
              className={styles.back}
              onClick={() => onIndex(index - 1)}
              disabled={index === 0}
            >
              ‹ Back
            </button>
            <button
              className={styles.next}
              onClick={() => (last ? onExit() : onIndex(index + 1))}
            >
              {last ? "Finish" : "Next ›"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
