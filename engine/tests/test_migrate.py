"""旧存档（state schema 1，多角色时代）升级成你我两个人。

先在纯函数层验规则，再造一个真正的 schema 1 数据库交给 sidecar：它要自己
迁移（先备份）、之后能读、能交账、能撤销、能读档；旧版导出文件也要能导入。
"""

import copy
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e
from harness import check, run
from rp_soul_engine import migrate as MG
from rp_soul_engine.application import transfer
from rp_soul_engine.domain import invariants
from rp_soul_engine.persistence import db, repo
from stdio import Sidecar
from tests.fixture import LEGACY_PERSONA

NOW = "2026-10-26T21:00:00+08:00"


def edge(a, b, trust=0, stage="stranger"):
    return {"from": a, "to": b, "trust": trust, "tension": 0, "stage": stage, "history": []}


def event(eid, kind, title, participants, dedupe):
    return {
        "id": eid, "kind": kind, "tier": "near", "title": title, "text": None,
        "participants": participants, "due": {"day": 2, "minute": 600}, "probability": None,
        "dedupe_key": dedupe, "state": "pending", "outcome": None, "created_turn": 2,
        "resolved_turn": None, "note": None, "coord": [2, 1],
    }


def fact(fid, key, text, known_by, spreading=False):
    return {
        "id": fid, "key": key, "text": text, "truth": True, "known_by": known_by, "believed_by": [],
        "visibility": "public" if len(known_by) > 1 else "private", "origin": "observed", "turn": 2,
        "spreading": spreading, "coord": [2, int(fid[1:])],
    }


def card(cid, name, tier, mood, **extra):
    out = {
        "id": cid, "name": name, "call": name, "tier": tier, "age": 30, "gender": "female",
        "adult_context": "", "public_role": name, "appearance": "", "voices": None, "start_stage": "stranger",
        "schedule": [], "status": {"location_id": "clinic", "conditions": []}, "mood": mood,
    }
    out.update(extra)
    return out


def v1_state(turn=3):
    """多角色时代的一局：林晚（主要）、周奕（配角）、玩家；地点、排班、NPC 之间的关系、传播中的事实。"""
    lin_mood = {"base": 55, "thoughts": [{
        "id": "th1", "label": "等了很久", "delta": -6, "kind": "memory", "decay": "linear",
        "since_turn": 2, "since_abs": 1200, "expires_at": 1560, "source_fact_id": "f1",
    }]}
    return {
        "schema": 1, "revision": turn + 2, "seed": 7, "persona_id": "rain_clinic",
        "persona_revision": "0123456789abcdef", "persona_title": "雨夜诊所",
        "mood_base": 55, "mood_thresholds": {"open": 72, "closed": 40, "break": 18},
        "player_id": "player", "turn": turn, "clock": {"day": 1, "minute": 1260},
        "real_start": None, "real_at": None,
        "characters": {
            "player": card("player", "你", "major", None, age=28, gender=None, status={"location_id": "clinic", "conditions": []}),
            "lin_wan": card("lin_wan", "林晚", "major", lin_mood, call="林医生", public_role="夜班医生",
                            voices={"surface": "话少", "inner": "总在算时间"}, start_stage="familiar",
                            schedule=[{"from": 1200, "to": 360, "location_id": "clinic"}]),
            "zhou_yi": card("zhou_yi", "周奕", "supporting", {"base": 55, "thoughts": []}, gender="male",
                            status={"location_id": "hall", "conditions": []}),
        },
        "relationships": {
            "player>lin_wan": edge("player", "lin_wan", stage="familiar"),
            "lin_wan>player": edge("lin_wan", "player", trust=2, stage="familiar"),
            "zhou_yi>lin_wan": edge("zhou_yi", "lin_wan", trust=-1),
            "lin_wan>zhou_yi": edge("lin_wan", "zhou_yi"),
        },
        "facts": {
            "f1": fact("f1", "late", "你迟到了一个钟头", ["player", "lin_wan", "zhou_yi"], spreading=True),
            "f2": fact("f2", "zhou_yi.debt", "周奕欠了赌债", ["zhou_yi"]),
        },
        "events": {
            "e1": event("e1", "promise", "明早一起吃早饭", ["player", "lin_wan"], "breakfast"),
            "e2": event("e2", "deadline", "周奕还债", ["zhou_yi"], "debt"),
            "e3": event("e3", "deadline", "你交房租", ["player"], "rent"),
        },
        "counters": {
            "next": {"scene": 3, "fact": 3, "event": 4, "thought": 2, "chapter": 1, "boundary": 1},
            "major_action_turn": {"lin_wan": 1, "zhou_yi": 1}, "offscreen_beat_turn": {"zhou_yi": 2},
            "last_chapter_turn": 0, "next_thought": {"lin_wan": 2, "zhou_yi": 1},
            "event_keys": {"breakfast": 1, "debt": 1, "rent": 1},
        },
        "scene": {
            "id": "sc2", "location_id": "clinic", "present": ["player", "lin_wan", "zhou_yi"],
            "since": {"day": 1, "minute": 1200},
            "responses": [{"turn": turn, "npc_id": "lin_wan", "response": "partial", "note": "嗯"},
                          {"turn": turn, "npc_id": "zhou_yi", "response": "refuse", "note": "不"}],
        },
        "memory": {"prologue": "", "chapters": [], "turns": [
            {"turn": turn, "day": 1, "mode": "continue", "summary": "她抬头看了你一眼。", "open_action": "等你开口。", "quotes": []}],
            "last_quotes": [], "open_action": "等你开口。"},
        "preferences": {"offscreen_simulation": True, "pace": "standard", "explicitness": "standard"},
        "safety": {"paused": False, "boundaries": []},
        "requests": {"chapter_summary": False, "prologue": False, "offscreen_beat_candidates": ["zhou_yi"]},
        "undo_floor": 0, "session_id": "s_old00001",
    }


