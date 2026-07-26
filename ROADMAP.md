# Roadmap

Three sections: what is shipped, what comes next and in what order, and what this project
will not do. The middle section is ordered by what would most improve the system, which is
not the same as what would most improve the demo — the first four items make nothing look
better and two of them make the numbers look worse before they look right.

---

## 1. Shipped

Eleven layers, end to end, from CSV to an operator's screen, plus a validation harness that
scores the whole thing against third-party labels and regenerates
[`VALIDATION.md`](VALIDATION.md) on every run.

| layer | shipped |
|:---|:---|
| **Ingest** | Two LBNL systems into a TimescaleDB hypertable through per-system manifests. Units converted on the way in; 107 points across 8 assets; a continuous aggregate for chart and API reads. Defective source columns flagged in the point catalogue with a required written reason. |
| **Degradation synthesis** | Continuous trajectories built by mixing consecutive measured-severity runs in proportion, driven by a seeded rate curve that can flatten but never reverse. Six scenarios plus two fault-free control runs. |
| **Quality scoring** | Every reading scored 0–100 across five dimensions with the failing dimensions recorded. A gate at 50 that the rule engine, the classifier and the advisory evidence all share. |
| **Semantic model** | Brick 1.3 with an `mvn:` extension for criticality, costs, occupancy and physical constraints. SPARQL traversal upstream and downstream, cross-checked against an independently built edge cache. |
| **Rule engine** | Nine physics-derived rules — six of NIST APAR's 28, three chiller performance rules — dispatched by Brick class, gated on operating mode, suppressed across transitions, and reported only after holding for an hour. |
| **Baselines** | Physics-form condition-normalised models per equipment class, fitted on a three-week commissioning window. Observed-minus-expected stored per point, and the graph's declared constraints evaluated the same way. |
| **Health index** | One number per mode per day, 0–100, changepoint-confirmed onset, isotonic clamp so it can flatten but not climb, asset roll-up as the weakest mode with the mode named. |
| **Remaining life** | Wiener degradation with Bayesian rate updating and an inverse-Gaussian first-passage interval, replayed daily so every intermediate answer is kept. A refusal layer that declines to predict and gives the specific reason. |
| **Diagnosis** | Sensor versus equipment versus control by single-bias reconciliation over constraints and baselines. Cross-asset upstream attribution with a declarative plausibility map, demoting rather than hiding. |
| **Advisories** | One object per fault with the evidence values, the interval or the refusal, the graph trace, the occupants affected, a severity, a cost of inaction traceable to measured quantities, and a dispatch recommendation keyed on fault class. |
| **API and UI** | Nine FastAPI endpoints. Dashboard with a priority-ranked queue, advisory detail with the RUL fan chart and graph trace, and a live-bound plant schematic. Frontend display logic verified headlessly through the same modules the components use. |
| **Validation** | Detection, false-alarm rate, lead time, interval calibration, alpha-lambda accuracy, fault-class confusion and cross-asset correctness — all recomputed on every run, none hand-written. |

**What it measures, as of the current run.** Full detail and method in
[`VALIDATION.md`](VALIDATION.md).

- **0.0017 findings per healthy asset-day** — two false findings across 1,208 asset-days of
  working equipment, and **zero** across 778 asset-days of the LBNL fault-free reference
  year.
- **Detection at the mildest measured severity:** precision 43.7%, recall 76.1%, F1 0.555
  over 1,350 labelled asset-days. **All four scorable faults caught while still at level 1**,
  at 1.8, 2.8, 9.8 and 18.8 days after injection.
- **Lead time to terminal severity:** median **26.6 days**, tenth percentile **12.2 days**,
  across thirteen warnings.
- **Fault class:** 4 of 5 correct, against 3 of 5 for a classifier that always guessed the
  commonest class. Both halves of the sensor-versus-equipment pair correct.
- **Cross-asset:** two correct refusals to link, one wrong attribution — which the
  demote-rather-than-hide design was built for, and which the advisory still shows.
- **Interval calibration: 10.1% against a nominal 80%.** This is a defect, it is the first
  item in the next section, and it is reported rather than buried.

---

## 2. Next, in priority order

