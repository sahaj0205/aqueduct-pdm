import { NavLink, Outlet } from "react-router-dom";

import { Mark } from "../design/Mark.tsx";
import { BRAND } from "../lib/brand.ts";
import { VantagePicker } from "./components/VantagePicker.tsx";
import { getOverview } from "./data/client.ts";
import { useData } from "./data/useData.ts";
import styles from "./Shell.module.css";

/**
 * The shell every screen sits inside: a fixed sidebar and a scrolling content pane.
 *
 * WHY A SIDEBAR AND NOT TOP TABS. This is a tool a facility manager opens every
 * morning and leaves open — eight surfaces is one more than a tab bar reads
 * comfortably, and a persistent nav with live counts on it (how many things need
 * attention, right now) is the thing that makes "open the app" answer a question
 * before a single screen has rendered.
 *
 * COUNTS ARE FETCHED HERE, ONCE, rather than each nav item computing its own — every
 * badge on this sidebar comes from the same `Overview` read the landing screen uses,
 * so the sidebar and the screen it points at can never disagree about how many open
 * items there are.
 */

interface NavItem {
  to: string;
  label: string;
  badge?: number;
  alert?: boolean;
}

export function Shell() {
  const { data: overview } = useData(getOverview);

  const items: NavItem[] = [
    { to: "/fm", label: "Overview" },
    { to: "/fm/worklist", label: "Worklist", badge: overview?.open_total },
    { to: "/fm/assets", label: "Assets" },
    { to: "/fm/schedule", label: "Schedule" },
    {
      to: "/fm/instruments",
      label: "Instruments",
      badge: overview?.sensor_advisories_total,
      alert: Boolean(overview?.sensor_advisories_total),
    },
    { to: "/fm/record", label: "Track Record" },
  ];

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <NavLink to="/fm" end className={styles.brand}>
          <Mark size={22} />
          <span className={styles.brandName}>{BRAND.name}</span>
        </NavLink>

        <nav className={styles.nav}>
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/fm"}
              className={({ isActive }) => (isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink)}
            >
              <span className={styles.navLabel}>{item.label}</span>
              {item.badge !== undefined && item.badge > 0 && (
                <span className={`${styles.navBadge} ${item.alert ? styles.navBadgeAlert : ""}`}>{item.badge}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className={styles.footer}>
          <div className={styles.user}>
            <span className={styles.userName}>J. Okafor</span>
            <span className={styles.userRole}>Facility Manager</span>
          </div>
        </div>
      </aside>

      <div className={styles.main}>
        <div className={styles.mainInner}>
          {/* The utility bar. Deployment-level controls only — nothing an operator acts
              on lives here, which is why it sits above the screen rather than in the
              navigation. */}
          <div className={styles.utility}>
            <VantagePicker />
          </div>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
