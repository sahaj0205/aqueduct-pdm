"""The reveal API: what was actually injected, served separately from what was detected.

    uv run uvicorn reveal.main:app --reload --port 8002
    open http://localhost:8002/docs

Three endpoints. What was injected into each run and when; what was running at a given
moment, which is what the reveal button on the dashboard asks; and, per run, the order
in which the fault showed up in the machine's own readings.

This process connects as the admin role and can read schema groundtruth. The detection
API cannot, and that has not changed -- see reveal/__init__.py for why this is a second
application rather than three more routes on the first one.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from typing import Annotated

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from reveal.cascade import DEPARTURE, HELD_DAYS, compute
from reveal.db import admin_dsn, connection

app = FastAPI(
    title="Aqueduct PDM — reveal",
    version="0.1.0",
    summary="The answer key: what was injected, when, and how it spread",
    description=(
        "Ground truth for the demonstration. Runs as a separate process on a "
        "separate credential from the detection API, which has no access to this "
        "data at all. Nothing here detects, scores or predicts."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

Conn = Annotated[psycopg.Connection, Depends(connection)]


class Rung(BaseModel):
    """One measured severity in the ladder the trajectory was built from."""

    level: int
    label: str
    source_file: str


class InjectedFault(BaseModel):
    """One run, and the fault put into it."""

    scenario_id: str
    system: str
    asset_id: str
    fault_mode: str
    terminal_severity: str = Field(
        description="The label of the worst rung the trajectory reaches"
    )
    profile: str = Field(description="progressive or step")
    t_onset: datetime
    t_failure: datetime | None
    t_start: datetime
    t_end: datetime
    ladder: list[Rung]
    seed: int | None


class CleanRun(BaseModel):
    scenario_id: str
    system: str
    t_start: datetime
    t_end: datetime


class AnswerKey(BaseModel):
    faults: list[InjectedFault]
    clean_runs: list[CleanRun]


class AtMoment(BaseModel):
    """What the answer key says was true at one instant."""

    as_of: datetime
    active: list[InjectedFault] = Field(
        description="Faults injected before this moment and not yet past failure"
    )
    not_yet_injected: list[InjectedFault]
    already_failed: list[InjectedFault]
    clean_runs_covering: list[CleanRun]


class DepartureOut(BaseModel):
    point_id: str
    diverged_on: str | None
    days_after_onset: int | None
    peak_departure: float = Field(
        description="Furthest the reading got from its twin, in multiples of its "
                    "own normal day-to-day movement"
    )
    compared_days: int


class CascadeOut(BaseModel):
    scenario_id: str
    asset_id: str
    onset: datetime
    twin_scenario: str = Field(description="The fault-free run compared against")
    year_shift: int
    covered_from: str | None
    covered_to: str | None
    days_compared: int
    points_considered: int
    departure_threshold: float
    held_days: int
    caveats: list[str]
    departures: list[DepartureOut]


def _fault_rows(conn: psycopg.Connection) -> list[InjectedFault]:
    rows = conn.execute(
        """
        SELECT e.scenario_id, s.system, e.asset_id, e.fault_mode, e.severity_level,
               e.t_onset, e.t_failure, s.t_start, s.t_end, e.params
          FROM groundtruth.fault_events e
          JOIN groundtruth.scenarios s USING (scenario_id)
         ORDER BY e.t_onset
        """
    ).fetchall()
    out = []
    for r in rows:
        params = r[9] or {}
        out.append(
            InjectedFault(
                scenario_id=r[0], system=r[1], asset_id=r[2], fault_mode=r[3],
                terminal_severity=r[4], profile=params.get("profile", "unknown"),
                t_onset=r[5], t_failure=r[6], t_start=r[7], t_end=r[8],
                ladder=[
                    Rung(level=w.get("level", 0), label=w.get("label", ""),
                         source_file=w.get("file", ""))
                    for w in params.get("waypoints", [])
                ],
                seed=params.get("seed"),
            )
        )
    return out


@app.get("/reveal/scenarios", response_model=AnswerKey, tags=["reveal"])
def scenarios(conn: Conn) -> AnswerKey:
    """Every run, the fault put into it, and the severity ladder it walks."""
    clean = [
        CleanRun(scenario_id=r[0], system=r[1], t_start=r[2], t_end=r[3])
        for r in conn.execute(
            "SELECT scenario_id, system, t_start, t_end FROM groundtruth.scenarios "
            " WHERE is_fault_free ORDER BY t_start"
        ).fetchall()
    ]
    return AnswerKey(faults=_fault_rows(conn), clean_runs=clean)


@app.get("/reveal/at", response_model=AtMoment, tags=["reveal"])
def at(
    conn: Conn,
    as_of: Annotated[datetime, Query(description="The moment to reveal")],
) -> AtMoment:
    """What was actually wrong with this building at this instant.

    The endpoint the reveal button calls. Faults are split three ways rather than
    filtered, because "nothing was injected yet" and "it had already reached failure"
    are different answers and a screen that showed an empty list for both would be
    hiding the more interesting one.
    """
    faults = _fault_rows(conn)
    return AtMoment(
        as_of=as_of,
        active=[
            f for f in faults
            if f.t_onset <= as_of and (f.t_failure is None or as_of <= f.t_failure)
        ],
        not_yet_injected=[f for f in faults if f.t_onset > as_of],
        already_failed=[
            f for f in faults if f.t_failure is not None and f.t_failure < as_of
        ],
        clean_runs_covering=[
            CleanRun(scenario_id=r[0], system=r[1], t_start=r[2], t_end=r[3])
            for r in conn.execute(
                "SELECT scenario_id, system, t_start, t_end FROM groundtruth.scenarios "
                " WHERE is_fault_free AND t_start <= %(t)s AND t_end >= %(t)s",
                {"t": as_of},
            ).fetchall()
        ],
    )


@lru_cache(maxsize=16)
def _cascade_cached(scenario_id: str) -> CascadeOut | None:
    """One cascade, computed once per process.

    Cached rather than stored in a table: there are six of these, each takes about
    three seconds, and none of them changes while the process runs. A table would be a
    migration and a driver for something a dictionary already does.
    """
    with psycopg.connect(admin_dsn()) as conn:
        found = compute(conn, scenario_id)
    if found is None:
        return None
    return CascadeOut(
        scenario_id=found.scenario_id, asset_id=found.asset_id, onset=found.onset,
        twin_scenario=found.twin_scenario, year_shift=found.year_shift,
        covered_from=None if found.covered_from is None else str(found.covered_from),
        covered_to=None if found.covered_to is None else str(found.covered_to),
        days_compared=found.days_compared, points_considered=found.points_considered,
        departure_threshold=DEPARTURE, held_days=HELD_DAYS,
        caveats=found.caveats,
        departures=[
            DepartureOut(
                point_id=d.point_id,
                diverged_on=None if d.diverged_on is None else str(d.diverged_on),
                days_after_onset=d.days_after_onset,
                peak_departure=d.peak_departure, compared_days=d.compared_days,
            )
            for d in found.departures
        ],
    )


@app.get("/reveal/cascade/{scenario_id}", response_model=CascadeOut, tags=["reveal"])
def cascade(scenario_id: str) -> CascadeOut:
    """In what order the injected fault showed up in the machine's own readings.

    Every run reads the same source year shifted by whole years, so a faulted run and
    the fault-free run share weather, occupancy and control decisions day for day.
    Subtracting one from the other leaves only the fault. Each reading is then
    measured against how much it normally moves from one day to the next, and the
    order in which they cross that is the cascade.

    Restricted to the faulted machine's own readings on purpose: two of these eras
    contain a second injected fault on different equipment, and comparing every point
    picked up the other fault instead. Limits are returned in `caveats` rather than
    smoothed over.
    """
    found = _cascade_cached(scenario_id)
    if found is None:
        raise HTTPException(
            status_code=404,
            detail=f"no injected fault recorded for scenario {scenario_id!r}",
        )
    return found
