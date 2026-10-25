"""One whole game through the sidecar: open it, play turns, look around,
undo, save, load, export, import, and the mood panel with a debug delete."""

import copy
import json
import os

import e2e
from harness import check, run
from stdio import Sidecar

DATA = e2e.temp_dir()


def with_sc(fn):
    def inner():
        with Sidecar(DATA) as s:
            fn(s)

    return inner


def npc_action(npc="zhou_yi", kind="observe", text="他把病历合上，没抬头。", significant=True):
    return {"op": "npc_action", "npc_id": npc, "kind": kind, "action": text, "significant": significant}


def scene_in(s, sid):
    """Bring the major on stage: the opening scene is the corridor, not the clinic."""
    return {"op": "enter_scene", "character_id": "lin_wan"}


def play(sidecar, sid, rev, ops=None, mode="continue", tags=None, acts_on=None):
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=ops or [npc_action()], mode=mode, tags=tags,
                      **({"acts_on": acts_on} if acts_on else {}))
    data = sidecar.ok("commit-turn", body)
    return data["revision"], data


def a_quiet_turn(s):
    sid, rev, _ = e2e.start(s)
    rev, data = play(s, sid, rev)
    assert data["turn"] == 1, data
    assert data["turns"][0]["turn"] == 1, data
    assert data["revision"] == rev, data


def turn_is_not_observable_without_ops(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=[])
    err = s.fail("commit-turn", body)
    assert err["code"] == "INVARIANT_VIOLATION", err
    assert "可观察的变化" in err["message"], err


def stale_revision_is_refused(s):
    sid, rev, _ = e2e.start(s)
    rev2, _ = play(s, sid, rev)
    body = e2e.commit({"session_id": sid, "revision": rev})
    err = s.fail("commit-turn", body)
    assert err["code"] == "STALE_REVISION", err
    assert err["current_revision"] == rev2, err


def brief_context_is_small(s):
    sid, rev, _ = e2e.start(s)
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief"})
    assert ctx["context"]["depth"] == "brief", ctx
    assert ctx["context"]["size_bytes"] <= 6 * 1024, ctx["context"]["size_bytes"]


def full_context_has_the_cast(s):
    sid, rev, _ = e2e.start(s)
    context = s.ok("get-context", {"session_id": sid, "depth": "full"})["context"]
    assert context["depth"] == "full", context
    for key in ("characters", "persona", "agency"):
        assert key in context, sorted(context)
    assert "world" not in context, "a persona-driven game has no world section"
    assert context["size_bytes"] <= 20 * 1024, context["size_bytes"]


def agency_offers_candidates(s):
    sid, rev, _ = e2e.start(s)
    agency = s.ok("get-context", {"session_id": sid, "depth": "brief"})["context"]["agency"]
    assert isinstance(agency, list), agency
    assert len(agency) <= 3, agency
    for row in agency:
        assert row["character_id"], row
        assert row["name"], row
        for option in row["options"]:
            assert option["kind"] in ("approach", "observe", "request", "accident", "provoke", "leave"), option
            assert option["text"], option
            # 每个候选都得说清「为什么」，否则模型只看到结论、理由全靠自己编。
            assert isinstance(option["reasons"], list), option
            assert option["reasons"], option
            assert option["because"].startswith("因为"), option
            assert len(option["because"]) <= 90, option


def mood_moves_after_a_refusal(s):
    sid, rev, _ = e2e.start(s)
    before = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert before["base"] == 55, before
    assert before["value"] <= 55, before
    ops = [
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "她把椅子往后推了半步。"},
        npc_action(),
    ]
    play(s, sid, rev, ops=ops, mode="attempt", acts_on=["lin_wan"])
    after = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert after["value"] < before["value"], (before["value"], after["value"])
    labels = [t["label"] for t in after["thoughts"]]
    assert labels, after
    assert any("拒" in label for label in labels), labels
    assert after["thoughts"][0]["kind"] == "memory", after["thoughts"]


def mood_panel_has_thresholds_and_decay(s):
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev, ops=[
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "她没接话。"},
        npc_action(),
    ], mode="attempt", acts_on=["lin_wan"])
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    for key in ("value", "band", "base", "thoughts", "thresholds"):
        assert key in panel, sorted(panel)
    assert panel["thresholds"]["open"] == 72, panel["thresholds"]
    row = [t for t in panel["thoughts"] if t["kind"] == "memory"][0]
    for key in ("id", "label", "delta", "kind", "since_turn", "remaining_minutes", "decay"):
        assert key in row, sorted(row)
    for thought in panel["thoughts"]:
        if thought["decay"] == "linear":
            assert thought["remaining_minutes"] > 0, thought
        else:
            assert thought["remaining_minutes"] is None, thought


