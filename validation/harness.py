"""Run every scenario end to end, score it against the answer key, write VALIDATION.md.

    uv run python -m validation.harness            # regenerate VALIDATION.md
    uv run python -m validation.harness --quiet    # without the per-window log

TWO CONNECTIONS, AND THE ORDER MATTERS

The detection sweep runs first, over a connection as app_rw, which the database denies
access to schema groundtruth. Only after every finding has been produced does this
module call into validation/groundtruth.py, which opens the admin credential and reads
the labels. Nothing that produced a number could have read the answer it is scored
against, and the ordering here is what makes that statement checkable rather than
merely intended.

The exit status is non-zero if the document could not be built. It is deliberately NOT
non-zero for a bad accuracy figure: this is a measuring instrument, and an instrument
that fails when the reading is unwelcome invites the reading to be adjusted.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from analytics.rules.readings import resolve_dsn
from model.loader import load_merged_graph
from validation import report
from validation.attribution import (
    classify_runs,
    majority_baseline,
    run_suppression,
    score_classifications,
    score_suppression,
)
from validation.detect import sweep as run_sweep
from validation.groundtruth import load_answer_key, severity_one_windows
from validation.metrics import (
    EXCLUDED_SCENARIOS,
    NEGATIVE,
    POSITIVE,
    asset_days,
    confusion,
    event_outcomes,
    false_alarms,
    false_positive_sources,
    held_out,
    late_findings,
    lead_summaries,
    lead_times,
    scored_span,
)
from validation.plots import alpha_lambda_figure
from validation.prognostics import (
    ALPHA,
    alpha_lambda,
    alpha_lambda_rollup,
    coverage_rollups,
    crossing_dates,
    interval_calibration,
    load_estimates,
    threshold_reach,
    uncalibratable,
)

OUTPUT = REPO_ROOT / "VALIDATION.md"


def main() -> int:
    parser = argparse.ArgumentParser(description="Regenerate VALIDATION.md.")
    parser.add_argument(
        "--quiet", action="store_true", help="suppress the per-window detection log"
    )
    args = parser.parse_args()
    log = (lambda *a, **k: None) if args.quiet else print

    generated = datetime.now(UTC)
    graph, _ = load_merged_graph()

    # ---- detection, prognostics and attribution, as the restricted role ---
    #
    # Everything that produces a number happens inside this block, over a connection
    # the database denies access to schema groundtruth. The answer key is not opened
    # until the block has closed.
    print("=== running every scenario end to end ===")
    with psycopg.connect(resolve_dsn()) as conn:
        sweep = run_sweep(conn, graph, log=log)
        print(f"  {len(sweep.findings)} findings across {len(sweep.observed)} windows")

        estimates = load_estimates(conn)
        crossings = crossing_dates(conn)
        reaches = threshold_reach(conn)
        print(f"  {len(estimates)} published remaining-life estimates, "
              f"{len(crossings)} indicator threshold crossings observed")

        print("=== classifying every run: sensor, equipment, control or ambiguous ===")
        classifications = classify_runs(conn, sweep, log=log)

        print("=== cross-asset suppression over three windows ===")
        suppression_runs = run_suppression(conn, graph, log=log)

    # ---- the answer key, as the admin role ------------------------------
    labels, events = load_answer_key()
    severity_windows = severity_one_windows()
    print(f"=== answer key: {len(labels)} runs, {len(events)} injected faults ===")
    grid_check = [
        (scenario_id, window.grid_samples, sweep.grid_samples.get(scenario_id, 0))
        for scenario_id, window in severity_windows.items()
        if scenario_id in sweep.grid_samples
    ]
    for scenario_id, rebuilt, actual in sorted(grid_check):
        flag = "match" if rebuilt == actual else "MISMATCH"
        print(f"  grid {scenario_id:<30}{rebuilt:>8,} rebuilt {actual:>8,} in db  {flag}")

    # ---- score ----------------------------------------------------------
    days = asset_days(sweep, labels, events, severity_windows)
    alarms = false_alarms(days, sweep)
    matrix = confusion(days)
    outcomes = event_outcomes(days, sweep, events, severity_windows)
    skip = frozenset(EXCLUDED_SCENARIOS)
    leads = lead_times(sweep, events, skip)
    summaries = lead_summaries(leads)
    late = late_findings(sweep, events, skip)
    heldout = held_out(sweep, labels)
    sources = false_positive_sources(days, sweep, labels)
    span = scored_span(days)

    calibrations = interval_calibration(estimates, events, crossings, reaches)
    coverage = coverage_rollups(calibrations)
    unscoreable = uncalibratable(estimates, events)
    alpha_points = alpha_lambda(estimates, events)
    alpha_all = alpha_lambda_rollup(alpha_points, matched_only=False)
    alpha_matched = alpha_lambda_rollup(alpha_points, matched_only=True)
    figure = alpha_lambda_figure(alpha_points)
    class_outcomes = score_classifications(classifications, events)
    suppression = score_suppression(suppression_runs, events)

    # ---- write ----------------------------------------------------------
    document = report.render(
        generated=generated,
        labels=labels,
        events=events,
        severity_windows=severity_windows,
        sweep=sweep,
        span=(
            span[0].isoformat() if span else "n/a",
            span[1].isoformat() if span else "n/a",
        ),
        alarms=alarms,
        matrix=matrix,
        outcomes=outcomes,
        leads=leads,
        summaries=summaries,
        late=late,
        heldout=heldout,
        sources=sources,
        calibrations=calibrations,
        coverage=coverage,
        unscoreable=unscoreable,
        total_estimates=len(estimates),
        alpha_points=alpha_points,
        alpha_all=alpha_all,
        alpha_matched=alpha_matched,
        figure=figure,
        class_outcomes=class_outcomes,
        suppression=suppression,
        grid_check=grid_check,
    )
    OUTPUT.write_text(document)

    summarise(days, alarms, matrix, outcomes, summaries, heldout, sources)
    summarise_prognostics(
        coverage, unscoreable, len(estimates), alpha_all, alpha_matched,
        class_outcomes, suppression, figure,
    )
    print(f"\nwrote {OUTPUT.relative_to(REPO_ROOT)} "
          f"({len(document.splitlines())} lines, {len(document):,} bytes)")
    return 0


def summarise(days, alarms, matrix, outcomes, summaries, heldout, sources) -> None:
    """The same numbers the document leads with, on the terminal."""
    positive = sum(1 for d in days if d.label == POSITIVE)
    negative = sum(1 for d in days if d.label == NEGATIVE)
    excluded = len(days) - positive - negative
    healthy_days = sum(a.asset_days for a in alarms)
    healthy_findings = sum(a.findings for a in alarms)
    rate = healthy_findings / healthy_days if healthy_days else 0.0

    print(f"\n{'=' * 78}\n=== 1. FALSE ALARMS PER ASSET-DAY, healthy equipment ===")
    print(f"  {'run':<32}{'asset-days':>12}{'findings':>10}{'per asset-day':>16}")
    for entry in sorted(alarms, key=lambda a: -a.asset_days):
        print(f"  {entry.scenario_id:<32}{entry.asset_days:>12,}"
              f"{entry.findings:>10}{entry.findings_per_asset_day:>16.4f}")
    print(f"  {'ALL HEALTHY ASSET-DAYS':<32}{healthy_days:>12,}"
          f"{healthy_findings:>10}{rate:>16.4f}")

    print("\n=== 2. DETECTION AT SEVERITY LEVEL 1 ===")
    print(f"  asset-days: {positive:,} positive, {negative:,} negative, "
          f"{excluded:,} excluded")
    print(f"  TP {matrix.tp:<6} FP {matrix.fp:<6} FN {matrix.fn:<6} TN {matrix.tn:<6}")
    print(f"  precision {report.pct(matrix.precision)}   "
          f"recall {report.pct(matrix.recall)}   F1 {report.num(matrix.f1, 3)}")
    print("  where the false positives came from:")
    for entry in sources:
        share = entry.fp_days / matrix.fp if matrix.fp else 0.0
        print(f"    {entry.scenario_id:<24}{entry.asset_id:<11}{entry.fault_id:<28}"
              f"{entry.fp_days:>5} FP days ({share * 100:>4.0f}% of all FP)")
    caught = sum(1 for o in outcomes if o.caught)
    print(f"  injected faults caught while still at level 1: {caught} of {len(outcomes)}")
    for outcome in outcomes:
        print(f"    {outcome.scenario_id:<30}{outcome.asset_id:<11}"
              f"{'CAUGHT' if outcome.caught else 'MISSED':<8}"
              f"{report.num(outcome.days_after_injection):>7} days after injection  "
              f"{outcome.first_channel or '-'}")

    print("\n=== 3. LEAD TIME TO TERMINAL SEVERITY ===")
    print(f"  {'injected fault':<38}{'n':>4}{'median':>9}{'P10':>9}{'worst':>9}{'best':>9}")
    for entry in summaries:
        print(f"  {entry.fault_mode:<38}{entry.n:>4}{entry.median:>9.1f}"
              f"{entry.p10:>9.1f}{entry.minimum:>9.1f}{entry.maximum:>9.1f}")

    print("\n=== 4. THE HELD-OUT FAULT ===")
    rules = sum(1 for h in heldout if h.source == "rule")
    print(f"  rule firings on the cooling tower run: {rules}")
    for entry in heldout:
        twin = (
            "no fault-free twin -- attributable to the tower"
            if entry.calendar_twin is None
            else f"SAME finding on a fault-free run, {entry.calendar_twin} "
                 f"(same day of the year)"
        )
        print(f"    {entry.asset_id:<11}{entry.fault_id:<28}"
              f"first seen {entry.first_seen:%Y-%m-%d}  {twin}")
    if heldout and not any(h.attributable for h in heldout):
        print("  VERDICT: the held-out fault was NOT detected. Every finding on that "
              "run also fires on a fault-free run at the same point of the calendar.")


def summarise_prognostics(
    coverage, unscoreable, total_estimates, alpha_all, alpha_matched,
    class_outcomes, suppression, figure,
) -> None:
    """Sections 5 to 8 on the terminal, in the same order the document has them."""
    print("\n=== 5. RUL INTERVAL CALIBRATION  (nominal coverage 80%) ===")
    print(f"  {'population':<62}{'bnd':>6}{'cov':>6}{'coverage':>10}"
          f"{'late':>6}{'early':>6}")
    for entry in coverage:
        print(f"  {entry.label:<62}{entry.bounded:>6}{entry.covered:>6}"
              f"{report.pct(entry.coverage):>10}{entry.late:>6}{entry.early:>6}")
    groups, scoreable = unscoreable
    print(f"  published estimates: {total_estimates:,}, of which {scoreable:,} scoreable "
          f"and {sum(n for _k, n, _w in groups):,} not:")
    for key, n, _why in groups:
        print(f"    {n:>5}  {key}")

    print(f"\n=== 6. ALPHA-LAMBDA ACCURACY  (within +/-{ALPHA * 100:.0f}%) ===")
    print(f"  {'lambda':>7}{'matched':>12}{'all series':>13}{'hit rate':>11}"
          f"{'P10-P90 hit':>13}{'median rel err':>16}")
    for entry, matched in zip(alpha_all, alpha_matched, strict=True):
        err = (
            "n/a" if entry.median_relative_error is None
            else f"{entry.median_relative_error * 100:+.0f}%"
        )
        print(f"  {entry.lam:>7.1f}{f'{matched.within}/{matched.n}':>12}"
              f"{f'{entry.within}/{entry.n}':>13}"
              f"{report.pct(entry.hit_rate, 0):>11}"
              f"{f'{entry.band_hits}/{entry.n}':>13}{err:>16}")
    if figure is not None:
        print(f"  wrote {figure.relative_to(REPO_ROOT)}")

    print("\n=== 7. SENSOR VERSUS EQUIPMENT ===")
    scored = [o for o in class_outcomes if o.scoreable and o.truth is not None]
    correct = sum(1 for o in scored if o.correct)
    commonest, hits, total = majority_baseline(class_outcomes)
    print(f"  correct on {correct} of {len(scored)} injected faults; a classifier that "
          f"always answered '{commonest}' would score {hits} of {total}")
    for outcome in class_outcomes:
        if not outcome.scoreable:
            mark = outcome.skipped_reason[:44]
        else:
            mark = "correct" if outcome.correct else "WRONG"
        print(f"    {outcome.scenario_id:<30}{outcome.asset_id:<11}"
              f"truth {outcome.truth or '-':<10}said {outcome.predicted:<11}{mark}")

    print("\n=== 8. CROSS-ASSET SUPPRESSION CORRECTNESS ===")
    for case in suppression:
        print(f"    {case.label:<62}{case.verdict:<20}"
              f"ordering {'holds' if case.ordering_holds else 'BROKEN'}")
        for symptom_asset, symptom_fault, cause_asset, cause_fault in case.demotions:
            print(f"      demoted {symptom_asset}/{symptom_fault} under "
                  f"{cause_asset}/{cause_fault}")


if __name__ == "__main__":
    raise SystemExit(main())
