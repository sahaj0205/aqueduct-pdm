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
-- APP — sensor advisories
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.sensor_advisories (
    advisory_id   BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    point_id      TEXT         NOT NULL
                               REFERENCES app.points(point_id)
                               ON DELETE CASCADE,
    kind          TEXT         NOT NULL
                               CHECK (kind IN ('flatline', 'out_of_range',
                                               'stale', 'dropout')),
    t_from        TIMESTAMPTZ  NOT NULL,
    t_to          TIMESTAMPTZ  NOT NULL,
    worst_score   SMALLINT     NOT NULL
                               CHECK (worst_score BETWEEN 0 AND 100),
    sample_count  INTEGER      NOT NULL CHECK (sample_count > 0),
    detail        JSONB,
    UNIQUE (point_id, kind, t_from),
    CHECK (t_from <= t_to)
);

CREATE INDEX IF NOT EXISTS sensor_advisories_point_time_idx
    ON app.sensor_advisories (point_id, t_from DESC);
CREATE INDEX IF NOT EXISTS sensor_advisories_kind_idx
    ON app.sensor_advisories (kind);

COMMENT ON TABLE app.sensor_advisories IS
    'Findings about INSTRUMENTS, not about equipment. A dead thermistor and a '
    'failing chiller both make the numbers look wrong, and conflating them is '
    'the classic way a fault detection system loses its users: it reports a '
    'chiller fault, someone opens the machine, and the actual problem was a '
    '20 dollar sensor. Everything in this table is a statement about whether a '
    'reading can be believed. Nothing in it is a statement about whether the '
    'machine is healthy. The rule engine reads the quality score these rows '
    'accompany and declines to fire when its inputs are untrustworthy, so a '
    'sensor failure surfaces here instead of being reported as an equipment '
    'fault.';

COMMENT ON COLUMN app.sensor_advisories.kind IS
    'flatline = the reading stopped moving entirely while its equipment was '
    'running and it was not parked at the end of its scale. stale = it is still '
    'moving but by far less than that kind of sensor should. out_of_range = it '
    'left the physically possible envelope in app.points. dropout = samples '
    'stopped arriving at the expected cadence.';

COMMENT ON COLUMN app.sensor_advisories.t_from IS
    'Start of one continuous episode. Rows are episodes, not samples: a sensor '
    'dead for a month is one row, not 8,640. Without that collapse this table '
    'would be larger than the measurements it describes.';

COMMENT ON COLUMN app.sensor_advisories.worst_score IS
    'The lowest score the offending dimension reached during the episode, so '
    'two advisories of the same kind can be ranked against each other.';

COMMENT ON COLUMN app.sensor_advisories.detail IS
    'Evidence for the finding, as JSON: which dimension triggered, and the '
    'actual values involved -- the bound that was crossed and by how much, or '
    'the value the reading was stuck at. An advisory a technician cannot act on '
    'without re-querying the raw data has failed at its job.';


-- =====================================================================
-- APP — constraint residuals
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.constraint_residuals (
    time           TIMESTAMPTZ       NOT NULL,
    constraint_id  TEXT              NOT NULL,
    residual       DOUBLE PRECISION,
    normalised     DOUBLE PRECISION,
    unit           TEXT,
    input_quality  SMALLINT          CHECK (input_quality IS NULL
                                            OR input_quality BETWEEN 0 AND 100),
    UNIQUE (constraint_id, time)
);

