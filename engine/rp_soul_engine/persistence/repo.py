"""SQL for sessions, facts, turn log, undo points, idempotency, slots, archive.

Every function takes an open connection; transactions belong to the
application's write path. Snapshots are compact JSON compressed with zlib.

A session is stored as a per-turn state blob *without* its facts, plus one row
per fact, so a commit's cost does not grow with the game. A loaded session's
state["facts"] is a FactSource that reads rows on demand. Each commit writes
only the facts it changed and journals their previous versions by turn, so
undo and rewrite can put them back. Slots and exports hold complete states.

What used to be `content` (a world pack) is now `persona` (the markdown the
player wrote, plus its parsed pack) - the engine only reads it.
"""

import json
import zlib

from .. import STATE_SCHEMA_VERSION as STATE_VERSION
from ..domain import facts as FA
from ..domain import memories as MEM
from ..errors import NOT_FOUND, UNSUPPORTED_VERSION, AppError, detail

IDEMPOTENCY_KEEP = 200
# 每条幂等记录都躺着一份 6~20KB 的完整 context：1000 条能撑到 20MB，
# 而真正会被重试的窗口只有最近几十次请求，砍到 200 条足够且省下十几 MB。

# 删除审计只留最近五条：它是给「刚才那条怎么没了」用的，翻不到五条以前。
DELETIONS_KEEP = 5

# Every session is opened from a persona pack; the column stays for the
# session list's "how was this opened" line.
PERSONA_MODE = "persona"


def pack(obj):
    return zlib.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)


def unpack(blob):
    return json.loads(zlib.decompress(blob).decode("utf-8"))


def hot(state):
    """The per-turn blob: the state without its facts.

    常识库也剥掉：它是全局的，不属于这一局，load_session 每次现读。
    """
    return {k: v for k, v in state.items() if k not in ("facts", "common")}


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _check_state(state, where):
    schema = state.get("schema")
    if schema != STATE_VERSION:
        raise AppError(
            UNSUPPORTED_VERSION,
            "存档的 state schema 是 %s，本引擎支持 %d" % (schema, STATE_VERSION),
            [detail("$.state.schema", "schema %s" % schema, "用升级前的引擎导出，或换回旧版本引擎读取；%s" % where)],
        )
    return state


# -- facts --------------------------------------------------------------------


def fact_row(session_id, fact):
    knowers = "," + ",".join(fact["known_by"] + fact["believed_by"]) + ","
    spreading = 1 if fact.get("spreading") and fact["visibility"] != "inner" else 0
    suppressed = 1 if fact.get("thought_suppressed") else 0
    return (
        session_id,
        FA.order(fact),
        fact["id"],
        fact["key"],
        fact["key"].split(".", 1)[0],
        1 if fact["truth"] else 0,
        fact["visibility"],
        fact["origin"],
        fact["turn"],
        spreading,
        knowers,
        fact["text"],
        _dump(fact),
        suppressed,
    )


FACT_COLUMNS = "n, id, key, head, truth, visibility, origin, turn, spreading, knowers, text, data, suppressed"
FACT_INSERT = "INSERT OR REPLACE INTO facts(session_id, %s) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)" % FACT_COLUMNS


def insert_facts(conn, session_id, facts):
    conn.executemany(FACT_INSERT, [fact_row(session_id, f) for f in facts])


def insert_slot_facts(conn, slot, facts):
    conn.executemany(
        "INSERT INTO slot_facts(slot, %s) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)" % FACT_COLUMNS,
        [fact_row(slot, f) for f in facts],
    )


