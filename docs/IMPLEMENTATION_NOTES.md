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
- WHAT IT DOES: Creates two loop nodes and 21 topology statements. Three chillers and five
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
  plant asset. It is 11 of the 21 authored statements and removable on its own.
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

- Merged graph 438 triples, up from 272. 151 typed entities. 21 authored
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

---

## Checkpoint 2.3a — Data cleanup and full reload before the trajectory work

Not a numbered checkpoint in the task. Requested directly, to clear the known
defects before the trajectory synthesiser and the rule engine are built on top of
them, and paid for with a full reload rather than carried forward.

### WHAT WE DID

Three things, all about making the stored data mean what it says.

Fourteen readings were labelled with an equipment type that was real but too
vague to be useful — the equivalent of filing a chilled water supply temperature
as simply "a water temperature". They are now labelled specifically. This
matters because the rule engine finds the readings it needs by asking for them by
type, so a reading filed under a vague type is invisible to it: a search for
chilled water supply temperature would have missed the primary loop entirely, and
one for condenser water flow would have missed all three cooling towers.

The air handler's three airflow readings were 60 times too large. As stored they
implied the unit was removing 686 tons of heat — enough for a small district
plant — from a machine serving five office zones, while its fan drew three
tenths of one percent of the power needed to move that much air. Corrected, the
same data says 9,523 cubic feet per minute and 11.4 tons, which is an ordinary
office air handler. Anything built on the old numbers would have been quietly and
badly wrong.

Finally the whole database was emptied and rebuilt from the source files, so
nothing that had been loaded under the old labels or the old units survives
anywhere.

### HOW IT WORKS

`ingestion/manifests/chiller.yaml` :: the fourteen specific water classes
- WHY IT EXISTS: The manifest is what a load reads, so a correction has to live
  here or it is undone by the next reload.
- WHAT IT DOES: Replaces the generic water temperature, return water temperature
  and water flow types on fourteen readings with the specific types Brick
  defines: chilled water supply and return for the primary loop, supply and
  return condenser water for the plant-level and tower-level pairs, and condenser
  water flow for the plant and all three towers.
- CHOICES: Every one of the seven replacement types was checked against the
  published Brick 1.3 ontology before use, not assumed to exist.
- CHOICES: Each assignment was decided from the July data rather than from the
  column name — which is the only reliable method here, given that this project
  has already found two pairs in this dataset labelled backwards.
- CHOICES: A naming rule, written down because otherwise this recurs. Water
  temperatures are named and typed from the LOOP's point of view: supply is
  always the cold water going to the load, return is always the warm water coming
  back. The plant-level readings and the tower readings already agreed on that
  reading, so it costs nothing to adopt.
- ⚠ JUDGEMENT CALL: The one exception is the chiller's own condenser pair, which
  stays on entering and leaving from checkpoint 2.2. It would have been more
  uniform to move it onto supply and return like everything else, but there the
  loop's convention and the machine's own convention genuinely disagree — the
  chiller supplies warm water to the tower while the tower supplies cool water to
  the chiller — and entering and leaving are the only names that cannot be read
  two ways.
- ⚠ JUDGEMENT CALL: For the same reason I did NOT rename the cooling tower point
  ids to entering and leaving, even though their descriptions use those words.
  The tower's supply reading and the plant's supply reading are both the cold
  side, so they already agree; renaming one of them would have broken an
  agreement that currently holds.

`ingestion/manifests/sdahu.yaml` :: the airflow unit correction
- WHY IT EXISTS: Three readings were being converted with the wrong unit, so
  every stored value was 60 times too large.
- WHAT IT DOES: Changes the declared source unit on supply, return and outdoor
  airflow from cubic feet per minute to cubic feet per hour. Nothing else
  changes; the conversion machinery already handles the new unit, and the ratio
  between the two is exactly 60.
- CHOICES: This contradicts the LBNL documentation, which was checked rather
  than guessed at: the published table states the unit as CFM outright. The
  documentation is being overruled on physical grounds, and the grounds are
  recorded on the reading itself. Read as CFM, the coil load averages 686 tons
  over cooling hours for a five-zone air handler and the supply fan draws 0.3% of
  the power needed to move that air. Read as cubic feet per hour, it is 9,523 CFM
  and 11.4 tons, and the fan is within a factor of six. This is the third place
  the LBNL documentation has been found to disagree with the LBNL data.
- CHOICES: The remaining factor of six on fan power is recorded as unresolved
  rather than explained away. It may be simulation crudeness — the supply fan
  speed is a hard constant 0.9 for all 525,540 minutes of the year, which is not
  physical either — but it is not proven, and a fan rule in a later task should
  not trust the power channel without checking it.
- CHOICES: A separate and worse defect on the outdoor airflow reading is recorded
  in the same place: it is a constant 357,730.44 for the entire year while the
  outdoor air damper swings from fully shut to fully open. It is therefore not a
  measurement of outdoor airflow at all, and looks like a design minimum
  ventilation figure. It is flagged as not usable as a sensor reading. This
  retroactively vindicates the choice made in 2.2 to build the mixed air balance
  on damper position rather than on measured flows — a flow-based version of that
  constraint would have been built on a constant.

`model/loader.py` :: fourteen more entries in `NODE_CLASS_REPAIRS`
- WHY IT EXISTS: The graph has to be corrected in step with the manifest and the
  database. Three copies of the same fact exist and a rule that reads one while
  the data comes from another is wrong in a way nothing reports.
- WHAT IT DOES: Adds the same fourteen corrections to the per-node class map, so
  the model loaded from the published Turtle carries the specific types too.
- CHOICES: The naming rule and its single exception are written into the comment
  above the entries, next to the code that applies it, rather than only in these
  notes.

`.env.example` :: `ADMIN_DATABASE_URL`
- WHY IT EXISTS: Checkpoint 2.4 has to write the fault labels it injects into the
  ground-truth schema, and the role every other part of the system connects as
  cannot see that schema at all — which is the property the whole accuracy claim
  depends on. A second, privileged connection string is needed, and it needs to
  be obviously separate.
- WHAT IT DOES: Adds a privileged connection URL for the superuser role, with a
  comment stating that exactly one thing may use it — the scenario generator that
  records what fault it injected and when — and that nothing which detects,
  scores, baselines, predicts or diagnoses may touch it.
- CHOICES: A separate variable rather than reusing the existing unrestricted
  `DATABASE_URL`, so that any code reaching for the privileged path has to name
  it explicitly and a breach of the separation shows up in a diff as a changed
  identifier rather than as an ordinary connection.

`scripts/fix_point_labels.sql` :: now superseded for fresh databases
- CHANGED FROM BEFORE: Still correct and still idempotent, but no longer needed
  after this reload — the manifests now produce the corrected state directly, and
  the truncate-and-reload path bypasses it entirely. Kept because it documents
  what was wrong and how it was proven, and because it is the only way to correct
  a database that cannot afford a reload.

### MEASURED RESULT

- Full reload from empty: 18 trajectories, 116,039,232 rows, 8 assets, 107
  points, in 36.5 minutes. Every trajectory reported 0 rows replaced, which is
  the check that the tables really were empty first rather than being overwritten
  in place.
- Air flows corrected by exactly 60. Supply air peak is now 8.887 m3/s, which is
  18,830 CFM, against 533.2 m3/s before. Peak coil load is 43.5 tons and the mean
  over cooling hours is 46.3 kW, which is an ordinary five-zone air handler,
  against 686 tons before.
- The outdoor airflow reading confirms itself as a constant rather than a
  measurement: its peak and its mean over the whole year are both 2.814 m3/s to
  three decimal places.
- No point in the database carries an invalid Brick class or a generic one: 0
  and 0 out of 107. The same holds for the manifests and for the graph.
- All 107 points agree on their class across the model, the manifests and the
  table. 45 class repairs are now applied to the graph as it loads, up from 3
  after checkpoint 2.1.
- The checkpoint 2.2 label corrections survived the reload, which is what proves
  they live in the manifests and not only in the migration script: secondary
  supply is 7.14 degC against return at 11.97, and chiller 1 condenser leaving is
  29.84 against entering at 27.44.
- All three constraint residuals are identical to before the reload -- -0.369 K,
  +0.456 K and -99.0 kW. This is the check that a unit fix on three airflow
  readings changed nothing else, since no constraint uses those readings.
- The hard gate from checkpoint 2.2 still passes: 17 assets upstream of the
  cooling coil, including all three chillers.
- app.asset_edges was rebuilt by the load as intended, 25 rows, and its checksum
  c9b39280a9edb49c93c1bf26ea70f8de is unchanged from before the reload -- the
  topology does not depend on the data.
- Database is 21 GB, from 2,375 MB immediately after the truncate.

START HERE: `ingestion/manifests/sdahu.yaml` — the note on `ahu-1.sa_flow`
records the one place in this project where the LBNL documentation was
deliberately overruled, and the physical argument for doing it.

---

## Checkpoint 2.4 — Trajectory synthesiser and scenarios

### WHAT WE DID

The system now has equipment that gets worse over time. Everything loaded until
now was a snapshot: each source file holds one fixed fault severity for a whole
year, so a machine in that data is either healthy or broken and never becomes
broken. Predicting how long something has left is impossible against data like
that, because nothing ever changes. There are now eight runs in which a machine
starts healthy, a fault begins on a known date, and it worsens continuously until
it reaches the worst state the source data measured.

The important part is how the worsening was produced. Nothing is modelled or
invented. At any instant the faulted run and the clean run of the same equipment,
under the same weather and the same controls, differ by some amount — and that
difference is entirely the fault, because everything else cancels. Each scenario
takes the real clean signal and adds a growing share of that real difference. The
result varies with weather and occupancy exactly as the real building does, and
the only thing that was interpolated is how far along the fault is.

Alongside the measurements, the system now records an answer key: which machine
was faulted, with what, starting when, reaching failure when. That is written by
a single privileged connection into a schema every other part of the platform is
forbidden to read, so the accuracy numbers reported later cannot have been tuned
against it.

Building this also uncovered that two groups of LBNL's published severity levels
are the same file published repeatedly under different names.

### HOW IT WORKS

Ordered by data flow: manifest, progress, blend, write, answer key, plot.

`simulator/scenarios/*.yaml` :: the eight scenario manifests
- WHY IT EXISTS: A scenario is a claim about what happened and when, and the
  accuracy of everything downstream is measured against that claim. It belongs in
  a file a reviewer can read, not in code.
- WHAT IT DOES: Each names the target machine, the fault, the window of the 2018
  source year it reads, the moment the fault starts, how long it takes to reach
  failure, how far up the severity ladder to go, a random seed, and the ordered
  list of source files that form the ladder.
- CHOICES: Each scenario occupies its own era of simulated time, so two scenarios
  on the same equipment can never write the same reading at the same instant.
  Eras are whole numbers of 365-day years from the source window, which preserves
  day-of-year and time-of-day and therefore keeps weather and the occupancy
  schedule aligned.
- CHOICES: Source windows are picked for weather that makes each fault visible.
  The damper fault reads a late-winter window because the economizer only
  modulates between 33.8F and 60F outdoor and the fault is nearly invisible in
  summer; the fouling faults read summer windows because fouling only shows on a
  loaded machine.
- CHOICES: Every scenario has 21 days of healthy operation before onset. The
  baseline layer has to learn what normal looks like from somewhere, and learning
  it from already-degraded data would define the fault as normal.
- ⚠ JUDGEMENT CALL: There are eight manifests, not the seven the checkpoint
  asked for. Two of them are clean controls, one per system, where the task
  specified one. The two systems are independent simulations with separate rule
  sets, so a false-positive control covering only one leaves the other's false
  positive rate unmeasured. `clean_chiller.yaml` is the extra file and deleting
  it restores the specified set exactly.

`simulator/trajectory.py` :: `load_scenario` and its validation
- WHY IT EXISTS: A scenario that is quietly wrong about when its fault started
  would corrupt every accuracy figure computed against it, and nothing downstream
  could detect that.
- WHAT IT DOES: Reads a manifest into a frozen record and refuses several
  specific ways of being wrong: an unknown profile, a severity ceiling outside
  its range, no healthy period before onset, a fault that reaches failure after
  the run ends, and a time shift that is not a whole number of days.
- CHOICES: The whole-day check exists because a shift of any other size moves the
  occupancy schedule to the wrong hour, which would look like the building
  suddenly working nights.

`simulator/trajectory.py` :: `progress_curve`
- WHY IT EXISTS: Decides how far along the fault is at each moment. This is the
  one genuinely synthetic quantity in the whole scenario, and it is deliberately
  the only one.
- WHAT IT DOES: Zero before onset, one at failure and after. In between it draws
  24 positive rate multipliers from the scenario's seed, stretches them across the
  window, and accumulates them. Because every multiplier is positive the curve can
  flatten but never falls, which is the never-improving behaviour the
  remaining-life maths assumes. A step fault skips all of it and jumps to one.
- CHOICES: Rate multipliers rather than a straight line, so degradation speeds up
  and slows down the way real fouling does. Twenty-four control points and a
  spread of 0.35 give roughly a factor of two between the slowest and fastest
  stretches — visible on the plot, but smooth rather than noisy.
- CHOICES: Seeded from the manifest, so a scenario is reproducible exactly.
  Verified: re-running one produced a byte-identical result.

`simulator/trajectory.py` :: `blend_contributions`
- WHY IT EXISTS: The heart of the checkpoint. Turns "the fault is 40% of the way
  along" into actual readings.
- WHAT IT DOES: For each reading it builds a ladder whose bottom rung is the
  clean run and whose upper rungs are each faulted run minus the clean run at the
  same instant. The progress value picks a position on that ladder; the two
  nearest rungs are mixed in proportion; the result is added back onto the clean
  signal.
- CHOICES: Contributions are differences at the same instant, so weather,
  occupancy and control response cancel out of them and only the fault remains.
  This is what "interpolate the fault contribution, not the whole signal" buys:
  the output keeps the genuine minute-to-minute variation of a real building
  instead of the smoothness of a curve.
- CHOICES: The shape of the resulting degradation is dictated by the measured
  rungs, not chosen. Condenser fouling climbs slowly then sharply because the
  mild rung is only 11% of the severe one in the source data — that curve is a
  property of LBNL's measurements, not of anything written here.

`simulator/trajectory.py` :: the duplicate-waypoint guard
- WHY IT EXISTS: Written in response to a defect found during this checkpoint,
  and it is the reason that defect cannot recur silently.
- WHAT IT DOES: After reading the waypoints, compares each consecutive pair and
  refuses to continue if two hold identical data, naming both files and saying
  what to do about it.
- CHOICES: An error, not a warning. A ladder with duplicate rungs produces a
  trajectory that looks like it walks four severity levels while actually
  interpolating between a value and itself — it jumps to full severity and
  nothing in the output reveals it.

`simulator/trajectory.py` :: `to_utc` and `source_tz`
- WHY IT EXISTS: Fixed a real bug rather than preventing a hypothetical one. The
  first version of the plot showed a non-zero fault contribution before onset,
  which is impossible; the cause was treating naive source-local timestamps as
  UTC, so two series six hours apart were being subtracted.
- WHAT IT DOES: Reads a naive manifest timestamp as local time at the site and
  converts it to UTC, using a fixed offset rather than a named zone for the same
  reason the loader does — simulation output has no daylight saving step.

`simulator/trajectory.py` :: `record_groundtruth`
- WHY IT EXISTS: The answer key. Without it there is nothing to measure accuracy
  against; with it in the wrong place, the accuracy claim collapses.
- WHAT IT DOES: Writes one row describing the scenario and, unless it is a clean
  run, one row naming the faulted asset, the fault, the worst severity reached,
  the onset and the failure time, plus the profile, ceiling, seed and the full
  waypoint list as structured data.
- CHOICES: It runs on its own connection, opened from `ADMIN_DATABASE_URL`, and
  it is the only function in the project that uses that credential. Everything
  that detects, scores, baselines, predicts or diagnoses connects as a role with
  every grant on this schema revoked. Keeping the privileged path in a separately
  named variable means a breach of that separation shows up in a diff as a changed
  identifier rather than as an ordinary connection.
- CHOICES: The measurements and the answer key are written on different
  connections in separate transactions, so the restricted role never touches the
  ground-truth schema even inside the generator.

`scripts/plot_scenario.py` :: `severity_ratio` and `ladder_table`
- WHY IT EXISTS: The raw difference between a scenario and its clean counterpart
  is not a measure of severity, because how much a fault shows depends on the
  weather — a leaking cooling valve barely matters on a day with a real cooling
  load. Plotting the raw difference makes a correct trajectory look erratic.
- WHAT IT DOES: Divides the achieved contribution by the contribution at full
  severity over the same hours. That ratio climbs from zero to one regardless of
  the weather, and it is the actual evidence that the trajectory walks the
  ladder. The ladder table separately reports each rung's average effect.
- CHOICES: Summed over each bucket rather than averaged pointwise, so hours in
  which the fault cannot express itself contribute nothing to either side instead
  of contributing a wild ratio.
- CHOICES: The ladder table exists to catch a specific trap: the fouling files
  are numbered by percent heat transfer RETAINED, so 095 is mildest and 065 worst,
  and anything that sorts them numerically runs the trajectory from broken to
  healthy. A misordered ladder shows up here as a column that falls.

### MEASURED RESULT

- 8 scenarios, 14,791,680 rows, about 10 minutes. Answer key: 8 scenario rows and
  6 fault events, the two clean runs correctly carrying none.
- Every scenario starts at exactly 0.0000 severity while healthy and reaches
  1.0000 by the end of its span. Both clean runs deviate from the fault-free
  signal by 0.000e+00 everywhere.
- Every severity ladder increases with level. Cooling tower fouling: 0.0542,
  0.3001, 0.7803. Bypass leakage: 7.16, 11.66, 14.73. Condenser fouling: 4,484
  then 40,735 watts. Damper stuck: 0.2502, 0.3033, 0.5243.
- Determinism confirmed: re-running cooling_tower_fouling with seed 26051501
  replaced 2,661,120 rows and reproduced md5 52140067985fc6114d95b5b689d99c43,
  identical row count and identical value sum.

### A DEFECT IN THE SOURCE DATA, FOUND HERE

Two groups of LBNL's AHU files are byte-identical duplicates published under
different severity names:

- `coi_leakage_010`, `_025`, `_040` and `_050` all have md5 `a9fdfc50...`. There
  is one measured coil leakage severity, not four.
- `oa_bias_2`, `_-2`, `_4` and `_-4` all have md5 `89b13704...`. There is one
  measured outdoor air sensor bias, and the sign distinction does not exist in
  the data either.

`coi_bias`, `coi_stuck`, `damper_stuck` and every chiller file are genuinely
distinct. Two consequences follow. The cooling valve leakage scenario now
declares one rung rather than four, which is what the data supports. And two
trajectories built back in checkpoint 1.5 are degenerate: `sdahu-coil-valve-leaking`
stitched four identical files, and the two `sdahu-oa-temp-sensor-drift`
trajectories are the same data as each other — so the decision recorded in
AI_LOG.md D-03 about splitting signed sensor faults into separate high and low
trajectories was, unknowingly, splitting one file from itself.

START HERE: `simulator/trajectory.py` — read `blend_contributions` first. Nine
lines of arithmetic are the whole difference between a synthesised trajectory
that a reviewer can trust and one that quietly invents its own physics.

---

## Checkpoint 2.5 — Decision log

### WHAT WE DID

The decision log now covers the semantic model, which was the last major
architectural choice with nothing written about it, and two earlier entries have
been closed out with what actually happened rather than what was expected.

The value of closing them out is that both turned out partly wrong, and in
different ways. The choice of public labelled data was correct and is now a
demonstrated property of the system rather than a promise — but the assumption
that came with it, that published data arrives correct, was not: it needed
continuous repair across four checkpoints. And the trajectory-stitching decision
was superseded by a better method two checkpoints later, while one of the reasons
recorded in its favour turned out to be factually false. A decision log that only
records decisions going well is not an audit trail.

### HOW IT WORKS

`AI_LOG.md` :: D-04 — Brick/RDF over Project Haystack or a custom graph
- WHY IT EXISTS: The semantic model is what makes tracing a fault from one
  machine to another possible at all, and until now nothing recorded why that
  layer is built on Brick rather than on the two obvious alternatives.
- WHAT IT DOES: Rejects Project Haystack because it describes equipment with bags
  of tags rather than typed relationships, which means nothing can check a model
  for contradictions and two authors can describe the same thing differently —
  tolerable when a human reads it, fatal when a traversal query depends on it.
  Rejects a custom schema as a worse Brick arrived at more slowly, throwing away
  the models that already exist. Rejects the newer ASHRAE standard as unfinished
  and heavier than needed. Chooses Brick, on the grounds that it has typed
  relationships a query can traverse and that the equipment descriptions ship
  with the data.
- CHOICES: Records the adoption cost as roughly a day rather than the hour
  estimated, and says exactly where the estimate went wrong. The published models
  are two disconnected graphs, and the chiller plant model contains no flow
  direction whatsoever — zero flow statements in 191. So the joining edge was not
  one triple as expected; the whole water-side topology had to be authored, 22
  statements and 2 invented nodes.
- CHOICES: Records that one of the three class names found not to exist in Brick
  was mine, not LBNL's — I assumed a condenser water loop class existed and it
  does not. Attributing that to Brick rather than to myself would have been the
  easy version.

`AI_LOG.md` :: D-02 Outcome
- WHY IT EXISTS: The entry claimed the accuracy figures would be computed against
  labels the project did not create. That is now testable rather than aspirational.
- WHAT IT DOES: Confirms the claim held and is enforced by the database rather
  than by convention, re-verified at three separate checkpoints. Then records the
  part that did not hold: eleven distinct defects in the published data, from
  swapped column pairs through class names that are not real classes to whole
  files published four times under four different severity names.
- CHOICES: States plainly that "public data, so the labels are free" was wrong —
  the labels were free, the data was not — while also stating why the decision is
  still right: a simulator would have had no defects because it would have had no
  independent authority either.

`AI_LOG.md` :: D-03 Outcome
- WHY IT EXISTS: Two things happened to this decision that a reader needs to know
  and neither is visible from the entry as written.
- WHAT IT DOES: Records that the method was superseded — the scenarios that
  accuracy is measured against now interpolate the fault contribution rather than
  concatenating whole files, which fixes the staircase caveat the entry itself
  raised. Then corrects a claim the entry makes in my own favour: it credits me
  with splitting signed sensor faults into separate high and low trajectories,
  and those source files are byte-identical, so the split was of one file from
  itself.
- ⚠ JUDGEMENT CALL: The checkpoint asked only for D-02's outcome. I filled in
  D-03's as well because it contains a statement now known to be false, and a
  decision log carrying an uncorrected error is worth less than one with a gap in
  it. Removing that outcome restores the specified scope exactly.

### MEASURED RESULT

- Four entries, each carrying all six required subsections: 4, 4, 4, 4, 4, 4.
- D-02 and D-03 outcomes filled; D-01 and D-04 deliberately still open, D-04 with
  the reason stated — the graph is not tested until cross-asset diagnosis in
  Task 6.
- The header is unchanged from the text specified in Task 1.
- Numbered D-04, not D-03 as the checkpoint said, because D-03 is already the
  trajectory-stitching entry and is cross-referenced from these notes.

START HERE: `AI_LOG.md` — the "cost actually paid" section of D-04 is the part
worth reading; it is the only place in the project that quantifies how wrong an
adoption estimate was and why.

## Checkpoint 3.1 — Quality scoring

### WHAT WE DID

The platform can now say how far each individual reading can be trusted, and it
records broken instruments separately from broken machines. Before this, every
number in the database was taken at face value: a thermistor that had died and
was repeating its last value looked exactly like a stable temperature, and
nothing downstream could tell the difference. Every reading in the two scored
periods now carries a 0-to-100 trust score and, where that score is less than
perfect, a note saying which specific check it failed.

Sensor findings go to their own table and are phrased as statements about
instruments, never about equipment. That separation is what stops the system
reporting a chiller fault when the real problem is a twenty-dollar sensor, and
it is the mechanism the rule engine will use in the next checkpoint to decline
to fire on inputs it cannot believe.

Running it over 26 million readings immediately found things nobody had asked
it to look for. It independently rediscovered the two dead air-handler points
the ingestion manifest already documents as defects, and it found a unit
inconsistency in the published source data that had gone unnoticed through two
whole tasks.

### HOW IT WORKS

`ingestion/manifests/point_bounds.yaml`
  WHY IT EXISTS: The three columns the range and plausibility checks need --
    lowest believable value, highest believable value, fastest believable change
    -- were empty for all 107 points, because the loader never had anything to
    put in them. Without them two of the five dimensions cannot be computed.
  WHAT IT DOES: Holds one entry per Brick class, 39 of them, covering all 107
    points; each gives the envelope, the rate limit, the smallest movement a live
    sensor of that kind should show, and whether constancy means anything for
    that kind of point at all. A per-point override section sits underneath and
    is merged over the class default field by field.
  CHOICES: Keyed on class rather than on point because a bound describes what
    kind of instrument something is, not which one it is -- 38 temperature
    sensors share one entry instead of repeating one number 38 times. The
    override section exists for exactly one reason: Electric_Power_Sensor spans
    a 512 W return fan and a 229 kW chiller, so all 16 power points override the
    ceiling. Rate limits are set at two to three times the fastest change seen
    across the fault-free year.
  ⚠ JUDGEMENT CALL: The envelopes describe what the INSTRUMENT can report, not
    what the equipment does when healthy. My first version confused the two and
    capped condenser water at 50 degC, rounded up from the 30 degC seen on clean
    data. A leaking bypass valve drives that loop to 72.4 degC in the LBNL source
    itself, so 81 days of a correctly-working sensor watching a genuinely
    overheating condenser were written off as bad readings. Since the rule engine
    refuses to fire on readings marked untrustworthy, that would have blinded
    fault detection at the exact moment it was needed. Water temperatures now run
    0 to 100 degC -- a loop cannot freeze or boil -- and the narrow "what is
    normal here" question belongs to the baseline layer in Task 5, not here.

`analytics/quality/scoring.py :: resolve_bounds`
  WHY IT EXISTS: The bounds file and the point catalogue are maintained by hand
    and can drift apart. A silently missing bound means a dimension quietly
    scores 100 forever and a whole class of sensor failure goes unreported.
  WHAT IT DOES: Merges each point's class default with any per-point override,
    then refuses to continue on four kinds of disagreement: a class with no
    entry, an override naming a point that does not exist, a run-state entry
    naming one that does not exist, and any Brick class used with two different
    SI units. The last check matters because every number in the file is written
    in one unit, so a class carrying both degC and degF would make a ceiling of
    60 mean two different temperatures.

`analytics/quality/scoring.py :: apply_bounds`
  WHY IT EXISTS: The bounds have to be readable by layers that will never parse
    a YAML file. The point catalogue is the interface everything else already
    reads.
  WHAT IT DOES: Writes the resolved lowest value, highest value and rate limit
    onto all 107 rows of the point catalogue.

`analytics/quality/scoring.py :: load_asset_frame`
  WHY IT EXISTS: Staleness needs to know whether the machine was switched on at
    the moment of each reading, which is a different point on the same asset.
  WHAT IT DOES: Pulls every reading for one asset over one period and pivots it
    into a table with one column per point, so the on/off status is already lined
    up against every other reading on the same timestamps.

`analytics/quality/scoring.py :: split_runs`
  WHY IT EXISTS: The database holds separate eras of simulated time with months
    of emptiness between them. That emptiness is how the data is laid out, not a
    sensor that stopped reporting, and treating it as the latter buries the real
    findings.
  WHAT IT DOES: Cuts an asset's timeline wherever the data stops for more than a
    day, and scores each resulting stretch independently. Gaps shorter than a day
    stay inside a stretch, which is what leaves them detectable as dropouts.
  CHANGED FROM BEFORE: The first version compared raw integer timestamps against
    a hardcoded billion, assuming nanosecond resolution. The database driver
    returns microseconds, so a 217-day gap was read as 18,749 seconds, no gap
    ever crossed the threshold, and all four years of scenarios were treated as
    one continuous run -- which manufactured 321 dropout advisories out of the
    empty months between them. It now divides by a unit-carrying interval, so the
    resolution cannot be assumed wrongly.

`analytics/quality/scoring.py :: score_point_run`
  WHY IT EXISTS: This is the actual scoring. Everything else feeds it or stores
    what it produces.
  WHAT IT DOES: Computes five numbers for every reading over a trailing window.
    Timeliness is the share of expected slots in the window that carried a row.
    Completeness is the share of arrived rows that held a number. Range is the
    share of readings inside the envelope. Plausibility is the share whose step
    from the previous sample, divided by the minutes between them, stays under
    the rate limit. Staleness is handled separately below. The composite is the
    MINIMUM of the five.
  CHOICES: Minimum rather than mean. A reading that is timely, complete, smooth
    and moving but physically impossible would average 80 out of 100 and sail
    through the rule engine's quality gate, which is precisely the failure this
    layer exists to prevent. Windows are trailing, so the score at a given moment
    uses only data up to that moment -- a rule that fires on evidence from the
    future cannot be run in production. Three hours for the first four
    dimensions; they are per-sample properties, so the window only controls how
    long one bad sample keeps depressing the score.

`analytics/quality/scoring.py :: _staleness`
  WHY IT EXISTS: A sensor that has died often keeps reporting its last value, so
    "has not moved" is one of the most useful failure signals there is. It is
    also the hardest to use without drowning in false alarms.
  WHAT IT DOES: Measures peak-to-peak movement across a day-long window, but
    only over the samples taken while the owning asset was actually running --
    the rest are masked out before the movement is measured. Scores the result
    against the smallest movement that class of sensor should show. Three gates
    suppress it entirely: the point's class says constancy is normal, fewer than
    a quarter of the window was spent running, or the reading is parked at the
    end of its scale.
  CHOICES: A day-long window, not three hours. Measured on the fault-free year,
    half of all three-hour windows on the secondary chilled water supply
    temperature are perfectly flat during entirely normal operation, against 28%
    of day-long ones -- a three-hour flatline test on this building would be
    almost all false alarms. Peak-to-peak rather than variance because it answers
    the question directly and can be compared against the sensor's resolution
    without any statistics.
  ⚠ JUDGEMENT CALL: The running-time requirement is a quarter of the window, not
    all of it. Requiring the whole window is more obviously correct and is what I
    wrote first, but the air handler shuts down every night, so no 24-hour window
    ever qualified, staleness was never scored for a single AHU point across a
    whole year, and both dead points went unreported. Six running hours out of
    twenty-four is enough evidence to judge and low enough to survive a nightly
    shutdown.

`analytics/quality/scoring.py :: _episodes` and `extract_advisories`
  WHY IT EXISTS: A sensor dead for a month is one thing a technician acts on
    once. Recorded per reading it would be 8,640 identical rows, and the advisory
    table would be larger than the measurements it describes.
  WHAT IT DOES: Collapses each per-reading failure into contiguous stretches,
    discards any stretch shorter than thirty minutes, and writes one row per
    stretch with its start, end, worst score, length and the evidence -- the
    bound that was crossed and by how much, or the value the reading was stuck
    at. Four kinds: dropout, out_of_range, flatline and stale.
  CHOICES: Episodes are cut from the per-reading condition rather than from the
    rolling score, so an episode covers when the sensor actually misbehaved
    rather than trailing three hours past it.
  ⚠ JUDGEMENT CALL: The checkpoint named flatline and stale as separate kinds
    without defining the difference. I made flatline the acute case -- no
    movement whatsoever -- and stale the chronic one, still moving but by less
    than 40% of what its class expects. Both come from the same dimension and
    differ only in degree.

`analytics/quality/scoring.py :: write_scores`
  WHY IT EXISTS: 26 million rows have to get their score back into the
    measurements table.
  WHAT IT DOES: Streams the scores into a temporary staging table in binary, then
    applies them with a single statement that joins staging against measurements
    on point and timestamp AND on an explicit time range.
  CHOICES: The failing dimensions are stored as JSON only where the composite is
    below 100. A row with nothing wrong needs no explanation, and writing an
    all-perfect object onto every clean reading would add about a gigabyte of
    JSON that says nothing.
  ⚠ JUDGEMENT CALL: Repeating the time range in the update looks redundant next
    to the timestamp join, and it is the single most important line in the
    function. The measurements table is split into 5,077 one-day chunks; joining
    on timestamp alone gives the query planner nothing to exclude chunks by, so
    it plans an update across all 130 million rows to change 268,000 of them.
    Measured: 296 seconds of execution on top of 37 seconds of planning. With the
    range restated, the same update takes 7.8 seconds -- 38 times faster.

`analytics/quality/scoring.py :: span_summary`
  WHY IT EXISTS: The verification number has to come from somewhere that cannot
    agree with itself when something has gone wrong.
  WHAT IT DOES: After each period is written, queries the database for the
    distribution of what was actually stored and prints that.
  ⚠ JUDGEMENT CALL: An earlier version computed this from the scores still in
    memory and reported a mean of 36.1 while the stored data was at 93.4 -- the
    in-memory set included grid slots that hold no row and are never written, so
    it was measuring something that does not exist. Reading back from storage
    costs one extra query per period and makes the check independent of the thing
    it checks.

`scripts/schema.sql :: app.sensor_advisories`
  WHY IT EXISTS: A dead thermistor and a failing chiller both make the numbers
    look wrong. Conflating them is how a fault detection system loses its users:
    it reports a chiller fault, someone opens the machine, and the actual problem
    was a cheap sensor.
  WHAT IT DOES: One row per episode, naming the point, the kind of failure, the
    period, the worst score reached, how many readings were involved, and the
    evidence as JSON. Everything in it is a statement about whether a reading can
    be believed; nothing in it is a statement about whether a machine is healthy.
  CHOICES: Placed before the grant section of the file, because those grants
    apply to all tables in the schema as of that point -- a table added after
    them would be unreadable by the role every analytics layer connects as.

`analytics/__init__.py` and `PROJECT_CONTEXT.md`
  WHY IT EXISTS: PROJECT_CONTEXT.md called this package `platform/`, and that
    name cannot be used.
  WHAT IT DOES: `platform` is a Python standard library module. A top-level
    package of the same name shadows it, and pandas calls
    platform.python_implementation() while being imported, so `import pandas`
    fails outright with the interpreter itself suggesting a rename. Omitting the
    package marker does not help either: the standard library then wins the name
    and importing anything beneath it fails. The package is `analytics/`, and the
    directory listing in PROJECT_CONTEXT.md records that task prompts saying
    `platform/...` mean this.

### MEASURED RESULT

- 26,038,236 readings scored in 17.3 minutes across two periods, 0 left unscored.
- LBNL fault-free year: mean composite 89.90, median 100, 88.69% of readings at
  a perfect 100, 8.12% at 0.
- Scenario era: mean 94.34, median 100, 94.27% at 100.
- 2,942 advisory episodes: 1,769 flatline, 1,142 stale, 31 out_of_range, 0
  dropout. Dropout is zero because the ingested grid has no holes in it.
- The two lowest-scoring points on the fault-free year are ahu-1.oa_flow and
  ahu-1.sf_speed at 16.8 -- the two the ingestion manifest already documents as
  defective, found independently here by a check that knew nothing about them.

### FINDING THE CHECKPOINT DID NOT ASK FOR

The out_of_range check named only two points, both static pressure, and tracing
them found a defect in the LBNL source data itself. The fault-free file publishes
the supply duct static pressure setpoint as 1.60746 inches of water. All 20 fault
files publish the same setpoint as -400.25253, which is that value converted to
Pascals and negated. The sensor beside it is inconsistent in the opposite
direction: Pascals in the fault-free file, inches of water in the fault files.
20 of the 21 AHU source files disagree with the fault-free file about the units
of both columns.

This means ahu-1.sa_static_p and ahu-1.sa_static_p_spt are unusable in every
stitched trajectory and every synthesised scenario, and that the units recorded
for them in ingestion/manifests/sdahu.yaml -- which were read off the fault-free
file -- are right for one file in twenty-one. No other point shows the problem.
Fixing it means a manifest change and a reload, so it is left for direction.

START HERE: `analytics/quality/scoring.py` — `score_point_run` and `_staleness`
are the whole checkpoint; everything above them feeds those two and everything
below stores what they produce.

## Checkpoint 3.2 — Rule registry and mode detection

### WHAT WE DID

The platform now has a place to put fault rules, and it knows which rules belong
to which machine without being told. A rule is written against a KIND of
equipment rather than against a particular one, and the system works out for
itself that a rule about air handlers applies to this building's air handler.
Adding a fourth kind of machine later means describing it in the model and
writing its rules; no dispatching code changes, which is the difference between
a second equipment class costing a day and a third costing a week.

It also has a safety interlock. A rule cannot read a measurement the quality
layer marked untrustworthy -- not "should not", cannot, because the only route
to a reading refuses to hand one over. When that happens the rule reports that
nobody knows rather than that the machine is fine, and it names the sensor that
blocked it. That is the mechanism that stops a dead sensor being written up as a
broken chiller.

Finally it can tell what the air handler is trying to do at any moment: asleep,
calling for heat, cooling with fresh air alone, or running the chiller with or
without help from the outside air. Almost every air-side fault only means
something in some of those states -- a wide-open cooling valve is ordinary in
August and alarming on a mild morning -- so knowing the state is what will keep
the rules in the next checkpoint from crying wolf at every changeover.

### HOW IT WORKS

`model/brick_taxonomy.ttl`
  WHY IT EXISTS: Dispatch has to know that a rule written for one name applies to
    equipment recorded under another. The published LBNL models say this machine
    is a brick:AHU; a rule may reasonably be written against
    brick:Air_Handling_Unit. Nothing in the LBNL files relates those two names,
    because instance data never carries the vocabulary that defines it.
  WHAT IT DOES: Holds Brick 1.3's own class hierarchy -- 1,628 statements of the
    form "this class is a kind of that one" and "these two names mean the same
    thing" -- and is merged into the graph alongside our own files.
  CHOICES: Only the hierarchy is vendored, not the whole ontology. The published
    file is 52,113 statements, of which the shapes, tags, units, definitions and
    validation rules are 97% and none of them are used here. Loading all of it
    costs 2.07 s against 0.09 s for the hierarchy alone, on a graph the rule
    engine reloads often. It is generated, not hand-picked: every subclass and
    equivalence edge between two Brick classes is present, so no future rule can
    reference a relation that was quietly dropped. The file header records the
    source URL, the fetch date and the md5 of what was downloaded.

`model/loader.py :: load_merged_graph`
  CHANGED FROM BEFORE: Now also merges the taxonomy above, controlled by a new
    argument that defaults to on. The graph grows from 442 statements to 2,070.
    The argument exists so that counting or inspecting the building itself is
    still possible -- with the taxonomy loaded, Brick's vocabulary outnumbers the
    actual building four to one, and every census would be swamped by it.

`analytics/rules/registry.py :: rule`
  WHY IT EXISTS: This is the registration point the whole checkpoint is about. It
    is what makes a rule a statement about a kind of equipment rather than about
    a named machine.
  WHAT IT DOES: A decorator that records a rule's identifier, the Brick class it
    applies to, the operating modes it is valid in, the minimum trust score its
    inputs need, and how long its condition must hold before being reported. It
    refuses a duplicate identifier and refuses a quality bar outside 0 to 100.
  CHOICES: The operating modes are stored as opaque strings. The registry
    deliberately knows nothing about what an air handler's modes are, which is
    exactly what lets the same registry hold chiller rules that have no concept
    of an economizer. persistence_minutes is recorded but not acted on here;
    holding a condition open across time is transient suppression, which belongs
    with the APAR rules in the next checkpoint, and this is where they will read
    it from.

`analytics/rules/registry.py :: class_closure`
  WHY IT EXISTS: The actual matching. Given the class of a machine, it produces
    every class that machine can be said to be.
  WHAT IT DOES: Starts at the machine's own class and walks outward -- upward
    through "is a kind of" links, and sideways in BOTH directions through "means
    the same as" links -- collecting everything it reaches. For this building's
    air handler that yields AHU, Air_Handler_Unit, Air_Handling_Unit, Equipment,
    HVAC_Equipment and Entity. A rule matches if the class it was registered
    against is anywhere in that set.
  CHOICES: Equivalence is followed in both directions because it is symmetric by
    definition but Brick only writes it down once -- the file states that
    Air_Handling_Unit is equivalent to AHU and never the reverse -- and the graph
    library does no reasoning of its own. Following it one way would mean an
    asset typed AHU never matched a rule written for Air_Handling_Unit, which is
    precisely the case the demonstration exercises. Breadth-first, skipping
    anything already seen, so the cycles that equivalence pairs inevitably create
    terminate.

`analytics/rules/registry.py :: rules_for_class`
  WHY IT EXISTS: The dispatch itself, and the thing the checkpoint requires to
    contain no equipment-specific logic.
  WHAT IT DOES: Works out the class ancestry of the asset, then returns every
    registered rule whose declared class appears in it. There is no lookup table
    and no mention of air handlers or chillers anywhere in it.

`analytics/rules/registry.py :: asset_class_from_graph`
  WHY IT EXISTS: The database and the semantic model each independently record
    what kind of thing every machine is. If they disagree, one is wrong, and
    dispatching on either without checking would silently apply the wrong rules.
  WHAT IT DOES: Looks up every graph node belonging to an asset, collects the
    classes those nodes carry, and confirms the database's class is among them,
    raising if not. The test is that SOME node belonging to the asset carries the
    class rather than all of them, because the graph models one air handler as
    many nodes -- coil, fan, two dampers, five zones.

`analytics/rules/registry.py :: RuleContext`
  WHY IT EXISTS: The quality gate. This is the single most important object in
    the file, because it makes the gate impossible to forget rather than merely
    mandatory.
  WHAT IT DOES: It is the only route from a rule to a measurement. A rule asks
    for a reading by point identifier and by the role it plays in the rule; the
    context looks it up, and if the score is below the rule's bar it records the
    offending reading and aborts the rule rather than returning the number. Every
    successful read is also recorded, so the evidence behind an outcome is
    assembled automatically instead of relying on the rule author to attach it.
  CHOICES: Aborting is done by raising, so there is no return value a careless
    rule could ignore. The blocked reading is recorded BEFORE aborting, so the
    outcome can name the sensor that stopped the rule instead of just reporting
    that something was untrusted.

`analytics/rules/registry.py :: RuleStatus`
  WHY IT EXISTS: A rule that did not fire and a rule that could not run are
    completely different statements and must never collapse into one boolean.
  WHAT IT DOES: Five outcomes: fired, did not fire, could not be trusted, had no
    reading at all, and does not apply in this operating mode. The first says the
    equipment looks fine; the third says nobody knows. A building full of dead
    sensors would otherwise report a clean bill of health.

`analytics/rules/registry.py :: evaluate_rule`
  WHY IT EXISTS: Ties the pieces together for one rule against one machine at one
    instant.
  WHAT IT DOES: Checks the operating mode first and skips the rule if it does not
    apply. Otherwise builds the context, runs the rule body, and catches the two
    ways a rule can be stopped by its inputs. Whatever comes back is wrapped
    together with the readings the rule actually consulted, its severity
    contribution and its cost estimate.

`analytics/rules/registry.py :: CostUnit and CostEstimate`
  WHY IT EXISTS: Every rule has to say what its fault is costing, or the advisory
    layer cannot rank two faults against each other.
  WHAT IT DOES: Carries an amount, one of three units -- electrical energy, water,
    or comfort measured as degrees away from setpoint multiplied by hours -- and a
    plain-language sentence saying how the number was arrived at.
  CHOICES: Three units rather than one currency. Converting to money needs
    tariffs, which belong in the advisory layer; doing it here would bury the
    reasoning behind a number nobody can check.

`analytics/rules/readings.py :: load_asset_readings` and `readings_at`
  WHY IT EXISTS: Rules need both halves of a reading -- the value and its trust
    score -- and they are two columns of the same row.
  WHAT IT DOES: Pulls one machine's measurements over a window into two aligned
    tables, one of values and one of scores, then hands a rule exactly one row of
    them at a time. What a rule can see is one instant and nothing either side of
    it.

`analytics/rules/mode.py :: classify_frame`
  WHY IT EXISTS: Which rules may run depends on what the air handler is trying to
    do. Getting this wrong sends every downstream rule down the wrong branch.
  WHAT IT DOES: Classifies every instant into one of five modes by asking, in
    order: is anyone in and is the fan running; is the cooling valve shut and the
    air arriving at the coil colder than the supply setpoint (heating); is the
    valve shut at all (free cooling); is the outdoor damper open beyond its
    minimum (mechanical cooling with economizer); otherwise mechanical cooling on
    minimum fresh air. A sixth value, unknown, is returned when any signal is
    missing or scores below the trust bar.
  CHOICES: The minimum outdoor air damper position is 0.10, read off the data
    rather than assumed -- across the occupied hours of the fault-free year the
    damper sits at exactly 0.10 for 33,615 samples, with the next most common
    position two orders of magnitude rarer. It is a hard control floor. The
    economizer test sits 0.02 above it to clear the handful of samples that
    jitter to 0.11 and 0.12 without swallowing genuine economizer action, which
    runs all the way to 1.0. The heating test uses a 0.5 degC deadband, because
    the economizer holds mixed air within tenths of a degree of the setpoint and
    without a deadband the mode would chatter on every crossing. Vectorised
    rather than looped because a year at the five-minute cadence is 105,108
    instants and the mode must be known at every one before a rule can run.
  ⚠ JUDGEMENT CALL: This air handler has no heating coil -- the LBNL unit is
    instrumented with a chilled water valve and nothing else, and the terminal
    reheat that actually adds heat is not instrumented either. So heating is
    inferred as a DEMAND rather than observed as an action: the coil is shut and
    the air reaching it is already below the supply setpoint, so the setpoint can
    only be met if something downstream adds heat. The alternative was to declare
    heating unobservable and never return it, which would have left one of the
    five modes the checkpoint names permanently empty and given the APAR heating
    rules nothing to gate on.
  ⚠ JUDGEMENT CALL: A shut coil with the damper on its floor and no heating
    demand is reported as free cooling. It is really a unit coasting inside its
    deadband with no cooling of any kind happening, and free cooling is the
    closest of the five names because the honest statement is that no mechanical
    cooling is in use. It is 107 samples in a year, 0.2% of occupied time.

`scripts/plot_mode.py`
  WHY IT EXISTS: A mode that flickers breaks every rule above it, and flicker is
    invisible in a summary statistic.
  WHAT IT DOES: Draws the classified mode as a band of colour over a week, with
    the temperatures and the two actuator positions underneath, and prints the
    mode shares plus every transition with its timestamp. Anchors the window to
    the building's local midnight rather than to UTC, otherwise the plot starts
    at six in the evening and every occupied block straddles a day boundary.

### MEASURED RESULT

- Dispatch, resolved purely by class: the air handler picks up the rule
  registered against brick:Air_Handling_Unit despite being typed brick:AHU; all
  three chillers pick up the chiller rule; the plant and the three cooling towers
  correctly match nothing, because no rule was registered for them.
- The class ancestry that makes that work: AHU, Air_Handler_Unit,
  Air_Handling_Unit, Class, Entity, Equipment, HVAC_Equipment.
- Quality gate, same instant and same values, only the score changed:
  at quality 100 the rule fires and reports supply air 20.90 degC against a
  12.88 degC setpoint; at quality 12 it returns insufficient_data_quality, does
  not fire, and names ahu-1.sa_temp as the reason.
- Mode over the fault-free year: unoccupied 44.79%, mechanical cooling without
  economizer 32.06%, free cooling 16.33%, mechanical cooling with economizer
  4.31%, heating 0.32%, unknown 2.19%.
- Transitions: 3.7 per day in a spring week, 3.9 per day in a winter week. Both
  weeks show the same physically sensible shape -- the unit wakes on schedule,
  passes briefly through heating during cold-morning startup, moves to free
  cooling as the return air warms the mixing box, and reaches for mechanical
  cooling only when the outside air stops being enough.

### AN INTERACTION WORTH KNOWING ABOUT BEFORE 3.3

The mode is unknown for 2.19% of the year, and 1.98 of those 2.19 points are the
outdoor air damper being scored below the trust bar by the quality layer -- it
flags the damper as flatlined for about 7.2 days of the year because it sits
perfectly still on its 0.10 floor for long stretches while the fan runs.

That is not obviously a false positive. A damper that has not moved in a day
while the unit runs is exactly what a stuck damper looks like, and a stuck
outdoor air damper is one of the six faults this project injects. But it means
the rules cannot run during those periods, and the fault they would be looking
for is the one that produced the flag. Checkpoint 3.3 has to decide whether a
damper-stuck rule reads the damper position through the normal quality gate at
all, or whether a stuck reading is its evidence rather than its obstacle.

START HERE: `analytics/rules/registry.py` — `class_closure` and `RuleContext` are
the two ideas in this checkpoint; everything else is scaffolding around them.

## Checkpoint 3.3 — APAR rules

### WHAT WE DID

The system can now say, in physical terms, that an air handler is misbehaving —
and it says so without crying wolf. Six published expert rules were implemented,
each a statement about conservation of mass or energy across the machine, each
only evaluated in the operating states where that balance is supposed to hold.

The hard part was not the rules but the silence around them. Air handlers are
only in balance when they have settled, and they are unsettled every morning at
startup and for a while after each time the controls change strategy. Rules run
during those moments do not find faults; they find the changeover, and a system
that alarms at every changeover gets switched off by the people answering the
alarms. Four separate mechanisms now hold the rules quiet until the machine has
settled, and the result is zero false alarms across 485 days of fault-free
operation while still keeping 83 to 87 percent of occupied time available for
detection.

Run against the injected faults, the rules caught one of the three air-side
faults outright and missed two. Both misses are understood and neither is a bug;
they are recorded below because they define what the later layers have to do.

### HOW IT WORKS

`analytics/rules/registry.py :: effective_quality` and `STALENESS`
  WHY IT EXISTS: The quality layer refuses to let a rule read a reading it has
    marked down. For one rule that refusal blocks exactly the evidence the rule
    exists to find.
  WHAT IT DOES: A reading can be marked down for five reasons. Four of them —
    it never arrived, it arrived empty, it is physically impossible, it moved
    faster than physics allows — mean the NUMBER is wrong. The fifth, staleness,
    means only that the number stopped changing, and a seized actuator still
    reports its position perfectly accurately. So a rule may declare specific
    points whose staleness it treats as evidence, and for those the trust score
    is recomputed across the other four dimensions alone.
  CHOICES: Declared per rule and per point, never globally, so the exemption sits
    at the top of the rule claiming it. It never waives the other four: a valve
    reading outside 0 to 1, or jumping impossibly fast, is still refused.
  ⚠ JUDGEMENT CALL: Only rule 20 claims it, for the cooling coil valve. The rule
    tests whether the valve has run fully open and stayed there, which IS a
    flatline by definition, so without the exemption the quality layer would
    suppress the rule at precisely the moment its condition became true.

`analytics/rules/readings.py :: effective_quality_frame`
  WHY IT EXISTS: The same problem, one layer earlier. The operating mode is read
    from the outdoor air damper among other signals, and a damper resting on its
    minimum position for hours is marked stale.
  WHAT IT DOES: Recomputes every trust score across the non-staleness dimensions
    before the mode classifier sees it.
  CHANGED FROM BEFORE: Without this the mode was unknown for 2.19% of the year
    and no rule ran at all during those periods. With it, the year contains no
    unknown modes whatsoever.

`analytics/rules/apar.py` — module docstring
  WHY IT EXISTS: The checkpoint asks which six rules were implemented and why the
    other twenty-two were not, and that answer is worth more than the code.
  WHAT IT DOES: Lists all six with their APAR numbers and expressions, then walks
    the twenty-two exclusions in groups: nine need a heating coil valve this unit
    does not have, two need an economizer changeover temperature the dataset does
    not publish, five belong to a mode whose definition here is only approximate,
    two are redundant against rules already chosen, one needs an operating mode
    the classifier never produces, and the rest test the control's decisions
    rather than the equipment.
  CHOICES: More than six qualify. The six were chosen to span the modes the unit
    actually spends time in and to cover the three air-side faults this project
    injects. Rule 19 was passed over for rule 20 specifically because 19 adds a
    supply-air condition that a drifting supply air sensor can never satisfy —
    the sensor reads at setpoint by construction — so 19 would be blind to the
    one fault 20 catches.

`analytics/rules/apar.py` — thresholds
  WHY IT EXISTS: Every number a rule compares against has to come from somewhere
    defensible, or the rules are just opinions.
  WHAT IT DOES: Four thresholds are APAR's own, taken from the reference
    implementation in NISTIR 7365: 2.0 degC on temperature errors, 0.02 on the
    cooling valve signal, 0.30 on outdoor air fraction, and 5.6 degC as the
    minimum outdoor-to-return temperature difference for the fraction to mean
    anything. Two are building-specific and were measured.
  CHOICES: The supply fan temperature rise is 0.53 degC here against APAR's
    published default of 1.1. Measured as the difference between supply and mixed
    air across the 17,508 samples of the fault-free year where the cooling coil
    is shut, so nothing but the fan is moving heat. Using the published default
    would bias rule 7 by 0.57 degC — a quarter of its threshold — in the
    direction that hides a leaking valve.
  ⚠ JUDGEMENT CALL: The minimum outdoor air fraction is 0.016, measured, where
    APAR's reference implementation would set it to the minimum damper position
    over 100, which is 0.10. Those differ by a factor of six. Damper position and
    airflow are related through the pressure drop across a partly open blade and
    are nowhere near proportional. Measured over the 15,910 fault-free samples in
    minimum-outdoor-air cooling, the fraction sits between 0.0155 and 0.0161 from
    the tenth to the ninetieth percentile, which is tight enough to use as a
    fixed expectation. Taking the reference implementation's value on trust would
    have put the healthy operating point 0.084 away from where the rule expects
    it, eating a third of the rule's tolerance before any fault occurred.

`analytics/rules/evaluate.py :: ewma_with_resets`
  WHY IT EXISTS: The first of APAR's four suppression mechanisms. Rules run on a
    smoothed signal, not a raw sample, so one noisy reading cannot trip an alarm.
  WHAT IT DOES: Keeps a running average that leans mostly on its own history and
    a little on each new sample, and RESTARTS it from scratch whenever the
    operating mode changes. The restart is the important half: a plain average
    carries the old mode's conditions across a changeover and takes many samples
    to forget them, which is exactly the interval the delays are protecting.
  CHOICES: NISTIR 7365 publishes a smoothing constant of 0.1 applied once per
    control scan, and a building automation scan is roughly a minute where this
    data arrives every five. Using 0.1 directly would smooth over five times as
    much wall-clock time as intended, so it is converted to preserve the time
    constant instead. Written as an explicit loop because the standard library
    routine has no concept of a reset.

`analytics/rules/evaluate.py :: suppression_mask`
  WHY IT EXISTS: The second and third mechanisms. Some moments are simply not
    admissible evidence.
  WHAT IT DOES: Marks an instant evaluable only if the unit is occupied, at least
    90 minutes have passed since occupancy began, and at least 60 minutes have
    passed since the mode last changed. Both delays are APAR's published values.
  CHOICES: Occupancy is taken from the mode itself rather than from a separate
    signal, so the two clocks cannot disagree about when the day started.

`analytics/rules/evaluate.py :: run_rules`
  WHY IT EXISTS: Ties smoothing, suppression, dispatch and the quality gate
    together across a whole season.
  WHAT IT DOES: Smooths the inputs, works out which instants are admissible, and
    at each of those asks every rule that applies to the machine's class. Quality
    scores come from the RAW readings rather than the smoothed ones, because an
    average of numbers nobody trusts is still untrustworthy and the quality layer
    scored samples, not averages.
  CHOICES: Values are pulled into plain arrays once before the loop. Building
    each instant's readings out of table lookups instead is the difference
    between seconds and tens of minutes across a year.

`analytics/rules/evaluate.py :: sustained`
  WHY IT EXISTS: The fourth mechanism, and the one that turns a condition into a
    report.
  WHAT IT DOES: Groups each rule's true instants into unbroken stretches and only
    reports a stretch once it has lasted the full hour APAR requires.
  ⚠ JUDGEMENT CALL: A stretch is broken by an evaluated instant where the rule
    was false, but NOT by the gaps where evaluation was suppressed. A fault does
    not stop existing because the unit changed mode, and requiring an unbroken
    hour of admissible samples would mean almost nothing ever qualified — the
    suppression windows are long enough to fragment every real fault.

`scripts/run_apar.py`
  WHY IT EXISTS: The verification. It produces every number the checkpoint asks
    for and the plot that shows the suppression working.
  WHAT IT DOES: Runs the six rules over the fault-free year, the three faulted
    AHU scenarios and the clean scenario; prints per-rule evaluation counts,
    firings and reports; computes false positives per asset-day on the fault-free
    windows only; then counts firings landing inside any post-transition
    suppression window and draws them against the mode changes.
  CHOICES: The window boundaries are stated by the operator, not read from the
    answer key — this script connects as the restricted role and could not read
    it. The labels name the windows in the report and decide which count as
    fault-free; nothing in the detection path consumes them.

### MEASURED RESULT

False positives, the headline number:

    lbnl-fault-free-year     0 reported over 365 days = 0.0000 per asset-day
    clean_ahu                0 reported over 120 days = 0.0000 per asset-day

Across 485 fault-free asset-days, not one rule reported. On the fault-free year
the six rules were evaluated 163,895 times between them and the condition was
never true, not merely never sustained.

Transient suppression:

    firings inside a 60-minute post-transition window: 0, across 39 transitions
    occupied time surviving suppression: 82.8% to 87.2% depending on scenario

Detection, one of three air-side faults caught:

    ahu_sat_sensor_drift   apar-20 reported 918 times (7.65/day), peak severity 1.00
                           apar-7  reported  42 times (0.35/day), peak severity 0.74
                           9 episodes, the longest 141 samples
    ahu_cooling_valve_leakage   nothing reported
    ahu_oa_damper_stuck         nothing reported

### THE TWO MISSES, AND WHY THEY ARE NOT BUGS

**Outdoor air damper stuck — the mode gate routes evaluation away from the rule.**
Rule 18 is the rule for this fault and its evidence is overwhelming: with the
damper seized at 0.750 the measured outdoor air fraction is 0.675 against an
expected 0.016, a gap of 0.659 which is more than twice the rule's threshold. It
never gets the chance. The mode classifier reads the same damper, sees it well
above the economizer margin, and concludes the unit is economizing — so the unit
spends 11.7% of occupied time in minimum-outdoor-air cooling during the fault
against 92.5% when healthy, and rule 18 only ever evaluates during the three
weeks before onset, where it correctly stays silent.

This is a structural limitation of mode-gated detection, not a threshold that
needs moving: the operating mode is inferred from the very actuator that is
broken, so the fault disguises itself as a control decision. The detector that
does not have this problem is a comparison of damper COMMAND against damper
POSITION — the dataset carries both — but that is not one of the 28 APAR rules
and does not belong in this module.

**Cooling coil valve leaking — the fault is smaller than APAR's noise floor, and
out of season.** Rule 7 is the rule for this fault, and it only applies while the
unit is cooling with outdoor air, because that is the only state in which the
coil is supposed to be doing nothing. Two things compound. Free cooling in that
scenario's window runs from 25 February to 20 March; the fault is injected on 17
March and does not reach full severity until 1 May, so only three days of
admissible time overlap the fault at all, and those three days are its weakest.
Second, even there the quantity the rule tests peaks at 0.43 degC against a
threshold of 2.0 — 22% of the way. Once the season turns, the coil is supposed to
be cooling, and extra cooling from a leaking valve is indistinguishable from the
coil doing its job.

Both misses say the same thing: APAR is a conservative, in-balance test that
trades sensitivity for silence, and it earns its zero false alarms honestly. The
faults it cannot see are the ones the condition-normalised baselines and the
cross-sensor residuals are for.

START HERE: `analytics/rules/apar.py` — the module docstring is the checkpoint;
the six rules under it are a direct transcription of Table 2.1.

## Checkpoint 3.4 — Chiller rules

### WHAT WE DID

The chillers can now be judged on their own performance rather than on a fixed
efficiency number. A chiller's power draw depends far more on what is being asked
of it than on its condition — the same healthy machine uses a third more energy
per unit of cooling on a hot afternoon than on a mild morning, because the
compressor has to push heat across a much bigger temperature gap. Comparing a raw
efficiency figure against a constant therefore flags every hot day and misses
every mild one, and that single mistake is the most common reason chiller fault
detection produces alarms nobody believes.

Every rule here first works out what a healthy machine WOULD have done at this
exact operating point — this load, this temperature gap, these water
temperatures — and then reports only what is left over. Fitted on fault-free
operation and run against the injected faults, the result is 7,183 reports on
condenser fouling and 25,656 on a leaking bypass valve, against zero reports
across 605 days of fault-free running.

The fault the project holds back for later — cooling tower fouling — produced
zero reports, which was checked explicitly rather than assumed.

### HOW IT WORKS

`analytics/rules/chiller.py` — module docstring
  WHY IT EXISTS: The checkpoint asks for condenser and evaporator approach
    temperatures, and this plant cannot compute them. That has to be said clearly
    rather than quietly worked around.
  WHAT IT DOES: Records that approach temperature is the gap between the
    refrigerant's saturation temperature and the water, that all 78 published
    columns are water and air side with no refrigerant instrumentation anywhere,
    and that the saturation temperature cannot be recovered from what is left.
    Each heat exchanger gives one equation in two unknowns, and the water-side
    energy balance supplies no second equation because it is an identity.
  CHOICES: It also records why the obvious escape fails. Assuming a design heat
    transfer coefficient and solving for the saturation temperature yields a
    fixed function of the measured water temperatures; fouling changes the real
    coefficient, which that assumption has already frozen, so the resulting
    "approach" cannot move in response to the fault it exists to catch. Two rules
    that look right and detect nothing are worse than two honest substitutes.

`analytics/rules/chiller.py` — the held-out fault
  WHY IT EXISTS: Task 8 needs a fault that no rule was ever written for.
  WHAT IT DOES: States that no rule tests for non-condensable gas, and then says
    two things the instruction assumed but the data does not support: the LBNL
    chiller dataset contains no non-condensable gas run and no refrigerant leak
    run at all — it ships 23 fault runs and neither is among them — and the fault
    this project actually holds out is cooling tower fouling, chosen back in
    checkpoint 2.4. The instruction is honoured against that instead: no rule
    references a cooling tower point, a tower approach, or the wet bulb
    temperature.

`analytics/rules/chiller.py :: POWER_MODEL` and `predicted_kw`
  WHY IT EXISTS: The baseline the efficiency rule measures against. Without it
    there is nothing to compare a kilowatt to.
  WHAT IT DOES: A least-squares quadratic surface giving the power a healthy
    machine draws for a given cooling output and a given temperature gap between
    the two water loops. Fitted across the 38,407 running samples of the
    fault-free year for chillers 1 and 2.
  CHOICES: Power is modelled, not efficiency. An earlier version fitted
    efficiency directly and reached a correlation of 0.73, because efficiency
    climbs steeply as load falls toward zero and no polynomial in load follows
    that shape. Modelling power and dividing afterwards reaches 0.98 and cuts the
    residual scatter from 0.295 to 0.110. Chiller 3 runs for 456 samples in the
    whole year and is not represented in the fit; that is reported rather than
    papered over.

`analytics/rules/chiller.py :: LIFT_MODEL` and `predicted_lift`
  WHY IT EXISTS: The condenser-side check. Efficiency tells you the machine is
    working too hard; this says whether the temperature gap it is working against
    is bigger than the conditions justify.
  WHAT IT DOES: Predicts the temperature gap between the water leaving the
    condenser and the water leaving the evaporator, from the cooling output, the
    condenser water arriving from the tower, and the chilled water leaving.
  ⚠ JUDGEMENT CALL: Chilled water supply is one of the inputs, and adding it was
    not obvious. The first version matched only on load and entering condenser
    water, and the residual moved the WRONG WAY under condenser fouling — minus
    0.53 K where physics says it should rise. The reason is that a fouled chiller
    loses a little grip on its chilled water setpoint, the chilled water drifts
    up, and because the gap is measured down to that water the drift cancels the
    condenser effect. Matching on it restores the correct sign. This is the same
    principle the checkpoint states for efficiency — compare only at matched
    conditions — applied to one more condition than was asked for.

`analytics/rules/chiller.py` — thresholds
  WHY IT EXISTS: Every limit has to come from somewhere that is not the answer
    key.
  WHAT IT DOES: Both residual limits are three standard deviations of the
    residual scatter on fault-free operation — 0.330 kW per ton and 1.08 K.
  CHOICES: Three standard deviations is the ordinary statistical process control
    limit and is used for that reason: it fixes a false alarm rate from healthy
    data alone. No fault label was read, and neither limit was adjusted after
    seeing whether a fault crossed it. The capacity limit of 2.0 K is set the same
    way — fault-free operation at full compressor command sits 0.22 K above
    setpoint on average and reaches 1.505 K at the 99th percentile.

`analytics/rules/chiller.py :: kw_per_ton_residual`
  WHY IT EXISTS: The primary detector, and the one the checkpoint specifies
    exactly.
  WHAT IT DOES: Computes the cooling actually delivered from the chilled water
    flow and its temperature drop, works out what the compressor should be drawing
    at that output and that temperature gap, and reports the difference per unit
    of cooling. Skips anything under 20 tons, about an eighth of capacity, where
    dividing by a small number swamps everything.
  CHOICES: Rules read their points through the asset identifier rather than
    naming chiller-1 directly, so one registration covers all three machines.

`analytics/rules/chiller.py :: capacity_shortfall`
  WHY IT EXISTS: The evaporator-side check. A machine can be efficient and still
    be failing, if it simply cannot make the water cold enough.
  WHAT IT DOES: Reports when the chilled water leaving the chiller sits more than
    2 K above its setpoint while the compressor is already at 95% of full
    command. Both halves are needed: water above setpoint with capacity in
    reserve is the control still working, not a fault.
  CHOICES: Claims the staleness exemption for the compressor command, for the
    same reason the air handler's saturated cooling valve does — a compressor
    pinned at full command has by definition stopped moving, and the pinning is
    the evidence.

`analytics/rules/evaluate.py :: suppression_mask`
  CHANGED FROM BEFORE: The idle state is now a parameter rather than the
    hardcoded unoccupied. A chiller has no occupancy schedule, but the settling
    physics is identical — neither machine is in balance for the first hour after
    it starts — so the same delays apply with only the name of the idle state
    changed.

`scripts/run_chiller_rules.py :: chiller_state`
  WHY IT EXISTS: The suppression needs to know when a chiller starts, and the
    status point cannot tell it.
  WHAT IT DOES: Calls a chiller running only when its status is on AND it is
    drawing real power AND it is moving chilled water. All three are required
    because chiller 1's status point sits at 1 for the entire year, so on its own
    it would never mark the machine as off and the start-up delay would never
    fire once.

### MEASURED RESULT

    window                                reported   per asset-day
    lbnl-fault-free-year                         0          0.0000
    chiller_condenser_fouling                7,183         59.8583
    chiller_bypass_valve_leakage            25,656        213.8000
    cooling_tower_fouling  [HELD OUT]            0          0.0000
    clean_chiller                                0          0.0000

    FALSE POSITIVES, all fault-free windows combined:
        0 reported over 605 asset-days = 0.0000 per asset-day

Condenser fouling, chiller 1: the efficiency residual reported 5,863 times at
48.86 per day with peak severity 1.00, and the capacity shortfall 1,320 times at
11.0 per day. Both confirm the fault the checkpoint asks to see fire.

Which rule catches which fault turns out to matter:

    rule                        condenser fouling   bypass valve leaking
    kw-per-ton-residual              5,863                    292
    capacity-shortfall               1,320                 24,441
    excess-lift                          0                    923

The condenser-side lift rule does NOT catch condenser fouling — 76 instants where
the condition was momentarily true, none of them sustained for the required hour.
That was known before it was written: measured against the matched clean
scenario, condenser fouling moves the lift residual by 0.15 K against 0.36 K of
healthy scatter, about 0.4 standard deviations, while it moves the efficiency
residual by roughly four. The rule earns its place on a different failure mode —
it is the one that fires hardest on a leaking bypass valve, which is a condenser
water flow disturbance rather than a heat transfer one.

This is worth stating plainly because it is a physical result, not a tuning
problem: **in this dataset condenser fouling is carried almost entirely by
compressor power and is very nearly invisible in the water temperatures.** The
simulation's fouled condenser raises the refrigerant's condensing temperature,
which the compressor pays for, while the water-side heat balance stays
consistent. It is the clearest possible argument for why the checkpoint insisted
on an efficiency residual at matched conditions rather than a temperature check.

### HELD-OUT FAULT, CONFIRMED

    cooling tower fouling produced 0 rule reports over 120 days

One nuance worth recording rather than hiding. The conditions were momentarily
true during that window — 54 instants on the lift rule and 65 on the efficiency
rule, one of them reaching severity 1.00 — but none held for the hour required
before a report. Tower fouling does perturb chiller efficiency, because a fouled
tower delivers warmer condenser water and the chiller pays for it, so the fault
is not completely invisible to rules written about a different machine. What
matters for Task 8 is that no rule was written for it and none reported it, and
both are true.

START HERE: `analytics/rules/chiller.py` — the module docstring explains what
could not be built and why; the three rules under it are what replaced it.

## Checkpoint 3.5 — Constraint residuals

### WHAT WE DID

The platform can now measure how far the building is from obeying its own
physics. Checkpoint 2.2 wrote down five statements that must be true if every
sensor is telling the truth — the air leaving a mixing box must be the blend of
the two streams entering it, the heat a chiller throws away must equal the heat
it removed plus the work its compressor did, and so on. Until now those were
prose attached to the model. They are now evaluated against every reading and
the leftover is stored.

The distinction from a rule matters. A rule says a machine is behaving badly. A
residual says a group of readings cannot all be true at once, WITHOUT yet saying
which of them is lying. That ambiguity is deliberate and is the input the
sensor-versus-equipment discrimination in Task 5 is built from: a failed sensor
breaks every statement it appears in and leaves the others untouched, whereas a
failed machine drags whole groups of statements together.

Running it exposed something the rule engine could not: the supply air
temperature sensor drift, which every APAR rule missed except through its
knock-on effect on the cooling valve, shows up directly here as a 1.37 degree
shift in the coil energy balance.

### HOW IT WORKS

`scripts/schema.sql :: app.constraint_residuals`
  WHY IT EXISTS: The residuals are a time series in their own right and every
    later layer joins against them.
  WHAT IT DOES: One row per constraint per instant, holding the raw imbalance in
    its natural unit, the same number restated as a robust standard score, the
    unit, and the worst quality score among the readings that went into it.
  CHOICES: A hypertable with seven-day chunks rather than the measurements'
    one-day chunks — five constraints produce about half a million rows a year
    against a hundred million, so day-sized chunks would be mostly empty.
    input_quality is stored because a residual is only as trustworthy as its
    worst input, and without it a diagnosis cannot tell a genuine violation of
    physics from one sensor having died.

`analytics/rules/constraints.py :: parse_expression`
  WHY IT EXISTS: The expressions in the model are written over point identifiers
    like {ahu-1.ma_temp}, which contain dots and hyphens and so cannot be
    variable names.
  WHAT IT DOES: Replaces each brace-delimited identifier with a positional
    placeholder, remembering the order, then parses the result and walks every
    node of the syntax tree checking it against a whitelist before compiling it.
  ⚠ JUDGEMENT CALL: The whitelist admits only arithmetic — addition,
    subtraction, multiplication, division, powers, unary signs, numbers and the
    generated placeholders. No function calls, no attribute access, no
    subscripts. These expressions come from a file this project controls, so
    nothing hostile is expected, but they are still text being turned into
    executable code and the check costs nothing. Widening it has to be a
    deliberate act rather than something that happens by accident when someone
    puts a square root in a .ttl file.

`analytics/rules/constraints.py :: manifest_column_to_point`
  WHY IT EXISTS: The model declares which points a constraint depends on using
    graph node names, while the expression names them using database point
    identifiers. Checking that the two agree needs a dictionary between them.
  WHAT IT DOES: Reads the ingestion manifests, the one place the mapping from a
    source file's column to a database point is actually recorded.
  ⚠ JUDGEMENT CALL: Keyed on the system as well as the column name, which the
    first version was not, and the cross-check immediately caught the mistake.
    Column names are only unique within a file: OA_TEMP exists in both datasets
    and means different things in each — outdoor dry bulb on the air handler,
    and on the chiller plant a column that actually holds wet bulb, which the
    manifest un-swaps. Keyed on the column alone, the air handler's outdoor air
    temperature silently resolved to the chiller plant's wet bulb and the
    cross-check reported a discrepancy that did not exist.

`analytics/rules/constraints.py :: RUN_GATES`
  WHY IT EXISTS: A constraint is only a statement about physics while the
    equipment is running.
  WHAT IT DOES: Names, per constraint, the points that must all be above a
    threshold before an instant is evaluated. A mixing box that is switched off
    has no airflow, so its "mixed air temperature" is the temperature of still
    air in a box and balances nothing.
  CHOICES: The chiller gates test power as well as status, because chiller 1's
    status point reads 1 for the whole year and on its own would gate nothing.

`analytics/rules/constraints.py :: evaluate`
  WHY IT EXISTS: Turns one compiled expression into a column of numbers.
  WHAT IT DOES: Substitutes each point's readings as an array, evaluates the
    expression once across the whole window, then drops any instant where an
    input was missing, the arithmetic produced infinity, or the run gate was
    shut. A residual nobody can compute is absent from the table, not zero — the
    two mean completely different things to anything reading it later.

`analytics/rules/constraints.py :: fit_baseline` and `normalise`
  WHY IT EXISTS: The raw residuals are not comparable with each other. One is in
    degrees and sits near zero; another is in watts and sits near minus eighty
    thousand. A diagnosis has to rank them against each other.
  WHAT IT DOES: Takes each constraint's fault-free behaviour, subtracts its
    median and divides by a spread estimated from the median absolute deviation,
    so every constraint is restated in the same currency: how unusual is this,
    for this constraint.
  CHOICES: Median and median absolute deviation rather than mean and standard
    deviation. The fault-free run is fault-free by label rather than by
    inspection — it still contains startup transients and occasional excursions —
    and one of those is enough to inflate a standard deviation so far that every
    real deviation measured against it afterwards disappears.

`analytics/rules/constraints.py :: write_residuals`
  WHAT IT DOES: Deletes the constraint's rows over the window and streams the new
    ones in, in one transaction. Same reasoning as every other derived table
    here: these rows are a function of the measurements and the model, and a
    stale one describes a building that no longer exists.

`scripts/plot_residuals.py`
  WHY IT EXISTS: The verification.
  WHAT IT DOES: Draws both air-side constraints over the fault-free year as a
    daily median with an interquartile band, and over the drift scenario with the
    matched clean scenario overlaid, then prints the numbers.
  CHOICES: Compares the drift against the clean run occupying the SAME calendar
    window in a different year, rather than against the fault-free year. The
    fault-free year is all twelve months and the scenarios are late May to late
    September; comparing them directly would report a season as if it were a
    fault.

### MEASURED RESULT

    constraint          window                    n       mean    median      p95   |norm| p95
    MixedAirBalance     fault-free year      55,728    +1.053    +0.426   +3.673        2.54
    MixedAirBalance     clean_ahu            18,576    -0.184    -0.180   +0.403        0.95
    MixedAirBalance     ahu_sat_sensor_drift 18,576    -0.224    -0.216   +0.347        0.96
                        SHIFT drift vs matched clean   -0.036 degC

    CoilEnergyBalance   fault-free year      55,728    +0.919    +0.532   +3.153        1.52
    CoilEnergyBalance   clean_ahu            15,792    +0.867    +0.782   +3.004        1.44
    CoilEnergyBalance   ahu_sat_sensor_drift 15,792    -0.509    -0.590   +2.557        2.58
                        SHIFT drift vs matched clean   -1.372 degC

500,810 residual rows written across the two spans in 1.1 minutes.

Baselines fitted on the fault-free year:

    ChillerEnergyBalance_1   centre     -1414.0 W   scale     120.4 W   99,528 samples
    ChillerEnergyBalance_2   centre    -84289.0 W   scale   29421.6 W   12,901 samples
    ChillerEnergyBalance_3   centre    -83262.3 W   scale   15434.8 W      456 samples
    CoilEnergyBalance        centre        +0.53 degC  scale    1.73 degC 55,728 samples
    MixedAirBalance          centre        +0.43 degC  scale    1.28 degC 55,728 samples

### THE VERIFICATION ASKS FOR THE WRONG CONSTRAINT

The checkpoint asks for the mixed air balance to sit near zero on fault-free data
and to diverge on the supply air sensor drift. The first half holds. The second
cannot, and the reason is visible in the expression itself:

    MixedAirBalance = ma_temp - (oa_damper * oa_temp + (1 - oa_damper) * ra_temp)

Supply air temperature does not appear. The mixed air balance reads mixed,
outdoor and return air and the damper position, and a drifting supply air sensor
is downstream of all four. Measured against its matched clean run the mixed air
residual moves by 0.036 degC, which is nothing.

The constraint that DOES contain supply air temperature is the coil energy
balance, and it moves by 1.372 degC — from +0.782 on the clean run to -0.590 on
the drift, a sign change, with the p95 normalised deviation rising from 1.44 to
2.58. So the capability the checkpoint is testing for is present and works; it is
carried by the other constraint. Both are plotted rather than just the one asked
for, so the contrast is visible.

This is the layer that finally sees this fault. Checkpoint 3.3 reported that the
APAR rules caught the drift only through its knock-on effect on the cooling
valve, and predicted the residuals would catch it directly. They do.

### TWO DEFECTS IN THE 2.2 MODEL THAT THIS CHECKPOINT EXPOSES

**The mixed air balance assumes a linear damper, and this one is not.** The
expression uses damper POSITION where the physics needs outdoor air FRACTION,
treating them as the same number. Measured on the fault-free year with the fan
running:

    damper 0.100  ->  true outdoor air fraction 0.016
    damper 0.187  ->  0.027
    damper 0.585  ->  0.373
    damper 0.712  ->  0.609

The two converge near full open and diverge by a factor of six near the minimum
position, which is the ordinary characteristic of a damper blade. The consequence
is that the raw residual carries a bias that varies with damper position and with
the gap between outdoor and return air: over the fault-free year with the fan
running it averages +1.053 degC rather than zero, reaching +3.673 at the 95th
percentile. The normalisation absorbs the average of that bias but not its
variation with operating condition, which is a condition-normalised baseline and
therefore Task 4's job.

The expression was left exactly as the model declares it. Rewriting it here would
mean calibrating a damper curve against fault-free data, and a constraint
calibrated to be satisfied is a constraint that can no longer detect the thing it
was calibrated on.

**The coil energy balance declares a point it never reads.** The model lists five
member points for it but the expression uses four; chw-plant-1.sec_return_temp is
declared and never appears. Harmless to the arithmetic, but the declared
membership is what Task 5 will use to work out which sensors a residual depends
on, and an over-broad declaration would make it think that sensor influences a
number it cannot touch. One triple to fix in extensions.ttl.

### A THIRD THING WORTH KNOWING BEFORE TASK 5

The chiller energy balance normalisation saturates. Chiller 1's fault-free
residual sits at -1414 W with a spread of only 120 W — the balance is
consistently wrong by a fixed amount and very precisely so — so the scenario
era's median of -30,473 W comes out at roughly 240 standard deviations, and the
95th percentile of the absolute normalised value reaches 1288. Chiller 2, which
runs intermittently, has a spread of 29,422 W and never exceeds about 2.5.

Both numbers are arithmetically correct. They are not comparable with each other,
and anything that combines constraints by summing normalised scores will be
entirely dominated by chiller 1. The underlying cause is the non-closure of the
chiller energy balance already recorded in checkpoint 2.2, and the fix is a
condition-normalised baseline rather than a single median and spread.

START HERE: `analytics/rules/constraints.py` — `parse_expression` and `evaluate`
are the whole mechanism; everything else is configuration and storage.

## Checkpoint 3.6 — Decision log

### WHAT WE DID

The decision log now covers the rule engine, which was the largest architectural
choice in this task and the one that determines what a third piece of equipment
will cost. The entry on the semantic model is also closed out, because the thing
it was waiting for happened earlier and differently than expected.

Separately, one small defect in the semantic model found by the previous
checkpoint was corrected: a constraint claimed to depend on a sensor its
arithmetic never touches.

### HOW IT WORKS

`model/extensions.ttl :: mvn:CoilEnergyBalance`
  WHY IT EXISTS: The model declares which sensors each physical constraint
    depends on. Task 5 will use those declarations to work out which readings
    could have moved a residual, so an over-broad declaration would send it
    looking at a sensor that cannot possibly be responsible.
  CHANGED FROM BEFORE: Five member points were declared and only four were read.
    The extra one was the secondary loop RETURN water temperature; the expression
    needs the water going TO the coil, and because the source dataset crosses
    that pair, the supply water arrives in the column named RW. The declaration
    now lists four members and the cross-check that found it is silent.

`AI_LOG.md :: D-04 Outcome`
  WHY IT EXISTS: The entry predicted the Brick decision would not be tested until
    cross-asset diagnosis in Task 6. That prediction was wrong and the log should
    say so.
  WHAT IT DOES: Records that the graph was tested in Task 3 instead, by rule
    dispatch, and on precisely the capability a hand-built schema could not have
    provided — a rule written against one class name matching equipment recorded
    under another, resolved through an equivalence Brick declares and the LBNL
    files do not. Records what using it cost against what adopting it cost, and
    that the constraint expressions live in the graph so 500,810 residual rows
    were produced with no physics in the Python.
  ⚠ JUDGEMENT CALL: The outcome also records a failure that reflects badly on
    the entry above it. D-04 credits the decision to give each source system its
    own namespace, on the grounds that both files define OA_TEMP and the two are
    different instruments. That held in the model — and then the same trap caught
    me one layer up in checkpoint 3.5, where the dictionary translating graph
    names back to database identifiers was keyed on the column name alone and
    silently resolved the air handler's dry bulb to the chiller plant's wet bulb.
    Being right about namespacing in the model does not inoculate the code that
    reads the model. A log that only records the decisions that worked is
    marketing.

`AI_LOG.md :: D-05`
  WHY IT EXISTS: The rule engine's central choice — where a machine's identity
    enters the system.
  WHAT IT DOES: Sets out the three options the checkpoint names, argues for the
    class-keyed registry, and backs the argument with the measured cost of the
    second equipment class rather than an estimate.
  CHOICES: The rationale rests on one number. Adding the chiller — three rules,
    its own baselines, and a completely different notion of when the machine is
    running — changed 346 new lines of chiller physics, 24 lines in the shared
    evaluator, and ZERO lines in the dispatcher. The 24 lines are one parameter:
    an air handler is idle when the building is empty and a chiller is idle when
    it is not running, so the name of the idle state became an argument. That is
    what a new equipment class costs here, and it is the number the per-asset
    option could not have produced.
  ⚠ JUDGEMENT CALL: On rejecting the rules DSL, the entry argues the position was
    not "no DSL ever" but "a DSL for arithmetic, not for control flow" — and
    points at checkpoint 3.5, where a narrow one did earn its place because the
    constraint expressions are arithmetic only and buy a real property. Recording
    a rejected option that was then partially adopted elsewhere is more useful
    than pretending the two decisions were unrelated.

`AI_LOG.md :: D-05 Overrode`
  WHY IT EXISTS: A field the earlier entries do not have, added because this
    checkpoint asks for it: where my recommendation was overruled.
  WHAT IT DOES: Records both cases from this task. The package name, where
    `platform/` turned out to be unusable, I recommended `aqueduct/` and was
    overruled in favour of `analytics/` — no consequence, aesthetic either way.
    And the quality scoring scope, where I recommended scoring only the
    synthesised scenarios and was overruled in favour of including the fault-free
    LBNL year as well.
  CHOICES: The second override is recorded as having been RIGHT, and my
    recommendation as having been wrong in a way that would have caused rework.
    The fault-free year became the baseline for the chiller design curves in 3.4
    and the residual normalisation in 3.5, and both need quality scores attached
    to their baseline data. My cost estimate was pessimistic too — 50 to 70
    minutes projected against 17.3 actual.

`AI_LOG.md :: D-01 Outcome`
  WHY IT EXISTS: The entry carried a caveat that the one-day chunk interval was
    "workable but at the high end", and that planning cost would grow with chunk
    count. That prediction came true with a number large enough to constrain the
    design of the API.
  WHAT IT DOES: Records that the database choice itself was right and delivered
    what it was picked for, and then that the chunk interval was not. The quality
    scorer's write-back joins a staging table against the measurements on point
    and timestamp, which gives the planner nothing to exclude chunks by, so it
    planned across all 5,077 chunks to change 267,840 rows: 36,750 ms of planning
    on top of 296,200 ms of execution, 5 minutes 33 seconds in total, against
    7,850 ms once the time range is restated. A factor of 42.
  CHOICES: Recorded explicitly as debt rather than as a solved problem. The fix
    applied in 3.1 is one redundant-looking predicate in one statement; nothing
    stops the next query from omitting it, and the penalty for forgetting looks
    like a hang rather than an error. The real fix needs the hypertable rebuilt,
    because the chunk interval only applies to chunks created after it changes —
    a reload, a scenario re-run and a re-score, roughly an hour, which was not
    paid. The entry says so rather than leaving the decision implicit.
  ⚠ JUDGEMENT CALL: The outcome also argues the interval is not wrong in
    general, only wrong here: a one-day chunk suits a real building, and this
    table only reaches 5,077 chunks because it holds 7,936 days of simulated
    time. A real three-year deployment at the same cadence would have produced
    about 1,100 and none of this would have surfaced. Saying that matters because
    the naive lesson — never use daily chunks — is the wrong one to carry
    forward.

### MEASURED RESULT

- Five entries, each carrying all six required subsections: 5, 5, 5, 5, 5, 5.
- The Overrode field appears once, on D-05, as specified.
- Numbered D-05, not D-04 as the checkpoint said, because D-04 is already the
  Brick entry written in checkpoint 2.5. The outcomes filled in are D-04's, which
  is the one now genuinely testable, and D-01's, rather than D-03's, which was
  filled in at 2.5 already.
- No outcome is left open. All five entries now carry one.
- The constraint member cross-check, which reported one discrepancy before this
  checkpoint, now reports none. Stored residuals are unaffected — they are
  computed from the expression, not from the declared membership, so no
  re-evaluation was needed.

START HERE: `AI_LOG.md` — two sections earn the read. The Overrode section of
D-05 is the only place in the log where a recommendation of mine is recorded as
having been overruled and the overrule as having been correct. The Outcome of
D-01 is the one piece of live technical debt the project is carrying, with the
measurement that quantifies it and the hour it would cost to clear.

## Checkpoint 4.1 — Condition-normalised baselines, air handler only

### WHAT WE DID

The system can now say what a healthy air handler *should* be doing right now,
given what is being asked of it, and report how far the real one is from that.
Before this it could only compare readings against fixed limits. That difference
matters because almost every quantity worth watching moves far more with
operating conditions than with equipment health: a supply fan drawing 900 watts
is alarming at half airflow and unremarkable at full airflow, so a fixed limit
fires on the busy afternoon rather than on the failing bearing, and a team fed
those alerts stops reading them.

Two models are fitted, one for fan electrical power and one for supply air
temperature, using three weeks of operation at the start of each run as the
definition of healthy. Both are written in the form of the physics the equipment
actually obeys rather than as generic curve fits, so their coefficients are
readable quantities — coil authority, fan temperature rise — and they behave
sensibly just outside the conditions they were fitted on. The gap between what
each model expects and what the sensors report is stored for every instant the
unit is running, and that gap, not the raw reading, is what the health index and
the remaining-life prediction will consume.

### HOW IT WORKS

    scripts/schema.sql :: app.residuals
      WHY IT EXISTS: The store every layer above the baselines reads from. A raw
        supply air temperature of 15 degrees means nothing on its own; the same
        number is correct on a mild morning and alarming on a hot afternoon. Once
        the operating conditions have been subtracted out, a number near zero
        means the equipment is doing what its own commissioning data says it
        should, whatever the weather is doing, and that is a statement the health
        index can act on.
      WHAT IT DOES: One row per modelled point per instant, holding the
        observation, what the baseline predicted, the difference, the difference
        restated in standard deviations of the model's own error, and the worst
        quality score among the inputs. Both the observation and the prediction
        are kept, not just the difference, because an engineer asked to trust a
        residual will want to see the two numbers that produced it.
      CHOICES: baseline_id is part of the unique key alongside point and time, so
        a point can carry more than one model without the second silently
        overwriting the first. Seven-day chunks, not the one-day interval
        app.measurements uses — that interval is the debt recorded in AI_LOG.md
        D-01, and this table starts on the right side of it. 163,374 rows land in
        72 chunks across the four runs; a one-day interval would have made 480.

    analytics/baselines/fit.py :: AHU_SPANS and COMMISSIONING_DAYS
      WHY IT EXISTS: A baseline has to be fitted on data somebody is willing to
        call healthy, and something has to say which data that is. In a real
        building it is "the unit was serviced on this date"; here it is
        configuration.
      WHAT IT DOES: Names the air handler's four 120-day runs with their start
        and end, and sets the commissioning window to the first 21 days of each.
        One set of baselines is fitted per run and applied across that run only.
      CHOICES: 21 days at a five-minute cadence gives about 3,100 to 3,800 usable
        samples against three or four fitted parameters, which is ample. Fitting
        per run rather than once globally is what makes a residual a statement
        about drift WITHIN a run — each run starts from its own zero, so a
        residual that grows means the equipment has moved away from where it was
        three weeks ago, not that two runs were simulated in different seasons.
      ⚠ JUDGEMENT CALL: These windows coincide exactly with the pre-onset period
        of each scenario, because that is how the scenarios were built, and that
        is said plainly in the module docstring rather than left to be noticed.
        The declaration is an input to the system, not an answer: it says nothing
        about which fault is coming or whether one is coming at all, and the
        clean run carries the identical declaration. Nothing in the module reads
        schema groundtruth, and nothing reads onset, fault mode or severity
        waypoints from the scenario manifests. The alternative was to discover
        run boundaries from gaps in the data and take the first three weeks of
        each, which reaches the same four windows without naming them; it was
        rejected as machinery for its own sake, since the dates are already
        hardcoded the same way in the quality scorer and the constraint
        evaluator.

    analytics/baselines/fit.py :: CHILLED_WATER_SUPPLY_C
      WHY IT EXISTS: The coil model needs a cold-side temperature or it has no
        driving temperature difference to work with. The air handler does not
        measure one. The LBNL single-duct dataset publishes 30 columns and not
        one is water side — the coil is instrumented with a valve position and
        nothing else.
      WHAT IT DOES: Stands in a constant 6.7 degC wherever the chilled water
        supply temperature would appear.
      CHOICES: It costs very little, and that was measured rather than assumed:
        sweeping the assumed value from 4 to 8 degC moves the fit R-squared by
        less than 0.003 and the residual spread by 0.02 K, because the
        effectiveness coefficients rescale to absorb whatever value is chosen.
        6.7 degC is the standard design chilled water supply temperature for
        commercial coils, and the chiller plant in this same project holds its
        own primary supply setpoint between 6.67 and 6.74 degC.
      ⚠ JUDGEMENT CALL: The rejected alternative was joining the chiller plant's
        measured supply temperature. Two of the four air-handler runs begin
        before the chiller data exists at all — the air handler record starts
        2036-02-25 and the chiller record starts 2036-05-10 — and the two
        datasets are independent LBNL simulations of different buildings, so the
        join would assert a water connection that is not there. Raised and
        confirmed before implementing.

    analytics/baselines/fit.py :: RUN_GATE_POINT
      WHY IT EXISTS: A baseline must only be fitted on instants when the machine
        was actually running. A stopped fan draws no power and a coil with no air
        over it has no supply temperature, and letting those rows into the fit
        would define healthy as mostly-switched-off.
      WHAT IT DOES: Gates on the supply fan's speed command being off its stop,
        at 0.05.
      ⚠ JUDGEMENT CALL: Deliberately NOT ahu-1.sf_status, which the rest of the
        project uses. That point is not a fan status despite its name. It is
        byte for byte identical to ahu-1.occupancy across all 138,240 samples of
        the record — zero differing — and the fan runs during morning pull-down
        while it still reads zero, 7,686 samples or 5.6 percent of the record.
        Gating on it drops every start-up and every after-hours run out of the
        fit. Checked against the speed command, which agrees with fan power
        exactly: both select the same 3,780 running samples in the clean
        commissioning window, where sf_status selects 3,276.

    analytics/baselines/fit.py :: load_ahu_frame(conn, t_from, t_to)
      WHY IT EXISTS: Pulls every point the two models need in one query and hands
        back usable quality scores alongside the values, so no caller has to
        remember to fetch trust separately from data.
      WHAT IT DOES: Reads the six model points plus the run gate over a window,
        pivots them into a frame indexed by time, then recomputes every quality
        score with the staleness dimension discounted.
      CHOICES: Staleness is discounted because it says a reading stopped
        changing, not that it is wrong: a fan resting at full command for two
        hours is scored badly for not moving and is still a correct statement of
        where the fan is. This is not a general excuse — it was checked. Every
        reading scoring below 70 in these windows is below 70 for staleness
        alone, so judging on the raw composite would throw away real operating
        points and nothing else.

    analytics/baselines/fit.py :: fan_power_terms(flow, speed)
      WHY IT EXISTS: Builds the design matrix for fan power. Fan power is the
        quantity the bearing-degradation indicator in checkpoint 4.3 will be
        built on, so how well it is modelled sets the noise floor for detecting a
        worn fan.
      WHAT IT DOES: Returns three columns — speed cubed, speed squared times
        airflow, and speed times airflow squared — each of total degree three in
        speed and airflow jointly.
      CHOICES: This is the fan similarity law in its general form, which says the
        dimensionless power coefficient is a function of the flow coefficient,
        airflow divided by speed. Writing that function as a quadratic and
        clearing denominators gives exactly these three terms. No intercept: at
        zero speed the fan is stopped and draws nothing, and a fitted constant
        would let the model claim otherwise. Enforcing that costs 0.0008 of
        R-squared.
      ⚠ JUDGEMENT CALL: The checkpoint asked for fan kW as a function of airflow
        alone. That does not fit and cannot be made to. Airflow on its own
        explains 15 to 55 percent of fan power depending on the window and the
        fitted cubic coefficient comes out negative, which is physically
        impossible. The reason is that the affinity law "power goes as the cube
        of airflow" only holds along a FIXED system curve, and this is a
        variable-air-volume unit whose system curve moves every time a terminal
        box modulates. Adding speed takes R-squared from 0.146 to 0.989 on the
        same rows. Conditioning on speed does not hide fan degradation, because a
        worn bearing draws more power at matched speed AND flow. Raised and
        confirmed before implementing.

    analytics/baselines/fit.py :: supply_air_terms(mixed_air, valve, flow)
      WHY IT EXISTS: Builds the design matrix for the cooling coil. This is the
        model the coil leak-by indicator in checkpoint 4.3 rests on.
      WHAT IT DOES: A cooling coil is a heat exchanger, and the standard
        description of one is its effectiveness — the fraction of the available
        temperature difference it actually delivers. The available difference is
        between the air arriving at the coil and the water inside it, so the
        cooling delivered is effectiveness times the gap from mixed air
        temperature down to 6.7 degC, minus the heat the supply fan adds on the
        way out. Effectiveness itself is not constant: it rises as the valve
        opens and admits more water, and it falls as airflow rises, because
        faster air spends less time against the tubes. The three effectiveness
        columns are valve position, valve position squared and valve position
        times airflow, each multiplied by that temperature gap; the fourth column
        is a constant fan temperature rise.
      CHOICES: Every effectiveness term carries valve position as a factor, which
        forces effectiveness to zero when the valve is shut. A closed valve
        delivers no cooling, and a model free to disagree with that would absorb
        the coil-leak fault this baseline exists to expose. The fan rise is
        fitted rather than computed from fan power and airflow, because the
        published wattage and the published airflow are not on consistent scales
        in this dataset and the computed rise comes out roughly six times too
        small; fitted, it lands at 0.51 to 0.56 K in the winter windows, which
        matches the 0.50 to 0.55 K measured directly with the valve shut.
      CHOICES: Because the driving temperature difference enters multiplicatively
        rather than as another additive term, the model cannot predict cooling
        when there is nothing to cool with, and its error does not grow without
        bound outside the fitted range. That is the "sane extrapolation" the
        checkpoint asked for, and it is load-bearing: in the stuck-damper run
        32.5 percent of mixed air temperatures fall outside the fitted range,
        because the fault itself is what moves them there.

    analytics/baselines/fit.py :: fit_supply_air_temp(...)
      WHY IT EXISTS: Fits the coil model on one commissioning window.
      WHAT IT DOES: Selects running, complete, trustworthy rows; checks the valve
        actually moved during the window; then fits by ordinary least squares.
      CHOICES: Fitted on the cooling the coil delivers — mixed air temperature
        minus supply air temperature — rather than directly on supply air
        temperature. The two carry identical information, but supply air
        temperature is a controlled variable pinned near setpoint, so in a winter
        window it barely varies and an R-squared measured against it reports how
        flat the controller holds it rather than how good the model is. The same
        fit scores 0.859 against supply air temperature and 0.994 against coil
        duty in the February window. Duty has real range in every window, so the
        statistic means the same thing in all four.
      CHOICES: MIN_VALVE_RANGE of 0.10 refuses the fit if the valve never moved,
        because every effectiveness term is multiplied by valve position and a
        window with the valve always shut carries no information about coil
        authority at all. Not triggered by any of the four windows — the
        narrowest spans 0.69 — so it is a guard, not a filter.

    analytics/baselines/fit.py :: _solve(...)
      WHY IT EXISTS: The single place least squares is called, so every baseline
        reports the same statistics computed the same way.
      WHAT IT DOES: Solves for the coefficients, then measures R-squared, the
        standard deviation of the fit errors, and their median.
      CHOICES: The centre is a median and the scale is a plain standard
        deviation, and mixing the two is deliberate. The median guards the offset
        — a handful of start-up transients would drag a mean off zero and bake a
        permanent bias into every residual measured against it. The scale
        deliberately does NOT use a median absolute deviation, which is what the
        constraint residuals in checkpoint 3.5 use.
      CHANGED FROM BEFORE: The first version did use a median absolute deviation
        for the scale, for consistency with 3.5, and it was wrong. These error
        distributions mix two regimes — in steady operation the model is very
        accurate, in the minutes after a fan start it is not — and the measured
        kurtosis runs from 30 to 250 against 3 for a normal distribution. The
        robust estimator sees only the steady regime: on the clean window it
        reported a spread of 0.55 watts where the standard deviation reported 24.
        Normalising on that turned every ordinary morning start-up into a
        fifty-sigma event and put the clean run's 95th percentile at 53.9 sigma.
        On the standard deviation the same run sits at 1.23. The reason 3.5 goes
        the other way is that it has no fitted model and so no fit-error scale
        available, and has to estimate spread from the raw residuals themselves,
        where one excursion really would dominate.

    analytics/baselines/fit.py :: predict(baseline, values)
      WHY IT EXISTS: Applies a fitted baseline to arbitrary rows, which is what
        turns a fit into a continuously computed expectation.
      WHAT IT DOES: Rebuilds the design matrix from the drivers at each instant
        and multiplies by the coefficients. For the coil it converts back: the
        model predicts how much cooling the coil delivers, so the predicted
        supply air temperature is the measured mixed air temperature minus that
        cooling.

    analytics/baselines/residual.py :: compute(baseline, values, quality)
      WHY IT EXISTS: Produces the rows that everything downstream consumes.
      WHAT IT DOES: Predicts at every instant, subtracts prediction from
        observation, divides the result by the model's own error spread after
        removing its median offset, and records the worst quality score among the
        observation and every driver.
      CHOICES: Instants when the fan is off are dropped, not stored as zero.
        Recording a manufactured zero for every night would put a long flat run
        into the health index and flatten any real trend it was meant to see.
      CHOICES: Input quality is stored rather than used to filter. A residual
        computed from a doubtful reading stays visible downstream with its score
        attached instead of quietly vanishing, which is the same choice the
        constraint residuals make.

    analytics/baselines/residual.py :: write_residuals(...)
      WHY IT EXISTS: Puts the residuals in the database.
      WHAT IT DOES: Deletes this baseline's rows over the window, then binary
        COPYs the new ones.
      CHOICES: Deleted and rewritten rather than merged, like every other derived
        table here: these rows are a function of the measurements and the fitted
        model, so a row left over from a previous fit describes a baseline that
        no longer exists. Non-finite values are written as NULL rather than NaN,
        which is neither SQL nor a measurement.

    scripts/plot_baselines.py :: main()
      WHY IT EXISTS: The verification for this checkpoint.
      WHAT IT DOES: Refits every baseline on every run and prints R-squared and
        residual spread; summarises the stored residuals over each whole run;
        splits the coil-leak run at the end of its commissioning window to show
        before against after; and draws both baselines for the clean run beside
        the coil-leak run, with the fitted window shaded.
      CHOICES: Daily medians with an interquartile band rather than raw points —
        22,374 five-minute samples over four months is unreadable as a scatter,
        and the band keeps the spread visible rather than smoothing it away.

### MEASURED RESULT

Fits, one set per run, on the first 21 days of each:

    run                        baseline                     R2   resid sd  unit
    ahu_cooling_valve_leakage  fan-similarity          0.98909    20.6764  watt
    ahu_cooling_valve_leakage  coil-effectiveness      0.99395     0.2276  degC
    ahu_oa_damper_stuck        fan-similarity          0.97688    26.3223  watt
    ahu_oa_damper_stuck        coil-effectiveness      0.99588     0.2403  degC
    ahu_sat_sensor_drift       fan-similarity          0.98354    24.0224  watt
    ahu_sat_sensor_drift       coil-effectiveness      0.99094     0.2931  degC
    clean_ahu                  fan-similarity          0.98354    24.0224  watt
    clean_ahu                  coil-effectiveness      0.99094     0.2931  degC

The sat-drift and clean runs fit identically because both scenarios are built
from the same source window and neither has a fault injected during its first
21 days. That is a consistency check passing, not a duplicate.

Flat against drifting, measured as the swing in 30-day medians across each run
and expressed in that fit's own error spread:

    run                        baseline              swing    in sigma
    clean_ahu                  coil-effectiveness   0.027 K       0.09
    clean_ahu                  fan-similarity       0.824 W       0.03
    ahu_cooling_valve_leakage  coil-effectiveness   0.456 K       2.00
    ahu_cooling_valve_leakage  fan-similarity       3.669 W       0.18

The leak's coil residual runs +0.025, +0.118, -0.153, -0.338 degC across its
four 30-day windows: monotone downward after the commissioning window, and
negative, which is the right sign. A leaking valve admits chilled water the model
does not know about, so the air leaves colder than the model predicts; where the
coil is modulating, the controller closes the valve to compensate, the model sees
a smaller opening, predicts less cooling, and the residual goes negative by the
same mechanism.

The fan residual is the control. It barely moves on either run — 0.18 sigma on
the leaking run against 0.09 sigma for the coil on the clean one — which is what
rules out the coil drift being a generic seasonal or extrapolation artifact of
fitting on three weeks, since an artifact of the method would move both.

- 163,374 residual rows written across the four runs, in 13 seconds.
- Extrapolation beyond the fitted driver range is small on three runs: 0.2 to
  5.7 percent of samples outside the fitted range on the coil-leak run, 0.1 to
  4.9 percent on the two summer runs. On the stuck-damper run 32.5 percent of
  mixed air temperatures fall outside it, because the fault is what puts them
  there — the case the physics form was chosen to survive.
- 5.3 percent of the coil-leak run's fan residuals exceed 100 watts against 1.7
  percent on the clean run. Fan starts are over-represented among them by four
  times — 29 percent of the large residuals fall in the first hour after a start,
  which is 7 percent of the rows — so start transients account for part of it and
  not all of it. The daily medians are unaffected.

### FINDING, NOT PART OF THIS CHECKPOINT

`ahu-1.sf_status` is not a fan status. It is identical to `ahu-1.occupancy` in
all 138,240 samples, and the fan runs while it reads zero in 7,686 of them. The
constraint run gates in `analytics/rules/constraints.py` and the operating-mode
classifier in `analytics/rules/mode.py` both gate on it, so both are currently
blind to morning pull-down and after-hours operation. Not changed here — it is
Task 3 code and outside this checkpoint.

START HERE: `analytics/baselines/fit.py` — the two design-matrix functions are
the whole checkpoint. Everything else loads rows for them or stores what comes
out.

## Checkpoint 4.2 — Generalise the fitter

### WAS THE GENERALISATION NEEDED?

Yes, and not marginally. Nothing in 4.1 could have accepted a chiller: the
prediction function dispatched on a hardcoded if/else naming the two air-handler
baselines, the loader named six `ahu-1.*` points as a module constant, the run
gate was a single module-level point id, and both fit functions spelled out
`ahu-1.sa_flow` and friends inline. The commit stands.

### WHAT WE DID

The baseline fitter is now one function that knows nothing about air handlers or
chillers, and the chiller goes through it. Before this there were two
hand-written air-handler fitters with the equipment's sensor names spelled out
inside them, and adding a second kind of machine meant writing a third.

What differs between kinds of equipment is now packed into a description of the
physics — how to turn raw sensor readings into the quantities the equation is
written in, what shape the equation takes, and when the machine is running hard
enough for the equation to mean anything. Which descriptions apply to a given
machine is decided by looking up its class in the semantic model, so all three
chillers are served by one entry and a fourth chiller would need no code at all.
The chiller baseline predicts compressor power from how hard the machine is
working, how large a temperature gap it is pushing against, and how cold it is
being asked to make the water, which is the same idea as the air-handler models:
subtract what the conditions explain, and watch what is left.

### HOW IT WORKS

    analytics/baselines/fit.py :: ModelForm
      WHY IT EXISTS: The seam that makes one fitter serve every kind of
        equipment. Without it, generalising the signature would have moved the
        air-handler knowledge from the function bodies into the caller and
        changed nothing.
      WHAT IT DOES: Holds a name, the list of coefficient names, the unit, and
        four callables that run in order. `derive` turns measured point values
        into the quantities the physics is written in — lift and part load ratio
        are not sensors, they are arithmetic over sensors. `evaluable` says which
        instants the model is meaningful at beyond the run gate. `fit_quantity`
        says what to regress on, which is not always the target point.
        `to_target` converts a prediction of that quantity back into a prediction
        of the target point, so the stored residual is always in the units of a
        real sensor. It also carries the run gates, as point-and-threshold pairs.
      CHOICES: The gates live on the form rather than on the spec because "this
        model is only valid while the machine is running" is a statement about
        the physics, not about the installation. Same shape as the RUN_GATES
        table in analytics/rules/constraints.py, deliberately.

    analytics/baselines/fit.py :: BaselineSpec
      WHY IT EXISTS: One chiller entry has to serve three chillers.
      WHAT IT DOES: Pairs a model form with a target point and a role-to-point
        mapping, all written with `{asset}` where the asset id goes, and
        substitutes a concrete asset on demand.
      CHOICES: `{asset}` templating rather than a function taking asset_id,
        matching how analytics/rules/chiller.py already addresses its three
        machines.

    analytics/baselines/fit.py :: BASELINE_CATALOGUE and specs_for(brick_class)
      WHY IT EXISTS: Something has to say which baselines a given machine gets,
        and doing it by asset id would mean three identical chiller entries and a
        fourth the day someone adds a chiller.
      WHAT IT DOES: A dictionary from Brick class to the baselines that class
        declares. Lookup resolves through Brick's own taxonomy — the class the
        database records, plus every class it is a kind of or is declared
        equivalent to — reusing the closure walk the rule registry dispatches on.
      ⚠ JUDGEMENT CALL: The taxonomy lookup is not decoration. The database
        records the air handler as `brick:AHU` and the catalogue is written
        against `brick:Air_Handling_Unit`, which Brick declares equivalent in one
        direction only and rdflib does not reason over. The first run of this
        checkpoint used plain string equality, fitted the chillers correctly and
        silently fitted nothing at all for the air handler — no error, just two
        missing baselines. Consistent with checkpoint 3.2, which vendored the
        taxonomy for exactly this.

    analytics/baselines/fit.py :: fit_baseline(conn, asset_id, target_point,
                                               driver_points, window, form)
      WHY IT EXISTS: The single fitter. Everything else in the package either
        feeds it or stores what comes out.
      WHAT IT DOES: Reads the points it is told to read over the window, asks the
        form to derive the physics quantities, masks down to instants that are
        running, complete, trustworthy and evaluable, solves ordinary least
        squares on whatever the form says to regress on, and measures R-squared,
        the error spread and the error median.
      CHOICES: `driver_points` maps a ROLE the physics uses — "lift", "valve",
        "mixed_air" — to the point id that supplies it. That indirection is what
        lets one form serve three chillers.
      CHOICES: Two arguments beyond the four the checkpoint named are
        structurally unavoidable: a connection, because the window has to be read
        from somewhere, and the form, because there is no way to guess from a
        point id whether a fan similarity law or a chiller performance map is
        wanted.

    analytics/baselines/fit.py :: applicable(...)
      WHY IT EXISTS: Fitting and predicting have to agree exactly on which
        instants a model covers, or the residuals would be computed on a
        different population than the one the baseline was fitted on.
      WHAT IT DOES: Applies the run gates, drops instants with any reading
        missing, derives the physics quantities, and applies the form's
        evaluability test. When a quality frame is passed a fourth gate applies —
        every input trustworthy enough to define healthy — which is used when
        fitting and skipped when predicting.
      CHOICES: Quality gates the fit but not the prediction, so a residual
        computed from a doubtful reading is stored with its low score attached
        rather than quietly vanishing.

    analytics/baselines/fit.py :: chiller_derive(roles)
      WHY IT EXISTS: None of the three drivers the chiller model needs is a
        sensor. All three are arithmetic over the four water-side temperatures
        and the chilled water flow.
      WHAT IT DOES: Delivered cooling is the chilled water flow times the
        temperature it gained crossing the evaporator, converted to tons of
        refrigeration; part load ratio is that divided by nominal capacity. Lift
        — the temperature gap the compressor has to push against — is leaving
        condenser water minus leaving chilled water.
      CHOICES: Lift is the single largest thing that changes how much power a
        healthy chiller draws, which is precisely why a fixed efficiency
        threshold flags every hot afternoon and misses every mild one.

    analytics/baselines/fit.py :: chiller_design(roles)
      WHY IT EXISTS: The design matrix for chiller power.
      WHAT IT DOES: A full quadratic in part load ratio, lift and chilled water
        supply temperature: each on its own, each squared, and each pair
        multiplied together. Ten terms.
      CHOICES: That is the standard shape of a manufacturer's chiller performance
        map. The cross terms are physics rather than decoration — the power cost
        of an extra kelvin of lift depends on how loaded the machine is, which is
        exactly the plr*lift term.
      ⚠ JUDGEMENT CALL: The checkpoint asked for kW/ton as the modelled quantity.
        The model targets electrical POWER instead, with those same three
        drivers. Two reasons. The structural one is decisive: app.residuals.
        point_id carries a foreign key to app.points, and kW/ton is not a point,
        so storing a residual against it would mean inventing a synthetic sensor.
        The measured one is that it barely matters either way — fitting power and
        dividing through gives a kW/ton residual spread of 0.12195 against 0.12489
        fitting the ratio directly, a 2.4 percent difference. Both are reported.

    analytics/baselines/fit.py :: CHILLER_DESIGN_TONS
      WHY IT EXISTS: Part load ratio is delivered cooling as a fraction of what
        the machine can do, so it needs a capacity.
      CHOICES: 150 tons, nominal. THE FIT IS INVARIANT TO IT — part load ratio is
        tons divided by this number, so changing it rescales the coefficients and
        leaves every prediction and residual identical. It is here so the
        coefficients read as fractions of capacity rather than as tons. Observed
        load reaches 138 tons on chiller-1 and 154 on chiller-2, so the ratio
        occasionally exceeds one, which is normal against a plate rating.

    analytics/baselines/fit.py :: fit_asset_baselines(...)
      WHY IT EXISTS: Fits everything one asset's class declares, and does not
        abort the run when one of them cannot be fitted.
      WHAT IT DOES: Loops the specs for the class, catches the refusal, and
        returns the successes and the refusal messages separately.
      CHOICES: A refusal is a result, not an error. chiller-3 runs for nine
        samples in the commissioning window and genuinely cannot be modelled;
        raising would have taken the other two chillers down with it.

    analytics/baselines/fit.py :: RUNS
      WHY IT EXISTS: The air-handler runs and the chiller runs are different
        calendar windows, so one list of spans no longer suffices.
      WHAT IT DOES: Eight runs, each naming the assets that have data in it.
        AHU_SPANS is derived from it so checkpoint 4.1's verification still
        resolves.
      CHANGED FROM BEFORE: 4.1 had four air-handler spans. This has eight runs
        across both systems, with the assets listed per run — the chiller record
        does not start until 2036-05-10 and the air-handler runs at 2036-02-25
        and 2037-01-27 predate it entirely.

    analytics/baselines/residual.py :: main()
      WHAT IT DOES: For each run, for each asset in it, reads the asset's Brick
        class from app.assets, fits whatever that class declares, then computes
        and stores residuals for each fitted baseline.
      CHANGED FROM BEFORE: The 4.1 version named the air handler in its loop and
        called a function called fit_ahu_baselines. This version contains no
        equipment name at all.

    scripts/plot_baselines.py :: kw_per_ton_sd(...)
      WHY IT EXISTS: The chiller residual is stored in watts and an engineer
        reads efficiency, so the verification reports the same spread both ways.
      WHAT IT DOES: Divides the fitted power spread by the mean evaluable load
        over the fit window.

### MEASURED RESULT

AHU R-squared identical to checkpoint 4.1, to all five decimal places, and so is
every downstream number — residual spread, error median, sample count, rows
written, residual median and normalised 95th percentile:

    run                        baseline                4.1        4.2
    ahu_cooling_valve_leakage  fan-similarity      0.98909    0.98909
    ahu_cooling_valve_leakage  coil-effectiveness  0.99395    0.99395
    ahu_oa_damper_stuck        fan-similarity      0.97688    0.97688
    ahu_oa_damper_stuck        coil-effectiveness  0.99588    0.99588
    ahu_sat_sensor_drift       fan-similarity      0.98354    0.98354
    ahu_sat_sensor_drift       coil-effectiveness  0.99094    0.99094
    clean_ahu                  fan-similarity      0.98354    0.98354
    clean_ahu                  coil-effectiveness  0.99094    0.99094

Chiller fits, through the same call:

    asset      R2         residual sd
    chiller-1  0.97927    7042.6052 W   = 0.10125 kW/ton
    chiller-2  0.96861    6279.7553 W   = 0.09222 kW/ton
    chiller-3  REFUSED — 9 usable samples in the commissioning window, below 200

The kW/ton spread of 0.10125 is an independent corroboration of the 0.109949 the
chiller rules in checkpoint 3.4 use as their process-control limit. That number
was fitted on the LBNL fault-free year with a different driver set; this one is
fitted on the scenario commissioning window with part load ratio, lift and
chilled water temperature. They agree to eight percent.

Chiller residual medians over each whole run, in the fit's own error spread:

    run                           chiller-1        chiller-2
    clean_chiller                 -1,001 W (0.14)     -26 W (0.00)
    chiller_condenser_fouling    +21,183 W (3.01)    -165 W (0.03)
    chiller_bypass_valve_leakage +34,902 W (4.96) +30,442 W (4.85)
    cooling_tower_fouling           -743 W (0.11)    +283 W (0.05)

Condenser fouling moves chiller-1 by three of its own standard deviations and
leaves chiller-2 alone, which is right — the fault is injected into chiller-1.
Bypass valve leakage moves both, which is also right, since it is a plant-level
fault. Cooling tower fouling moves neither, which is what the held-out fault
should do to a chiller baseline: tower fouling raises condenser water
temperature, the model conditions ON lift, and so the effect is absorbed as an
operating condition rather than reported as a chiller problem. Task 8 has to find
it without a model.

- 260,561 residual rows now stored across both systems.

START HERE: `analytics/baselines/fit.py` — the ModelForm dataclass and
fit_baseline directly below the catalogue. Those two are the whole refactor.

## Checkpoint 4.3 — Failure modes and degradation indicators

### WHAT WE DID

The system now knows the distinct ways each kind of equipment can fail, tracks a
separate number for each one, and knows the value at which each of those numbers
means the machine is finished. Before this the system could say a machine looked
wrong; it could not say in which of several possible ways, and it had no notion of
how far along that path the machine had got.

The list of failure modes lives in a database table rather than in code, so
adding a mode nobody has thought of yet is one INSERT. Each row carries a small
piece of arithmetic that computes the mode's degradation number from sensor
readings and from the baseline residuals built in the previous two checkpoints,
the value at which that number counts as failure, and — required, not optional —
a written physical or economic reason for that value. That last column matters
more than it looks: the remaining-life estimate coming next predicts when a
number will cross a threshold, and a prediction that a made-up number will cross
another made-up number is not a prediction of anything.

Six modes are seeded. Three of them turned out to name instruments this building
does not have, which is recorded honestly rather than papered over.

### HOW IT WORKS

    scripts/schema.sql :: app.failure_modes
      WHY IT EXISTS: A machine does not simply get worse. A chiller fouls its
        condenser, or loses refrigerant charge, or slides in compressor
        efficiency, and those are three different numbers reaching failure at
        three different values. Rolling them into one score before measuring them
        separately throws away the only information that says which repair to
        order.
      WHAT IT DOES: One row per mode, holding the Brick class it applies to, the
        arithmetic that computes its degradation number, an optional condition
        restricting when that number means anything, the failure value, its unit,
        and the justification. The health index reads the table and loops over
        whatever it finds.
      CHOICES: threshold_rationale is NOT NULL and additionally CHECKed to be
        longer than 40 characters, so a threshold cannot be entered with a token
        justification any more than with none.
      CHOICES: indicator_expression is nullable. A mode that is real but not
        measurable here keeps its row, its threshold and its rationale, so the
        instrument gap is documented rather than silently absent.
      ⚠ JUDGEMENT CALL: Two columns beyond the six the checkpoint listed.
        indicator_unit, because a threshold of 2.8 is meaningless without knowing
        it is kelvin. applies_when, because several indicators only mean anything
        in a particular commanded state and folding that into the arithmetic would
        force comparison operators into the indicator language. Keeping the gate
        in its own column is what lets indicator_expression stay pure arithmetic,
        which is the security property checkpoint 3.5 chose deliberately.
      CHOICES: The seed uses ON CONFLICT DO UPDATE rather than DO NOTHING, so
        correcting a rationale in this file and re-applying the schema actually
        corrects it in the database.

    scripts/schema.sql :: the sign convention
      WHY IT EXISTS: Every indicator is written so that LARGER IS WORSE and zero
        is healthy, whatever the underlying physics does. The health index in 4.4
        maps indicator onto 0 to 100 and cannot do that if some modes count up and
        others count down.
      WHAT IT DOES: In practice this means one mode carries a leading minus sign —
        a leaking coil makes supply air COLDER than predicted, so the raw residual
        goes negative and the indicator negates it.

    analytics/baselines/fit.py :: ModelForm.ceilings
      WHY IT EXISTS: Some models describe a component in a specific commanded
        state. What a cooling coil does with its valve shut is a different model
        from what it does modulating, and expressing "shut" needs an upper bound.
      CHANGED FROM BEFORE: ModelForm previously had only lower-bound gates, which
        could say "the fan is running" but not "the valve is closed".

    analytics/baselines/fit.py :: shut_valve_design / SHUT_VALVE_SUPPLY_AIR
      WHY IT EXISTS: The coil leak indicator the checkpoint asks for is "supply
        air deviation with the valve commanded closed", and the existing coil
        model cannot provide it.
      WHAT IT DOES: A second, separate model of supply air temperature,
        restricted by its ceiling gate to instants where the valve is commanded
        closed. In that state the coil should do nothing at all, so the only thing
        between mixed air and supply air is the heat the fan adds, and the model
        is a single constant: supply air is mixed air plus a fixed rise. Any
        cooling that appears therefore has nowhere to hide — it shows up directly
        as supply air colder than predicted.
      ⚠ JUDGEMENT CALL: A third air-handler baseline, added in 4.3 rather than
        4.2. It is needed because the coil-effectiveness model CANNOT detect this
        fault: that model is driven by the valve POSITION, and in this dataset a
        leaking valve honestly reports itself as 10 percent open, so the model
        explains the leak away as ordinary cooling from a partly open valve. I
        confirmed this against the raw LBNL files before adding anything — see the
        finding below. The alternative was to change the existing model's driver
        from position to command, which was rejected because it would have altered
        the 4.1 and 4.2 results that are already verified and committed.
      CHOICES: One parameter, no airflow term. Airflow was tried and earns
        nothing: with the valve shut it moves R-squared by 0.003 to 0.099
        depending on the window, because there is almost no variance left to
        explain once the coil is out of the picture.
      CHOICES: R-squared for this model is identically 0.00000 and that is not a
        failure — an intercept-only model explains none of the variance by
        construction. The statistic that matters is the residual spread, 0.166 to
        0.209 K.

    analytics/baselines/fit.py :: condenser_design / CONDENSER_HEAT_REJECTION
      WHY IT EXISTS: The condenser fouling indicator needs an excess-lift
        residual, and 4.2's chiller baseline predicts power, not lift.
      WHAT IT DOES: Models the temperature the condenser water LEAVES at, from
        part load ratio, entering condenser water and chilled water temperature.
        For a given load and given entering water a clean condenser leaves the
        water at a predictable temperature; fouling insulates the tubes, so
        rejecting the same heat needs a hotter refrigerant, condensing pressure
        rises, and the water leaves warmer. The residual is the excess lift the
        compressor is working against.
      CHOICES: Leaving condenser water is the target because it is a real point,
        which app.residuals requires — it carries a foreign key to app.points, and
        "lift" is not a sensor.
      CHOICES: Entering condenser water is a DRIVER, not an output, because it is
        set by the cooling tower rather than by the chiller. Holding it fixed is
        what stops this residual moving when the TOWER fouls, which matters
        because tower fouling is the fault held out for Task 8. Measured: the
        indicator reads 0.401 on condenser fouling and -0.024 on tower fouling.

    analytics/health/modes.py :: FailureMode / load_failure_modes
      WHY IT EXISTS: Reads the config table. NO FAILURE MODE IS DEFINED IN PYTHON
        anywhere in this package, which is the whole point of the table.

    analytics/health/modes.py :: modes_for_class(modes, brick_class)
      WHY IT EXISTS: Three chillers must share one row.
      WHAT IT DOES: Resolves the mode's declared class through Brick's taxonomy,
        so a mode written against brick:Air_Handling_Unit reaches an asset the
        database records as brick:AHU. Same closure the baseline catalogue and the
        rule registry use.

    analytics/health/modes.py :: _substitute(expression, asset_id)
      WHY IT EXISTS: Expressions have to name two different kinds of thing — raw
        measurements and baseline residuals — and have to work for any asset of
        the right class.
      WHAT IT DOES: Replaces @asset with the concrete asset id, then rewrites each
        {point:...} or {residual:...} reference as a positional placeholder,
        returning the reference list alongside so the values can be supplied in a
        fixed order. Identifiers contain dots and hyphens, so they cannot be
        Python names and this indirection is unavoidable.

    analytics/health/modes.py :: ARITHMETIC_NODES and GATE_NODES
      WHY IT EXISTS: These expressions come from a table, and text from a table
        being compiled into executable code is exactly where a config store
        becomes a foothold.
      WHAT IT DOES: Two whitelists. Indicators may contain arithmetic over names
        and numbers and nothing else — no calls, no attributes, no subscripts, no
        comparisons — which is the same list the constraint evaluator in 3.5 uses.
        Gates additionally allow comparison and boolean operators, because a gate
        is a yes-or-no question. Nothing else is added to either.

    analytics/health/modes.py :: compile_mode(mode, asset_id)
      WHAT IT DOES: Substitutes the indicator and the gate as one string joined by
        a separator that cannot occur in arithmetic, so the two share a single
        reference list and a point named in both is loaded once, then splits them
        apart and compiles each against its own whitelist.

    analytics/health/modes.py :: load_references(...)
      WHY IT EXISTS: An expression can read measurements and residuals in the same
        line, and those live in two tables with two shapes.
      WHAT IT DOES: Pivots each source to one column per identifier, prefixed by
        kind so a point and a residual of the same name cannot collide, and joins
        them on time. An OUTER join, so an instant carrying a measurement but no
        residual survives with a gap; the gap then propagates through the
        arithmetic to a missing indicator, which is the honest answer.

    analytics/health/modes.py :: evaluate(compiled, values)
      WHAT IT DOES: Evaluates the indicator, then drops instants the gate
        excludes and instants where the arithmetic came out non-finite.
      CHOICES: Gated-out instants are DROPPED, not set to zero. A cooling coil
        whose valve is modulating is not a coil with no leak; it is a coil whose
        leak cannot be seen right now, and recording zero would tell the trend
        downstream that the machine had recovered.

    analytics/health/modes.py :: summarise / ModeSummary
      WHAT IT DOES: Reduces an indicator series to sample count, median, 95th
        percentile, and where it finished, plus that as a fraction of the
        threshold.
      CHOICES: `final` is the median over the last tenth of the window rather than
        the last value, because a single sample at the end of a run is noise and
        the question is where the indicator has GOT to.

    analytics/health/modes.py :: indicators_for_asset(...)
      WHY IT EXISTS: The entry point everything else calls.
      CHOICES: A mode that cannot be evaluated is returned as a message, not
        raised. chiller-3 has no fitted baselines at all, and one missing baseline
        must not take an asset's other modes down with it.

    scripts/run_modes.py :: main()
      WHAT IT DOES: Prints the config table with every rationale in full,
        evaluates every mode on every asset over every run, reports how far each
        indicator travelled as a percentage of its threshold, lists the modes that
        are declared but not computable, and plots each verifiable mode against
        the matched clean run with its threshold drawn on.

### MEASURED RESULT

Six modes seeded, four of which reference substitute indicators because the
instrument the checkpoint named does not exist in this building:

    mode                       indicator                            asked for
    coil-valve-leak-by         supply air deviation, valve shut     as specified
    chiller-condenser-fouling  excess leaving condenser water       substituted
    chiller-efficiency-loss    kW/ton over condition-matched base   added
    fan-bearing-degradation    fan power residual at matched duty   as specified
    chiller-refrigerant-loss   chilled water above setpoint at
                               full compressor command              substituted
    filter-loading             none — no instrument exists          declared only

Direction of travel on each mode's own scenario, against the matched clean run:

    mode                       faulted final   clean final   moves
    coil-valve-leak-by                 0.402        -0.264      UP
    chiller-condenser-fouling          0.401         0.002      UP
    chiller-efficiency-loss            1.037        -0.021      UP

All three move upward, which is the physically expected direction for all three
by the sign convention. chiller-efficiency-loss crosses its 0.536 kW/ton
threshold around 20 July, about seven weeks after onset, and finishes at 193
percent of it.

Every mode on every run, as a percentage of its own threshold, final value:

    run                         asset       coil    fan    cond      eff  refrig
    clean_ahu                   ahu-1      -9.4%   4.7%      -        -       -
    ahu_cooling_valve_leakage   ahu-1      14.4%  -2.3%      -        -       -
    ahu_oa_damper_stuck         ahu-1     -17.6%   4.6%      -        -       -
    ahu_sat_sensor_drift        ahu-1    -143.9%   4.7%      -        -       -
    clean_chiller               chiller-1      -      -   0.1%    -3.8%   24.6%
    chiller_condenser_fouling   chiller-1      -      -  13.4%   193.5%   73.6%
    chiller_bypass_valve_leak   chiller-1      -      - 259.7%  1584.6%  637.0%
    cooling_tower_fouling       chiller-1      -      -  -0.8%    -2.8%   19.7%

Four things in that table are worth stating plainly rather than leaving to be
noticed.

- The held-out fault does what it should. cooling_tower_fouling leaves every
  chiller indicator inside noise: -0.8 percent, -2.8 percent and 19.7 percent of
  threshold. No seeded mode can claim it, which is the point of holding it out.
- No indicator is falsely driven toward failure by a fault belonging to another
  mode on the same asset. The stuck damper leaves coil-valve-leak-by at -17.6
  percent, further from failure than the clean run's -9.4 percent, and the fan
  indicator sits at 4.6 to 4.7 percent on every air-handler run including the
  clean one.
- The indicators are not perfectly specific across assets, and the cross-talk is
  physical. Condenser fouling pushes chiller-refrigerant-loss to 73.6 percent of
  threshold because fouling really does cost capacity, and a machine short of
  capacity really does drift above setpoint. Separating that from an actual charge
  loss is Task 5's job, not an indicator's.
- ahu_sat_sensor_drift drives coil-valve-leak-by to -143.9 percent, hard in the
  WRONG direction. That is correct behaviour and useful: a supply air sensor
  reading high looks like the exact opposite of a leak, so the sign itself
  discriminates a sensor fault from an equipment fault. It also means the mode
  indicators alone cannot be trusted without the quality layer, which is why
  every residual they read carries an input_quality column.
- chiller-3 has no indicators at all on any run, because it has no fitted
  baselines: it runs for 9 samples in every commissioning window. Reported as
  SKIPPED on every run rather than silently absent.

### FINDING — the LBNL coil leakage fault, and a flat severity ladder

Two things came out of checking the raw source files, and the second one matters
beyond this checkpoint.

The coil valve leakage fault is genuine leak-by. With the valve commanded shut,
the fault-free file has the valve at position 0.0004 and supply air 0.97 degF
WARMER than mixed air, which is fan heat and no cooling. The faulted file has the
valve pinned at 0.1006 — ten percent open — and supply air 0.06 degF COOLER at the
median and 2.23 degF cooler at the 95th percentile. So the valve reports its own
leak honestly as a position, which is exactly why the coil-effectiveness baseline
cannot detect it and the shut-valve baseline can.

`coi_leakage_010_annual.csv` and `coi_leakage_050_annual.csv` are IDENTICAL on
every column this checkpoint reads: same valve position 0.10064, same mixed-minus-
supply distribution to three decimals, same sample count. The four published
severity levels of this fault are not distinguishable in the data. That does not
affect anything built here — the trajectory synthesiser blends between fault-free
and one faulted file, so a flat ladder still produces a correct ramp — but it does
mean the severity ladder recorded for this fault in checkpoint 2.4 describes file
names rather than measured differences, and the validation in a later task should
not claim severity discrimination on it.

START HERE: `scripts/schema.sql`, the app.failure_modes seed. Six INSERT rows with
their rationales are the actual content of this checkpoint; the Python only reads
them.

## Checkpoint 4.4 — Health index and onset detection

### WHAT WE DID

The system now produces one number per machine per day saying how much of the way
to failure it has travelled, and separately says whether it is confident anything
has actually started going wrong. Before this there were degradation indicators
in physical units that nobody outside the project could read; now there is a
score from 100 down to 0, where 100 means the machine is no worse than when it
was last called healthy and 0 means it has reached a failure value with a written
physical justification behind it.

Two properties make the number usable rather than decorative. It can only fall,
because equipment does not repair itself, and it falls to the WEAKEST of the
several ways the machine can fail rather than the average of them — a chiller
with a perfect compressor and a dying condenser is a chiller about to fail, not a
chiller in average condition. Every mode's contribution is kept alongside, so the
score always comes with the reason for it.

Separately, a detector confirms when degradation actually began. That matters
because the next layer predicts a failure date by extending a trend, and a trend
extended from noise produces a confident date that means nothing. Nothing may
project forward until the detector has confirmed a change exists.

### HOW IT WORKS

    scripts/schema.sql :: app.maintenance_events
      WHY IT EXISTS: Health is clamped so it can never climb, which is right
        until somebody performs a repair, at which point the machine genuinely
        HAS recovered and the clamp becomes a lie that holds a fixed asset at its
        worst-ever score forever.
      WHAT IT DOES: One row per repair, naming the asset, optionally the specific
        mode, when, and what was done. THE TABLE IS EMPTY and expected to be —
        neither the LBNL data nor the synthesised runs contain a repair.
      CHOICES: A NULL mode_id is a whole-asset overhaul that resets everything; a
        specific one resets only itself, because brushing condenser tubes should
        not erase the evidence that a compressor is wearing out.

    scripts/schema.sql :: app.health_state
      WHY IT EXISTS: What the API serves and what the prediction layer fits.
      WHAT IT DOES: One row per asset per mode per day with the raw indicator, the
        clamped one, the 0 to 100 score and the confirmed onset. Rows with
        mode_id NULL are the asset roll-up and additionally carry which mode
        produced the minimum.
      CHOICES: Both the per-mode detail and the roll-up are stored rather than
        deriving the roll-up on read, so the API and the prediction layer cannot
        disagree about what an asset's health was.
      CHOICES: Deliberately NOT a hypertable. Health is one row per mode per day,
        so the whole table is 3,123 rows; weekly chunks would create more chunks
        than any chunk would hold rows. AI_LOG.md D-01 is about chunk counts
        getting out of hand and the lesson cuts both ways.

    analytics/health/changepoint.py :: cusum(series, reference_end)
      WHY IT EXISTS: To stop the remaining-life layer answering questions it has
        no business answering. Fit a trend to a flat noisy line and you get a
        slope, and from that slope a confident failure date. That number is worse
        than none, because it looks like an answer.
      WHAT IT DOES: Walks the daily indicator keeping a running total of how far
        it has sat above where it sat during commissioning, minus a slack
        allowance. The total is floored at zero, so it stays pinned while the
        machine behaves and climbs once it does not. When the total passes a
        decision interval a change is declared.
      CHOICES: A cumulative sum rather than a threshold on the indicator itself,
        because the whole difficulty is that early degradation is SMALLER than the
        noise. One day half a degree high means nothing; thirty consecutive days
        half a degree high is a machine that has changed, and only a cumulative
        sum separates those.
      CHOICES: Slack 0.5 standard deviations and decision interval 5.0. These are
        the textbook tabular CUSUM values; at that pairing the in-control average
        run length is about 465 samples, so on a machine that is not degrading a
        false onset is expected about once per 465 days of daily samples. Chosen
        from that false-alarm property, NOT from how well it separates any
        scenario here.
      CHOICES: Upper-sided only, because every indicator is written so larger is
        worse. An indicator falling below where it started is a machine better
        than commissioned, which is not degradation.
      CHOICES: Two times are returned and they are different questions. The
        crossing is when we knew. The last sample at which the running total was
        still zero is the estimate of when it began — CUSUM signals late by
        construction because it has to accumulate evidence first, so using the
        crossing as the onset estimate would overstate the lag by design.
      CHOICES: A reference window shorter than 7 days produces no answer rather
        than a guess. This bites: three of the chiller modes have only 6 usable
        reference days and are correctly refused.

    analytics/health/index.py :: to_daily(series)
      WHY IT EXISTS: Indicators arrive every five minutes, far finer than
        degradation moves.
      WHAT IT DOES: Daily median, dropping any day with fewer than 6 samples. A
        day represented by three readings taken during a start-up transient is
        not a measurement of that day.

    analytics/health/index.py :: enforce_monotonic(series, resets)
      WHY IT EXISTS: Equipment health should only ever get worse until someone
        repairs it. Real readings jitter, so the raw number wobbles, and the
        prediction maths downstream assumes a one-directional slide — if the line
        bounces, the fit breaks or produces a slope that means nothing.
      WHAT IT DOES: Takes the daily values and pulls up any that sit below the one
        before, so the line can flatten but never fall. It does that with
        isotonic regression, which finds the closest possible never-decreasing
        version of a wobbly line in a least-squares sense, rather than crudely
        clamping each point to the running maximum. The difference matters: a
        running maximum lets one bad day set a floor the line can never come back
        under, whereas isotonic regression lets a single outlier be outvoted by
        the days either side of it.
      CHOICES: Applied over the whole window between repairs rather than a rolling
        one, so a noisy first week does not get permanently baked in as the floor.
      CHOICES: Every recorded repair splits the series and each segment is fitted
        independently. With an empty maintenance table there is one segment today,
        but a health index that silently cannot handle repair is wrong in a way
        that would only surface in production.

    analytics/health/index.py :: to_health(excess, threshold)
      WHY IT EXISTS: Turns a physical quantity into a number a human can read.
      WHAT IT DOES: 100 where the mode is no worse than commissioned, 0 where it
        has travelled the whole failure threshold from there, linear between,
        clamped at both ends.
      CHOICES: The input is an EXCESS over the commissioning value, not the raw
        indicator, and that is what makes 100 mean "baseline" rather than "the
        indicator happens to read zero". Residual-based indicators read near zero
        when healthy so it changes nothing for them; directly measured ones do
        not. Chilled water at full compressor command sits 0.2 K above setpoint on
        a perfectly healthy machine, and scoring that against absolute zero
        started the clean chiller at 90 and ended it at 68 with nothing wrong.
      CHOICES: Clamped at zero rather than allowed negative, because a machine
        past its failure threshold is not more failed than failed, and a negative
        contribution would drag an asset roll-up below the scale it defines.

    analytics/health/index.py :: mode_health(...)
      WHAT IT DOES: Daily median, then onset detection, then centring on the
        commissioning mean, then the clamp, then the score.
      CHOICES: The order is load-bearing. Onset detection runs FIRST, on the raw
        series — a clamped series is monotone by construction, and a changepoint
        detector run after the clamp would be finding the clamp rather than the
        fault. Centring reuses the mean the detector already computed, so the two
        can never disagree about what baseline means.
      CHOICES: When the commissioning window is too thin to establish a reference,
        the mode returns nothing rather than falling back to an assumed zero. An
        indicator that does not read zero when healthy, scored against zero,
        produces a confident wrong answer.

    analytics/health/index.py :: roll_up(asset_id, modes)
      WHY IT EXISTS: The asset-level number, and the reason for it.
      WHAT IT DOES: Takes the minimum health across modes at each day and records
        which mode produced it.
      CHOICES: Minimum, never mean. A chiller whose compressor is perfect and
        whose condenser is at 10 is a chiller about to fail, and the mean of those
        describes a machine that does not exist. The minimum is also always
        attributable: exactly one mode is responsible and it is named next to the
        number.
      ⚠ JUDGEMENT CALL: A mode with no reading on a given day carries its last
        known value forward rather than dropping out of that day's minimum. The
        alternative, taking the minimum only over modes with data, was tried and
        was clearly wrong: the coil leak indicator is only defined while the valve
        is commanded shut, so as the weather warmed and the valve stopped closing,
        the air handler's roll-up CLIMBED from 43 back to 92. Health that recovers
        because a test stopped running is the worst kind of wrong number.

    analytics/health/index.py :: write_health(...)
      WHAT IT DOES: Deletes and rewrites this asset's rows over the window, modes
        then roll-up. The roll-up carries the earliest confirmed onset among its
        modes, because the asset started degrading when the first of its modes did.

### MEASURED RESULT

Health across every run, first day to last:

    run                           asset       days  start  end  min  weakest at end
    ahu_cooling_valve_leakage     ahu-1        109    100   43   43  coil-valve-leak-by
    ahu_sat_sensor_drift          ahu-1        117    100   63   63  fan-bearing-degradation
    chiller_condenser_fouling     chiller-1    117    100    0    0  chiller-efficiency-loss
    chiller_bypass_valve_leakage  chiller-1     45    100    0    0  chiller-condenser-fouling
    ahu_oa_damper_stuck           ahu-1        106    100   95   95  fan-bearing-degradation
    cooling_tower_fouling         chiller-1    117    100   95   95  chiller-efficiency-loss
    clean_ahu                     ahu-1        117    100   98   98  fan-bearing-degradation
    clean_chiller                 chiller-1    117    100   97   97  chiller-efficiency-loss

All four progressive scenarios decline; both clean runs finish at 97 and 98. The
held-out tower fault moves chiller health by 5 points, which is the right order —
tower fouling really does cost a chiller a little efficiency, and no seeded mode
claims it.

Monotonicity: zero per-mode health series increases at any point, across all 8
runs and every mode.

Min-across-modes with two modes degrading at once, chiller-1 under condenser
fouling. Days where the roll-up is not exactly the minimum of its modes: 0.

    date          condenser  efficiency    MIN   weakest
    2036-05-10        100.0       100.0  100.0   condenser
    2036-06-23        100.0        88.0   88.0   efficiency
    2036-07-08         99.7        77.0   77.0   efficiency
    2036-07-22         95.5         0.0    0.0   efficiency
    2036-09-02         86.7         0.0    0.0   efficiency

The faster mode takes the roll-up and is correctly named; the slower one keeps
declining underneath and is still visible.

Detection delay, confirmation minus true injected onset, read from
groundtruth.fault_events over a superuser connection AFTER every number was
written:

    run                           mode                        estimated  confirmed  delay
    ahu_cooling_valve_leakage     coil-valve-leak-by          2036-03-19 2036-03-27  +9.8 d
    ahu_cooling_valve_leakage     fan-bearing-degradation     2036-03-16 2036-03-29 +11.8 d
    ahu_sat_sensor_drift          coil-valve-leak-by          not detected        -       -
    ahu_sat_sensor_drift          fan-bearing-degradation     2038-06-17 2038-06-20  +2.8 d
    chiller_condenser_fouling     chiller-condenser-fouling   2036-07-10 2036-07-21 +50.8 d
    chiller_condenser_fouling     chiller-efficiency-loss     2036-06-11 2036-06-19 +18.8 d
    chiller_bypass_valve_leakage  chiller-condenser-fouling   2037-05-30 2037-06-02  +1.8 d
    chiller_bypass_valve_leakage  chiller-efficiency-loss     2037-05-28 2037-06-02  +1.8 d

The onset ESTIMATES are much better than the confirmation delays: 2036-03-19
against a true 2036-03-17, 2038-06-17 exactly right, 2037-05-30 one day early.
That is the CUSUM working as intended — it confirms late and then points back at
when the evidence started.

The condenser mode's 50.8 day delay is the weak indicator predicted in checkpoint
4.3: excess lift only reaches 1.17 standard deviations by end of run, so it takes
seven weeks of accumulation to clear the decision interval. The efficiency mode
sees the same fault in 18.8 days.

The coil mode correctly does NOT fire on the supply air sensor drift. A sensor
reading high looks like the opposite of a leak, so the mode stays silent on a
fault that is not its own.

### TWO FALSE POSITIVES, NOT TUNED AWAY

The onset detector fires on the clean chiller. chiller-1's efficiency mode
confirms an onset on 2039-06-28 and chiller-2's on 2039-06-01, with peak
statistics of 3.07 and 4.12 times the decision interval — not marginal. Two false
onsets among the six clean-run mode series. The air handler's two clean modes do
not fire, peaking at 0.86 and 0.36.

The cause is not the CUSUM design. It is that the chiller efficiency baseline is
fitted on 21 days in May and applied through September, so seasonal conditions
drift outside the fitted envelope and leave a small systematic residual — and a
small SUSTAINED shift is exactly what a CUSUM is built to find. The false-alarm
rate of the onset detector is therefore set by how well the baselines extrapolate
across a season, not by the decision interval.

The thresholds were not adjusted to make this go away. The health consequence is
small — the clean chiller ends at 97 and 99 — so the index is not misleading even
where the detector is early, but the detector's own precision is 4 true onsets out
of 6 firings on chiller assets and that number should be carried into Task 5
rather than discovered there.

### LIMITATION — the monotone clamp and intermittent excursions

The supply air sensor drift run ends with the air handler at 63, attributed to
fan bearing degradation, and that attribution is not real. The fan power residual
on that run has 12 days out of 117 above the 88.9 W threshold, the worst at 406 W,
scattered at roughly weekly intervals — against zero such days on the clean run,
where the maximum is 11 W. So the excursions are genuine and specific to that run.
But the last ten days of the run read 3 to 11 W, entirely normal, and the monotone
clamp holds health at 63 anyway.

That is the monotone assumption being wrong rather than the implementation being
wrong: intermittent excursions are not degradation, and clamping converts twelve
bad days into a permanent 37 point loss. The clamp was kept as specified rather
than adding an unrequested recovery mechanism, but the behaviour should be a
decision rather than a discovery.

START HERE: `analytics/health/index.py` — mode_health is five lines and the
ordering of those five lines is the whole checkpoint.

## Checkpoint 4.5 — Decision log

### WHAT WE DID

The decision log now records why this project learns what normal looks like
instead of setting fixed limits, and it records what that choice actually cost and
where it fell short. It also closes out the previous entry with what Task 4
revealed about it — including one prediction that entry made which turned out to be
only half right.

Nothing here is code. It exists because the reason for a design choice is not
recoverable from the code that implements it, and because the two entries most
worth reading are the ones that record a decision failing to do everything it was
supposed to.

### HOW IT WORKS

    AI_LOG.md :: D-05 Outcome, updated after Task 4
      WHY IT EXISTS: The outcome written at checkpoint 3.6 ended on a forward
        claim -- that the condition-normalised baselines coming in Task 4 were
        what the rule engine's two remaining misses needed. Task 4 has now
        happened, so the claim is either right or it is not, and leaving it
        unresolved would be the one thing a decision log must not do.
      WHAT IT DOES: Records that the claim was half right. The cooling coil valve
        leak IS now caught -- the rule reached 22 percent of its threshold and
        stayed silent, the baseline-driven indicator reaches its full threshold and
        takes health from 100 to 43, with onset estimated two days after the true
        injection. The stuck outdoor air damper is STILL missed, health ending at
        95 and its coil indicator moving to -17.6 percent of threshold, which is
        away from failure rather than toward it.
      CHOICES: The reason for the surviving miss is stated as a general principle
        rather than as a local excuse: a baseline cannot fix a fault that hides
        inside one of its own drivers, because the condition being matched on is
        the thing that is lying. The operating mode is inferred from the same
        damper that is broken.
      CHOICES: The entry's Confidence section had committed only to "a third
        equipment class will not require touching dispatch". The update records
        that what the claim actually survived was larger: two entirely new LAYERS,
        each of which independently needed to answer "which machines does this
        apply to", and both answered it by calling the same closure. 2,996 lines
        added across 11 files, every one an insertion; registry.py, evaluate.py,
        apar.py and chiller.py changed zero lines between them.
      CHOICES: Also records the near-miss that justified the taxonomy closure a
        second time. Checkpoint 4.2's first catalogue used string equality on the
        Brick class, fitted both chillers correctly, and silently fitted nothing
        at all for the air handler, because the database says brick:AHU while the
        catalogue said brick:Air_Handling_Unit -- classes Brick declares
        equivalent in one direction only. No error, just two missing baselines.

    AI_LOG.md :: D-06 Forcing question
      WHY IT EXISTS: Frames the decision against the failure it exists to avoid.
      WHAT IT DOES: States the mechanism of false-positive fatigue rather than
        gesturing at it. A static limit does not fire when the asset is unhealthy;
        it fires when conditions are unusual, which is a different event that
        happens far more often. The failure is then social rather than technical:
        a team fed a dozen weather-explained alerts a day stops reading the
        alerts, after which the system's accuracy is irrelevant because nobody is
        listening. A detector nobody trusts is worth less than no detector,
        because it cost money and occupies the place a working one would go.
      CHOICES: Records why it had to be settled before the health index rather
        than after: health is defined as distance to a threshold, so a threshold
        on a raw signal makes the health number -- and the remaining-life estimate
        fitted to it -- inherit every weather swing.

    AI_LOG.md :: D-06 Options
      WHAT IT DOES: Three named options with their real costs. Static limits per
        point, free and already supported by columns in app.points, conditioning
        on nothing. Condition-normalised physics-form baselines fitted per
        commissioning window, chosen, about a day of work and five model forms.
        Learned black-box models per point, which would very likely fit better
        in-sample and buy nothing checkable against physics.

    AI_LOG.md :: D-06 Rationale
      WHAT IT DOES: Settles option 1 with a measurement rather than an argument.
        Fan power on airflow alone explains 14.6 to 55.4 percent of variance
        depending on window, with a NEGATIVE fitted cubic coefficient, which
        means more air for less power and is impossible. Conditioned on shaft
        speed as well, R-squared 0.977 to 0.989 at 21 to 26 watts. A static limit
        is strictly worse than the 15 percent model because it conditions on
        nothing at all.
      CHOICES: The clinching form of the argument is that no value works, not that
        the wrong value was chosen. Fan power spans 0 to 1,622 watts across a
        healthy run: every limit inside that band fires on ordinary operation and
        every limit above it never fires. After normalisation the same healthy run
        drifts 0.824 watts in 120 days, 0.03 of its own standard deviation.
      CHOICES: Records a fourth option rejected inside the chosen one -- fitting
        one baseline globally instead of one per run -- and why: the runs sit in
        different seasons and eras, so a global fit leaves a systematic per-run
        offset and the residual then partly encodes which run a reading came from.
      CHOICES: The case against the black box is extrapolation, not elegance. In
        the stuck-damper run 32.5 percent of mixed air temperatures fall outside
        the fitted range because the fault is what moves them there; the
        effectiveness form stays bounded because the driving temperature
        difference enters multiplicatively, so it cannot predict cooling with
        nothing to cool with. An unconstrained learned model has no such guarantee
        at exactly the moment it matters most, which is during the fault.
      ⚠ JUDGEMENT CALL: The interpretability cross-check is stated with its scope
        rather than as a blanket claim. The fitted fan temperature rise matches a
        direct independent measurement to a hundredth of a kelvin -- 0.51 against
        0.50, 0.56 against 0.55 -- but only in the two WINTER windows. In summer
        the valve is almost never shut, the term is weakly identified, and it fits
        at 0.06 K. My first draft quoted the agreement without the qualifier,
        which would have implied it held across all four windows.

    AI_LOG.md :: D-06 Confidence
      WHAT IT DOES: Splits into three levels rather than one. High that
        normalisation beats static limits on this equipment, because 0.15 against
        0.99 on the same rows is not a close call. Moderate on the commissioning
        window specifically, since 21 days in May applied through September is
        where the only false alarms in Task 4 came from. Low on the monotone clamp
        where excursions are intermittent rather than progressive.

    AI_LOG.md :: D-06 Outcome
      WHY IT EXISTS: The measured result, including the part that did not work.
      WHAT IT DOES: Leads with "the decision was right, and it relocated the
        false-positive problem rather than solving it", then supports both halves.
        Working: both clean runs end at 97 and 98, all four progressive scenarios
        decline, the coil leak the rules missed is caught, the held-out tower fault
        moves health 5 points and no seeded mode claims it, the roll-up equals the
        minimum of its modes on every day, no per-mode series ever rises. Not
        working: the onset detector fires twice on the clean chiller at 3.07 and
        4.12 times its decision interval.
      CHOICES: States the relocation as the general finding, because it is the one
        a reader should carry forward. A static threshold fires when conditions are
        unusual; a condition-normalised baseline fires when conditions are outside
        the window it was fitted on. The second set is much smaller and bounded --
        2 false onsets against a raw signal that would have alarmed continuously --
        but it is the same mechanism wearing a different coat, and the fix is a
        longer or seasonally refitted commissioning window that 120-day runs cannot
        supply.
      CHOICES: Records both mistakes made inside this decision, because both would
        have shipped confident wrong numbers and both were caught by measurement
        rather than review. The median-absolute-deviation normalisation scale that
        put a clean run at 53.9 sigma, and health scored against absolute zero
        rather than the commissioned value, which alone started the clean chiller
        at 90 and ended it at 68 with nothing wrong.

### MEASURED RESULT

    6 entries; Forcing question 6, Options 6, Rationale 6, Mine vs delegated 6,
    Confidence 6, Outcome 6, Overrode 1

- No outcome is blank or a stub. Shortest is D-03 at 2,402 characters.
- D-05's outcome grew from 1,700 to 3,947 characters with the Task 4 update, and
  the forward claim it previously ended on is now resolved: one of the two rule
  misses fixed, one still open with the reason stated.
- D-06 carries three named options, as required.
- Two claims in the first draft of D-06 were tightened after checking them against
  the actual runs: the fan-temperature-rise cross-check holds in the two winter
  windows and not in summer, and the fit sample count is 524 to 3,780 rather than
  "around 3,000".

START HERE: `AI_LOG.md` — the Outcome of D-06. It is the only place in the log
that records a decision working and relocating its own problem at the same time,
which is the most useful thing Task 4 learned.

---

## Checkpoint 5.1 — Degradation model

### WHAT WE DID

The system can now say how fast a machine is getting worse, and how confident it
is in that speed. Before this it could only say how bad things currently are: the
health index gave a number per day, but nothing turned that sequence of numbers
into a rate of change with an honest error bar around it. That rate is the whole
input to predicting a failure date — a remaining-life estimate is just "how far
is left to go" divided by "how fast we are going", and the error bar on the
second of those is what makes the prediction an interval rather than a guess.

Two different kinds of wear are now modelled separately, because they are
physically different. Some things drift both ways day to day while trending one
way overall, like the extra power a worn fan draws. Others can only accumulate —
scale settling on a condenser tube does not come off by itself. Which of the two
applies to each failure mode is recorded in the database next to the mode, with
the physical reason written beside it, so it is a statement about the equipment
rather than a decision buried in code.

The estimate also starts from a stated default rather than from nothing, and that
default is deliberately weak: it carries the weight of one week of observation, so
after a month of real data it contributes almost nothing. The belief is then
updated one day at a time as data arrives, and it provably sharpens as it goes.

### HOW IT WORKS

`scripts/schema.sql` :: `app.failure_modes.degradation_process`
- WHY IT EXISTS: Which stochastic process fits a mode's wear is a claim about
  physics, and the project's standing rule is that claims about equipment live in
  the database, not in Python. Without this column the prediction layer would have
  to hardcode a list of mode names, and adding a failure mode would stop being an
  INSERT.
- WHAT IT DOES: One text column, constrained to `wiener` or `gamma`, defaulting to
  `wiener`. Every seeded mode now carries a value with a comment above it giving
  the physical argument. Condenser fouling, refrigerant loss and filter loading are
  `gamma` — deposit, escaped refrigerant and trapped dust are all irreversible.
  Coil valve leak-by, compressor efficiency loss and fan/bearing degradation are
  `wiener`, because in each case the indicator is a noisy readout of a hidden state
  and not the state itself, so honest days do move the wrong way. On the fault-free
  run, 45 of 116 daily changes in the fan indicator are downward.
- CHOICES: Added by `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` as well as being in
  the `CREATE TABLE`, because the table already exists in the running database and
  `CREATE TABLE IF NOT EXISTS` silently does nothing to it. This is the first
  `ALTER` in the schema file; the comment above it says why.
- ⚠ JUDGEMENT CALL: Bearing wear is physically irreversible, so a case could be
  made for `gamma` there too. I chose `wiener` on the grounds that a Gamma process
  assigns zero probability to a negative day, and 39 percent of this indicator's
  days are negative on a machine with nothing wrong with it — a model that calls
  observed data impossible is worse than one that is philosophically imprecise.

`analytics/rul/degradation.py` :: `load_daily_indicator`
- WHY IT EXISTS: The entry point for the whole layer. Everything below fits to
  what this returns.
- WHAT IT DOES: Reads one mode's daily indicator for one asset over one window out
  of the health table. Deliberately reads the RAW daily column and not the clamped
  one, because the clamped column was computed over the whole run — replaying an
  as-of date against it would let the model at day 20 use the shape of day 100.
  The raw daily median is a statistic of its own day and nothing else.

`analytics/rul/degradation.py` :: `observe`
- WHY IT EXISTS: Reconstructs what the system would have known on a given date.
  Everything about a narrowing interval is a lie if the early snapshots can see
  the end of the run.
- WHAT IT DOES: Cuts the daily series off at the as-of date, then redoes on that
  truncated series alone both steps the health index performs: runs the cumulative
  sum detector to see whether degradation has been confirmed yet, and applies the
  one-directional clamp. Subtracts the commissioning mean so that zero means "where
  this mode sat when the machine was last called healthy". Returns the post-onset
  stretch alongside the detector's verdict — including the cases where there is
  nothing to fit, because the refusal layer in 5.3 has to be able to say WHICH
  precondition failed, and it cannot do that if the failure comes back as nothing.
- CHOICES: An already-confirmed onset can be passed in and is then used rather than
  re-detected. Once a change is confirmed it stays confirmed with the same start
  date; a live system does not quietly slide the date a fault began because a week
  later the cumulative sum would have preferred a different day. Measured across
  these runs the detector's estimate is in fact stable once it fires, so this
  changes no number in the report — it removes the possibility.

`analytics/rul/degradation.py` :: `increments` and `Increments`
- WHY IT EXISTS: Both processes are fitted from day-to-day changes, not from
  levels, so this is the shape everything downstream consumes.
- WHAT IT DOES: Splits the post-onset series into the change across each interval
  and the length of that interval, and carries the totals. Interval lengths are
  measured rather than assumed to be one day, because the health index drops a day
  whose indicator had fewer than six samples, which leaves a two-day gap; treating
  that gap as one step would claim the machine moved twice as fast that day. Also
  reports what fraction of intervals the clamp held exactly flat — 45 to 100
  percent across the 38 fits here, median 90, which is the single most important number for
  understanding everything below.
- CHOICES: Refuses to produce anything below 10 increments. Both a rate and a
  spread estimated from a handful of daily steps have a sampling error comparable
  to themselves. This is a numerical floor for the arithmetic, explicitly NOT the
  policy on when a prediction may be published — that is 5.3's job and 5.3 owns
  the configurable sample minimum.

`analytics/rul/degradation.py` :: `moments`
- WHY IT EXISTS: The two numbers both processes are built from. Sharing them is
  what makes the Wiener and Gamma alternatives comparable rather than two
  unrelated models.
- WHAT IT DOES: The rate is the total rise divided by the total elapsed days,
  which for a Wiener process is exactly the maximum-likelihood estimate of the
  drift. Worth knowing why: for Brownian motion every path between two endpoints
  is equally likely, so the days in the middle carry no information about the
  drift at all. That makes the rate robust to one bad day and blind to the shape
  of the trajectory. The spread is the average squared departure from that rate,
  each interval divided by its own length because a two-day step is expected to
  stray twice as far as a one-day step. Unlike the rate, this one uses every point.

`analytics/rul/degradation.py` :: `fit_wiener`
- WHY IT EXISTS: The default model. Brownian motion with drift, meaning the
  indicator trends one way at a fixed average rate while individual days scatter
  either side of it.
- WHAT IT DOES: Takes the rate and spread from `moments` and computes the log
  likelihood of the observed increments under them, which is the sum over days of
  the normal density of each day's departure from its expected rise. Nothing is
  optimised numerically — for this model the closed-form estimates ARE the maximum
  likelihood.

`analytics/rul/degradation.py` :: `fit_gamma`
- WHY IT EXISTS: The alternative for modes where the underlying physical quantity
  can only accumulate. Its increments are strictly positive, so it can never
  forecast a machine spontaneously recovering.
- WHAT IT DOES: A Gamma process has mean rate shape times scale, and one-day
  variance shape times scale squared, so the same two statistics pin both
  parameters down: the scale is the variance over the rate, and the shape is what
  is left. Fitted shapes here run 0.15 to 0.31 per day. If the post-onset rate is
  not positive a Gamma process cannot represent the data at all, so it falls back
  to Wiener and records the reason in the fit rather than reporting parameters
  that do not exist — which happens on the second chiller of the bypass-leakage
  run, whose clamped series never moves.
- CHOICES: Fitted by moments, not maximum likelihood, and this is forced rather
  than lazy. The clamp produces intervals that are exactly zero — a median of 90
  percent of them — and the Gamma density at zero is either zero or infinite
  depending on the shape, so the likelihood is not hard to maximise, it is
  degenerate. Dropping the flat intervals to rescue it would discard the evidence
  that the machine stopped moving, which is precisely the evidence that should
  widen a prediction. A likelihood over the positive intervals only is still
  reported for comparison, with the count it had to leave out stated beside it.

`analytics/rul/degradation.py` :: `Anchor` and `anchor_at`
- WHY IT EXISTS: This is the spine of the checkpoint and the thing three wrong
  versions taught me. It holds everything that is decided ONCE, at the moment
  degradation is first confirmed: the onset, the prior, the process spread, and the
  Gamma shape. A prior re-derived from each day's data is not a prior, and a
  process whose spread is re-chosen every day is not one process.
- WHAT IT DOES: The prior mean rate is the failure threshold spread over one year —
  absent intervention, this mode arrives at the value somebody physically justified
  as failure in about a season and a bit. A year rather than an equipment service
  life, because the thresholds in the config table are maintenance triggers, not
  end-of-life: a condenser reaches its cleaning threshold in a season or two, not
  in the twenty-three years ASHRAE gives the chiller around it. The prior width is
  the process spread over the square root of seven, which makes the prior worth
  exactly seven days of observation whatever unit the mode is measured in.
- CHOICES: Seven days. The modes here differ by three orders of magnitude in scale
  — a fan power residual in watts against a temperature residual in kelvin — so no
  fixed variance could be weak for both, and expressing the prior's strength as a
  number of days is what makes it scale-free. Measured against the runs, seven days
  out of a 35-day window pulls a fitted rate back by about 20 percent, and out of a
  100-day window by about 7 percent.
- ⚠ JUDGEMENT CALL: The spread is floored at the commissioning-window day-to-day
  spread of the same indicator, and that floor is doing real work — in 12 of the 14
  fitted cases it is LARGER than the spread fitted to the clamped series, so it is
  what the update actually runs on. The argument is that a day cannot honestly
  claim to be quieter than the same indicator was on the same equipment when nobody
  thought anything was wrong; the clamp removed variance that physically exists,
  measured here as a deflation of between 2.8 and 61 times. The alternative was to
  take the clamped spread at face value, which is what the checkpoint's wording
  literally asks for. I rejected it because it makes the interval in 5.2 too narrow
  by up to a factor of 61, and because with no floor a perfectly flat clamped
  series reports zero spread and the belief collapses onto the prior mean with
  unbounded confidence — on the second chiller of the bypass run that produced a
  rate ten million standard deviations from zero, out of a series that had not moved
  at all. Both the floored and unfloored spreads are printed side by side so the
  choice is auditable rather than hidden.

`analytics/rul/degradation.py` :: `update_wiener`
- WHY IT EXISTS: Turns the fit into a belief with a width, and it is the width that
  becomes the prediction interval in 5.2.
- WHAT IT DOES: Each day's increment is a noisy observation of the rate — expected
  value the rate times the interval length, variance the spread squared times that
  length. A normal prior updated by a normal observation gives a normal posterior,
  so the whole history collapses into two running numbers: a mean, and a precision
  which is one over the variance. The loop walks the days adding each day's
  precision to the total. Because every term added is positive the total can only
  grow, so the standard deviation can only fall. That is where the narrowing comes
  from — it is a property of accumulating evidence, not something the data happened
  to do.
- CHOICES: Written as a loop even though it collapses to a closed form, because the
  accumulation is the claim being made. Verified numerically that the loop and the
  closed form agree to 1e-12, and that the accumulated precision strictly increases
  over every prefix of a series.
- CHANGED FROM BEFORE: Two earlier versions were wrong and both are recorded in the
  docstring because the failure modes are instructive. Re-fitting the whole window
  from scratch at each date is the honest batch answer but it is not an update: the
  spread is re-estimated each time, and on an accelerating fault it grows faster
  than the extra days shrink it, so the rate's standard deviation on the coil valve
  leak went 0.0074, then 0.0032, then back up to 0.0053. Re-estimating the spread
  from the data available at each STEP is worse and looks more principled than it
  is — the first increment has no scatter of its own so its spread falls to the
  floor, a small spread means an enormous weight, and the entire estimate ends up
  pinned to day one. On the bypass-leakage fault that dragged a measured 0.438
  kW/ton per day down to 0.054, because day one carried roughly eight hundred times
  the weight of day thirty.

`analytics/rul/degradation.py` :: `update_gamma`
- WHY IT EXISTS: The same belief for the accumulating modes, so that switching a
  mode's declared process changes the shape of its uncertainty and not how much of
  it there is.
- WHAT IT DOES: With the shape held at the anchored value the only unknown is the
  scale, and the conjugate prior for a Gamma scale is an inverse gamma. The update
  is two running numbers again: the first parameter gains the shape times the
  elapsed days, the second gains the total rise, and both only ever increase. The
  rate is the shape times the scale, so the belief about the rate follows from the
  belief about the scale.
- CHOICES: The two prior parameters are placed so that this posterior's MEAN is
  arithmetically identical to the Wiener one — verified to 1e-12 on a synthetic
  series. Both reduce to total rise over total time, counting the prior as seven
  pseudo-days during which the indicator rose at the prior rate. That is what makes
  the two genuinely comparable alternatives rather than two different amounts of
  optimism; what differs between them is the spread, and in 5.2 the first-passage
  law that spread feeds.
- ⚠ JUDGEMENT CALL: What necessarily narrows here is the spread AS A FRACTION of
  the rate, one over the square root of the accumulated first parameter. The
  absolute spread is that fraction times the mean, so on a fault whose rate is
  itself climbing the absolute number can widen while the belief genuinely
  sharpens. This happens once in the report and is not tuned away. Neither of these
  processes models acceleration, which is the real limitation underneath it.

`analytics/rul/degradation.py` :: `replay`
- WHY IT EXISTS: The difference between "posterior updating as new data arrives"
  and "three separate fits printed next to each other". Also the mechanism 5.2
  needs to store a history the UI can replay.
- WHAT IT DOES: Walks the as-of dates in order. At the first date where a fit is
  possible it creates the anchor; from then on it passes that same anchor forward,
  so only the evidence accumulates. Dates before degradation is confirmed come back
  as nothing, in order, so the caller can see when the model started having
  anything to say.

`scripts/run_degradation.py` :: `main`
- WHY IT EXISTS: The verification, and the only place the numbers in this report
  come from.
- WHAT IT DOES: Prints the config table's process declarations, then for every run
  and asset and applicable mode walks the replay through three dates and prints the
  fitted rate and spread beside the updated belief and how many standard deviations
  that belief sits above zero. Then four checks: whether the belief ever gets
  vaguer, what each mode's final rate reads as against zero, the Gamma parameters
  and flat-interval fractions where a Gamma was declared, and the clamped spread
  against the raw spread with the floor that was applied.
- CHOICES: Reads nothing but the health table and the config table, both as the
  unprivileged role. No ground truth is touched anywhere in the file, because the
  question this checkpoint asks is whether the belief sharpens, not whether it is
  right; that comparison arrives in 5.2.

Skipped as boilerplate: three dataclasses that only carry fields and derived
properties (`Observation`, `ProcessFit`, `Posterior`), the `fit_process` and
`update` two-line dispatchers, `prior_rate`, `snapshots`, and the `fmt` helper in
the script.

### MEASURED RESULT

Rate, spread and posterior spread at three dates, for every mode with a confirmed
onset, are in the run output. The headline numbers:

    narrows: 12    unchanged because no new data: 1    WIDENS: 1

- The one unchanged row is the second chiller of the bypass-leakage run, whose
  data ends 87 days before the nominal window closes, so the middle and late dates
  see the identical series. Precision unchanged is the correct response to no new
  evidence.
- The one WIDENS row is condenser fouling on the bypass-leakage run, a
  Gamma-declared mode on an accelerating fault: absolute spread 0.10009 to 0.107,
  up 6.9 percent, while the same spread as a fraction of the rate went 0.369 to
  0.3297, down 10.6 percent. The rate itself rose 20 percent over the same step.
  Not tuned away; it is what choosing a Gamma process means.
- Worked example of the tightening, coil valve leak-by: posterior spread 0.010985,
  then 0.0067269, then 0.0054361, over 17, 57 and 91 post-onset days.

The rate against zero at the last date separates the runs correctly without any
threshold having been fitted to them: the two coil and chiller faults that reach
their thresholds read 3.07, 3.50, 3.21, 3.03 and 3.54 standard deviations above
zero, while both clean-chiller modes read 0.08 and 0.11, the held-out cooling
tower reads 0.10 and 0.16, and the stuck damper reads 0.11. That is the quantity
5.3 refuses on, and it is already doing the right thing.

### TWO THINGS 5.3 WILL HAVE TO SETTLE

- The clamp flattens a median of 90 percent of all intervals (range 45 to 100
  across 38 fits), and the fitted spread
  falls below the healthy-period spread in 12 of 14 cases. The floor covers it for
  now, but the underlying problem is upstream in the clamp.
- 5.3 specifies a minimum of 200 post-onset samples. These series are daily and no
  run is longer than 117 days, so that minimum can never be met and would refuse
  everything. It needs restating in days, or the indicator needs sampling finer
  than daily.

START HERE: `analytics/rul/degradation.py` — `anchor_at`, and the docstring above
`update_wiener`. Between them they hold the three wrong versions of this checkpoint
and why the fourth one is right.

---

## Checkpoint 5.2 — RUL first-passage estimation

### WHAT WE DID

The system now produces a date. Not a health score, not a rate — an actual answer
to "when will this need attention", expressed as a window rather than a single day,
because a single day would be a lie. For each failure mode on each machine it says
there is a ten percent chance of crossing the threshold by one date, an even chance
by another, and a ninety percent chance by a third. Before this the system could
say a machine was declining at some rate; it could not say when that rate runs out
of room.

The window is computed, not decorated. There is no step anywhere that produces a
best guess and then pads it by some factor to look suitably humble — the width
comes out of the same mathematics as the middle, by taking the uncertainty about
the decline rate and asking what range of crossing dates it implies. One
consequence is that when the system does not know, the window is enormous or has no
upper end at all, and both of those happen in the results.

Every answer at every date is kept, not just the latest. Replaying the table in
date order shows exactly what the system would have said each day of the run,
including the days it was wrong, which is the only honest way to demonstrate that
the estimate improves as evidence arrives.

### HOW IT WORKS

`analytics/rul/estimator.py` :: `first_passage_cdf`
- WHY IT EXISTS: The heart of the checkpoint. Everything else arranges inputs for
  this and interprets its output.
- WHAT IT DOES: Given how far the indicator still has to climb, a decline rate and
  a day-to-day spread, returns the probability that the threshold has already been
  touched by a given number of days. It is the closed-form first-passage law for
  Brownian motion with drift, two normal terms added: the chance of simply being
  past the threshold now, plus a correction for paths that crossed earlier and came
  back below. No simulation, no numerical integration of a path.
- CHOICES: The second term multiplies a growing exponential by a vanishing normal
  tail, and computing those separately overflows on entirely ordinary inputs — a
  rate of 0.3 across a distance of 3 with a spread of 0.7 already puts the exponent
  near 4 and larger cases run away. Both are combined in log space so the product
  is one exponential of a sum. Checked against the inverse Gaussian distribution in
  scipy across four parameter sets spanning these modes: agreement to 5e-16.

`analytics/rul/estimator.py` :: `reachability`
- WHY IT EXISTS: This is the honest core of the whole checkpoint and it is why the
  interval is allowed to have no upper end. A machine that is not declining is not
  going to reach the threshold, and the model has to be able to say so.
- WHAT IT DOES: Returns the probability the threshold is EVER touched. One when the
  rate is positive: a random walk tilted upward reaches every level above it
  eventually, with certainty. Less than one when the rate is negative or zero-ish,
  falling off exponentially, so the distribution over crossing dates is DEFECTIVE —
  the missing probability sits at infinity, meaning no crossing. The belief about
  the rate from 5.1 is a normal distribution, so it always puts some weight on
  non-positive rates, and the predictive answer inherits that missing mass. If the
  ninetieth percentile falls inside it there is no ninetieth percentile, and the
  estimate says so instead of producing a number.
- CHOICES: Written as one clipped exponential rather than a branch on the sign of
  the rate. Selecting between branches with numpy's `where` evaluates both, so the
  positive-rate case still computed a growing exponential and overflowed; clipping
  the exponent at zero gives exactly one there, which is the right answer anyway.
- Verified against simulated random walks: for a distance of 1 with rate -0.02 and
  spread 0.2 the closed form says 0.368 and 6,000 simulated thousand-day paths hit
  34.5 percent of the time, the shortfall being paths that would cross after the
  simulated horizon. Same direction and magnitude on two other parameter sets.

`analytics/rul/estimator.py` :: `predictive_cdf` and `predictive_reachability`
- WHY IT EXISTS: The step the checkpoint calls propagating the posterior. Without
  it the interval would come only from day-to-day noise around a single assumed
  rate, which is the smaller half of the uncertainty and would produce a
  confidently narrow band.
- WHAT IT DOES: Averages the first-passage law over the belief about the rate,
  weighting each candidate rate by how plausible 5.1 thinks it is. Done by
  Gauss-Hermite quadrature, which places 61 evaluation points exactly where a
  normal distribution has its mass.
- CHOICES: Quadrature rather than drawing random rates, for two reasons. It is
  exact for smooth integrands against a normal weight, and the first-passage law is
  smooth in the rate. More importantly it returns the identical answer every time
  it runs — with sampling, the verification that the interval narrows could pass or
  fail on the seed, and a monotonicity claim that depends on a random seed is not a
  claim.

`analytics/rul/estimator.py` :: `quantile`
- WHY IT EXISTS: Converts the distribution into the three numbers a human reads.
- WHAT IT DOES: The mixture probability rises with time, so the quantile is found
  by bisection on it. Returns nothing at all in the two cases where the answer does
  not exist, rather than inventing one: when the total chance of ever failing is
  below the quantile asked for, and when the crossing is real but beyond the horizon
  the model will look.
- CHOICES: Ten years for that horizon. A chiller's service life is around
  twenty-three years by ASHRAE's tables, so a crossing predicted past ten is
  indistinguishable from "not in the foreseeable future" for anyone planning
  maintenance, and reporting it as a number would imply a precision that is not
  there.

`analytics/rul/degradation.py` :: `trailing_level` and the level floor in
`fit_degradation`
- WHY IT EXISTS: The distance still to travel is what the first-passage law is
  measured from, so an error here moves every date. Two rounds of wrong answers
  came from getting it wrong.
- WHAT IT DOES: The current level is the MEDIAN of the clamped indicator over the
  trailing seven days, then held at its running maximum across dates.
- ⚠ JUDGEMENT CALL: The obvious choice is the most recent clamped value, and it is
  wrong twice over. The clamp upstream is isotonic regression, a BATCH smoother that
  refits the whole window and revises its own earlier points when new data arrives,
  so its latest value is not a non-decreasing function of how much data it has seen.
  Read one date at a time that gave a mode whose distance to threshold went 28.1,
  then -46.6, then +30.1 across three consecutive weeks — a machine that failed and
  then unfailed. Holding the value at its running maximum fixes the direction and
  breaks something else, because the last point of an isotonic fit is the least
  reliable point in it: there is no later data to outvote an excursion sitting
  there. The running maximum promptly locked in a 257 watt transient on a fan whose
  threshold is 89 watts and called it failed for the rest of the run. The trailing
  median cannot be moved by one excursion and the running maximum keeps the premise
  that degradation does not un-happen; both are needed and neither is sufficient.
  Seven days follows the existing convention in this project — the mode summaries in
  4.3 already take a trailing median for the same stated reason. The alternative I
  rejected was estimating the level from the fitted trend line instead of from
  observation, which is smoother but means the prediction stops being anchored to
  where the machine actually is.

`analytics/rul/estimator.py` :: `estimate`
- WHY IT EXISTS: Assembles one answer from one fitted mode.
- WHAT IT DOES: Takes the rate and its uncertainty from the belief built in 5.1,
  the spread from the anchor that belief was formed against, and the distance from
  the level above, and returns the three quantiles plus the total chance of ever
  reaching the threshold. Using the anchored spread rather than refitting one here
  matters: the two halves of the interval cannot then disagree about how noisy the
  machine is.

`analytics/rul/estimator.py` :: `soonest`
- WHY IT EXISTS: An asset needs one number, and it has to be the same weakest-link
  rule the health index uses or the two layers will contradict each other.
- WHAT IT DOES: Picks whichever mode reaches its threshold first. A mode with no
  bounded date cannot be the soonest so it is skipped, but if every mode is
  unbounded the answer is that the asset has no bounded failure date, which comes
  back as nothing rather than as a large number.

`scripts/schema.sql` :: `app.rul_estimates`
- WHY IT EXISTS: The history is the demonstration. A single current estimate proves
  nothing about whether the system is learning.
- WHAT IT DOES: One row per mode per asset per date with the three quantiles, the
  number of post-onset days behind them, the rate used and the spread used. The
  quantile columns are NULLABLE and a NULL is an answer, not missing data: it means
  the model declined to bound that end. Two check constraints enforce that the
  quantiles are ordered where they exist.
- CHOICES: Not a hypertable, same as the health table — 1,117 rows in total, and
  weekly chunks would create more chunks than any chunk would hold rows.

`analytics/rul/estimator.py` :: `write_estimates`
- WHAT IT DOES: Deletes and rewrites this mode's rows over the window rather than
  merging, like every derived table in this project, because a row left behind
  describes a threshold or a baseline that may no longer exist.

`scripts/run_rul.py` :: `main`
- WHAT IT DOES: Walks every run day by day, and at each date refits and re-estimates
  every applicable mode using only data up to that date, storing all of it. Then
  prints the interval over the three weeks before the injected failure, the error in
  the median against two different reference events, and the asset roll-up. The
  ground-truth read is one function and runs only after every estimate has been
  computed and written; the estimation itself runs as the unprivileged role, which
  the database physically denies access to the answer key.

`scripts/run_rul.py` :: `plot`
- WHAT IT DOES: One panel per progressive scenario, with the shaded band from the
  tenth to the ninetieth percentile, the median as a line, and a dashed diagonal
  showing how long was actually left — a straight line falling to zero on the
  injected failure date. A prediction that works has the band tracking that diagonal
  and closing on it, which the condenser-fouling panel does visibly for three weeks.
  Each panel is scaled to its own predictions; one shared limit either clips the slow
  modes or flattens the fast ones onto the axis.

Skipped as boilerplate: the `RulEstimate` dataclass and its derived properties,
`daily_as_ofs`, and two formatting helpers in the script.

### MEASURED RESULT

1,117 estimates stored across 14 mode/asset/run combinations.

**The median prediction, three weeks out, against the crossing it actually
predicts.** Three modes both degraded genuinely and crossed their threshold inside
a run, so for these the prediction can be checked against the event it was making
a claim about:

    chiller_bypass_valve_leakage  chiller-efficiency-loss     +2.0 days
    chiller_bypass_valve_leakage  chiller-condenser-fouling   +3.9 days
    chiller_condenser_fouling     chiller-efficiency-loss    +13.6 days

Against the answer key's `t_failure` — a different event, the date the injected
fault reached terminal severity — the same three read -21.2, -14.4 and -3.6 days.
Both are reported because they are not the same question, and the second is the one
the model was built to answer.

**The interval width over the last three weeks: 6 of 7 shrink, 1 widens.** The
widening is `coil-valve-leak-by`, and it is not a defect:

    2036-04-10   n=17   left 2.536   P10 100.4   P50 241.5   P90 unbounded
    2036-04-17   n=24   left 2.320   P10  85.1   P50 171.4   P90   1245.3
    2036-04-24   n=30   left 2.320   P10  94.8   P50 197.3   P90   2042.2

The distance left does not move at all across the second week. The daily history
shows why: the rate sawtooths, jumping up when the indicator steps and decaying
between steps, because this indicator only exists while the coil valve is commanded
shut and therefore arrives as a staircase with gaps. Over 2036-04-11 to 04-22 the
rate decays from 0.0201 to 0.0107 with no new rise, and the ninetieth percentile —
which sits far out in the tail of a rate whose belief is only two standard
deviations clear of zero — goes from 336 days to unbounded. The answer key confirms
the mechanism is real: this fault reached terminal severity on 2036-05-01, so the
ramp genuinely flattens during exactly this window. The model becoming less certain
when the machine stops getting worse is correct behaviour, and forcing it to narrow
would be forcing it to lie. Not tuned.

**The estimator's arithmetic is verified independently of the data**: the closed
form matches scipy's inverse Gaussian to 5e-16 on four parameter sets; the defective
total probability matches simulated random walks; the mixture is monotone in time and
tends to the total reachability; and quantiles vanish exactly as that total falls
below them (at a rate of 0.005 with spread 0.004 the total is 0.929, so P10 and P50
exist at 130 and 310 days and P90 does not).

### WHAT 5.3 HAS TO FIX, AND THIS MAKES THE CASE FOR IT

Two results here are wrong, and both are wrong in the same way — the arithmetic is
right and the mode should never have been believed:

- `fan-bearing-degradation` on the coil-leak run predicts a crossing 642.8 days
  after the one it appears to have had, and worse, its own threshold reads as
  already crossed, which makes the asset roll-up say the air handler has failed
  today for a reason that has nothing to do with the injected fault. Checkpoint 5.1
  already measured this mode's rate at 0.49 standard deviations from zero.
- `clean_chiller` produces a median crossing 254 days out on a machine with nothing
  wrong with it. Its rate is 0.08 standard deviations from zero.

Neither is a defect in the estimator; both are it faithfully computing a
consequence of a rate that cannot be told apart from no degradation at all. The
significance test in 5.3 refuses on exactly that quantity, and these are the cases
it exists for.

START HERE: `analytics/rul/estimator.py` — `reachability`. Three lines, and the
reason the interval is allowed to have no upper end is entirely in them.

---

## Checkpoint 5.3 — Insufficient-evidence refusal

### WHAT WE DID

The system can now decline to answer, and say precisely why. Every layer beneath
this one will produce a number if asked: the fitter will fit a rate to noise, and
the estimator will turn that rate into a confident-looking date. Neither is capable
of saying no. This is the only part of the project that is.

That is not a nicety. A maintenance team that receives a failure date acts on it —
orders a part, books a crew, takes a machine offline. A date derived from a machine
that is not actually degrading costs exactly as much as a real one and buys nothing,
and after a handful of those nobody believes any of the dates, including the true
ones. So the question asked here is not "can a number be computed" but "is there
enough evidence that stating it beats admitting we do not know".

The effect is measurable and large. Across both fault-free runs — 720 combinations
of machine, failure mode and day where any prediction at all is wrong by definition
— the system now publishes nothing. And on the air handler carrying the coil valve
leak, the answer a human would see changes from "this unit has already failed,
because of its fan" to "this unit's cooling coil valve will need attention in about
a month", which is the correct fault.

### HOW IT WORKS

`analytics/rul/refusal.py` :: `Policy`
- WHY IT EXISTS: The thresholds a prediction has to clear, in one place, as data
  rather than scattered through the checks. Anything tuned later is tuned here.
- WHAT IT DOES: Three numbers — the minimum observations since degradation was
  confirmed, how far the rate must sit from zero, and how wide the interval may be
  relative to how long we have watched.
- ⚠ JUDGEMENT CALL: The minimum sample count is 21, not the 200 the checkpoint
  specifies, and this is a deliberate deviation. 200 was written for a faster
  sampling rate than this pipeline has: the indicators arrive every five minutes,
  but the health index aggregates to one value per day, because degradation does not
  move on a five-minute timescale and a daily median survives a few hours of
  missing data. No run in this dataset exceeds 117 days, so a 200-sample minimum
  could never be satisfied by any asset ever, and the refusal layer would stop
  being a layer and become an off switch. 21 is chosen to equal the commissioning
  window the baselines are fitted on and the changepoint detector takes its
  reference from: we require as much evidence that a machine is failing as we
  required to establish what healthy looked like. Counted in observations rather
  than elapsed days, so a fortnight with half its days missing does not qualify.
- CHOICES: The significance cutoff is 1.96, the two-sided 95 percent normal value.
  A one-sided test at 1.645 would be defensible, since every indicator in this
  project is written so only upward movement counts as degradation. The stricter of
  the two is used because this is a gate on speaking, and staying quiet about a real
  fault for another week costs far less than one confident wrong date.

`analytics/rul/refusal.py` :: `adjudicate`
- WHY IT EXISTS: The decision itself. Everything above produces inputs for it and
  everything below the API consumes its verdict.
- WHAT IT DOES: Walks five conditions in a fixed order and returns on the first one
  that holds, because each presupposes the ones above it — asking whether a rate is
  significant is meaningless before a change has been confirmed, and asking whether
  an interval is too wide is meaningless when there is no interval. In order: is
  there a healthy baseline to compare against at all; has the changepoint detector
  confirmed a change; are there enough observations since it; can the rate be told
  apart from zero; and is the interval narrower than the observation behind it. Each
  refusal carries a slug that is safe to branch on and a sentence with the actual
  figures in it, so the reason is specific to that day rather than a category.
- CHOICES: Takes the observation, the fitted degradation and the estimate as three
  separate arguments rather than reaching through one to another. That keeps this
  module a pure decision with no ability to recompute anything and quietly disagree
  with what was stored.
- ⚠ JUDGEMENT CALL: There are five conditions, not the four specified. The extra one
  is "no commissioning reference": fewer than seven daily values of this indicator
  exist yet, so there is no healthy mean to measure a change against and no spread
  to judge its size by. This is genuinely distinct from "onset not confirmed" —
  the detector has not failed to find a change, it has not been able to look — and
  it is the honest reason on 6 to 16 days of every run. Folding it into
  onset_not_confirmed would have produced a reason that was true of the category and
  false of the day.
- ⚠ JUDGEMENT CALL: "wider than the elapsed observation window" is read as the whole
  window the asset has been watched for, not the post-onset stretch. The stricter
  post-onset reading would additionally refuse the coil valve leak at the end of its
  own run — a 99-day interval against 91 post-onset days — which is the one true
  air-handler detection in the set. Both numbers are available on the objects, so
  the policy can be tightened later without code changes.

`analytics/rul/refusal.py` :: `Verdict` and its `withheld` field
- WHY IT EXISTS: A refusal that cannot be audited has to be taken on trust.
- WHAT IT DOES: Carries either the published estimate or the refusal, and when an
  estimate was computed and then refused it keeps it under `withheld`. Somebody
  asking "what were you about to say?" gets an answer, and the before-and-after
  comparison that shows this layer earning its place becomes computable rather than
  asserted. Nothing downstream may render it as a prediction.

`analytics/rul/refusal.py` :: `published`
- WHY IT EXISTS: The asset roll-up has to be computed over survivors only.
- WHAT IT DOES: Filters a list of verdicts down to the estimates that cleared the
  policy. Rolling up across refused modes is exactly how the air handler ended
  checkpoint 5.2 reporting it had already failed, on the strength of a fan indicator
  whose rate sat half a standard deviation from zero.

`scripts/run_refusal.py` :: `walk`
- WHAT IT DOES: For one run, steps date by date through every mode on every asset,
  carrying the anchor and the level floor forward exactly as the replay does, and
  adjudicates each date. Returns every verdict rather than a summary so the
  verification can count reasons per day instead of trusting a total.

`scripts/run_refusal.py` :: `main`
- WHAT IT DOES: Prints the policy, then the first fortnight of each progressive
  scenario day by day with the reason and its figures, then both fault-free runs in
  full with a count of any prediction that leaked, then the specific upstream false
  alarms this checkpoint names with the value each one suppressed, then the asset
  roll-up with and without the policy side by side. Ground truth is read in one
  function and only to label the injected dates in the output; no decision in the
  file depends on it.

Skipped as boilerplate: the `Refusal` dataclass, the `_refuse` constructor, and two
formatting helpers in the script.

### MEASURED RESULT

**Both fault-free runs, in full: 0 predictions published across 720 mode-days.**
Six mode/asset combinations over 120 days each, and every day refused. The reasons
distribute the way the pipeline does — 47 to 114 days of onset not confirmed, 6 to
16 days with no commissioning reference yet, and on the two clean-chiller modes
where the changepoint detector did misfire, 16 to 26 days of too few samples
followed by 50 to 69 days of the rate not clearing zero.

**The first two weeks of all four progressive scenarios: refused on all 14 days**,
in every mode, with a reason true of that day. Typical:

    ahu_cooling_valve_leakage, coil-valve-leak-by
       6d  no_commissioning_reference  only 2 daily values of this indicator exist
                                       so far, against the 7 the commissioning
                                       window needs
       8d  onset_not_confirmed         the cumulative-sum detector reached 0.30 of
                                       its decision interval over 7 days

**The four false alarms the checkpoint names are all caught, all by the
significance test, and nothing else would have caught them:**

    seasonal changepoint firing, clean chiller-1   z=0.08   suppressed P50 254d
    seasonal changepoint firing, clean chiller-2   z=0.11   suppressed P50 891d
    clamped fan flatline, sensor-drift run         z=0.04   suppressed P50   0d
    fan excursions during the coil fault           z=0.49   suppressed P50   0d

**The asset roll-up, before and after the policy.** This is where refusing changes
what a human sees:

    ahu_cooling_valve_leakage  ahu-1      fan-bearing P50 0d    ->  coil-valve-leak-by P50 32d
    chiller_condenser_fouling  chiller-1  efficiency-loss 0d    ->  efficiency-loss 0d
    chiller_condenser_fouling  chiller-2  efficiency-loss 884d  ->  no bounded prediction
    ahu_oa_damper_stuck        ahu-1      fan-bearing 552d      ->  no bounded prediction
    chiller_bypass_valve_leak  chiller-1  condenser-fouling 0d  ->  condenser-fouling 0d
    ahu_sat_sensor_drift       ahu-1      fan-bearing P50 0d    ->  no bounded prediction
    cooling_tower_fouling      chiller-1  efficiency-loss 235d  ->  no bounded prediction
    cooling_tower_fouling      chiller-2  efficiency-loss 727d  ->  no bounded prediction
    clean_chiller              chiller-1  efficiency-loss 254d  ->  no bounded prediction
    clean_chiller              chiller-2  efficiency-loss 891d  ->  no bounded prediction

The first line is the best result in the task: the answer flips from "this air
handler has already failed, because of its fan" to "its cooling coil valve needs
attention in about a month", which is the fault that was actually injected. Three
predictions survive across all runs and all three are on assets carrying a genuine
progressive fault. Ten are withdrawn.

### TWO WITHDRAWALS THAT ARE WORTH ARGUING ABOUT

- `cooling_tower_fouling` is real degradation and is now refused on both chillers.
  That is the held-out fault: no failure mode in the config table measures cooling
  tower performance, so the only thing that moved was chiller efficiency, weakly and
  below significance. Refusing is right — publishing a chiller efficiency failure
  date for a fouled cooling tower would be a correct-looking number attached to the
  wrong machine — but it is a miss, not a save.
- `ahu_sat_sensor_drift` is refused, and should be. Nothing about that machine is
  degrading; a thermometer is lying about it. Producing no equipment failure date is
  the right answer, but "no prediction" is not the useful answer either. The useful
  answer is "your supply air sensor has drifted", and that is checkpoint 5.4.

START HERE: `analytics/rul/refusal.py` — `adjudicate`. Five conditions in a fixed
order, and the third one is the only thing standing between this project and a
confident failure date for every machine in the building.

---

## Checkpoint 5.4 — Sensor versus equipment discrimination

### WHAT WE DID

The system can now tell a lying instrument from a worn machine. That distinction is
the whole point of the layer: sent for equipment when it is a sensor, somebody
dismantles a healthy cooling coil; sent for a sensor when it is equipment, somebody
recalibrates a thermometer that was telling the truth and the machine carries on
failing. Before this, both looked the same — supply air temperature not where the
controller wants it — and the system had no way to choose.

It works by asking a falsifiable question rather than pattern-matching. Every
relation between measurements that ought to hold is written down. When some of them
stop holding, the system asks whether there is ONE measurement such that assuming it
reads consistently wrong makes all of them hold again. If yes, that instrument is
the suspect and the machine is probably fine. If no single measurement can do it —
if fixing one relation would break another the same measurement appears in — then
the measurements are agreeing with each other and the machine is what changed.

Two things fall out that were not designed in. An actuator that will not obey its
own command is a third kind of fault, distinct from both, and it is detectable
without any reference at all. And "we cannot tell" is a real outcome with a real
cause: a measurement that appears in only one relation can always be blamed for it,
so blaming it carries no information. Saying so is more useful than guessing,
because the fix is known — one more relation covering that point makes the case
decidable.

### HOW IT WORKS

`analytics/diagnosis/isolation.py` :: `constraint_relations`
- WHY IT EXISTS: Turns the stored physics residuals into the rows of a linear system.
- WHAT IT DOES: For each constraint touching the asset, reads its residual over both
  windows and records how far the mean has moved. Violation is always a SHIFT, never
  a departure from zero, because these constraints deliberately do not close at zero
  — the chiller energy balance is documented as being out by about 99 kW because the
  source simulation's own reported power disagrees with its own thermal terms.
- ⚠ JUDGEMENT CALL: The reference window is the FAULT-FREE run at the same time of
  year, not the commissioning window at the start of the same run. That was the
  original design and it was badly wrong. The coil-leak run starts in late February
  and its fault is developed by May, so comparing the two put the mixed air balance
  out by −2.36 K, about two of its own spreads, and every bit of it was the seasons
  changing — outdoor air is a term in that relation and February in Chicago does not
  resemble June. Season-matched, the same shift is +0.03 K. The cost of the fix is
  that a run with no season-matched fault-free counterpart cannot use this test; the
  stuck-damper run is one, and its output says so.

`analytics/diagnosis/isolation.py` :: `baseline_relations`
- WHY IT EXISTS: This is the checkpoint. Without it the key test cannot be done at
  all, and finding that out was most of the work.
- WHAT IT DOES: Treats every condition-normalised baseline from checkpoint 4.1 as a
  relation. A baseline says a point should read what its drivers predict, so observed
  minus expected ought to sit at zero exactly like a constraint residual — and its
  derivative with respect to its own target point is exactly plus one, needing no
  differentiation and no fitted coefficients to know.
- CHOICES: Supply air temperature appears in exactly ONE physical constraint, the
  coil energy balance. One relation with one suspect can always be reconciled by
  biasing that suspect: one equation, one unknown, no way to be wrong. So on the
  constraints alone the supply air sensor is unfalsifiable and BOTH faults come out
  as "a sensor explains it". It is the target of two baselines, which takes it from
  one relation to three and makes it falsifiable. The measured separation:

      relation                        d/d(sa_temp)    drift     leak
      CoilEnergyBalance                    -1        -2.11s   -0.03s
      sa_temp.shut-valve-supply-air        +1       +12.18s   -7.91s
      sa_temp.coil-effectiveness           +1       +11.92s   -1.11s

  One bias reproduces the drift column. The leak column disagrees in sign.
- ⚠ JUDGEMENT CALL: The spread each shift is measured against is NOT the spread over
  the reference window. For a baseline that is an in-sample fit error — those are the
  very points the coefficients were chosen to pass through — and using it made the
  drift's two baseline relations read as 12.7 and 12.0 sigma while a hypothesis
  explaining 94 percent of everything was still rejected, because five percent of
  twelve sigma is three sigma. The honest scale is the baseline's own fitted residual
  spread, recovered from the ratio of the stored raw and normalised columns, which is
  exact because one is a linear transform of the other. Driver points are left
  undifferentiated: their sensitivities would need the fitted coefficients, and every
  driver in this model appears in a physical constraint anyway.

`analytics/diagnosis/isolation.py` :: `constraint_sensitivities`
- WHY IT EXISTS: How much a relation moves per unit of bias is its partial
  derivative, and the code needs those without anybody deriving them by hand.
- WHAT IT DOES: Nudges one point's values up and down and re-evaluates the compiled
  expression, at every instant, averaging the central difference over the window.
  Averaging matters because these are not all linear: the coil balance multiplies
  valve position by a temperature difference, so its sensitivity to mixed air
  temperature is one minus the valve position and changes through the day.
- CHOICES: Numerical rather than symbolic so that editing a constraint in the .ttl
  needs no corresponding code change — the same reason the residuals themselves are
  evaluated from the expression rather than reimplemented.

`analytics/diagnosis/isolation.py` :: `feedback_gaps`
- WHY IT EXISTS: A commanded actuator is its own redundant measurement, and this is
  the only test in the layer that needs no reference and no baseline.
- WHAT IT DOES: Pairs each point with its `_cmd` sibling by naming convention — Brick
  has no way to say "commanded value of" — and measures how far position sits from
  command. Two opposite uses: a large gap is a control fault, and a small gap
  EXONERATES that position sensor. On the drift run, isolation wanted to blame the
  chilled water valve for reading 0.217 high; its command sitting 0.0013 away said
  otherwise, and the hypothesis was struck out without any physics being consulted.

`analytics/diagnosis/isolation.py` :: `isolate` and `Hypothesis.verdict`
- WHY IT EXISTS: The sweep that produces the evidence a human reads.
- WHAT IT DOES: Builds the violation vector and sensitivity matrix with every row
  divided by that relation's own spread — without which the chiller energy balance in
  watts, running to six figures, would drown every air-side relation in kelvin and
  the least squares would only ever be about the chiller. Then for each point solves
  the one-unknown least squares, and records the implied bias, the fraction of the
  violation removed, and what it would do to every relation the point touches.
- ⚠ JUDGEMENT CALL: A hypothesis is falsified when applying it would make some
  relation the point appears in MORE inconsistent than it already was. The first
  version demanded the leftover fall under one sigma, which is really demanding 92
  percent accuracy per relation on a 12-sigma violation, and it rejected the correct
  answer. Getting worse is the right test because it is scale-free and it is what
  contradiction looks like: on the leak, a bias chosen to fix the shut-valve baseline
  pushes the coil-effectiveness baseline from −1.11 sigma to +2.88, flipping its sign.
- ⚠ JUDGEMENT CALL: A second requirement is that at least two VIOLATED relations
  agree on the bias, not merely that the point appears in two relations. One violated
  relation corroborates nothing — every point in it explains all of it by
  construction. Condenser fouling is the case that forced this: fouling genuinely
  raises compressor power, so "the meter reads 63 kW high" is arithmetically
  indistinguishable from "the machine now draws 63 kW more" from that relation alone,
  and the energy balance would be pushed to 0.95 sigma by the bias — just under the
  threshold for being called worse. Without this the fouled chiller was diagnosed as
  a faulty power meter.

`analytics/diagnosis/isolation.py` :: `sparse_reconciliation`
- WHAT IT DOES: Coordinate descent on the L1-penalised least squares over all points
  at once, soft-thresholding each coefficient to exactly zero when its fit is smaller
  than the penalty. Answers a different question from the sweep: not "which one
  point" but "how MANY points have to be wrong". A fault needing several sensors
  simultaneously wrong is not a sensor fault. On the drift run it puts +2.415 on
  supply air temperature and +0.001 on everything else, which is the sweep's answer
  arrived at independently.

`analytics/diagnosis/coherence.py` :: `locality`
- WHY IT EXISTS: The independent second opinion. Isolation asks whether a bias can be
  made to FIT; this asks a purely structural question about WHERE the trouble sits,
  fitting nothing.
- WHAT IT DOES: Sums the violation carried by relations containing the candidate, and
  divides by the violation across its whole neighbourhood — every relation reachable
  through points it shares a relation with. Near one means the trouble is confined to
  relations this point can explain. Near zero means its neighbours are as upset as it
  is and a bias on it cannot be the story. The drift scores 1.00.
- ⚠ JUDGEMENT CALL: Computed on residuals, not on raw readings, and the obvious
  reading of the checkpoint's wording is the raw one. It does not work: these air
  handlers run closed loops, so when the supply air sensor drifts high the controller
  opens the chilled water valve until the READING returns to setpoint. Mean valve
  position goes from 0.310 fault-free to 0.445 on the drift run while supply air
  relative to setpoint moves LESS than on the clean run. In raw space a drifting
  sensor looks distributed and its neighbours look guilty. A control loop can hide a
  fault from a measurement but it cannot make a physical relation hold that does not.

`analytics/diagnosis/coherence.py` :: `independent_sets`
- WHAT IT DOES: Counts violated relations sharing no point with any other violated
  one. Two violated relations with nothing in common cannot be explained by any
  single measurement at all — a structural fact that holds before any least squares
  runs and cannot be argued with.

`analytics/diagnosis/classify.py` :: `classify`
- WHY IT EXISTS: The one word a technician acts on, with the reasoning attached.
- WHAT IT DOES: Five branches in a fixed order. An unresponsive actuator; then one
  measurement that explains everything and is localised; then a violation no single
  measurement can account for; then measurements that all agree while a confirmed
  degradation trend says the machine is declining anyway; then nothing to report.
  Each returns the class, the subject, a sentence saying why this class and not
  another, and an `Evidence` record naming every relation and number involved.
- CHOICES: The order is load-bearing, not tidiness. An actuator ignoring its command
  appears in the physics as a measurement that lies, so isolation offers a perfectly
  good sensor hypothesis for it — on the stuck-damper run, supply air temperature
  survives as a suspect explaining 87 percent. Testing the actuator first settles it
  before that arises. The equipment branch is deliberately the fallback, because
  every measurement agreeing while output falls IS what a worn machine looks like.
- ⚠ JUDGEMENT CALL: The control test requires the gap to have GROWN by a factor of
  three over the fault-free window, not merely to exceed a deadband. One actuator
  here fails an absolute test permanently: supply fan speed sits about 0.5 of full
  travel from its own command on every run including the fault-free one, which is the
  same source-data defect Task 3 recorded when it found `sf_status` byte-identical to
  the occupancy schedule. On an absolute test that made a healthy air handler a
  control fault, and because control is checked first it masked BOTH of the faults
  this checkpoint exists to tell apart. The relative test leaves the stuck damper
  firing at 0.612 against a reference of 0.000 and drops the fan at 0.506 against
  0.429.

`analytics/diagnosis/classify.py` :: `untrusted_points`
- WHAT IT DOES: Reads the quality advisories from checkpoint 3.1 and attaches them as
  a caveat that can downgrade confidence from clear to weak but cannot change a class.
- ⚠ JUDGEMENT CALL: The checkpoint asks for the quality flags as a third test and
  they cannot serve as one. Measured across these runs, the supply air sensor draws
  `stale` advisories on ALL FOUR, the fault-free run included — 16 times there
  against 8 on the run where it is genuinely drifting. The quality layer answers "can
  this reading be trusted right now", which is about dropouts and stuck values, and
  is silent on whether a reading arriving perfectly on time is correct. Treating it as
  evidence of a sensor fault would have made the fault-free run the most suspicious
  of the four. It is wired in, and it changes no classification here.

Skipped as boilerplate: the `Relation`, `Feedback`, `Locality`, `Evidence` and
`Diagnosis` dataclasses and their derived properties, `single_bias`, `neighbours`,
`feedback_pairs`, `spread`, `most_localised`, `violated_summary`, `stuck_actuators`,
and the formatting in the verification script.

### MEASURED RESULT — THE KEY TEST

      ahu_sat_sensor_drift        expected sensor      got sensor      PASS
      ahu_cooling_valve_leakage   expected equipment   got equipment   PASS

**Drift, classified SENSOR on `ahu-1.sa_temp`.** Assuming that sensor reads +2.434 K
wrong reconciles 94 percent of the violation across the three relations it appears
in without making any of them worse, and 100 percent of the nearby violation is on
relations it can reach. **The true injected bias is +4 °F, which is +2.22 K** — so
the recovered bias is out by 0.21 K, under ten percent, and the system was never
told the answer. Three competing hypotheses were struck out with named reasons: the
chilled water valve exonerated by its own command feedback, the plant's secondary
supply water temperature unfalsifiable at one relation, mixed air temperature leaving
100 percent unexplained.

**Leak, classified EQUIPMENT.** No single measurement can be biased to reconcile
what is violated. The supply air sensor is the only candidate that fits at all and it
is falsified: the bias that fixes the shut-valve baseline pushes the
coil-effectiveness baseline from −1.11 sigma to +2.88 sigma. The two relations
disagree in sign, so one bias cannot produce both, and the measurements are therefore
consistent with each other while the machine underperforms.

### THE OTHER FOUR, SAME MACHINERY

    ahu_oa_damper_stuck        CONTROL     oa_damper 0.612 from command vs 0.000 clean
    chiller_condenser_fouling  EQUIPMENT   no single measurement reconciles it
    clean_ahu                  AMBIGUOUS   nothing violated, nothing degrading
    clean_chiller              AMBIGUOUS   nothing violated, nothing degrading

Six for six, and all four classes are reached including `ambiguous`. On both
fault-free runs every relation sits below 0.5 of its own spread — the largest is 0.48
— against 12.18 on the drift run, so the separation is not marginal.

### WHAT THIS LAYER CANNOT DO, STATED PLAINLY

- The stuck-damper run has no season-matched fault-free counterpart, because it is a
  late-winter run and the clean air handler run is summer. Its constraint evidence is
  therefore not trustworthy and the output says so. Its classification does not
  depend on it: an actuator disagreeing with its own command needs no reference.
- `chw-plant-1.sec_supply_temp` appears in one relation and can never be exonerated
  or convicted. In this dataset it cannot even be cross-checked, because the .ttl
  already records that the two LBNL systems are independent simulations and the water
  in that expression is not physically the water that cooled that air.
- Every "ambiguous" verdict on a real fault would be resolved by adding one relation
  containing the suspect. That is a modelling change in the semantic model, not a
  threshold change here, which is the decision D-08 records.

START HERE: `analytics/diagnosis/isolation.py` — `baseline_relations`. The checkpoint
is impossible without it: the physical constraints alone leave supply air temperature
in one relation, and one relation with one suspect can never be wrong.

---

## Checkpoint 5.5 — Decision log for RUL and fault discrimination

### WHAT WE DID

The log now records the two decisions Task 5 turned on, and closes out the one
Task 4 left open. The first is why the remaining-life model is a classical
stochastic process rather than a neural network — a choice a reader will question
first, so the reasoning is written to be attacked rather than admired. The second
is why sensor-versus-equipment discrimination is posed as a falsifiable question
about redundancy instead of a pattern learned from examples.

Both entries record something that changed my mind while building them, and in both
cases the thing that changed was the argument for the decision rather than the
decision itself. That is the useful content: a log that only says "I chose X and X
worked" teaches nothing that the code does not already show.

### HOW IT WORKS

`AI_LOG.md` :: D-07 — Wiener first-passage RUL over an LSTM or Transformer
- WHY IT EXISTS: The single most predictable objection to this project is that it
  does not use a deep sequence model on a sequence problem. Declining the
  fashionable method needs an argument on the record, not an omission.
- WHAT IT DOES: Four named options. The deep model is rejected on circularity: no
  public run-to-failure fleet dataset exists for building HVAC, so a network would
  be trained on the degradation ramps this project synthesised and then scored
  against those same ramps, which measures whether it can learn a shape I chose.
  Weibull is rejected as age-based, which is the thing predictive maintenance
  replaces — two identical chillers of the same age, one fouled and one clean, get
  identical answers. Cox is rejected for needing a failure population; there are
  four machines here and zero recorded failures. Wiener first passage is chosen
  because the interval is the model's own output, the parameters are quantities
  somebody can dispute, and the belief narrows by construction.
- CHOICES: The Rationale leads with the closed-form cumulative distribution written
  out, so the claim "the interval is derived, not asserted" can be checked rather
  than believed. Every number in the entry is measured: the posterior spread
  narrowing 0.0110 to 0.0067 to 0.0054 over 17, 57 and 91 days; 12 of 14
  combinations narrowing with one holding and one widening; the three median errors
  of +2.0, +3.9 and +13.6 days.
- ⚠ JUDGEMENT CALL: The Confidence section says high confidence in the family and
  moderate in the numbers, with the reason separated: the confidence rests on the
  interval being derived, the parameters being disputable and the model being able
  to decline — properties of the choice that hold whether or not any prediction
  lands. Three data points on synthetic degradation is explicitly labelled as "the
  machinery is not broken" rather than as an accuracy measurement.

`AI_LOG.md` :: D-07 Outcome
- WHY IT EXISTS: The Outcome is where the argument changed, and it changed in the
  project's favour for a reason I did not have when I made the decision.
- WHAT IT DOES: Records that the estimator on its own produced two badly wrong
  answers with impeccable arithmetic — the air handler reporting it had already
  failed on a fan indicator 0.49 standard deviations from zero, and the fault-free
  chiller predicting a crossing 254 days out. Then the point: the value of an
  interpretable parametric process was not mainly that its predictions were good.
  It was that the drift and its spread are quantities you can test against zero. A
  deep model has no comparable quantity to gate on, so both false answers would
  have shipped. **The refusal layer exists because the model has parameters** —
  that is the real argument for the decision, and it is stated as one I acquired
  rather than one I started with.
- CHOICES: The one cost is recorded rather than buried: the interval genuinely
  widens on the coil valve leak, from unbounded to 1,160 to 1,947 days, because the
  indicator plateaus in exactly that window — which the answer key confirms, the
  fault having reached terminal severity mid-window. Stated as correct behaviour and
  explicitly not tuned.

`AI_LOG.md` :: D-08 — Constraint isolation for sensor versus equipment
  discrimination
- WHY IT EXISTS: Records why the discrimination is a falsification rather than a
  signature, and what that implies about where the capability lives.
- WHAT IT DOES: Three options. A learned classifier is rejected — four labelled air
  handler scenarios means memorisation. A signature rule per fault is rejected for
  not generalising and for being unfalsifiable, in that no observation could
  contradict "this pattern means sensor". Single-sensor bias reconciliation is
  chosen precisely because it CAN be wrong: every hypothesis predicts a specific
  shift in relations it did not come from, and on the drift run one bias of +2.434 K
  reproduces three of them against an injected truth of +2.22 K.
- ⚠ JUDGEMENT CALL: The consequence the checkpoint asked me to record is that
  sensor coverage is a modelling decision in the `.ttl` bindings, with the
  over-determined mixed-air section being what makes isolation possible. I recorded
  a correction to that rather than the claim itself, because the claim is half
  wrong. The mixed-air section does work as described and it is what falsifies mixed
  air temperature on the damper run. But supply air temperature appears in exactly
  ONE physical constraint, so on the constraint set alone it is unfalsifiable and
  both faults in the key test come out as sensor faults. The coverage that made the
  key test possible came from Task 4's baselines, not from the constraint bindings.
  The corrected form — any declared relation counts, and a fitted baseline is one —
  is more useful than the original, because adding a baseline is cheaper than adding
  a physical constraint and needs no new instrumentation.
- CHANGED FROM BEFORE: This is the second entry to carry an **Overrode** section,
  after D-05. Two instructions were followed in a different form than written: the
  localisation test is computed on residuals rather than raw readings, because these
  are closed control loops and in raw space a drifting sensor looks distributed while
  its neighbours look guilty; and the Task 3 quality flags are demoted from a third
  test to a confidence caveat, because the supply air sensor draws stale-data
  advisories on all four runs and 16 times on the fault-free one against 8 on the
  drift run.

`AI_LOG.md` :: D-06 Outcome, updated after Task 5
- WHY IT EXISTS: D-06 ended on a forward claim, and leaving a forward claim
  unresolved is how a decision log becomes decoration.
- WHAT IT DOES: The claim was that fixing the seasonal false onsets needs a longer
  or seasonally refitted commissioning window, which this dataset cannot supply.
  Half right. The two false onsets are real and persist. But a longer window was
  never the only fix and the one that works needed no extra data: the problem was
  not the LENGTH of the reference period, it was that the reference period is the
  wrong period. Comparing against the fault-free run at the same time of year
  instead of the start of the same run takes the coil-leak run's mixed air balance
  from −2.36 of its own spread to +0.03. Same data, same relation, same code.
- CHOICES: Also records that the two false onsets no longer reach anybody, because
  5.3 refuses a rate that cannot be separated from zero and both sit at 0.08 and
  0.11 standard deviations. So the false-positive problem D-06 admitted it had
  relocated rather than solved is now bounded twice, and neither fix touched a
  threshold in the baseline layer — which is where I had expected to have to pay.

Skipped as routine: no code was written in this checkpoint.

### MEASURED RESULT

    8 entries; Forcing question 8, Options 8, Rationale 8, Mine vs delegated 8,
    Confidence 8, Outcome 8, Overrode 2

- Outcome lengths, characters: D-01 3383, D-02 2470, D-03 2397, D-04 2457,
  D-05 3947, D-06 4913, D-07 2760, D-08 2248. None blank, none a stub.
- D-07 carries four named options, D-08 three, both as specified.
- D-06's outcome grew from 2,917 to 4,913 characters with the Task 5 update, and the
  forward claim it previously ended on is now resolved — with the prediction inside
  it recorded as half wrong.
- Every figure quoted in both new entries traces to output in this document or in a
  run script: the +2.434 K recovered bias against +2.22 K injected, the −1.11 to
  +2.88 sign flip, the 0.310 to 0.445 valve position, the 16-against-8 advisory
  count, 0 predictions across 720 fault-free mode-days, and the 5e-16 agreement with
  scipy's Inverse Gaussian.

START HERE: `AI_LOG.md` — the Outcome of D-07. It is the only place in the log that
records the ARGUMENT for a decision changing while the decision stayed put: the
reason to prefer an interpretable model turned out to be that its parameters give
you something to refuse on, which is not why I chose it.


## Checkpoint 6.1 — Cross-asset root cause

### WHAT WE DID

The system can now tell the difference between a machine that is broken and a
machine that merely looks broken because something feeding it is broken. Until
now every layer examined one piece of equipment at a time, on its own evidence,
which is the right way to detect a fault and the wrong way to decide who to send
somebody to see. A chiller that has lost cooling capacity sends warmer water
down the loop, and the air handler it feeds then cannot get its supply air cold
enough however wide it opens its valve — so the air handler, judged on its own
readings, is failing, and a technician sent there finds a coil working perfectly.
The platform now traces each finding back along the pipes recorded in the
semantic model, checks whether anything upstream has a fault of a kind that could
physically produce this particular symptom, and if so marks the downstream item
as a consequence, names the machine to actually visit, and ranks the consequence
below its own cause. It ranks it lower rather than removing it, which matters
because the inference can be wrong and the operator is the only one in a position
to notice: two faults on connected machines in the same fortnight are very often
a coincidence, and an operator who once finds a genuine fault hidden behind a
guess stops believing the queue is complete. Everything the advisory layer, the
API and the dashboard will show is ordered by this ranking, so without it the
first thing an operator sees could be the machine that is fine.

### HOW IT WORKS

`analytics/diagnosis/rootcause.py :: OpenFault`
  WHY IT EXISTS: Cross-asset reasoning has to range over findings from three
    different layers that share no vocabulary — the rule engine reports episodes
    of a physics rule being violated, the health layer reports failure modes with
    a confirmed degradation trend, and the classifier reports a fault class. A
    layer that had to know about all three shapes would need changing every time
    a detector was added.
  WHAT IT DOES: Flattens any finding to the five things cross-asset reasoning
    actually needs: which asset, what the finding is called, when it was first
    and last seen, and how bad it is on a nought-to-one scale. The name is
    whichever identifier the detector that found it uses — a failure mode id like
    `chiller-condenser-fouling` or a rule id like `apar-20` — and `source` records
    which kind it is so an advisory can say where it came from.
  CHOICES: Severity is deliberately made comparable across detectors: a rule
    episode contributes its peak severity directly, and a degradation fault
    contributes the fraction of the way to failure it has travelled, so health 63
    becomes 0.37. Without a common scale one queue could not hold both.

`analytics/diagnosis/rootcause.py :: open_failure_modes(conn, window)`
  WHY IT EXISTS: The degradation side of the queue has to come from what the
    health layer already committed to the database, not from a fresh computation,
    or the advisory queue and the health page can end up disagreeing about which
    modes are open on the same asset.
  WHAT IT DOES: Takes the most recent scored day for each asset and failure mode
    inside the window, keeps only those whose degradation onset was confirmed and
    whose health has fallen below full, and turns each into an open finding. The
    fault is dated from its confirmed onset to the last day it was scored.
  CHOICES: Requires a confirmed onset, so an indicator drifting without
    confirmation cannot reach an operator through this door — that is the same
    gate checkpoint 5.3 applies before publishing a remaining-life number, and
    the two must not disagree. Reports the isotonic-clamped indicator rather than
    the raw daily value, because health is computed from the clamped one and
    printing the raw one next to a health score produces readings that look
    contradictory: on 23 September 2038 the fan indicator's raw value is 178.6 W
    against an 88.9 W failure threshold while health is 63, which only makes
    sense once you know the clamped value that day is 33.2 W.

`analytics/diagnosis/rootcause.py :: Propagation` and `PROPAGATIONS`
  WHY IT EXISTS: Topology says two machines are connected. It cannot say whether
    a particular fault on one can produce a particular symptom on the other, and
    that is a physical claim which has to be written down somewhere it can be
    read and argued with rather than buried in a branch inside the detector.
  WHAT IT DOES: Six rows, each naming an upstream fault, a downstream symptom,
    the medium that carries the effect between them, and the mechanism in one
    sentence. All six are the same physical chain — a chiller that cannot make
    cold enough water, and a coil that consequently cannot reach its supply air
    setpoint — entered once per pair of detectors that can observe each end,
    because the map is keyed on what the detectors are called.
  CHOICES: There is an explicit admission rule, and it is what keeps this from
    being a list of opinions: **a cause must be a fault that degrades the medium
    the downstream asset consumes.** Here the medium is chilled water and the
    property is its temperature. Compressor efficiency loss is therefore excluded
    even though it is the most frequently detected chiller fault in this project —
    a chiller burning more electricity per ton is still delivering water at
    setpoint, and an air handler downstream cannot tell and does not care. The
    two chiller rules that report surplus lift and surplus power are excluded on
    the same grounds. Each exclusion is written beside the map with its reason.
  ⚠ JUDGEMENT CALL: The cooling-coil leak-by mode is excluded in the opposite
    direction and this is the exclusion most likely to look like an omission.
    Warmer chilled water makes supply air warmer; leak-by is supply air being
    colder than it should be. An upstream capacity loss therefore SUPPRESSES that
    symptom rather than causing it, and linking the two would be backwards. The
    alternative — treating any air-side symptom as potentially water-caused —
    would have made the target scenario easier to demonstrate and would have been
    wrong.

`analytics/diagnosis/rootcause.py :: nodes_by_asset(mapping)` and `faulted_nodes`
  WHY IT EXISTS: Traversal happens over graph nodes and faults are detected
    against database assets, and the two are not one-to-one. The air handler is
    one asset in the database and eleven nodes in the graph — a coil, two fans,
    three dampers, five zones — and only the coil is on the receiving end of the
    chilled water loop. Starting the traversal from the wrong node finds nothing
    upstream and looks exactly like a building with no upstream faults.
  WHAT IT DOES: Inverts the node-to-asset mapping so every node of an asset can
    be used as a traversal start, and marks each open fault onto every node of
    its own asset.
  CHOICES: A fault is marked on all of its asset's nodes rather than on the one
    part it belongs to. Guessing which part would need a failure-mode-to-node
    mapping that nothing in the model supplies, and getting it wrong would
    silently break the traversal rather than fail loudly. Marking the whole asset
    is also the honest reading of what the detectors claim — they name an asset,
    not a part.

`analytics/diagnosis/rootcause.py :: upstream_open_faults(...)`
  WHY IT EXISTS: This is the topology half of the inference and the reason the
    chilled water loop had to be modelled as a graph edge back in checkpoint 2.2.
    Anything not returned here is not a candidate cause, which is what stops the
    layer blaming an unrelated machine that happens to be degrading in the same
    week.
  WHAT IT DOES: Runs `open_faults_upstream.rq` from every graph node belonging to
    the symptom's asset, with the other assets' faults asserted into a throwaway
    copy of the graph, then unions the results and keeps the shortest hop count
    for each upstream asset. The asset's own faults are excluded from the marks.
  CHOICES: Self-exclusion is not cosmetic — without it a fault could be offered
    as the cause of its own symptom on the same machine and explain itself away.
    Hop counts come back from the query wrapper rather than being recomputed, and
    the verification cross-checks all seven upstream assets against
    `app.asset_edges`, which was built by an independent breadth-first walk in
    checkpoint 2.3. They agree on every one.

`model/graph.py :: open_faults_upstream(graph, asset, open_faults)`
  WHY IT EXISTS: The typed wrapper around the SPARQL query. Unchanged in purpose.
  CHANGED FROM BEFORE: It used to accept exactly one fault identifier per graph
    node, which was fine when nothing in the project produced faults at all. A
    real asset carries several at once — a chiller can be fouled and short of
    charge simultaneously — and each has to be considered as a separate candidate
    cause, so the value may now be a sequence of identifiers. A bare string is
    still accepted and still means one fault; the normalisation is explicit
    rather than duck-typed because a string is itself a sequence of
    one-character strings, so guessing would have asserted one triple per letter.

`analytics/diagnosis/rootcause.py :: Concurrency` and `concurrency(symptom, cause)`
  WHY IT EXISTS: A cause that was not in force cannot have produced the symptom,
    and a cause nobody has looked at for a year should not be leaned on even if
    the mechanism is sound. Both are needed, and they are different questions.
  WHAT IT DOES: Rejects a candidate whose first evidence comes after the symptom
    was last seen — that is causality, not a threshold. Otherwise it measures two
    things: how many days the two were observed at the same time, and, when they
    never were, how long the cause had gone unobserved before the symptom
    started. It rejects the candidate if that gap exceeds thirty days, and
    otherwise carries both numbers through to the advisory so the operator can
    see which kind of evidence the link rests on.
  CHOICES: Thirty days is placed against the shortest run-to-failure in this
    project, the coil leak at 45 days, so a month of silence still sits inside
    the same failure episode that produced the evidence. It needs tuning against
    real maintenance intervals rather than simulated run lengths.
  ⚠ JUDGEMENT CALL: My first version required the two findings to be observed on
    overlapping days, and that was wrong — not too strict, but modelling the
    wrong thing. A fault is open from detection until repair, and
    `app.maintenance_events`, the table that records a repair, is empty for every
    asset in this project. A condenser fouled in July is certainly still fouled
    in September; requiring simultaneous observation means a cause stops being
    able to explain anything the moment its own sensor coverage lapses. I found
    this because the demonstration failed, which is worth flagging honestly: the
    fix was to correct a model that was wrong, not to relax a threshold until the
    answer came out, and the freshness limit that replaced it is a real constraint
    that rejects stale causes — it is why the same chiller fault cannot explain an
    air handler symptom two years later.

`analytics/diagnosis/rootcause.py :: attribute(graph, mapping, faults)`
  WHY IT EXISTS: The single entry point that decides, for every open fault,
    whether something upstream explains it. Everything above this — advisories,
    the API, the dashboard's demoted rows — reads its output.
  WHAT IT DOES: For each fault, looks up which upstream fault names could
    produce it, traverses the graph for upstream assets actually carrying one of
    those, checks the timing, and keeps the best surviving candidate. All three
    conditions are required and they are independent: the graph says connected,
    the map says physically possible, the timing says in force.
  CHOICES: Ties break on hop distance first and the cause's severity second, so a
    chiller two hops away is preferred over a cooling tower four hops away that
    would explain the same thing. The near cause is the one to send somebody to,
    and if it is itself a consequence of the far one, the same pass says so.

`analytics/diagnosis/rootcause.py :: demote(own, cause_priority)` and `rank(...)`
  WHY IT EXISTS: Marking an advisory consequential changes nothing an operator
    experiences unless it changes where the advisory sits in the queue. This is
    the part that does, and it is also where the demote-versus-hide decision is
    actually implemented.
  WHAT IT DOES: Cuts a consequential advisory to 40 percent of its own priority
    and then, separately, forces it at least 5 percent below its cause's. The
    queue is sorted on the result. Chains are resolved by recursion, so a symptom
    caused by a fault that is itself caused by something further upstream is
    demoted below the middle link's already-demoted priority rather than its
    original one — without that, a two-step chain could leave the last symptom
    outranking the link above it.
  CHOICES: Two mechanisms rather than one because they do different jobs. The
    multiplier expresses that a consequence deserves less attention than a cause
    in general; the clamp guarantees the specific ordering this module promises,
    which a multiplier alone cannot — a severe symptom fed by a mild cause can
    still land on top of it. When the cause has no positive priority the clamp is
    skipped, since clamping to zero would hide the symptom, which is the exact
    behaviour the module is arranged to avoid. `rank` takes the priorities from
    its caller rather than computing them: this module knows about topology and
    mechanism and has no business deciding what a fault is worth. Checkpoint 6.2
    will pass in a cost of inaction; this checkpoint's verification passes in
    severity.
  ⚠ JUDGEMENT CALL: 0.4 is a placement, not a fitted number. It is chosen so that
    a demoted symptom whose own priority is more than two and a half times a piece
    of routine work still outranks that work — a consequence must stop competing
    with its cause for the top of the queue without falling to the bottom of it,
    because it might be a genuine independent fault. The alternative I rejected
    was a rank band, which would have guaranteed the ordering without any
    arithmetic but would also have pushed a severe symptom below every unrelated
    trivial advisory in the building.

`scripts/run_rootcause.py :: main` and the three situations
  WHY IT EXISTS: The verification, and the place where the honesty about what
    this dataset can and cannot show is recorded.
  WHAT IT DOES: Builds the queue three times through the same code. The first two
    run on entirely unmodified data. The third runs on the SAME window as the
    first with exactly one fault added, so the demotion that appears can only have
    come from that fault.
  CHOICES: Situation 1 is the strongest available negative rather than a weak
    one: the air handler's cooling valve really is saturating, the chiller really
    does have a fault open across the same period, and the graph really does
    connect them — every condition holds except the mechanism, and the mechanism
    is what says no. That is a better test of the map than a pair of assets that
    fail on timing or topology as well.
  ⚠ JUDGEMENT CALL: Situation 3's concurrency is composed and this is the one
    thing in the checkpoint a reader should look at hardest. The target scenario
    cannot be observed in this data at all: the two LBNL systems are independent
    simulations, so the air handler's chilled water does not come from this
    chiller, and no air handler run in the dataset is fed by a starved chiller.
    The calendars make it doubly impossible — every chiller run ends on 7
    September and the saturated valve does not sustain until 11 September, so the
    two ends of the chain never share a single day. Rather than report the
    checkpoint unverifiable, situation 3 takes the chiller's REAL detected
    condenser fouling — real confirmed onset, real health score of 84, real
    indicator of 0.492 of 3.0 degC — and moves its dates forward by two whole
    years in a four-line function. Nothing inside either fault is altered and the
    topology is not touched. Whole years, because the simulator places every
    scenario a whole number of years from its 2018 source window precisely so
    day-of-year and time-of-day survive the move. The alternative was to declare
    the scenario untestable, which would have left the most important inference in
    the layer unexercised.

### The verification, in one paragraph

Same window, same code, one fault added. Without the fouling fault the queue is
led by the air handler's saturated cooling valve at priority 1.000 and nothing is
attributed to anything. With it, the valve advisory drops to 0.152 at position 4,
below the chiller at 0.160, marked consequential, linked to `chiller-1` two hops
upstream through the chilled water loop, with the mechanism and the 5.8-day
evidence age printed beside it — and still present in a queue of six.

The attribution is also, on this particular run, WRONG, and that is the most
useful thing in the checkpoint. Checkpoint 5.4 classifies the air handler's fault
on this same run as a SENSOR fault: the supply air thermometer is drifting high
and the controller is saturating the valve chasing a temperature that is not
real. So the queue has just blamed a chiller for a thermometer. Because the
advisory is demoted rather than suppressed, it is still on screen with its own
evidence attached and an operator can overrule it. Had it been hidden, a drifting
sensor would have disappeared behind a chiller that had nothing to do with it —
which is the argument for demote-over-hide, arrived at from the wrong side.

START HERE: `analytics/diagnosis/rootcause.py` — the plausibility map and its
admission rule are the whole checkpoint; the traversal and the ranking exist to
serve them.


## Checkpoint 6.2 — Advisory generation

### WHAT WE DID

The system can now produce work orders instead of numbers. Every layer before this
one ends in a measurement — a residual, a health score, a prediction interval, a
fault class — and none of those is something a maintenance team can be dispatched
on. An advisory now arrives as the whole argument in one piece: which machine,
what is wrong with it, whether the trouble is the machine or the instrument
measuring it, when it is expected to fail and with what spread, which readings
support that and how far each of them moved, who upstream might really be at
fault, which rooms and how many people are affected, what leaving it alone costs
in dollars over the next quarter, what fixing it costs in technician-hours and
parts, and the specific job to raise. The queue is then ordered by dollars saved
per dollar spent, so the first thing an operator sees is the work with the best
return rather than the loudest alarm. Two things make this different from a
conventional alarm list. Every dollar figure traces back to a coefficient measured
on a fault-free run and a rate written down in the semantic model, so a number can
be argued with rather than only believed. And where a figure genuinely cannot be
computed, the advisory says so and is ranked on what is known, instead of a zero
standing in for an unknown.

### HOW IT WORKS

`scripts/schema.sql :: app.failure_modes.penalty_kw_per_unit` and `penalty_basis`
  WHY IT EXISTS: The bridge from physics to money, and without it every priority in
    the system would rest on a guess. The health layer measures degradation in
    kelvin, watts and kilowatts per ton; a maintenance budget is in dollars. This
    column says how many excess kilowatts one unit of each mode's indicator
    represents.
  WHAT IT DOES: One coefficient per failure mode, each measured on a fault-free run
    at that machine's own average operating point, with the arithmetic recorded
    beside it in a column the database requires to be more than a token. Condenser
    fouling is 1.876 kW per kelvin, from 2.5 percent of the 75.04 kW mean compressor
    power measured over 30,078 running samples. Compressor efficiency loss is 48.34
    kW per kW/ton, which is simply the measured mean load. Coil valve leak-by is
    0.928 kW per kelvin, from the 2.0192 m³/s mean airflow measured over the 16,353
    samples where the valve is actually commanded shut, converted to electricity at
    the machine's commissioned efficiency. Fan bearing wear is 0.001, a unit change.
  CHOICES: Two of the six modes are deliberately NULL and that is the interesting
    part. Refrigerant charge loss is NULL because a short-charged chiller draws LESS
    power, not more — it is failing to make the water rather than paying extra to
    make it — so a positive coefficient would have got the sign of the cost wrong.
    Filter loading is NULL because its indicator is NULL: there is no differential
    pressure instrument to multiply.
  ⚠ JUDGEMENT CALL: The coil leak coefficient counts the chiller electricity only.
    Overcooled air is reheated back to setpoint downstream, which would roughly
    double the figure, but this building has no reheat instrument, so that half is
    left out rather than estimated. The advisory therefore understates the cost of
    that fault, which is stated in the basis column rather than quietly split.

`model/extensions.ttl :: mvn:electricityTariffUSDPerKWh`, `mvn:labourRateUSDPerHour`
  WHY IT EXISTS: A cost of inaction needs a price for a kilowatt-hour and a cost of
    acting needs a price for an hour of somebody's time. Both are business inputs
    like replacement cost, so they belong in the model where they can be edited with
    their reasoning attached, not as constants inside the advisory code.
  WHAT IT DOES: Declares the two properties in the extension vocabulary and asserts
    them on a site node — 0.128 USD/kWh, the 2024 US commercial average, and 95.00
    USD per fully loaded technician-hour. Asserted once at site level because a
    building buys electricity and labour once, and because every advisory must price
    against the same rates or the ranking compares incomparable numbers.
  CHOICES: The tariff is flat, with no time-of-use rate and no demand charge, which
    is recorded in the comment as an understatement: a chiller losing efficiency on
    the hottest afternoon of the year is exactly the fault a demand charge would
    punish, and the real bill would be worse than this project reports.

`model/building_extensions.ttl :: occupants per zone`
  WHY IT EXISTS: The downstream half of the graph trace terminates on the five
    occupied zones, and until now they carried no occupancy at all, so the trace
    could name the rooms but not the people in them.
  WHAT IT DOES: Asserts 40 occupants on each of the five zones. The five sum to the
    200 already on the air handler, so the asset-level figure and the zone-level
    figures are consistent by construction and either can be checked against the
    other.
  CHOICES: Uniform across the five zones because nothing in the source data
    distinguishes them — LBNL publishes a zone temperature per zone and an occupancy
    schedule for the unit as a whole, with no headcount and no floor area. Recorded
    as estimated in the comment.

`scripts/schema.sql :: app.intervention_library`
  WHY IT EXISTS: An advisory that names a failing machine and stops there hands the
    problem back to whoever asked. It is also the denominator of the ranking: the
    cost of acting is duration times the labour rate plus parts, which is exactly
    what these rows hold.
  WHAT IT DOES: Sixteen seeded rows, each with the job in words, its wrench time, the
    trades required, the materials, the parts cost and a basis for the estimates.
    Keyed on the fault the way the detector that found it names it — a mode id for a
    degradation fault, a rule id for a rule firing — and NOT a foreign key to
    app.failure_modes, because rule ids are not failure modes and half the rows would
    be unrepresentable.
  CHOICES: The `applies_to_class` column is the point of the table. Two rows answer
    the same fault, `apar-20`, a cooling valve that has run fully open: classified as
    a sensor fault it is ninety minutes with a reference probe, classified as an
    equipment fault it is six hours of coil survey. Same symptom, same rule id, 3.2
    times the cost, and the only thing choosing between them is checkpoint 5.4. The
    lookup prefers an exact class match and falls back to the class-independent row.

`analytics/advisories/generate.py :: classify_fault(...)`
  WHY IT EXISTS: Fixes a real defect that only became visible once advisories were
    assembled. The classifier from checkpoint 5.4 answers per ASSET per window, which
    is the right question for it and the wrong granularity for an advisory, because a
    machine can carry two unrelated faults at once.
  WHAT IT DOES: Decides the class per fault. A rule firing takes the asset's class
    directly, because a rule reports a symptom and "why" is exactly what the
    classifier answers. A failure mode is equipment degradation by construction —
    the health layer measured a physical quantity trending to a threshold and the
    changepoint detector confirmed the onset. Unless the mode's own indicator is
    computed from the very measurement the classifier accuses, in which case the
    trend may be an artefact of the lying instrument and the mode inherits the sensor
    verdict.
  CHOICES: The check is textual — the accused point id against the mode's indicator
    expression with `@asset` substituted — which is exact enough because those
    expressions name their points explicitly.
  CHANGED FROM BEFORE: The first version handed every fault on an asset the asset's
    class. On the 2038 air handler run that labelled the supply fan's bearing wear a
    SENSOR fault, because the supply air thermometer on the same machine is drifting.
    The two faults have nothing to do with each other and the label would have sent
    somebody with a reference probe to a worn bearing.

`analytics/advisories/generate.py :: contributing_signals(...)`
  WHY IT EXISTS: The evidence a technician can go and check for themselves. Reads raw
    measurements rather than residuals on purpose: residuals are the better detection
    signal and are reported separately as the diagnosis evidence, but an advisory has
    to be checkable against the building automation system a technician can actually
    open, and that system shows raw values.
  WHAT IT DOES: Compares every point on the asset between the advisory window and a
    fault-free reference window, ranks by how many of its own reference standard
    deviations it moved, and returns the top six with both values and the movement.
    Points whose mean quality score in either window is below 50 are dropped and
    counted, and the count is reported.
  CHOICES: The quality gate is 50, matching the threshold the rule engine and the
    fault classifier already use, so three layers cannot disagree about what
    untrusted means.
  ⚠ JUDGEMENT CALL: I originally omitted the quality filter, and it broke the report
    in a way worth recording. The air handler's supply air static pressure SETPOINT
    is corrupt in every synthesised run: it should be a constant 400.4 Pa and instead
    sits pinned at −99698.47 Pa, about minus one atmosphere, for 14,176 of the 34,560
    samples in the 2038 window. Ranked on movement alone it was the largest mover on
    the asset by a factor of ten thousand and crowded every real signal out of the
    advisory. The quality layer from checkpoint 3.1 had already scored it 0 out of
    100 on all 17,280 samples and raised out_of_range advisories against it — the
    detection worked, and the advisory layer simply was not reading the verdict.

`analytics/advisories/generate.py :: prognosis(...)` and `Prognosis.sentence`
  WHY IT EXISTS: The remaining-life sentence, and the guarantee that an advisory
    never invents one. A planner reading "likely to fail in 40 to 120 days" and a
    planner reading "cannot bound this" make different decisions, and collapsing the
    second into a vague version of the first is the easiest way to make the whole
    system untrustworthy.
  WHAT IT DOES: Reads the latest row checkpoint 5.2 published on or before the
    advisory date and renders it as "likely to fail in X to Y days, median Z, from N
    post-onset samples". When there is no row, or the interval is unbounded, it
    reports the refusal and its reason in the place the interval would have gone.
  CHOICES: `probability_by(days)` interpolates across the three stored quantiles
    rather than recomputing the first-passage distribution, and that is deliberate
    with a cost. app.rul_estimates stores P10, P50 and P90 and not the distribution
    behind them, so an exact figure would mean refitting the process here — and an
    advisory that refits is an advisory that can contradict the remaining-life page
    it is summarising. Agreement with what the system already published matters more
    than the last few percent of accuracy.

`analytics/advisories/generate.py :: severity(...)`
  WHY IT EXISTS: How urgent this is, on a scale that can rank a chiller against an
    air handler.
  WHAT IT DOES: Four inputs, each put on nought to one before weighting because they
    are measured in incompatible things. Rate of decline in health points per day
    from a least-squares fit over the last 28 days; urgency from the published median
    time to failure against the 90-day horizon; criticality from the tier; occupancy
    from the headcount as a fraction of the building's largest.
  CHOICES: Weights are 0.35 slope, 0.35 urgency, 0.15 criticality, 0.15 occupancy.
    The two the system MEASURED carry 0.7 between them and the two that are business
    context carry 0.3, because tier and headcount should shade a ranking rather than
    decide it: a tier 1 asset that is not degrading is not urgent. The slope
    saturates at one health point per day, which takes a machine from new to failed
    in a quarter and is about as fast as anything here degrades. The 28-day fit
    window makes the number the CURRENT rate rather than the average since onset, so
    a fault that has plateaued stops being urgent.
  ⚠ JUDGEMENT CALL: The urgency term is zero when there is no prediction, rather
    than a guess. A refused advisory is therefore ranked on its rate of decline and
    what it serves, and can still reach the top of the queue on those alone — it just
    cannot borrow urgency from a prediction that was never made.

`analytics/advisories/generate.py :: duty_fraction(...)`
  WHY IT EXISTS: An excess-power penalty is only paid while the machine is on, and
    these machines are off a great deal — the air handler is occupied 53.8 percent of
    the time.
  WHAT IT DOES: Counts the fraction of samples in the window where the asset's duty
    indicator is above a threshold, trying compressor power, then the occupancy
    schedule, then fan power.
  CHOICES: Costing a fault at 24 hours a day would overstate every advisory by
    roughly a factor of two, uniformly — so it would not even have the decency to
    change the ranking. Falls back to the whole window when no duty point exists,
    which errs toward overstating cost.

`analytics/advisories/generate.py :: cost_of_inaction(...)`
  WHY IT EXISTS: The numerator of the priority, and the place the project's claim
    that nothing is hand-waved either holds or fails.
  WHAT IT DOES: Two terms. ENERGY is the mode's current indicator times the measured
    kilowatts-per-unit coefficient times the running hours over the horizon times the
    site tariff. CONSEQUENTIAL is the chance of reaching the failure threshold inside
    the horizon, read off the published prediction interval, times replacement cost
    minus repair cost — that difference being the real penalty for waiting, since the
    repair is owed either way and running a machine to failure converts it into a
    purchase.
  CHOICES: The energy term is held flat at today's indicator rather than projected
    along the degradation trend. That understates an accelerating fault, and the
    alternative would make the figure depend on a fit the refusal layer may have
    declined to publish.
  ⚠ JUDGEMENT CALL: When NEITHER term can be computed the result is marked
    unpriceable rather than returned as zero dollars, and the priority becomes None
    rather than 0.00. Zero is a claim — it says the fault is free to ignore — and a
    cooling valve saturated at severity 1.00 serving two hundred people is not free
    to ignore just because this building does not meter what it costs. The rejected
    alternative was to price comfort by inventing a dollars-per-degree-hour rate,
    which is exactly the hand-waving the checkpoint forbids.

`analytics/advisories/generate.py :: recommend(...)` and `Intervention.effort_usd`
  WHY IT EXISTS: Turns the fault into a job with a price, and is where the
    sensor-versus-equipment discrimination stops being an academic result.
  WHAT IT DOES: Looks up the intervention library preferring a row written for this
    fault CLASS and falling back to the class-independent one, then prices the effort
    as duration times the site labour rate plus parts. Returns None rather than a
    placeholder when nothing matches, so a fault with no recorded response shows as a
    gap in the library instead of arriving with an invented recommendation.

`analytics/advisories/generate.py :: rank_key(...)` and `queue(...)`
  WHY IT EXISTS: The order an operator reads.
  WHAT IT DOES: Two tiers. Priced advisories first, sorted on dollars saved per
    dollar spent; unpriced ones after, sorted on severity. Consequential advisories
    are demoted within whichever tier they are in, using the same 40 percent cut and
    the same clamp under the cause as checkpoint 6.1.
  CHOICES: Two tiers rather than one number, because a priority in dollars-per-dollar
    and a severity on nought to one are not the same quantity and combining them
    would invent a comparison. The operator sees the boundary and knows the second
    group is ordered on how bad the fault is rather than what it costs. The demotion
    is re-applied here rather than reused from 6.1 because an advisory's economic
    priority does not exist until its intervention has been priced, which happens
    after the cross-asset pass has already run on severity.

`analytics/advisories/generate.py :: withhold_if_contradicted(...)`
  WHY IT EXISTS: Two of the system's own published numbers describe the same thing --
    how far a mode has travelled toward failure. Health says it directly; the median
    time to failure says it by implication. When they disagree by the whole range, at
    least one is wrong and nothing in this layer can tell which. This is the gate that
    refuses to publish either rather than printing both and letting the reader guess.
  WHAT IT DOES: When health reports more than half a life remaining and the estimate
    reports the failure threshold reached inside a tenth of the planning horizon, the
    prediction is dropped, its place in the advisory carries the contradiction in
    words, and the advisory continues on health, severity and the energy penalty,
    which are unaffected.
  CHOICES: The PREDICTION is what gets dropped, not health, because health is the more
    robust of the two here: an isotonic fit over the whole window against a running
    maximum that any single outlier latches onto permanently. Withheld rather than
    flagged-and-published, because the prediction is not merely displayed -- it feeds
    the consequential term of the cost of inaction, where a spurious zero-day forecast
    is worth the asset's entire replacement cost.
  ⚠ JUDGEMENT CALL: This is a real inconsistency between checkpoints 4.4 and 5.2, and
    I have contained it here rather than re-engineering either. The air handler's fan
    indicator reads between 3.4 and 7.5 watts on 30 of the last 34 days of the 2038
    run, against an 88.9 watt failure threshold, with isolated single-day excursions to
    245, 406 and 178.6 watts. The isotonic clamp reads that correctly as a machine
    barely degrading -- 33.2 watts, health 63. The running maximum latched onto the
    excursions and published a median time to failure of zero days, which was worth
    68,400 USD of expected replacement cost and put the LEAST degraded mode in this
    building first in the entire priority queue at 18.89 against the genuinely fouling
    chiller. With the gate in place the queue is led by the chiller and the fan advisory
    falls to 0.00 with its prediction withheld and the reason stated. The alternative
    was to change the level definition in 5.2 or the clamp in 4.4, which would have
    invalidated the verified numbers in 4.4, 5.1, 5.2 and 5.3; the deeper fix is to make
    the daily indicator robust to these excursions at source, in 4.3, and that is
    recorded as outstanding rather than done.

`analytics/advisories/generate.py :: build(...)`
  WHY IT EXISTS: Assembling every field in one object.
  WHAT IT DOES: Runs the steps in the order the argument needs them, since severity
    needs the prediction, the cost needs the prediction and the duty, and the priority
    needs both the cost and the intervention. Applies the contradiction gate above
    before anything consumes the prediction.

`scripts/run_advisories.py :: completeness(...)`
  WHY IT EXISTS: The checkpoint asks for three advisories with every field populated,
    and that is checked here rather than asserted in prose.
  WHAT IT DOES: Walks the advisory's fields, splits the empty ones into those that are
    legitimately absent for a recorded reason — a rule firing has no mode id and no
    health score — and those that are not, and fails the run on any of the second
    kind. Reports 19 of 22, 19 of 22 and 21 of 22 populated across the three, with
    every empty field explained.

### The verification, in one paragraph

Six advisories, ordered by dollars saved per dollar spent: condenser fouling at 18.89,
compressor efficiency loss at 16.21, the fan bearing at 0.00 with its contradicted
prediction withheld, a nearly healthy second chiller at 0.00, and two unpriced
air-side rule firings, the last of them the demoted consequential one. Every dollar figure decomposes on screen — 30,418.85 USD
for the fouling advisory is 218.85 of electricity, from 0.492 indicator units times
1.876 kW per unit over 1,854 running hours at 85.8 percent duty and 0.128 USD/kWh,
plus 30,200 of exposure, from a 10.0 percent chance of crossing the threshold inside
90 days against 302,000 USD of replacement over repair. The same fault looked up
under two classes returns two different jobs at 262.50 and 830.00 USD, which is what
the discrimination in checkpoint 5.4 is worth in dispatch terms.

START HERE: `analytics/advisories/generate.py` — `cost_of_inaction` and `rank_key`
are the two functions that decide what an operator sees first, and everything else in
the file exists to feed them numbers that can be traced.


## Checkpoint 6.3 — API

### WHAT WE DID

Everything the platform computes is now reachable over HTTP, which is what makes a
user interface possible at all. Nine endpoints cover the equipment list and each
machine's instruments, health over time, hourly sensor readings, the full history
of every remaining-life prediction ever made, the operator's work queue with each
advisory in full, and the pipe-and-duct graph in both directions. The API only
reads: everything it serves was computed and committed by a script beforehand.
That boundary is deliberate rather than tidy, because assembling one advisory means
running the fault-isolation sweep, the physics rules and the health replay over a
multi-month window, which takes minutes — nothing an operator refreshing a screen
could wait for. So the advisory queue became a stored table, written once by the
analytics layer and served instantly. Two guarantees are enforced rather than
promised: sensor readings are served only from the hourly summary and never from
the raw table, and the API connects as the restricted database role that has no
access whatsoever to the labelled answer key, so no endpoint can leak it even by
mistake.

### HOW IT WORKS

`scripts/schema.sql :: app.advisories`
  WHY IT EXISTS: The advisory queue has to be readable in milliseconds and is
    expensive to compute in minutes, so it is stored. Without the table the
    dashboard would have to recompute the isolation sweep, the rule engine and the
    health replay on every page load.
  WHAT IT DOES: One row per open fault. The scalar columns are the ones the queue is
    filtered and sorted on — status, fault class, severity, priority, the two dollar
    figures, whether it is consequential and what caused it — and everything else
    travels in a JSONB payload, so adding a field to an advisory is not a migration.
  CHOICES: The identifier is deterministic, built from the asset, the fault and the
    end of the window it was computed over, so re-running the advisory layer over the
    same window updates the same row instead of accumulating a second copy. `priority`
    is nullable and NULL is a statement, not a gap, following the same convention as
    app.rul_estimates: it means the cost of inaction could not be computed, which is
    emphatically not the same as zero. A CHECK constraint ties `consequential` to the
    presence of a cause so the flag and the cause can never disagree.
  ⚠ JUDGEMENT CALL: `status` exists with three values and nothing in this project
    ever moves a row off `open`. There is no acknowledge or close action, so the
    filter the API exposes always returns everything. I kept the column because the
    endpoint contract the checkpoint specifies exposes the filter and because a queue
    with no way to retire an item is not a queue — but it is dead weight today and the
    column comment says so rather than implying a workflow that does not exist.

`analytics/advisories/generate.py :: as_payload(advisory, priority)`
  WHY IT EXISTS: The published shape of an advisory, and the only place it is decided.
  WHAT IT DOES: Writes the advisory out field by field into nested JSON — asset,
    fault, forecast, signals, evidence, trace, severity, cost, effort, priority,
    intervention, notes.
  CHOICES: Written out explicitly rather than by reflecting over the dataclass. A
    generic dump would make every internal rename a breaking API change and would
    silently start publishing any field added for internal use.

`analytics/advisories/generate.py :: write_advisories(...)`
  WHY IT EXISTS: Commits the queue so the API can serve it.
  WHAT IT DOES: Deletes every row and inserts the current queue inside one
    transaction.
  CHOICES: Replaced rather than merged, for the same reason app.asset_edges is: this
    is derived output and a stale row is worse than a missing one. An advisory left
    over from a previous run points a technician at a fault the current evidence no
    longer supports, and nothing in the queue would mark it out of date. Sharing a
    transaction means no reader ever sees the queue empty.

`api/db.py :: connection()` and `semantic_graph()`
  WHY IT EXISTS: The two resources every endpoint needs, with very different costs.
  WHAT IT DOES: A database connection is opened per request and closed with it — no
    pool, because a pool is state that has to be sized, monitored and drained and this
    API serves one dashboard against a local database. The semantic graph is parsed
    once, lazily, and kept, because merging three Turtle files takes a noticeable
    fraction of a second and the traversal endpoints would pay it on every call.
  CHOICES: Caching the graph is only safe because nothing in the API asserts a triple
    into it. The one place in the project that does assert triples — marking open
    faults for cross-asset traversal — works on a throwaway copy, which is why this
    is a shared read-only object rather than a hazard.

`api/models.py` — the Pydantic v2 response models
  WHY IT EXISTS: The contract the frontend is written against. A field renamed here
    is a breaking change; a field renamed in the analytics layer is not, and that
    indirection is the point.
  WHAT IT DOES: Fourteen models covering the nine endpoints. Every optional field
    means "the system declines to say" rather than "we forgot", and each one travels
    beside a text field carrying the reason — a null p50 next to a refusal sentence, a
    null priority next to the cost basis.
  CHOICES: `AdvisoryDetail.detail` is passed through as the JSON the advisory layer
    wrote rather than being re-modelled field by field, which is a deliberate
    exception to this file's own rule. The payload is deeply nested and its shape is
    already fixed by `as_payload`; re-declaring forty nested fields would create two
    contracts to keep in step instead of one.

`api/main.py :: _LATEST_HEALTH`
  WHY IT EXISTS: Every endpoint that shows an asset shows its current health, and
    "current" turns out to be the hard part.
  WHAT IT DOES: Reports each asset's health as of the vintage of that asset's own
    advisories, falling back to its newest row when it has none.
  ⚠ JUDGEMENT CALL: The obvious implementation — the newest row per asset — was
    wrong in a way that made the whole system look broken. This database holds eight
    independent simulation runs placed in separate calendar eras, so the newest row
    for the air handler belongs to whichever of its runs sits latest in the calendar,
    which is the FAULT-FREE run of 2039. The asset list therefore showed health 98
    beside three open advisories. Anchoring to the window the advisories were computed
    over makes the two agree: the air handler now reads 63, which is the number its own
    advisory quotes. Assets with no advisories keep their newest row, which is correct
    for them because nothing is being claimed about them.

`api/main.py :: get_timeseries(...)`
  WHY IT EXISTS: The chart data, and the one endpoint with a hard rule attached.
  WHAT IT DOES: Serves hourly buckets — mean, minimum, maximum, sample standard
    deviation and count — for named points on one asset, from app.measurements_hourly.
    The raw measurements table is not referenced anywhere in the file, which is
    checkable by grep.
  CHOICES: The standard deviation within each hour is carried alongside the mean
    because a widening spread is itself an early degradation signal, and a chart that
    plots only the mean throws it away. Points must belong to the named asset, so a
    typo returns 400 with the reason rather than an empty chart the caller has to
    debug.

`api/main.py :: list_advisories(...)`
  WHY IT EXISTS: The queue, in the order it should be worked.
  WHAT IT DOES: Filters on status, minimum severity and fault class, and orders
    priced rows above unpriced ones.
  CHOICES: The two-tier order is expressed as `priority IS NULL` ascending, then
    priority descending, then severity descending — which puts every priced row above
    every unpriced one without pretending a null priority is a number. `severity`
    filters rather than reorders: an operator narrowing to severity above 0.5 wants
    fewer rows in the same order, not a different ranking.

`api/main.py :: advisory_summary(...)`
  WHY IT EXISTS: The strip along the top of the dashboard — asset count, advisory
    count, how many are consequential, how many unpriced, the breakdown by fault
    class, the worst health in the building and the totals.
  CHOICES: Declared BEFORE the parameterised advisory route on purpose. FastAPI
    matches routes in declaration order, so with `/advisories/{advisory_id}` first
    this path would be read as an advisory whose id is the word "summary" and 404.

`api/main.py :: _traverse(...)`, `graph_upstream`, `graph_downstream`
  WHY IT EXISTS: The pipe-and-duct graph, annotated with what is wrong on each node.
    Upstream is the cause direction; downstream is who suffers.
  WHAT IT DOES: Traverses from every graph node belonging to the asset and unions the
    results, keeping the shortest hop count, then joins health and open advisory
    counts onto each asset reached. Downstream additionally collects the occupied
    zones and sums the people in them.
  CHOICES: Every node, not one. The database models a machine as a single asset while
    the graph models its parts, and the pipes attach to the parts — traversing from the
    node called AHU alone finds nothing upstream of the air handler, because the
    chilled water arrives at its cooling coil.

`model/building_extensions.ttl` — the air-side continuation
  WHY IT EXISTS: Closes a gap in the model that only became visible once the API
    served a downstream trace.
  WHAT IT DOES: Adds six authored triples: the cooling coil feeds the supply air fan,
    and the supply air fan feeds each of the five zones.
  ⚠ JUDGEMENT CALL: LBNL publishes exactly one flow statement on the air side — the
    air handler feeds its five zones — and the chilled water loop lands on the cooling
    coil. Those two facts do not join up, because the coil is a `hasPart` of the air
    handler, which is containment and not flow. So a traversal from a chiller arrived
    at the coil and stopped: asked who a failing chiller affects, the platform could
    answer "the air handler" and could NOT answer "two hundred people". With the six
    triples the chain runs cooling tower to condenser loop to chiller to chilled water
    loop to coil to supply fan to zones, and occupant impact is reachable from any
    water-side fault. Whether the fan sits before or after the coil in this unit is
    not determinable from the published data and does not matter, because either order
    gives the same reachability and reachability is all these edges are used for.
    Verified not to disturb anything: app.asset_edges rebuilds to the same 25 rows
    with the same hop distances, because every node named maps to ahu-1 and the cache
    drops self-edges.

### The verification, in one paragraph

All nine endpoints return 200 against live data. `/assets` lists eight machines with
health anchored to their advisory vintage and occupant counts read from the model.
`/assets/chiller-1` returns nine instruments with units. `/assets/chiller-1/health`
returns per-mode and roll-up rows carrying both the raw and clamped indicator and the
confirmed onset date. `/assets/chiller-1/timeseries` returns 24 hourly buckets from
app.measurements_hourly with mean, min, max, spread and sample count.
`/assets/chiller-1/rul-history` returns 138 condenser-fouling estimates and 292
efficiency-loss estimates with the P10-to-P90 width per date — the series the
narrowing-interval chart is drawn from. `/advisories` returns the six-row queue with
two unpriced rows sorted below the four priced ones and the consequential row last.
`/advisories/summary` returns 6 advisories, 1 consequential, 2 unpriced, 4 equipment
and 2 sensor, worst health 0 on chiller-1, 314,851.75 USD of cost of inaction against
38,192.50 USD of effort. `/advisories/{id}` returns the whole payload including the
cost arithmetic in three lines and the recommended job.
`/graph/upstream/ahu-1` returns all seven upstream assets at 2 and 4 hops with their
health and advisory counts; `/graph/downstream/chiller-1` now returns the air handler
plus five zones and 200 occupants, and `/graph/downstream/ct-1` reaches four assets,
five zones and 200 occupants at up to four hops.

START HERE: `api/main.py` — the nine route handlers, and the `_LATEST_HEALTH`
fragment above them that decides what "current health" means in a database holding
eight simulation runs in different years.

### Checkpoint 6.3 addendum — debt cleared

Two items of carried-forward debt, cleared on request rather than as part of a
numbered checkpoint.

`app.points.usable` and `unusable_reason`, and the manifest keys behind them
  WHY IT EXISTS: Three of this building's 107 measurements are defective at source in
    ways no per-row processing can repair, and all three were already documented as
    DO NOT USE in prose in the ingestion manifests. Prose is not enforcement: the
    advisory layer read one of them anyway and put it at the top of the evidence list
    on every air handler advisory. These two columns are that prose made
    machine-readable.
  WHAT IT DOES: A boolean on the point catalogue with a required reason, set from a
    `usable: false` key in the manifest and carried into the database by the loader's
    existing catalogue upsert. The advisory evidence ranking excludes them; the API
    publishes both fields so a chart can grey the point out AND say why.
  CHOICES: This is deliberately NOT folded into the quality score, and the distinction
    is the whole point. Quality asks whether a particular reading can be believed
    right now and answers per sample. This asks whether the column means what its name
    says at all, and answers once. Supply air static pressure is the case that proves
    neither subsumes the other: it averages 89.5 out of 100 and passes the quality gate
    comfortably, because its readings are consistent, punctual and inside their
    physical envelope — they are simply recorded in inches of water in 20 of the 21
    source files and in Pascals in the other, so the stitched series is meaningless.
    No per-sample score can see that. A reading can be entirely trustworthy and still
    mean nothing.
  ⚠ JUDGEMENT CALL: The instruction was to add a specific exclusion for the known
    sa_static_p artefact. I generalised it to a declared property of the point instead
    of a named exclusion in the advisory code, for two reasons. A hardcoded point id
    in the ranking function would be invisible to the other six consumers of
    app.points, and it would have needed a second copy the next time somebody noticed
    the same class of defect — which they already had, twice, in the same manifest.
    Three points are now flagged, not one: the outdoor airflow column that is a
    constant design figure rather than a measurement was carrying the same DO NOT USE
    prose and the same lack of enforcement.
  CHANGED FROM BEFORE: The AHU evidence list was led by supply air static pressure at
    −386.8 sigma, an artefact. It is now led by the chilled water valve position at
    +0.4 sigma, moving 0.310 to 0.445 — which is the actual mechanism of the fault on
    that run: the controller opening the valve to chase a supply air thermometer that
    is reading high. Exclusion counts are reported separately for the two reasons, so
    "3 points whose source data is known defective, 1 whose readings the quality layer
    condemned" is visible on the advisory rather than a single opaque total.

`ingestion/lbnl_loader.py :: main(--points-only)` and `SYSTEM_MANIFESTS`
  WHY IT EXISTS: Picking up a catalogue edit needed a way to sync assets and points
    without re-reading 80 million measurements.
  WHAT IT DOES: Upserts the asset and point catalogue from the manifests and stops,
    without opening a single CSV, reporting which points came back marked unusable.
  CHOICES: The manifest list is now named rather than globbed. `point_bounds.yaml`
    shares that directory and is a different shape — no `source_root`, no `points` —
    so the glob picked it up and `load_manifest` would have exited on it. That was a
    latent breakage in `make load` introduced when the bounds file was added in 3.1,
    and it is fixed here because the points-only path walks the same list.

The four ruff findings in `ingestion/lbnl_loader.py`
  WHAT IT DOES: `zip(edges[:-1], edges[1:])` became `itertools.pairwise(edges)`.
    `None if value != value else value` became `math.isnan(value)` — the same NaN test
    written so it does not read as a mistake somebody will later "correct". `_stamp`
    now attaches its fixed UTC offset in the datetime constructor instead of building
    a naive value and calling replace, which is equivalent because the zone has no
    daylight rule and leaves no moment where a naive datetime could escape.
  ⚠ JUDGEMENT CALL: The fourth, DTZ001 on `segment_windows`, is a FALSE POSITIVE and
    is silenced with a noqa and a reason rather than "fixed". Those datetimes are
    window boundaries used only to slice the source CSVs, whose timestamp column
    parses to tz-naive source-local time — `read_segment` subtracts the window start
    from a datetime parsed out of the file and compares the window against the frame
    index. Attaching a timezone would make both operations raise "can't subtract
    offset-naive and offset-aware datetimes". Silencing a rule is the honest fix when
    obeying it introduces a bug; the docstring now says why naive is required.
  VERIFIED: both rewritten functions were checked against their previous
    implementations across 112 cases — 96 combinations of date, offset and trajectory
    index for `_stamp`, 16 combinations of span and segment count for
    `segment_windows` — with zero mismatches, and the windows confirmed still tz-naive.


## Checkpoint 6.4 — Operations dashboard

### WHAT WE DID

There is now a screen. Everything the platform has computed over the previous five
sessions — trustworthiness scores, physics rules, condition-normalised baselines, a
health index, remaining-life predictions and their refusals, sensor-versus-equipment
discrimination, and cross-asset root cause — arrives as a single ranked list of work
with a summary strip above it. The list is ordered by expected dollars saved per
dollar spent, so the first row is the best return rather than the loudest alarm. Each
row names the machine, what is wrong with it, whether the trouble is the machine or
the instrument measuring it, its health score, how long until it fails and with what
spread, and one line of why. Advisories judged to be consequences of a fault
elsewhere are dimmed, indented and marked with the machine actually at fault — still
on screen, ranked lower, because that inference can be wrong and only a human can
overrule it. Where the system cannot compute something it says so on the row instead
of showing a blank or a zero, and the queue is split by a labelled separator at the
point where the ordering stops being about money and starts being about severity.

### HOW IT WORKS

`api/models.py :: AdvisorySummary.p10/p50/p90`
  WHY IT EXISTS: The queue needs a countdown per row and must stay one request.
  WHAT IT DOES: Lifts the three published quantiles out of the JSONB payload onto the
    queue row.
  CHOICES: Extracted with the `#>>` text operator and then cast, not with `#>`.
    Casting a jsonb null straight to double precision is an error in Postgres, and a
    refused prediction stores JSON null in all three — so that is the common path, not
    an edge case. Found the hard way: the first version returned 500 on the whole
    queue.

`web/vite.config.ts` — the dev proxy
  WHY IT EXISTS: How the browser reaches the API.
  WHAT IT DOES: Proxies `/api/*` to port 8000, stripping the prefix.
  CHOICES: The frontend contains no hostname anywhere, so deploying behind a single
    origin needs no rebuild, and no browser request is ever cross-origin — which means
    CORS cannot be the thing that breaks the dashboard. The CORS middleware in the API
    stays as a second line for anyone hitting it directly.

`web/src/types.ts`
  WHY IT EXISTS: The API contract in TypeScript.
  CHOICES: Hand-written rather than generated from the OpenAPI schema. For nine
    endpoints a generator adds a build step and a large file nobody reads; the cost is
    that a field renamed in `api/models.py` must be renamed here too, and the compiler
    will say so. Every `| null` carries the same meaning as in the API — the system
    declines to say — and every nullable field has a sibling holding the reason.

`web/src/api.ts :: get<T>()`
  WHY IT EXISTS: One fetch, with the failure path treated as seriously as the success
    path.
  WHAT IT DOES: Throws on a network error or a non-2xx, with the status, the body and
    the command that starts the API.
  CHOICES: A dashboard that renders an empty table when the API is down is worse than
    one that says the API is down, because an empty table reads as "nothing is wrong
    with the building" — the single most dangerous thing this screen could imply.

`web/src/lib/format.ts`
  WHY IT EXISTS: This is the checkpoint's most load-bearing decision. Every string the
    queue displays is produced here, in a pure module with no React in it, so that the
    contents of the table can be checked by running the same functions against the live
    API rather than by somebody looking at their own screen.
  WHAT IT DOES: `usd` rounds to whole dollars — cents on a five-figure estimate are
    false precision. `priorityLabel` returns the word "unpriced", never 0.00.
    `countdown` returns a cell, a band and whether it is bounded, giving "260 d" with
    "127–569 d" beneath, "now" with "threshold already reached" when every quantile is
    zero, and an em dash with the reason when there is no prediction. `shortRefusal`
    keeps the first clause of a refusal, which is always the reason. `healthLabel`
    returns "n/a" and not 0 for a rule firing, which has no health score. `buildRows`
    assembles the rows in the order they arrived.
  CHOICES: `buildRows` does NOT re-sort. The two-tier ranking is decided by the
    analytics layer, and a dashboard that sorted the rows itself would be free to
    disagree with the numbers it is displaying — the first time it did, the ordering
    would stop being explainable. The rank number is just arrival position.
  ⚠ JUDGEMENT CALL: `healthBand`'s thresholds at 70 and 40 are the only numbers in
    this checkpoint that are not derived from anything. They are presentational: nothing
    branches on them and no value in the system changes if they move. Said so in the
    docstring so a reader does not go looking for a justification that does not exist.

`web/src/components/FaultClassBadge.tsx`
  WHY IT EXISTS: The visible output of the whole sensor-versus-equipment
    discrimination, and the field that decides which van is dispatched.
  WHAT IT DOES: One colour per class, with a hover explanation of what the class
    means.
  CHOICES: AMBIGUOUS is styled flat grey rather than as a warning. It is a real and
    honest outcome — the instrumentation cannot decide this case — and dressing it up
    as an alarm would push operators to treat it as one. On the same reported symptom
    SENSOR and EQUIPMENT differ by 3.2 times in dispatch cost, which is why the badge
    is the leftmost thing after the fault name rather than a detail.

`web/src/components/SummaryStrip.tsx`
  WHY IT EXISTS: The site in one row of cells.
  WHAT IT DOES: Assets, open advisories with the consequential count, worst health and
    which asset has it, cost of inaction over the horizon, cost to act, the unpriced
    count, and the breakdown by fault class.
  CHOICES: Cost of inaction and cost to act are adjacent, because their ratio is what
    the entire queue is sorted by and seeing them together is what makes the ordering
    legible. `unpriced` gets its own cell rather than being folded into the advisory
    count, because it is the honest caveat on the two totals beside it: those are sums
    over the priced rows only.
  ⚠ JUDGEMENT CALL: The strip ends with a line stating when the queue was generated
    and that health is quoted as of each asset's own advisory window rather than
    wall-clock now. That sentence is there because this database holds eight
    independent simulation runs in separate calendar eras, so "now" is not a single
    instant. Without it the screen implies it is live, and a live-looking dashboard
    over historical simulation data is the most misleading thing this project could
    ship.

`web/src/components/AdvisoryQueue.tsx`
  WHY IT EXISTS: The work queue.
  WHAT IT DOES: One row per advisory: rank, asset, failure mode with its id, fault
    class badge, health coloured by band, the countdown with its band beneath,
    priority, cost of inaction with the cost to act beneath, and one line of why. Rows
    carry the full sentence in a title attribute where it is truncated.
  CHOICES: A consequential row is dimmed, indented behind a coloured left border, and
    carries a "↳ caused by <asset> / <fault>" line under the fault name. Dimmed and
    subordinate at a glance, but every field still on screen and still legible —
    demoted, never hidden. The cross-asset inference can be wrong, and on this dataset
    it demonstrably is on one row, so the operator has to be able to overrule it, which
    they cannot do if it is not there.
  ⚠ JUDGEMENT CALL: The boundary between priced and unpriced rows is drawn as a
    labelled separator row rather than left implicit. An operator scanning a priority
    column that suddenly reads "unpriced" needs to be told they have crossed into a
    group ordered on a different quantity, or the ordering looks broken. The separator
    also says an unpriced advisory is not a cheap one, because that is exactly the
    wrong conclusion to draw from a blank.

`web/scripts/verify-queue.ts`
  WHY IT EXISTS: How this checkpoint is verified, given that the project has no test
    suite by deliberate decision and "I looked at it" is not a verification anybody can
    repeat.
  WHAT IT DOES: Fetches the summary and the queue from the running API, renders both
    through the same `format.ts` the React components import, prints them, and then
    checks three properties the queue must have: priced rows all precede unpriced ones,
    every consequential advisory sits strictly below the row it names as its cause, and
    no unpriced advisory renders as 0.00. Exits non-zero on any failure.
  CHOICES: Run through esbuild, which Vite already depends on, piped into node. Node
    22 on this machine is not compiled with TypeScript support so
    `--experimental-strip-types` fails, and adding a runtime like tsx for one script is
    not worth a dependency.
  ⚠ JUDGEMENT CALL: This checks contents, not appearance. Layout, colour and the
    visual demotion of a consequential row are not covered and cannot be by this
    method; a screenshot is the only check for those. The script says so at the top
    rather than implying the dashboard is fully verified.

### The verification, in one paragraph

`make web-verify` renders the strip and all six rows and passes all three checks.
The strip reads 8 assets, 6 open advisories of which 1 is consequential, worst health
0 on chiller-1, $314,852 of cost of inaction over 90 days against $38,193 to act, 2
unpriced, and 4 equipment / 2 sensor. The queue leads with condenser fouling on
chiller-1 at priority 18.89 — health 84, fails in 260 d with a 127–569 d band, $30,419
of inaction against $1,610 to act — then compressor efficiency loss at 16.21 showing
"now" and "threshold already reached" rather than "0 to 0 days", then the fan bearing
at health 63 with an em dash and its withheld-prediction reason, then the second
chiller. The labelled separator follows, then the two unpriced air-side rule firings,
the last of which is the demoted consequential row marked "↳ DEMOTED, still in the
queue — caused by chiller-1 / chiller-condenser-fouling". `npm run build` typechecks
under `strict` with `noUnusedLocals`, `noUncheckedIndexedAccess` and
`verbatimModuleSyntax`, and produces a 153 kB bundle. The dev server serves the shell,
compiles all five modules and the CSS module, and proxies `/api/advisories/summary`
through to the API.

START HERE: `web/src/lib/format.ts` — every string the operator reads is produced
there, which is also what makes the dashboard checkable without a browser.


## Checkpoint 6.5 — Advisory detail and the RUL fan chart

### WHAT WE DID

Clicking a row in the queue now opens the whole argument for doing that piece of work.
The centrepiece is a chart in two stacked panels sharing one calendar axis. The upper
panel shows the degradation number climbing toward the value at which the equipment
counts as failed, with the predicted failure window shaded across the dates it could
happen on. The lower panel shows something more unusual and more important: how the
prediction itself changed every time it was recomputed. Early on, with two weeks of
evidence, the system said the coil valve would fail somewhere in the next 3,479 days —
which is a useless answer, and it says so by being visibly enormous. Eight weeks later,
with fifty-two days of evidence, it said 11 to 34 days. Watching that interval close by
97 percent as the evidence accumulates is the single clearest demonstration that this is
prediction rather than pattern-matching. Around the chart sits the rest of the case: the
measurements with their actual values and how far each moved, the health trend, the
upstream machines that could have caused it and the downstream zones and people who
suffer if it is left, the arithmetic behind every dollar, and the specific job to raise
with its hours, trades, parts and cost. Where the system refused to predict, the chart
draws no band at all and prints the refusal in its place.

### HOW IT WORKS

`scripts/run_advisories.py :: EXTRA`
  WHY IT EXISTS: The flagship visual had to be reachable by clicking a row, not only
    from a verification script.
  WHAT IT DOES: Adds the 2036 coil-valve-leak advisory to the queue, on its own
    observation window and its own season-matched reference, classified over that
    window rather than over the 2038 one.
  CHOICES: The coil leak carries the most informative remaining-life history in the
    project — 84 published estimates whose interval closes from 3,479 days to 23 as the
    post-onset sample count goes 14 to 53. Adding it means the queue holds advisories
    from two different runs, which is honest for a database of eight independent
    simulations in separate calendar eras: there is no single "now" here, every advisory
    carries the window it was computed over, and the dashboard states that above the
    queue. `classify_assets` gained an optional per-call window override so the air
    handler can be classified over its 2038 run for the cross-asset situation and its
    2036 run for the coil leak.

`web/src/lib/chart.ts :: LOOKBACK_DAYS` and `chartWindow`
  WHY IT EXISTS: Deciding the calendar span both panels and the health request cover.
  WHAT IT DOES: One function returning the from/to used by the indicator line, the
    prediction band and the health query alike.
  ⚠ JUDGEMENT CALL: The first version clipped the band to the advisory's own window and
    that was wrong in a way that hid the best part of the chart. An advisory's window is
    the span the fault CLASSIFICATION was computed over — a month or two, chosen so the
    isolation sweep has a stable operating point. The degradation story is longer and
    starts earlier: the coil leak's onset is confirmed on 19 March and its first
    prediction published on 1 April, both before the classification window opens on 27
    May. Clipping threw away 56 of the 84 estimates, and with them the fall from 3,479
    days to 138 — the interval appeared to close by 57 percent instead of 97. Reaching
    back 120 days, the length of a synthesised run, recovers the whole history and no
    more; reaching further would pull the same mode's estimates in from a different run
    and draw two unrelated histories as one line with a two-year gap in it.

`web/src/lib/chart.ts :: indicatorSeries`, `fanBand`, `crossingWindow`, `narrowing`
  WHY IT EXISTS: All four are pure, which is what lets the chart be checked without a
    browser. The components do no arithmetic.
  WHAT IT DOES: `indicatorSeries` keeps both the raw and the clamped indicator.
    `fanBand` produces one point per published estimate, restricted to the run.
    `crossingWindow` converts the interval — published in DAYS FROM the date it was made
    — into a region on a calendar axis, which is the form a planner can put in a diary:
    an 11-to-34-day interval made on 23 June becomes 4 July to 27 July. `narrowing`
    reports the widest and narrowest interval, the percentage closed, whether every step
    was monotone, and how many estimates left the upper end unbounded.
  CHOICES: `fanBand` returns an empty array when the advisory carries a refusal — not a
    wide band, not a dashed one. A refused prediction is not an uncertain prediction, and
    any band at all would contradict the sentence printed beside it. Points whose upper
    end is unbounded keep their P10 and P50 and carry a null P90, so the median line
    continues and the fill simply stops, which is the truthful rendering of "there may be
    no failure date at all" — an open top rather than a guessed one. `monotone` is
    reported separately from `percentClosed` because these intervals close dramatically
    over a run and still widen from one day to the next: each estimate is refitted from
    that day's evidence, and a day the indicator did not move genuinely is weaker
    evidence about a rate. Claiming monotone convergence would be overselling.

`web/src/components/RulFanChart.tsx`
  WHY IT EXISTS: The chart the checkpoint calls the most important visual in the
    project.
  WHAT IT DOES: Three states. With a bounded prediction it draws both panels: indicator
    and clamped indicator against the amber dashed threshold line, the crossing window
    as a red shaded region with the median marked and dated, then the interval band
    beneath with a readout of estimate count, widest, narrowest, percent closed, sample
    growth, monotonicity and how many estimates were open above. With a refusal it draws
    the indicator panel and replaces the band panel with the reason. With no failure mode
    at all — a rule firing — it draws nothing and explains that a rule reports a
    condition rather than a quantity accumulating toward a threshold.
  CHOICES: Two panels rather than one, because the checkpoint asks for two things that
    cannot share a pair of axes. The interval is measured in days and the indicator in
    kelvin or watts or kW/ton; putting the interval on the indicator's axis would mean
    drawing days against kelvin, and putting the indicator on the interval's axis would
    mean dropping the threshold, which is the only thing that makes "failure" mean
    anything. The band is drawn as two stacked areas because Recharts has no native
    range area — the lower one is transparent and only lifts the visible one off the
    axis.

`web/src/components/AdvisoryDetail.tsx`
  WHY IT EXISTS: The rest of the case, in the order the advisory layer assembles it.
  WHAT IT DOES: Fetches the advisory, then the remaining-life history and health
    concurrently, both with a catch that yields null — so a missing history degrades the
    page rather than breaking it. Renders the fan chart, the health trend with the
    per-mode line solid and the asset roll-up dashed, the evidence table with observed
    and reference values and the movement in each point's own spread, the cost breakdown
    with its basis lines, the severity terms with their weights, the graph trace both
    directions with the occupant count, the recommended intervention, any caveats, and
    the reason for the fault class.
  CHOICES: The evidence table states how many measurements were excluded and
    distinguishes the two reasons — source data known defective versus readings the
    quality layer condemned — because those call for different responses. When an
    intervention was matched on the fault class the page says so, since that is where
    the sensor-versus-equipment discrimination turns into a different van being sent.
  ⚠ JUDGEMENT CALL: Which advisory is open is held in React state rather than in the
    URL. A router for one nested view is a dependency and a build step for a screen with
    two states. The cost is real and worth naming: the detail view is not linkable, so an
    operator cannot paste a colleague an advisory. That is the first thing a router would
    buy and the reason to add one later.

`web/scripts/verify-detail.ts`
  WHY IT EXISTS: How the claim "the fan chart narrows" is made checkable by somebody who
    did not look at my screen.
  WHAT IT DOES: Walks every advisory, prepares its chart through the same `chart.ts` the
    component uses, prints the interval per date as a bar, and reports per series how far
    it closed.
  ⚠ JUDGEMENT CALL: It separates two kinds of finding, and the split is the honest part.
    A band drawn for a refused prediction, or a closing percentage computed from fewer
    than two bounded intervals, is the CHART misrepresenting its data — that fails the
    run. A series whose interval does not close is a property of the remaining-life model
    from checkpoint 5.2, which already recorded it as an honest partial failure; scoring
    this checkpoint on that would be scoring it on another checkpoint's work, and hiding
    it would be worse. So it is reported loudly, separately, with the number. The run
    fails if no series demonstrates closing at all, because then the visual's central
    claim is unevidenced whatever the code does.

### The verification, in one paragraph

`make web-verify-detail` walks all seven advisories and exits 0. Two intervals close:
the coil valve leak by 97 percent, from 3,479 days to 59, over 84 estimates as the
sample count goes 14 to 53 — the flagship, and now the top row of the queue at priority
24.69 — and compressor efficiency loss by 100 percent, from 480 days to 0, over 78
estimates as it reaches its threshold. One does not: condenser fouling widens 12 percent,
393 days to 442, which is checkpoint 5.2's known limitation now visible on screen rather
than only in a report. One has nothing to compare, chiller-2, where 83 of 84 estimates
leave the upper end unbounded because a barely-degrading chiller may genuinely never
reach its threshold and the model says so rather than inventing a date. Three advisories
carry a refusal and in all three the band is correctly absent: the fan bearing, whose
prediction the advisory layer withheld for contradicting its own health score, and the
two rule firings, which have no indicator to chart at all. The frontend typechecks under
strict and builds.

START HERE: `web/src/lib/chart.ts` — every number the fan chart draws is computed there,
which is also what makes the narrowing claim verifiable outside a browser.


## Checkpoint 6.6 — Plant schematic

### WHAT WE DID

The dashboard now draws the plant. Cooling towers feed a condenser water loop, which
feeds three chillers, which feed the chilled water loop, which feeds the air handler's
cooling coil, which feeds the supply fan, which feeds the five occupied zones. Each
machine is a box coloured by its current health — green above 70, amber between 40 and
69, red below, grey for the equipment this dataset never scores — with a count of its
open advisories pinned to the corner and a coloured dot for each kind of fault open on
it. When cross-asset reasoning has blamed a chiller for something happening at the air
handler, the pipe between those two lights up red and dashed and the picture says which
machine is being held responsible. That is the thing a list cannot do: the queue can put
the chiller at position two and the air handler symptom at position seven, but only the
drawing shows that they are joined by a pipe and are one fault rather than two. Clicking
a machine opens its highest-priority advisory.

### HOW IT WORKS

`web/src/lib/schematic.ts :: buildSchematic(assets, advisories, zones)`
  WHY IT EXISTS: The whole picture as data — every coordinate, every colour, and whether
    the chilled water path is lit. The component draws shapes and does no arithmetic,
    which is what lets the schematic be rendered and checked without a browser.
  WHAT IT DOES: Places eleven boxes and sixteen connecting polylines, resolves each
    machine's colour from its health, collects the distinct fault classes open on it, and
    decides whether the chilled water path is carrying an explanation rather than just
    water.
  CHOICES: Positions are hand-placed rather than produced by a graph layout engine. This
    plant has a fixed topology that will not change, and a solver would arrange it
    differently on every load, which is the opposite of what a schematic is for — an
    operator learns where the chiller is on this picture. Zone boxes come from the
    downstream graph traversal rather than being written into the frontend, so a building
    with a sixth zone gets a sixth box with no code change. The two health thresholds are
    imported from `lib/format.ts` rather than restated, so the queue and the schematic
    cannot disagree about what amber means.
  ⚠ JUDGEMENT CALL: Colour lives in fill and stroke attributes computed from health, not
    in a CSS class. Partly because colour here IS data — it is the health score — and
    partly for a second reason that turned out to matter more: it makes the rendered SVG
    self-contained, so it can be written to a file and opened on its own. A
    class-styled SVG would have needed a stylesheet to mean anything and could not have
    been verified the way this one is.

`web/src/lib/schematic.ts` — which chiller lights up
  WHY IT EXISTS: The cross-asset highlight is the one piece of state on this drawing that
    is an inference rather than a measurement, so it needs care.
  WHAT IT DOES: Looks for a consequential advisory whose named cause is a chiller, and if
    it finds one, lights the pipe from THAT chiller to the loop and the loop to the coil.
  CHOICES: Only the chiller actually blamed is lit, not all three. Lighting the whole
    plant would say the plant is at fault when the diagnosis named one machine, and the
    diagnosis naming one machine is the entire value of checkpoint 6.1. The accompanying
    line above the drawing repeats that the demoted advisory is still in the queue, so
    the picture cannot be read as the system having decided the air handler is fine.

`web/src/components/PlantSchematic.tsx`
  WHY IT EXISTS: The drawing.
  WHAT IT DOES: Renders the plan as SVG — edges first so boxes sit on top of them, two
    arrowhead markers so an ordinary flow and a lit fault path are distinguishable at a
    glance, a health legend and a legend entry for the fault path. Machines are
    clickable; loops and zones are not, because there is nothing to open on them.
  CHOICES: Loops are drawn as dashed rounded bars rather than boxes, and zones smaller
    than machines, so three kinds of thing are three shapes. The advisory count is a
    filled red circle in the corner and the fault classes are small dots along the
    bottom edge in the same colours the queue's badges use, so the class survives a
    glance down the picture rather than needing a hover.

`web/scripts/run-ts.mjs`
  WHY IT EXISTS: Runs the three verification scripts, TypeScript and all, with no test
    runner and no new dependency.
  WHAT IT DOES: Bundles a script in memory with esbuild, which Vite already depends on,
    writes it to a temp file and imports it.
  CHOICES: Three things in here are each a fix for a real failure rather than
    boilerplate. A plugin stubs `*.module.css`, because esbuild treats those as CSS
    modules and refuses to bundle one without an output path — and `--loader` does not
    override that; the stub returns each key as its own class name, which is what a CSS
    module does anyway. A `createRequire` banner is injected, because `react-dom/server`
    is CommonJS and calls `require("stream")`, which does not exist in an ESM bundle. And
    the bundle goes to a temp file rather than a `data:` URL, because any error inside a
    data URL reports the entire base64 bundle as the specifier and buries the stack trace
    under seven megabytes of noise.

`web/scripts/verify-schematic.ts`
  WHY IT EXISTS: This is the one visual in the project that can be verified properly
    rather than described, because an SVG is text.
  WHAT IT DOES: Fetches live assets, advisories and the downstream traversal, prints the
    component table with each box's state and pinned faults, renders the real React
    component to static markup with `renderToStaticMarkup`, asserts eleven properties,
    and writes the result to `docs/plots/plant_schematic.svg`.
  CHOICES: Eight of the eleven checks are about data — every asset has a box, boxes are
    coloured from live health, faults are pinned to the component they belong to, supply
    air reaches every zone, the path highlights on a cross-asset fault, and only the
    blamed chiller is lit. The last three are about GEOMETRY, and they exist because they
    are the only checks on the drawing itself available without eyes: no two components
    overlap, every component is inside the canvas, and every pipe's endpoints land on a
    component rather than in mid-air. Those three catch exactly what a glance would catch.
  ⚠ JUDGEMENT CALL: The output path resolves against the working directory, not against
    the script's own location. The runner bundles the script into a temp directory before
    executing it, so `import.meta.dirname` points at `/tmp` — the first version tried to
    write to the filesystem root and got EACCES. npm scripts always run in the package
    directory, which makes the working directory the stable anchor.

### The verification, in one paragraph

`make web-verify-schematic` passes all eleven checks and writes a 10,688-byte SVG. The
component table shows chiller-1 critical at health 0 with two equipment advisories,
chiller-2 healthy at 79 with one, the air handler degrading at 63 with four advisories
across two fault classes, and the three cooling towers and third chiller grey because
this dataset never scores them — which is honest rather than a gap, since the LBNL
chiller file carries no readings for them. Sixteen pipes are drawn and exactly two are
lit: `chiller-1-chw` and `chw-coil`, with the chilled water path reported ACTIVE and
chiller-1 named as responsible for `ahu-1 / apar-20`. Supply air reaches five zones and
200 occupants. Geometry is clean: no overlaps, nothing outside the 780×588 canvas, and
all 32 polyline endpoints land on a component.

START HERE: `docs/plots/plant_schematic.svg` — open it. It is the rendered output of
`web/src/components/PlantSchematic.tsx` against live data, written by the verification.


## Checkpoint 6.7 — Decision log for cross-asset diagnosis

### WHAT WE DID

The decision log now covers all nine choices that shaped this build, and the two
entries written at the end of the previous session have been brought up to date with
what building the interface revealed about them. Nothing in this checkpoint changes how
the system behaves; it changes what a reader can reconstruct about why it behaves that
way. That matters here more than usual, because two of the three entries touched record
the same pattern: the argument for a decision changed after the decision was made, and
in both cases it changed because something was put on a screen next to something else
and the two disagreed.

### HOW IT WORKS

`AI_LOG.md :: D-09 — Cross-asset consequential faults are demoted, never hidden`
  WHY IT EXISTS: The one policy in this project that removes information from an
    operator's view, or rather deliberately declines to. Once a symptom can be traced
    upstream, the platform has to decide whether it may delete a measured finding on
    the strength of an inference, and that is a decision about trust rather than about
    code.
  WHAT IT DOES: Records four options — suppress, demote and link, flag without
    reranking, or merge the pair into one advisory — and why the second was taken. The
    core of it is an asymmetry: demoting wrongly produces a badly ordered queue, which
    an operator notices and works around; suppressing wrongly makes a genuine fault
    absent, and the operator learns this by the equipment failing. After that they read
    the raw alarm list and every layer in this project is worth nothing, because nobody
    is reading its output. The upside of suppression over demotion is one dimmed row of
    screen space.
  CHOICES: The entry is explicit that the POLICY was specified in the prompt and not
    chosen by me, and equally explicit about what was mine: the demotion arithmetic, the
    clamp that guarantees the ordering a multiplier alone cannot, the chain recursion,
    the two-tier queue that keeps demoted unpriced advisories ranked on severity rather
    than dropping them to zero, the admission rule on the plausibility map that stops
    demotion happening promiscuously, and the decision to light only the blamed chiller
    on the schematic. Also mine is the verification design: the negative case was built
    first, because a demotion feature that never declines to demote is
    indistinguishable from one that demotes everything.
  ⚠ JUDGEMENT CALL: The Outcome records that the inference is WRONG on this dataset and
    treats that as the most useful result in Task 6 rather than a failure to be
    explained away. The traversal, the mechanism and the timing all worked; checkpoint
    5.4 independently says the air handler fault is a drifting thermometer and the
    chiller has nothing to do with it. Two faults on connected machines in the same
    weeks were a coincidence, which is what they usually are. Because the advisory is
    demoted rather than suppressed it is still on screen, still carrying the SENSOR
    badge and the 94-percent single-sensor reconciliation that contradicts the
    attribution, and an operator can overrule it in one glance. I arrived at the
    argument for this decision from the wrong side — not by reasoning about trust in the
    abstract, but by watching the feature be wrong on the first real case it was given.
  CHANGED FROM BEFORE: One numeric claim was corrected during the write-up. The first
    draft said the advisory was "demoted from priority 1.000 to position six of seven",
    which silently mixed two different rankings — checkpoint 6.1 demotes on severity
    because the cost of inaction did not exist yet, and the finished dashboard demotes
    on economic priority. On the dashboard `apar-20` is unpriced, because a saturated
    valve wastes no measurable energy and has no threshold to cross, so it is ranked
    among the unpriced rows on severity and lands seventh of seven. The entry now states
    both rankings and says which is which: two demotions by two different mechanisms,
    both landing it under the chiller, neither removing it.

`AI_LOG.md :: D-07 Outcome — updated after Task 6`
  WHY IT EXISTS: D-07 declined a deep sequence model in favour of a Wiener process with
    a closed-form first-passage law. Task 5's outcome already recorded that the argument
    had shifted: the value of an interpretable model turned out to be that its drift is
    a quantity you can test against zero, which is what the refusal layer needs.
  WHAT IT DOES: Adds the two things building the interface revealed. The payoff is that
    a parametric model has something you can DRAW — the fan chart plots the interval
    against the date each prediction was made, and on the coil valve leak it closes from
    3,479 days to 59 across 84 successive estimates as the sample count goes 14 to 53.
    A deep model can emit a date and a spread but cannot show a belief tightening,
    because there is no belief in it, only an output.
  ⚠ JUDGEMENT CALL: The entry also records a cost I did not anticipate, and it is a cost
    OF the decision rather than a limitation elsewhere. Interpretability means the
    platform publishes two numbers derived from the same daily indicator through
    different smoothing — a health score from an isotonic clamp and an interval from a
    running maximum — and on the fan indicator they contradicted each other flatly:
    health 63 of 100 beside a median time to failure of zero days. That was worth 68,400
    USD of expected replacement cost and put the least degraded mode in the building at
    the top of the queue. So choosing a model with parameters bought a quantity to refuse
    on, and then made a second refusal necessary by having two published quantities at
    all. A model with no interpretable state would have had neither problem and neither
    defence — it would simply have been believed.

`AI_LOG.md :: D-08 Outcome — updated after Task 6`
  WHY IT EXISTS: D-08 chose constraint isolation over a learned classifier for telling a
    lying sensor from a worn machine.
  WHAT IT DOES: Records what the discrimination is worth in dispatch terms and a scope
    error it exposed. The worth: the intervention library is keyed on the fault AND the
    fault class, so `apar-20` resolves to a 1.5-hour calibration at 262.50 USD or a
    6-hour coil survey at 830.00 USD — same rule id, same evidence, 3.2 times the cost
    and a different trade dispatched. That is a table row rather than a branch in code,
    so a site with different labour rates changes the number without touching the
    discrimination.
  ⚠ JUDGEMENT CALL: The scope error is the more instructive half and it was mine. The
    isolation sweep answers per ASSET per window; I handed that verdict to every advisory
    on the asset, which labelled the supply fan's bearing wear a SENSOR fault because the
    thermometer on the same machine is drifting. The corrected reading is now recorded as
    part of the decision rather than as a bug fix elsewhere: a rule firing takes the
    asset's class, a failure mode is equipment by construction, unless the mode's own
    indicator is computed from the very measurement the sweep accuses — which is not
    hypothetical, because the coil leak-by indicator IS the supply air temperature
    residual. Stated plainly: the verdict is about the asset's violated relations, not
    about every fault open on the asset, and I had been over-reading it.

### The verification, in one paragraph

Nine entries, every one carrying all six required subsections — Forcing question,
Options, Rationale, Mine vs delegated, Confidence, Outcome — and two carrying an
Overrode section. No Outcome is blank or a stub: they run from 2,402 to 5,441
characters, with D-07 at 5,441 and D-08 at 4,806 after this session's extensions and
D-09 at 3,145. D-09 lists four named options. Every figure in the three sections written
here traces to measured output: the 3,479-to-59-day close over 84 estimates, the 14-to-53
sample growth, the 262.50 against 830.00 USD dispatch costs, the 5.8-day evidence age,
the 94-percent single-sensor reconciliation, the four-day gap between the last chiller
reading and the first sustained saturated valve, and one of three chiller pipes lit.

START HERE: `AI_LOG.md` — the Outcome of D-09. It is the only place in the log that
records a feature being WRONG on the first real case it was given, and the decision
being vindicated by that rather than despite it.


## Checkpoint 7.1 — Validation harness core

### What we did

The system can now measure its own accuracy against labels it was never allowed to see,
and write the answer down in a document that is regenerated from scratch every time it
runs. Before this the project could show what it detected and predicted, but every claim
about how WELL it did so lived in the terminal output of a verification script that
nobody would run again. There is now one command that replays every simulation run
through the whole detection path, compares what fired against the injected faults, and
produces `VALIDATION.md` with three numbers in it: how often the platform interrupts an
operator about equipment that was working, how reliably it catches a fault while that
fault is still at the mildest severity anyone measured, and how many days of warning it
gives before the equipment reaches the end.

That last question is the one the whole project exists to answer, so it needs an answer
that is not self-reported. The measurement matters because a predictive-maintenance
platform is a claim about the future, and the only way to check a claim about the future
is to make it against data where somebody already knows what happened. It also found
things: the platform's single worst behaviour — one degradation channel that confirms a
fault on a chiller that was working perfectly, and then holds that finding for two
months — is visible in the output for the first time, and so is the fact that the fault
this project deliberately held out was not caught by anything.

### How it works

`validation/groundtruth.py` :: `admin_dsn` and `load_answer_key`
  WHY IT EXISTS: The answer key lives in a database schema that the detection path is
    physically denied access to. Something has to open it, and confining that to one
    function in one module is what makes "no detector could have seen its own label" a
    checkable statement rather than an intention.
  WHAT IT DOES: Reads the environment for the admin credential, connects, and pulls two
    tables into frozen dataclasses: one row per simulation run saying whether a fault
    was injected into it, and one row per injected fault saying which machine, which
    fault, when it started, when it reached its terminal severity, and the list of
    measured severity rungs the trajectory was built from. It returns values, not a
    connection, so nothing downstream can reach back through it.
  CHOICES: The severity rung labels are lifted out of the JSON parameter blob rather
    than re-read from the scenario files, so the labels shown in the report are the ones
    recorded at the moment the data was generated.

`validation/groundtruth.py` :: `severity_one_windows`
  WHY IT EXISTS: The checkpoint requires accuracy at severity level 1 specifically, and
    nothing in the database records when a run passed each severity. The answer key says
    where each trajectory ENDED, not when it crossed each rung. Without this function
    there is no way to restrict the figures to the hard case, and the accuracy numbers
    would be dominated by the severe end of every trajectory, which any system catches.
  WHAT IT DOES: For each run it rebuilds the timestamp grid the simulator evaluated its
    degradation curve on, replays that curve from the run's own integer seed, and maps
    it onto the severity ladder the same way the simulator did — degradation progress of
    zero sits on the fault-free source file, progress of one sits on the worst measured
    file, so multiplying by the number of rungs gives the position on the ladder at every
    instant. The severity-1 window closes at the first instant that position reaches one,
    which is the moment the run arrives at the second measured severity. It converts that
    instant out of the source files' local time into UTC and returns it with a sentence
    saying how the boundary was chosen.
  CHOICES: Two awkward cases fall out of the same search rather than being special-cased.
    A fault with only one measured severity in the source data never leaves level 1, so
    its window runs all the way to failure — the search finds the failure date because
    the curve is pinned to one there. A fault that steps rather than progresses arrives at
    the top rung at the moment of injection, so the search returns the injection instant
    itself, the window has zero length, and the run is marked unscored with that stated as
    the reason. The outdoor air damper run is the second case and is excluded from every
    accuracy figure because of it.
  ⚠ JUDGEMENT CALL: The timestamp grid is rebuilt from the run's start date, span and
    resample interval rather than re-read from the source CSVs. Re-reading would be the
    unarguable choice, but it means parsing 21 large files to recover a set of timestamps
    that three integers already determine, and it would make regenerating the document
    depend on the raw dataset being present. Instead the rebuilt length is checked against
    the number of readings in the database and the comparison is printed in the report —
    it comes out at 34,560 against 34,560 on all eight runs. The first version of that
    check reported a mismatch of exactly 72 samples on every run, which turned out to be
    the six-hour offset between the window the run list declares and the timestamps the
    data actually carries, not an error in the reconstruction.

`validation/detect.py` :: `windows`
  WHY IT EXISTS: Defines what "every scenario" means. Eight synthesised runs plus the
    LBNL fault-free reference year, in calendar order.
  WHAT IT DOES: Builds the evaluation window list from the run list the baseline layer
    already uses, and prepends the 2018 reference year.
  CHOICES: The 2018 year is included because it is the most valuable false-alarm evidence
    in the project and the least like the rest of it — 365 days of real measured output
    from a building that was working, with nothing synthesised into it. It also carries an
    asymmetry that is stated wherever its numbers appear: the health layer has only ever
    been run over the eight scenario windows, so the reference year contributes rule
    firings only and no confirmed-degradation detections.

`validation/detect.py` :: `ahu_rule_findings` and `chiller_rule_findings`
  WHY IT EXISTS: Nothing in this project stores rule firings, so any measurement of them
    has to recompute them. These two run the six air-side rules and the three chiller
    performance rules over a window and collapse what fired into findings.
  WHAT IT DOES: Loads the window's readings, classifies the air handler's operating mode
    or derives the chiller's running state, runs every rule the machine's semantic class
    registers, keeps only firings that held for the full sustain delay, groups those into
    continuous episodes, and then collapses all episodes of one rule on one machine into a
    single finding carrying the first instant it was raised and the set of calendar days it
    covered. Each also returns the set of days on which the suppression mask left at least
    one instant the rules were willing to judge.
  CHOICES: Nine separate afternoons of the same saturated valve is one finding, not nine.
    That is the unit an operator disposes of, and counting it the other way would make the
    false-alarm rate a function of how choppy the weather was.
  ⚠ JUDGEMENT CALL: The chiller running-state derivation and the plant-setpoint join are
    imported from `scripts/run_chiller_rules.py` rather than reimplemented. Importing from
    a scripts directory into a package is ugly, and the alternative was to copy fifteen
    lines. Copying would create a second definition of "this machine is running" free to
    drift from the one the chiller rules were actually verified against, and the harness
    would then be scoring something subtly different from what the project ships. The
    genuinely right fix is to move that function into `analytics/rules/chiller.py`, which
    is a refactor outside this checkpoint.

`validation/detect.py` :: `degradation_findings`
  WHY IT EXISTS: The second of the two detectors that reach an operator. A failure mode
    whose degradation the changepoint detector has confirmed is a finding in exactly the
    same sense a rule firing is, and the lead-time metric depends on knowing WHEN it was
    confirmed.
  WHAT IT DOES: Rebuilds each mode's daily health trajectory from the measurements exactly
    as the health layer does — daily median of the indicator, changepoint detection on the
    raw series, centring on the commissioning mean, then the one-directional clamp — and
    keeps the modes where the cumulative-sum statistic crossed its decision interval. The
    finding begins at that crossing and covers every subsequent day the mode's health sits
    below full.
  ⚠ JUDGEMENT CALL: This recomputes rather than reading `app.health_state`, and the reason
    is the difference between two dates that table conflates. The changepoint detector
    looks back and estimates that the change began on, say, the 3rd; the persisted column
    stores that estimate, and it is what the health page shows. But nobody learned anything
    on the 3rd. They learned when the statistic crossed its threshold, which is days later
    and is written down nowhere. Scoring lead time against the stored estimate would credit
    this system with warning it never gave — on the air handler's coil leak the gap is
    ten days of unearned credit. The cost of recomputing is that the harness takes minutes
    rather than seconds; the alternative was to add a column, which changes what the health
    layer writes in order to measure it.

`validation/detect.py` :: `_evaluable_days` and `observed_days`
  WHY IT EXISTS: These decide the denominator of every per-asset-day figure in the report,
    and getting it wrong is the easiest way to make a false-alarm rate look good.
  WHAT IT DOES: `_evaluable_days` returns the days on which the suppression mask left at
    least one instant a rule was willing to judge. `observed_days` separately returns the
    days that merely hold readings, read from the hourly rollup rather than the raw
    hypertable. Both are reported, and the gap between them is stated in the document.
  CHOICES: The scored denominator is evaluable days, not days with data. A chiller that
    never started is not a chiller that was correctly found healthy — the rules skipped
    every instant of it, so there was no opportunity to raise a false alarm, and counting
    the day as a correct silence is padding. One of the three chillers in this plant runs
    about one percent of the year. The first version of the harness used days-with-readings
    and reported 2,028 healthy asset-days; the corrected denominator is 1,208, and the
    false-alarm rate went from 0.0010 to 0.0017 per asset-day. The correction made the
    headline number worse, which is how it was identified as the right one.
  CHANGED FROM BEFORE: `observed_days` was originally the denominator. It is now reported
    beside the denominator instead.

`validation/detect.py` :: `sweep`
  WHY IT EXISTS: One pass over every window, so the whole detection side of the harness is
    a single call and the ordering guarantee — detect first, read labels afterwards — can
    be seen in one place.
  WHAT IT DOES: For each window it collects the days with readings, counts one point's
    readings for the grid cross-check, runs all three detectors, unions their evaluable-day
    sets, and unions in the days any finding was active. It logs each finding as it goes.
  CHOICES: Days a finding was active are forced into the denominator whatever the
    suppression masks say. Without that, a false positive could be raised on a day the
    matrix does not count, and it would vanish from precision — a bug that would flatter
    the system and be almost impossible to notice.

`validation/metrics.py` :: `INJECTED_INTO_ASSET` and `EXCLUDED_SCENARIOS`
  WHY IT EXISTS: Two places where the answer key does not line up with the machines the
    platform monitors, recorded as declarative tables with the reason beside each row
    rather than resolved silently in code.
  WHAT IT DOES: The first maps a fault injected into a piece of plant with no
    instrumentation of its own onto the machine it is actually visible through — the bypass
    valve belongs to the chilled water plant and shows up on the chiller working against a
    warmer return; the tower fouling reaches the chiller as warmer condenser water. The
    second lists runs excluded from the accuracy figures, currently just the held-out
    cooling tower.
  CHOICES: The exclusion carries its full justification as data, and the report prints it
    verbatim. An exclusion that is not visible in the output is indistinguishable from a
    result that was inconvenient.

`validation/metrics.py` :: `asset_days` and `_label`
  WHY IT EXISTS: Turns findings and labels into one row per machine per day carrying what
    was true, what the platform said, and whether the day counts. Everything else in the
    metrics module is an aggregation of this list.
  WHAT IT DOES: Walks every scored machine-day and assigns one of four outcomes. A day
    inside a severity-1 window on a faulted machine is a positive. A day on a fault-free
    run, or a day before injection on a faulted run, is a negative. A day after the
    trajectory passed level 1 is excluded — the fault is present, so it is not a negative,
    but detecting it there is the easy case this document declines to take credit for. A
    day on a machine sharing a simulated plant with a faulted machine is also excluded.
  CHOICES: Pre-injection days are ordinary negatives, including the three weeks the
    baselines are fitted on. A finding raised while the equipment was still healthy is a
    false alarm whatever else was happening that week.
  ⚠ JUDGEMENT CALL: The other two chillers during a chiller run are excluded rather than
    counted as healthy. The source data is a whole-plant simulation, so when one chiller is
    fouled the other two see a different loop around them; they are neither faulted nor
    assertably healthy. Counting them as negatives would have added roughly 250 asset-days
    of free true negatives and a handful of false positives, and I could not defend either
    reading. The alternative — treating them as faulted — is worse, because nothing was
    injected into them.
  CHANGED FROM BEFORE: The first version consulted the severity window before checking
    whether the day preceded injection, which threw away the entire pre-injection stretch
    of the step-fault run — three weeks of healthy air handler the false-alarm rate was
    entitled to. The order is now: injection first, severity window second.

`validation/metrics.py` :: `false_alarms`
  WHY IT EXISTS: The number the checkpoint asks to lead with, and the number that decides
    whether anybody keeps using a fault detection system.
  WHAT IT DOES: Counts, over the machine-days labelled healthy in each run, three things:
    how many distinct findings stood on any of them, how many of those days carried at
    least one standing finding, and the raw episode count.
  CHOICES: Three counts because they answer three different questions. Findings per
    asset-day is the headline — how many separate things an operator is asked to dispose
    of. Alarm-days is deliberately identical to the false-positive cell of the confusion
    matrix, so the two sections of the document cannot quietly disagree. Episodes exists
    only so these figures can be lined up against the per-rule tables from checkpoints 3.3
    and 3.4, which counted that way.

`validation/metrics.py` :: `confusion`
  WHY IT EXISTS: Precision, recall and F1 at severity level 1, as required.
  WHAT IT DOES: Tallies the four cells over labelled machine-days and exposes the three
    ratios as properties that return nothing rather than zero when a denominator is empty.
  CHOICES: The unit is the machine-day, not the injected fault. With five scorable faults
    a per-fault confusion matrix would rest on five numbers; the machine-day denominator
    runs to thousands. It also makes precision and the false-alarm rate two views of the
    same count rather than two unrelated figures.
  ⚠ JUDGEMENT CALL: Detection is scored at machine level, so a run is credited when ANY
    channel fires on the faulted machine and not only when the correct fault is named. That
    is generous and the report says so in those words. On the condenser fouling run the
    efficiency channel firing is the same fault seen from another angle and crediting it is
    fair; on the sensor-drift run the fan-bearing channel firing is credited and it is much
    less clear that it should be. The alternative was to require the named fault to match a
    mapping from injected fault to platform channel, which turns a detection metric into an
    attribution metric — a different question with a different answer, and one the
    following checkpoint is for.

`validation/metrics.py` :: `false_positive_sources`
  WHY IT EXISTS: A precision figure with nothing behind it is barely honest. Forty-three
    percent could mean every detector is noisy or it could mean one channel is broken and
    the rest are silent, and those call for opposite responses.
  WHAT IT DOES: Attributes every false-positive machine-day to the channel that produced
    it, with the size of the finding and its share of the total. For each one it also looks
    for the same channel raising the same finding on the same machine on the same day of
    the YEAR in other runs.
  CHOICES: The calendar comparison works because every synthesised run reads the same 2018
    source window shifted forward by a whole number of years. A detection driven by weather
    or load lands on the same day of the year in every run; one driven by the injected fault
    does not. Both false positives in this project have such twins on faulted and fault-free
    runs alike.

`validation/metrics.py` :: `lead_times`, `percentile` and `lead_summaries`
  WHY IT EXISTS: The assignment's headline requirement. The gap between the first warning
    and the end is what the system is for.
  WHAT IT DOES: For each injected fault, and each channel that raised a finding on the
    affected machine before the fault reached terminal severity, records the number of days
    between the two. Then per fault it reports the count, the median, the tenth percentile
    and the extremes, and repeats the calculation pooled across all faults.
  CHOICES: The population is one row per fault per channel, not one row per fault. That is
    what makes a distribution out of five events — condenser fouling is caught by two rules
    and two degradation channels and those four warnings arrive on four different days.
    Reporting only the earliest would describe a system that always warns as early as its
    luckiest detector. The percentile is written out by hand rather than taken from numpy,
    because with four samples the choice of interpolation convention moves the tenth
    percentile by days and a reader comparing against their own tooling needs to know which
    definition produced the number.
  CHOICES: Findings first raised AFTER the fault reached terminal severity are dropped from
    the distribution rather than entered as negative leads, and counted separately in their
    own table. There are two of them.

`validation/metrics.py` :: `held_out`
  WHY IT EXISTS: The cooling tower fault is held out to test whether anything catches a
    fault the rule library does not cover. Something did fire on that run, and the obvious
    reading — that the trending caught what the rules could not — is wrong. This function
    is what shows it is wrong.
  WHAT IT DOES: For each finding on the held-out run, looks for the same channel on the
    same machine firing on the same day of the year on a run with no fault injected at all.
    A match means the finding tracks the season and not the tower.
  CHOICES: Both findings on that run have fault-free twins, one day for one day, on both
    chillers. So the verdict the harness prints is that the held-out fault was NOT detected,
    and the two findings present on it are the same artefact that fires on a clean run.
    Without this check the report would have claimed a detection it did not make.

`validation/report.py` :: `render` and its section functions
  WHY IT EXISTS: The checkpoint requires the document to be regenerated on every run and
    never hand-written. A validation document with hand-typed numbers decays silently, and
    the moment one figure in it is stale the whole document is worthless because a reader
    cannot tell which one.
  WHAT IT DOES: Takes every computed value as an argument and emits the whole markdown
    document — header, the false-alarm section, the severity-1 detection section with its
    confusion matrix and per-fault table, the lead-time section, the held-out fault section
    and a method appendix. The prose is fixed and every number is interpolated, so a
    regression shows up as a changed number under unchanged prose.
  CHOICES: No literal number appears anywhere in the file. Even the sentence describing how
    large the worst false positive is pulls the health-point figure out of the finding.

`validation/harness.py` :: `main`
  WHY IT EXISTS: The entry point, and the place the credential ordering is enforced.
  WHAT IT DOES: Loads the semantic model, opens the restricted connection and runs the
    whole detection sweep, closes it, and only then calls into the module that opens the
    admin credential. Scores, renders, writes the file, and prints the same figures to the
    terminal.
  CHOICES: The exit status is non-zero only if the document could not be built, never for a
    bad accuracy figure. This is a measuring instrument, and an instrument that fails when
    the reading is unwelcome invites the reading to be adjusted.

`Makefile` :: `validate`
  WHAT IT DOES: `make validate` regenerates the document. Documented as the second target
    in the project needing the admin credential, and noted as opening it only after every
    finding has been produced.

### What the numbers came out at, and the one defect they expose

Everything below is in the generated document; this is the summary.

The false-alarm rate is **0.0017 findings per healthy asset-day** — two findings across
1,208 asset-days of equipment that was working, one every 604 asset-days. The LBNL
fault-free reference year produced zero findings across 778 evaluable asset-days.

Detection at severity level 1: precision **43.7%**, recall **76.1%**, F1 **0.555** over
1,350 labelled machine-days. All four scorable faults were caught while still at level 1,
at 1.8, 2.8, 9.8 and 18.8 days after injection.

Lead time to terminal severity, pooled across thirteen warnings on four faults: median
**26.6 days**, tenth percentile **12.2 days**, range 3.4 to 87.2.

The precision figure is the interesting one and it is honest. Every false positive in the
project comes from ONE channel — the chiller efficiency indicator — on the fault-free
chiller run, on two machines. Two findings, and between them they stand for 139 healthy
asset-days, which is 65% of that run's evaluable days. Counted as findings, 2 of the 24
findings raised anywhere in the project were on a machine with nothing wrong with it; counted
as asset-days, precision is 43.7%. Both framings are in the document because they are the
same result and they mean different things: the platform put two wrong items in front of an
operator, and each then sat on the screen for two months.

The finding itself is small — a confirmed change costing one health point out of a hundred
on one machine and three on the other — so it would arrive at the bottom of the advisory
queue rather than as an alarm. Ranking it low is not the same as being right about it. It
is the clearest defect these measurements expose and it belongs to the efficiency
indicator, not to the harness.

The held-out fault was not detected. No rule fired on it, which is what the held-out design
intends. Two degradation findings did appear on that run, and both have fault-free twins on
the same machine on the same day of the year, so neither can be credited to the tower.

START HERE: `validation/detect.py` — everything the report says rests on what this module
decides counts as a detection and which machine-days count at all.


## Checkpoint 7.2 — Prognostic metrics, attribution and suppression correctness

### What we did

The harness now scores the four things that were still taking themselves on trust. It
checks whether the prediction interval means what it claims — a band that says "eighty
percent confident" should contain the truth four times in five, and nothing until now had
counted. It checks whether the predicted remaining life is within a fifth of the real
remaining life at each stage of a fault's life, which is the standard way this is reported
in the prognostics literature, and draws it. It checks whether the platform names the right
KIND of fault, sensor against equipment against control, which is the difference between
dispatching a calibration kit and dispatching a wrench. And it checks whether the one
advisory the cross-asset layer demoted was demoted for a true reason.

Three of those four came out badly, and the document now says so with the numbers. That is
the capability that was actually added: not four more figures, but the ability to be shown
wrong by the data. The interval coverage is nowhere near its nominal eighty percent, the
predicted remaining life is outside the twenty-percent band almost everywhere it can be
checked, and the cross-asset attribution is wrong on the only case this dataset can
produce. Each of those had been suspected in earlier checkpoints and none had been
measured. Two of them turn out to have the same underlying cause, which only became
visible because both were measured at once.

### How it works

`validation/prognostics.py` :: `MODE_FOR_FAULT`
  WHY IT EXISTS: Decides whether a remaining-life number is a prediction ABOUT the injected
    fault or merely a prediction made DURING it. Only the first kind can be calibrated, and
    without this distinction the coverage figure silently compares a fan-bearing forecast
    against the date a thermometer's bias reached its terminal value.
  WHAT IT DOES: Maps each injected fault to the configured degradation mode that names it,
    with a sentence of justification, and records `None` where nothing does.
  CHOICES: Only two of the six injected faults have a mode that names them. The other four
    absences are each listed with a reason rather than skipped: a leaking bypass valve
    produces no wear model, a drifting thermometer should not have one, a jammed damper
    reaches its terminal state instantly, and the cooling tower is held out. So the matched
    population is two series, and that is the headline limitation of the whole section.

`validation/prognostics.py` :: `load_estimates`
  WHY IT EXISTS: The 1,117 remaining-life estimates the platform has published, which are
    what gets calibrated.
  WHAT IT DOES: Reads every row of the stored estimate history.
  CHOICES: Read back rather than recomputed, which is the opposite of the decision made for
    onset detection in 7.1, and the difference is the point. The stored onset is a
    retrospective estimate and therefore the wrong quantity for measuring warning time.
    These rows are not like that — each is exactly what the system published on that date
    from data available on that date, which is the thing being calibrated.

`validation/prognostics.py` :: `crossing_dates` and `threshold_reach`
  WHY IT EXISTS: Between them they supply the single number that decides how to read every
    coverage figure in the section, and without it the results look like a broken model.
  WHAT IT DOES: `crossing_dates` finds when each mode's clamped indicator first reached its
    own failure threshold — the event the prediction is actually about, as distinct from the
    answer key's terminal-severity date. `threshold_reach` finds how far the indicator ever
    got, as a fraction of that threshold.
  CHOICES: The fraction is reported as a column beside every coverage row. On the two
    matched series it comes out at 57 percent and 16 percent, meaning the indicator never
    got close to failing during runs the answer key calls failures. A band putting the
    crossing two hundred days out is then correct about its own event and wrong about the
    answer key's, and most of the zero-percent coverage is those two events being weeks
    apart rather than the interval being miscalibrated.
  ⚠ JUDGEMENT CALL: Coverage is reported against BOTH definitions of failure rather than
    picking one. Reporting only the answer key's date would blame the model for a threshold
    placement decision; reporting only the indicator crossing would let it define its own
    exam. The alternative I rejected was moving the failure thresholds so the two events
    coincide, which is exactly the threshold tuning the working agreement forbids.

`validation/prognostics.py` :: `interval_calibration` and `_calibrate`
  WHY IT EXISTS: The checkpoint's headline requirement — what fraction of true failure times
    fell inside the P10-to-P90 band.
  WHAT IT DOES: For each series, converts each estimate's two quantiles into a calendar
    window by adding them to the date the estimate was made, and counts how often the target
    date falls inside it. Counts misses separately by direction: the whole band after the
    target, or the whole band before it.
  CHOICES: Only estimates made between injection and the target are counted. An estimate
    made after the equipment already reached the target is not a prediction of it — the band
    lies entirely in the future and the target is in the past, so it can only ever miss. 306
    of the published estimates fall after their own target because the replay continues to
    the end of every run, and including them would have reported a calibration failure that
    was really a scoping error.
  CHOICES: Direction of miss is counted because it turned out to be the most useful column
    in the section. On the matched series every miss is late, 41 of 41. Across all series
    against the answer key it is 42 late and 91 early, and the early ones all come from
    modes whose indicator had already crossed its own threshold, so the model says zero days
    left while the answer key still has days to run. Same cause, opposite sign.

`validation/prognostics.py` :: `uncalibratable`
  WHY IT EXISTS: A coverage figure whose denominator cannot be tied back to what the system
    published is not a measurement. This function accounts for every estimate.
  WHAT IT DOES: Puts each of the 1,117 estimates into exactly one bucket — scoreable, or one
    of six named reasons it is not — and returns the groups alongside the scoreable count.
    185 scoreable, 932 not, and the two add to the total.
  CHANGED FROM BEFORE: The first version tested only some of the exclusions, so its groups
    did not add up and the report quoted a "scoreable" figure of 161 that was the sum of two
    different reference populations double-counting the same estimates. Two exclusions were
    missing: estimates on a machine coupled to the faulted one, which is 176 of them, and
    estimates made before injection. The arithmetic now closes and the report says it does.
  CHOICES: One of the buckets is worth the whole function: 145 estimates were published on a
    machine with no fault injected into it. That is the remaining-life layer naming a failure
    date for a chiller that was working, and it is the same false positive section 1
    attributes to the efficiency channel, one layer downstream.

`validation/prognostics.py` :: `alpha_lambda` and `alpha_lambda_rollup`
  WHY IT EXISTS: The accuracy question the prognostics literature asks, so this project's
    result can be compared against published ones rather than only against itself.
  WHAT IT DOES: At each fraction of the way from injection to terminal severity, takes the
    estimate published on that date or the most recent earlier one, and asks whether its
    median is within twenty percent of how much life was really left. The tolerance is
    relative, so it narrows in absolute terms as the end approaches — twenty percent of
    ninety days is eighteen days of slack and twenty percent of five days is one.
  CHOICES: Twenty percent is the conventional alpha and is kept rather than tuned. The
    fraction 1.0 is excluded because at the failure date the true remaining life is zero, so
    the accepted band has zero width and everything fails by construction.
  CHOICES: The two earliest fractions come out empty, and that is reported as a finding
    rather than a gap. The remaining-life layer refuses to publish anything until degradation
    is confirmed, and on these runs confirmation lands between a third and two-thirds of the
    way through the fault's life. An accuracy metric that filled those rows in would be
    scoring predictions the platform never made.

`validation/plots.py` :: `alpha_lambda_figure`
  WHY IT EXISTS: The checkpoint asks for a plot, and the accepted region is a cone rather
    than a fixed tolerance, which a table of hit rates hides.
  WHAT IT DOES: One panel per series, matched series first. Draws the true remaining life
    falling to zero, the twenty-percent wedge closing around it, the published median, and a
    vertical bar for each P10-to-P90 interval. An upward triangle marks an estimate where
    the model declined to bound the upper end.
  CHOICES: An unbounded upper end is drawn to the top of the axis with a marker rather than
    omitted, because "the model declined to bound this" is an answer and a gap in the line
    looks like missing data.
  CHOICES: Written as SVG rather than PNG, unlike every other plot in the project. The
    reason is that VALIDATION.md links to it: `docs/plots/*.png` is gitignored because those
    files are diagnostic aids regenerated on demand, so a PNG would leave a broken image in
    a committed document. An SVG is text, which is the same reason checkpoint 6.6's plant
    schematic is committed in that form, and here it is also the smaller file.
  CHOICES: Linear y-axis, deliberately, even though it makes the wedge invisible on the two
    matched panels — the predictions run to hundreds of days against a truth of about ten, so
    the wedge collapses onto the axis. A log axis would make the panel prettier and would
    hide the magnitude of the error, so the report warns the reader instead.

`validation/attribution.py` :: `TRUE_CLASS`
  WHY IT EXISTS: A confusion matrix built on unstated labels measures nothing. This is the
    true class of each injected fault with the reason for each, and two of the six are
    arguable.
  CHOICES: A jammed outdoor air damper is labelled CONTROL rather than EQUIPMENT. The jam
    itself is mechanical, but this project's definition of a control fault is an actuator
    that will not track its command, which is exactly what a jammed damper is. Labelling it
    equipment would also make the control class untestable, since it is the only fault in
    the set that produces an actuator-feedback gap.
  CHOICES: Both leaking valves are EQUIPMENT rather than CONTROL, on the reasoning that the
    valve POSITION still obeys its command — what has failed is the seat.

`validation/attribution.py` :: `classify_runs`
  WHY IT EXISTS: Runs the fault classifier once per machine per run so its answers can be
    scored. It reads no labels at all, including where to look.
  WHAT IT DOES: For each run, poses the isolation problem over a window of recent history
    against the run's own commissioning window as the healthy reference, then asks the
    classifier for a class, a confidence and a subject.
  ⚠ JUDGEMENT CALL: The first version took the observation window's start from the injected
    onset. That is a leak — the harness telling the classifier when the fault began — and it
    would have made the accuracy figure partly a measurement of the answer key. Removing it
    changed a result: with the window running from the platform's own detected onset to the
    end of the run, the coil valve leak came out CONTROL rather than EQUIPMENT, because over
    three months reaching from winter into summer the coil valve's average position drifts
    far enough from its command to look like an actuator refusing orders.
  ⚠ JUDGEMENT CALL: The window is the last 28 days of the run, and it was chosen on
    operational grounds rather than by which window scored best. Two candidates were tried.
    The recent-28-day window gets the air handler right on all three faults and the chiller
    fouling wrong; the whole-post-injection window gets the fouling right and the coil leak
    wrong. Choosing per equipment class would be fitting the harness to the answer key, so
    one rule is applied and the run it gets wrong is reported as wrong. 28 also matches the
    window the advisory layer fits its health slope over, so the project has one notion of
    "recently", and a window ending now is what the classifier would see in production.
  ⚠ JUDGEMENT CALL: The reference is each run's own three-week commissioning window rather
    than a fault-free run at the same time of year, which is what checkpoint 5.4 used and is
    the stronger choice. Two of the air-handler runs sit in late winter and early spring and
    the only fault-free air-handler run is a summer one, so a seasonally matched reference
    does not exist for them and both runs would have had to be dropped — including the coil
    valve leak, which is one half of the discrimination this section exists to measure. The
    check on the substitution is the coil-leak run, the one case where both references cover
    the same 28 days: both return EQUIPMENT.
  CHOICES: The window is NOT restricted to severity level 1, which makes these figures
    easier than the detection figures, and the report says so. The classifier works by asking
    which relations between measurements have stopped holding; at level 1 on several runs
    nothing has visibly stopped holding, so asking it to name a fault it cannot see measures
    the detector again rather than the classifier.

`validation/attribution.py` :: `score_classifications`, `class_matrix`, `majority_baseline`
  WHY IT EXISTS: Attaches the answer key's label after the fact, builds the matrix, and
    computes what a classifier that ignored the data entirely would have scored.
  WHAT IT DOES: A classification is scoreable only where a fault was injected into that
    exact machine. Machines coupled to a faulted one, machines on fault-free runs and the
    held-out run are carried through as unscoreable with the reason attached rather than
    dropped.
  CHOICES: The majority baseline is reported next to the accuracy because without it the
    accuracy is not interpretable. Four of five correct, against three of five for a
    classifier that always answered "equipment" — a thin margin, and what makes it worth
    having is which cases are in it. The drifting thermometer and the jammed damper are the
    two a majority guess gets wrong, and both are right, down to naming the correct physical
    part.

`validation/attribution.py` :: `run_suppression` and `score_suppression`
  WHY IT EXISTS: Checks whether the one demoted advisory was demoted for a true reason.
  WHAT IT DOES: `run_suppression` puts three windows through the cross-asset layer — two
    entirely real, and one that is the same window as the first with a single era-shifted
    chiller fault added — and records what was demoted and whether every demoted advisory
    landed below the advisory it blames. `score_suppression` then applies a falsification
    test: if the answer key injected a fault directly into the machine carrying the symptom,
    the symptom had a cause of its own and the consequential label is wrong.
  CHOICES: Falsification only, because that is the only direction this answer key can settle.
    The two LBNL systems are independent simulations, so no run in this dataset contains a
    genuine chiller-caused air handler symptom for the layer to get right. A link the answer
    key does not contradict is reported as "unfalsified", not as confirmed.
  CHOICES: The two real windows are the negative cases and they carry as much weight as the
    positive one. Both have faults open on other machines and overlapping timing, and the
    plausibility map declines anyway because the open water-side faults cost power rather
    than capacity. A demotion layer that never declines to demote is indistinguishable from
    one that demotes everything.

`validation/report.py` :: `_section_calibration`, `_section_alpha_lambda`,
`_section_fault_class`, `_section_suppression`
  WHY IT EXISTS: Four new sections, inserted before the method appendix. Same rule as before:
    no number is a literal, everything is interpolated, so a regression appears as a changed
    number under unchanged prose.
  CHANGED FROM BEFORE: `render` grew from eleven arguments to nineteen. Two prose bugs were
    caught by reading the generated output rather than the code — a sentence that pooled the
    late-miss counts from two different reference populations and reported 54 of 145 where
    the answer-key row says 42, and the double-counted "scoreable" figure described above.
    Both were arithmetic that looked right in the source and was wrong on the page.

`validation/harness.py` :: `main` and `summarise_prognostics`
  CHANGED FROM BEFORE: The restricted-connection block now also loads the estimate history,
    runs the classifier over every run and puts three windows through the cross-asset layer.
    The answer key is still not opened until that block has closed. Getting this wrong was
    the near miss of this checkpoint: the first version called into the answer key inside the
    block because the classifier needed to know the injection dates, and the fix was to make
    the classifier take its window from the platform's own detected onset instead.

`Makefile` — no change; `make validate` already regenerates everything.

### The four results, and the one cause behind two of them

Everything below is in the generated document.

**Interval calibration is bad and the shape of the failure is informative.** Nominal
coverage is 80 percent. Against the answer key's failure date it is 10.1 percent across
148 bounded estimates, and 0 percent on the two series where the mode names the injected
fault. But the indicator on those two series only ever reached 57 percent and 16 percent of
its own failure threshold, so a band putting the crossing hundreds of days out is right
about its own event and wrong about the answer key's. Where the model's own event did
happen, coverage is 1 of 13 and the misses are late — that part is a genuine calibration
failure on a small sample, and it is stated as one.

**Alpha-lambda accuracy: 0 of 8 checks pass on the matched series, 1 of 35 overall.** The
median relative error is large and positive early in the measurable range and goes to −100
percent late, which is the already-crossed case. The errors are structured, not scattered.

**Sensor versus equipment: 4 of 5, against a majority-guess baseline of 3 of 5.** The one
miss is condenser fouling called a power-meter fault, and it exposes something more useful
than the score: the air handler contributes up to five relations and a chiller up to three,
electrical power appears in two of those three, so a single bias on the power meter can
reconcile a fully developed fouling fault and nothing is left to falsify it with. This is
the same falsifiability problem checkpoint 5.4 solved on the air side by adding baselines
as extra relations. The chiller never received that treatment, and adding it is a
configuration change rather than a code change.

**Cross-asset suppression: two correct refusals and one wrong attribution.** The demoted
advisory is ranked below its named cause in all three situations, so the mechanism is
correct; the inference it is applied to is wrong in the one case this dataset can produce,
and section 7 reaches that conclusion independently from the machine's own evidence.

**Two of these have one cause.** The false positive on the efficiency channel that section 1
identified is now visible in three more places: 145 remaining-life estimates published for a
chiller that was working, two of four healthy machines given a fault class with zero
relations violated, and the finding on the held-out run that turns out to be the same
artefact. It is one defect in one indicator, and it propagates through detection, prediction
and diagnosis.

START HERE: `validation/prognostics.py` — the `threshold_reach` column is what turns a
coverage figure that looks like a broken model into a statement about two different
definitions of failure, and every reading of section 5 depends on it.


### Checkpoint 7.2 addendum — debt cleared

One item of carried-forward debt, cleared on request rather than as part of a numbered
checkpoint. No behaviour changed and nothing was added; code moved to where it belongs.

`analytics/rules/chiller.py` :: `CHILLERS`, `RUNNING`, `OFF`, `chiller_state`, `load_window`
  WHY IT EXISTS: These five are the chiller rules' input contract — which machines the
    plant has, what states they are in, how to decide which state a machine is in at each
    instant, and how to assemble the readings the rules need. They had been living in
    `scripts/run_chiller_rules.py` since checkpoint 3.4, which was defensible while that
    script was their only caller. Checkpoint 7.2 gave them a second caller in
    `validation/detect.py`, which then had to reach into `scripts/` across a package
    boundary via a `sys.path` insert. That import worked and was wrong: a verification
    script is a consumer of the analytics layer, not a place other packages should be
    importing definitions out of.
  WHAT IT DOES: `chiller_state` decides per instant whether a machine is running, and
    requires all three of status on, real power draw and real chilled water flow. All
    three are needed because chiller 1's status point reads 1 for every sample of the
    year, so status alone would never mark it off, the start-up delay would never apply,
    and the rules would be evaluated across every cold start. `load_window` loads one
    chiller's readings and joins on the plant's chilled water supply setpoint, which
    belongs to the plant rather than to any one chiller and which the capacity rule needs;
    it returns nothing rather than an empty frame when the window holds no data, so a
    caller learns that immediately instead of three steps later.
  CHANGED FROM BEFORE: Identical code, new home. `scripts/run_chiller_rules.py` and
    `scripts/run_rootcause.py` now import all five from `analytics.rules.chiller`, and
    `validation/detect.py` does too — so its `sys.path` no longer includes `scripts/` at
    all. The redundant `numpy` and `pandas` imports the script no longer needed came out
    with them, and `load_asset_readings` moved from the script's imports to the module's.
  CHOICES: `validation/attribution.py` still imports `collect`, `era_shift` and three
    window constants from `scripts/run_rootcause.py`, so one scripts-boundary crossing
    remains and is not addressed here. It is a different shape of problem: `collect` is a
    genuine analytics step that belongs beside the cross-asset layer, while `era_shift`
    and the composed-window constants are specific to checkpoint 6.1's demonstration and
    have no home in `analytics/`. Splitting them is a larger change than this request, so
    it is left recorded rather than half-done.

VERIFIED, and the verification is the point of a pure move: `VALIDATION.md` regenerated
after the change is byte-identical to the version generated before it, apart from the
generated-on timestamp. `scripts/run_chiller_rules.py` still reports 0 false positives per
asset-day across all 605 fault-free asset-days and 0 rule reports on the held-out cooling
tower fault, matching checkpoint 3.4. `scripts/run_rootcause.py` still produces the same
three queues, with the traversal agreeing with `app.asset_edges` on all seven upstream
machines and `ahu-1/apar-20` demoted from 1.000 to 0.152 under the chiller in situation 3.
`uv run ruff check .` passes.


## Checkpoint 7.3 — Architecture

### What we did

The project now has a document that explains how it is built and why it is built that way,
aimed at somebody who has to judge the engineering rather than run it. It walks the eleven
layers in the order data moves through them, and for every choice that mattered it names
the alternative that was rejected and the reason. It states in one place what the system
deliberately does not do, including the absence of a test suite, and it states the property
the whole design was arranged around: that adding a new kind of equipment is a semantic
model entry, a rule registration and a few database rows, with no change to the engines
that detect, score or predict.

Before this, that reasoning existed in three places and none of them was the right one. The
long-form arguments were in the decision log, one entry per decision, too long to read as
an overview. The layer-level reasoning was in module docstrings, only findable by opening
the module. And the non-goals were nowhere at all — they had been decided repeatedly in
conversation and never written down, which meant every gap in the system looked like an
oversight rather than a choice. `ARCHITECTURE.md` is the map that sits above all three.

### How it works

`ARCHITECTURE.md` :: the layer walk
  WHY IT EXISTS: The eleven layers are the spine of the project and each one's job is only
    intelligible in terms of the layer above it. A reader who does not know that baselines
    exist to turn "the number is high" into "the number is high for these conditions"
    cannot judge anything downstream of them.
  WHAT IT DOES: One subsection per layer — ingest, quality, semantic graph, rules,
    baselines, health, remaining life, cross-asset diagnosis, advisories, API, UI, plus the
    validation harness. Each says what the layer consumes, what it hands on, and carries
    two to five REJECTED entries naming the alternative and why it lost.
  CHOICES: Nine of the rejected alternatives are cited to the decision log by number rather
    than restated, because the log holds the full argument with the options and the outcome
    recorded after the fact. Roughly thirty more are given in full here because they have no
    log entry — the sustain filter, the suppression windows, collapsing episodes into one
    finding, minimum-across-modes rather than average, isotonic clamping rather than
    per-point, storing both the raw and clamped indicator, the floored process variance,
    priority as null rather than zero, serving only the hourly rollup, keeping display logic
    out of components, and the harness's choice of denominator.
  CHOICES: An ASCII data-flow block rather than a rendered diagram, so the document has no
    build step and no external dependency.

`ARCHITECTURE.md` :: the extensibility property
  WHY IT EXISTS: The checkpoint requires it stated explicitly, and it is the strongest claim
    the design makes: that this is a platform rather than two hard-coded machines.
  WHAT IT DOES: States it as specified, then gives the concrete six-row table for adding a
    boiler, marking each step as semantic model, code, or database rows. Then it says what
    makes the claim true — that nothing in the health, prediction or diagnosis path branches
    on equipment class, and that the only appearances of a Brick class name anywhere in
    `analytics/` outside the rule modules are the keys of one dictionary and two docstrings.
  ⚠ JUDGEMENT CALL: The checkpoint names three requirements — a Brick model entry, a rules
    registration and a failure-mode config row. Checking it against the code found a fourth:
    a new class that wants condition-normalised baselines also needs an entry in
    `BASELINE_CATALOGUE`, which is a dict literal in `analytics/baselines/fit.py`. I stated
    the property as specified and then added the fourth item and two qualifications — that
    rules and baseline forms are genuinely code, declarative in shape but code, and that
    this has been exercised across two equipment classes rather than twenty. Asserting the
    three-item version unqualified would have been a claim a reviewer could falsify in five
    minutes by grepping, which is a worse outcome than a longer sentence.
  CHOICES: It also states the one-level-down case, which is stronger and is fully true:
    adding a new failure mode to an existing class is a single database row and no code at
    all, which is why `threshold_rationale` is a `NOT NULL` column with a minimum length.

`ARCHITECTURE.md` :: what is deliberately not built
  WHY IT EXISTS: An undocumented gap reads as an oversight. Eleven of them are choices.
  WHAT IT DOES: Carries the mandated no-test-suite paragraph verbatim as a blockquote, then
    an eleven-row table of non-goals each with its reason — water metering, air quality,
    MQTT and Modbus, a physics simulator, work order lifecycle, additional dashboards,
    natural-language query, floorplan and 3D, a frontend router, authentication, and
    multi-building.
  CHOICES: The no-test-suite paragraph is followed by a short honest note on what partly
    stands in for it and what does not. Ten verification scripts run each layer over
    real data and print the numbers its checkpoint claimed, and the harness scores accuracy
    on every run — so a regression in accuracy is caught, and a regression in behaviour on a
    fixed input is not. That is exactly the gap the mandated paragraph names.
  CHOICES: Water is the entry worth reading. It is not absent because it was hard; it is
    absent because neither dataset publishes a makeup water flow, so every water number
    would have been an estimate presented as a measurement.

`ARCHITECTURE.md` :: known defects
  WHY IT EXISTS: A reader of the architecture should learn where it is weak from the
    architecture, not by finding it later in the validation output.
  WHAT IT DOES: Six defects, each with its measured size: the efficiency indicator's false
    positive and its propagation through three layers, the interval coverage shortfall and
    the part of it that is genuinely miscalibration, the chiller's relation set being too
    thin to falsify a power-meter hypothesis, the plausibility map being one physical chain,
    the impossibility of positively validating cross-asset causation on independent
    simulations, and the one package boundary still crossed.

### Two factual corrections made while writing it

Both were caught by checking a claim against the code or the database rather than against
an earlier document, which is the reason to write this kind of document at all.

The semantic graph section first said the model was "two vendored LBNL .ttl files merged
with a project extension namespace". Three things wrong: the LBNL models are not vendored,
they are read from the downloaded dataset under `data/raw/ttl/`; there are two extension
files, not one; and it omitted the file that actually matters most, Brick's own class
hierarchy, which IS vendored into the repository and is what every class-closure dispatch
in the system resolves through. A build that had to fetch an ontology would be a build that
could fail offline, and that is why it is vendored.

The remaining-life section first repeated a sentence from the decision log: that the
interval "closes from 3,479 days to 59 across 84 successive estimates as the post-onset
sample count goes from 14 to 53". Queried against `app.rul_estimates`, those numbers do not
pair up. The first bounded estimate is 2,259 days at 14 samples, the widest is 3,479 days
at 44 samples, and the last is 59 days at 53. So 3,479 does not belong with 14. The
corrected sentence gives first-to-last, 2,259 to 59, which is a 97 percent close and is
exactly what the frontend's own `percentClosed` computes — it is defined as one minus last
over first — and states plainly that the interval is not monotone, widening at 44 samples
before closing. The decision log's own readout line two sentences later already records
"widest 3,479 days, narrowest 23, closed by 97 percent, sample count 14 to 53, monotone
no", so the log is internally correct and only its prose sentence pairs the endpoints
loosely. I have not rewritten the log entry, since that is not this checkpoint's scope, but
it is worth knowing that the looser phrasing is there.

START HERE: `ARCHITECTURE.md` — the extensibility section, because it is the only claim in
the document that a reviewer can falsify by grepping, and it is stated so that they can.


## Checkpoint 7.4 — Domain notes

### What we did

The project now explains its own subject matter to somebody who does not have it. Everything
in this repository rests on six pieces of physics — what an air handler is trying to do, what
a chiller is trying to do, what free cooling is, what a fouling heat exchanger looks like in
numbers, why chiller efficiency cannot be compared between two days, and what condenser
fouling physically is — and until now every one of those was assumed. A reader could see that
a threshold was 3.0 K and could not see why 3.0 K rather than 1 or 10.

The second half is provenance. Every fault this project detects is now traced to the
published source that defined it, in a table that also records where a source and this
building disagree. That matters more than it sounds: two of the six declared failure modes
produce no number in this building at all, one because the instrument does not exist and one
because there is not enough healthy data to establish its baseline, and both were previously
visible only to somebody who queried the database and noticed rows missing.

### How it works

`DOMAIN_NOTES.md` :: Part 1, the six explanations
  WHY IT EXISTS: Every threshold, rule and residual in the codebase follows from these six
    things. A reader who does not know that a fouled heat exchanger needs a bigger
    temperature difference to move the same heat cannot judge any chiller number in the
    project.
  WHAT IT DOES: Each of the six gets a plain-language paragraph that assumes nothing, then a
    technical paragraph that gives the actual mechanism, the actual units, and this
    building's actual numbers.
  CHOICES: The plain-first-then-technical split is literal — you can read the first paragraph
    of each of the six, stop, and still follow the rest of the repository.
  CHOICES: Every number quoted comes from the database or from a recorded threshold
    justification rather than from general knowledge: the 1.3402 kW/ton commissioning
    average, the 0.536 kW/ton threshold as 40 percent of it, the 592.4 W fan draw, the 0.42 K
    baseline spread, the 20-ton evaluation floor discarding 3 percent of running samples,
    the 5.0 m³/s airflow, the 107 points across 8 assets.
  ⚠ JUDGEMENT CALL: The approach-temperature section spends more space on why this project
    CANNOT compute approach temperature than on what it is. That is deliberate: approach is
    the first thing a chiller diagnostic normally looks at, its absence here is the largest
    concession the codebase makes to its data, and a reader who does not understand that
    concession will read the chiller rules as amateurish rather than as constrained. The
    algebra is given — one equation, two unknowns, and the water side supplies an identity
    rather than a second equation — so the claim can be checked rather than taken.

`DOMAIN_NOTES.md` :: Part 2, the citation table
  WHY IT EXISTS: The checkpoint requires every failure mode mapped to its published source.
  WHAT IT DOES: Four sources plus one guideline, each with what is taken from it and whether
    it is public. Then three tables: the six degradation modes with threshold, taxonomy
    source, the justification recorded in the database, and whether this data exercises it;
    the nine rules with their source; and the six injected scenarios with the exact LBNL
    filenames and severity counts each is built from.
  CHOICES: RP-1043 is cited strictly as the taxonomy reference and that is stated in those
    words, with the fact that it is not public and is purchasable from ASHRAE, and with the
    explicit statement that no RP-1043 measurement appears anywhere in the repository and no
    accuracy number is computed against it.
  CHOICES: The APAR rules are listed with their original numbering — 6, 7, 16, 18, 20, 27 of
    28 — restated as the assertion each makes rather than as the fault condition the code
    stores, so a reader can see they are conservation statements. The other 22 are accounted
    for: they need points this building does not publish or cover modes these runs do not
    enter.
  CHOICES: Two rows in the mode table are honest negatives rather than omissions.
    `filter-loading` is marked NOT COMPUTABLE with the reason — no filter differential
    pressure exists in either dataset and there is no filter in the simulation to load — and
    `chiller-refrigerant-loss` is marked never exercised, because RP-1043 has the fault and
    the LBNL data does not, and because its validity gate leaves too few samples in the
    commissioning window to establish a baseline. Verified by running the health layer over
    it directly: the indicator computes 5,698 points and `mode_health` returns None.
  ⚠ JUDGEMENT CALL: `fan-bearing-degradation` is attributed to **this project** rather than
    to a published source, because it is not in RP-1043's chiller taxonomy and it is not one
    of LBNL's injected air-side faults. Its threshold is justified against a real standard —
    the NEMA 1.15 service factor applied to this fan's own commissioned draw — but the mode
    itself was declared here. Attributing it to LBNL because it happens to fire on LBNL data
    would have been the easy and wrong thing.

`DOMAIN_NOTES.md` :: the non-condensable gas section
  WHY IT EXISTS: The checkpoint requires the sentence explicitly.
  WHAT IT DOES: Carries it verbatim as a blockquote, then states three things that have to
    sit next to it, matching what `analytics/rules/chiller.py` already records: that
    non-condensable gas is in RP-1043's taxonomy and is in none of LBNL's 23 chiller fault
    runs, so there is no run on which such a detector could be demonstrated either way; that
    the fault this project actually holds out is cooling tower fouling, honoured literally
    with zero rule firings on that run; and that the held-out fault was **not** detected,
    because both findings on it also appear on a fault-free run on the same machines on the
    same day of the year.
  CHOICES: It closes with the physics of non-condensable gas anyway — air leaking into a
    circuit running below atmospheric pressure, collecting in the condenser, blanketing
    surface area and adding partial pressure — because the signature closely resembles
    condenser fouling, and that resemblance is exactly why RP-1043 measured them separately
    and why discriminating them is hard.

`DOMAIN_NOTES.md` :: Part 3, the glossary
  WHY IT EXISTS: The working agreement for this project requires every domain term defined
    inline the first time it appears. Twenty-four of them appear across the documents and
    code, so they are defined once in a table instead.
  WHAT IT DOES: Covers approach temperature, changepoint detection, CHW and CDW, the
    commissioning window, dry and wet bulb, economizer, EWMA, first-passage time, isotonic
    regression, kW/ton, lift, LMTD, MERV, part-load ratio, residual, the four air
    temperatures, static pressure, ton of refrigeration, VAV and the Wiener process.

### One factual correction made while writing it

The chiller section first said the plant "runs about 6.7 °C supply", taken from the minimum
of the setpoint's range. Queried against the measurements, that is wrong: over a summer the
plant's chilled water setpoint averages 9.31 °C and moves between 6.67 and 12.22, and
chiller 1's actual supply averages 9.26 °C. It is a chilled water **reset** schedule, not a
fixed setpoint — a warmer setpoint is cheaper to make, so the plant only asks for cold water
when the load needs it. The corrected paragraph says so, and points out that this is exactly
why the capacity rule compares supply temperature against the plant's current setpoint
rather than against a constant. Getting this wrong in the other direction would have made
the capacity rule look like an unnecessary complication.

START HERE: `DOMAIN_NOTES.md` — the approach-temperature section. It is the one place where
the physics a textbook would use and the physics this data permits come apart, and the rest
of the chiller design only makes sense once that is understood.


## Checkpoint 7.5 — README and roadmap

### What we did

The project can now be handed to somebody. Two documents: one that says what this is, gets it
running, and walks a stranger through the seven minutes that demonstrate it; and one that says
what is finished, what should be done next in what order and why, and what will never be done.

Between them they close the last gap in the deliverable. Until now a reader arriving at the
repository had no entry point — the architecture document explains a system they had not seen
running, and the validation document scores a system they had no way to start. And the
absence of a roadmap meant every gap in the product looked like an oversight, including the
missing test suite that the architecture document explicitly promises is scheduled somewhere.
It is now scheduled somewhere.

Two things came out of writing the quickstart that matter more than the prose. The documented
setup sequence did not work, and fixing it needed two new Makefile targets — so the README is
the first artefact in this project that was tested by being followed rather than by being
read.

### How it works

`Makefile` :: `advisories-write`
  WHY IT EXISTS: Nothing in the project put rows in `app.advisories`. The `advisories` target
    runs the queue as a report; only `scripts/run_advisories.py --write` stores it, and that
    invocation existed nowhere except in the script's own docstring. On a freshly built
    database the API therefore serves an empty queue and the dashboard comes up blank, which
    would have made the README's walkthrough undemonstrable on any machine but this one.
  WHAT IT DOES: Runs the same script with `--write`.
  CHOICES: Kept as a separate target rather than adding `--write` to `advisories`, because
    that target is a verification report and printing a report should not mutate a table.

`Makefile` :: `demo`
  WHY IT EXISTS: The analytics artefacts the dashboard shows — health scores, the
    remaining-life history, the advisory queue — do not exist after `make load`. There was no
    single documented path from an empty database to a working demo, only nine checkpoints'
    worth of targets and the knowledge of which order they go in.
  WHAT IT DOES: Chains `db-up load scenarios quality residuals baselines health rul
    advisories-write` and then prints what to run next.
  CHOICES: The order is a genuine dependency chain, not a convenience: the loader has to place
    measurements before the graph can resolve nodes to assets, the quality scores gate what
    the baselines may fit on, health needs the residuals, the remaining-life replay needs
    health, and the advisory queue needs both plus the cross-asset pass. Stated in a comment
    on the target so it survives someone reordering it.
  CHOICES: `modes`, `degradation`, `plots`, `apar`, `chiller-rules`, `refusal` and `diagnosis`
    are deliberately NOT in the chain. They are report-only — they compute and print and
    write nothing — so including them would triple the runtime of a setup step for output
    nobody is reading at that moment.

`README.md` :: what this is, and the quickstart
  WHAT IT DOES: Three sentences on the product, a table linking the four other documents, and
    a six-command setup.
  CHANGED FROM BEFORE: The brief specified `docker compose up, make load, make api, make web`.
    That sequence does not work and the first command is the reason: `docker compose up`
    starts the container but does not apply `scripts/schema.sql`, so `make load` runs against a
    database with no tables. The quickstart uses `make db-up`, which starts the container,
    waits for it to accept connections and applies the schema, and the README says in one
    clause why. `make demo` was added between `load` and `api` for the same reason — following
    the brief literally produces a dashboard with nothing on it.
  CHOICES: It also says to download the LBNL datasets into `data/raw/` first, because the
    loader exits with "Download the dataset first" and a reader should hit that sentence in the
    README rather than in a traceback.

`README.md` :: the timed walkthrough
  WHY IT EXISTS: Seven minutes is what a reviewer will actually give this, and left to
    themselves they will click the first row and see a chart. The walkthrough routes them
    through the five things that are hard to build and easy to miss.
  WHAT IT DOES: Six stops at the specified times. The dashboard and the economic ranking; the
    fan chart; the evidence and graph trace; the sensor-versus-equipment pair; the demoted
    cross-asset advisory; and the validation document.
  ⚠ JUDGEMENT CALL: The brief says "1:00 open the chiller advisory, RUL with narrowing
    interval". The chiller advisory's interval does not narrow — `chiller-condenser-fouling`
    **widens by 12%** over its run, which is a known limitation of the degradation fit recorded
    in checkpoint 5.2 and visible in `VALIDATION.md`. The series that narrows is the air
    handler's coil valve leak, which closes 97% from 2,259 days to 59 across 84 estimates, and
    checkpoint 6.5 deliberately put that advisory in the queue so the flagship chart would be
    reachable by clicking. So the walkthrough opens the top row — the coil valve leak — for the
    narrowing chart, and then opens the chiller advisory immediately afterwards to show the
    contrast, with the sentence "a demo where every chart cooperates is a demo of chart
    selection". Following the brief literally would have put a widening interval on screen at
    the moment the presenter said the word "narrowing".
  CHOICES: Every number in the walkthrough was read out of the live database rather than
    recalled: priority 24.7, cost $68,625, median 32 days, position 7 of 7 for the demoted
    advisory, and $262.50 against $830.00 for the two dispatch options — verified as 3.16×,
    quoted as 3.2×.
  CHOICES: The 1:00 stop states that the fan chart is not monotone and that it widens at 44
    samples before closing, and says why that is correct behaviour rather than a defect. The
    7:00 stop reads the worst number in the project out loud — 10.1% interval coverage against
    a nominal 80%. A walkthrough that only visits the good screens is a sales demo, and this is
    being judged as engineering.

`README.md` :: the iteration paragraph and the validation claim
  WHAT IT DOES: Two short sections covering the specified content — prioritised iterations
    against a fixed time budget, iteration 1 as the minimum system that genuinely predicts
    failure with quantified confidence, everything after it additive and listed in the roadmap,
    the commit history reflecting that order; and separately that the fault signatures are
    grounded in third-party labelled data, that only the temporal trajectory between measured
    severity levels is synthesised because no public run-to-failure dataset exists for
    building HVAC, and that every accuracy number is computed against labels this project did
    not create.
  CHOICES: The validation claim ends with the mechanism rather than the assertion: the
    separation is enforced by a database role with no grant on the answer key's schema, and
    exactly one module opens the credential that can read it. An assertion of independence is
    worth much less than a description of what makes it unavoidable.
  CHOICES: A scope-and-limitations section follows immediately, saying that the figures rest on
    single-digit event counts against asset-day denominators in the thousands, and pointing at
    the six known defects. Putting it under the validation claim rather than at the bottom is
    deliberate.

`ROADMAP.md` :: section 1, shipped
  WHAT IT DOES: A table of what each of the eleven layers actually delivers, then the current
    measured numbers with the bad one included in the same list as the good ones.

`ROADMAP.md` :: section 2, next in priority order
  ⚠ JUDGEMENT CALL: I reordered the brief's list and said so in the document. The brief
    suggested leading with an energy and water dashboard and putting the natural-language
    query layer third. I put four correctness items in front of everything: fixing the chiller
    efficiency false positive, adding chiller baselines so the isolation test can falsify a
    power-meter hypothesis, diagnosing the late bias in the remaining-life interval, and the
    test suite. The reasoning is stated in the document — the system currently has a false
    positive that propagates through three layers and a prediction interval that does not mean
    what it says, and building a dashboard on top of that is building on a floor with a hole in
    it. Two of those four items make the numbers look worse before they look right, which is
    exactly why they would never get done if the ordering optimised for the demo. Every item
    the brief listed is present.
  WHAT IT DOES: Five tiers. Tier 0 correctness; tier 1 the two things without which the
    product is not usable, work order lifecycle and a frontend router; tier 2 new capability
    the existing data supports; tier 3 new capability blocked on instrumentation; tier 4
    presentation. Each item says what it is, what is known and not known, the approach, the
    effort, and what it depends on.
  CHOICES: Each tier-0 item cites the specific evidence for it in `VALIDATION.md`, so a reader
    can check that the priority is justified rather than asserted.
  CHOICES: The water balance and air quality items say explicitly that they are **unbuildable,
    not merely unbuilt** — neither dataset publishes a makeup water flow or a CO₂ point — and
    each names the single instrument that would unblock it. That distinction is the difference
    between an omission and a dependency.
  CHOICES: The physics simulator entry opens by distinguishing itself from a decision already
    taken. D-02 rejected a simulator as the source of ground truth and that stands permanently;
    what is proposed here is a forward model for what-if projection, and the entry says it must
    never be wired into a metric. Without that paragraph the roadmap would appear to contradict
    the decision log.

`ROADMAP.md` :: section 3, explicitly not doing
  WHY IT EXISTS: The difference between "not yet" and "no" is most of what a roadmap is for.
  WHAT IT DOES: Eight decisions, each with the reason it would make the system worse: a
    self-built simulator as ground truth, deep learning for remaining life, suppressing
    consequential advisories, removing the refusal behaviour, tuning a threshold to improve a
    validation number, closed-loop control, becoming a building automation system, and
    authentication or multi-tenancy for their own sake.
  CHOICES: Two of these are new here rather than inherited from the decision log. **Tuning a
    threshold to make a validation number improve** is written down as a prohibition because
    every threshold carries a required written physical justification in a `NOT NULL` column
    specifically so that moving one means changing the argument rather than only the value.
    And **closed-loop control** is refused on a safety basis rather than a scope basis: this
    system advises a human, and a platform that adjusted setpoints on the strength of an
    inference `VALIDATION.md` shows can be wrong is a different product with a different
    safety case.

### Verification

Both documents were checked mechanically rather than read for typos. All six specified
walkthrough timings present; all four quickstart commands present; every element of the
iteration paragraph and the validation claim present; all ten roadmap items from the brief
present plus the test suite the architecture document promises; all seventeen internal links
across README, ROADMAP and ARCHITECTURE resolve, which includes the `ROADMAP.md` link that has
been broken since checkpoint 7.3 and the one inside the mandated no-test-suite paragraph; no
ragged markdown tables. `make -n demo` expands to the correct nine-step chain. `.env.example`
does carry exactly the two passwords the README says to set.

START HERE: `README.md` — the timed walkthrough. It is the only document in the project written
to be executed rather than read, and the one place where a claim that does not survive contact
with the running system shows up immediately.


## Checkpoint 7.6 — Final decision log entries

### What we did

The decision log now covers the two decisions that framed everything else and had never
been written down: how much of the building to take on, and how to treat the things that
would deliberately not be built. It also records what Task 7 measured about the
sensor-versus-equipment discrimination, which is the first time that layer has been scored
against the answer key rather than demonstrated on cases chosen for it.

Those two missing entries were missing for the same reason. Both decisions were taken
before any code existed, both were applied continuously afterwards, and neither ever
produced a moment where writing it down was the obvious next thing to do. The result was a
log that recorded nine technical choices in detail and was silent on the two that
constrained all nine.

### How it works

`AI_LOG.md` :: D-00 — Scope: one building, AHU plus chiller, fixed time budget
  WHY IT EXISTS: Every other entry in the log is downstream of this one. The scope decides
    how many equipment classes each layer must generalise over and how much surface there
    is to validate, and without it a reader cannot tell whether "two equipment classes" was
    a judgement or whatever the dataset happened to offer.
  WHAT IT DOES: Four named options — one class done deeply, two classes joined by one
    modelled edge, everything the dataset ships, and multiple buildings — with the rejection
    reason for each. The rationale turns on one question: what is the smallest system that
    can genuinely predict a failure, quantify its confidence and explain it across a machine
    boundary. Each of those three rules something out, and the third is what fixes the count
    at two classes and one edge.
  ⚠ JUDGEMENT CALL: Numbered **D-00** and placed FIRST in the log rather than appended at
    the end. The checkpoint said to append it as D-01, and there is already a D-01 on
    TimescaleDB. Renumbering nine entries would break every cross-reference in
    `ARCHITECTURE.md`, `ROADMAP.md` and these notes, and appending a project-start decision
    at position ten makes it useless as the frame for the nine it precedes. So it is zero,
    it sits at the top, and it opens with a blockquote saying the decision was taken at
    project start and recorded retrospectively at the end of Task 7. The log's header now
    explains the numbering in two sentences so a reader does not have to infer it.
  CHOICES: The Outcome is the part worth reading, because two of its three findings are
    corrections to the reasoning rather than confirmations of it. The two-class scope was
    right for a reason I had not identified — it is the minimum at which the extensibility
    claim becomes CHECKABLE, and every class-dispatch point broke first and got fixed,
    including the Brick equivalence bug that made string matching silently fit nothing.
    And the one edge turned out to be unvalidatable in the positive direction, because the
    two LBNL systems are independent simulations, which is a direct consequence of choosing
    scope by what the model needs rather than by what the data couples. The cheapest fix was
    available and unnoticed: tower to chiller is the one chain this dataset genuinely
    couples, both sit inside the same simulation, and giving the tower a failure mode would
    have made the cross-asset layer positively validatable. It is now roadmap item 2.2 and
    it should have been in scope on day one.

`AI_LOG.md` :: D-08 Outcome — "Updated after Task 7"
  WHY IT EXISTS: The checkpoint asks for it, and Task 7 scored this layer against the
    answer key for the first time.
  WHAT IT DOES: Records 4 of 5 correct against a 3 of 5 majority-guess baseline, states that
    a one-case margin over guessing is not a demonstration on its own, and then says what
    makes it worth having: the drifting thermometer and the jammed damper are the two a
    majority guess gets wrong and both are right, with the damper case naming the outdoor
    damper that was actually jammed rather than the return damper it is linked to.
  CHOICES: Most of the entry is about the MISS rather than the four hits, because the miss
    confirms this decision's own central claim. The original entry argues that supply air
    temperature is unfalsifiable on the constraint set alone because it appears in exactly
    one relation, and that adding baselines as relations fixed it by taking it from one to
    three. The chiller never received that treatment: it contributes three relations to the
    air handler's five, and electrical power appears in two of the three. So the same
    argument predicts, exactly, that the chiller will fail on any fault developed enough to
    move two relations at once — and condenser fouling came out SENSOR, blaming the power
    meter, reconciling 99 percent of the violation with nothing left to contradict it. The
    entry says plainly that being confirmed by a miss is the stronger and less pleasant kind
    of confirmation.
  CHOICES: Two weaknesses the scoring exposed are recorded as new rather than folded into
    the existing text. The observation window matters and there is no uniformly right one —
    28 days gets the air handler right and the chiller wrong, the whole post-injection
    stretch gets the reverse, and choosing per equipment class would be fitting the harness
    to the answer key. And the equipment branch is weaker than the sensor branch in a way
    the chosen cases hid: sensor and control both require positive evidence, while equipment
    fires on the absence of a sensor explanation plus a degradation trend, so when the trend
    is spurious nothing stops it — two of four healthy machines were labelled that way.
  CHANGED FROM BEFORE: One sentence in the earlier Outcome is corrected rather than left
    standing. It said the layer "depends on having a fault-free window at the same time of
    year to compare against". Task 7 tested that with each run's own commissioning window as
    the reference and it holds: on the one run where both references cover the same 28 days
    they return the same class. The seasonal reference is better; it is not required.

`AI_LOG.md` :: D-10 — Explicitly not built, and why
  WHY IT EXISTS: The checkpoint asks for it, and it is the decision `ROADMAP.md` section 3
    is the output of.
  WHAT IT DOES: Three options — build a thin version of everything, build deep and say
    nothing about the gaps, or build deep and document every gap with its reason and its
    blocker. The rationale is that an undocumented gap is evidence about thoroughness and a
    documented one is evidence about judgement, and judgement is what a time-boxed project
    is assessed on.
  CHOICES: The entry records the distinction that fell out of the framing and that I would
    not have found by listing cuts: some things are **unbuildable on this data** and some
    were **traded away**, and they need different treatment. Neither dataset publishes a
    makeup water flow or a CO₂ point, so water balance and air quality are blocked on
    instrumentation and each names the single meter that would unblock it. The test suite,
    the dashboards, the work order lifecycle and the router were all buildable and were
    traded, so each names what it was traded against and goes into the roadmap in priority
    order.
  CHOICES: It names why option 1 was the dangerous one rather than the lazy one. The thin
    version demos best, the model offered it repeatedly and always with a working
    implementation attached, and it arrives already working so declining it feels like
    waste. A handful of tests on the easy functions is specifically called out as worse than
    none, because it converts "no test suite" into "a test suite that passes".
  CHOICES: The Outcome concedes one trade as indefensible. The test suite is the one I would
    not make again, and the reason is that three defects surfaced in the final scoring pass
    that a modest suite would have caught earlier — none visible from any individual layer's
    verification output, because each layer's script checks that the layer did what it was
    asked and none checks that what it was asked for was right. The defence I would have
    offered, that the verification scripts and the harness substitute for tests, is half
    true: they catch a regression in accuracy and they do not pin behaviour on a fixed
    input.
  CHOICES: It also records a structural mistake — treating the not-built list as one
    document when it is two. Permanent refusals are not deferred work, and two of the five
    named were only articulated while writing that section, which is late. A prohibition on
    tuning thresholds to improve a metric should have been written the first time a
    validation number came out badly, not after the last one did.

### Verification

Eleven entries. Every one carries all six required subsections — Forcing question, Options,
Rationale, Mine vs delegated, Confidence, Outcome — and two carry an Overrode section. No
Outcome is a stub: they run from 2,402 to 9,747 characters, with D-08 now the longest after
three sessions of updates. Named options per entry: 4, 3, 3, 3, 4, 3, 3, 4, 3, 4, 3. D-00 is
marked as taken at project start in a blockquote at its head, D-08 carries an explicit
"Updated after Task 7" section, and D-10 cross-references `ROADMAP.md`.

### One factual correction, across three documents

`AI_LOG.md`, `ROADMAP.md` and these notes each claimed "sixteen verification scripts under
`scripts/`". There are fourteen files in that directory and ten of them are verification
drivers; the other four are plotting helpers. All three now say ten. The number had been
carried from document to document without anybody counting, which is exactly the failure
mode a generated validation document exists to prevent and which prose does not get.

START HERE: `AI_LOG.md` — the Outcome of D-00. It is the only place in the project that
records the scope decision being right for a reason other than the one it was made for, and
being wrong about something nobody checked.


## Demo Phase 1, Checkpoint 1.3 — Daily advisory replay

Numbered against the demo build plan rather than the original task list, which ended at
7.6. `Checkpoint 1.3` on its own already means the schema, so this heading carries the
phase.

### What we did

The system can now say what the maintenance queue looked like on any given morning,
rather than only what it looks like once. Before this it held a single snapshot computed
over one hand-picked stretch of time — enough to fill a screen, not enough to make one
move. The demonstration this is being built for has to put a clock at a date and show an
advisory that was not there the week before appearing, climbing the ranking as the fault
worsens, and its cost of doing nothing growing with it. That is now six hundred and
nineteen days of queue instead of one, and it needed no change to the shape of the
database: the table had been keyed for exactly this since it was written and nothing had
ever used it.

### How it works

    scripts/run_advisory_replay.py :: eras()
      WHY IT EXISTS: The replay has to know which days to compute a queue for. The
        obvious source is the scenario manifests, and they are the wrong source: they
        record when each fault was injected, which is answer-key material the detection
        path is forbidden to read. This function gets the same span from a table that
        holds only which days this project already scored something on.
      WHAT IT DOES: Groups the stored health history by calendar year and returns the
        first and last day of each. Four eras come back, spanning 619 days in total.
        Every scenario is placed a whole number of years from its 2018 source window, so
        a calendar year is exactly one era, and two scenarios sharing a year are on
        different equipment and belong in the same queue on the same day.
      CHOICES: Deriving the span from data rather than configuration is not only about
        the answer key. If a run is ever shortened or extended, the replay follows it
        without anybody remembering to edit a constant.

    scripts/run_advisory_replay.py :: EraReadings
      WHY IT EXISTS: This is the entire reason the batch is three hours and not nine.
        Six hundred overlapping four-month windows are drawn out of eras only a few
        months long, so consecutive days share about 99% of their readings, and the
        original code fetched all of them again every time.
      WHAT IT DOES: Fetches one era's readings for all five relevant machines once — the
        air handler, the three chillers, and the plant whose setpoint the capacity rule
        needs — and holds them as three aligned tables per machine: the values, the
        trust score for each value, and the breakdown of which trust dimension each
        score failed. Everything afterwards takes slices of these instead of querying.
      CHOICES: 172,512 rows for the 2036 era, fetched in 15 seconds, held in memory for
        the whole era. Five machines rather than eight because the other three have no
        rule and no failure mode that could put them in a queue.
      ⚠ JUDGEMENT CALL: I had planned to cache the rule FIRINGS instead, and measuring
        first is what stopped me. Of the 45 seconds a day cost, 35 was fault collection
        and two thirds of that was the database read, not the arithmetic — the chiller
        sweep spent 16 seconds reading and 8 computing, to return zero findings. Caching
        firings would also have moved where a sustained run of firings is judged to
        begin, changing results at every window edge, and the advisory output is what
        the validation document rests on. Caching readings cannot do that, which is why
        the equality check below is possible at all.

    scripts/run_advisory_replay.py :: EraReadings.asset()
      WHY IT EXISTS: The slice has to be indistinguishable from a fetch, or every number
        downstream quietly stops matching the code path everything else uses.
      WHAT IT DOES: Returns the rows whose timestamp is at or after the window start and
        strictly before its end, from all three tables at once.
      CHOICES: Half-open on the right, because the SQL behind the real loader is
        `>= from` and `< to`. Slicing inclusively would have handed the rules one extra
        sample per window — a difference small enough to survive review and large enough
        to make six hundred days of output subtly wrong.

    scripts/run_advisory_replay.py :: EraReadings.window()
      WHY IT EXISTS: A chiller rule cannot be evaluated from the chiller alone. Whether
        the machine is failing to reach the temperature it was asked for depends on a
        setpoint that belongs to the plant, not to any one chiller, so it has to be
        brought alongside.
      WHAT IT DOES: Slices the chiller's readings and the plant's, then joins the one
        setpoint column onto the chiller's tables, and returns nothing at all when
        either side is empty for that window — which is how a caller learns the machine
        has no data rather than finding out three steps later.
      CHANGED FROM BEFORE: Reproduces the existing loader's join rather than calling it,
        because that function reaches for the database and this class exists to stop
        doing that. Same column, same left join, same empty-means-None rule.

    scripts/run_rootcause.py :: ahu_rule_faults(), chiller_rule_faults(), collect()
      WHY IT EXISTS: These are what actually sweep the rules and collapse repeated
        firings into one finding per rule. The replay needs them to read from memory
        instead of the database without becoming a second copy of them.
      CHANGED FROM BEFORE: Each gained one optional argument holding preloaded tables.
        Left out, they fetch exactly as they always did, so every existing caller is
        untouched and unaffected. Passed in, they take slices. No other line changed.
      CHOICES: An optional argument rather than a separate replay-only copy of the
        sweep. A copy would have drifted from the original the first time either was
        edited, and then two different sets of advisories would exist with no way to
        tell which was current.

    scripts/run_advisory_replay.py :: reference_window()
      WHY IT EXISTS: Every advisory ranks the signals that moved most, in units of how
        much that signal normally wanders. That needs a stretch of healthy operation to
        measure "normally" against, and which stretch is not a free choice.
      WHAT IT DOES: Returns either the era's own first 21 days — the commissioning
        window, meaning the healthy period before anything was injected, and the same
        stretch the baseline layer already fits on — or the same calendar days one to
        three years later in a clean run.
      ⚠ JUDGEMENT CALL: The existing code uses the same-calendar-days version, which
        cancels out weather, and I made the commissioning window the default anyway.
        The reason is availability, not preference: the two clean runs occupy May to
        September 2039, while the 2036 and 2037 eras begin in February and January, so
        most days in the replay have no same-season counterpart and would produce no
        advisory at all. Task 7 had already tested the commissioning window against the
        seasonal one and found they agree where both exist, so this is a documented
        finding rather than a guess. The weakness is real and stated: a February
        reference against an August observation compares two weather regimes, and a
        point that moves with outdoor temperature reads as having shifted when only the
        season did. It affects the evidence ranking on the advisory only — the residual
        and health layers are condition-normalised and do not have this problem.
        `--reference seasonal` restores the old behaviour and covers fewer days.

    scripts/run_advisory_replay.py :: classify_or_ambiguous()
      WHY IT EXISTS: Walking every day of every era found a case three hand-picked
        windows never could. The sensor-versus-equipment test works by asking whether
        one sensor reading wrongly would explain everything that looks broken, and that
        question needs at least one physical relation — an energy balance, or a fitted
        expectation — touching the machine inside the window. A chiller that barely ran
        that spring has none, and the sweep raises an error rather than returning.
      WHAT IT DOES: Classifies one machine at a time, and where the sweep cannot run,
        records the class as ambiguous with a reason saying precisely why: no relation
        touches this machine over this window, so no single-sensor explanation could be
        formed OR rejected. The evidence fields say "not attempted" rather than being
        left blank.
      ⚠ JUDGEMENT CALL: The alternative was to drop that machine's advisories for the
        day, which would have left silent holes in the history with nothing on screen
        explaining them. Ambiguous is a value the schema already permits and it is the
        honest word: the layer did not fail, it genuinely had nothing to reason from.
        One machine at a time matters too — classified as a set, one silent chiller
        would have cost every other machine its diagnosis that day.

    scripts/run_advisory_replay.py :: replay_era()
      WHY IT EXISTS: The loop that turns one era into one queue per day.
      WHAT IT DOES: Loads the era once, then walks it a day at a time, oldest first. For
        each day it takes the trailing four months ending that day, clipped to the start
        of the era, collects everything open from every detector over that slice, works
        out which findings are consequences of others, diagnoses each machine, builds an
        advisory per finding and orders the result. Days with nothing open cost
        milliseconds and produce no rows.
      CHOICES: The observation window trails the as-of date rather than being fixed,
        which is the whole point of a replay: an advisory dated the 3rd genuinely does
        not know what one dated the 10th knows. 120 days is kept identical to the span
        the snapshot script uses, so a replayed advisory and a snapshot one are computed
        the same way and remain comparable.
      CHOICES: Progress prints on every tenth day whether or not it produced anything.
        The first version printed only on days that wrote rows, and since most days
        early in an era are healthy, a three-hour batch would have looked hung for its
        first twenty minutes.

    scripts/run_advisory_replay.py :: write_snapshot()
      WHY IT EXISTS: The existing write path empties the whole table before inserting.
        That is correct when it owns the single snapshot it writes, and destroys the
        history the moment a second day exists.
      WHAT IT DOES: Inserts each day's queue and, on a row that is already there,
        updates it in place. Each advisory's identifier is built from the machine, the
        fault and the date the window ends, so a queue computed to a different date is
        a different set of rows rather than a collision.
      CHOICES: Additive and therefore resumable — a killed run picks up from the days
        already present, and rerunning one day corrects that day and leaves the rest
        alone. This is what made a three-hour batch safe to start.
      ⚠ JUDGEMENT CALL: `make advisories-write` still deletes everything, so running it
        after the replay destroys the history. I left it that way rather than changing a
        verified script, and put the ordering in the Makefile comment. It is a footgun
        in the repository either way and the comment is the weaker of the two fixes.

    Makefile :: advisory-replay
      WHY IT EXISTS: One command, and a place to record that the ordering against
        `advisories-write` matters.
      WHAT IT DOES: Runs the replay with resume switched on, so an interrupted batch
        continues rather than starting over.

### Verification

Cost was measured before an approach was chosen, and the measurement changed it:

    collect               78.8%    35.40s/day     of which ~2/3 was the database read
    build                 10.7%     4.83s/day
    classify               9.6%     4.33s/day
    attribute              0.8%     0.38s/day
    chiller sweep @120d:  load 16.1s | rules 7.8s  -> 0 faults found

Measured over ten faulted days, the per-day cost fell from **44.95s to 16.4s**, a factor
of 2.7, putting 619 days at about 2.8 hours instead of 9.4.

The check that matters is not the speed, it is that nothing changed. Fault collection was
run both ways over four windows and compared on machine, fault, both timestamps, severity
to nine decimal places and the detail text:

    2036-06-15  db= 4 cached= 4  IDENTICAL
    2036-07-20  db= 6 cached= 6  IDENTICAL
    2036-08-02  db= 7 cached= 7  IDENTICAL
    2036-09-01  db= 7 cached= 7  IDENTICAL

`uv run ruff check` passes on both changed files.

### Known consequence, not yet resolved

Where a replayed day's window ends on the same date as one of the seven existing snapshot
rows, the replay overwrites it. The replayed version is the more principled of the two —
same trailing window as every other day rather than a span chosen to display three
particular advisories — but it may change which advisories the README walkthrough names,
and that has not been checked yet.

START HERE: `scripts/run_advisory_replay.py` — the module docstring states the two
windows every advisory now carries and why the reference one had to change, which is the
only decision in this checkpoint that alters what an advisory says rather than how fast
it is produced.


## Demo Phase 1, Checkpoint 1.1 — Twin topology endpoint

### What we did

The system can now hand a dashboard the shape of the building: every piece of
equipment, every water loop, every occupied space, which of them feeds which, and
which readings are taken on each. Before this it could only describe the building as
eight machines with no insides, because the one place that shape was written down had
been flattened for a different purpose — answering "is this upstream of that" quickly
during fault diagnosis — and flattening discarded everything inside a machine. The
demonstration needs the opposite: a picture that starts at a cooling tower on the roof
and ends at five occupied rooms, with every step in between visible and clickable. That
chain now comes back from one call, thirty-one nodes and fifty-four relations, and it
is the same semantic model the diagnosis layer reasons over rather than a drawing
maintained separately.

### How it works

    model/twin.py :: _point_index()
      WHY IT EXISTS: A sensor in the semantic model and a sensor in the database are
        two different objects that happen to describe the same instrument, and nothing
        in either one states the connection. Without this join the drawing could show
        where every sensor sits and could never fetch a value for one.
      WHAT IT DOES: Reads both ingestion manifests and builds a lookup from the pair
        (which source system, which column name) to that column's full record — its
        database key, its human name and its unit. The semantic model names each
        reading after the source spreadsheet column, so the column name is the shared
        fact the two sides can be joined on.
      CHOICES: The same recovery route the asset mapping already uses, deliberately.
        There is now one way this project relates a graph point to a stored point, not
        two that could disagree.

    model/twin.py :: _brick_class()
      WHY IT EXISTS: The class decides how a node is drawn — a chiller is not a pump is
        not an occupied room — and a node can carry more than one type.
      WHAT IT DOES: Returns the node's type from the Brick vocabulary, preferring it
        explicitly over any other type the node carries, and falls back to whatever
        type exists if somehow there is no Brick one.
      CHOICES: Preferring rather than taking the first. Triple stores make no ordering
        promise, so taking the first would have produced a drawing that changed its
        icons between restarts.

    model/twin.py :: build()
      WHY IT EXISTS: The single unit of work in this checkpoint. Turns the merged
        semantic model into the node-and-edge list a drawing needs.
      WHAT IT DOES: Walks every reading in the model and files it under the thing it is
        attached to, joining each to its database identity on the way. Then decides
        which things are worth drawing, works out what contains what, and emits one
        node per thing with its class, its database asset, its container and its
        readings, plus one edge per relation between two things it kept.
      CHOICES: A node is kept if it carries flow, holds a reading, or contains
        something that does. The node set is collected before any edge is emitted, so
        an edge can never point at a node the caller was not given — checked below and
        it holds.
      ⚠ JUDGEMENT CALL: That rule is a deliberate SUPERSET of the flow chain, and the
        outside air damper is why. It feeds nothing in the model, so a flow-only rule
        would have dropped it — but it has a position sensor and it is the target of
        one of the injected faults, so a picture of this building without it would be
        lying by omission. The alternative, drawing only what carries flow, gives a
        tidier diagram that cannot show one of the six faults this project detects.
      ⚠ JUDGEMENT CALL: Both kinds of relation are returned and labelled rather than
        just the flow one. Flow says which way a fault travels and therefore which way
        the picture should read; containment says which box a thing is drawn inside.
        Neither can be derived from the other, and returning only flow would have left
        the front end to invent its own grouping. The cost is that a caller must know
        the difference, which is why the field carries that sentence in the schema.
      CHOICES: A reading whose column never reached the database comes back with a null
        key rather than being dropped, so a sensor the model claims exists and has no
        stored history is visible rather than quietly absent. As it happens there are
        none — all 107 join — but the drawing would have shown the gap if there were.

    api/models.py :: TwinPoint, TwinNode, TwinEdge, TwinTopology
      WHY IT EXISTS: The wire contract, and the place the two counts are distinguished.
      WHAT IT DOES: Describes a reading, a node, a relation, and the whole topology with
        its totals. Nullable fields carry a sentence saying what null MEANS — a node
        with no database asset is one the database does not model, such as a water loop,
        rather than a lookup that failed.
      CHOICES: point_count and point_attachments are separate because they are genuinely
        different numbers: 107 and 109. Three cooling towers share one supply
        temperature setpoint — the temperature the towers are asked to deliver — so it
        is drawn on all three and counted once. The first version reported only the
        larger number and would have contradicted app.points by two for a reason nobody
        could have found from the response.

    api/main.py :: _twin()
      WHY IT EXISTS: Building the topology walks every reading in the model and parses
        both manifests. Cheap once, wasteful on every request from a dashboard that
        redraws whenever its clock moves.
      WHAT IT DOES: Builds it on first call and keeps it for the life of the process,
        converting the internal form to the wire form.
      CHOICES: Safe to cache only because the shape cannot change while the process
        runs — it comes entirely from the Turtle files and nothing in this API asserts a
        triple. That is the same argument the shared graph already rests on.

    api/main.py :: GET /twin/topology
      WHY IT EXISTS: One call that gives a front end everything it needs to draw the
        building before it asks for a single value.
      WHAT IT DOES: Returns the cached topology. 27.6 KB, static for the process.
      CHOICES: Values are deliberately NOT included. The shape changes never and the
        values change constantly, so binding them into one response would mean
        refetching the whole building on every tick of the clock.

Two trivial units are not described: a label helper that turns underscores into spaces,
and the tuple pairing each relation name with its predicate.

### Verification

    nodes 31 | edges 54 | points 107 | attachments 109
    feeds edges 30 | hasPart edges 24
    edges pointing at a node not returned: 0  OK
    nodes whose parent was not returned   : 0  OK

The chain this project exists to demonstrate, resolved from the returned edges alone:

    Cooling_Tower_1 -> CDW_Loop -> Chiller_1 -> CHW_Loop -> Cooling_Coil
                    -> Supply_Air_Fan -> Zone_3

Reconciled against the database rather than asserted: 107 distinct readings in the
topology, 107 rows in `app.points`, **nothing in the topology that is not in the
database and nothing in the database that is not in the topology**. Two nodes carry no
readings and no database asset, both water loops, which is correct — they are how the
model represents flow between machines, not machines.

Served over HTTP from a running server:

    status 200  bytes 27633
    nodes 31 edges 54 points 107 attachments 109
    Chiller_1: Chiller  asset chiller-1  parent Chilled_Water_System  points 9
      sample point: CHL_CD_FLOW_1 -> chiller-1.cdw_flow,
                    Supply_Condenser_Water_Flow_Sensor, meter**3/second
    Outdoor_Air_Damper: Outside_Damper  points 2

`uv run ruff check` passes on both changed packages.

START HERE: `model/twin.py` — the module docstring states why this cannot be served
from `app.asset_edges`, which is the decision the whole checkpoint rests on.


## Demo Phase 1, Checkpoint 1.2 — As-of truncation and bulk twin state

### What we did

Every screen can now be asked what it looked like at a chosen moment, and will answer
with only what was known then. Before this the API had one tense — the present — and
returned whatever was newest in the table, so a clock could not be moved without the
screen showing the ending. That is the difference between a recording and a replay,
and it is the whole illusion the demonstration rests on: the prediction interval has
to narrow while somebody watches, an advisory has to appear rather than always have
been there. Alongside it there is now a single call that returns every live number the
building drawing needs for one moment — every reading, how far each has drifted from
what it should be, and each machine's condition and remaining life — so a running
clock costs one request per tick rather than one per node.

### How it works

    api/main.py :: _vintage()
      WHY IT EXISTS: The advisory table now holds one complete queue per day. Asking
        for "the queue on 3 June" has to mean one of those queues, and the obvious
        reading is wrong.
      WHAT IT DOES: Finds the most recent day at or before the moment asked for on
        which a queue was computed, and returns that date. Callers then match on it
        exactly.
      CHOICES: NOT "every row whose window ends before this moment" -- that would pile
        six hundred days into one response and stand an advisory next to the one that
        superseded it.
      ⚠ JUDGEMENT CALL: It is bounded to forty-eight hours, and that bound was added
        after seeing what happened without it. A clock at 2038-09-20 came back with
        the queue computed on 2036-09-06 -- two years earlier, about different
        machines -- because the replay had not reached 2038 yet and "most recent at or
        before" walked backwards through the whole table. The runs in this database
        sit a whole year apart, so any bound between two days and a year behaves the
        same; two days was chosen because the replay writes daily and anything older
        than that is not a stale queue, it is a different building's afternoon.

    api/main.py :: the null-vintage filter
      WHY IT EXISTS: Fixing the leak above created a worse one, and the fix is worth
        recording because the shape of the mistake is common.
      WHAT IT DOES: The three queries match `window_to = vintage` with no "or the
        parameter is null" escape. A null vintage means no queue exists near that
        moment, so the comparison is never true and no rows come back.
      CHANGED FROM BEFORE: The first version wrote `vintage IS NULL OR window_to =
        vintage`, which is the usual way to make a filter optional. Here it meant that
        the moment the bound correctly found nothing, the filter switched itself off
        and served the entire history -- six hundred and seventy-seven advisories for
        a date that should have had none. Absent and unfiltered are not the same
        thing, and SQL's null propagation already expresses the difference.

    api/main.py :: /advisories, /advisories/summary, /assets/{id}/rul, /assets/{id}/health
      WHY IT EXISTS: These are what the dashboard reads. Each had no way to be asked
        about a past moment.
      WHAT IT DOES: Each takes an as-of moment. The queue and the site summary serve
        one day's queue; the remaining-life series returns only estimates published at
        or before that moment, so the fan chart draws itself as the clock advances
        instead of arriving complete; the health series truncates at the same edge.
      CHOICES: With no moment given, behaviour is unchanged -- the newest queue, the
        whole series. Existing callers and the current dashboard keep working.

    api/main.py :: GET /twin/state
      WHY IT EXISTS: A dashboard with a running clock asks for this on every tick.
        Thirty-one nodes and a hundred and seven readings at one request each is
        thirty-one round trips per frame.
      WHAT IT DOES: Four queries and one count, assembled into one response. For every
        reading: its value and when it was taken, and where a baseline exists, what the
        reading should have been, how far off it is, and how far off that is in units
        of its own normal spread. For every machine: its health, which failure mode is
        worst, the remaining life of whichever mode runs out soonest, and how many
        advisories are open. Each query takes the most recent row at or before the
        moment and rejects anything older than a staleness bound.
      CHOICES: The staleness bound exists for the same reason the vintage bound does.
        Without it a machine that stopped reporting in 2036 reads as live in 2039,
        frozen at its last value. Twenty-four hours for readings, which are hourly;
        forty-eight for health and remaining life, which are daily -- a clock at
        00:30 is already past a row written at the previous midnight, and a
        twenty-four hour bound would drop it. Checked: a moment with no data anywhere
        near it returns zero points rather than the last thing in the table.
      CHOICES: One remaining life per machine, from the mode predicted to fail
        soonest. A node shows one number and it should be the one that runs out first.

    api/models.py :: TwinPointState.observed and .residual_at
      WHY IT EXISTS: Caught by reading the response rather than by a check. The
        drifting chiller came back with a value of 49,069 W and an expectation of
        37,077 W, which subtract to 11,992 -- while the residual field said 16,994.
      WHAT IT DOES: Carries the raw sample the residual was actually computed from,
        and the instant it belongs to, next to the expectation and the residual.
      CHANGED FROM BEFORE: The two numbers disagreed because they come from different
        places: the value is an hourly AVERAGE from the rollup, and the residual is
        computed from one five-minute sample. Neither is wrong and the pair is
        misleading, because a caller would reasonably subtract one from the other.
        Now the triple observed-expected-residual agrees with itself exactly, the
        hourly value stands separately as the number to display, and both carry their
        own timestamp.

    api/models.py :: TwinState.points_with_baseline
      WHY IT EXISTS: Only six of a hundred and seven readings have a fitted baseline,
        so the deviation number that would colour a node exists for almost none of
        them. That is a real property of this system -- baselines were fitted where a
        residual drives a detection rule and nowhere else -- and it decides what the
        drawing can show.
      WHAT IT DOES: Reports how many of the reporting readings carry an expectation,
        beside how many are reporting at all.
      CHOICES: Reported rather than worked around. The alternative was to invent a
        second deviation measure for the other hundred readings -- a z-score against
        some quiet period -- which would have been a new statistical quantity nobody
        asked for, weaker than the condition-normalised residual, and easy to mistake
        for it on a screen. The coverage gap is a decision for the next checkpoint to
        take deliberately, with the number in front of it.

### Verification

The queue moves with the clock, which is the property the demonstration needs:

    as_of 2036-04-15: vintage 2036-04-15   2 advisories  [coil-valve-leak-by, fan-bearing-degradation]
    as_of 2036-06-20: vintage 2036-06-20   4 advisories  [+ chiller-efficiency-loss x2]
    as_of 2036-08-02: vintage 2036-08-02   7 advisories  [+ chiller-condenser-fouling]
    as_of 2038-09-20: vintage None         0 advisories  (replay has not reached 2038)

Nothing after the moment asked for is ever served:

    vintages later than their as_of                    : 0   OK
    remaining-life estimates published after as_of      : 0   at every moment tested
    points reporting at 2042-01-01, where no data exists: 0   OK

Twin state over HTTP, 14.6 KB for the whole building:

    as_of 2036-08-02  vintage 2036-08-02  77 points reporting, 2 with baseline
      chiller-1.power  value 49069.0 W (hourly)  observed 54070.5  expected 37076.9
                       residual 16993.6  sigma 2.49  self-consistent: True
      chiller-1        health 0  weakest chiller-efficiency-loss  rul_p50 0.0  4 open

    as_of 2039-07-01 (the clean run)  107 points reporting, 6 with baseline
      health  ahu-1 98, chiller-1 97, chiller-2 99   rul_p50  chiller-2 229.2

`uv run ruff check` passes.

### Carried forward

Six of 107 readings have a modelled expectation, so on the evidence available a
building drawing coloured by deviation would colour four nodes. Deciding what the
other twenty-seven show is checkpoint 1.7's problem and it now has a number attached.

START HERE: `api/main.py` — `_vintage()` and the comment above the filter it feeds.
Both bugs found in this checkpoint were the same bug in different clothes: a lookup
that walks backwards further than the data means anything, and a filter that turns
itself off when it finds nothing.


## Demo Phase 1, Checkpoint 1.4 — Engine trace funnel

### What we did

The system can now show what it decided NOT to do. Every table in this project until
now recorded a conclusion — this machine is at 63, that fault will cross its threshold
in 32 days — and none of them recorded the far larger number of moments where the
system looked at the building and declined to say anything. That is not an omission
worth filling for tidiness: it is where a fault detection system actually earns its
keep. These programmes do not die in the field by missing faults, they die by
interrupting an operator until nobody opens the screen again. This project raises one
false finding per 604 healthy machine-days, and the reason turns out not to be a
cleverer detector — it is ten successive refusals to judge, none of which were visible
anywhere. They are now a table, one funnel per machine per day.

### How it works

    scripts/schema.sql :: app.engine_trace
      WHY IT EXISTS: Somewhere to record how a conclusion was reached rather than what
        it was, at a granularity a screen can show.
      WHAT IT DOES: One row per machine per day per stage: how many things arrived,
        how many got through, a reason-to-count map for everything that did not, and
        stage-specific evidence. Keyed so a rerun of one day corrects that day.
      CHOICES: `unit` is a stored column, not a comment, because the funnel counts a
        different KIND of thing at five points down its length -- readings, then rule
        evaluations, then points, then failure modes, then findings. A picture that
        ran one bar smoothly into the next would be claiming that 702,000 readings
        become 2 findings by attrition. They do not: they become 2 findings by being
        aggregated into a different kind of object, and the drawing has to break the
        bar where the kind changes.
      CHOICES: A check that `passed <= entered`. It caught a real error within an hour
        of being written -- see the class closure entry below.

    analytics/trace/funnel.py :: rule_stages()
      WHY IT EXISTS: Stages 1 to 6, the detection half, which is the part no table
        already holds.
      WHAT IT DOES: Runs the rule engine once over the window and counts its own
        verdicts. Every sample the building reported; every instant where rules were
        allowed to run at all; every rule-and-instant pair attempted; how many of
        those had readings anybody trusts; how many said something was wrong; and how
        many of those held long enough to count as a fault rather than a gust.
      CHOICES: The engine is run, not re-implemented. No threshold is re-derived and
        no category is invented here -- the drop reasons are the rule engine's own
        status values and the suppression gate's own conditions. A trace that
        recomputed its subject could disagree with it, and then which one is the
        system?
      ⚠ JUDGEMENT CALL: Suppression reasons are attributed to the FIRST condition that
        bites, in the order the gate applies them, rather than counting an instant
        under every condition it fails. An instant during an unoccupied night also has
        zero minutes since the machine started, so counting both would make the
        reasons sum to more than the number suppressed and the funnel would not
        balance. The cost is that the reasons are not independently meaningful: "1,224
        settling since start" means 1,224 that were not already idle.

    analytics/trace/funnel.py :: configured_modes()
      WHY IT EXISTS: Stage 8 asks how many failure modes are declared for a machine
        against how many have been confirmed as degrading. Getting the first number
        needs the machine's equipment class, and the obvious way is wrong.
      WHAT IT DOES: Expands the machine's class to everything Brick considers
        equivalent or more general, then finds every failure mode registered against
        any of them.
      ⚠ JUDGEMENT CALL: The first version joined the two tables on the class name.
        `app.assets` calls the air handler `brick:AHU`; `app.failure_modes` registers
        its three modes against `brick:Air_Handling_Unit`; Brick declares those
        equivalent and a string comparison finds nothing. The trace reported ZERO
        modes declared beside TWO confirmed, which is both a false number and
        impossible -- and the table's own check on it refused the row rather than
        storing the contradiction. The fix reuses the class closure the rule registry
        already dispatches on, so the trace and the engine now agree about what
        applies to a machine by construction rather than by coincidence. The chiller
        had been matching by luck: both tables happen to spell it `brick:Chiller`.

    analytics/trace/funnel.py :: stored_stages()
      WHY IT EXISTS: Stages 7 to 10 describe layers that already persist their own
        conclusions, so tracing them is a query rather than a re-run.
      WHAT IT DOES: How many of the machine's readings have a fitted expectation to be
        compared against; how many failure modes are past the changepoint that lets a
        trend be projected; how many of those the remaining-life model would put a
        bound on rather than refusing; and how many findings reached the operator.
      CHOICES: Read rather than recomputed on purpose. Re-running the remaining-life
        fit to describe it would risk describing something the dashboard is not
        showing.
      ⚠ JUDGEMENT CALL: Demotion is recorded in the evidence and is NOT counted as a
        drop. A consequential advisory is still on the operator's screen, ranked below
        the fault it was blamed on -- that distinction is the entire design of the
        cross-asset layer, and a funnel that counted it as suppression would misreport
        the one thing that layer exists to get right.

    scripts/run_engine_trace.py :: trace_day() and the candidate count
      WHY IT EXISTS: Joins the two halves for one machine on one day.
      WHAT IT DOES: Picks the right idle state and rule set for the machine -- an air
        handler is idle when the building is empty, a chiller when it is not running,
        and the same settling machinery applies to both -- runs the detection stages,
        then reads the stored ones.
      CHANGED FROM BEFORE: The number of candidates handed to the last stage was the
        count of sustained EPISODES, and that made stage 10 read "18 candidates, 4
        advisories, 14 raised nothing". Nine separate stretches of the same saturated
        valve are deliberately one thing an operator disposes of, and the rule layer
        collapses them before an advisory is built. Counting episodes described that
        collapse as a rejection. It now counts one candidate per rule, and the stage
        balances exactly: 2 rules reporting plus 2 modes with a bounded prediction,
        4 advisories, nothing unexplained.

    scripts/run_engine_trace.py :: the driver
      WHY IT EXISTS: Populates the table across every era.
      WHAT IT DOES: Walks each era day by day, four machines a day, using the same
        reading cache the advisory replay uses -- consecutive windows overlap by about
        99% and fetching them again is two thirds of the runtime.
      ⚠ JUDGEMENT CALL: This is a SEPARATE PASS from the advisory replay and it should
        not be. Both walk the same days over the same windows and both run the same
        rules, so emitting the trace from inside the replay loop would have cost
        nothing. The replay was already running against the database when this was
        written and restarting it would have discarded the days it had finished. The
        module docstring records the trade and says what to do instead if these are
        ever rebuilt from empty.
      CHOICES: It has to run AFTER the advisory replay, because its last stage reports
        which findings reached the operator and reads the advisory table to do it. Run
        first, it would record zero advisories on every day and look like a system
        that detects nothing. The Makefile comment says so.

### Verification

The funnel, on a chiller in the middle of its condenser fouling run:

    chiller-1  2036-07-31
    #  stage                  unit           in       out   dropped
    1  readings               readings   211,896   211,896
    2  evaluable instants     instants    23,544    16,956   idle 2,816; settling since start 3,772
    3  rule evaluations       evaluations 50,868    50,868
    4  inputs trusted         evaluations 50,868    41,620   reading not trusted 9,248
    5  rule fired             evaluations 41,620     2,718   nothing wrong at this instant 38,902
    6  sustained              firings      2,718     2,368   held under 60 min, not a fault 350
    7  baseline coverage      points           9         2   no baseline fitted 7
    8  degradation confirmed  modes            3         2   no changepoint yet 1
    9  prediction published   modes            2         2
    10 advisory raised        findings         4         4

CORRECTED after checkpoint 1.8. Stages 3 and 4 above were first written as 50,868 ->
41,620 at stage 3 for "rule does not apply in this operating mode", with stage 4 passing
everything through. That was wrong, and wrong in a way worth recording: at the time only
stages 2, 5, 6, 8 and 10 had been queried, and 3 and 4 were INFERRED from them rather
than read. The 9,248 is real but it is dropped one stage later and for a different
reason -- the quality layer refusing readings it does not trust, not a rule declining to
apply. Misattributing one suppression mechanism to another is exactly the error this
screen exists to make impossible, so it is corrected here rather than quietly.

And the same day on the chiller that barely runs, which is the whole argument in one
row: 24,120 instants, 23,780 of them idle, 169 evaluable, 507 rule evaluations, none
fired. A system counting idle days as days it correctly found nothing wrong would have
banked 23,780 free successes.

Stage 10 balances exactly on every machine, with no unexplained candidates:

    ahu-1      2 candidates (0 rules reporting + 2 bounded modes)  -> 2 advisories
    chiller-1  4 candidates (2 rules reporting + 2 bounded modes)  -> 4 advisories
    chiller-2  1 candidate  (0 rules reporting + 1 bounded mode)   -> 1 advisory
    chiller-3  0 candidates                                        -> 0 advisories

Written and read back: 120 rows for three days, four machines, ten stages each, with
the table's `passed <= entered` check enforcing that nothing passes a stage it never
entered. `uv run ruff check` passes.

### Not yet done

The table holds four days. Populating all 619 has to wait for the advisory replay to
finish, because stage 10 reads the queue that replay is still writing -- traced now,
every day past the replay's frontier would record zero advisories. `make engine-trace`
is resumable and takes roughly the same time as the replay.

START HERE: `analytics/trace/funnel.py` — the module docstring lists the ten stages and
says why the unit changes, which is the one thing a caller has to understand before
drawing this. (Corrected in 1.8: it changes six times, not three. Seven kinds of thing
are counted down ten stages.)


## Demo Phase 1, Checkpoint 1.5 — Reveal service

### What we did

The demonstration can now show the answer. Until this checkpoint the record of what was
actually wrong with the building — which fault was put into which machine, when, and how
bad it got — was readable by exactly one thing, the offline scoring harness, and there
was no way to put it on a screen next to what the system had worked out for itself. That
comparison is the point of the demonstration: a number the engine produced is only
interesting beside the number it was trying to find. The system can also now say, for
each injected fault, the order in which it showed up in the machine's own instruments —
on the fouled chiller, the compressor draws more power fifty days before the machine
starts failing to hold its water temperatures, and that ordering is the fault's
signature rather than a claim about it.

### How it works

    reveal/__init__.py :: the package boundary
      WHY IT EXISTS: To record a decision that is invisible in the code and easy to
        undo by accident.
      WHAT IT DOES: States that this is a second application on a second credential,
        and why it is not three more routes on the existing API. The dashboard needs
        both sides of the line on one screen; adding the routes to `api/` would put the
        answer key inside the process that serves detections, and the separation would
        then rest on nobody adding the wrong import.
      ⚠ JUDGEMENT CALL: A second process is more to run and more to deploy than three
        routes. It is worth it because the alternative quietly converts an enforced
        property into a convention, and this project's accuracy claims all rest on that
        property.

    reveal/db.py :: admin_dsn()
      WHY IT EXISTS: The privileged credential, in one place.
      WHAT IT DOES: Reads the admin connection string and strips the driver prefix
        psycopg does not accept.
      CHOICES: Deliberately identical to the resolution in the validation harness.
        These two are the only callers in the repository and a divergence between them
        would be a security-relevant difference discovered by accident.

    reveal/main.py :: GET /reveal/scenarios
      WHY IT EXISTS: The whole answer key, for the configuration screen.
      WHAT IT DOES: Every run, the fault put into it, the machine it went into, when it
        started, when it reached failure, and the ladder of measured severities the
        trajectory walks between.

    reveal/main.py :: GET /reveal/at
      WHY IT EXISTS: What the reveal button on the dashboard calls.
      WHAT IT DOES: Splits every fault three ways against the moment asked for: running
        now, not injected yet, already past failure.
      CHOICES: Split rather than filtered. "Nothing was injected yet" and "it had
        already reached failure" are different answers, and a screen showing an empty
        list for both would hide the more interesting one. At 2 August 2036 the answer
        is one fault running, one already failed and four not yet injected — which is a
        far better thing to show than one row.

    reveal/cascade.py :: compute()
      WHY IT EXISTS: To answer which instrument moved first and what followed it.
      WHAT IT DOES: Every run reads the same 2018 source year shifted by whole years, so
        a faulted run and a fault-free run share weather, occupancy and control
        decisions day for day. Subtracting one from the other on matching days leaves
        only the fault. Each reading is then compared against how much it normally moves
        from one day to the next in the clean run, and the order in which readings cross
        that is the cascade.
      CHOICES: The threshold is one normal day's movement, held for three days. Low on
        purpose: this is not a detector and is scored against nothing. It describes what
        the fault did, and the interesting output is the ORDER — a higher bar compresses
        it by pushing every reading past the line on the same late day.
      ⚠ JUDGEMENT CALL: Restricted to the faulted machine's own readings. The first
        version looked at every point in the era and produced nonsense: for the fouled
        chiller of 2036 the earliest "divergences" were all on the AIR HANDLER, dated
        one day BEFORE the chiller fault was injected — because that era also contains a
        leaking coil valve, and the comparison was reporting somebody else's fault.
        Cross-asset cascade cannot be measured this way while two faults share an era,
        and claiming it anyway would have put a confident wrong answer on the screen.
      CHANGED FROM BEFORE: The first two attempts at the scale were both wrong and the
        way they failed is worth keeping. Normalising by the clean run's spread over the
        whole window found nothing at all: that spread is dominated by the change of
        season, and a fault's effect disappears against it. Normalising by the spread of
        the pre-injection DIFFERENCE found everything on day one: before injection the
        difference is not small, it is exactly zero on 77 of 104 points, so any
        movement afterwards is infinitely many standard deviations. That zero is
        actually the strongest evidence in this checkpoint that the calendar twin holds
        — it just cannot be used as a denominator.

    reveal/main.py :: _cascade_cached()
      WHY IT EXISTS: A cascade takes about three seconds and none of them changes.
      CHOICES: Cached in the process rather than stored in a table. Six of them, static
        for the life of the run — a table would mean a migration and a driver for what a
        dictionary does.

    README.md and ARCHITECTURE.md :: the separation claim
      WHY IT EXISTS: The old wording became an overclaim the moment this service existed.
      CHANGED FROM BEFORE: It said the answer key was reachable by exactly one module in
        the repository. There are now two, and one of them is a running web service.
        Both documents now say what is actually true and still strong: the detection path
        connects as a role with **no grant of any kind** on that schema, an endpoint that
        asked for a label fails with permission denied, and the two components that can
        read it — the validation harness and this service — compute nothing. Weaker than
        the old sentence, and the true one.

### Verification

The answer key, served:

    6 injected faults, 2 clean runs
      ahu_cooling_valve_leakage     ahu-1        progressive  1 rung  -> leaking (single measured severity)
      chiller_condenser_fouling     chiller-1    progressive  2 rungs -> 65% heat transfer retained
      ahu_oa_damper_stuck           ahu-1        step         3 rungs -> stuck at 75% open
      chiller_bypass_valve_leakage  chw-plant-1  progressive  3 rungs -> 75% bypass leakage
      cooling_tower_fouling         ct-1         progressive  3 rungs -> 65% heat transfer retained
      ahu_sat_sensor_drift          ahu-1        progressive  2 rungs -> +4F sensor bias

At one moment, split three ways:

    as_of 2036-08-02
      active            [chiller_condenser_fouling]
      already_failed    [ahu_cooling_valve_leakage]
      not_yet_injected  [ahu_oa_damper_stuck, chiller_bypass_valve_leakage,
                         cooling_tower_fouling, ahu_sat_sensor_drift]

The cascade on the fouled chiller, compared against the clean run three years later over
120 days and nine instruments:

    2036-07-20  +50d  chiller-1.power              peak 3.47 x its normal daily movement
    2036-07-25  +55d  chiller-1.compressor_cmd     peak 2.72
    2036-08-04  +65d  chiller-1.chw_return_temp    peak 2.48
    2036-08-04  +65d  chiller-1.chw_supply_temp    peak 2.03

That order is the physics: a fouled condenser makes the compressor work harder, the
controller asks for more, and only fifteen days later does the machine start failing to
deliver the water temperature it was asked for. The same computation on the drifting
supply air sensor gives fan powers at 31 days, the chilled water valve at 55, and the
zone temperatures at 73 — a control loop over-cooling the building long before anybody
in it would notice.

The separation still holds, checked rather than asserted:

    app_rw reaching for groundtruth.fault_events
      -> permission denied for schema groundtruth

`uv run ruff check` passes on the new package.

START HERE: `reveal/cascade.py` — the module docstring records two wrong ways of
measuring divergence before the one that works, and the reason the second failed is the
single best piece of evidence that the scenarios were built correctly.


## Demo Phase 1, Checkpoint 1.6 — The clock and the control bar

### What we did

The dashboard has a moment now, and it can be moved. Until this checkpoint every screen
showed whatever was newest in the database and there was no way to ask what any of it
looked like a week earlier — so the most convincing thing this system can demonstrate,
a prediction interval closing while somebody watches, could not be shown at all. There
is now one clock, shared by every screen, which can be dragged, stepped a day or a week
at a time, or played forward at up to ten simulated days a second. Moving it refetches
what the operator would have seen that morning and nothing else. It can also be sent
straight to a chosen fault, or to a chosen rung of that fault's severity ladder,
without anybody having to know what date that was.

### How it works

    api/main.py :: GET /clock/eras
      WHY IT EXISTS: The clock has to know which stretches of time this database holds.
        It must not learn that from the scenario manifests, which carry each fault's
        injection date -- exactly what the operator view is forbidden to know.
      WHAT IT DOES: Reads the health history, which records only which days this project
        computed something for, and returns one entry per calendar year with its span,
        its machines and how many of its days have an advisory queue.
      CHOICES: `queue_days` is reported separately from `days` and is smaller. That is
        not a gap: a day on which nothing was open produces no rows, and an empty queue
        is what a healthy building looks like. Reported so a scrubber can mark which
        days have something to show without treating the rest as missing data.

    web/src/lib/clock.ts :: the whole module
      WHY IT EXISTS: This decides which moment every screen renders, so a mistake here
        is a mistake on every screen at once -- and an invisible one, because the
        dashboard would simply be showing a different day than it says.
      WHAT IT DOES: Pure functions over plain values. Which run a moment falls in,
        how far through it, the moment at a given position, the twenty-four hourly
        marks of a day, and where on the clock a given severity rung sits.
      CHOICES: No React and no fetching anywhere in it, so all of it can be checked in
        a terminal. That is the same reason the schematic's geometry lives in its own
        module.
      ⚠ JUDGEMENT CALL: Stepping does NOT roll from the end of one run into the start
        of the next. The runs here are separate simulations of the same building placed
        years apart, and a clock that rolled would show the queue emptying and refilling
        with different machines for no reason a viewer could see. It stops at the edge
        and tells the caller, which is what stops the play button sitting there
        incrementing nothing.

    web/src/lib/clock.ts :: clampToEra()
      WHY IT EXISTS: The runs are separated by whole years of nothing.
      WHAT IT DOES: A moment outside every run is pulled to the nearest edge of the
        nearest run.
      CHOICES: A clock left in one of those gaps shows a building with no readings, no
        health and no queue, which reads as a broken dashboard rather than as an empty
        stretch of calendar. Checked both directions: a date in 2035 lands on
        2036-02-25 and one in 2045 lands on 2039-09-23.

    web/src/lib/clock.ts :: momentAtSeverity()
      WHY IT EXISTS: The severity selector.
      WHAT IT DOES: Each scenario walks its whole ladder once, from healthy to its worst
        measured rung, so "show me this fault at severity 3" means "put the clock where
        this trajectory reached rung 3". Returns the MIDPOINT of the rung, not its start
        -- the start is the instant the trajectory crosses in, where the difference from
        the rung below is still nothing.
      ⚠ JUDGEMENT CALL: Severity is a position on the clock rather than a separate
        dataset. The alternative was holding each rung as its own precomputed run, which
        would multiply the data by the ladder length AND leave nothing downstream a
        history to fit a trend to, because a fault held at a fixed severity never
        degrades. The cost is that a rung cannot be viewed in isolation from the
        trajectory that reaches it, which for this demonstration is the right way round.

    web/src/components/ControlBar.tsx
      WHY IT EXISTS: The clock, and everything that moves it, in one place on every
        screen -- which is what stops the queue and the building drawing disagreeing
        about what day it is.
      WHAT IT DOES: Play and pause, four speeds, a day scrubber, week and day nudges, a
        run selector, and -- when the reveal service is up -- a jump-to-fault list and
        clickable severity rungs for whatever is running at that moment.
      CHOICES: The scrubber moves in days because everything it drives is computed once
        a day; a finer control would slide without changing anything on screen, which
        teaches a viewer that the control does nothing.
      CHOICES: Jumping to a fault lands one day BEFORE it was injected. The interesting
        thing to watch is the system not knowing yet, and landing on the onset skips it.
      ⚠ JUDGEMENT CALL: The answer key is optional and its absence is not an error. The
        bar works in dates alone when the reveal service is not running, and says so.
        Anything sourced from the answer key carries a marker every time it appears, so
        a viewer never has to wonder whether a number on screen is what the system
        worked out or what it was trying to find.

    web/src/App.tsx :: the two effects
      WHY IT EXISTS: Dragging a scrubber must not refetch the whole building.
      WHAT IT DOES: One load on mount for the things that do not depend on the moment --
        the era range, the asset list, the graph traversal, the answer key. A second,
        separate effect refetches only the queue and the site summary when the clock
        moves, and cancels itself if the clock moves again first.
      CHOICES: The clock starts at the END of the first run rather than its beginning.
        A run opens with three weeks of healthy commissioning data, so starting there
        would open the dashboard on an empty queue and look broken.

    web/scripts/verify-clock.ts
      WHY IT EXISTS: To check the above against the real database without a browser,
        the same way the queue, the fan chart and the schematic are already checked.
      WHAT IT DOES: Fetches the real era range and asserts every property that has to
        hold, then fetches the real answer key and checks each fault's rungs land in
        order, inside that fault's own life, on days the clock can stand at.

### Verification

    the clock can stand in 4 runs
      2036  2036-02-25 .. 2036-09-06  195d  3 machines  173 days with a queue
      2037  2037-01-27 .. 2037-06-25  150d  3 machines  139 days with a queue
      2038  2038-05-10 .. 2038-09-23  137d  3 machines  133 days with a queue
      2039  2039-05-10 .. 2039-09-23  137d  3 machines   92 days with a queue

Twenty-seven properties of the clock itself, all holding: every run reachable from both
edges, every day count agreeing with its own dates, the scrubber round-tripping, and
stepping thirty days past either edge of every run stopping exactly at that edge rather
than leaving it. A date in 2035 clamps to 2036-02-25 and one in 2045 to 2039-09-23.

Severity as a clock position, checked against the real answer key:

    ahu_cooling_valve_leakage      1 rung   04-08
    chiller_condenser_fouling      2 rungs  06-17 07-22
    ahu_oa_damper_stuck            3 rungs  02-17 02-17 02-17
    chiller_bypass_valve_leakage   3 rungs  06-05 06-15 06-25
    cooling_tower_fouling          3 rungs  06-10 06-30 07-20
    ahu_sat_sensor_drift           2 rungs  07-09 08-23

Every one lands in order, inside its own fault's life, on a day the clock can stand at.
The three identical dates on the damper are correct and are the step fault: it jumps
straight to its worst rung at injection rather than walking there, so all three rungs
are the same instant.

`npx tsc --noEmit` clean; `uv run ruff check` clean.

### One thing found by running it

The reveal service was written on port 8001 and would not start: something unrelated
already holds that port on this machine, behind a docker proxy. It now runs on 8002,
and the Makefile records why. A demonstration that fails to open because an unrelated
service holds a common port is a bad way to start a meeting, and 8001 is a common port.

START HERE: `web/src/lib/clock.ts` — every screen's notion of "now" comes from this
file, and the two judgement calls in it (not rolling between runs, severity as a
position) are the ones that decide how the demonstration reads.


## Demo Phase 1, Checkpoint 1.7a — Router and navigation shell

### What we did

Every screen in this dashboard now has an address. Before this the one nested view —
an opened advisory — was a flag in memory, so nobody could send a colleague a link to
the fault they were talking about, and a demonstration paused halfway could not be
resumed anywhere except the top. That limitation was recorded in three documents as
something worth fixing, and Phase 1 adds five more screens, which would have meant five
more things reachable only by clicking in the right order. The dashboard is now a shell
holding the clock and the navigation, with each screen underneath it as a plain
component and a real path.

### How it works

    web/src/main.tsx :: BrowserRouter
      WHY IT EXISTS: Real paths rather than fragments.
      CHOICES: BrowserRouter and not HashRouter, so a deployment serves /twin directly
        and a pasted link has no # in it. The cost is that whatever serves the built
        files must fall back to index.html on an unknown path. Checked rather than
        assumed -- see below.

    web/src/App.tsx :: the shell
      WHY IT EXISTS: Every screen shows one moment and they must all show the SAME
        moment.
      WHAT IT DOES: Holds the clock, the navigation, the error state and the two
        fetches, and renders whichever screen the path names underneath.
      CHANGED FROM BEFORE: It used to BE the operations screen. The clock living in
        the shell rather than in a screen is what makes navigation non-destructive:
        open an advisory, come back, and the day has not jumped. It also means no
        screen added later can grow its own copy of the clock, which is the failure
        this split exists to prevent.
      CHANGED FROM BEFORE: The comment explaining why there was no router is deleted,
        because it stopped being true. It argued a router was "a dependency and a build
        step for a screen with exactly two states" -- correct when there were two, and
        the reason it names for adding one, that an operator cannot paste a colleague
        an advisory, is exactly what changed.

    web/src/App.tsx :: AdvisoryRoute
      WHY IT EXISTS: The advisory detail reads its id from the path now.
      WHAT IT DOES: Takes the id from the URL, renders the existing detail component
        unchanged, and sends Back to the queue. A path with no id redirects rather than
        rendering an empty detail.

    web/src/screens/Operations.tsx
      WHY IT EXISTS: The dashboard body, lifted out of the shell.
      WHAT IT DOES: The summary strip, the plant drawing and the queue, exactly as
        before, with selection navigating instead of setting a flag.
      CHOICES: Takes its data as props rather than fetching. The shell owns the fetches
        because two screens will want the same queue, and a screen that fetched its own
        would refetch on every navigation.

    web/src/components/NavTabs.tsx
      WHY IT EXISTS: The screen switcher.
      CHOICES: Real links, not buttons, because they are real URLs -- a demonstration
        can be paused mid-flow and the address pasted to somebody else.
      ⚠ JUDGEMENT CALL: Screens not yet built are listed and DISABLED rather than
        hidden. The shape of Phase 1 is then visible from the first screen, and no tab
        moves sideways when the next one lands -- a tab strip that grows during a
        series of demonstrations looks unrehearsed. The cost is five visible dead ends,
        each of which says so when opened.

    ARCHITECTURE.md and ROADMAP.md
      CHANGED FROM BEFORE: "A router in the frontend" was listed in the not-built table
        and as item 1.2 of the next section, described as blocking "the most basic
        collaborative act there is". Both entries are removed and the Shipped section
        records it, along with the clock, the daily advisory replay, the engine trace
        and the reveal service, which had all landed since the validation run and none
        of which the document mentioned.

### Verification

The production bundle built and served, and every path fetched over HTTP -- which is
the only check that matters here, because a router that works in the dev server and
404s on a deployment is the classic way this goes wrong:

    /                            http 200   serves the app: yes
    /twin                        http 200   serves the app: yes
    /engine                      http 200   serves the app: yes
    /advisory/some-advisory-id   http 200   serves the app: yes
    /nonsense                    http 200   serves the app: yes

`npx tsc --noEmit` clean, `npm run build` clean at 643 kB, `uv run ruff check .` clean.

### One planned change that turned out unnecessary

The plan called for a history-fallback setting in `vite.config.ts`. It is not needed:
both the dev server and `vite preview` already fall back to index.html, which the deep
links above prove. Recorded because a config entry nobody needs is worse than no entry
-- it implies something is being handled that is not.

START HERE: `web/src/App.tsx` — the shell, and the comment that used to argue against
this change sitting one commit back in the history of the same file.


## Demo Phase 1, Checkpoint 1.7b — The digital twin

### What we did

The building is now drawn as the model rather than as a summary of it. The picture it
replaces had eleven boxes, one per database asset, which is the level at which an air
handler is a single rectangle. This one draws thirty-one nodes — the cooling coil, both
fans, the dampers, both water loops, five occupied rooms — so the chain a fault actually
travels along, from a cooling tower on the roof to the people in Zone 3, is on the screen
instead of implied. Clicking any node lists the instruments on it with what each reads
now, what a fitted baseline expects it to read, and how far apart those are. Three
separate things are shown by colour at once, and kept separate: how the machine is
doing, how far its readings have drifted today, and what kind of fault it is.

### How it works

    web/src/lib/format.ts :: COLOURS, conditionBand, driftBand
      WHY IT EXISTS: The colour vocabulary, moved here when the twin replaced the
        schematic.
      CHANGED FROM BEFORE: It lived in lib/schematic.ts. That module already gave the
        reason for putting the health thresholds in format.ts -- so the queue and the
        drawing cannot disagree about what amber means -- and the same argument applies
        now that a second thing is drawn.
      CHOICES: conditionBand prefers remaining life and falls back to health. "Fails in
        three weeks" is a stronger statement than "scores 61", but the remaining-life
        model refuses to answer until a changepoint is confirmed, so filling only on
        remaining life would grey out machines whose condition is perfectly well known.
        Thresholds are 30 and 90 days: thirty is the shortest horizon a technician can
        be scheduled inside without disrupting other work, ninety matches the planning
        horizon every advisory's cost of inaction is already computed over.

    web/src/lib/twin-layout.ts :: columnsOf()
      WHY IT EXISTS: Where each node sits left to right.
      WHAT IT DOES: Longest path from the sources of the flow graph, so a node can never
        be drawn at or left of something that feeds it. Then one adjustment: a node that
        nothing feeds and that feeds exactly one thing is a source -- a pump, a tower, a
        valve -- and is placed immediately before what it feeds.
      CHOICES: Without that adjustment the chilled water pumps land in the same column
        as the cooling towers, three columns from the loop they push water into. True
        about graph depth, misleading about a building.
      ⚠ JUDGEMENT CALL: Computed rather than hand-placed. The schematic argued for hand
        placement so "an operator learns where the chiller is", and thirty-one hand-
        placed coordinate pairs would break the first time the model gained a node. The
        column comes from flow depth instead, which is deterministic and identical on
        every load -- which is the property that argument actually needs.

    web/src/lib/twin-layout.ts :: buildTwin()
      WHY IT EXISTS: Every number the drawing uses, computed outside the component so
        the picture can be rendered and checked without a browser.
      WHAT IT DOES: Places each node, works out its three colours, counts how many of
        its instruments are reporting, finds the worst drift among them, and builds the
        orthogonal polylines between them.
      ⚠ JUDGEMENT CALL: CONDITION IS FOR MACHINES ONLY, and this was wrong in the first
        version. Every one of the five occupied rooms maps to the same database asset as
        the air handler that serves them, because that is where their thermometers live
        -- so colouring by asset painted five rooms with the air handler's health and
        claimed the rooms were failing. A room is a space, not a machine, and has no
        condition of its own. The coil, the fans and the dampers DO take the air
        handler's condition, because they are the parts that machine is made of.
      CHOICES: Edges are orthogonal, not straight. Thirty diagonal lines crossing each
        other reads as a graph theory exercise; a building reads as plumbing.

    web/src/components/DigitalTwin.tsx
      WHY IT EXISTS: Shapes and text.
      CHOICES: Every colour is a fill or stroke attribute rather than a CSS class, which
        is what lets the verification write a standalone SVG that opens correctly on its
        own. A class-styled drawing would arrive there colourless.
      CHOICES: A thick border means drift is being measured on that node; a thin one is
        the node's own outline and claims nothing. The distinction is in the legend,
        because "no border" and "border showing no drift" are different statements and
        the second one is much rarer here than the first.
      CHOICES: The coverage sentence is printed ON the drawing rather than in a
        footnote. A picture where most nodes are grey has to say why, or it reads as a
        broken feed.

    web/src/components/NodeInspector.tsx
      WHY IT EXISTS: A node is not a coloured box, it is a set of named instruments.
      WHAT IT DOES: Lists every reading on the node with its current hourly value, the
        raw five-minute sample, what a baseline expected, the drift between them, and
        the unit.
      ⚠ JUDGEMENT CALL: Three numeric columns where a simpler panel would show one. The
        hourly average and the sample are genuinely different numbers taken at different
        instants -- the residual is computed from the sample -- so a panel showing only
        the average next to the expectation would invite subtracting one from the other
        and getting a third answer that is not the drift. The note under the table says
        so in one sentence.
      CHOICES: A refused remaining life is printed as a refusal, not left blank.

    web/scripts/verify-twin.ts
      WHY IT EXISTS: Replaces verify-schematic.ts for the reason that one gave: an SVG
        is text, so this is the one visual in the project that can be verified rather
        than described.
      WHAT IT DOES: Renders the real component against the live API and checks the
        things a drawing of a building can actually get wrong -- a node left of
        something that feeds it, two boxes overlapping, an edge pointing at a node that
        was not drawn, a colour claiming knowledge the data does not support -- then
        writes docs/plots/digital_twin.svg.
      CHANGED FROM BEFORE: It first tested the last day of the first run, which is past
        the END of that run's air-side scenario, so only the chillers were reporting and
        the picture under test was emptier than the one a demonstration shows. It now
        finds the busiest day in the database by asking, rather than assuming one.

### Verification

    the building at 2037-06-16
      31 nodes in the model, 31 drawn, 30 flow edges
      79 readings reporting, 1 node able to show drift

      ok  no node is drawn at or left of something it feeds
      ok  every drawn edge joins two drawn nodes
      ok  no two boxes overlap                             0 pairs
      ok  every box is inside the canvas
      ok  no node shows drift without a measured sigma
      ok  the chilled water path is lit only when something is blamed on a chiller
      ok  no node is coloured as scored without a health or a remaining life
      ok  all 7 nodes of tower-to-zone are drawn
      ok  and they run left to right in order
          Cooling_Tower_1@0 CDW_Loop@1 Chiller_1@2 CHW_Loop@3
          Cooling_Coil@4 Supply_Air_Fan@5 Zone_3@6
      ok  the component rendered an svg

    wrote docs/plots/digital_twin.svg (15,907 bytes)

`npx tsc --noEmit` clean, `npm run build` clean, `npm run verify` (the queue) still
passes unchanged, `uv run ruff check .` clean.

### How much of the picture is actually coloured, corrected

The plan was written expecting four of thirty-one nodes to carry colour. Measured, it is
fewer, and the reason is the shape of the database rather than anything in the drawing:

    fill (condition)   2 of 31 at a typical moment — the machines with a scored history
                       in whichever run the clock is standing in
    border (drift)     1 of 31 — six readings in this building have a fitted baseline,
                       and at any one instant only the ones inside the current run report

At 2037-06-16 both readings carrying a drift figure belong to the same machine, which is
why one node shows a border rather than two. This database holds four separate runs
placed years apart, so at any single moment only the one or two scenarios live in that
run have health, remaining life or residuals at all. The other machines are not missing
data; they are genuinely not running in that year.

That is a real limit on how much the twin can say, it is printed on the drawing itself,
and it is the coverage boundary this project has been explicit about since the baselines
were fitted. It also means the twin is at its most informative when the clock is inside a
faulted run — which is where a demonstration puts it.

START HERE: `docs/plots/digital_twin.svg` — open it. It is the rendered output of the
real component against real data, not a description of one.


## Demo Phase 1, Checkpoint 1.8 — The engine trace screen

### What we did

The dashboard can now show the argument this project's headline number rests on. It
raises one false finding per 604 healthy machine-days, and until this screen the only
way to believe that was to read it in a document. The screen shows the pipeline as ten
narrowings on one machine on one day, each with a count and the engine's own reason for
everything it threw away — and beside it, the same machine on the same day of the year
with nothing wrong. On a faulted chiller the rules fire 2,255 times and 1,967 of those
firings survive the persistence test. On the healthy twin, in the same weather, they
fire 11 times and **not one survives**. That contrast is the false-alarm story stated as
a measurement rather than a claim.

### How it works

    api/main.py :: GET /engine/trace
      WHY IT EXISTS: Checkpoint 1.4 built the table and the driver that fills it, and
        nothing served it. This is that endpoint.
      WHAT IT DOES: Returns one machine's ten stages for one day, and alongside them the
        same machine on the same day of the year in the fault-free run.
      CHOICES: The counterpart is returned WITH the trace rather than fetched separately.
        Every run in this database reads the same source year shifted by whole years, so
        the same calendar day in the clean run is the same weather, the same occupancy
        and the same control decisions with nothing wrong. Without that column a viewer
        sees a funnel narrowing and has nothing to judge it against.
      CHOICES: A missing trace is a 404 saying why -- a machine with no readings that day
        has no row, which is a fact about the run rather than a gap in the table.

    web/src/components/Funnel.tsx
      WHY IT EXISTS: Ten stages, their counts, their drop reasons and the clean
        comparison, in one readable column.
      CHOICES: The bars are LOGARITHMIC. The first stage counts about 235,000 readings
        and the last counts four findings; on a linear scale every bar after the second
        is one pixel, which would say the pipeline throws everything away at once --
        the opposite of what it does.
      CHOICES: The bar BREAKS where the unit changes, with a line saying what is now
        being counted. A continuous taper would claim 235,000 readings turn into four
        findings by attrition. They do not: they turn into four findings by being
        aggregated into a different kind of object.
      CHOICES: Zero-valued drop reasons are filtered out. A stage can carry a reason
        that did not bite on a particular day, and printing "0" beside it invites the
        reader to wonder what they are looking at.
      CHOICES: A stage that passed nothing draws a bar in a different colour rather than
        no bar. An absent bar reads as a rendering fault; this is a result.

    web/src/components/StageDetail.tsx
      WHY IT EXISTS: One stage opened.
      WHAT IT DOES: What it was given, the percentage that got through, what the clean
        twin did with the same stage, every drop reason with its count, and the evidence
        the layer recorded while running -- which rules were evaluated, which failure
        modes are past their changepoint, which readings have a fitted baseline, which
        faults reached the queue.
      CHOICES: The evidence is what the layer itself wrote, not a summary composed here.

    web/scripts/verify-funnel.ts
      WHY IT EXISTS: The funnel is an accounting statement and has to add up.
      WHAT IT DOES: Finds the busiest day in the database by asking rather than assuming,
        then checks on every machine that nothing passes a stage it did not enter, that
        the named reasons account for exactly the difference at every stage that
        subtracts, that no stage reports two different units, and that the clean twin is
        the same day of the year with the same ten stages.
      CHOICES: The exact-balance check is applied to stages 2, 4, 5 and 6 only. Stages 1
        and 3 carry a reason that can legitimately be zero, and stage 10's candidates are
        a set union rather than a subtraction -- checking those for exact balance would
        be checking a different property and failing for the wrong reason.

    analytics/trace/funnel.py :: stage 6's unit
      CHANGED FROM BEFORE: It reported `episodes` on the path where no rule ran and
        `firings` everywhere else, so one stage carried two different units depending on
        a branch nobody would think to check -- 230 rows of 1,892. Zero firings is still
        a count of firings. Fixed in the code and corrected in place for the stored rows,
        which needed no re-run because the right value is the same on both paths.

### Verification

    the engine on 2037-06-16

      ok  nothing passes a stage it did not enter          (all 4 machines, all 10 stages)
      ok  reasons account for every drop                   (stages 2, 4, 5, 6)
      ok  no stage reports two different units             (all 4 machines)
      ok  the clean twin is the same day of the year       2037-06-16 vs 2039-06-16
      ok  the clean twin has the same ten stages

          chiller-1: fired 2,255 vs 11 clean · sustained 1,967 vs 0 clean
          chiller-2: fired   530 vs  1 clean · sustained   478 vs 0 clean
          ahu-1:     fired     0 vs  0 clean · sustained     0 vs 0 clean
          chiller-3: fired     0 vs  0 clean · sustained     0 vs 0 clean

The two middle rows are the screen's whole argument. On healthy equipment, in the same
weather and the same week of the year, the rules still fire — and the persistence
requirement kills every single firing. Nothing reaches the operator.

`npx tsc --noEmit` clean, `npm run build` clean, `uv run ruff check .` clean.

### Two corrections to earlier work, both found by building this

The 1.4 notes recorded 9,248 evaluations dropped at stage 3 for "rule does not apply in
this operating mode". That is wrong: they are dropped one stage later, by the quality
layer refusing readings it does not trust. At the time only stages 2, 5, 6, 8 and 10 had
been queried and stages 3 and 4 were inferred from them rather than read. Misattributing
one suppression mechanism to another is exactly the error this screen exists to prevent,
so it is corrected in place with a note saying what happened.

Four files said the funnel's unit "changes three times". It changes six times: seven
kinds of thing are counted down ten stages -- readings, instants, evaluations, firings,
points, failure modes, findings. The verification counted them and disagreed with the
prose, which is the correct direction for that argument to be settled in.

START HERE: `web/src/components/Funnel.tsx` — the docstring says why the bars are
logarithmic and why the bar has to break where the unit changes, which are the two
decisions that make this readable rather than merely accurate.


## Demo Phase 1, Checkpoint 1.10 — Sensor versus equipment

### What we did

The dashboard can now show the one discrimination in this project that is worth money
rather than tidiness. A supply air temperature above its setpoint is produced by a coil
that cannot cool AND by a thermometer reading high; from the symptom alone the two are
identical, and getting them the wrong way round sends a technician with a wrench to
something that needs a calibration kit. The screen puts both faults side by side with the
classifier's own working under each, and then the number: the same rule on the same
machine costs $262.50 dispatched one way and $830.00 the other. It also shows something
the advisory queue hides — that the classifier changed its mind, reading EQUIPMENT for
ten days before it read SENSOR, because the reconciliation refused to name a suspect
until one biased reading actually explained the violations.

### How it works

    api/main.py :: _case()
      WHY IT EXISTS: One fault at the moment its classifier had the most to work with,
        plus everything it said on the way there.
      WHAT IT DOES: Takes every day the fault appeared in a queue, returns the last one
        in full -- class, reason, the three evidence lines, the dispatch -- and the whole
        sequence of classes as a history.
      CHOICES: The LAST day rather than a chosen one. That is where the trailing window
        holds the most evidence, and on this data it is also where the classification is
        right: the same fault reads EQUIPMENT earlier.

    api/main.py :: the counterfactual
      WHY IT EXISTS: "What is the discrimination worth" is a question about ONE symptom
        sent out two ways, and getting that wrong was the first thing this checkpoint
        got wrong.
      WHAT IT DOES: Finds the most recent day the same fault was classified the other
        way and returns that day's dispatch alongside the current one.
      ⚠ JUDGEMENT CALL: The published ratio is within one fault, not between the two
        faults on the screen. Dividing the valve replacement by the sensor calibration
        gives 10.59x, which is a bigger and more impressive number and answers no
        question anybody asked -- they are different jobs on different equipment. The
        same rule id dispatched two ways gives 3.16x, and that is the number the
        intervention library was built to produce. Both dispatches are real stored
        advisories rather than a lookup, because the classifier called that fault both
        things on different days and the advisory layer costed each.

    api/main.py :: GET /diagnosis/pair
      WHY IT EXISTS: The screen's single fetch.
      CHOICES: `composed` is in the response and is true here. The two faults are two
        runs two years apart and no position of the clock holds both. The alternative
        was a screen implying they had been seen side by side, which they never were.

    web/src/components/Reconciliation.tsx
      WHAT IT DOES: One fault's card -- the class, the sentence explaining it, the three
        evidence lines split into label and value, and what the dispatch costs.
      CHOICES: The evidence is the layer's own output, not a summary written here. It
        says which relations were violated and by how much, what a single biased sensor
        would explain, and whether the trouble stays inside the relations that sensor
        reaches. Those three together ARE the discrimination.

    web/src/components/ClassTimeline.tsx
      WHY IT EXISTS: Because the queue shows one class per fault and reads as a system
        that was always right, and it was not.
      WHAT IT DOES: One block per day, coloured by class, grouped into runs, with the
        reason recorded that day shown underneath as you move across it.
      ⚠ JUDGEMENT CALL: Showing this at all. The flip is easy to read as instability and
        a screen without it would be simpler and more flattering. It is in because a
        classifier that declines to commit until the evidence supports it is a better
        system than one that guesses early and happens to be right, and because a
        reviewer who found the flip themselves would reasonably wonder what else was
        being smoothed over.

### Verification

    apar-20              SENSOR     2038-09-24  13 days in a queue
    coil-valve-leak-by   EQUIPMENT  2036-09-05  170 days in a queue

    ok  the two halves are classified differently        sensor vs equipment
    ok  both are on the same machine                     ahu-1
    ok  apar-20 recorded a reason / its evidence / the single-sensor test
    ok  coil-valve-leak-by recorded a reason / its evidence / the single-sensor test
    ok  composed is true exactly when the two come from different runs   2038 and 2036
    ok  one half was classified both ways, so a counterfactual exists
    ok  the counterfactual is a different dispatch of the SAME fault
        calibrate-supply-air-sensor vs inspect-coil-capacity
    ok  the published ratio is those two costs and nothing else          3.16 vs 3.16
        $262.50 as sensor vs $830.00 the other way = 3.16x on the same symptom
    ok  both histories end on the class shown
        apar-20: equipment and sensor across 13 days
        coil-valve-leak-by: equipment across 170 days

`npx tsc --noEmit` clean, `npm run build` clean, `uv run ruff check .` clean.

### What the replay says that the walkthrough did not

Building this checkpoint measured four things the README's 5:00 step had stated from the
old hand-picked windows. Three of them changed and one was exactly right.

The bias estimate is **+2.434 K explaining 94% across three relations**, not the 2.7 K
the walkthrough quoted. Against a true injected bias of 2.22 K that is a BETTER estimate,
not a worse one -- the trailing window at the end of the run has more evidence than the
window the snapshot script chose.

The equipment half does not fail the single-sensor test the way the walkthrough said. It
does not reach it: `single-sensor test : not reached -- an unresponsive actuator
invalidates it`. The documented version -- three relations disagreeing in sign so no one
number can produce them -- is a true statement about a different window. What the replay
shows is the classifier declining to run a test whose precondition is not met, which is a
different and arguably better answer.

The classification is not stable. `apar-20` reads EQUIPMENT for ten days and SENSOR for
three. The walkthrough implied one settled answer.

The money was right: **$262.50 and $830.00, 3.16x**, exactly as documented, on the same
rule id and the same machine.

README.md's 5:00 step is rewritten to the replayed numbers, because the dashboard is the
source of truth now and a demonstration script that disagrees with the running screen is
worse than no script.

START HERE: `web/src/components/ClassTimeline.tsx` — the docstring says why a screen
that shows the classifier changing its mind is stronger than one that hides it.


## Demo Phase 1, Checkpoint 1.11 — The prediction screen

### What we did

The prediction can now be checked rather than believed. The system says a machine has
thirty-two days left; this screen walks the eight steps between a thermometer reading
and that sentence, with the real number at each and the table it is stored in, so a
sceptical reader can follow it end to end. Then it shows the same prediction against
what actually happened — and the model is late every single time, by eighty-four days
on the last estimate of its best series. Both halves are on one screen on purpose. The
interval closing by 97% as evidence accumulates is real and is the thing the model does
well; a screen that stopped there would be a sales pitch.

### How it works

    api/main.py :: GET /prediction/explain
      WHY IT EXISTS: Six of the eight steps were already served across two endpoints and
        the residual that starts the chain was served nowhere. Assembling eight steps in
        the browser would have put the pipeline's structure in the frontend, where it
        cannot be checked.
      WHAT IT DOES: Reads the failure mode's configuration, the last health row and the
        last estimate at or before the moment asked for, and returns eight steps each
        carrying a plain-language description, the actual value, and the table it came
        from.
      CHOICES: Every figure is READ, never recomputed. A screen that recomputed the chain
        to describe it could disagree with the chain, and a viewer would then have two
        answers and no way to tell which one the system used.

    api/main.py :: _RESIDUAL_REF
      WHY IT EXISTS: Step 1 needs the raw residual the whole chain is built on, and
        nothing said which point that is.
      WHAT IT DOES: Reads it out of the failure mode's own indicator expression --
        `-{residual:@asset.sa_temp.shut-valve-supply-air}` names both the instrument and
        the baseline -- and resolves `@asset` against the machine.
      CHOICES: Parsed rather than mapped in a table here. A second copy of "which point
        measures which mode" would be a second thing to keep in step, and the expression
        is already the authority the health layer uses.

    web/src/components/RulExplainer.tsx
      WHAT IT DOES: The eight steps as a numbered list, each with what it does in plain
        language, the number, and the table.
      CHOICES: The value is in the monospace face and the source underneath it, because
        the value is the thing being checked and the source is how you would check it.

    web/src/components/PredictedVsActual.tsx
      WHY IT EXISTS: The least flattering picture in the project and the most useful one.
      WHAT IT DOES: Plots each day's prediction as the failure DATE it implies rather
        than as days remaining, against a horizontal line at the date the machine
        actually failed. A correct forecaster's line walks onto that line; a late-biased
        one approaches from above and never lands.
      CHOICES: Dates, not a countdown. A countdown always looks like it is working --
        the number goes down every day whether or not it is right.
      ⚠ JUDGEMENT CALL: The caveat beside the chart is long, and it is long because the
        gap it shows is two different things added together. The green line is when the
        INJECTED FAULT reached terminal severity; the model is predicting when ITS OWN
        indicator crosses ITS OWN threshold, and on this series that indicator only ever
        reached 57 percent of it. A reader who took the whole gap as modelling error
        would be drawing a harsher conclusion than the data supports; one who took it all
        as definitional would be excusing a real late bias. VALIDATION.md section 5
        splits the 10.1 percent coverage between exactly those two causes, and the screen
        has to do the same or it is misreporting in one direction or the other.

    web/src/screens/Prediction.tsx
      CHOICES: The remaining-life history is fetched WITHOUT the clock's as_of. Every
        other screen truncates at the clock; this one is about the whole arc of a
        prediction, and truncating would hide the thing it exists to show.
      CHANGED FROM BEFORE: The plan said the advisory detail's fan chart would be reused
        unchanged. It cannot be -- it takes an advisory payload and is built around one
        open advisory, and fabricating a payload to borrow it would couple this screen
        to a shape it does not have. What IS reused is `narrowing()` from lib/chart.ts,
        which is pure, so the close percentage quoted here and the one on the advisory
        cannot disagree.

### Verification

    ahu-1 / coil-valve-leak-by: 84 estimates

    what the model does well
      ok  the interval closes over the run            97.4% over 68 bounded estimates
      ok  and NOT monotonically, which is stated      monotone=false

    the eight steps resolve
      ok  all eight steps returned
      ok  every step carries a real value, not a placeholder
      ok  every step names where it is stored
      ok  step 1 reaches an actual residual
          ahu-1.sa_temp: measured 11.675, expected 15.983, gap -4.308
      ok  the threshold carries its physical justification

    and what it does badly
      ok  every bounded estimate predicts failure LATER than it happened   84 of 84
          actual failure 2036-05-01; last prediction puts it 84 days later
      ok  the final error is late, not early                               84 days

The eight steps on that series, end to end:

    1  ahu-1.sa_temp: measured 11.675, expected 15.983, gap -4.308
    2  -{residual:@asset.sa_temp.shut-valve-supply-air}
    3  0.4003 degC
    4  1.6041 degC   (raw was 0.4003, so the clamp moved it 1.2038)
    5  confirmed 2036-03-19
    6  drift 0.01669 per day, spread 0.05382, fitted on 53 days
    7  threshold 2.800 degC, currently at 1.604 -- 57% of the way
    8  P10 15.9 days · P50 31.7 days · P90 74.5 days

Step 7's **57 percent** is worth pausing on: it is the same figure VALIDATION.md
section 5 names as the definitional half of the 10.1 percent coverage failure. The
document states it as a summary statistic; this screen shows where it comes from.

`npx tsc --noEmit` clean, `npm run build` clean, `uv run ruff check .` clean.

START HERE: `web/src/components/PredictedVsActual.tsx` — the docstring says why the
chart plots dates rather than a countdown, and why the caveat beside it has to name
both causes of the gap rather than the flattering one or the damning one alone.


## Demo Phase 1, Checkpoint 1.12 — Reveal and configuration

### What we did

Phase 1 is complete. Two screens close it: one showing what was actually wrong with the
building, and one showing what the system was configured with and why. The first is the
demonstration's reveal and shows nothing until asked, because everything on every other
screen was worked out from readings alone and that moment is worth keeping. The second
answers the question a sceptical reviewer asks after being shown accuracy figures --
what are the thresholds, and who decided them -- with nine rules, six failure modes and
sixteen interventions, each carrying the physical reason for its own numbers.

### How it works

    api/main.py :: GET /config/rules
      WHY IT EXISTS: The nine rules live in Python decorators, not in a table, so there
        is no other way to serve them.
      WHAT IT DOES: Each rule's id, one-line description, the Brick class it applies to,
        which operating modes it may run in, the quality bar below which its inputs are
        not believed, and how long a firing must hold before it counts as a fault.
      CHOICES: The docstring says why rules are code while modes and interventions are
        rows, rather than leaving that looking like an oversight: a rule is an expression
        over readings, and making it a row would mean inventing a small language to put
        in the row. What IS data about a rule is the class it dispatches on.

    api/main.py :: GET /config/modes and /config/interventions
      WHAT THEY DO: Straight reads of the two configuration tables, rationale columns
        included.
      CHOICES: These are the two tables that make the extensibility claim true -- adding
        a failure mode or a response is a row, not a code change -- so the screen showing
        them is also the evidence for that claim.

    web/src/screens/Configuration.tsx
      CHOICES: The reason is hidden until a row is clicked. Six rationales at 518
        characters each shown at once is a wall of text nobody reads; behind a click,
        each one is read by somebody who wanted that specific number explained.
      CHOICES: A mode with no indicator expression is marked "not computable in this
        building" in orange rather than left blank. An empty cell reads as missing data
        and this is a decision.

    web/src/screens/Reveal.tsx
      ⚠ JUDGEMENT CALL: The screen shows nothing until an explicit click. A reveal that
        has already told you the answer before you asked has spent the moment it exists
        for, and the tab being visible while the content is one action away is the
        difference between a demonstration and a reference page. The cost is one extra
        click for anybody using it as reference.
      WHAT IT DOES: Splits the answer key three ways at the clock's moment -- running
        now, already past failure, not injected yet -- and offers each active fault a
        cascade measurement on demand.
      CHOICES: It states, on the screen, that it is served by a separate process on a
        separate credential and that the detection API cannot read this data. That
        sentence is the whole basis of every accuracy figure in the project and it
        belongs where somebody is looking at the answer key, not only in a document.

    web/src/components/CascadeList.tsx
      WHAT IT DOES: Which instrument on the faulted machine departed from its fault-free
        twin first, when, and how far it eventually got, with the measurement's own
        caveats printed rather than smoothed.
      CHOICES: Fetched per fault on demand. Each takes about three seconds on first call
        and is cached in the reveal process afterwards; fetching all six on load would
        make the screen slow for a viewer who wanted one.

    web/src/App.tsx :: NotBuilt, deleted
      CHANGED FROM BEFORE: The placeholder component that stood in for unbuilt screens is
        gone, because nothing is unbuilt. Every route in the tab strip now resolves to a
        real screen.

### Verification

    9 rules · 6 failure modes · 16 interventions

    every threshold has a physical reason
      ok  every failure mode carries a threshold rationale     shortest is 518 characters
      ok  every threshold is a real positive number
      ok  every failure mode names the unit its threshold is in
      ok  every failure mode is either measurable or says why it is not
          1 declared but not computable here: filter-loading

    every cost has a basis
      ok  every intervention carries a basis                   shortest is 42 characters
      ok  every intervention names at least one skill
      ok  every intervention takes a positive amount of time

    the discrimination is worth money because the library says so
      ok  at least one fault resolves to a different response depending on its class
          apar-20: equipment 6h vs sensor 1.5h  (4.0x in hours)

    every rule declares when it may run
      ok  every rule has a description
      ok  every rule is dispatched by a Brick class, not by an asset id
          brick:Air_Handling_Unit, brick:Chiller
      ok  every rule sets a quality bar and a persistence requirement

`npx tsc --noEmit` clean, `npm run build` clean, `uv run ruff check .` clean.

### A verification that failed, and was the wrong verification

The first version of the configuration check asserted that every failure mode has an
indicator expression. It failed, on `filter-loading`, and the data turned out to be
right. A loaded filter is measured by the pressure drop across it; neither LBNL dataset
publishes one, and there is no filter in the simulation to load. The threshold is
recorded anyway because 250 Pa is the real change-out criterion, and the rationale opens
with the words NOT COMPUTABLE IN THIS BUILDING.

So the property worth asserting is not "everything is measurable". It is that anything
unmeasurable SAYS SO in the row rather than sitting there looking configured. The check
now asserts that, and the screen marks the mode in orange rather than leaving the cell
blank -- an empty cell reads as missing data, and this is a decision somebody made and
wrote down.

Worth separating from the times this project has loosened a check to make it pass: the
check here was testing the wrong property, the data was correct, and the corrected check
is stricter about the thing that actually matters.

### One more thing the tables say

`chiller-refrigerant-loss` is measurable, configured, and has produced zero health rows,
zero estimates and zero advisories across all four runs. It is gated on the compressor
running at or above 95 percent of full load, which does not happen often enough in this
data. That is visible on the screen -- the gate is printed under the rationale -- and it
is a fair thing for a reviewer to notice.

START HERE: `web/src/screens/Reveal.tsx` — the gate at the top, and the paragraph
explaining why the answer key is served by a different process, which is the sentence
every accuracy figure in this project rests on.


## Demo Phase 1 — Consolidation pass

### What we did

A fresh database now becomes a working demonstration in one command, and the two
documents that describe the system describe the one that exists. Before this, `make demo`
stopped after the remaining-life replay, so somebody who followed the README got four of
the six screens showing nothing and no indication why. The documentation had drifted
further: it described a dashboard with one screen, an API with nine endpoints, and a log
with nine entries, against a system that now has six screens, nineteen endpoints and
eleven entries.

### How it works

    Makefile :: demo
      CHANGED FROM BEFORE: The chain ended at `advisories-write`. It now continues
        through `advisory-replay` and `engine-trace`, which is what the clock and the
        engine screen read. A fresh database ran the old target and produced a dashboard
        where four screens were empty.
      ⚠ JUDGEMENT CALL: `advisories-write` is KEPT, and kept BEFORE the replay. Dropping
        it was the tidier option and would have been wrong: it is the only thing in this
        project that produces the cross-asset demotion. It composes that situation by
        era-shifting the chiller's condenser fouling into the air handler's window,
        whereas the replay builds every day from unmodified data -- where the
        plausibility map correctly declines to link anything. Checked rather than
        assumed: across all 1,657 rows there is exactly one consequential advisory, and
        it belongs to the snapshot. Drop the step and the demotion does not exist
        anywhere in the database, and the walkthrough's 6:30 has nothing to show.
      CHOICES: The ordering hazard is documented in three places -- on the `demo` target,
        on `advisories-write` itself, and in the README quickstart -- because it is
        silent and destructive. `advisories-write` DELETES app.advisories before writing,
        since it owns the single snapshot it produces. Run after the replay it removes
        577 days of per-day queues with no error; the clock keeps moving and every screen
        goes blank.
      CHOICES: `python -u` on the four long-running targets. The advisory replay's first
        run wrote its progress into a pipe buffer and reported nothing for eighty
        minutes, which is indistinguishable from a hang.

    README.md :: Quickstart
      CHANGED FROM BEFORE: It said `make demo` "is the only path that writes
        app.advisories", which stopped being true when the replay arrived and would have
        led a reader to believe one step was sufficient. It now names the three long
        batches in a table with what each produces and why the order matters, carries the
        ordering warning, and adds `make reveal` as a third terminal.

    README.md :: Timed walkthrough
      CHANGED FROM BEFORE: It opened "0:00 — The dashboard", describing a single screen.
        It now opens by naming the six screens and the shared clock, and explains the
        property that makes the replay convincing: at any moment nothing after that
        moment is visible anywhere, which is why an interval can be watched closing.

    ARCHITECTURE.md :: layer 11
      CHANGED FROM BEFORE: Three sentences about a queue, a detail view and a plant
        schematic -- a component that no longer exists. Replaced with the six screens as
        a table, the clock as the spine of all of them, and the strict as-of rule stated
        as the thing that makes a replay indistinguishable from a live system without
        anything being faked.
      CHANGED FROM BEFORE: A new rejected alternative recording that the no-router
        decision was reversed. It was right with two views and wrong with seven, and the
        cost it accepted at the time -- an advisory that could not be linked to -- is
        exactly what changed.
      CHANGED FROM BEFORE: The verification paragraph said "Node scripts" render the
        schematic. There are now seven of them and they check the queue's ordering, the
        fan chart's narrowing, the clock's era arithmetic, the twin's geometry, the
        funnel's accounting, the diagnosis screen's cost claim and the configuration's
        justifications.

### Verification

    demo: db-up load scenarios quality residuals baselines health rul \
          advisories-write advisory-replay engine-trace

Resolved order, from `make -n demo`:

    uv run python    scripts/run_advisories.py --write
    uv run python -u scripts/run_advisory_replay.py --resume
    uv run python -u scripts/run_engine_trace.py --resume

Stale claims, counted before and after:

    "nine decisions"            0 occurrences   (AI_LOG.md has 11 entries)
    "Nine endpoints"            0 occurrences   (the API serves 19)
    "one dashboard that exists" 0 occurrences
    "only path that writes"     0 occurrences
    plant schematic references  0 occurrences   (the component was deleted in 1.7b)

Every `make` target named in README.md or ARCHITECTURE.md exists in `.PHONY`: twelve
checked, twelve present. `.PHONY` itself covers every target defined in the file.

`npx tsc --noEmit` clean, `uv run ruff check .` clean.

### What this pass did not do

No Phase 2. No live injection, no feed process, no change to how anything is computed.
The two documents now describe the system as built; ROADMAP.md's Next section is
untouched and still describes work that has not started.

START HERE: `Makefile` — the comment above `advisories-write`, which is the one place in
this project where running two targets in the wrong order destroys hours of work without
producing an error.

## Demo Phase R, Checkpoint R1 — Design system and vocabulary layer

### What we did

The dashboard gained a single, shared definition of how everything in it should look,
and a way for a technical word to carry its own meaning.

Before this the interface had been styled by hand, one screen at a time, on the day each
screen was written. That left sixteen different text sizes in use, a hundred and
twenty-three of the hundred and eighty size settings at twelve pixels or smaller, and
eighty-one places where a screen set its own colours and spacing inline instead of
sharing them. Seventy-one colours were written out as raw codes scattered across eight
files, with no two files agreeing on which grey meant "less important". The practical
effect was that nothing on any screen looked more important than anything else, so a
reader had to work out the priority for themselves every single time.

The second and larger problem was that the system explains itself in paragraphs. Because
this project requires every piece of industry jargon to be defined where it is first
used, and the only tool available for that was a block of text, every screen opened with
one — forty-six runs of prose over a hundred characters, and three screens where the
very first thing on the page is an essay. The definition of a term sat inches away from
the number it explained, and the reader had to carry it across that gap unaided.

The system can now attach a definition to the word itself. Hovering or tapping any
technical term shows one or two plain sentences explaining it, which means a screen can
open with its finding rather than with a lesson. Forty-two terms are defined this way.
The colour scheme also moved from dark navy to warm paper, which reads considerably
better on a projector and in a screen share, and colour is now reserved for meaning:
four colours, one job each.

None of this changes a single number the system produces. It changes only how they are
presented.

### How it works

`web/src/design/tokens.css` :: the token set
  WHY IT EXISTS: One place that decides every size, colour and spacing value in the
    interface. Without it each screen invents its own, which is exactly how the build
    arrived at sixteen text sizes and four different greys for the same idea.
  WHAT IT DOES: Declares five text sizes where there were sixteen, an eight-step spacing
    scale, three weights of ink, four meaning-colours with a pale tint of each, and three
    shadow depths. It then re-declares every OLD variable name — `--panel`, `--line`,
    `--muted` and the rest — as an alias pointing at the new light values.
  CHOICES: The aliases are the reason this checkpoint is one file rather than a rewrite
    of twenty stylesheets. Sixty-three references to `--line` exist across the build; had
    the name been deleted, every one of those files would have had to change in the same
    commit and there would be no way to show that only presentation moved. Each alias
    disappears as its screen is rebuilt.
  CHOICES: The smallest permitted size is 11.5px. Everything below that — 9, 9.5, 10 and
    10.5px, a hundred and twenty-three declarations in total — is unreadable at arm's
    length and invisible projected. Those are removed screen by screen, not here.
  CHOICES: Warm neutrals rather than blue-grey. The same lightness with a blue cast reads
    as an unlit screen, which is what the old palette was; warm reads as paper.
  ⚠ JUDGEMENT CALL: The three ink weights were picked to specific contrast ratios against
    the page — 16.1:1, 7.4:1 and 4.8:1 — so that even the faintest one clears the 4.5:1
    accessibility floor. The alternative was a lighter, prettier tertiary grey. Rejected
    because the faintest ink is the colour most of the small text in this build is set
    in, so it is the one that must not fail.

`web/src/design/palette.ts` :: the same palette as literal strings
  WHY IT EXISTS: Six components draw SVG and set colour as a `fill` or `stroke` attribute
    rather than through a stylesheet. That is load-bearing, not sloppiness: the twin
    verification script writes the building drawing out to a standalone file and opens it
    on its own, where a stylesheet variable resolves against nothing and the drawing
    arrives with no colour at all.
  WHAT IT DOES: Exports every colour a second time as a plain string, grouped into
    surfaces, ink, meaning, the four states a drawn machine can be in, the four fault
    classes, and chart furniture. Each entry names the stylesheet token it mirrors.
  CHOICES: Duplication between this and the token file is accepted deliberately, because
    the alternative — a build step that generates one from the other — is machinery for
    two dozen values. The two files name each other at the top so the pairing is visible.
  ⚠ JUDGEMENT CALL: A drawn machine is now a pale tint with a saturated border, not a
    saturated fill. On a dark page a solid red box was readable; on paper it is a shout,
    and a plant diagram where six nodes shout at once is the state the old theme was in.

`web/src/lib/glossary.ts` :: GLOSSARY and TermId
  WHY IT EXISTS: The single change that lets the opening paragraph be deleted from every
    screen. The project requires jargon to be defined inline and is right to; this makes
    that possible without a wall of text.
  WHAT IT DOES: Holds forty-two entries across six groups — the plant itself, how it
    degrades, how it is measured, how a judgement is reached, how a prediction is made,
    and how the replay works. Each is one or two plain sentences with no identifiers and
    no second undefined term hiding inside the definition.
  CHOICES: `TermId` is derived from the object's own keys, so a misspelled term is a
    compile error rather than a tooltip that silently shows nothing. There is therefore
    no runtime fallback anywhere for a missing definition, because there cannot be one.
  CHOICES: Entries are capped at two sentences. If a word needs three, the word is doing
    too much work and the screen should say less rather than the tooltip saying more.

`web/src/design/Term.tsx` :: Term
  WHY IT EXISTS: Puts a glossary entry onto the word it defines, which is what lets a
    screen lead with its finding instead of with an explanation.
  WHAT IT DOES: Renders the word as a real button with a dotted underline. On hover or
    keyboard focus it measures its own position on screen, works out whether there is
    room for the bubble above, flips it below if not, centres it on the word and then
    pulls it back inside the window edge. The bubble is rendered out to the end of the
    document rather than next to the word.
  CHOICES: Rendered elsewhere in the document because terms appear inside tables that
    scroll sideways and panels that clip their contents, and a bubble positioned inside
    the flow gets sliced off by both.
  CHOICES: Position is measured before the browser paints, so the bubble never appears in
    the wrong place for one frame and then visibly corrects itself.
  CHOICES: Scrolling closes it rather than repositioning it. A bubble measured against a
    page that has since moved is pointing at the wrong word, and closing is more honest
    than chasing.
  ⚠ JUDGEMENT CALL: It is a `<button>`, so it opens on focus and on tap, not on hover
    alone. Hover alone is simpler and was rejected: it would put all forty-two
    definitions out of reach of anyone using a keyboard or a touchscreen.
  ⚠ JUDGEMENT CALL: A click inside it stops the event travelling further up. Terms will
    sit inside clickable table rows, and defining a word should never also open the row.

`web/src/design/Stat.tsx` :: Stat, Unit, StatRow
  WHY IT EXISTS: The most important figure in the product — how long a machine has left,
    what ignoring it costs — was set at twelve pixels in a table cell, the same size as
    the column heading above it and the footnote below it.
  WHAT IT DOES: Stacks a small tracked capital label, a large tabular number, and a
    caption underneath. Two sizes: "hero", meaning the one number a screen is about, and
    "normal". An optional click handler turns the whole block into a button for numbers
    that open their own evidence.
  CHOICES: The caption is where a number gets restated in plain English — "one per 604
    machine-days" is a quantity the reader has to convert before they can feel it, and
    "cried wolf once in 604 days of watching a healthy machine" is one they cannot help
    feeling. A Stat with no caption is usually a Stat nobody thought about.
  CHOICES: Colour is opt-in. A number is only tinted when the tint is a claim about it;
    counts and horizons stay plain, because colouring them spends the reader's attention
    on something that does not need it.

`web/src/design/Panel.tsx` :: Panel and Why
  WHY IT EXISTS: Every section in the build wrote its own heading by hand, and most of
    the eighty-one inline style blocks are that heading written out again slightly
    differently. One component means one answer to how far a title sits from its content.
  WHAT IT DOES: Draws a titled white surface with an optional short subtitle, optional
    controls on the right, and an optional folded-shut explanation. `Why` is that
    disclosure on its own: a small circled question mark that opens a block of
    explanation, and inside a panel heading it drops out as an overlay so opening it does
    not shove the title around.
  CHOICES: Built on the browser's native disclosure element rather than a state flag.
    That element is reachable by keyboard, announced properly to a screen reader, and —
    the reason that matters here — findable by the browser's own page search even while
    it is closed. What gets folded away is the justification for a number somebody may be
    trying to check, so it must stay findable.

`web/src/styles.css` :: base layer
  CHANGED FROM BEFORE: Held the entire colour scheme as raw values. Now imports the token
    file and defines only the reset, the base elements, and the three shared classes the
    build still uses. One keyboard focus ring is defined here for everything.

`web/src/lib/format.ts` :: COLOURS and CLASS_COLOUR
  CHANGED FROM BEFORE: Declared the drawn-machine colours and the fault-class colours as
    raw values. Now re-exports them from the palette file under the same names, so the
    five components importing them did not have to change.

`web/src/App.tsx` :: the masthead
  CHANGED FROM BEFORE: The line under the title read "one air handler, three chillers,
    three cooling towers" as flat text. All three are now defined terms. This is the
    checkpoint's own proof that the vocabulary layer works — a reader who does not know
    what a cooling tower is can now find out without leaving the page.

Supporting work, not detailed individually: a scripted pass re-pointed fifty-four literal
colour values across nine files at the light palette, verified afterwards by confirming
that every colour code still present anywhere in the source appears in the palette file.
The call sites still hold literal strings rather than importing the named constants;
those convert as each file is rebuilt in R5 to R8.

START HERE: `web/src/design/tokens.css` — every other file in this checkpoint either
defines a value that belongs there or consumes one.

## Demo Phase R, Checkpoint R2 — Plain-language names and the story order

### What we did

Every screen in the dashboard was renamed to something a person can understand without
knowing how the system is built, the screens were put into the order of the argument
rather than the order of the codebase, and each one now opens by stating what it claims.

Six of the seven screens were named after the internal machinery that produces them —
Twin, Engine, Diagnosis, Prediction, Reveal, Configuration. Those are architecture words
promoted to the top of the interface. Somebody arriving cold could not tell what any of
them would show, so the only way to find out was to open all seven and read. "Engine" is
now "How we know", which is less a rename than an admission of what that screen was
always for.

The order was also wrong. It ran roughly along the layers of the codebase, which is
useful to the person who wrote it and to nobody else. Read left to right the tabs now
make a case: something is wrong, here is where it sits, here is how we know, here is
which kind of fault it is, here is how long it has, here are the rules we judged it by —
and only at the end, set apart, here is what was actually broken.

Each screen also gained a headline, in the largest text on that screen, stating what it
is claiming rather than what it is called. Where a headline carries a number, that number
comes from the data and moves with the clock. Three screens used to begin with a
paragraph of explanation; that text is still there, folded shut behind a marker beside
the headline, so the screen leads with its finding instead of with a lesson.

No number, no calculation and no piece of data changed.

### How it works

`web/src/design/ScreenHead.tsx` :: ScreenHead
  WHY IT EXISTS: The first rule of this redesign is that every screen states what you are
    looking at before it shows you anything. Previously a screen opened with its internal
    name at fifteen pixels, which tells a reader who already knows the system nothing new
    and everyone else nothing at all.
  WHAT IT DOES: Renders the claim at the display size, an optional supporting line under
    it, and — opposite rather than below — an optional folded explanation.
  CHOICES: The claim is capped at twenty-two characters of width so it breaks into two or
    three short lines rather than running as one long ruler across a wide monitor.
  CHOICES: The disclosure sits opposite the headline, not under it, so opening it never
    pushes the screen's content down the page and never moves what the reader was
    pointing at.
  ⚠ JUDGEMENT CALL: A headline is a claim, not a noun. "Configuration" is a filing label;
    "Every number in this system, and why it is that number" is an assertion the screen
    then has to make good on. Writing the headline first is what forces each screen to
    have a point, and two screens' headlines were rewritten once it became clear the old
    name was hiding the fact that the screen did not have one.

`web/src/components/NavTabs.tsx` :: TABS and ANSWER
  WHY IT EXISTS: The switcher between screens, and the first thing anybody reads.
  WHAT IT DOES: Six operator screens in the order of the argument, then a spacer, then
    the answer key on its own past a divider. Every tab carries a one-line hint on hover,
    but the label has to stand on its own — the hint is never required reading.
  CHANGED FROM BEFORE: Labels were Operations, Twin, Engine, Diagnosis, Prediction,
    Reveal, Configuration, in that order, with a flag for screens not yet built. All
    seven are built, so the flag went; all seven are renamed; the order is now the
    argument.
  ⚠ JUDGEMENT CALL: The answer key is pushed to the far end behind a divider rather than
    sitting in the run of operator screens. It is served by a different process on a
    different credential and it gives the game away, so the visual separation is an
    honest signal that it is a different kind of thing. The alternative — leaving it
    seventh in the row — made it look like one more screen of findings.

`web/src/components/NavTabs.module.css` :: the tab row
  CHANGED FROM BEFORE: A joined segmented control of filled boxes. That read well on a
    dark page; on paper it puts seven grey blocks across the top of every screen, heavier
    than the content beneath. Now underline tabs, which spend almost no ink and still say
    exactly where you are. The row scrolls sideways rather than wrapping, so it never
    becomes two rows and shifts the whole page down.

`web/src/App.tsx` :: MOVED
  WHY IT EXISTS: The paths were renamed alongside the tabs, because a URL is read aloud
    during a demonstration and sits in the address bar of a shared screen, where "/engine"
    tells a viewer as little as it did on the tab.
  WHAT IT DOES: Maps each old path to its new one. Every entry is turned into a redirect
    route, so a link somebody saved last week still lands on the right screen instead of
    bouncing to the queue.
  CHOICES: The component files were deliberately NOT renamed — `screens/Engine.tsx` still
    renders "How we know". Renaming seven files and their imports would be a large diff
    with no visible effect whatever. This table is instead the single documented place
    that maps an internal name to the name a viewer sees.

The seven screens, in the order the tabs now run:

`screens/Operations.tsx` :: the headline
  WHAT IT DOES: Reads how many advisories are open and says so — "6 things need
    attention", or "Nothing needs attention right now", or just "What needs doing" before
    the data has arrived. Singular and plural are both handled.
  CHOICES: The number is passed from the data and never written into the string. The
    clock moves and this number moves with it; a headline reading "six" above a queue
    showing two is worse than no headline at all.

`screens/Twin.tsx` :: the headline
  WHAT IT DOES: "Where each fault sits in the plant", with a supporting line that names
    the direction heat travels — towers throw it away, chillers make cold water, the air
    handler blows cooled air at the rooms — and tells the reader that boxes are
    clickable. All three pieces of equipment are defined terms.

`screens/Engine.tsx` :: the headline
  CHANGED FROM BEFORE: Opened with "The engine" and then a six-line paragraph. Now
    "Everything the system threw away, and why", with one line of direction — read
    downwards — and the paragraph folded into the disclosure.

`screens/Diagnosis.tsx` :: Head
  WHY IT EXISTS: Defined as its own small component because the screen has a loading
    state and a loaded state, and a screen that has no title until its data arrives looks
    broken for the half second before it does.
  WHAT IT DOES: Renders "One symptom. Two causes. N× apart." where N is the cost ratio
    the API computed, falling back to "One symptom, two causes" while loading.
  CHOICES: The ratio was 3.16 the last time anybody looked, and writing that into the
    string would leave the headline asserting a figure the tables below it had quietly
    stopped agreeing with.

`screens/Prediction.tsx` :: the headline
  CHANGED FROM BEFORE: "Prediction". Now "How long it has left, and how sure we are",
    with the supporting line making the point the screen exists to make — never a single
    date, always a range, and the range narrows as evidence arrives.

`screens/Configuration.tsx` :: the headline
  CHANGED FROM BEFORE: "Configuration" plus a seven-line paragraph. Now "Every number in
    this system, and why it is that number", with one line telling the reader that rows
    are clickable, and the whole justification — the not-null constraint, rows versus
    code, the one failure mode that cannot be measured in this building — folded away.

`screens/Reveal.tsx` :: the headline
  WHAT IT DOES: "What was actually broken" in both the gated state and the revealed one.
    The gated state's supporting line is the tease — everything elsewhere was worked out
    from readings alone, this is the marking scheme. The revealed state's line carries the
    date the clock is standing at.
  CHANGED FROM BEFORE: The gate's own heading said "This is the answer", which gave away
    in the heading what the button underneath existed to offer. It now says it is worth
    forming a view on the other screens first, which is the actual instruction.

START HERE: `web/src/components/NavTabs.tsx` — the order of that list is the argument the
whole dashboard is now arranged to make.

## Demo Phase R, Checkpoint R3 — The clock

### What we did

The clock is the one component visible on every screen of the demonstration, and it was
the least readable thing in the build. It has been rebuilt around a drawn timeline, and
the ground truth has been taken off it.

Before this it was eleven small controls in a row — a play button, four speed buttons,
four step buttons, two dropdowns — followed by an unlabelled grey slider. The date it was
showing was set at the same size as the buttons crowding it, so the single most important
piece of state in the whole application was also the hardest thing on the bar to find.
The slider moved the clock correctly and told a viewer nothing: not how long the run was,
not what month they were in, not whether the interesting part was ahead of them or behind.
A demonstration was run by dragging a grey rectangle and watching numbers change
somewhere else on the page.

The run is now drawn. The track shows the whole run with month markings and its start and
end dates, the position is a marked point on it, and the date itself is the largest thing
on the bar. Clicking or dragging anywhere on the track moves the clock; arrow keys move a
day and shift with arrow keys moves a week, so the four step buttons became two.

The more consequential change is what came off the bar. It used to carry a dropdown
listing every injected fault with the exact date it was injected, and chips naming
whatever was running at that moment — the answer key, sitting in the operator's chrome,
on every screen, permanently. This project's central claim is that nothing on the
detection path can see that data. Printing it along the top of every screen undercuts the
claim before a viewer reads a word. It now sits behind a switch that is off by default,
labelled as reading the answer key, and the fault spans only appear on the timeline once
that switch is on.

### How it works

`web/src/components/Timeline.tsx` :: Timeline
  WHY IT EXISTS: Replaces a bare range input with a thousand steps and no labels. A
    viewer needs to see where in a run they are standing, not infer it from a date.
  WHAT IT DOES: Draws the run as a track, fills the part behind the clock, and marks the
    position with a full-height line and a dot. Beneath it, one label per month plus the
    run's own start and end dates pinned to the ends. A pointer press captures the
    pointer and converts its horizontal position into a moment; arrow keys step a day and
    shift with them steps a week.
  CHOICES: COMPUTES NOTHING. Every position comes from `positionInEra` and every seek
    goes back through `momentAtPosition` — both pure functions in lib/clock.ts that are
    checked in a terminal by `npm run verify:clock`. A drawing doing its own date
    arithmetic could disagree with the rest of the application about what day it is, and
    the entire point of a shared clock is that nothing can.
  CHOICES: The hit area is twenty-six pixels tall while the track drawn inside it is
    four. A four-pixel target is correct visually and miserable to hit.
  CHOICES: The pointer is captured on press, so a drag that wanders off the element keeps
    scrubbing instead of stopping wherever the pointer happened to leave.
  CHOICES: The position marker is a line and a dot rather than a dot alone. The line says
    exactly which day; the dot is what the eye finds. A dot on its own reads as
    approximate, which on a clock driving four screens it is not.
  ⚠ JUDGEMENT CALL: Fault spans are drawn only when `faults` is passed, and the bar
    passes null unless the demo drawer is open. The alternative — always drawing them,
    since they are useful — was rejected because it puts the answer key on every screen
    of a system whose whole argument is that the answer key is unreachable from there. A
    screenshot of the default state now contains no ground truth at all.

`web/src/components/ControlBar.tsx` :: ControlBar
  CHANGED FROM BEFORE: Eleven controls and an unlabelled slider. Now a play button, the
    date at title size with the day count under it, two step buttons, four speeds, a
    demo-tools switch, the timeline, and the runs as pills.
  CHANGED FROM BEFORE: The run selector was a dropdown. Four runs in this database, so a
    dropdown hid three of them behind a click for no reason; they are now pills, and the
    one you are in is marked.
  CHANGED FROM BEFORE: The play interval used to be listed as depending on the whole
    clock object, so every tick tore the timer down and started a fresh thousand
    milliseconds. It now reads the newest state through a reference and depends only on
    whether playback is running, so a playing clock keeps one steady timer.
  CHOICES: The four step buttons became two. Moving a week is still available — drag the
    track, or hold shift with an arrow key — and the bar says so in one line of text
    rather than drawing two more buttons.
  CHOICES: The demo switch is amber rather than blue. Blue in this palette means "the
    thing you are pointing at"; this control is not a normal control, it turns the answer
    key on, and it is the only amber thing on the bar.
  ⚠ JUDGEMENT CALL: The switch keeps the jump-to-fault control available rather than
    banishing it to the answer screen entirely. Banishing it is more pure and was
    rejected: a demonstration needs to land on an interesting moment quickly, and forcing
    a detour through another screen and back to do it would make the tool worse without
    making the claim any stronger. The claim is protected by the default state, not by
    removing the capability.

`web/src/components/ControlBar.module.css` :: the bar
  CHANGED FROM BEFORE: Kept sticky at the top of the page, which was right. Gained a
    hairline along its bottom edge, because on paper the bar and the page behind it are
    nearly the same value and content scrolling underneath had nothing to disappear
    behind. The dark theme did not need this — everything behind it was darker.

START HERE: `web/src/components/Timeline.tsx` — the run drawn is the whole checkpoint,
and the bar around it is arranged to leave room for it.