def legacy_persona():
    return copy.deepcopy(LEGACY_PERSONA)


def stored_legacy_persona():
    """库里存的是旧引擎校验过的人设：没写的 call/role/appearance 被补成 None / "" / ""。"""
    raw = legacy_persona()
    for member in raw["cast"]:
        member.setdefault("call", None)
        member["call"] = None
        member["role"] = ""
        member["appearance"] = ""
    return raw


def a_stored_persona_with_engine_own_fields_upgrades():
    """旧引擎自己的字段（start / goal / 旧 decision）不该让迁移失败：不认识就丢掉。

    真实的旧库里存着 ``start: {day, minute}``——旧引擎的虚拟时钟起点，新引擎按真实墙钟走，
    这个字段已经没有意义。迁移曾因为它报「未知字段：start」整库失败（备份能还原，但那一局打不开）。
    """
    raw = stored_legacy_persona()
    raw["start"] = {"day": 1, "minute": 1290}
    raw["rules"] = list(raw.get("rules") or [])
    raw["cast"][0]["decision"] = {"core_value": "不喧哗", "prefers": ["具体的进度"]}
    persona = MG.persona_v1_to_v2(raw)
    assert "start" not in persona, persona.keys()
    major = next(m for m in raw["cast"] if m.get("tier", "major") == "major")
    assert persona["name"] == major["name"], persona
    assert persona["routine"], persona


# ---------------------------------------------------------------------------
# 纯函数层


def only_the_two_of_you_remain():
    new = MG.state_v1_to_v2(v1_state(), legacy_persona())
    assert new["schema"] == 2 and new["persona_id"] == "lin_wan", (new["schema"], new["persona_id"])
    assert sorted(new["characters"]) == ["lin_wan", "player"], sorted(new["characters"])
    her = new["characters"]["lin_wan"]
    assert "tier" not in her and "schedule" not in her, sorted(her)
    assert her["routine"] == [{"from": 1200, "to": 360, "doing": "在诊所"}], her["routine"]
    assert her["status"] == {"conditions": []}, her["status"]
    assert her["mood"]["thoughts"][0]["label"] == "等了很久", "her feelings survive"


def her_bond_survives_the_rest_goes():
    new = MG.state_v1_to_v2(v1_state(), legacy_persona())
    assert sorted(new["relationships"]) == ["lin_wan>player", "player>lin_wan"], sorted(new["relationships"])
    assert new["relationships"]["lin_wan>player"]["trust"] == 2
    assert new["scene"]["present"] == ["player", "lin_wan"], new["scene"]
    assert "location_id" not in new["scene"], new["scene"]
    assert [r["npc_id"] for r in new["scene"]["responses"]] == ["lin_wan"], new["scene"]["responses"]
    assert "offscreen_beat_candidates" not in new["requests"]
    assert new["counters"]["major_action_turn"] == {"lin_wan": 1}
    assert new["counters"]["next_thought"] == {"lin_wan": 2}


def facts_and_events_are_trimmed():
    new = MG.state_v1_to_v2(v1_state(), legacy_persona())
    assert new["facts"]["f1"]["known_by"] == ["player", "lin_wan"], new["facts"]["f1"]
    assert new["facts"]["f1"]["spreading"] is False
    assert new["facts"]["f2"]["known_by"] == [], "a fact only 周奕 knew is known by nobody now"
    assert sorted(new["events"]) == ["e1", "e3"], sorted(new["events"])
    assert new["events"]["e1"]["participants"] == ["lin_wan", "player"]
    assert new["events"]["e3"]["participants"] == ["lin_wan", "player"], "a player-only event is ours now"


def the_upgraded_state_passes_the_invariants():
    new = MG.state_v1_to_v2(v1_state(), legacy_persona())
    problems = invariants.check(new)
    assert problems == [], problems


def the_old_persona_becomes_her():
    persona = MG.persona_v1_to_v2(legacy_persona())
    assert persona["id"] == "lin_wan" and persona["name"] == "林晚", persona
    assert "cast" not in persona and "places" not in persona
    assert persona["revision"] == LEGACY_PERSONA["revision"]


