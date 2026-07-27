# Architecture

How Aqueduct PDM is put together, layer by layer, and for every choice that mattered,
what the alternative was and why it lost.

The long-form argument for the nine largest decisions lives in [`AI_LOG.md`](AI_LOG.md),
one entry each, with the options considered and the outcome recorded after the fact. This
document is the map: it says what each layer does, what it consumes, what it hands on, and
what it decided not to be. Where an entry in the log covers a decision, it is cited by
number and title. Where a decision has no log entry, the reasoning is given here in full.

Every accuracy figure quoted below is from [`VALIDATION.md`](VALIDATION.md), which is
regenerated from the database on every run and contains no hand-written numbers.

---

## The shape of it

Eleven layers, each consuming the one above. Nothing skips a layer and nothing reaches
back up.

```
  CSVs (LBNL)          simulator/            ingestion/
       │                    │                     │
       └──── severity ladder┴─── trajectories ────┤
                                                  ▼
  1  ingest              app.measurements   ─────────────►  app.measurements_hourly
                                                  │              (continuous aggregate)
  2  quality scoring     app.sensor_advisories, per-reading scores
                                                  │
  3  semantic graph      model/*.ttl  ──►  app.asset_edges, app.points, app.assets
                                                  │
  4  rule engine         nine physics rules, dispatched by Brick class
                                                  │
  5  baselines           app.residuals, app.constraint_residuals
                                                  │
  6  health index        app.health_state          (one number per mode per day)
                                                  │
  7  RUL estimation      app.rul_estimates         (full history, every date kept)
                                                  │
  8  cross-asset         upstream traversal, consequential demotion
                                                  │
  9  advisories          app.advisories            (what a human is asked to read)
                                                  │
  10 API                 nine FastAPI endpoints
                                                  │
  11 UI                  React dashboard, advisory detail, plant schematic

  validation/            runs 1-9 end to end and scores them against groundtruth.*
```

Two databases' worth of tables in one database, under two credentials. Schema `app` is
everything the platform computes. Schema `groundtruth` is the answer key. The role every
analytics layer connects as has **no grant of any kind** on `groundtruth` — not restricted
access, none. That is the architectural spine of every accuracy claim this project makes,
and it is enforced by the database rather than by discipline.

Two components open the other credential, and neither of them detects, scores, predicts or
diagnoses: `validation/`, which regenerates `VALIDATION.md`, and `reveal/`, which serves the
demonstration's answer-key screen as **a separate process on a separate port**. The reveal
was built that way rather than as three more routes on `api/` precisely because the
alternative would have put the answer key inside the process that serves detections, leaving
the separation resting on nobody adding the wrong import. The claim is therefore not "the
answer key is unreachable from the running system" — it is reachable, by design, from one
process that computes nothing — but "the detection path connects as a role that cannot read
it", which is checkable and is checked.

About 21,000 lines of Python and 2,400 lines of TypeScript.

---

## Layer by layer

### 1. Ingest — `ingestion/`

Reads the LBNL CSVs into a TimescaleDB hypertable through a per-system YAML manifest that
names every column, its native unit, its SI unit, and the point id it becomes. Resamples
from the source cadence to five minutes and converts units on the way in, so nothing
downstream ever handles a Fahrenheit or a gallon per minute.

**Rejected: PostgreSQL without TimescaleDB.** See [D-01](AI_LOG.md). A year of one point
at the native cadence is over half a million rows and this building has 107 points; the
hypertable's chunking and the continuous aggregate are what make a four-month window
queryable in the API path. The lesson cut both ways later — `app.health_state` and
`app.rul_estimates` are deliberately *not* hypertables, because one row per mode per day
is a few thousand rows in total and weekly chunks would create more chunks than any chunk
would hold rows.

**Rejected: a units column and conversion at read time.** Converting on ingest means the
unit is a property of the manifest, checked once, rather than a property of every query.
The cost is that a units bug requires a reload; that happened once, in checkpoint 2.2,
and it was worth it for every query since.

