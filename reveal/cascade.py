"""Which reading on the faulted machine moved first, and in what order after it.

THE IDEA, and it only works because of how the scenarios were built. Every run in this
database reads the same 2018 source year, shifted by a whole number of years, so a
faulted run and a fault-free run have the SAME weather, the same occupancy schedule
and the same control decisions on the same day of the year. Subtract one from the
other on matching days and everything except the fault cancels. Before the injection
the difference is not merely small, it is exactly zero -- which is worth stating
because it is what makes the rest of this trustworthy, and because it also rules out
the obvious way of measuring divergence.

WHY NOT A Z-SCORE AGAINST THE PRE-INJECTION DIFFERENCE. That was the first attempt and
it is meaningless here: the pre-injection difference has zero spread on most points,
so any post-injection movement at all is infinitely many standard deviations and every
reading "diverges" on the first day. Measured that way, seventy-seven of a hundred and
four points came back with a standard deviation of exactly zero.

WHAT IS MEASURED INSTEAD. Each reading is compared against how much IT normally moves
from one day to the next in the fault-free run -- its own daily wobble. A reading has
diverged when its departure from the twin has exceeded one normal day's movement for
three days running. That gives a real ordering in time, because a fault reaches
different readings at different rates: on the fouled chiller, power crosses its own
wobble fifty days after injection, the compressor command five days after that, and
the water temperatures ten days after that again. The machine works harder long before
it fails to hold its temperatures, and that ordering is the story.

TWO LIMITS, BOTH REPORTED RATHER THAN WORKED AROUND.

Only readings on the faulted machine are considered. The first version looked at every
point in the era and produced nonsense: for the fouled chiller of 2036 the earliest
"divergences" were all on the air handler, one day BEFORE injection -- because that
era also contains a leaking coil valve, and the comparison was picking up somebody
else's fault. Cross-asset cascade cannot be measured this way in this dataset while
two faults share an era.

The fault-free runs cover May to September only, so a scenario reaching outside that
window can only be compared where the two overlap. Each answer says how much of its
own span it could actually see.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date, datetime

import psycopg

# How far a reading must depart from its twin, in multiples of its own normal
# day-to-day movement, before the departure is called real. One is deliberately low:
# this is not a detector and it is not scored against anything. It is a description of
# what the injected fault did, and the interesting output is the ORDER, which a higher
# bar would compress by pushing every reading past the threshold on the same late day.
DEPARTURE = 1.0

# For how many consecutive days, so that a single odd afternoon does not set the date.
HELD_DAYS = 3

# Which fault-free run each system is compared against.
TWIN = {"sdahu": "clean_ahu", "chiller": "clean_chiller"}

DAILY = """
WITH faulted AS (
  SELECT h.point_id, h.bucket::date AS d, avg(h.avg_value_si) AS v
    FROM app.measurements_hourly h JOIN app.points p USING (point_id)
   WHERE h.bucket >= %(ff)s AND h.bucket < %(ft)s
     AND p.usable AND p.asset_id = %(asset)s
   GROUP BY 1, 2
), clean AS (
  SELECT h.point_id, h.bucket::date AS d, avg(h.avg_value_si) AS v
    FROM app.measurements_hourly h JOIN app.points p USING (point_id)
   WHERE h.bucket >= %(cf)s AND h.bucket < %(ct)s
     AND p.usable AND p.asset_id = %(asset)s
   GROUP BY 1, 2
)
SELECT f.point_id, f.d, f.v, c.v
  FROM faulted f
  JOIN clean c ON c.point_id = f.point_id
              AND c.d = (f.d + make_interval(years => %(shift)s))::date
 ORDER BY f.point_id, f.d
