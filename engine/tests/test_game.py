"""One whole game through the sidecar: open it, play turns, look around,
undo, save, load, export, import, and the mood panel with a debug delete.

There are two people: the player and 林晚. No operation names a character."""

import copy
import json
import os

import e2e
import fixture
from harness import check, run
from stdio import Sidecar

DATA = e2e.temp_dir()


def with_sc(fn):
    def inner():
        with Sidecar(DATA) as s:
            fn(s)

    return inner


def npc_action(kind="observe", text="她把病历合上，没抬头。", significant=True):
    return {"op": "npc_action", "kind": kind, "action": text, "significant": significant}


def her_fact(key, text, scope="companion_only"):
    return {"op": "add_fact", "key": key, "text": text, "scope": scope, "origin": "observed"}


def play(sidecar, sid, rev, ops=None, mode="continue", tags=None, on_her=None, **fields):
    extra = dict(fields)
    if on_her is not None:
        extra["acts_on_her"] = on_her
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=ops or [npc_action()], mode=mode, tags=tags, **extra)
    data = sidecar.ok("commit-turn", body)
    return data["revision"], data


def brief_of(s, sid):
    return s.ok("get-context", {"session_id": sid, "depth": "brief"})["context"]


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


def brief_context_is_about_her(s):
    sid, rev, _ = e2e.start(s)
    ctx = brief_of(s, sid)
    assert ctx["depth"] == "brief", ctx
    assert ctx["size_bytes"] <= 6 * 1024, ctx["size_bytes"]
    her = ctx["companion"]
    assert her["id"] == "lin_wan" and her["name"] == "林晚", her
    assert her["present"] is True, her
    assert her["routine_now"] == "在诊所值夜班", her
    for gone in ("present_npcs", "nearby"):
        assert gone not in ctx, gone
    assert "location_id" not in ctx["scene"], ctx["scene"]


def full_context_has_her_card(s):
    sid, rev, _ = e2e.start(s)
    context = s.ok("get-context", {"session_id": sid, "depth": "full"})["context"]
    assert context["depth"] == "full", context
    for key in ("card", "relationship", "persona", "agency"):
        assert key in context, sorted(context)
    for gone in ("characters", "locations", "background", "relationships", "world"):
        assert gone not in context, gone
    assert context["card"]["voices"]["surface"] == "话少，句子短", context["card"]
    assert context["size_bytes"] <= 20 * 1024, context["size_bytes"]


def agency_offers_candidates(s):
    sid, rev, _ = e2e.start(s)
    agency = brief_of(s, sid)["agency"]
    assert isinstance(agency, list) and len(agency) == 1, agency
    row = agency[0]
    assert row["character_id"] == "lin_wan", row
    for option in row["options"]:
        assert option["kind"] in ("approach", "observe", "request", "accident", "provoke", "leave",
                                  "silence", "seek_comfort", "change_topic", "withdraw"), option
        assert option["text"].startswith("林晚"), option
        # 每个候选都得说清「为什么」，否则模型只看到结论、理由全靠自己编。
        assert option["reasons"], option
        assert option["because"].startswith("因为"), option
        assert len(option["because"]) <= 90, option


def ops_no_longer_name_a_character(s):
    sid, rev, _ = e2e.start(s)
    for op in (
        {"op": "npc_action", "npc_id": "lin_wan", "action": "她抬头。"},
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "relationship", "from": "lin_wan", "to": "player", "trust_delta": 1, "reason": "x"},
    ):
        err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=[op]))
        assert err["code"] == "INVALID_INPUT", (op, err)


def a_refusal_leaves_her_own_mood_alone(s):
    """她自己选的回应不进她自己的心情：否则低落→拒绝→更低落会一路滑进崩溃档。"""
    sid, rev, _ = e2e.start(s)
    before = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert before["base"] == 55, before
    ops = [{"op": "npc_response", "response": "refuse", "note": "她把椅子往后推了半步。"}, npc_action()]
    play(s, sid, rev, ops=ops, mode="attempt", on_her=True)
    after = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    memories = [t for t in after["thoughts"] if t["kind"] == "memory"]
    assert memories == [], memories


