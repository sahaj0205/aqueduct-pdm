# AI_LOG.md — decision log

This log records the architectural decisions in this project, the alternatives
weighed, and the division of labour between my judgement and AI execution. I
used Claude Code heavily throughout — it wrote most of the implementation. The
decisions about what to build, what to reject, and what to trust were mine, and
this document is the audit trail for them. Where I overrode the model, I've said
so. Where I got something wrong and reversed it, I've said that too.

---

## D-01 — TimescaleDB for time-series scalability vs standard PostgreSQL

**Forcing question**

Every layer of this platform reads from one table of sensor readings, and that
table is the only thing in the project that gets large. Ingestion writes it
continuously, the rule engine scans narrow time slices of it, and the baseline
and health layers aggregate across months of it. What stores it?

**Options**

1. **Standard PostgreSQL with hand-rolled partitioning.**
   *Rejected.* At this volume a single table is not viable, so partitioning is
   not optional — it just becomes something I write and maintain myself:
   declarative partitions, a job to create next month's, and a rollup table with
   its own refresh logic. Continuous ingestion into large B-tree indexes also
   bloats them, which then needs its own reindex maintenance. All of that is
   plumbing that adds no capability the project is being judged on.
2. **TimescaleDB.**
   *Chosen.*
3. **A dedicated time-series store (InfluxDB, ClickHouse) alongside PostgreSQL.**
   *Rejected.* Fast on the measurements, but the assets, points, Brick classes,
   fault labels and scenario metadata are all relational and get joined against
   the readings constantly. Splitting them across two engines means doing those
   joins in application code, and it means the `groundtruth` privilege wall —
   the thing D-02 depends on — could no longer be enforced by one database's
   grant system.

**Rationale**

We are dealing with 116 million rows of 5-minute interval data. Standard
Postgres would require manual partitioning and suffer heavy index-bloat during
continuous ingestion. Timescale's hypertables and continuous aggregates give us
the performance we need out-of-the-box while keeping the standard relational
querying capabilities for our assets and points.

That last clause is the deciding one. Because a hypertable is still a
PostgreSQL table, `app.measurements` joins directly to `app.points` and
`app.assets`, ordinary foreign keys and check constraints still apply, and the
role-based revocation that keeps the detection path out of `groundtruth` is
enforced by the same engine that stores the readings. Nothing about the
time-series optimisation is bought at the cost of the relational model.

Measured after the load: 116,039,232 rows across 4,381 one-day chunks, 18 GB,
with the hourly rollup maintained incrementally by a continuous aggregate rather
than by anything I wrote.

**Mine vs delegated**

*Mine.* The database choice.

*Delegated.* The specific hypertable schema implementation.

**Confidence**

High. One caveat worth recording: the one-day chunk interval, combined with
trajectories that each occupy a year of simulated time, produced 4,381 chunks.
That is workable but at the high end, and query planning cost grows with chunk
count — a seven-day interval would give roughly 626. Worth revisiting if
planning time shows up in the API latency later.

**Outcome**

**The database choice was right. The chunk interval was not, and it is now
technical debt with a number attached.**

TimescaleDB delivered what it was chosen for. `app.measurements` holds 130.8
million rows in 22 GB, joins directly to `app.points` and `app.assets`, and the
hourly rollup is maintained by a continuous aggregate rather than by anything I
wrote. The privilege wall that D-02 depends on is enforced by the same engine
that stores the readings, exactly as argued. None of that is in question.

The caveat recorded above is. It said: *"the one-day chunk interval … produced
4,381 chunks. That is workable but at the high end, and query planning cost grows
with chunk count … Worth revisiting if planning time shows up in the API latency
later."*

Planning time showed up in checkpoint 3.1, and it is not a rounding error.

The quality scorer writes scores back by joining a staging table against
`app.measurements` on point and timestamp. That join gives the planner nothing to
exclude chunks by, so it planned an update across every chunk in the table —
5,077 of them, since the synthesised scenarios in 2.4 pushed the count up from
4,381 — in order to change 267,840 rows. Measured:

    Planning Time:    36,750 ms
    Execution Time:  296,200 ms
    Total:           333,022 ms   (5 min 33 s, to update one month of one asset)

