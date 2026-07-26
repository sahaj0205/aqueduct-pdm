"""Report every fitted baseline and plot the air-handler residuals.

Verification for checkpoints 4.1 and 4.2. Prints R-squared and residual standard
deviation for every baseline on every run and asset -- air handler and chillers
through the same call -- then draws the air-handler residuals for the clean run
against the cooling coil valve leakage run so the flat case and the drifting case
sit side by side.

    uv run python scripts/plot_baselines.py
"""

from __future__ import annotations

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

from analytics.baselines.fit import (
    AHU_SPANS,
    COMMISSIONING_DAYS,
    RUNS,
    asset_classes,
    chiller_derive,
    commissioning_window,
    fit_asset_baselines,
    load_points,
    role_arrays,
)
from analytics.rules.readings import resolve_dsn

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

BASELINE_SUPPLY_AIR_TEMP = "ahu-1.sa_temp.coil-effectiveness"
BASELINE_FAN_POWER = "ahu-1.sf_power.fan-similarity"

BASELINES = (BASELINE_SUPPLY_AIR_TEMP, BASELINE_FAN_POWER)
LABELS = {
    BASELINE_SUPPLY_AIR_TEMP: "supply air temperature residual, degC",
    BASELINE_FAN_POWER: "supply fan power residual, W",
}

# The two runs drawn against each other: a clean run and the coil valve leak.
FLAT = "clean_ahu"
DRIFTING = "ahu_cooling_valve_leakage"


def load(conn, baseline_id: str, t_from: datetime, t_to: datetime) -> pd.DataFrame:
    rows = conn.execute(
        "SELECT time, observed, expected, residual, normalised "
        "  FROM app.residuals "
        " WHERE baseline_id = %s AND time >= %s AND time < %s ORDER BY time",
        (baseline_id, t_from, t_to),
    ).fetchall()
    frame = pd.DataFrame(
        rows, columns=["time", "observed", "expected", "residual", "normalised"]
    )
    return frame.set_index("time")


def daily(frame: pd.DataFrame) -> pd.DataFrame:
    """Daily median and interquartile band, so four months fit on one axis."""
    grouped = frame["residual"].resample("1D")
    return pd.DataFrame(
        {
            "median": grouped.median(),
            "lo": grouped.quantile(0.25),
            "hi": grouped.quantile(0.75),
        }
    ).dropna()


def kw_per_ton_sd(conn, baseline, window) -> float | None:
    """Restate a chiller power residual spread as kW per ton of refrigeration.

    The fit is on electrical power, because that is the quantity a real point
    carries and app.residuals keys on a point. Efficiency is what an engineer
    reads, so the same spread is reported in both.
    """
    if baseline.form.name != "chiller-efficiency":
        return None
    t_from, t_to = window
    values, _ = load_points(conn, list(baseline.drivers), t_from, t_to)
    roles = chiller_derive(role_arrays(baseline.driver_roles, values))
    tons = roles["tons"]
    usable = tons >= 20.0
    return float(baseline.residual_sd / 1000.0 / tons[usable].mean())


