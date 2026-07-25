-- =====================================================================
-- Aqueduct PDM — database schema
--
-- Apply with:   psql "$DATABASE_URL_LIBPQ" -v ON_ERROR_STOP=1 -f scripts/schema.sql
-- Idempotent: every object is created IF NOT EXISTS, so re-applying is safe.
--
-- NOTE: this file uses psql client features (\set, backtick substitution) and
-- must be run through psql, not through a generic SQL driver. Continuous
-- aggregates and TimescaleDB policy functions also cannot run inside an
-- explicit transaction block, which is why there is no BEGIN/COMMIT wrapper.
-- =====================================================================

-- Password for the restricted application role. Taken from the environment so
-- no credential is committed; falls back to a local-development value.
\set app_rw_password `echo "${APP_RW_PASSWORD:-app_rw_local_dev}"`

CREATE EXTENSION IF NOT EXISTS timescaledb;


-- =====================================================================
-- SCHEMAS
--
-- The separation between these two schemas is the central integrity
-- guarantee of this project, not an organisational nicety. See the comment
-- on the groundtruth schema below.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS groundtruth;

COMMENT ON SCHEMA app IS
    'Observable state. Everything here is what a real building automation '
    'system would expose: equipment, sensor points, and their readings. All '
    'detection, baseline, health and prediction code reads from here and only '
    'here.';

COMMENT ON SCHEMA groundtruth IS
    'The answer key. Holds the fault labels shipped with the LBNL datasets: '
    'which fault was injected, at what severity, and when it started. '
    'DETECTION CODE CANNOT READ THIS SCHEMA, BY DESIGN. The app_rw role that '
    'the ingestion, rule engine, baseline, health, RUL and diagnosis layers '
    'connect as is granted USAGE on schema app only, and is deliberately '
    'granted nothing here — see the GRANTS section at the end of this file. '
    'The reason is that this project claims its accuracy numbers are computed '
    'against third-party labels it did not create. If the detection path could '
    'read these tables, that claim would be unverifiable by inspection: a rule '
    'threshold could be tuned against the answer key, accidentally or '
    'otherwise, and nothing in the code would look wrong. Enforcing it at the '
    'database privilege level means leakage fails loudly with "permission '
    'denied" rather than passing review. Only the validation layer, which runs '
    'after detection has committed its output, connects with a role that can '
    'read both schemas and join them to score results.';


-- =====================================================================
-- APP — equipment and sensor points
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.assets (
    asset_id              TEXT        PRIMARY KEY,
    brick_class           TEXT        NOT NULL,
    name                  TEXT        NOT NULL,
    criticality_tier      SMALLINT    NOT NULL
                                      CHECK (criticality_tier BETWEEN 1 AND 3),
    replacement_cost_usd  NUMERIC(12,2)
                                      CHECK (replacement_cost_usd >= 0),
    install_date          DATE
);

COMMENT ON TABLE  app.assets IS
    'One row per piece of equipment. For this project: one air handling unit '
    'and one chiller plant.';
COMMENT ON COLUMN app.assets.brick_class IS
    'Brick Schema class of the equipment, e.g. brick:Air_Handling_Unit. Ties '
    'this row to a node in the semantic graph so the graph and the relational '
    'store agree on what a thing is.';
COMMENT ON COLUMN app.assets.criticality_tier IS
    '1 = most critical, 3 = least. Drives advisory ranking: two assets '
    'degrading at the same rate are not equally urgent.';
COMMENT ON COLUMN app.assets.replacement_cost_usd IS
    'Used by the advisory layer to weigh a repair against a replacement. '
    'Nullable because it is a business input, not a measurement.';

