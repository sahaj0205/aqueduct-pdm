--
-- One-shot correction of point labelling defects found in checkpoint 2.2.
--
-- Nothing here re-reads a CSV or recomputes a value. Every measurement stays
-- exactly as loaded; only the point_id it is filed under, and the metadata
-- describing that point, change. The ingestion manifests were corrected in the
-- same commit, so a load into a fresh database produces this state directly and
-- this script is only needed for a database loaded before the fix.
--
-- Safe to run more than once. Each step is guarded by a condition that becomes
-- false once the step has been applied -- which matters most for step 1, since a
-- swap applied twice is a swap undone.
--
-- Run with:
--   psql -v ON_ERROR_STOP=1 -f scripts/fix_point_labels.sql
--

\timing on

--
-- ---------------------------------------------------------------------------
-- STEP 1 -- secondary chilled water loop: supply and return are swapped
-- ---------------------------------------------------------------------------
--
-- The source columns CWL_SEC_SW_TEMP and CWL_SEC_RW_TEMP are the wrong way
-- round in the LBNL data. Over July the column named "supply" averages
-- 11.97 degC and the one named "return" averages 7.14 degC. A secondary loop
-- delivers cold water to its loads, so its supply cannot be the warmer of the
-- pair. The primary loop, which is labelled correctly, settles it: primary
-- supply is 7.19 degC, and a secondary loop is fed from the primary supply, so
-- secondary supply has to be about 7.19 -- which is what the column named
-- "return" actually contains.
--
-- Two points, 2,522,592 rows, exchanged in one statement. The guard reads a
-- single summer day and acts only while supply is still the warmer of the two.
--

DO $$
DECLARE
    supply_mean DOUBLE PRECISION;
    return_mean DOUBLE PRECISION;
    swapped     BIGINT;
BEGIN
    SELECT avg(value_si) FILTER (WHERE point_id = 'chw-plant-1.sec_supply_temp'),
           avg(value_si) FILTER (WHERE point_id = 'chw-plant-1.sec_return_temp')
      INTO supply_mean, return_mean
      FROM app.measurements
     WHERE time >= '2018-07-16' AND time < '2018-07-17'
       AND point_id IN ('chw-plant-1.sec_supply_temp', 'chw-plant-1.sec_return_temp');

    IF supply_mean IS NULL OR return_mean IS NULL THEN
        RAISE NOTICE 'step 1 SKIPPED: secondary loop points hold no data on the probe day';
        RETURN;
    END IF;

    IF supply_mean <= return_mean THEN
        RAISE NOTICE 'step 1 ALREADY APPLIED: supply % is at or below return %',
                     round(supply_mean::numeric, 2), round(return_mean::numeric, 2);
        RETURN;
    END IF;

    RAISE NOTICE 'step 1 APPLYING: supply % is warmer than return %',
                 round(supply_mean::numeric, 2), round(return_mean::numeric, 2);

    UPDATE app.measurements
       SET point_id = CASE point_id
                          WHEN 'chw-plant-1.sec_supply_temp' THEN 'chw-plant-1.sec_return_temp'
                          WHEN 'chw-plant-1.sec_return_temp' THEN 'chw-plant-1.sec_supply_temp'
                      END
     WHERE point_id IN ('chw-plant-1.sec_supply_temp', 'chw-plant-1.sec_return_temp');

    GET DIAGNOSTICS swapped = ROW_COUNT;
    RAISE NOTICE 'step 1 DONE: % rows exchanged', swapped;
END $$;

-- Both points now hold what their names claim, so tighten the classes from the
-- generic water-temperature ones to the chilled-water-specific classes Brick
-- actually defines.
UPDATE app.points
   SET brick_class = 'brick:Chilled_Water_Supply_Temperature_Sensor'
 WHERE point_id = 'chw-plant-1.sec_supply_temp';

UPDATE app.points
   SET brick_class = 'brick:Chilled_Water_Return_Temperature_Sensor'
 WHERE point_id = 'chw-plant-1.sec_return_temp';

--
-- ---------------------------------------------------------------------------
-- STEP 2 -- chiller condenser water: rename to entering and leaving
-- ---------------------------------------------------------------------------
--
-- This pair is NOT swapped. The data and the point names already agree: the
-- point called cdw_supply_temp is named "condenser water leaving temperature"
-- and holds the warm side, 29.84 degC against 27.44 degC. What is wrong is the
-- word "supply" in the identifier, because it means the opposite thing one level
-- up -- the plant-level pair uses "supply" for the cool water the towers send to
-- the chillers. One word, two senses, inside one model.
--
-- Rather than pick a winner, the identifiers move to entering and leaving, which
-- Brick defines explicitly and which cannot be read two ways: entering arrives at
-- the condenser from the tower, leaving goes back to it. Arithmetic written later
-- then reads correctly without the author having to recall which convention
-- applies -- which is the whole reason for doing this at the data layer rather
-- than compensating for it in each expression.
--
-- Six points, 7,567,776 rows. The identifier itself changes, so the new point
-- rows must exist before any measurement can point at them.
--