Thirty-six seconds of that is the planner alone, before a single row is read.
Restating the time range in the statement so chunk exclusion can work brings the
same update to **7,850 ms** — a factor of 42, and the single largest performance
finding in the project.

**Why this is debt and not a solved problem.** The fix applied in 3.1 is local:
that one statement now carries a redundant-looking time predicate, with a comment
explaining that it is load-bearing. Nothing prevents the next query from omitting
it. Every future join against the measurements table has to remember, and the
penalty for forgetting is a 37-second planning cost that looks like a hang rather
than an error.

**What the real fix costs.** `set_chunk_time_interval` only affects chunks
created after it is called, so re-intervalling the existing table means recreating
the hypertable and re-inserting: a full reload, re-running the scenarios, and
re-scoring quality — roughly an hour. At a seven-day interval the 5,077 populated
days would collapse to about 725 chunks, a seventh of the present count. I have
not paid that hour, and I am recording the decision not to rather than leaving it
implicit.

Worth noting what actually made this bite. A one-day chunk is a sensible interval
for a real building; it is wrong here because this table holds 7,936 days of
simulated time, four eras of scenarios stacked on top of twenty-one years of
stitched trajectories. A real three-year deployment at the same cadence would
have produced about 1,100 chunks and none of this would have surfaced.

**Two things follow for later tasks.** First, this is now a hard constraint on the
API in Task 8: any endpoint that touches `app.measurements` must carry a bounded
time range, and one that accepts an unbounded query is not slow, it is broken.
Second, the lesson has already been applied once — `app.constraint_residuals`,
created in checkpoint 3.5, uses a seven-day interval and holds its data in 157
chunks rather than the roughly 1,100 a one-day interval would have produced.

---

## D-02 — LBNL labelled data over a self-built physics simulator

**Forcing question**

This project has to report fault-detection accuracy and remaining-life error.
Those numbers are worthless unless something independent says what the right
answer was. Where does labelled HVAC fault data come from?

**Options**

1. **Custom four-layer physics simulator.** Build the air-side and water-side
   thermodynamics, inject faults, generate labelled output.
   *Rejected.* Twelve hours minimum before a single row of usable data exists,
   and the fatal objection is not cost but circularity: validating predictions
   against ground truth I generated myself proves only that my detector agrees
   with my simulator. Both could be wrong in the same direction and every
   accuracy number would still look excellent.
2. **LBNL Fault Detection and Diagnostics Datasets.** Public, from a consortium
   of LBNL, PNNL, NREL, ORNL and Drexel. Ships CSVs at multiple fault severity
   levels plus a fault-free case, with a Brick Schema `.ttl` model, for both the
   single-duct AHU and the chiller plant.
   *Chosen.* Accuracy is computed against third-party labels.
3. **Minimal chiller performance-map generator.** A small correlation-based
   generator producing chiller behaviour only, no air side.
   *Held as fallback* in case the LBNL download proved unusable. Not needed.

**Rationale**

The strongest available claim is "every number in VALIDATION.md is computed
against labels I did not create." That sentence is only true under option 2, and
it is worth more than any amount of simulator sophistication. A reviewer can
check it by inspection: the labels arrive in files I did not write, and the
detection code is structurally prevented from reading them.

That structural prevention is the other half of this decision. Ground truth
lives in its own `groundtruth` schema with all grants revoked from the `app_rw`
role that ingestion, rules, baselines, health, RUL and diagnosis all connect as.
A `SELECT` against it from anywhere in the detection path fails with
`permission denied for schema groundtruth`. Without that, "I didn't tune against
the labels" would be a promise rather than a property.

**Mine vs delegated**

*Mine.* The data source decision itself. The 60-minute ingestion timebox, which
is what forced the 5-minute downsample when reconnaissance showed the native
one-minute cadence to be 1.3 billion rows. The separate `groundtruth` schema
with explicitly revoked grants, including the choice to enforce it at the
database privilege level rather than by convention.

*Delegated.* Loader implementation, unit conversion, schema DDL.

**Confidence**

High.

**Outcome**

**The decision holds. The premise that made it cheap did not.**