def main() -> int:
    with psycopg.connect(resolve_dsn()) as conn:
        print("=== fits, one set per run and asset, on the first "
              f"{COMMISSIONING_DAYS} days of each ===")
        print(f"  {'run':<30}{'asset':<11}{'baseline':<20}{'R2':>10}"
              f"{'resid sd':>12}  unit")
        classes = asset_classes(conn)
        for label, assets, raw_from, _ in RUNS:
            window = commissioning_window(datetime.fromisoformat(raw_from))
            for asset_id in assets:
                fitted, refused = fit_asset_baselines(
                    conn, asset_id, classes[asset_id], window
                )
                for baseline in fitted:
                    short = baseline.baseline_id.split(".")[-1]
                    extra = kw_per_ton_sd(conn, baseline, window)
                    tail = "" if extra is None else f"   = {extra:.5f} kW/ton"
                    print(f"  {label:<30}{asset_id:<11}{short:<20}"
                          f"{baseline.r_squared:10.5f}{baseline.residual_sd:12.4f}"
                          f"  {baseline.unit}{tail}")
                for message in refused:
                    print(f"  {label:<30}{asset_id:<11}REFUSED  {message.split(': ', 1)[1]}")

        spans = {label: (a, b) for label, a, b in AHU_SPANS}
        data = {}
        for run in (FLAT, DRIFTING):
            a, b = spans[run]
            for baseline_id in BASELINES:
                data[(run, baseline_id)] = load(
                    conn, baseline_id, datetime.fromisoformat(a), datetime.fromisoformat(b)
                )

    print("\n=== residual distribution over each whole run ===")
    print(f"  {'run':<26}{'baseline':<22}{'n':>8}{'median':>10}{'p05':>10}"
          f"{'p95':>10}{'|norm| p95':>12}")
    for run in (FLAT, DRIFTING):
        for baseline_id in BASELINES:
            f = data[(run, baseline_id)]
            r = f["residual"]
            short = baseline_id.split(".")[-1]
            print(f"  {run:<26}{short:<22}{len(r):8,}{r.median():10.4f}"
                  f"{r.quantile(0.05):10.4f}{r.quantile(0.95):10.4f}"
                  f"{f['normalised'].abs().quantile(0.95):12.2f}")

    # The leak only bites when the coil is not modulating, so the run is split at
    # the end of the commissioning window to show before against after.
    print(f"\n=== {DRIFTING}: commissioning window against the rest of the run ===")
    a, _ = spans[DRIFTING]
    boundary = datetime.fromisoformat(a) + timedelta(days=COMMISSIONING_DAYS)
    for baseline_id in BASELINES:
        f = data[(DRIFTING, baseline_id)]
        early, late = f[f.index < boundary], f[f.index >= boundary]
        short = baseline_id.split(".")[-1]
        print(f"  {short:<22} first {COMMISSIONING_DAYS} days median "
              f"{early['residual'].median():+9.4f}   rest of run median "
              f"{late['residual'].median():+9.4f}   shift "
              f"{late['residual'].median() - early['residual'].median():+9.4f}")
        # Monthly medians make a slow drift legible where a single median does not.
        monthly = f["residual"].resample("30D").median()
        print("      30-day medians: "
              + "  ".join(f"{t.date()} {r:+7.3f}" for t, r in monthly.items()))

    fig, axes = plt.subplots(2, 2, figsize=(15, 8), sharex="col")
    fig.suptitle(
        "Condition-normalised baseline residuals: a clean run (left) and the "
        "cooling coil valve leak (right)",
        fontsize=13,
    )
    for row, baseline_id in enumerate(BASELINES):
        for col, run in enumerate((FLAT, DRIFTING)):
            ax = axes[row][col]
            frame = data[(run, baseline_id)]
            band = daily(frame)
            colour = "#2a9d8f" if run == FLAT else "#e76f51"
            ax.fill_between(band.index, band["lo"], band["hi"], color=colour,
                            alpha=0.25, linewidth=0, label="interquartile range")
            ax.plot(band.index, band["median"], lw=1.0, color="#264653",
                    label="daily median")
            ax.axhline(0, color="#000", lw=1, ls="--", alpha=0.6)
            start = frame.index.min()
            ax.axvspan(start, start + timedelta(days=COMMISSIONING_DAYS),
                       color="#888", alpha=0.12, linewidth=0)
            ax.text(start + timedelta(days=1), ax.get_ylim()[1],
                    "  fitted here", va="top", fontsize=7, color="#555")
            ax.set_title(f"{run} — {baseline_id.split('.')[-1]}", fontsize=10)
            if col == 0:
                ax.set_ylabel(LABELS[baseline_id])
            ax.legend(fontsize=8, frameon=False, loc="lower left")
            ax.grid(alpha=0.25)
            ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / "baseline_residuals.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"\nwrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
