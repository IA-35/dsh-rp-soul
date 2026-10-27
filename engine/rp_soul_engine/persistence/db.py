"""SQLite storage: connection, schema migration, backups.

One database file per data directory; all state lives here. The schema is
forward-only. Before migrating an existing database the file is copied to
backups/, and a failed migration restores that copy.
"""

import os
import sqlite3
import time

from .. import DB_SCHEMA_VERSION, MIN_SQLITE
from ..errors import (
    MIGRATION_FAILED,
    RUNTIME_UNSUPPORTED,
    STORAGE_BUSY,
    UNSUPPORTED_VERSION,
    AppError,
    detail,
)

BUSY_TIMEOUT_MS = 2000


def sqlite_version_ok():
    return tuple(sqlite3.sqlite_version_info) >= MIN_SQLITE


def connect(path):
    if not sqlite_version_ok():
        raise AppError(
            RUNTIME_UNSUPPORTED,
            "SQLite 版本过低：需要 %s 或更高，当前 %s" % (".".join(map(str, MIN_SQLITE)), sqlite3.sqlite_version),
            [detail("$.sqlite", "SQLite %s" % sqlite3.sqlite_version, "换用自带较新 SQLite 的 Python 3.10+")],
        )
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000.0, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=%d" % BUSY_TIMEOUT_MS)
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def begin_write(conn):
    """Start a write transaction or report STORAGE_BUSY."""
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc) or "busy" in str(exc):
            raise AppError(
                STORAGE_BUSY,
                "数据库正被其他进程占用",
                [detail("$", str(exc), "稍后用同一个 request_id 重试")],
            )
        raise


def read_schema_version(conn):
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
    if row is None:
        return 0
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Migrations. Each entry upgrades from version N-1 to N.


def _exec_script(conn, script):
    # executescript() would COMMIT the surrounding transaction; run statements
    # one by one so that a migration stays atomic.
    for statement in script.split(";"):
        if statement.strip():
            conn.execute(statement)


def _migrate_to_1(conn):
    """The initial layout: sessions hold a persona snapshot instead of world
    content, facts live in their own table so a commit's cost does not grow
    with the game, and slots copy facts and archive as rows."""
    _exec_script(
        conn,
        """
        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            turn INTEGER NOT NULL,
            persona_id TEXT NOT NULL,
            persona_title TEXT NOT NULL,
            persona_revision TEXT NOT NULL,
            mode TEXT NOT NULL,
            origin TEXT NOT NULL,
            state BLOB NOT NULL,
            persona BLOB NOT NULL,
            current_slot TEXT,
            slot_version INTEGER,
            turns_since_save INTEGER NOT NULL DEFAULT 0,
            activity INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX sessions_activity ON sessions(activity);
        CREATE TABLE facts (
            session_id TEXT NOT NULL,
            n INTEGER NOT NULL,
            id TEXT NOT NULL,
            key TEXT NOT NULL,
            head TEXT NOT NULL,
            truth INTEGER NOT NULL,
            visibility TEXT NOT NULL,
            origin TEXT NOT NULL,
            turn INTEGER NOT NULL,
            spreading INTEGER NOT NULL,
            knowers TEXT NOT NULL,
            text TEXT NOT NULL,
            data TEXT NOT NULL,
            suppressed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, id)
        );
        CREATE INDEX facts_key ON facts(session_id, key);
        CREATE INDEX facts_spreading ON facts(session_id, spreading);
        CREATE TABLE fact_journal (
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            id TEXT NOT NULL,
            before TEXT,
            PRIMARY KEY (session_id, turn, id)
        );
        CREATE TABLE turn_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            kind TEXT NOT NULL,
            action_mode TEXT,
            player_input TEXT,
            payload TEXT NOT NULL,
            summary TEXT,
            open_action TEXT,
            undone INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX turn_log_session ON turn_log(session_id, id);
        CREATE INDEX turn_log_turn ON turn_log(session_id, turn);
        CREATE TABLE undo_points (
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            state BLOB NOT NULL,
            PRIMARY KEY (session_id, turn)
        );
        CREATE TABLE idempotency (
            scope TEXT NOT NULL,
            request_id TEXT NOT NULL,
            digest TEXT NOT NULL,
            response TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (scope, request_id)
        );
        CREATE INDEX idempotency_scope ON idempotency(scope);
        CREATE TABLE archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            turn INTEGER,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX archive_session ON archive(session_id, id);
        CREATE TABLE slots (
            name TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            turn INTEGER NOT NULL,
            persona_id TEXT NOT NULL,
            persona_title TEXT NOT NULL,
            clock_label TEXT NOT NULL,
            mood_label TEXT,
            open_action TEXT,
            version INTEGER NOT NULL,
            state BLOB NOT NULL,
            persona BLOB NOT NULL,
            saved_at TEXT NOT NULL
        );
        CREATE TABLE slot_facts (
            slot TEXT NOT NULL,
            n INTEGER NOT NULL,
            id TEXT NOT NULL,
            key TEXT NOT NULL,
            head TEXT NOT NULL,
            truth INTEGER NOT NULL,
            visibility TEXT NOT NULL,
            origin TEXT NOT NULL,
            turn INTEGER NOT NULL,
            spreading INTEGER NOT NULL,
            knowers TEXT NOT NULL,
            text TEXT NOT NULL,
            data TEXT NOT NULL,
            suppressed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (slot, id)
        );
        CREATE TABLE slot_archive (
            slot TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            turn INTEGER,
            payload TEXT NOT NULL,
            PRIMARY KEY (slot, seq)
        );
        CREATE TABLE commit_failures (
            session_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            failed_at TEXT NOT NULL
        );
        CREATE TABLE thought_debug (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            npc_id TEXT NOT NULL,
            thought_id TEXT NOT NULL,
            label TEXT NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX thought_debug_session ON thought_debug(session_id, id);
        """
    )