The claim it was taken for is intact and is now a demonstrated property rather
than an intention. Ground truth lives in its own schema, the role every part of
the detection path connects as has all grants on it revoked, and a `SELECT`
against it from that role fails with `permission denied for schema groundtruth` —
re-verified at checkpoints 2.2, 2.3 and 2.4. The scenario generator in checkpoint
2.4 writes the answer key on a separate `ADMIN_DATABASE_URL` connection, which is
the only credential in the project permitted to touch that schema, and it is used
by exactly one function. The fallback option, a minimal chiller performance-map
generator, was never needed.

What was wrong was the implicit assumption that using published data means
inheriting data that is correct. It required continuous repair, and I did not
budget for any of it:

- Two pairs of columns are swapped relative to their own names — outdoor air dry
  bulb against wet bulb, and the secondary loop supply against return. Both were
  caught only by checking the physics, never by reading the documentation.
- A third pair, the chiller's condenser water temperatures, uses "supply" in the
  opposite sense to the plant-level readings of the same loop.
- Three class names used in the published models are not Brick classes at all,
  and fourteen more were too vague to select on. 45 corrections are now applied
  at load time, against 3 after the first checkpoint.
- The air flow readings are 60 times larger than the documented unit allows. The
  documentation says CFM; as CFM the air handler would be removing 686 tons of
  heat from five office zones. The documentation was overruled on physical
  grounds — the only place in this project where that has been necessary.
- One flow reading is a constant for the entire simulated year while its damper
  swings fully open and shut, so it is not a measurement at all.
- Two groups of files published as four distinct severity levels each are one
  file repeated four times, byte for byte.

None of that changes the answer. A self-built simulator would have had no defects
because it would have had no independent authority either, which is exactly the
circularity the decision was taken to avoid — and finding these defects is only
possible because the data came from somewhere else. But "public data, so the
labels are free" was wrong. The labels were free; the data was not.

---

## D-03 — Synthesising degradation trajectories by stitching severity levels

**Forcing question**

Reconnaissance found that no LBNL run degrades. Each faulted file holds one
fixed fault severity for a whole year — fitting a line through the monthly
effect of the worst cooling-tower fouling case gives a trend of +0.006 °F per
month, which is flat; the month-to-month variation is weather, not
deterioration. The dataset provides discrete severity levels. The health index
and remaining-life layers both require a trajectory: equipment that starts
healthy and slides toward failure. How do we get one from data that has none?

**Options**

1. **Accept discrete severity levels and drop remaining-life estimation.**
   Report fault detection accuracy only.
   *Rejected.* Remaining-life estimation with calibrated confidence intervals is
   the centrepiece of the brief, not an extra.
2. **Stitch the severity files together sequentially over simulated time.**
   Divide a target year into consecutive windows and fill each from a
   progressively worse severity file, beginning with the fault-free run.
   *Chosen.*
3. **Fit a degradation model and generate the trajectory synthetically.**
   *Rejected*, and rejected for the same reason as option 1 in D-02. Generating
   the degradation curve I then predict against reintroduces exactly the
   circularity that choosing LBNL data was meant to eliminate.

**Rationale**

Stitching keeps every stored value a third-party measurement. Nothing is
interpolated, modelled or invented — the only thing I contribute is the
*ordering*, which is declared in the manifests where a reviewer can read it. The
LBNL runs all use identical Chicago TMY weather, so taking January from one file
and April from another leaves the seasonal signal continuous across the join
rather than producing a discontinuity a changepoint detector would fire on.

Each trajectory begins with a fault-free segment, so there is a genuine healthy
baseline before the decline starts. That matters because the baseline layer has
to learn "normal" from somewhere, and learning it from already-degraded data
would bake the fault into the definition of normal.

Verified after loading: cooling-tower approach temperature in the tower-fouling
trajectory tracks the fault-free trajectory through the healthy and
95%-heat-transfer-retained segments, then diverges by +0.29 to +0.34 °C in the
80% segment and +0.44 to +1.12 °C in the 65% segment. The curve degrades
monotonically across segments, which is what the layers above need.

**The honest caveat, recorded because a reviewer will ask.** A stitched
trajectory is a construction. Three things follow. The severity steps are
discrete rather than continuous, so it is a staircase, not a smooth slide.
`t_onset` marks where I chose to place a step, not a physical event. And
`t_failure` has no meaning in the source data at all — none of these runs is
carried to failure, so any failure threshold the remaining-life layer uses is a
threshold I define and must justify physically rather than one the data
supplies. I would rather state this plainly than have it discovered.

