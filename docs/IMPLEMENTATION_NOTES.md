# Implementation Notes

Appended after each approved checkpoint. Records the capability the system
gained and how the code that provides it actually works.

---

## Checkpoint 1.1 — Project context and scaffold

### WHAT WE DID

The repository now has a written definition of what is being built and a
skeleton to build it in. Anyone opening it can read one page and learn which
building systems are in scope, where the data comes from, why the two machines
are modelled as connected, and the fixed order the ten processing stages run
in. Before this there was nothing but a working-agreement file. The empty
directories are not decoration — the layer order in the context document maps
one-to-one onto them, so where a future piece of code belongs is already
decided rather than argued about later. The dependency list is also pinned and
installable, which means every later checkpoint starts from an environment that
is known to resolve rather than discovering a broken package combination
halfway through writing a loader.

### HOW IT WORKS

`PROJECT_CONTEXT.md` :: Scope section
- WHY IT EXISTS: Fixes the boundary of the project so later checkpoints do not
  drift into modelling equipment we have no data for. It also states the single
  most important structural fact of the whole system.
- WHAT IT DOES: Names the two equipment classes — an air handling unit (the
  machine that conditions air and blows it into the building) and a
  water-cooled chiller plant (the machine that makes cold water and dumps its
  waste heat to a cooling tower) — and records that they share a chilled water
  loop, with the chiller feeding the air handler's cooling coil. It spells out
  why that one connection matters: a symptom seen at the air handler, such as
  the coil not reaching its target air temperature, can be blamed on the
  chiller upstream instead of being written up as an air handler fault. Without
  that modelled link every diagnosis would stop at the edge of one machine.
- CHOICES: Every domain term is defined inline on first use, per the language
  rules in CLAUDE.md.

`PROJECT_CONTEXT.md` :: Data source section
- WHY IT EXISTS: Records where the numbers come from and, more importantly,
  that we did not generate them. That is the claim the validation work later
  rests on.
- WHAT IT DOES: Names the LBNL Fault Detection and Diagnostics Datasets and the
  two systems we take from them. Notes what each system ships: CSVs at several
  fault severity levels plus a fault-free baseline case, and a Brick Schema
  `.ttl` file — Brick being a standard vocabulary for describing building
  equipment and sensors as a graph. Points forward to the decision-log entry
  that justifies the choice.

`PROJECT_CONTEXT.md` :: Layer order section
- WHY IT EXISTS: The processing stages have a strict dependency order, and
  getting it wrong is expensive — for example, fitting "normal behaviour"
  baselines before filtering out bad sensor readings would bake the bad
  readings into the definition of normal.
- WHAT IT DOES: Lists all ten stages as a numbered chain from ingest through to
  the UI, stating that each consumes the one above it.

Directory layout :: the `platform/` subtree
- WHY IT EXISTS: Each analytics layer gets its own directory so the layer order
  is visible in the filesystem, not just in prose.
- WHAT IT DOES: `platform/` holds six subdirectories matching stages 2 and 4
  through 8 of the layer order — quality, rules, baselines, health, rul,
  diagnosis. Every directory is empty apart from a `.gitkeep`, which is a
  zero-byte file that exists only because git tracks files and not directories,
  so an empty directory would otherwise vanish on commit.
- ⚠ JUDGEMENT CALL: `platform` is also the name of a Python standard library
  module, and pandas and others import it. I deliberately did **not** add
  `__init__.py` files. A directory with no `__init__.py` is only a namespace
  package, which Python ranks below a real stdlib module on the import path, so
  `import platform` still finds the real one — verified. The moment anyone adds
  `platform/__init__.py`, it will shadow the stdlib and break pandas' import at
  startup. The alternative was to rename the directory to something like
  `pipeline/`, rejected because the name was specified; flagged because the
  failure mode is obscure and the fix later is a rename that touches every
  import.

`pyproject.toml` :: `[project].dependencies`
- WHY IT EXISTS: Pins the toolchain named in CLAUDE.md so every later
  checkpoint installs the same thing.
- WHAT IT DOES: Declares FastAPI with uvicorn for the API, pydantic v2 and
  pydantic-settings for typed config, SQLAlchemy 2.0 with the psycopg 3 driver
  for database access, rdflib for the Brick graph, numpy/scipy/pandas/
  statsmodels for the analytics, and pint plus pyyaml plus python-dotenv for
  ingestion and config. Requires Python 3.11 or newer.
- CHOICES: Three dependencies are not in CLAUDE.md's list but are required by
  checkpoints in this task — `pint` (checkpoint 1.5 names it for unit
  conversion), `pyyaml` (1.5 specifies a YAML manifest), and `psycopg[binary]`
  (SQLAlchemy needs a PostgreSQL driver; the `[binary]` extra ships a prebuilt
  wheel so no local libpq build is needed). `python-dotenv` and
  `pydantic-settings` are for reading the `.env` credentials that checkpoint
  1.2 introduces. Version floors are minimums, not pins — the exact resolved
  set is frozen in `uv.lock`.
- ⚠ JUDGEMENT CALL: `package = false` under `[tool.uv]` means the project is
  treated as a set of scripts, not an installable library, so `uv sync`
  installs dependencies without trying to build `aqueduct-pdm` itself.
  Alternative was a full src-layout package; rejected as unnecessary ceremony
  for something that is only ever run from its own repo root. `ruff` is the
  only dev dependency, for linting.

`Makefile` :: `install`
- WHAT IT DOES: Runs `uv sync`, which reads `pyproject.toml`, resolves the
  dependency graph, writes `uv.lock`, and creates `.venv`.
- CHOICES: uv over pip/poetry because it is already on this machine and
  produces a lockfile without extra config.

`Makefile` :: `db-up` and `db-down`
- WHY IT EXISTS: The database is a container, and a target that returns before
  the database actually accepts connections would make `make db-up && make
  load` in checkpoint 1.5 fail intermittently.
- WHAT IT DOES: `db-up` starts the compose stack detached, then loops calling
  `pg_isready` inside the container once a second until it answers, and only
  then prints ready. `db-down` stops the stack but does not pass `-v`, so the
  named volume and its data survive.
- CHOICES: Polling `pg_isready` rather than a fixed `sleep`, because
  TimescaleDB's first start does extension setup and the wait is not a
  predictable length.
- ⚠ JUDGEMENT CALL: `db-down` deliberately preserves data. Alternative was
  `docker compose down -v` for a truly clean slate every time, rejected because
  it turns a routine stop into silent data loss. Checkpoint 1.5's "from a clean
  database" verification will need an explicit volume removal, done inline
  there rather than making destruction the default.

`Makefile` :: `load`, `api`, `web`
- WHAT IT DOES: `load` runs the loader module, `api` serves FastAPI on port
  8000 with reload enabled, `web` installs node packages and starts the Vite
  dev server.
- NOTE: these three point at files that do not exist yet
  (`ingestion/lbnl_loader.py` arrives in 1.5, `api/main.py` and `web/` much
  later). The targets exist because this checkpoint specified them; they fail
  until their code lands.

`.gitignore`
- WHY IT EXISTS: `data/raw/` holds the downloaded LBNL CSVs, which are large
  and are third-party data we should not be redistributing through this repo.
- WHAT IT DOES: Ignores Python build and cache artefacts, `.venv`,
  node_modules and Vite output, all `.env` files, `data/raw/`, `SCRATCH.md`,
  and `CLAUDE.md`. It re-includes `.env.example` with a negation pattern so the
  credentials template is still tracked.
- CHOICES: Ignores `data/raw/` specifically, not all of `data/` — anything
  derived and small enough to commit can live elsewhere under `data/`.

Skipped as boilerplate: 15 `.gitkeep` files, the ruff line-length/target-version
block, and the `.PHONY` declaration.

START HERE: `PROJECT_CONTEXT.md` — it is the specification the other four files
implement; the directory layout and the layer order in it drive every later
checkpoint.

---

## Checkpoint 1.2 — Database container

### WHAT WE DID

The project now has its own database, running in a container, isolated from
anything else on the machine. Before this there was nowhere to put the sensor
readings. It is not a plain database — it is TimescaleDB, a PostgreSQL
extension built for time-series data, which is what lets a later checkpoint
store years of readings at a few-minute interval and still query a single day
quickly. The readings survive stopping and restarting the container because
they live in a storage area managed separately from it. Passwords are read from
a local file that is never committed, with a committed template beside it
showing what that file must contain, so someone cloning this repo can bring the
database up without being handed credentials.

### HOW IT WORKS

`docker-compose.yml` :: the `db` service
- WHY IT EXISTS: Every layer from ingest onward reads and writes here. It is
  the only stateful component in the project.
- WHAT IT DOES: Declares one container from `timescale/timescaledb:latest-pg16`.
  On first start the image creates the superuser role, its password, and an
  empty database from three environment variables, then loads the TimescaleDB
  extension into the server and enables it in that database — which is why
  `SELECT extversion` returns 2.28.3 without anyone running `CREATE EXTENSION`.
  `restart: unless-stopped` brings it back after a reboot or a Docker daemon
  restart, but respects a deliberate `make db-down`.
- CHOICES: `latest-pg16` rather than a fully pinned tag, because the checkpoint
  named that tag. It resolved to PostgreSQL 16.14 with TimescaleDB 2.28.3; it
  is a moving target and will drift. Worth pinning to a digest before handover,
  so a reviewer gets the same server we tested against.
- ⚠ JUDGEMENT CALL: No `healthcheck:` block. Compose healthchecks would
  duplicate the readiness poll the Makefile already does, and a healthcheck
  alone would not make `make db-up` wait — only `depends_on: condition:
  service_healthy` in a second service would, and there is no second service.
  Rejected adding one now; it becomes worth having if the API ever joins this
  compose file.

`docker-compose.yml` :: the `timescale_data` named volume
- WHY IT EXISTS: A container's own filesystem is discarded when the container
  is removed. Without this, every `docker compose down` would silently destroy
  every loaded measurement, and the loader would have to be re-run constantly.
- WHAT IT DOES: Declares a Docker-managed volume mounted at the database's data
  directory. Docker named it `aqueduct-pdm_timescale_data`, prefixed from the
  `name:` at the top of the file. It outlives the container and is only
  destroyed by an explicit `docker compose down -v` or `docker volume rm`.
- CHOICES: A named volume rather than a bind mount to a host directory. A bind
  mount would put the database files inside the repo, where they would need
  gitignoring and would carry host filesystem permission problems; a named
  volume stays out of the working tree entirely.

`docker-compose.yml` :: environment and port substitution
- WHY IT EXISTS: Keeps credentials out of a committed file while still letting
  the compose file be committed.
- WHAT IT DOES: The four `${...}` references are filled by Compose from `.env`
  in this directory at the moment the command runs. `POSTGRES_USER`,
  `POSTGRES_PASSWORD` and `POSTGRES_DB` have no defaults — if `.env` is
  missing, Compose warns they are blank and the container fails to initialise
  rather than quietly coming up with an empty password. `POSTGRES_PORT` is
  written `${POSTGRES_PORT:-5432}`, meaning "use the value from `.env`, or 5432
  if unset".
- CHOICES: Only the host side of the port mapping is variable — the container
  side is the literal `5432`. So changing the port changes nothing about the
  server's own configuration, and a developer with a free 5432 needs no change
  at all. On this machine a systemd PostgreSQL already owns 5432, so the local
  `.env` publishes on 5434; the mapping reads `0.0.0.0:5434->5432/tcp`.

`.env.example`
- WHY IT EXISTS: `.env` is gitignored, so without a committed template a fresh
  clone has no way to know which variables the compose file demands. The
  container would come up broken with no useful error.
- WHAT IT DOES: Lists the variables with working local-development values and a
  comment above each group explaining what it controls, including an explicit
  note that `POSTGRES_PORT` is the one to change if 5432 is occupied. The first
  line gives the copy command.
- CHOICES: Ships the real default port 5432 rather than this machine's 5434, so
  the template stays correct for anyone else. The 5434 override lives only in
  the untracked local `.env`. States inline that these are not secrets — a
  container bound to localhost with a dev password — so nobody treats rotating
  them as a security task.
