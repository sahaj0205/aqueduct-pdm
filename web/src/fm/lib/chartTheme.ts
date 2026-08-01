/**
 * The chart palette, in dark.
 *
 * WHY THIS FILE EXISTS RATHER THAN REUSING design/palette.ts. Recharts and the plant
 * drawing set colour as an SVG `fill`/`stroke` ATTRIBUTE, which cannot resolve a CSS
 * custom property — so every chart colour has to be a literal string, and a literal
 * string cannot follow a theme. `design/palette.ts` holds the light values the console
 * still renders in; this file holds the dark values the facility-manager platform
 * renders in, under the same export names, so a chart component switches theme by
 * changing one import line.
 *
 * IF YOU EDIT A VALUE HERE, EDIT fm/theme.css TOO. The two are the same palette
 * expressed twice — once as CSS custom properties for everything laid out in HTML, once
 * as literals for everything drawn in SVG. There is no way to enforce that from the type
 * system, so they name each other instead.
 */

/* Surfaces. Mirrors --paper / --canvas-soft / --sunken / --hairline / --hairline-strong. */
export const paper = "#131c2e";
export const raised = "#182236";
export const sunken = "#0f1726";
export const hairline = "#233149";
export const hairlineStrong = "#3a4d6b";

/* Ink. Mirrors --ink / --ink-muted / --ink-faint. */
export const ink = "#e9eff8";
export const inkMuted = "#aabdd4";
export const inkFaint = "#7488a3";

/* The single chromatic accent. Indigo, lifted off the light-theme #533afd so it keeps
   its contrast against a dark surface rather than sinking into it. */
export const info = "#8b7bff";
export const infoWash = "#242a4d";
export const infoInk = "#b6acff";

/**
 * SEVERITY, from DESIGN_SEMANTIC.md, lifted for dark surfaces. Red, orange, gold,
 * slate — four tiers, and deliberately NOT red-amber-green, for the reason stated in
 * the light palette: around eight per cent of men have red-green colour deficiency, so
 * a scale whose two ends collapse into each other is not a scale for one reader in
 * twelve. Every badge still carries a word and a distinct silhouette as well as a hue.
 */
export const critical = "#ff6b74";
export const high = "#ff9f52";
export const medium = "#f2cf51";
export const low = "#8ba1bd";

/* Washes are dark tints here rather than pale ones — a pale wash on a dark panel reads
   as a light-theme element that failed to load. */
export const criticalWash = "#3b1b20";
export const highWash = "#3a2718";
export const mediumWash = "#37301a";
export const lowWash = "#1b2434";

export const criticalInk = "#ff8f96";
export const highInk = "#ffb87d";
export const mediumInk = "#f5db83";
export const lowInk = "#a8bcd6";

/* Text set on a saturated fill. */
export const onFill = "#0b1220";

/**
 * The four states a drawn node can be in.
 *
 * THE FILL STAYS FLAT UNTIL SOMETHING IS ACTUALLY WRONG — same rule as the light
 * palette. A machine in condition, a machine nobody has scored and a machine merely
 * worth watching all sit on the plain panel colour; only degraded and critical take a
 * tint, and `watch` gets a coloured border alone. Otherwise the drawing reads as
 * confetti and the two machines that need attention are no louder than the six that
 * do not.
 */
export const NODE = {
  unknown: { fill: paper, stroke: hairline, text: inkFaint },
  healthy: { fill: paper, stroke: hairlineStrong, text: ink },
  watch: { fill: paper, stroke: medium, text: ink },
  degraded: { fill: highWash, stroke: high, text: highInk },
  critical: { fill: criticalWash, stroke: critical, text: criticalInk },
} as const;

/** Chart furniture: the parts of a plot that are not data and must not read as data. */
export const CHART = {
  surface: paper,
  grid: "#1f2c42",
  axis: hairlineStrong,
  tick: inkFaint,
  label: inkMuted,
} as const;
