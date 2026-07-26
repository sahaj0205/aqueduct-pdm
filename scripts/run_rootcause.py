"""Build the advisory queue for a window and show what cross-asset reasoning did to it.

Verification for checkpoint 6.1. Three situations run through the same code path and
the difference between them is the whole report:

  1. The 2038 air-handler run, entirely real. The air handler's cooling valve is
     saturating and the chiller plant has faults open across the same period, so
     topology and timing both permit a link. The plausibility map refuses anyway,
     because the chiller's open fault costs power rather than capacity and cannot
     warm the water. Nothing is demoted. This is the true negative that shows the
     map is not a rubber stamp for "these two assets are connected".

  2. The 2036 air-handler run, entirely real. Different faults, same outcome.

  3. THE TARGET SCENARIO, on the SAME WINDOW as situation 1 with exactly one fault
     added: condenser fouling on the chiller. The air handler advisory comes out
     marked consequential, linked to the chiller two hops upstream, and ranked
     below it. Because the window and the code are identical to situation 1, the
     demotion can only have come from that one added fault.

WHY SITUATION 3 HAS TO BE COMPOSED, STATED HERE RATHER THAN BURIED

The two LBNL systems are independent simulations. The air handler's chilled water
does not come from this chiller in the data; it comes from a boundary condition
inside the air handler's own simulation. No air handler run in this dataset is fed
by a starved chiller, so a chiller-caused air handler symptom cannot be observed
here, by construction of the source data. The calendars make it doubly impossible:
every chiller run ends on 7 September and the saturated valve does not sustain until
11 September, so the two ends of the chain never share a day.

What is composed is ONLY the calendar era of one fault. Situation 3 takes the
chiller's real detected condenser fouling -- real onset from the changepoint
detector, real health score, real indicator value -- and moves its dates forward by
two whole years. No number inside either fault is altered, the shift is a single
four-line function, and situations 1 and 2 run the same code on unshifted data.

The topology is not composed. chiller-1 really does feed ahu-1 in the semantic
model, at two hops through the chilled water loop, and that edge is what the
traversal follows -- cross-checked below against the independently built edge cache.

    uv run python scripts/run_rootcause.py
"""

from __future__ import annotations

import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from analytics.diagnosis.rootcause import (
    CAUSE_MARGIN,
    DEMOTION_FACTOR,
    PROPAGATIONS,
    OpenFault,
    Ranked,
    attribute,
    nodes_by_asset,
    open_failure_modes,
    rank,
    upstream_open_faults,
)
from analytics.rules import apar, chiller  # noqa: F401 - importing registers the rules
from analytics.rules.apar import POINTS_USED
from analytics.rules.chiller import (
    CHILLERS,
    OFF,
    chiller_state,
    load_window,
    points_used,
)
from analytics.rules.evaluate import episodes, run_rules, sustained
from analytics.rules.mode import SIGNALS, classify_frame
from analytics.rules.readings import (
    effective_quality_frame,
    load_asset_readings,
    resolve_dsn,
    signal_frames,
)
from analytics.rules.registry import registered_rules
from model.graph import node_to_asset_id
from model.loader import load_merged_graph

# The situations, as (label, window start, window end). Both are real: every fault
# in them was detected from data inside the window itself.
#
# The 2038 window is the whole air-handler sensor-drift run. It is chosen because it
# is the only window in this dataset where the downstream symptom the target scenario
# needs actually exists -- the saturated cooling valve first sustains on 11 September,
# once the drift has grown large enough to keep the controller pinned -- and because
# the chiller plant has real detected faults across most of the same period.
SITUATIONS = (
    ("1. REAL CONCURRENCY, air-handler run of 2038", "2038-05-27", "2038-09-24"),
    ("2. REAL CONCURRENCY, air-handler run of 2036", "2036-05-31", "2036-06-24"),
)

# Situation 3 runs on THE SAME WINDOW as situation 1 and adds exactly one fault: the
# chiller's condenser fouling, detected in its own 2036 run and moved forward by
# ERA_SHIFT_YEARS. Same window, same code, one extra fault -- so the demotion that
# appears in situation 3 and not in situation 1 can only have come from that fault.
#
# Two whole years is not arbitrary. The simulator places each scenario a whole number
# of years from its 2018 source window precisely so day-of-year and time-of-day
# survive the move, so a whole-year shift keeps the fault on the same calendar days,
# in the same weather, at the same point in the occupancy schedule it was detected in.
COMPOSED_WINDOW = ("2038-05-27", "2038-09-24")
FOULING_WINDOW = ("2036-07-10", "2036-09-07")
ERA_SHIFT_YEARS = 2


def d(text: str) -> datetime:
    return datetime.fromisoformat(f"{text}T00:00:00+00:00")


def rule_titles() -> dict[str, str]:
    """First docstring line of every registered rule, for the advisory headline."""
    return {r.rule_id: r.description for r in registered_rules()}


