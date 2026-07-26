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

**Updated after Task 4.**

The forward claim in the paragraph above — that the condition-normalised
baselines were what the two remaining misses needed — was half right, and the
half that failed is the more interesting one.

*The coil valve leak is now caught.* The APAR rule reached 22% of its detection
threshold and stayed silent. The baseline-driven indicator reaches its full
threshold, takes air-handler health from 100 to 43, and estimates the onset at
2036-03-19 against a true injection of 2036-03-17. Two days.

*The stuck outdoor air damper is still missed.* Health ends at 95 out of 100, and
the coil indicator moves to −17.6% of threshold — away from failure, not toward
it. The structural reason recorded above survives normalisation unchanged: the
operating mode is inferred from the same damper that is broken, so the fault
routes evaluation away from itself. A baseline cannot fix a fault that hides
inside one of its own drivers, and no amount of condition-matching will, because
the condition is what is lying.

*The mechanism generalised further than the Confidence section committed to.*
That section claimed only that a third equipment class would not require touching
dispatch. What actually happened is that two entirely new LAYERS were built —
condition-normalised baselines and per-mode degradation indicators — and each of
them independently needed the same question answered, "which machines does this
apply to". Both answered it by calling the same closure:

    analytics/baselines/fit.py :: specs_for(brick_class)
    analytics/health/modes.py  :: modes_for_class(modes, brick_class)

Task 4 added 2,996 lines across 11 files, every one of them an insertion.
`registry.py`, `evaluate.py`, `apar.py` and `chiller.py` changed zero lines
between them. The claim being tested was about a third machine; what it survived
was two new layers.

*And the taxonomy closure earned its keep a second time, by failing loudly enough
to notice.* Checkpoint 4.2's first version of the baseline catalogue used plain
string equality on the Brick class. It fitted both chillers correctly and
silently fitted NOTHING for the air handler, with no error, because `app.assets`
records that machine as `brick:AHU` while the catalogue was written against
`brick:Air_Handling_Unit` — classes Brick declares equivalent in one direction
only, and which rdflib does not reason over. The closure walk built in 3.2 is what
makes those two the same thing, and a project that had keyed on strings would have
shipped two missing baselines.


## D-06 — Condition-normalised baselines over static thresholds

**Forcing question**

Every layer above detection has to answer one question: is this number bad? The
obvious answer is a limit per sensor — supply air above this, fan power above
that — and it is the answer most building analytics ships with. It does not work
here, and the reason is not subtle: in HVAC almost every quantity worth watching
moves far more with operating conditions than with equipment health. A supply fan
drawing 900 watts is alarming at half airflow and unremarkable at full airflow.
The same chiller in the same condition draws 1.2 kW per ton on a mild morning and
1.9 on a hot afternoon.

So a static limit does not fire when the asset is unhealthy. It fires when
conditions are unusual, which is a different event that happens far more often.
That is the documented mechanism behind false-positive fatigue in building fault
detection, and the failure is social rather than technical: a team fed a dozen
alerts a day, most of them explained by the weather, stops reading the alerts.
After that the system's accuracy is irrelevant, because nobody is listening to
it. A detector nobody trusts is worth less than no detector, because it cost
money and it occupies the place where a working one would go.

This had to be settled before the health index, not after. Health is defined as
distance to a failure threshold. If the threshold sits on a raw signal, then the
health number inherits every weather swing, and so does the remaining-life
estimate fitted to it.

**Options**

1. **Static limits per point.** A minimum and maximum per sensor, checked on every
   reading. Free to implement — the columns already exist in `app.points` — and
   trivially explainable to an operator. Conditions on nothing, so it cannot
   distinguish a hot afternoon from a failing compressor even in principle.

2. **Condition-normalised baselines in physics form, fitted per commissioning
   window.** *Chosen.* For each modelled point, learn what a healthy asset does as
   a function of what is being asked of it, using the terms of the equation the
   equipment actually obeys, fitted on three weeks the operator declares healthy.
   Watch the leftover. Roughly a day of work and five model forms.

3. **Learned black-box models per point.** Regress each point on every other
   available point with a gradient-boosted or neural model. Would very likely fit
   better in-sample than a four-parameter physics form. Buys nothing that can be
   checked against physics, and adds a dependency the project does not have.

**Rationale**

The measurement that settles option 1 is not a judgement call. Fan electrical
power regressed on airflow alone explains between 14.6% and 55.4% of its variance
depending on the window, and the fitted cubic coefficient comes out NEGATIVE,
which is physically impossible — more air for less power. The same fan under the
fan-similarity law, conditioned on shaft speed as well as flow, reaches R² 0.977
to 0.989 with a residual spread of 21 to 26 watts. A static limit is strictly
worse than the 15% model, because it conditions on nothing at all.

Put concretely: supply fan power spans 0 to 1,622 watts across a perfectly
healthy run. There is no fixed limit inside that band that does not fire on
ordinary operation, and none above it that ever fires. No value works. After
normalisation the same healthy run's residual moves 0.824 watts across 120 days,
which is 0.03 of its own standard deviation.

The false-positive claim is not hypothetical either. The nine rules in Task 3
already compare against condition-matched baselines rather than fixed limits, and
across 1,090 fault-free asset-days they produced zero false positives. Extending
the same principle to the health index, both clean runs finish at 97 and 98 out
of 100.

A fourth option was considered and rejected inside option 2: fitting one baseline
globally over all clean data rather than one per run. It fails for a specific
reason. The runs sit in different seasons and different simulated eras, so a
global fit would leave a systematic per-run offset in the residual, and the
residual would then partly encode WHICH RUN a reading came from. Fitting per run
means each starts from its own zero, so a residual that grows is the machine
moving away from where it was three weeks ago.