SELECT create_hypertable(
    'app.constraint_residuals',
    by_range('time', INTERVAL '7 days'),
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS constraint_residuals_id_time_idx
    ON app.constraint_residuals (constraint_id, time DESC);

COMMENT ON TABLE app.constraint_residuals IS
    'How far the building is from obeying its own physics, one row per '
    'constraint per instant. Each row answers a question of the form "mixed air '
    'temperature should be the blend of outdoor and return air — how far off is '
    'it?". A rule says a machine is behaving badly; a residual says a set of '
    'readings cannot all be true at once, without yet saying which one is '
    'lying. That distinction is what the sensor-versus-equipment discrimination '
    'in Task 5 is built on: a broken sensor breaks every constraint it appears '
    'in and leaves the others intact, while a broken machine moves whole groups '
    'of constraints together.';

COMMENT ON COLUMN app.constraint_residuals.constraint_id IS
    'Local name of the mvn:Constraint in the semantic model, e.g. '
    'MixedAirBalance. The expression evaluated is mvn:residualExpression on '
    'that node, so this column is the join back to the physics that produced '
    'the number.';

COMMENT ON COLUMN app.constraint_residuals.residual IS
    'The raw imbalance, in the natural unit of the expression — degrees for the '
    'air-side balances, watts for the chiller energy balances. Kept unscaled so '
    'the number stays physically interpretable: three degrees of mixed air '
    'error means three degrees, whatever the normalisation says.';

COMMENT ON COLUMN app.constraint_residuals.normalised IS
    'The raw residual restated as a robust standard-score against how that same '
    'constraint behaves during fault-free operation: the fault-free median '
    'subtracted, then divided by a spread estimated from the median absolute '
    'deviation. Needed because the raw residuals are not comparable — one is in '
    'degrees and sits near zero, another is in watts and sits near a hundred '
    'thousand — and a diagnosis has to rank them against each other. Robust '
    'statistics rather than mean and standard deviation because the fault-free '
    'run still contains outliers and a single excursion would otherwise inflate '
    'the scale and hide everything after it.';

COMMENT ON COLUMN app.constraint_residuals.input_quality IS
    'The LOWEST quality score among the readings the expression consumed. A '
    'residual is only as trustworthy as its worst input, and without this a '
    'diagnosis could not tell a genuine violation of physics from one sensor '
    'having died.';


-- =====================================================================
-- APP — baseline residuals
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.residuals (
    time           TIMESTAMPTZ       NOT NULL,
    point_id       TEXT              NOT NULL
                                     REFERENCES app.points(point_id)
                                     ON DELETE CASCADE,
    baseline_id    TEXT              NOT NULL,
    observed       DOUBLE PRECISION,
    expected       DOUBLE PRECISION,
    residual       DOUBLE PRECISION,
    normalised     DOUBLE PRECISION,
    input_quality  SMALLINT          CHECK (input_quality IS NULL
                                            OR input_quality BETWEEN 0 AND 100),
    UNIQUE (point_id, baseline_id, time)
);

-- Seven-day chunks, not the one-day interval app.measurements uses. That
-- interval is the technical debt recorded in AI_LOG.md entry D-01: this project
-- holds several thousand days of simulated time, so daily chunks produce
-- thousands of them and a query that forgets its time range spends over half a
-- minute in the planner before reading a row.
SELECT create_hypertable(
    'app.residuals',
    by_range('time', INTERVAL '7 days'),
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS residuals_baseline_time_idx
    ON app.residuals (baseline_id, time DESC);

COMMENT ON TABLE app.residuals IS
    'How far a modelled point sits from what its own operating conditions say it '
    'should be, one row per point per instant. A fixed threshold on a raw signal '
    'fires whenever conditions are unusual rather than when the equipment is '
    'unhealthy -- a fan drawing 900 watts is alarming at low airflow and '
    'unremarkable at high airflow, and a threshold cannot tell the two apart. '
    'Subtracting a baseline fitted against the drivers removes the part of the '
    'signal that operating conditions explain, and what is left is the part that '
    'has to be explained by the state of the machine. Everything from the health '
    'index onward consumes these rows rather than the raw measurements.';

COMMENT ON COLUMN app.residuals.baseline_id IS
    'Which fitted model produced the expectation, e.g. '
    'ahu-1.sf_power.fan-similarity. A point can carry more than one baseline, so '
    'this is part of the key: without it a second model of the same sensor would '
    'silently overwrite the first.';

COMMENT ON COLUMN app.residuals.expected IS
    'What the baseline predicted at this instant given the drivers measured at '
    'this instant. Stored alongside the observation rather than only the '
    'difference, because an engineer asked to trust a residual will want to see '
    'both numbers that produced it.';

COMMENT ON COLUMN app.residuals.residual IS
    'observed minus expected, in the natural unit of the point -- watts for fan '
    'power, degrees for supply air temperature. Kept unscaled so it stays '
    'physically interpretable.';

COMMENT ON COLUMN app.residuals.normalised IS
    'The residual restated as robust standard deviations of how that same '
    'baseline scattered across its own fit window: the fit-window median '
    'subtracted, then divided by a spread from the median absolute deviation. '
    'Needed because a 200 watt fan residual and a 2 degree temperature residual '
    'are not comparable until both are expressed against their own noise.';

COMMENT ON COLUMN app.residuals.input_quality IS
    'Lowest quality score among the readings that went into the prediction and '
    'the observation, ignoring the staleness dimension. A residual is only as '
    'trustworthy as its worst input.';


-- =====================================================================
-- APP — failure modes
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.failure_modes (
    mode_id               TEXT              PRIMARY KEY,
    brick_class           TEXT              NOT NULL,
    mode_name             TEXT              NOT NULL,
    indicator_expression  TEXT,
    applies_when          TEXT,
    failure_threshold     DOUBLE PRECISION  NOT NULL CHECK (failure_threshold > 0),
    indicator_unit        TEXT              NOT NULL,
    threshold_rationale   TEXT              NOT NULL CHECK (length(threshold_rationale) > 40),
    degradation_process   TEXT              NOT NULL DEFAULT 'wiener'
                                            CHECK (degradation_process
                                                   IN ('wiener', 'gamma')),
    penalty_kw_per_unit   DOUBLE PRECISION  CHECK (penalty_kw_per_unit IS NULL
                                                   OR penalty_kw_per_unit > 0),
    penalty_basis         TEXT,
    CHECK (penalty_kw_per_unit IS NULL OR length(penalty_basis) > 40)
);

-- Added in checkpoint 5.1, after this table already existed in the running
-- database. CREATE TABLE IF NOT EXISTS silently does nothing to a table that is
-- already there, so the column has to be added separately for the file to stay
-- idempotent against both a fresh volume and an existing one. The DEFAULT is
-- what makes the ADD COLUMN safe on rows that predate the column.
ALTER TABLE app.failure_modes
    ADD COLUMN IF NOT EXISTS degradation_process TEXT NOT NULL DEFAULT 'wiener';
ALTER TABLE app.failure_modes
    DROP CONSTRAINT IF EXISTS failure_modes_degradation_process_check;
ALTER TABLE app.failure_modes
    ADD CONSTRAINT failure_modes_degradation_process_check
    CHECK (degradation_process IN ('wiener', 'gamma'));

-- Added in checkpoint 6.2, for the same reason and by the same means. No DEFAULT:
-- both columns are legitimately NULL for a mode whose cost is not electrical.
ALTER TABLE app.failure_modes
    ADD COLUMN IF NOT EXISTS penalty_kw_per_unit DOUBLE PRECISION;
ALTER TABLE app.failure_modes
    ADD COLUMN IF NOT EXISTS penalty_basis TEXT;
ALTER TABLE app.failure_modes
    DROP CONSTRAINT IF EXISTS failure_modes_penalty_basis_check;
ALTER TABLE app.failure_modes
    ADD CONSTRAINT failure_modes_penalty_basis_check
    CHECK (penalty_kw_per_unit IS NULL OR length(penalty_basis) > 40);

COMMENT ON TABLE app.failure_modes IS
    'One row per distinct way a class of equipment can fail. A chiller does not '
    'just "degrade" -- it fouls its condenser, or loses charge, or both at once, '
    'and each of those is measured by a different number and reaches failure at a '
    'different value. Keeping them in a table rather than in Python is what makes '
    'adding a failure mode a database row: the health index reads this table at '
    'startup and loops over whatever it finds, so a mode nobody has thought of '
    'yet needs an INSERT and no code change.';

COMMENT ON COLUMN app.failure_modes.brick_class IS
    'Which class of equipment this mode applies to, e.g. brick:Chiller. Resolved '
    'through Brick''s taxonomy, so a mode written against brick:Chiller reaches '
    'every asset whose class is a kind of chiller, and three chillers need one '
    'row rather than three.';

COMMENT ON COLUMN app.failure_modes.indicator_expression IS
    'Arithmetic that computes the degradation number, over {point:...} for a raw '
    'measurement and {residual:...} for a baseline residual, with @asset standing '
    'in for the asset being evaluated. WRITTEN SO THAT LARGER IS ALWAYS WORSE and '
    'zero is healthy, whatever the underlying physics does -- the health index '
    'maps the indicator onto 0 to 100 and cannot do that if some modes count up '
    'and others count down. NULL means the mode is real but this building cannot '
    'measure it; the threshold and rationale are still recorded so the gap is '
    'documented rather than forgotten.';

COMMENT ON COLUMN app.failure_modes.applies_when IS
    'Optional condition restricting the instants at which the indicator means '
    'anything. A cooling coil that leaks is only detectable while its valve is '
    'commanded shut -- when the valve is modulating the controller absorbs the '
    'leak and there is nothing to see. Kept separate from the indicator rather '
    'than folded into it because a gate and a measurement are different things, '
    'and because it lets the indicator language stay pure arithmetic with no '
    'comparisons in it.';

COMMENT ON COLUMN app.failure_modes.failure_threshold IS
    'The indicator value at which the equipment counts as failed, in '
    'indicator_unit. This is what the remaining-life estimate predicts the '
    'crossing of, so it has to be a number that means something physically or '
    'economically -- a prediction of when a made-up number will cross another '
    'made-up number is not a prediction of anything.';

COMMENT ON COLUMN app.failure_modes.threshold_rationale IS
    'Why that value and not another, in physical or economic terms. Required, '
    'not optional, and checked to be more than a token: a threshold can never be '
    'entered into this table without a justification recorded beside it.';

COMMENT ON COLUMN app.failure_modes.penalty_kw_per_unit IS
    'Electrical power wasted, in kilowatts, per one unit of this mode''s indicator. '
    'The bridge from a physical degradation number to money: the advisory layer '
    'multiplies the current indicator by this to get the excess kilowatts the fault '
    'is drawing right now, then by the hours it is actually running and the '
    'electricity tariff in the semantic model. Without it a cost of inaction would '
    'have to be guessed, and the whole priority ranking would rest on the guess. '
    'NULL where the mode genuinely has no electrical cost -- a plant losing '
    'refrigerant charge draws LESS power, not more, because it is failing to make '
    'the water rather than paying to make it, and its real cost is lost comfort '
    'which this building does not price. NULL is therefore a statement, not a gap.';

COMMENT ON COLUMN app.failure_modes.penalty_basis IS
    'How penalty_kw_per_unit was arrived at, including the operating point it was '
    'measured at. Required whenever the coefficient is present and checked to be '
    'more than a token, on the same principle as threshold_rationale: a number that '
    'converts degrees into dollars can never enter this table without the arithmetic '
    'recorded beside it. Every coefficient here was measured on a fault-free run '
    'rather than assumed from a handbook.';

COMMENT ON COLUMN app.failure_modes.degradation_process IS
    'Which stochastic process the remaining-life layer fits to this mode''s '
    'indicator once degradation has been confirmed. ''wiener'' is Brownian motion '
    'with drift: the indicator trends one way but individual days may move either '
    'way, which is right for an indicator that is a noisy readout of a state '
    'rather than the state itself. ''gamma'' is a pure-jump process whose '
    'increments cannot be negative, which is right only where the underlying '
    'physical quantity can genuinely only accumulate -- deposit on a tube, dust in '
    'a filter, refrigerant that has left the circuit. Choosing gamma where the '
    'indicator can honestly fall means the model assigns zero probability to '
    'something that is observed, so this is a per-mode physical statement and '
    'deliberately not a global setting.';


-- --- seed -------------------------------------------------------------
-- ON CONFLICT DO UPDATE rather than DO NOTHING, so correcting a rationale here
-- and re-applying the schema actually corrects it in the database.

INSERT INTO app.failure_modes (mode_id, brick_class, mode_name, indicator_expression,
                               applies_when, failure_threshold, indicator_unit,
                               threshold_rationale, degradation_process,
                               penalty_kw_per_unit, penalty_basis) VALUES

('coil-valve-leak-by', 'brick:Air_Handling_Unit', 'Cooling coil valve leak-by',
 -- Reads the shut-valve baseline, not the coil-effectiveness one. That baseline
 -- is already restricted to instants where the valve is commanded closed and
 -- already asserts the coil delivers nothing there, so no applies_when is needed
 -- and the leak cannot be absorbed as normal cooling from a partly open valve.
 -- Negated because a leak makes supply air COLDER than predicted, and every
 -- indicator in this table has to count upward as things get worse.
 '-{residual:@asset.sa_temp.shut-valve-supply-air}',
 NULL,
 2.8, 'degC',
 'With the valve commanded shut the coil should deliver no cooling at all, so '
 'every degree of depression below the baseline is cooling nobody asked for. '
 '2.8 K (5 degF) across this unit''s 5.0 m3/s average airflow is about 17 kW of '
 'unwanted cooling, and it is paid for twice: once at the chiller making the '
 'water, and again wherever the overcooled space is reheated back to setpoint. '
 'It is also 2.5 times the plus or minus 1.1 K supply air control tolerance in '
 'ASHRAE Guideline 36, so a coil holding this deviation has taken supply air '
 'temperature outside the band the control sequence is specified to hold.',
 -- Wiener. A valve seat erodes one way, but this indicator is not the erosion --
 -- it is how cold the air got, which also depends on how much water happened to
 -- be in the coil and how hard the fan was blowing. Day-to-day falls are real.
 'wiener',
 0.928,
 'One kelvin of unwanted supply air depression removes m_dot * cp * 1 K of heat. '
 'Mean supply airflow measured over the 16,353 fault-free samples where the '
 'chilled water valve is actually commanded shut -- the only instants this '
 'indicator is defined at -- is 2.0192 m3/s, which at 1.2 kg/m3 and 1.005 kJ/kgK '
 'is 2.435 kW of cooling nobody asked for. Converted to electricity at this '
 'chiller''s commissioned 1.3402 kW/ton, which is 0.3811 kW electrical per kW '
 'thermal, giving 0.928 kW per kelvin. Counts the chiller electricity only. The '
 'overcooled air is also reheated back to setpoint downstream, which would roughly '
 'double the figure, but this building has no reheat instrument so that half is '
 'left out rather than estimated.'),

('chiller-condenser-fouling', 'brick:Chiller', 'Condenser fouling',
 '{residual:@asset.cdw_leaving_temp.condenser-heat-rejection}',
 NULL,
 3.0, 'degC',
 'Fouling insulates the condenser tubes, so rejecting the same heat needs a '
 'hotter refrigerant, which raises condensing pressure and therefore the '
 'temperature gap the compressor works across. 3.0 K of excess leaving condenser '
 'water at matched load and matched entering water is roughly a 7 to 9 percent '
 'compressor power penalty at the usual 2.5 percent per kelvin, which is the '
 'point at which a tube-brush cleaning pays for itself inside one cooling '
 'season. It is also seven times the 0.42 K spread of the fitted baseline, so it '
 'cannot be reached by scatter.',
 -- Gamma. Scale and biofilm settle onto condenser tubes and stay there until
 -- somebody brushes them out; there is no mechanism by which a tube spontaneously
 -- gets cleaner mid-season. The accumulated deposit is the state being tracked and
 -- it is genuinely one-directional, so a process that forbids negative increments
 -- is the physically correct one rather than a convenience.
 'gamma',
 1.876,
 'A chiller pays roughly 2.5 percent of its compressor power per kelvin of extra '
 'lift, and excess leaving condenser water is what raises the lift. Mean compressor '
 'power over the 30,078 fault-free samples where this machine is actually running '
 'is 75.04 kW, so 2.5 percent of it is 1.876 kW per kelvin. The 2.5 percent is a '
 'handbook rule of thumb rather than a measurement on this machine, and it is the '
 'weakest link in this coefficient; the 75.04 kW it multiplies is measured.'),

('chiller-efficiency-loss', 'brick:Chiller', 'Compressor efficiency loss',
 '({residual:@asset.power.chiller-efficiency} / 1000.0) / '
 '({point:@asset.chw_flow} * 997.0 * 4184.0 * '
 '({point:@asset.chw_return_temp} - {point:@asset.chw_supply_temp}) / 3516.85)',
 '{point:@asset.compressor_cmd} > 0.0',
 0.536, 'kW/ton',
 'This machine was commissioned at 1.3402 kW/ton averaged over its first three '
 'weeks. A chiller running at 1.4 times its own commissioned efficiency is '
 'buying the same cooling with 40 percent more electricity, which is the '
 'conventional economic-replacement trigger: the annual energy penalty exceeds '
 'the cost of the overhaul. 40 percent of 1.3402 is the 0.536 kW/ton of excess '
 'recorded here. Stated as an excess over the condition-matched baseline rather '
 'than as an absolute kW/ton, because the same healthy machine runs 1.2 kW/ton '
 'on a mild morning and 1.9 on a hot afternoon and an absolute limit would flag '
 'the afternoon.',
 -- Wiener. kW/ton excess is the sum of several independent causes -- fouling,
 -- charge, wear, and the accuracy of the flow meter it is computed from -- and a
 -- genuinely better week is possible without anyone repairing anything.
 'wiener',
 48.34,
 'The indicator is already excess electrical power per ton of cooling, so the only '
 'thing needed to turn it into kilowatts is how many tons the machine is actually '
 'making. Mean load over the 30,078 fault-free samples where it is running is 48.34 '
 'tons, so one kW/ton of excess is 48.34 kW. This is the most directly measured '
 'coefficient in the table -- no conversion factor and no rule of thumb, just the '
 'measured mean load. It understates the penalty on a hot afternoon, when the '
 'machine is at its 135-ton peak and the same indicator costs 135 kW.'),

('fan-bearing-degradation', 'brick:Air_Handling_Unit', 'Fan and bearing degradation',
 '{residual:@asset.sf_power.fan-similarity}',
 NULL,
 88.9, 'watt',
 'Worn bearings and a fouled impeller both show as more shaft power for the same '
 'air delivered, so the excess is measured at matched fan speed AND matched '
 'airflow. This fan was commissioned drawing 592.4 W on average. NEMA motors are '
 'built to a 1.15 service factor, meaning 15 percent over nameplate is the '
 'continuous overload the winding is rated to survive, so 15 percent of the '
 'commissioned draw -- 88.9 W -- is the point past which the motor is running '
 'outside its own rating whenever the fan is at its average duty.',
 -- Wiener. Bearing wear only accumulates, but the excess shaft power reporting it
 -- is dominated by how well the similarity-law fit happens to match the day's
 -- operating point, and that error changes sign. Measured on the fault-free run,
 -- 45 of 116 daily changes in this indicator are downward.
 'wiener',
 0.001,
 'This indicator is already electrical watts drawn above what the similarity-law '
 'baseline predicts at matched speed and matched airflow, so the conversion is a '
 'unit change and nothing else: one watt of excess shaft power is one thousandth of '
 'a kilowatt. Included with a coefficient of exactly 0.001 rather than special-cased '
 'in code, so that every mode goes through the same arithmetic and a reader does not '
 'have to check whether this one is handled differently.'),

('chiller-refrigerant-loss', 'brick:Chiller', 'Refrigerant charge loss',
 '{point:@asset.chw_supply_temp} - {point:chw-plant-1.pri_supply_temp_spt}',
 '{point:@asset.compressor_cmd} >= 0.95',
 2.0, 'degC',
 'Losing charge reduces the refrigerant mass the compressor can move, so the '
 'machine runs out of capacity before it runs out of command: chilled water '
 'drifts above setpoint while the compressor is already flat out. Measured only '
 'at full command, because below it a warm supply just means the controller has '
 'not asked for more yet. Fault-free operation at full command sits 0.22 K above '
 'setpoint on average and reaches 1.505 K at the 99th percentile, so 2.0 K is '
 'clear of normal control error and represents a plant that can no longer make '
 'its design water temperature on a design day.',
 -- Gamma. Refrigerant that has escaped the circuit does not come back, so the lost
 -- charge is strictly accumulating. The indicator is a lagging readout of it and
 -- does wobble, which argues the other way; gamma is chosen because the physical
 -- state is irreversible and because a charge-loss prediction that can forecast
 -- recovery would be predicting something no technician has ever seen.
 'gamma',
 -- NULL, and this is the interesting one. A short-charged chiller draws LESS power,
 -- not more: it is failing to make the water rather than paying extra to make it,
 -- and the lower lift actually reduces compressor draw. Its real cost is chilled
 -- water above setpoint, which becomes lost cooling capacity and warm occupants, and
 -- this building prices neither. Giving it a positive coefficient would have made
 -- the cost of inaction wrong in sign; giving it a small one would have been an
 -- invention. So it is NULL, the advisory says the cost is not electrical, and the
 -- priority for this mode falls back to severity alone.
 NULL, NULL),

('filter-loading', 'brick:Air_Handling_Unit', 'Filter loading',
 NULL,
 NULL,
 250.0, 'pascal',
 'NOT COMPUTABLE IN THIS BUILDING. A loaded filter is measured by the pressure '
 'drop across it, and neither LBNL dataset publishes one -- the air handler ships '
 '30 columns and none is a filter differential pressure, and there is no filter '
 'in the simulation to load. The threshold is recorded anyway because it is real: '
 '250 Pa (1.0 inch water gauge) is the standard final-pressure change-out '
 'criterion for a MERV 13 bank, set at the point where the extra fan energy to '
 'push air through the filter exceeds the cost of replacing it. The row exists so '
 'the missing instrument is documented rather than silently absent; the nearest '
 'available proxy, fan speed required at matched airflow, was rejected because it '
 'fits at only R2 0.50 to 0.75 with a residual of 5 percent of full scale.',
 -- Gamma, on the same grounds as condenser fouling: dust caught in a filter stays
 -- caught. Recorded for completeness even though nothing can fit it, so that if a
 -- filter pressure sensor is ever added the process choice is already made.
 'gamma',
 -- NULL because the indicator itself is NULL. A loaded filter absolutely does cost
 -- fan energy -- that is the whole reason 250 Pa is the change-out criterion -- but
 -- with no differential pressure instrument there is no indicator to multiply, so a
 -- coefficient here would convert a number that does not exist.
 NULL, NULL)

ON CONFLICT (mode_id) DO UPDATE SET
    brick_class          = EXCLUDED.brick_class,
    mode_name            = EXCLUDED.mode_name,
    indicator_expression = EXCLUDED.indicator_expression,
    applies_when         = EXCLUDED.applies_when,
    failure_threshold    = EXCLUDED.failure_threshold,
    indicator_unit       = EXCLUDED.indicator_unit,
    threshold_rationale  = EXCLUDED.threshold_rationale,
    degradation_process  = EXCLUDED.degradation_process,
    penalty_kw_per_unit  = EXCLUDED.penalty_kw_per_unit,
    penalty_basis        = EXCLUDED.penalty_basis;


-- =====================================================================
-- APP — advisories
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.advisories (
    advisory_id    TEXT              PRIMARY KEY,
    asset_id       TEXT              NOT NULL
                                     REFERENCES app.assets(asset_id) ON DELETE CASCADE,
    fault_id       TEXT              NOT NULL,
    mode_id        TEXT              REFERENCES app.failure_modes(mode_id)
                                     ON DELETE SET NULL,
    fault_source   TEXT              NOT NULL
                                     CHECK (fault_source IN ('failure_mode', 'rule')),
    fault_class    TEXT              NOT NULL
                                     CHECK (fault_class IN ('sensor', 'equipment',
                                                            'control', 'ambiguous')),
    status         TEXT              NOT NULL DEFAULT 'open'
                                     CHECK (status IN ('open', 'acknowledged',
                                                       'closed')),
    generated_at   TIMESTAMPTZ       NOT NULL,
    window_from    TIMESTAMPTZ       NOT NULL,
    window_to      TIMESTAMPTZ       NOT NULL,
    health         SMALLINT          CHECK (health IS NULL
                                            OR health BETWEEN 0 AND 100),
    severity       DOUBLE PRECISION  NOT NULL CHECK (severity BETWEEN 0 AND 1),
    priority       DOUBLE PRECISION  CHECK (priority IS NULL OR priority >= 0),
    cost_usd       DOUBLE PRECISION  NOT NULL CHECK (cost_usd >= 0),
    effort_usd     DOUBLE PRECISION  NOT NULL CHECK (effort_usd > 0),
    consequential  BOOLEAN           NOT NULL,
    cause_asset    TEXT,
    cause_fault    TEXT,
    detail         JSONB             NOT NULL,
    UNIQUE (asset_id, fault_id, window_to),
    CHECK (window_from <= window_to),
    CHECK (consequential = (cause_asset IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS advisories_status_priority_idx
    ON app.advisories (status, priority DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS advisories_asset_idx ON app.advisories (asset_id);

COMMENT ON TABLE app.advisories IS
    'The operator''s work queue, one row per open fault. Written by the advisory '
    'layer and read by the API and the dashboard. It exists as a table rather than '
    'being computed per request because building one advisory means running the '
    'isolation sweep, the rule engine and the health replay over a multi-month '
    'window -- minutes of work, not milliseconds. A dashboard cannot wait for that '
    'and neither can an operator. The scalar columns are the ones the queue is '
    'filtered and sorted on; everything else lives in detail so that adding a field '
    'to an advisory is not a migration.';

COMMENT ON COLUMN app.advisories.advisory_id IS
    'Deterministic, built from the asset, the fault and the end of the window it was '
    'computed over. Deliberately not a generated identity: re-running the advisory '
    'layer over the same window must UPDATE the same row rather than accumulate a '
    'second copy, and a surrogate key would make that a lookup instead of a conflict '
    'target.';

COMMENT ON COLUMN app.advisories.fault_id IS
    'What the detector that found this called it -- a mode_id for a degradation '
    'trend, a rule_id for a rule firing. mode_id beside it is non-NULL only in the '
    'first case, which is also why health can be NULL: health is scored per failure '
    'mode and a rule firing has none.';

COMMENT ON COLUMN app.advisories.status IS
    'open, acknowledged or closed. NOTHING IN THIS PROJECT YET MOVES A ROW OFF open '
    '-- there is no acknowledge or close action, so every row is open and the filter '
    'on this column always returns everything. The column is here because the API '
    'contract exposes the filter and because a queue with no way to retire an item '
    'is not a queue; the transition belongs with whatever raises real work orders.';

COMMENT ON COLUMN app.advisories.severity IS
    '0 to 1, from the rate of health decline, how soon the prediction says it fails, '
    'the criticality tier and the occupants served. Always present -- it can be '
    'computed for any fault.';

COMMENT ON COLUMN app.advisories.priority IS
    'Expected cost of inaction divided by cost of acting: dollars saved per dollar '
    'spent. NULL means the cost of inaction could not be computed at all, which is a '
    'statement and not a gap -- the same convention as app.rul_estimates. A NULL here '
    'is NOT zero: zero would claim the fault is free to ignore. Rows with NULL are '
    'ranked among themselves by severity, below every priced row.';

COMMENT ON COLUMN app.advisories.consequential IS
    'TRUE when cross-asset reasoning found an upstream fault that plausibly produces '
    'this symptom, in which case cause_asset and cause_fault name it and the priority '
    'has already been demoted below that cause''s. The CHECK constraint ties the flag '
    'to the presence of a cause so the two can never disagree. Consequential rows are '
    'never hidden from the queue, only ranked lower -- see AI_LOG.md entry D-09.';

COMMENT ON COLUMN app.advisories.detail IS
    'The whole advisory as JSON: the contributing signals with their actual and '
    'reference values, the diagnosis evidence, the remaining-life sentence or the '
    'reason there is none, the graph trace upstream and downstream with occupant '
    'counts, the arithmetic behind every dollar figure, the recommended intervention, '
    'and any caveats. An advisory a technician cannot audit without re-querying the '
    'raw data has failed at its job, so the audit trail travels with the row.';


-- =====================================================================
-- APP — intervention library
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.intervention_library (
    intervention_id   TEXT              PRIMARY KEY,
    applies_to_fault  TEXT              NOT NULL,
    applies_to_class  TEXT              CHECK (applies_to_class IS NULL
                                               OR applies_to_class IN
                                                  ('sensor', 'equipment',
                                                   'control', 'ambiguous')),
    description       TEXT              NOT NULL CHECK (length(description) > 20),
    duration_hours    DOUBLE PRECISION  NOT NULL CHECK (duration_hours > 0),
    skills            TEXT[]            NOT NULL CHECK (cardinality(skills) > 0),
    parts             TEXT[]            NOT NULL,
    cost_usd          NUMERIC(10,2)     NOT NULL CHECK (cost_usd >= 0),
    basis             TEXT              NOT NULL CHECK (length(basis) > 30),
    UNIQUE NULLS NOT DISTINCT (applies_to_fault, applies_to_class)
);

COMMENT ON TABLE app.intervention_library IS
    'What to actually DO about each fault this system can report. An advisory that '
    'names a failing machine and stops there hands the diagnosis back to the person '
    'who asked for it: they still have to decide whether this is an hour with a '
    'screwdriver or a weekend with a crane, and that decision is what determines '
    'whether the work gets scheduled. It is a table rather than code for the same '
    'reason app.failure_modes is -- a site with different labour rates or a different '
    'parts store changes rows, not Python. It is also the denominator of the priority '
    'ranking: priority is the cost of doing nothing divided by the cost of acting, and '
    'the cost of acting is duration times the labour rate plus parts, which is exactly '
    'what these rows hold.';

COMMENT ON COLUMN app.intervention_library.applies_to_fault IS
    'The fault this intervention answers, named the same way the detector that found '
    'it names it: a mode_id from app.failure_modes for a degradation fault, or a '
    'rule_id for a rule firing. Deliberately NOT a foreign key to app.failure_modes, '
    'because rule ids are not failure modes and half these rows would be '
    'unrepresentable.';

COMMENT ON COLUMN app.intervention_library.applies_to_class IS
    'Which fault class this row is the answer for, or NULL for any class. This column '
    'is the payoff of the sensor-versus-equipment discrimination in checkpoint 5.4, '
    'and it is where that work turns into a different van being dispatched. A '
    'saturated cooling valve classified as a sensor fault needs a reference probe and '
    'ninety minutes; the same saturated valve classified as an equipment fault needs a '
    'coil inspection and most of a day. Same symptom, same rule id, 3.2 times the cost. '
    'Lookup prefers an exact class match and falls back to the NULL row.';

COMMENT ON COLUMN app.intervention_library.duration_hours IS
    'Wrench time for one technician, excluding travel and excluding waiting for parts. '
    'Feeds the effort denominator of the priority ranking.';

COMMENT ON COLUMN app.intervention_library.skills IS
    'Trades required. Present because it changes who can be sent, not for display: a '
    'refrigerant recovery needs a certified technician and cannot be handed to the '
    'building engineer whatever the priority says.';

COMMENT ON COLUMN app.intervention_library.parts IS
    'Materials needed, possibly empty. An empty array is meaningful and common -- '
    'brushing condenser tubes or recalibrating a sensor consumes nothing -- and it is '
    'what distinguishes work that can start this afternoon from work that waits on a '
    'delivery.';

COMMENT ON COLUMN app.intervention_library.cost_usd IS
    'Parts and materials only. Labour is computed from duration_hours and the labour '
    'rate in the semantic model, so a site with different wages does not need these '
    'rows edited.';

COMMENT ON COLUMN app.intervention_library.basis IS
    'Where the duration and cost estimates come from. Required on the same principle '
    'as threshold_rationale and penalty_basis. EVERY ESTIMATE IN THIS TABLE IS A '
    'PLANNING FIGURE AND NEEDS REPLACING WITH REAL CONTRACTOR QUOTES; the basis column '
    'is where that shows, rather than the numbers looking authoritative.';


-- --- seed -------------------------------------------------------------

INSERT INTO app.intervention_library (intervention_id, applies_to_fault,
                                      applies_to_class, description, duration_hours,
                                      skills, parts, cost_usd, basis) VALUES

-- ---- degradation modes -----------------------------------------------
('brush-condenser-tubes', 'chiller-condenser-fouling', NULL,
 'Isolate and drain the condenser, brush the tube bundle mechanically, treat the '
 'water side, refill and verify the approach temperature has returned to its '
 'commissioned value before closing the work order.',
 8.0, ARRAY['chiller technician', 'water treatment'],
 ARRAY['tube brushes', 'condenser water biocide', 'gaskets'], 850.00,
 'One shift for a single-bundle machine of this size, the standard interval task in '
 'a chiller maintenance contract. Parts are consumables only.'),

('replace-coil-valve', 'coil-valve-leak-by', NULL,
 'Isolate the chilled water branch, replace the cooling coil control valve and '
 'actuator, stroke it end to end and confirm zero flow at the commanded-shut '
 'position.',
 4.0, ARRAY['pipefitter', 'controls technician'],
 ARRAY['150 mm modulating control valve', 'electric actuator', 'flange gaskets'],
 2400.00,
 'Half a shift with the branch already isolated. Valve and actuator priced at trade '
 'list for a two-inch modulating assembly.'),

('overhaul-compressor', 'chiller-efficiency-loss', NULL,
 'Compressor teardown: inspect and replace bearings and seals, verify impeller '
 'clearances, change oil and filters, then re-run the machine against its '
 'commissioning kW/ton at matched load and lift to confirm the efficiency came back.',
 32.0, ARRAY['chiller technician', 'certified refrigerant handler', 'rigger'],
 ARRAY['bearing set', 'shaft seals', 'oil charge', 'oil filter', 'refrigerant top-up'],
 14500.00,
 'Four shifts including recovery and recharge. The most expensive intervention here '
 'and the reason the efficiency threshold is set at the economic-replacement point '
 'rather than lower -- at 40 percent excess the energy saved pays this back in a '
 'season.'),

('replace-fan-bearings', 'fan-bearing-degradation', NULL,
 'Lock out the supply fan, replace both shaft bearings, check belt tension and '
 'sheave alignment, clean the impeller, and confirm power at matched airflow has '
 'returned toward the similarity-law baseline.',
 6.0, ARRAY['mechanic', 'electrician'],
 ARRAY['bearing pair', 'drive belts', 'grease'], 480.00,
 'Most of a shift, since the fan must be locked out and the section opened. Bearings '
 'and belts are stocked items.'),

('recharge-refrigerant', 'chiller-refrigerant-loss', NULL,
 'Leak-test the circuit under pressure, repair whatever is found, evacuate, and '
 'recharge to the nameplate mass. Verify chilled water reaches setpoint at full '
 'command before signing off.',
 12.0, ARRAY['certified refrigerant handler', 'chiller technician'],
 ARRAY['refrigerant charge', 'filter drier', 'leak sealant kit'], 6200.00,
 'A day and a half, because leak-finding dominates and the repair itself is usually '
 'short. Refrigerant priced per kilogram at 2024 rates; the figure moves a lot with '
 'the refrigerant and the regulatory year.'),

('replace-filter-bank', 'filter-loading', NULL,
 'Change the filter bank and record the clean-filter pressure drop as the new '
 'reference.',
 2.0, ARRAY['building engineer'], ARRAY['MERV 13 filter bank'], 320.00,
 'Two hours for a full bank. Recorded for completeness -- this building has no '
 'filter pressure instrument, so no advisory can ever reach this row.'),

-- ---- the same rule, two classes, two completely different jobs -------
-- These two rows are the point of the applies_to_class column. Both answer
-- apar-20, a cooling valve that has run fully open and stayed there.
('calibrate-supply-air-sensor', 'apar-20', 'sensor',
 'Check the supply air temperature sensor against a calibrated reference probe in '
 'the same airstream, re-trim or replace it, and confirm the control loop settles '
 'with the valve back on its normal duty.',
 1.5, ARRAY['controls technician'], ARRAY['replacement RTD sensor'], 120.00,
 'Ninety minutes including the reference reading and the loop check. This is the '
 'cheap outcome and taking it requires believing the discrimination in checkpoint '
 '5.4 -- dispatched as an equipment fault instead, the same symptom costs 3.2 times '
 'as much once labour and parts are both counted, and four times as much in '
 'technician-hours alone.'),

('inspect-coil-capacity', 'apar-20', 'equipment',
 'Survey the coil for capacity loss: check the water side for fouling and air side '
 'for blockage, verify the valve strokes fully and the chilled water arriving is at '
 'the temperature the coil was selected for, then decide between cleaning and '
 'replacement.',
 6.0, ARRAY['pipefitter', 'controls technician'],
 ARRAY['coil cleaning chemicals'], 260.00,
 'Most of a shift, most of it diagnosis rather than repair. 3.2 times the cost of the '
 'sensor outcome above for exactly the same reported symptom -- four times the '
 'technician-hours, partly offset because the sensor job buys a replacement RTD and '
 'this one buys only cleaning chemicals.'),

-- ---- remaining rule firings, class-independent ------------------------
('investigate-free-cooling-balance', 'apar-7', NULL,
 'Verify the mixed air and supply air sensors against each other with both coils '
 'confirmed shut, and check the supply fan heat assumption against measured power.',
 2.0, ARRAY['controls technician'], ARRAY[]::TEXT[], 0.00,
 'Two hours of sensor cross-checking. No parts unless a sensor is condemned.'),

('investigate-coil-no-cooling', 'apar-16', NULL,
 'Confirm chilled water is available at the coil at the expected temperature and '
 'flow, then stroke the valve through its full range while watching the air-side '
 'temperature drop.',
 3.0, ARRAY['pipefitter', 'controls technician'], ARRAY[]::TEXT[], 0.00,
 'Half a shift of diagnosis. Deliberately carries no parts: this rule says the coil '
 'is not delivering, not what to replace.'),

('rebalance-outdoor-air', 'apar-18', NULL,
 'Re-measure outdoor air fraction at the design airflow, verify the damper linkage '
 'and its position feedback, and re-trim the minimum position to the ventilation '
 'requirement.',
 4.0, ARRAY['test and balance technician', 'controls technician'],
 ARRAY['damper linkage kit'], 180.00,
 'Half a shift for a single mixing box, at test-and-balance rates.'),

('check-mixing-box-sensors', 'apar-27', NULL,
 'Mixed air hotter than both the return and outdoor air it is made from is '
 'physically impossible, so check the three sensors against one another and against '
 'a reference probe before touching any hardware.',
 2.0, ARRAY['controls technician'], ARRAY['replacement RTD sensor'], 120.00,
 'Two hours. The rule detects an impossibility, so a sensor is the first suspect and '
 'usually the last.'),

('check-economizer-changeover', 'apar-6', NULL,
 'Verify the economizer changeover logic and the return and supply air sensors, '
 'since supply air warmer than return air during free cooling means either the '
 'dampers are not where the controller thinks or two sensors disagree.',
 3.0, ARRAY['controls technician'], ARRAY[]::TEXT[], 0.00,
 'Half a shift of logic and sensor checking.'),

('verify-chiller-efficiency-inputs', 'chiller-kw-per-ton-residual', NULL,
 'Before condemning the machine, verify the flow meter and the two chilled water '
 'temperature sensors the kW/ton calculation depends on, since a flow meter reading '
 'low makes a healthy chiller look inefficient.',
 3.0, ARRAY['chiller technician', 'controls technician'], ARRAY[]::TEXT[], 0.00,
 'Half a shift. Placed before any mechanical work because the calculated efficiency '
 'is only as good as the flow measurement underneath it.'),

('inspect-condenser-approach', 'chiller-excess-lift', NULL,
 'Measure the condenser approach temperature and the cooling tower supply, to '
 'separate a fouled condenser from a tower that is returning warm water.',
 3.0, ARRAY['chiller technician'], ARRAY[]::TEXT[], 0.00,
 'Half a shift of measurement. This is the manual version of the cross-asset '
 'reasoning in checkpoint 6.1, and it is here because this building has no cooling '
 'tower detector to do it automatically.'),

('investigate-capacity-shortfall', 'chiller-capacity-shortfall', NULL,
 'Chilled water above setpoint with the compressor at full command means the plant '
 'is out of capacity. Check charge, condenser cleanliness and tower performance in '
 'that order, and stage another chiller if one is available.',
 4.0, ARRAY['chiller technician', 'certified refrigerant handler'],
 ARRAY[]::TEXT[], 0.00,
 'Half a shift of diagnosis, which then leads to one of the mode-specific rows '
 'above. Kept separate because the shortfall is a symptom with several causes.')

ON CONFLICT (intervention_id) DO UPDATE SET
    applies_to_fault = EXCLUDED.applies_to_fault,
    applies_to_class = EXCLUDED.applies_to_class,
    description      = EXCLUDED.description,
    duration_hours   = EXCLUDED.duration_hours,
    skills           = EXCLUDED.skills,
    parts            = EXCLUDED.parts,
    cost_usd         = EXCLUDED.cost_usd,
    basis            = EXCLUDED.basis;


-- =====================================================================
-- APP — maintenance events
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.maintenance_events (
    event_id      BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id      TEXT         NOT NULL
                               REFERENCES app.assets(asset_id) ON DELETE CASCADE,
    mode_id       TEXT         REFERENCES app.failure_modes(mode_id) ON DELETE CASCADE,
    performed_at  TIMESTAMPTZ  NOT NULL,
    action        TEXT         NOT NULL,
    UNIQUE NULLS NOT DISTINCT (asset_id, mode_id, performed_at)
);

CREATE INDEX IF NOT EXISTS maintenance_events_asset_idx
    ON app.maintenance_events (asset_id, performed_at);

COMMENT ON TABLE app.maintenance_events IS
    'When somebody repaired something. THIS TABLE IS EMPTY and is expected to be: '
    'the LBNL datasets record no maintenance, and none of the synthesised runs '
    'contains a repair. It exists because the health index has to handle repair '
    'correctly or it is wrong in a way that only shows up in production. '
    'Degradation is treated as one-directional -- a fouled condenser does not '
    'un-foul itself -- and the index enforces that by clamping health so it can '
    'never climb. A cleaned condenser genuinely HAS recovered, so without an '
    'explicit reset the clamp would hold a repaired machine at its worst-ever '
    'score forever and the remaining-life estimate would keep predicting a '
    'failure that had already been prevented.';

COMMENT ON COLUMN app.maintenance_events.mode_id IS
    'Which failure mode the work addressed, or NULL for a whole-asset overhaul '
    'that resets every mode. Brushing condenser tubes should not reset the '
    'evidence that a compressor is wearing out.';

COMMENT ON COLUMN app.maintenance_events.action IS
    'What was done, in words. Required: a reset with no recorded reason is '
    'indistinguishable from the health index losing its history.';


-- =====================================================================
-- APP — health state
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.health_state (
    time                 TIMESTAMPTZ       NOT NULL,
    asset_id             TEXT              NOT NULL
                                           REFERENCES app.assets(asset_id)
                                           ON DELETE CASCADE,
    mode_id              TEXT              REFERENCES app.failure_modes(mode_id)
                                           ON DELETE CASCADE,
    indicator_raw        DOUBLE PRECISION,
    indicator_monotonic  DOUBLE PRECISION,
    health               SMALLINT          CHECK (health IS NULL
                                                  OR health BETWEEN 0 AND 100),
    t_onset              TIMESTAMPTZ,
    weakest_mode         TEXT,
    UNIQUE NULLS NOT DISTINCT (asset_id, mode_id, time)
);

CREATE INDEX IF NOT EXISTS health_state_asset_time_idx
    ON app.health_state (asset_id, time DESC);

-- Deliberately NOT a hypertable. Health is computed once per day per mode, so
-- the whole table is a few thousand rows; partitioning it into weekly chunks
-- would create more chunks than any chunk would hold rows. AI_LOG.md D-01 is
-- about chunk counts getting out of hand, and the lesson cuts both ways.

COMMENT ON TABLE app.health_state IS
    'One number per asset per failure mode per day, saying how much of the way to '
    'failure that mode has travelled. This is the layer that turns a pile of '
    'residuals into something a human can be shown and a prediction can be fitted '
    'to. Rows with a mode are the per-mode detail; rows with mode_id NULL are the '
    'asset roll-up.';

COMMENT ON COLUMN app.health_state.mode_id IS
    'The failure mode this row scores, or NULL for the asset as a whole. Both are '
    'stored rather than deriving the roll-up on read, so that what the API serves '
    'and what the prediction layer fits are the same numbers.';

COMMENT ON COLUMN app.health_state.indicator_raw IS
    'The mode''s degradation number for this day, as the daily median of its '
    'five-minute values. Kept next to the clamped version so the clamp can be '
    'audited rather than trusted.';

COMMENT ON COLUMN app.health_state.indicator_monotonic IS
    'The same number after enforcing that degradation does not un-happen, by '
    'isotonic regression over the window since the last repair. Real sensor noise '
    'makes the raw indicator wobble up and down; the prediction maths downstream '
    'assumes a one-directional slide toward failure and either breaks or refuses '
    'to answer if the trend reverses.';

COMMENT ON COLUMN app.health_state.health IS
    '0 to 100. 100 means the indicator is at or better than the value the asset '
    'was commissioned at; 0 means it has reached the failure threshold in '
    'app.failure_modes. Linear in between, so half the score means half the '
    'distance to a threshold that has a physical justification behind it.';

COMMENT ON COLUMN app.health_state.t_onset IS
    'When degradation was CONFIRMED to have begun for this mode, from the '
    'changepoint detector, or NULL if no change has been confirmed. Constant '
    'within a run. Nothing may project a trend forward before this is set: a '
    'remaining-life number extrapolated from noise is worse than no number, '
    'because it looks like an answer.';

COMMENT ON COLUMN app.health_state.weakest_mode IS
    'On roll-up rows, which mode produced the minimum. The single most useful '
    'field for a technician: it turns "this chiller is at 40" into "this chiller '
    'is at 40 because of its condenser".';


-- =====================================================================
-- APP — remaining useful life
-- =====================================================================

CREATE TABLE IF NOT EXISTS app.rul_estimates (
    asset_id   TEXT              NOT NULL
                                 REFERENCES app.assets(asset_id) ON DELETE CASCADE,
    mode_id    TEXT              REFERENCES app.failure_modes(mode_id)
                                 ON DELETE CASCADE,
    as_of      TIMESTAMPTZ       NOT NULL,
    p10        DOUBLE PRECISION,
    p50        DOUBLE PRECISION,
    p90        DOUBLE PRECISION,
    n_samples  INTEGER           NOT NULL,
    mu_hat     DOUBLE PRECISION  NOT NULL,
    sigma_hat  DOUBLE PRECISION  NOT NULL,
    UNIQUE NULLS NOT DISTINCT (asset_id, mode_id, as_of),
    CHECK (p10 IS NULL OR p50 IS NULL OR p10 <= p50),
    CHECK (p50 IS NULL OR p90 IS NULL OR p50 <= p90)
);

CREATE INDEX IF NOT EXISTS rul_estimates_asset_as_of_idx
    ON app.rul_estimates (asset_id, as_of DESC);

-- Deliberately NOT a hypertable, for the same reason app.health_state is not:
-- one row per mode per asset per day is a few thousand rows in total, and weekly
-- chunks would create more chunks than any chunk would hold rows.

COMMENT ON TABLE app.rul_estimates IS
    'One row per failure mode per asset per date, holding the whole distribution '
    'over when that mode will reach its failure threshold. Every date is kept, not '
    'just the latest, because the most convincing thing this system can show a '
    'human is the prediction interval narrowing as evidence accumulates, and that '
    'is only visible if every intermediate answer was written down.';

COMMENT ON COLUMN app.rul_estimates.as_of IS
    'The date the estimate was made, using only data up to that date. Replaying '
    'the table in as_of order reproduces exactly what the system would have said '
    'at each point during the run, including the parts it got wrong.';

COMMENT ON COLUMN app.rul_estimates.p10 IS
    'Days from as_of by which there is a 10 percent chance the threshold has been '
    'crossed -- the pessimistic end. NULL means the model declines to bound it: '
    'either the drift cannot be separated from zero, in which case there may be no '
    'failure date at all, or the crossing is further off than the ten-year horizon '
    'this system will look. A NULL here is an answer, not missing data.';

COMMENT ON COLUMN app.rul_estimates.p50 IS
    'Days from as_of to the even-odds crossing date. The number to plan around. '
    'NULL on the same terms as p10.';

COMMENT ON COLUMN app.rul_estimates.p90 IS
    'Days from as_of by which there is a 90 percent chance of crossing -- the '
    'optimistic end. This is the one that goes NULL first, because a drift only '
    'marginally above zero leaves a real chance the machine never gets there.';

COMMENT ON COLUMN app.rul_estimates.n_samples IS
    'Post-onset daily increments the fit was based on. Kept next to the interval '
    'because a narrow band from nine days is not the same claim as a narrow band '
    'from ninety, and the refusal layer keys off this.';

COMMENT ON COLUMN app.rul_estimates.mu_hat IS
    'Posterior mean degradation rate, in the mode''s indicator unit per day. The '
    'belief about the rate after updating, NOT the raw maximum-likelihood fit -- '
    'this is the number the interval was actually computed from.';

COMMENT ON COLUMN app.rul_estimates.sigma_hat IS
    'The process spread the interval was computed with, in indicator units per '
    'root day: how far a single day strays from the average rate. Fixed when '
    'degradation was confirmed and floored at the spread the same indicator showed '
    'during commissioning, because the monotone clamp upstream removes real '
    'variance and an unfloored value makes this interval too narrow.';


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