**Rejected: trusting the manifests' prose.** Three of the 107 measurements are defective
at source in ways no per-row processing can repair, and all three were documented as DO
NOT USE in manifest comments. Prose is not enforcement — the advisory layer read one of
them anyway and put a static pressure of −99,698 Pa at the top of every air-handler
advisory's evidence list. `app.points.usable` with a required `unusable_reason` is that
prose made machine-readable.

### 2. Quality scoring — `analytics/quality/`

Scores every reading 0–100 across five dimensions — is it present, is it inside its
physical envelope, has it stopped moving, did it arrive on time, is it a spike — and
records which dimensions each score failed. A reading below 50 is not fed to a rule.

**Rejected: dropping bad readings.** A dropped reading is indistinguishable from a
reading that was never taken, and the difference matters: a sensor that has gone flat is a
finding in its own right. Scoring keeps the reading and the reason.

**Rejected: one composite score.** The breakdown is kept because the dimensions imply
different actions. Staleness in particular is discounted where the rule engine reads it:
the supply fan sitting at full command for two hours scores badly for not moving and is
perfectly trustworthy.

**Not scored as fault detection.** The quality layer's own advisories are excluded from
every accuracy figure in `VALIDATION.md`, in both directions. They are correct about a
different question, the answer key holds no instrument-failure labels to score them
against, and folding them in would charge the fault detector for findings that were right.

### 3. Semantic graph — `model/`

The Brick Schema model of the building: what equipment exists, what points it has, what
feeds what. Four sources are merged into one graph — the two `.ttl` models LBNL ships with
the datasets, read from `data/raw/ttl/`; two project extension files under `model/` in an
`mvn:` namespace that adds what Brick does not model, namely criticality tier, replacement
and repair cost, occupants served, the physical constraints each asset must satisfy, and
the site's electricity tariff and labour rate; and Brick's own class hierarchy, extracted
from the published 1.3 ontology and **vendored into the repository** because every dispatch
point in the system resolves through it and a build that needed to fetch an ontology would
be a build that could fail offline. `app.asset_edges` is a materialised cache of the
transitive `feeds` closure, rebuilt by an independent breadth-first walk so the SPARQL
traversals can be cross-checked against it.

**Rejected: Project Haystack, and a custom graph.** See [D-04](AI_LOG.md). Briefly: Brick
is RDF, so the traversals are SPARQL rather than hand-written recursion, and its class
taxonomy is what every dispatch in the system keys on. A custom graph would have needed
its own transitive closure and its own subclass reasoning.

**Rejected: string equality on class names.** Brick declares `brick:AHU` equivalent to
`brick:Air_Handling_Unit` in one direction only. Matching on strings silently fits
nothing, which is exactly what it did on the first run of the baseline layer. Every
dispatch point — rules, baselines, failure modes — resolves through the class closure
instead.

**Rejected: modelling one asset as one graph node.** The air handler is a coil, two fans,
three dampers and five zones. Only the cooling coil is on the receiving end of the chilled
water loop and only the supply fan is the origin of the air path, so traversals start from
every node of an asset and union the results. Starting from "the node called ahu-1" finds
nothing upstream.

### 4. Rule engine — `analytics/rules/`

Nine physics-derived rules: the six APAR air-side rules (NIST, House et al. 2001 /
Schein et al. 2006) and three chiller performance rules. Rules are registered against a
Brick class by decorator and dispatched onto whatever assets the graph says are of that
class or a subclass of it.

**Rejected: one rule function per asset.** See [D-05](AI_LOG.md). Registration by class is
what makes the extensibility property below true.

**Rejected: firing on the instant the condition goes true.** A rule true during a gust or
a setpoint change is not a fault. Every rule's firings are grouped into unbroken stretches
and a stretch is reported only once it has held for the sustain delay. Crucially a stretch
is broken by an evaluated instant where the rule did not fire, but *not* by the gaps where
evaluation was suppressed — a fault does not stop existing because the unit changed mode.