On option 3, the argument for physics form is not elegance, it is that
interpretable coefficients are a cross-check you can actually run. In the two
winter windows the cooling coil model's fitted fan temperature rise came out at
0.51 and 0.56 K. Measuring supply minus mixed air directly with the valve
commanded shut — a completely independent route through the data — gives 0.50 and
0.55 K for the same two windows. Two methods agreeing to a hundredth of a kelvin
is how you find out a model is describing the right physics rather than merely
interpolating. A black box offers no equivalent test. The check is only available
in winter: in the summer windows the valve is almost never shut, the term is
weakly identified, and it fits at 0.06 K — which is itself worth knowing, and is
the kind of thing an uninterpretable model cannot tell you.

Extrapolation decided it. In the stuck-damper run, 32.5% of mixed air
temperatures fall outside the range the baseline was fitted on, because the fault
itself is what moves them there. The effectiveness-NTU form survives that: the
driving temperature difference enters multiplicatively, so the model cannot
predict cooling when there is nothing to cool with, and its error stays bounded.
An unconstrained learned model has no such guarantee at precisely the moment it
matters most, which is during the fault. Every baseline here carries between one
and ten parameters, fitted on 524 to 3,780 samples depending on how much of the
window the model's own gating admits, and each parameter names something — coil
authority, flow dilution, fan temperature rise.

**Mine vs delegated**

*Mine.* Requiring physics-form regression with few, interpretable coefficients
and sane extrapolation, rather than accepting whatever fits best. Requiring the
baselines be fitted on a declared healthy window at the start of each run rather
than once globally. Requiring that the air-handler results come out bit-identical
across the 4.2 generalisation, which is what made that refactor verifiable rather
than merely plausible. Requiring every failure threshold to carry a written
physical or economic justification, as a mandatory column and not a convention.
Requiring health be the minimum across failure modes and never the mean.
Requiring onset confirmation as a hard precondition for projecting any trend.
Authorising the substitution of measurable indicators where the named instrument
does not exist, and requiring the one with no substitute be recorded as absent
rather than proxied.

*Delegated.* The fan-similarity form, once the specified f(airflow) was measured
and shown not to fit. The effectiveness-NTU parameterisation and the decision to
regress on coil duty rather than on the controlled supply air temperature. The
constant chilled-water substitution and the sensitivity sweep that justified it.
The generic ModelForm seam and the per-asset templating. The CUSUM design and its
textbook parameter values. The isotonic implementation and the maintenance
segmentation. The indicator expression language and its whitelist. The discovery
that the coil-effectiveness baseline structurally cannot see the coil leak, and
the separate shut-valve baseline that can.

**Confidence**

High that normalisation beats static limits on this equipment. The gap is 0.15
against 0.99 in explained variance on the same rows, and a healthy run's residual
drifts 0.03 of a standard deviation over four months. This is not a close call
and it did not need a judgement.

Moderate on the commissioning-window approach specifically, and the reason is
recorded in the Outcome below rather than glossed. Twenty-one days in May applied
through September is where the only false alarms in Task 4 came from.

Low on the monotone clamp where excursions are intermittent rather than
progressive. The clamp is correct under its own assumption and the assumption is
sometimes false.

**Outcome**

**The decision was right, and it relocated the false-positive problem rather than
solving it.**

What worked, measured. Both clean runs end at 97 and 98 out of 100 health. All
four progressive scenarios decline monotonically, and one of them — the coil
valve leak — is a fault the rule engine had missed and this layer catches, taking
health from 100 to 43 with the onset estimated two days after injection. The
held-out cooling tower fault moves chiller health by 5 points and no seeded
failure mode claims it, which is what a held-out fault should do to a system that
was not told about it. Across every asset and run, the roll-up equals the minimum
of its modes on every single day, and no per-mode health series ever increases.

What did not work, stated as plainly. The onset detector fires twice on the CLEAN
chiller — chiller-1's efficiency mode on 2039-06-28 and chiller-2's on
2039-06-01, at 3.07 and 4.12 times the decision interval, so not marginal noise.
The cause is not the detector. It is that the chiller efficiency baseline is
fitted on 21 days in May and applied through September, so seasonal conditions
drift outside the fitted envelope and leave a small SYSTEMATIC residual — and a
small sustained shift is exactly what a cumulative-sum detector is built to find.

That is the honest shape of this decision's result. A static threshold fires when
conditions are unusual. A condition-normalised baseline fires when conditions are
outside the window it was fitted on. The second is a much smaller and a bounded
set — 2 false onsets against a raw signal that would have alarmed continuously —
but it is not zero, and the mechanism is the same mechanism wearing a different
coat. The fix is a longer or seasonally refitted commissioning window, which this
dataset cannot supply because each run is only 120 days long. The thresholds were
not adjusted to hide it.

Two mistakes were made inside this decision and both were caught by measurement
rather than by review, which is worth recording because both would have produced
confident wrong numbers. The first normalisation scale used a median absolute
deviation, for consistency with the constraint residuals in 3.5; because these
error distributions mix a very accurate steady regime with a poor post-start one,
measured kurtosis 30 to 250 against 3 for a normal distribution, it reported a
spread of 0.55 watts where the standard deviation reported 24, and put the clean
run's 95th percentile at 53.9 sigma. On the fit-error standard deviation the same
run sits at 1.23. The second: health was first scored against an absolute zero
rather than against the commissioned value, which is correct for residual-based
indicators and wrong for directly measured ones — chilled water at full
compressor command sits 0.2 K above setpoint on a healthy machine, and that alone
started the clean chiller at 90 and ended it at 68 with nothing whatsoever wrong.

