# STORY_BUILD.md — the execution spec for the walkthrough

This document exists so that checkpoints 2 to 11 can be built without re-deciding
anything. Every layout coordinate, every function signature, every threshold and every
commit message is fixed here. **If you find yourself weighing two designs, the answer is
already in this file — go and find it rather than choosing.** If it genuinely is not here,
that is a gap: stop and ask, do not invent.

Read `docs/PIPELINE_STORY_PLAN.md` first for why the walkthrough is shaped this way. This
file is the how.

---

## 0. Using this with `/goal`

`/goal` loops turns automatically until a stated condition holds. This project's working
agreement requires stopping at every checkpoint for review, so **scope each goal to one
checkpoint**:

```
/goal checkpoint 2 in docs/STORY_BUILD.md is complete, its verification passes, and it is committed
```

Do not write a goal spanning several checkpoints. It would run straight through the review
gates, and those gates are what caught the tolerance bug in checkpoint 1.

Nothing else is needed to use `/goal` — no extra file, no configuration. This document is
what makes the goal achievable, not a requirement of the feature.

---

## 1. House rules — these override instinct

1. **Never fabricate a number.** Every figure on screen comes from `snapshot.json`, which
   comes from the running system. If a value is unavailable, stop and report it. A
   plausible-looking invented number is the single worst failure available here, because the
   whole argument of this walkthrough is that its numbers are traceable.

2. **A failing check is information, not an obstacle.** Do not loosen a threshold to make a
   check pass. In checkpoint 1 a camera move failed a "settles inside one second" assertion
   at 1.42 s. The threshold was not wrong and the camera was not wrong — the *measurement*
   was, because the tolerance was expressed in world units when it needed to be in screen
   pixels. Tuning the number would have hidden a real dimensional bug. When a check fails,
   ask what it is really measuring first.

3. **No new dependencies.** React, react-dom, react-router-dom and recharts are what exists.
   Animation is CSS transitions, the Web Animations API (`element.animate`) and
   `requestAnimationFrame`. Charts in the walkthrough are hand-rolled SVG, never Recharts —
   every chart here is a drawing animation and Recharts cannot be drawn partially.

4. **No tests.** Verification goes in `web/scripts/verify-story.ts`, extended each
   checkpoint, run with `npm run verify:story`. It is a property script, not a test suite.

5. **Colour follows the existing semantics.** Tokens from `web/src/design/tokens.css` only;
   never a literal hex in a component. Severity is red / orange / gold / slate and never
   red-amber-green. Indigo means action and emphasis. Anything carrying meaning also carries
   a word or a shape, never colour alone. SVG attributes that cannot resolve a custom
   property use `web/src/design/palette.ts`.

6. **Light palette throughout.** This is shown on a projector. If a plant drawing is needed
   in light form, add a light variant to the colour table in `web/src/lib/schematic.ts` —
   do not use its dark fills.

7. **The camera is the only way anything moves between scenes.** Do not add per-scene
   transitions, page transitions, or mount/unmount animation. Scenes never unmount.

8. **Stop at the checkpoint boundary.** Implement only that checkpoint, run its
   verification, output the report in the format in `CLAUDE.md`, append the WHAT WE DID and
   HOW IT WORKS sections to `docs/IMPLEMENTATION_NOTES.md`, and wait.

9. **Commit messages are exactly as given below.** Subject line only, no body, no trailers —
   that is this repository's convention.

10. **Do not commit `web/src/App.tsx`.** It carries in-flight work on the facility-manager
    platform that is not ready. The `/story` route is already wired in the working tree and
    is deliberately left uncommitted. Do not stage it, and do not "fix" it.

---

## 2. The world map — fixed, do not redesign

All nineteen scenes, with their permanent addresses. Act II is a serpentine: the first row
runs left to right, the second right to left, the third left to right, so the reading's
path through the world is one continuous snake. Every Act II station is 1300 × 850.