- ⚠ JUDGEMENT CALL: `DATABASE_URL` is in the template although nothing reads it
  until the loader. The alternative was to add it later, rejected because it
  would mean deriving the same connection details in two places and letting
  them drift. It duplicates the four values above it — that duplication is the
  cost.

`Makefile` :: `db-up` ready message
- CHANGED FROM BEFORE: It printed the literal string `timescaledb ready on port
  5432`. With the host port now 5434 that was simply false. It now runs
  `docker compose port db 5432`, which asks Docker what the container's 5432 is
  actually published as, and prints that — `timescaledb ready on 0.0.0.0:5434`.
  The readiness poll itself is unchanged.

START HERE: `docker-compose.yml` — twenty lines, and it defines the only
stateful thing in the project; `.env.example` exists only to feed it.

---

## Checkpoint 1.3 — Schema

### WHAT WE DID

The database now has a shape. There are two walled-off areas: one holding what
a real building system would show you — the equipment, its sensors, and every
reading — and one holding the answer key that came with the downloaded data,
saying which fault was deliberately injected and when. The account that all the
fault-detection work will run under can read and write the first area and is
refused outright at the second, which the database enforces rather than a
convention anyone could forget. The readings table is set up to split itself
into one-day slices automatically, so a query for a single day never scans a
year. There is also an automatic hourly summary that keeps a running mean, low,
high, spread and count for each sensor, refreshing itself every hour, because
the later trend-fitting work runs on hourly figures and would be needlessly
slow on raw samples.

### HOW IT WORKS

`scripts/schema.sql` :: `\set app_rw_password` and file preamble
- WHY IT EXISTS: The file creates a login role, which needs a password. Writing
  that password into a committed file would be the one genuinely bad credential
  practice in this project.
- WHAT IT DOES: Runs a shell command from inside psql to read
  `APP_RW_PASSWORD` from the environment, falling back to `app_rw_local_dev` if
  unset. That value is interpolated into the `ALTER ROLE` at the bottom.
- CHOICES: There is no `BEGIN`/`COMMIT` around the file. TimescaleDB refuses to
  create a continuous aggregate or add a policy inside an explicit transaction
  block, so wrapping it would fail. The cost is that a mid-file error leaves the
  schema half-applied — mitigated by everything being `IF NOT EXISTS`, so
  re-running finishes the job.
- ⚠ JUDGEMENT CALL: psql's backtick shell substitution makes this file
  psql-only — it cannot be fed through SQLAlchemy or any generic driver.
  Alternative was `-v app_rw_password=...` on the command line, which keeps it
  driver-neutral but pushes responsibility onto every caller. Chose the
  self-contained version so the loader can apply this file without
  reimplementing the credential plumbing.

`scripts/schema.sql` :: `COMMENT ON SCHEMA groundtruth`
- WHY IT EXISTS: The required design note, and the sentence the whole
  separation rests on.
- WHAT IT DOES: Stores a paragraph in the database catalogue, visible from
  `\dn+`, stating that detection code cannot read this schema by design, and
  giving the reason: the project's central claim is that its accuracy numbers
  are computed against labels it did not create, and if the detection path
  could read the answer key that claim would be unverifiable by inspection — a
  rule threshold could be tuned against the labels, accidentally or not, and
  the code would still look correct. Enforcing it as a database privilege means
  leakage fails loudly with "permission denied" instead of passing review. Also
  records that validation runs afterwards under a different role that can see
  both and join them.
- CHOICES: Put in the catalogue rather than only in a `--` comment, so it
  travels with the database and shows up for anyone inspecting a live instance
  who never opens this file.

`scripts/schema.sql` :: `app.assets`
- WHY IT EXISTS: The root of the equipment model. Points hang off assets,
  measurements hang off points, and every advisory names an asset.
- WHAT IT DOES: One row per piece of equipment, keyed by a text id. Carries the
  Brick class (Brick being the standard vocabulary for describing building
  equipment as a graph) so this row and the semantic graph agree on what the
  thing is, plus a criticality tier, a replacement cost and an install date.
- CHOICES: `criticality_tier` is `SMALLINT` constrained to 1-3, where 1 is most
  critical — it exists so two assets degrading at the same rate can be ranked
  differently in advisories. `replacement_cost_usd` is nullable and
  `NUMERIC(12,2)` not float, because it is money and a business input rather
  than a measurement.
- ⚠ JUDGEMENT CALL: `asset_id` is `TEXT`, not a generated integer or UUID.
  Readable ids like `chiller-1` make the manifests, the SPARQL work and every
  debugging session legible. The cost is that ids are hand-assigned and a typo
  in a manifest becomes a foreign key error rather than being impossible.

`scripts/schema.sql` :: `app.points`
- WHY IT EXISTS: A stream of numbers is meaningless without knowing what it
  measures, in what unit, and what values are physically possible. Quality
  scoring, the rule engine and the baseline fitter all read this table.
- WHAT IT DOES: One row per sensor or setpoint, keyed by text id, with a
  foreign key to its asset that cascades on delete. Records the unit as it
  appeared in the source file and the unit everything was converted to, the
  physically plausible range, the fastest believable rate of change, and the
  expected seconds between readings. A table constraint rejects a row where the
  minimum is not below the maximum.
- CHOICES: `max_roc_per_min` is the maximum believable change per minute —
  thermal mass means a real air temperature cannot jump twenty degrees between
  samples, so if it does the sensor glitched rather than the building. Nullable
  because for some points no sane bound exists. `sample_interval_s` is what
  makes a gap detectable at all: a missing hour is only visible if the expected
  cadence is known. Keeping both `unit_native` and `unit_si` means a stored
  value can always be traced back to the raw file, while physics rules
  downstream never have to ask what unit they are looking at.

`scripts/schema.sql` :: `app.measurements`
- WHY IT EXISTS: Every layer above ingest reads this. It is the largest table
  in the project by orders of magnitude.
- WHAT IT DOES: Holds a timestamp, the point it belongs to, the value already
  converted to SI, and two columns the quality layer fills in later — a 0-100
  trust score and a JSON record of which specific checks the reading failed.
- CHOICES: `value_si` is nullable so a known gap can be recorded explicitly
  rather than inferred from a missing row. `quality_score` is nullable and
  constrained 0-100, where NULL means "not yet scored" — deliberately distinct
  from scored-as-zero, so the quality layer can tell unprocessed data from data
  it rejected. `quality_flags` is JSONB so a low score can be explained rather
  than just asserted, and so new check types do not need a migration. No
  primary key: a hypertable's primary key must include the partitioning column,
  and the natural candidate is discussed under the index below.

`scripts/schema.sql` :: `create_hypertable(...)`
- WHY IT EXISTS: Turns the plain table into TimescaleDB's partitioned form.
  Without it, a query for one day of one sensor scans everything ever loaded.
- WHAT IT DOES: Registers `time` as the partitioning dimension with a one-day
  chunk width, so TimescaleDB stores each day in a separate physical table and
  skips the ones a query's time filter cannot match. `if_not_exists => TRUE`
  makes re-application a no-op.
- CHOICES: Written with the modern `by_range('time', INTERVAL '1 day')`
  dimension builder rather than the legacy positional form, which is deprecated
  in TimescaleDB 2.13 and later.

`scripts/schema.sql` :: `measurements_point_time_idx`
- WHY IT EXISTS: Almost every query in this project is "give me this one sensor
  over this time range, newest first". Without this index each of those scans
  every point in every matching chunk.
