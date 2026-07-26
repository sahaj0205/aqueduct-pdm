"""Estimate remaining useful life across every run, store the history, and score it.

Verification for checkpoint 5.2. Walks each run day by day, and at every date
computes the whole distribution over when each failure mode will cross its
threshold using only data available on that date. Stores all of it, then prints
the interval over the last three weeks before the injected failure and the error
in the median prediction.

THE GROUND TRUTH READ IS CONFINED TO ONE FUNCTION IN THIS FILE, and it runs only
after every estimate has already been computed and written. The estimation itself
runs over a connection as app_rw, which the database physically denies access to
schema groundtruth. Nothing under analytics/ can read the answer key at all.

    uv run python scripts/run_rul.py
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.baselines.fit import RUNS, asset_classes, commissioning_window
from analytics.health.index import maintenance_resets
from analytics.health.modes import load_failure_modes, modes_for_class
from analytics.rul.degradation import load_daily_indicator, replay
from analytics.rul.estimator import (
    MAX_HORIZON_DAYS,
    RulEstimate,
    daily_as_ofs,
    estimate,
    soonest,
    write_estimates,
)
from analytics.rules.readings import REPO_ROOT, resolve_dsn

PLOT_DIR = REPO_ROOT / "docs" / "plots"

# The four progressive scenarios and the asset whose health we track on each. The
# bypass fault is injected at the plant rather than at one chiller, so the answer
# key records it against chw-plant-1 while the degradation shows up on chiller-1.
PROGRESSIVE = (
    ("ahu_cooling_valve_leakage", "ahu-1"),
    ("chiller_condenser_fouling", "chiller-1"),
    ("chiller_bypass_valve_leakage", "chiller-1"),
    ("ahu_sat_sensor_drift", "ahu-1"),
)
WEEKS_BEFORE = (21, 14, 7)


def admin_dsn() -> str:
    """The only credential permitted to read the answer key. Validation only."""
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def ground_truth_failures() -> dict[str, datetime]:
    """When each injected fault reached its terminal severity. VALIDATION ONLY."""
    with psycopg.connect(admin_dsn()) as conn:
        rows = conn.execute(
            "SELECT scenario_id, max(t_failure) FROM groundtruth.fault_events "
            " WHERE t_failure IS NOT NULL GROUP BY 1"
        ).fetchall()
    return dict(rows)


def days(value: float | None, width: int = 9) -> str:
    return f"{'unbounded':>{width}}" if value is None else f"{value:>{width}.1f}"


def main() -> int:
    history: dict[tuple[str, str, str], list[RulEstimate]] = {}
    crossings: dict[tuple[str, str, str], datetime] = {}
    written = 0

    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        for label, assets, raw_from, raw_to in RUNS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            _, reference_end = commissioning_window(t_from)
            as_ofs = daily_as_ofs(t_from, t_to)

            for asset_id in assets:
                for mode in modes_for_class(modes, classes[asset_id]):
                    daily = load_daily_indicator(
                        conn, asset_id, mode.mode_id, t_from, t_to
                    )
                    if daily.empty:
                        continue
                    fits = replay(
                        asset_id, mode, daily, reference_end, as_ofs,
                        maintenance_resets(conn, asset_id, mode.mode_id),
                    )
                    estimates = [estimate(f) for f in fits if f is not None]
                    if not estimates:
                        continue
                    key = (label, asset_id, mode.mode_id)
                    history[key] = estimates
                    written += write_estimates(conn, estimates, t_from, t_to)
                    conn.commit()

                    # When the indicator ACTUALLY crossed the threshold, if it did
                    # within the run. This is the event the model is predicting, as
                    # distinct from the answer key's terminal-severity date.
                    crossed = next(
                        (e.as_of for e in estimates if e.distance <= 0.0), None
                    )
                    if crossed is not None:
                        crossings[key] = crossed

    print(f"=== stored {written} estimates across {len(history)} mode/asset/run "
          f"combinations ===")
    print(f"  horizon: the model declines to bound anything beyond "
          f"{MAX_HORIZON_DAYS:.0f} days")

    truth = ground_truth_failures()

    # ---- the required table: last three weeks before failure ---------------
    print("\n=== P10 to P90 over the last three weeks before the injected failure ===")
    print("  as_of is counted back from groundtruth.fault_events.t_failure.")
    print("  'left' is how far the indicator still has to climb to its threshold.")
    print(f"  {'run':<28}{'mode':<26}{'as_of':<12}{'n':>4}{'left':>9}"
          f"{'P10':>10}{'P50':>10}{'P90':>10}{'width':>10}")
    verdicts: list[tuple[str, str, str]] = []
    for label, asset_id in PROGRESSIVE:
        t_failure = truth.get(label)
        if t_failure is None:
            print(f"  {label:<28}no t_failure in the answer key")
            continue
        for mode_id in sorted({k[2] for k in history if k[:2] == (label, asset_id)}):
            series = history[(label, asset_id, mode_id)]
            by_date = {e.as_of.date(): e for e in series}
            picked = [
                by_date.get((t_failure - timedelta(days=d)).date())
                for d in WEEKS_BEFORE
            ]
            if all(p is None for p in picked):
                print(f"  {label:<28}{mode_id:<26}"
                      f"no confirmed degradation in that window")
                continue
            for offset, entry in zip(WEEKS_BEFORE, picked, strict=True):
                stamp = (t_failure - timedelta(days=offset)).date().isoformat()
                if entry is None:
                    print(f"  {label:<28}{mode_id:<26}{stamp:<12}"
                          f"{'':>4}   not yet confirmed")
                    continue
                print(f"  {label:<28}{mode_id:<26}{stamp:<12}"
                      f"{entry.n_samples:>4}{entry.distance:>9.3f}"
                      f"{days(entry.p10, 10)}{days(entry.p50, 10)}"
                      f"{days(entry.p90, 10)}{days(entry.width, 10)}")
            verdicts.append((label, mode_id, _width_verdict(picked)))
            print()

    print("=== does the P10 to P90 width shrink monotonically? ===")
    for label, mode_id, verdict in verdicts:
        print(f"  {label:<28}{mode_id:<26}{verdict}")
    bad = [v for _, _, v in verdicts if v.startswith("WIDENS")]
    print(f"\n  shrinks: {len(verdicts) - len(bad)}    WIDENS: {len(bad)}")

    # ---- P50 error, against two different definitions of failure ----------
    print("\n=== P50 error, at three weeks before the injected failure ===")
    print("  Two references, because they are two different events. The answer key's")
    print("  t_failure is when the INJECTED FAULT reached terminal severity. The")
    print("  model predicts when the INDICATOR crosses a physically justified")
    print("  threshold. Where the indicator actually crossed inside the run, that")
    print("  observed crossing is the thing the model was trying to predict.")
    print(f"  {'run':<28}{'mode':<26}{'P50 date':<12}{'t_failure':<12}"
          f"{'err d':>7}  {'observed crossing':<19}{'err d':>7}")
    for label, asset_id in PROGRESSIVE:
        t_failure = truth.get(label)
        if t_failure is None:
            continue
        for mode_id in sorted({k[2] for k in history if k[:2] == (label, asset_id)}):
            key = (label, asset_id, mode_id)
            by_date = {e.as_of.date(): e for e in history[key]}
            entry = by_date.get((t_failure - timedelta(days=WEEKS_BEFORE[0])).date())
            if entry is None or entry.p50 is None:
                continue
            predicted = entry.failure_date
            err_key = (predicted - t_failure).total_seconds() / 86400.0
            observed = crossings.get(key)
            if observed is None:
                obs_txt, err_obs = "never, inside run", ""
            else:
                obs_txt = observed.date().isoformat()
                err_obs = f"{(predicted - observed).total_seconds() / 86400.0:+.1f}"
            print(f"  {label:<28}{mode_id:<26}"
                  f"{predicted.date().isoformat():<12}"
                  f"{t_failure.date().isoformat():<12}{err_key:>+7.1f}"
                  f"  {obs_txt:<19}{err_obs:>7}")

    # ---- the asset roll-up, weakest link -----------------------------------
    print("\n=== asset remaining life at the end of each run: soonest mode wins ===")
    print(f"  {'run':<28}{'asset':<11}{'soonest mode':<26}"
          f"{'P10':>10}{'P50':>10}{'P90':>10}")
    for label, assets, _a, _b in RUNS:
        for asset_id in assets:
            finals = [
                history[k][-1] for k in history if k[:2] == (label, asset_id)
            ]
            if not finals:
                continue
            pick = soonest(finals)
            if pick is None:
                print(f"  {label:<28}{asset_id:<11}"
                      f"{'no bounded failure date on any mode':<26}")
                continue
            print(f"  {label:<28}{asset_id:<11}{pick.mode_id:<26}"
                  f"{days(pick.p10, 10)}{days(pick.p50, 10)}{days(pick.p90, 10)}")

    plot(history, truth)
    return 1 if bad else 0


def _width_verdict(picked: list[RulEstimate | None]) -> str:
    """Whether the interval narrowed across the three weekly snapshots."""
    live = [p for p in picked if p is not None]
    if len(live) < 2:
        return "only one snapshot confirmed, nothing to compare"
    widths = [p.width for p in live]
    if any(w is None for w in widths):
        # Going from unbounded to bounded is the strongest possible narrowing:
        # the model went from declining to commit to naming a window.
        first_bounded = next(i for i, w in enumerate(widths) if w is not None)
        if all(w is not None for w in widths[first_bounded:]):
            rest = [w for w in widths[first_bounded:] if w is not None]
            tail = all(b <= a for a, b in pairwise(rest))
            return ("shrinks, after going from unbounded to bounded" if tail
                    else "WIDENS after becoming bounded")
        return "WIDENS back to unbounded"
    if all(b <= a for a, b in pairwise(widths)):
        return "shrinks"
    return "WIDENS"


def plot(
    history: dict[tuple[str, str, str], list[RulEstimate]],
    truth: dict[str, datetime],
) -> None:
    """The band over time against the truth: the standard remaining-life funnel.

    One panel per progressive scenario. The shaded region is P10 to P90, the solid
    line is the median, and the dashed diagonal is how long was actually left --
    which is a straight line falling to zero at the injected failure date. A
    prediction that works has the band tracking that diagonal and closing on it.
    """
    fig, axes = plt.subplots(len(PROGRESSIVE), 1, figsize=(13, 2.9 * len(PROGRESSIVE)))
    fig.suptitle(
        "Remaining useful life, recomputed every day from data available that day. "
        "Shaded band is P10 to P90; dashed diagonal is the true time left.",
        fontsize=12,
    )
    for ax, (label, asset_id) in zip(axes, PROGRESSIVE, strict=True):
        t_failure = truth.get(label)
        ceiling = 30.0
        for mode_id in sorted({k[2] for k in history if k[:2] == (label, asset_id)}):
            series = [e for e in history[(label, asset_id, mode_id)] if e.bounded]
            if not series:
                continue
            # Scale each panel to its own predictions. A single fixed limit either
            # clips the slow modes or flattens the fast ones into the axis, and the
            # band closing on the truth is the whole thing worth looking at.
            ceiling = max(ceiling, min(400.0, 1.15 * max(e.p50 for e in series)))
            stamps = [e.as_of for e in series]
            ax.fill_between(
                stamps, [e.p10 for e in series], [e.p90 for e in series],
                alpha=0.22, label=f"{mode_id} P10-P90",
            )
            ax.plot(stamps, [e.p50 for e in series], lw=1.6, label=f"{mode_id} P50")
        if t_failure is not None:
            span = [e.as_of for k, v in history.items() if k[:2] == (label, asset_id)
                    for e in v]
            if span:
                lo, hi = min(span), max(span)
                ax.plot(
                    [lo, hi],
                    [(t_failure - lo).days, (t_failure - hi).days],
                    ls="--", color="#b00", lw=1.3, label="true time left",
                )
                ax.axvline(t_failure, color="#b00", lw=1.0, alpha=0.5)
        ax.set_title(f"{label} — {asset_id}", fontsize=10)
        ax.set_ylabel("days to failure")
        ax.set_ylim(-0.03 * ceiling, ceiling)
        ax.legend(fontsize=7, frameon=False, loc="upper right", ncol=3)
        ax.grid(alpha=0.25)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b", tz=UTC))

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out = PLOT_DIR / "rul_bands.png"
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print(f"\nwrote {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    raise SystemExit(main())