"""


@dataclass(frozen=True)
class Departure:
    """One reading, and when the injected fault became visible in it."""

    point_id: str
    diverged_on: date | None
    days_after_onset: int | None
    peak_departure: float
    compared_days: int


@dataclass(frozen=True)
class Cascade:
    scenario_id: str
    asset_id: str
    onset: datetime
    twin_scenario: str
    year_shift: int
    covered_from: date | None
    covered_to: date | None
    days_compared: int
    points_considered: int
    departures: list[Departure]
    caveats: list[str]


def _twin_window(
    conn: psycopg.Connection, system: str, t_start: datetime, t_end: datetime
) -> tuple[str, int, datetime, datetime] | None:
    """The fault-free run for this system, and how many years forward it sits."""
    twin_id = TWIN.get(system)
    if twin_id is None:
        return None
    row = conn.execute(
        "SELECT t_start, t_end FROM groundtruth.scenarios WHERE scenario_id = %s",
        (twin_id,),
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return twin_id, row[0].year - t_start.year, row[0], row[1]


def compute(conn: psycopg.Connection, scenario_id: str) -> Cascade | None:
    """Order the faulted machine's readings by when the fault first showed in them."""
    row = conn.execute(
        """
        SELECT e.asset_id, e.t_onset, s.system, s.t_start, s.t_end
          FROM groundtruth.fault_events e
          JOIN groundtruth.scenarios s USING (scenario_id)
         WHERE e.scenario_id = %s
        """,
        (scenario_id,),
    ).fetchone()
    if row is None:
        return None
    asset_id, onset, system, t_start, t_end = row

    twin = _twin_window(conn, system, t_start, t_end)
    if twin is None:
        return None
    twin_id, shift, twin_from, twin_to = twin

    # Only the days both runs cover, expressed in the faulted run's own calendar.
    overlap_from = max(t_start, twin_from.replace(year=twin_from.year - shift))
    overlap_to = min(t_end, twin_to.replace(year=twin_to.year - shift))
    caveats: list[str] = []
    if overlap_to <= overlap_from:
        no_overlap = (
            f"the fault-free run {twin_id} does not cover any day of this scenario, "
            "so nothing here can be compared"
        )
        return Cascade(
            scenario_id, asset_id, onset, twin_id, shift, None, None, 0, 0, [],
            [no_overlap],
        )
    span_days = (t_end.date() - t_start.date()).days
    covered = (overlap_to.date() - overlap_from.date()).days
    if covered < span_days:
        caveats.append(
            f"{covered} of this scenario's {span_days} days have a fault-free "
            f"counterpart; {twin_id} runs {twin_from:%d %b} to {twin_to:%d %b} only, so "
            "the rest cannot be compared and a reading that diverged outside the "
            "overlap is dated at the first day inside it"
        )
    if overlap_from > onset:
        caveats.append(
            f"the comparable window opens {(overlap_from.date() - onset.date()).days} "
            "days after the fault was injected, so the dates below are lower bounds "
            "rather than the moment each reading actually moved"
        )

    rows = conn.execute(
        DAILY,
        {
            "ff": overlap_from, "ft": overlap_to,
            "cf": overlap_from.replace(year=overlap_from.year + shift),
            "ct": overlap_to.replace(year=overlap_to.year + shift),
            "shift": shift, "asset": asset_id,
        },
    ).fetchall()

    series: dict[str, list[tuple[date, float, float]]] = {}
    for point_id, day, faulted_v, clean_v in rows:
        if faulted_v is None or clean_v is None:
            continue
        series.setdefault(point_id, []).append((day, float(faulted_v), float(clean_v)))

    departures: list[Departure] = []
    for point_id, points in series.items():
        points.sort()
        clean = [c for _, _, c in points]
        steps = [abs(clean[i] - clean[i - 1]) for i in range(1, len(clean))]
        wobble = statistics.fmean(steps) if steps else 0.0
        if wobble < 1e-9:
            # A reading that never moves in the fault-free run has no scale to
            # measure against. Reported with a null date rather than dropped, so a
            # constant-valued point is visible as one rather than as an absence.
            departures.append(Departure(point_id, None, None, 0.0, len(points)))
            continue
        run = 0
        started: date | None = None
        first: date | None = None
        peak = 0.0
        for day, faulted_v, clean_v in points:
            ratio = abs(faulted_v - clean_v) / wobble
            peak = max(peak, ratio)
            if ratio >= DEPARTURE:
                run += 1
                if run == 1:
                    started = day
                if run >= HELD_DAYS and first is None:
                    first = started
            else:
                run = 0
        departures.append(
            Departure(
                point_id, first,
                None if first is None else (first - onset.date()).days,
                round(peak, 2), len(points),
            )
        )

    departures.sort(
        key=lambda d: (d.diverged_on is None, d.diverged_on or date.max, -d.peak_departure)
    )
    return Cascade(
        scenario_id, asset_id, onset, twin_id, shift,
        overlap_from.date(), overlap_to.date(), covered,
        len(series), departures, caveats,
    )
