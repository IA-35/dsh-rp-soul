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
    entry = MEM.add(state, "days", "conversation", "那天一起吃了面", 0.5, summarized=True)
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
    first = MEM.add(state, "days", "conversation", "最早的事", 0.5, summarized=True)
    state["clock"] = CL.add_minutes(state["clock"], 60)
    rest = [MEM.add(state, "days", "conversation", "第%d件事" % i, 0.5, summarized=True) for i in range(20)]
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


# ---------------------------------------------------------------------------
# 每日总结与归档


def play(state, persona, now, **kw):
    """一回合一条记录：提交后像 close_record 一样算出下一条记录要交的请求。"""
    new = commit(state, persona, now, **kw)
    TU.close_record(new, [{"crossed_day": new["clock"]["day"] > state["clock"]["day"]}])
    return new


def a_finished_day_asks_for_a_summary():
    state, persona = start()
    state = play(state, persona, at(0), remember="下雨天他来了")
    assert state["requests"]["memory_summary"] is None, "today is still going on"
    state = play(state, persona, at(1), ops=[beat(), glance()])
    assert state["requests"]["memory_summary"] is None
    state = play(state, persona, at(14), ops=[beat(), glance()])          # 第二天 10:00
    request = state["requests"]["memory_summary"]
    # 第一天：两回合对话 + 一段离屏经历（动作类不进总结）
    assert request and request["day"] == 1 and len(request["ids"]) == 3, request
    try:
        commit(state, persona, at(14.1))
    except Exception as exc:
        assert "那些事" in str(exc), exc
    else:
        raise AssertionError("the summary is required")
    state = play(state, persona, at(14.2), memory_summary="那天下雨他来了两次，我挺高兴")
    events = MEM.of_layer(state, "events")
    assert len(events) == 1 and events[0]["origin_ids"] == request["ids"], events
    assert events[0]["at"]["day"] == 1 and "高兴" in events[0]["keywords"], events[0]
    sources = [e for e in MEM.entries(state) if e["id"] in request["ids"]]
    assert all(e["summarized"] for e in sources), "sources are marked, not removed"
    assert state["requests"]["memory_summary"] is None, "day one is not asked for again"


def a_summary_nobody_asked_for_is_refused():
    state, persona = start()
    try:
        commit(state, persona, at(0), memory_summary="没人要的总结")
    except Exception as exc:
        assert "没有要求每日总结" in str(exc), exc
    else:
        raise AssertionError("refused")


def ended_events_leave_with_the_summary():
    state, persona = start()
    deadline = {"op": "event_create", "kind": "deadline", "title": "交报告", "in_minutes": 60,
                "dedupe_key": "report", "with_player": False}
    state = play(state, persona, at(0), ops=[deadline])
    state = play(state, persona, at(14), ops=[beat(), glance()])          # 到期、跨天
    assert state["events"]["e1"]["state"] == "resolved"
    state = play(state, persona, at(14.1), memory_summary="那天的报告没交上")
    assert "e1" not in state["events"], "an ended event is archived with the day"


def half_a_month_asks_for_an_archive():
    state, persona = start()
    old = MEM.add(state, "events", "summary", "第一周的事", 0.5)
    kept = MEM.add(state, "events", "summary", "第一次吵架", 0.9, pinned=True)
    state["clock"] = {"day": 16, "minute": 600}
    request = MEM.archive_request(state)
    assert request == {"ids": [old["id"]]}, request
    state["requests"]["memory_archive"] = request
    state["real_at"] = at(15 * 24 - 10)
    state = commit(state, persona, at(15 * 24 - 9.9), memory_archive="那半个月我们慢慢熟了")
    years = MEM.of_layer(state, "years")
    assert len(years) == 1 and years[0]["origin_ids"] == [old["id"]], years
    assert old["id"] not in [e["id"] for e in MEM.entries(state)], "archived sources are consumed"
    assert kept["id"] in [e["id"] for e in MEM.entries(state)], "a pinned 那些事 stays"
    assert state["memory"]["last_archive_day"] == 16 and MEM.archive_request(state) is None