**Rejected: evaluating always.** Rules are held quiet for the first hour after the
building opens or a chiller starts, and after any mode change, because neither machine is
in thermal balance then. On the chiller this is driven from a running state derived from
status *and* real power *and* real flow, all three, because chiller 1's status point reads
1 for every sample of the year and status alone would never mark it off.

**Rejected: one alarm per episode.** Nine afternoons of the same saturated valve is one
finding, not nine — the operator needs to know the valve has been saturating for two
months. The episode count and peak severity are carried in the detail so nothing is lost.
Counting the other way would make the false-alarm rate a function of how choppy the
weather was.

**Deliberately absent: any rule for non-condensable gas.** Reserved so that unsupervised
detection can be shown catching a fault the rule library does not cover. Two honest
qualifications, recorded in the module itself: the LBNL chiller dataset contains no
non-condensable gas run at all, and the fault this project actually holds out is cooling
tower fouling. No rule references a tower point, a tower approach, or the wet-bulb
temperature — and `VALIDATION.md` confirms zero rule firings on the tower run.

### 5. Condition-normalised baselines — `analytics/baselines/`

What healthy equipment does *given what is being asked of it*, fitted on a three-week
commissioning window at the start of each run. Every baseline is physics-form: the terms
come from the equation the equipment obeys, not from throwing polynomials at data, so the
coefficients mean something and the model does not fly apart just outside its fitted
range. Observed minus expected is stored per point. The `mvn:constrainedBy` relations in
the graph are evaluated the same way, giving a second family of residuals.

**Rejected: static thresholds.** See [D-06](AI_LOG.md). This is the documented cause of
false-positive fatigue in building fault detection, and the reason is simple: almost every
quantity worth watching moves further with operating conditions than with equipment
health. A supply fan drawing 900 watts is alarming at half airflow and unremarkable at
full airflow, and a fixed limit fires on the hot afternoon rather than the failing
bearing.

**Rejected: a generic function approximator.** A fitted polynomial or a small neural net
would have scored better in-sample and produced coefficients nobody could sanity-check.
Physics-form terms mean a reviewer can look at a fitted kW-per-ton model and say whether
the lift coefficient has the right sign.

**Rejected: one fitter per equipment class.** There is one `fit_baseline`, and it knows
nothing about air handlers or chillers. What differs per class is packed into a
`ModelForm` — how to turn measured points into the quantities the physics is written in,
what the design matrix looks like, and when the model is valid at all.

### 6. Health index — `analytics/health/`

One number per asset per failure mode per day, 0–100, where 100 is the value the asset was
commissioned at and 0 is the failure threshold in `app.failure_modes`. Onset detection
runs first on the raw daily series, then the series is centred on the commissioning mean,
then clamped so health can only fall.

**The order of those three steps is the design.** A clamped series is monotone by
construction, so a changepoint detector run after the clamp would be finding the clamp
rather than the fault.

**Rejected: averaging across modes.** A chiller whose compressor is perfect and whose
condenser is at 10 is a chiller about to fail, and the mean of those two describes a
machine that does not exist. The roll-up is the minimum, and it records which mode
produced it — the single most useful field for a technician, because it turns "this
chiller is at 40" into "this chiller is at 40 because of its condenser".

**Rejected: clamping each point to the previous one.** Isotonic regression finds the
closest never-increasing version of a wobbly line; crude clamping bakes a noisy first week
in as a permanent ceiling.

**Rejected: clamping across repairs.** `app.maintenance_events` is empty and expected to
be — neither LBNL dataset records maintenance. It exists because a cleaned condenser
genuinely *has* recovered, and without an explicit reset the clamp would hold a repaired
machine at its worst-ever score forever and the remaining-life estimate would keep
predicting a failure that had already been prevented.

**Rejected: assuming zero when there is no commissioning reference.** A mode whose
indicator does not read zero when healthy, scored against zero, produces a confident wrong
answer. That is how the clean chiller first came out at 68 on a mode whose reference window
held six days. Such modes now return nothing and are reported as unscored.

**Both the raw and the clamped indicator are stored**, so the clamp can be audited rather
than trusted.

### 7. RUL estimation — `analytics/rul/`