**Updated after Task 5.** The forward claim this outcome ended on was that the fix
for the seasonal false onsets is a longer or seasonally refitted commissioning
window, which this dataset cannot supply. That was half right and the wrong half is
the more useful one.

The half that was right: the two false onsets are real and they persist. Nothing in
Task 5 made the changepoint detector stop firing on the clean chillers.

The half that was wrong: a longer commissioning window is not the only fix, and the
one that works needed no more data at all. The problem was never the LENGTH of the
reference period — it was that the reference period is the wrong period. Checkpoint
5.4 compares each window against the FAULT-FREE run at the same time of year
instead of against the start of the same run, and the seasonal artefact simply
disappears: the coil-leak run's mixed air balance reads −2.36 of its own spread
against its own February commissioning window, and +0.03 against the fault-free run
in the same weeks. Same data, same relation, same code — a different choice of what
"normal" is compared to. The lesson generalises past this project: when a
condition-normalised model drifts seasonally, matching the season of the comparison
is cheaper than extending the fit, and it was available the whole time.

And the two false onsets no longer reach anybody. Checkpoint 5.3 refuses to publish
a prediction whose degradation rate cannot be separated from zero, and both of these
sit at 0.08 and 0.11 standard deviations from zero. Across both fault-free runs —
720 combinations of machine, failure mode and day — the system now publishes
nothing at all. So the false-positive problem this decision relocated rather than
solved has now been bounded twice: once by making the comparison season-matched, and
once by requiring a rate to be measurably non-zero before anyone is told about it.
Neither fix touched a threshold in the baseline layer, which is where I expected to
have to pay for this.

---

## D-07 — Wiener first-passage RUL over an LSTM or Transformer

**Forcing question**

Remaining useful life is the deliverable this project is judged on, and the
question is not "which model is most accurate" — nothing here can establish that,
because no run-to-failure population exists to be accurate against. The question
is what a maintenance planner can be handed. A single date is unusable: nobody
schedules a crew on a point estimate with no width. A date with a made-up width is
worse, because the width looks like information and is not.

So the requirement is a genuine distribution over failure dates, narrowing as
evidence arrives, from parameters somebody can argue with. That requirement rules
out more than it sounds like it does, and it rules out the method a reader would
expect to see first.

**Options**

1. **Deep sequence model — LSTM or Transformer over the multivariate history.**
   *Rejected, deliberately.* This is the fashionable answer and it is what a
   reviewer expects on a remaining-life problem in 2026. Two reasons it cannot be
   used honestly here, and the first is fatal. There is no public run-to-failure
   fleet dataset for commercial building HVAC. The LBNL data this project uses is
   labelled fault data, not failure histories: each run is a simulation of a fault
   at a fixed severity, and no machine in it is followed from healthy to dead. So a
   sequence model would have to be trained on the degradation trajectories in
   `simulator/trajectory.py` — which this project synthesised. Training a model on
   my own synthetic ramps and then reporting its accuracy against those same ramps
   measures whether the network can learn the shape I chose. It is circular, and
   the resulting accuracy number would be a fabrication dressed as a result. The
   second reason: it produces no attribution. It cannot say WHY it expects failure
   in forty days, so it cannot be checked, and a technician cannot act on it.

2. **Weibull or another age-based reliability distribution.** *Rejected.* Fits a
   failure-time distribution to equipment age and returns a hazard from the age
   alone. This is what most maintenance planning software actually does, and it is
   the thing predictive maintenance is supposed to replace: it says nothing about
   the machine in front of you. Two identical chillers of the same age, one with a
   fouled condenser and one clean, get identical predictions. Every measurement
   this project spent four tasks producing would be discarded at the last step.

3. **Cox proportional hazards.** *Rejected.* The right shape of answer — a hazard
   modulated by measured covariates, so condition does enter — and it is the
   standard tool when you have a population of units, some of which failed. That
   population is the problem. Cox estimates its baseline hazard from observed
   failures across many units; here there is one air handler and three chillers,
   with zero recorded failures between them. There is nothing to estimate the
   baseline hazard from, and a Cox model fitted to no failures is not a Cox model.

4. **Wiener process with drift, failure as first passage to a threshold.**
   *Chosen.* Model the degradation indicator as a trend plus noise, and define
   failure as the first time it touches the threshold in `app.failure_modes`. For
   this process the first-passage time is Inverse Gaussian in closed form, so the
   whole distribution over failure dates is an expression rather than a simulation.
   With a Gamma process as the declared alternative for modes whose underlying
   quantity can only accumulate.

**Rationale**

The interval is the model's own output, not an add-on. This is the decisive
property and it is what all three rejected options lack. A Wiener process starting
a distance `a` below its threshold with drift `mu` and diffusion `sigma` reaches
that threshold at a time whose cumulative distribution is two normal terms:

    F(t) = Phi((mu*t - a)/(sigma*sqrt(t)))
           + exp(2*mu*a/sigma^2) * Phi(-(mu*t + a)/(sigma*sqrt(t)))

P10, P50 and P90 are quantiles of that. There is no point estimate anywhere in
`analytics/rul/estimator.py` and nothing is padded by a factor chosen to make the
band look appropriately humble. Checked against scipy's Inverse Gaussian on four
parameter sets spanning these modes, the implementation agrees to 5e-16.

The parameters mean something a person can dispute. `mu` is kelvin per day, or
watts per day, or kW/ton per day. `sigma` is how far a single day strays from that
rate. `a` is how far the indicator still has to travel to reach a threshold with a
written physical justification beside it in the config table. Somebody who thinks
the answer is wrong can point at which of those three they disagree with. No layer
of an LSTM affords that.

