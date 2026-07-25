.PHONY: install db-up db-down load graph api web

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

# Serve the API on :8000
api:
	uv run uvicorn api.main:app --reload --port 8000

# Serve the frontend dev server
web:
	cd web && npm install && npm run dev