**Mine vs delegated**

*Mine.* The decision to synthesise at all, and to do it by reordering real
measurements rather than generating data. The requirement that every trajectory
open with a fault-free segment. The severity ordering, which mattered more than
expected — the fouling files are numbered by *heat-transfer capability
retained*, so `065` is the worst case and `095` the mildest, and anything
sorting them numerically ranks severity exactly backwards. Splitting signed
sensor-bias faults into separate drift-high and drift-low trajectories, because
a sensor drifts one way rather than alternating.

*Delegated.* The window arithmetic, the segment reader that seeks directly to a
row offset instead of parsing whole files, the pint-based unit conversion
reduced to a scale and offset, and the bulk-copy write path.

**Confidence**

Medium-high on the approach; high that it was the only option that preserved the
D-02 claim. Lower on the specific choice of equal-length segments, which is
arbitrary — real fouling accelerates rather than progressing in even steps, and
a reviewer could reasonably want the later, worse segments to be shorter.

**Outcome**

**Superseded by a better method, and one of the stated reasons turned out to be
false.**

Stitching did what it was chosen to do and the bulk trajectories built on it are
still the project's main body of data. But checkpoint 2.4 replaced the *method*
for the scenarios that accuracy is actually measured against. Rather than
concatenating whole files in sequence, each scenario now takes the fault-free
signal and adds a growing share of the measured difference between a faulted run
and the clean run at the same instant. That keeps everything this decision was
taken for — every value still traces to a third-party measurement — and fixes the
caveat recorded above, that a stitched trajectory is a staircase rather than a
slide. It is now continuous, and the fault contribution rather than the whole
signal is what gets interpolated, so the weather and control variation in the
output is the genuine variation of the real clean run.

The false reason is worth stating plainly because it is recorded above as my own
judgement. Under *Mine* I claimed credit for "splitting signed sensor-bias faults
into separate drift-high and drift-low trajectories, because a sensor drifts one
way rather than alternating". The reasoning is sound and the implementation was
pointless: `oa_bias_2`, `oa_bias_-2`, `oa_bias_4` and `oa_bias_-4` are one file
published four times under four names, md5 `89b13704` for every one of them. I
split a file from itself. The same is true of the four `coi_leakage` files, md5
`a9fdfc50`, so the `sdahu-coil-valve-leaking` trajectory stitches four identical
segments and contains no progression whatsoever.

Two of the eighteen trajectories from checkpoint 1.5 are therefore degenerate.
They are not wrong, just empty of the degradation they claim to show, and nothing
downstream has consumed them yet. Checkpoint 2.4 added a guard that refuses to
build a severity ladder whose rungs hold identical data, which is what should
have existed from the start: the failure mode here was silent, because a ladder
of duplicates produces a trajectory that looks like it walks four levels while
actually jumping straight to full severity.

The honest caveat recorded above still stands unchanged. `t_failure` has no
meaning in the source data — no LBNL run is carried to failure — so any failure
threshold the remaining-life layer uses remains one I define and must justify
physically.

---

## D-04 — Brick/RDF over Project Haystack or a custom graph

**Forcing question**

Cross-asset root cause analysis is the thing this platform is for. A symptom seen
at the air handler has to be traceable to a chiller two machines upstream, which
means something has to record what feeds what, what belongs to what, and which
reading measures which quantity — in a form code can traverse rather than a form
a human reads. What describes the equipment?

**Options**

1. **Project Haystack.**
   *Rejected.* It is tag-based: an entity is described by a bag of tags rather
   than by typed relationships. Two consequences sank it. There is no
   programmatically executable consistency rule, so nothing stops a model being
   internally contradictory and nothing can check one. And the same concept can
   be described with different tag sets by different authors, which is tolerable
   when a human reads the model and fatal when a traversal query depends on it —
   a query written against one tagging convention silently returns nothing
   against another. Reliable traversal is the whole requirement.
2. **A custom graph schema.**
   *Rejected.* Whatever I designed would be a worse Brick arrived at more slowly,
   and it would throw away the one thing that made this cheap: LBNL ships Brick
   models for these exact two systems. Adopting a custom schema means hand-writing
   the equipment description that already exists.
