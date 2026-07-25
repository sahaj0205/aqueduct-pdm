"""Pulling measurements and their trust scores together for the rule engine.

Rules need both halves of every reading: the value, and how far the quality
layer says it can be believed. They are two columns of the same row in the
database, and this module keeps them together all the way to the rule so nothing
above has to remember to fetch the second one.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import psycopg
from dotenv import load_dotenv

from analytics.rules.registry import Reading

REPO_ROOT = Path(__file__).resolve().parents[2]


def resolve_dsn() -> str:
    """Connect as the restricted role, like the rest of the detection path."""
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("APP_RW_DATABASE_URL")
    if not url:
        sys.exit("APP_RW_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def load_asset_readings(
    conn: psycopg.Connection, asset_id: str, t_from: datetime, t_to: datetime
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Values and quality scores for one asset over one window.

    Returns two frames on the same index and columns -- one of readings, one of
    the scores that go with them -- so a caller can line a value up against its
    trustworthiness by position without a join.
    """
    rows = conn.execute(
        "SELECT m.time, m.point_id, m.value_si, m.quality_score "
        "  FROM app.measurements m JOIN app.points p USING (point_id) "
        " WHERE p.asset_id = %s AND m.time >= %s AND m.time < %s",
        (asset_id, t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.DataFrame(), pd.DataFrame()

    frame = pd.DataFrame(rows, columns=["time", "point_id", "value_si", "quality_score"])
    values = frame.pivot_table(
        index="time", columns="point_id", values="value_si", dropna=False
    ).sort_index()
    quality = frame.pivot_table(
        index="time", columns="point_id", values="quality_score", dropna=False
    ).sort_index()
    return values, quality


def readings_at(
    values: pd.DataFrame, quality: pd.DataFrame, at: datetime
) -> dict[str, Reading]:
    """The value-and-quality pair for every point at one instant.

    This is the mapping a RuleContext is built from, so what a rule can see is
    exactly one row of the database and nothing either side of it.
    """
    value_row = values.loc[at]
    quality_row = quality.loc[at] if at in quality.index else None
    out: dict[str, Reading] = {}
    for point_id in values.columns:
        raw_value = value_row.get(point_id)
        raw_quality = None if quality_row is None else quality_row.get(point_id)
        out[point_id] = Reading(
            value=None if pd.isna(raw_value) else float(raw_value),
            quality=None if raw_quality is None or pd.isna(raw_quality) else int(raw_quality),
        )
    return out


def signal_frames(
    values: pd.DataFrame, quality: pd.DataFrame, signals: dict[str, str]
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Rename point columns to the roles the mode classifier asks for."""
    wanted = {role: point for role, point in signals.items() if point in values.columns}
    named_values = values[list(wanted.values())].rename(
        columns={point: role for role, point in wanted.items()}
    )
    named_quality = quality[list(wanted.values())].rename(
        columns={point: role for role, point in wanted.items()}
    )
    return named_values, named_quality
