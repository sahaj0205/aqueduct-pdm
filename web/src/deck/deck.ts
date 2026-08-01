/**
 * THE SCRIPT.
 *
 * Every word the deck says lives in this one file. No slide is written as a component, no
 * heading is hardcoded in JSX, and nothing on screen comes from anywhere else. That is the
 * same decision the walkthrough's scenes.ts made, for the same reason: a presentation whose
 * content is scattered across fifty components cannot be reordered, cannot be counted, and
 * cannot be checked. Here it can be all three — scripts/verify-deck.ts reads this file and
 * fails the build if the structure breaks its own rules.
 *
 * HOW THIS DIFFERS FROM THE WALKTHROUGH. That artefact is a camera move through a world,
 * told from the point of view of one measurement travelling through the pipeline. This is a
 * presentation to somebody deciding whether the pipeline is worth having. Same system, same
 * numbers, different question. So: no camera, no world, no beats. One slide fills the
 * screen, everything on it is visible at once, and the presenter talks over it.
 *
 * THE SHAPE EVERY ACT TAKES, and it never varies:
 *
 *   OPEN     what is already standing from the acts before, then what this layer does
 *   ...      the deep dives
 *   CLOSE    what this layer built, and what is now in hand
 *
 * That repetition is the orientation aid. A listener who lost the thread three slides ago
 * gets picked back up at the next act boundary without anybody having to stop and recap.
 *
 * DEPTH LIVES BEHIND CLICKS, NOT ON SLIDES. Nine rules, five baselines, eight scenarios,
 * every failure mode and every validation number each open a panel on click. The slide
 * carries the claim; the panel carries the evidence, and is opened only if the room asks
 * for it. A deck that put all of it on the surface would be ninety slides nobody sits
 * through.
 */

/* ------------------------------------------------------------------------ the acts */

export type ActId =
  | "claim"
  | "trust"
  | "data"
  | "building"
  | "alerts"
  | "onset"
  | "life"
  | "decision"
  | "proof"
  | "close";

export interface Act {
  id: ActId;
  /** Shown in the rail and on the act's own opening slide. */
  name: string;
  /** The question this act answers, in the room's language. One line, on the open slide. */
  question: string;
}

/**
 * Ten acts, in the order they are presented.
 *
 * THE ORDER IS AN ARGUMENT, not a table of contents. Trust comes before data because the
 * reason for building the data the way it was built is the whole point of act one. Data
 * comes before the building because the building is populated from it. Alerts come before
 * prediction because alerts are what the system does on day one and prediction is what it
 * does on day ninety. Validation comes last because it is the only act that can be
 * evaluated once everything it measures has been described.
 */
export const ACTS: readonly Act[] = [
  {
    id: "claim",
    name: "The claim",
    question: "What is this, in one sentence?",
  },
  {
    id: "trust",
    name: "Why believe any of it",
    question: "How do you know the predictions are any good?",
  },
  {
    id: "data",
    name: "The data",
    question: "Where did the measurements come from, and who decided what was true?",
  },
  {
    id: "building",
    name: "The building",
    question: "What is being watched, and what does the system already know about it?",
  },
  {
    id: "alerts",
    name: "Live alerts",
    question: "What does it do on the first day, before it has learned anything?",
  },
  {
    id: "onset",
    name: "A number that only moves one way",
    question: "How does a stream of readings become one number that says how sick a machine is?",
  },
  {
    id: "life",
    name: "Remaining life",
    question: "How long before it fails?",
  },
  {
    id: "decision",
    name: "From a number to a decision",
    question: "So what should anybody actually do about it?",
  },
  {
    id: "proof",
    name: "Does it work",
    question: "Measured against the answer key, how right is it?",
  },
  {
    id: "close",
    name: "Close",
    question: "What is this worth, and what happens next?",
  },
] as const;

/* --------------------------------------------------------------------- the drawings */

/**
 * Which figure a slide asks for.
 *
 * NOT EVERY SLIDE GETS ONE and that restraint is deliberate, the same way it is in the
 * walkthrough. A picture on every slide is fifty things to decode, and the ones that add
 * nothing train the room to stop looking at the ones that do.
 *
 * Six of these are ports of drawings the walkthrough already has, because they already
 * answer the question this deck asks at that point. The rest are new to this artefact.
 */
export type FigureKind =
  /* act 0 — the claim */
  | "howToRead" // where the controls are: the chips, the rail, the drawer
  /* act 2 — the data */
  | "sourceFiles" // what LBNL actually ships: one year, one severity, per file
  | "ladder" // the severity rungs available for one fault, mildest first
  | "blend" // the transient quotient climbing 0 to 1, and what it mixes
  | "scenarioGrid" // all eight scenarios on one timeline, clickable
  /* act 3 — the building */
  | "topology" // the plant as blocks, no edges yet
  | "topologyEdges" // the same drawing with the brick relationships drawn in
  | "cadence" // how often a reading lands, and how many that is per year
  /* act 4 — live alerts */
  | "qualityGate" // five checks as bars, the minimum of them highlighted
  | "ruleStretch" // the hour window, and why a gap in checking does not break it
  | "advisoryCard" // the shape of a generated advisory
  /* act 5 — onset */
  | "baselineFit" // drivers in, equation, expected value out
  | "gapBand" // observed against expected with the residual shaded (port)
  | "cusum" // the running total climbing off zero, and where onset is declared
  | "healthBands" // the four bands with the score marked (port)
  /* act 6 — remaining life */
  | "rulFan" // p10 / p50 / p90 as one band, never a date (port)
  /* act 7 — decision */
  | "isolation" // sensor or equipment: what separates the two
  | "causeChain" // the root-cause walk across the graph, on one real chain
  | "costScale" // acting against waiting, on one shared scale (port)
  /* act 8 — proof */
  | "validationBars"; // the six numbers, with the bad one bad

