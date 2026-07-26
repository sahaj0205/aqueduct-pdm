"""Fit the degradation process for every confirmed-degrading mode, replayed in time.

Verification for checkpoint 5.1. For each run and asset, walks every failure
mode's post-onset trajectory forward through three points in time -- one third,
two thirds and all of the way through -- and prints the rate, the spread, and the
posterior standard deviation on the rate at each.

The property being checked is that the belief about the rate never gets vaguer as
evidence accumulates. It holds because the update accumulates precision rather
than refitting, so nothing here is tuned to produce it. Two things legitimately
break strict narrowing and are reported as themselves rather than as failures: a
step across which no new day of data arrived leaves the belief exactly where it
was, and a Gamma-declared mode ties its spread to its mean, so an accelerating
fault can widen the absolute number while the scale-free one narrows.

Reads only app.health_state and app.failure_modes, both as app_rw. No ground
truth is touched anywhere in this file -- there is nothing here to score against
an answer key, because the question is whether the fit becomes more certain, not
whether it is right. That comes in 5.2.

    uv run python scripts/run_degradation.py
"""

from __future__ import annotations

import sys
from datetime import datetime
from itertools import pairwise
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analytics.baselines.fit import RUNS, asset_classes, commissioning_window
from analytics.health.index import maintenance_resets
from analytics.health.modes import load_failure_modes, modes_for_class
from analytics.rul.degradation import (
    MIN_SIGMA,
    PRIOR_EQUIVALENT_DAYS,
    PRIOR_HORIZON_DAYS,
    Degradation,
    load_daily_indicator,
    replay,
    snapshots,
)
from analytics.rules.readings import resolve_dsn

SNAPSHOT_LABELS = ("early", "middle", "late")


def fmt(value: float | None, width: int = 10, places: int = 4) -> str:
    if value is None:
        return f"{'-':>{width}}"
    return f"{value:>{width}.{places}f}"


