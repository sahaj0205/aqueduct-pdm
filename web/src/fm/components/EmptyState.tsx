import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

/**
 * Two different messages that both render as "nothing here" — because they mean
 * different things. `good` is the correct answer ("nothing needs attention"); the
 * default is a gap ("nothing is set up yet"). Conflating them is how a healthy queue
 * and a broken data feed end up looking identical.
 */
export function EmptyState({
  title,
  children,
  good = false,
}: {
  title: string;
  children?: ReactNode;
  good?: boolean;
}) {
  return (
    <div className={`${styles.wrap} ${good ? styles.good : ""}`}>
      <div className={styles.title}>{title}</div>
      {children && <p className={styles.sub}>{children}</p>}
    </div>
  );
}
