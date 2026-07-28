import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { GLOSSARY } from "../lib/glossary.ts";
import type { TermId } from "../lib/glossary.ts";
import styles from "./Term.module.css";

/**
 * A domain word that carries its own definition.
 *
 * THE ONE COMPONENT THIS REDESIGN TURNS ON. This project has to define its vocabulary —
 * approach temperature, part-load ratio, lift, isotonic regression — and the only way it
 * could before was an opening paragraph on every screen. Attaching the definition to the
 * word instead means the screen can lead with the finding rather than with a lesson.
 *
 * RENDERED THROUGH A PORTAL, not as an absolutely positioned child. Terms appear inside
 * tables that scroll sideways and inside panels that clip their overflow, and a tooltip
 * positioned within the flow gets cut off by both. Going out to document.body and
 * positioning from a measured rectangle is the only version that cannot be clipped by
 * an ancestor it knows nothing about.
 *
 * OPENS ON HOVER AND ON FOCUS. Hover alone would make every definition in the build
 * unreachable by keyboard and unreachable on a touchscreen; it is a real <button>, so
 * tab reaches it and tap opens it. Escape closes, because a tooltip that can only be
 * dismissed by finding somewhere else to point is a trap.
 */

interface Props {
  id: TermId;
  /** Defaults to the glossary's own spelling of the word. */
  children?: ReactNode;
  /** Set when the term is already inside small print and must not grow it. */
  quiet?: boolean;
}

/** Distance from the trigger to the bubble, and the margin kept from the viewport edge. */
const GAP = 8;
const EDGE = 12;

export function Term({ id, children, quiet = false }: Props) {
  const entry = GLOSSARY[id];
  const anchor = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; above: boolean } | null>(
    null,
  );

  /**
   * Position from measured rectangles rather than from CSS. Prefers to sit above the
   * word — a bubble below covers the line you are reading next — and flips underneath
   * only when there is not room above. Horizontally it is centred on the word and then
   * pulled back inside the viewport, so a term at the right-hand edge of a wide table
   * still shows its whole definition.
   */
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const b = bubble.current?.getBoundingClientRect();
    if (!a || !b) return;

    const above = a.top >= b.height + GAP + EDGE;
    const top = above ? a.top - b.height - GAP : a.bottom + GAP;

    const wanted = a.left + a.width / 2 - b.width / 2;
    const left = Math.min(
      Math.max(wanted, EDGE),
      Math.max(EDGE, window.innerWidth - b.width - EDGE),
    );
    setBox({ top, left, above });
  }, []);

  // Measured after the bubble is in the DOM but before the browser paints it, so it
  // never appears at 0,0 for a frame and then jumps to where it belongs.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture on scroll: a bubble measured against a page that has since moved is
    // pointing at the wrong word, and closing is more honest than chasing it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={quiet ? styles.quiet : styles.term}
        aria-describedby={open ? `term-${id}` : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // A term inside a clickable table row must not also trigger the row.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children ?? entry.term}
      </button>

      {open &&
        createPortal(
          <div
            ref={bubble}
            id={`term-${id}`}
            role="tooltip"
            className={styles.bubble}
            style={{
              top: box?.top ?? -9999,
              left: box?.left ?? -9999,
              // Hidden until measured. Without this the first paint of a bubble whose
              // height is not yet known lands in the wrong place and visibly corrects.
              visibility: box ? "visible" : "hidden",
            }}
            data-above={box?.above ? "" : undefined}
          >
            <span className={styles.word}>{entry.term}</span>
            <span className={styles.definition}>{entry.short}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