Bayesian updating on `mu` makes the narrowing a property of the model rather than
a hope. Accumulated precision is a running sum of positive terms, so the standard
deviation of the belief about the rate can only fall. Measured: on the coil valve
leak it goes 0.0110, 0.0067, 0.0054 over 17, 57 and 91 post-onset days, and across
14 mode/asset/run combinations it narrows in 12, holds unchanged in 1 where no new
data arrived, and widens in exactly 1 — a Gamma-declared mode on an accelerating
fault, where the absolute width grows 6.9% while the scale-free width narrows
10.6%, which is inherent to the Gamma family tying spread to mean.

And the model can refuse. This is the property I did not anticipate and it is the
best thing about the choice. For non-positive drift the first-passage distribution
is DEFECTIVE: the total probability of ever reaching the threshold is
`exp(2*mu*a/sigma^2)`, less than one, with the missing mass at infinity. The
belief about `mu` is normal so it always puts some weight there, and if P90 lands
in the missing mass then there is no P90 and the estimator returns nothing. That is
not a special case anybody coded — it falls out of the arithmetic of the chosen
process, and it is why checkpoint 5.3 has a coherent thing to refuse on.

**Mine vs delegated**

The rejection of the deep model on circularity grounds is mine and it is the
central call in this entry. It would have been straightforward to train a small
LSTM on the synthesised trajectories, report a low validation error, and present
that as the headline. The reason not to is that the trajectories were built by
`simulator/trajectory.py` from a severity ladder I chose; measuring a network
against them measures my own assumptions, and I would have had no honest way to
say so in a results table. Declining the method a reviewer expects is a risk I
took knowingly.

The Gamma-process alternative was specified. Where it applies is mine: the column
`degradation_process` in `app.failure_modes` carries a per-mode physical argument,
and I assigned `gamma` only where the underlying quantity is irreversible —
deposit on a tube, escaped refrigerant, trapped dust. Bearing wear is physically
irreversible too and I still assigned `wiener`, because 45 of 116 daily changes in
that indicator are downward on a machine with nothing wrong with it, and a process
that assigns zero probability to observed data is worse than one that is
philosophically imprecise.

The prior is mine and three versions of it were wrong. Scaling its width by the
commissioning-period spread made it worth several thousand days of observation on
a fast fault, dragging a measured 0.438 kW/ton per day down to 0.021. Re-deriving
it at each date meant the starting point moved, so the interval could widen while
evidence accumulated. Re-estimating the noise at each step gave day one roughly
eight hundred times the weight of day thirty. The version that works fixes the
prior, the process spread and the Gamma shape once, at the moment degradation is
confirmed, and then only accumulates evidence.

**Confidence**

High that this is the right family for this problem, and the confidence does not
rest on accuracy. It rests on the interval being derived rather than asserted, on
the parameters being disputable, and on the model being able to decline. Those are
properties of the choice and they hold whether or not any particular prediction
lands.

Moderate on the numbers. Three modes both degraded genuinely and crossed their
threshold inside a run, and for those the median prediction three weeks out lands
+2.0, +3.9 and +13.6 days from the crossing it was predicting. That is a small
sample of three, on synthetic degradation, and it should be read as "the machinery
is not broken" rather than as a measured accuracy.

Low on `sigma` being right. It is fixed from the first fittable window, so a
trajectory that later turns out much noisier than its opening weeks gets an
interval that is too narrow by that factor. The monotone clamp upstream makes this
worse: it flattens a median of 90 percent of all daily intervals and deflates the
measured spread by between 2.8 and 61 times, which is why the spread is floored at
the indicator's own commissioning-period spread. That floor is doing real work in
12 of 14 cases and it is a patch over an upstream problem, not a solution to it.

**Outcome**

**The model was right and the refusal layer turned out to be the load-bearing
half.** 1,117 estimates were stored across 14 mode/asset/run combinations and the
first-passage arithmetic behaved exactly as advertised — verified against scipy,
against simulated random walks for the defective case, and monotone in time. But
the raw estimator, used on its own, produced two badly wrong answers with
impeccable arithmetic: the air handler on the coil-leak run reported that it had
ALREADY failed, on the strength of a fan indicator whose rate sat 0.49 standard
deviations from zero, and the fault-free chiller reported a median crossing 254
days out with nothing whatever wrong with it.

Neither is a defect in the model. Both are it faithfully computing the consequence
of a rate it cannot distinguish from no degradation at all. Refusing on exactly
that quantity fixed both, and the effect is the single most convincing measurement
in Task 5: across both fault-free runs, 720 combinations of machine, failure mode
and day where any prediction is wrong by definition, the system now publishes
nothing. And on the air handler carrying the coil leak the answer a human sees
flips from "this unit has already failed, because of its fan" to "its cooling coil
valve needs attention in about a month", which is the fault that was injected.

What this means for the decision is worth stating precisely, because it is not
what I expected going in. The value of choosing an interpretable parametric process
was not primarily that its predictions were good. It was that `mu` and its
posterior spread are quantities you can test against zero. A deep sequence model
would have produced its wrong answers with no comparable quantity to gate on —
there is no "is this network's belief separable from no degradation" test — so the
fan-bearing false alarm and the healthy-chiller prediction would have shipped. The
refusal layer exists because the model has parameters. That is the real argument
for this decision and I did not have it when I made it.

One cost, paid and recorded. The interval genuinely widens sometimes, and the
verification asked for it never to. On the coil valve leak the P10-to-P90 span goes
from unbounded to 1,160 days to 1,947 days across the three weeks before failure,
because the indicator plateaus during exactly that window — the answer key
confirms the fault reached terminal severity on 2036-05-01, mid-window. The rate
sawtooths, decaying between the discrete steps of an indicator that only exists
while the coil valve is commanded shut, and P90 sits far out in the tail of a rate
only two standard deviations clear of zero. A model that becomes less certain when
the machine stops getting worse is behaving correctly. It was not tuned to pass.