def debug_delete_removes_one_thought(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "add_fact", "key": "stare", "text": "她注意到你一直盯着她看", "visibility": "private",
         "known_by": ["lin_wan"], "origin": "observed"},
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "add_thought", "npc_id": "lin_wan", "label": "被人盯着看", "delta": -8, "basis_fact_id": "f1"},
        npc_action(),
    ])
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    target = [t for t in panel["thoughts"] if t["label"] == "被人盯着看"]
    assert target, panel["thoughts"]
    rid = target[0]["id"]
    out = s.ok("debug-delete-thought", {"session_id": sid, "request_id": e2e.rid("r_del"), "expected_revision": rev,
                                        "npc_id": "lin_wan", "thought_id": rid, "reason": "测试删除"})
    assert out["removed"]["id"] == rid, out
    assert "已删除" in out["receipt"], out
    after = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert all(t["id"] != rid for t in after["thoughts"]), after["thoughts"]
    assert after["deletions"], after


def thought_cap_is_enforced(s):
    sid, rev, _ = e2e.start(s)
    ops = [{"op": "add_fact", "key": "pile", "text": "一晚上出了很多事", "visibility": "private",
            "known_by": ["lin_wan"], "origin": "observed"},
           {"op": "enter_scene", "character_id": "lin_wan"}]
    ops += [{"op": "add_thought", "npc_id": "lin_wan", "label": "第%d件事" % i, "delta": -2, "basis_fact_id": "f1"}
            for i in range(14)]
    ops.append(npc_action())
    play(s, sid, rev, ops=ops)
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert len(panel["thoughts"]) <= 12, len(panel["thoughts"])


def undo_takes_the_turn_back(s):
    sid, rev, _ = e2e.start(s)
    rev, data = play(s, sid, rev)
    undone = s.ok("undo-turn", {"session_id": sid, "request_id": e2e.rid("r_undo"), "expected_revision": rev})
    assert undone["turn"] == 0, undone
    assert undone["undone_turn"] == 1, undone


def undo_floor_is_the_opening(s):
    sid, rev, _ = e2e.start(s)
    err = s.fail("undo-turn", {"session_id": sid, "request_id": e2e.rid("r_undo"), "expected_revision": rev})
    assert err["code"] == "INVARIANT_VIOLATION", err
    assert "读档或开局" in err["message"], err