def ahu_rule_faults(
    conn: psycopg.Connection, graph, window: tuple[datetime, datetime]
) -> list[OpenFault]:
    """Sustained APAR firings on the air handler, collapsed to one row per rule.

    Nine episodes of the same rule are one advisory, not nine: an operator needs to
    know the cooling valve has been saturating for two months, not to receive the
    finding once per stretch. The episode count and the peak severity are carried in
    the detail so nothing is lost by the collapse.
    """
    values, quality, flags = load_asset_readings(conn, "ahu-1", *window)
    if values.empty:
        return []
    signals, signal_quality, signal_flags = signal_frames(values, quality, flags, SIGNALS)
    modes = classify_frame(signals, effective_quality_frame(signal_quality, signal_flags))
    reported = sustained(
        run_rules(graph, "ahu-1", "brick:AHU", values, quality, flags, modes, POINTS_USED)
    )
    return _collapse("ahu-1", episodes(reported))


def chiller_rule_faults(
    conn: psycopg.Connection, graph, window: tuple[datetime, datetime]
) -> list[OpenFault]:
    """Sustained chiller rule firings, per chiller, collapsed the same way."""
    out: list[OpenFault] = []
    for asset in CHILLERS:
        loaded = load_window(conn, asset, *window)
        if loaded is None:
            continue
        values, quality, flags = loaded
        state = chiller_state(values, asset)
        reported = sustained(
            run_rules(
                graph, asset, "brick:Chiller", values, quality, flags, state,
                points_used(asset), off_state=OFF,
            )
        )
        out += _collapse(asset, episodes(reported))
    return out


def _collapse(asset_id: str, found) -> list[OpenFault]:
    titles = rule_titles()
    out: list[OpenFault] = []
    for rule_id, group in found.groupby("rule_id", sort=True):
        out.append(
            OpenFault(
                asset_id=asset_id,
                fault_id=rule_id,
                source="rule",
                title=titles.get(rule_id, rule_id),
                t_from=group["t_from"].min().to_pydatetime(),
                t_to=group["t_to"].max().to_pydatetime(),
                severity=float(group["peak_severity"].max()),
                detail=(
                    f"{len(group)} sustained episodes, "
                    f"{int(group['samples'].sum())} samples, peak severity "
                    f"{group['peak_severity'].max():.2f}"
                ),
            )
        )
    return out


def era_shift(fault: OpenFault, years: int) -> OpenFault:
    """Move a fault's dates by whole years, changing nothing else about it."""
    return replace(
        fault,
        t_from=fault.t_from.replace(year=fault.t_from.year + years),
        t_to=fault.t_to.replace(year=fault.t_to.year + years),
        detail=f"{fault.detail}; dates moved +{years} years, see the module docstring",
    )


def collect(conn, graph, window: tuple[datetime, datetime]) -> list[OpenFault]:
    """Everything open on every asset in this window, from every detector."""
    return (
        open_failure_modes(conn, window)
        + ahu_rule_faults(conn, graph, window)
        + chiller_rule_faults(conn, graph, window)
    )


def show(label: str, window: tuple[datetime, datetime], queue: list[Ranked]) -> None:
    print(f"\n{'=' * 92}\n{label}   {window[0]:%Y-%m-%d} .. {window[1]:%Y-%m-%d}\n{'=' * 92}")
    if not queue:
        print("  nothing open")
        return
    print(f"  {'#':<3}{'asset':<12}{'fault':<28}{'prio':>7}{'own':>7}  status")
    for position, entry in enumerate(queue, start=1):
        status = "CONSEQUENTIAL" if entry.consequential else "primary"
        print(
            f"  {position:<3}{entry.fault.asset_id:<12}{entry.fault.fault_id:<28}"
            f"{entry.priority:>7.3f}{entry.own_priority:>7.3f}  {status}"
        )
        print(f"      {entry.fault.title}")
        print(f"      {entry.fault.detail}")
        if entry.attribution is not None:
            a = entry.attribution
            print(f"      CAUSED BY  {a.cause.asset_id} / {a.cause.fault_id}   "
                  f"{a.hops} hops upstream via {a.propagation.medium}")
            print(f"      TIMING     {a.concurrency.summary}")
            print(f"      MECHANISM  {a.propagation.mechanism}")
            print(f"      DEMOTED    {entry.own_priority:.3f} -> {entry.priority:.3f} "
                  f"(x{DEMOTION_FACTOR}, then forced "
                  f"{CAUSE_MARGIN * 100:.0f}% under the cause), still in the queue "
                  f"at position {position}")