| # | id | act | module | cadence | x | y | w | h |
|---|---|---|---|---|---|---|---|---|
| 1 | `plant` | 1 | — | — | 0 | 0 | 1240 | 720 |
| 2 | `pick` | 1 | — | — | 1640 | 140 | 460 | 420 |
| 3 | `record` | 1 | — | — | -520 | 1120 | 3080 | 1680 |
| 4 | `arrival` | 1 | Ingestion | every few minutes | 3400 | 1320 | 1600 | 900 |
| 5 | `ingest` | 2 | Ingestion | every few minutes | 0 | 3000 | 1300 | 850 |
| 6 | `quality` | 2 | Quality scoring | every few minutes | 1600 | 3000 | 1300 | 850 |
| 7 | `context` | 2 | Rule engine · mode gating | every few minutes | 3200 | 3000 | 1300 | 850 |
| 8 | `rules` | 2 | Rule engine | every few minutes | 4800 | 3000 | 1300 | 850 |
| 9 | `constraints` | 2 | Physics constraints | every few minutes | 6400 | 3000 | 1300 | 850 |
| 10 | `baseline` | 2 | Baselines | every few minutes | 6400 | 4100 | 1300 | 850 |
| 11 | `indicator` | 2 | Failure modes | every few minutes | 4800 | 4100 | 1300 | 850 |
| 12 | `health` | 2 | Health index | once a day | 3200 | 4100 | 1300 | 850 |
| 13 | `prediction` | 2 | Remaining life | once a day | 1600 | 4100 | 1300 | 850 |
| 14 | `diagnosis` | 2 | Diagnosis · isolation | once a day | 0 | 4100 | 1300 | 850 |
| 15 | `rootcause` | 2 | Diagnosis · root cause | once a day | 0 | 5200 | 1300 | 850 |
| 16 | `advisory` | 2 | Advisory generation | once a day | 1600 | 5200 | 1300 | 850 |
| 17 | `screen` | 2 | API and interface | on request | 3200 | 5200 | 1300 | 850 |
| 18 | `map` | 3 | — | — | *derived* | | | |
| 19 | `honesty` | 3 | — | — | 4800 | 5200 | 1300 | 850 |

**Scene 18 is the one derived box.** Its rectangle is `union()` of every other scene's
rectangle, computed in `scenes.ts`, because it is the pull-out that has to hold the whole
show. It resolves to roughly 8220 × 6050 at (-520, 0), which frames at scale ≈ 0.13 on a
1440 × 900 viewport. At that scale titles are not readable and are not meant to be — the
scene is about the *shape* of the journey and the path traced through it.

Scenes 1 to 4 sit above the Act II run with a 200-unit gap; the three Act II rows are
250 apart. **Do not change any of these numbers.** If a scene needs more room, say so in
the checkpoint report and stop, because moving one rectangle moves the framing of the
pull-out and the reach of every callback.

---

## 3. Mechanics contracts

Already built in checkpoint 1, do not rewrite:

```ts
// web/src/story/camera.ts
type Box = { x, y, w, h }; type Viewport = { w, h };
type Camera = { x, y, scale };        // x,y is the world point at screen CENTRE
type Rig = { x, y, z, vx, vy, vz };   // z is ln(scale)
FRAME_PADDING = 0.12; MAX_SCALE = 1.6; OMEGA = 9;
centreOf(box); fit(box, viewport, padding?, maxScale?); rigAt(camera); cameraOf(rig);
stepRig(rig, target, dt, omega?); settled(rig, target);
transformOf(camera, viewport); worldToScreen(camera, viewport, point); union(boxes);

// web/src/story/show.ts   — takes beat COUNTS, never scenes
type Spot = { scene, beat }; START;
clampSpot(beats, spot); forward(beats, spot); back(beats, spot); jumpTo(beats, scene);
totalSteps(beats); stepIndex(beats, spot); shown(spot, beat);

// web/src/story/scenes.ts
type Scene = { id, act, title, module?, cadence?, box, reveals };
SCENES; BEAT_COUNTS; sceneById(id);

// web/src/story/useCamera.ts
useCamera(target: Box) => { stage, world }   // writes transform outside React

// web/src/story/useShow.ts
useShow(beats, from?) => { spot, advance, rewind, go }
```

To be built. **Use exactly these signatures** so later checkpoints do not have to adapt:

