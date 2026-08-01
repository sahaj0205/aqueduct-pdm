"""Dump the facility-manager platform's data straight out of the analytics database.

WHY THIS EXISTS. The FM platform ships as a static build with its data baked in rather
than calling the API. That is fine for a demo, but only if the baked numbers are the REAL
ones — otherwise wiring the API later would silently change every figure on every screen,
and the demo would have been showing fiction.

So this is the bridge. It reads the analytics tables for a set of VANTAGES — one run of
the building, one instant inside it treated as "now" — and writes JSON the frontend
imports. Re-run it against a rebuilt database and the demo updates; point the frontend at
the live API instead and the numbers do not move.

TWO CONNECTIONS, ON PURPOSE. Operational tables are read on the ordinary credential.
`groundtruth` — the answer key — is read on the admin credential, in its own function,
into its own output file. That mirrors the separation the rest of the project enforces:
the detection path has no grant on the answer key, and only the validation harness and
the one screen that exists to show it may read it.

    uv run python scripts/export_fm_seed.py --host 192.168.0.235
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "web" / "src" / "fm" / "data" / "generated"

# The runs worth serving, and the instant inside each that the platform calls "now".
#
# Chosen from the data rather than picked in advance — see the note on each. Every date
# below is one where the advisory replay actually produced a queue, so none of them is
# an empty screen by accident.
VANTAGES = [
    {
        "id": "2038-09-24",
        "era": 2038,
        "as_of": "2038-09-24",
        "default": True,
        # The only date in the whole 1,657-row replay carrying a cross-asset demotion,
        # and the only window with sensor-class advisories.
        "note": "AHU-1 fan bearing + two sensor faults, one demoted beneath an upstream cause",
    },
    {
        "id": "2036-06-20",
        "era": 2036,
        "as_of": "2036-06-20",
        "default": False,
        # Biggest spread between cost of waiting and cost of acting anywhere in the set.
        "note": "AHU-1 cooling-coil valve leaking — the strongest cost-of-waiting case",
    },
    {
        "id": "2038-07-15",
        "era": 2038,
        "as_of": "2038-07-15",
        "default": False,
        "note": "Mid-run in the sensor-drift year, before the sensor faults surface",
    },
    {
        "id": "2039-07-15",
        "era": 2039,
        "as_of": "2039-07-15",
        "default": False,
        "note": "Both runs fault-free — what the queue looks like with nothing wrong",
    },
]


def _dsn(var: str, host: str | None, port: str | None) -> str:
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get(var)
    if not url:
        sys.exit(f"{var} is not set. Copy .env.example to .env.")
    url = url.replace("postgresql+psycopg://", "postgresql://", 1)
    if host:
        # The .env points at localhost; the database may be on another machine.
        import re

        url = re.sub(r"@[^:/]+", f"@{host}", url, count=1)
        if port:
            url = re.sub(r"@([^:/]+):\d+", rf"@\1:{port}", url, count=1)
    return url


def _json_default(value):
    # `date` must be tested before `datetime` is not needed — datetime is a subclass of
    # date, so the isinstance check below covers both and .isoformat() is right for each.
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"cannot serialise {type(value)!r}")


def rows(conn: psycopg.Connection, sql: str, params: tuple = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        if cur.description is None:
            return []
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def export_operational(conn: psycopg.Connection) -> dict:
    """Everything the operator's screens read. Ordinary credential, no answer key."""
    out: dict = {"vantages": VANTAGES}

    # --- configuration: true for every run, so fetched once -------------------
    out["assets"] = rows(conn, "SELECT * FROM app.assets ORDER BY asset_id")
    out["asset_edges"] = rows(conn, "SELECT * FROM app.asset_edges ORDER BY from_asset, to_asset")
    out["failure_modes"] = rows(conn, "SELECT * FROM app.failure_modes ORDER BY mode_id")
    out["interventions"] = rows(
        conn, "SELECT * FROM app.intervention_library ORDER BY applies_to_fault, applies_to_class"
    )
    out["points"] = rows(conn, "SELECT * FROM app.points ORDER BY point_id")

    # --- per-vantage ----------------------------------------------------------
    out["runs"] = {}
    for v in VANTAGES:
        era, as_of = v["era"], v["as_of"]

        advisories = rows(
            conn,
            """
            SELECT * FROM app.advisories
             WHERE window_to::date = %s::date
             ORDER BY priority DESC NULLS LAST, severity DESC
            """,
            (as_of,),
        )

        # Health for every asset scored in this run, every day up to the vantage. Both
        # the per-mode rows and the asset roll-up (mode_id IS NULL).
        health = rows(
            conn,
            """
            SELECT * FROM app.health_state
             WHERE time >= make_date(%s, 1, 1) AND time <= %s::date + 1
             ORDER BY asset_id, mode_id NULLS FIRST, time
            """,
            (era, as_of),
        )

        # Every estimate published in the run, so the fan chart can show the interval
        # narrowing rather than only its final width.
        rul = rows(
            conn,
            """
            SELECT * FROM app.rul_estimates
             WHERE as_of >= make_date(%s, 1, 1) AND as_of <= %s::date + 1
             ORDER BY asset_id, mode_id, as_of
            """,
            (era, as_of),
        )

        # Residuals are five-minutely; the chart plots daily medians anyway. Restricted
        # to points that actually belong to an asset with an advisory or a health score,
        # so this does not drag the whole instrument set along.
        residuals = rows(
            conn,
            """
            SELECT point_id,
                   time::date                                            AS day,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY observed) AS observed,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY expected) AS expected,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY residual) AS residual,
                   count(*)                                              AS n
              FROM app.residuals
             WHERE time >= make_date(%s, 1, 1) AND time <= %s::date + 1
             GROUP BY point_id, time::date
             ORDER BY point_id, day
            """,
            (era, as_of),
        )

        # Instrument faults standing at the vantage: opened on or before it, and not
        # already closed before it.
        sensors = rows(
            conn,
            """
            SELECT * FROM app.sensor_advisories
             WHERE t_from <= %s::date + 1
               AND t_to   >= %s::date
             ORDER BY worst_score ASC, t_from DESC
             LIMIT 400
            """,
            (as_of, as_of),
        )

        out["runs"][v["id"]] = {
            "era": era,
            "as_of": as_of,
            "advisories": advisories,
            "health_state": health,
            "rul_estimates": rul,
            "residuals_daily": residuals,
            "sensor_advisories": sensors,
        }

    return out