def a_stored_persona_with_blank_fields_upgrades():
    """回归：旧引擎把没写的可选字段存成 None / ""，新 schema 不收这两种值。"""
    persona = MG.persona_v1_to_v2(stored_legacy_persona())
    assert persona["name"] == "林晚", persona
    assert persona["call"] is None and persona["role"] == "" and persona["appearance"] == "", persona


def events_with_someone_else_are_dropped():
    """你和周奕的约定不该变成你和她的约定。"""
    state = v1_state()
    state["events"]["e4"] = event("e4", "promise", "陪周奕去还债", ["player", "zhou_yi"], "debt_help")
    new = MG.state_v1_to_v2(state, legacy_persona())
    assert "e4" not in new["events"], sorted(new["events"])


def the_input_is_not_touched():
    old = v1_state()
    MG.state_v1_to_v2(old, legacy_persona())
    assert old == v1_state(), "the upgrade is pure"


def a_new_state_passes_through():
    new = MG.state_v1_to_v2(v1_state(), legacy_persona())
    assert MG.state_v1_to_v2(new, legacy_persona()) is new


# ---------------------------------------------------------------------------
# 真正的 schema 1 数据库


def make_v1_db(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    conn = db.connect(os.path.join(data_dir, "engine.db"))
    conn.execute("PRAGMA journal_mode=WAL")
    db.begin_write(conn)
    db._migrate_to_1(conn)
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')")
    repo.insert_session(conn, v1_state(), stored_legacy_persona(), "new_game", NOW)
    repo.put_undo_point(conn, "s_old00001", 3, v1_state(turn=2))
    repo.put_slot(conn, "旧档", "s_old00001", "第一天 21:00", "林晚 49", "等你开口。", 1, NOW)
    conn.execute("COMMIT")
    conn.close()


def an_old_database_is_migrated_and_playable():
    data = e2e.temp_dir()
    make_v1_db(data)
    with Sidecar(data) as s:
        ctx = s.ok("get-context", {"session_id": "s_old00001", "depth": "brief"})["context"]
        assert ctx["companion"]["id"] == "lin_wan", ctx["companion"]
        assert ctx["companion"]["stage"] == "熟络", ctx["companion"]
        known = [f["text"] for f in ctx["known_facts"]]
        assert "你迟到了一个钟头" in known and "周奕欠了赌债" not in known, known
        body = e2e.commit({"session_id": "s_old00001", "revision": ctx["revision"]},
                          ops=[{"op": "npc_action", "action": "她把病历合上。"}])
        turn = s.ok("commit-turn", body)
        assert turn["turn"] == 4, turn
        undone = s.ok("undo-turn", {"session_id": "s_old00001", "request_id": e2e.rid("r_u"),
                                    "expected_revision": turn["revision"]})
        assert undone["turn"] == 3, undone
        undone = s.ok("undo-turn", {"session_id": "s_old00001", "request_id": e2e.rid("r_u"),
                                    "expected_revision": undone["revision"]})
        assert undone["turn"] == 2, "the old undo point was upgraded too"
        loaded = s.ok("load-slot", {"request_id": e2e.rid("r_l"), "name": "旧档"})
        assert loaded["turn"] == 3, loaded
        moods = s.ok("debug-moods", {"session_id": loaded["session_id"]})
        assert [row["id"] for row in moods["npcs"]] == ["lin_wan"], moods["npcs"]
    backups = os.listdir(os.path.join(data, "backups"))
    assert any("schema1" in name for name in backups), backups


def an_old_export_file_imports_as_her():
    state = v1_state()
    doc = transfer.build(state, legacy_persona(), [], {"session_id": state["session_id"]}, NOW)
    doc["schema_version"] = 1
    doc["checksum"] = transfer.checksum(doc)
    with Sidecar(e2e.temp_dir()) as s:
        imported = s.ok("import-save", {"request_id": e2e.rid("r_imp"), "data": json.loads(json.dumps(doc))})
        assert imported["turn"] == 3, imported
        ctx = s.ok("get-context", {"session_id": imported["session_id"], "depth": "brief"})["context"]
        assert ctx["companion"]["name"] == "林晚", ctx["companion"]


check("only the two of you remain", only_the_two_of_you_remain)
check("her bond survives, the rest goes", her_bond_survives_the_rest_goes)
check("facts and events are trimmed to the two of you", facts_and_events_are_trimmed)
check("the upgraded state passes the invariants", the_upgraded_state_passes_the_invariants)
check("the old persona becomes her", the_old_persona_becomes_her)
check("a stored persona with blank optional fields upgrades", a_stored_persona_with_blank_fields_upgrades)
check("a stored persona with the old engine's own fields still upgrades", a_stored_persona_with_engine_own_fields_upgrades)
check("events with someone else are dropped", events_with_someone_else_are_dropped)
check("the upgrade does not touch its input", the_input_is_not_touched)
check("a new state passes through untouched", a_new_state_passes_through)
check("an old database is migrated (with a backup) and playable", an_old_database_is_migrated_and_playable)
check("an old export file imports as her", an_old_export_file_imports_as_her)
run("migrate")
