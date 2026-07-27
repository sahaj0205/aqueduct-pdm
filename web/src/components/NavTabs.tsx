import { NavLink } from "react-router-dom";

import styles from "./NavTabs.module.css";

/**
 * The screen switcher.
 *
 * Real links, not buttons, because they are real URLs now — a demonstration can be
 * paused mid-flow and the address pasted to somebody else, and a reviewer can open the
 * screen you told them about instead of being told how to click to it.
 *
 * Screens not yet built are listed and disabled rather than hidden. Two reasons: the
 * shape of Phase 1 is visible from the first screen, and a tab appearing later moves
 * every other tab sideways, which is exactly the sort of thing that makes a live demo
 * look unrehearsed.
 */

interface Tab {
  to: string;
  label: string;
  ready: boolean;
}

const TABS: Tab[] = [
  { to: "/", label: "Operations", ready: true },
  { to: "/twin", label: "Twin", ready: true },
  { to: "/engine", label: "Engine", ready: false },
  { to: "/prediction", label: "Prediction", ready: false },
  { to: "/reveal", label: "Reveal", ready: false },
  { to: "/config", label: "Configuration", ready: false },
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