- WHAT IT DOES: A B-tree on `(point_id, time DESC)`.
- ⚠ JUDGEMENT CALL: Deliberately **not unique**, though a unique index would
  have given the loader's idempotency requirement a free `ON CONFLICT DO
  NOTHING`. The LBNL datasets ship each fault severity as a separate simulation
  run covering the same simulated dates, so if two severity runs map onto the
  same `point_id` their timestamps collide and a unique constraint would reject
  legitimate data. Left non-unique, which is the choice that cannot lose data.
  Checkpoint 1.4's reconnaissance confirmed the collision is real.

`scripts/schema.sql` :: `app.measurements_hourly`
- WHY IT EXISTS: Baselines and health trends are fitted on hourly data. At a
  one-minute cadence a year of a single sensor is over half a million rows, and
  fitting on that is slow without being more accurate.
- WHAT IT DOES: A continuous aggregate — a materialised rollup TimescaleDB
  keeps current incrementally rather than rebuilding. Groups readings into
  one-hour buckets per point and stores mean, minimum, maximum, sample standard
  deviation and count.
- CHOICES: Keeps min and max next to the mean because a spike that averages
  away still matters, and standard deviation because a widening spread is
  itself an early degradation signal, before the average moves at all.
  `stddev_samp` rather than `stddev_pop`, since an hour of readings is a sample
  of the behaviour, not the whole population. `count(value_si)` counts non-null
  values, so it doubles as a completeness measure for that hour.
- ⚠ JUDGEMENT CALL: `materialized_only = false` turns on real-time aggregation
  — queries transparently union the materialised buckets with a live scan of
  not-yet-refreshed recent data. The TimescaleDB default `true` is faster but
  returns nothing for data loaded since the last refresh. Chose `false` so the
  hourly view returns rows immediately after loading rather than being empty
  until a policy run.

`scripts/schema.sql` :: `add_continuous_aggregate_policy(...)`
- WHY IT EXISTS: Keeps the hourly rollup current without a manual refresh.
- WHAT IT DOES: Registers a background job that runs hourly and materialises
  buckets from the beginning of time up to one hour ago.
- CHOICES: `start_offset => NULL` is the important value and is deliberately
  unusual. The normal setting is a finite window like three days, which only
  refreshes recent data. That would be wrong here: the LBNL data is historical
  simulation output, bulk-loaded at once, with timestamps far in the past. A
  finite start offset would silently never materialise any of it. NULL means
  "refresh from the earliest data onward". The cost is that each run considers
  the whole range, acceptable at this volume and needing revisiting on a live
  building feed. `end_offset` of one hour leaves the current, still-filling
  bucket alone so it is not materialised half-complete.

`scripts/schema.sql` :: `groundtruth.scenarios`
- WHY IT EXISTS: Each source CSV is an independent simulation run. Mixing them
  without recording which is which would make validation meaningless.
- WHAT IT DOES: One row per source CSV, keyed by text id, recording which of
  the two systems it belongs to, the file it came from, whether it is the
  fault-free run, and its time span.
- CHOICES: `is_fault_free` is a required boolean because those runs are the
  false-positive test — any detection firing on a fault-free run is wrong by
  definition, and that check needs to be a trivial query.

`scripts/schema.sql` :: `groundtruth.fault_events`
- WHY IT EXISTS: What detections are scored against. A detection counts as
  correct only if it names this fault mode on this asset after the onset time.
- WHAT IT DOES: One row per injected fault: which asset, which fault mode, at
  what severity, when it started, optionally when the equipment would count as
  failed, and a JSON bag of fault-specific parameters.
- CHOICES: `severity_level` is `TEXT`, not a number, because LBNL's severity
  naming is mixed — degrees Celsius of bias, percent open, percent fouling —
  and is not a single ordinal scale. `params` is JSONB because parameters
  differ per fault mode and do not fit fixed columns. `t_failure` is nullable
  since most of these runs do not run to failure. `asset_id` is deliberately
  **not** a foreign key to `app.assets`: a foreign key would make this schema
  depend on the app schema, and the point of the separation is that
  `groundtruth` can be dropped entirely without the detection path noticing.
- ⚠ JUDGEMENT CALL: Added a `scenario_id` foreign key not in the specified
  column list. Without it `groundtruth.scenarios` is an orphan table with
  nothing pointing at it, and there is no way to ask "on this specific run, did
  we fire?" — only "somewhere in the whole corpus".

`scripts/schema.sql` :: `app_rw` role creation
- WHY IT EXISTS: The identity the entire detection path connects as, and the
  thing the groundtruth wall is built around.
- WHAT IT DOES: A `DO` block checks the system catalogue for the role and
  creates it only if absent, since PostgreSQL has no `CREATE ROLE IF NOT
  EXISTS`. A following `ALTER ROLE` always sets the password from the psql
  variable, so re-applying both creates and rotates.

`scripts/schema.sql` :: grants on schema `app`
- WHAT IT DOES: Grants `USAGE` on the schema and full `SELECT, INSERT, UPDATE,
  DELETE` on its tables plus sequence access, then sets default privileges so
  tables created in `app` later are covered automatically.
- CHOICES: The default-privileges lines exist so a future migration cannot
  accidentally add a table the detection path cannot read, which would surface
  as a confusing runtime failure long after the migration.

`scripts/schema.sql` :: revokes on schema `groundtruth`
- WHY IT EXISTS: The enforcement half of the design note above.
- WHAT IT DOES: Six `REVOKE ALL` statements stripping schema, table and
  sequence privileges from both `PUBLIC` and `app_rw`.
- CHOICES: Strictly belt-and-braces — a newly created schema grants nothing to
  `PUBLIC` anyway, so `app_rw` was already locked out. They are in the file so
  the intent is legible rather than an accident of PostgreSQL defaults, and so
  that a later careless `GRANT ... TO PUBLIC` is undone on re-apply.

`.env.example` :: `APP_RW_PASSWORD`
- CHANGED FROM BEFORE: The template had four Postgres variables and a
  connection URL. It now also documents `APP_RW_PASSWORD`, which
  `scripts/schema.sql` reads when creating the restricted role. Added because
  the schema file references an environment variable that nothing previously
  told you to set.

Skipped as boilerplate: two secondary indexes (`points_asset_id_idx` and two on
`fault_events`) and roughly twenty `COMMENT ON COLUMN` statements.

START HERE: `scripts/schema.sql` — read the `COMMENT ON SCHEMA groundtruth`
block first, then the GRANTS section at the bottom that enforces it.

---

## Checkpoint 1.4 — Data reconnaissance (report gate, no commit)

A report gate produces findings rather than code, so this entry records what
the data turned out to be and which decisions it forced. Everything the loader
in 1.5 does traces back to something here.

### WHAT WE FOUND

**Files.** 2.2 GB downloaded from `fdddata.lbl.gov`, 15 GB extracted into
`data/raw/` (gitignored). 45 CSVs: 21 for the single-duct AHU and 24 for the
chiller plant, of which 2 are fault-free baselines. Plus two inventory PDFs and
two Brick `.ttl` files. The two archives nest differently — the AHU wraps its
CSVs in a subfolder, the chiller archive does not — so the loader cannot assume
a layout.

**Columns.** AHU fault-free CSV is 525,540 rows x 31 columns (`Datetime` plus
30 points). Chiller fault-free CSV is 525,540 rows x 78 columns (`Datetime`
plus 77 points). Every point column is `float64`, zero NaN, no non-numeric
columns anywhere. Chiller column order does not match its PDF's table order, so
the manifest must key by column name and never by position.

**Severity is expressed in the filename only.** All 45 headers are byte-identical
to their system's fault-free header — there is no fault column, severity column
or label column in any file. Three mutually incompatible naming conventions are
in use: signed degrees Celsius for sensor bias, percent open for stuck valves
and dampers, and percent *heat-transfer capability retained* for fouling.

**The fouling numbers run backwards from the obvious reading.** `065` is the
worst case and `095` the mildest, because the number is the fraction of heat
transfer retained, not the fraction fouled. Measured cooling-tower range (water
in minus water out) against the fault-free run confirms it: January means of
4.539 fault-free, 4.320 at `095`, 3.658 at `080`, 2.989 at `065`. Anything that
sorts severity numerically ranks these exactly backwards. This is why
`groundtruth.fault_events.severity_level` is TEXT and why severity order is
stated explicitly in the manifests rather than derived.

**Timestamps.** Format `2018-01-01 01:00:00` — space separated, naive, no zone.
Exactly one minute apart, with all 525,539 diffs equal and no duplicates or
gaps. Range `2018-01-01 01:00` to `2018-12-31 23:59` for 44 of 45 files; LBNL
strips the first hour of every file to discard simulation start-up transients.
The exception is `damper_stuck_100_annual_short.csv`, 308,101 rows covering
Apr 1 to Nov 1 only. Weather is Chicago TMY for both systems.

**All 45 runs occupy the identical timestamp range.** This settled the open
question from 1.3: a unique index on `(point_id, time)` would have rejected 44
of the 45 files. Leaving it non-unique was correct.

**Brick TTL files are present and complete.** Both parse with rdflib. Every CSV
column has a matching TTL node in both systems — 30/30 and 77/77. The AHU file
has 26 distinct Brick classes across 41 nodes; the chiller file has 30 classes
across 95 nodes. Three problems: two class names are invalid through wrong
capitalisation (`brick:Speed_status`, and `brick:Water_temperature_Sensor` on
`CT_SW_TEMP_1` where its two identical siblings use the correct spelling, so a
SPARQL query for tower supply temperature silently misses tower 1); both files
declare the same `bldg-59#` namespace and both define `bldg:OA_TEMP`, so
merging the graphs would collapse two different sensors into one node; and
there is **no edge linking the AHU cooling coil to the chiller plant**, which is
the relationship the entire cross-asset diagnosis story depends on.

### DATA DEFECTS THAT CHANGED THE DESIGN

- **The chiller's two outdoor temperature columns are swapped.** Wet bulb
  exceeded dry bulb in 521,925 of 525,540 rows, which is physically impossible.
  The column named `OA_TEMP_WB` matches the AHU's dry bulb to within 0.33 degF
  while the column named `OA_TEMP` differs by up to 26.9 degF. So `OA_TEMP`
  holds wet bulb and `OA_TEMP_WB` holds dry bulb. This matters directly:
  cooling-tower approach temperature (how close the tower gets the water to the
  wet-bulb floor) is the primary tower-fouling indicator.
- **`SA_SP` is in Pascals, not inches H2O as the PDF states.** Mean 402.8
  against a setpoint of 1.607 inH2O, a ratio of 250.6 where 1 inH2O = 249.089
  Pa. A rule comparing pressure to its own setpoint would be wrong by 250x.
- **Airflow magnitudes are about 13x the documented equipment.** The PDF's own
  figure gives design supply airflow as ~36,800 CFM; measured median is 496,328
  with a max of 1,266,232. Unresolved — either the unit is not CFM or the
  simulated unit is not the one documented. Consequence: `expected_min` and
  `expected_max` should be derived empirically from the fault-free run, not
  from the PDF.
- **`SF_SPD` is dead and `SF_CS` carries the real fan speed.** `SF_SPD` is
  pinned at 0.9 for the entire year while `SF_CS` varies across 158,208 distinct
  values, and `RF_SPD` equals `0.9 * SF_CS` in 426,292 of 525,540 rows with a
  correlation of 0.9998 — which is what the documented control sequence
  describes. Any fan-degradation rule must read `SF_CS`.
- **Two different kinds of impossible value.** Negative valve positions and fan
  power are solver round-off at 1e-13 and smaller (8 and 10 rows), harmless.
  Return airflow reaching -3,284 across 148,435 rows — 28% of the year — is a
  real wrong number. The first should be clamped, the second flagged.
- **Constant columns.** AHU `OA_CFM` holds a single value all year and is
  unusable; `SA_SPSPT` and `SA_TEMPSPT` are legitimately fixed setpoints
  matching the documented control sequence. Chiller `CHL_STA_1`, `CT_STA_1` and
  `CWL_SEC_PM_STA_1` are pinned on, because the lead units never cycle off.

### THE PDFs ARE WRONG IN TWO PLACES

- **Four AHU files are named differently than documented.** The PDF lists
  `sa_bias_{-4,-2,2,4}_annual.csv` as a supply-air-temperature sensor bias; the
  archive ships `coi_bias_{-4,-2,2,4}_annual.csv`. Counts match, but
  differencing each against the fault-free run does **not** confirm a supply air
  temperature bias: `coi_bias_2` shifts `SA_TEMP` by -1.007 degF where +3.6 was
  expected, the effect is not monotonic in severity, and both the +2 and -2
  cases move the system colder. `MA_TEMP` and `RA_TEMP` shift too, so whatever
  is biased sits inside a control loop that drags the whole unit. Leading
  hypothesis: it biases a coil-leaving-air temperature sensor that the
  controller uses but which is not among the 30 logged points. Unresolved.
- **Two chiller scenarios are undocumented.**
  `ChillerPlant_chiller_fouling_065.csv` and `_095.csv` exist on disk and are
  absent from the PDF's file inventory. They are arguably the most valuable
  files in the download, since chiller condenser fouling is the textbook
  gradual-degradation mode this project exists to track.

### THE TWO BLOCKERS, AND THE DECISIONS TAKEN

- **Volume.** Loading everything at native one-minute resolution is
  1,295,764,950 rows and roughly 103 GB, incompatible with the 60-minute
  ingestion timebox. **Decision: downsample to 5-minute intervals on ingest.**
- **No fault progresses over time.** Every faulted run holds its severity fixed
  from the first row to the last. Fitting a line through the monthly effect of
  the worst tower-fouling case gives a trend of +0.006 degF per month — flat;
  the month-to-month variation is weather, not degradation. The dataset
  therefore provides discrete severity levels, not degradation trajectories,
  while the health-index and remaining-life layers both assume a trajectory.
  **Decision: synthesise trajectories by stitching severity levels
  sequentially over simulated time.** Implemented in 1.5 and logged as a
  decision in `AI_LOG.md`.
- Also decided here: **ignore the four `coi_bias` files entirely** rather than
  guess a label for them, and **manually assert the missing chilled-water loop
  edge** in `model/extensions.ttl` when the semantic-graph layer is built.

START HERE: `PROJECT_CONTEXT.md` — unchanged by this checkpoint, but the data
source section is what these findings qualify.

---

## Checkpoint 1.5 — Loader

### WHAT WE DID

The database now holds twelve simulated years of sensor readings for eight
pieces of equipment — one air handler, three chillers, three cooling towers,
and the pipework and pumps that connect them. Before this the database was an
empty shape. Two things happened on the way in that the raw files could not
give us. First, the readings were thinned from one-per-minute to
one-per-five-minutes, which cut 1.3 billion readings down to 116 million
without losing anything the later maths needs, and is what made the whole load
finish in forty minutes instead of most of a day. Second, and more important,
the system now has equipment that gets worse over time. The downloaded files
could not do that — each one holds a single fixed fault level for a whole year,
so nothing in them ever deteriorates. The loader builds a deteriorating history
by taking the first stretch of a year from the healthy recording, the next
stretch from the mildest faulty recording, and so on down to the worst,
producing one continuous story per fault type of a machine sliding from fine to
badly degraded. Everything the remaining-life prediction does depends on that
story existing.

### HOW IT WORKS

`ingestion/manifests/sdahu.yaml` and `chiller.yaml` :: the `points` list
- WHY IT EXISTS: The only place that knows what a CSV column means. Nothing
  about either dataset is written into Python, so adding a sensor or fixing a
  wrong unit is a YAML edit.
- WHAT IT DOES: One entry per source column — 30 for the air handler, 77 for
  the chiller, verified to cover every column exactly once with no duplicates.
  Each entry names the column, the point id it becomes, the asset it belongs
  to, its Brick class, the unit the file actually contains, the unit we store,
  and how to aggregate it when downsampling. A `note` field carries the defect
  warnings from 1.4 so nobody trusts a bad point by accident.
- CHOICES: The two data defects are fixed here, not in code. The chiller's
  swapped outdoor temperature columns are cross-mapped — source column
  `OA_TEMP_WB` becomes the point `oa_temp` with the dry-bulb Brick class, and
  `OA_TEMP` becomes `oa_temp_wb`. `SA_SP` is declared `pascal` against the
  PDF's claim of inches H2O, while its setpoint is declared `inch_H2O`; both
  convert to Pa so a rule can compare them. Expressing the fixes as data makes
  the correction visible to a reviewer reading the manifest rather than buried
  in a special case.

Manifest :: the `trajectories` list
- WHY IT EXISTS: The construction that turns discrete severity levels into a
  degradation curve. The highest-consequence thing in the checkpoint, and
  entirely declarative.
- WHAT IT DOES: Each entry names a fault mode and an ordered list of segments,
  each segment naming a source file and a human-readable severity. The order is
  mild-to-severe and is stated explicitly rather than derived, which matters
  because the fouling files are numbered backwards. Every trajectory starts
  with a fault-free segment so there is a healthy baseline before the decline.