Fits a Wiener degradation process to the post-onset daily increments, updates the belief
about the drift rate as evidence accumulates, and converts it to a first-passage
distribution over when the indicator will cross its threshold. Every date's estimate is
kept, not just the latest.

**Rejected: an LSTM or a Transformer.** See [D-07](AI_LOG.md). The parametric model buys
three things a deep model cannot give here: a prediction *interval* rather than a point,
the ability to refuse when the drift cannot be separated from zero, and a belief that
visibly tightens as evidence arrives. On the coil-leak run, across 84 successive estimates,
the P10-to-P90 interval starts at 2,259 days on 14 post-onset samples and ends at 59 days
on 53 — a 97% close. It is **not monotone**: it widens to 3,479 days at 44 samples before
closing, which is what a Bayesian update looks like when a run of steeper days arrives and
the process variance is revised upward with the rate. A deep model cannot show you a belief
tightening or a belief being revised, because there is no belief in it, only an output.
There is also no run-to-failure corpus here to train one on.

**Rejected: always producing a number.** The refusal layer declines to publish when the
drift is not significantly different from zero, when there are too few post-onset samples,
or when the crossing is beyond a ten-year horizon — and it reports the specific reason
where the interval would have gone. A maintenance planner reading "likely to fail in 40 to
120 days" and one reading "cannot bound this: the drift is 0.8 standard deviations from
zero" make different decisions, and collapsing the second into a vague version of the
first is the easiest way to make the whole system untrustworthy.

**Rejected: an unfloored process variance.** The monotone clamp upstream removes real
variance, so a spread estimated from the clamped series makes the interval too narrow. It
is floored at the spread the same indicator showed during commissioning.

**Every date is kept** because the most convincing thing this system can show a human is
the interval narrowing, and that is only visible if every intermediate answer — including
the wrong ones — was written down.

### 8. Cross-asset root cause — `analytics/diagnosis/`

Two independent questions, deliberately separated.

*Sensor or equipment?* Write down every relation between measurements that ought to hold —
the physical constraints and the baselines, because a baseline is a relation too — observe
which stopped holding, then ask whether one sensor reading consistently wrong would make
them all hold again. If yes, that sensor is the suspect and the machine is probably fine.
See [D-08](AI_LOG.md).

*Is this symptom someone else's fault?* Traverse `^brick:feeds+` upstream. If an upstream
asset has an open fault whose failure mode could plausibly produce this downstream symptom,
mark the downstream advisory consequential, link it to the cause, and **demote** it.

**Rejected: hiding consequential advisories.** See [D-09](AI_LOG.md). The argument is an
asymmetry, not a preference. Demoting wrongly gives a badly ordered queue and the operator
works it anyway. Suppressing wrongly makes a genuine fault *absent*, and they find out when
the equipment fails — after which they read the raw alarm list and every layer above is
worth nothing. `VALIDATION.md` shows this was the right call on the only case this dataset
can produce: the one demotion is a **wrong attribution**, and because the advisory was
demoted rather than hidden it is still on screen carrying the sensor badge and the evidence
that contradicts the attribution.

**Rejected: topology alone as grounds for a link.** Two connected assets with concurrent
faults are not a causal chain. A cause must be a fault that degrades **the medium the
downstream asset consumes** — a declarative plausibility map states which upstream failure
modes can produce which downstream symptoms, and it refuses on both real windows in the
dataset because the open upstream faults there cost power rather than capacity and cannot
warm the water.

**Rejected: differentiating the constraint sensitivities by hand.** The expressions are not
all linear — the coil balance multiplies valve position by a temperature difference — so
partials would need re-deriving every time somebody edits a `.ttl`. Each is obtained
numerically by nudging that point's values and re-evaluating the compiled expression.

### 9. Advisories — `analytics/advisories/`

One object per open fault carrying everything the platform knows: asset, failure mode,
fault class, health, the prediction interval or the refusal reason, the contributing
signals *with their actual values*, the upstream causes and downstream zones and
occupants, a severity, a cost of inaction over the cost of acting, and the recommended
intervention from `app.intervention_library` keyed on failure mode **and fault class**.

