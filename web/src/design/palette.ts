/**
 * The same palette as tokens.css, as literal strings.
 *
 * WHY IT HAS TO BE DUPLICATED, which is the only reason this file exists. Six components
 * in this build draw SVG, and they set colour as a `fill` or `stroke` ATTRIBUTE rather
 * than through a CSS class. That is deliberate and load-bearing: scripts/verify-twin.ts
 * writes the building drawing out to a standalone .svg file and opens it on its own, and
 * a var(--x) reference in that file resolves against nothing and arrives colourless.
 *
 * So these cannot be `var(--info)`. They have to be the literal `#1d4ed8`.
 *
 * WHAT THIS FILE REPLACED. Seventy-one literal hex codes spread across eight files, with
 * no two agreeing on what "the muted one" was — #8d9bad in five places, #63707f in
 * seven, four different greys for a chart gridline. Changing the theme meant finding all
 * seventy-one. Now it means changing this file and tokens.css together, and the pairing
 * is stated at the top of each block so a value cannot drift out of step silently.
 *
 * IF YOU EDIT ONE, EDIT BOTH. There is no way to enforce that from inside the type
 * system, so the two files name each other and each token below carries the CSS custom
 * property it mirrors.
 */

/** Surfaces. Mirrors --paper / --canvas-soft / --sunken / --hairline / --hairline-strong. */
export const paper = "#ffffff";
export const raised = "#ffffff";
export const sunken = "#f6f9fc";
export const hairline = "#e3e8ee";
export const hairlineStrong = "#a8c3de";

/** Ink. Mirrors --ink / --ink-muted / --ink-faint. */
export const ink = "#0d253d";
export const inkMuted = "#273951";
export const inkFaint = "#64748d";

/** The single chromatic accent. Mirrors --primary. */
export const info = "#533afd";

/**
 * SEVERITY, from DESIGN_SEMANTIC.md. Red, orange, gold, slate — four tiers, and
 * deliberately NOT red-amber-green: around eight per cent of men have red-green colour
 * deficiency, and a scale whose two ends collapse into each other for one reader in
 * twelve is not a scale. Each tier carries its own text colour because a gold fill needs
 * dark ink and a red fill needs white.
 */
export const critical = "#da1e28";
export const high = "#ff832b";
export const medium = "#f1c21b";
export const low = "#64748d";

export const criticalWash = "#fdecec";
export const highWash = "#fff2e8";
export const mediumWash = "#fcf5da";
export const lowWash = "#f6f9fc";

export const criticalInk = "#a2191f";
export const highInk = "#8a3800";
export const mediumInk = "#684e00";
export const lowInk = "#445068";

/* Names the components written against the previous palette still resolve through. */
export const good = low;
export const caution = high;
export const alarm = critical;
export const goodWash = lowWash;
export const cautionWash = highWash;
export const alarmWash = criticalWash;
export const infoWash = "#eeecff";
export const goodInk = lowInk;
export const cautionInk = highInk;
export const alarmInk = criticalInk;
export const infoInk = "#4434d4";

/** Text set on a saturated fill. Always white — see the note in tokens.css. */
export const onFill = "#ffffff";

/**
 * The four states a drawn component can be in.
 *
 * Moved here from lib/format.ts, which is where it lived when the drawing was the only
 * thing that needed it. Two pictures of the same building that disagreed about what
 * amber means would be worse than one picture, and now three components read this.
 *
 * THE FILL IS CONSTANT UNTIL SOMETHING IS ACTUALLY WRONG. Every node used to take a
 * tinted fill from its band, which meant thirty-one boxes in five colours — the drawing
 * read as confetti and the two machines that genuinely needed attention were no louder
 * than the twenty-nine that did not. A machine in condition, a machine nobody has scored
 * and a machine merely worth watching now all sit on the plain canvas; only degraded and
 * critical take a tint, and `watch` gets a coloured border alone.
 *
 * That is still the health band scale the semantic specification asks for — the tiers are
 * unchanged and a node's band still decides how it is drawn. What changed is how much ink
 * the quiet end of the scale is allowed to spend.
 */
export const NODE = {
  unknown: { fill: paper, stroke: hairline, text: inkFaint },
  healthy: { fill: paper, stroke: hairlineStrong, text: ink },
  watch: { fill: paper, stroke: medium, text: ink },
  degraded: { fill: highWash, stroke: high, text: highInk },
  critical: { fill: criticalWash, stroke: critical, text: criticalInk },
} as const;

/**
 * What a fault is blamed on. Read before anything else on an advisory row, because it
 * decides which van goes out — an instrument needs a calibration kit and a machine needs
 * a wrench, and sending the wrong one costs the difference between the two.
 */
/**
 * FAULT CLASS. Deliberately desaturated and identical in hue across all four — the
 * semantic specification is explicit that these classify rather than alarm, and that the
 * icon carries the distinction. Giving each one a colour would put them in competition
 * with the severity scale, which is the thing that IS allowed to shout.
 */
export const CLASS = {
  sensor: inkMuted,
  equipment: inkMuted,
  control: inkMuted,
  ambiguous: inkFaint,
} as const;

/**
 * The same four fault classes as a fill, a border and a text colour.
 *
 * Needed because the building drawing can be painted by blame as well as by condition,
 * and a drawn node is a tinted box with a saturated border rather than a solid colour —
 * see NODE above for why. CLASS on its own gives only the saturated value, which is
 * correct for a badge and far too loud for a box the size of a machine.
 */
export const CLASS_PAINT = {
  sensor: { fill: paper, stroke: hairlineStrong, text: inkMuted },
  equipment: { fill: paper, stroke: hairlineStrong, text: inkMuted },
  control: { fill: paper, stroke: hairlineStrong, text: inkMuted },
  ambiguous: { fill: paper, stroke: "#c9d6e4", text: inkFaint },
} as const;

/** Chart furniture: the parts of a plot that are not data and must not read as data. */
export const CHART = {
  /** The plot area itself. */
  surface: paper,
  /** Gridlines and axis rules — present, never noticed. */
  grid: hairline,
  /** An axis line or a tick that has to be followed. */
  axis: hairlineStrong,
  /** Axis numbers. */
  tick: inkFaint,
  /** An axis title or a series label. */
  label: inkMuted,
} as const;