def the_old_chain_becomes_her_memory():
    from rp_soul_engine import migrate as MG
    state, persona = start()
    old = copy.deepcopy(state)
    old["schema"] = 2
    old["clock"] = {"day": 5, "minute": 600}
    old["memory"] = {
        "prologue": "我们是在雨夜认识的",
        "chapters": [{"index": 1, "from_turn": 1, "to_turn": 20, "day": 2, "summary": "第二天一起吃了面"}],
        "turns": [{"turn": 20, "day": 2, "summary": "吃面", "quotes": []},
                  {"turn": 21, "day": 4, "summary": "她生气了", "quotes": ["走开"]},
                  {"turn": 22, "day": 5, "summary": "和好了", "quotes": []}],
        "last_quotes": [], "open_action": "",
    }
    old["counters"]["last_chapter_turn"] = 20
    old["counters"]["next"]["chapter"] = 2
    old["counters"]["next"].pop("memory", None)
    old["requests"] = {"chapter_summary": True, "prologue": False}
    new = MG.state_v2_to_v3(old)
    assert new["schema"] == 3 and "chapters" not in new["memory"] and "prologue" not in new["memory"]
    by = {e["content"]: e for e in MEM.entries(new)}
    assert by["我们是在雨夜认识的"]["layer"] == "years"
    assert by["第二天一起吃了面"]["layer"] == "events"
    assert by["吃面"]["summarized"] is True, "covered by the chapter"
    assert by["她生气了"]["summarized"] is False and by["她生气了"]["quotes"] == ["走开"]
    assert by["和好了"]["layer"] == "now" and by["她生气了"]["layer"] == "days"
    assert new["requests"] == {"memory_summary": None, "memory_archive": None}
    assert "last_chapter_turn" not in new["counters"] and new["counters"]["next"]["memory"] == 6
    assert MG.state_v2_to_v3(new) is new, "a schema-3 state passes through"


# ---------------------------------------------------------------------------
# 注入：配额收割


def rounds_come_first_newest_first():
    state, persona = start()
    for i in range(4):
        state = commit(state, persona, at(0.05 * i), player_input="第%d句" % i, quotes=["回%d" % i],
                       ops=[{"op": "npc_state", "add_conditions": [{"kind": "busy", "text": "忙%d" % i}]}])
    MEM.add(state, "days", "conversation", "前几天一起散步", 0.5)
    rows = MEM.inject(state, "", MEM.TOTAL_BRIEF)
    assert [r["you"] for r in rows[:3]] == ["第3句", "第2句", "第1句"], rows[:3]
    assert rows[0]["said"] == ["回3"] and rows[0]["layer"] == "刚刚"
    assert rows[3]["text"] == "前几天一起散步" and "you" not in rows[3], rows[3:]
    assert len(rows) <= MEM.TOTAL_BRIEF


def a_cue_brings_back_an_old_memory():
    state, persona = start()
    sea = MEM.add(state, "events", "summary", "那天我们去看海，风很大", 0.3, at={"day": 1, "minute": 600})
    MEM.add(state, "events", "summary", "那天吃了一碗面", 0.3, at={"day": 1, "minute": 600})
    state["clock"] = {"day": 20, "minute": 600}
    _, quiet = MEM.select(state, "", MEM.TOTAL_BRIEF)
    _, cued = MEM.select(state, "还记得看海那次吗", MEM.TOTAL_BRIEF)
    assert cued and cued[0]["id"] == sea["id"], [e["content"] for e in cued]
    now = MEM.CL.to_abs(state["clock"])
    assert MEM.score(sea, now, MEM.cue_keywords(state, "还记得看海那次吗"), "together") > MEM.score(sea, now, MEM.cue_keywords(state, ""), "together")
    assert quiet[0]["id"] != sea["id"], "without the cue the two tie and nothing pulls the sea forward"


def a_cue_recalls_the_other_recent_rounds():
    state, persona = start()
    sea = MEM.add(state, "now", "conversation", "一起看海捡到了蓝色贝壳", 0.5)
    for text in ("买菜", "散步", "听歌", "吃饭", "下雨"):
        MEM.add(state, "now", "conversation", text, 0.5)
    MEM.maintain(state)
    rounds, picked = MEM.select(state, "还记得蓝色贝壳吗")
    assert [e["content"] for e in rounds] == ["下雨", "吃饭", "听歌"]
    assert picked and picked[0]["id"] == sea["id"], [e["content"] for e in picked]
    ids = [e["id"] for e in rounds + picked]
    assert len(ids) == len(set(ids)) and len(ids) <= MEM.TOTAL_BRIEF
    rows = MEM.inject(state, "还记得蓝色贝壳吗")
    assert any("蓝色贝壳" in r["text"] for r in rows), rows


def the_threshold_drops_the_faint():
    state, persona = start()
    faint = MEM.add(state, "years", "chapter", "很久以前的一件小事", 0.0, at={"day": 1, "minute": 0})
    MEM.touch(faint, faint["t0"], 0.03)
    state["clock"] = {"day": 200, "minute": 0}
    _, picked = MEM.select(state, "", MEM.TOTAL_BRIEF)
    assert faint not in picked, "below 0.15 it is not brought up"
    faint["pinned"] = True
    _, picked = MEM.select(state, "", MEM.TOTAL_BRIEF)
    assert faint in picked, "a pinned memory always clears the threshold"


