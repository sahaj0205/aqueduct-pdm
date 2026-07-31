/**
 * The scene table: every place the camera can stand, and what gets revealed there.
 *
 * THIS FILE IS THE SCRIPT. The order of the list is the order of the show, each entry's
 * `box` is that scene's fixed address in the world, and each entry's `reveals` are the
 * presses it takes to get through it. Nothing else decides any of that — there is no
 * routing table, no separate ordering, no per-scene camera code. Adding a scene is adding
 * a row here.
 *
 * THE BOXES ARE A LAYOUT, NOT A LIST. Because the whole show lives in one coordinate
 * space, where a scene sits relative to the others is meaningful and permanent. The
 * building is at the origin; the chosen machine's record sits to its right because that is
 * the direction the camera travels to reach it; the thirteen pipeline stages run beneath
 * both as a SERPENTINE — first row left to right, second right to left, third left to
 * right — so the path the reading takes through the world is one continuous snake, and the
 * final pull-out shows the whole journey as a single shape.
 *
 * SCALE IS NOT SET PER SCENE, it falls out of the box. A small box means the camera has to
 * come close; a large one means it has to pull back. The sense of moving in and out through
 * the show is therefore a consequence of how much each scene actually contains, and can
 * never disagree with what is on screen.
 *
 * EVERY NUMBER BELOW COMES OUT OF THE SNAPSHOT, which came out of the database. Nothing is
 * typed in. If a figure looks wrong, the place to look is the system that produced it, not
 * this file — which is the entire argument the walkthrough is making.
 */

import { type Box, union } from "./camera.ts";
import { PLANT_BOX } from "./plantLayout.ts";
import { SNAPSHOT as S } from "./snapshot.ts";

/** Which of the three acts a scene belongs to. Shown in the presenter's readout. */
export type Act = 1 | 2 | 3;

/** One named number, shown on the scene that earns it. */
export interface Figure {
  label: string;
  value: string;
  /** Where it came from, when that is the interesting part. */
  from?: string;
}

export interface Scene {
  /** Stable, short, and URL-safe: this becomes the deep link to the scene. */
  id: string;
  act: Act;
  title: string;
  /** The module of the platform this scene is about, if it is about one. */
  module?: string;
  /** How often this stage would run in a live deployment. */
  cadence?: string;
  /** The question the stage answers, in the operator's words. */
  asks?: string;
  /** Where this stage's answer lands. Some stages write nothing, and say so. */
  writes?: string;
  /** Where the scene lives in world space. Decides the camera framing entirely. */
  box: Box;
  /** One label per press, in order. The count is what the show machine walks. */
  reveals: readonly string[];
  /** Real numbers this scene puts on screen. */
  figures?: readonly Figure[];
}

// ------------------------------------------------------------------ small helpers

