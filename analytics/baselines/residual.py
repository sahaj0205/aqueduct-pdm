"""Compute and store observed minus expected for every baseline-modelled point.

The residual, not the raw signal, is what every layer above this one consumes.
A raw supply air temperature of 15 degrees means nothing on its own -- it is
correct on a mild morning with the valve half open and alarming on a hot
afternoon with the valve wide open. The residual has already had the operating
conditions divided out, so a number near zero means the equipment is doing what
its own commissioning data says it should, whatever the weather is doing.

One set of baselines is fitted per run, on the commissioning window at the start
of that run, and then applied across the whole run. Fitting per run rather than
once globally is what makes the residual a statement about drift WITHIN a run:
each run starts from its own zero, so a residual that grows is the equipment
moving away from where it was three weeks ago, not the two runs having been
simulated in different seasons.

Which baselines an asset gets is decided by its Brick class, read from
app.assets, so the loop below never names a piece of equipment.

Run with `make baselines`.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime

import numpy as np
import pandas as pd
import psycopg

from analytics.baselines.fit import (
    RUNS,
    Baseline,
    BaselineError,
    asset_classes,
    commissioning_window,
    fit_asset_baselines,
    load_points,
    points_needed,
    predict,
    specs_for,
)
from analytics.rules.readings import resolve_dsn

log = logging.getLogger("baselines")


# ---------------------------------------------------------------------------
# computing
# ---------------------------------------------------------------------------


def compute(
    baseline: Baseline, values: pd.DataFrame, quality: pd.DataFrame
) -> pd.DataFrame:
    """One baseline's residual at every instant its model is valid.

    Instants where the equipment is off are dropped rather than stored as zero.
    A stopped fan has no expected power and a coil with no air over it has no
    expected supply temperature; recording a residual for them would put a long
    run of manufactured zeros into the health index every night, which would
    flatten any real trend it was meant to see. The same applies to a chiller
    idling below the load at which efficiency means anything.

    Input quality is the worst score among the observation and every driver, with
    the staleness dimension already discounted upstream. It is stored rather than
    used to filter, so a residual computed from a doubtful reading is visible
    downstream instead of quietly absent.
    """
    needed = [baseline.target, *baseline.drivers]
    missing = [p for p in needed if p not in values.columns]
    if missing:
        raise BaselineError(f"{baseline.baseline_id}: no readings for {missing}")

    expected, applies = predict(baseline, values)
    observed = values[baseline.target]

    usable = applies & expected.notna() & observed.notna()
    residual = observed - expected
    frame = pd.DataFrame(
        {
            "time": values.index,
            "observed": observed.to_numpy(),
            "expected": expected.to_numpy(),
            "residual": residual.to_numpy(),
            "normalised": (
                (residual - baseline.centre) / baseline.residual_sd
            ).to_numpy(),
            "input_quality": quality[[c for c in needed if c in quality.columns]]
            .min(axis=1, skipna=False)
            .to_numpy(),
        }
    )
    return frame[usable.to_numpy()]


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------


def write_residuals(
    conn: psycopg.Connection,
    baseline: Baseline,
    frame: pd.DataFrame,
    t_from: datetime,
    t_to: datetime,
) -> tuple[int, int]:
    """Replace this baseline's residuals over this window.

    Deleted and rewritten rather than merged, like every other derived table in
    this project: these rows are a function of the measurements and the fitted
    model, and a row left behind from a previous fit describes a baseline that no
    longer exists.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM app.residuals "
            " WHERE baseline_id = %s AND time >= %s AND time < %s",
            (baseline.baseline_id, t_from, t_to),
        )
        removed = cur.rowcount
        with cur.copy(
            "COPY app.residuals (time, point_id, baseline_id, observed, expected, "
            "                    residual, normalised, input_quality) "
            "FROM STDIN (FORMAT BINARY)"
        ) as copy:
            copy.set_types(
                ["timestamptz", "text", "text", "float8", "float8", "float8",
                 "float8", "int2"]
            )
            for stamp, observed, expected, residual, normalised, quality in (
                frame.itertuples(index=False, name=None)
            ):
                copy.write_row(
                    (
                        stamp,
                        baseline.target,
                        baseline.baseline_id,
                        _finite(observed),
                        _finite(expected),
                        _finite(residual),
                        _finite(normalised),
                        None if quality is None or not np.isfinite(quality) else int(quality),
                    )
                )
    return removed, len(frame)


def _finite(value: float) -> float | None:
    """NaN and infinity are not JSON, not SQL, and not measurements."""
    return None if value is None or not np.isfinite(value) else float(value)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def report(baseline: Baseline) -> None:
    log.info(
        "    %-40s R2 %+.5f   residual sd %9.4f %-5s  centre %+8.4f  n=%5d",
        baseline.baseline_id,
        baseline.r_squared,
        baseline.residual_sd,
        baseline.unit,
        baseline.centre,
        baseline.samples,
    )
    log.info("        %s", baseline.describe())


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fit equipment baselines and store their residuals."
    )
    parser.add_argument("--run", help="only this run label")
    parser.add_argument("--asset", help="only this asset id")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

    runs = [r for r in RUNS if not args.run or r[0] == args.run]
    if not runs:
        sys.exit(f"no run named {args.run}")

    started = time.monotonic()
    total = 0
    with psycopg.connect(resolve_dsn()) as conn:
        classes = asset_classes(conn)
        for label, assets, raw_from, raw_to in runs:
            t_from = datetime.fromisoformat(raw_from)
            t_to = datetime.fromisoformat(raw_to)
            fit_from, fit_to = commissioning_window(t_from)
            log.info("\n%s\n%s   %s .. %s   fitting on the first %s days",
                     "=" * 78, label, t_from.date(), t_to.date(),
                     (fit_to - fit_from).days)

            for asset_id in assets:
                if args.asset and asset_id != args.asset:
                    continue
                brick_class = classes.get(asset_id)
                if brick_class is None:
                    log.info("  %s: not in app.assets", asset_id)
                    continue
                log.info("  %s  [%s]", asset_id, brick_class)

                baselines, refused = fit_asset_baselines(
                    conn, asset_id, brick_class, (fit_from, fit_to)
                )
                for message in refused:
                    log.info("    REFUSED  %s", message)
                for baseline in baselines:
                    report(baseline)
                if not baselines:
                    continue

                needed: list[str] = []
                for spec in specs_for(brick_class):
                    needed += points_needed(spec, asset_id)
                values, quality = load_points(conn, needed, t_from, t_to)

                for baseline in baselines:
                    frame = compute(baseline, values, quality)
                    _removed, written = write_residuals(
                        conn, baseline, frame, t_from, t_to
                    )
                    conn.commit()
                    total += written
                    if written == 0:
                        log.info("    %-40s no evaluable instants", baseline.baseline_id)
                        continue
                    log.info(
                        "    %-40s %7d rows   median %+10.4f   |normalised| p95 %6.2f",
                        baseline.baseline_id,
                        written,
                        frame["residual"].median(),
                        frame["normalised"].abs().quantile(0.95),
                    )

    log.info(
        "\n%s\nwrote %d residual rows in %.1f seconds",
        "=" * 78, total, time.monotonic() - started,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