```ts
// CP2 — web/src/story/Ledger.tsx
Ledger({ upTo }: { upTo: number })      // upTo = scene index; renders rows for stages <= it

// CP5 — web/src/story/Comet.tsx
Comet({
  points,          // readonly { t: number; v: number }[] in world coords already mapped
  head,            // index of the leading point
  tailLength,      // how many points of history stay visible behind the head
  colour,          // a token-derived string
  label,           // what the HUD chip shows: "32.4 °C", "residual", "indicator"
}): JSX.Element

// CP7 — web/src/story/Callback.tsx
Callback({ from, to, active }: { from: Box; to: Box; active: boolean })
// Draws in WORLD coordinates inside the world element. Never uses worldToScreen.

// CP7 — the camera target while a callback is showing
cameraTargetFor(scene: Scene, spot: Spot): Box
// Returns scene.box normally; returns union([scene.box, target.box]) on the beat that
// points somewhere. Lives in scenes.ts. Must return a STABLE object reference for the
// same input, or the camera restarts every render — memoise per (scene id, beat).

// CP8 — web/src/story/BackgroundRail.tsx
BackgroundRail({ stage }: { stage: number })   // other assets' progress, out of step
```

**The referential-stability rule bites here.** `useCamera` retargets whenever the box
object identity changes. Anything computing a box must return the same object for the same
inputs. This is the single easiest way to break the camera, and the symptom is a camera
that never settles and a fan that never stops.

---

## 4. The snapshot — CP2's output shape

One committed file, `web/src/story/snapshot.json`, generated by
`web/scripts/make-snapshot.ts` from the running API. The walkthrough imports it directly
and never fetches anything. A presentation that shows a fetch error is unrecoverable.

```ts
// web/src/story/snapshot.ts — the type, hand-written, next to the data
export interface Snapshot {
  generatedAt: string;          // ISO, when the snapshot was taken
  asset: { id: string; kind: string; label: string };
  point: { id: string; unit: string; label: string };

  commissioning: { days: number; from: string; to: string };

  // The reading and its history. `series` is oldest-first.
  series: readonly { t: string; v: number }[];
  reading: { t: string; v: number };          // the one we follow: 32.4 °C

  quality: { score: number; checks: readonly { name: string; score: number; passed: boolean }[] };
  context: { running: boolean; minutesSinceStart: number; tons: number; gates: readonly { name: string; passed: boolean }[] };
  rules: readonly { id: string; label: string; usesThisPoint: boolean; fired: boolean; sustainedMinutes: number }[];
  constraints: readonly { id: string; label: string; residual: number; normalised: number }[];

  baseline: {
    model: string;
    drivers: readonly string[];
    expected: readonly { t: string; v: number }[];   // same timestamps as `series`
  };
  residuals: readonly { t: string; v: number }[];

  indicator: {
    failureMode: string;
    unit: string;
    threshold: number;                                // 3.0 K
    thresholdBasis: readonly string[];                // the three justifications
    series: readonly { t: string; v: number }[];
  };

  health: {
    value: number;                                    // 50
    band: "healthy" | "watch" | "degraded" | "critical";
    excess: number;                                   // 1.5 K
    arithmetic: string;                               // "100 × (1 − 1.5 ÷ 3.0) = 50"
    daily: readonly { t: string; v: number }[];
    onset: string | null;
  };

  prediction:
    | { kind: "estimate"; dates: { early: string; likely: string; late: string };
        fan: readonly { t: string; low: number; mid: number; high: number }[] }
    | { kind: "refusal"; reason: string };

  diagnosis: { faultClass: "sensor" | "equipment" | "control" | "ambiguous";
               relations: readonly { id: string; label: string; includesPowerMeter: boolean }[];
               caveat: string | null };

  rootCause: { upstream: string | null; consequential: boolean; demotedBeneath: string | null };

  advisory: {
    id: string; title: string; severity: string;
    energy: { perKelvin: number; kelvin: number; hours: number; tariff: number; total: number; basis: string };
    consequential: { probability: number; failureCost: number; plannedCost: number; total: number };
    action: { job: string; hours: number; rate: number; parts: number; total: number };
  };

  // Other assets, for the background rail. Only what the rail draws.
  others: readonly { id: string; label: string; stage: number; note: string }[];
}
```