class FactSource(FA.FactsAPI):
    """One session's facts, read from the facts table on demand."""

    def __init__(self, conn, session_id):
        self.conn = conn
        self.session_id = session_id
        self.cache = {}

    def _rows(self, where, args, tail=" ORDER BY n"):
        out = []
        sql = "SELECT id, data FROM facts WHERE session_id=?" + where + tail
        for fid, data in self.conn.execute(sql, (self.session_id,) + tuple(args)):
            fact = self.cache.get(fid)
            if fact is None:
                fact = self.cache[fid] = json.loads(data)
            out.append(fact)
        return out

    def get(self, fid, default=None):
        if fid in self.cache:
            return self.cache[fid]
        found = self._rows(" AND id=?", (fid,), "")
        return found[0] if found else default

    def all(self):
        return self._rows("", ())

    def by_key(self, key):
        return self._rows(" AND key=?", (key,))

    def known_to(self, cid):
        return self._rows(" AND instr(knowers, ?) > 0", ("," + cid + ",",))

    def spreading(self):
        return self._rows(" AND spreading=1", ())

    def player_ranked(self, player, present_ids, present_names, recent_turn, limit=None, exclude=()):
        # The same order as facts.rank_key, computed by SQLite so that only the
        # returned rows are decoded.
        mention, args = [], []
        if present_ids:
            mention.append("head IN (%s)" % ",".join("?" * len(present_ids)))
            args.extend(present_ids)
        for name in present_names:
            if name:
                mention.append("instr(text, ?) > 0")
                args.append(name)
        where = " AND instr(knowers, ?) > 0"
        where_args = ["," + player + ","]
        if exclude:
            where += " AND id NOT IN (%s)" % ",".join("?" * len(exclude))
            where_args.extend(exclude)
        tail = (
            " ORDER BY (CASE WHEN %s THEN 3 ELSE 0 END) + (CASE WHEN turn >= ? THEN 2 ELSE 0 END)"
            " - (CASE WHEN origin='setup' AND head='player' THEN 1 ELSE 0 END) DESC, turn DESC, n"
        ) % (" OR ".join(mention) or "0")
        tail_args = args + [recent_turn]
        if limit:
            tail += " LIMIT ?"
            tail_args.append(limit)
        return self._rows(where, where_args + tail_args, tail)


def write_fact_changes(conn, session_id, turn, view):
    """Store a commit's new and changed facts, drop the deleted ones; journal
    what they were (a deleted fact journals its last version, so undo brings
    it back)."""
    changed = view.changed_facts()
    if changed:
        conn.executemany(FACT_INSERT, [fact_row(session_id, f) for f in changed])
        conn.executemany(
            "INSERT OR IGNORE INTO fact_journal(session_id, turn, id, before) VALUES(?,?,?,?)",
            [(session_id, turn, f["id"], None if view.before[f["id"]] is None else _dump(view.before[f["id"]])) for f in changed],
        )
    dropped = view.dropped()
    if dropped:
        conn.executemany(
            "INSERT OR IGNORE INTO fact_journal(session_id, turn, id, before) VALUES(?,?,?,?)",
            [(session_id, turn, f["id"], _dump(f)) for f in dropped],
        )
        conn.executemany(
            "DELETE FROM facts WHERE session_id=? AND id=?",
            [(session_id, f["id"]) for f in dropped],
        )


def revert_turn_facts(conn, session_id, turn):
    """Put the facts back as they were before `turn` (undo, rewrite).

    A fact the settings page deleted by hand is journalled at turn 0 and is
    gone from `facts`; undoing an older turn that happened to write it must
    not bring it back, so those ids are skipped.
    """
    by_hand = set(
        row[0]
        for row in conn.execute(
            "SELECT j.id FROM fact_journal j WHERE j.session_id=? AND j.turn=0 "
            "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.session_id=j.session_id AND f.id=j.id)",
            (session_id,),
        )
    )
    rows = conn.execute("SELECT id, before FROM fact_journal WHERE session_id=? AND turn=?", (session_id, turn)).fetchall()
    for fid, before in rows:
        if fid in by_hand:
            continue
        if before is None:
            conn.execute("DELETE FROM facts WHERE session_id=? AND id=?", (session_id, fid))
        else:
            conn.execute(FACT_INSERT, fact_row(session_id, json.loads(before)))
    conn.execute("DELETE FROM fact_journal WHERE session_id=? AND turn=?", (session_id, turn))


