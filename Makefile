.PHONY: install db-up db-down load graph scenarios plots quality rules-demo mode-plot apar chiller-rules residuals baselines modes health degradation rul refusal diagnosis rootcause advisories advisories-write advisory-replay engine-trace demo api reveal web web-verify web-verify-detail web-verify-twin web-verify-clock web-build validate

# Resolve and install the Python environment into .venv
install:
	uv sync

# Start the TimescaleDB container, wait for it, then apply the schema.
# Applying the schema here is what makes `make db-up && make load` work against
# a freshly created volume. schema.sql is idempotent, so this is safe to repeat.
db-up:
	docker compose up -d
	@echo "waiting for timescaledb..."
	@set -a; . ./.env; set +a; \
	  for i in $$(seq 1 90); do \
	    PGPASSWORD="$$POSTGRES_PASSWORD" psql -h localhost -p "$$POSTGRES_PORT" \
	      -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -tAc 'SELECT 1' >/dev/null 2>&1 \
	      && break; \
	    sleep 1; \
	    if [ $$i = 90 ]; then echo "timed out waiting for timescaledb"; exit 1; fi; \
	  done
	@echo "timescaledb ready on $$(docker compose port db 5432)"
	@set -a; . ./.env; set +a; \
	  PGPASSWORD="$$POSTGRES_PASSWORD" psql -h localhost -p "$$POSTGRES_PORT" \
	    -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -q -v ON_ERROR_STOP=1 \
	    -f scripts/schema.sql
	@echo "schema applied"

# Stop the container. The named volume is left intact.
db-down:
	docker compose down

# Load the LBNL datasets, then rebuild the asset-level edge cache from the
# semantic model. The edge rebuild has to run second: it resolves graph nodes to
# database assets through app.points, so those rows must exist first.
load:
	uv run python -m ingestion.lbnl_loader
	$(MAKE) graph

# Rebuild app.asset_edges from the Brick model. Safe to run on its own after any
# change to model/*.ttl, and much faster than a reload.
graph:
	uv run python -m model.graph

# Synthesise the degradation scenarios and write their answer key. Deliberately
# NOT part of `load`: it needs ADMIN_DATABASE_URL, which is the only credential
# allowed to write schema groundtruth, and keeping it a separate target means the
# privileged path is never invoked by a routine data refresh.
scenarios:
	uv run python -m simulator.trajectory

# Plot every scenario against the clean signal it was built from, and print the
# severity ladder and per-decile progression used to verify them.
plots:
	uv run python scripts/plot_scenario.py

# Score every reading for trustworthiness and raise sensor advisories. Covers
# the LBNL fault-free year and the whole synthesised scenario era; pass
# --from/--to to score any other window. Uses APP_RW_DATABASE_URL, like every
# other part of the detection path.
quality:
	uv run python -m analytics.quality.scoring

# Show the rule registry resolving rules to assets purely by Brick class, and
# the quality gate refusing to let a rule fire on an untrusted reading. Registers
# throwaway rules; the real ones arrive with the APAR set.
rules-demo:
	uv run python -m analytics.rules.registry

# Plot the detected AHU operating mode against the signals it came from. Defaults
# to a shoulder-season week, which is when the economizer actually has decisions
# to make. Pass --from and --days for any other window.
mode-plot:
	uv run python scripts/plot_mode.py

# Run the six APAR rules over every AHU scenario: what fired, false positives per
# asset-day on fault-free data, and a plot of firings against mode changes.
apar:
	uv run python scripts/run_apar.py

# Run the three chiller rules over every chiller scenario: what fired, the
# held-out fault check, and false positives per asset-day on fault-free data.
chiller-rules:
	uv run python scripts/run_chiller_rules.py

# Evaluate every mvn:constrainedBy residual the semantic model declares and store
# it, then plot the two air-side constraints for verification.
residuals:
	uv run python -m analytics.rules.constraints
	uv run python scripts/plot_residuals.py

# Fit every baseline an asset's Brick class declares, on the commissioning window
# at the start of each run, store observed-minus-expected for every modelled
# point, then report each fit and plot the clean run against the coil valve leak.
baselines:
	uv run python -m analytics.baselines.residual
	uv run python scripts/plot_baselines.py

# Evaluate every degradation indicator app.failure_modes declares, across every
# run and asset, and plot each one against the clean run it should not move on.
# Reads the modes from the database, so seeding a new one needs no code change.
modes:
	uv run python scripts/run_modes.py

# Build the health index for every asset on every run, store it, and score the
# onset detection against the answer key. This is the one target that touches
# schema groundtruth, and only after every number it scores has been written --
# the health computation itself runs as app_rw, which cannot read that schema.
health:
	uv run python scripts/run_health.py

# Fit the stochastic degradation process to every mode whose onset has been
# confirmed, replayed at three points in time, and report whether the belief about
# the degradation rate narrows as evidence accumulates. Reads app.health_state and
# app.failure_modes only; writes nothing.
degradation:
	uv run python scripts/run_degradation.py

# Estimate remaining useful life for every mode on every run, recomputed at every
# date from data available that date, store the full history in app.rul_estimates,
# and score the median prediction against the answer key. Like `health`, the only
# ground-truth read happens after every number it scores has been written.
rul:
	uv run python scripts/run_rul.py

# Show the refusal layer declining to predict and giving the specific reason: the
# first two weeks of every progressive scenario, the whole of both fault-free runs,
# the named upstream false alarms, and the asset roll-up before and after the policy.
refusal:
	uv run python scripts/run_refusal.py