/* ---------------------------------------------------------------------- the panels */

/**
 * What kind of thing a click opens.
 *
 * ONE COMPONENT RENDERS ALL OF THEM, driven by this tag, for the same reason one component
 * renders all the slides: the room learns to read a panel once and then knows what to
 * expect from every other one. Nine bespoke drawers would hide the regularity.
 */
export type PanelKind =
  | "scenario" // one built scenario and every ground truth set for it
  | "asset" // one machine: its instruments, how it fails, what fixing it takes
  | "rule" // one of the nine rules: the formula, the window, the reasoning
  | "check" // one of the five quality checks
  | "baseline" // one baseline: target, drivers, form, where it was fitted
  | "mode" // one failure mode: indicator, threshold, why that threshold
  | "metric" // one validation number: what it means, the figure, how it was computed
  | "maths"; // an optional descent into the arithmetic, for when the room asks

/** A chip on a slide that opens a panel. */
export interface PanelRef {
  kind: PanelKind;
  /** Identifies the row within that kind — a scenario_id, rule id, point id, and so on. */
  id: string;
  /** What the chip reads on the slide. */
  label: string;
}

/* ----------------------------------------------------------------------- the slides */

export type SlideKind = "title" | "open" | "content" | "close";

/**
 * A bullet.
 *
 * Text wrapped in *asterisks* is rendered as a keyword — brighter, heavier, and the thing
 * the presenter lands on when reading the line out. That is why the marker exists: this
 * deck is read aloud, and a bullet with nothing marked is a bullet the presenter has to
 * find the emphasis in mid-sentence.
 */
export type Point = string;

export interface Slide {
  /** Stable, kebab-case. Used by the rail, the verifier, and any future deep link. */
  id: string;
  act: ActId;
  kind: SlideKind;
  title: string;
  /** One sentence under the title. The claim the rest of the slide supports. */
  lead?: string;
  points?: readonly Point[];
  figure?: FigureKind;
  /** Chips that open a drawer. */
  panels?: readonly PanelRef[];
  /**
   * OPEN SLIDES ONLY: what is already built when this act begins. Not a summary of the
   * previous act — a list of the things now standing, wherever they came from.
   */
  standing?: readonly Point[];
  /** CLOSE SLIDES ONLY: what is in hand now that was not before this act. */
  gained?: readonly Point[];
  /** Never rendered on the slide. Sits in the rail, for the presenter only. */
  note?: string;
}

/*
 * ============================================================================ THE DECK
 *
 * PASS 2 — STRUCTURE ONLY. Every slide below is in its final position with its final
 * heading and the milestones it must cover. The points are placeholders naming what goes
 * there, not the words that will be said. Pass 3 replaces every one of them with real
 * content drawn from the extracted catalogue.
 */

