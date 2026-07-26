.PHONY: install db-up db-down load graph scenarios plots quality rules-demo mode-plot apar chiller-rules residuals baselines modes health degradation rul refusal diagnosis api web

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

# Serve the API on :8000
api:
	uv run uvicorn api.main:app --reload --port 8000

# Serve the frontend dev server
web:
	cd web && npm install && npm run dev