# Classify every scenario's fault as sensor, equipment, control or ambiguous, with
# the evidence attached. The key test is printed first: a drifting supply air sensor
# and a leaking coil valve present identically and must come out differently.
diagnosis:
	uv run python scripts/run_diagnosis.py

# Build the advisory queue and trace every open fault upstream across the chilled
# water loop. Prints three queues: two on unmodified data where the plausibility map
# declines to link anything, and the chiller-fouling scenario where the air handler
# advisory is marked consequential, linked to the chiller and ranked below it.
rootcause:
	uv run python scripts/run_rootcause.py

# Build the full advisory queue and print three advisories end to end -- one
# equipment, one sensor which is also the demoted consequential one, and one more
# equipment. Every number shown traces to a query or a computation, and the report
# checks field by field that nothing arrived empty without a reason.
advisories:
	uv run python scripts/run_advisories.py

# The same queue, stored in app.advisories, which is what the API serves. Kept separate
# from `advisories` because that target is a report and this one writes: nothing else in
# the project puts rows in that table, so without this the API has an empty queue and the
# dashboard comes up blank on a freshly built database.
advisories-write:
	uv run python scripts/run_advisories.py --write

# Empty database to demo-ready, in dependency order. Each step needs the one before it:
# the loader has to place measurements before the graph can resolve nodes to assets, the
# quality scores gate what the baselines may fit on, health needs the residuals, the
# remaining-life replay needs health, and the advisory queue needs both plus the
# cross-asset pass. Takes a while -- the two rule sweeps and the daily replay are the
# expensive parts -- and is the sequence the README's setup section documents.
demo: db-up load scenarios quality residuals baselines health rul advisories-write
	@echo ""
	@echo "demo data ready. now run 'make api' and 'make web' in two terminals."

# Serve the API on :8000
api:
	uv run uvicorn api.main:app --reload --port 8000

# Serve the reveal API on :8002 -- the answer key, on the admin credential, in its own
# process. 8002 and not 8001: 8001 is a common default and was already taken on the
# machine this was built on, and a demo that fails to start because something unrelated
# holds a port is a bad way to open a meeting.
# Deliberately a second application rather than three more routes on `api`:
# that process connects as app_rw, which has no grant of any kind on schema groundtruth,
# and keeping it that way is the whole basis of the claim that no detector here can have
# seen the label it is scored against. Run alongside `api` for the demo.
reveal:
	uv run uvicorn reveal.main:app --reload --port 8002

# Serve the frontend dev server on :5173. Needs `make api` running in another
# terminal -- the dev server proxies /api to :8000, so nothing in the frontend
# knows a hostname and no browser request is ever cross-origin.
web:
	cd web && npm install && npm run dev

# Render the advisory queue to the terminal through the SAME formatting module the
# React components use, and check the properties the queue has to have: priced rows
# above unpriced, every consequential advisory below its own cause, and no unpriced
# advisory displayed as 0.00. This is how the dashboard is verified without a browser.
web-verify:
	cd web && npm run verify

# Verify the fan chart's data through the same module the chart renders from: that no
# band is drawn for a refused prediction, that every closing percentage rests on at
# least two bounded intervals, and how far each series' interval actually closes.
# Prints the interval per date as a bar so the narrowing is readable in a terminal.
web-verify-detail:
	cd web && npm run verify:detail

# Render the digital twin with live data OUTSIDE a browser, check its geometry, and write
# it to docs/plots/digital_twin.svg. An SVG is text, so that file is a reproducible
# screenshot rather than a description. Checks the things a drawing of a building can
# actually get wrong: a node placed left of something that feeds it, two boxes on top of
# each other, an edge pointing at a node that was not drawn, and any colour claiming
# knowledge the data does not support. Needs `make api`.
web-verify-twin:
	cd web && npm run verify:twin

# Check the clock outside a browser: that every run is reachable and self-consistent,
# that stepping never leaves a run into the empty years between them, that the scrubber
# round-trips, and that every severity rung maps to a date inside its own fault's life.
# The clock decides what moment EVERY screen renders, so an error here is invisible in a
# screenshot -- the dashboard would just be showing a different day than it says.
# Needs `make api`; the severity half is skipped unless `make reveal` is also running.
web-verify-clock:
	cd web && npm run verify:clock

# Typecheck and production-build the frontend.
web-build:
	cd web && npm run build

# Rebuild the advisory queue once per DAY across every era and keep every day, so the
# dashboard can put its clock at any date and show what was on the operator's screen
# that morning. Additive and resumable: unlike `advisories-write`, which owns the one
# snapshot it writes and empties the table first, this upserts per day. Run it AFTER
# `advisories-write`, never before, or the snapshot delete takes the history with it.
# Takes about three hours over 619 days; --resume picks up where a killed run stopped.
advisory-replay:
	uv run python scripts/run_advisory_replay.py --resume

# Record what the detection pipeline did on every machine on every day as a ten-stage
# funnel, into app.engine_trace. This is what the engine screen reads: not what the
# system concluded, but everything it declined to conclude and why -- a reading nobody
# trusts, a machine that is not running, an hour after a start, a rule briefly true
# during a gust. MUST RUN AFTER advisory-replay: the last stage reports which findings
# reached the operator, and reads app.advisories to do it, so running it first records
# zero advisories on every day. Resumable.
engine-trace:
	uv run python -u scripts/run_engine_trace.py --resume

# Run every scenario end to end, score every detection against the answer key, and
# regenerate VALIDATION.md. The document is overwritten in place on every run and no
# number in it is written by hand. This is the one target besides `scenarios` that
# needs ADMIN_DATABASE_URL, and it opens it only after every finding has been produced
# over the restricted connection.
validate:
	uv run python -m validation.harness