3. **ASHRAE 223P.**
   *Rejected.* Not finalised at the time of the decision, and substantially
   heavier than this project needs — it models physical connections at a level of
   detail that would take longer to populate than the analytics it feeds.
4. **Brick Schema.**
   *Chosen.*

**Rationale**

Brick is a real ontology with typed classes and typed relationships, so a
traversal is a query against declared structure rather than a string match
against a convention. That is what makes `?coil (^brick:feeds)+ ?upstream`
answerable at all, and that query is the spine of the diagnosis layer.

The deciding practical factor was that LBNL publishes `.ttl` models for the
single-duct AHU and the chiller plant — the same two systems the data comes from.
The equipment description therefore arrives with the measurements instead of
being authored, which I estimated at roughly an hour of adoption cost against
something like six for a custom schema. It also matches the stack the target
company has said it uses, which matters for a take-home.

**The cost actually paid**

The estimate was wrong, and the reason is worth recording because it is the
recurring theme of this project.

The two published models are **two disconnected graphs**. There is not one
statement linking the air handler to the chiller plant. Worse, and unnoticed
until I measured it, the chiller plant model contains **no flow direction at
all** — zero `brick:feeds` statements in 191 triples. It records which pumps and
chillers exist and which readings belong to them, and nothing about what feeds
what. So the CHW loop edge was not a single joining triple as expected; the
entire water-side topology had to be authored:

- 21 topology statements in `model/building_extensions.ttl`, every one of which
  crosses between the two systems
- 2 equipment nodes invented, one per water loop, because three chillers and five
  pumps feed one coil and a shared node makes that a six-into-one fan-in rather
  than fifteen separate edges
- both loops modelled in one direction only, deliberately, so the graph stays
  acyclic — a real water loop is a closed circuit, and modelling it faithfully
  would make every asset upstream of every other and root cause traversal
  meaningless

Then the class names. 45 corrections are applied at load time: two miscased, one
that is not a Brick class under any spelling, one that is used for two different
fluids and needs splitting per node, two swapped pairs, and fourteen that were
real but too vague to select on. Three of the 54 classes used in the merged model
do not exist in Brick 1.3 — two of those are LBNL's, and one was mine, because I
assumed `brick:Condenser_Water_Loop` existed and it does not. Brick defines a
condenser water *system* and a chilled water *loop* but no condenser water loop,
which is an inconsistency in Brick rather than in the data.

Real adoption cost: roughly a day across three checkpoints, not an hour.

**Mine vs delegated**

*Mine.* The choice of Brick, and the rejection of Haystack specifically on the
grounds that tag-based description cannot support reliable traversal. The
decision to give each source system its own namespace rather than merging them,
which turned out to matter: both files define an entity called `OA_TEMP` and they
are not the same instrument — one is dry bulb and the other wet bulb. The
decision to model each water loop in a single direction to keep the graph
acyclic. The requirement that graph, ingestion manifest and database agree on
every point's class, rather than treating the graph as documentation.

*Delegated.* The namespace relocation, the merge, the SPARQL traversal queries,
the flattening of the graph into `app.asset_edges`, and the class repair maps.

**Confidence**

High on the choice; it is the only option of the four that supports executable
traversal and the only one that came with the models already written. Low on my
estimate of what it would cost, which was out by roughly a factor of eight — and
that error was not in Brick, it was in assuming a published model would be
complete. A reviewer should read the adoption cost above as the honest figure.

**Outcome**

**Vindicated earlier than expected, and by a use I had not planned for.**

I wrote above that the graph would not be tested until cross-asset diagnosis in
Task 6. That was wrong. It was tested in Task 3, by the rule engine, and the
thing it was tested on is precisely the thing a custom schema would not have
been able to do.

The rule registry dispatches on Brick class. A rule written against
`brick:Air_Handling_Unit` has to fire on an asset the LBNL model types as
`brick:AHU`. Nothing in the LBNL files relates those two names — instance data
never carries the vocabulary that defines it — but Brick does, as an
`owl:equivalentClass` statement, and the dispatcher resolves it by walking that
relation. A hand-rolled schema would have had one name for the concept and no
equivalence to fall back on, so the mismatch would have been a silent
non-matching rule rather than a resolved one. The same mechanism means a rule
written for `brick:Chiller` already covers `brick:Centrifugal_Chiller` without
anyone saying so.