def genuine_responses_do_not_reward_her_own_mood(s):
    sid, rev, _ = e2e.start(s)
    for _ in range(3):
        rev, _ = play(s, sid, rev, ops=[
            {"op": "npc_response", "response": "genuine", "note": "她轻声说晚安。"},
        ])
        panel = s.ok("debug-mood", {"session_id": sid})
        memories = [t for t in panel["thoughts"] if t["kind"] == "memory"]
        assert memories == [], memories


def mood_panel_has_thresholds_and_decay(s):
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev, ops=[
        her_fact("late", "你迟到了一个钟头", scope="shared"),
        {"op": "add_thought", "label": "等了很久", "delta": -6, "basis_fact_id": "f1"},
        npc_action(),
    ])
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


def a_thought_needs_a_fact_she_knows(s):
    sid, rev, _ = e2e.start(s)
    ops = [her_fact("secret", "你偷偷看了她的病历", scope="player_only"),
           {"op": "add_thought", "label": "被偷看", "delta": -8, "basis_fact_id": "f1"}]
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=ops))
    assert "不知道事实 f1" in json.dumps(err, ensure_ascii=False), err


def refreshing_a_thought_updates_its_label(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        her_fact("misunderstanding", "她误会了你迟到的原因", scope="shared"),
        {"op": "add_thought", "label": "误会让她难过", "delta": -8, "basis_fact_id": "f1"},
    ])
    original = next(t for t in s.ok("debug-mood", {"session_id": sid})["thoughts"] if t["kind"] == "memory")
    rev, data = play(s, sid, rev, ops=[
        {"op": "add_thought", "label": "误会解开，她释然了", "delta": 10, "basis_fact_id": "f1", "minutes": 120},
    ])
    memories = [t for t in s.ok("debug-mood", {"session_id": sid})["thoughts"] if t["kind"] == "memory"]
    assert len(memories) == 1 and memories[0]["id"] == original["id"], memories
    assert memories[0]["label"] == "误会解开，她释然了" and memories[0]["delta"] == 10, memories
    weighing = data["context"]["companion"]["mood"]["weighing"]
    assert any(w["label"] == "误会解开，她释然了" and w["delta"] == 10 for w in weighing), weighing
    assert all("ago_minutes" in w for w in weighing), weighing
    s.ok("undo-turn", {"session_id": sid, "request_id": e2e.rid(), "expected_revision": rev})
    restored = next(t for t in s.ok("debug-mood", {"session_id": sid})["thoughts"] if t["id"] == original["id"])
    assert restored["label"] == "误会让她难过" and restored["delta"] == -8, restored


def debug_delete_removes_one_thought(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        her_fact("stare", "她注意到你一直盯着她看"),
        {"op": "add_thought", "label": "被人盯着看", "delta": -8, "basis_fact_id": "f1"},
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
    ops = [her_fact("pile", "一晚上出了很多事")]
    ops += [{"op": "add_thought", "label": "第%d件事" % i, "delta": -2, "basis_fact_id": "f1"} for i in range(14)]
    ops.append(npc_action())
    play(s, sid, rev, ops=ops)
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert len(panel["thoughts"]) <= 12, len(panel["thoughts"])


def fact_scopes_decide_who_knows(s):
    """shared 和 player_only 进你的已知；companion_only / inner 只有她知道。"""
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev, ops=[
        her_fact("umbrella", "伞落在了门口", scope="shared"),
        her_fact("plan", "你打算明天辞职", scope="player_only"),
        her_fact("letter", "她抽屉里压着一封信", scope="companion_only"),
        her_fact("wait", "她其实在等你开口", scope="inner"),
    ])
    known = [f["text"] for f in brief_of(s, sid)["known_facts"]]
    assert "伞落在了门口" in known and "你打算明天辞职" in known, known
    assert "她抽屉里压着一封信" not in known and "她其实在等你开口" not in known, known