def _knowers(fact):
    return "," + ",".join(fact["known_by"] + fact["believed_by"]) + ","


def _rewrite_facts(conn, table, column, owner, keep, migrate):
    """Fact rows of one session or slot, with only the two of you as knowers."""
    import json

    rows = conn.execute("SELECT id, data FROM %s WHERE %s=?" % (table, column), (owner,)).fetchall()
    for fid, data in rows:
        fact = migrate.fact_v1_to_v2(json.loads(data), keep)
        conn.execute(
            "UPDATE %s SET knowers=?, spreading=0, data=? WHERE %s=? AND id=?" % (table, column),
            (_knowers(fact), json.dumps(fact, ensure_ascii=False, separators=(",", ":")), owner, fid),
        )


def _migrate_to_2(conn):
    """State schema 1 (the multi-character engine) -> 2 (one companion).

    Sessions, their undo points, fact rows and fact journal, and save slots
    are upgraded in place by migrate.py; the turn log and the archive are
    display-only history and stay as they were.
    """
    import json

    from .. import migrate
    from . import repo

    for sid, state_blob, persona_blob in conn.execute("SELECT session_id, state, persona FROM sessions").fetchall():
        state, persona = repo.unpack(state_blob), repo.unpack(persona_blob)
        if not migrate.is_v1(state):
            continue
        new_state, new_persona = migrate.session_v1_to_v2(state, persona)
        conn.execute(
            "UPDATE sessions SET state=?, persona=?, persona_id=? WHERE session_id=?",
            (repo.pack(new_state), repo.pack(new_persona), new_persona["id"], sid),
        )
        keep = migrate.keep_of(new_state)
        _rewrite_facts(conn, "facts", "session_id", sid, keep, migrate)
        for turn, fid, before in conn.execute(
            "SELECT turn, id, before FROM fact_journal WHERE session_id=? AND before IS NOT NULL", (sid,)
        ).fetchall():
            fact = migrate.fact_v1_to_v2(json.loads(before), keep)
            conn.execute(
                "UPDATE fact_journal SET before=? WHERE session_id=? AND turn=? AND id=?",
                (json.dumps(fact, ensure_ascii=False, separators=(",", ":")), sid, turn, fid),
            )
        for turn, blob in conn.execute("SELECT turn, state FROM undo_points WHERE session_id=?", (sid,)).fetchall():
            old = repo.unpack(blob)
            if migrate.is_v1(old):
                conn.execute(
                    "UPDATE undo_points SET state=? WHERE session_id=? AND turn=?",
                    (repo.pack(migrate.state_v1_to_v2(old, persona)), sid, turn),
                )
    for name, state_blob, persona_blob in conn.execute("SELECT name, state, persona FROM slots").fetchall():
        state, persona = repo.unpack(state_blob), repo.unpack(persona_blob)
        if not migrate.is_v1(state):
            continue
        new_state, new_persona = migrate.session_v1_to_v2(state, persona)
        conn.execute(
            "UPDATE slots SET state=?, persona=?, persona_id=? WHERE name=?",
            (repo.pack(new_state), repo.pack(new_persona), new_persona["id"], name),
        )
        _rewrite_facts(conn, "slot_facts", "slot", name, migrate.keep_of(new_state), migrate)


