"""The single write path and the game commands.

Every state change goes through session_write() or create_write():
  1. shape validation (unknown fields, duplicates, types, ranges)
  2. BEGIN IMMEDIATE (STORAGE_BUSY when the lock cannot be taken)
  3. idempotency lookup: same request_id + same input -> stored response
  4. revision check (session writes)
  5. domain on a working copy; any error -> rollback, nothing written
  6. write state, turn log and idempotency record in the same transaction
The response (including the next context) is built before COMMIT so that the
idempotency record stores exactly what the caller received.

What changed from the adult-tension runtime: there is no world pack and no
content store. A persona arrives with the call, is validated by
`persona.validate`, and its snapshot is stored with the session.
"""

import hashlib
import os
import re
from datetime import datetime

from .. import paths
from .. import persona as PE
from .. import schema as S
from ..errors import (
    CONTENT_ERROR,
    IDEMPOTENCY_CONFLICT,
    INVALID_INPUT,
    INVARIANT_VIOLATION,
    NOT_FOUND,
    SAFETY_BLOCK,
    SLOT_CONFLICT,
    STALE_REVISION,
    STORAGE_BUSY,
    AppError,
    detail,
    top_code,
)
from ..jsonio import canonical
from ..domain import structure as ST
from ..persistence import db, repo
from ..projections import context as CX
from . import specs

CREATE_SCOPE = "create"
RESERVED_SLOT_NAMES = {"con", "prn", "aux", "nul"} | {"com%d" % i for i in range(1, 10)} | {"lpt%d" % i for i in range(1, 10)}


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_request_id():
    return "r_" + os.urandom(6).hex()


def new_session_id(conn):
    while True:
        sid = "s_" + os.urandom(4).hex()
        if not repo.session_exists(conn, sid):
            return sid


def validate(spec, payload):
    normalized, errors = S.validate(spec, payload)
    if errors:
        raise AppError(INVALID_INPUT, "输入有 %d 处问题" % len(errors) if len(errors) > 1 else errors[0]["reason"], errors)
    return normalized


def digest_of(command, payload):
    return hashlib.sha256(canonical([command, payload]).encode("utf-8")).hexdigest()


def _replay(conn, scope, request_id, digest):
    cached = repo.idem_get(conn, scope, request_id)
    if cached is None:
        return None
    if cached["digest"] != digest:
        raise AppError(
            IDEMPOTENCY_CONFLICT,
            "request_id %s 已经用于另一个请求" % request_id,
            [detail("$.request_id", "同一个 request_id 带了不同的内容", "先 get-context 确认上一次是否已经生效，再决定是否用新的 request_id 补交；不能把同一回合写两次", IDEMPOTENCY_CONFLICT)],
        )
    response = cached["response"]
    response["replayed"] = True
    return response


def save_info(session):
    return {"current_slot": session["current_slot"], "turns_since_save": session["turns_since_save"]}


def session_write(ctx, command, payload, handler):
    """Run a session-scoped write. handler(conn, session, now) -> response dict."""
    conn = ctx.db()
    digest = digest_of(command, payload)
    db.begin_write(conn)
    try:
        replay = _replay(conn, payload["session_id"], payload["request_id"], digest)
        if replay is not None:
            conn.execute("COMMIT")
            return replay
        session = repo.load_session(conn, payload["session_id"])
        if session["revision"] != payload["expected_revision"]:
            raise AppError(
                STALE_REVISION,
                "局面已经变了：当前 revision 是 %d，不是 %d" % (session["revision"], payload["expected_revision"]),
                [detail("$.expected_revision", "revision 已过期", "基于附带的新上下文重新判断后再提交；不要只换 revision 重放旧操作", STALE_REVISION)],
                current_revision=session["revision"],
                context=CX.brief(session["state"], session["persona"], save_info(session)),
            )
        now = now_iso()
        response = handler(conn, session, now)
        response.setdefault("next_request_id", new_request_id())
        response["replayed"] = False
        repo.idem_put(conn, payload["session_id"], payload["request_id"], digest, response, now)
        conn.execute("COMMIT")
        return response
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def create_write(ctx, command, payload, handler):
    """Run a write that creates a session. handler(conn, now) -> response dict."""
    conn = ctx.db()
    digest = digest_of(command, payload)
    db.begin_write(conn)
    try:
        replay = _replay(conn, CREATE_SCOPE, payload["request_id"], digest)
        if replay is not None:
            conn.execute("COMMIT")
            return replay
        now = now_iso()
        response = handler(conn, now)
        response.setdefault("next_request_id", new_request_id())
        response["replayed"] = False
        repo.idem_put(conn, CREATE_SCOPE, payload["request_id"], digest, response, now)
        conn.execute("COMMIT")
        return response
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


# ---------------------------------------------------------------------------
# persona


def _persona_or_raise(ctx, raw):
    """Assemble + validate a persona from what node handed over."""
    payload = validate(specs.PERSONA_PAYLOAD, raw)
    assembled = PE.from_markdown(payload["front"], payload["prose"], payload["title"], payload["persona_id"])
    persona, errors = PE.validate(assembled)
    if errors:
        code = top_code(errors, CONTENT_ERROR)
        raise AppError(code, "人设有 %d 处问题，没能开局" % len(errors) if len(errors) > 1 else errors[0]["reason"], errors)
    return persona


def check_persona(ctx, payload):
    payload = validate(specs.CHECK_PERSONA, payload)
    legacy = PE.is_legacy(payload["persona"]["front"])
    persona, errors = PE.validate(PE.from_markdown(payload["persona"]["front"], payload["persona"]["prose"], payload["persona"]["title"], payload["persona"]["persona_id"]))
    if errors:
        return {
            "ok": False,
            "count": len(errors),
            "problems": errors,
            "text": PE.problems_text(errors),
            "legacy": legacy,
        }
    return {
        "ok": True,
        "count": 0,
        # 旧格式（places + cast）已按第一个主要角色读取；设置页提示保存一次换成新格式
        "legacy": legacy,
        "persona": _persona_summary(persona),
    }