**A note on the ordering.** The brief for this checkpoint listed the feature work in a
suggested sequence. I have put four correctness items ahead of all of it, because the system
currently has a false positive that propagates through three layers and a prediction interval
that does not mean what it says, and shipping an energy dashboard on top of that would be
building on a floor with a hole in it. Everything the brief listed is here, in the order I
would actually do it, with the reasoning stated. Where I moved something, the move is said
out loud.

### Tier 0 — things that are currently wrong

**0.1 Fix the chiller efficiency indicator's false positive.**
It is the only false-positive source in the project and it accounts for **all** of the
precision shortfall: two findings standing for 139 of 1,208 healthy asset-days, on the
fault-free chiller run. It then propagates — 145 remaining-life estimates published for a
machine that was working, two of four healthy machines given a fault class with zero
relations violated, and the apparent "detection" on the held-out tower run that turns out to
be this same artefact. One defect, three layers.
*What we know:* it fires on the same day of the year across faulted and fault-free runs
alike, so it is tracking something in that week's weather or load rather than the machine.
Its magnitude is one to three health points out of a hundred.
*What we do not know:* the mechanism. The indicator's mean over the fault-free run is within
0.01 of zero, so it is not a steady seasonal drift.
*Approach:* the kW/ton residual is divided by tons, so the first hypothesis is
denominator amplification at low load — the 20-ton evaluation floor applies to the rules but
the daily indicator is computed from all samples. Second hypothesis is that the changepoint
detector's decision interval is too tight for an indicator with this much scatter.
*Effort:* small. *Risk:* none to anything else; it is one expression and one threshold.

**0.2 Add condition-normalised baselines to the chiller so its relation set can falsify a
suspect.**
The one fault-class miss in `VALIDATION.md` is condenser fouling called a power-meter fault,
and the cause is structural: the air handler contributes up to five relations and a chiller
up to three, and electrical power appears in two of those three. Once a developed fault has
pushed two relations out, assuming the power meter is wrong reconciles 99% of the violation
and nothing is left to contradict it. This is precisely the falsifiability problem the air
side had, and it was solved there by adding baselines as extra relations — supply air
temperature went from one relation to three and became falsifiable.
*Approach:* declare chiller-side baselines that target points other than power — condenser
water temperature rise, evaporator approach proxy, flow against pump command. Each new
relation that does *not* read power reduces power's explanatory reach.
*Effort:* small to medium, and it is configuration plus one `BASELINE_CATALOGUE` entry
rather than engine work. *Payoff:* directly converts a known miss into a hit.

**0.3 Diagnose and fix the late bias in the remaining-life interval.**
Where the model's own predicted event actually occurred, coverage is 1 of 13 and **every
miss is late** — it promises more time than there is, which is the dangerous direction for a
maintenance system. Most of the headline 10.1% is a definitional gap between the answer
key's terminal severity and the indicator's own threshold, and that part is not a defect.
This part is.
*Hypothesis, untested:* the drift rate is fitted over every post-onset daily increment with
equal weight, so a fault whose rate rises late in its life is projected forward at its
average rate rather than its current one. A decay weighting, or refitting on a trailing
window, would test it.
*Effort:* medium, and it needs care — the same change moves every published interval, so it
has to be evaluated by re-running the harness rather than by inspecting one series.
*Depends on:* nothing, but do it after 0.1 so the calibration population is not polluted by
estimates on a healthy machine.

**0.4 The test suite the architecture document promises.**
Named in [`ARCHITECTURE.md`](ARCHITECTURE.md) as deliberately traded away, and this is where
it comes back. Three kinds, in this order:
- **Golden-dataset regression tests per rule.** A fixture of readings and the exact firing
  pattern expected. There are nine rules and every one of them is a pure function of a frame,
  so this is cheap and it is the highest-value test in the system: a rule that silently
  changes behaviour is currently caught by nothing except a validation number moving.
- **Calibration tests per RUL model.** Assert coverage stays inside a band. This one cannot
  be written until 0.3 lands, because the band would have to be set at today's 10%.
- **Property tests on the monotonicity constraint.** For any input series and any set of
  repair events, the clamped health series never increases between repairs. A property test
  is the right shape here because the invariant is universal.
*Effort:* medium. *Note:* the ten verification scripts under `scripts/` already run each
layer over real data and print what its checkpoint claimed, and the harness catches accuracy
regressions on every run. What is missing is behaviour pinned on a fixed input.