**If the API cannot supply a field, do not fill it in.** Leave the generator failing, report
exactly which endpoint returned what, and stop. Several fields have known homes:
`/engine/trace` for the per-stage walk, `/prediction/explain` for the fan and the refusal,
`/diagnosis/pair` for the fault class and relations, `/advisories` and its detail for the
costs, `/assets/{id}/health` for the daily health, `/config/rules` and `/config/modes` for
the rule and mode registries.

### Figures that must appear, and their sources

These are the numbers from the pipeline write-up. They are the acceptance criteria for the
snapshot being right — if the generated file disagrees with one of them, the *snapshot* is
reporting the system and the write-up may be stale, so report the difference rather than
editing either to match.

| Figure | Value in the write-up |
|---|---|
| the reading | `chiller-1.cdw_leaving_temp = 32.4 °C` |
| quality gate | composite is the worst of five checks; must clear 50 |
| context gates | running, started over an hour ago, above twenty tons |
| rules | 2 of 3 chiller rules take it; must hold one hour |
| indicator threshold | 3.0 K excess, 7–9% compressor power penalty, 7× baseline spread |
| health | 1.5 K excess → `100 × (1 − 1.5 ÷ 3.0) = 50`, degraded |
| energy cost | excess K × 1.876 kW/K × running hours × $0.128/kWh |
| the 1.876 basis | 2.5% of measured mean 75.04 kW per kelvin of extra lift |
| consequential | P(cross within 90 days) × ($165,000 − $18,000) |
| cost of acting | brush condenser tubes, 8.0 h × $95/h + $850 parts = $1,610 |
| commissioning | 21 days |
| instruments | 107, of which 3 defective at source |

---

## 5. The thirteen stages — content spec

Per stage: the question it answers, the apparatus on screen, and its beats. Beat labels
should read as the presenter's next action, as in checkpoint 1's stubs. Keep to the beat
counts given — they set the rhythm, and the readout shows them.

**5 · ingest** — *Is this number in the system, in the right unit, at the right time?*
Funnel. The number is stamped SI on the way in. A slower bucket fills behind it: the hourly
rollup, and the first moment two things are shown happening at once. Writes
`app.measurements`, `app.measurements_hourly`. **4 beats.**

**6 · quality** — *Is the instrument telling the truth right now?* Five gates in series. The
composite is the worst of the five, not the average. A second, bad reading is stopped dead at
gate three so refusal is shown rather than described. Writes `quality_score`,
`quality_flags`, `app.sensor_advisories`. **5 beats.**

**7 · context** — *Is this a moment in which anything can fairly be judged?* Three dials:
running, started over an hour ago, above twenty tons. **Show the failing case first** and
grey the whole downstream run. Writes nothing — it gates. Say out loud that three of the
thirteen stages exist mainly to refuse. **4 beats.**

**8 · rules** — *Does any physics assertion about this machine fail to hold?* Nine assertion
cards; two of the three chiller rules reach out and take our number. A persistence bar fills
toward one hour, and a rule that fired for twenty minutes is visibly discarded. Writes rule
findings. **4 beats.**

**9 · constraints** — *Is this set of readings physically consistent?* A balance scale;
chiller-1's energy balance weighed both sides. The miss is recorded raw and normalised.
Writes `app.constraint_residuals`. **4 beats.**

**10 · baseline** — *Given exactly what is being asked of this machine right now, is this the
number it should be producing?* Split screen, expected against observed. **First callback:**
the baseline was fitted on the 21 commissioning days, so the camera widens to hold this
scene and scene 3 together, a line is drawn, scene 3's card lights, and the camera returns.
`observed − expected` drops out as a second, smaller comet. Writes `app.residuals`.
**6 beats.**

**11 · indicator** — *For this specific way of failing, what is the one number that tracks
it?* The residual is renamed the condenser-fouling indicator — the comet changes identity
rather than being replaced. Threshold drawn at 3.0 K with its three justifications
annotating in. Writes an indicator series per machine per failure mode. **5 beats.**