Using it cost less than adopting it did. Brick's published ontology is 52,113
triples and 2.07 s to parse, on a graph the rule engine reloads constantly, so
only the class hierarchy is vendored — 1,628 triples, 116 KB, 0.09 s. That is
generated from the published file rather than hand-picked, so no relation was
quietly dropped.

The graph also turned out to be the right home for the physics. The five
constraint residuals in checkpoint 3.5 are read out of it as expressions and
evaluated against 500,810 rows of measurements, with no physics whatsoever in the
Python. Adding a constraint is a triple.

One honest counterpoint. This entry credits me with giving each source system its
own namespace, on the grounds that both files define `OA_TEMP` and the two are
different instruments. That decision was right and it held. Then in checkpoint
3.5 I hit exactly the same trap one layer up: the code translating graph names
back to database point identifiers was keyed on the column name alone, so the air
handler's outdoor dry bulb silently resolved to the chiller plant's wet bulb. The
model was namespaced; the dictionary out of it was not. Namespacing has to be
carried the whole way, and being right about it once in the model does not
inoculate the code that reads the model.

Still untested: the chilled water loop edge itself. Nothing has yet traced a
symptom at the coil back to a cause at the chiller, and that remains Task 6.

---

## D-05 — Class-keyed rule registry over per-asset rule functions

**Forcing question**

The project detects faults on two kinds of equipment, an air handler and a
chiller, and the fault rules for them share nothing physically — one is about air
mixing and economizers, the other about compressor lift and part-load
efficiency. But everything downstream is shared: the same quality gate has to
apply to both, the same transient suppression, the same severity and cost
reporting, and later the same health index and remaining-life estimate.

So the question is where the machine's identity enters. If a rule is a function
that knows it is about `ahu-1`, then everything downstream also has to know, and
a third equipment class means editing detection, health and prediction code
together. If a rule is a statement about a KIND of equipment, the identity enters
once, at dispatch, and nothing downstream has to care.

This had to be settled before the first rule was written, because retrofitting it
means rewriting every rule.

**Options**

1. **Per-asset rule functions.** A function per rule per machine, calling it by
   name. Fastest thing to write and the easiest to read for the first two
   machines — there is no indirection, and what a rule applies to is obvious from
   its body. The cost lands later and lands everywhere: a third equipment class
   means touching the detection layer, the health index and the remaining-life
   code at the same time, because each of them has its own idea of which assets
   exist.

2. **A registry keyed by Brick class.** *Chosen.* A rule declares the class it
   applies to and the framework works out which machines that means by querying
   the semantic model. Roughly forty minutes more work than option 1 to build,
   all of it in one file. After that, the second equipment class costs what the
   third would, and the third costs what the second did.

3. **A full rules DSL.** Rules as data in a file, with their own expression
   language, evaluated by an interpreter. Genuinely useful when non-programmers
   author rules or when there are hundreds of them. There are nine, they are
   written by the same person writing the engine, and the cost — an expression
   language, a parser, error messages that point at the right line, some story
   for debugging — is entirely real. Over-engineered at this size.

**Rationale**

Option 1 is the right answer for a two-machine building that will never grow, and
this one will. The whole premise of the semantic model, argued in D-04, is that
the building describes itself well enough for code to ask it questions. Keying
rules to asset identifiers throws that away at exactly the layer that most
benefits from it.

The forty-minute estimate was about right, and the payoff is measurable rather
than hypothetical. Adding the chiller — the second equipment class, three rules,
its own baselines and a completely different notion of when the machine is
running — changed exactly two files:

    analytics/rules/chiller.py    346 lines, new, all of it physics
    analytics/rules/evaluate.py    24 lines changed
    analytics/rules/registry.py     0 lines changed

The dispatcher never learned what a chiller is. The 24 lines in the shared
evaluator are one parameter: the air handler is idle when the building is
unoccupied and a chiller is idle when it is not running, so the name of the idle
state became an argument. That is the honest measure of what a new equipment
class costs here, and it is the number option 1 could not have produced.