### Tier 1 — the product is not usable without this

**1.1 Work order lifecycle.**
`app.advisories.status` has three values and nothing moves a row off `open`. An operator can
see the queue and rank it and cannot acknowledge, assign, defer, or close anything, and
cannot record that they looked at something and disagreed. That last one matters more than
it sounds: a system that cannot be told it was wrong learns nothing and is trusted less each
time it is wrong.
*Scope:* status transitions with a reason and an actor, a link from a closed advisory to an
`app.maintenance_events` row — which already exists and is already honoured by the health
layer's clamp reset, so closing a work order would correctly recover the machine's health
score. That is the piece that makes this more than CRUD.
*Effort:* medium. *Why first among the features:* it is the difference between a monitoring
demo and a maintenance tool.

**1.2 A router in the frontend.**
The open advisory is React state, so no advisory can be linked to, bookmarked, or sent to a
colleague. Trivial to add and currently blocks the most basic collaborative act there is.
*Effort:* small.

### Tier 2 — new capability the existing data can support

**2.1 Energy dashboard.**
Every advisory already carries a cost of inaction in dollars traceable to a measured
kilowatt penalty, an observed duty fraction and a tariff from the semantic model. Those
numbers exist and are currently visible only one advisory at a time. A site-level view —
excess kilowatts by asset, by fault, cumulative cost of inaction over the quarter, and what
the closed work orders actually saved — is mostly aggregation over data already computed.
*Effort:* medium, almost all frontend. *Why here and not higher:* it adds no new detection
and it presents numbers that are already correct, so it improves the argument rather than the
system. It moves up sharply once 1.1 lands, because then it can show realised savings rather
than only avoided cost.

**2.2 Cooling tower detection at all.**
The one physical chain this dataset genuinely couples is tower to chiller, and the tower has
no failure mode, no rule, and no health score — which is why the held-out fault went
undetected and why the cross-asset layer has no real upstream fault to find. The towers ship
seven points each including two water temperatures and a fan speed, so a tower approach
against the wet-bulb is computable.
*Effort:* small to medium. *Payoff:* it is the only change that would let the cross-asset
layer be validated positively on real data rather than on a composed scenario, which is
currently the single largest gap in the validation story.

### Tier 3 — new capability needing data this building does not have

**3.1 Cooling tower water balance and leak detection.**
Deliberately not attempted so far, and the reason is in the data: neither LBNL dataset
publishes a makeup water flow. The towers ship a circulating flow, which is water going
round the loop rather than water bought, so every water number would have been an estimate
presented as a measurement. The cost of inaction says so explicitly rather than inventing a
litre.
*What it needs:* one makeup water meter per tower, and ideally a blowdown meter. With those,
the balance is arithmetic — makeup should equal evaporation plus blowdown plus drift, where
evaporation is calculable from the heat rejected, so a persistent unexplained surplus is a
leak and its size is the leak's size. Without a meter this is unbuildable, not merely
unbuilt.
*Effort:* small in software, blocked on instrumentation.

**3.2 Air quality coverage.**
No CO₂, no particulate, no VOC point exists in either dataset. There is nothing to detect on.
With a CO₂ sensor per zone the useful work is ventilation-adequacy detection against the
occupancy schedule and the outdoor air fraction the economizer is holding — and the outdoor
air fraction is already computed by `apar-18`, so half the machinery is present.
*Effort:* small in software, blocked on instrumentation.

**3.3 MQTT and Modbus ingestion.**
This building is a set of CSVs. A protocol adapter written now would be written against no
live device and tested against nothing, which is why it has not been. The ingestion layer is
already the right shape for it — a manifest maps a source identifier to a point id, a unit
and an SI unit, and nothing downstream knows where a reading came from — so the adapter is a
new source behind an existing interface rather than a change to the platform.
*What changes when it lands:* the interesting work is not the protocol, it is everything
streaming makes newly hard — late and out-of-order arrivals, gaps that are network outages
rather than sensor failures, and the fact that the continuous aggregate and the daily health
computation both currently assume a complete window.
*Effort:* medium for the adapter, large for the streaming semantics.

