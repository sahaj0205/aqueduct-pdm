# The API and the reveal service. One image, two entrypoints -- they share the whole
# analytics package and differ only in which credential they open and which app they
# serve, so building twice would be two copies of the same 400 MB of scientific Python.
FROM python:3.12-slim

# psycopg[binary] ships wheels; nothing here needs a compiler at runtime. curl is for
# the container healthchecks compose declares.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall scipy.
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.32" "pydantic>=2.9" "pydantic-settings>=2.6" \
      "sqlalchemy>=2.0" "psycopg[binary]>=3.2" "rdflib>=7.1" "numpy>=2.1" "scipy>=1.14" \
      "pandas>=2.2" "statsmodels>=0.14" "pint>=0.24" "pyyaml>=6.0" "python-dotenv>=1.0"

COPY analytics ./analytics
COPY api ./api
COPY reveal ./reveal
COPY model ./model
COPY ingestion ./ingestion
COPY simulator ./simulator
COPY scripts ./scripts

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
