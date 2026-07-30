# The Reading's Journey — plan for the animated walkthrough

A cinematic, presenter-driven walkthrough that follows **one number**
(`chiller-1.cdw_leaving_temp = 32.4 °C`) from the sensor to a work order on a
named person's screen. Audience: a facility manager who does not code and does
not want a system diagram.

The prose, the stage list and every figure below already exist and are checked —
they come from the pipeline HTML and from the code in this workspace. This
document is about turning that argument into something that **moves**.

---

## 1. The one architectural idea

**Do not build slides. Build one world and move a camera through it.**

Every "crazy transition" the brief asks for — blasting an asset out, zooming
back to a past slide to show a callback, keeping background work visible — is
trivially available if scenes are *places in a single coordinate space* and
impossible if scenes are separate DOM trees that swap.

```
   world (one <div>, one transform)
   ├── layer: plant          (the schematic, always present, usually far away)
   ├── layer: asset-record   (chiller-1 exploded, sits to the right of the plant)
   ├── layer: pipeline       (13 station cards on a long horizontal run)
   ├── layer: callbacks      (lines drawn between any two cards in world space)
   └── the comet             (ONE element, travels the whole show, never remounts)

   camera = { x, y, scale }   ← scenes declare a target box; the camera eases to it
```

Consequences worth stating out loud, because they are the whole design:

- **Zooming back to a past slide is a camera move, not a rewind.** Scene 10
  needs to point at the 21 commissioning days introduced in scene 3? The camera
  widens to fit both cards and a line is drawn between them. Nothing unmounts,
  nothing re-renders, no state is restored.
- **Parallel work is literally visible** because the other assets' station cards
  are in the same world, just outside the current viewport. Pull back slightly
  and you see tower-1 and ahu-1 mid-pipeline while chiller-1 is at stage 8.
- **The final zoom-out is free.** Scene 18 just sets `scale` low enough to fit
  everything, and the entire journey is on screen at once with the comet's path
  traced through it. That is the money shot and it costs one line of scene data.

The measurement is a **single persistent element**. It is never re-created
between scenes. That is what makes the show feel like one continuous take
instead of nineteen unrelated animations.

---

## 2. Where it lives, and with what

**Recommendation: a route inside the existing app** — `/story`, files under
`web/src/story/`, mounted in `App.tsx` next to the existing `/fm` handoff
(`App.tsx` already branches on `location.pathname.startsWith("/fm")`; this is
the same pattern).

Why not a standalone HTML file: the schematic geometry, the design tokens, the
severity bands and the number formatting all already exist here and would have
to be duplicated and then kept in sync by hand.

Stack, staying inside the standing constraints (React + TS + Vite, plain CSS
modules, **no new dependencies**, no component libraries, no tests):

| Need | How |
|---|---|
| Camera + scene easing | `requestAnimationFrame` loop over a critically-damped spring. ~40 lines. |
| Element-to-element flight ("blast out") | FLIP — measure with `getBoundingClientRect`, animate with the Web Animations API (`element.animate`). Native, no library. |
| The comet and its tail | SVG `<path>` + `stroke-dasharray` offset + a `<linearGradient>` that fades the tail. |
| Charts | Hand-rolled SVG, not Recharts. Recharts cannot be scrubbed frame-by-frame or partially drawn, and every chart here is a *drawing animation*. |
| Reduced motion | `prefers-reduced-motion` → camera snaps instead of eases, all beats reveal at once. Already the convention in the pipeline HTML. |

**Reuse directly:** `lib/schematic.ts` (plant geometry as data — 275 lines,
already pure and already renderable outside a browser),
`components/PlantSchematic.tsx`, `design/tokens.css`, `lib/format.ts` severity
bands, `lib/glossary.ts` + `design/Term.tsx` for inline domain definitions.

### Data: a frozen snapshot, not the live API

The story reads **one committed JSON file**, `web/src/story/snapshot.json`,
generated once by a script from real API output.

A live demo that shows a fetch error, or an empty stretch of calendar, in front
of a facility manager is a catastrophe with no recovery. `web/src/fm/data/seed.ts`
already establishes the frozen-data precedent in this repo. The snapshot carries:
the 21-day commissioning window, ~600 hourly points of `cdw_leaving_temp`, the
fitted baseline's expected series, the residual series, the indicator series,
health per day, the RUL fan, the diagnosis relations, and the finished advisory
with its three cost components.

---

## 3. The script — nineteen scenes