def reveal_makes_her_secret_shared(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[her_fact("letter", "她抽屉里压着一封信")])
    play(s, sid, rev, ops=[{"op": "reveal_fact", "fact_id": "f1", "note": "她把信推了过来"}])
    known = [f["text"] for f in brief_of(s, sid)["known_facts"]]
    assert "她抽屉里压着一封信" in known, known


def her_inner_fact_cannot_be_revealed(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[her_fact("wait", "她其实在等你开口", scope="inner")])
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev},
                                           ops=[{"op": "reveal_fact", "fact_id": "f1"}]))
    assert "心里的事" in json.dumps(err, ensure_ascii=False), err


def a_false_fact_is_hers(s):
    sid, rev, _ = e2e.start(s)
    bad = dict(her_fact("lie", "你说你在加班", scope="shared"), truth=False)
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=[bad]))
    assert "scope 写 companion_only" in json.dumps(err, ensure_ascii=False), err
    play(s, sid, rev, ops=[dict(bad, scope="companion_only")])


def a_promise_with_her_is_yours(s):
    """你们之间的约定默认带上玩家，所以要玩家本人答应。"""
    sid, rev, _ = e2e.start(s)
    promise = {"op": "event_create", "kind": "promise", "title": "周末去看海", "in_minutes": 3000,
               "dedupe_key": "sea"}
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=[promise]))
    assert "玩家本人答应" in json.dumps(err, ensure_ascii=False), err
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=[promise], mode="result", player_authorized=True,
                      player_input="好，周末去看海")
    s.ok("commit-turn", body)
    due = brief_of(s, sid)["due_soon"]
    assert due and due[0]["involves_player"] is True, due


def her_own_deadline_needs_no_consent(s):
    sid, rev, _ = e2e.start(s)
    own = {"op": "event_create", "kind": "deadline", "title": "交夜班报告", "in_minutes": 600,
           "dedupe_key": "report", "with_player": False}
    play(s, sid, rev, ops=[own])
    due = brief_of(s, sid)["due_soon"]
    assert due and "involves_player" not in due[0], due


def an_offscreen_beat_needs_time_apart(s):
    sid, rev, _ = e2e.start(s)
    beat = {"op": "offscreen_beat", "summary": "她去楼下买了杯咖啡。"}
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=[beat]))
    assert "刚刚还在说话" in json.dumps(err, ensure_ascii=False), err


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
    doc = json.loads(text)
    doc["session"]["state"]["turn"] = 5
    err = s.fail("import-save", {"request_id": e2e.rid("r_imp"), "data": doc})
    assert err["code"] in ("INVALID_INPUT", "CONTENT_ERROR"), err
    assert "校验" in err["message"] or "不一致" in err["message"], err


def legacy_persona_still_opens(s):
    """The old places + cast file opens as one companion: her, not the supporting nurse."""
    payload = {"front": copy.deepcopy(fixture.LEGACY_PERSONA), "prose": fixture.LEGACY_PERSONA["prose"],
               "title": fixture.LEGACY_PERSONA["title"], "persona_id": fixture.LEGACY_PERSONA["id"]}
    data = s.ok("new-game", {"request_id": e2e.rid("r_new"), "persona": payload, "seed": 7})
    assert data["persona"]["name"] == "林晚", data["persona"]
    her = data["context"]["companion"]
    assert her["id"] == "lin_wan", her
    assert her["stage"] == "熟络", her
    checked = s.ok("check-persona", {"persona": payload})
    assert checked["ok"] is True and checked["legacy"] is True, checked


def persona_refresh_moves_static_facts(s):
    """Edit persona.md mid-story: her name and the mood baseline follow, the story does not."""
    sid, rev, _ = e2e.start(s)
    payload = copy.deepcopy(e2e.persona_payload())
    front = payload["front"]
    front["title"] = "雨夜诊所·续"
    front["mood_base"] = 88
    front["name"] = "林晚晚"
    front["age"] = 32
    front["routine"] = [{"from": 0, "to": 1439, "doing": "在家补觉"}]
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    report = out["persona"]
    assert report["ok"] is True, report
    assert report["changed"] is True, report
    assert "lin_wan" in report["updated"], report
    her = out["context"]["companion"]
    assert her["name"] == "林晚晚", her
    assert her["routine_now"] == "在家补觉", her
    # The story itself does not move: no time passes and no turn is added.
    assert out["revision"] == rev, (out["revision"], rev)
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert panel["base"] == 88, panel