CREATE TABLE IF NOT EXISTS app.points (
    point_id           TEXT      PRIMARY KEY,
    asset_id           TEXT      NOT NULL
                                 REFERENCES app.assets(asset_id)
                                 ON DELETE CASCADE,
    brick_class        TEXT      NOT NULL,
    name               TEXT      NOT NULL,
    unit_native        TEXT      NOT NULL,
    unit_si            TEXT      NOT NULL,
    expected_min       DOUBLE PRECISION,
    expected_max       DOUBLE PRECISION,
    max_roc_per_min    DOUBLE PRECISION
                                 CHECK (max_roc_per_min IS NULL
                                        OR max_roc_per_min > 0),
    sample_interval_s  INTEGER   CHECK (sample_interval_s IS NULL
                                        OR sample_interval_s > 0),
    CHECK (expected_min IS NULL
           OR expected_max IS NULL
           OR expected_min < expected_max)
);

CREATE INDEX IF NOT EXISTS points_asset_id_idx ON app.points (asset_id);

COMMENT ON TABLE  app.points IS
    'One row per sensor or setpoint on a piece of equipment. This is the '
    'catalogue the quality scorer, rule engine and baseline fitter all read to '
    'find out what a stream of numbers actually means.';
COMMENT ON COLUMN app.points.unit_native IS
    'Unit as it appears in the source CSV, e.g. degF. Kept so a value can '
    'always be traced back to the raw file.';
COMMENT ON COLUMN app.points.unit_si IS
    'Unit everything is converted to on ingest, e.g. degC. Every value in '
    'app.measurements is in this unit, so physics rules never have to ask what '
    'unit they are looking at.';
COMMENT ON COLUMN app.points.expected_min IS
    'Physically plausible lower bound in SI units. A reading outside '
    '[expected_min, expected_max] is a broken sensor, not a fault — the '
    'quality scorer flags it so the rule engine does not treat it as signal.';
COMMENT ON COLUMN app.points.max_roc_per_min IS
    'Maximum believable rate of change, in SI units per minute. Thermal mass '
    'means a real air temperature cannot jump 20 degrees in one sample; if it '
    'does, the sensor glitched. Nullable for points where no sane bound exists.';
COMMENT ON COLUMN app.points.sample_interval_s IS
    'Expected seconds between readings. Used to detect gaps — a missing hour '
    'is only detectable if the expected cadence is known.';


-- =====================================================================
-- APP — measurements hypertable
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.measurements (
    time           TIMESTAMPTZ      NOT NULL,
    point_id       TEXT             NOT NULL
                                    REFERENCES app.points(point_id)
                                    ON DELETE CASCADE,
    value_si       DOUBLE PRECISION,
    quality_score  SMALLINT         CHECK (quality_score IS NULL
                                           OR quality_score BETWEEN 0 AND 100),
    quality_flags  JSONB
);

SELECT create_hypertable(
    'app.measurements',
    by_range('time', INTERVAL '1 day'),
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS measurements_point_time_idx
    ON app.measurements (point_id, time DESC);

COMMENT ON TABLE  app.measurements IS
    'Every sensor reading, one row each, already converted to SI units. '
    'Partitioned into one-day chunks by time.';
COMMENT ON COLUMN app.measurements.value_si IS
    'The reading, in the unit named by app.points.unit_si. Nullable so a known '
    'gap can be recorded explicitly rather than inferred from absence.';
COMMENT ON COLUMN app.measurements.quality_score IS
    '0-100 trust score written by the quality layer after ingest. NULL means '
    'not yet scored, which is distinct from scored-as-zero.';
COMMENT ON COLUMN app.measurements.quality_flags IS
    'Which specific quality checks this reading failed, as JSON, so a low '
    'score can be explained rather than just asserted.';


-- =====================================================================
-- APP — hourly rollup
-- =====================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS app.measurements_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '1 hour', time)  AS bucket,
    point_id,
    avg(value_si)                         AS avg_value_si,
    min(value_si)                         AS min_value_si,
    max(value_si)                         AS max_value_si,
    stddev_samp(value_si)                 AS stddev_value_si,
    count(value_si)                       AS sample_count
FROM app.measurements
GROUP BY bucket, point_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'app.measurements_hourly',
    start_offset      => NULL,
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE
);

