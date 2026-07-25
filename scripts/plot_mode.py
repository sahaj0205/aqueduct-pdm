"""Plot the detected air handler operating mode and the signals behind it.

Verification for checkpoint 3.2. The mode drives which fault rules are allowed
to run, so a mode that is wrong -- or that flickers -- quietly breaks every rule
downstream of it. This draws the classification against the signals it was
derived from so the transitions can be checked against physical sense: the unit
should wake when the building opens, economize when the outside air is useful,
and fall back to mechanical cooling when it is not.

    uv run python scripts/plot_mode.py
    uv run python scripts/plot_mode.py --from 2018-07-16 --days 7

Writes to docs/plots/, which is gitignored -- the script is the artefact, not
the image.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import psycopg

# Run as a script, so the repo root is not on the path -- same as plot_scenario.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.rules.mode import SIGNALS, Mode, classify_frame, transitions
from analytics.rules.readings import (
    effective_quality_frame,
    load_asset_readings,
    resolve_dsn,
    signal_frames,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

# A colour per mode. Cool colours for the free and unoccupied states, warm for
# the ones that cost money, so an expensive week looks expensive at a glance.
COLOURS = {
    Mode.UNOCCUPIED.value: "#c8ccd4",
    Mode.HEATING.value: "#d1495b",
    Mode.FREE_COOLING.value: "#2a9d8f",
    Mode.MECHANICAL_COOLING_WITH_ECONOMIZER.value: "#e9c46a",
    Mode.MECHANICAL_COOLING_NO_ECONOMIZER.value: "#e76f51",
    Mode.UNKNOWN.value: "#000000",
}


def summarise(label: str, modes) -> None:
    counts = modes.value_counts()
    total = len(modes)
    print(f"\n=== mode share, {label} ({total:,} samples at 5 min) ===")
    for mode in Mode:
        n = int(counts.get(mode.value, 0))
        if n:
            print(f"  {mode.value:<40} {n:>7,}  {100.0 * n / total:>6.2f}%   {n * 5 / 60:>7.1f} h")


def main() -> int:
    parser = argparse.ArgumentParser(description="Plot AHU operating mode.")
    # Defaults to a week in April: the shoulder season is when an economizer
    # actually has to make decisions, so it is the week that exercises the
    # classification hardest. Midsummer would sit in one mode for seven days.
    parser.add_argument("--from", dest="start", default="2018-04-16")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()

    # The stored timestamps are UTC and the building runs six hours behind, so
    # anchor the window to local midnight rather than UTC midnight; otherwise the
    # plot starts at 6pm and every occupancy block straddles a day boundary.
    local = timezone(timedelta(hours=-6))
    t_from = datetime.fromisoformat(args.start).replace(tzinfo=local)
    t_to = t_from + timedelta(days=args.days)

    with psycopg.connect(resolve_dsn()) as conn:
        january = t_from.replace(month=1, day=1)
        year_values, year_quality, year_flags = load_asset_readings(
            conn, "ahu-1", january, january + timedelta(days=365)
        )
        values, quality, flags = load_asset_readings(conn, "ahu-1", t_from, t_to)

    if values.empty:
        print(f"no readings for ahu-1 between {t_from} and {t_to}")
        return 1

    yv, yq, yf = signal_frames(year_values, year_quality, year_flags, SIGNALS)
    year_modes = classify_frame(yv, effective_quality_frame(yq, yf))
    summarise(f"whole year from {january.date()}", year_modes)

    signals, signal_quality, signal_flags = signal_frames(values, quality, flags, SIGNALS)
    modes = classify_frame(signals, effective_quality_frame(signal_quality, signal_flags))
    summarise(f"{t_from.date()} .. {t_to.date()}", modes)

    changes = transitions(modes)
    per_day = len(changes) / max(1, args.days)
    print(f"\n=== transitions in the window: {len(changes)} ({per_day:.1f} per day) ===")
    for row in changes.itertuples(index=False):
        print(f"  {row.at.tz_convert(local):%Y-%m-%d %H:%M}   {row.from_mode:<38} -> {row.to_mode}")

    # ---- plot ----
    fig, axes = plt.subplots(
        3, 1, figsize=(15, 9), sharex=True, gridspec_kw={"height_ratios": [1.1, 2, 2]}
    )
    fig.suptitle(
        f"AHU-1 operating mode, {t_from.date()} to {t_to.date()}  "
        f"({len(changes)} transitions, {per_day:.1f}/day)",
        fontsize=13,
    )

    # Mode band. Drawn as one span per contiguous stretch rather than a scatter,
    # so a mode held for six hours reads as a block of time and not as dots.
    ax = axes[0]
    block_start = modes.index[0]
    current = modes.iloc[0]
    for stamp, mode in list(modes.items())[1:] + [(modes.index[-1], None)]:
        if mode != current:
            ax.axvspan(block_start, stamp, color=COLOURS.get(current, "#888"), linewidth=0)
            block_start, current = stamp, mode
    ax.set_yticks([])
    ax.set_ylabel("mode")
    present = [m for m in Mode if (modes == m.value).any()]
    ax.legend(
        handles=[mpatches.Patch(color=COLOURS[m.value], label=m.value) for m in present],
        loc="upper left",
        bbox_to_anchor=(0, -0.12),
        ncol=3,
        fontsize=8,
        frameon=False,
    )

    ax = axes[1]
    ax.plot(signals.index, signals["mixed_air_temp"], lw=0.9, label="mixed air", color="#264653")
    ax.plot(
        values.index, values["ahu-1.oa_temp"], lw=0.9, label="outside air", color="#2a9d8f"
    )
    ax.plot(values.index, values["ahu-1.sa_temp"], lw=0.9, label="supply air", color="#e76f51")
    ax.plot(
        signals.index,
        signals["supply_air_setpoint"],
        lw=1.2,
        ls="--",
        label="supply setpoint",
        color="#000000",
    )
    ax.set_ylabel("degC")
    ax.legend(loc="upper right", fontsize=8, ncol=4, frameon=False)
    ax.grid(alpha=0.25)

    ax = axes[2]
    ax.plot(
        signals.index,
        signals["outside_air_damper"],
        lw=0.9,
        label="outside air damper",
        color="#2a9d8f",
    )
    ax.plot(
        signals.index, signals["cooling_valve"], lw=0.9, label="cooling valve", color="#e76f51"
    )
    ax.axhline(0.10, color="#666", ls=":", lw=1, label="minimum outside air (0.10)")
    ax.set_ylabel("position 0-1")
    ax.set_ylim(-0.05, 1.05)
    ax.legend(loc="upper right", fontsize=8, ncol=3, frameon=False)
    ax.grid(alpha=0.25)
    ax.xaxis.set_major_locator(mdates.DayLocator(tz=local))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%a %d %b", tz=local))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / f"mode_{t_from.date()}_{args.days}d.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"\nwrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