def persona_refresh_follows_a_renamed_id(s):
    """She is "the one who is not the player": a new persona id does not cut her off."""
    sid, rev, _ = e2e.start(s)
    payload = copy.deepcopy(e2e.persona_payload())
    payload["front"]["id"] = "wan"
    payload["front"]["name"] = "阿晚"
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    assert out["persona"]["ok"] is True, out["persona"]
    assert out["context"]["companion"]["name"] == "阿晚", out["context"]["companion"]


def persona_refresh_leaves_a_started_relationship_alone(s):
    """start_stage is the opening of a bond; once trust moved, the file has no say."""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "npc_response", "response": "partial", "note": "她把灯往你那边挪了挪。"},
        {"op": "relationship", "trust_delta": 1, "reason": "你把伞留在了门口"},
        npc_action(),
    ], mode="attempt", on_her=True)
    payload = copy.deepcopy(e2e.persona_payload())
    payload["front"]["start_stage"] = "intimate"
    out = s.ok("get-context", {"session_id": sid, "depth": "brief", "persona": payload})
    assert out["persona"]["ok"] is True, out["persona"]
    assert out["context"]["companion"]["stage"] != "亲密", out["context"]["companion"]


def persona_refresh_does_not_break_a_broken_persona(s):
    """A half-written file must not take a running story down with it."""
    sid, rev, _ = e2e.start(s)
    payload = copy.deepcopy(e2e.persona_payload())
    del payload["front"]["age"]
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
    for key in ("clock_label", "paused", "present", "mood"):
        assert key in brief, sorted(brief)
    assert "place" not in brief, sorted(brief)
    assert "open_action" in detail and "requests" in detail, sorted(detail)
    for key in ("facts", "undo_points", "turns_logged", "persona", "thought_deletions"):
        assert key in debug, sorted(debug)
    assert debug["persona"]["name"] == "林晚", debug["persona"]
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


def check_persona_summarises_her(s):
    out = s.ok("check-persona", {"persona": e2e.persona_payload()})
    assert out["ok"] is True and out["legacy"] is False, out
    summary = out["persona"]
    assert summary["name"] == "林晚" and summary["routine"], summary
    assert "cast" not in summary and "places" not in summary, summary


def preview_persona_does_not_write(s):
    before = len(s.ok("list-sessions")["sessions"])
    out = s.ok("preview-persona", {"persona": e2e.persona_payload(), "seed": 42})
    assert out["seed"] == 42, out
    assert out["name"] == "林晚" and out["doing"] == "在诊所值夜班", out
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


def a_relationship_move_is_felt_by_her(s):
    """Her trust toward you moving leaves a thought on her; the player has no mood bar."""
    sid, rev, _ = e2e.start(s)
    ops = [
        {"op": "npc_response", "response": "partial", "note": "她把灯往你那边挪了挪。"},
        {"op": "relationship", "trust_delta": 1, "reason": "你记得她怕黑"},
        npc_action(),
    ]
    rev, data = play(s, sid, rev, ops=ops, mode="attempt", on_her=True)
    turn_result = data["turns"][0]
    row = [a for a in turn_result["applied"] if a["op"] == "relationship"][0]
    assert row["trust"] == 1 and row["from"] == "lin_wan" and row["to"] == "player", row
    panel = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    labels = [t["label"] for t in panel["thoughts"]]
    assert any("信任" in label for label in labels), labels
    # The player id is not an addressable mood subject at all.
    assert s.fail("debug-mood", {"session_id": sid, "npc_id": "player"})["code"] == "NOT_FOUND"


def the_memory_page_shows_her_memories(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[npc_action()], remember="她第一次对我笑")
    data = s.ok("debug-memories", {"session_id": sid})
    assert data["revision"] == rev and data["counts"]["now"] >= 1, data["counts"]
    mine = [e for e in data["entries"] if e["content"] == "她第一次对我笑"]
    assert mine and mine[0]["layer_label"] == "刚刚" and mine[0]["activity"] == 1.0, data["entries"]
    assert data["layers"]["events"] == "那些事" and data["capacity"]["days"] == 30


