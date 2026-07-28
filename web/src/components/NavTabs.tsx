import { NavLink } from "react-router-dom";

import styles from "./NavTabs.module.css";

/**
 * The screen switcher, in the order of the argument.
 *
 * WHAT CHANGED AND WHY. These tabs used to be named after the parts of the system that
 * produce them — Operations, Twin, Engine, Diagnosis, Prediction, Reveal, Configuration.
 * Six of those seven are internal architecture words promoted to the top of the screen,
 * and only one of them names something a person who does not already know this codebase
 * could act on. A viewer arriving cold had to open tabs to find out what they were.
 *
 * Every label is now a plain-language claim or question. "Engine" became "How we know",
 * which is not a rename so much as an admission of what that screen was always for.
 *
 * THE ORDER IS THE ARGUMENT, not the architecture. Something is wrong → here is where it
 * is → here is how we know → here is which kind of fault it is → here is how long it has
 * → here are the rules we judged it by → and only then, here is what was actually
 * broken. Read left to right it is a case being made. The old order was roughly the
 * layering of the codebase, which is useful to nobody but the person who wrote it.
 *
 * THE ANSWER IS SET APART. It is served by a different process on a different credential
 * and it is the one screen that gives the game away, so it sits after a divider rather
 * than in the run of operator screens. The separation is the honest signal that it is a
 * different kind of thing, not decoration.
 */

interface Tab {
  to: string;
  label: string;
  /** A one-line hint on hover. Never required reading — the label has to stand alone. */
  hint: string;
}

const TABS: Tab[] = [
  {
    to: "/",
    label: "Needs doing",
    hint: "What is wrong with the building, in the order it should be fixed",
  },
  {
    to: "/building",
    label: "The building",
    hint: "Where each fault sits in the plant, and what is connected to what",
  },
  {
    to: "/how-we-know",
    label: "How we know",
    hint: "Every reading the system threw away on the way to a finding, and why",
  },
  {
    to: "/sensor-or-machine",
    label: "Sensor or machine",
    hint: "Telling a broken instrument from broken equipment, and what it is worth",
  },
  {
    to: "/time-left",
    label: "Time left",
    hint: "How long a machine has, how sure we are, and how wrong we were",
  },
  {
    to: "/rules",
    label: "The rules",
    hint: "Every threshold in the system and the physical reason for it",
  },
];

/** Served by a separate process on the admin credential. Kept visibly apart. */
const ANSWER: Tab = {
  to: "/answer",
  label: "The answer",
  hint: "What was actually broken — the ground truth, hidden behind a click",
};

interface Props {
  /**
   * Re-enters the guided path. Omitted when there is no run list to build a tour from,
   * in which case the offer is simply not made rather than made and then failing.
   */
  onStartTour?: () => void;
}

export function NavTabs({ onStartTour }: Props) {
  return (
    <nav className={styles.tabs} aria-label="screens">
      {onStartTour && (
        <button className={styles.tour} onClick={onStartTour}>
          ▸ Walk me through it
        </button>
      )}

      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          title={tab.hint}
          className={({ isActive }) => (isActive ? styles.on : styles.tab)}
        >
          {tab.label}
        </NavLink>
      ))}

      <span className={styles.spacer} />

      <NavLink
        to={ANSWER.to}
        title={ANSWER.hint}
        className={({ isActive }) => (isActive ? styles.answerOn : styles.answer)}
      >
        {ANSWER.label}
      </NavLink>
    </nav>
  );
}