**12 · health** — *How much of the way to failure has this machine travelled, and did it
really start?* **The tempo change.** The cadence badge flips to once-a-day and the show
slows. Daily median, onset test, clamp, then the arithmetic types out and the badge lands on
degraded. Writes `app.health_state`, `indicator_raw`, `indicator_monotonic`, `t_onset`.
**6 beats.**

**13 · prediction** — *If it keeps worsening like this, when does it reach the threshold that
has a physical argument behind it?* The fan grows forward in time. The monotonic clamp is a
ratchet: scale and biofilm do not fall off tubes by themselves. Three dates. In the
background rail another asset is refused at this same stage. Writes `app.rul_estimates`, or
the refusal with its reason. **5 beats.**

**14 · diagnosis** — *Do we send somebody with a calibration kit, or somebody with a
wrench?* Chiller-1's three relations light up and its power meter appears in two of them.
**State the weakness on screen** — a developed fault here can be misread as a faulty meter,
and the fix is declaring more relations. Writes a fault class per machine per window.
**4 beats.**

**15 · rootcause** — *Could an open fault upstream be producing this symptom?* **The biggest
camera move.** Pull back to the plant view, walk upstream to the cooling tower, then play the
alternative world where the tower has an open fault and this advisory demotes itself beneath
it as consequential. Writes a consequential link and a demoted rank. **5 beats.**

**16 · advisory** — *What should be done, by whom, and what does waiting cost?* Three numbers
assemble: energy, consequential risk, and against them the $1,610 job. Each figure, as it
lands, fires a short callback to whichever earlier card it came from. Writes `app.advisories`.
**6 beats.**

**17 · screen** — *What does the operator see, and can they trust it is only what was known
at the time?* The advisory card flies out of the world and becomes the real worklist row.
**A frozen render, not the live app**, with a button offering to open the real thing. Writes
nothing — every endpoint reads. **4 beats.**

---

## 6. Checkpoints 2 to 11

Every checkpoint: extend `verify-story.ts`, run `npm run verify:story` and
`npx tsc --noEmit` (expect zero errors under `story/`; two pre-existing errors in
`web/src/lib/schematic.ts` are not yours), append to `docs/IMPLEMENTATION_NOTES.md`, report,
wait. Commit only the files that checkpoint created, never `App.tsx`.

### CP2 — the snapshot and the ledger
Files: `web/scripts/make-snapshot.ts`, `web/src/story/snapshot.json`,
`web/src/story/snapshot.ts`, `web/src/story/Ledger.tsx` + `.module.css`, `package.json`
(a `snapshot` script).
Needs the backend — see section 7.
Accept: the generator runs against the live API and writes the file; the snapshot's
`series` and `baseline.expected` share timestamps; `health.value` is 50 and its `arithmetic`
string matches; the twelve figures in section 4 are present and agree; the ledger renders one
row per stage up to a given index and none beyond it.
Commit: `feat: the walkthrough's frozen snapshot and stage ledger`

### CP3 — the plant, and the blast
Files: `web/src/story/scenes/Plant.tsx`, `Pick.tsx`, and their CSS; a light colour variant
in `web/src/lib/schematic.ts`.
Accept: the plant renders from `lib/schematic.ts` geometry, not new coordinates; 107
instrument ticks with 3 struck through; the blast is one continuous transform with nothing
remounting; every other asset leaves the viewport and chiller-1 is left alone.
Commit: `feat: the plant, and blasting one asset out of it`

### CP4 — what we already know
Files: `web/src/story/scenes/Record.tsx` + CSS.
Accept: eight cards, each addressable by name so CP7 and CP10 can point at them; each card's
world box is exported and stable; contents come from the snapshot, not from prose.
Commit: `feat: everything known about the machine before a reading arrives`

### CP5 — the comet
Files: `web/src/story/Comet.tsx` + CSS, `web/src/story/scenes/Arrival.tsx` + CSS.
Accept: the history draws and the head holds at 32.4; the tail fades over the documented
number of points; the HUD chip tracks the head; the comet element is created once and its
identity survives a scene change.
Commit: `feat: the reading arrives, with its history behind it`

### CP6 — the fast-cadence stages
Files: `web/src/story/scenes/Ingest.tsx`, `Quality.tsx`, `Context.tsx`, `Rules.tsx`,
`Constraints.tsx`, and CSS.
Accept: all five drop their ledger rows in order; scene 7's refusing branch plays and greys
the downstream run; scene 8 discards a twenty-minute firing on screen.
Commit: `feat: the five stages that run every few minutes`