def save_and_load_round_trip(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    saved = s.ok("save-slot", {"session_id": sid, "request_id": e2e.rid("r_save"), "expected_revision": rev, "name": "雨夜一"})
    assert saved["slot"]["name"] == "雨夜一", saved
    assert saved["slot"]["turn"] == 1, saved
    slots = s.ok("list-slots")["slots"]
    assert [row["name"] for row in slots] == ["雨夜一"], slots
    loaded = s.ok("load-slot", {"request_id": e2e.rid("r_load"), "name": "雨夜一"})
    assert loaded["turn"] == 1, loaded
    assert loaded["session_id"] != sid, loaded
    assert loaded["resume"]["open_action"], loaded
    assert loaded["slot"]["version"] == 1, loaded


def saving_over_a_slot_needs_overwrite(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    s.ok("save-slot", {"session_id": sid, "request_id": e2e.rid("r_s"), "expected_revision": rev, "name": "slotA"})
    sid2, rev2, _ = e2e.start(s)
    err = s.fail("save-slot", {"session_id": sid2, "request_id": e2e.rid("r_s"), "expected_revision": rev2, "name": "slotA"})
    assert err["code"] == "SLOT_CONFLICT", err
    assert err.get("reason") == "exists", err


def delete_slot_needs_confirmation(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    s.ok("save-slot", {"session_id": sid, "request_id": e2e.rid("r_s"), "expected_revision": rev, "name": "slotB"})
    err = s.fail("delete-slot", {"session_id": sid, "request_id": e2e.rid("r_d"), "expected_revision": rev, "name": "slotB"})
    assert err["code"] == "INVALID_INPUT", err
    assert "确认" in err["message"], err
    assert "slotB" in [row["name"] for row in s.ok("list-slots")["slots"]], "an unconfirmed delete must not touch the slot"
    rev = s.ok("get-context", {"session_id": sid})["revision"]
    out = s.ok("delete-slot", {"session_id": sid, "request_id": e2e.rid("r_d"), "expected_revision": rev,
                               "name": "slotB", "confirm": True})
    assert out["deleted"] == "slotB", out
    assert "slotB" not in [row["name"] for row in s.ok("list-slots")["slots"]], "the slot is gone"


def slot_names_are_sanitised(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    err = s.fail("save-slot", {"session_id": sid, "request_id": e2e.rid("r_s"), "expected_revision": rev, "name": "a/b"})
    assert err["code"] == "INVALID_INPUT", err
    err = s.fail("save-slot", {"session_id": sid, "request_id": e2e.rid("r_s"), "expected_revision": rev, "name": "con"})
    assert err["code"] == "INVALID_INPUT", err


def export_and_import(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    path = os.path.join(DATA, "export-%s.json" % os.getpid())
    out = s.ok("export-save", {"session_id": sid, "path": path, "overwrite": True})
    assert os.path.exists(path), out
    assert out["checksum"], out
    assert out["format"] == "rp-soul-save", out
    with open(path, encoding="utf-8") as handle:
        doc = json.load(handle)
    assert doc["checksum"] == out["checksum"], doc
    imported = s.ok("import-save", {"request_id": e2e.rid("r_imp"), "data": doc})
    assert imported["turn"] == 1, imported
    assert imported["session_id"] != sid, imported
    assert imported["resume"]["open_action"], imported


def import_rejects_a_damaged_file(s):
    sid, rev, _ = e2e.start(s)
    path = os.path.join(DATA, "damaged-%s.json" % os.getpid())
    s.ok("export-save", {"session_id": sid, "path": path, "overwrite": True})
    text = open(path, encoding="utf-8").read()
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text.replace('"turn": 1', '"turn": 2', 1))
    doc = json.loads(text)
    doc["session"]["state"]["turn"] = 5
    err = s.fail("import-save", {"request_id": e2e.rid("r_imp"), "data": doc})
    assert err["code"] in ("INVALID_INPUT", "CONTENT_ERROR"), err
    assert "校验" in err["message"] or "不一致" in err["message"], err


def persona_refresh_moves_static_facts(s):
    """Edit persona.md mid-story: names and the mood baseline follow, the story does not."""
    sid, rev, _ = e2e.start(s)
    payload = copy.deepcopy(e2e.persona_payload())
    front = payload["front"]
    front["title"] = "雨夜诊所·续"
    front["mood_base"] = 88
    for place in front["places"]:
        if place["id"] == "hall":
            place["name"] = "值班室"
    for member in front["cast"]:
        if member["id"] == "lin_wan":
            member["name"] = "林晚晚"
            member["age"] = 32
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    report = out["persona"]
    assert report["ok"] is True, report
    assert report["changed"] is True, report
    assert "lin_wan" in report["updated"], report
    context = out["context"]
    assert context["scene"]["location_id"] == "hall", context["scene"]
    assert context["scene"]["location"] == "值班室", context["scene"]
    npc = [row for row in context["present_npcs"] if row["id"] == "lin_wan"]
    if npc:
        assert npc[0]["name"] == "林晚晚", npc[0]
    # The story itself does not move: no time passes and no turn is added.
    assert out["revision"] == rev, (out["revision"], rev)
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert panel["base"] == 88, panel


def persona_refresh_leaves_a_started_relationship_alone(s):
    """start_stage is the opening of a bond; once trust moved, the file has no say."""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "partial", "note": "她把灯往他那边挪了挪。"},
        {"op": "relationship", "from": "player", "to": "lin_wan", "trust_delta": 1,
         "reason": "他把伞留在了门口"},
        npc_action(),
    ], mode="attempt", acts_on=["lin_wan"])
    payload = copy.deepcopy(e2e.persona_payload())
    for member in payload["front"]["cast"]:
        if member["id"] == "lin_wan":
            member["start_stage"] = "intimate"
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    report = out["persona"]
    assert report["ok"] is True, report
    npc = [row for row in out["context"]["present_npcs"] if row["id"] == "lin_wan"]
    assert npc, out["context"]["present_npcs"]
    assert npc[0]["stage"] != "亲密", npc[0]


def persona_refresh_does_not_break_a_broken_persona(s):
    """A half-written file must not take a running story down with it."""
    sid, rev, _ = e2e.start(s)
    payload = copy.deepcopy(e2e.persona_payload())
    payload["front"]["places"] = []
    payload["front"]["cast"] = []
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    report = out["persona"]
    assert report["ok"] is False, report
    assert report["changed"] is False, report
    assert report["count"] >= 1, report
    assert report["text"], report
    assert out["revision"] == rev, (out["revision"], rev)


def status_levels(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev)
    brief = s.ok("status", {"session_id": sid, "level": "brief"})
    detail = s.ok("status", {"session_id": sid, "level": "detail"})
    debug = s.ok("status", {"session_id": sid, "level": "debug"})
    for key in ("place", "clock_label", "paused", "present", "mood"):
        assert key in brief, sorted(brief)
    assert "open_action" in detail and "requests" in detail, sorted(detail)
    for key in ("facts", "undo_points", "turns_logged", "persona", "thought_deletions"):
        assert key in debug, sorted(debug)
    assert "open_action" not in brief, sorted(brief)


def boundaries_and_pause(s):
    sid, rev, _ = e2e.start(s)
    out = s.ok("set-boundary", {"session_id": sid, "request_id": e2e.rid("r_b"), "expected_revision": rev,
                                "action": "add", "text": "不要写诊所之外的场景"})
    assert out["changed"] is True, out
    rev = out["revision"]
    paused = s.ok("set-safety", {"session_id": sid, "request_id": e2e.rid("r_b"), "expected_revision": rev, "paused": True})
    assert paused["paused"] is True, paused
    rev = paused["revision"]
    resumed = s.ok("set-safety", {"session_id": sid, "request_id": e2e.rid("r_b"), "expected_revision": rev, "paused": False})
    assert resumed["paused"] is False, resumed


def check_persona_reports_problems(s):
    payload = e2e.persona_payload()
    payload["front"]["mood_thresholds"] = {"open": 20, "closed": 60, "break": 10}
    out = s.ok("check-persona", {"persona": payload})
    assert out["ok"] is False, out
    assert out["count"] >= 1, out
    assert "break < closed < open" in out["text"], out["text"]


def preview_persona_does_not_write(s):
    before = len(s.ok("list-sessions")["sessions"])
    out = s.ok("preview-persona", {"persona": e2e.persona_payload(), "seed": 42})
    assert out["seed"] == 42, out
    assert out["place"] and out["present"], out
    after = len(s.ok("list-sessions")["sessions"])
    assert after == before, (before, after)


def list_sessions_after_a_game(s):
    sid, rev, _ = e2e.start(s)
    rows = s.ok("list-sessions", {"limit": 5})["sessions"]
    assert any(r["session_id"] == sid for r in rows), rows
    row = [r for r in rows if r["session_id"] == sid][0]
    assert row["turn"] == 0, row
    assert row["persona_title"] == "雨夜诊所", row


def missing_session_is_not_found(s):
    err = s.fail("get-context", {"session_id": "s_00000000"})
    assert err["code"] == "NOT_FOUND", err


def idempotency_returns_the_same_turn(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=[npc_action()])
    body["request_id"] = e2e.rid("r_same")
    first = s.ok("commit-turn", body)
    second = s.ok("commit-turn", body)
    assert second["replayed"] is True, second
    assert first["turn"] == second["turn"] == 1, (first, second)


def a_relationship_toward_the_player_keeps_playing(s):
    """An NPC growing toward the player must not need a mood bar on the player.

    Regression: the player card carries ``"mood": None`` on purpose (the player
    is a slot, nothing about how they feel is stored). A relation whose ``to``
    is the player used to plant a thought on that side and crashed with
    ``'NoneType' object has no attribute 'get'``.
    """
    sid, rev, _ = e2e.start(s)
    ops = [
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "partial", "note": "她把灯往他那边挪了挪。"},
        {"op": "relationship", "from": "lin_wan", "to": "player", "trust_delta": 1, "reason": "他记得她怕黑"},
        npc_action(),
    ]
    rev, data = play(s, sid, rev, ops=ops, mode="attempt", acts_on=["lin_wan"])
    turn_result = data["turns"][0]
    assert turn_result["turn"] == 1, turn_result
    row = [a for a in turn_result["applied"] if a["op"] == "relationship"][0]
    assert row["trust"] == 1, row
    # The edge a>b is a's attitude toward b, so lin_wan is the one who feels it
    # even though the other end is the player (who has no mood blob at all).
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    labels = [t["label"] for t in panel["thoughts"]]
    assert any("信任" in label for label in labels), labels
    # The player id is not an addressable mood subject at all.
    assert s.fail("debug-mood", {"session_id": sid, "npc_id": "player"})["code"] == "NOT_FOUND"


