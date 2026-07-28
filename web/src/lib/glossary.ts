/**
 * Every domain word this interface uses, defined once.
 *
 * THE PROBLEM THIS SOLVES. This project's working agreement requires that a domain term
 * be defined the first time it appears — and it is right to. But the only tool the build
 * had for that was a paragraph, so every screen opened with one: forty-six runs of prose
 * over a hundred characters, across sixteen components, three screens where the first
 * thing you see is an essay. The definition of "approach temperature" sat two hundred
 * pixels from the number it explained, in eleven-pixel grey, and the reader had to carry
 * it across the gap themselves.
 *
 * A definition attached to its own word does not need a paragraph. That is all this is.
 *
 * WHY A TYPED KEY AND NOT A STRING. `TermId` is the keys of this object, so <Term
 * id="lft"> is a compile error rather than a tooltip that silently says nothing. There
 * is no runtime fallback for a missing definition anywhere in the component, because
 * with this type there cannot be a missing definition.
 *
 * HOW LONG AN ENTRY MAY BE. One or two sentences, no identifiers, no second domain term
 * left undefined inside the definition. If an entry needs three sentences the word is
 * doing too much work and the screen should say less, not the tooltip more.
 */

export interface GlossaryEntry {
  /** The word as it is normally written, used when <Term> is given no children. */
  term: string;
  /** One or two sentences. Plain. No jargon inside the definition of jargon. */
  short: string;
}

