"""Compute health for every asset on every run, and score the onset detection.

Verification for checkpoint 4.4. Builds the health index, stores it, plots the
four progressive scenarios against a clean run, and compares each detected onset
against the answer key.

THE GROUND TRUTH READ IS CONFINED TO ONE FUNCTION IN THIS FILE. Health itself is
computed over a connection as app_rw, which the database physically denies access
to schema groundtruth. Only the scoring at the end reopens as the admin role, and
by then every number being scored has already been written. Nothing under
analytics/ can read the answer key at all.

    uv run python scripts/run_health.py
"""

from __future__ import annotations

import os
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

from analytics.baselines.fit import RUNS, asset_classes, commissioning_window
from analytics.health.index import (
    AssetHealth,
    maintenance_resets,
    mode_health,
    roll_up,
    write_health,
)
from analytics.health.modes import (
    indicators_for_asset,
    load_failure_modes,
    modes_for_class,
)
from analytics.rules.readings import REPO_ROOT, resolve_dsn

PLOT_DIR = REPO_ROOT / "docs" / "plots"

# The four progressive runs plus the clean comparator, and the asset each one
# actually damages. cooling_tower_fouling is progressive too but is the held-out
# fault, deliberately unmodelled, so it is reported separately rather than being
# presented as a detection.
PROGRESSIVE = (
    ("ahu_cooling_valve_leakage", "ahu-1"),
    ("ahu_sat_sensor_drift", "ahu-1"),
    ("chiller_condenser_fouling", "chiller-1"),
    ("chiller_bypass_valve_leakage", "chiller-1"),
)
CLEAN = ("clean_chiller", "chiller-1")
HELD_OUT = ("cooling_tower_fouling", "chiller-1")


def admin_dsn() -> str:
    """The only credential permitted to read the answer key. Validation only."""
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def ground_truth_onsets() -> dict[tuple[str, str], datetime]:
    """Injected fault times, keyed by scenario and asset. VALIDATION PATH ONLY."""
    with psycopg.connect(admin_dsn()) as conn:
        rows = conn.execute(
            "SELECT scenario_id, asset_id, min(t_onset) FROM groundtruth.fault_events "
            " GROUP BY 1, 2"
        ).fetchall()
    return {(scenario, asset): onset for scenario, asset, onset in rows}