**Updated after Task 6.** Two things, one of which is the reason to have made this
decision at all and one of which is a cost I did not anticipate.

The payoff is that an interpretable parametric model has something you can DRAW. The
fan chart in checkpoint 6.5 plots the P10-to-P90 interval against the date each
prediction was made, and on the coil valve leak it closes from 3,479 days to 59 across
84 successive estimates as the post-onset sample count goes from 14 to 53. That picture
is the whole argument for predictive maintenance in one image: early on the system says
"somewhere in the next ten years", which is visibly useless, and eight weeks later it
says "11 to 34 days". A deep sequence model has no comparable object. It can emit a
predicted date and, with effort, a spread; it cannot show you a belief tightening,
because there is no belief in it — only an output. Everything that makes this chart
legible comes from the fact that the model's uncertainty is a parameter with a
posterior, and the same is true of the readout beside it: 84 estimates, widest 3,479
days, narrowest 23, closed by 97 percent, sample count 14 to 53, monotone no.

The unanticipated cost is that interpretability created a NEW failure mode as well as
the ability to catch one. Because the model has parameters, the platform publishes two
different numbers derived from the same daily indicator — a health score computed from
an isotonic clamp, and a first-passage interval computed from a trailing median held at
its running maximum. On a clean indicator they agree. On the air handler's fan indicator
they contradicted each other flatly: health 63 of 100, meaning most of a life left,
beside a median time to failure of zero days. Both were the system's own published
numbers and neither was arithmetically wrong; the indicator reads 3.4 to 7.5 watts on 30
of the last 34 days against an 88.9 watt threshold, with isolated single-day excursions
to 245, 406 and 178.6, and the two smoothings disagree about whether those count.

That contradiction was worth 68,400 USD of expected replacement cost and put the LEAST
degraded mode in the building at the top of the priority queue. It is now caught by a
third refusal, in the advisory layer, which withholds a prediction its own health score
refutes and prints which two numbers disagreed. So the shape of this decision's outcome
has extended once more: choosing a model with parameters bought a quantity to refuse on,
and then bought a second refusal made necessary by having two published quantities at
all. A model with no interpretable state would have had neither problem and neither
defence — it would simply have been believed.

---

## D-08 — Constraint isolation for sensor versus equipment discrimination

**Forcing question**

A drifting supply air temperature sensor and a leaking cooling coil valve produce
the same complaint at the air handler: supply air is not where the controller wants
it. The two call for opposite responses. Sent for equipment when it is a sensor,
somebody dismantles a healthy coil; sent for a sensor when it is equipment,
somebody recalibrates a thermometer that was telling the truth and the machine
carries on failing. Getting this wrong wastes the visit either way, and a
predictive maintenance system that cannot tell them apart is producing work orders
by coin flip on a substantial fraction of what it detects.

The tempting approach is a signature per fault: this pattern means sensor, that
pattern means equipment. It is quick and it is a dead end, because the number of
patterns grows with the product of faults and equipment types, and each one is a
claim about the data that nothing can falsify.

**Options**

1. **Learned classifier over the residual vector.** Label the scenarios and train
   something to map residual patterns onto sensor-or-equipment. Rejected for the
   same reason as the deep RUL model in D-07 and more sharply: there are four
   labelled AHU scenarios. A classifier fitted to four examples has memorised them.

2. **A signature rule per fault mode.** Written by hand from the physics: sensor
   drift moves the coil balance one way, a leak moves it the other. Rejected
   because it does not generalise past the faults somebody thought of, and because
   it is unfalsifiable in the way that matters — there is no observation that could
   contradict "this pattern means sensor".

3. **Analytical redundancy: single-sensor bias reconciliation over the declared
   relation set.** *Chosen.* Write down every relation between measurements that
   ought to hold. Observe which stopped holding. Ask whether ONE measurement, if
   assumed to read consistently wrong, makes all of them hold again — and crucially
   whether the bias that fixes one relation BREAKS another that the same
   measurement appears in. If a single bias reconciles everything, the instrument
   is the suspect. If no single bias can, the measurements agree with each other
   and the machine is what changed.

**Rationale**

Option 3 is the only one that can be wrong, and that is the argument for it. Every
hypothesis makes a checkable prediction about relations it did not come from. On
the sensor drift, assuming `ahu-1.sa_temp` reads high predicts a specific shift in
three different relations at once, and one bias of +2.434 K reproduces all three
within their own spreads. The true injected bias is +4 degrees Fahrenheit, which is
+2.22 K. The recovered figure is out by 0.21 K, under ten percent, and nothing in
the isolation path has access to the answer key.

On the coil valve leak the same hypothesis is refuted by its own arithmetic. The
bias that reconciles the shut-valve baseline pushes the coil-effectiveness baseline
from −1.11 to +2.88 of its own spread, flipping its sign. One number cannot be both,
so no single measurement is lying, so the machine is not performing. That is a
falsification, not a pattern match, and it would work identically on a fault nobody
has thought of.

**The consequence for where sensor coverage lives, and a correction to how I first
stated it.** The premise of this decision is that discrimination is possible only
where a measurement appears in more than one relation — one relation with one
suspect can always be reconciled, because it is one equation in one unknown with no
way to fail. That makes coverage a MODELLING property, settled in the semantic
model, not a threshold inside a detector. The mixed-air section demonstrates it
working as intended: `ma_temp` appears in both the mixed-air balance and the coil
energy balance, and on the stuck-damper run that over-determination is what
falsifies it — a bias reconciling one would break the other.

