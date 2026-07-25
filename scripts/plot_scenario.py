"""Plot a synthesised scenario against the clean signal it was built from.

The plot is evidence, not decoration. A synthesised trajectory has to be checked
for three things that a row count cannot show: that the degradation climbs from
healthy to the worst severity in the source, that it climbs smoothly rather than
in the visible steps a naive file-stitch would produce, and that the severity
ladder is ordered the right way round.

Everything here is built from one comparison. The stored scenario is read back
out of the database and set against the fault-free signal for the SAME instants,
read out of the source file. Same weather, same occupancy schedule, same control
response; the only difference is the fault.

That difference is the fault contribution. It is NOT a clean measure of severity
on its own, because how much a fault shows depends on the weather -- a leaking
cooling valve barely matters on a day with a real cooling load, and matters a
great deal on a mild one. So the summary also divides the achieved contribution
by the contribution at full severity over the same hours. That ratio is what
climbs from zero to one regardless of the weather, and it is the actual check
that the trajectory walks the ladder.

    uv run python scripts/plot_scenario.py                  # every scenario
    uv run python scripts/plot_scenario.py cooling_tower_fouling
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # no display in this environment; write files only

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingestion.lbnl_loader import affine_conversion, load_manifest
from simulator.trajectory import (
    MANIFEST_DIR,
    REPO_ROOT,
    Scenario,
    ScenarioError,
    _dsn,
    _read_window,
    load_scenarios,
    progress_curve,
    source_tz,
    to_utc,
)

OUT_DIR = REPO_ROOT / "docs" / "plots"

# Below this, the fault has no room to show at all -- a leaking valve on a day
# the coil is already wide open changes nothing measurable. Hours where full
# severity would move the indicator by less than this are left out of the
# severity ratio, because dividing by a number near zero turns a meaningless
# difference into a huge one.
NEGLIGIBLE = 1e-6


def _indicator_point(scenario: Scenario, manifest: dict) -> dict:
    try:
        return next(
            p for p in manifest["points"] if p["point_id"] == scenario.degradation_indicator
        )
    except StopIteration:
        raise ScenarioError(
            f"{scenario.scenario_id}: degradation_indicator "
            f"{scenario.degradation_indicator} is not a point of system {scenario.system}"
        ) from None


def stored_indicator(scenario: Scenario, manifest: dict) -> pd.Series:
    """Read the scenario's degradation indicator back out of the database.

    Reading it back rather than plotting the frame we just built is deliberate:
    it exercises the round trip, so a unit conversion or a timestamp shift that
    went wrong on the way in shows up here instead of surviving into Task 3.
    """
    with psycopg.connect(_dsn("APP_RW_DATABASE_URL")) as conn:
        rows = conn.execute(
            "SELECT time, value_si FROM app.measurements "
            "WHERE point_id = %s AND time >= %s AND time < %s ORDER BY time",
            (
                scenario.degradation_indicator,
                to_utc(scenario.scenario_start, manifest),
                to_utc(scenario.scenario_end, manifest),
            ),
        ).fetchall()
    if not rows:
        raise ScenarioError(
            f"{scenario.scenario_id}: no stored rows for {scenario.degradation_indicator}"
        )
    return pd.DataFrame(rows, columns=["time", "value"]).set_index("time")["value"].astype(float)


def source_indicator(scenario: Scenario, manifest: dict, filename: str) -> pd.Series:
    """One source file's indicator, in SI, on the scenario's clock.

    The index conversion is the same one the writer used. The source index is
    naive local time, so it has to be stamped with the site's offset and moved to
    UTC before it can be compared with anything read back from the database.
    Localising it as UTC instead shifts the whole series by six hours, which
    shows up as a fault contribution that is not zero before onset.
    """
    point = _indicator_point(scenario, manifest)
    frame = _read_window(scenario, manifest, filename)
    scale, offset = affine_conversion(point["unit_native"], point["unit_si"])
    values = frame[point["column"]].to_numpy(dtype="float64") * scale + offset
    stamps = (frame.index + scenario.time_shift).tz_localize(source_tz(manifest)).tz_convert("UTC")
    return pd.Series(values, index=stamps)


def daily(series: pd.Series) -> pd.Series:
    """Daily means. A five-minute series over 120 days is unreadable raw."""
    return series.resample("1D").mean()


def severity_ratio(delta: pd.Series, full: pd.Series, freq: str) -> pd.Series:
    """What fraction of the full-severity effect has been reached, per bucket.

    Summed over the bucket rather than averaged pointwise, so hours where the
    fault cannot express itself contribute nothing to either side instead of
    contributing a wild ratio to the average. Absolute values, because a fault
    that pushes a temperature down is no less severe than one that pushes it up.
    """
    num = delta.abs().resample(freq).sum()
    den = full.abs().resample(freq).sum()
    return (num / den.where(den > NEGLIGIBLE)).clip(0.0, 2.0)


def ladder_table(scenario: Scenario, manifest: dict, clean: pd.Series) -> pd.DataFrame:
    """Mean absolute effect of each rung of the severity ladder.

    This is the check that the ladder is ordered correctly, and it is not
    academic: the chiller and cooling tower fouling files are numbered by percent
    heat transfer RETAINED, so 095 is the mildest case and 065 the worst. Sorting
    them numerically would run the trajectory from broken to healthy, and this
    table is where that shows up as a column that falls instead of rising.
    """
    rows = []
    for level, waypoint in enumerate(scenario.waypoints, start=1):
        series = source_indicator(scenario, manifest, waypoint["file"])
        common = series.index.intersection(clean.index)
        effect = (series.loc[common] - clean.loc[common]).abs().mean()
        rows.append(
            {
                "level": level,
                "label": waypoint.get("label", waypoint["file"]),
                "mean_abs_effect": round(float(effect), 4),
            }
        )
    return pd.DataFrame(rows)


def decile_table(scenario: Scenario, delta: pd.Series, full: pd.Series) -> pd.DataFrame:
    """Per-tenth-of-span summary, so the plot can be checked in a terminal."""
    step = (delta.index[-1] - delta.index[0]) / 10
    onset = pd.Timestamp(scenario.onset, tz=delta.index.tz)
    failure = pd.Timestamp(scenario.failure, tz=delta.index.tz)
    rows = []
    for i in range(10):
        lo = delta.index[0] + step * i
        hi = lo + step
        window = (delta.index >= lo) & (delta.index < hi)
        if not window.any():
            continue
        d, f = delta[window], full[window]
        den = float(f.abs().sum())
        rows.append(
            {
                "decile": i + 1,
                "from": lo.date().isoformat(),
                "phase": "healthy" if hi <= onset else "degrading" if lo < failure else "failed",
                "mean_delta": round(float(d.mean()), 4),
                "severity": round(float(d.abs().sum() / den), 4) if den > NEGLIGIBLE else np.nan,
            }
        )
    return pd.DataFrame(rows)


def plot(scenario: Scenario, manifest: dict, out_dir: Path) -> tuple[Path, dict]:
    stored = stored_indicator(scenario, manifest)
    clean = source_indicator(scenario, manifest, scenario.baseline_file)
    common = stored.index.intersection(clean.index)
    if len(common) < min(len(stored), len(clean)):
        raise ScenarioError(
            f"{scenario.scenario_id}: stored and clean series share only {len(common)} of "
            f"{len(stored)} and {len(clean)} timestamps -- they are not on the same grid"
        )
    stored, clean = stored.loc[common], clean.loc[common]
    delta = stored - clean

    if scenario.is_fault_free:
        full = pd.Series(0.0, index=common)
        ladder = pd.DataFrame(columns=["level", "label", "mean_abs_effect"])
    else:
        top = source_indicator(scenario, manifest, scenario.waypoints[-1]["file"]).loc[common]
        full = top - clean
        ladder = ladder_table(scenario, manifest, clean)

    local = common.tz_convert(source_tz(manifest)).tz_localize(None)
    progress = progress_curve(scenario, pd.DatetimeIndex(local))
    onset = pd.Timestamp(scenario.onset, tz=common.tz)
    failure = pd.Timestamp(scenario.failure, tz=common.tz)

    fig, (top_ax, bot_ax) = plt.subplots(2, 1, figsize=(11, 7.5), sharex=True, height_ratios=[3, 2])
    fig.suptitle(
        f"{scenario.scenario_id}   —   {scenario.fault_mode} on {scenario.target_asset}",
        fontsize=13,
    )

    top_ax.plot(
        daily(clean).index,
        daily(clean),
        lw=1.4,
        color="#4a7ebb",
        label="fault-free, identical weather",
    )
    top_ax.plot(
        daily(stored).index, daily(stored), lw=1.7, color="#c0392b", label="synthesised scenario"
    )
    top_ax.set_ylabel(f"{scenario.degradation_indicator}\n(daily mean)", fontsize=9)
    top_ax.legend(loc="best", fontsize=9)
    top_ax.grid(alpha=0.25)

    if not scenario.is_fault_free:
        ratio = severity_ratio(delta, full, "1D")
        bot_ax.plot(
            ratio.index,
            ratio.to_numpy(),
            lw=1.6,
            color="#c0392b",
            label="severity reached (|Δ| ÷ |Δ at full severity|)",
        )
    bot_ax.plot(
        common, progress, lw=1.3, ls="--", color="#2e8b57", label="commanded degradation progress"
    )
    bot_ax.set_ylabel("fraction of full severity", fontsize=9)
    bot_ax.set_ylim(-0.08, 1.35)
    bot_ax.grid(alpha=0.25)
    bot_ax.legend(loc="upper left", fontsize=9)

    if not scenario.is_fault_free:
        for axis in (top_ax, bot_ax):
            axis.axvline(onset, color="#e67e22", lw=1.2, ls=":")
            axis.axvline(failure, color="#8e44ad", lw=1.2, ls=":")
        bot_ax.annotate("onset", (onset, 1.28), fontsize=8, color="#e67e22", ha="center")
        bot_ax.annotate("failure", (failure, 1.28), fontsize=8, color="#8e44ad", ha="center")

    bot_ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m-%d"))
    fig.autofmt_xdate()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{scenario.scenario_id}.png"
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)

    return path, {
        "deciles": decile_table(scenario, delta, full),
        "ladder": ladder,
        "delta": delta,
        "full": full,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario_id", nargs="*", help="default: every scenario")
    parser.add_argument("--outdir", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    scenarios = load_scenarios()
    if args.scenario_id:
        wanted = set(args.scenario_id)
        scenarios = [s for s in scenarios if s.scenario_id in wanted]
        missing = wanted - {s.scenario_id for s in scenarios}
        if missing:
            print(f"STOP: no such scenario: {sorted(missing)}", file=sys.stderr)
            return 1

    manifests = {n: load_manifest(MANIFEST_DIR / f"{n}.yaml") for n in ("sdahu", "chiller")}
    failures = 0
    for scenario in scenarios:
        path, result = plot(scenario, manifests[scenario.system], args.outdir)
        deciles, ladder = result["deciles"], result["ladder"]
        print(f"\n=== {scenario.scenario_id} ===")
        print(f"  indicator {scenario.degradation_indicator}  ->  {path.relative_to(REPO_ROOT)}")

        if not ladder.empty:
            print("  severity ladder, mean absolute effect on the indicator:")
            for row in ladder.itertuples():
                print(f"    level {row.level}  {row.label:<32}{row.mean_abs_effect:>10.4f}")
            ordered = ladder["mean_abs_effect"].is_monotonic_increasing
            print(f"    ladder increases with level: {'YES' if ordered else 'NO -- MISORDERED'}")
            failures += 0 if ordered else 1

        print(f"  {'decile':>7}{'from':>13}{'phase':>11}{'mean delta':>12}{'severity':>10}")
        for row in deciles.itertuples():
            sev = "     n/a" if pd.isna(row.severity) else f"{row.severity:>8.3f}"
            print(f"  {row.decile:>7}{row._2:>13}{row.phase:>11}{row.mean_delta:>12.4f}  {sev}")

        if scenario.is_fault_free:
            worst = float(result["delta"].abs().max())
            ok = worst < 1e-9
            print(
                f"  largest deviation from fault-free anywhere: {worst:.3e}"
                f"   {'CLEAN' if ok else 'SHOULD BE ZERO'}"
            )
            failures += 0 if ok else 1
        else:
            healthy = deciles[deciles.phase == "healthy"]["severity"].abs().max()
            reached = float(deciles["severity"].iloc[-1])
            print(f"  severity while healthy: {healthy:.4f}   at end of span: {reached:.4f}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
