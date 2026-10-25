"""Engine and format versions, plus the command table (read-only, no database)."""

from .. import ENGINE_VERSION, MIN_PYTHON, MIN_SQLITE, RNG_VERSION, SAVE_FORMAT, STATE_SCHEMA_VERSION
from . import commands as REGISTRY


def version(ctx, payload):
    """Engine, save format, state schema, RNG version and the runtime floor."""
    import sqlite3
    import sys

    return {
        "engine": ENGINE_VERSION,
        "save_format": SAVE_FORMAT,
        "schema_version": STATE_SCHEMA_VERSION,
        "rng_version": RNG_VERSION,
        "python": {
            "version": sys.version.split()[0],
            "minimum": "%d.%d" % MIN_PYTHON,
            "ok": sys.version_info[:2] >= MIN_PYTHON,
        },
        "sqlite": {
            "version": sqlite3.sqlite_version,
            "minimum": "%d.%d.%d" % MIN_SQLITE,
            "ok": sqlite3.sqlite_version_info >= MIN_SQLITE,
        },
        "data_dir": ctx.data_dir,
        "data_dir_source": ctx.data_dir_source,
    }


def commands(ctx, payload):
    """Every command with its input shape and one-line summary."""
    return {"commands": REGISTRY.table()}