But the correction matters more than the confirmation. `sa_temp` appears in exactly
ONE physical constraint. On the `.ttl` constraint set alone the supply air sensor
is unfalsifiable, and BOTH faults in the key test come out as "a sensor explains
it". The coverage that made the key test possible did not come from the constraint
bindings at all. It came from the condition-normalised baselines of Task 4:
observed minus expected is a relation that ought to sit at zero exactly like a
constraint residual, its derivative with respect to its own target point is exactly
plus one, and `sa_temp` is the target of two of them. Three relations instead of
one, and the case becomes decidable.

So the honest form of the consequence is broader than the one I set out to record.
Sensor coverage is a modelling decision — and the model that provides it is not
only the constraint graph. Any declared relation counts, and a fitted baseline is
one. That is a more useful conclusion than the original, because adding a baseline
is cheaper than adding a physical constraint and needs no new instrumentation.

Sparsity is the preference rather than a regulariser bolted on. Two solves run: an
explicit sweep of every single-point hypothesis, which is the sparsest correction
that exists, and an L1-penalised fit over all points at once to check whether the
correction WANTS to concentrate. On the drift run the penalised solve puts +2.415
on supply air temperature and +0.001 on everything else, reaching the sweep's
answer independently.

**Mine vs delegated**

Analytical redundancy and the sparsity preference were specified. What the task
described as achievable with the constraint residuals alone was not, and finding
that out is the substance of my contribution: bringing the Task 4 baselines in as
additional relations is the difference between this checkpoint working and not.

Four judgement calls, each forced by a wrong answer I got first, all recorded in
`analytics/diagnosis/`. The reference window has to be the fault-free run at the
same time of year, not the start of the same run — comparing the coil-leak run's
May behaviour against its own February commissioning window reported the mixed-air
balance out by −2.36 of its spread, and every bit of it was the weather; season
matched, the same figure is +0.03. A baseline's spread must not be measured over
the window it was fitted on, because that is an in-sample fit error, and using it
rejected a hypothesis explaining 94 percent of everything. Falsification has to
mean "makes some relation worse", not "leaves nothing above one sigma", which
demands 92 percent per-relation accuracy on a twelve-sigma violation. And at least
two VIOLATED relations must agree, not merely two relations exist — condenser
fouling genuinely raises compressor power, so "the meter reads 63 kW high" is
arithmetically identical to "the machine draws 63 kW more" from one relation, and
without this the fouled chiller was diagnosed as a faulty power meter.

**Overrode**

Two instructions in the task were followed in a different form than written,
because as written they produced wrong answers, and both are worth naming.

The localisation test was to be computed over the constraint graph on the premise
that a sensor fault moves one node while its neighbours hold still. On raw
readings that premise is false here, because these air handlers run closed loops:
when the supply air sensor drifts high the controller opens the chilled water
valve until the READING returns to setpoint. Mean valve position goes from 0.310 on
the fault-free run to 0.445 on the drift run, while supply air relative to setpoint
moves LESS than on the clean run. In raw measurement space a drifting sensor looks
distributed and its neighbours look guilty. Computed on residuals the premise
holds exactly, and the drift scores 1.00 — a control loop can hide a fault from a
measurement but it cannot make a physical relation hold that does not hold.

The quality flags from Task 3 were to be combined in as a third test and they
cannot serve as one. Measured across these runs, `ahu-1.sa_temp` draws stale-data
advisories on ALL FOUR, the fault-free run included, 16 times there against 8 on
the run where it is genuinely drifting. That layer answers "can this reading be
trusted right now", which is about dropouts and stuck values, and it is silent on
whether a reading arriving perfectly on time is correct. Treating it as evidence
would have made the fault-free run the most suspicious of the four. It is wired in
as a confidence caveat that can downgrade `clear` to `weak`, and it changes no
classification in the set.

**Confidence**

High on the two-fault key test. Both classify correctly, the recovered sensor bias
lands within 0.21 K of an injected value the code cannot see, and the separation is
not marginal: on both fault-free runs every relation sits below 0.48 of its own
spread against 12.18 on the drift run.

High that the method generalises past these faults, because nothing in it is keyed
to a fault. It asks one question — can a single measurement be biased to reconcile
this — and the question has the same form for any relation set.

Moderate on the four-way classification. Six scenarios classify correctly and all
four classes are reached, but three of the four classes rest on a single scenario
each. `control` in particular rests entirely on the stuck damper, and the threshold
that catches it had to be made relative to the fault-free gap because one actuator
in this building disagrees with its own command by half of full travel on every run
— the same source-data defect Task 3 found when it discovered `sf_status` is
byte-identical to the occupancy schedule.

Low on anything requiring a season-matched fault-free reference outside the
May-to-September window the clean air handler run covers. The stuck-damper run is
late winter and has none; its constraint evidence is therefore untrustworthy and
the output says so. Its classification survives only because an actuator
disagreeing with its own command needs no reference at all.

**Outcome**

Six scenarios, six correct classifications, all four classes reached including
`ambiguous`. The key test passes: the sensor drift is called SENSOR and named to
the right point with a bias within ten percent of truth, and the coil valve leak is
called EQUIPMENT, from a single mechanism that was never told which fault was
which.

The most useful thing this produced is not a classification. It is that
`ambiguous` turned out to be a diagnosis of the INSTRUMENTATION rather than of the
equipment, and an actionable one. When the only surviving suspect appears in a
single relation, the correct output is not a guess with low confidence — it is
"this building cannot decide this case, and one more relation containing this point
would make it decidable". `chw-plant-1.sec_supply_temp` is permanently in that
state here and cannot even be cross-checked, because the model already records that
the two LBNL systems are independent simulations and the water in that expression
is not physically the water that cooled that air. That is a gap in the model, it is
now visible as one, and closing it is a `.ttl` edit rather than a threshold change
— which is exactly the consequence this decision was made to produce, arrived at
from a direction I did not expect.

