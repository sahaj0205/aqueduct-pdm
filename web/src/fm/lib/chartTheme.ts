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

/* Surfaces. Mirrors --paper / --canvas-soft / --sunken / --hairline / --hairline-strong.
   The same middle-dark slate navy the deck uses — see the note in fm/theme.css. */
export const paper = "#1a2332";
export const raised = "#232f42";
export const sunken = "#1c2636";
export const hairline = "#34435c";
export const hairlineStrong = "#4c5f7d";

/* Ink. Mirrors --ink / --ink-muted / --ink-faint. */
export const ink = "#eef3fa";
export const inkMuted = "#c2d0e2";
export const inkFaint = "#95a6bf";

/* The single chromatic accent. Indigo lifted toward lavender so it clears the contrast
   floor against this field — the light theme's #533afd sits at roughly 3:1 here. */
export const info = "#a99cff";
export const infoWash = "#2a2f56";
export const infoInk = "#bcb2ff";

/**
 * SEVERITY, from DESIGN_SEMANTIC.md, lifted for dark surfaces. Red, orange, gold,
 * slate — four tiers, and deliberately NOT red-amber-green, for the reason stated in
 * the light palette: around eight per cent of men have red-green colour deficiency, so
 * a scale whose two ends collapse into each other is not a scale for one reader in
 * twelve. Every badge still carries a word and a distinct silhouette as well as a hue.
 */
export const critical = "#ff8389";
export const high = "#ff9d4d";
export const medium = "#f4d35e";
export const low = "#a8c3de";

/* Washes are tints of the slate field, not pale colours — a pale wash on a dark panel
   reads as a light-theme element that failed to load. */
export const criticalWash = "#3d2530";
export const highWash = "#3a2c1f";
export const mediumWash = "#363220";
export const lowWash = "#263345";

export const criticalInk = "#ff9ba0";
export const highInk = "#ffb87d";
export const mediumInk = "#f7de8b";
export const lowInk = "#bed3e8";

/* Text set on a saturated fill. Dark, because every severity fill here is light. */
export const onFill = "#1a2332";

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
  /* Sits between the card fill and the hairline: present, never noticed. */
  grid: "#2c3a4d",
  axis: hairlineStrong,
  tick: inkFaint,
  label: inkMuted,
} as const;