def her_secrets_are_in_context():
    from rp_soul_engine.projections import context as CX
    state, persona = start()
    state = commit(state, persona, at(0), ops=[
        {"op": "add_fact", "key": "her.letter", "text": "她抽屉里压着一封没寄出的信", "scope": "companion_only", "origin": "observed"},
        {"op": "add_fact", "key": "umbrella", "text": "伞落在了门口", "scope": "shared", "origin": "observed"},
    ])
    knows = [f["text"] for f in CX.her_knows(state, "")]
    assert "她抽屉里压着一封没寄出的信" in knows and "伞落在了门口" not in knows, knows
    ctx = CX.brief(state, persona, cue="那封信")
    assert ctx["her_knows"][0]["text"] == "她抽屉里压着一封没寄出的信"
    assert "memories" in ctx and "recent" not in ctx and "last_quotes" not in ctx, sorted(ctx)


def the_brief_stays_within_budget():
    from rp_soul_engine.projections import context as CX
    state, persona = start()
    for i in range(50):
        MEM.add(state, "events", "summary", "那些日子里第%d件事，" % i + "细节" * 60, 0.9, pinned=True)
    ctx = CX.brief(state, persona, cue="细节")
    assert ctx["size_bytes"] <= 6 * 1024, ctx["size_bytes"]
    assert all(len(r["text"]) <= MEM.TEXT_MAX for r in ctx["memories"])


def mentioning_it_makes_it_stronger():
    state, persona = start()
    sea = MEM.add(state, "days", "conversation", "那天我们去看海", 0.3)
    # 配额只有 8 条：放 9 件同样分量的别的事，只有被你提起的那件才挤得进来
    for i in range(9):
        MEM.add(state, "days", "conversation", "别的事%d" % i, 0.3)
    state["real_at"] = at(0)
    later = commit(state, persona, at(10), player_input="想再去看海", ops=[beat(), glance()])
    plain = commit(state, persona, at(10), player_input="今天好累", ops=[beat(), glance()])
    now = MEM.CL.to_abs(later["clock"])
    strong = [e for e in MEM.entries(later) if e["id"] == sea["id"]][0]
    weak = [e for e in MEM.entries(plain) if e["id"] == sea["id"]][0]
    assert MEM.activity(strong, now) > MEM.activity(weak, now), (MEM.activity(strong, now), MEM.activity(weak, now))


# ---------------------------------------------------------------------------
# 审查发现的问题（回归测试）


def a_long_absence_keeps_the_day_for_its_summary():
    """回归：隔了五天才回来，走之前那天在总结前不能被忘掉。"""
    state, persona = start()
    state = play(state, persona, at(0), remember="走之前那晚我们聊到很晚")
    state = play(state, persona, at(1), ops=[beat(), glance()])
    state = play(state, persona, at(5 * 24), ops=[beat(), glance()])
    request = state["requests"]["memory_summary"]
    assert request and request["day"] == 1 and len(request["ids"]) == 3, request
    texts = [e["content"] for e in MEM.sources(state, request)]
    assert "走之前那晚我们聊到很晚" in texts, texts
    state = play(state, persona, at(5 * 24 + 0.1), memory_summary="那晚我们聊到很晚，之后他好几天没来")
    assert all(e["summarized"] for e in MEM.entries(state) if e["at"]["day"] == 1 and e["type"] in MEM.KEEPS)
    state = play(state, persona, at(5 * 24 + 0.2), ops=[glance()])
    assert not [e for e in MEM.entries(state) if e["at"]["day"] == 1 and e["type"] == "conversation"], \
        "once summarised, the faded days are forgotten"


def a_busy_day_is_summarised_whole():
    """回归：一天聊了 26 回合，这几天的容量 20 不能在总结前挤掉其中几回合。"""
    state, persona = start()
    for i in range(26):
        state = commit(state, persona, at(0.02 * i), ops=[{"op": "npc_state", "add_conditions": [{"kind": "busy", "text": "忙%d" % i}]}])
    state = play(state, persona, at(14), ops=[beat(), glance()])
    request = state["requests"]["memory_summary"]
    assert request and len(request["ids"]) == 26, (request and len(request["ids"]))


def the_brief_stays_small_while_a_summary_is_due():
    """回归：待交的总结 / 归档不能把 brief 撑过 6 KB、把记忆挤没。"""
    from rp_soul_engine.projections import context as CX
    state, persona = start()
    for i in range(21):
        MEM.add(state, "days", "conversation", "那天发生的第%d件事，" % i + "细节" * 55, 0.5, at={"day": 1, "minute": 600})
    for i in range(50):
        MEM.add(state, "events", "summary", "第%d天，" % i + "点滴" * 38, 0.5)
    state["clock"] = {"day": 20, "minute": 600}
    state["requests"]["memory_summary"] = MEM.summary_request(state)
    state["requests"]["memory_archive"] = MEM.manual_archive_request(state)
    brief = CX.brief(state, persona, cue="细节")
    assert brief["size_bytes"] <= 6 * 1024, brief["size_bytes"]
    assert brief["memories"], "memories survive the budget"
    assert brief["memory_summary_sources"]["more"] == 9 and len(brief["memory_summary_sources"]["sources"]) == 12
    full = CX.full(state, persona, cue="细节")
    assert len(full["memory_summary_sources"]["sources"]) == 21, "the full context has every source"