def _persona_summary(persona):
    return {
        "id": persona["id"],
        "title": persona["title"],
        "revision": persona["revision"],
        "name": persona["name"],
        "role": persona["role"],
        "age": persona["age"],
        "gender": persona["gender"],
        "start_stage": persona["start_stage"],
        "routine": [dict(slot) for slot in persona["routine"]],
        "mood_base": persona["mood_base"],
        "mood_thresholds": persona["mood_thresholds"],
    }


def preview_persona(ctx, payload):
    payload = validate(specs.PREVIEW_PERSONA, payload)
    persona = _persona_or_raise(ctx, payload["persona"])
    from .. import opening

    return opening.preview(persona, payload["seed"])


# ---------------------------------------------------------------------------
# new-game


def new_game(ctx, payload):
    from .. import opening

    payload = validate(specs.NEW_GAME, payload)
    persona = _persona_or_raise(ctx, payload["persona"])

    def handler(conn, now):
        state, warnings = opening.new_session(persona, seed=payload["seed"], now=now)
        prefs = payload["preferences"]
        for key in ("offscreen_simulation", "person", "pace", "explicitness"):
            if key in prefs:
                state["preferences"][key] = prefs[key]
        state["session_id"] = new_session_id(conn)
        repo.insert_session(conn, state, persona, "new_game", now)
        repo.insert_turn_log(conn, state["session_id"], state["turn"], state["revision"], "opening", None, None,
                             {"persona_id": persona["id"], "revision": persona["revision"], "seed": state["seed"]},
                             None, None, now)
        return {
            "session_id": state["session_id"],
            "revision": state["revision"],
            "turn": state["turn"],
            "seed": state["seed"],
            "persona": {
                "id": persona["id"],
                "title": persona["title"],
                "revision": persona["revision"],
                "name": persona["name"],
            },
            "warnings": warnings,
            "context": CX.full(state, persona, {"current_slot": None, "turns_since_save": 0}),
            "commit_template": CX.commit_template(state, persona),
        }

    return create_write(ctx, "new-game", payload, handler)


def _refresh_persona(conn, state, persona, raw, now):
    """Swap the on-disk persona's static facts into a running session.

    Returns (persona, report). A persona that does not validate keeps the
    session exactly as it is and reports why, instead of taking the story down
    with it: the settings page may be half-written while the player is playing.
    """
    payload = validate(specs.PERSONA_PAYLOAD, raw)
    assembled = PE.from_markdown(payload["front"], payload["prose"], payload["title"], payload["persona_id"])
    fresh, errors = PE.validate(assembled)
    if errors:
        return persona, {
            "ok": False,
            "changed": False,
            "count": len(errors),
            "text": PE.problems_text(errors),
            "problems": errors,
        }
    if fresh["revision"] == state.get("persona_revision"):
        # Same file, nothing to do: touching the row here would only churn it.
        return persona, {"ok": True, "changed": False, "revision": fresh["revision"]}
    report = PE.apply_static(state, fresh)
    repo.refresh_persona(conn, state, fresh, now)
    return fresh, {"ok": True, "changed": True, **report}


# ---------------------------------------------------------------------------
# get-context


def get_context(ctx, payload):
    payload = validate(specs.GET_CONTEXT, payload)
    conn = ctx.db()
    # `persona` is the file the user is editing right now. Sending it here is
    # what makes an edit visible without restarting the story: the persona is
    # static facts, the story is not, and only the former gets replaced.
    session = repo.load_session(conn, payload["session_id"])
    state, persona = session["state"], session["persona"]
    persona_report = None
    if payload["persona"] is not None:
        db.begin_write(conn)
        try:
            persona, persona_report = _refresh_persona(conn, state, persona, payload["persona"], now_iso())
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    context = CX.full(state, persona, save_info(session)) if payload["depth"] == "full" else CX.brief(state, persona, save_info(session))
    out = {"revision": state.get("revision", 0), "turn": state["turn"], "context": context}
    if payload["want_twist"]:
        out["twists"] = list(persona.get("twists") or [])
        if not out["twists"]:
            out["twists_note"] = "这份人设没有预设转折；转折要由你自己想，不能替玩家决定结局"
    if persona_report is not None:
        out["persona"] = persona_report
    out["commit_template"] = CX.commit_template(state, persona)
    return out


# ---------------------------------------------------------------------------
# commit-turn


DOMAIN_KEYS = (
    "action_mode",
    "player_input",
    "player_authorized",
    "acts_on_her",
    "operations",
    "content_tags",
    "summary",
    "remember",
    "open_action",
    "quotes",
    "chapter_summary",
    "prologue",
    "replaces_turn",
    "together",
)
# A failed commit with one of these codes makes the next context full.
FAILURE_CODES = (INVALID_INPUT, INVARIANT_VIOLATION, NOT_FOUND, SAFETY_BLOCK)
SESSION_ID_RE = re.compile(r"s_[a-z0-9]{2,38}")


def choose_depth(state, results, failed_before=False):
    """Full after a failed commit, after a record of several turns, on a new
    stretch of time together or a new day, every 5 turns, and when a prologue
    is due; brief otherwise. A brief context is ~6 KB, a full one ~20 KB."""
    if failed_before or len(results) > 1:
        return "full"
    result = results[0]
    if result["scene_changed"] or result["crossed_day"]:
        return "full"
    if state["requests"].get("prologue") or state["turn"] % 5 == 0:
        return "full"
    return "brief"


