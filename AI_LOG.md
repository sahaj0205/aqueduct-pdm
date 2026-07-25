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

_(left blank)_

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

_(left blank)_

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

_(left blank)_