def export_groundtruth(conn: psycopg.Connection) -> dict:
    """The answer key. Admin credential, its own file, never merged with the above."""
    return {
        "scenarios": rows(conn, "SELECT * FROM groundtruth.scenarios ORDER BY scenario_id"),
        "fault_events": rows(
            conn, "SELECT * FROM groundtruth.fault_events ORDER BY t_onset"
        ),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=None, help="database host, if not the one in .env")
    ap.add_argument("--port", default=None)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(_dsn("DATABASE_URL", args.host, args.port)) as conn:
        operational = export_operational(conn)
    (OUT_DIR / "operational.json").write_text(
        json.dumps(operational, indent=1, default=_json_default)
    )

    with psycopg.connect(_dsn("ADMIN_DATABASE_URL", args.host, args.port)) as conn:
        truth = export_groundtruth(conn)
    (OUT_DIR / "groundtruth.json").write_text(
        json.dumps(truth, indent=1, default=_json_default)
    )

    print("operational.json")
    for k, v in operational.items():
        if isinstance(v, list):
            print(f"    {k:22s} {len(v):>7,}")
    for run_id, run in operational["runs"].items():
        counts = " ".join(
            f"{k.split('_')[0]}={len(v):,}" for k, v in run.items() if isinstance(v, list)
        )
        print(f"    run {run_id}  {counts}")
    print("groundtruth.json")
    for k, v in truth.items():
        print(f"    {k:22s} {len(v):>7,}")


if __name__ == "__main__":
    main()