-- A continuous aggregate is created with CREATE MATERIALIZED VIEW but is
-- registered in the catalogue as an ordinary view over TimescaleDB's internal
-- materialisation hypertable, so this must be COMMENT ON VIEW.
COMMENT ON VIEW app.measurements_hourly IS
    'One row per point per hour: mean, min, max, sample standard deviation and '
    'count of the readings in that hour. Baselines and health trends are fitted '
    'on hourly data, not raw samples — at a one-minute cadence a year of one '
    'point is half a million rows, and fitting on that is slow without being '
    'more accurate. min and max are kept alongside the mean because a spike '
    'that averages away still matters, and stddev because a widening spread is '
    'itself an early degradation signal.';


CREATE TABLE IF NOT EXISTS app.asset_edges (
    from_asset    TEXT     NOT NULL
                           REFERENCES app.assets(asset_id)
                           ON DELETE CASCADE,
    to_asset      TEXT     NOT NULL
                           REFERENCES app.assets(asset_id)
                           ON DELETE CASCADE,
    relation      TEXT     NOT NULL
                           CHECK (relation IN ('feeds', 'hasPart')),
    hop_distance  SMALLINT NOT NULL
                           CHECK (hop_distance > 0),
    PRIMARY KEY (from_asset, to_asset, relation),
    CHECK (from_asset <> to_asset)
);

COMMENT ON TABLE app.asset_edges IS
    'The semantic graph flattened to asset-level reachability, so SQL can answer '
    '"what is upstream of this" without loading the RDF graph. Rebuilt from '
    'scratch by model.graph on every load — it is a derived cache, never edited '
    'by hand, and nothing should write to it except that regeneration. It exists '
    'because the diagnosis layer joins fault and health data against topology in '
    'the same query, and a SPARQL round trip per row would make that unusable.';

COMMENT ON COLUMN app.asset_edges.relation IS
    'feeds = what flows, so what a fault propagates along. hasPart = containment, '
    'so which machine a symptom rolls up to. Both directions are stored '
    'explicitly rather than inferred, because reading a row should not require '
    'knowing which way round the predicate was defined.';

COMMENT ON COLUMN app.asset_edges.hop_distance IS
    'Shortest number of graph edges between the two assets, counting equipment '
    'the database does not model as an asset — the two water loops in '
    'building_extensions.ttl are each one hop. This is a transitive closure, not '
    'an adjacency list: a cooling tower reaches the air handler at four hops '
    'through a chiller, and that row is present. Root cause search uses the '
    'distance to prefer near causes over far ones.';

-- Self-edges are excluded by the CHECK above. They would otherwise be the most
-- common row in the table and carry no information: the database models one air
-- handler as a single asset while the graph models its coil, fans, dampers and
-- five zones separately, so every internal AHU relation collapses to
-- ahu-1 -> ahu-1.


-- =====================================================================
-- GROUNDTRUTH — the answer key
-- =====================================================================

CREATE TABLE IF NOT EXISTS groundtruth.scenarios (
    scenario_id     TEXT         PRIMARY KEY,
    system          TEXT         NOT NULL,
    source_file     TEXT         NOT NULL,
    is_fault_free   BOOLEAN      NOT NULL,
    t_start         TIMESTAMPTZ,
    t_end           TIMESTAMPTZ,
    notes           TEXT,
    CHECK (t_start IS NULL OR t_end IS NULL OR t_start < t_end)
);

COMMENT ON TABLE groundtruth.scenarios IS
    'One row per source CSV. The LBNL datasets ship each fault at each '
    'severity as its own simulation run over the same period, plus a '
    'fault-free run. Recording the run a reading came from is what lets '
    'validation ask "on this specific run, did we fire?" instead of mixing '
    'independent simulations together.';
COMMENT ON COLUMN groundtruth.scenarios.system IS
    'Which of the two LBNL systems this run belongs to: the single-duct air '
    'handling unit, or the chiller plant.';