- CHOICES: Signed sensor-bias faults get two trajectories, one drifting high
  and one drifting low, rather than one ordered by absolute bias. A sensor
  drifts in one direction, not alternately; and it uses all four severity files
  instead of discarding two. This is why there are 18 trajectories rather than
  the 16 projected, and why the row count came out at 116M rather than ~100M.
- ⚠ JUDGEMENT CALL: A comment warns that new trajectories must be appended,
  never inserted. A trajectory's position in the list determines which span of
  simulated time it occupies, so inserting one silently relocates every
  trajectory after it and orphans their already-loaded rows. That coupling
  between list order and stored data is the weakest part of the design; an
  explicit `starts:` date per trajectory would remove it. Left implicit because
  deterministic packing means nobody has to pick dates by hand.
- ⚠ JUDGEMENT CALL: `damper_stuck_100_annual_short.csv` is excluded. It covers
  only Apr 1 to Nov 1, so it cannot fill the last segment of an annual
  trajectory without leaving a two-month hole. That trajectory therefore steps
  10% -> 25% -> 75% and never reaches fully-stuck. Alternative was to give that
  one trajectory a shorter, non-annual span.

`ingestion/lbnl_loader.py` :: `resolve_dsn` and `libpq_dsn`
- WHY IT EXISTS: The loader is the first code to connect to the database, and
  it must connect as the restricted role so the groundtruth wall is exercised
  rather than assumed.
- WHAT IT DOES: Reads `.env`, takes `APP_RW_DATABASE_URL`, and strips the
  `+psycopg` driver tag that SQLAlchemy needs but the raw PostgreSQL client
  library rejects — so one environment variable serves both the API layer later
  and this loader now. Exits with a readable message if the variable is missing.

`ingestion/lbnl_loader.py` :: `affine_conversion`
- WHY IT EXISTS: Converting units naively means calling the unit library once
  per value, which for 116 million values would dominate the entire run.
- WHAT IT DOES: Every conversion this project needs is affine — Fahrenheit to
  Celsius has both a multiplier and an offset, the rest are pure multipliers. It
  asks pint what 0 and 100 of the source unit become in the target unit, then
  recovers the multiplier as the difference over 100 and the offset as the
  converted zero. After that a whole year of one sensor converts with a single
  numpy multiply and add. pint is called twice per point instead of 116 million
  times.
- CHOICES: Two probe points 100 apart rather than 0 and 1, because subtracting
  two nearly equal numbers loses precision and 0-and-1 is exactly that case for
  temperature.

`ingestion/lbnl_loader.py` :: `upsert_assets` and `upsert_points`
- WHY IT EXISTS: Measurements cannot be written before the equipment and
  sensors they reference exist, because of the foreign keys.
- WHAT IT DOES: Inserts every asset and point from the manifest, and on a
  primary-key collision updates the existing row instead of failing. Editing a
  name or a Brick class in the manifest and re-running propagates the change.
- CHOICES: `sample_interval_s` is set to the resampled interval, 300, not the
  source 60, because that is the cadence of what is actually stored and gap
  detection later must compare against reality. `expected_min`, `expected_max`
  and `max_roc_per_min` are left NULL — 1.4 established the PDF's stated units
  are unreliable for airflow, so those bounds should be derived from the loaded
  data by the quality layer rather than guessed here.
- ⚠ JUDGEMENT CALL: The eight assets are modelled at the level where faults are
  actually injected — the air handler, three chillers, three cooling towers,
  and one plant-level asset holding the loop and pump points. Scope said two
  equipment classes; the chiller data has three of each machine plus eleven
  pumps. No fault in the dataset targets a pump, so their power and speed points
  hang off the plant asset rather than becoming eight separate assets.
- NOTE: `criticality_tier`, `replacement_cost_usd` and `install_date` are
  invented. They are business inputs appearing nowhere in the LBNL data, and
  the advisory layer will rank on them. Flagged so they are not mistaken for
  measured facts.

`ingestion/lbnl_loader.py` :: `segment_windows`
- WHY IT EXISTS: Decides where in the year the fault steps worse.
- WHAT IT DOES: Cuts a 365-day span into as many consecutive, non-overlapping
  windows as the trajectory has segments, using integer arithmetic so the
  remainder lands in the final window and the span is covered exactly with no
  gap or overlap.

`ingestion/lbnl_loader.py` :: `read_segment`
- WHY IT EXISTS: The source files are 140 MB to 430 MB each and a segment needs
  roughly a quarter of one. Reading whole files and discarding most of each
  would have added a large multiple to the run time.
- WHAT IT DOES: Reads just the first data row to learn where the file's
  timestamps begin, then computes the row offset of the window start by
  arithmetic — the grid is exactly one minute with no gaps, so the offset is
  elapsed minutes. It then tells the CSV reader to skip straight to that offset
  and read only that many rows. Measured on a chiller file, this reads 174,180
  rows in 2.1 s instead of parsing all 430 MB.
- CHOICES: It still filters the result by timestamp afterwards. The offset
  arithmetic assumes a gapless grid; the filter means a file violating that
  assumption produces short output rather than silently wrong output.

`ingestion/lbnl_loader.py` :: `resample_segment`
- WHY IT EXISTS: The 5-minute downsample, and the reason 1.3 billion readings
  became 116 million.
- WHAT IT DOES: Groups one-minute rows into 5-minute buckets, left-labelled and
  left-closed so bucket 01:00 covers 01:00 to 01:04 and the boundaries line up
  with the hourly rollup in the database. Analog points take the bucket mean.
- CHOICES: On/off statuses and the occupancy flag take the last value in the
  bucket, not the mean. Averaging a 0/1 status over five minutes yields values
  like 0.4, which is not a state the equipment is ever in and would break any
  rule testing whether a chiller is running. Verified after loading: status
  points still contain only 0.0 and 1.0.

`ingestion/lbnl_loader.py` :: `write_segment`
- WHY IT EXISTS: Where converted values enter the hypertable, and where source
  timestamps become real instants.
- WHAT IT DOES: Shifts the segment's timestamps into the year this trajectory
  occupies, stamps them with a fixed UTC offset, converts to UTC, then streams
  every point's converted values into the database over the bulk-copy protocol
  in a single binary stream per segment. If a point's values contain no gaps it
  skips the per-value null check entirely.
- CHOICES: Timestamps are stamped with a fixed -6 hour offset rather than the
  named zone `America/Chicago`. Simulation output has no daylight-saving step,
  so a named zone would make the spring-forward hour non-existent and the
  autumn hour ambiguous, and both raise errors. A fixed offset is both correct
  for this data and incapable of failing that way.
- CHOICES: Throughput measured at roughly 51,000 rows/s, which is the
  Python-level per-row loop, not the database. Batching rows into pre-formatted
  buffers would be several times faster. Left as-is because 39.6 minutes fits
  the timebox and this runs once.

`ingestion/lbnl_loader.py` :: `load_trajectory`
- WHY IT EXISTS: Assembles one degradation story and is the unit of
  idempotency.
- WHAT IT DOES: Works out which span of simulated time this trajectory owns,
  deletes anything already stored for its points in that span, then walks the
  segments in order — reading each source file's slice, downsampling it,
  converting units, and writing it — all inside one transaction, so an
  interrupted run leaves the trajectory either wholly old or wholly new and
  never half-written. It logs how many rows it wrote and how many it replaced,
  which is what made the idempotency check measurable: re-running one
  trajectory reported 3,153,240 written and 3,153,240 replaced, with the total
  row count and a value checksum both unchanged.
- CHOICES: Successive trajectories are offset by whole 365-day blocks rather
  than calendar years. Calendar-year offsets would land a leap day inside some
  trajectories and leave a one-day hole in the timestamp grid; fixed 365-day
  blocks keep the grid gapless at the cost of the seasons drifting by a day per
  leap year, two days across the widest case here.
- CHOICES: Each trajectory owning a distinct span of time is what makes the
  scheme work without a schema change. It is why 1.3's non-unique index on
  `(point_id, time)` was the right call and why nothing actually collides:
  point ids are shared across trajectories, and the time spans keep them apart.
  It also means `groundtruth.scenarios.t_start`/`t_end` can identify a scenario
  later with no extra column.

`Makefile` :: `db-up` readiness poll and schema apply
- CHANGED FROM BEFORE: It called `pg_isready` inside the container and then
  reported ready. That check tests the unix socket, which the TimescaleDB
  entrypoint's temporary init-phase server also answers — so on a fresh volume
  it returned success against a server about to shut down, and the first clean
  run failed with `server closed the connection unexpectedly`. It now loops up
  to 90 times attempting a real authenticated connection from the host over
  TCP, which is exactly what the next step needs, and fails with a clear
  message on timeout. It then applies `scripts/schema.sql`, which is what makes
  `make db-up && make load` work against a brand-new volume.

`docker-compose.yml` :: `shm_size`
- CHANGED FROM BEFORE: Not present. Docker defaults the container's shared
  memory filesystem to 64 MB, and PostgreSQL allocates parallel-query worker
  memory there. Any aggregate spanning the measurements hypertable failed with
  `could not resize shared memory segment ... No space left on device`. Now
  1 GB, with a comment recording the symptom.

`.env.example` :: `APP_RW_DATABASE_URL`
- CHANGED FROM BEFORE: Added. The loader needed a connection string for the
  restricted role, and nothing previously told anyone to set one. Documented as
  the URL every part of the detection path uses, with the reason: a SELECT
  against groundtruth from that code fails loudly.

### MEASURED RESULT

- 116,039,232 measurement rows in 39.6 minutes from a clean database.
  97,119,792 for the chiller plant across 77 points, 18,919,440 for the AHU
  across 30 points, 8 assets, 107 points, 18 trajectories.
- Both totals sit exactly 12 five-minute buckets per trajectory below the
  arithmetic projection, which is the first hour LBNL strips from every file.
- 18 GB in the hypertable across 4,381 one-day chunks, 19 GB for the whole
  database. That is 155 bytes per row against the 80 estimated in 1.4 — the
  text `point_id` repeated 116 million times plus the `(point_id, time DESC)`
  index. A smallint surrogate key for points would roughly halve it.
- Stitching verified to produce real degradation: cooling-tower approach
  temperature in the tower-fouling trajectory runs level with the fault-free
  trajectory through the healthy and 95%-retained segments, then rises to
  +0.29..+0.34 degC in the 80% segment and +0.44..+1.12 degC in the 65%
  segment.

START HERE: `ingestion/lbnl_loader.py` — read `load_trajectory` first; it is
the stitching, the idempotency and the time-partitioning scheme in one
function, and everything else is a helper it calls.

---

## Checkpoint 1.6 — Decision log

### WHAT WE DID

The project now carries a written record of the decisions that shaped it, kept
separate from the code that resulted from them. Before this, the reasoning
existed only in conversation and would have been unrecoverable by anyone reading
the repository — they would see the choice made but not the alternatives
rejected or why. Three decisions are recorded so far: what stores the sensor
readings, where labelled fault data comes from, and how a gradual decline was
obtained from source data that contains none. Each one states the question that
forced a decision, every option weighed with the reason it was rejected, which
parts were a human judgement versus delegated execution, and how confident that
judgement is. This matters because the project will be assessed partly on
whether its author can defend its architecture, and a decision nobody can
reconstruct is indistinguishable from one taken by accident.

### HOW IT WORKS

`AI_LOG.md` :: header
- WHY IT EXISTS: States up front what the document is for and that AI wrote most
  of the implementation. Declaring that plainly is what makes the rest of the
  log credible; a reader who suspects it is being hidden discounts everything
  else in the file.
- WHAT IT DOES: Four sentences saying the log records architectural decisions,
  the alternatives weighed, and the division of labour between human judgement
  and AI execution — and committing to record both overrides of the model and
  reversals of the author's own earlier positions.

`AI_LOG.md` :: the six-subsection entry shape
- WHY IT EXISTS: A fixed shape stops entries degenerating into a narrative of
  what was built. Each subsection forces something a reader needs and an author
  would otherwise skip.