def _mark_failure(ctx, session_id):
    """Best effort: a busy database skips the marker, never the caller's error."""
    conn = ctx.db()
    try:
        db.begin_write(conn)
    except AppError as err:
        if err.code == STORAGE_BUSY:
            return
        raise
    try:
        repo.mark_commit_failure(conn, session_id, now_iso())
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def commit_turn(ctx, payload):
    try:
        return _commit_turn(ctx, payload)
    except AppError as err:
        sid = payload.get("session_id") if isinstance(payload, dict) else None
        if err.code in FAILURE_CODES and isinstance(sid, str) and SESSION_ID_RE.fullmatch(sid):
            _mark_failure(ctx, sid)
        raise


def _commit_turn(ctx, payload):
    from ..domain import turn

    payload = validate(specs.COMMIT_TURN, payload)
    commits = [{key: item[key] for key in DOMAIN_KEYS} for item in payload["turns"]]
    late = ["$.turns[%d].replaces_turn" % i for i, c in enumerate(commits) if i and c["replaces_turn"] is not None]
    if late:
        problems = [detail(path, "只有第一项可以改写上一回合", "去掉它；还没记录的回合直接改写正文", INVALID_INPUT) for path in late]
        raise AppError(INVALID_INPUT, problems[0]["reason"], problems)

    def handler(conn, session, now):
        sid = session["session_id"]
        state = session["state"]
        persona = session["persona"]
        if payload.get("persona") is not None:
            persona, _ = _refresh_persona(conn, state, persona, payload["persona"], now)
        failed_before = repo.take_commit_failure(conn, sid) is not None
        unsaved = session["turns_since_save"]
        results = []
        for index, commit in enumerate(commits):
            unsaved += 1
            # Undoing a later turn of a record goes back to where a record of
            # the turns before it would have left the game, requests included.
            undo_base = _record_end(state, results) if results else None
            try:
                state, result = _apply_turn(conn, session, state, persona, commit, unsaved, now, undo_base)
            except AppError as err:
                _at_turn(err, index)
                raise
            results.append(result)
        _engine_outcomes_last(results)
        turn.close_record(state, results)
        repo.update_session(conn, state, now, turns_since_save=unsaved)
        depth = choose_depth(state, results, failed_before)
        project = CX.full if depth == "full" else CX.brief
        return {
            "revision": state["revision"],
            "turn": state["turn"],
            "turns": [_turn_result(result) for result in results],
            "clock": results[-1]["clock"],
            "context": project(state, persona, {"current_slot": session["current_slot"], "turns_since_save": unsaved}),
        }

    return session_write(ctx, "commit-turn", payload, handler)


def _record_end(state, results):
    from ..domain import turn

    from ..jsonio import copy

    base = dict(state, requests=copy(state["requests"]), counters=copy(state["counters"]))
    turn.close_record(base, results)
    return base


def _apply_turn(conn, session, state, persona, commit, unsaved, now, undo_base=None):
    """One turn of a record inside the commit transaction: domain commit, undo
    point, facts, session row, archive and turn log."""
    from ..domain import turn

    sid = session["session_id"]
    snapshot = None
    replacing = commit["replaces_turn"]
    if replacing is not None:
        snapshot = repo.undo_point(conn, sid, replacing)
        if replacing == state["turn"] and snapshot is not None:
            # Undoing the replaced turn in this same transaction: its facts
            # first, so the domain sees the facts from before it.
            repo.revert_turn_facts(conn, sid, replacing)
            state["facts"] = repo.FactSource(conn, sid)
    new_state, result = turn.commit_turn(state, persona, commit, snapshot, now)
    replaced = result["replaced_turn"]
    if replaced is not None:
        repo.mark_turn_undone(conn, sid, replaced)
        repo.delete_archive_turn(conn, sid, replaced)
        repo.put_undo_point(conn, sid, new_state["turn"], result["undo_base"])
    elif undo_base is not None:
        repo.put_undo_point(conn, sid, new_state["turn"], undo_base)
    else:
        repo.save_undo_point_from_session(conn, sid, new_state["turn"])
    repo.write_fact_changes(conn, sid, new_state["turn"], new_state["facts"])
    repo.trim_undo_points(conn, sid, turn.UNDO_KEEP)
    repo.update_session(conn, new_state, now, turns_since_save=unsaved)
    for item in result["archive"]:
        repo.add_archive(conn, sid, item["kind"], new_state["turn"], item["payload"], now)
    repo.insert_turn_log(
        conn,
        new_state["session_id"],
        new_state["turn"],
        new_state["revision"],
        "commit",
        commit["action_mode"],
        commit["player_input"],
        {"operations": commit["operations"], "applied": result["applied"],
         "resolved_events": result["resolved_events"], "content_tags": commit["content_tags"]},
        commit["summary"],
        commit["open_action"],
        now,
    )
    # The next turn of the record reads the facts as just written.
    new_state["facts"] = repo.FactSource(conn, sid)
    return new_state, result


def _turn_result(result):
    out = {
        "turn": result["turn"],
        "applied": result["applied"],
        "resolved_events": result["resolved_events"],
        "simulation": result["simulation"],
        "time_settled": result["time_settled"],
        "mood": result.get("mood") or {},
    }
    for key in ("chapter", "replaced_turn", "thoughts", "remembered"):
        if result.get(key) is not None:
            out[key] = result[key]
    return out