**3.4 A physics simulator, for forward projection.**
This needs distinguishing from a decision already taken. [`AI_LOG.md`](AI_LOG.md) D-02
rejected building a simulator as the source of *ground truth*, and that rejection stands
permanently — see section 3 below. What is proposed here is different: a calibrated
forward model used to answer *what-if*, not to generate labels. "If we do not clean this
condenser for six weeks, what does the chiller draw and what does it cost?" is a question
the current system cannot answer, because it extrapolates one degradation indicator and does
not model the plant.
*Effort:* large. *Value:* it turns a prediction into a decision-support tool, and it makes
the cost of inaction a projection rather than a linear extrapolation of the observed duty.
*Risk:* a calibrated simulator is a research project with an unbounded appetite, and it must
never become an input to any accuracy figure.

### Tier 4 — presentation

**4.1 Remaining dashboards.** Per-asset detail beyond the advisory, per-zone comfort, a
quality-and-instrumentation view showing which points are trusted and which are flagged
unusable. The last of these is the most useful and the least glamorous.

**4.2 Natural language query.** "Which chillers got worse this month" over the semantic
model. The graph makes this genuinely tractable — a question maps to a SPARQL traversal plus
a health query rather than to free-text search — which is exactly why it is a demonstration
of the semantic layer rather than a new capability. Moved down from the brief's suggested
position for that reason: it re-presents what the API already answers.

**4.3 Floorplan.** Zone-level health on a plan. Needs spatial geometry the Brick model does
not carry.

**4.4 3D.** A rendered plant. The hand-drawn schematic already answers the one spatial
question the cross-asset story needs, which is which machine feeds which.

---

## 3. Explicitly not doing

Not "later". These are decisions, and each one would make the system worse.

**A self-built simulator as the source of ground truth.** [D-02](AI_LOG.md). The entire
validation claim rests on the labels having been created by somebody else. A project that
generates its own faults and then reports how well it detects them has measured its own
consistency and called it accuracy. This is the one item on this page that is closed
permanently. The forward-projection simulator in 3.4 is a different artefact and must never
be wired into a metric.

**Deep learning for remaining useful life.** [D-07](AI_LOG.md). Not a resourcing decision. A
sequence model can emit a predicted date and, with effort, a spread; it cannot refuse, and it
cannot show a belief tightening, because there is no belief in it — only an output. The
interval and the refusal are the two things that make this output usable by a maintenance
planner, and both are properties of having parameters. There is also no run-to-failure corpus
to train on. If a learned component is ever added it should be for pattern discovery where no
rule exists, feeding the same parametric prognostic — not replacing it.

**Suppressing consequential advisories.** [D-09](AI_LOG.md). The queue may be badly ordered;
it must never be incomplete. Demoting wrongly costs a dimmed row and the operator works it
anyway. Suppressing wrongly removes a real fault from the screen, and they find out when the
equipment fails — after which they read the raw alarm list and every layer in this project is
worth nothing. `VALIDATION.md` shows the one attribution this dataset can produce is wrong,
which is the argument made for us.

**Removing the refusal behaviour to always produce a number.** A remaining-life figure
extrapolated from noise is worse than no figure, because it looks like an answer. The same
goes for the contradiction check that withholds a prediction when health and the interval
flatly disagree, and for the two-tier queue that prints `unpriced` rather than `0.00`. Every
one of these makes the product look less complete and makes it more honest, and that trade is
not up for revisiting.

**Tuning a threshold to make a validation number improve.** Every threshold in
`app.failure_modes` carries a written physical justification in a `NOT NULL` column with a
minimum length, precisely so that moving one requires changing the argument for it rather
than only the value. If a number is bad, the fix is upstream of the threshold.

**Closed-loop control.** No write path to any actuator, ever, from this system. It advises a
human. Predictive maintenance that adjusts setpoints on the strength of an inference that
`VALIDATION.md` shows can be wrong is a different product with a different safety case, and
this one is not it.

**Becoming a building automation system.** No supervisory control, no scheduling, no alarm
management for the whole plant. This sits beside a BAS and reads from it.

**Authentication and multi-tenancy for their own sake.** There are no users and there is one
building. Both would be real work with real value in a product and neither would demonstrate
anything about predictive maintenance, which is what this is for. Nothing in the schema
forbids a second building; nothing has been done to support one.