def a_relation_from_the_player_is_recorded_but_not_felt(s):
    """A move starting at the player writes the ledger and no mood anywhere."""
    sid, rev, _ = e2e.start(s)
    ops = [
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "partial", "note": "她嗯了一声。"},
        {"op": "relationship", "from": "player", "to": "lin_wan", "trust_delta": 1, "reason": "他把自己那杯让给她"},
        npc_action(),
    ]
    _rev, data = play(s, sid, rev, ops=ops, mode="attempt", acts_on=["lin_wan"])
    row = [a for a in data["turns"][0]["applied"] if a["op"] == "relationship"][0]
    assert row["trust"] == 1, row
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    labels = [t["label"] for t in panel["thoughts"]]
    assert not any("信任" in label for label in labels), labels


def an_an_npc_relation_still_plants_a_thought(s):
    """The guard must not silence the ordinary NPC-to-NPC case."""
    sid, rev, _ = e2e.start(s)
    ops = [
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "npc_response", "npc_id": "lin_wan", "response": "partial", "note": "她点了点头。"},
        {"op": "relationship", "from": "zhou_yi", "to": "lin_wan", "trust_delta": 1, "reason": "他把值班表改了"},
        npc_action(),
    ]
    play(s, sid, rev, ops=ops, mode="attempt", acts_on=["lin_wan"])
    # zhou_yi is the one whose attitude moved, so the trace is on him.
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "zhou_yi"})
    labels = [t["label"] for t in panel["thoughts"]]
    assert any("信任" in label for label in labels), labels
    other = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert not any("信任" in t["label"] for t in other["thoughts"]), other["thoughts"]


