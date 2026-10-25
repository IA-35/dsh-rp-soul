"""Environment diagnostics and first-run initialisation (idempotent).

`doctor` is what node calls before it trusts the sidecar: version gate, data
directory, schema, and a few counts. It never writes anything except the
data directory and the schema it is asked to create.
"""

import os
import sqlite3
import sys

from .. import DB_SCHEMA_VERSION, ENGINE_VERSION, MIN_PYTHON, MIN_SQLITE
from ..errors import RUNTIME_UNSUPPORTED, AppError, detail
from ..persistence import db, repo


def _python_report():
    ok = sys.version_info[:2] >= MIN_PYTHON
    return {"version": sys.version.split()[0], "minimum": "%d.%d" % MIN_PYTHON, "ok": ok}


def _sqlite_report():
    ok = sqlite3.sqlite_version_info >= MIN_SQLITE
    return {"version": sqlite3.sqlite_version, "minimum": "%d.%d.%d" % MIN_SQLITE, "ok": ok}


def run(ctx, payload):
    python = _python_report()
    sqlite = _sqlite_report()
    if not python["ok"]:
        raise AppError(
            RUNTIME_UNSUPPORTED,
            "Python 版本过低：需要 %s 以上，当前 %s" % (python["minimum"], python["version"]),
            [detail("$.python", "Python 版本不满足要求", "把 node 侧探测顺序里的 python3 / python / py -3 指到 3.10 以上", RUNTIME_UNSUPPORTED)],
        )
    if not sqlite["ok"]:
        raise AppError(
            RUNTIME_UNSUPPORTED,
            "SQLite 版本过低：需要 %s 以上，当前 %s" % (sqlite["minimum"], sqlite["version"]),
            [detail("$.sqlite", "SQLite 版本不满足要求", "换一个自带新版 SQLite 的 Python 解释器", RUNTIME_UNSUPPORTED)],
        )
    problem = ctx.data_dir_problem()
    if problem is not None:
        ctx.prepare_data_dir()  # raises the structured error with suggestions
    conn = ctx.db()
    integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
    return {
        "ok": integrity == "ok",
        "engine": ENGINE_VERSION,
        "python": python,
        "sqlite": sqlite,
        "data_dir": ctx.data_dir,
        "data_dir_source": ctx.data_dir_source,
        "db": {
            "path": os.path.join(ctx.data_dir, "engine.db"),
            "schema": repo_schema(conn),
            "target_schema": DB_SCHEMA_VERSION,
            "integrity": integrity,
            "report": ctx.schema_report,
        },
        "counts": {
            "sessions": count(conn, "sessions"),
            "slots": count(conn, "slots"),
            "facts": count(conn, "facts"),
        },
    }


def repo_schema(conn):
    try:
        return db.read_schema_version(conn)
    except sqlite3.Error:
        return None


def count(conn, table):
    try:
        return conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
    except sqlite3.Error:
        return None
