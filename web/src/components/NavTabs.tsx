import { NavLink } from "react-router-dom";

import styles from "./NavTabs.module.css";

/**
 * The screen switcher.
 *
 * Real links, not buttons, because they are real URLs now — a demonstration can be
 * paused mid-flow and the address pasted to somebody else, and a reviewer can open the
 * screen you told them about instead of being told how to click to it.
 *
 * Screens not yet built were listed and disabled rather than hidden, so the shape of
 * Phase 1 was visible from the first screen and no tab moved sideways as the next one
 * landed. As of checkpoint 1.12 every one of them is built, so `ready` is true
 * throughout — the flag stays because Phase 2 adds more.
 */

interface Tab {
  to: string;
  label: string;
  ready: boolean;
}

const TABS: Tab[] = [
  { to: "/", label: "Operations", ready: true },
  { to: "/twin", label: "Twin", ready: true },
  { to: "/engine", label: "Engine", ready: true },
  { to: "/diagnosis", label: "Diagnosis", ready: true },
  { to: "/prediction", label: "Prediction", ready: true },
  { to: "/reveal", label: "Reveal", ready: true },
  { to: "/config", label: "Configuration", ready: true },
];

export function NavTabs() {
  return (
    <nav className={styles.tabs}>
      {TABS.map((tab) =>
        tab.ready ? (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) => (isActive ? styles.on : styles.tab)}
          >
            {tab.label}
          </NavLink>
        ) : (
          <span key={tab.to} className={styles.pending} title="not built yet">
            {tab.label}
          </span>
        ),
      )}
    </nav>
  );
}