def editing_a_memory_marks_it_yours(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[npc_action()], remember="下雨那天")
    mid = [e for e in s.ok("debug-memories", {"session_id": sid})["entries"] if e["content"] == "下雨那天"][0]["id"]
    out = s.ok("edit-memory", {"session_id": sid, "request_id": e2e.rid("r_m"), "expected_revision": rev,
                               "memory_id": mid, "content": "下雨那天他把伞给了我", "pinned": True, "note": "别忘"})
    assert out["revision"] == rev + 1 and "已改" in out["receipt"], out
    row = out["memory"]
    assert row["edited"] is True and row["pinned"] is True and row["note"] == "别忘", row
    assert "雨伞" not in row["keywords"] and "把伞" in row["keywords"], row["keywords"]
    err = s.fail("edit-memory", {"session_id": sid, "request_id": e2e.rid("r_m"), "expected_revision": rev,
                                 "memory_id": mid, "note": "旧版本"})
    assert err["code"] == "STALE_REVISION", err


def deleting_a_memory_leaves_an_audit(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[npc_action()], remember="不想记得的事")
    mid = [e for e in s.ok("debug-memories", {"session_id": sid})["entries"] if e["content"] == "不想记得的事"][0]["id"]
    s.ok("delete-memory", {"session_id": sid, "request_id": e2e.rid("r_d"), "expected_revision": rev,
                           "memory_id": mid, "reason": "测试"})
    data = s.ok("debug-memories", {"session_id": sid})
    assert all(e["id"] != mid for e in data["entries"]), data["entries"]
    assert data["deletions"][0]["memory_id"] == mid and data["deletions"][0]["reason"] == "测试", data["deletions"]
    err = s.fail("delete-memory", {"session_id": sid, "request_id": e2e.rid("r_d"), "expected_revision": data["revision"],
                                   "memory_id": mid})
    assert err["code"] == "NOT_FOUND", err


def summarize_now_is_paid_by_the_next_commit(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[npc_action()], remember="今天陪她值了夜班")
    out = s.ok("request-memory", {"session_id": sid, "request_id": e2e.rid("r_q"), "expected_revision": rev, "kind": "summary"})
    rev = out["revision"]
    assert out["request"]["sources"][0]["text"] == "今天陪她值了夜班", out
    ctx = s.ok("get-context", {"session_id": sid})["context"]
    assert ctx["memory_summary_sources"]["sources"], ctx.get("memory_summary_sources")
    err = s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=[npc_action(significant=False)]))
    assert "日记" in json.dumps(err, ensure_ascii=False), err
    play(s, sid, rev, ops=[npc_action(significant=False)], memory_summary="那晚我值夜班，有人陪着，没那么难熬")
    days = [e for e in s.ok("debug-memories", {"session_id": sid})["entries"] if e["layer"] == "days"]
    assert days and days[0]["content"].startswith("那晚我值夜班"), days


def nothing_to_archive_is_refused(s):
    sid, rev, _ = e2e.start(s)
    err = s.fail("request-memory", {"session_id": sid, "request_id": e2e.rid("r_q"), "expected_revision": rev, "kind": "journal"})
    assert err["code"] == "INVALID_INPUT" and "没有可以写进日记" in err["message"], err