export const SLIDES: readonly Slide[] = [
  /* ------------------------------------------------------------------ ACT 0 · claim */
  {
    id: "title",
    act: "claim",
    kind: "title",
    title: "Augur",
    lead: "Knowing which machine is dying, and roughly when.",
    note: "Open cold. Do not explain the name.",
  },
  {
    id: "the-claim",
    act: "claim",
    kind: "content",
    title: "The claim",
    lead: "This takes ordinary sensor readings off building plant and turns them into a ranked list of what to fix, and what it costs to wait.",
    points: [
      "In goes what a building management system already records — *131 million readings* across 8 machines and 107 instruments.",
      "Out comes a work queue: what is wrong, how sure we are, how long until it fails, and what acting costs against what waiting costs.",
      "And the part that matters: every one of those answers has been *marked against a hidden answer key*.",
    ],
    note: "The last bullet is the hook for act one. Do not elaborate it here.",
  },
  {
    /*
     * WHY THIS SLIDE EXISTS AT ALL, this early, before anything has been explained.
     *
     * The chips are deliberately understated so a room does not spend the presentation in
     * the drawer — but understated furniture on a screen full of furniture reads as
     * decoration. Somebody arriving at slide twelve and seeing a row of grey pills below
     * four bullets has no reason to think they are anything other than part of the picture,
     * and a reader working through this alone will sit still and never open one.
     *
     * So it is said once, at the front, with a live chip on the slide to try it on. Telling
     * somebody a control exists is weaker than handing them the control.
     */
    id: "how-to-read",
    act: "claim",
    kind: "content",
    title: "How to read this",
    lead: "Most of it goes slide to slide. But wherever a row along the bottom says open, there is more underneath it.",
    figure: "howToRead",
    points: [
      // Deliberately does not state a slide count. The first draft said "52 of them" and was
      // wrong by one before the day was out, because this very slide had been added since.
      // The rail already shows the real number, computed.
      "*Arrow keys or space* move between slides, in ten acts. The bar along the bottom shows how far through you are.",
      "A row labelled *open* means the claim above it has evidence behind it: the real formula, the actual thresholds, the full working.",
      "*Click one and a panel opens beside the slide.* Press Escape, or just move on, to close it again.",
      "Nothing that matters is hidden. The slides carry the argument; the panels are there for when you want to check it.",
    ],
    panels: [{ kind: "asset", id: "chiller-1", label: "try it — chiller 1" }],
    note: "Open the chip yourself here, once, so the room has seen a panel appear before it matters.",
  },

  /* ------------------------------------------------------------------ ACT 1 · trust */
  {
    id: "trust-open",
    act: "trust",
    kind: "open",
    title: "Why you should believe any of this",
    standing: ["Nothing yet. This is where the argument starts, and everything after it depends on this act."],
    points: [
      "Before any pipeline, a way to *prove the pipeline works* — decided first, because it constrains how the data had to be built.",
    ],
  },
  {
    id: "grading-your-own-homework",
    act: "trust",
    kind: "content",
    title: "The easy version, and why I did not build it",
    lead: "Simulate a machine decaying, predict the decay, score yourself. It demos beautifully and proves nothing.",
    points: [
      "Write a model of how a chiller degrades. Feed it to a predictor of how a chiller degrades.",
      "It will score near perfect — because *both halves share the same assumption*, and the test only ever measured that agreement.",
      "Change one physical assumption and the accuracy is unchanged. That is the tell: the number was never about the equipment.",
      "So: *real measurements*, from real equipment, with a *known answer* nobody downstream can see.",
    ],
  },
  {
    id: "the-answer-key",
    act: "trust",
    kind: "content",
    title: "Planting the answer key",
    lead: "The truth about each fault is fixed when the data is built, then withheld from every layer that follows.",
    points: [
      "For every scenario, two dates are recorded: *the day the fault begins* and *the day it is fully degraded*.",
      "They live in a separate database schema the pipeline has no credentials to read.",
      "So every alert, every health score and every failure date can be marked right or wrong afterwards.",
      "And *re-marked* — change a method tomorrow, rerun the marking, see whether it helped or hurt.",
    ],
    note: "The last point is what a CEO actually wants: the score is repeatable, so improvement is measurable.",
  },
  {
    id: "trust-close",
    act: "trust",
    kind: "close",
    title: "What act one settled",
    gained: [
      "A way to test the system that does not depend on trusting the person who built it.",
      "A repeatable score, so any future change can be shown to have helped or hurt.",
      "A constraint on everything next: the data has to be real, and the truth has to be planted, not inferred.",
    ],
  },

  /* ------------------------------------------------------------------- ACT 2 · data */
  {
    id: "data-open",
    act: "data",
    kind: "open",
    title: "The data",
    standing: ["From act one: the requirement for real measurements carrying a known, hidden answer."],
    points: ["Get measurements off real equipment, make them degrade honestly, and plant the answers inside them."],
  },
  {
    id: "lbnl",
    act: "data",
    kind: "content",
    title: "Where the measurements come from",
    lead: "Lawrence Berkeley National Laboratory ran real HVAC equipment, broke it deliberately, and published every reading.",
    figure: "sourceFiles",
    points: [
      "A US national laboratory, running instrumented plant and injecting known faults on purpose.",
      "Two systems used here: a *water-cooled chiller plant* and a *single-duct air handling unit*.",
      "One published file holds a *whole year* of that equipment running, at *one fixed fault severity*.",
      "Nothing in this project is a physics simulation. Every value began as something an instrument recorded.",
    ],
  },
  {
    id: "no-degradation",
    act: "data",
    kind: "content",
    title: "What was missing from it",
    lead: "The source has faults but no decline. Each file is a flat line held at one severity for a year.",
    figure: "ladder",
    points: [
      "For condenser fouling the lab published two rungs: *95% heat transfer retained*, and *65%*.",
      "A flat severity cannot be predicted — nothing is approaching anything, so there is no date to get right.",
      "Prediction needs equipment that *starts well and slides*, which the source does not contain.",
      "So the data had to be made to degrade *without inventing a single measurement*.",
    ],
  },
  {
    id: "the-blend",
    act: "data",
    kind: "content",
    title: "How degradation was built",
    lead: "Interpolate the fault's contribution, never the signal.",
    figure: "blend",
    points: [
      "At any instant, faulted run minus clean run is the *fault contribution* — a real difference between two real runs.",
      "Same weather, same hour, same control decisions, so *everything except the fault cancels out of it*.",
      "A progress value climbs *0 at onset to 1 at failure*, and that fraction of the contribution is added back onto the clean signal.",
      "The output's weather and control variation is therefore genuine and unsmoothed. Only the fault's magnitude is interpolated.",
    ],
    panels: [{ kind: "maths", id: "blend-formula", label: "the formula" }],
    note: "Show the formula. Do not read it out unless asked.",
  },
  {
    id: "unusable",
    act: "data",
    kind: "content",
    title: "What could not be used",
    lead: "Three of the 107 instruments in the published data are unusable, and saying so out loud is part of the argument.",
    points: [
      "One reports *357,730.44 every minute of the year* while the damper swings across its full range — a design figure, not a measurement.",
      "Two more mix units between files: Pascals in the clean run, inches of water in every fault run, spliced together by the blend.",
      "They are excluded and documented, not quietly averaged in.",
      "A system that used them would produce confident numbers built on nothing — which is the failure this whole project is about.",
    ],
  },
  {
    id: "scenarios",
    act: "data",
    kind: "content",
    title: "Eight scenarios built from it",
    lead: "Six carry an injected fault. Two are clean controls, and those two are what make a false-alarm rate measurable at all.",
    figure: "scenarioGrid",
    points: [
      "One scenario is: one machine, one fault, one window in time, one answer key.",
      "Each occupies its own year, so two scenarios never write the same instrument at the same instant.",
      "The clean runs contain no fault — so *anything flagged there is something the system got wrong*.",
      "Click any scenario for every ground truth set for it: onset, failure, calendar, seed, severity ladder.",
    ],
    panels: [
      { kind: "scenario", id: "chiller_condenser_fouling", label: "condenser fouling" },
      { kind: "scenario", id: "chiller_bypass_valve_leakage", label: "bypass valve leakage" },
      { kind: "scenario", id: "cooling_tower_fouling", label: "cooling tower fouling" },
      { kind: "scenario", id: "ahu_cooling_valve_leakage", label: "coil valve leakage" },
      { kind: "scenario", id: "ahu_sat_sensor_drift", label: "sensor drift" },
      { kind: "scenario", id: "ahu_oa_damper_stuck", label: "damper stuck" },
      { kind: "scenario", id: "clean_chiller", label: "clean chiller" },
      { kind: "scenario", id: "clean_ahu", label: "clean air handler" },
    ],
    note: "Open one, not eight. Condenser fouling is the one the rest of the deck follows.",
  },
  {
    id: "data-close",
    act: "data",
    kind: "close",
    title: "What act two built",
    gained: [
      "131,006,465 measurements from real instrumented equipment, blended into genuine decline.",
      "Eight scenarios across four machines — six faulted, two clean.",
      "Six injected faults, each with an onset date and a failure date the pipeline cannot see.",
      "Three unusable instruments, excluded and documented rather than silently used.",
    ],
  },

  /* --------------------------------------------------------------- ACT 3 · building */
  {
    id: "building-open",
    act: "building",
    kind: "open",
    title: "The building",
    standing: [
      "From act two: 131 million measurements, and the answers hidden inside them.",
    ],
    points: [
      "Describe the plant those measurements come off — every machine, every instrument, how each one fails, and what connects to what.",
    ],
  },
  {
    id: "plant",
    act: "building",
    kind: "content",
    title: "What is being watched",
    lead: "Eight machines, 107 instruments, and everything the system already holds about each of them.",
    figure: "topology",
    points: [
      "Three chillers, three cooling towers, a chilled water plant, and one air handling unit.",
      "Instruments range from *30 on the air handler* down to *7 on a cooling tower*.",
      "Each machine also carries what it costs to replace — *$320,000* for a chiller, *$85,000* for the air handler.",
      "Click any machine for its instruments, its failure modes, and what fixing each one takes.",
    ],
    panels: [
      { kind: "asset", id: "chiller-1", label: "chiller 1" },
      { kind: "asset", id: "ahu-1", label: "air handler 1" },
      { kind: "asset", id: "ct-1", label: "cooling tower 1" },
      { kind: "asset", id: "chw-plant-1", label: "chilled water plant" },
    ],
    note: "Open chiller-1 here. Everything after this act follows that machine.",
  },
  {
    id: "cadence",
    act: "building",
    kind: "content",
    title: "How often a reading arrives",
    lead: "Every instrument reports on a five-minute cadence, all year, without stopping.",
    figure: "cadence",
    points: [
      "288 readings per instrument per day. Across 107 instruments that is *30,816 a day*.",
      "Over the eight years of scenario time in the database: *131,006,465 rows*.",
      "Stored in a time-series database, partitioned by time, because counting rows in a table that size is itself a slow query.",
      "Everything downstream in this deck operates on that stream — no daily summaries, no sampling.",
    ],
  },
  {
    id: "relationships",
    act: "building",
    kind: "content",
    title: "The parts know about each other",
    lead: "The same plant, with the connections between machines written down as data.",
    figure: "topologyEdges",
    points: [
      "Machines are described in *Brick*, a standard vocabulary for building equipment — so a chiller means the same thing in every building.",
      "Two relationships carry the weight: *part-of*, and *feeds* — what A does affects B.",
      "Chillers feed the chilled water loop; the loop feeds the cooling coil; the coil feeds the fan; the fan feeds five zones.",
      "The published model had *zero* flow statements. Every connection here had to be added.",
    ],
  },
  {
    id: "why-a-graph",
    act: "building",
    kind: "content",
    title: "Why a graph and not a list",
    lead: "Because the machine showing a bad number is usually not the machine at fault.",
    points: [
      "A chiller short of capacity sends warm water down the loop. The coil downstream then cannot hit its setpoint however far it opens.",
      "Examined alone, *the air handler is failing*. Send somebody there and they find a perfect coil and a valve doing everything asked of it.",
      "Without the graph, one problem becomes four alarms on four machines and nobody knows which to attend.",
      "With it, the system can ask *what is upstream of this* — which is act seven.",
    ],
  },
  {
    id: "building-close",
    act: "building",
    kind: "close",
    title: "What act three built",
    gained: [
      "Every machine and all 107 instruments catalogued, with replacement costs attached.",
      "Six failure modes defined, each with a threshold and a written physical justification.",
      "The intervention for each fault: the work, the hours, the parts cost.",
      "The plant as a searchable graph, so upstream and downstream are questions with answers.",
    ],
  },

  /* ----------------------------------------------------------------- ACT 4 · alerts */
  {
    id: "alerts-open",
    act: "alerts",
    kind: "open",
    title: "Live alerts",
    standing: [
      "From act two: the measurement stream.",
      "From act three: the plant, every instrument, and how each machine fails.",
    ],
    points: [
      "Catch what is wrong *today*, from the first day, with no history and no training period required.",
      "Two tracks run from here on: *detection now*, and *prediction later*. They are different questions and this deck keeps them apart.",
    ],
    note: "Make the two-track point explicitly. It is the thing most people conflate.",
  },
  {
    id: "quality",
    act: "alerts",
    kind: "content",
    title: "Five questions asked of every reading",
    lead: "Before any rule runs, the reading has to earn the right to be believed.",
    figure: "qualityGate",
    points: [
      "*Timeliness, completeness, range, plausibility, staleness* — each scored 0 to 100 over a trailing window.",
      "Trailing means the score at noon uses nothing recorded after noon. A rule that fires on evidence from the future cannot run in production.",
      "The composite is the *minimum* of the five, never the average.",
      "A reading that is timely, complete, smooth and moving but *physically impossible* is not 80% trustworthy. It is worthless.",
    ],
    panels: [
      { kind: "check", id: "timeliness", label: "timeliness" },
      { kind: "check", id: "completeness", label: "completeness" },
      { kind: "check", id: "range", label: "range" },
      { kind: "check", id: "plausibility", label: "plausibility" },
      { kind: "check", id: "staleness", label: "staleness" },
    ],
  },
  {
    id: "sensor-advisories",
    act: "alerts",
    kind: "content",
    title: "When the instrument is the problem",
    lead: "A reading that fails the gate is itself a finding, not a silence.",
    points: [
      "Below *70*, the rule engine declines to read that instrument at all.",
      "The failure is raised separately, as a *sensor advisory* against the instrument rather than the machine.",
      "A dead sensor is a real work order — cheap, fast, and it restores visibility on everything downstream of it.",
      "Kept in its own table, because saying *this thermometer is broken* and *this chiller is broken* are different claims with different repairs.",
    ],
  },
  {
    id: "rules",
    act: "alerts",
    kind: "content",
    title: "Nine rules",
    lead: "Published engineering relationships that must hold if the machine is working — not thresholds invented for this project.",
    points: [
      "Six come from *APAR*, a published diagnostic rule set for air handlers. Three are chiller rules built on the same principle.",
      "A rule is an equation over several instruments at once: *mixed air cannot be hotter than both the streams feeding it*.",
      "Each names the operating mode it applies in — a relationship that is true while economizing is nonsense while heating.",
      "Click any rule for its test, what it reads, and why it means what it means.",
    ],
    panels: [
      { kind: "rule", id: "apar-6", label: "apar 6" },
      { kind: "rule", id: "apar-7", label: "apar 7" },
      { kind: "rule", id: "apar-16", label: "apar 16" },
      { kind: "rule", id: "apar-18", label: "apar 18" },
      { kind: "rule", id: "apar-20", label: "apar 20" },
      { kind: "rule", id: "apar-27", label: "apar 27" },
      { kind: "rule", id: "chiller-kw-per-ton-residual", label: "efficiency residual" },
      { kind: "rule", id: "chiller-excess-lift", label: "excess lift" },
      { kind: "rule", id: "chiller-capacity-shortfall", label: "capacity shortfall" },
    ],
  },
  {
    id: "an-hour-not-an-instant",
    act: "alerts",
    kind: "content",
    title: "An hour, not an instant",
    lead: "One bad reading is noise. An hour of bad readings is a fault.",
    figure: "ruleStretch",
    points: [
      "A violation must hold continuously for *60 minutes* before anything is raised.",
      "The nuance that matters: a stretch is broken only when the rule is *checked and passes*.",
      "A gap where the rule could not run — the machine was off, or a reading failed quality — does *not* reset the clock.",
      "Otherwise a fault would be erased by the very dropouts that accompany it. The cost is that alerts arrive an hour late, by design.",
    ],
    note: "The gap nuance is subtle and worth the extra sentence. It is a real design decision.",
  },
  {
    id: "alert-format",
    act: "alerts",
    kind: "content",
    title: "What comes out",
    lead: "A finding names the machine, the rule, the values that broke it, and what the violation costs per hour.",
    points: [
      "Which machine, which rule, and the *actual measured values* — not a code, the numbers themselves.",
      "The cost is in physical units first: kilowatt-hours of wasted energy, or degree-hours of comfort lost.",
      "Deliberately absent at this stage: *any statement about the future*. Nothing here says a machine is getting worse.",
      "That gap is the entire reason acts five and six exist.",
    ],
  },
  {
    id: "alerts-close",
    act: "alerts",
    kind: "close",
    title: "What act four built",
    gained: [
      "A trust score on every one of the 131 million readings.",
      "Findings against equipment, from nine published engineering rules.",
      "Findings against instruments, kept deliberately separate.",
      "Still missing: none of this can say a machine is *degrading*, or when it will fail.",
    ],
    note: "End on the gap. It is the setup for act five.",
  },

  /* ------------------------------------------------------------------ ACT 5 · onset */
  {
    id: "onset-open",
    act: "onset",
    kind: "open",
    title: "A number that only moves one way",
    standing: [
      "From act three: every failure mode, with a threshold somebody physically justified.",
      "From act four: readings scored for trust, and rules that catch what is wrong right now.",
    ],
    points: [
      "Turn a stream of readings into *one number per failure mode* that says how far this machine has travelled toward failing.",
      "The rules of act four cannot do this. They answer yes or no, today, with no memory.",
    ],
    note: "This is the act the project exists for. Slow down here.",
  },
  {
    id: "why-baselines",
    act: "onset",
    kind: "content",
    title: "The problem with reading a sensor directly",
    lead: "A chiller drawing more power might be sick — or it might be a hot afternoon with a full building.",
    points: [
      "Load and weather move every measurement far more than early degradation does.",
      "The same healthy chiller runs *1.2 kW per ton on a mild morning and 1.9 on a hot afternoon*. Any fixed limit flags the afternoon.",
      "So the confound has to be removed before decline is visible at all.",
      "The idea: predict what a *healthy* machine would have done *under today's exact conditions*, and compare.",
    ],
  },
  {
    id: "baseline-targets",
    act: "onset",
    kind: "content",
    title: "Five things worth predicting",
    lead: "Not every instrument gets a baseline. Choosing which do is most of the work.",
    points: [
      "Two on a chiller — *its power draw*, and *how hot the condenser water leaves*. Three on the air handler.",
      "Only where the physics is known and the drivers are instrumented. Everywhere else a model would be a confident model of nothing.",
      "A bad choice does not fail loudly. It produces residuals that *look like evidence* and are not.",
      "Defined per equipment class, so a fourth chiller needs a database row and no code change.",
    ],
    panels: [
      { kind: "baseline", id: "condenser-heat-rejection", label: "condenser heat rejection" },
      { kind: "baseline", id: "chiller-efficiency", label: "chiller efficiency" },
      { kind: "baseline", id: "fan-similarity", label: "fan similarity" },
      { kind: "baseline", id: "coil-effectiveness", label: "coil effectiveness" },
      { kind: "baseline", id: "shut-valve-supply-air", label: "shut-valve supply air" },
    ],
  },
  {
    id: "baseline-fit",
    act: "onset",
    kind: "content",
    title: "What a baseline is, and how it learns",
    lead: "An equation with blanks in it, filled in from a stretch when the machine was known to be healthy.",
    figure: "baselineFit",
    points: [
      "Driver measurements go in — for the condenser, *how much heat is being rejected* and *how cold the water arrived*.",
      "The equation's shape comes from the physics; only the constants are unknown.",
      "Those constants are set on *21 days of commissioning data*, when the machine was newly verified as working.",
      "Then they are *frozen forever*. Refitting later would quietly teach the model that a degrading machine is normal.",
    ],
    panels: [{ kind: "maths", id: "least-squares", label: "how the constants are chosen" }],
  },
  {
    id: "residuals",
    act: "onset",
    kind: "content",
    title: "The gap is the signal",
    lead: "What actually happened, minus what a healthy machine would have done in the same conditions.",
    figure: "gapBand",
    points: [
      "Every five minutes: take the drivers, compute the expected value, *subtract it from the observed one*.",
      "Near zero means the machine is behaving exactly as its healthy self would have.",
      "Load and weather have now *cancelled out* — they moved both numbers equally, so they are gone from the difference.",
      "Stored per reading rather than recomputed, so the evidence behind a health score can always be produced.",
    ],
  },
  {
    id: "failure-modes",
    act: "onset",
    kind: "content",
    title: "How this machine fails",
    lead: "One machine fails several distinct ways, and each is measured differently.",
    points: [
      "A chiller has three: *condenser fouling*, *compressor efficiency loss*, *refrigerant charge loss*. The air handler has three more.",
      "Each carries an indicator, the value at which it counts as failed, and a *written physical justification for that value*.",
      "Fouling fails at *3.0 °C* of excess condenser water — a 7–9% power penalty, and seven times the baseline's own scatter.",
      "The justification is a required database column. A threshold cannot be entered without one.",
    ],
    panels: [
      { kind: "mode", id: "chiller-condenser-fouling", label: "condenser fouling" },
      { kind: "mode", id: "chiller-efficiency-loss", label: "efficiency loss" },
      { kind: "mode", id: "chiller-refrigerant-loss", label: "refrigerant loss" },
      { kind: "mode", id: "coil-valve-leak-by", label: "coil valve leak-by" },
      { kind: "mode", id: "fan-bearing-degradation", label: "fan and bearings" },
      { kind: "mode", id: "filter-loading", label: "filter loading" },
    ],
    note: "Filter loading is the honest one: defined, justified, and not computable in this building.",
  },
  {
    id: "onset-detection",
    act: "onset",
    kind: "content",
    title: "When did it start?",
    lead: "Finding the day the decline began, not the day it became obvious.",
    figure: "cusum",
    points: [
      "Add up, day by day, how far above its old normal the indicator is sitting. Excursions that cancel out contribute nothing.",
      "Early degradation is *smaller than the noise*. One day half a degree high means nothing; thirty consecutive days means the machine changed.",
      "The running total is deliberately slow to declare — so the moment it crosses is *when we knew*, and the last time it sat at zero is *when it started*.",
      "On the chiller we are following, it puts the start at *30 May 2037*.",
    ],
    panels: [{ kind: "maths", id: "cusum", label: "the running total, precisely" }],
    note: "Say running total, not CUSUM, unless asked.",
  },
  {
    id: "health-index",
    act: "onset",
    kind: "content",
    title: "One number a manager can act on",
    lead: "How far along the road from commissioned to failed this machine has travelled, out of a hundred.",
    figure: "healthBands",
    points: [
      "100 is the value it was commissioned at. 0 is the failure threshold. Today the excess is 1.151 °C of 3.0.",
      "*100 × (1 − 1.151 ÷ 3.0) = 62* — degraded, not yet critical.",
      "Clamped so it can only get worse, because real readings jitter and a bouncing line breaks the prediction maths downstream.",
      "A machine's overall health is the *minimum* across its modes, never the mean — a perfect compressor and a dead condenser is not a healthy chiller.",
    ],
  },
  {
    id: "onset-close",
    act: "onset",
    kind: "close",
    title: "What act five built",
    gained: [
      "An expected value for every driven measurement, from a model frozen at commissioning.",
      "The gap between expected and actual, stored per reading.",
      "A start date for the decline on each failure mode.",
      "A health score — 62 of 100 on the chiller we are following. Still missing: *when*.",
    ],
  },

  /* ------------------------------------------------------------------- ACT 6 · life */
  {
    id: "life-open",
    act: "life",
    kind: "open",
    title: "Remaining life",
    standing: [
      "From act five: a health score, and the day the decline started.",
      "From act three: the value at which this fault counts as failed.",
    ],
    points: ["Turn the rate of decline into a range of dates — and refuse when the evidence will not support one."],
  },
  {
    id: "rul",
    act: "life",
    kind: "content",
    title: "How long until it fails",
    lead: "Failure is the first moment the indicator touches its threshold. The answer is a distribution over when that happens.",
    figure: "rulFan",
    points: [
      "Fit how fast the indicator is climbing, and how much it scatters, from the days since onset.",
      "*First passage*: the first touch, not the average level — equipment that crosses and comes back has still crossed.",
      "Because the rate itself is uncertain, that uncertainty is carried through, so the output is *a band and never a date*.",
      "Read as: a tenth chance of failing by the early edge, half by the middle, nine tenths by the far edge.",
    ],
    panels: [{ kind: "maths", id: "first-passage", label: "the model behind the band" }],
    note: "If an engineer asks why not machine learning: there is no failure history to train on. Six events is not a training set.",
  },
  {
    id: "refusal",
    act: "life",
    kind: "content",
    title: "The system is allowed to say no",
    lead: "On the day we are looking at, it declines to give a failure date at all.",
    points: [
      "The reason it gives: *not enough samples yet* — the indicator has not been above its onset level long enough to fit a rate.",
      "Four conditions can trigger a refusal, checked in order. The one that does the real work is *the rate cannot be told apart from zero*.",
      "That single condition catches both known false alarms coming in from upstream — machines with nothing actually wrong with them.",
      "Two days later, on 9 June, enough evidence arrives and the estimate appears: *3 to 22 days, most likely 7*.",
    ],
    note: "This is the slide that buys credibility. Do not rush it.",
  },
  {
    id: "life-close",
    act: "life",
    kind: "close",
    title: "What act six built",
    gained: [
      "A remaining-life band per failure mode, never a single date.",
      "An explicit refusal, with its specific reason, when the evidence is too thin.",
      "A filter that caught two upstream false alarms nothing else in the pipeline caught.",
    ],
  },

  /* --------------------------------------------------------------- ACT 7 · decision */
  {
    id: "decision-open",
    act: "decision",
    kind: "open",
    title: "From a number to a decision",
    standing: [
      "From act five: a health score. From act six: a remaining-life band.",
      "From act three: the graph, the replacement costs, and the intervention for every fault.",
    ],
    points: [
      "Work out *what kind of fault it is*, *which machine actually started it*, *what it is worth fixing*, and turn all of it into one document.",
    ],
  },
  {
    id: "sensor-or-equipment",
    act: "decision",
    kind: "content",
    title: "Is it the machine, or the instrument measuring it?",
    lead: "Identical symptoms, completely different repairs, and getting it wrong wastes the visit in a specific way.",
    figure: "isolation",
    points: [
      "Sent for equipment when it is a sensor: somebody dismantles a healthy coil.",
      "Sent for a sensor when it is equipment: somebody recalibrates a thermometer that was telling the truth, and the machine carries on failing.",
      "*Control is tested first* — an actuator ignoring its command makes a good sensor look like a lying one.",
      "*Sensor needs positive evidence*: one measurement whose assumed bias explains all of it. Equipment is what remains when every measurement agrees and output still falls.",
    ],
  },
  {
    id: "root-cause",
    act: "decision",
    kind: "content",
    title: "Which machine started it",
    lead: "Walked on one real chain the system produced — not a constructed example.",
    figure: "causeChain",
    points: [
      "The symptom: *air handler 1*, cooling valve wide open and stuck there. On its own evidence, that unit is failing.",
      "Step outward through the graph: the coil is fed by the chilled water loop, which is fed by *chiller 1* — two hops upstream.",
      "Chiller 1 has an open condenser fouling fault that *started first*. Timing is required, not just adjacency.",
      "And the mechanism must be real: fouling *degrades the water the coil consumes*. Efficiency loss would not — that costs money without changing the water.",
    ],
    note: "This is the chain in the database: ahu-1 apar-20, caused by chiller-1 condenser fouling.",
  },
  {
    id: "cost",
    act: "decision",
    kind: "content",
    title: "What acting costs, and what waiting costs",
    lead: "Both sides priced from fields already stored against the machine.",
    figure: "costScale",
    points: [
      "Acting: eight hours of labour and $850 of parts to brush the tube bundle. *$1,610* all in.",
      "Waiting, part one — energy: 10.65 indicator units × 1.876 kW each = *19.98 kW wasted*, over 2,048 running hours at $0.128/kWh. *$5,238*.",
      "Waiting, part two — consequence: a *90% chance* of crossing the threshold within 90 days, against *$302,000* of replacement over repair. *$271,800*.",
      "*$1,610 against $277,038.* That ratio, not the health score, is what orders the work queue.",
    ],
  },
  {
    id: "the-advisory",
    act: "decision",
    kind: "content",
    title: "The advisory",
    lead: "Everything the pipeline knows, assembled into the one object a human is asked to read.",
    figure: "advisoryCard",
    points: [
      "*What is wrong* — machine, failure mode, class, health. From acts three and five.",
      "*When it fails* — the interval, or the refusal and its reason, verbatim. From act six.",
      "*Who it reaches* — 5 zones, 200 occupants, one downstream machine. From the graph in act three.",
      "*What it is worth, and what to do* — both costs, and the intervention in the engineer's own words. From act three and this act.",
    ],
    note: "Point at each field and name the act it came from. This is the payoff slide.",
  },
  {
    id: "decision-close",
    act: "decision",
    kind: "close",
    title: "What act seven built",
    gained: [
      "Every finding classified: control, sensor, equipment, or honestly unknown.",
      "Consequential findings linked to their cause and ranked below it — demoted, never hidden.",
      "Both sides of the decision priced from stored fields, with the arithmetic shown.",
      "One ranked queue of work, ordered by what it costs to do nothing.",
    ],
  },

  /* ------------------------------------------------------------------ ACT 8 · proof */
  {
    id: "proof-open",
    act: "proof",
    kind: "open",
    title: "Does it work",
    standing: [
      "From act one: the answer key, planted when the data was built and hidden ever since.",
      "From acts four to seven: everything the pipeline produced without ever seeing it.",
    ],
    points: ["Mark one against the other, and report what comes out — including the number that is bad."],
  },
  {
    id: "how-scored",
    act: "proof",
    kind: "content",
    title: "How the marking works",
    lead: "Every machine, every day, labelled from the answer key, then compared with what the platform said that day.",
    points: [
      "The unit of scoring is *one machine on one day* — not one alert, because a fault that runs for a week is not seven successes.",
      "Four outcomes per machine-day: correctly flagged, correctly silent, missed, or a false alarm.",
      "The two clean scenarios contribute only healthy days, which is what makes false alarms countable.",
      "It runs as a single command and writes a report. *Repeatable* — that was the point of act one.",
    ],
  },
  {
    id: "the-numbers",
    act: "proof",
    kind: "content",
    title: "The numbers",
    lead: "Six measures, reported exactly as the harness produced them.",
    figure: "validationBars",
    points: [
      "Caught *76.1%* of the machine-days where something was genuinely wrong.",
      "Of everything it raised, *43.7%* was real — the honest cost of that recall.",
      "Warned *26.6 days* before failure, typically. Named the right fault *4 times out of 5*, against a 3-in-5 baseline for always guessing.",
      "Click any number for what it means and how it was computed.",
    ],
    panels: [
      { kind: "metric", id: "recall", label: "recall" },
      { kind: "metric", id: "precision", label: "precision" },
      { kind: "metric", id: "lead", label: "warning time" },
      { kind: "metric", id: "faultClass", label: "right fault named" },
      { kind: "metric", id: "rulCoverage", label: "remaining-life accuracy" },
      { kind: "metric", id: "suppression", label: "refusals" },
    ],
  },
  {
    id: "the-bad-one",
    act: "proof",
    kind: "content",
    title: "The number that is bad",
    lead: "The remaining-life band should contain the true failure date about 80% of the time. It manages 7.7%.",
    points: [
      "The band is *too narrow and too confident* — wrong in the most expensive direction, because a planner trusting it books a crew for the wrong week.",
      "The detection layers are usable today. *The remaining-life interval is not*, and this deck says so rather than quoting the median and moving on.",
      "It is reported because act one built the machinery to report it. A system that only publishes its good numbers cannot be improved.",
      "The fix is a wider uncertainty model on the rate — and act one is what will tell us whether it actually worked.",
    ],
    note: "Do not apologise for this slide. Its presence is the argument.",
  },
  {
    id: "proof-close",
    act: "proof",
    kind: "close",
    title: "What act eight established",
    gained: [
      "A scored, repeatable measurement of the whole pipeline against hidden ground truth.",
      "Detection that works: 76% caught, 26 days of warning, the right fault named 4 times in 5.",
      "One named weak component — the remaining-life interval, at 7.7% coverage.",
      "A way to tell whether tomorrow's change helped or hurt.",
    ],
  },

  /* ------------------------------------------------------------------ ACT 9 · close */
  {
    id: "what-this-is",
    act: "close",
    kind: "content",
    title: "What this is",
    lead: "Nine layers, each one refusing to hand the next anything it cannot justify.",
    points: [
      "Real measurements, blended into real decline, with the truth planted and hidden.",
      "Readings scored for trust, then nine published rules catching what is wrong today.",
      "Healthy-behaviour models frozen at commissioning, and the gap between expected and actual as the signal.",
      "A health score, a remaining-life band or an honest refusal, a root cause, and both sides of the money.",
    ],
  },
  {
    id: "what-next",
    act: "close",
    kind: "content",
    title: "What happens when the method changes",
    lead: "The answer key is not a one-off audit. It is the instrument every future change is measured with.",
    points: [
      "Change a method, rerun the marking, compare against today's six numbers. *That loop is the product.*",
      "First target is named and known: the remaining-life interval at 7.7% coverage.",
      "To point this at a real building: its equipment list, its connections, and three weeks of commissioning data.",
      "Everything else in this deck already runs unchanged.",
    ],
  },
] as const;

