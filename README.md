# Aqueduct PDM

**A predictive maintenance platform for building HVAC equipment.** It ingests labelled
fault data from a real air handling unit and chiller plant, models the equipment
semantically, detects faults with physics-derived rules against condition-normalised
baselines, tracks degradation as a single health number per failure mode, and predicts
remaining useful life with a calibrated confidence interval — refusing to predict when the
evidence does not support one. Because the two machines are connected in the model by the
chilled water loop, a symptom seen at the air handler can be traced upstream to the chiller
that caused it, and the resulting advisory carries the evidence, the affected occupants, the
cost of doing nothing, and which technician to send.

| | |
|:---|:---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How it is built, layer by layer, and every rejected alternative |
| [`VALIDATION.md`](VALIDATION.md) | How well it works. Regenerated from the database on every run; no hand-written numbers |
| [`DOMAIN_NOTES.md`](DOMAIN_NOTES.md) | The building physics, for a reader who knows software. Every fault signature traced to its published source |
| [`ROADMAP.md`](ROADMAP.md) | Shipped, next in priority order, and what will not be done |
| [`AI_LOG.md`](AI_LOG.md) | The eleven decisions the system rests on, each with the options considered and what happened afterwards |

---

## Quickstart

Needs Docker, `uv`, `psql`, and Node 20+. Download the LBNL datasets into `data/raw/`
first — the loader names the files it wants and exits if they are absent.

```bash
cp .env.example .env    # then set the two passwords
make db-up              # docker compose up, wait for it, apply the schema
make load               # LBNL datasets into the hypertable, then the semantic graph
make demo               # everything computed — a couple of hours, see below
make api                # http://localhost:8000/docs   (leave running)
make reveal             # http://localhost:8002/docs   (second terminal)
make web                # http://localhost:5173        (third terminal)
```

Three of those need a word.

**`make db-up` rather than `docker compose up`.** Starting the container is not enough:
`db-up` also waits for the server to accept connections and then applies
`scripts/schema.sql`, which creates the tables, the hypertable, the continuous aggregate and
the two roles. The schema file is idempotent, so re-running it is safe.

**`make demo` is what makes the dashboard non-empty**, and it takes a couple of hours. The
raw measurements come from `make load`; everything else — quality scores, baselines, health,
the remaining-life history, one advisory queue per day and the engine trace — is computed and
does not exist until the pipeline has run. It ends with three long batches in a fixed order:

| step | produces | why the order matters |
|:---|:---|:---|
| `advisories-write` | one snapshot queue, including the **cross-asset demotion** | it DELETES the table first |
| `advisory-replay` | one queue per day, 1,657 rows across 577 days | upserts, so it adds around the snapshot |
| `engine-trace` | 18,920 rows of what the pipeline declined to judge | its last stage reads the queue |

⚠ **`advisories-write` must never run after `advisory-replay`.** It empties `app.advisories`
and rewrites it, because it owns the single snapshot it produces. Run it afterwards and 577
days of per-day queues disappear silently — the clock keeps moving and every screen goes
blank. `make demo` runs them the safe way round; the hazard only exists if you invoke the
targets by hand.

Both are needed, and the reason is worth knowing. The replay is what makes the queue change
as the clock moves. The snapshot is the **only** source of the demoted cross-asset advisory,
because it composes that situation by era-shifting the chiller fault into the air handler's
window — the replay builds every day from unmodified data, where the plausibility map
correctly declines to link anything, so the demotion does not occur naturally anywhere in
this dataset.

**`make reveal` is a second process on a second credential.** It serves the answer key, and
the detection API cannot read that data at all. Every screen except the Reveal tab works
without it.

```bash
make validate           # regenerate VALIDATION.md from the database and the answer key
```

Every layer also has its own verification target — `make apar`, `make chiller-rules`,
`make health`, `make rul`, `make refusal`, `make diagnosis`, `make rootcause`,
`make advisories` — which runs that layer over real data and prints the numbers its
checkpoint claimed. Each target in the `Makefile` carries a comment saying what it does and
what it needs.

---

## Timed walkthrough

Seven minutes, in front of the running dashboard. Each step is a real screen, not a slide.

Six screens share one clock, pinned to the top of every page: **Operations**, **Twin**,
**Engine**, **Diagnosis**, **Prediction**, **Configuration**, and the gated **Reveal**. The
clock can be dragged, stepped a day at a time, played forward at up to ten simulated days a
second, or sent straight to a chosen fault. Whatever it says, every screen answers about that
same moment and nothing after it is visible anywhere — which is why the walkthrough below can
show a prediction interval closing while somebody watches.

