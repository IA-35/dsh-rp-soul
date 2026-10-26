"""她的记忆：四层随真实时间老化（以 RimTalk-ExpandMemory 为主）。

直接调领域层、显式给时间：刚刚存活 24 小时、这几天约 3 天被忘、容量淘汰、
那些事超额直接进那些年、Pin 不动、里程碑自动 Pin、重要度按情绪分量。
"""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rp_soul_engine import opening
from rp_soul_engine import persona as PE
from rp_soul_engine import schema as S
from rp_soul_engine.domain import clock as CL
from rp_soul_engine.domain import memories as MEM
from rp_soul_engine.domain import turn as TU
from tests.fixture import PERSONA
from tests.harness import check, run

T0 = "2026-10-26T20:00:00+08:00"   # 周一
COMMIT = S.Obj(TU.commit_fields())


def pack():
    got, errors = PE.validate(copy.deepcopy(PERSONA))
    assert got is not None, PE.problems_text(errors)
    return got


def start():
    persona = pack()
    state, _ = opening.new_session(persona, seed=7, now=T0)
    return state, persona


def commit(state, persona, now, ops=None, **kw):
    raw = {"action_mode": "continue", "player_input": "", "operations": ops or [glance()], "content_tags": [],
           "summary": "她抬头看了你一眼。", "open_action": "等你开口。"}
    raw.update(kw)
    normalized, errors = S.validate(COMMIT, raw, "$")
    assert normalized is not None, errors
    new, _ = TU.commit_turn(state, persona, normalized, now=now)
    return new


def glance():
    return {"op": "npc_action", "action": "她抬头看了你一眼。"}


def beat():
    return {"op": "offscreen_beat", "summary": "她自己待了一会儿。"}


def at(hours):
    """T0 之后若干小时的真实时刻。"""
    base = CL.parse_iso(T0)
    from datetime import timedelta
    return (base + timedelta(hours=hours)).isoformat()


def layer_of(state, eid):
    found = [e for e in MEM.entries(state) if e["id"] == eid]
    return found[0]["layer"] if found else None


def main_entry(state, turn):
    return [e for e in MEM.entries(state) if e["turn"] == turn and e["type"] in ("conversation", "experience")][0]


# ---------------------------------------------------------------------------


def a_turn_is_remembered_in_now():
    state, persona = start()
    state = commit(state, persona, at(0), player_input="今晚雨好大", quotes=["伞给你"],
                   remember="他冒雨来了，我其实挺高兴")
    entry = main_entry(state, 1)
    assert entry["layer"] == "now" and entry["type"] == "conversation", entry
    assert entry["content"] == "他冒雨来了，我其实挺高兴", "her own words win over the summary"
    assert entry["quotes"] == ["伞给你"] and entry["you"] == "今晚雨好大", entry
    assert "高兴" in entry["keywords"], entry["keywords"]
    actions = [e for e in MEM.entries(state) if e["type"] == "action"]
    assert actions and actions[0]["content"] == "她抬头看了你一眼。", actions


def without_remember_the_summary_is_kept():
    state, persona = start()
    state = commit(state, persona, at(0))
    assert main_entry(state, 1)["content"] == "她抬头看了你一眼。"


def importance_follows_the_feelings():
    state, persona = start()
    state = commit(state, persona, at(0), ops=[
        {"op": "add_fact", "key": "lie", "text": "你撒了谎", "scope": "companion_only", "origin": "observed"},
        {"op": "add_thought", "label": "被骗", "delta": -30, "basis_fact_id": "f1"},
    ])
    assert main_entry(state, 1)["importance"] == 0.8, main_entry(state, 1)
    calm, persona = start()
    calm = commit(calm, persona, at(0))
    assert main_entry(calm, 1)["importance"] == 0.3


def now_lives_a_day_then_moves_on():
    state, persona = start()
    state = commit(state, persona, at(0))
    first = main_entry(state, 1)["id"]
    action = [e["id"] for e in MEM.entries(state) if e["type"] == "action"][0]
    state = commit(state, persona, at(23), ops=[beat(), glance()])
    assert layer_of(state, first) == "now", "still 刚刚 before 24 hours"
    state = commit(state, persona, at(25), ops=[beat(), glance()])
    assert layer_of(state, first) == "days", "a conversation moves on to 这几天"
    assert layer_of(state, action) is None, "a passing action is dropped"
    moved = [e for e in MEM.entries(state) if e["id"] == first][0]
    assert moved["t0"] == CL.to_abs(moved["at"]) + MEM.NOW_LIFESPAN_MINUTES, "decay starts when it left 刚刚"


def now_keeps_six():
    state, persona = start()
    for i in range(8):
        state = commit(state, persona, at(0.05 * i), ops=[glance()] if i == 0 else [{"op": "npc_state", "add_conditions": [{"kind": "busy", "text": "忙%d" % i}]}])
    now = [e for e in MEM.entries(state) if e["layer"] == "now" and e["type"] != "action"]
    assert len([e for e in MEM.entries(state) if e["layer"] == "now"]) <= 6
    assert main_entry(state, 1)["layer"] == "days", "the oldest moved on"
    assert now, now


def days_are_forgotten_in_about_three_days():
    state, persona = start()
    entry = MEM.add(state, "days", "conversation", "那天一起吃了面", 0.5)
    start_minute = entry["t0"]
    assert 0.29 < MEM.activity(entry, start_minute + 24 * 60) < 0.30, MEM.activity(entry, start_minute + 24 * 60)
    assert MEM.activity(entry, start_minute + 71 * 60) > MEM.CLEAN_BELOW
    assert MEM.activity(entry, start_minute + 73 * 60) < MEM.CLEAN_BELOW
    state["clock"] = CL.from_abs(start_minute + 73 * 60)
    report = MEM.maintain(state)
    assert entry["id"] in report["forgotten"], report