- WHAT IT DOES: Every entry carries the same six headings. *Forcing question*
  states the problem before naming any solution. *Options* lists what was
  considered with an explicit chosen/rejected verdict on each. *Rationale* is the
  argument. *Mine vs delegated* splits the decision from its implementation.
  *Confidence* records how sure the author is, including caveats. *Outcome* is
  left blank on purpose — it gets filled in later once the decision has been
  lived with, so the log can record decisions that turned out badly.

`AI_LOG.md` :: D-01 — TimescaleDB over standard PostgreSQL
- WHY IT EXISTS: The sensor-reading table is the only thing in the project that
  gets large, and every layer reads it. What stores it is the decision the rest
  of the storage design hangs off.
- WHAT IT DOES: Rejects plain PostgreSQL, on the grounds that at this volume
  partitioning stops being optional and simply becomes work the author writes and
  maintains — partition creation, rollup refresh, index maintenance — none of
  which the project is judged on. Rejects a dedicated time-series store running
  alongside PostgreSQL, because assets, points, equipment classes and fault
  labels are all relational and get joined against the readings constantly, and
  because splitting engines would put the ground-truth privilege wall outside the
  database holding the readings. Chooses TimescaleDB, and records the measured
  result: 116,039,232 rows, 4,381 chunks, 18 GB, with the hourly rollup
  maintained by the database rather than by code.
- CHOICES: Confidence recorded as high but with a caveat rather than bare — the
  one-day chunk interval produced 4,381 chunks, which is workable but at the high
  end since query planning cost grows with chunk count. Seven-day chunks would
  give roughly 626.

`AI_LOG.md` :: D-02 — LBNL labelled data over a self-built simulator
- WHY IT EXISTS: The project has to report fault-detection accuracy and
  remaining-life error. Those figures mean nothing unless something independent
  says what the right answer was.
- WHAT IT DOES: Rejects building a physics simulator, and the stated reason is
  not the twelve hours it would cost but circularity — validating a detector
  against ground truth the author generated proves only that the detector agrees
  with the simulator, and both could be wrong in the same direction while every
  accuracy number still looked excellent. Chooses the LBNL datasets, so accuracy
  is computed against third-party labels. Records the second half of the
  decision: the labels live in their own database schema with all access revoked
  from the role every detection component connects as, which turns "I did not
  tune against the labels" from a promise into a property of the system.

`AI_LOG.md` :: D-03 — synthesising degradation by stitching severity levels
- WHY IT EXISTS: Reconnaissance found that no LBNL run degrades — each faulted
  file holds one fixed fault severity for a whole year. The health and
  remaining-life layers both need equipment that starts healthy and slides toward
  failure, so this is the decision that makes those layers possible at all.
- WHAT IT DOES: Rejects dropping remaining-life estimation, since calibrated
  remaining-life intervals are the centrepiece of the brief. Rejects generating
  the degradation curve from a fitted model, for exactly the circularity reason
  that decided D-02. Chooses to stitch real severity files together over
  simulated time, so every stored value remains a third-party measurement and the
  only authored contribution is the ordering, which is declared in the manifests.
- CHOICES: Includes a caveat section written to be found rather than discovered:
  the steps are discrete so the curve is a staircase not a slide; the onset time
  marks where a step was placed, not a physical event; and failure time has no
  meaning in the source data at all, so any failure threshold the remaining-life
  layer uses is authored and has to be justified physically.

START HERE: `AI_LOG.md` — D-02 is the entry the rest of the project's
credibility rests on; the other two are consequences of it.

---

## Checkpoint 2.1 — Loading and merging the Brick models

### WHAT WE DID

The system can now read the two equipment descriptions that LBNL ships alongside
its data — one for the air handler, one for the chiller plant — and hold them
together as a single description of the building. Before this those descriptions
were two inert text files that nothing in the project could interpret. This
matters because every question the platform will later ask about *why* something
is wrong is a question about relationships: which readings belong to which
machine, which machine feeds which other machine, and therefore which machine is
a plausible cause of a symptom seen somewhere else. Those relationships exist
only in these files.

Loading them also surfaced three defects in the published data. The two files
each describe their contents using the same internal shorthand, so combining
them carelessly would have merged the air handler's outdoor-temperature sensor
with the chiller plant's into a single reading — which matters especially because
Task 1 found the chiller plant's version of that column actually holds a
different quantity. Two pieces of equipment carry a misspelt equipment type,
which would have made them invisible to any later search by type. And the two
files share no connection whatsoever, which is the gap checkpoint 2.2 exists to
close.

### HOW IT WORKS

Ordered by data flow: file on disk, parsed, relocated, merged, repaired,
reported. Four trivial helpers skipped.

`model/loader.py` :: `SOURCES`
- WHY IT EXISTS: The one place recording which files make up the building model
  and what namespace each is given. Adding a third system is a row here rather
  than an edit to parsing logic.
- WHAT IT DOES: Two frozen records, each pairing a filename under
  `data/raw/ttl/` with the URI namespace its entities will live in — `sdahu#`
  for the air handler, `chiller#` for the chiller plant — plus a plain-English
  description used in error messages.
- CHOICES: The namespace root is `https://aqueduct-pdm.local/`, a hostname that
  deliberately does not resolve. RDF identifiers are names, not addresses, and
  nothing ever fetches them; a real domain would imply we publish these
  definitions.

`model/loader.py` :: `_parse_source(source)`
- WHY IT EXISTS: The gate the checkpoint asked for. If a Brick file is absent,
  empty, or not valid Turtle, this is where the project stops rather than
  continuing with a partial graph.
- WHAT IT DOES: Checks the file exists and is non-empty, hands it to rdflib's
  Turtle parser, then checks the result is not zero triples — a file can parse
  successfully and contain nothing. Any failure raises with a message naming the
  file, saying which system it describes, and stating that hand-authoring a
  substitute is not the fix.
- CHOICES: Each file is parsed against a different base URI. Both LBNL files
  declare their namespace as the bare relative fragment `bldg-59#` with no base,
  so a parser must resolve it against something; per-file bases mean the two can
  never accidentally resolve to the same namespace even before the explicit
  relocation step.

`model/loader.py` :: `_relocate_namespace(graph, source)`
- WHY IT EXISTS: Both files name their contents identically, so this is what
  stops the merge fusing unrelated equipment. Without it the merged graph is
  quietly wrong in a way nothing downstream would flag.
- WHAT IT DOES: Looks up the namespace the parser actually bound to the shorthand
  `bldg`, then walks every statement and rebuilds it with any identifier under
  that namespace re-pointed into this system's namespace. Statement structure is
  untouched; only names change. Equipment types such as `brick:Chiller` sit
  outside that namespace and pass through unaltered.
- CHOICES: Reads the bound namespace out of the parsed graph rather than
  hardcoding `bldg-59#`, so a re-published file using a different internal
  shorthand still relocates instead of silently relocating nothing.
- ⚠ JUDGEMENT CALL: Not specified. Each system was given its own namespace
  rather than merging into one. The rejected alternative — a single shared
  namespace — collapses `OA_TEMP` into one node belonging to both machines, 271
  triples instead of 272. Rejected because Task 1 found the chiller plant's
  `OA_TEMP` column carries wet-bulb temperature (what a wet thermometer reads,
  always at or below air temperature, and the quantity a cooling tower's
  performance is judged against) while the air handler's carries true air
  temperature. They are not the same sensor. The cost is that
  `building_extensions.ttl` has to declare two prefixes rather than one.

`model/loader.py` :: `load_merged_graph()`
- WHY IT EXISTS: The single entry point every layer above calls. Rules,
  baselines, diagnosis and the API all need the same graph and none of them
  should know it came from two files.
- WHAT IT DOES: Creates an empty graph, registers readable short prefixes on it,
  parses and relocates each source, copies every statement in, then runs the
  spelling repair. Returns the graph together with the list of repairs applied.
- CHOICES: Returns the repair list alongside the graph rather than logging it
  internally, so silent modification of third-party data is not possible — the
  caller holds the record.

`model/loader.py` :: `CLASS_SPELLING_REPAIRS` and `_repair_class_spellings(graph)`
- WHY IT EXISTS: Two entities in the published files carry a misspelt equipment
  type. Types are URIs, compared exactly, so a later query asking for all
  fan-speed readings would return a short answer with no indication it had.
- WHAT IT DOES: A two-entry map from wrong spelling to right spelling. The repair
  walks every type statement and where the type matches an entry, removes that
  statement and adds the corrected one. Both spellings of each pair already
  appear in the corpus for the same concept, which is how the correct one is
  known: the chiller plant writes fan speed as `Speed_Status` while the air
  handler writes `Speed_status`, and cooling towers 2 and 3 write
  `Water_Temperature_Sensor` while tower 1 writes `Water_temperature_Sensor`.
  Three entities were corrected — supply and return fan speed, and cooling tower
  1's supply water temperature.
- CHOICES: A fixed two-entry map, not case-insensitive matching. Case-folding
  would silently absorb any future miscasing, whereas an explicit map makes a new
  defect appear as a query returning nothing, which is investigable. The repair
  removes one statement and adds one, so the 272 triple count stays a real check
  on the load.
- ⚠ JUDGEMENT CALL: Not asked for, and it edits third-party data. The
  alternative was to leave the files faithful and match class names
  case-insensitively in every query. Rejected because that workaround would have
  to be repeated in every query written from here to the end of the project, and
  forgetting it once produces a silently short answer. Reverted by emptying the
  map.

`model/loader.py` :: `cross_system_triples(graph)`
- WHY IT EXISTS: Checkpoint 2.2's hard gate is that traversal from the air
  handler's cooling coil reaches the chiller. This measures whether any such path
  exists, so the gate is tested against a number rather than an assumption.
- WHAT IT DOES: Scans the merged graph for statements whose subject belongs to
  one system and object to the other. Reports zero. The merged graph is therefore
  two islands with nothing between them.

`model/loader.py` :: `_collision_count()`
- WHY IT EXISTS: Quantifies the namespace decision above so the judgement call is
  auditable rather than asserted.
- WHAT IT DOES: Loads both files a second time into one deliberately shared
  namespace and reports the resulting triple count and which local names appear
  in both systems. Nothing downstream uses this graph.
- CHOICES: Kept as a reporting function rather than deleted after the decision,
  because it will catch a future third system introducing a new collision.

`model/loader.py` :: `main()`
- WHY IT EXISTS: Produces the checkpoint's verification output, and doubles as
  the way to eyeball the graph after any change to the model.
- WHAT IT DOES: Loads everything, then prints per-file triple counts and
  namespaces, merged totals, repairs applied, the full class census with
  per-system instance counts, the cross-system connectivity count, and the
  collision diagnostic. On a source-file failure it prints `STOP:` with the
  reason and exits 1.

### MEASURED RESULT

- 272 triples merged: 81 from the air handler file, 191 from the chiller plant
  file, nothing lost and nothing deduplicated.
- 136 typed entities, 52 distinct `brick:` classes. Only two classes appear in
  both systems — `Electrical_Power_Sensor` and
  `Outside_Air_Temperature_Sensor`.
- 3 class-spelling repairs applied: `RF_SPD` and `SF_SPD` from `Speed_status` to
  `Speed_Status`, `CT_SW_TEMP_1` from `Water_temperature_Sensor` to
  `Water_Temperature_Sensor`.
- 0 statements link the two systems. Each file is a single-rooted tree —
  everything is reachable from `sdahu:AHU` or
  `chiller:Simulated_Chiller_Plant`, and nothing is referenced without being
  typed.
- The chiller plant file contains **no `feeds` statements at all**, only
  part-of and has-point. The air handler has five, all to zones. So the water
  flow path inside the plant does not exist either, and 2.2 has to author it as
  well as the loop edge.

START HERE: `model/loader.py` — read `load_merged_graph` first; the two
functions it calls are the whole of what makes two conflicting files into one
usable graph.

---

## Checkpoint 2.2 — Extension vocabulary, constraints, and the CHW loop edge

### WHAT WE DID