**0:00 — Operations.** Seven advisories across three machines, ranked by expected dollars
saved per dollar spent. The strip along the top gives the site: how many advisories, how many
are consequential on something else, how many could not be priced, the worst health score and
which machine has it, and the total cost of doing nothing over a quarter. Point out that the
ranking is economic, not alphabetical and not by severity — and that two rows at the bottom
say `unpriced` rather than `0.00`, because "we cannot compute this" and "this is worthless"
are different answers.

**1:00 — Open the top row: the air handler's cooling coil valve, leaking past its seat.**
Priority 24.7, $68,625 of cost over the quarter, and the headline sentence: *likely to fail in
X to Y days, median 32*. Scroll to the **RUL fan chart**. This is the single most important
picture in the project. It plots the P10-to-P90 interval against the date each prediction was
made, replayed daily from data available on that day. Eighty-four estimates: the first bounded
one says "somewhere in the next 2,259 days", which is visibly useless, and the last says 59
days — a **97% close** as the post-onset evidence goes from 14 samples to 53. The band
visibly *widens* at 44 samples before closing, and that is not a bug: each estimate is
refitted from that day's evidence, and a run of flatter days genuinely is weaker evidence
about a rate. The chart says `monotone no` rather than pretending otherwise.

Then open the **second** row, the chiller's condenser fouling, and show the contrast: that
interval *widens* by 12% over its run. It is a known limitation of the degradation fit,
recorded in `VALIDATION.md`, and it is on the screen rather than hidden. A demo where every
chart cooperates is a demo of chart selection.

**3:00 — The evidence, and the graph trace.** Below the chart: every contributing signal with
its **actual measured value**, its fault-free reference value, and how many standard
deviations it has moved — not "the residual is elevated". Note the two exclusion counts: how
many points were dropped because the quality layer condemned the readings, and how many
because the source column never meant what its name said. Then the trace: what is upstream of
this machine, what is downstream, and specifically which zones and how many occupants are
affected — 200 people across five zones, read off the semantic model rather than typed in.
Then the cost of inaction broken into its energy and consequential-repair terms, each with the
computation printed, and the recommended intervention with its duration, skills, parts and
cost.

**5:00 — The pair that matters: same symptom, different diagnosis.** Open the **Diagnosis**
tab. Two faults on the same air handler both amount to "supply air is not where it should
be". `apar-20` is classified **SENSOR** — assuming one thermometer reads **+2.434 K** high
explains **94% of the violation across the three relations it appears in without making any
of them worse**, against a true injected bias of 2.22 K. `coil-valve-leak-by` is classified
**EQUIPMENT** — its single-sensor test is *not reached at all*: an unresponsive actuator
invalidates it, so there is no sensor hypothesis to accept or reject, and the confirmed
degradation trend on a physical quantity is what remains. From the symptom alone these are
indistinguishable.

Then look at what the distinction is worth: the **same rule id on the same machine**
dispatched as a sensor fault costs **$262.50** — 1.5 technician-hours and a $120 part — and
as an equipment fault **$830.00**, six hours. **3.2× on one symptom, and the only thing
choosing between them is that reconciliation.** Both figures are real advisories this system
produced on different days, because the classifier called that fault both things.

The screen says two more things out loud. These two faults are **two runs two years apart**,
so no position of the clock holds both and the comparison is composed — stated in a banner
rather than implied. And the timeline underneath shows `apar-20` read **EQUIPMENT for ten
days and SENSOR for the last three**: the reconciliation declining to name a suspect until
one biased reading actually explained the violations. A classifier that had committed on day
one would have been confidently wrong for ten days.

**6:30 — Cross-asset root cause.** Scroll to the bottom of the queue. `apar-20` sits at
position 7 of 7, visually demoted, marked **CONSEQUENTIAL**, with a link to its cause: the
chiller's condenser fouling, two hops upstream through the chilled water loop. The chain is
the one from the scenario this exists for — fouling reduces capacity, chilled water supply
temperature rises, the coil cannot hit its setpoint, and the air handler looks faulty when it
is not. Two things to say plainly. It is **demoted, not hidden**: still on the screen, still
readable, ranked below its cause. And on this data the attribution is **wrong** — the answer
key injected a sensor drift directly into that air handler, and the classifier independently
agrees. Which is exactly the case demote-rather-than-hide was designed for: the advisory is
still there, still carrying the SENSOR badge and the evidence that contradicts the
attribution. Had it been suppressed, a real fault would have left the queue on the strength of
a wrong inference, and nothing on the screen would have said so.

**7:00 — The Reveal, then the numbers.** Open the **Reveal** tab. It does not show you
anything until you ask it to — that is deliberate, because everything on every other
screen was worked out from readings alone and the moment is worth keeping. Click through
and it says what was actually injected at the clock's position, split three ways into
running now, already past failure, and not injected yet. Ask any active fault which
instrument moved first and it measures the cascade against the fault-free twin: on the
fouled chiller, power departs fifty days before the water temperatures do, which is the
physics rather than a claim about it. Say plainly that this screen is served by a
*different process on a different credential*, and that the API every other screen reads
fails with `permission denied` if it asks for a label.