Cadence note that the show must respect: stages 1–7 run *every few minutes*,
stages 8–13 run *once a day*. **The tempo of the animation should visibly slow
at scene 12.** That is not decoration; it is the single most important fact
about how the system actually runs and it can be *felt* rather than stated.

### ACT I — before the number means anything (4 scenes)

**S1 · The plant.** Full schematic, camera wide. Two cooling towers → three
chillers → chilled water loop → air handler coil → five occupied zones, with
flow animating along the pipes. Beats: name the parts (each domain word carries
its `Term` definition); 107 instruments appear as tiny ticks on the assets;
three of them strike through — *defective at source, flagged with a written
reason, before any analysis runs.*

**S2 · The pick — the blast.** Camera dollies toward chiller-1. Every other
asset desaturates and flies outward past the viewport edges (FLIP, staggered
40 ms, easing out fast). Chiller-1 is left alone in the centre, then **explodes
into an exploded-view diagram** — housing, condenser, compressor, its five
instruments separating outward along their normals.

**S3 · What we already know about this machine.** Eight cards settle into orbit
around the exploded chiller. Each flips to show its contents: instruments +
their SI units + physical bounds; the topology edges (what feeds it, what it
feeds); the 6 named failure modes; the 9 physics rules; the physics constraints;
the 5 baseline models; the 16 interventions with hours, trades, parts and cost;
and the 21 commissioning days. The line that has to land: **none of this was
learned from data — it is configuration, and it existed before the first reading
arrived.** Every one of these eight cards gets pinged by a later scene, so their
world positions matter and should be laid out deliberately.

**S4 · The reading arrives — the comet.** Camera swings to an empty chart plane.
The history polyline draws itself left-to-right, fast, weeks compressed into two
seconds. The head arrives at *now*, decelerating, and stops: **32.4 °C**. The
tail is the last ~72 hours at full opacity fading to nothing behind it. From
here the comet is pinned to a persistent HUD chip in the corner carrying its
current value and its current identity — and its identity changes twice later
(scene 10 → residual, scene 11 → indicator), which is worth watching for.

### ACT II — the thirteen stages (13 scenes)

Shared grammar, so the viewer learns the language once: the comet **enters from
the left**, meets the stage's apparatus, **emerges changed**, and drops a row
into a **ledger drawer** pinned to the bottom of the viewport. The ledger
accumulates all show — one line per stage, "what it wrote and where it landed" —
and by scene 17 it is full. That growing ledger is the answer to "so what does
the system actually *have* at the end", and it assembles itself in front of the
viewer instead of being asserted at the end.

| # | Stage | Apparatus on screen | Writes |
|---|---|---|---|
| S5 | 01 Ingest | Funnel. The number gets stamped SI on the way in. Behind it, a slower bucket fills — the hourly rollup. **First background beat.** | `app.measurements` |
| S6 | 02 Quality | Five gates in series; the comet clears each. Score is the *worst* of the five, not the average. A ghost reading is stopped dead at gate 3 to show refusal. | `quality_score`, `quality_flags`, `app.sensor_advisories` |
| S7 | 03 Context | The gate that writes nothing. Three dials: is it running, did it start over an hour ago, is it above twenty tons. Show the *failing* case first — the entire downstream run greys out. **"Three of these stages exist mainly to refuse."** | — gate only |
| S8 | 04 Rules | Nine assertion cards; two of the three chiller rules reach out and take our number as an input. A persistence bar fills toward one hour — and a rule that fired for twenty minutes is visibly discarded. | rule findings |
| S9 | 05 Constraints | A balance scale. Chiller-1's energy balance weighed both sides; the miss is recorded raw *and* normalised. | `app.constraint_residuals` |
| S10 | 06 Baseline | Split screen, expected vs observed. **First major callback:** the baseline was fitted on the 21 commissioning days — camera widens to fit both this card and S3's card, a line is drawn, S3's card lights, camera returns. `observed − expected` drops out as a smaller second comet. | `app.residuals` |
| S11 | 07 Indicator | The residual comet is *renamed* the condenser-fouling indicator. Threshold line drawn at **3.0 K**, with its three justifications annotating in: a 7–9% compressor power penalty, the point a tube brushing pays for itself in one season, and seven times the fitted baseline's own spread. | indicator series |
| S12 | 08 Health | **Tempo change — cadence badge flips to "once a day" and the show slows.** Daily median, onset test, clamp. Arithmetic types out: `100 × (1 − 1.5 ÷ 3.0) = 50`. Badge lands on **degraded**. | `app.health_state` |
| S13 | 09 Prediction | Fan chart grows forward in time. The monotonic clamp is drawn as a ratchet — scale and biofilm do not fall off tubes by themselves. Three dates. In the background rail, ahu-1 is **refused** at this same stage. | `app.rul_estimates` |
| S14 | 10 Diagnosis | Sensor or machine. Chiller-1's three relations light up; its power meter appears in two of them. The honest weakness is stated on screen, not hidden. | fault class |
| S15 | 11 Root cause | **Biggest camera move of the show.** Pull all the way back to the S1 plant view, walk upstream to tower-1, then play the alternative world where the tower has an open fault — and our advisory demotes itself beneath it, marked consequential. | consequential link |
| S16 | 12 Advisory | Three numbers assemble: energy at `excess K × 1.876 kW/K × running hours × $0.128/kWh`; consequential risk at `P(cross within 90 days) × ($165,000 − $18,000)`; against it, **8.0 h × $95/h + $850 = $1,610**. Each figure, when it lands, fires a short ping back to whichever earlier card it came from. | `app.advisories` |
| S17 | 13 The screen | The advisory card flies out of the world and **becomes** the real worklist row in the FM app. Story-world hands off to product. | — every endpoint reads |