The two machines are now connected. Before this the air handler and the chiller
plant were two separate descriptions with nothing joining them, so a question
like "the coil cannot reach its target air temperature — is the chiller at
fault?" had no path to an answer; the trail stopped at the edge of the air
handler. There is now a chilled water loop between them, and behind it a
condenser water loop from the cooling towers to the chillers, so starting at the
cooling coil and walking backwards along the direction water flows reaches all
three chillers, all five chilled water pumps, all three cooling towers and their
pumps — seventeen assets, across two systems the published data never linked.

The graph also now records things Brick has no way to say. Each machine carries
how much it matters, what it costs to fix, what it costs to replace, and how many
people it serves, which is what lets the system later rank two simultaneous
problems instead of just listing them. And five physical conservation
relations are recorded — statements that must be true if the equipment and its
sensors are both honest, each naming the readings that take part and carrying an
arithmetic expression whose value is zero when the relation holds. Those
expressions are the raw material of fault detection: a persistently non-zero
value means either the physics is being violated or an instrument is lying, and
telling those two apart is the whole job.

Writing them required measuring what the relations actually do on healthy data,
and two of the three do not come out at zero. That is recorded next to each one
rather than hidden, because a detector that expects zero from them would report
faults continuously.

### HOW IT WORKS

Ordered by data flow: vocabulary, then the constraints built on it, then the
join, then per-asset values, then the loader changes that pull it together and
the gate that proves it worked.

`model/extensions.ttl` :: the `mvn:` vocabulary
- WHY IT EXISTS: Brick describes what equipment exists and how it is wired. It
  has no way to say what a machine is worth, how many people depend on it, or
  which physical law relates a group of its readings. Without those the system
  can detect that something is wrong but cannot say which wrong thing to fix
  first, and cannot check physics at all.
- WHAT IT DOES: Declares seven terms. Four are per-asset numbers: criticality
  tier, replacement cost, repair cost, occupants served. One is per-point: the
  design value, meaning what a reading is supposed to be when everything is
  right. The last two are the constraint machinery — a link from a constraint to
  each reading that participates in it, and the arithmetic expression itself.
  Each carries a comment explaining what breaks downstream without it.
- CHOICES: Criticality tier is documented as 1 = failure interrupts occupants
  immediately, 2 = degrades performance and is tolerable for days, 3 = nuisance.
  That matches the 1-to-3 range the database already constrains the column to, so
  the graph and the table cannot disagree.

`model/extensions.ttl` :: the residual expression variable convention
- WHY IT EXISTS: An expression is useless unless something can turn its variable
  names into actual columns of stored measurements. This is the rule that does
  that, and it is written down in the file rather than living in the evaluator.
- WHAT IT DOES: Variables are written `system.NAME`, for example
  `sdahu.MA_TEMP`. The system prefix is mandatory because both source systems
  define a reading called `OA_TEMP` and they are not the same instrument. The
  name after the dot is simultaneously the entity's name in the Brick model, the
  column name in the source CSV, and the `column` key in the ingestion manifests
  — so the manifests written back in checkpoint 1.5 already map every variable to
  a row of the points table. No new lookup table was needed.
- CHOICES: Operators restricted to the four arithmetic ones and parentheses. No
  functions and no conditionals, on the grounds that a relation needing either is
  a relation that belongs in code where it can be read and reviewed, not hidden
  in a string inside a data file.
- ⚠ JUDGEMENT CALL: You did not specify the variable form. The alternative was
  to write database point ids directly, like `ahu-1.ma_temp`, which removes the
  resolution step entirely. Rejected because those ids contain hyphens, so they
  cannot be parsed as names without a quoting convention, and because the graph
  should be able to state a physical relation without knowing how the data
  happens to be stored. A separate consequence, verified rather than assumed: all
  30 constraint participants across the five constraints resolve through the
  manifests to rows that exist in the points table.

`model/extensions.ttl` :: `mvn:MixedAirBalance`
- WHY IT EXISTS: The first and cleanest physics check on the air side. Air
  leaving the mixing box is outdoor air and return air blended together, so its
  temperature has to sit between the two at the point set by how much of each is
  present. Three separate faults disturb it, which is what makes it valuable and
  also why the graph is needed to tell them apart.
- WHAT IT DOES: Takes the outdoor air damper position as the blend fraction,
  computes what the mixed temperature should therefore be, and subtracts that
  from the measured mixed temperature. Result is in kelvin, zero when the mixing
  is consistent. Fires on a stuck outdoor air damper, on mixed air sensor drift,
  and on outdoor air sensor drift — and a damper fault also disturbs the coil
  downstream while a sensor fault does not, which is the discrimination the
  traversal queries exist to support.
- CHOICES: Damper position is used directly as a fraction, not divided by 100.
  Checked against the data first: both the damper and the valve are stored on a 0
  to 1 scale, not 0 to 100. Had that been assumed rather than checked, every
  residual would have been out by a factor of a hundred and the constraint would
  have looked catastrophically violated at all times.
- CHOICES: Measured on fault-free July data with the supply fan running, 4560
  samples: mean -0.369 K, standard deviation 0.377 K. The small negative bias is
  expected and is recorded in the file — damper position is a nonlinear stand-in
  for the actual outdoor air mass fraction, so a straight-line blend understates
  outdoor air at mid-travel.
- ⚠ JUDGEMENT CALL: The measured air flows were available and would give a
  physically exact blend fraction instead of the damper-position approximation.
  I used damper position because you named it as a participant. This turned out
  to be the safer choice for an unrelated reason found while checking the data:
  the air flow columns are not trustworthy (see the defect list below), so a
  flow-based expression would have been built on bad numbers.

`model/extensions.ttl` :: `mvn:CoilEnergyBalance`
- WHY IT EXISTS: The constraint that spans both systems, and therefore the
  reason the chilled water loop edge has to exist at all. Its water temperature
  input comes from the chiller plant, not the air handler.
- WHAT IT DOES: A coil cannot cool air below the temperature of the water
  entering it, and how close it gets to that limit should track how far the
  chilled water valve is open. So it compares the actual air temperature drop
  across the coil against the fraction of the maximum possible drop that the
  valve is commanding. Result in kelvin. Measured fault-free: mean +0.456 K,
  standard deviation 1.165 K over the same 4560 samples.
- CHOICES: Two limitations are written into the file rather than left to be
  discovered. First, coil water flow is not measured anywhere in the air handler
  dataset, so a true two-sided balance — heat leaving the air equals heat entering
  the water — cannot be written at all; the chilled water return temperature is
  therefore a declared participant that does not appear in the expression, and
  that mismatch is verified as the only one of its kind across all five
  constraints. Second, the two source datasets are independent simulations with
  unrelated load profiles, coupled only through sharing the same Chicago weather
  file, so the water in this expression is not physically the water that cooled
  this air. The residual is approximate as a number. The graph edge underneath it
  is not approximate, and that edge is what carries root cause across the systems.

`model/extensions.ttl` :: `mvn:ChillerEnergyBalance_1`, `_2`, `_3`
- WHY IT EXISTS: Conservation of energy across a chiller: everything the
  compressor puts in and everything the chilled water gives up has to leave
  through the condenser. It is the check that catches condenser fouling and
  refrigerant loss, which are two of the six scenarios the next checkpoint
  builds.
- WHAT IT DOES: Each instance computes heat rejected at the condenser, subtracts
  heat absorbed from the chilled water, then subtracts electrical power drawn.
  Both heat terms are a water flow multiplied by a temperature difference and by
  4.17 million, which is the heat capacity of a cubic metre of water per kelvin —
  997 kilograms per cubic metre times 4184 joules per kilogram per kelvin —
  because both flows are stored as cubic metres per second. Result in watts.
- CHOICES: The subtraction order for the condenser pair was determined from the
  data, not from the class names. At the chiller-level points the one named
  "supply condenser water" is the warmer of the pair, averaging 29.84 against
  27.44 degrees, which is the opposite sense to the plant-level pair describing
  the same loop. Assuming the names were right made the entire residual negative.
- ⚠ JUDGEMENT CALL: Three instances, one per chiller, where you named one
  constraint. The three machines are identical, each has its own sensors and
  stages independently, so a single instance bound to chiller 1 would leave
  chillers 2 and 3 with no energy balance at all. The alternative — one instance
  with a templated expression applied by class — would have meant inventing
  templating machinery in the graph that nothing else needs.
- CHOICES: Measured fault-free on chiller 1, July, running only, 5403 samples:
  mean -99.0 kW, standard deviation 66.3 kW. **The balance does not close.**
  Backing compressor work out of the two thermal terms implies about 112 kW where
  the power channel reports 355 kW — a coefficient of performance of 6.1 against
  the 1.9 the reported power implies, and 6.1 is the plausible figure for a
  water-cooled chiller. So the reported power and the thermal measurements
  disagree in the source simulation itself. The residual still moves with fouling
  and refrigerant loss so it is usable as a trend, but its absolute value is not
  a physical energy imbalance and must never be thresholded at zero. This is
  recorded on the constraint.

`model/building_extensions.ttl` :: the water-side flow path
- WHY IT EXISTS: The hard requirement of this checkpoint. Nothing in the
  published data connects the two systems, and — separately — the chiller plant
  file contains no flow direction whatsoever: 0 flow statements out of its 191.
  So the entire water topology is authored here. Without it, walking upstream
  from the cooling coil returns nothing and cross-asset diagnosis is impossible
  by construction.
- WHAT IT DOES: Creates two loop nodes and 22 statements. Three chillers and five
  chilled water pumps feed the chilled water loop; the chilled water loop feeds
  the air handler's cooling coil — that single statement is what makes the two
  systems one graph. Three cooling towers, three condenser pumps and the diverting
  valve feed the condenser water loop, and the condenser water loop feeds the
  three chillers. Both loops are also declared parts of the plant subsystems that
  already existed, so they hang off the existing structure rather than floating.
  The resulting chain is cooling tower to condenser loop to chiller to chilled
  water loop to cooling coil.
- CHOICES: A loop node rather than direct chiller-to-coil statements. Three
  chillers and five pumps all feed one coil, so a shared node makes that a
  six-into-one fan-in instead of fifteen separate edges, and the loop is genuinely
  the thing they share.
- ⚠ JUDGEMENT CALL: Each loop is modelled in one direction only, so the graph is
  acyclic. A real water loop is a closed circuit and modelling it as one would be
  more faithful — but it would make every asset upstream of every other asset,
  and root cause traversal would return the entire plant for any symptom. The
  direction chosen is the one along which faults propagate: towers affect
  chillers, chillers affect the coil.
- ⚠ JUDGEMENT CALL: The condenser water loop was not asked for. Only the chilled
  water edge was specified. I added it because the chiller plant file has no flow
  direction at all, so without it the plant has no internal topology, the
  condenser fouling scenario in the next checkpoint has no path from tower to
  chiller, and the traversal queries in 2.3 would return almost nothing for any
  plant asset. It is 11 of the 22 authored statements and removable on its own.
- CHOICES: The condenser loop node is typed as a generic water loop, not as a
  condenser water loop. Checked against the published Brick 1.3 ontology: there
  is no condenser water loop class — Brick defines loop, water loop, chilled water
  loop, hot water loop, domestic water loop and air loop, and the condenser case
  is simply absent. The generic class is the most specific one that actually
  exists.

`model/building_extensions.ttl` :: asset attributes
- WHY IT EXISTS: Gives the advisory and remaining-life layers what they need to
  answer the only question a building owner actually asks — is it cheaper to fix
  this now or run it to failure — and to rank two simultaneous problems.
- WHAT IT DOES: Sets criticality tier, replacement cost, repair cost and
  occupants served on the air handler, the three chillers and the three cooling
  towers, and tier plus occupants on the plant as a whole. Chillers and the air
  handler are tier 1; towers are tier 2 because a fouled tower costs energy and
  capacity but cooling continues, which is the boundary between the tiers.
- CHOICES: Capacities are measured, not assumed. Each chiller's peak evaporator
  load across the fault-free year is 476 kW, which is 135 tons of refrigeration
  (the unit chillers are sold in, being the rate that melts a ton of ice in a
  day). Plant peak is 903 kW, 257 tons. Costs are then derived at roughly $1,200
  per ton installed for a water-cooled chiller and $400 per ton for a tower.