The **Configuration** tab is the answer to "what is this thing actually configured
with": nine rules, six failure modes, sixteen interventions. Open any failure mode and
the threshold's physical justification is underneath it — the column is `NOT NULL` with
a length check, so no threshold can enter without a reason, and the shortest one here is
518 characters. One mode is marked *not computable in this building*, because a loaded
filter is measured by pressure drop and neither dataset publishes one. It is shown
rather than hidden.

**Then [`VALIDATION.md`](VALIDATION.md).** Every number recomputed from the database on
every run. Lead with the false-alarm rate, because that is what kills fault detection
programmes in the field: **0.0017 findings per healthy asset-day**, and **zero** across 778
asset-days of the LBNL fault-free reference year. Then detection at the mildest measured
severity — precision 43.7%, recall 76.1%, all four scorable faults caught while still at
level 1. Then lead time: median 26.6 days of warning, tenth percentile 12.2. Then scroll to
section 5 and read the bad one out loud: the prediction interval achieves **10.1% coverage
against a nominal 80%**, most of which is a definitional gap between two different failure
dates and some of which is a real late bias. It is the first item in [`ROADMAP.md`](ROADMAP.md).

---

## How this was built

Built in prioritised iterations against a fixed time budget. Iteration 1 was the minimum
system that genuinely predicts failure with quantified confidence — ingest, semantic model,
rules, baselines, health, remaining life with intervals and refusal — and nothing was added
alongside it that a prediction did not need. Everything after that is additive: cross-asset
root cause, advisories with costed impact, the API, the operator interface, and the validation
harness. Everything not built is listed in [`ROADMAP.md`](ROADMAP.md) with the reason and the
priority, and the small number of things that will never be built are listed separately as
decisions rather than as omissions. The commit history reflects that sequence: it runs in
dependency order, one checkpoint per commit, with the decision log entries committed at the
points where the decisions were actually taken.

## The validation claim

**The fault signatures in this project are empirically grounded in third-party labelled
data.** They come from the LBNL Fault Detection and Diagnostics Datasets, a public release
produced by a consortium of LBNL, PNNL, NREL, ORNL and Drexel, in which each fault is
simulated at several measured severity levels alongside a fault-free reference run. The
chiller fault taxonomy is ASHRAE RP-1043, cited as the taxonomy reference only — it is not
public and this project does not hold it. The air-side rules are NIST APAR.

**The only thing this project synthesised is the temporal trajectory between the measured
severity levels**, because no public run-to-failure dataset exists for building HVAC
equipment. Each severity level is a real measured run; what is interpolated is the path from
one rung of that ladder to the next, built by mixing consecutive measured runs in proportion so
that weather, occupancy and control response cancel out of the fault contribution and only the
fault's own effect is added to a real fault-free signal.

**Every accuracy number in [`VALIDATION.md`](VALIDATION.md) is computed against labels this
project did not create**, and the separation is enforced by the database rather than by
discipline: every layer that detects, scores, baselines, predicts or diagnoses connects as a
role with no grant of any kind on the schema holding the answer key. No detector here can
have seen the label it is scored against — an endpoint that asked for one fails with
`permission denied for schema groundtruth`, which is checked rather than asserted.

**Two processes read that schema and neither of them computes anything.** The validation
harness, which produces `VALIDATION.md`, and the reveal API, which serves the demonstration's
answer-key screen. Both connect on a separate credential and run as separate processes from
the detection API. That is a weaker statement than "nothing in the running system can reach
the answer key", and it is the true one now that the demonstration shows both sides of the
line on one dashboard — so it is the one stated here.

## Scope and limitations

One commercial building, two equipment classes, 107 measured points, eight assets. Six
injected fault scenarios plus two fault-free control runs. The accuracy figures rest on
single-digit event counts against asset-day denominators in the thousands — the confusion
matrix is well-conditioned, the per-fault table is one row per fault, and one miss moves it
visibly. `VALIDATION.md` states every exclusion and the reason for it, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) has a Known Defects section listing six of them with
their measured sizes. These are measurements on one building, not a benchmark result.

## Stack

Python 3.11+, FastAPI, SQLAlchemy Core, pydantic v2, rdflib, numpy/scipy/pandas, statsmodels,
TimescaleDB. React + TypeScript + Vite, Recharts, plain CSS modules, no component library.
About 21,000 lines of Python and 2,400 of TypeScript.

Deliberately no test suite — a scope trade, argued in [`ARCHITECTURE.md`](ARCHITECTURE.md) and
scheduled in [`ROADMAP.md`](ROADMAP.md).