def _engine_outcomes_last(results):
    """A turn whose outcome the engine decides (an event coming due) is
    recorded before its prose is written, so it can only be the last turn of a
    record."""
    problems = []
    for index, result in enumerate(results[: len(results) - 1]):
        if result["resolved_events"]:
            problems.append(detail(
                "$.turns[%d]" % index,
                "第 %d 项有要由引擎决定结果的事（到期事件），它只能是记录的最后一项" % (index + 1),
                "这次只记录到第 %d 项，按返回的结果写它；后面的回合下一次再记" % (index + 1),
                INVALID_INPUT,
            ))
    if problems:
        raise AppError(INVALID_INPUT, problems[0]["reason"] if len(problems) == 1 else "记录有 %d 处问题" % len(problems), problems)


def _at_turn(err, index):
    """Point a rejected record's problems at the turn that caused them."""
    for item in err.details:
        if isinstance(item, dict) and str(item.get("path", "")).startswith("$"):
            item["path"] = "$.turns[%d]%s" % (index, item["path"][1:])
    err.message = "第 %d 项：%s" % (index + 1, err.message)


# ---------------------------------------------------------------------------
# undo-turn


def undo_turn(ctx, payload):
    from ..domain import turn

    payload = validate(specs.UNDO_TURN, payload)

    def handler(conn, session, now):
        sid = session["session_id"]
        persona = session["persona"]
        undone = session["state"]["turn"]
        snapshot = repo.undo_point(conn, sid, undone)
        new_state, result = turn.undo(session["state"], snapshot)
        repo.revert_turn_facts(conn, sid, undone)
        new_state["facts"] = repo.FactSource(conn, sid)
        repo.delete_undo_point(conn, sid, undone)
        repo.mark_turn_undone(conn, sid, undone)
        repo.delete_archive_turn(conn, sid, undone)
        unsaved = session["turns_since_save"] + 1
        repo.update_session(conn, new_state, now, turns_since_save=unsaved)
        repo.insert_turn_log(conn, sid, new_state["turn"], new_state["revision"], "undo", None, None,
                             {"undone_turn": undone}, None, None, now)
        return {
            "revision": new_state["revision"],
            "turn": new_state["turn"],
            "undone_turn": result["undone_turn"],
            "receipt": "已撤销第 %d 回合" % result["undone_turn"],
            "context": CX.brief(new_state, persona, {"current_slot": session["current_slot"], "turns_since_save": unsaved}),
            "commit_template": CX.commit_template(new_state, persona),
        }

    return session_write(ctx, "undo-turn", payload, handler)


# ---------------------------------------------------------------------------
# save / load / list


def normalize_slot_name(raw, path="$.name", label="存档名"):
    name = re.sub(r"\s+", "-", raw.strip())
    problems = []
    if not name:
        problems.append(label + "不能为空")
    if len(name) > 40:
        problems.append(label + "最长 40 个字符")
    if re.search(r'[\\/:*?"<>|]', name):
        problems.append(label + "不能含路径分隔符或以下字符：/ : * ? \" < > |")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        problems.append(label + "不能含控制字符")
    if name.strip(".") == "" or name.endswith("."):
        problems.append(label + "不能只由点组成或以点结尾")
    if name.split(".")[0].lower() in RESERVED_SLOT_NAMES:
        problems.append(label + "是系统保留名：%s" % name)
    if problems:
        raise AppError(INVALID_INPUT, problems[0], [detail(path, p, "换一个名字（可以用中文）", INVALID_INPUT) for p in problems])
    return name


def _mood_label(state):
    from ..domain import mood as MO
    from ..domain import state as SS

    parts = []
    for cid in SS.npcs(state):
        info = MO.evaluate(state, cid)
        parts.append("%s %d" % (state["characters"][cid]["name"], info[0]))
    return "、".join(parts)


def save_slot(ctx, payload):
    from ..domain import clock as CL
    from ..domain import state as SS

    payload = validate(specs.SAVE_SLOT, payload)

    def handler(conn, session, now):
        state, persona = session["state"], session["persona"]
        auto = False
        if payload["name"]:
            name = normalize_slot_name(payload["name"])
        elif session["current_slot"]:
            name = session["current_slot"]
        else:
            name = normalize_slot_name("%s-第%d回合" % (state["persona_title"], state["turn"]))
            auto = True
        existing = repo.get_slot(conn, name)
        if existing is not None and not payload["overwrite"]:
            if name != session["current_slot"]:
                raise AppError(
                    SLOT_CONFLICT,
                    "「%s」已存在" % name,
                    [detail("$.name", "存档名已被占用", "问用户是否覆盖；确认后带 overwrite: true 重交", SLOT_CONFLICT)],
                    reason="exists",
                    slot={k: existing[k] for k in ("name", "persona_title", "turn", "clock_label", "saved_at")},
                )
            if existing["version"] != session["slot_version"]:
                raise AppError(
                    SLOT_CONFLICT,
                    "「%s」已在别的对话里被改动过" % name,
                    [detail("$.name", "本局的当前槽已被别处更新", "给用户三个选项：A 读取最新 / B 另存为新名 / C 取消", SLOT_CONFLICT)],
                    reason="changed_elsewhere",
                    options=["A 读取最新", "B 另存为新名", "C 取消"],
                    slot={k: existing[k] for k in ("name", "persona_title", "turn", "clock_label", "saved_at")},
                )
        version = (existing["version"] + 1) if existing else 1
        state["facts"] = session["state"]["facts"]
        label = CL.label(state["clock"])
        mood = _mood_label(state) if SS.npcs(state) else ""
        repo.put_slot(conn, name, state["session_id"], label, mood, state["memory"].get("open_action") or "", version, now)
        repo.set_save_info(conn, state["session_id"], name, version, now)
        verb = "已另存为" if payload["save_as"] else "已保存到"
        return {
            "revision": state["revision"],
            "turn": state["turn"],
            "slot": {"name": name, "version": version, "turn": state["turn"], "persona_title": state["persona_title"],
                     "clock_label": label, "saved_at": now},
            "auto_named": auto,
            "receipt": "%s「%s」·第 %d 回合" % (verb, name, state["turn"]),
        }

    return session_write(ctx, "save-slot", payload, handler)