const n = (v: number, dp = 3) => v.toFixed(dp).replace(/\.?0+$/, "");
const money = (v: number) =>
  `$${Math.round(v).toLocaleString("en-US")}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

const UNIT = S.indicator.unit;
const THRESHOLD = n(S.indicator.threshold, 1);
const EXCESS = n(S.health.excess);
const arriving = S.prediction.kind === "refusal" ? S.prediction.arrivingEstimate : null;
const published = S.prediction.kind === "estimate" ? S.prediction : null;

/** The written basis the advisory carries for its own cost arithmetic. */
const costBasis: readonly string[] =
  (S.advisory?.detail as { cost?: { basis?: string[] } } | null)?.cost?.basis ?? [];

// ------------------------------------------------------------------ the layout grid

/** Every Act II station is the same size, so the run reads as one repeated apparatus. */
const STATION = { w: 1300, h: 850 };
/** Horizontal pitch along a row, and vertical pitch between rows. */
const COL = 1600;

/**
 * THE THREE ROWS OF THE PIPELINE, and why they start where they do.
 *
 * Act I above them descends the left-hand side and ends at the fourth scene, whose bottom
 * edge sits at y = 3060. The first row of stages begins at 3300, so the move from the last
 * scene of Act I into the first stage is a short step straight DOWN rather than a leap
 * back across the canvas. An earlier layout put Act I's scenes at scattered coordinates,
 * which meant the camera lurched three and a half thousand units left to reach stage one —
 * the single most disorienting move in the show.
 */
const ROW_Y = [3300, 4400, 5500];

/** A station's box from its row and column. */
const at = (col: number, row: 0 | 1 | 2): Box => ({
  x: col * COL,
  y: ROW_Y[row]!,
  ...STATION,
});

// ------------------------------------------------------------------ the script

const ACT_ONE: Scene[] = [
  {
    id: "plant",
    act: 1,
    title: "The building",
    box: PLANT_BOX,
    asks: "What is actually here, before anything is measured?",
    reveals: [
      "two cooling towers, three chillers, one chilled water loop, one air handler coil, five occupied zones",
      `${S.instruments.total} instruments appear across the plant`,
      `${S.instruments.unusable} of them strike through — defective at source, each with a written reason, before any analysis runs`,
    ],
    figures: [
      { label: "instruments", value: String(S.instruments.total) },
      { label: "defective at source", value: String(S.instruments.unusable) },
      { label: "the machine we follow", value: S.asset.name },
    ],
  },
  {
    id: "pick",
    act: 1,
    title: "One machine",
    // Level with the building, and to its right, so picking the machine out is a purely
    // sideways move — the camera never changes height while the machine is flying. Wide
    // enough to hold the words on the left and the exploded machine on the right without
    // the two overlapping; see CHILLER1_EXPLODED.
    box: { x: 1600, y: 180, w: 1120, h: 580 },
    asks: "Which machine, and which of its instruments?",
    reveals: [
      `the camera closes on ${S.asset.name}`,
      "every other asset desaturates and leaves the frame",
      `it comes apart, and one instrument is left lit: ${S.point.point_id}`,
    ],
    figures: [
      { label: "asset", value: S.asset.asset_id },
      { label: "instrument", value: S.point.point_id },
      { label: "unit", value: S.point.unit_si, from: "converted on the way in" },
    ],
  },
  {
    id: "record",
    act: 1,
    title: "What we already know about this machine",
    // Back to the left margin and below both, so the show starts descending. Its left edge
    // is flush with the building's rather than hanging past it — a box starting at a
    // negative x used to bleed into the opening shot from off-frame.
    box: { x: 0, y: 1080, w: 2600, h: 1100 },
    asks: "What exists before a single reading arrives?",
    reveals: [
      "eight things are already in the database, and none of them were learned from data",
      `the failure mode: ${S.mode.mode_name}, with a threshold of ${THRESHOLD} ${UNIT}`,
      "the threshold carries a written physical justification, not a round number somebody liked",
      `and a healthy reference: ${S.commissioning.days} days somebody declared the plant was working`,
    ],
    figures: [
      { label: "failure mode", value: S.mode.mode_name },
      { label: "fails at", value: `${THRESHOLD} ${UNIT}` },
      { label: "energy penalty", value: `${S.indicator.penaltyKwPerUnit} kW per ${UNIT}` },
      { label: "commissioning window", value: `${S.commissioning.days} days` },
      { label: "degradation process", value: `${S.indicator.process} — it only ever accumulates` },
    ],
  },
  {
    id: "arrival",
    act: 1,
    title: "The reading arrives",
    module: "Ingestion",
    cadence: "every few minutes",
    // Directly beneath the record, and directly above the first pipeline stage, so Act I
    // hands off to Act II as one continuous descent down the left of the canvas.
    box: { x: 0, y: 2300, w: 1700, h: 760 },
    asks: "What does one reading actually look like?",
    reveals: [
      `${S.series.length} hours of history draw themselves, oldest first`,
      `the head arrives and holds: ${n(S.reading.v)} ${S.point.unit_si}`,
      "this is the number the next thirteen stages are about",
    ],
    figures: [
      { label: "the reading", value: `${n(S.reading.v)} ${S.point.unit_si}` },
      { label: "at", value: S.reading.t.slice(0, 16).replace("T", " ") },
      { label: "history behind it", value: `${S.series.length} hourly points` },
    ],
  },
];

const ACT_TWO: Scene[] = [
  {
    id: "ingest",
    act: 2,
    title: "The reading lands",
    module: "Ingestion",
    cadence: "every few minutes",
    box: at(0, 0),
    asks: "Is this number in the system, in the right unit, at the right time?",
    writes: "app.measurements · app.measurements_hourly",
    reveals: [
      `the reading is stamped SI on the way in — ${S.point.unit_si}, never a Fahrenheit`,
      "the unit is a property of the ingestion manifest, checked once, not of every query",
      "the row is written",
      "behind it, a slower bucket fills: the hourly rollup that charts and long fits read",
    ],
    figures: [{ label: "stored as", value: S.point.unit_si }],
  },
  {
    id: "quality",
    act: 2,
    title: "Can this reading be believed?",
    module: "Quality scoring",
    cadence: "every few minutes",
    box: at(1, 0),
    asks: "Is the instrument telling the truth right now?",
    writes: "quality_score · quality_flags · app.sensor_advisories",
    reveals: [
      "five checks run: range, rate of change, flatline, staleness, cross-agreement",
      "the composite is the WORST of the five, not the average",
      "a reading must clear 50 to be used as evidence anywhere downstream",
      "a bad reading is stopped here, and the instrument gets its own advisory",
      "this is the first of three stages whose main job is to refuse",
    ],
    figures: [
      { label: "checks", value: "5, scored worst-of" },
      { label: "must clear", value: "50" },
      { label: "bounds on file", value: `${S.point.expected_min} to ${S.point.expected_max} ${S.point.unit_si}` },
    ],
  },
  {
    id: "context",
    act: 2,
    title: "What is the machine even doing?",
    module: "Rule engine · mode gating",
    cadence: "every few minutes",
    box: at(2, 0),
    asks: "Is this a moment in which anything can fairly be judged?",
    writes: "nothing — this gates every stage below it",
    reveals: [
      "three gates: is it running, did it start over an hour ago, is it above twenty tons",
      "if any gate fails, everything downstream greys out and no judgement is made",
      "a chiller starting up is not a chiller performing badly",
      "this stage writes nothing at all — and that is the point of it",
    ],
    figures: [{ label: "writes", value: "nothing — it gates" }],
  },
  {
    id: "rules",
    act: 2,
    title: "Is something wrong right now?",
    module: "Rule engine",
    cadence: "every few minutes",
    box: at(3, 0),
    asks: "Does any physics assertion about this machine fail to hold?",
    writes: "rule findings — per machine, per rule, per sustained stretch",
    reveals: [
      "nine physics assertions are registered against classes of equipment",
      "the engine asks the building graph which machines each one applies to",
      "two of the three chiller rules take this reading as an input",
      "a firing must hold for a full hour before it is reported — a twenty-minute blip is discarded",
    ],
    figures: [
      { label: "rules", value: "9" },
      { label: "must hold for", value: "1 hour" },
    ],
  },
  {
    id: "constraints",
    act: 2,
    title: "Do the instruments agree with each other?",
    module: "Physics constraints",
    cadence: "every few minutes",
    box: at(4, 0),
    asks: "Is this set of readings physically consistent?",
    writes: "app.constraint_residuals",
    reveals: [
      "balances that must hold if the instruments are telling the truth",
      "this reading appears in the chiller's own energy balance",
      "both sides are weighed and the miss is recorded raw and normalised",
      "the balances are arithmetic in the semantic model, so adding one is configuration",
    ],
  },
  {
    id: "baseline",
    act: 2,
    title: "Is it behaving like its own healthy past?",
    module: "Baselines",
    cadence: "every few minutes",
    box: at(4, 1),
    asks: "Given exactly what is being asked of this machine right now, is this the number it should be producing?",
    writes: "app.residuals",
    reveals: [
      "a model of what this machine does when healthy, fitted on its own commissioning window",
      `it predicts what this reading SHOULD have been, given the load it is under`,
      `observed ${n(S.baseline.residuals[S.baseline.residuals.length - 1]?.observed ?? 0)} against expected ${n(S.baseline.residuals[S.baseline.residuals.length - 1]?.expected ?? 0)} ${UNIT}`,
      "the difference is what carries forward — not the reading itself",
      `the model was fitted on ${S.commissioning.days} days declared healthy — the reference from three scenes ago`,
      "this is where the walkthrough stops being about a number and starts being about a gap",
    ],
    figures: [
      {
        label: "observed",
        value: `${n(S.baseline.residuals[S.baseline.residuals.length - 1]?.observed ?? 0)} ${UNIT}`,
      },
      {
        label: "expected",
        value: `${n(S.baseline.residuals[S.baseline.residuals.length - 1]?.expected ?? 0)} ${UNIT}`,
      },
      {
        label: "the gap",
        value: `${n(S.baseline.residuals[S.baseline.residuals.length - 1]?.residual ?? 0)} ${UNIT}`,
        from: "observed − expected",
      },
      { label: "fitted on", value: `${S.commissioning.days} commissioning days` },
    ],
  },
  {
    id: "indicator",
    act: 2,
    title: "How far has this failure progressed?",
    module: "Failure modes",
    cadence: "every few minutes",
    box: at(3, 1),
    asks: "For this specific way of failing, what is the one number that tracks it?",
    writes: "an indicator series, per machine, per failure mode",
    reveals: [
      `that gap IS the ${S.mode.mode_name.toLowerCase()} indicator — the same number, renamed`,
      `it fails at ${THRESHOLD} ${UNIT}, and that number has three separate justifications`,
      "roughly a 7 to 9 per cent compressor power penalty",
      "the point at which brushing the tubes pays for itself inside one cooling season",
      "and seven times the fitted baseline's own spread, so scatter alone cannot reach it",
    ],
    figures: [
      { label: "indicator now", value: `${EXCESS} ${UNIT}` },
      { label: "fails at", value: `${THRESHOLD} ${UNIT}` },
      { label: "rationale", value: S.mode.threshold_rationale, from: "app.failure_modes" },
    ],
  },
  {
    id: "health",
    act: 2,
    title: "Health, and whether decline really began",
    module: "Health index",
    cadence: "once a day",
    box: at(2, 1),
    asks: "How much of the way to failure has this machine travelled, and did it really start?",
    writes: "app.health_state · indicator_raw · indicator_monotonic · t_onset",
    reveals: [
      "the cadence changes here — from every few minutes to once a day",
      "the day's readings are reduced to one median, so a single bad hour cannot move the score",
      `an onset test asks whether decline genuinely started: it did, on ${day(S.health.onset)}`,
      "the line is clamped so it can flatten but never climb — scale does not fall off tubes by itself",
      `the arithmetic: ${S.health.arithmetic}`,
      `health ${S.health.value} of 100 — degraded, not yet critical`,
    ],
    figures: [
      { label: "health", value: `${S.health.value} / 100` },
      { label: "arithmetic", value: S.health.arithmetic },
      { label: "decline began", value: day(S.health.onset) },
      { label: "raw vs clamped", value: `${n(S.health.raw)} → ${EXCESS} ${UNIT}` },
    ],
  },
  {
    id: "prediction",
    act: 2,
    title: "How long has it got — or a refusal",
    module: "Remaining life",
    cadence: "once a day",
    box: at(1, 1),
    asks: "If it keeps worsening like this, when does it cross the threshold?",
    writes: "app.rul_estimates — or the refusal, with its reason",
    reveals: [
      "the honest answer today is that there is no answer",
      S.prediction.kind === "refusal"
        ? `it refuses: ${S.prediction.reason}`
        : "an estimate is published",
      "a platform that always produces a number is a platform whose numbers mean nothing",
      arriving
        ? `two days later the evidence is there, and it answers: ${arriving.p50} days, likely`
        : "the estimate arrives once there is evidence for one",
      arriving
        ? `with a band from ${arriving.p10} to ${arriving.p90} days, fitted on ${arriving.n_samples} samples`
        : "with a band, never a single date",
    ],
    figures: [
      { label: "today", value: S.prediction.kind === "refusal" ? "REFUSED" : "published" },
      ...(S.prediction.kind === "refusal"
        ? [{ label: "because", value: S.prediction.reason }]
        : []),
      ...(arriving
        ? [
            { label: "answered on", value: day(arriving.as_of) },
            {
              label: "days remaining",
              value: `${arriving.p10} · ${arriving.p50} · ${arriving.p90}`,
              from: "early · likely · late",
            },
            { label: "fitted on", value: `${arriving.n_samples} samples` },
          ]
        : []),
      ...(published
        ? [
            {
              label: "days remaining",
              value: `${published.p10} · ${published.p50} · ${published.p90}`,
              from: "early · likely · late",
            },
          ]
        : []),
    ],
  },
  {
    id: "diagnosis",
    act: 2,
    title: "Broken sensor, or broken machine?",
    module: "Diagnosis · isolation",
    cadence: "once a day",
    box: at(0, 1),
    asks: "Do we send somebody with a calibration kit, or somebody with a wrench?",
    writes: "a fault class per machine, per window",
    reveals: [
      "the same symptom can be a failing machine or a failing instrument",
      "the graph is asked which other readings should agree with this one",
      `the verdict here: ${S.advisory?.fault_class ?? "unresolved"} — a real fault, not a bad sensor`,
      "and the honest weakness: this chiller offers only three relations, and its power meter is in two of them",
    ],
    figures: [
      { label: "fault class", value: S.advisory?.fault_class ?? "unresolved" },
      { label: "known weakness", value: "3 relations only; the power meter appears in 2" },
    ],
  },
  {
    id: "rootcause",
    act: 2,
    title: "The patient, or someone else's fever?",
    module: "Diagnosis · root cause",
    cadence: "once a day",
    box: at(0, 2),
    asks: "Could an open fault upstream be producing this symptom?",
    writes: "a consequential link, and a demoted rank",
    reveals: [
      "the camera pulls all the way back to the building",
      "this chiller is fed by a cooling tower — warm condenser water would look exactly like fouling",
      "so the graph is walked upstream before any advisory is raised",
      S.advisory?.consequential
        ? `this one IS consequential, beneath ${S.advisory.cause_asset ?? "an upstream fault"}`
        : "here the tower is clean, so this fault is this machine's own",
      "had it not been, this advisory would have been demoted beneath the tower's — never hidden, but ranked below it",
    ],
    figures: [
      {
        label: "consequential",
        value: S.advisory?.consequential ? `yes — beneath ${S.advisory.cause_asset}` : "no — this machine's own fault",
      },
    ],
  },
  {
    id: "advisory",
    act: 2,
    title: "The advisory — the only thing a human acts on",
    module: "Advisory generation",
    cadence: "once a day",
    box: at(1, 2),
    asks: "What should be done, by whom, and what does waiting cost?",
    writes: "app.advisories",
    reveals: [
      "thirteen stages collapse into one card a person can act on",
      `the job: brush the condenser tubes — ${money(S.advisory?.effort_usd ?? 0)}`,
      `the cost of not doing it: ${money(S.advisory?.cost_usd ?? 0)}`,
      "every term in that number carries its own arithmetic in the database beside it",
      costBasis[0] ?? "energy, duty and tariff, each traceable",
      "the tariff and the labour rate are read from the model — the code refuses to default them",
    ],
    figures: [
      { label: "do this", value: "brush the condenser tubes" },
      { label: "cost of acting", value: money(S.advisory?.effort_usd ?? 0) },
      { label: "cost of waiting", value: money(S.advisory?.cost_usd ?? 0) },
      { label: "fault class", value: S.advisory?.fault_class ?? "—" },
      ...(costBasis[0] ? [{ label: "basis", value: costBasis[0], from: "app.advisories.detail" }] : []),
      ...(costBasis[1] ? [{ label: "coefficient", value: costBasis[1] }] : []),
    ],
  },
  {
    id: "screen",
    act: 2,
    title: "The screen",
    module: "API and interface",
    cadence: "on request",
    box: at(2, 2),
    asks: "What does the operator see, and can they trust it is only what was known at the time?",
    writes: "nothing — every endpoint reads",
    reveals: [
      "the advisory becomes a row on a worklist, with a name against it",
      "every screen answers as of a moment, never with today's knowledge backdated",
      "and nothing the interface can do writes anything back",
    ],
    figures: [{ label: "advisory", value: S.advisory?.advisory_id ?? "—" }],
  },
];

const ACT_THREE: Scene[] = [
  {
    id: "honesty",
    act: 3,
    title: "What this is, and what it is not",
    // The next slot along the bottom row, so the last stage hands straight over to it
    // without the camera leaving the run it has been travelling.
    box: at(3, 2),
    asks: "What should you not believe about what you just watched?",
    reveals: [
      "today this is a batch pipeline, not a live streaming service",
      "readings are loaded, then each layer runs over what is stored",
      "connect a live feed shaped like the measurements table and every stage above still runs, in this order",
      "no stage ever skips a layer, and no stage ever reaches back up",
      `and on the day we stood at, the prediction refused — that is the system working, not failing`,
    ],
    figures: [
      { label: "runs as", value: "batch, not streaming" },
      { label: "the moment shown", value: S.at, from: S.source },
    ],
  },
];

const NAMED: Scene[] = [...ACT_ONE, ...ACT_TWO, ...ACT_THREE];

/**
 * The pull-out that holds the whole show.
 *
 * ITS BOX IS THE ONE DERIVED ONE — the union of every other scene's rectangle — because it
 * exists precisely to frame all of them at once. Written down it would drift the first time
 * any other scene moved.
 */
const MAP: Scene = {
  id: "map",
  act: 3,
  title: "The whole journey",
  box: union(NAMED.map((scene) => scene.box)),
  asks: "What shape does one reading's journey actually have?",
  reveals: [
    "one reading, thirteen stages, one job for one person",
    "nothing skipped a layer, and nothing reached back up",
    "every number on the way was traceable to the table that produced it",
  ],
  figures: [
    { label: "stages", value: "13" },
    { label: "from", value: `${n(S.reading.v)} ${S.point.unit_si}` },
    { label: "to", value: `a ${money(S.advisory?.effort_usd ?? 0)} job on one worklist` },
    { label: "against", value: `${money(S.advisory?.cost_usd ?? 0)} of waiting` },
  ],
};

/**
 * The running order, and it ends on the pull-out deliberately.
 *
 * The honest limits come second to last, while the audience is still reading words, and
 * the show finishes by pulling back to show the whole journey as one shape. The previous
 * order put the map before the caveats, which meant the camera flew all the way out and
 * then all the way back in to land on a single small card — the most disorienting move in
 * the show, and for no narrative gain.
 */
export const SCENES: readonly Scene[] = [...ACT_ONE, ...ACT_TWO, ...ACT_THREE, MAP];

/**
 * Just the beat counts, which is all the show machine takes. Derived rather than written
 * down, so a scene cannot claim a different number of presses than it has reveals to make.
 */
export const BEAT_COUNTS: readonly number[] = SCENES.map((scene) => scene.reveals.length);

/** The scene with this id, and where it sits in the running order. */
export function sceneById(id: string): { scene: Scene; index: number } | null {
  const index = SCENES.findIndex((scene) => scene.id === id);
  const scene = SCENES[index];
  return scene ? { scene, index } : null;
}

/**
 * The one callback in this checkpoint: standing at the baseline scene, on the beat that
 * says the model was fitted on the commissioning window, the camera should widen to hold
 * that scene together with the "record" scene where the commissioning window was first
 * named — so the audience can see, rather than be told, where the number came from.
 *
 * MEMOISED, because useCamera retargets whenever the box object it is given changes
 * identity, not when its contents change. A fresh `union()` object built on every render
 * would restart the camera move every time React re-rendered for an unrelated reason —
 * the symptom would be a camera that never quite settles.
 */
const CALLBACK_SCENE = "baseline";
const CALLBACK_BEAT = 4;
let callbackBox: Box | null = null;

/** What the camera should be framing right now: usually the scene's own box. */
export function cameraTargetFor(scene: Scene, beat: number): Box {
  if (scene.id === CALLBACK_SCENE && beat === CALLBACK_BEAT) {
    if (!callbackBox) {
      const record = sceneById("record");
      callbackBox = union([scene.box, record ? record.scene.box : scene.box]);
    }
    return callbackBox;
  }
  return scene.box;
}

/** Whether the callback line should be showing right now. */
export function callbackActiveAt(scene: Scene, beat: number): boolean {
  return scene.id === CALLBACK_SCENE && beat === CALLBACK_BEAT;
}