/* ---------------------------------------------------------------------- derived views
 *
 * DERIVED, NEVER AUTHORED. Every count and grouping below is computed from SLIDES, so
 * adding a slide cannot leave a number somewhere else stale. That is the same rule the
 * walkthrough's ledger follows and it exists because the first version of that ledger was
 * hand-maintained and silently drifted two entries out of date.
 */

/** Every slide belonging to one act, in order. */
export function slidesInAct(act: ActId): Slide[] {
  return SLIDES.filter((s) => s.act === act);
}

/** Where an act starts in the deck. Used by the rail to draw act groups. */
export function actRanges(): { act: Act; from: number; to: number }[] {
  return ACTS.map((act) => {
    const indices = SLIDES.flatMap((s, i) => (s.act === act.id ? [i] : []));
    return { act, from: indices[0] ?? 0, to: indices[indices.length - 1] ?? 0 };
  });
}

export function actOf(index: number): Act {
  const id = SLIDES[index]?.act ?? ACTS[0]!.id;
  return ACTS.find((a) => a.id === id)!;
}

/** Position within the act, one-based, for the rail's "3 of 6". */
export function positionInAct(index: number): { at: number; of: number } {
  const slide = SLIDES[index];
  if (!slide) return { at: 1, of: 1 };
  const within = slidesInAct(slide.act);
  return { at: within.findIndex((s) => s.id === slide.id) + 1, of: within.length };
}

/** Every panel referenced anywhere in the deck, deduplicated. */
export function allPanelRefs(): PanelRef[] {
  const seen = new Map<string, PanelRef>();
  for (const slide of SLIDES) {
    for (const ref of slide.panels ?? []) {
      seen.set(`${ref.kind}:${ref.id}`, ref);
    }
  }
  return [...seen.values()];
}

export const SLIDE_COUNT = SLIDES.length;