def _resume(state):
    turns = state["memory"]["turns"]
    chapters = state["memory"]["chapters"]
    return {
        "chapter_summary": chapters[-1]["summary"] if chapters else None,
        "prologue": state["memory"].get("prologue"),
        "recent": [t["summary"] for t in turns[-3:]],
        "last_quotes": list(state["memory"].get("last_quotes") or []),
        "open_action": state["memory"].get("open_action") or "",
    }


def load_slot(ctx, payload):
    payload = validate(specs.LOAD_SLOT, payload)
    name = normalize_slot_name(payload["name"])

    def handler(conn, now):
        slot = repo.get_slot(conn, name, with_blobs=True)
        if slot is None:
            names = [s["name"] for s in repo.list_slots(conn)]
            raise AppError(
                NOT_FOUND,
                "没有名为「%s」的存档" % name,
                [detail("$.name", "存档不存在", "现有存档：%s" % ("、".join(names[:20]) or "（无）"), NOT_FOUND)],
                available=names[:20],
            )
        state = slot["state"]
        persona = slot["persona"]
        state["session_id"] = new_session_id(conn)
        state["undo_floor"] = state["turn"]
        repo.insert_session(conn, state, persona, "load_slot", now, current_slot=name, slot_version=slot["version"], with_facts=False)
        repo.copy_slot_rows(conn, name, state["session_id"], now)
        state["facts"] = repo.FactSource(conn, state["session_id"])
        repo.insert_turn_log(conn, state["session_id"], state["turn"], state["revision"], "load", None, None,
                             {"slot": name, "version": slot["version"]}, None, None, now)
        return {
            "session_id": state["session_id"],
            "revision": state["revision"],
            "turn": state["turn"],
            "slot": {"name": name, "version": slot["version"], "saved_at": slot["saved_at"]},
            "receipt": "已读取「%s」·第 %d 回合" % (name, state["turn"]),
            "resume": _resume(state),
            "context": CX.full(state, persona, {"current_slot": name, "turns_since_save": 0}),
            "commit_template": CX.commit_template(state, persona),
        }

    return create_write(ctx, "load-slot", payload, handler)


def list_slots(ctx, payload):
    slots = repo.list_slots(ctx.db())
    return {
        "slots": [
            {
                "name": s["name"],
                "persona_title": s["persona_title"],
                "turn": s["turn"],
                "clock_label": s["clock_label"],
                "mood_label": s["mood_label"],
                "saved_at": s["saved_at"],
                "open_action": s["open_action"],
            }
            for s in slots
        ]
    }


def delete_slot(ctx, payload):
    payload = validate(specs.DELETE_SLOT, payload)
    name = normalize_slot_name(payload["name"])
    if not payload["confirm"]:
        raise AppError(
            INVALID_INPUT,
            "删除存档需要用户确认",
            [detail("$.confirm", "用户还没有确认", "先问“确定删除「%s」吗？”，确认后带 confirm: true 重交" % name, INVALID_INPUT)],
        )

    def handler(conn, session, now):
        if repo.get_slot(conn, name) is None:
            names = [s["name"] for s in repo.list_slots(conn)]
            raise AppError(
                NOT_FOUND,
                "没有名为「%s」的存档" % name,
                [detail("$.name", "存档不存在", "现有存档：%s" % ("、".join(names[:20]) or "（无）"), NOT_FOUND)],
                available=names[:20],
            )
        repo.delete_slot(conn, name)
        return {"revision": session["revision"], "turn": session["turn"], "deleted": name, "receipt": "已删除「%s」" % name}

    return session_write(ctx, "delete-slot", payload, handler)


# ---------------------------------------------------------------------------
# sessions, export, import


def list_sessions(ctx, payload):
    from ..domain import clock as CL

    payload = validate(specs.LIST_SESSIONS, payload)
    out = []
    for row in repo.list_sessions(ctx.db(), payload["limit"]):
        state = row["state"]
        memory = state["memory"]
        last = memory["turns"][-1]["summary"] if memory["turns"] else (memory["chapters"][-1]["summary"] if memory["chapters"] else None)
        out.append(
            {
                "session_id": row["session_id"],
                "persona_title": row["persona_title"],
                "turn": row["turn"],
                "clock_label": CL.label(state["clock"]),
                "last_summary": last,
                "open_action": memory.get("open_action") or "",
                "paused": state["safety"]["paused"],
                "current_slot": row["current_slot"],
                "turns_since_save": row["turns_since_save"],
                "origin": row["origin"],
                "updated_at": row["updated_at"],
            }
        )
    return {"sessions": out}