def settings_moods_page_lists_her(s):
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        {"op": "relationship", "trust_delta": 2, "reason": "你把伞留给了她"},
        npc_action(),
    ])
    data = s.ok("debug-moods", {"session_id": sid})
    assert data["session_id"] == sid, data
    assert data["revision"] == rev, data
    assert data["persona_title"], data
    assert isinstance(data["thresholds"], dict), data
    ids = [row["id"] for row in data["npcs"]]
    assert ids == ["lin_wan"], ids
    wan = data["npcs"][0]
    # the edge lin_wan > player is her attitude; the panel mirrors it
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
        {"op": "relationship", "trust_delta": 2, "reason": "你把伞留给了她"},
        npc_action(kind="observe", text="她把病历本抱到胸前。"),
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
    assert [a["kind"] for a in latest["actions"]] == ["observe"], latest["actions"]
    action = latest["actions"][0]
    assert action["kind_label"] == "在旁观察", action
    assert action["text"] == "她把病历本抱到胸前。", action
    assert action["name"] == "林晚", action
    rel = latest["relations"][0]
    assert rel["from_name"] == "林晚" and rel["to_name"] == "你", rel
    assert rel["trust"] == 2, rel
    assert data["counts"]["actions"] >= 1, data["counts"]


def settings_activity_respects_the_limit(s):
    sid, rev, _ = e2e.start(s)
    for _ in range(3):
        # a quiet turn: she is on cooldown after a significant action
        rev, _ = play(s, sid, rev, ops=[npc_action(significant=False)])
    data = s.ok("debug-activity", {"session_id": sid, "limit": 2})
    assert len(data["rows"]) == 2, data["rows"]
    assert data["counts"]["turns"] == 2, data["counts"]


def settings_activity_default_limit_is_twenty(s):
    sid, rev, _ = e2e.start(s)
    play(s, sid, rev)
    data = s.ok("debug-activity", {"session_id": sid})
    assert len(data["rows"]) <= 20, len(data["rows"])


check("a quiet turn advances the clock", with_sc(a_quiet_turn))
check("a turn needs an observable change", with_sc(turn_is_not_observable_without_ops))
check("a stale revision is refused with the current one", with_sc(stale_revision_is_refused))
check("brief context is about her", with_sc(brief_context_is_about_her))
check("full context carries her card, no cast or map", with_sc(full_context_has_her_card))
check("agency offers her candidates", with_sc(agency_offers_candidates))
check("ops no longer name a character", with_sc(ops_no_longer_name_a_character))
check("a refusal leaves her own mood alone", with_sc(a_refusal_leaves_her_own_mood_alone))
check("genuine responses do not reward her own mood", with_sc(genuine_responses_do_not_reward_her_own_mood))
check("the mood panel shows thresholds and decay", with_sc(mood_panel_has_thresholds_and_decay))
check("a thought needs a fact she knows", with_sc(a_thought_needs_a_fact_she_knows))
check("a refreshed thought updates its label and undo restores it", with_sc(refreshing_a_thought_updates_its_label))
check("debug delete removes exactly one thought", with_sc(debug_delete_removes_one_thought))
check("at most twelve memory thoughts are kept", with_sc(thought_cap_is_enforced))
check("a fact's scope decides who knows it", with_sc(fact_scopes_decide_who_knows))
check("reveal makes her secret shared", with_sc(reveal_makes_her_secret_shared))
check("her inner fact cannot be revealed", with_sc(her_inner_fact_cannot_be_revealed))
check("a false fact is one she believes", with_sc(a_false_fact_is_hers))
check("a promise with her needs the player's consent", with_sc(a_promise_with_her_is_yours))
check("her own deadline needs no consent", with_sc(her_own_deadline_needs_no_consent))
check("an offscreen beat needs time apart", with_sc(an_offscreen_beat_needs_time_apart))
check("undo takes the turn back", with_sc(undo_takes_the_turn_back))
check("undo cannot go below the opening", with_sc(undo_floor_is_the_opening))
check("save then load resumes the same place", with_sc(save_and_load_round_trip))
check("saving over a slot needs overwrite", with_sc(saving_over_a_slot_needs_overwrite))
check("deleting a slot needs confirmation", with_sc(delete_slot_needs_confirmation))
check("slot names are sanitised", with_sc(slot_names_are_sanitised))
check("export then import round-trips", with_sc(export_and_import))
check("a damaged export is refused", with_sc(import_rejects_a_damaged_file))
check("the old cast file still opens as her", with_sc(legacy_persona_still_opens))
check("status grows from brief to debug", with_sc(status_levels))
check("boundaries and pause round-trip", with_sc(boundaries_and_pause))
check("check-persona reports the broken threshold", with_sc(check_persona_reports_problems))
check("check-persona summarises her", with_sc(check_persona_summarises_her))
check("preview-persona writes nothing", with_sc(preview_persona_does_not_write))
check("list-sessions shows the new game", with_sc(list_sessions_after_a_game))
check("an unknown session is NOT_FOUND", with_sc(missing_session_is_not_found))
check("the same request_id replays instead of writing twice", with_sc(idempotency_returns_the_same_turn))
check("a relationship move is felt by her", with_sc(a_relationship_move_is_felt_by_her))
check("the mood page lists her", with_sc(settings_moods_page_lists_her))
check("the memory page shows her memories", with_sc(the_memory_page_shows_her_memories))
check("editing a memory marks it yours", with_sc(editing_a_memory_marks_it_yours))
check("deleting a memory leaves an audit", with_sc(deleting_a_memory_leaves_an_audit))
check("summarize now is paid by the next commit", with_sc(summarize_now_is_paid_by_the_next_commit))
check("nothing to archive is refused", with_sc(nothing_to_archive_is_refused))
check("the mood page never writes", with_sc(settings_moods_page_is_read_only))
check("the activity page reads the turn log", with_sc(settings_activity_page_reads_the_turn_log))
check("the activity page honours its limit", with_sc(settings_activity_respects_the_limit))


