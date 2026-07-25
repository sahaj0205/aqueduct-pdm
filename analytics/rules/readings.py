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
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Values, quality scores and quality flags for one asset over one window.

    Returns three frames on the same index and columns -- the readings, the
    scores that go with them, and the breakdown of which dimensions each score
    failed -- so a caller can line all three up by position without a join.
    """
    rows = conn.execute(
        "SELECT m.time, m.point_id, m.value_si, m.quality_score, m.quality_flags "
        "  FROM app.measurements m JOIN app.points p USING (point_id) "
        " WHERE p.asset_id = %s AND m.time >= %s AND m.time < %s",
        (asset_id, t_from, t_to),
    ).fetchall()
    if not rows:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

    frame = pd.DataFrame(
        rows, columns=["time", "point_id", "value_si", "quality_score", "quality_flags"]
    )
    values = frame.pivot_table(
        index="time", columns="point_id", values="value_si", dropna=False
    ).sort_index()
    quality = frame.pivot_table(
        index="time", columns="point_id", values="quality_score", dropna=False
    ).sort_index()
    # pivot_table aggregates, and a dict is not aggregatable, so the flags are
    # reshaped with pivot instead. They are needed because a rule that treats a
    # motionless reading as evidence has to know WHICH dimension scored badly.
    flags = frame.pivot(index="time", columns="point_id", values="quality_flags").sort_index()
    return values, quality, flags


def readings_at(
    values: pd.DataFrame, quality: pd.DataFrame, flags: pd.DataFrame, at: datetime
) -> dict[str, Reading]:
    """The value-and-quality pair for every point at one instant.

    This is the mapping a RuleContext is built from, so what a rule can see is
    exactly one row of the database and nothing either side of it.
    """
    value_row = values.loc[at]
    quality_row = quality.loc[at] if at in quality.index else None
    flag_row = flags.loc[at] if at in flags.index else None
    out: dict[str, Reading] = {}
    for point_id in values.columns:
        raw_value = value_row.get(point_id)
        raw_quality = None if quality_row is None else quality_row.get(point_id)
        raw_flags = None if flag_row is None else flag_row.get(point_id)
        out[point_id] = Reading(
            value=None if pd.isna(raw_value) else float(raw_value),
            quality=None if raw_quality is None or pd.isna(raw_quality) else int(raw_quality),
            flags=raw_flags if isinstance(raw_flags, dict) else None,
        )
    return out


def signal_frames(
    values: pd.DataFrame,
    quality: pd.DataFrame,
    flags: pd.DataFrame,
    signals: dict[str, str],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Rename point columns to the roles the mode classifier asks for."""
    wanted = {role: point for role, point in signals.items() if point in values.columns}
    columns = list(wanted.values())
    rename = {point: role for role, point in wanted.items()}
    return (
        values[columns].rename(columns=rename),
        quality[columns].rename(columns=rename),
        flags[columns].rename(columns=rename),
    )


def effective_quality_frame(quality: pd.DataFrame, flags: pd.DataFrame) -> pd.DataFrame:
    """Recompute every score ignoring the staleness dimension.

    Staleness says a reading stopped changing, not that it is wrong, so a value
    marked down only for sitting still is still a correct statement of where the
    sensor or actuator is. Judging operating mode on the raw composite throws
    that away: the outdoor air damper resting on its minimum position for hours
    is scored badly for not moving, and the mode then becomes unknown for a
    fifth of the time the quality layer flags it -- which suppresses every rule,
    including the one looking for a damper that has seized.
    """
    out = quality.copy()
    for column in quality.columns:
        if column not in flags.columns:
            continue
        column_flags = flags[column]
        flagged = column_flags.map(lambda entry: isinstance(entry, dict))
        if not flagged.any():
            continue
        out.loc[flagged, column] = column_flags[flagged].map(
            lambda entry: min(
                [score for name, score in entry.items() if name != "staleness"], default=100
            )
        )
    return out