def export_save(ctx, payload):
    from ..domain import facts as FA
    from . import transfer

    payload = validate(specs.EXPORT_SAVE, payload)
    if (payload["session_id"] is None) == (payload["slot"] is None):
        raise AppError(INVALID_INPUT, "session_id 与 slot 必须且只能给一个",
                       [detail("$", "说明要导出哪个会话或哪个存档", None, INVALID_INPUT)])
    conn = ctx.db()
    if payload["session_id"] is not None:
        session = repo.load_session(conn, payload["session_id"])
        state = FA.full_state(session["state"])
        persona = session["persona"]
        archive = repo.archive_items(conn, session["session_id"])
        source = {"kind": "session", "session_id": session["session_id"], "current_slot": session["current_slot"]}
    else:
        name = normalize_slot_name(payload["slot"], "$.slot")
        slot = repo.get_slot(conn, name, with_blobs=True)
        if slot is None:
            names = [s["name"] for s in repo.list_slots(conn)]
            raise AppError(NOT_FOUND, "没有名为「%s」的存档" % name,
                           [detail("$.slot", "存档不存在", "现有存档：%s" % ("、".join(names[:20]) or "（无）"), NOT_FOUND)],
                           available=names[:20])
        state = slot["state"]
        state["facts"] = repo.slot_facts(conn, name)
        persona = slot["persona"]
        archive = repo.slot_archive(conn, name)
        source = {"kind": "slot", "name": name, "version": slot["version"]}
    doc = transfer.build(state, persona, archive, source, now_iso())
    target = transfer.export_target(ctx, payload["path"], "%s-第%d回合" % (state["persona_title"], state["turn"]), payload["overwrite"])
    size = transfer.write_file(target, doc)
    return {
        "path": target,
        "bytes": size,
        "checksum": doc["checksum"],
        "format": doc["format"],
        "schema_version": doc["schema_version"],
        "turn": state["turn"],
        "receipt": "已导出到 %s" % target,
    }


def import_save(ctx, payload):
    from . import transfer

    payload = validate(specs.IMPORT_SAVE, payload)
    slot_name = normalize_slot_name(payload["slot"], "$.slot") if payload["slot"] is not None else None
    doc, raw = transfer.read_source(payload)
    state, persona, archive = transfer.check(doc)

    def handler(conn, now):
        from ..domain import clock as CL

        state["session_id"] = new_session_id(conn)
        state["undo_floor"] = state["turn"]
        repo.insert_session(conn, state, persona, "import", now)
        repo.restore_archive(conn, state["session_id"], archive, now)
        repo.insert_turn_log(conn, state["session_id"], state["turn"], state["revision"], "import", None, None,
                             {"source": doc["source"], "exported_at": doc["exported_at"]}, None, None, now)
        slot = None
        save = {"current_slot": None, "turns_since_save": 0}
        if slot_name is not None:
            existing = repo.get_slot(conn, slot_name)
            if existing is not None and not payload["overwrite"]:
                raise AppError(
                    SLOT_CONFLICT,
                    "「%s」已存在" % slot_name,
                    [detail("$.slot", "存档名已被占用", "问用户是否覆盖；确认后带 overwrite: true 重交", SLOT_CONFLICT)],
                    reason="exists",
                )
            version = (existing["version"] + 1) if existing else 1
            label = CL.label(state["clock"])
            repo.put_slot(conn, slot_name, state["session_id"], label, "", state["memory"].get("open_action") or "", version, now)
            repo.set_save_info(conn, state["session_id"], slot_name, version, now)
            slot = {"name": slot_name, "version": version}
            save = {"current_slot": slot_name, "turns_since_save": 0}
        return {
            "session_id": state["session_id"],
            "revision": state["revision"],
            "turn": state["turn"],
            "persona_title": state["persona_title"],
            "slot": slot,
            "receipt": "已导入·第 %d 回合" % state["turn"],
            "resume": _resume(state),
            "context": CX.full(state, persona, save),
            "commit_template": CX.commit_template(state, persona),
        }

    return create_write(ctx, "import-save", payload, handler)


# ---------------------------------------------------------------------------
# settings


def set_boundary(ctx, payload):
    from ..domain import meta

    payload = validate(specs.SET_BOUNDARY, payload)

    def handler(conn, session, now):
        state, persona = session["state"], session["persona"]
        new_state, result = meta.set_boundary(state, payload["action"], payload["text"], payload["tags"], payload["boundary_id"])
        if new_state is not None:
            repo.update_session(conn, new_state, now)
            state = new_state
        return {
            "revision": state["revision"],
            "turn": state["turn"],
            "boundary": result["boundary"],
            "changed": result["changed"],
            "receipt": result["receipt"],
            "boundaries": list(state["safety"]["boundaries"]),
        }

    return session_write(ctx, "set-boundary", payload, handler)


def set_safety(ctx, payload):
    from ..domain import meta

    payload = validate(specs.SET_SAFETY, payload)

    def handler(conn, session, now):
        state, persona = session["state"], session["persona"]
        new_state, result = meta.set_safety(state, payload["paused"], payload["change_scene"])
        if new_state is not None:
            repo.update_session(conn, new_state, now)
            state = new_state
        out = {
            "revision": state["revision"],
            "turn": state["turn"],
            "paused": result["paused"],
            "changed": result["changed"],
            "receipt": result["receipt"],
        }
        if result.get("scene"):
            out["scene"] = result["scene"]
        return out

    return session_write(ctx, "set-safety", payload, handler)


def set_preferences(ctx, payload):
    from ..domain import meta

    payload = validate(specs.SET_PREFERENCES, payload)

    def handler(conn, session, now):
        state, persona = session["state"], session["persona"]
        changes = {k: v for k, v in payload.items() if k in ("offscreen_simulation", "person", "pace", "explicitness")}
        new_state, result = meta.set_preferences(state, changes)
        repo.update_session(conn, new_state, now)
        return {
            "revision": new_state["revision"],
            "turn": new_state["turn"],
            "preferences": result["preferences"],
            "changed": result["changed"],
            "receipt": result["receipt"],
        }

    return session_write(ctx, "set-preferences", payload, handler)


# ---------------------------------------------------------------------------
# status, mood debug