- CHOICES: **Every cost figure is an estimate and is labelled as one in the
  file.** They are the right order of magnitude and no better. Each is a single
  edit and nothing computes them.
- CHOICES: The plant deliberately carries no replacement cost. A plant is not
  bought or replaced as a unit, its machines are, and a number there would let
  the remaining-life layer double-count it against the chillers and towers.
- CHOICES: All three chillers carry the full occupant count each, even though
  three machines against a 257-ton peak means losing one interrupts nobody.
  Whether redundancy should discount criticality depends on which machines were
  staged on at the time of the fault, which is a fact about an event and not about
  the machine, so it is left to the advisory layer rather than baked in here.
- CHOICES: Recorded on the plant node: 257 tons of installed plant would normally
  serve a building many times larger than a five-zone air handler. The two source
  datasets were simulated independently and were never sized against each other.

`model/building_extensions.ttl` :: point design values
- WHY IT EXISTS: Gives the baseline layer a fixed reference that does not come
  from observed data, so "normal" is not defined entirely by whatever the
  equipment happened to be doing — which matters because some of the loaded data
  is already faulted.
- WHAT IT DOES: Sets 14 design values, all read off the fault-free run so any of
  them can be checked with one query, all in the SI unit the measurement is
  stored in. Where the source setpoint is constant across the whole year, that
  constant is the design value exactly: supply air temperature 12.88 degrees,
  duct static pressure 400.4 pascals, secondary loop differential pressure. Where
  the setpoint follows a reset schedule, the design value is the demanding end of
  that schedule, because that is what the equipment was sized for.
- CHOICES: The demanding end is the cold end for chilled water — 6.67 degrees,
  the coldest water the plant is ever asked for — and the hot end for the cooling
  towers, 29.44 degrees, because a tower's hardest day is the hottest and most
  humid one when it can only just reach that temperature. Opposite directions for
  the same kind of quantity, so this is stated in the file rather than left to be
  inferred.
- CHOICES: Design cooling load is set to the annual peak of 903 kW because it is
  needed as the denominator of part-load ratio — how hard the plant is working as
  a fraction of what it can do — which the baseline layer needs since a chiller's
  efficiency depends on part-load ratio more than on anything else.
- CHOICES: Full-load compressor power is the observed annual peak standing in for
  a nameplate rating, and is flagged in the file as weaker than the
  setpoint-derived values: if the chiller never reached full load in the simulated
  year, it is an underestimate.

`model/building_extensions.ttl` :: recorded source defects
- WHY IT EXISTS: Two pairs of columns carry the opposite sense to the equipment
  class they are labelled with. Anyone writing a rule against them needs to know,
  and the place they will look is the model.
- WHAT IT DOES: Attaches a comment to each affected entity stating the inversion
  and the evidence for it. Neither is corrected, because correcting them means
  re-mapping the ingestion manifests and reloading the data, which is outside this
  checkpoint.

`model/loader.py` :: `load_merged_graph(with_extensions=True)`
- CHANGED FROM BEFORE: It merged the two published files and stopped. It now also
  loads both extension files afterwards and registers their prefixes, so one call
  returns the complete model. The new flag exists so the published data can still
  be loaded alone, which is what produces the zero that proves the two systems
  arrive disconnected.

`model/loader.py` :: `upstream_of(graph, start)` and `UPSTREAM_SPARQL`
- WHY IT EXISTS: Runs the checkpoint's gate, and is the shape of the traversal
  that cross-asset diagnosis will use.
- WHAT IT DOES: Runs a query that walks flow statements backwards from a starting
  entity, any number of hops, and returns everything it reaches with each one's
  class.
- CHOICES: Written as an inverse property path rather than by asking for the
  reverse relation directly. Brick does declare the reverse relation as the formal
  inverse of the forward one — confirmed by reading the published ontology, which
  states exactly that — but we do not load the ontology and the query engine does
  no logical inference, so asking for it by name returns nothing. Writing the
  inverse as a path is the same thing semantically and needs no reasoner.

`model/loader.py` :: `cross_system_triples(graph)`
- CHANGED FROM BEFORE: It looked at every statement whose two ends were in
  different systems. Now restricted to the three structural relations — feeds,
  part-of, has-point — because constraints link to readings in both systems by
  design, and 30 of those crossings would have buried the 22 that are actually the
  topology. It also now recognises the two namespaces added in this checkpoint.

`model/loader.py` :: `main()` gate and constraint report
- CHANGED FROM BEFORE: Two blocks added. The gate block runs the upstream
  traversal from the cooling coil, prints every asset reached with its class,
  counts how many chillers are among them, and prints PASS or FAIL. The constraint
  block lists each constraint with how many readings it binds and its expression,
  so the whole physics layer is visible from one command.

### MEASURED RESULT

- Merged graph 438 triples, up from 272. 151 typed entities. 22 authored
  topology statements, 2 new equipment nodes, 5 constraints binding 30 readings,
  8 assets carrying attributes, 14 design values.
- **Gate PASS.** From the air handler's cooling coil, walking flow backwards
  reaches 17 assets, including all three chillers by class, and all three cooling
  towers four hops away.
- The published data alone yields 0 cross-system statements, and the chiller
  plant file contains 0 flow statements out of 191 triples.
- All 30 constraint participants resolve, through the ingestion manifests, to
  rows that exist in the points table. All 14 design values likewise. One
  declared participant is deliberately absent from its expression and it is the
  documented one.
- Fault-free residuals, July 2018: mixed air balance mean -0.369 K (sd 0.377);
  coil balance mean +0.456 K (sd 1.165); chiller 1 energy balance mean -99.0 kW
  (sd 66.3). The third does not close, for reasons in the source data.
- Classes validated against the published Brick 1.3 ontology. 52 of 54 used
  classes are real. This also confirms both spelling repairs made in 2.1 were
  correct: the miscased forms do not exist in Brick and the corrected forms do,
  and it confirms the reverse-flow relation is formally declared as the inverse
  of the forward one.

### CORRECTION APPLIED WITHIN 2.2 — point labelling fixed at the data layer

The first pass through this checkpoint recorded two labelling defects as comments
and compensated for them inside the residual expressions. That was rejected on
review, for a good reason: a compensation only works for as long as everyone
remembers it is there, and there was nothing to stop a rule written in Task 3
from reading the same points and getting the sign wrong. The defects are now
corrected at the data layer instead, in all three places that had to agree.

Investigating properly also changed the diagnosis. Only one of the two pairs was
actually swapped.

**The secondary loop pair genuinely was swapped.** The source column named
`CWL_SEC_SW_TEMP` — supply — averages 11.97 degC while `CWL_SEC_RW_TEMP` —
return — averages 7.14. A secondary loop delivers cold water to its loads, so its
supply cannot be the warmer of the pair. What settles it is the primary loop,
which is labelled correctly at 7.19 degC supply and 9.54 degC return: a secondary
loop is fed from the primary supply, so secondary supply has to be about 7.19,
which is exactly what the column named "return" holds. Fixed by crossing the
mapping in the manifest and exchanging the data already loaded, so both point ids
now hold what their names claim.

**The chiller condenser pair was not swapped.** Its point names already read
"entering" and "leaving" and already matched the data. The defect was narrower:
the word "supply" in the identifier `cdw_supply_temp` means the opposite thing one
level up, where the plant-level pair uses supply for the cool water the towers
send to the chillers. One word, two senses, inside one model — which is how the
original misreading happened. Rather than pick a winner, both identifiers moved to
Brick's own entering and leaving classes, which are defined explicitly and cannot
be read two ways.

`ingestion/manifests/chiller.yaml` :: the crossed pair and the renamed pair
- WHY IT EXISTS: The manifest is what a load reads, so a fresh database has to
  come out correct without anyone running a repair afterwards.
- WHAT IT DOES: The two secondary loop entries now take their data from each
  other's source column, with a comment block above them stating the evidence.
  The six chiller condenser entries have new point ids ending in
  `cdw_leaving_temp` and `cdw_entering_temp`. Eighteen points also got corrected
  classes.
- CHOICES: The crossing is done by swapping the `column` key rather than the
  `point_id`, so each point's id, name and class stay together as one block and
  the change is two lines rather than six.

`scripts/fix_point_labels.sql` :: the migration
- WHY IT EXISTS: The database already held 116 million rows and reloading to fix
  labels would have meant re-reading 15 GB of CSV for a change that alters no
  value. This corrects the existing database in place.
- WHAT IT DOES: Three steps. Step one exchanges the two secondary loop point ids
  across 2,522,592 rows. Step two creates the six new condenser point rows, moves
  7,567,776 rows onto them, then deletes the old rows. Step three corrects the
  classes that are not Brick classes. It ends by re-checking each correction and
  printing the totals.
- CHOICES: Every step is guarded so the script can be run twice safely. This
  matters most for the swap, because a swap applied twice is a swap undone — so
  rather than assume, it reads one summer day first and acts only while supply is
  still the warmer of the two.
- CHOICES: The condenser fix is a rename to new identifiers, not an exchange
  between existing ones, so there is never a moment when two points share a name
  and no temporary placeholder is needed.
- CHOICES: New point rows are inserted before any measurement is moved onto them,
  and old rows are deleted only after confirming nothing still references them,
  because the measurements table has a foreign key to the points table.

`model/loader.py` :: `NODE_CLASS_REPAIRS`
- WHY IT EXISTS: The graph had to be corrected alongside the manifest and the
  database, or a rule selecting points by class from the model would disagree with
  the data it then reads. The existing repair map could not express these, because
  it maps one class to another and here the right answer depends on the individual
  node.
- WHAT IT DOES: Maps a source system and entity name to the class that entity
  should carry. Twelve entries: the secondary loop pair, the six condenser
  readings, the two setpoints that shared one class across two different fluids,
  and the outdoor air pair. Applied after the class-wide repairs so a node listed
  in both gets the per-node answer.
- CHOICES: Raises rather than continuing if an entry names a node that is not in
  the graph. A repair that silently matches nothing is worse than no repair,
  because it reads as though the defect has been handled.
- CHOICES: Keyed by system and name rather than name alone, because both source
  systems have an entity called `OA_TEMP` and they are different instruments.

`model/extensions.ttl` :: residual expressions rewritten to point ids
- CHANGED FROM BEFORE: Variables were the Brick model's local names, which are
  the LBNL source column names — `chiller.CHL_SWCD_TEMP_1`. They are now database
  point ids in braces — `{chiller-1.cdw_leaving_temp}`. The reason is the whole
  point of this correction: four of those column names state the opposite of what
  the column contains, so an expression written in them looks as though its signs
  are reversed even when it is right, and the only way to check it was to hold the
  exceptions in your head. Written in corrected point ids, the condenser term
  reads "leaving minus entering" and the evaporator term reads "return minus
  supply" — warm minus cool in both cases, checkable by reading. The braces are
  needed because point ids contain hyphens and dots.
- CHOICES: `mvn:constrainedBy` still names Brick model nodes, because relating
  physical entities is what the graph is for. The two naming systems are kept in
  step by the manifests and checked mechanically.

**Measured after the correction:**
- 10,090,368 rows relabelled in 7 minutes. No CSV re-read, no value recomputed.
- Secondary loop: supply now 7.14 degC and return 11.97 degC on the probe day,
  the right way round. Chiller 1 condenser: leaving 29.84, entering 27.44.
- Totals unchanged at 107 points and 116,039,232 measurements. Zero stale
  identifiers left in either table.
- All three residuals are numerically identical to before the correction —
  -0.369 K, +0.456 K, -99.0 kW — which is the check that this changed labels and
  nothing else.
- 31 class repairs now applied to the graph, up from 3. Every class used in the
  graph, in the manifests and in the database exists in Brick 1.3, and all 107
  points agree on their class across the model, the manifest and the table.

START HERE: `model/building_extensions.ttl` — section 1 is the twenty-two
authored statements that turn two disconnected files into a graph you can trace
a fault across, and everything else in this checkpoint either supports them or
measures them.

---

## Checkpoint 2.3 — Traversal queries and the materialised edge table

### WHAT WE DID