export const GLOSSARY = {
  /* ---------------------------------------------------------------- the plant */
  "air-handler": {
    term: "air handler",
    short:
      "The box that blows conditioned air into the building — a fan, a cooling coil, and dampers that decide how much outside air to mix in.",
  },
  chiller: {
    term: "chiller",
    short:
      "The machine that makes cold water, by the same cycle as a fridge but at building scale.",
  },
  "cooling-tower": {
    term: "cooling tower",
    short:
      "The open structure on the roof that throws the building's heat away into the outside air by evaporating water.",
  },
  damper: {
    term: "damper",
    short: "The adjustable flap that sets how much air goes down a duct.",
  },
  "chilled-water-loop": {
    term: "chilled water loop",
    short:
      "The circuit carrying cold water from the chillers out to the coils that cool the air.",
  },
  "condenser-water-loop": {
    term: "condenser water loop",
    short:
      "The circuit carrying the heat the chillers removed out to the cooling towers, where it is thrown away.",
  },
  "supply-air-temperature": {
    term: "supply air temperature",
    short: "The temperature of the air an air handler delivers into the rooms.",
  },
  setpoint: {
    term: "setpoint",
    short: "The value a control system is trying to hold a measurement at.",
  },
  economizer: {
    term: "economizer",
    short:
      "The mode where the building cools itself with outside air instead of running a chiller, because outside is already cold enough.",
  },

  /* ------------------------------------------------------------ how it degrades */
  "approach-temperature": {
    term: "approach temperature",
    short:
      "The gap between the temperature a heat exchanger actually achieved and the best it physically could have. The gap widening means its surface is fouling up.",
  },
  "part-load-ratio": {
    term: "part-load ratio",
    short:
      "How hard a machine is working as a fraction of flat out. A chiller at 0.4 is doing forty per cent of the cooling it could.",
  },
  lift: {
    term: "lift",
    short:
      "The temperature gap a compressor has to push against. More lift means more electricity for the same amount of cooling.",
  },
  "failure-mode": {
    term: "failure mode",
    short:
      "One specific way a piece of equipment can fail, with its own way of being measured and its own point at which it counts as failed.",
  },
  "severity-ladder": {
    term: "severity ladder",
    short:
      "The named steps a fault climbs on its way to failure, so that 'worse' is a rung you can point at rather than an adjective.",
  },

  /* ------------------------------------------------------------- the measurement */
  baseline: {
    term: "baseline",
    short:
      "What a reading looks like on this machine when nothing is wrong, fitted from its first weeks of running and allowing for weather and load.",
  },
  residual: {
    term: "residual",
    short:
      "What is left after subtracting what a reading should have been from what it actually was. Near zero on healthy equipment.",
  },
  drift: {
    term: "drift",
    short:
      "How far a reading has moved away from its baseline, counted in standard deviations rather than raw units so that different instruments are comparable.",
  },
  sigma: {
    term: "sigma",
    short:
      "One standard deviation — how far a reading normally wanders on its own. Three sigma is further than it wanders by chance.",
  },
  ewma: {
    term: "exponentially weighted average",
    short:
      "A running average that weights recent readings more heavily than old ones, so it reacts to a real change without jumping at a single odd sample.",
  },
  changepoint: {
    term: "changepoint",
    short:
      "The moment a measurement stopped behaving the way it used to — found by looking for where the slope of a line breaks, not where it crosses a threshold.",
  },
  "hotelling-t2": {
    term: "Hotelling's T²",
    short:
      "One number summarising how far several readings have jointly moved away from normal, allowing for the fact that they normally move together.",
  },
  "isotonic-regression": {
    term: "isotonic regression",
    short:
      "The closest version of a wobbly line that only ever moves one way. Used here to stop a health score climbing, because equipment does not heal itself.",
  },
  "quality-gate": {
    term: "quality gate",
    short:
      "The check every reading passes before any rule may use it. Frozen, stale, out-of-range and missing readings are refused rather than quietly averaged in.",
  },

  /* --------------------------------------------------------------- the judgement */
  advisory: {
    term: "advisory",
    short:
      "One piece of recommended work: what is wrong, on what, how confident the system is, what fixing it costs and what ignoring it costs.",
  },
  "fault-class": {
    term: "fault class",
    short:
      "Whether the blame lands on the instrument, on the machine, or on the logic driving them. It decides which van goes out.",
  },
  isolation: {
    term: "isolation",
    short:
      "Asking whether assuming one single reading is wrong would make every broken relation hold again. If it would, the instrument is at fault; if it would not, the machine is.",
  },
  plausibility: {
    term: "plausibility",
    short:
      "Whether a fault on one machine could physically have caused a fault on another, judged from how they are plumbed together rather than from the two happening at once.",
  },
  consequential: {
    term: "consequential",
    short:
      "An advisory that exists only because something upstream is broken. Fixing the cause makes it disappear, so it is ranked below its cause — but never hidden.",
  },
  persistence: {
    term: "persistence",
    short:
      "How long a rule has to keep firing before it counts as anything. A rule that trips for ten minutes and stops was noise.",
  },

  /* -------------------------------------------------------------- the prediction */
  rul: {
    term: "remaining useful life",
    short:
      "How long until this machine crosses the point that counts as failed — given as a range, never as a single date.",
  },
  "first-passage-time": {
    term: "first-passage time",
    short:
      "The date a drifting measurement is expected to first cross the line that counts as failed.",
  },
  "percentile-band": {
    term: "p10 / p50 / p90",
    short:
      "The spread on a prediction: a one-in-ten chance it fails sooner than p10, an even chance either side of p50, a one-in-ten chance it survives past p90.",
  },
  "health-index": {
    term: "health index",
    short:
      "A single score out of a hundred for one machine, taking its worst failure mode. A hundred is as-new; it only ever goes down until somebody repairs it.",
  },
  "cost-of-inaction": {
    term: "cost of inaction",
    short:
      "What leaving this alone is expected to cost over the planning horizon: the wasted energy, plus the chance of the failure itself, priced.",
  },

  /* -------------------------------------------------------- measuring the system */
  "false-alarm-rate": {
    term: "false alarm rate",
    short:
      "How often the system raises a finding against equipment that is provably fine. Measurable here only because some runs have nothing wrong with them at all.",
  },
  "machine-days": {
    term: "machine-days",
    short:
      "One machine watched for one day. Counting this way is what makes a false alarm rate comparable between buildings of different sizes.",
  },
  cascade: {
    term: "cascade",
    short:
      "The order the instruments moved in after a fault started, which shows the path the fault took through the plant.",
  },

  /* ------------------------------------------------------------------- the replay */
  era: {
    term: "run",
    short:
      "One complete simulated run of this building. Every run reads the same source year shifted by whole years, so the same date in two runs has the same weather and the same occupancy.",
  },
  "commissioning-window": {
    term: "commissioning window",
    short:
      "The opening weeks of a run, before anything was injected, used as the reference for what healthy looks like on this particular machine.",
  },
  vintage: {
    term: "vintage",
    short:
      "The moment a queue was computed. This database holds several runs placed years apart, so 'now' has to be stated rather than assumed.",
  },
  "as-of": {
    term: "as-of",
    short:
      "Nothing computed after the moment on the clock is visible anywhere on screen. It is what makes replaying a stored result honest rather than a slideshow.",
  },
  "brick-class": {
    term: "Brick class",
    short:
      "What kind of equipment something is, written in a standard vocabulary for building systems. It is what lets a rule written for one air handler apply to a machine nobody has seen yet.",
  },
} as const satisfies Record<string, GlossaryEntry>;

/**
 * Every key above, as a type. This is the whole safety story: a misspelled term id
 * fails `tsc` rather than rendering a tooltip with nothing in it.
 */
export type TermId = keyof typeof GLOSSARY;

export function lookup(id: TermId): GlossaryEntry {
  return GLOSSARY[id];
}