def status(ctx, payload):
    from ..domain import clock as CL
    from ..domain import mood as MO
    from ..domain import state as SS

    payload = validate(specs.STATUS, payload)
    conn = ctx.db()
    session = repo.load_session(conn, payload["session_id"])
    state, persona = session["state"], session["persona"]
    level = payload["level"]
    out = {
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "persona_title": state["persona_title"],
        "clock_label": CL.label(state["clock"]),
        "paused": state["safety"]["paused"],
        "present": [state["characters"][cid]["name"] for cid in state["scene"]["present"]],
        "mood": {cid: MO.brief(state, cid) for cid in SS.npcs(state)},
        "current_slot": session["current_slot"],
        "turns_since_save": session["turns_since_save"],
    }
    if level in ("detail", "debug"):
        out["open_action"] = state["memory"].get("open_action") or ""
        out["recent"] = [t["summary"] for t in state["memory"]["turns"][-3:]]
        out["due_soon"] = CX.brief(state, persona, save_info(session))["due_soon"]
        out["boundaries"] = list(state["safety"]["boundaries"])
        out["requests"] = dict(state["requests"])
        out["counters"] = dict(state["counters"].get("next") or {})
    if level == "debug":
        out["facts"] = repo.count_facts(conn, state["session_id"])
        out["undo_points"] = repo.count_rows(conn, "undo_points", state["session_id"])
        out["turns_logged"] = repo.count_rows(conn, "turn_log", state["session_id"])
        out["archive"] = repo.count_archive(conn, state["session_id"])
        out["thought_deletions"] = repo.thought_deletions(conn, state["session_id"])
        out["persona"] = _persona_summary(persona)
    return out


def next_wake(ctx, payload):
    """When she should wake up on her own, and why. Read-only: nothing is written."""
    from ..domain import clock as CL
    from ..domain import wake as WK

    payload = validate(specs.NEXT_WAKE, payload)
    conn = ctx.db()
    session = repo.load_session(conn, payload["session_id"])
    state, persona = session["state"], session["persona"]
    now = CL.parse_iso(payload["now"]) if payload["now"] else None
    pick, rows = WK.next_wake(
        state,
        persona,
        miss_you_hours=payload["miss_you_hours"],
        streak=payload["streak"],
        routine=payload["routine"],
        quiet_text=payload["quiet"],
        now=now,
    )
    out = {
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "clock": dict(state["clock"], label=CL.label(state["clock"])),
        "paused": bool(state["safety"]["paused"]),
        "plan": _plan_row(state),
        "candidates": rows,
        "next": pick,
        "now": now.isoformat(timespec="seconds") if now else state.get("real_at"),
    }
    return out


def _plan_row(state):
    from ..domain import clock as CL
    from ..domain import ops as OPS

    plan = OPS.current_plan(state)
    if plan is None:
        return None
    return {"note": plan["note"], "until": dict(plan["until"]),
            "until_label": CL.label(plan["until"]), "set_turn": plan.get("set_turn")}


def _her(state, payload):
    """The npc_id a debug call names, or her when it names none."""
    from ..domain import state as SS

    return payload["npc_id"] or SS.companion(state)


def debug_mood(ctx, payload):
    from ..domain import mood as MO

    payload = validate(specs.DEBUG_MOOD, payload)
    conn = ctx.db()
    session = repo.load_session(conn, payload["session_id"])
    state = session["state"]
    cid = _her(state, payload)
    if cid not in state["characters"] or cid == state["player_id"]:
        known = sorted(k for k in state["characters"] if k != state["player_id"])
        raise AppError(NOT_FOUND, "没有这个角色：%s" % cid,
                       [detail("$.npc_id", "角色不存在", "可用角色：%s" % "、".join(known), NOT_FOUND)])
    panel = MO.panel(state, cid)
    panel["npc"] = {"id": cid, "name": state["characters"][cid]["name"]}
    panel["thresholds"] = dict(state.get("mood_thresholds") or {})
    panel["deletions"] = repo.thought_deletions(conn, state["session_id"])
    return panel


def debug_delete_thought(ctx, payload):
    from ..domain import facts as FA
    from ..domain import mood as MO

    payload = validate(specs.DEBUG_DELETE_THOUGHT, payload)

    def handler(conn, session, now):
        state, persona = session["state"], session["persona"]
        cid = _her(state, payload)
        if cid not in state["characters"] or cid == state["player_id"]:
            known = sorted(k for k in state["characters"] if k != state["player_id"])
            raise AppError(NOT_FOUND, "没有这个角色：%s" % cid,
                           [detail("$.npc_id", "角色不存在", "可用角色：%s" % "、".join(known), NOT_FOUND)])
        work = FA.working_copy(state)
        removed = MO.remove_thought(work, cid, payload["thought_id"])
        if removed is None:
            raise AppError(NOT_FOUND, "这个角色身上没有这条情绪：%s" % payload["thought_id"],
                           [detail("$.thought_id", "情绪不存在", "用 debug-mood 看当前条目", NOT_FOUND)])
        # The fact behind it is suppressed so the engine does not add it back
        # on the next situational refresh (user's call: 看着办).
        suppressed = False
        fid = removed.get("source_fact_id")
        if fid:
            fact = work["facts"].get(fid)
            if fact is not None and not fact.get("thought_suppressed"):
                target = FA.edit(work, fid)
                target["thought_suppressed"] = True
                suppressed = True
        work["revision"] = state.get("revision", 0) + 1
        if suppressed:
            repo.write_fact_changes(conn, session["session_id"], work["turn"], work["facts"])
        work["facts"] = repo.FactSource(conn, session["session_id"])
        repo.update_session(conn, work, now)
        repo.log_thought_delete(conn, session["session_id"], work["turn"], cid, removed["id"], removed["label"],
                                removed.get("delta"), payload["reason"], now)
        return {
            "revision": work["revision"],
            "turn": work["turn"],
            "npc_id": cid,
            "removed": {"id": removed["id"], "label": removed["label"], "delta": removed.get("delta"), "kind": removed["kind"]},
            "mood": MO.panel(work, cid),
            "fact_suppressed": suppressed,
            "receipt": "已删除「%s」%s" % (removed["label"], "（相关事实已标记，不再自动加回）" if suppressed else ""),
        }

    return session_write(ctx, "debug-delete-thought", payload, handler)