def the_facts_page_lists_what_is_known(s):
    """常识库页是只读的：她知道的事列出来，谁知道也写清楚。"""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        her_fact("secret", "你偷偷看了她的病历", scope="player_only"),
        her_fact("rain", "昨天下了一整夜的雨", scope="companion_only"),
    ])
    data = s.ok("debug-facts", {"session_id": sid})
    assert data["revision"] == rev and data["count"] == len(data["rows"]) >= 2, data["count"]
    by_key = {f["key"]: f for f in data["rows"]}
    assert by_key["secret"]["known_by"] == ["你"], by_key["secret"]
    assert by_key["rain"]["visibility"] == "private" and "林晚" in by_key["rain"]["known_by"], by_key["rain"]


check("the activity page defaults to twenty turns", with_sc(settings_activity_default_limit_is_twenty))
def deleting_a_fact_takes_its_thoughts_with_it(s):
    """常识库能手动删：删了事实，指着它的想法一起走，下一回合不会卡在校验上。"""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[
        her_fact("stare", "她注意到你一直盯着她看"),
        {"op": "add_thought", "label": "被人盯着看", "delta": -8, "basis_fact_id": "f1"},
        npc_action(),
    ])
    rows = s.ok("debug-facts", {"session_id": sid})["rows"]
    target = [r for r in rows if r["key"] == "stare"]
    assert target, rows
    out = s.ok("delete-fact", {"session_id": sid, "request_id": e2e.rid("r_f"), "expected_revision": rev,
                               "fact_id": target[0]["id"]})
    assert out["removed"]["text"] == "她注意到你一直盯着她看" and out["dropped_thoughts"] == 1, out
    assert "已删除" in out["receipt"], out
    after = s.ok("debug-facts", {"session_id": sid})
    assert all(r["id"] != target[0]["id"] for r in after["rows"]), after["rows"]
    assert out["revision"] == rev + 1, out
    mood = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})
    assert all(t["label"] != "被人盯着看" for t in mood["thoughts"]), mood["thoughts"]
    # 下一回合照常能提交（想法依据的事实已经不在了，校验不该炸）
    play(s, sid, out["revision"], ops=[npc_action(significant=False)])
    err = s.fail("delete-fact", {"session_id": sid, "request_id": e2e.rid("r_f"),
                                 "expected_revision": out["revision"] + 1, "fact_id": target[0]["id"]})
    assert err["code"] == "NOT_FOUND", err


check("the facts page lists what is known", with_sc(the_facts_page_lists_what_is_known))
check("deleting a fact takes its thoughts with it", with_sc(deleting_a_fact_takes_its_thoughts_with_it))