def years_last_about_a_year_and_a_half():
    state, persona = start()
    entry = MEM.add(state, "years", "chapter", "那年秋天", 0.5)
    month = MEM.activity(entry, entry["t0"] + 30 * 24 * 60)
    assert 0.80 < month < 0.81, month
    assert MEM.activity(entry, entry["t0"] + 500 * 24 * 60) > MEM.CLEAN_BELOW
    assert MEM.activity(entry, entry["t0"] + 520 * 24 * 60) < MEM.CLEAN_BELOW


def pinned_is_never_forgotten():
    state, persona = start()
    entry = MEM.add(state, "days", "conversation", "第一次见面", 0.5, pinned=True)
    state["clock"] = CL.from_abs(entry["t0"] + 400 * 24 * 60)
    report = MEM.maintain(state)
    assert entry["id"] not in report["forgotten"] and MEM.activity(entry, CL.to_abs(state["clock"])) == 1.0


def days_capacity_drops_the_least_active():
    state, persona = start()
    first = MEM.add(state, "days", "conversation", "最早的事", 0.5)
    state["clock"] = CL.add_minutes(state["clock"], 60)
    rest = [MEM.add(state, "days", "conversation", "第%d件事" % i, 0.5) for i in range(20)]
    report = MEM.maintain(state)
    assert first["id"] in report["forgotten"], report
    assert len(MEM.of_layer(state, "days")) == 20 and rest[-1] in MEM.entries(state)


def events_overflow_moves_into_years():
    state, persona = start()
    oldest = MEM.add(state, "events", "summary", "最早的那天", 0.5)
    state["clock"] = CL.add_minutes(state["clock"], 1)
    for i in range(50):
        MEM.add(state, "events", "summary", "第%d天" % i, 0.5)
    MEM.maintain(state)
    assert layer_of(state, oldest["id"]) == "years", "over capacity: the oldest becomes 那些年 as it is"
    assert len(MEM.of_layer(state, "events")) == 50


def a_stage_advance_is_pinned():
    state, persona = start()
    state = commit(state, persona, at(0), action_mode="attempt", acts_on_her=True, ops=[
        {"op": "npc_response", "response": "genuine", "note": "她笑了"},
        {"op": "relationship", "stage_advance": True, "reason": "你们聊开了"},
    ], player_input="我们算朋友了吧")
    entry = main_entry(state, 1)
    assert entry["pinned"] is True and "stage" in entry["milestone"], entry
    assert entry["importance"] >= 0.5, entry


def only_the_first_promise_is_a_milestone():
    state, persona = start()
    promise = {"op": "event_create", "kind": "promise", "title": "周末看海", "in_minutes": 3000, "dedupe_key": "sea"}
    state = commit(state, persona, at(0), action_mode="result", player_authorized=True, player_input="好", ops=[promise])
    assert main_entry(state, 1)["pinned"] is True
    second = dict(promise, title="下周吃面", dedupe_key="noodle")
    state = commit(state, persona, at(0.1), action_mode="result", player_authorized=True, player_input="好", ops=[second])
    assert main_entry(state, 2)["pinned"] is False, "only the first promise is a milestone"


def an_alone_turn_is_an_experience():
    state, persona = start()
    state = commit(state, persona, at(2), together=False, ops=[glance()], summary="她一个人收拾了诊室。")
    assert main_entry(state, 1)["type"] == "experience"


def memory_follows_undo():
    """记忆在状态里：撤销这一回合，这一回合的记忆一起退回去。"""
    state, persona = start()
    before = len(MEM.entries(state))
    after = commit(state, persona, at(0))
    assert len(MEM.entries(after)) > before
    assert len(MEM.entries(state)) == before, "the commit works on a copy"


def when_label_is_lifelike():
    state, persona = start()
    state["clock"] = {"day": 4, "minute": 600}
    assert MEM.when_label(state, {"day": 4, "minute": 1200}) == "今天 · 周四晚上"
    assert MEM.when_label(state, {"day": 3, "minute": 60}) == "昨天 · 周三凌晨"
    assert MEM.when_label(state, {"day": 1, "minute": 1230}) == "3 天前 · 周一晚上"


def keywords_are_bigrams():
    assert MEM.keywords("下雨天") == ["下雨", "雨天"]
    assert MEM.keywords("Rain 很大") == ["很大", "rain"]


check("a turn is remembered in 刚刚", a_turn_is_remembered_in_now)
check("without remember the summary is kept", without_remember_the_summary_is_kept)
check("importance follows the turn's feelings", importance_follows_the_feelings)
check("刚刚 lives a day, then moves on", now_lives_a_day_then_moves_on)
check("刚刚 keeps six", now_keeps_six)
check("这几天 is forgotten in about three days", days_are_forgotten_in_about_three_days)
check("那些年 lasts about a year and a half", years_last_about_a_year_and_a_half)
check("pinned is never forgotten", pinned_is_never_forgotten)
check("这几天 over capacity drops the least active", days_capacity_drops_the_least_active)
check("那些事 overflow moves into 那些年", events_overflow_moves_into_years)
check("a stage advance is pinned", a_stage_advance_is_pinned)
check("only the first promise is a milestone", only_the_first_promise_is_a_milestone)
check("a turn alone is an experience", an_alone_turn_is_an_experience)
check("memory follows undo (commit works on a copy)", memory_follows_undo)
check("time labels are lifelike", when_label_is_lifelike)
check("keywords are two-character pieces", keywords_are_bigrams)
run("memories")
