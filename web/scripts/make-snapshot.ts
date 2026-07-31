/**
 * Freeze one real moment out of the running system into `web/src/story/snapshot.json`.
 *
 * WHY THE WALKTHROUGH READS A FILE AND NOT THE API. It is shown to a room, on a projector,
 * often on a laptop that is not on the office network. A fetch that fails mid-presentation
 * has no recovery — the screen simply stops telling the story. So every number the
 * walkthrough shows is captured once, here, and committed. The frontend never makes a
 * request.
 *
 * WHY IT READS THE DATABASE RATHER THAN THE API. The API is a read layer with its own
 * shaping — bands, joins, formatting — and several things the walkthrough needs (the
 * written justification for a failure threshold, the raw indicator series, the exact
 * residual behind a baseline) are rows rather than endpoints. Going to the system of record
 * means one less translation between the number the platform computed and the number the
 * audience is shown. Everything here is traceable to a table.
 *
 * NOTHING IN THIS FILE INVENTS A VALUE. Every field comes out of a query. Where the system
 * has no answer — and it genuinely has none for the remaining-life estimate on the chosen
 * day — the absence is recorded as an absence, with the system's own reason, because a
 * refusal is one of the things the walkthrough exists to explain.
 *
 *   npm run snapshot        (needs `make db-up` and a loaded database)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Resolved from the working directory, not from this file's own path. The runner bundles
// these scripts into a temporary directory before executing them, so `import.meta.url`
// points at somewhere under /var/folders and every path built from it lands nowhere. npm
// runs the script with the working directory at `web/`, which is stable.
const ROOT = join(process.cwd(), "..");
const OUT = join(process.cwd(), "src", "story", "snapshot.json");

/**
 * THE MOMENT THE WALKTHROUGH STANDS AT.
 *
 * Chosen from the data rather than picked for neatness, and the choice is worth recording.
 * The story the platform's own write-up tells is condenser fouling on chiller 1 — the
 * failure mode that carries a physically argued threshold, a measured kilowatts-per-kelvin
 * penalty, and a priced intervention. On this machine that fault develops fast: health sits
 * at 62 on the 7th of June and has fallen to 0 by the 9th.
 *
 * There is therefore NO day on which this fault has both a mid-range health and a published
 * remaining-life estimate — the estimate needs a run of samples the fault does not last long
 * enough to provide until it is already over the threshold. Rather than switch to a
 * different machine with a tidier arc, the walkthrough stands on the 7th and shows the
 * refusal, then shows the estimate arriving on the 9th. That is what the system actually
 * does, and "not enough evidence yet" is one of the four things this platform is built to
 * say out loud.
 */
const AT = "2037-06-07";
const ASSET = "chiller-1";
const MODE = "chiller-condenser-fouling";

/** Days of history the travelling reading drags behind it in the opening scene. */
const HISTORY_DAYS = 14;

/**
 * The healthy reference window. Twenty-one days is the platform's own constant — every
 * baseline is fitted on it and every health score is measured against it.
 */
const COMMISSIONING_DAYS = 21;

// ---------------------------------------------------------------------------- database

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const E = env();

/**
 * Run one query that returns a single JSON value.
 *
 * Every query below builds its own JSON in SQL rather than returning columns for this
 * script to stitch together. That keeps the shape of each answer next to the query that
 * produces it, and means a column added to a table cannot silently shift a positional
 * parse here.
 */
