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
    threshold_rationale   TEXT              NOT NULL CHECK (length(threshold_rationale) > 40)
);

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


-- --- seed -------------------------------------------------------------
-- ON CONFLICT DO UPDATE rather than DO NOTHING, so correcting a rationale here
-- and re-applying the schema actually corrects it in the database.

INSERT INTO app.failure_modes (mode_id, brick_class, mode_name, indicator_expression,
                               applies_when, failure_threshold, indicator_unit,
                               threshold_rationale) VALUES

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
 'temperature outside the band the control sequence is specified to hold.'),

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
 'cannot be reached by scatter.'),

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
 'the afternoon.'),

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
 'outside its own rating whenever the fan is at its average duty.'),

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
 'its design water temperature on a design day.'),

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
 'fits at only R2 0.50 to 0.75 with a residual of 5 percent of full scale.')

ON CONFLICT (mode_id) DO UPDATE SET
    brick_class          = EXCLUDED.brick_class,
    mode_name            = EXCLUDED.mode_name,
    indicator_expression = EXCLUDED.indicator_expression,
    applies_when         = EXCLUDED.applies_when,
    failure_threshold    = EXCLUDED.failure_threshold,
    indicator_unit       = EXCLUDED.indicator_unit,
    threshold_rationale  = EXCLUDED.threshold_rationale;


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
