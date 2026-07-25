"""Run the six APAR rules over every scenario and report what fired.

Verification for checkpoint 3.3:

  * rules fired per scenario
  * false positives per asset-day on fault-free data
  * a plot of firings overlaid on mode changes, to show that nothing fires
    during a transition

    uv run python scripts/run_apar.py
    uv run python scripts/run_apar.py --plot-window 2036-03-17 --plot-days 14

The scenario windows below are stated by the operator, not read from schema
groundtruth -- this script connects as the restricted role and cannot see it.
The fault labels are NOT used to decide anything; they are only used to name the
windows in the report, and the fault-free windows are the ones a false positive
is counted against.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.rules import apar  # noqa: F401 - importing is what registers the rules
from analytics.rules.apar import POINTS_USED
from analytics.rules.evaluate import (
    MODE_SWITCH_DELAY_MINUTES,
    OCCUPANCY_DELAY_MINUTES,
    RULE_DELAY_MINUTES,
    episodes,
    run_rules,
    suppression_mask,
    sustained,
)
from analytics.rules.mode import SIGNALS, Mode, classify_frame, transitions
from analytics.rules.readings import (
    effective_quality_frame,
    load_asset_readings,
    resolve_dsn,
    signal_frames,
)
from model.loader import load_merged_graph

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

# Windows to evaluate. `clean` marks the ones with no injected air-side fault,
# which are where a firing counts as a false positive.
WINDOWS: tuple[tuple[str, str, str, bool], ...] = (
    ("lbnl-fault-free-year", "2018-01-01T06:00:00+00:00", "2019-01-01T06:00:00+00:00", True),
    ("ahu_cooling_valve_leakage", "2036-02-25T06:00:00+00:00", "2036-06-24T06:00:00+00:00", False),
    ("ahu_oa_damper_stuck", "2037-01-27T06:00:00+00:00", "2037-05-27T06:00:00+00:00", False),
    ("ahu_sat_sensor_drift", "2038-05-27T06:00:00+00:00", "2038-09-24T06:00:00+00:00", False),
    ("clean_ahu", "2039-05-27T06:00:00+00:00", "2039-09-24T06:00:00+00:00", True),
)


def evaluate_window(conn, graph, t_from: datetime, t_to: datetime):
    values, quality, flags = load_asset_readings(conn, "ahu-1", t_from, t_to)
    if values.empty:
        return None
    signals, signal_quality, signal_flags = signal_frames(values, quality, flags, SIGNALS)
    modes = classify_frame(signals, effective_quality_frame(signal_quality, signal_flags))
    outcomes = run_rules(
        graph, "ahu-1", "brick:AHU", values, quality, flags, modes, POINTS_USED
    )
    return modes, outcomes, sustained(outcomes)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the APAR rules.")
    parser.add_argument("--plot-window", default="2036-03-10")
    parser.add_argument("--plot-days", type=int, default=10)
    args = parser.parse_args()

    graph, _ = load_merged_graph()
    print(
        f"suppression: {OCCUPANCY_DELAY_MINUTES} min after occupancy starts, "
        f"{MODE_SWITCH_DELAY_MINUTES} min after each mode switch, "
        f"condition must hold {RULE_DELAY_MINUTES} min before it is reported"
    )

    all_reported: dict[str, pd.DataFrame] = {}
    with psycopg.connect(resolve_dsn()) as conn:
        for label, raw_from, raw_to, clean in WINDOWS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            result = evaluate_window(conn, graph, t_from, t_to)
            if result is None:
                print(f"\n=== {label}: no data ===")
                continue
            modes, _outcomes, reported = result
            all_reported[label] = reported

            days = (t_to - t_from).days
            suppression = suppression_mask(modes, 300)
            occupied = int((modes != Mode.UNOCCUPIED.value).sum())
            evaluable = int(suppression.evaluable.sum())

            print(f"\n{'=' * 78}\n=== {label}   {t_from.date()} .. {t_to.date()}   "
                  f"{days} days   {'FAULT-FREE' if clean else 'faulted'} ===")
            print(
                f"  {len(modes):,} samples, {occupied:,} occupied, "
                f"{evaluable:,} survive suppression ({100.0 * evaluable / max(1, occupied):.1f}% "
                f"of occupied time)"
            )

            if reported.empty:
                print("  no rule was evaluated")
                continue

            summary = (
                reported.groupby("rule_id")
                .agg(
                    evaluated=("fired", "size"),
                    raw_true=("fired", "sum"),
                    reported=("reported", "sum"),
                    peak_severity=("severity", "max"),
                )
                .reset_index()
            )
            print(f"  {'rule':<10}{'evaluated':>10}{'condition true':>16}"
                  f"{'reported':>10}{'peak sev':>10}{'per asset-day':>15}")
            for row in summary.itertuples(index=False):
                print(
                    f"  {row.rule_id:<10}{row.evaluated:>10,}{row.raw_true:>16,}"
                    f"{row.reported:>10,}{row.peak_severity:>10.2f}"
                    f"{row.reported / days:>15.3f}"
                )
            total_reported = int(summary["reported"].sum())
            print(f"  {'TOTAL':<10}{'':>10}{'':>16}{total_reported:>10,}{'':>10}"
                  f"{total_reported / days:>15.3f}"
                  + ("   <-- FALSE POSITIVES" if clean else ""))

            for row in episodes(reported).itertuples(index=False):
                print(
                    f"    episode {row.rule_id:<9} {row.t_from:%Y-%m-%d %H:%M} .. "
                    f"{row.t_to:%Y-%m-%d %H:%M}  {row.samples:>5} samples  "
                    f"peak severity {row.peak_severity:.2f}"
                )

    # ---- false positive headline ----
    print(f"\n{'=' * 78}\n=== FALSE POSITIVES PER ASSET-DAY, fault-free windows only ===")
    for label, _, _, clean in WINDOWS:
        if not clean or label not in all_reported:
            continue
        reported = all_reported[label]
        days = next(
            (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days
            for name, a, b, _ in WINDOWS
            if name == label
        )
        fired = int(reported["reported"].sum()) if not reported.empty else 0
        print(f"  {label:<26} {fired:>6,} reported over {days:>4} days "
              f"= {fired / days:.4f} per asset-day")

    # ---- transition plot ----
    plot_from = datetime.fromisoformat(args.plot_window).replace(tzinfo=UTC)
    plot_to = plot_from + timedelta(days=args.plot_days)
    with psycopg.connect(resolve_dsn()) as conn:
        result = evaluate_window(conn, graph, plot_from, plot_to)
    if result is None:
        print("\nno data in the plot window")
        return 0
    modes, _outcomes, reported = result
    changes = transitions(modes)

    fig, axes = plt.subplots(2, 1, figsize=(15, 7), sharex=True,
                             gridspec_kw={"height_ratios": [1, 2]})
    fig.suptitle(
        f"APAR firings against mode changes, {plot_from.date()} to {plot_to.date()}\n"
        f"vertical lines are mode switches; no marker may sit inside a shaded "
        f"{MODE_SWITCH_DELAY_MINUTES}-minute suppression window",
        fontsize=12,
    )

    suppression = suppression_mask(modes, 300)
    ax = axes[0]
    ax.plot(modes.index, (modes != Mode.UNOCCUPIED.value).astype(int),
            lw=0.8, color="#264653", label="occupied")
    ax.plot(modes.index, suppression.evaluable.astype(int) * 0.9,
            lw=0.8, color="#2a9d8f", label="rules evaluable")
    ax.set_yticks([0, 1])
    ax.set_ylabel("state")
    ax.legend(loc="upper right", fontsize=8, ncol=2, frameon=False)

    ax = axes[1]
    rule_ids = sorted(reported["rule_id"].unique()) if not reported.empty else []
    for position, rule_id in enumerate(rule_ids):
        group = reported[reported["rule_id"] == rule_id]
        hits = group[group["reported"]]
        ax.scatter(group["at"], [position] * len(group), s=2, color="#c8ccd4")
        ax.scatter(hits["at"], [position] * len(hits), s=14, color="#e76f51")
    for stamp in changes["at"]:
        ax.axvline(stamp, color="#999", lw=0.5, alpha=0.7)
        ax.axvspan(stamp, stamp + pd.Timedelta(minutes=MODE_SWITCH_DELAY_MINUTES),
                   color="#d1495b", alpha=0.10, linewidth=0)
    ax.set_yticks(range(len(rule_ids)))
    ax.set_yticklabels(rule_ids)
    ax.set_ylabel("rule")
    ax.set_ylim(-0.6, max(0.6, len(rule_ids) - 0.4))
    ax.grid(alpha=0.2, axis="x")
    ax.xaxis.set_major_locator(mdates.DayLocator(tz=UTC))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / f"apar_firings_{plot_from.date()}_{args.plot_days}d.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)

    # ---- the explicit check the checkpoint asks for ----
    inside = 0
    if not reported.empty:
        hits = reported[reported["reported"]]["at"]
        for stamp in changes["at"]:
            window_end = stamp + pd.Timedelta(minutes=MODE_SWITCH_DELAY_MINUTES)
            inside += int(((hits >= stamp) & (hits < window_end)).sum())
    print(f"\n=== firings inside a {MODE_SWITCH_DELAY_MINUTES}-minute post-transition "
          f"window: {inside} ===")
    print(f"  {len(changes)} mode transitions in the plot window")
    print(f"  wrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