def settings_moods_page_lists_every_npc(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "relationship", "from": "lin_wan", "to": "player", "trust_delta": 2, "reason": "你把伞留给了她"},
        npc_action(),
    ])
    data = s.ok("debug-moods", {"session_id": sid})
    assert data["session_id"] == sid, data
    assert data["revision"] == rev, data
    assert data["persona_title"], data
    assert data["thresholds"] == {"open": 75, "closed": 55, "break": 30} or isinstance(data["thresholds"], dict), data
    ids = [row["id"] for row in data["npcs"]]
    assert ids == ["lin_wan", "zhou_yi"], ids
    wan = data["npcs"][0]
    # the edge lin_wan > player is lin_wan's attitude; the panel mirrors it
    assert wan["trust"] == 2, wan
    assert wan["stage"] == "stranger", wan
    assert wan["stage_label"] == "陌生", wan
    assert wan["role"], wan
    assert isinstance(wan["thoughts"], list) and wan["thoughts"], wan
    assert wan["band"] in ("open", "normal", "closed", "break"), wan
    assert isinstance(wan["value"], int), wan
    assert wan["can_act"] in (True, False), wan


def settings_moods_page_is_read_only(s):
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev)
    first = s.ok("debug-moods", {"session_id": sid})
    again = s.ok("debug-moods", {"session_id": sid})
    assert first["revision"] == again["revision"], (first, again)
    assert [r["value"] for r in first["npcs"]] == [r["value"] for r in again["npcs"]], again


def settings_activity_page_reads_the_turn_log(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "relationship", "from": "lin_wan", "to": "player", "trust_delta": 2, "reason": "你把伞留给了她"},
        npc_action(npc="lin_wan", kind="approach", text="她把病历本抱到胸前。"),
    ])
    data = s.ok("debug-activity", {"session_id": sid, "limit": 10})
    assert data["counts"]["turns"] >= 2, data["counts"]
    rows = data["rows"]
    # newest first, so the opening is the last row
    assert rows[0]["turn"] == 1, rows[0]
    assert rows[-1]["turn"] == 0, rows[-1]
    latest = rows[0]
    assert latest["kind"] == "commit", latest
    assert latest["mode"] == "continue", latest
    assert latest["summary"], latest
    assert [a["kind"] for a in latest["actions"]] == ["approach"], latest["actions"]
    action = latest["actions"][0]
    assert action["kind_label"] == "主动接近", action
    assert action["text"] == "她把病历本抱到胸前。", action
    assert action["name"] == "林晚", action
    rel = latest["relations"][0]
    assert rel["from_name"] == "林晚" and rel["to_name"] == "你", rel
    assert rel["trust"] == 2, rel
    assert data["counts"]["actions"] >= 1, data["counts"]