CREATE TEMPORARY TABLE cdw_rename (old_id TEXT PRIMARY KEY, new_id TEXT, new_class TEXT);

INSERT INTO cdw_rename VALUES
    ('chiller-1.cdw_supply_temp', 'chiller-1.cdw_leaving_temp',
     'brick:Leaving_Condenser_Water_Temperature_Sensor'),
    ('chiller-2.cdw_supply_temp', 'chiller-2.cdw_leaving_temp',
     'brick:Leaving_Condenser_Water_Temperature_Sensor'),
    ('chiller-3.cdw_supply_temp', 'chiller-3.cdw_leaving_temp',
     'brick:Leaving_Condenser_Water_Temperature_Sensor'),
    ('chiller-1.cdw_return_temp', 'chiller-1.cdw_entering_temp',
     'brick:Entering_Condenser_Water_Temperature_Sensor'),
    ('chiller-2.cdw_return_temp', 'chiller-2.cdw_entering_temp',
     'brick:Entering_Condenser_Water_Temperature_Sensor'),
    ('chiller-3.cdw_return_temp', 'chiller-3.cdw_entering_temp',
     'brick:Entering_Condenser_Water_Temperature_Sensor');

INSERT INTO app.points (point_id, asset_id, brick_class, name, unit_native, unit_si,
                        expected_min, expected_max, max_roc_per_min, sample_interval_s)
SELECT r.new_id, p.asset_id, r.new_class, p.name, p.unit_native, p.unit_si,
       p.expected_min, p.expected_max, p.max_roc_per_min, p.sample_interval_s
  FROM cdw_rename r
  JOIN app.points p ON p.point_id = r.old_id
ON CONFLICT (point_id) DO NOTHING;

UPDATE app.measurements m
   SET point_id = r.new_id
  FROM cdw_rename r
 WHERE m.point_id = r.old_id;

DELETE FROM app.points p
 USING cdw_rename r
 WHERE p.point_id = r.old_id
   AND NOT EXISTS (SELECT 1 FROM app.measurements m WHERE m.point_id = p.point_id);

--
-- ---------------------------------------------------------------------------
-- STEP 3 -- classes that are not Brick classes at all
-- ---------------------------------------------------------------------------
--
-- Checked against the published Brick 1.3 ontology. Neither name exists in it,
-- so every query selecting points by class was silently missing whatever carried
-- them. Metadata only, no measurement row touched.
--
-- Electrical_Power_Sensor is simply not the name -- Brick calls it
-- Electric_Power_Sensor. 16 points, including all three chiller power meters,
-- which the chiller energy balance depends on.
--

UPDATE app.points
   SET brick_class = 'brick:Electric_Power_Sensor'
 WHERE brick_class = 'brick:Electrical_Power_Sensor';

-- Supply_Water_Temperature_Setpoint does not exist either, and unlike the case
-- above it has no single replacement: LBNL used one class for two different
-- fluids, so each point needs the class for its own fluid.

UPDATE app.points
   SET brick_class = 'brick:Supply_Chilled_Water_Temperature_Setpoint'
 WHERE point_id = 'chw-plant-1.pri_supply_temp_spt';

UPDATE app.points
   SET brick_class = 'brick:Supply_Condenser_Water_Temperature_Setpoint'
 WHERE point_id = 'chw-plant-1.ct_supply_temp_spt';

--
-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
--

\echo ''
\echo 'secondary loop -- supply must now be COLDER than return:'
SELECT point_id, round(avg(value_si)::numeric, 2) AS mean_jul_16, count(*) AS rows
  FROM app.measurements
 WHERE time >= '2018-07-16' AND time < '2018-07-17'
   AND point_id IN ('chw-plant-1.sec_supply_temp', 'chw-plant-1.sec_return_temp')
 GROUP BY point_id ORDER BY point_id;

\echo ''
\echo 'chiller 1 condenser water -- leaving must be WARMER than entering:'
SELECT point_id, round(avg(value_si)::numeric, 2) AS mean_jul_16, count(*) AS rows
  FROM app.measurements
 WHERE time >= '2018-07-16' AND time < '2018-07-17'
   AND point_id LIKE 'chiller-1.cdw%'
 GROUP BY point_id ORDER BY point_id;

\echo ''
\echo 'old identifiers must be gone from both tables:'
SELECT 'app.points' AS relation, count(*) AS stale
  FROM app.points p JOIN cdw_rename r ON p.point_id = r.old_id
UNION ALL
SELECT 'app.measurements', count(*)
  FROM app.measurements m JOIN cdw_rename r ON m.point_id = r.old_id;

\echo ''
\echo 'no point may still carry a class Brick does not define:'
SELECT count(*) AS invalid_classes FROM app.points
 WHERE brick_class IN ('brick:Electrical_Power_Sensor',
                       'brick:Supply_Water_Temperature_Setpoint');

\echo ''
\echo 'totals must be unchanged -- 107 points, 116,039,232 measurements:'
SELECT (SELECT count(*) FROM app.points)       AS points,
       (SELECT count(*) FROM app.measurements) AS measurements;
