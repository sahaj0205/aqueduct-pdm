"""The alpha-lambda accuracy figure, written to docs/plots/ and linked from the report.

The standard prognostics accuracy picture, and it is a picture rather than a table for
a specific reason: the question "is the prediction within twenty percent of the truth"
has an answer that changes shape as the end approaches. Twenty percent of ninety days is
eighteen days of slack; twenty percent of five days is one. So the acceptable region is
a cone that closes on zero, and a prediction can be passing at one stage and failing at
the next without the model having changed at all. A table of hit rates hides that. The
cone shows it.

One panel per series scored. The dashed diagonal is how much life was really left, the
shaded wedge around it is the plus-or-minus-twenty-percent band, the line is the
published median and the vertical bars are P10 to P90.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from validation.prognostics import ALPHA, AlphaLambdaPoint

REPO_ROOT = Path(__file__).resolve().parents[1]
PLOT_DIR = REPO_ROOT / "docs" / "plots"

# SVG, not PNG, and the reason is that VALIDATION.md links to this file. Every other plot
# in this project is a diagnostic aid regenerated on demand and `docs/plots/*.png` is
# gitignored accordingly, so a PNG here would leave a broken image in a committed
# document. An SVG is text, which is also why checkpoint 6.6's plant schematic is committed
# in that form: the figure travels with the repository and can be diffed rather than only
# looked at. It also happens to be smaller than the equivalent PNG for this many points.
FIGURE = PLOT_DIR / "alpha_lambda.svg"


def alpha_lambda_figure(points: list[AlphaLambdaPoint]) -> Path | None:
    """Draw the accuracy cone against the published intervals. Returns the file path."""
    series: dict[tuple[str, str, str], list[AlphaLambdaPoint]] = {}
    for point in points:
        series.setdefault(
            (point.scenario_id, point.asset_id, point.mode_id), []
        ).append(point)
    if not series:
        return None

    # Matched series first, so the two the answer key can actually speak to are the
    # first panels a reader sees rather than being buried among the others.
    order = sorted(
        series, key=lambda k: (not series[k][0].matched, k[0], k[2])
    )
    fig, axes = plt.subplots(
        len(order), 1, figsize=(12, 2.7 * len(order)), squeeze=False
    )
    fig.suptitle(
        "Alpha-lambda accuracy: is the published median within "
        f"{ALPHA * 100:.0f}% of the true remaining life, at each stage of the fault?\n"
        "Dashed line is the truth, shaded wedge is the accepted band, bars are P10 to "
        "P90. A point outside the wedge is a miss.",
        fontsize=12,
    )

    for (key, ax) in zip(order, axes[:, 0], strict=True):
        group = sorted(series[key], key=lambda p: p.lam)
        scenario_id, asset_id, mode_id = key
        lams = [p.lam for p in group]
        truth = [p.true_rul for p in group]

        ax.plot(lams, truth, ls="--", lw=1.4, color="#b00", label="true remaining life")
        ax.fill_between(
            lams,
            [t * (1.0 - ALPHA) for t in truth],
            [t * (1.0 + ALPHA) for t in truth],
            color="#2a9d8f", alpha=0.20,
            label=f"within {ALPHA * 100:.0f}%",
        )

        drawn = [p for p in group if p.p50 is not None]
        if drawn:
            ax.plot(
                [p.lam for p in drawn], [p.p50 for p in drawn],
                lw=1.6, marker="o", ms=4, color="#264653", label="published P50",
            )
            for point in drawn:
                if point.p10 is None:
                    continue
                # An unbounded upper end is drawn to the top of the axis with an arrow
                # rather than skipped, because "the model declined to bound this" is an
                # answer and a gap in the line looks like missing data.
                top = point.p90 if point.p90 is not None else ax.get_ylim()[1]
                ax.plot(
                    [point.lam, point.lam], [point.p10, top],
                    lw=1.0, color="#264653", alpha=0.55,
                )
                if point.p90 is None:
                    ax.plot([point.lam], [top], marker="^", ms=5, color="#e76f51")

        hits = sum(1 for p in group if p.within)
        ax.set_title(
            f"{scenario_id} — {asset_id} — {mode_id}"
            f"{'   [names the injected fault]' if group[0].matched else ''}"
            f"   within {ALPHA * 100:.0f}%: {hits} of {len(group)}",
            fontsize=10,
        )
        ax.set_ylabel("days")
        ax.set_xlabel("fraction of the way from injection to terminal severity")
        ax.set_ylim(bottom=0.0)
        ax.grid(alpha=0.25)
        ax.legend(fontsize=7, frameon=False, loc="upper right", ncol=4)

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(FIGURE, dpi=110)
    plt.close(fig)
    return FIGURE
