"""The privileged connection, in one place, as everywhere else in this project."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from functools import cache
from pathlib import Path

import psycopg
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]


@cache
def admin_dsn() -> str:
    """The only credential permitted to read the answer key.

    Same resolution as validation/groundtruth.py, including stripping the SQLAlchemy
    driver prefix psycopg does not accept. These two are the only callers in the
    repository and they must not drift apart.
    """
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("ADMIN_DATABASE_URL")
    if not url:
        sys.exit("ADMIN_DATABASE_URL is not set. Copy .env.example to .env.")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def connection() -> Iterator[psycopg.Connection]:
    """One connection per request, as a FastAPI dependency."""
    with psycopg.connect(admin_dsn()) as conn:
        yield conn