The measured set, for the record:

    ahu_sat_sensor_drift        SENSOR     ahu-1.sa_temp, bias +2.434 K (true +2.22)
    ahu_cooling_valve_leakage   EQUIPMENT  no single bias reconciles the relations
    ahu_oa_damper_stuck         CONTROL    oa_damper 0.612 from command vs 0.000 clean
    chiller_condenser_fouling   EQUIPMENT  power bias would break the energy balance
    clean_ahu                   AMBIGUOUS  nothing violated, nothing degrading
    clean_chiller               AMBIGUOUS  nothing violated, nothing degrading

Two limits are worth carrying forward rather than leaving implied. Three of the four
classes rest on a single scenario each, so "all four classes are reachable" is
demonstrated and "all four are reliable" is not. And the whole layer depends on
having a fault-free window at the same time of year to compare against; where the
calendar does not supply one, as on the late-winter damper run, the constraint
evidence has to be discounted and the output says so.

**Updated after Task 6.** The classification became money, and in becoming money it
exposed a scope error in how I was applying it.

The money first, because it is the answer to "why does this matter". Checkpoint 6.2 keys
the intervention library on the fault AND the fault class, so the same reported symptom
resolves to two different jobs. `apar-20` — a cooling coil valve that has run fully open
and stayed there — classified as a sensor fault is `calibrate-supply-air-sensor`: 1.5
technician-hours with a reference probe, 262.50 USD all in. Classified as an equipment
fault it is `inspect-coil-capacity`: 6.0 hours of coil survey, 830.00 USD. Same rule id,
same evidence, 3.2 times the cost and a different trade dispatched. That ratio is what
this decision is worth per occurrence, and it is a row in a table rather than a branch in
code, so a site with different labour rates changes the number without touching the
discrimination.

The scope error is the more instructive half. The isolation sweep answers per ASSET per
window: it sweeps the physical relations and reports what is wrong with the machine. I
handed that verdict to every advisory on the asset, which on the 2038 air handler run
labelled the supply fan's bearing wear a SENSOR fault — because the supply air
thermometer on the same machine is drifting. The two faults have nothing to do with each
other, and the label would have sent somebody with a calibration kit to a worn bearing.

The fix sharpens what this decision actually claims. A rule firing takes the asset's
class, because a rule reports a symptom and "why" is exactly the question the sweep
answers. A failure mode is equipment degradation by construction, because the health
layer measured a physical quantity trending toward a threshold and a changepoint detector
confirmed the onset — that is a statement about the machine, not about an instrument.
UNLESS the mode's own indicator is computed from the very measurement the sweep accuses,
in which case the trend may be an artefact of the lying instrument and the mode inherits
the sensor verdict. That last clause is not hypothetical: the cooling coil leak-by
indicator is the supply air temperature residual, which is precisely the drifting point,
so on that run the leak-by trend genuinely is suspect and now says so.

Stated plainly: the constraint isolation verdict is about the asset's violated relations,
not about every fault open on the asset. I had been over-reading it, and the
over-reading was invisible until advisories put a class badge on every row.

---

## D-09 — Cross-asset consequential faults are demoted, never hidden

**Forcing question**

Once the platform can trace a symptom upstream, it faces a choice it cannot avoid.
The chiller is fouled; the air handler's coil consequently cannot reach its supply
air setpoint; two advisories exist and one of them is arguably not a fault at all.
Sending a technician to the air handler wastes the visit — they will find a coil
doing everything it was asked. So the obvious move is to suppress the downstream
advisory and show only the machine that needs attention.

The question is whether the platform is allowed to remove a finding from an
operator's queue on the strength of an inference. Not on the strength of a
measurement — the air handler's symptom is measured, it is real, the valve genuinely
is saturated — but on the strength of a claim that something else explains it. That
claim rests on a graph edge somebody authored and a mechanism somebody wrote down.
Both are fallible in ways the operator can check and the platform cannot.

**Options**

1. **Suppress the downstream advisory.** Cleanest queue. One machine named, one
   visit dispatched, no ambiguity for the operator to resolve. This is what most
   alarm-reduction features in building automation actually do, and it is why
   operators distrust them.

2. **Demote it, link it, keep it visible.** Chosen. The advisory stays in the queue,
   ranked below its own cause, dimmed and indented, carrying the name of the machine
   held responsible and the mechanism claimed. Costs a line of screen space.

3. **Flag it, leave the ranking alone.** Mark it consequential but let it compete on
   its own priority. Honest, and useless: on this dataset the symptom's severity is
   1.00 and it would sit at the top of the queue above the chiller that explains it,
   which is exactly the failure the traversal was built to prevent.

4. **Merge the two into one advisory naming both machines.** Attractive, and wrong
   for a reason that took a while to see: a merged advisory cannot be disagreed with
   in halves. If the link is wrong the operator has to reject the whole thing,
   including the correctly detected downstream symptom, and has nowhere to put the
   observation that the coil really is misbehaving.

**Rationale**

Suppression fails on a trust argument, not a technical one, and the argument is
asymmetric in a way worth spelling out.

If the platform demotes correctly, the cost is one dimmed row an operator's eye
skips. If it suppresses correctly, the benefit is that same row not being there. The
upside of suppression over demotion is therefore approximately nothing.

If the platform demotes wrongly, the operator sees a real fault ranked lower than it
deserves, notices, and works it anyway — the queue was ordered badly and nothing was
lost. If it suppresses wrongly, a genuine fault is gone. Not deprioritised: absent.
And the operator finds out by the equipment failing, at which point they learn that
this system removes things from their queue based on guesses. After that they read
the raw alarm list, and every layer in this project — quality scoring, physics rules,
condition-normalised baselines, health, remaining life, discrimination, cross-asset
reasoning — is worth nothing, because nobody is reading its output.

