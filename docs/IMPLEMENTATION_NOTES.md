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