def topology_check(graph, mapping, conn) -> None:
    """What the SPARQL traversal thinks is upstream of the air handler, cross-checked.

    The whole cross-asset layer rests on this one answer, and a traversal that
    silently returns nothing would look exactly like a building with no upstream
    faults. So it is stated, and checked against app.asset_edges -- which was built
    by an independent breadth-first walk of the same graph in checkpoint 2.3.
    """
    nodes = nodes_by_asset(mapping)
    probe = [
        OpenFault(a, "probe", "rule", "probe", d("2000-01-01"), d("2100-01-01"), 0.0)
        for a in sorted(set(mapping.values()))
        if a != "ahu-1"
    ]
    reached = upstream_open_faults(graph, nodes, mapping, "ahu-1", probe)
    cached = dict(
        conn.execute(
            "SELECT from_asset, hop_distance FROM app.asset_edges "
            " WHERE to_asset = 'ahu-1' AND relation = 'feeds'"
        ).fetchall()
    )
    print("\nupstream of ahu-1, from open_faults_upstream.rq over every node of the asset:")
    for reach in reached:
        agree = cached.get(reach.asset_id)
        print(f"  {reach.asset_id:<14}{reach.hops} hops   app.asset_edges says "
              f"{agree}   {'AGREE' if agree == reach.hops else 'DISAGREE'}")
    missing = set(cached) - {r.asset_id for r in reached}
    print(f"  assets the edge cache has and the traversal missed: "
          f"{sorted(missing) if missing else 'none'}")


def main() -> int:
    graph, _ = load_merged_graph()
    mapping, _notes = node_to_asset_id(graph)

    print(f"plausibility map: {len(PROPAGATIONS)} declared mechanisms")
    for propagation in PROPAGATIONS:
        print(f"  {propagation.cause:<28} -> {propagation.symptom:<10}"
              f"via {propagation.medium}")

    with psycopg.connect(resolve_dsn()) as conn:
        topology_check(graph, mapping, conn)

        # ---- the two real windows -----------------------------------------
        for label, start, end in SITUATIONS:
            window = (d(start), d(end))
            faults = collect(conn, graph, window)
            attributions = attribute(graph, mapping, faults)
            show(label, window, rank(faults, {}, attributions))
            print(f"  -> {len(attributions)} of {len(faults)} advisories attributed "
                  f"to an upstream cause")

        # ---- the target scenario, era-shifted -----------------------------
        window = (d(COMPOSED_WINDOW[0]), d(COMPOSED_WINDOW[1]))
        faults = collect(conn, graph, window)
        fouling = [
            f
            for f in open_failure_modes(conn, (d(FOULING_WINDOW[0]), d(FOULING_WINDOW[1])))
            if f.fault_id == "chiller-condenser-fouling"
        ]
        if not fouling:
            print("\nno detected condenser fouling to compose with -- cannot verify")
            return 1
        composed = faults + [era_shift(f, ERA_SHIFT_YEARS) for f in fouling]
        attributions = attribute(graph, mapping, composed)
        queue = rank(composed, {}, attributions)
        show("3. TARGET SCENARIO, chiller fouling composed onto the 2038 air-handler "
             "window", window, queue)

        # ---- the checks this checkpoint is judged on -----------------------
        print(f"\n{'-' * 92}")
        symptom = next(
            (e for e in queue if e.fault.asset_id == "ahu-1" and e.consequential), None
        )
        if symptom is None:
            print("  FAIL  no air handler advisory was marked consequential")
            return 1
        cause_key = symptom.attribution.cause.key
        cause = next(e for e in queue if e.fault.key == cause_key)
        positions = {e.fault.key: i for i, e in enumerate(queue)}

        print(f"  marked consequential      {symptom.fault.asset_id}/"
              f"{symptom.fault.fault_id}   PASS")
        print(f"  linked upstream           {cause.fault.asset_id}/"
              f"{cause.fault.fault_id} at {symptom.attribution.hops} hops   PASS")
        print(f"  priority demoted          {symptom.own_priority:.3f} -> "
              f"{symptom.priority:.3f}   "
              f"{'PASS' if symptom.priority < symptom.own_priority else 'FAIL'}")
        print(f"  ranked below its cause    position "
              f"{positions[symptom.fault.key] + 1} vs cause at "
              f"{positions[cause.fault.key] + 1}   "
              f"{'PASS' if positions[symptom.fault.key] > positions[cause.fault.key] else 'FAIL'}")
        print(f"  still visible, not hidden {len(queue)} advisories in the queue, "
              f"the demoted one included   PASS")
        print(
            "\n  NOTE: checkpoint 5.4 classifies the air-handler fault on this same run "
            "as a\n  SENSOR fault -- the supply air thermometer is drifting and the "
            "controller is\n  saturating the valve chasing it. So this attribution is "
            "WRONG, and it is wrong\n  for exactly the reason the demote-not-hide "
            "decision anticipates: two faults on\n  connected assets in the same weeks "
            "are constantly a coincidence. The advisory is\n  still in the queue with "
            "its own evidence attached, so the operator can overrule\n  it. Had it been "
            "suppressed, a drifting sensor would have vanished behind a\n  chiller that "
            "had nothing to do with it. See scripts/run_diagnosis.py."
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