def undo_does_not_resurrect_a_deleted_fact(s):
    """设置页手动删的事实不属于任何回合：撤回上一回合不该把它变回来。"""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[her_fact("rain", "昨天下了一整夜的雨")])
    rev, _ = play(s, sid, rev, ops=[npc_action()])
    fid = [r for r in s.ok("debug-facts", {"session_id": sid})["rows"] if r["key"] == "rain"][0]["id"]
    rev = s.ok("delete-fact", {"session_id": sid, "request_id": e2e.rid("r_f"), "expected_revision": rev,
                               "fact_id": fid})["revision"]
    assert all(r["id"] != fid for r in s.ok("debug-facts", {"session_id": sid})["rows"])
    rev = s.ok("undo-turn", {"session_id": sid, "request_id": e2e.rid(), "expected_revision": rev})["revision"]
    still = [r for r in s.ok("debug-facts", {"session_id": sid})["rows"] if r["id"] == fid]
    assert still == [], still


check("undo does not resurrect a deleted fact", with_sc(undo_does_not_resurrect_a_deleted_fact))


def undo_keeps_a_removed_fact_removed_even_if_it_was_edited(s):
    """「改过一回合、又在设置页删掉」那条路：这条事实在 journal 里既有第 N 回合
    的旧版本，也有 turn 0 的删除记录。撤回第 N 回合只能恢复它写过的东西，
    不能把这条已经从 facts 里拿掉的事实整个插回来。"""
    sid, rev, _ = e2e.start(s)
    rev, _ = play(s, sid, rev, ops=[her_fact("rain", "昨天下了一整夜的雨")])
    fid = [r for r in s.ok("debug-facts", {"session_id": sid})["rows"] if r["key"] == "rain"][0]["id"]
    # 第二回合把这条事实的知情范围改了：journal 在这一回合记下 before = 旧版本
    rev, _ = play(s, sid, rev, ops=[{"op": "reveal_fact", "fact_id": fid}])
    edited = [r for r in s.ok("debug-facts", {"session_id": sid})["rows"] if r["key"] == "rain"][0]
    assert edited["id"] == fid and "你" in edited["known_by"], edited
    rev = s.ok("delete-fact", {"session_id": sid, "request_id": e2e.rid("r_f"), "expected_revision": rev,
                               "fact_id": fid})["revision"]
    assert all(r["id"] != fid for r in s.ok("debug-facts", {"session_id": sid})["rows"])
    rev = s.ok("undo-turn", {"session_id": sid, "request_id": e2e.rid(), "expected_revision": rev})["revision"]
    still = [r for r in s.ok("debug-facts", {"session_id": sid})["rows"] if r["id"] == fid]
    assert still == [], still


check("undo keeps an edited-then-removed fact removed", with_sc(undo_keeps_a_removed_fact_removed_even_if_it_was_edited))
check("editing persona.md refreshes the static facts", with_sc(persona_refresh_moves_static_facts))
check("a renamed persona id still finds her", with_sc(persona_refresh_follows_a_renamed_id))
check("a started relationship ignores start_stage", with_sc(persona_refresh_leaves_a_started_relationship_alone))
check("a broken persona does not take the story down", with_sc(persona_refresh_does_not_break_a_broken_persona))

def _wait(s, minutes):
    """让真实时间真的过去若干分钟：改存档里的 real_at 锚点（测试里不能干等）。"""
    import time
    time.sleep(0)
    return minutes


def thoughts_carry_how_long_ago():
    """心情里每条心事要带「多久以前」：刚冒出的念头和昨天留下的分量不一样。"""
    from rp_soul_engine.domain import mood as MO
    state = {
        "characters": {"lin_wan": {"id": "lin_wan", "mood": {"base": 50, "thoughts": []}}},
        "counters": {}, "turn": 0, "clock": {"day": 1, "minute": 600},
    }
    MO.add_thought(state, "lin_wan", "很久没见你", -5, "memory", minutes=1200)
    state["clock"] = {"day": 1, "minute": 700}
    rows = MO.brief(state, "lin_wan")["top"]
    assert rows and rows[0]["ago_minutes"] == 100, rows


check("thoughts carry how long ago", thoughts_carry_how_long_ago)


run("game")