**Rejected: hand-tuned priority weights.** Cost of inaction is energy plus consequential
repair: the mode's own indicator times a kilowatts-per-unit coefficient measured on a
fault-free run, times observed duty in the window, times the tariff from the semantic
model; plus the probability of failing inside the horizon times the difference between
replacement and repair cost. Nothing is scaled to look reasonable.

**Rejected: pricing water.** Cooling tower makeup is the one place a fault here would
consume water and neither LBNL dataset publishes a makeup flow — the towers ship a fan
speed, a fan power, a circulating flow and two temperatures, and circulating flow is water
going round the loop, not water bought. Rather than convert an evaporation estimate into
litres and call it traceable, the water term is **absent and stated**.

**Rejected: priority zero when cost cannot be computed.** Unpriceable and worthless are
different answers. Priority is `float | None`, the queue is two-tier — priced rows ranked
by priority above unpriced rows ranked by severity — and the frontend renders `unpriced`,
never `0.00`.

**Rejected: printing health and remaining life side by side without checking they agree.**
They are computed from two different smoothings of the same indicator and on a spiky one
they can contradict flatly. On the supply fan, health said 63 while the median said zero
days left, and that pair carried $68,400 of consequential cost to the top of the queue.
When they contradict, the advisory now withholds the prediction and says so.

### 10. API — `api/`

Nine endpoints, Pydantic v2 response models, one connection per request.

**Rejected: serving `app.measurements`.** Timeseries come from the hourly rollup, always.
A year of one point at five minutes is over a hundred thousand rows and no chart can draw
them; more importantly, serving raw would let a client pull the whole measurement history
one request at a time.

**Rejected: re-modelling the advisory detail field by field.** The payload is deeply
nested and its shape is already fixed by the advisory layer, so re-declaring forty nested
fields would create two contracts to keep in step instead of one. Everything else is a
declared model, because the internal dataclasses must stay free to change as the maths
changes.

**Convention: optional means "the system declines to say", never "we forgot".** A null
`p50` means the model does not bound the crossing; a null `priority` means the cost could
not be computed. Both travel next to a text field carrying the reason.

### 11. UI — `web/`

React, TypeScript, Vite, Recharts, plain CSS modules. An advisory queue sorted by
priority; a detail view with the evidence table, the health trend, the **RUL fan chart**,
the graph trace, the occupant impact and the intervention; and a hand-drawn plant
schematic bound to live data.

**Rejected: a component library.** Explicitly out of scope, and the schematic would have
needed hand-drawn SVG regardless.

**Rejected: putting display logic in components.** Every formatting and charting decision
lives in a pure module — `format.ts`, `chart.ts`, `schematic.ts` — which is what makes the
frontend verifiable without a browser: Node scripts drive the same functions the
components call, check the properties the queue must have, and render the schematic with
`renderToStaticMarkup` into a committed SVG. An SVG is text, so that file is a
reproducible screenshot rather than a description of one.

**Rejected: re-sorting in the view.** `buildRows` deliberately does not re-sort. The
queue's order is the API's answer, and a view that re-sorts can silently disagree with the
ranking the analytics layer computed.

### Validation — `validation/`

Runs layers 1–9 over every scenario, scores them against `groundtruth.fault_events`, and
regenerates `VALIDATION.md` in full on every run.

**Rejected: hand-written numbers.** A validation document with typed-in figures decays
silently, and the moment one figure is stale the whole document is worthless because a
reader cannot tell which one. No number in the renderer is a literal.

**Rejected: reading the persisted onset.** `app.health_state` stores the changepoint
detector's *retrospective* estimate — "this began on the 3rd" — and nobody learned anything
on the 3rd. Lead time is measured from the confirmation instant, which is days later and is
written down nowhere, so the health layer is recomputed. On the coil leak the difference is
ten days of credit the system had not earned.

