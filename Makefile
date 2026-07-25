.PHONY: install db-up db-down load api web

# Resolve and install the Python environment into .venv
install:
	uv sync

# Start the TimescaleDB container and wait for it to accept connections
db-up:
	docker compose up -d
	@echo "waiting for timescaledb..."
	@until docker compose exec -T db pg_isready -q; do sleep 1; done
	@echo "timescaledb ready on $$(docker compose port db 5432)"

# Stop the container. The named volume is left intact.
db-down:
	docker compose down

# Load the LBNL datasets into the database
load:
	uv run python -m ingestion.lbnl_loader

# Serve the API on :8000
api:
	uv run uvicorn api.main:app --reload --port 8000

# Serve the frontend dev server
web:
	cd web && npm install && npm run dev