def migrating_in_the_morning_keeps_today_in_the_past():
    """回归：早上 8 点升级，今天的旧回合不能落在中午（未来）、压过之后的新对话。"""
    from rp_soul_engine import migrate as MG
    state, persona = start()
    old = copy.deepcopy(state)
    old["schema"] = 2
    old["clock"] = {"day": 1, "minute": 480}
    old["memory"] = {"prologue": "", "chapters": [], "last_quotes": [], "open_action": "",
                     "turns": [{"turn": i, "day": 1, "summary": "旧回合%d" % i, "quotes": []} for i in range(1, 9)]}
    old["counters"]["last_chapter_turn"] = 0
    old["counters"]["next"].pop("memory", None)
    old["requests"] = {"chapter_summary": False, "prologue": False}
    new = MG.state_v2_to_v3(old)
    assert all(CL.to_abs(e["at"]) <= CL.to_abs(new["clock"]) for e in MEM.entries(new)), "nothing in the future"
    new["real_at"] = T0
    for i in range(3):
        new = commit(new, persona, at(0.01 * (i + 1)), summary="新回合%d" % i)
    rounds = [e["content"] for e in MEM.recent_rounds(new)]
    assert rounds == ["新回合2", "新回合1", "新回合0"], rounds


def saving_unchanged_fields_is_not_an_edit():
    """回归：设置页只改 Pin / 备注，不该算「你改过」（RimTalk 给改过的 +0.3）。"""
    state, persona = start()
    entry = MEM.add(state, "days", "conversation", "下雨那天", 0.5)
    MEM.edit(state, entry["id"], {"content": "下雨那天", "importance": 0.5, "keywords": list(entry["keywords"]),
                                  "activity": 1.0, "note": "备注", "pinned": True})
    assert entry["edited"] is False and entry["pinned"] is True and entry["note"] == "备注", entry
    MEM.edit(state, entry["id"], {"content": "下雨那天他来了"})
    assert entry["edited"] is True


def long_ascii_words_are_clipped():
    """回归：网址片段之类的长英文词截到 20 个字符，设置页才存得回去。"""
    words = MEM.keywords("看 https://example.com/watch?v=dQw4w9WgXcQ supercalifragilisticexpialidocious")
    assert words and all(len(w) <= MEM.KEYWORD_LEN for w in words), words


def a_request_with_nothing_left_is_dropped():
    state, persona = start()
    entry = MEM.add(state, "events", "summary", "那些日子", 0.5)
    state["requests"]["memory_archive"] = MEM.manual_archive_request(state)
    entry["pinned"] = True
    MEM.prune_requests(state)
    assert state["requests"]["memory_archive"] is None, "an archive of only pinned 那些事 has nothing to write"


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
check("a finished day asks for a summary", a_finished_day_asks_for_a_summary)
check("a summary nobody asked for is refused", a_summary_nobody_asked_for_is_refused)
check("ended events leave with the summary", ended_events_leave_with_the_summary)
check("half a month asks for an archive", half_a_month_asks_for_an_archive)
check("the old chain becomes her memory", the_old_chain_becomes_her_memory)
check("the recent rounds come first, newest first", rounds_come_first_newest_first)
check("a cue brings back an old memory", a_cue_brings_back_an_old_memory)
check("a cue recalls the other recent rounds", a_cue_recalls_the_other_recent_rounds)
check("the threshold drops the faint (not the pinned)", the_threshold_drops_the_faint)
check("her secrets are in the context", her_secrets_are_in_context)
check("the brief stays within 6 KB", the_brief_stays_within_budget)
check("mentioning it makes it stronger", mentioning_it_makes_it_stronger)
check("a long absence keeps the day for its summary", a_long_absence_keeps_the_day_for_its_summary)
check("a busy day is summarised whole", a_busy_day_is_summarised_whole)
check("the brief stays small while a summary is due", the_brief_stays_small_while_a_summary_is_due)
check("migrating in the morning keeps today in the past", migrating_in_the_morning_keeps_today_in_the_past)
check("saving unchanged fields is not an edit", saving_unchanged_fields_is_not_an_edit)
check("long ASCII words are clipped", long_ascii_words_are_clipped)
check("a request with nothing left is dropped", a_request_with_nothing_left_is_dropped)
run("memories")