def count_facts(conn, session_id):
    return conn.execute("SELECT COUNT(*) FROM facts WHERE session_id=?", (session_id,)).fetchone()[0]


# -- sessions -----------------------------------------------------------------

SESSION_COLUMNS = (
    "session_id",
    "revision",
    "turn",
    "persona_id",
    "persona_title",
    "persona_revision",
    "mode",
    "origin",
    "current_slot",
    "slot_version",
    "turns_since_save",
    "created_at",
    "updated_at",
)


def _missing_session(session_id):
    return AppError(
        NOT_FOUND,
        "会话不存在：%s" % session_id,
        [detail("$.session_id", "会话不存在：%s" % session_id, "用 list-sessions 列出实际存在的会话", NOT_FOUND)],
    )


def load_session(conn, session_id, with_persona=True):
    columns = ", ".join(SESSION_COLUMNS) + ", state" + (", persona" if with_persona else "")
    row = conn.execute("SELECT %s FROM sessions WHERE session_id=?" % columns, (session_id,)).fetchone()
    if row is None:
        raise _missing_session(session_id)
    info = dict(zip(SESSION_COLUMNS, row[: len(SESSION_COLUMNS)]))
    info["state"] = MEM.normalize_legacy(_check_state(unpack(row[len(SESSION_COLUMNS)]), "session %s" % session_id))
    # 老存档的 state 里没有时间锚点（写它们的代码是后来才有的），而续写全靠它们
    # 算「过了多久」：缺一个，整局就从此刻重新起算，中间那几天被静默吃掉。
    # 会话的 created_at 是唯一还留着的真实时刻，拿它补。
    for key in ("real_start", "real_at"):
        if not info["state"].get(key):
            info["state"][key] = info["created_at"]
    info["state"]["facts"] = FactSource(conn, session_id)
    # 常识库不随这一局存（它跨会话），每次读存档现挂上：注入和模型学新条目
    # 都要用到，但写回去的时候 hot() 会再剥掉。
    info["state"]["common"] = load_common(conn)
    info["state"]["common_limit"] = common_limit(conn)
    if with_persona:
        info["persona"] = unpack(row[len(SESSION_COLUMNS) + 1])
    return info


def insert_session(conn, state, persona, origin, now, current_slot=None, slot_version=None, with_facts=True):
    """A new session from a complete state (opening, import); a load copies the
    slot's fact rows itself (with_facts=False)."""
    if with_facts:
        insert_facts(conn, state["session_id"], FA.of(state).all())
    conn.execute(
        "INSERT INTO sessions(session_id, revision, turn, persona_id, persona_title, persona_revision, mode, origin, state, persona, "
        "current_slot, slot_version, turns_since_save, created_at, updated_at, activity) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(activity), 0) + 1 FROM sessions))",
        (
            state["session_id"],
            state.get("revision", 0),
            state["turn"],
            state["persona_id"],
            state["persona_title"],
            state["persona_revision"],
            PERSONA_MODE,
            origin,
            pack(hot(state)),
            pack(persona),
            current_slot,
            slot_version,
            0,
            now,
            now,
        ),
    )


def update_session(conn, state, now, turns_since_save=None):
    """Write the per-turn blob; fact rows are written by write_fact_changes()."""
    touch = "activity=(SELECT COALESCE(MAX(activity), 0) + 1 FROM sessions)"
    if turns_since_save is None:
        conn.execute(
            "UPDATE sessions SET revision=?, turn=?, state=?, updated_at=?, %s WHERE session_id=?" % touch,
            (state.get("revision", 0), state["turn"], pack(hot(state)), now, state["session_id"]),
        )
    else:
        conn.execute(
            "UPDATE sessions SET revision=?, turn=?, state=?, updated_at=?, turns_since_save=?, %s WHERE session_id=?" % touch,
            (state.get("revision", 0), state["turn"], pack(hot(state)), now, turns_since_save, state["session_id"]),
        )