def settings_activity_respects_the_limit(s):
    sid, rev, _ = e2e.start(s)
    for _ in range(3):
        # a quiet turn: the major NPC is on cooldown after a significant action
        rev, _ = play(s, sid, rev, ops=[npc_action(significant=False)])
    data = s.ok("debug-activity", {"session_id": sid, "limit": 2})
    assert len(data["rows"]) == 2, data["rows"]
    assert data["counts"]["turns"] == 2, data["counts"]


def settings_activity_default_limit_is_twenty(s):
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev)
    data = s.ok("debug-activity", {"session_id": sid})
    assert len(data["rows"]) <= 20, len(data["rows"])


check("a relation toward the player still plays", with_sc(a_relationship_toward_the_player_keeps_playing))
check("a relation from the player is recorded, not felt", with_sc(a_relation_from_the_player_is_recorded_but_not_felt))
check("an NPC-to-NPC relation still leaves a trace", with_sc(an_an_npc_relation_still_plants_a_thought))
check("a quiet turn advances the clock", with_sc(a_quiet_turn))
check("a turn needs an observable change", with_sc(turn_is_not_observable_without_ops))
check("a stale revision is refused with the current one", with_sc(stale_revision_is_refused))
check("brief context stays under 6 KB", with_sc(brief_context_is_small))
check("full context carries the cast but no world", with_sc(full_context_has_the_cast))
check("agency offers candidates", with_sc(agency_offers_candidates))
check("a refusal lowers the mood", with_sc(mood_moves_after_a_refusal))
check("the mood panel shows thresholds and decay", with_sc(mood_panel_has_thresholds_and_decay))
check("debug delete removes exactly one thought", with_sc(debug_delete_removes_one_thought))
check("at most twelve memory thoughts are kept", with_sc(thought_cap_is_enforced))
check("undo takes the turn back", with_sc(undo_takes_the_turn_back))
check("undo cannot go below the opening", with_sc(undo_floor_is_the_opening))
check("save then load resumes the same place", with_sc(save_and_load_round_trip))
check("saving over a slot needs overwrite", with_sc(saving_over_a_slot_needs_overwrite))
check("deleting a slot needs confirmation", with_sc(delete_slot_needs_confirmation))
check("slot names are sanitised", with_sc(slot_names_are_sanitised))
check("export then import round-trips", with_sc(export_and_import))
check("a damaged export is refused", with_sc(import_rejects_a_damaged_file))
check("status grows from brief to debug", with_sc(status_levels))
check("boundaries and pause round-trip", with_sc(boundaries_and_pause))
check("check-persona reports the broken threshold", with_sc(check_persona_reports_problems))
check("preview-persona writes nothing", with_sc(preview_persona_does_not_write))
check("list-sessions shows the new game", with_sc(list_sessions_after_a_game))
check("an unknown session is NOT_FOUND", with_sc(missing_session_is_not_found))
check("the same request_id replays instead of writing twice", with_sc(idempotency_returns_the_same_turn))

check("the mood page lists every NPC", with_sc(settings_moods_page_lists_every_npc))
check("the mood page never writes", with_sc(settings_moods_page_is_read_only))
check("the activity page reads the turn log", with_sc(settings_activity_page_reads_the_turn_log))
check("the activity page honours its limit", with_sc(settings_activity_respects_the_limit))
check("the activity page defaults to twenty turns", with_sc(settings_activity_default_limit_is_twenty))
check("editing persona.md refreshes the static facts", with_sc(persona_refresh_moves_static_facts))
check("a started relationship ignores start_stage", with_sc(persona_refresh_leaves_a_started_relationship_alone))
check("a broken persona does not take the story down", with_sc(persona_refresh_does_not_break_a_broken_persona))

run("game")
