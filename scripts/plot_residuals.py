"""Plot constraint residuals for the fault-free run and for the sensor drift.

Verification for checkpoint 3.5. Draws the two air-side constraints over the
fault-free year and over the supply air temperature drift scenario, with the
matched clean scenario overlaid so the comparison is like for like rather than
summer against a whole year.

    uv run python scripts/plot_residuals.py

Both constraints are shown, not just the mixed air balance, because only one of
them can respond to a supply air sensor fault and it is worth seeing why.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.rules.readings import resolve_dsn

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

FAULT_FREE = ("fault-free year", "2018-01-01T06:00:00+00:00", "2019-01-01T06:00:00+00:00")
DRIFT = ("ahu_sat_sensor_drift", "2038-05-27T06:00:00+00:00", "2038-09-24T06:00:00+00:00")
CLEAN = ("clean_ahu", "2039-05-27T06:00:00+00:00", "2039-09-24T06:00:00+00:00")

CONSTRAINTS = ("MixedAirBalance", "CoilEnergyBalance")


def load(conn, constraint_id: str, t_from: str, t_to: str) -> pd.DataFrame:
    rows = conn.execute(
        "SELECT time, residual, normalised FROM app.constraint_residuals "
        " WHERE constraint_id = %s AND time >= %s AND time < %s ORDER BY time",
        (constraint_id, datetime.fromisoformat(t_from), datetime.fromisoformat(t_to)),
    ).fetchall()
    frame = pd.DataFrame(rows, columns=["time", "residual", "normalised"])
    return frame.set_index("time")


def summarise(name: str, window: str, frame: pd.DataFrame) -> None:
    if frame.empty:
        print(f"  {name:<20}{window:<24} no rows")
        return
    r = frame["residual"]
    print(
        f"  {name:<20}{window:<24}n={len(r):>6,}  mean={r.mean():+7.3f}  "
        f"median={r.median():+7.3f}  p05={r.quantile(0.05):+7.3f}  "
        f"p95={r.quantile(0.95):+7.3f}  |norm| p95={frame['normalised'].abs().quantile(0.95):5.2f}"
    )


def daily(frame: pd.DataFrame) -> pd.DataFrame:
    """Daily median and interquartile band, so a season fits on one axis."""
    grouped = frame["residual"].resample("1D")
    return pd.DataFrame(
        {
            "median": grouped.median(),
            "lo": grouped.quantile(0.25),
            "hi": grouped.quantile(0.75),
        }
    ).dropna()


def main() -> int:
    with psycopg.connect(resolve_dsn()) as conn:
        data = {
            (c, label): load(conn, c, a, b)
            for c in CONSTRAINTS
            for label, a, b in (FAULT_FREE, DRIFT, CLEAN)
        }

    print("=== constraint residuals, degC ===")
    for c in CONSTRAINTS:
        for label, _, _ in (FAULT_FREE, CLEAN, DRIFT):
            summarise(c, label, data[(c, label)])
        drift_med = data[(c, DRIFT[0])]["residual"].median()
        clean_med = data[(c, CLEAN[0])]["residual"].median()
        print(
            f"  {'':<20}{'SHIFT drift vs matched clean':<24}"
            f"{drift_med - clean_med:+7.3f} degC\n"
        )

    fig, axes = plt.subplots(2, 2, figsize=(15, 8), gridspec_kw={"width_ratios": [2, 1]})
    fig.suptitle(
        "Constraint residuals: fault-free year (left) and the supply air sensor "
        "drift against its matched clean run (right)",
        fontsize=13,
    )

    for row, constraint in enumerate(CONSTRAINTS):
        ax = axes[row][0]
        band = daily(data[(constraint, FAULT_FREE[0])])
        ax.fill_between(band.index, band["lo"], band["hi"], color="#2a9d8f", alpha=0.25,
                        linewidth=0, label="interquartile range")
        ax.plot(band.index, band["median"], lw=0.9, color="#264653", label="daily median")
        ax.axhline(0, color="#000", lw=1, ls="--", alpha=0.6)
        ax.set_title(f"{constraint} — fault-free year", fontsize=10)
        ax.set_ylabel("residual, degC")
        ax.legend(fontsize=8, frameon=False, loc="upper right")
        ax.grid(alpha=0.25)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b", tz=UTC))

        ax = axes[row][1]
        for label, colour in ((CLEAN[0], "#2a9d8f"), (DRIFT[0], "#e76f51")):
            band = daily(data[(constraint, label)])
            # Both windows are the same calendar period in different years, so the
            # drift run is shifted back one year to draw them on one axis.
            index = band.index - pd.DateOffset(years=0 if label == CLEAN[0] else -1)
            ax.plot(index, band["median"], lw=1.1, color=colour, label=label)
        ax.axhline(0, color="#000", lw=1, ls="--", alpha=0.6)
        ax.set_title(f"{constraint} — drift vs matched clean", fontsize=10)
        ax.legend(fontsize=8, frameon=False, loc="upper right")
        ax.grid(alpha=0.25)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / "constraint_residuals.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"wrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