### CP7 — baseline, indicator, and the callback
Files: `web/src/story/Callback.tsx` + CSS, `scenes/Baseline.tsx`, `scenes/Indicator.tsx`,
`cameraTargetFor` in `scenes.ts`.
Accept: the camera frames scene 10 and scene 3 together and returns to *exactly* its prior
box (assert the returned box is the same object); the callback line is drawn in world
coordinates and needs no screen arithmetic; the comet changes identity from residual to
indicator without being recreated.
Commit: `feat: the baseline, the indicator, and pointing back at what justified them`

### CP8 — health, prediction, and the rail
Files: `web/src/story/BackgroundRail.tsx` + CSS, `scenes/Health.tsx`,
`scenes/Prediction.tsx`.
Accept: the cadence badge changes at scene 12 and the beat timing visibly slows; the
arithmetic renders from the snapshot; the fan is hand-rolled SVG; another asset's refusal
plays in the rail while ours publishes.
Commit: `feat: health, remaining life, and the work happening alongside`

### CP9 — diagnosis, root cause, advisory
Files: `scenes/Diagnosis.tsx`, `scenes/RootCause.tsx`, `scenes/Advisory.tsx`.
Accept: scene 14 states the power-meter weakness on screen; scene 15 reaches plant scale and
returns without drift (assert the camera lands on the same box it left); the three advisory
figures come from the snapshot and each fires its callback.
Commit: `feat: sensor or machine, the real culprit, and the advisory`

### CP10 — the handoff, the map, the honesty
Files: `scenes/Screen.tsx`, `scenes/Map.tsx`, `scenes/Honesty.tsx`.
Accept: scene 17 shows a frozen worklist row; scene 18's derived box contains all eighteen
others and frames above scale 0.1; scene 19 carries the batch-not-streaming statement and the
four things that never happen.
Commit: `feat: the handoff to the product, the whole map, and the honest limits`

### CP11 — presenter controls
Files: `web/src/story/Story.tsx`, `useShow.ts`, a scene rail component.
Accept: every scene reachable at `/story/:id` and the URL follows as the show advances; a
scene list can be opened and jumped from; autoplay runs the whole show unattended at a
settable pace; the static fallback renders every beat at once for printing.
Commit: `feat: presenter controls, deep links and an unattended run`

---

## 7. Bringing the backend up

The walkthrough itself never needs the backend — it reads the committed snapshot. **Only CP2
needs it**, to generate that snapshot.

This machine had no database and no container when this was written, so the full chain is
required once:

```bash
open -a Docker                  # the daemon must be running first
make demo                       # db-up, load, then the whole analytics chain
make api                        # serves :8000
make reveal                     # optional, :8002, the answer key
```

`make demo` is `db-up load scenarios quality residuals baselines health rul
advisories-write advisory-replay engine-trace`. It pulls a TimescaleDB image, applies
`scripts/schema.sql`, ingests from `data/raw` (14 GB), then runs every analytics stage. It is
long. Run it in the background and read the log rather than waiting on it in the foreground.

Check it worked before generating anything:

```bash
curl -s localhost:8000/clock/eras | head -c 400
curl -s localhost:8000/advisories?status=open | head -c 400
```

If `make demo` fails, report the actual failure from the log and stop. Do not generate a
snapshot from a partially loaded database — it would be wrong in ways nobody could see.

To tear it down: `make db-down`.

---

## 8. When you are blocked

Stop and report. Specifically:

- **A figure the snapshot needs is not served by any endpoint.** Report which figure and
  which endpoints were tried. Do not compute it in the frontend — the point of the snapshot
  is that the numbers come from the system that produced them.
- **A scene does not fit its rectangle.** Report it and stop; do not resize the rectangle,
  because that moves the pull-out framing and every callback's reach.
- **A verification check fails.** Report the actual output. Re-read house rule 2 before
  touching any threshold.
- **A checkpoint is larger than it looks.** Say so and propose a split rather than running
  long or silently merging two checkpoints.
