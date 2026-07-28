import type { ReactNode } from "react";

import { Why } from "./Panel.tsx";
import styles from "./ScreenHead.module.css";

/**
 * The claim a screen opens with, in the largest type on that screen.
 *
 * RULE ONE OF THIS REDESIGN. Every screen states what you are looking at, as a plain
 * sentence, before it shows you anything. Before this, a screen opened with its
 * internal name — "The engine", "Configuration", "Prediction" — set at fifteen pixels,
 * which tells a reader who already knows the system nothing they did not know and tells
 * everyone else nothing at all.
 *
 * A HEADLINE IS A CLAIM, NOT A NOUN. "Configuration" is a filing label. "Every number in
 * this system, and why it is that number" is an assertion the screen then has to make
 * good on. Writing the headline first is what forces each screen to have a point.
 *
 * NUMBERS IN A HEADLINE MUST BE LIVE. Several of these headlines carry a figure — how
 * many things need attention, how far apart two repair bills are. Those are passed in
 * from the data, never written into the string, because the clock moves and a headline
 * that says "six" while the queue below it shows two is worse than no headline.
 *
 * THE `why` SLOT is where a screen's opening paragraph goes. Three screens used to begin
 * with one; the text is worth keeping and was never worth leading with.
 */

interface Props {
  /** The claim. Plain language, no identifiers, ideally under twelve words. */
  children: ReactNode;
  /** One short supporting line. If it wraps more than twice it belongs in `why`. */
  sub?: ReactNode;
  /** The explanation, folded shut. */
  why?: ReactNode;
  whyLabel?: string;
}

export function ScreenHead({ children, sub, why, whyLabel = "how this works" }: Props) {
  return (
    <header className={styles.head}>
      <div className={styles.text}>
        <h2 className={styles.claim}>{children}</h2>
        {sub && <p className={styles.sub}>{sub}</p>}
      </div>
      {why && (
        <div className={styles.aside}>
          <Why label={whyLabel}>{why}</Why>
        </div>
      )}
    </header>
  );
}