def _migrate_to_3(conn):
    """State schema 2 -> 3: her memory in four layers replaces turns/chapters/prologue.

    Sessions, their undo points and save slots; facts and the archive table are
    untouched (the archived turns were already covered by chapters).
    """
    from .. import migrate
    from . import repo

    # 设置页手动删记忆的审计（和删情绪的 thought_debug 一样）
    _exec_script(conn, """
        CREATE TABLE memory_debug (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL,
            memory_id TEXT NOT NULL,
            layer TEXT NOT NULL,
            content TEXT NOT NULL,
            reason TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX memory_debug_session ON memory_debug(session_id, id)
    """)
    for sid, blob in conn.execute("SELECT session_id, state FROM sessions").fetchall():
        state = repo.unpack(blob)
        if state.get("schema") == migrate.TO_SCHEMA:
            conn.execute("UPDATE sessions SET state=? WHERE session_id=?", (repo.pack(migrate.state_v2_to_v3(state)), sid))
    for sid, turn, blob in conn.execute("SELECT session_id, turn, state FROM undo_points").fetchall():
        state = repo.unpack(blob)
        if state.get("schema") == migrate.TO_SCHEMA:
            conn.execute(
                "UPDATE undo_points SET state=? WHERE session_id=? AND turn=?",
                (repo.pack(migrate.state_v2_to_v3(state)), sid, turn),
            )
    for name, blob in conn.execute("SELECT name, state FROM slots").fetchall():
        state = repo.unpack(blob)
        if state.get("schema") == migrate.TO_SCHEMA:
            conn.execute("UPDATE slots SET state=? WHERE name=?", (repo.pack(migrate.state_v2_to_v3(state)), name))


MIGRATIONS = {1: _migrate_to_1, 2: _migrate_to_2, 3: _migrate_to_3}


def _now_stamp():
    return time.strftime("%Y%m%dT%H%M%S", time.localtime())


def backup(conn, backups_dir, label):
    """Copy the live database to backups/ with SQLite's online backup API."""
    os.makedirs(backups_dir, exist_ok=True)
    target = os.path.join(backups_dir, "rp-soul-%s-%s.db" % (label, _now_stamp()))
    suffix = 1

    base = target
    while os.path.exists(target):
        suffix += 1
        target = base[:-3] + "-%d.db" % suffix
    dest = sqlite3.connect(target)
    try:
        conn.backup(dest)
    finally:
        dest.close()
    return target


def restore(conn, backup_file):
    src = sqlite3.connect(backup_file)
    try:
        src.backup(conn)
    finally:
        src.close()


def _fault(name):
    return os.environ.get("RP_SOUL_FAULT") == name


def ensure_schema(conn, backups_dir):
    """Bring the database to DB_SCHEMA_VERSION. Returns a report dict."""
    current = read_schema_version(conn)
    report = {"from": current, "to": DB_SCHEMA_VERSION, "backup": None, "migrated": False}
    if current > DB_SCHEMA_VERSION:
        raise AppError(
            UNSUPPORTED_VERSION,
            "数据库来自更新版本的引擎（schema %d，本版本支持 %d）" % (current, DB_SCHEMA_VERSION),
            [detail("$.db.schema_version", "schema %d > %d" % (current, DB_SCHEMA_VERSION), "升级 rp-soul 到更新的版本；数据库未被修改")],
            found=current,
            supported=DB_SCHEMA_VERSION,
        )
    if current == DB_SCHEMA_VERSION:
        return report
    backup_file = None
    if current == 0:
        conn.execute("PRAGMA journal_mode=WAL")
    if current > 0:
        backup_file = backup(conn, backups_dir, "schema%d" % current)
        report["backup"] = backup_file
    begin_write(conn)
    try:
        current = read_schema_version(conn)
        for target in range(current + 1, DB_SCHEMA_VERSION + 1):
            MIGRATIONS[target](conn)
            if _fault("migration_fail"):
                raise RuntimeError("injected migration failure")
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", (str(target),))
        conn.execute("COMMIT")
    except AppError:
        conn.execute("ROLLBACK")
        raise
    except Exception as exc:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        restored = False
        if backup_file is not None:
            restore(conn, backup_file)
            restored = True
        # 文案不能说谎：没备份（库里还没有 schema_version，是全新库）时就说没可恢复的。
        hint = "不会加载任何会话；换回可用版本或把错误报告给维护者"
        if restored:
            message = "数据库从 schema %d 迁移到 %d 失败，已恢复迁移前的状态" % (report["from"], DB_SCHEMA_VERSION)
        else:
            message = "数据库从 schema %d 迁移到 %d 失败；这是全新库，没有可恢复的备份" % (report["from"], DB_SCHEMA_VERSION)
        raise AppError(
            MIGRATION_FAILED,
            message,
            [detail("$.db", "%s: %s" % (type(exc).__name__, exc), hint)],
            backup=backup_file,
            restored=restored,
        )
    report["migrated"] = True
    return report