def refresh_persona(conn, state, persona, now):
    """Rewrite the stored persona snapshot after the player edited the file.

    Only the persona-derived columns move: revision/turn/activity stay put, so a
    read that happens to refresh the persona does not reorder the save list or
    invalidate anything the caller is holding.
    """
    conn.execute(
        "UPDATE sessions SET persona_id=?, persona_title=?, persona_revision=?, state=?, persona=?, updated_at=? WHERE session_id=?",
        (
            state["persona_id"],
            state["persona_title"],
            state["persona_revision"],
            pack(hot(state)),
            pack(persona),
            now,
            state["session_id"],
        ),
    )


def set_save_info(conn, session_id, slot, version, now):
    conn.execute(
        "UPDATE sessions SET current_slot=?, slot_version=?, turns_since_save=0, updated_at=? WHERE session_id=?",
        (slot, version, now, session_id),
    )


def session_exists(conn, session_id):
    return conn.execute("SELECT 1 FROM sessions WHERE session_id=?", (session_id,)).fetchone() is not None


def has_sessions(conn):
    return conn.execute("SELECT 1 FROM sessions LIMIT 1").fetchone() is not None


def session_summary(conn, session_id):
    row = conn.execute("SELECT persona_title, turn FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if row is None:
        raise _missing_session(session_id)
    return {"persona_title": row[0], "turn": row[1]}


def list_sessions(conn, limit=10):
    """Most recently played first, with each one's per-turn state."""
    rows = conn.execute(
        "SELECT session_id, persona_title, mode, turn, revision, current_slot, turns_since_save, origin, updated_at, state "
        "FROM sessions ORDER BY activity DESC LIMIT ?",
        (limit,),
    ).fetchall()
    keys = ("session_id", "persona_title", "mode", "turn", "revision", "current_slot", "turns_since_save", "origin", "updated_at")
    out = []
    for row in rows:
        item = dict(zip(keys, row[: len(keys)]))
        item["state"] = _check_state(unpack(row[len(keys)]), "session %s" % item["session_id"])
        out.append(item)
    return out


# -- turn log -------------------------------------------------------------------


def insert_turn_log(conn, session_id, turn, revision, kind, action_mode, player_input, payload, summary, open_action, now):
    conn.execute(
        "INSERT INTO turn_log(session_id, turn, revision, kind, action_mode, player_input, payload, summary, open_action, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (session_id, turn, revision, kind, action_mode, player_input, _dump(payload), summary, open_action, now),
    )


def recent_turn_log(conn, session_id, limit=5):
    rows = conn.execute(
        "SELECT turn, revision, kind, action_mode, payload, summary, open_action, undone, created_at FROM turn_log "
        "WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    keys = ("turn", "revision", "kind", "action_mode", "payload", "summary", "open_action", "undone", "created_at")
    out = []
    for row in rows:
        item = dict(zip(keys, row))
        item["payload"] = json.loads(item["payload"])
        out.append(item)
    return out


def mark_turn_undone(conn, session_id, turn):
    conn.execute("UPDATE turn_log SET undone=1 WHERE session_id=? AND turn=? AND kind='commit' AND undone=0", (session_id, turn))


def count_rows(conn, table, session_id):
    return conn.execute("SELECT COUNT(*) FROM %s WHERE session_id=?" % table, (session_id,)).fetchone()[0]


# -- undo points ------------------------------------------------------------------
# The state before turn N is stored under (session, N). Undo and rewrite read
# it; a load starts a new session, so its undo history starts empty.


def save_undo_point_from_session(conn, session_id, turn):
    """Store the session's current (pre-commit) state blob as the point for `turn`."""
    conn.execute(
        "INSERT OR REPLACE INTO undo_points(session_id, turn, state) SELECT session_id, ?, state FROM sessions WHERE session_id=?",
        (turn, session_id),
    )


def put_undo_point(conn, session_id, turn, state):
    conn.execute("INSERT OR REPLACE INTO undo_points(session_id, turn, state) VALUES(?,?,?)", (session_id, turn, pack(hot(state))))


def undo_point(conn, session_id, turn):
    row = conn.execute("SELECT state FROM undo_points WHERE session_id=? AND turn=?", (session_id, turn)).fetchone()
    return _check_state(unpack(row[0]), "undo point %s/%s" % (session_id, turn)) if row else None


def delete_undo_point(conn, session_id, turn):
    conn.execute("DELETE FROM undo_points WHERE session_id=? AND turn=?", (session_id, turn))


def trim_undo_points(conn, session_id, keep):
    conn.execute(
        "DELETE FROM undo_points WHERE session_id=? AND turn NOT IN "
        "(SELECT turn FROM undo_points WHERE session_id=? ORDER BY turn DESC LIMIT ?)",
        (session_id, session_id, keep),
    )
    # The fact journal of a turn is only needed while its undo point exists.
    # turn=0 is not a turn: it records what the settings page deleted by hand,
    # and revert_turn_facts needs it to know what must stay gone. Deleting it
    # here would let an older turn's undo bring a hand-deleted fact back.
    conn.execute(
        "DELETE FROM fact_journal WHERE session_id=? AND turn > 0 AND turn < "
        "(SELECT COALESCE(MIN(turn), 1000000000) FROM undo_points WHERE session_id=?)",
        (session_id, session_id),
    )


# -- commit failures ----------------------------------------------------------------
# A failed commit leaves a marker; the next successful commit returns the full
# context.


def mark_commit_failure(conn, session_id, now):
    row = conn.execute("SELECT revision FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if row is not None:
        conn.execute("INSERT OR REPLACE INTO commit_failures(session_id, revision, failed_at) VALUES(?,?,?)", (session_id, row[0], now))


def commit_failure(conn, session_id):
    row = conn.execute("SELECT revision FROM commit_failures WHERE session_id=?", (session_id,)).fetchone()
    return row[0] if row else None


def take_commit_failure(conn, session_id):
    row = conn.execute("SELECT revision FROM commit_failures WHERE session_id=?", (session_id,)).fetchone()
    if row is None:
        return None
    conn.execute("DELETE FROM commit_failures WHERE session_id=?", (session_id,))
    return row[0]


# -- mood debug -----------------------------------------------------------------------
# A thought the player deleted by hand. The journal keeps what it was, so
# "why did his mood jump" stays answerable; undo does not bring it back.


def log_thought_delete(conn, session_id, turn, npc_id, thought_id, label, delta, reason, now):
    conn.execute(
        "INSERT INTO thought_debug(session_id, turn, npc_id, thought_id, label, delta, reason, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (session_id, turn, npc_id, thought_id, label, delta, reason, now),
    )
    _keep_newest(conn, "thought_debug", session_id)


def _keep_newest(conn, table, session_id):
    """Drop everything but the newest DELETIONS_KEEP rows of this session."""
    conn.execute(
        "DELETE FROM %s WHERE session_id=? AND rowid < "
        "(SELECT rowid FROM %s WHERE session_id=? ORDER BY rowid DESC LIMIT 1 OFFSET ?)" % (table, table),
        (session_id, session_id, DELETIONS_KEEP - 1),
    )


def thought_deletions(conn, session_id, limit=DELETIONS_KEEP):
    rows = conn.execute(
        "SELECT turn, npc_id, thought_id, label, delta, reason, created_at FROM thought_debug "
        "WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    keys = ("turn", "npc_id", "thought_id", "label", "delta", "reason", "created_at")
    return [dict(zip(keys, row)) for row in rows]


def log_memory_delete(conn, session_id, turn, memory_id, layer, content, reason, now):
    conn.execute(
        "INSERT INTO memory_debug(session_id, turn, memory_id, layer, content, reason, created_at) VALUES(?,?,?,?,?,?,?)",
        (session_id, turn, memory_id, layer, content, reason, now),
    )
    _keep_newest(conn, "memory_debug", session_id)


def memory_deletions(conn, session_id, limit=DELETIONS_KEEP):
    rows = conn.execute(
        "SELECT turn, memory_id, layer, content, reason, created_at FROM memory_debug "
        "WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    keys = ("turn", "memory_id", "layer", "content", "reason", "created_at")
    return [dict(zip(keys, row)) for row in rows]


def clear_thought_deletions(conn, session_id):
    conn.execute("DELETE FROM thought_debug WHERE session_id=?", (session_id,))


# -- idempotency ----------------------------------------------------------------


def idem_get(conn, scope, request_id):
    row = conn.execute("SELECT digest, response FROM idempotency WHERE scope=? AND request_id=?", (scope, request_id)).fetchone()
    if row is None:
        return None
    return {"digest": row[0], "response": unpack(row[1])}


def idem_put(conn, scope, request_id, digest, response, now):
    conn.execute(
        "INSERT INTO idempotency(scope, request_id, digest, response, created_at) VALUES(?,?,?,?,?)",
        (scope, request_id, digest, pack(response), now),
    )
    # Keep the newest IDEMPOTENCY_KEEP rows of the scope.
    conn.execute(
        "DELETE FROM idempotency WHERE scope=? AND rowid < "
        "(SELECT rowid FROM idempotency WHERE scope=? ORDER BY rowid DESC LIMIT 1 OFFSET ?)",
        (scope, scope, IDEMPOTENCY_KEEP - 1),
    )


def idem_count(conn, scope):
    return conn.execute("SELECT COUNT(*) FROM idempotency WHERE scope=?", (scope,)).fetchone()[0]


# -- slots ------------------------------------------------------------------------

SLOT_COLUMNS = (
    "name",
    "session_id",
    "revision",
    "turn",
    "persona_id",
    "persona_title",
    "clock_label",
    "mood_label",
    "open_action",
    "version",
    "saved_at",
)


# A slot is a complete copy of a session at one revision, kept like a session:
# the per-turn blob and persona in `slots`, facts in `slot_facts`, archive in
# `slot_archive`. Saving and loading copy rows inside SQLite.


def get_slot(conn, name, with_blobs=False):
    columns = ", ".join(SLOT_COLUMNS) + (", state, persona" if with_blobs else "")
    row = conn.execute("SELECT %s FROM slots WHERE name=?" % columns, (name,)).fetchone()
    if row is None:
        return None
    info = dict(zip(SLOT_COLUMNS, row[: len(SLOT_COLUMNS)]))
    if with_blobs:
        info["state"] = _check_state(unpack(row[len(SLOT_COLUMNS)]), "slot %s" % name)
        info["persona"] = unpack(row[len(SLOT_COLUMNS) + 1])
    return info


def put_slot(conn, name, session_id, clock_label, mood_label, open_action, version, now):
    """Copy the session as it is stored now into the slot `name`."""
    _drop_slot_rows(conn, name)
    conn.execute(
        "INSERT INTO slots(name, session_id, revision, turn, persona_id, persona_title, clock_label, mood_label, open_action, version, state, persona, saved_at) "
        "SELECT ?, session_id, revision, turn, persona_id, persona_title, ?, ?, ?, ?, state, persona, ? FROM sessions WHERE session_id=?",
        (name, clock_label, mood_label, open_action, version, now, session_id),
    )
    conn.execute(
        "INSERT INTO slot_facts(slot, {0}) SELECT ?, {0} FROM facts WHERE session_id=?".format(FACT_COLUMNS),
        (name, session_id),
    )
    conn.execute(
        "INSERT INTO slot_archive(slot, seq, kind, turn, payload) SELECT ?, id, kind, turn, payload FROM archive WHERE session_id=?",
        (name, session_id),
    )


def copy_slot_rows(conn, name, session_id, now):
    """A load: the slot's facts and archive become the new session's."""
    conn.execute(
        "INSERT INTO facts(session_id, {0}) SELECT ?, {0} FROM slot_facts WHERE slot=?".format(FACT_COLUMNS),
        (session_id, name),
    )
    conn.execute(
        "INSERT INTO archive(session_id, kind, turn, payload, created_at) SELECT ?, kind, turn, payload, ? FROM slot_archive WHERE slot=? ORDER BY seq",
        (session_id, now, name),
    )


def slot_facts(conn, name):
    return {fid: json.loads(data) for fid, data in conn.execute("SELECT id, data FROM slot_facts WHERE slot=? ORDER BY n", (name,))}


def slot_archive(conn, name):
    rows = conn.execute("SELECT kind, turn, payload FROM slot_archive WHERE slot=? ORDER BY seq", (name,)).fetchall()
    return [{"kind": r[0], "turn": r[1], "payload": json.loads(r[2])} for r in rows]


def list_slots(conn):
    rows = conn.execute("SELECT %s FROM slots ORDER BY saved_at DESC, name" % ", ".join(SLOT_COLUMNS)).fetchall()
    return [dict(zip(SLOT_COLUMNS, row)) for row in rows]


def _drop_slot_rows(conn, name):
    conn.execute("DELETE FROM slots WHERE name=?", (name,))
    conn.execute("DELETE FROM slot_facts WHERE slot=?", (name,))
    conn.execute("DELETE FROM slot_archive WHERE slot=?", (name,))


def delete_slot(conn, name):
    """An explicit deletion: sessions whose current slot it was no longer have one."""
    _drop_slot_rows(conn, name)
    conn.execute("UPDATE sessions SET current_slot=NULL, slot_version=NULL WHERE current_slot=?", (name,))


# -- archive -----------------------------------------------------------------------


def archive_items(conn, session_id):
    rows = conn.execute("SELECT kind, turn, payload FROM archive WHERE session_id=? ORDER BY id", (session_id,)).fetchall()
    return [{"kind": r[0], "turn": r[1], "payload": json.loads(r[2])} for r in rows]


def add_archive(conn, session_id, kind, turn, payload, now):
    conn.execute(
        "INSERT INTO archive(session_id, kind, turn, payload, created_at) VALUES(?,?,?,?,?)",
        (session_id, kind, turn, _dump(payload), now),
    )


def delete_archive_turn(conn, session_id, turn):
    conn.execute("DELETE FROM archive WHERE session_id=? AND turn=?", (session_id, turn))


def restore_archive(conn, session_id, items, now):
    for item in items:
        add_archive(conn, session_id, item["kind"], item["turn"], item["payload"], now)


def count_archive(conn, session_id):
    return conn.execute("SELECT COUNT(*) FROM archive WHERE session_id=?", (session_id,)).fetchone()[0]


# ---------------------------------------------------------------------------
# 常识库（全局：不挂会话，也不进撤销账）


COMMON_COLUMNS = "n, id, key, weight, content, turn, at, origin, pending"


def _common_row(entry):
    return (
        int(entry["id"][1:]),
        entry["id"],
        _dump(entry["key"]),
        float(entry["weight"]),
        entry["content"],
        entry.get("turn"),
        entry.get("at"),
        entry.get("origin") or "manual",
        1 if entry.get("pending") else 0,
    )


def load_common(conn):
    """全部常识，按 id 排。"""
    rows = conn.execute("SELECT %s FROM common ORDER BY n" % COMMON_COLUMNS).fetchall()
    return [
        {"id": r[1], "key": json.loads(r[2]), "weight": r[3], "content": r[4], "turn": r[5], "at": r[6], "origin": r[7],
         "pending": bool(r[8])}
        for r in rows
    ]


def write_common(conn, rows):
    """整表重写：常识库很小（几十条），不值得为增量维护一份 diff。"""
    conn.execute("DELETE FROM common")
    conn.executemany("INSERT OR REPLACE INTO common(%s) VALUES(?,?,?,?,?,?,?,?,?)" % COMMON_COLUMNS, [_common_row(e) for e in rows])


def common_limit(conn):
    row = conn.execute("SELECT value FROM meta WHERE key='common_limit'").fetchone()
    return None if row is None else row[0]


def set_common_limit(conn, limit):
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('common_limit', ?)", (str(limit),))
