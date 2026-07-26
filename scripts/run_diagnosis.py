"""Classify every scenario's fault, and print the key test side by side.

Verification for checkpoint 5.4. THE TEST THAT MATTERS is the first block: the
supply air temperature sensor drift must come out as a sensor fault and the cooling
coil valve leak must come out as an equipment fault, even though both present
identically at the air handler as supply air temperature departing from where the
controller wants it. If those two agree, the project can tell a lying instrument
from a worn machine, which is the difference between dispatching a calibration kit
and dispatching a coil.

Every window is compared against the FAULT-FREE run at the same time of year, not
against the start of its own run. The comparison window is stated in the output so
the seasonal matching can be checked rather than assumed.

Ground truth is read once, at the end, only to state what was actually injected
beside what was concluded. Nothing in the classification path touches it.

    uv run python scripts/run_diagnosis.py
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.baselines.fit import asset_classes, commissioning_window
from analytics.diagnosis.classify import classify
from analytics.diagnosis.isolation import isolate
from analytics.health.modes import load_failure_modes, modes_for_class
from analytics.rul.degradation import (
    fit_degradation,
    load_daily_indicator,
    observe,
)
from analytics.rul.estimator import daily_as_ofs, estimate
from analytics.rul.refusal import adjudicate
from analytics.rules.readings import REPO_ROOT, resolve_dsn


def d(text: str) -> datetime:
    return datetime.fromisoformat(f"{text}T00:00:00+00:00")


# Each case: the run, the asset, the window the fault is fully developed in, and the
# fault-free window at the same time of year to compare it against. The AHU
# fault-free run covers 27 May to 24 September, so the two air-side cases that
# matter are fully covered; the damper run is late winter and has no season match,
# which is stated in the output and does not affect its classification because an
# actuator disagreeing with its own command needs no reference window at all.
CASES = (
    ("ahu_sat_sensor_drift", "ahu-1", "2038-05-27",
     ("2038-07-26", "2038-09-24"), ("2039-07-26", "2039-09-24"), True),
    ("ahu_cooling_valve_leakage", "ahu-1", "2036-02-25",
     ("2036-05-27", "2036-06-24"), ("2039-05-27", "2039-06-24"), True),
    ("ahu_oa_damper_stuck", "ahu-1", "2037-01-27",
     ("2037-04-27", "2037-05-27"), ("2039-05-27", "2039-06-26"), False),
    ("clean_ahu", "ahu-1", "2039-05-27",
     ("2039-07-26", "2039-09-24"), ("2039-05-27", "2039-07-25"), True),
    ("chiller_condenser_fouling", "chiller-1", "2036-05-10",
     ("2036-07-10", "2036-09-06"), ("2039-07-10", "2039-09-06"), True),
    ("clean_chiller", "chiller-1", "2039-05-10",
     ("2039-07-10", "2039-09-06"), ("2039-05-10", "2039-07-09"), True),
)

KEY_TEST = ("ahu_sat_sensor_drift", "ahu_cooling_valve_leakage")


def admin_dsn() -> str:
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def injected() -> dict[str, str]:
    """What was actually put in each run. For labelling the output only."""
    with psycopg.connect(admin_dsn()) as conn:
        rows = conn.execute(
            "SELECT scenario_id, string_agg(DISTINCT fault_mode, ', ') "
            "  FROM groundtruth.fault_events GROUP BY 1"
        ).fetchall()
    return dict(rows)


def is_degrading(
    conn: psycopg.Connection,
    asset_id: str,
    run_start: str,
    window: tuple[datetime, datetime],
    modes: list,
    classes: dict[str, str],
) -> tuple[bool, str]:
    """Whether any failure mode on this asset has a published degradation trend.

    Runs the same replay and the same refusal policy the remaining-life layer uses,
    so the diagnosis layer cannot believe a trend that 5.3 refused to publish. This
    is what stops the equipment branch firing on a healthy machine whose relations
    happen to be quiet -- which is every healthy machine.
    """
    t_from = d(run_start)
    _, reference_end = commissioning_window(t_from)
    as_ofs = daily_as_ofs(t_from, window[1])
    best: tuple[float, str] | None = None
    for mode in modes_for_class(modes, classes[asset_id]):
        daily = load_daily_indicator(conn, asset_id, mode.mode_id, t_from, window[1])
        if daily.empty:
            continue
        anchor = None
        floor = None
        verdict = None
        for as_of in as_ofs:
            seen = observe(asset_id, mode, daily, reference_end, as_of,
                           onset=anchor.onset if anchor else None)
            fitted = fit_degradation(seen, anchor, floor)
            if fitted is not None:
                if anchor is None:
                    anchor = fitted.anchor
                floor = fitted.level
            verdict = adjudicate(
                seen, fitted, estimate(fitted) if fitted is not None else None
            )
        if verdict is not None and verdict.published and fitted is not None:
            z = fitted.posterior.z
            if best is None or z > best[0]:
                summary = (
                    f"{mode.mode_id} is degrading at {z:.1f} "
                    f"standard deviations from zero"
                )
                best = (z, summary)
    return (best is not None, best[1] if best else "")


def main() -> int:
    truth = injected()
    results = {}

    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        for label, asset_id, run_start, obs, ref, matched in CASES:
            window = (d(obs[0]), d(obs[1]))
            reference = (d(ref[0]), d(ref[1]))
            iso = isolate(conn, {asset_id}, reference, window)
            degrading, detail = is_degrading(
                conn, asset_id, run_start, window, modes, classes
            )
            results[label] = (
                asset_id, obs, ref, matched,
                classify(conn, asset_id, iso, degrading, detail),
                iso,
            )

    # ---- THE KEY TEST ------------------------------------------------------
    print("=" * 78)
    print("KEY TEST — two faults that present identically at the supply air sensor")
    print("=" * 78)
    for label in KEY_TEST:
        asset_id, obs, ref, _matched, diag, _iso = results[label]
        print(f"\n{label}   ({asset_id})")
        print(f"  injected      : {truth.get(label, 'n/a')}")
        print(f"  window        : {obs[0]} to {obs[1]}, "
              f"compared against fault-free {ref[0]} to {ref[1]}")
        print(f"  CLASSIFIED AS : {diag.fault_class.upper()}"
              f"{'' if diag.subject is None else '  —  ' + diag.subject}"
              f"   ({diag.confidence})")
        print(f"  why           : {diag.reason}")
        for line in diag.evidence.lines():
            print(f"    {line}")
        for note in diag.notes:
            print(f"    note               : {note}")

    verdicts = {label: results[label][4].fault_class for label in KEY_TEST}
    want = {"ahu_sat_sensor_drift": "sensor",
            "ahu_cooling_valve_leakage": "equipment"}
    print("\n" + "-" * 78)
    for label, expected in want.items():
        got = verdicts[label]
        print(f"  {label:<30} expected {expected:<10} got {got:<10} "
              f"{'PASS' if got == expected else 'FAIL'}")
    print("-" * 78)

    # ---- everything else --------------------------------------------------
    print("\n=== every other scenario, same machinery ===")
    for label, (asset_id, obs, ref, matched, diag, _iso) in results.items():
        if label in KEY_TEST:
            continue
        season = "" if matched else "  [no season-matched reference available]"
        print(f"\n{label}  ({asset_id}){season}")
        print(f"  injected      : {truth.get(label, 'nothing — fault-free run')}")
        print(f"  CLASSIFIED AS : {diag.fault_class.upper()}"
              f"{'' if diag.subject is None else '  —  ' + diag.subject}"
              f"   ({diag.confidence})")
        print(f"  why           : {diag.reason}")
        for line in diag.evidence.lines()[:3]:
            print(f"    {line}")

    # ---- the relation table underneath it all -----------------------------
    print("\n=== the relations each classification rests on ===")
    print(f"  {'run':<28}{'relation':<38}{'shift':>9}{'sigmas':>8}")
    for label, (_a, _o, _r, _m, _d, iso) in results.items():
        for relation in iso.relations:
            mark = "*" if relation.violated else " "
            print(f"{mark} {label:<28}{relation.relation_id:<38}"
                  f"{relation.shift:>9.3f}{relation.shift_sigma:>8.2f}")

    print("\n  * = moved by at least one of its own reference spreads")
    return 0 if all(verdicts[k] == v for k, v in want.items()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