# ---------------------------------------------------------------------------
# settings page: the whole ledger at a glance
#
# The settings page has three tabs (persona / mood / activity). Both of these
# are read-only: they never bump a revision and never write, so they are safe
# to poll while a turn is being written.


def _mood_rows(state, persona):
    """Every NPC's mood panel, plus their edge toward the player."""
    from ..domain import clock as CL
    from ..domain import mood as MO
    from ..domain import state as SS

    player = state["player_id"]
    thresholds = dict(state.get("mood_thresholds") or {})
    rows = []
    for cid in SS.npcs(state):
        char = state["characters"][cid]
        panel = MO.panel(state, cid)
        edge = SS.edge(state, cid, player) or {}
        rows.append({
            "id": cid,
            "name": char["name"],
            "role": char.get("public_role"),
            "present": SS.is_present(state, cid),
            "conditions": [c["kind"] for c in char["status"].get("conditions") or []],
            "value": panel["value"],
            "band": panel["band"],
            "base": panel["base"],
            "thoughts": panel["thoughts"],
            # how this character feels about the player (the edge points at them)
            "trust": edge.get("trust"),
            "tension": edge.get("tension"),
            "stage": edge.get("stage"),
            "stage_label": SS.stage_label(edge["stage"]) if edge.get("stage") else "",
            "can_act": SS.can_act(state, cid),
        })
    return {"thresholds": thresholds, "npcs": rows}


def debug_moods(ctx, payload):
    from ..domain import clock as CL

    payload = validate(specs.DEBUG_MOODS, payload)
    conn = ctx.db()
    session = repo.load_session(conn, payload["session_id"])
    state = session["state"]
    out = {
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "persona_title": state["persona_title"],
        "clock_label": CL.label(state["clock"]),
        "deletions": repo.thought_deletions(conn, state["session_id"]),
    }
    out.update(_mood_rows(state, session["persona"]))
    return out


_RESPONSE_TEXT = {
    "refuse": "拒绝",
    "partial": "半配合",
    "genuine": "真心回应",
    "surface": "表面配合",
}


def _activity_row(state, row):
    """One turn log row, in the shape the settings page renders."""
    names = {cid: char["name"] for cid, char in state["characters"].items()}
    name_of = lambda cid: names.get(cid, str(cid))
    payload = row.get("payload") or {}
    applied = payload.get("applied") or []
    actions, beats, responses, relations, thoughts = [], [], [], [], []
    for item in applied:
        if not isinstance(item, dict):
            continue
        kind = item.get("op")
        if kind == "npc_action":
            actions.append({
                "npc_id": item.get("npc_id"),
                "name": name_of(item.get("npc_id")),
                "kind": item.get("kind"),
                "kind_label": ST.AGENCY_GOAL_KINDS.get(item.get("kind") or "", item.get("kind") or ""),
                "significant": bool(item.get("significant")),
                "text": item.get("action") or "",
            })
        elif kind == "offscreen_beat":
            beats.append({
                "npc_id": item.get("npc_id"),
                "name": name_of(item.get("npc_id")),
                "summary": item.get("summary") or "",
            })
        elif kind == "npc_response":
            responses.append({
                "npc_id": item.get("npc_id"),
                "name": name_of(item.get("npc_id")),
                "response": item.get("response"),
                "label": _RESPONSE_TEXT.get(item.get("response") or "", item.get("response") or ""),
                "note": item.get("note") or "",
            })
        elif kind == "relationship":
            relations.append({
                "from": item.get("from"),
                "to": item.get("to"),
                "from_name": name_of(item.get("from")),
                "to_name": name_of(item.get("to")),
                "trust": item.get("trust"),
                "tension": item.get("tension"),
                "stage": item.get("stage"),
                "stage_label": ST.STAGE_LABELS.get(item.get("stage") or "", item.get("stage") or ""),
            })
        elif kind == "add_thought":
            thoughts.append({
                "npc_id": item.get("npc_id"),
                "name": name_of(item.get("npc_id")),
                "label": item.get("label") or "",
                "delta": item.get("delta"),
            })
    return {
        "turn": row.get("turn"),
        "revision": row.get("revision"),
        "kind": row.get("kind"),
        "mode": row.get("action_mode"),
        "undone": bool(row.get("undone")),
        "created_at": row.get("created_at"),
        "summary": row.get("summary") or "",
        "open_action": row.get("open_action") or "",
        "actions": actions,
        "beats": beats,
        "responses": responses,
        "relations": relations,
        "thoughts": thoughts,
    }


def debug_activity(ctx, payload):
    from ..domain import clock as CL

    payload = validate(specs.DEBUG_ACTIVITY, payload)
    conn = ctx.db()
    session = repo.load_session(conn, payload["session_id"])
    state = session["state"]
    # recent_turn_log already returns the newest row first: the page reads like
    # a log, not like a book, so no extra reordering here.
    rows = [_activity_row(state, row) for row in repo.recent_turn_log(conn, state["session_id"], payload["limit"])]
    beats_total = sum(len(row["beats"]) for row in rows)
    actions_total = sum(len(row["actions"]) for row in rows)
    return {
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "persona_title": state["persona_title"],
        "clock_label": CL.label(state["clock"]),
        "open_action": state["memory"].get("open_action") or "",
        "counts": {"turns": len(rows), "actions": actions_total, "beats": beats_total},
        "rows": rows,
    }
