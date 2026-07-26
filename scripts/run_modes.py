"""Compute every degradation indicator across every scenario, and plot them.

Verification for checkpoint 4.3. Prints the config table with its thresholds and
rationales, then evaluates each mode on each asset over each run and reports how
far the indicator travelled toward failure. The plot puts each indicator's own
scenario against the matched clean run so the direction of travel is visible.

    uv run python scripts/run_modes.py
"""

from __future__ import annotations

import sys
import textwrap
from datetime import UTC, datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.baselines.fit import RUNS, asset_classes
from analytics.health.modes import (
    indicators_for_asset,
    load_failure_modes,
    modes_for_class,
)
from analytics.rules.readings import resolve_dsn

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

# Which run each mode is expected to move on, and the clean run to compare it
# against. Modes absent from here have no scenario in this project, which is
# reported rather than hidden.
OWN_SCENARIO = {
    "coil-valve-leak-by": ("ahu_cooling_valve_leakage", "clean_ahu", "ahu-1"),
    "chiller-condenser-fouling": ("chiller_condenser_fouling", "clean_chiller", "chiller-1"),
    "chiller-efficiency-loss": ("chiller_condenser_fouling", "clean_chiller", "chiller-1"),
}


def daily(series: pd.Series) -> pd.DataFrame:
    grouped = series.resample("1D")
    return pd.DataFrame(
        {"median": grouped.median(), "lo": grouped.quantile(0.25),
         "hi": grouped.quantile(0.75)}
    ).dropna()


def main() -> int:
    collected: dict[tuple[str, str, str], pd.Series] = {}

    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        print(f"=== app.failure_modes: {len(modes)} rows ===")
        for mode in modes:
            state = "computable" if mode.computable else "DECLARED, NOT COMPUTABLE"
            print(f"\n  {mode.mode_id}  [{mode.brick_class}]  {state}")
            print(f"    {mode.mode_name} — fails at {mode.failure_threshold:g} "
                  f"{mode.indicator_unit}")
            if mode.indicator_expression:
                print(f"    indicator:    {mode.indicator_expression}")
            if mode.applies_when:
                print(f"    applies when: {mode.applies_when}")
            print(textwrap.fill(mode.threshold_rationale, 78,
                                initial_indent="    why: ", subsequent_indent="         "))

        print("\n\n=== indicators across every run ===")
        print(f"  {'run':<30}{'asset':<11}{'mode':<28}{'n':>7}{'median':>10}"
              f"{'final':>10}{'thr':>8}{'% of thr':>10}")
        for label, assets, raw_from, raw_to in RUNS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            for asset_id in assets:
                brick_class = classes[asset_id]
                series, skipped = indicators_for_asset(
                    conn, asset_id, brick_class, modes, t_from, t_to
                )
                for mode_id, values in sorted(series.items()):
                    collected[(label, asset_id, mode_id)] = values
                    mode = next(m for m in modes if m.mode_id == mode_id)
                    if values.empty:
                        print(f"  {label:<30}{asset_id:<11}{mode_id:<28}"
                              f"{0:>7}  no instants the gate admits")
                        continue
                    tail = values.tail(max(1, len(values) // 10))
                    final = float(tail.median())
                    print(f"  {label:<30}{asset_id:<11}{mode_id:<28}{len(values):>7,}"
                          f"{values.median():>10.3f}{final:>10.3f}"
                          f"{mode.failure_threshold:>8.3g}"
                          f"{100 * final / mode.failure_threshold:>9.1f}%")
                for message in skipped:
                    print(f"  {label:<30}{asset_id:<11}SKIPPED  {message}")

        print("\n=== declared but not computable ===")
        for asset_id, brick_class in sorted(classes.items()):
            for mode in modes_for_class(modes, brick_class):
                if not mode.computable:
                    print(f"  {asset_id:<12}{mode.mode_id:<24}{mode.mode_name}")

    print("\n=== direction of travel on each mode's own scenario ===")
    print(f"  {'mode':<28}{'faulted run final':>20}{'clean run final':>18}"
          f"{'moves':>8}")
    for mode_id, (faulted, clean, asset_id) in OWN_SCENARIO.items():
        f = collected.get((faulted, asset_id, mode_id))
        c = collected.get((clean, asset_id, mode_id))
        if f is None or c is None or f.empty or c.empty:
            print(f"  {mode_id:<28} missing data")
            continue
        fv = float(f.tail(max(1, len(f) // 10)).median())
        cv = float(c.tail(max(1, len(c) // 10)).median())
        print(f"  {mode_id:<28}{fv:>20.3f}{cv:>18.3f}"
              f"{'UP' if fv > cv else 'DOWN':>8}")

    thresholds = {m.mode_id: m.failure_threshold for m in modes}
    fig, axes = plt.subplots(len(OWN_SCENARIO), 1, figsize=(13, 3.2 * len(OWN_SCENARIO)))
    fig.suptitle(
        "Degradation indicators: each mode on its own scenario against the matched "
        "clean run, with its failure threshold",
        fontsize=12,
    )
    for ax, (mode_id, (faulted, clean, asset_id)) in zip(
        axes, OWN_SCENARIO.items(), strict=True
    ):
        for run, colour in ((clean, "#2a9d8f"), (faulted, "#e76f51")):
            series = collected.get((run, asset_id, mode_id))
            if series is None or series.empty:
                continue
            band = daily(series)
            # The two runs are the same calendar period in different years, so the
            # faulted run is shifted onto the clean run's axis by whole years.
            shift = pd.DateOffset(years=band.index[0].year - 2039)
            index = band.index - shift
            ax.fill_between(index, band["lo"], band["hi"], color=colour, alpha=0.20,
                            linewidth=0)
            ax.plot(index, band["median"], lw=1.1, color=colour, label=run)
        threshold = thresholds[mode_id]
        ax.axhline(threshold, color="#b00", lw=1.2, ls="--",
                   label=f"failure threshold {threshold:g}")
        ax.axhline(0, color="#000", lw=0.8, ls=":", alpha=0.5)
        ax.set_title(mode_id, fontsize=10)
        ax.legend(fontsize=8, frameon=False, loc="upper left")
        ax.grid(alpha=0.25)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / "degradation_indicators.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"\nwrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
