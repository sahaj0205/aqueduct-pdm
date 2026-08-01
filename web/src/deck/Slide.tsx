/**
 * What a slide looks like.
 *
 * ONE COMPONENT FOR ALL FIFTY, driven by the row in the script rather than written out
 * slide by slide. Same decision as the walkthrough's Station, and same reason: the deck is
 * arguing that ten layers all have the same shape — each one opens by saying what is
 * already standing, does its work, and closes by saying what is now in hand — and a room
 * learns to read that shape once, in act one, and then knows where to look for the rest of
 * the presentation. Fifty bespoke layouts would hide the regularity being argued for.
 *
 * FOUR KINDS, and the difference between them is which regions render:
 *
 *   title     the cold open. Heading only, centred, no furniture.
 *   open      what is already standing, then what this act does. The orientation slide.
 *   content   heading, claim, bullets, a figure if the slide earns one, chips.
 *   close     what this act built, and what is now in hand.
 *
 * A LISTENER WHO LOST THE THREAD is picked back up at the next act boundary without
 * anybody having to stop and recap, because open and close slides say it for them.
 */

import { Figure } from "./figures/Figure.tsx";
import { type PanelRef, type Point, type Slide as SlideRow, type SlideKind, actOf } from "./deck.ts";
import styles from "./Slide.module.css";

/**
 * The class each slide kind adds, spelled out rather than looked up by `styles[kind]`.
 *
 * A CSS module exports one name per class, and three of the four kind names collide with
 * classes that already mean something inside a slide — `title` is the heading, `close`
 * would read as a dismiss control. Mapping them explicitly is what stops a kind class
 * from resolving to the same generated identifier as an unrelated element's.
 */
const KIND_CLASS: Record<SlideKind, string> = {
  title: styles.kindTitle!,
  open: styles.kindOpen!,
  content: styles.kindContent!,
  close: styles.kindClose!,
};

/**
 * Render a bullet, lighting up whatever the script marked with *asterisks*.
 *
 * WHY THE MARKER EXISTS AT ALL. This deck is read aloud. A bullet with nothing marked is a
 * bullet the presenter has to find the emphasis in halfway through saying it, which is
 * where presentations start to sound uncertain. The marked span is the word to land on.
 *
 * Split on the delimiter rather than parsing markdown: there is exactly one construct, the
 * text is authored in this repo, and a markdown dependency to bold a word would be absurd.
 */
function Marked({ text }: { text: Point }) {
  const parts = text.split(/\*([^*]+)\*/g);
  return (
    <>
      {parts.map((part, i) =>
        // Odd indices are what sat between the asterisks — that is how split with a capture
        // group interleaves. Even indices are the plain text around them.
        i % 2 === 1 ? (
          <em key={i} className={styles.key}>
            {part}
          </em>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Points({ points, className }: { points: readonly Point[]; className?: string }) {
  return (
    <ul className={className}>
      {points.map((point, i) => (
        <li key={i}>
          <Marked text={point} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The chips that open a drawer.
 *
 * DELIBERATELY UNDERSTATED. These are not calls to action — a room that felt invited to
 * click nine rules would spend the presentation in the drawer. They read as "there is more
 * here if you ask", and the presenter opens one only when somebody does.
 */
function Chips({
  panels,
  onOpen,
}: {
  panels: readonly PanelRef[];
  onOpen: (ref: PanelRef) => void;
}) {
  return (
    <div className={styles.chips}>
      <span className={styles.chipsLabel}>open</span>
      {panels.map((ref) => (
        <button
          key={`${ref.kind}:${ref.id}`}
          type="button"
          className={styles.chip}
          onClick={() => onOpen(ref)}
        >
          {ref.label}
        </button>
      ))}
    </div>
  );
}

export function Slide({
  slide,
  index,
  current,
  narrowed = false,
  onOpenPanel,
}: {
  slide: SlideRow;
  index: number;
  /** Whether this is the slide on screen. Off-slides stay mounted and hidden. */
  current: boolean;
  /**
   * True while a drawer is open and the slide has given up 460px of width.
   *
   * The figure is dropped in that state rather than shrunk. Narrowing rewraps the bullets
   * onto more lines, which is what pushed the two longest slides past their own bottom edge;
   * giving the text the full width instead makes them SHORTER, not taller. And the trade is
   * the right way round — somebody who has opened a drawer is reading the evidence, not the
   * diagram, and the diagram comes straight back when they close it.
   */
  narrowed?: boolean;
  onOpenPanel: (ref: PanelRef) => void;
}) {
  const act = actOf(index);
  const isTitle = slide.kind === "title";

  return (
    <section
      className={`${styles.slide} ${KIND_CLASS[slide.kind]} ${current ? styles.current : styles.away}`}
      aria-hidden={!current}
    >
      <header className={styles.head}>
        {!isTitle && (
          <div className={styles.meta}>
            <span className={styles.act}>{act.name}</span>
            {slide.kind === "open" && <span className={styles.tag}>where we are</span>}
            {slide.kind === "close" && <span className={styles.tag}>what we have</span>}
          </div>
        )}
        <h2 className={styles.title}>{slide.title}</h2>
        {slide.lead && <p className={styles.lead}>{slide.lead}</p>}
        {/* An open slide restates the act's question in the room's own language, so the
            next few minutes have something to be an answer to. */}
        {slide.kind === "open" && <p className={styles.question}>{act.question}</p>}
      </header>

      <div className={styles.body}>
        <div className={styles.column}>
          {/* Only on an open slide: everything already built when this act begins. Not a
              summary of the previous act — a list of what is standing, from wherever. */}
          {slide.standing && (
            <div className={styles.aside}>
              <span className={styles.asideLabel}>already standing</span>
              <Points points={slide.standing} className={styles.subPoints} />
            </div>
          )}

          {slide.points && <Points points={slide.points} className={styles.points} />}

          {/* Only on a close slide: what is in hand now that was not before. */}
          {slide.gained && (
            <div className={styles.aside}>
              <span className={styles.asideLabel}>in hand at the end of this act</span>
              <Points points={slide.gained} className={styles.subPoints} />
            </div>
          )}
        </div>

        {slide.figure && !narrowed && (
          <div className={styles.figure}>
            <Figure kind={slide.figure} />
          </div>
        )}
      </div>

      {slide.panels && <Chips panels={slide.panels} onOpen={onOpenPanel} />}
    </section>
  );
}