**Rejected: counting days with readings as the denominator.** A chiller that never started
is not a chiller correctly found healthy — the rules skipped every instant of it. One of the
three chillers here runs about one percent of the year. The denominator is asset-days on
which at least one detector was willing to judge, and switching to it made the false-alarm
rate worse, which is how it was identified as the right one.

**Rejected: accuracy over the whole fault trajectory.** Every detection figure is
restricted to the window in which the injected fault had not yet exceeded LBNL's *mildest*
published severity. A condenser down to 65% of its heat transfer is caught by a hand-set
threshold; reporting accuracy over the full trajectory would mostly report accuracy on the
easy end of it.

**Rejected: failing the build on a bad number.** The harness exits non-zero only if the
document could not be built. This is a measuring instrument, and an instrument that fails
when the reading is unwelcome invites the reading to be adjusted.

---

## The extensibility property

**Adding a new equipment class requires a Brick model entry, a rules registration and a
failure-mode config row. No change to the detection, health or RUL engines.**

Concretely, to add — say — a boiler:

| step | where | kind of change |
|:---|:---|:---|
| declare the equipment, its points and what it feeds | `model/*.ttl` | semantic model |
| declare its constraints, criticality, costs | `model/extensions.ttl` | semantic model |
| register its rules against `brick:Boiler` | a new module under `analytics/rules/` | code, one decorated function per rule |
| declare its failure modes and thresholds | rows in `app.failure_modes` | database rows |
| declare its interventions | rows in `app.intervention_library` | database rows |
| declare its baselines, if it needs any | `BASELINE_CATALOGUE` in `analytics/baselines/fit.py` | one dict entry, declarative |

Everything else is untouched. `fit_baseline` knows nothing about equipment classes.
`mode_health`, the changepoint detector, the degradation fit, the first-passage estimator
and the refusal layer all take a failure mode and a series and have no idea what kind of
machine produced it. The advisory layer reads `app.failure_modes` and
`app.intervention_library` at run time and loops over whatever it finds. The isolation
solver builds its relations from whatever the graph declares. The only appearances of a
Brick class name anywhere in `analytics/` outside the rule modules themselves are the keys
of `BASELINE_CATALOGUE` and two docstrings.

Two honest qualifications. First, the rules and the baseline forms are genuinely code —
declarative code shaped like data, but code. What the property claims is that no *engine*
changes, and that is checkable: nothing in the health, prediction or diagnosis path
branches on equipment class. Second, this has been exercised across two classes, not
twenty. It is a property of the design that has been used twice, not a property proven at
scale.

The same is true one level down. Adding a new failure mode to an *existing* class is a
single database row — a mode id, a Brick class, an indicator expression, a threshold, and a
required written justification for that threshold. No code at all. That is why
`threshold_rationale` is `NOT NULL` with a minimum length: a threshold can never be entered
without a physical justification recorded beside it.

---

## What is deliberately not built

### No test suite

> No test suite: a deliberate scope trade in a time-boxed prototype. In production this
> engine needs golden-dataset regression tests per rule and calibration tests per RUL
> model, plus property tests on the monotonicity constraint. See ROADMAP.md.

Two things partly stand in for it and neither is a substitute. Every checkpoint has a
verification script under `scripts/` that runs its layer over real data and prints the
numbers the checkpoint claimed — those are executable and were re-run whenever something
below them changed. And `validation/` scores the whole pipeline against third-party labels
on every run, which catches a regression in *accuracy* even where it would not catch a
regression in *behaviour*. What is missing is exactly what the paragraph above names:
per-rule fixtures that pin a rule's output on a known input, calibration tests that fail
when coverage drifts, and a property test asserting the health series never increases.

### Not built, and why

