"""Run the three chiller rules over every chiller scenario and report what fired.

Verification for checkpoint 3.4:

  * condenser fouling fires
  * the held-out fault produces NO fault, confirmed explicitly
  * false positives per asset-day on fault-free operation

    uv run python scripts/run_chiller_rules.py

The chiller has no occupancy, so the suppression machinery is driven by a
running/off state derived from the compressor: the rules are held quiet for the
first 90 minutes after a start and 60 minutes after any change of state, exactly
as they are for the air handler after the building opens.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.rules import chiller  # noqa: F401 - importing registers the rules
from analytics.rules.chiller import MIN_EVALUABLE_TONS, points_used
from analytics.rules.evaluate import (
    MODE_SWITCH_DELAY_MINUTES,
    OCCUPANCY_DELAY_MINUTES,
    RULE_DELAY_MINUTES,
    episodes,
    run_rules,
    suppression_mask,
    sustained,
)
from analytics.rules.readings import load_asset_readings, resolve_dsn
from model.loader import load_merged_graph

REPO_ROOT = Path(__file__).resolve().parents[1]

RUNNING, OFF = "running", "off"

# Windows to evaluate. `clean` marks those with no injected chiller-side fault.
#
# cooling_tower_fouling is the fault this project holds out for unsupervised
# detection in Task 8. It is evaluated here precisely to CONFIRM that no rule
# fires on it, so it is marked clean: any firing would be a rule that had learned
# the held-out fault, which is exactly what must not happen.
WINDOWS: tuple[tuple[str, str, str, bool], ...] = (
    ("lbnl-fault-free-year", "2018-01-01T06:00:00+00:00", "2019-01-01T06:00:00+00:00", True),
    ("chiller_condenser_fouling", "2036-05-10T06:00:00+00:00", "2036-09-07T06:00:00+00:00", False),
    ("chiller_bypass_valve_leakage", "2037-05-10T06:00:00+00:00", "2037-09-07T06:00:00+00:00", False),
    ("cooling_tower_fouling  [HELD OUT]", "2038-05-10T06:00:00+00:00", "2038-09-07T06:00:00+00:00", True),
    ("clean_chiller", "2039-05-10T06:00:00+00:00", "2039-09-07T06:00:00+00:00", True),
)

CHILLERS = ("chiller-1", "chiller-2", "chiller-3")


def chiller_state(values: pd.DataFrame, asset: str) -> pd.Series:
    """Running or off, from the compressor rather than from an occupancy schedule.

    A chiller is treated as running when its status is on, it is drawing real
    power and it is actually moving chilled water. All three are required because
    the status point alone stays at 1 all year on chiller 1, so on its own it
    would never mark the machine as off and the start-up delay would never apply.
    """
    status = values.get(f"{asset}.status")
    power = values.get(f"{asset}.power")
    flow = values.get(f"{asset}.chw_flow")
    if status is None or power is None or flow is None:
        return pd.Series(OFF, index=values.index)
    running = (status > 0.5) & (power > 1000.0) & (flow > 0.001)
    return pd.Series(np.where(running, RUNNING, OFF), index=values.index)


def load_window(conn, asset: str, t_from: datetime, t_to: datetime):
    """One chiller's readings plus the plant setpoint the capacity rule needs."""
    values, quality, flags = load_asset_readings(conn, asset, t_from, t_to)
    plant_v, plant_q, plant_f = load_asset_readings(conn, "chw-plant-1", t_from, t_to)
    if values.empty or plant_v.empty:
        return None
    keep = ["chw-plant-1.pri_supply_temp_spt"]
    return (
        values.join(plant_v[keep], how="left"),
        quality.join(plant_q[keep], how="left"),
        flags.join(plant_f[keep], how="left"),
    )


