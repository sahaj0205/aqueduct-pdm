"""Show the refusal layer declining to answer, and why, on every run.

Verification for checkpoint 5.3. Three things are demonstrated:

  - the first two weeks of each progressive scenario, day by day, where the system
    must refuse and must give a reason that is true of that day;
  - the whole of both fault-free runs, where any published prediction is a false
    positive by definition;
  - the two known upstream false alarms the checkpoint names -- the seasonal
    changepoint firings on clean chillers from 4.4, and the clamped fan indicator
    on the sensor-drift run -- confirmed refused, with the figures.

It also shows the asset roll-up before and after the policy is applied, because that
is where refusing changes the answer a human would see rather than just a row in a
table.

Ground truth is read in one function, only to name the injected failure dates in the
output. No decision in this file depends on it.

    uv run python scripts/run_refusal.py
"""

from __future__ import annotations

import os
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.baselines.fit import RUNS, asset_classes, commissioning_window
from analytics.health.index import maintenance_resets
from analytics.health.modes import load_failure_modes, modes_for_class
from analytics.rul.degradation import (
    fit_degradation,
    load_daily_indicator,
    observe,
)
from analytics.rul.estimator import daily_as_ofs, estimate, soonest
from analytics.rul.refusal import DEFAULT_POLICY, Verdict, adjudicate, published
from analytics.rules.readings import REPO_ROOT, resolve_dsn

PROGRESSIVE = (
    ("ahu_cooling_valve_leakage", "ahu-1"),
    ("chiller_condenser_fouling", "chiller-1"),
    ("chiller_bypass_valve_leakage", "chiller-1"),
    ("ahu_sat_sensor_drift", "ahu-1"),
)
FAULT_FREE = ("clean_ahu", "clean_chiller")

# The specific upstream false alarms checkpoint 5.3 names, and what each is.
NAMED_FALSE_ALARMS = (
    ("clean_chiller", "chiller-1", "chiller-efficiency-loss",
     "seasonal changepoint firing on a clean chiller (4.4)"),
    ("clean_chiller", "chiller-2", "chiller-efficiency-loss",
     "seasonal changepoint firing on a clean chiller (4.4)"),
    ("ahu_sat_sensor_drift", "ahu-1", "fan-bearing-degradation",
     "false flatline held up by the monotone clamp (4.4)"),
    ("ahu_cooling_valve_leakage", "ahu-1", "fan-bearing-degradation",
     "fan excursions on a coil fault, which broke the 5.2 roll-up"),
)


def admin_dsn() -> str:
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def injected_onsets() -> dict[str, datetime]:
    """Only used to label the output. No decision here depends on it."""
    with psycopg.connect(admin_dsn()) as conn:
        rows = conn.execute(
            "SELECT scenario_id, min(t_onset) FROM groundtruth.fault_events GROUP BY 1"
        ).fetchall()
    return dict(rows)


def walk(
    conn: psycopg.Connection, label: str, assets: tuple[str, ...],
    raw_from: str, raw_to: str, modes: list, classes: dict[str, str],
    as_ofs: list[datetime] | None = None,
) -> dict[tuple[str, str], list[Verdict]]:
    """Every verdict for every mode on every asset of one run, date by date."""
    t_from = datetime.fromisoformat(raw_from)
    t_to = datetime.fromisoformat(raw_to)
    _, reference_end = commissioning_window(t_from)
    dates = as_ofs if as_ofs is not None else daily_as_ofs(t_from, t_to)

    out: dict[tuple[str, str], list[Verdict]] = {}
    for asset_id in assets:
        for mode in modes_for_class(modes, classes[asset_id]):
            daily = load_daily_indicator(conn, asset_id, mode.mode_id, t_from, t_to)
            if daily.empty:
                continue
            resets = maintenance_resets(conn, asset_id, mode.mode_id)
            anchor = None
            level_floor = None
            verdicts: list[Verdict] = []
            for as_of in dates:
                seen = observe(
                    asset_id, mode, daily, reference_end, as_of, resets,
                    onset=anchor.onset if anchor else None,
                )
                fitted = fit_degradation(seen, anchor, level_floor)
                if fitted is not None:
                    if anchor is None:
                        anchor = fitted.anchor
                    level_floor = fitted.level
                verdicts.append(
                    adjudicate(
                        seen, fitted,
                        estimate(fitted) if fitted is not None else None,
                    )
                )
            out[(asset_id, mode.mode_id)] = verdicts
    return out


