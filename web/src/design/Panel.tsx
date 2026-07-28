import type { ReactNode } from "react";

import styles from "./Panel.module.css";

/**
 * A titled surface, with somewhere for the explanation to go that is not the page.
 *
 * WHY IT EXISTS. Every section in this build wrote its own header — a flex row, a
 * fifteen-pixel h2, an eleven-and-a-half-pixel grey span — and eighty-one inline style
 * blocks are mostly that header, written out again slightly differently each time. One
 * component means one answer to how far a title sits from its content, which is most of
 * what makes a set of screens feel composed rather than assembled.
 *
 * THE `why` SLOT IS THE POINT. It is where the paragraph that used to open the screen
 * now lives — folded shut, one click away, still in the product. This build's
 * explanatory prose is genuinely worth keeping; it just should not be the first thing
 * between the reader and the finding.
 */

interface Props {
  title?: ReactNode;
  /** One short line under the title. Not a paragraph — if it wraps twice, use `why`. */
  sub?: ReactNode;
  /** Controls belonging to this panel, set to the right of the title. */
  action?: ReactNode;
  /** Folded-shut explanation, opened from a marker beside the title. */
  why?: ReactNode;
  /** Label on the disclosure. Defaults to asking the question the reader would ask. */
  whyLabel?: string;
  /** Content manages its own padding — for tables and drawings that run to the edge. */
  flush?: boolean;
  /** No border, no lift. For grouping without drawing another box. */
  bare?: boolean;
  children: ReactNode;
}

export function Panel({
  title,
  sub,
  action,
  why,
  whyLabel = "how this works",
  flush = false,
  bare = false,
  children,
}: Props) {
  const hasHead = Boolean(title || sub || action || why);

  return (
    <section className={bare ? styles.bare : styles.panel}>
      {hasHead && (
        <header className={styles.head}>
          <div className={styles.heading}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {sub && <p className={styles.sub}>{sub}</p>}
          </div>
          <div className={styles.tools}>
            {action}
            {why && <Why label={whyLabel}>{why}</Why>}
          </div>
        </header>
      )}
      <div className={flush ? styles.flush : styles.body}>{children}</div>
    </section>
  );
}

/**
 * A disclosure holding an explanation, shut by default.
 *
 * Built on native <details>, not on a state flag and a conditional. The native element
 * is reachable by keyboard, announced correctly by a screen reader, and findable by the
 * browser's own in-page search even while it is closed — which matters here, because
 * what is folded away is the justification for a number somebody may be trying to
 * check.
 */
export function Why({ label = "why", children }: { label?: string; children: ReactNode }) {
  return (
    <details className={styles.why}>
      <summary className={styles.summary}>
        <span className={styles.marker} aria-hidden="true">
          ?
        </span>
        {label}
      </summary>
      <div className={styles.explanation}>{children}</div>
    </details>
  );
}