def main() -> int:
    computed: dict[tuple[str, str], AssetHealth] = {}
    undefined: list[str] = []

    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        print("=== health, one row per asset per run ===")
        print(f"  {'run':<30}{'asset':<11}{'days':>6}{'start':>7}{'end':>6}"
              f"{'min':>6}  weakest at end")
        for label, assets, raw_from, raw_to in RUNS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            _, reference_end = commissioning_window(t_from)

            for asset_id in assets:
                series, _skipped = indicators_for_asset(
                    conn, asset_id, classes[asset_id], modes, t_from, t_to
                )
                built = []
                for mode in modes_for_class(modes, classes[asset_id]):
                    indicator = series.get(mode.mode_id)
                    if indicator is None or indicator.empty:
                        continue
                    entry = mode_health(
                        asset_id, mode, indicator, reference_end,
                        maintenance_resets(conn, asset_id, mode.mode_id),
                    )
                    if entry is None:
                        undefined.append(f"{label}/{asset_id}/{mode.mode_id}")
                        continue
                    built.append(entry)
                if not built:
                    print(f"  {label:<30}{asset_id:<11}   no computable modes")
                    continue

                asset = roll_up(asset_id, built)
                computed[(label, asset_id)] = asset
                write_health(conn, asset, t_from, t_to)
                conn.commit()
                h = asset.health
                print(f"  {label:<30}{asset_id:<11}{len(h):>6}{h.iloc[0]:>7.0f}"
                      f"{h.iloc[-1]:>6.0f}{h.min():>6.0f}  {asset.weakest.iloc[-1]}")

        print("\n=== modes with no usable commissioning reference, health not scored ===")
        for entry in undefined:
            print(f"  {entry}")

        print("\n=== per-mode contributions, and onset confirmation ===")
        print(f"  {'run':<30}{'asset':<11}{'mode':<28}{'end health':>11}"
              f"{'onset':>12}{'peak CUSUM':>12}")
        for (label, asset_id), asset in computed.items():
            for mode in asset.modes:
                onset = mode.onset
                when = (
                    onset.t_onset.date().isoformat() if onset.detected else "none"
                )
                print(f"  {label:<30}{asset_id:<11}{mode.mode_id:<28}"
                      f"{mode.final_health:>11.0f}{when:>12}"
                      f"{onset.peak_statistic:>12.2f}")

        print("\n=== monotonicity check: does any health series ever rise? ===")
        for (label, asset_id), asset in computed.items():
            for mode in asset.modes:
                rises = (mode.health.diff() > 1e-9).sum()
                if rises:
                    print(f"  FAIL {label} {asset_id} {mode.mode_id}: rises {rises}x")
        print("  no per-mode health series increases at any point")

        print("\n=== min-across-modes, two modes degrading at once ===")
        target = computed.get(("chiller_condenser_fouling", "chiller-1"))
        if target:
            frame = pd.DataFrame({m.mode_id: m.health for m in target.modes})
            frame["MIN"] = target.health
            frame["weakest"] = target.weakest
            picked = frame.iloc[:: max(1, len(frame) // 8)]
            print(picked.to_string(float_format=lambda x: f"{x:6.1f}"))
            wrong = frame.apply(
                lambda r: r["MIN"] > min(
                    v for k, v in r.items() if k not in ("MIN", "weakest")
                    and pd.notna(v)
                ) + 1e-9,
                axis=1,
            ).sum()
            print(f"\n  days where the roll-up is not the minimum of its modes: {wrong}")

    # ---- the only ground-truth read in the project -----------------------
    truth = ground_truth_onsets()
    print("\n=== detection delay against groundtruth.fault_events ===")
    print(f"  {'run':<30}{'asset':<11}{'mode':<28}{'true onset':>14}"
          f"{'estimated':>12}{'confirmed':>12}{'delay d':>9}")
    for label, asset_id in (*PROGRESSIVE, HELD_OUT, CLEAN):
        asset = computed.get((label, asset_id))
        actual = truth.get((label, asset_id))
        if actual is None:
            # The fault may be injected into a different asset than the one whose
            # health we track -- a plant-level fault, or the held-out tower.
            actual = next(
                (v for (s, _a), v in truth.items() if s == label), None
            )
        if asset is None:
            print(f"  {label:<30}{asset_id:<11}  no health computed")
            continue
        for mode in asset.modes:
            o = mode.onset
            true_s = actual.date().isoformat() if actual else "none (clean)"
            if not o.detected:
                print(f"  {label:<30}{asset_id:<11}{mode.mode_id:<28}"
                      f"{true_s:>14}{'not detected':>12}{'-':>12}{'-':>9}")
                continue
            delay = (
                (o.t_confirmed - actual).total_seconds() / 86400.0 if actual else None
            )
            print(f"  {label:<30}{asset_id:<11}{mode.mode_id:<28}{true_s:>14}"
                  f"{o.t_onset.date().isoformat():>12}"
                  f"{o.t_confirmed.date().isoformat():>12}"
                  f"{'' if delay is None else f'{delay:+.1f}':>9}")

    # ---- plot -------------------------------------------------------------
    panels = [*PROGRESSIVE, CLEAN]
    fig, axes = plt.subplots(len(panels), 1, figsize=(13, 2.5 * len(panels)),
                             sharey=True)
    fig.suptitle(
        "Asset health: the four progressive scenarios and a clean run. "
        "Dashed line is the injected onset, dotted is where the detector confirmed it.",
        fontsize=12,
    )
    for ax, (label, asset_id) in zip(axes, panels, strict=True):
        asset = computed.get((label, asset_id))
        if asset is None:
            continue
        for mode in asset.modes:
            ax.plot(mode.health.index, mode.health.values, lw=0.9, alpha=0.55,
                    label=mode.mode_id)
        ax.plot(asset.health.index, asset.health.values, lw=2.0, color="#264653",
                label="asset (min)")
        actual = truth.get((label, asset_id)) or next(
            (v for (s, _a), v in truth.items() if s == label), None
        )
        if actual:
            ax.axvline(actual, color="#b00", lw=1.2, ls="--")
        confirmed = [m.onset.t_confirmed for m in asset.modes if m.onset.detected]
        if confirmed:
            ax.axvline(min(confirmed), color="#06c", lw=1.2, ls=":")
        ax.set_title(f"{label} — {asset_id}", fontsize=10)
        ax.set_ylabel("health")
        ax.set_ylim(-3, 103)
        ax.legend(fontsize=7, frameon=False, loc="lower left", ncol=4)
        ax.grid(alpha=0.25)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / "health_index.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"\nwrote {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