### ACT III — the shape of the whole thing (2 scenes)

**S18 · The map.** Camera pulls out until all nineteen scene cards are on
screen, the comet's path traced through them as one continuous line, every
callback line drawn at once, ledger fully populated. Held silent for a beat.

**S19 · The honesty slide.** Today this is a **batch pipeline, not a live
streaming service**. The cadence table. The four things that never happen.
Carried over verbatim from the pipeline HTML — the walkthrough must not become
more impressive than the system by omission.

---

## 4. The six mechanics, built once and reused

1. **Camera** — `{x, y, scale}` spring; scenes declare a target world box.
2. **Comet** — SVG path with a dashed, gradient-faded tail; used three times
   (measurement → residual → indicator) with different colours and one identity
   transition each.
3. **Blast (FLIP)** — measure, reparent, `element.animate`. Used at S2, S17.
4. **Callback ping** — draw a line in world space between two cards, widen the
   camera to fit both, pulse the target, return. Used at S10, S15, S16.
5. **Background rail** — a strip showing the other assets' pipelines running out
   of step with ours, so parallelism is shown rather than claimed.
6. **Ledger** — bottom drawer, one row per stage, accumulating.

---

## 5. Build order — eleven checkpoints

Each is one commit, each stops for a checkpoint report.

| CP | Scope | Verification |
|---|---|---|
| 1 | Scene machine, camera spring, `/story` route, three stub scenes | Arrow keys move the camera between stubs; reduced-motion snaps |
| 2 | `snapshot.json` + the generator script + the ledger drawer | Snapshot's series lengths and the advisory's three cost components print correctly |
| 3 | S1 plant + S2 blast | Plant renders from `lib/schematic.ts`; blast completes in one continuous transform, nothing remounts |
| 4 | S3 asset record, eight cards, world positions fixed | Each card's world box is addressable by name (S10/S15/S16 depend on this) |
| 5 | S4 comet mechanic | Comet draws its history and holds at 32.4; the HUD chip tracks it |
| 6 | S5–S9 (the fast-cadence stages) | All five drop their ledger rows; S7's refusing branch plays |
| 7 | S10–S11 + the callback mechanic | Camera fits both cards and returns to exactly its prior box |
| 8 | S12–S13 + the background rail | Tempo change is visible; ahu-1's refusal plays in the rail |
| 9 | S14–S16 + the big camera move | S15 reaches plant scale and returns without drift |
| 10 | S17–S19 | Handoff lands on a real FM row; S18 fits all nineteen cards |
| 11 | Presenter controls — keyboard, `/story/:scene` deep links, autoplay, speed, static fallback | Every scene is reachable by URL; the whole show plays unattended |

---

## 6. Open decisions — need a call before CP1

1. **Palette.** The pipeline HTML uses the light `tokens.css` palette; but
   `lib/schematic.ts` hardcodes a *dark* plant palette (`#1e2833` fills). The
   story cannot use both. Recommendation: light tokens throughout, and add a
   light variant to the schematic colour table — the walkthrough will be shown
   on a projector, and dark plant drawings on a bright projector wash out.
2. **Driven by presenter or by scroll.** Recommendation: presenter (space /
   arrows / click advances one beat), because a facility manager is being *shown*
   this by someone. Scroll-driving costs the ability to hold a beat.
3. **Does S17 embed the live FM app**, or a frozen render of it? Live is more
   convincing and more fragile. Recommendation: frozen render, with a "open the
   real thing" button beside it.
