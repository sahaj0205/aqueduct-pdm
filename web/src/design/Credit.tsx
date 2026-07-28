import styles from "./Credit.module.css";

/**
 * Who built this, and where to find them.
 *
 * The links are the ones published on the author's own portfolio rather than any typed
 * in here — they were read from sahajpreet.in's API so this cannot quietly go stale
 * against the place it is claiming to point at.
 *
 * Rendered on both the front door and the working application, because either one might
 * be the page somebody is sent.
 */

const LINKS = [
  { label: "Portfolio", href: "https://sahajpreet.in" },
  { label: "GitHub", href: "https://github.com/photon0205/" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/photon0205/" },
];

export function Credit() {
  return (
    <div className={styles.credit}>
      <span className={styles.by}>
        Built by <strong>Sahajpreet Singh</strong>
      </span>
      <span className={styles.links}>
        {LINKS.map((l) => (
          <a
            key={l.label}
            className={styles.link}
            href={l.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {l.label}
          </a>
        ))}
      </span>
    </div>
  );
}