COMMENT ON COLUMN groundtruth.scenarios.is_fault_free IS
    'TRUE for the baseline run with no fault injected. These runs are the '
    'false-positive test: any detection firing here is wrong by definition.';

CREATE TABLE IF NOT EXISTS groundtruth.fault_events (
    event_id        BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scenario_id     TEXT         NOT NULL
                                 REFERENCES groundtruth.scenarios(scenario_id)
                                 ON DELETE CASCADE,
    asset_id        TEXT         NOT NULL,
    fault_mode      TEXT         NOT NULL,
    severity_level  TEXT         NOT NULL,
    t_onset         TIMESTAMPTZ  NOT NULL,
    t_failure       TIMESTAMPTZ,
    params          JSONB,
    CHECK (t_failure IS NULL OR t_onset <= t_failure)
);

CREATE INDEX IF NOT EXISTS fault_events_scenario_idx
    ON groundtruth.fault_events (scenario_id);
CREATE INDEX IF NOT EXISTS fault_events_asset_onset_idx
    ON groundtruth.fault_events (asset_id, t_onset);

COMMENT ON TABLE groundtruth.fault_events IS
    'One row per injected fault. This is what detections are scored against: '
    'a detection is a true positive only if it names this fault mode on this '
    'asset after t_onset.';
COMMENT ON COLUMN groundtruth.fault_events.asset_id IS
    'Which asset the fault was injected into. Deliberately NOT a foreign key '
    'to app.assets — a foreign key would require this schema to depend on the '
    'app schema, and the point of the separation is that groundtruth can be '
    'dropped entirely without the detection path noticing.';
COMMENT ON COLUMN groundtruth.fault_events.severity_level IS
    'Severity as the dataset expresses it, kept as text rather than a number '
    'because the LBNL naming is not known to be numeric or ordinal until the '
    'data reconnaissance in checkpoint 1.4 says so.';
COMMENT ON COLUMN groundtruth.fault_events.t_onset IS
    'When the fault was injected. Detection latency is measured from here, so '
    'this is the single most important column in the schema for scoring.';
COMMENT ON COLUMN groundtruth.fault_events.t_failure IS
    'When the equipment would be considered failed. NULL where the dataset '
    'does not run to failure, which is expected for most of these runs.';
COMMENT ON COLUMN groundtruth.fault_events.params IS
    'Fault-specific parameters as JSON — the degree of a valve leak, the '
    'percentage of fouling — which differ per fault mode and so do not fit '
    'fixed columns.';


-- =====================================================================
-- GRANTS
--
-- app_rw is the role every part of the detection path connects as. The
-- asymmetry below is the enforcement of the design note on schema
-- groundtruth: USAGE on app, nothing whatsoever on groundtruth.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw LOGIN;
    END IF;
END
$$;

ALTER ROLE app_rw WITH LOGIN PASSWORD :'app_rw_password';

COMMENT ON ROLE app_rw IS
    'Read/write on schema app, no access at all to schema groundtruth. Used by '
    'ingestion, quality scoring, rules, baselines, health, RUL and diagnosis.';

-- --- app: full read/write ---
GRANT USAGE ON SCHEMA app TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;

-- Tables added to schema app later are covered automatically, so a future
-- migration cannot accidentally leave the detection path unable to read.
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
    GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- --- groundtruth: nothing, stated explicitly ---
-- A new schema grants nothing to PUBLIC by default, so these REVOKEs are
-- belt-and-braces. They are here so that the intent is legible in the file
-- and so that a later accidental GRANT ... TO PUBLIC is undone on re-apply.
REVOKE ALL ON SCHEMA groundtruth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA groundtruth FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA groundtruth FROM PUBLIC;
REVOKE ALL ON SCHEMA groundtruth FROM app_rw;
REVOKE ALL ON ALL TABLES IN SCHEMA groundtruth FROM app_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA groundtruth FROM app_rw;