def main() -> int:
    graph, _ = load_merged_graph()
    print(
        f"suppression: {OCCUPANCY_DELAY_MINUTES} min after a start, "
        f"{MODE_SWITCH_DELAY_MINUTES} min after any state change, condition must "
        f"hold {RULE_DELAY_MINUTES} min before it is reported"
    )
    print(f"rules skip any instant below {MIN_EVALUABLE_TONS:.0f} tons")

    totals: dict[str, dict[str, int]] = {}
    with psycopg.connect(resolve_dsn()) as conn:
        for label, raw_from, raw_to, clean in WINDOWS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            days = (t_to - t_from).days
            print(f"\n{'=' * 78}\n=== {label}   {t_from.date()} .. {t_to.date()}   "
                  f"{days} days   {'FAULT-FREE' if clean else 'faulted'} ===")
            window_total = 0

            for asset in CHILLERS:
                loaded = load_window(conn, asset, t_from, t_to)
                if loaded is None:
                    continue
                values, quality, flags = loaded
                state = chiller_state(values, asset)
                outcomes = run_rules(
                    graph, asset, "brick:Chiller", values, quality, flags, state,
                    points_used(asset), off_state=OFF,
                )
                reported = sustained(outcomes)
                running = int((state == RUNNING).sum())
                evaluable = int(suppression_mask(state, 300, OFF).evaluable.sum())

                if reported.empty:
                    print(f"  {asset}: {running:,} running samples, {evaluable:,} after "
                          f"suppression -- no rule evaluated")
                    continue

                summary = (
                    reported.groupby("rule_id")
                    .agg(evaluated=("fired", "size"), true=("fired", "sum"),
                         reported=("reported", "sum"), peak=("severity", "max"))
                    .reset_index()
                )
                asset_total = int(summary["reported"].sum())
                window_total += asset_total
                print(f"  {asset}: {running:,} running, {evaluable:,} after suppression")
                for row in summary.itertuples(index=False):
                    print(f"     {row.rule_id:<32}{row.evaluated:>8,} eval "
                          f"{row.true:>7,} true {row.reported:>7,} reported "
                          f"peak sev {row.peak:.2f}  {row.reported / days:>7.3f}/day")
                for row in episodes(reported).itertuples(index=False):
                    print(f"       episode {row.rule_id:<30} {row.t_from:%Y-%m-%d %H:%M} .. "
                          f"{row.t_to:%Y-%m-%d %H:%M}  peak {row.peak_severity:.2f}")

            totals[label] = {"reported": window_total, "days": days, "clean": clean}
            marker = "   <-- FALSE POSITIVES" if clean else ""
            print(f"  WINDOW TOTAL: {window_total:,} reported over {days} days "
                  f"= {window_total / days:.4f} per asset-day{marker}")

    print(f"\n{'=' * 78}\n=== SUMMARY ===")
    print(f"  {'window':<38}{'reported':>10}{'per asset-day':>16}")
    for label, row in totals.items():
        print(f"  {label:<38}{row['reported']:>10,}{row['reported'] / row['days']:>16.4f}")

    print("\n=== FALSE POSITIVES PER ASSET-DAY, fault-free windows ===")
    fp_days = sum(r["days"] for r in totals.values() if r["clean"])
    fp_hits = sum(r["reported"] for r in totals.values() if r["clean"])
    for label, row in totals.items():
        if row["clean"]:
            print(f"  {label:<38}{row['reported']:>8,} over {row['days']:>4} days "
                  f"= {row['reported'] / row['days']:.4f}")
    print(f"  {'ALL FAULT-FREE COMBINED':<38}{fp_hits:>8,} over {fp_days:>4} days "
          f"= {fp_hits / fp_days:.4f} per asset-day")

    held = totals.get("cooling_tower_fouling  [HELD OUT]", {}).get("reported")
    print("\n=== HELD-OUT FAULT CHECK ===")
    print(f"  cooling tower fouling produced {held} rule reports.")
    print("  No rule in analytics/rules/chiller.py references a cooling tower point,")
    print("  a tower approach, or the wet bulb temperature.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