The graph can now be asked questions, by name, from ordinary Python. Before this
the connections existed but every use of them meant writing a query by hand
inside whatever code needed it, which would have meant the same traversal
written five slightly different ways across five layers. There are now five named
questions the rest of the system asks: what readings does this machine have,
what could have caused a problem here, who suffers if this machine fails, which
readings does this physical law relate, and — the one cross-asset diagnosis is
built on — which machines upstream of here are already known to be broken.

Each answer also now carries a distance, meaning how many links away the other
machine is. That matters because a diagnosis that lists a cooling tower and a
chiller as equally likely causes of a coil problem is not much use; the chiller
is two links away and the tower is four, and the near cause should be preferred.

Finally, the connections are copied into an ordinary database table. The layers
above all need to combine topology with measurements, health scores and faults in
a single database query, and reaching back into the graph for every row would
make that unworkably slow. The table is rebuilt from the graph on every load, so
it can never drift from the model it came from.

### HOW IT WORKS

Ordered by data flow: query files, then the wrapper that runs them, then the
node-to-asset resolution, then the flattening, then the write.

`model/queries/points_of_asset.rq`
- WHY IT EXISTS: Anything that evaluates a rule or fits a baseline for a machine
  first has to know which readings that machine has. This is the only place that
  answers it.
- WHAT IT DOES: Walks from the named machine down through its parts to any depth,
  collects every reading attached anywhere along the way, and returns each one
  with its class, the part that holds it, and its design value if it has one.
- CHOICES: The part-walk is zero-or-more, not one-or-more, so the machine's own
  directly attached readings come back as well as its children's. For the air
  handler this is the difference between 11 readings and 25 — without it the
  coil's valve position, both fan speeds and powers, both damper positions and
  the five zone temperatures are all missing, and a rule about the air handler
  needs every one of them. It should not have to know that the published model
  hangs the valve off the coil rather than off the unit.

`model/queries/upstream_assets.rq` and `downstream_assets.rq`
- WHY IT EXISTS: These are the two halves of causal reasoning. Upstream asks what
  could have caused a symptom seen here; anything not in that answer is not a
  candidate, which is what stops a diagnosis blaming an unrelated machine that
  happens to be degrading at the same time. Downstream asks who is about to
  suffer, which is how a fault becomes a priority and how a repair gets scheduled
  honestly.
- WHAT IT DOES: Each follows flow statements to any number of hops, one in each
  direction, and returns what it reaches with each thing's class.
- CHOICES: Upstream is written as an inverse property path rather than by naming
  the reverse relation. Brick does formally declare the two as inverses — checked
  by reading the published ontology — but we do not load that ontology and the
  query engine performs no logical inference, so naming the reverse relation
  returns nothing at all. Written as a path it is the same statement and needs no
  reasoner.
- CHOICES: Neither returns a hop count, because property paths report only
  whether something is reachable, not how far. The distance is added by the
  wrapper.

`model/queries/constraint_members.rq`
- WHY IT EXISTS: Read one way it tells the rule engine what there is to evaluate,
  so the list of physical checks lives in the model rather than hardcoded in
  Python. Read the other way it is what makes a bad sensor separable from a bad
  machine: given a reading that looks wrong, which relations does it take part in,
  and therefore which other readings could be the real culprit.
- WHAT IT DOES: Returns each constraint with its label, its residual expression
  and one row per participating reading.
- CHOICES: The constraint parameter is optional. Bound, it returns one
  constraint; left unbound the same file returns all five, which is how the rule
  engine discovers them. One file, two uses, no duplication.

`model/queries/open_faults_upstream.rq`
- WHY IT EXISTS: The query cross-asset diagnosis is built on, and the reason the
  chilled water loop edge had to be authored in the first place. A coil failing to
  reach its target air temperature is a symptom; if a chiller upstream of it is
  already known to be faulted, the coil is probably a consequence, and writing it
  up as an air handler problem sends an engineer to the wrong machine.
- WHAT IT DOES: Walks upstream exactly as the upstream query does, then keeps only
  those assets carrying an open-fault mark, returning the fault identifier with
  each.
- CHOICES: Fault state is never written to any file. It changes by the minute and
  the model is loaded from static Turtle, so storing it there would guarantee it
  goes stale with nothing to invalidate it. The caller asserts the marks into a
  throwaway copy of the graph for the duration of one query.
- CHOICES: The file records what the fault list must not be. The labelled fault
  events in the ground-truth schema are unreadable from this code by design — the
  database role it connects as has every grant on that schema revoked, so a
  select against it fails outright. Faults reaching this query have to have been
  detected, not looked up. Verified: `permission denied for schema groundtruth`.

`model/graph.py` :: `load_query(name)`
- WHY IT EXISTS: One place that reads the query files, so no caller builds a path
  and no query text is duplicated in Python.
- WHAT IT DOES: Reads the named file from the queries directory and caches it.
  Raises if it is missing rather than returning empty text, which would otherwise
  surface much later as a query that mysteriously matches everything.
- CHOICES: Cached because the rule engine will call these inside loops over
  assets and timestamps, and re-reading a file per iteration is pointless work.

`model/graph.py` :: `_hops_from(graph, start, predicate, reverse)`
- WHY IT EXISTS: Supplies the distance the queries cannot. Without it every
  upstream result is a flat list, and root cause search has no way to prefer a
  near cause over a far one.
- WHAT IT DOES: Walks outward from the starting node one link at a time, in
  waves, recording each node the first time it is seen — which by construction is
  by its shortest path. Can walk either with the flow or against it.
- CHOICES: Breadth-first rather than following each path to its end, because
  that is what makes the first sighting of a node also the shortest one, with no
  second pass needed to find minimum distances.
- CHOICES: A node already recorded is never queued again, so a cycle terminates
  on its own. This matters because the current model deliberately breaks both
  water loops open to stay acyclic, and if a later change closes one, this stays
  correct rather than hanging.

`model/graph.py` :: `_traverse(...)`, `upstream_assets`, `downstream_assets`
- WHY IT EXISTS: Turns each reachability query into typed rows carrying a
  distance, so callers deal in assets and integers rather than query results.
- WHAT IT DOES: Runs the query file for membership, walks the same links for
  distance, joins the two, and returns rows sorted nearest first.
- CHOICES: The query result is treated as the authority on membership and the
  walk only supplies numbers. They are two independent implementations of the
  same traversal, so if they disagree one of them is wrong — and the function
  raises rather than returning a row with an invented distance. All three
  traversals checked in the report agree exactly.

`model/graph.py` :: `constraint_members` and `open_faults_upstream`
- WHAT IT DOES: The first groups the query's one-row-per-reading output into one
  record per constraint holding its readings as a tuple. The second copies the
  graph, adds a fault mark for each asset the caller names, runs the query
  against the copy, annotates distances, and lets the copy go.
- CHOICES: The fault marks go on a copy rather than the shared graph, so a
  diagnosis run cannot leave fault state behind for the next one to pick up. With
  an empty fault list the query returns nothing, which is the check that the
  marks and not the traversal are what select the rows.

`model/graph.py` :: `node_to_asset_id(graph)`
- WHY IT EXISTS: The graph and the database name the same equipment differently
  and nothing states the correspondence. The graph calls it `sdahu:AHU`, the
  database calls it `ahu-1`, and no rule derives one from the other. Without this
  the edge table cannot be written at all.
- WHAT IT DOES: Recovers the mapping through the readings. Each reading in the
  graph is named after a source CSV column; the ingestion manifests map that
  column to a database point; each point records which asset it belongs to. So a
  machine's asset is whichever asset its own readings belong to. Where a
  machine's readings do not all agree, the majority wins and the disagreement is
  reported.
- CHOICES: Derived rather than asserted by hand in the model. A hand-written
  mapping is another list to keep in step with the manifests, and it would be
  wrong silently. This one is wrong loudly, because a mismatch shows up as a
  machine with no asset.
- CHOICES: The majority rule is not hypothetical: each cooling tower has 8
  readings, 7 of which belong to that tower and one of which — the shared tower
  temperature setpoint — belongs to the plant. All three towers resolve 7 to 1
  and the report prints each one, so a future tie would be visible rather than
  arbitrary.
- CHOICES: 29 machines resolve to 8 assets; 109 graph entities have no readings
  and so no asset, which is expected — most of them are the readings themselves,
  and the rest are the two water loops, which are equipment in the model but not
  assets in the database.

`model/graph.py` :: `asset_edges(graph, mapping)`
- WHY IT EXISTS: Flattens the graph into something SQL can join against.
- WHAT IT DOES: Walks from every machine that has an asset, and for every other
  such machine it reaches, records the shortest number of links between the two
  assets. Does this twice, once along flow and once along containment.
- CHOICES: Paths run through machines the database does not model as assets, and
  those links still count. Each water loop is one link, which is why a cooling
  tower reaches the air handler at four rather than appearing not to reach it at
  all.
- CHOICES: This is a transitive closure with distances, not a list of direct
  neighbours. A cooling tower's effect on the air handler is real and is stored,
  and the distance is what distinguishes it from the chiller's more immediate
  one.
- CHOICES: Edges from an asset to itself are dropped. The database models one air
  handler as a single asset while the graph models its coil, fans, dampers and
  five zones separately, so every internal relation would otherwise collapse to
  `ahu-1 -> ahu-1` and those rows would be both the most numerous and the least
  informative in the table.
- ⚠ JUDGEMENT CALL: Containment edges are materialised alongside flow edges.
  You specified a relation column but named only transitive flow in the queries.
  I stored both because the column exists to distinguish them and containment is
  what lets a symptom roll up to the machine that owns it — the plant contains
  three chillers and three towers, which is 6 of the 25 rows. Removable by
  dropping one entry from one tuple.

`scripts/schema.sql` :: `app.asset_edges`
- WHY IT EXISTS: The cache the table-level layers read instead of the graph.
- WHAT IT DOES: Stores one row per ordered pair of assets per relation, with the
  hop distance. Both asset columns are foreign keys, the relation is constrained
  to the two known values, distance must be positive, and an asset cannot relate
  to itself.
- CHOICES: Placed before the grant statements in the file, because those grant on
  all tables in the schema as it stands at that moment; a table added after them
  would be unreadable by the application role.
- CHOICES: The primary key is the asset pair plus the relation, not including
  distance, so the same pair cannot be stored twice at two distances. Only the
  shortest survives.

`model/graph.py` :: `write_asset_edges(conn, edges)`
- WHAT IT DOES: Deletes every row and inserts the freshly derived set, both
  inside one transaction.
- CHOICES: Replaced wholesale rather than merged. The table is a cache of the
  graph, and a stale row is worse than a missing one — a diagnosis that follows
  an edge the model no longer contains is wrong in a way nothing downstream would
  flag. Sharing one transaction means no reader ever sees the table empty.

`Makefile` :: `load` and the new `graph` target
- CHANGED FROM BEFORE: `load` ran the ingestion loader and stopped. It now runs
  the edge rebuild afterwards, which is what makes the table regenerate on load
  as specified. The rebuild must run second, because resolving graph nodes to
  assets reads the points table.
- CHOICES: The rebuild is also its own target, so a change to the model can be
  reflected in seconds without the 40-minute reload.

### MEASURED RESULT

- Five query files, five typed functions, 25 rows in `app.asset_edges` — 19 flow
  edges at distances 2 to 4, and 6 containment edges at distance 1.
- Flow edges found: each chiller and the plant reach the air handler at 2; the
  plant and all three towers reach all three chillers at 2; all three towers
  reach the air handler at 4.
- SPARQL reachability and the breadth-first walk agree exactly on all three
  traversals checked — 17, 6 and 8 nodes respectively.
- Running the rebuild twice produces a byte-identical table: checksum
  `c9b39280a9edb49c93c1bf26ea70f8de` both times.
- 29 graph machines resolve to 8 database assets. Three resolutions are 7-to-1
  majorities and all three are reported by name.
- `open_faults_upstream` returns 2 rows with two faults asserted and 0 with none.
  The ground-truth schema remains unreadable from the application role:
  `permission denied for schema groundtruth`.

START HERE: `model/graph.py` — read `asset_edges` and `node_to_asset_id`
together; recovering which database asset a graph node belongs to, and then
counting hops through equipment the database does not model, is the whole of what
turns the semantic model into a table SQL can use.