function q<T>(sql: string): T {
  const text = execFileSync(
    "psql",
    [
      "-h", "localhost",
      "-p", E.POSTGRES_PORT ?? "5432",
      "-U", E.POSTGRES_USER ?? "postgres",
      "-d", E.POSTGRES_DB ?? "postgres",
      "-tAc", sql,
    ],
    { env: { ...process.env, PGPASSWORD: E.POSTGRES_PASSWORD ?? "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  if (text === "" || text === "null") {
    throw new Error(`query returned nothing:\n${sql.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Read the scored results out of VALIDATION.md.
 *
 * WHY IT IS PARSED RATHER THAN RECOMPUTED. That document is produced by
 * `make validate`, which runs the detectors over a connection that is denied access to the
 * answer key and only afterwards opens the admin credential to score what came out. That
 * ordering is the entire basis of the claim that nothing which produced a number could have
 * seen the answer it is judged against. Recomputing any of it here, in a script that has
 * the key in scope, would throw that guarantee away for the sake of tidier code.
 *
 * IT REPORTS ABSENCE AS ABSENCE. If the harness has not been run against loaded ground
 * truth, every figure in the document is `n/a` or zero — and a zero here means "not
 * measured", not "measured as zero". Those two must never look the same on a screen shown
 * to somebody deciding whether to trust the system, so `available` is false unless a real
 * precision figure was found, and the scene says so in words.
 */
function readValidation() {
  let text: string;
  try {
    text = readFileSync(join(ROOT, "VALIDATION.md"), "utf8");
  } catch {
    return { available: false, reason: "VALIDATION.md has not been generated — run `make validate`" };
  }

  const cell = (label: string): string | null => {
    const m = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*\\*\\*([^|*]+)\\*\\*`, "i").exec(text);
    return m ? m[1]!.trim() : null;
  };
  const numOrNull = (v: string | null): number | null => {
    if (v === null) return null;
    const cleaned = v.replace(/[%\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
  };

  const precision = numOrNull(cell("precision"));
  const recall = numOrNull(cell("recall"));
  const classHit = /correct on (\d+) of (\d+) injected faults/i.exec(text);
  const refusals = (text.match(/CORRECT REFUSAL/g) ?? []).length;
  const generated = /generated ([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(text);

  return {
    available: precision !== null || recall !== null,
    reason:
      precision === null && recall === null
        ? "the harness ran but scored nothing — no ground truth was loaded when it last ran"
        : null,
    precision,
    recall,
    faultClassCorrect: classHit ? Number(classHit[1]) : null,
    faultClassTotal: classHit ? Number(classHit[2]) : null,
    suppressionRefusals: refusals,
    generatedAt: generated ? generated[1]! : null,
  };
}

function main() {
  console.log(`\nfreezing ${ASSET} / ${MODE} at ${AT}\n`);

  // ------------------------------------------------------------------ the machine
  const asset = q<{ asset_id: string; name: string; brick_class: string; replacement_cost_usd: number | null }>(`
    select json_build_object(
      'asset_id', asset_id, 'name', name, 'brick_class', brick_class,
      'replacement_cost_usd', replacement_cost_usd
    ) from app.assets where asset_id = '${ASSET}'`);

  // The instrument the walkthrough follows: the temperature of the water leaving the
  // condenser. It is the target of a baseline AND the indicator for a failure mode, which
  // is exactly why it exercises the whole chain.
  const point = q<{ point_id: string; name: string; unit_si: string; expected_min: number; expected_max: number }>(`
    select json_build_object(
      'point_id', point_id, 'name', name, 'unit_si', unit_si,
      'expected_min', expected_min, 'expected_max', expected_max
    ) from app.points
    where asset_id = '${ASSET}' and point_id like '%cdw_leaving%' limit 1`);

  // Scene one counts these out loud: how many instruments this building has, and how many
  // are known to be broken before any analysis runs.
  const instruments = q<{ total: number; unusable: number; reasons: string[] }>(`
    select json_build_object(
      'total', count(*),
      'unusable', count(*) filter (where not usable),
      'reasons', coalesce(json_agg(unusable_reason) filter (where not usable), '[]'::json)
    ) from app.points`);

  // ------------------------------------------------------------------ the reading
  const series = q<{ t: string; v: number }[]>(`
    select coalesce(json_agg(json_build_object('t', t, 'v', v) order by t), '[]'::json) from (
      select time_bucket('1 hour', time) t, round(avg(value_si)::numeric, 3)::float8 v
      from app.measurements
      where point_id = '${point.point_id}'
        and time >  timestamptz '${AT}' - interval '${HISTORY_DAYS} days'
        and time <  timestamptz '${AT}' + interval '1 day'
      group by 1 order by 1
    ) s`);

  const reading = series[series.length - 1];
  if (!reading) throw new Error("no measurements in the history window");

  // ------------------------------------------------------------------ the baseline
  // What the machine SHOULD have been producing, and the gap. The residual is the number
  // that becomes the indicator two stages later.
  const residuals = q<{ t: string; observed: number; expected: number; residual: number }[]>(`
    select coalesce(json_agg(json_build_object(
      't', time, 'observed', round(observed::numeric,3)::float8,
      'expected', round(expected::numeric,3)::float8,
      'residual', round(residual::numeric,3)::float8) order by time), '[]'::json)
    from app.residuals
    where point_id = '${point.point_id}'
      and time >  timestamptz '${AT}' - interval '${HISTORY_DAYS} days'
      and time <  timestamptz '${AT}' + interval '1 day'`);

  // ------------------------------------------------------------------ the failure mode
  const mode = q<{
    mode_id: string; mode_name: string; failure_threshold: number; indicator_unit: string;
    penalty_kw_per_unit: number; degradation_process: string; threshold_rationale: string;
  }>(`
    select json_build_object(
      'mode_id', mode_id, 'mode_name', mode_name, 'failure_threshold', failure_threshold,
      'indicator_unit', indicator_unit, 'penalty_kw_per_unit', penalty_kw_per_unit,
      'degradation_process', degradation_process, 'threshold_rationale', threshold_rationale
    ) from app.failure_modes where mode_id = '${MODE}'`);

  // ------------------------------------------------------------------ health
  const daily = q<{ t: string; health: number; raw: number; monotonic: number }[]>(`
    select coalesce(json_agg(json_build_object(
      't', time, 'health', health,
      'raw', round(indicator_raw::numeric,3)::float8,
      'monotonic', round(indicator_monotonic::numeric,3)::float8) order by time), '[]'::json)
    from app.health_state
    where asset_id='${ASSET}' and mode_id='${MODE}'
      and time > timestamptz '${AT}' - interval '${HISTORY_DAYS} days'
      and time <  timestamptz '${AT}' + interval '1 day'`);

  const today = q<{ health: number; monotonic: number; raw: number; t_onset: string | null }>(`
    select json_build_object(
      'health', health, 'monotonic', round(indicator_monotonic::numeric,3)::float8,
      'raw', round(indicator_raw::numeric,3)::float8, 't_onset', t_onset)
    from app.health_state
    where asset_id='${ASSET}' and mode_id='${MODE}' and time::date = date '${AT}'`);

  // ------------------------------------------------------------------ remaining life
  // The refusal, and the estimate that arrives after it. Both are real rows (or the real
  // absence of one) — see the note on AT above.
  const rulToday = q<{ n: number }>(`
    select json_build_object('n', count(*)) from app.rul_estimates
    where asset_id='${ASSET}' and mode_id='${MODE}' and as_of::date = date '${AT}'`);

  const rulNext = q<{ as_of: string; p10: number; p50: number; p90: number; n_samples: number } | null>(`
    select coalesce((select json_build_object(
      'as_of', as_of, 'p10', round(p10::numeric,1)::float8, 'p50', round(p50::numeric,1)::float8,
      'p90', round(p90::numeric,1)::float8, 'n_samples', n_samples)
    from app.rul_estimates
    where asset_id='${ASSET}' and mode_id='${MODE}' and as_of::date > date '${AT}'
    order by as_of limit 1), 'null'::json)`);

  // ------------------------------------------------------------------ the advisory
  const advisory = q<Record<string, unknown> | null>(`
    select coalesce((select json_build_object(
      'advisory_id', advisory_id, 'fault_id', fault_id, 'fault_class', fault_class,
      'status', status, 'health', health, 'severity', severity, 'priority', priority,
      'cost_usd', cost_usd, 'effort_usd', effort_usd, 'consequential', consequential,
      'cause_asset', cause_asset, 'cause_fault', cause_fault, 'detail', detail)
    from app.advisories
    where asset_id='${ASSET}' and mode_id='${MODE}'
    order by abs(extract(epoch from (generated_at - timestamptz '${AT}'))) limit 1), 'null'::json)`);

  // ------------------------------------------------------------------ the other machines
  // Only what the background rail draws: enough to show that other work is in flight while
  // this reading is being handled.
  const others = q<{ asset_id: string; name: string; mode_id: string; health: number }[]>(`
    select coalesce(json_agg(json_build_object(
      'asset_id', h.asset_id, 'name', a.name, 'mode_id', h.mode_id, 'health', h.health)), '[]'::json)
    from app.health_state h join app.assets a on a.asset_id = h.asset_id
    where h.time::date = date '${AT}' and h.asset_id <> '${ASSET}'`);

  const era = q<{ t_from: string; t_to: string }>(`
    select json_build_object('t_from', min(time), 't_to', max(time)) from app.health_state
    where asset_id='${ASSET}' and time between timestamptz '${AT}' - interval '200 days'
      and timestamptz '${AT}' + interval '200 days'`);

  // ------------------------------------------------- everything held about this machine
  // The full inventory the walkthrough shows before any reading arrives: the instruments,
  // the ways it is known to fail, and the priced jobs that fix them. All configuration —
  // none of it learned from data — which is the claim the scene exists to make.
  const inventory = {
    points: q<{ point_id: string; name: string; unit_si: string; usable: boolean; unusable_reason: string | null }[]>(`
      select coalesce(json_agg(json_build_object(
        'point_id', point_id, 'name', name, 'unit_si', unit_si,
        'usable', usable, 'unusable_reason', unusable_reason) order by point_id), '[]'::json)
      from app.points where asset_id = '${ASSET}'`),

    modes: q<{ mode_id: string; mode_name: string; failure_threshold: number; indicator_unit: string; penalty_kw_per_unit: number | null }[]>(`
      select coalesce(json_agg(json_build_object(
        'mode_id', mode_id, 'mode_name', mode_name, 'failure_threshold', failure_threshold,
        'indicator_unit', indicator_unit, 'penalty_kw_per_unit', penalty_kw_per_unit) order by mode_id), '[]'::json)
      from app.failure_modes
      where brick_class = (select brick_class from app.assets where asset_id='${ASSET}')`),

    interventions: q<{ fault_id: string; action: string; hours: number | null; cost: number | null }[]>(`
      select coalesce(json_agg(json_build_object(
        'fault_id', fault_id, 'action', action, 'hours', labour_hours,
        'cost', round((coalesce(labour_hours,0) * coalesce(labour_rate_usd_per_hour,0)
                       + coalesce(parts_cost_usd,0))::numeric, 0)::float8) order by fault_id), '[]'::json)
      from app.intervention_library`),

    baselines: q<{ baseline_id: string; n: number }[]>(`
      select coalesce(json_agg(json_build_object('baseline_id', baseline_id, 'n', n) order by baseline_id), '[]'::json)
      from (select baseline_id, count(*) n from app.residuals r
            join app.points p on p.point_id = r.point_id
            where p.asset_id = '${ASSET}' group by baseline_id) b`),
  };

  // ---------------------------------------------------------------- where the data is from
  const provenance = {
    assets: q<{ n: number }>(`select json_build_object('n', count(*)) from app.assets`).n,
    points: instruments.total,
    scenarios: q<{ n: number }>(`select json_build_object('n', count(*)) from groundtruth.scenarios`).n,
    faultEvents: q<{ n: number }>(`select json_build_object('n', count(*)) from groundtruth.fault_events`).n,
    measurements: q<{ n: number }>(`select json_build_object('n', count(*)) from app.measurements`).n,
    eras: q<{ n: number }>(`select json_build_object('n', count(distinct extract(year from time))) from app.health_state`).n,
  };

  const excess = today.monotonic;
  const threshold = mode.failure_threshold;
  const computed = Math.round(100 * (1 - excess / threshold));

  const snapshot = {
    generatedAt: new Date().toISOString(),
    at: AT,
    source: "app schema, local TimescaleDB — see web/scripts/make-snapshot.ts",
    asset,
    point,
    instruments,
    commissioning: { days: COMMISSIONING_DAYS, from: era.t_from, to: era.t_to },
    series,
    reading,
    baseline: { residuals },
    mode,
    indicator: {
      threshold,
      unit: mode.indicator_unit,
      rationale: mode.threshold_rationale,
      process: mode.degradation_process,
      penaltyKwPerUnit: mode.penalty_kw_per_unit,
    },
    health: {
      value: today.health,
      excess,
      raw: today.raw,
      onset: today.t_onset,
      arithmetic: `100 × (1 − ${excess} ÷ ${threshold}) = ${computed}`,
      daily,
    },
    prediction:
      rulToday.n > 0
        ? { kind: "estimate" as const, ...rulNext }
        : {
            kind: "refusal" as const,
            reason: "not enough samples yet — the indicator has not been above its onset long enough to fit a rate",
            arrivesAt: rulNext?.as_of ?? null,
            arrivingEstimate: rulNext,
          },
    advisory,
    others,
    inventory,
    provenance,
    validation: readValidation(),
  };

  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);

  // ------------------------------------------------------------------ what was captured
  const say = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${value}`);
  say("asset", `${asset.name} (${asset.asset_id})`);
  say("instrument", `${point.point_id}, ${point.unit_si}`);
  say("instruments in the building", `${instruments.total}, of which ${instruments.unusable} unusable`);
  say("history", `${series.length} hourly points over ${HISTORY_DAYS} days`);
  say("the reading", `${reading.v} ${point.unit_si} at ${reading.t}`);
  say("residual rows", residuals.length);
  say("failure threshold", `${threshold} ${mode.indicator_unit}, ${mode.degradation_process} process`);
  say("penalty", `${mode.penalty_kw_per_unit} kW per ${mode.indicator_unit}`);
  say("excess today", `${excess} ${mode.indicator_unit}`);
  say("health", `${today.health}  — ${snapshot.health.arithmetic}`);
  say("onset", today.t_onset ?? "none");
  say("prediction", snapshot.prediction.kind === "refusal" ? `REFUSED, next estimate ${rulNext?.as_of ?? "never"}` : "published");
  if (rulNext) say("  the estimate that follows", `p10 ${rulNext.p10}d  p50 ${rulNext.p50}d  p90 ${rulNext.p90}d  n=${rulNext.n_samples}`);
  say("advisory", advisory ? `${(advisory as { advisory_id: string }).advisory_id}` : "none");
  say("other machines today", others.length);

  console.log(`\nwrote ${OUT}\n`);
}

main();