| not built | why not |
|:---|:---|
| **Water metering and leak detection** | Neither LBNL dataset publishes a makeup water flow. Every water number would have been an estimate presented as a measurement. The cost of inaction says so explicitly rather than inventing a litre. |
| **Air quality** | No CO₂, no particulate, no VOC point exists in either dataset. There is nothing to detect on. |
| **MQTT and Modbus ingestion** | This building is a set of CSVs. A live protocol adapter would have been written against no live device and tested against nothing. |
| **A physics simulator** | Rejected at the start, [D-02](AI_LOG.md): a self-built simulator would mean every accuracy number was scored against labels this project also created. Third-party labelled data is the whole basis of the validation claim. |
| **Work order lifecycle** | `app.advisories.status` has three values and nothing moves a row off `open`. An operator can see and rank, but cannot acknowledge, assign or close. This is the largest functional gap in the product. |
| **Additional dashboards** | Energy, water, and per-zone comfort views. The one dashboard that exists is the one the prediction needs. |
| **Natural-language query** | Interesting and not on the critical path to predicting a failure. |
| **Floorplan and 3D** | Same. The plant drawing covers the one spatial question the cross-asset story needs: which machine feeds which. |
| **Authentication** | There are no users. Adding a login to a single-operator prototype would have been theatre. |
| **Multi-building or multi-tenant** | One building, by scope. Nothing in the schema forbids a second, and nothing has been done to support one. |

All of these are in [`ROADMAP.md`](ROADMAP.md), in priority order, with the reasoning for
the order.

---

## Known defects

Stated here rather than only in `VALIDATION.md`, because a reader of the architecture
should know where it is weak.

**The chiller efficiency indicator raises a confirmed onset on a fault-free machine.** Two
findings across 1,208 healthy asset-days, and between them they stand for 139 of them —
they are the *only* false positives in the project and the entire reason detection
precision reads 43.7% per asset-day rather than the 92% it reads per finding. The same
channel then propagates: 145 remaining-life estimates published for a chiller that was
working, and two of four healthy machines given a fault class with zero relations violated.
One defect in one indicator, visible in three layers. It is small — one to three health
points out of a hundred — so it ranks at the bottom of the queue, but ranking a wrong
finding low is not the same as being right about it.

**The prediction interval does not achieve its nominal coverage.** 80% claimed, 10.1%
measured against the answer key's failure date and 0% on the two series where the mode
actually names the injected fault. Most of that gap is not miscalibration: those two
indicators only ever reached 57% and 16% of their own failure thresholds, so the model is
right about the event it predicts and the answer key's date is a different event. But where
the model's own event did occur, coverage is 1 of 13 and every miss is *late* — the
dangerous direction. A plausible mechanism, untested: the drift rate is fitted over all
post-onset increments with equal weight, so a fault whose rate rises late is projected
forward at its average rate.

**The chiller's relation set is too thin to falsify a sensor hypothesis.** The air handler
contributes up to five relations and a chiller up to three, and electrical power appears in
two of those three — so a fully developed fouling fault can be reconciled by assuming the
power meter is wrong, and nothing is left to contradict it. That is the one
sensor-versus-equipment miss in `VALIDATION.md`. It is the same falsifiability problem the
air side had and solved by adding baselines as relations; the chiller never received that
treatment, and doing so is configuration rather than code.

**The plausibility map is six rows of one physical chain.** The mechanism generalises; the
table has not been shown to. And the one chain this dataset genuinely couples — cooling
tower to chiller — has no upstream detector, so it cannot exercise the traversal.

**Cross-asset causation cannot be positively validated on this data.** The two LBNL systems
are independent simulations, so no run contains a genuine chiller-caused air-handler
symptom. The target scenario is composed by shifting one real fault's calendar era by two
whole years, stated wherever its numbers appear. The answer key can falsify a consequential
link and cannot confirm one.

**One package boundary is still crossed.** `validation/attribution.py` imports fault
collection and two composed-window constants from `scripts/run_rootcause.py`. The
collection step belongs in `analytics/diagnosis/`; the composed-window constants belong
nowhere but that script.

---

## Reading order

If you have ten minutes: [`VALIDATION.md`](VALIDATION.md) section 1, then this document's
extensibility section, then `analytics/advisories/generate.py` — it is where every layer's
output arrives in one object.

If you have an hour: [`AI_LOG.md`](AI_LOG.md) entries D-06 through D-09, which are the four
decisions the system's behaviour actually rests on, and each records what happened after
the decision was made — including the two that turned out differently than expected.
