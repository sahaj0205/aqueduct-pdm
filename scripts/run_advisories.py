"""Print the advisory queue in full, every field populated, and check it is.

Verification for checkpoint 6.2. Builds the queue for the cross-asset situation set
up in checkpoint 6.1 -- the chiller's real condenser fouling, era-shifted so it
overlaps the air handler's real saturated-valve episodes -- and prints three
advisories end to end.

The three are chosen to cover the three shapes an advisory can take:

    EQUIPMENT      the chiller's condenser fouling. A degradation trend with a
                   published prediction interval and a priced energy penalty.
    SENSOR         the air handler's saturated cooling valve, which checkpoint 5.4
                   attributes to a drifting thermometer rather than the coil. Also
                   the CONSEQUENTIAL one, and the two coinciding is not a shortcut:
                   this dataset contains exactly one downstream symptom that the
                   cross-asset map can link, and it happens to be a sensor fault.
                   Checkpoint 6.1 flagged that the attribution is therefore wrong,
                   which is what the demote-rather-than-hide behaviour is for.
    REFUSED        the air handler's fan bearing wear, where the remaining-life
                   layer published a prediction but the advisory has no electrical
                   penalty term for part of the queue -- included so the report
                   shows what a partly-priced advisory looks like.

The last block prints the same fault looked up under two different fault classes,
to show what the sensor-versus-equipment discrimination is actually worth in
dispatch terms.

    uv run python scripts/run_advisories.py
    uv run python scripts/run_advisories.py --write   # also store for the API
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import fields
from datetime import UTC, datetime
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_rootcause import collect, d, era_shift

from analytics.advisories.generate import (
    HORIZON_DAYS,
    Advisory,
    asset_facts,
    build,
    effective_priority,
    queue,
    recommend,
    site_economics,
    write_advisories,
)
from analytics.diagnosis.classify import classify
from analytics.diagnosis.isolation import isolate
from analytics.diagnosis.rootcause import (
    attribute,
    nodes_by_asset,
    open_failure_modes,
    rank,
)
from analytics.rules.readings import resolve_dsn
from model.graph import node_to_asset_id
from model.loader import load_merged_graph

# The window from checkpoint 6.1's situation 3, and the fault composed into it.
WINDOW = ("2038-05-27", "2038-09-24")
FOULING_WINDOW = ("2036-07-10", "2036-09-07")
ERA_SHIFT_YEARS = 2

# Per-asset windows for the fault classifier, each paired with a fault-free window at
# the same time of year. These are the windows checkpoint 5.4 verified against, reused
# unchanged so the fault class an advisory carries is the one that checkpoint proved.
CLASSIFY = {
    "ahu-1": (("2038-07-26", "2038-09-24"), ("2039-07-26", "2039-09-24")),
    "chiller-1": (("2036-07-10", "2036-09-06"), ("2039-07-10", "2039-09-06")),
    "chiller-2": (("2036-07-10", "2036-09-06"), ("2039-07-10", "2039-09-06")),
}

# Advisories from a DIFFERENT run, added to the queue explicitly rather than
# smuggled in. Each entry is (asset, fault, its own observation window, a fault-free
# reference window at the same time of year).
#
# The coil valve leak is here because it carries the most informative remaining-life
# history in this project: 68 successive estimates over the 2036 air handler run, whose
# P10-to-P90 interval closes from 2,259 days to 23 as the post-onset sample count goes
# from 14 to 52. That narrowing is what checkpoint 6.5's fan chart exists to show, and
# a flagship visual that could only be reached from a verification script rather than
# by clicking a row in the queue would be a demonstration of nothing.
#
# It sits in the same queue as the 2038 cross-asset situation, which is honest for a
# database holding eight independent simulation runs in separate calendar eras: there
# is no single "now" here, so every advisory carries the window it was computed over
# and the dashboard says so above the queue.
EXTRA = (
    (
        "ahu-1", "coil-valve-leak-by",
        ("2036-05-27", "2036-06-24"), ("2039-05-27", "2039-06-24"),
    ),
)

# Which advisories to print in full, and under what heading.
SHOW = (
    ("EQUIPMENT — the root cause", ("chiller-1", "chiller-condenser-fouling")),
    ("SENSOR, and also CONSEQUENTIAL — the demoted symptom", ("ahu-1", "apar-20")),
    ("EQUIPMENT — a second, unrelated primary fault", ("ahu-1", "fan-bearing-degradation")),
)


def classify_assets(
    conn,
    asset_ids: set[str],
    degrading: dict[str, str],
    windows: dict[str, tuple[tuple[str, str], tuple[str, str]]] | None = None,
):
    """One fault class per asset per window, from checkpoint 5.4's machinery.

    `degrading` says which assets have a confirmed, published degradation trend, and
    is read from app.health_state rather than recomputed by replaying the estimator.
    That is a deliberate difference from scripts/run_diagnosis.py, which does replay:
    an advisory has to agree with the health page it sits beside, and the persisted
    state is what that page shows.

    Note the granularity this imposes and that the advisory layer inherits: the
    classifier answers per ASSET per window, not per fault, so every fault open on
    one asset in one window carries the same class. Two genuinely different faults on
    the same machine at the same time would both be labelled with whichever one the
    isolation sweep found.
    """
    # An asset can need classifying over more than one window -- the air handler is
    # classified over its 2038 run for the cross-asset situation and over its 2036 run
    # for the coil leak -- so the window can be overridden per call rather than being
    # fixed per asset.
    lookup = windows if windows is not None else CLASSIFY
    out = {}
    for asset_id in sorted(asset_ids):
        if asset_id not in lookup:
            continue
        obs, ref = lookup[asset_id]
        window = (d(obs[0]), d(obs[1]))
        reference = (d(ref[0]), d(ref[1]))
        isolation = isolate(conn, {asset_id}, reference, window)
        out[asset_id] = classify(
            conn, asset_id, isolation,
            asset_id in degrading, degrading.get(asset_id, ""),
        )
    return out


def _priority(value: float | None) -> str:
    """A priority, or the word for not having one. Never a zero standing in for it."""
    return "unpriced" if value is None else f"{value:.2f}"


def show(heading: str, advisory: Advisory, priority: float | None) -> None:
    print(f"\n{'=' * 92}\n{heading}\n{'=' * 92}")
    print(f"  {advisory.asset_name}  ({advisory.asset_id})")
    print(f"  FAULT           {advisory.fault_title}")
    print(f"                  {advisory.fault_id}  "
          f"(named by the {advisory.fault_source.replace('_', ' ')} layer)")
    print(f"  FAULT CLASS     {advisory.fault_class.upper()}")
    print(f"                  {advisory.fault_class_reason}")
    print(f"  HEALTH          {advisory.health if advisory.health is not None else 'n/a'}"
          f"   window {advisory.window[0]:%Y-%m-%d} .. {advisory.window[1]:%Y-%m-%d}")

    print(f"\n  REMAINING LIFE  {advisory.forecast.sentence}")
    probability = advisory.forecast.probability_by(HORIZON_DAYS)
    if probability is not None:
        print(f"                  {probability * 100:.1f}% chance of crossing the "
              f"threshold within {HORIZON_DAYS:.0f} days")

    print("\n  CONTRIBUTING SIGNALS   (measured value, reference value, movement)")
    print(f"    excluded: {advisory.signals_excluded_unusable} point(s) whose source "
          f"data is known defective, {advisory.signals_excluded_untrusted} whose "
          f"readings the quality layer condemned")
    for signal in advisory.signals:
        print(f"    {signal.line}")
    for line in advisory.diagnosis_evidence:
        print(f"    evidence: {line}")

    print("\n  GRAPH TRACE")
    print(f"    upstream      {advisory.trace.upstream_summary}")
    if advisory.trace.cause is not None:
        cause = advisory.trace.cause
        print(f"    CAUSED BY     {cause.cause.asset_id} / {cause.cause.fault_id}, "
              f"{cause.hops} hops upstream")
        print(f"                  {cause.propagation.mechanism}")
        print(f"                  {cause.concurrency.summary}")
    print(f"    downstream    {advisory.trace.impact.summary}")

    severity = advisory.severity
    print(f"\n  SEVERITY        {severity.score:.3f}")
    print(f"    terms         {severity.basis}")
    print(f"    decline       {severity.slope_per_day:.3f} health points/day, fitted "
          f"over {severity.slope_days} days")
    print(f"    context       criticality tier {severity.criticality_tier}, "
          f"{severity.occupants} occupants served")

    cost = advisory.cost
    print(f"\n  COST OF INACTION over {HORIZON_DAYS:.0f} days   "
          f"{cost.total_usd:>12,.2f} USD")
    print(f"    energy        {cost.energy_usd:>12,.2f} USD   "
          f"({cost.excess_kw:.3f} kW excess at {cost.duty * 100:.1f}% duty)")
    print(f"    consequential {cost.consequential_usd:>12,.2f} USD")
    for line in cost.basis.split("; "):
        print(f"      {line}")

    print(f"\n  EFFORT          {advisory.effort_usd:>12,.2f} USD")
    print(f"  PRIORITY        {_priority(priority):>12}   "
          + ("(USD saved per USD spent)" if priority is not None
             else "— no cost of inaction could be computed, so this advisory is "
                  "ranked on severity"))
    if advisory.consequential:
        cut = (
            f"severity rank cut from {advisory.severity.score:.3f}"
            if priority is None
            else f"priority cut from {advisory.priority:.2f}"
        )
        print(f"                  DEMOTED — consequential on an upstream fault, "
              f"{cut}, still in the queue")

    intervention = advisory.intervention
    if intervention is None:
        print("\n  RECOMMENDED     nothing recorded in app.intervention_library")
    else:
        print(f"\n  RECOMMENDED     {intervention.intervention_id}"
              f"{'  (matched on fault class)' if intervention.matched_on_class else ''}")
        print(f"    what          {intervention.description}")
        print(f"    duration      {intervention.duration_hours} technician-hours")
        print(f"    skills        {', '.join(intervention.skills)}")
        print(f"    parts         {', '.join(intervention.parts) or 'none'}")
        print(f"    parts cost    {intervention.parts_cost_usd:,.2f} USD")
        print(f"    basis         {intervention.basis}")
    for note in advisory.notes:
        print(f"  NOTE            {note}")


# Fields that are legitimately empty on some advisories, and why. Anything empty and
# NOT in here is a genuine gap and is reported as one -- the point of the check is to
# tell the two apart rather than to make the report look clean.
ALLOWED_EMPTY = {
    "mode_id": "this fault is a rule firing, not a failure mode, so it has no mode id",
    "health": "health is scored per failure mode; a rule firing has none",
    "demoted_from": "only set on a consequential advisory",
    "notes": "no caveats needed on this advisory",
    "diagnosis_evidence": "no isolation evidence available for this asset",
    "signals_excluded_unusable": "no unusable points on this asset",
    "signals_excluded_untrusted": "no untrusted points on this asset",
    "intervention": "no row in app.intervention_library matches this fault",
}


def completeness(advisory: Advisory) -> tuple[list[str], list[str]]:
    """Empty fields split into expected and unexplained.

    'Every field populated' is checked here rather than asserted in prose. Fields
    that are legitimately absent for a known reason are listed with the reason;
    anything else empty is a gap in the advisory and is reported as a failure.
    """
    expected, unexplained = [], []
    for spec in fields(advisory):
        value = getattr(advisory, spec.name)
        if value is None or (isinstance(value, tuple) and not value):
            reason = ALLOWED_EMPTY.get(spec.name)
            (expected if reason else unexplained).append(
                f"{spec.name} ({reason})" if reason else spec.name
            )
    return expected, unexplained


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and print the advisory queue.")
    parser.add_argument(
        "--write", action="store_true",
        help="also store the queue in app.advisories, which is what the API serves",
    )
    args = parser.parse_args()

    graph, _ = load_merged_graph()
    mapping, _notes = node_to_asset_id(graph)
    window = (d(WINDOW[0]), d(WINDOW[1]))

    # Every graph node of every asset, because the traversals have to start from all
    # of them: the chilled water loop arrives at the air handler's cooling coil and
    # the supply air leaves from its supply fan, and neither is the node the database
    # calls ahu-1.
    nodes = nodes_by_asset(mapping)

    with psycopg.connect(resolve_dsn()) as conn:
        economics = site_economics(graph)
        facts = asset_facts(conn, graph, nodes)
        print(f"site economics: {economics.basis}")
        print(f"planning horizon: {HORIZON_DAYS:.0f} days")

        # ---- open faults, including the composed cross-asset cause -------
        faults = collect(conn, graph, window)
        fouling = [
            f for f in open_failure_modes(
                conn, (d(FOULING_WINDOW[0]), d(FOULING_WINDOW[1]))
            )
            if f.fault_id == "chiller-condenser-fouling"
        ]
        faults += [era_shift(f, ERA_SHIFT_YEARS) for f in fouling]
        attributions = attribute(graph, mapping, faults)
        ranked = rank(faults, {}, attributions)
        print(f"open faults: {len(faults)}, attributed to an upstream cause: "
              f"{len(attributions)}")

        # ---- a fault class per asset, from checkpoint 5.4 ----------------
        degrading = {
            f.asset_id: f"{f.fault_id} is degrading, {f.detail}"
            for f in faults if f.source == "failure_mode"
        }
        diagnoses = classify_assets(
            conn, {f.asset_id for f in faults}, degrading
        )
        print("fault class per asset, from the isolation sweep in checkpoint 5.4:")
        for asset_id, diagnosis in sorted(diagnoses.items()):
            print(f"  {asset_id:<12}{diagnosis.fault_class.upper():<12}"
                  f"{diagnosis.subject or ''}")

        # ---- build every advisory ---------------------------------------
        advisories: list[Advisory] = []
        for entry in ranked:
            asset_id = entry.fault.asset_id
            if asset_id not in CLASSIFY or asset_id not in facts:
                continue
            obs, ref = CLASSIFY[asset_id]
            diagnosis = diagnoses[asset_id]
            advisories.append(
                build(
                    conn=conn, graph=graph, nodes=nodes, mapping=mapping,
                    facts=facts, economics=economics, ranked=entry,
                    window=(d(obs[0]), d(obs[1])),
                    reference=(d(ref[0]), d(ref[1])),
                    diagnosis_class=diagnosis.fault_class,
                    diagnosis_reason=diagnosis.reason,
                    diagnosis_subject=diagnosis.subject,
                    diagnosis_evidence=tuple(diagnosis.evidence.lines()[:3]),
                )
            )

        # ---- advisories from another run, each on its own window ---------
        for asset_id, fault_id, obs, ref in EXTRA:
            window_extra = (d(obs[0]), d(obs[1]))
            found = [
                f for f in open_failure_modes(conn, window_extra)
                if f.asset_id == asset_id and f.fault_id == fault_id
            ]
            if not found:
                print(f"  {asset_id}/{fault_id}: nothing open in {obs[0]}..{obs[1]}")
                continue
            extra_diagnoses = classify_assets(
                conn, {asset_id},
                {asset_id: f"{fault_id} is degrading, {found[0].detail}"},
                {asset_id: (obs, ref)},
            )
            diagnosis = extra_diagnoses[asset_id]
            print(f"  added {asset_id}/{fault_id} from {obs[0]}..{obs[1]}, "
                  f"classified {diagnosis.fault_class.upper()}")
            for entry in rank(found, {}, {}):
                advisories.append(
                    build(
                        conn=conn, graph=graph, nodes=nodes, mapping=mapping,
                        facts=facts, economics=economics, ranked=entry,
                        window=window_extra,
                        reference=(d(ref[0]), d(ref[1])),
                        diagnosis_class=diagnosis.fault_class,
                        diagnosis_reason=diagnosis.reason,
                        diagnosis_subject=diagnosis.subject,
                        diagnosis_evidence=tuple(diagnosis.evidence.lines()[:3]),
                    )
                )

        ordered = queue(advisories)
        by_key = {(a.asset_id, a.fault_id): a for a in ordered}
        if args.write:
            written = write_advisories(conn, ordered, datetime.now(UTC))
            print(f"\nwrote {written} advisories to app.advisories")

        # ---- the queue ---------------------------------------------------
        print(f"\n{'=' * 92}\nTHE QUEUE, sorted by priority\n{'=' * 92}")
        print(f"  {'#':<3}{'asset':<12}{'fault':<28}{'class':<11}"
              f"{'priority':>10}{'cost USD':>12}{'effort':>10}  status")
        for position, advisory in enumerate(ordered, start=1):
            print(f"  {position:<3}{advisory.asset_id:<12}{advisory.fault_id:<28}"
                  f"{advisory.fault_class:<11}"
                  f"{_priority(effective_priority(advisory, ordered)):>10}"
                  f"{advisory.cost.total_usd:>12,.0f}"
                  f"{advisory.effort_usd:>10,.0f}  "
                  f"{'CONSEQUENTIAL' if advisory.consequential else 'primary'}")

        # ---- three in full ----------------------------------------------
        missing_report = []
        for heading, key in SHOW:
            advisory = by_key.get(key)
            if advisory is None:
                print(f"\n{heading}: {key} not in the queue — cannot show")
                missing_report.append(key)
                continue
            show(heading, advisory, effective_priority(advisory, ordered))
            expected, unexplained = completeness(advisory)
            print(f"\n  FIELDS POPULATED  "
                  f"{len(fields(advisory)) - len(expected) - len(unexplained)} "
                  f"of {len(fields(advisory))}")
            for entry in expected:
                print(f"    expected empty  {entry}")
            if unexplained:
                print(f"    UNEXPLAINED EMPTY  {unexplained}   <-- FAIL")
                missing_report.append(key)

        # ---- what the fault class is worth in dispatch terms -------------
        print(f"\n{'=' * 92}\nWHAT THE FAULT CLASS IS WORTH: apar-20 looked up both ways"
              f"\n{'=' * 92}")
        for fault_class in ("sensor", "equipment"):
            option = recommend(conn, "apar-20", fault_class)
            labour = option.duration_hours * economics.labour_usd_per_hour
            print(f"  as a {fault_class.upper():<10} {option.intervention_id:<28}"
                  f"{option.duration_hours:>5.1f} h  "
                  f"{labour + option.parts_cost_usd:>9,.2f} USD  "
                  f"{', '.join(option.skills)}")
        cheap = recommend(conn, "apar-20", "sensor").effort_usd(economics)
        dear = recommend(conn, "apar-20", "equipment").effort_usd(economics)
        print(f"  same symptom, same rule id, {dear / cheap:.1f}x the cost. The only "
              f"thing choosing between them is checkpoint 5.4.")

        return 1 if missing_report else 0


if __name__ == "__main__":
    raise SystemExit(main())
