/**
 * The mark.
 *
 * Four bars on a rising diagonal, the last one crossing a rule — a reading that has been
 * climbing and has just gone past the line. It is the shape of every chart in this
 * product reduced to eight strokes.
 *
 * SQUARE, FLAT, NO CURVES. The visual language this build follows commits to zero-radius
 * geometry throughout; a rounded or organic mark would be the one thing on screen
 * disagreeing with everything else.
 *
 * Drawn in `currentColor` so it inherits whatever it is set in — charcoal on the white
 * header, white on the inverted footer — rather than needing a variant per background.
 */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {/* the threshold */}
      <path d="M1 9H23" stroke="currentColor" strokeWidth={1} opacity={0.45} />
      {/* three bars below it, one through it */}
      <rect x="2" y="16" width="4" height="6" fill="currentColor" opacity={0.45} />
      <rect x="8" y="13" width="4" height="9" fill="currentColor" opacity={0.65} />
      <rect x="14" y="11" width="4" height="11" fill="currentColor" opacity={0.85} />
      <rect x="20" y="4" width="3" height="18" fill="currentColor" />
    </svg>
  );
}
