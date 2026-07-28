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

/** Surfaces. Mirrors --paper / --raised / --sunken / --hairline / --hairline-strong. */
export const paper = "#faf9f7";
export const raised = "#ffffff";
export const sunken = "#f2f0ec";
export const hairline = "#e4e0d9";
export const hairlineStrong = "#d6d1c7";

/** Ink. Mirrors --ink / --ink-muted / --ink-faint. */
export const ink = "#1c1917";
export const inkMuted = "#57534e";
export const inkFaint = "#78716c";

/** Meaning. Mirrors --good / --caution / --alarm / --info. */
export const good = "#15803d";
export const caution = "#b45309";
export const alarm = "#b91c1c";
export const info = "#1d4ed8";

/** Tints, for a fill sitting behind text of the matching colour. */
export const goodWash = "#ecfdf3";
export const cautionWash = "#fef6ec";
export const alarmWash = "#fef2f2";
export const infoWash = "#eef2ff";

/**
 * Text set ON a tint. Darker than the saturated colour itself, because a label inside a
 * pale green box has to clear contrast against that box and not against the page.
 */
export const goodInk = "#14532d";
export const cautionInk = "#7c2d12";
export const alarmInk = "#7f1d1d";
export const infoInk = "#1e3a8a";

/** Text set on a saturated fill. Always white — see the note in tokens.css. */
export const onFill = "#ffffff";

/**
 * The four states a drawn component can be in.
 *
 * Moved here from lib/format.ts, which is where it lived when the drawing was the only
 * thing that needed it. Two pictures of the same building that disagreed about what
 * amber means would be worse than one picture, and now three components read this.
 *
 * A tinted fill with a saturated border, rather than a saturated fill. On paper a solid
 * red box is a shout, and every node in a plant diagram shouting at once is the state
 * the old dark theme was in.
 */
export const NODE = {
  unknown: { fill: sunken, stroke: hairlineStrong, text: inkMuted },
  healthy: { fill: goodWash, stroke: good, text: goodInk },
  degrading: { fill: cautionWash, stroke: caution, text: cautionInk },
  critical: { fill: alarmWash, stroke: alarm, text: alarmInk },
} as const;

/**
 * What a fault is blamed on. Read before anything else on an advisory row, because it
 * decides which van goes out — an instrument needs a calibration kit and a machine needs
 * a wrench, and sending the wrong one costs the difference between the two.
 */
export const CLASS = {
  sensor: info,
  equipment: "#c2410c",
  control: "#6d28d9",
  ambiguous: inkMuted,
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
  sensor: { fill: infoWash, stroke: info, text: infoInk },
  equipment: { fill: "#ffedd5", stroke: "#c2410c", text: "#7c2d12" },
  control: { fill: "#ede9fe", stroke: "#6d28d9", text: "#4c1d95" },
  ambiguous: { fill: sunken, stroke: hairlineStrong, text: inkMuted },
} as const;

/** Chart furniture: the parts of a plot that are not data and must not read as data. */
export const CHART = {
  /** The plot area itself. */
  surface: raised,
  /** Gridlines and axis rules — present, never noticed. */
  grid: hairline,
  /** An axis line or a tick that has to be followed. */
  axis: hairlineStrong,
  /** Axis numbers. */
  tick: inkFaint,
  /** An axis title or a series label. */
  label: inkMuted,
} as const;