So the asymmetry is: demotion risks a badly ordered queue, suppression risks the
operator's belief that the queue is complete. The second is the only thing this
platform actually has.

There is a narrower engineering reason too. The demotion is arithmetic — 40 percent
of the advisory's own priority, then forced at least 5 percent below its cause's, with
chains resolved so a two-step attribution cannot leave the last symptom outranking
the middle link. Two mechanisms rather than one, because a multiplier alone cannot
guarantee the ordering: a severe symptom fed by a mild cause can still come out on
top of it, and "ranked below its cause" is the property the whole layer exists to
provide. Arithmetic can be inspected and tuned. Suppression is a boolean, and a
boolean has no dial to turn when it turns out to be wrong 30 percent of the time.

**Mine vs delegated**

The prompt specified this one. It named "demote, do not hide" and gave the reason —
suppressing entirely destroys trust when the inference is wrong. I did not choose the
policy.

What is mine is the mechanism and the honesty about it. The multiplier value, the
clamp against the cause, the chain recursion, the two-tier queue that keeps demoted
unpriced advisories ranked on severity rather than dropping them to zero, the visual
treatment that dims and indents without removing any field, and the decision to have
the plant schematic light only the blamed chiller rather than the whole plant — all
mine. So is the admission rule on the plausibility map, which is the thing that stops
demotion happening promiscuously: a cause must be a fault that degrades the MEDIUM the
downstream asset consumes. Without that the map becomes a list of opinions about which
faults feel related, and then demotion starts hiding things on no evidence at all.

Also mine is the verification design. I built the negative case first — a window where
topology and timing both permit a link and the mechanism refuses it — because a
demotion feature that never declines to demote is indistinguishable from one that
demotes everything.

**Confidence**

High on the policy, and I would have chosen it unprompted for the trust argument
above. Medium on the numbers: 0.4 and the 5 percent margin are placements, not fitted
values, chosen so a demoted symptom still outranks routine work while no longer
competing with its cause. They need exposure to real operators to settle.

Low on one thing, stated because it is the weakest part of the layer: the plausibility
map has six rows and they are all the same physical chain. Its discriminating power is
demonstrated on one negative case and one positive case. A map this small cannot be
said to generalise, and the honest claim is that the MECHANISM generalises — topology
from the graph, mechanism from a declared table, timing from openness and freshness —
not that the table is complete.

**Outcome**

**The inference is wrong on this dataset, and that is the most useful result in Task 6.**

The composed situation puts chiller-1's real detected condenser fouling upstream of
the air handler's real saturated cooling valve. The traversal finds it at two hops
across the chilled water loop, the mechanism matches, the timing holds at 5.8 days of
evidence age, and `apar-20` is duly marked consequential and demoted — from the top of
the queue on its own severity of 1.00 to the last row of seven on the dashboard.
Everything worked.

And checkpoint 5.4 independently classifies that same air handler fault as a SENSOR
fault: the supply air thermometer is drifting high and the controller is saturating
the valve chasing a temperature that is not real. The chiller has nothing to do with
it. Two faults on connected machines in the same weeks were a coincidence, which is
what they usually are.

So the queue has blamed a chiller for a thermometer — and because the advisory is
demoted rather than suppressed, it is still on screen, still carrying its SENSOR
badge, still carrying the 94-percent single-sensor reconciliation on `ahu-1.sa_temp`
that contradicts the attribution, and an operator can overrule it in one glance. Had
it been suppressed, a drifting sensor would have vanished behind a chiller, and the
only evidence remaining on screen would have been the chiller's. I arrived at the
argument for this decision from the wrong side: not by reasoning about trust in the
abstract, but by watching the feature be wrong on the first real case it was given.

Measured, for the record:

    situation 1, real data      5 advisories, 0 attributed — the map refuses although
                                topology and timing both permit the link, because the
                                open chiller fault is efficiency loss, which costs
                                power rather than capacity and cannot warm the water
    situation 2, real data      4 advisories, 0 attributed
    situation 3, same window
      as 1 plus one fault       apar-20 demoted 1.000 -> 0.152, position 1 -> 4,
                                linked to chiller-1 at 2 hops, still in a queue of 6

Those three lines are checkpoint 6.1's ranking, which orders on severity because the
cost of inaction did not exist yet. On the finished dashboard the same advisory is
demoted differently and further: its cost of inaction cannot be computed at all — a
saturated valve wastes no measurable energy and has no failure threshold to cross — so
it is unpriced, ranked among the unpriced rows on severity, below its own cause and
below the one other unpriced row, seventh of seven. Two demotions by two different
mechanisms, both landing it under the chiller, neither removing it.

The schematic makes the same point visually and adds one thing the queue cannot: with
the path lit, the chiller and the air handler are visibly joined by a pipe, so an
operator can see the claim being made rather than reading it. Exactly one of three
chiller-to-loop pipes lights, because the diagnosis named one machine and lighting the
plant would say something the diagnosis did not.

Two limits carried forward. The dataset cannot produce this scenario unassisted — the
two LBNL systems are independent simulations, so no air handler run is fed by a starved
chiller, and every chiller run ends four days before the saturated valve first
sustains; situation 3 moves one real fault's dates by two whole years and says so in
the module docstring, the report and the dashboard. And `app.advisories.status` has
three values with nothing in the project moving a row off `open`, so an operator can
demote-and-see but cannot yet acknowledge or close. A queue with no way to retire an
item is not finished being a queue.