def main() -> int:
    with psycopg.connect(resolve_dsn()) as conn:
        modes = load_failure_modes(conn)
        classes = asset_classes(conn)

        print("=== declared degradation process, per mode ===")
        print(f"  {'mode':<28}{'process':<9}{'threshold':>11}  unit")
        for mode in modes:
            print(f"  {mode.mode_id:<28}{mode.degradation_process:<9}"
                  f"{mode.failure_threshold:>11.4g}  {mode.indicator_unit}")
        print(f"\n  prior: reaches threshold in {PRIOR_HORIZON_DAYS:.0f} days, "
              f"worth {PRIOR_EQUIVALENT_DAYS:.0f} days of observation")

        print("\n=== fitted rate and spread, replayed at three points in time ===")
        print("  mu/day and sigma are the maximum-likelihood fit to the window "
              "available at that date.")
        print("  post mu and post sd are the belief about the rate after the "
              "sequential update; z is how")
        print("  many posterior standard deviations that rate sits above zero.")
        header = (
            f"  {'run':<28}{'asset':<10}{'mode':<26}{'when':<7}"
            f"{'days':>6}{'n':>5}{'mu/day':>11}{'sigma':>10}"
            f"{'post mu':>11}{'post sd':>10}{'z':>7}"
        )
        results: dict[tuple[str, str, str], list[Degradation | None]] = {}

        for label, assets, raw_from, raw_to in RUNS:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            _, reference_end = commissioning_window(t_from)
            as_ofs = snapshots(t_from, t_to, len(SNAPSHOT_LABELS))

            for asset_id in assets:
                for mode in modes_for_class(modes, classes[asset_id]):
                    daily = load_daily_indicator(
                        conn, asset_id, mode.mode_id, t_from, t_to
                    )
                    if daily.empty:
                        continue
                    results[(label, asset_id, mode.mode_id)] = replay(
                        asset_id,
                        mode,
                        daily,
                        reference_end,
                        as_ofs,
                        maintenance_resets(conn, asset_id, mode.mode_id),
                    )

        printed_header = False
        for (label, asset_id, mode_id), row in results.items():
            if all(entry is None for entry in row):
                continue
            if not printed_header:
                print(header)
                printed_header = True
            for when, entry in zip(SNAPSHOT_LABELS, row, strict=True):
                if entry is None:
                    print(f"  {label:<28}{asset_id:<10}{mode_id:<26}{when:<7}"
                          f"{'':>6}{'':>5}   no confirmed onset yet")
                    continue
                fit, post = entry.fit, entry.posterior
                print(f"  {label:<28}{asset_id:<10}{mode_id:<26}{when:<7}"
                      f"{fit.total_days:>6.0f}{fit.samples:>5}"
                      f"{fmt(fit.mu, 11)}{fmt(fit.sigma, 10)}"
                      f"{fmt(post.mean, 11)}{fmt(post.sd, 10)}"
                      f"{post.z:>7.1f}")
            print()

        print("=== does the posterior on the rate tighten? ===")
        print("  The property is that accumulated precision never falls, so the")
        print("  posterior sd never rises. A step where no new day arrived leaves")
        print("  it unchanged, which is the correct behaviour and not a widening,")
        print("  so those steps are counted separately rather than as failures.")
        print(f"  {'run':<28}{'asset':<10}{'mode':<26}{'proc':<8}"
              f"{'sd early':>11}{'sd middle':>11}{'sd late':>11}"
              f"{'new days':>10}  verdict")
        narrowed = flat = widened = partial = 0
        for (label, asset_id, mode_id), row in results.items():
            fitted = [e for e in row if e is not None]
            if len(fitted) < 2:
                if fitted:
                    partial += 1
                continue
            pairs = list(pairwise(fitted))
            rises = [b for a, b in pairs if b.posterior.sd > a.posterior.sd]
            fresh = [
                b.fit.total_days - a.fit.total_days > 0 for a, b in pairs
            ]
            if rises:
                widened += 1
                verdict = "WIDENS"
            elif not any(fresh):
                flat += 1
                verdict = "unchanged, no new data"
            else:
                narrowed += 1
                verdict = "narrows" if all(fresh) else "narrows where data arrived"
            cells = ["" if e is None else f"{e.posterior.sd:.5g}" for e in row]
            rels = ["" if e is None else f"{e.posterior.relative_sd:.4g}" for e in row]
            print(f"  {label:<28}{asset_id:<10}{mode_id:<26}"
                  f"{fitted[-1].fit.process:<8}"
                  f"{cells[0]:>11}{cells[1]:>11}{cells[2]:>11}"
                  f"{sum(fresh):>10}  {verdict}")
            if rises:
                # The Gamma family ties spread to mean, so on an accelerating
                # fault the absolute number can grow while the belief genuinely
                # sharpens. Show the scale-free version next to it.
                print(f"  {'':<28}{'':<10}{'':<26}{'as a fraction of the rate:':<8}"
                      f"{rels[0]:>11}{rels[1]:>11}{rels[2]:>11}")
        print(f"\n  narrows: {narrowed}    unchanged because no new data: {flat}"
              f"    WIDENS: {widened}    only one snapshot fittable: {partial}")

        print("\n=== the rate against zero, which is what 5.3 will refuse on ===")
        print(f"  {'run':<28}{'asset':<10}{'mode':<26}"
              f"{'post mu':>11}{'post sd':>10}{'z':>7}  reads as")
        for (label, asset_id, mode_id), row in results.items():
            entry = row[-1]
            if entry is None:
                continue
            post = entry.posterior
            reads = "degrading" if post.z >= 1.96 else "not separable from zero"
            print(f"  {label:<28}{asset_id:<10}{mode_id:<26}"
                  f"{post.mean:>11.5f}{post.sd:>10.5f}{post.z:>7.2f}  {reads}")

        print("\n=== gamma process detail, where declared ===")
        print(f"  {'run':<28}{'asset':<10}{'mode':<26}{'when':<7}"
              f"{'shape/day':>11}{'scale':>11}{'flat steps':>12}  note")
        for (label, asset_id, mode_id), row in results.items():
            for when, entry in zip(SNAPSHOT_LABELS, row, strict=True):
                if entry is None:
                    continue
                fit = entry.fit
                if fit.shape is None and fit.fallback_reason is None:
                    continue
                note = fit.fallback_reason or ""
                print(f"  {label:<28}{asset_id:<10}{mode_id:<26}{when:<7}"
                      f"{fmt(fit.shape, 11, 4)}{fmt(fit.scale, 11, 5)}"
                      f"{fit.increments.zero_fraction * 100:>11.0f}%  {note}")

        print("\n=== the clamp deflates sigma: fitted spread, clamped vs raw ===")
        print("  The process is fitted to the monotone series, as specified. This is")
        print("  what that costs. 'floor' is the day-to-day spread of the same")
        print("  indicator over the commissioning window, and 'used' is what the")
        print("  update actually ran on -- the larger of the two, because a clamped")
        print("  day cannot honestly be quieter than a healthy one.")
        print(f"  {'run':<28}{'asset':<10}{'mode':<26}"
              f"{'sigma clamped':>14}{'sigma raw':>11}{'ratio':>8}"
              f"{'floor':>10}{'used':>10}")
        for (label, asset_id, mode_id), row in results.items():
            entry = row[-1]
            if entry is None:
                continue
            from analytics.rul.degradation import increments, moments

            raw_post = entry.observation.raw[
                entry.observation.raw.index >= entry.fit.increments.t0
            ]
            raw_inc = increments(raw_post)
            if raw_inc is None:
                continue
            _, raw_sigma = moments(raw_inc)
            # A completely flattened series has no measured spread at all, so its
            # ratio would be a division by the numerical floor rather than a
            # deflation figure, and is not reported as one.
            ratio = (
                f"{raw_sigma / entry.fit.sigma:>8.1f}"
                if entry.fit.sigma > MIN_SIGMA
                else f"{'flat':>8}"
            )
            anchor = entry.anchor
            print(f"  {label:<28}{asset_id:<10}{mode_id:<26}"
                  f"{entry.fit.sigma:>14.4f}{raw_sigma:>11.4f}{ratio}"
                  f"{anchor.sigma_floor:>10.4f}{anchor.sigma:>10.4f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