def main() -> int:
    policy = DEFAULT_POLICY
    print("=== refusal policy ===")
    print(f"  minimum daily observations since onset : "
          f"{policy.min_post_onset_samples}")
    print(f"  rate must clear zero by                : "
          f"{policy.significance_z:.2f} standard deviations")
    print(f"  P10-P90 span may be at most            : "
          f"{policy.max_width_ratio:.1f} x the observed window")

    truth = injected_onsets()
    everything: dict[str, dict[tuple[str, str], list[Verdict]]] = {}

    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        # ---- the first two weeks of each progressive scenario --------------
        print("\n=== the first two weeks of each progressive scenario ===")
        print("  Every day here must refuse. The reason has to be true of that day,")
        print("  not merely a reason.")
        for label, assets, raw_from, raw_to in RUNS:
            targets = [a for lbl, a in PROGRESSIVE if lbl == label]
            if not targets:
                continue
            t_from = datetime.fromisoformat(raw_from)
            fortnight = [t_from + timedelta(days=d) for d in range(1, 15)]
            got = walk(conn, label, tuple(targets), raw_from, raw_to,
                       modes, classes, fortnight)
            injected = truth.get(label)
            print(f"\n  {label}  (fault injected "
                  f"{injected.date().isoformat() if injected else 'n/a'}, "
                  f"run starts {t_from.date().isoformat()})")
            for (asset_id, mode_id), verdicts in sorted(got.items()):
                reasons = Counter(v.reason for v in verdicts)
                leaked = [v for v in verdicts if v.published]
                print(f"    {asset_id:<10}{mode_id:<26}"
                      f"{'PUBLISHED ' + str(len(leaked)) + ' DAYS' if leaked else 'refused all 14 days'}")
                for reason, count in reasons.most_common():
                    sample = next(v for v in reversed(verdicts)
                                  if v.reason == reason)
                    if sample.refusal is None:
                        continue
                    print(f"      {count:>2}d  {reason}")
                    print(f"           {sample.refusal.detail}")

        # ---- the entire fault-free runs ------------------------------------
        print("\n=== the entire fault-free runs: any prediction here is a false "
              "positive ===")
        clean_days = clean_leaks = 0
        for label, assets, raw_from, raw_to in RUNS:
            if label not in FAULT_FREE:
                continue
            got = walk(conn, label, assets, raw_from, raw_to, modes, classes)
            everything[label] = got
            print(f"\n  {label}")
            for (asset_id, mode_id), verdicts in sorted(got.items()):
                reasons = Counter(v.reason for v in verdicts)
                leaked = [v for v in verdicts if v.published]
                flag = ("FALSE POSITIVE on " + str(len(leaked)) + " of "
                        + str(len(verdicts)) + " days") if leaked else "refused every day"
                print(f"    {asset_id:<10}{mode_id:<26}{len(verdicts):>4}d  {flag}")
                for reason, count in reasons.most_common():
                    print(f"           {count:>4}d  {reason}")
                clean_days += len(verdicts)
                clean_leaks += len(leaked)

        print(f"\n  TOTAL: {clean_leaks} predictions published across "
              f"{clean_days} fault-free mode-days")

        # ---- the named upstream false alarms -------------------------------
        print("\n=== the false alarms this checkpoint names, at the end of their "
              "runs ===")
        print("  Each of these is a mode the layers below happily produced a "
              "failure date for.")
        for label, asset_id, mode_id, description in NAMED_FALSE_ALARMS:
            row = next((r for r in RUNS if r[0] == label), None)
            if row is None:
                continue
            got = everything.get(label) or walk(
                conn, label, (asset_id,), row[2], row[3], modes, classes
            )
            verdicts = got.get((asset_id, mode_id))
            if not verdicts:
                print(f"  {description:<48}no verdicts")
                continue
            final = verdicts[-1]
            # Recover the drift significance for the report, where it exists.
            withheld = final.withheld
            suppressed = (
                "nothing computable" if withheld is None or withheld.p50 is None
                else f"P50 {withheld.p50:.0f}d"
            )
            print(f"\n  {description}")
            print(f"    {asset_id} / {mode_id}")
            print(f"    verdict   : {final.reason}")
            print(f"    suppressed: {suppressed}")
            if final.refusal is not None:
                print(f"    because   : {final.refusal.detail}")

        # ---- the roll-up, before and after --------------------------------
        print("\n=== asset remaining life: the 5.2 roll-up against the 5.3 one ===")
        print(f"  {'run':<28}{'asset':<11}{'without refusal':<40}"
              f"{'with refusal':<40}")
        for label, assets, raw_from, raw_to in RUNS:
            got = everything.get(label) or walk(
                conn, label, assets, raw_from, raw_to, modes, classes
            )
            everything[label] = got
            for asset_id in assets:
                finals = [
                    v[-1] for (a, _m), v in got.items() if a == asset_id and v
                ]
                if not finals:
                    continue
                # 5.2 rolled up over every mode it could compute, refused or not.
                # `either` recovers exactly that set, so the two columns differ
                # only by the policy and not by anything else.
                raw_pick = soonest([
                    v.either for v in finals if v.either is not None
                ])
                kept = soonest(published(finals))
                print(f"  {label:<28}{asset_id:<11}"
                      f"{_describe(raw_pick):<40}{_describe(kept):<40}")

    return 0


def _describe(pick) -> str:
    if pick is None:
        return "no bounded prediction"
    p50 = "unbounded" if pick.p50 is None else f"{pick.p50:.0f}d"
    return f"{pick.mode_id} P50 {p50}"


if __name__ == "__main__":
    raise SystemExit(main())
