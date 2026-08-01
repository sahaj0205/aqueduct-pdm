/**
 * The chart palette for the facility-manager platform.
 *
 * IT IS THE PRODUCT PALETTE, RE-EXPORTED, AND THAT IS THE WHOLE FILE. Recharts and the
 * plant drawing set colour as an SVG `fill`/`stroke` ATTRIBUTE, which cannot resolve a
 * CSS custom property, so every chart colour has to reach the component as a literal
 * string. `design/palette.ts` already holds those literals for the console. The platform
 * renders in the same light theme now, so it wants the same literals.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE. It held a second, hand-kept
 * copy of the entire palette in slate navy, because the platform used to be dark. Its own
 * header warned that editing a value here meant editing fm/theme.css too and that nothing
 * could enforce it — twenty-six exports and fifty-four custom properties expressing one
 * palette twice, with the two files naming each other and hoping. That hazard is gone
 * rather than managed: there is now one palette, in one file, and this module is the seam
 * that points at it.
 *
 * THE SEAM IS KEPT RATHER THAN DELETED. Six components import this as `* as C`, so
 * pointing them straight at design/palette.ts would be six edits for no behavioural
 * change, and it would also throw away the one place a future second theme could be
 * reintroduced without touching a component. One line is a cheap option to hold.
 */

export * from "../../design/palette.ts";