Two other things fell out of having a single registration point rather than
scattered functions. The quality gate is enforced in one place and inherited by
all nine rules across both modules, so a rule cannot fire on a reading it was not
allowed to see even if its author forgets — that is not a convention, it is that
the only route to a measurement refuses. And when the stuck-actuator problem
appeared, the exemption was added once and claimed by two rules in different
modules with one line each.

On option 3, the judgement was not "no DSL ever" but "a DSL for arithmetic, not
for control flow". A narrow one did appear where it earned its place: the
constraint residuals in checkpoint 3.5 are arithmetic expressions stored in the
`.ttl` and evaluated through a whitelist that admits nothing but arithmetic. That
is a hundred lines and it buys a genuine property — adding a physical constraint
is a triple in the model rather than a code change. A DSL for the rules
themselves would have had to express operating modes, persistence, quality
thresholds and cost models, and at nine rules that is a language nobody needs.

**Mine vs delegated**

*Mine.* Requiring dispatch on Brick class rather than asset identifier or an
internal enum, and requiring it before any rule was written. Requiring that a
rule be unable to fire on a reading below its quality bar, rather than trusting
rule authors to check. Authorising the staleness exemption for rules that detect
seized actuators, and requiring it be declared per rule and per point rather than
turned on globally. Holding the line that the checkpoint's six APAR rules had to
be the real published ones with their real numbers, not six plausible-looking
inventions.

*Delegated.* The taxonomy closure and the equivalence walk, the context object
that enforces the gate, the selection of which six APAR rules the instrumentation
supports and the argument for the twenty-two it does not, the transient
suppression, the chiller baseline fits, and the constraint evaluator.

**Overrode**

Two of the model's recommendations, both during Task 3.

*The package name.* `platform/` could not be used — it shadows a Python standard
library module and breaks `import pandas` outright, which the model found by
testing rather than by reasoning about it. It recommended `aqueduct/`; I chose
`analytics/`, because PROJECT_CONTEXT.md already describes these as the analytics
layers and the directory should match the document. No consequence either way;
this one was aesthetic.

*The quality scoring scope.* The model recommended scoring only the synthesised
scenario era, 14.8 million rows, leaving the LBNL trajectories unscored. I
widened it to include the fault-free LBNL year as well, 26 million rows. **This
one mattered and the recommendation would have caused rework.** The fault-free
year became the baseline for the chiller design curves in 3.4 and for the
constraint residual normalisation in 3.5, and both of those need quality scores
attached to the baseline data. Scoring only the scenario era would have left both
layers fitting against unscored measurements or forced a second pass. The model's
cost estimate was also pessimistic — it projected 50 to 70 minutes for the wider
scope and the actual run took 17.3.

**Confidence**

High on the mechanism. It is exercised by nine rules across two equipment classes
and the dispatch resolves entirely through the published ontology, including the
equivalent-class case that a custom schema could not have handled.

Moderate on the extrapolation. Two classes is a small sample, and the claim that
a third is free rests on the second having cost 24 lines of shared code. A class
with genuinely different temporality — per-zone VAV boxes, where the interesting
comparisons are between zones rather than against a baseline — could need more
than a parameter. The claim I am confident in is narrower than "the third class
is free": it is that the third class will not require touching dispatch.

**Outcome**

**The mechanism holds; the rules it carries are more conservative than expected.**

Nine rules, two equipment classes, and across 1,090 fault-free asset-days —
485 on the air handler and 605 on the chiller — **zero false positives**. Dispatch
resolved correctly for every asset, including the three cooling towers and the
plant, which correctly matched nothing because no rule was registered for them.

What the registry could not fix is what the rules can see. The APAR set caught one
of three injected air-side faults. A stuck outdoor air damper is missed for a
structural reason worth recording: the operating mode is inferred from the same
damper that is broken, so the fault disguises itself as an economizer decision
and routes evaluation away from the one rule that would catch it — that rule's
evidence, when it does run, is more than twice its threshold. A leaking cooling
coil valve is missed because it only shows in a mode the season had already left,
and even there it reaches 22% of the detection threshold.

Neither is a registry problem and neither is fixable by moving a number. They are
the honest cost of a rule set that trades sensitivity for silence, and they are
the argument for the layers that come next: the residuals in 3.5 caught the
sensor drift directly that the rules only saw second-hand, and the condition-
normalised baselines in Task 4 are what the two remaining misses need.
