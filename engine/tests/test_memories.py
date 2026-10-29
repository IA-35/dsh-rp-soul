"""她的记忆：ABM / SCM / CLPA 三层，加一份落盘的日记。

直接调领域层、显式给时间：ABM 只管记不管注入，满了或者搁置一小时由子代理收成
一条 SCM；SCM 约一个月被忘、满了淘汰最不活跃的；CLPA 永不淡忘，只能你手动删；
日记是文件，写它不删 SCM。
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


def play(state, persona, now, **kw):
    """一回合一条记录：提交后像 close_record 一样算出下一条记录要交的请求。"""
    new = commit(state, persona, now, **kw)
    TU.close_record(new, [{"crossed_day": new["clock"]["day"] > state["clock"]["day"]}])
    return new


# ---------------------------------------------------------------------------
# ABM：只管记


def a_turn_is_remembered_in_abm():
    state, persona = start()
    state = commit(state, persona, at(0), player_input="今晚雨好大", quotes=["伞给你"],
                   remember="他冒雨来了，我其实挺高兴")
    entry = main_entry(state, 1)
    assert entry["layer"] == "abm" and entry["type"] == "conversation", entry
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


def abm_is_never_injected():
    """ABM 不注入：刚说的话还在对话里，再捞一遍只是把转写重复一次。"""
    state, persona = start()
    state = commit(state, persona, at(0), player_input="今晚雨好大")
    assert MEM.of_layer(state, "abm"), "记下了"
    assert MEM.inject(state, "今晚雨真大") == [], "但不进上下文"


def a_passing_action_is_dropped_after_a_day():
    state, persona = start()
    state = commit(state, persona, at(0))
    action = [e for e in MEM.entries(state) if e["type"] == "action"][0]
    state["clock"] = CL.from_abs(CL.to_abs(state["clock"]) + 25 * 60)
    report = MEM.maintain(state)
    assert action["id"] in report["dropped"], report
    assert layer_of(state, action["id"]) is None


# ---------------------------------------------------------------------------
# ABM -> SCM：满了或者搁置一小时，收成一条


def passing_actions_do_not_bloat_abm():
    """过场的动作也记在 ABM 里，但它们不该把这一层撑过二十条。"""
    state, persona = start()
    for i in range(MEM.CAPACITY["abm"]):
        MEM.add(state, "abm", "conversation", "第%d句" % i, 0.5, turn=i + 1)
    for i in range(5):
        MEM.add(state, "abm", "action", "她应了一声", 0.2, turn=MEM.CAPACITY["abm"] + 1)
    report = MEM.maintain(state)
    assert len(report["dropped"]) == 5, report
    assert len(MEM.of_layer(state, "abm")) == MEM.CAPACITY["abm"]
    # 被挤掉的只是动作，能收的那批原封不动
    request = MEM.abm_batch(state)
    assert request and len(request["ids"]) == MEM.CAPACITY["abm"], request


def a_full_abm_asks_to_be_folded():
    """ABM 满 20 条就要收成一条 SCM。"""
    state, persona = start()
    for i in range(MEM.CAPACITY["abm"] + 1):
        state = commit(state, persona, at(0.01 * i), remember="第%d件事" % i)
    request = MEM.abm_batch(state)
    # 刚记下的那一回合留到下一批，所以正好是满员那 20 条
    assert request and len(request["ids"]) == MEM.CAPACITY["abm"], request


def a_quiet_hour_asks_to_be_folded():
    """不满也要收：搁置一小时，这一段就该进 SCM 了。"""
    state, persona = start()
    state = play(state, persona, at(0), remember="他说今晚会来")
    assert state["requests"]["memory_fold"] is None, "刚聊完不收"
    state = play(state, persona, at(0.02), remember="他走了")
    state = play(state, persona, at(1.5), ops=[beat(), glance()])
    request = MEM.abm_batch(state)
    assert request and len(request["ids"]) == 2, request


def the_fold_makes_one_scm_and_clears_the_batch():
    state, persona = start()
    state = play(state, persona, at(0), remember="他说今晚会来")
    state = play(state, persona, at(0.02), remember="他走了")
    state = play(state, persona, at(1.5), ops=[beat(), glance()])
    request = MEM.abm_batch(state)
    assert request
    folded = MEM.apply_fold(state, request, "他那晚说会来，我等着。", 9)
    assert folded["layer"] == "scm" and folded["type"] == "summary", folded
    assert folded["origin_ids"] == request["ids"], folded
    left = [e["id"] for e in MEM.of_layer(state, "abm")]
    assert not set(left) & set(request["ids"]), "那一批清空了，只有刚记的还在"


def a_pinned_milestone_goes_into_clpa():
    """关系推进时自动钉住的那条，不能因为模型没往 memory_keep 里写就被吞掉。"""
    state, persona = start()
    state = play(state, persona, at(0), player_input="那晚我们成了朋友")
    entry = main_entry(state, 1)
    entry["pinned"] = True                     # 里程碑自动 Pin
    state = play(state, persona, at(0.02), remember="他走了")
    state = play(state, persona, at(1.5), ops=[beat(), glance()])
    request = MEM.abm_batch(state)
    MEM.apply_fold(state, request, "那天下雨他来了", 9)
    kept = MEM.of_layer(state, "clpa")
    assert len(kept) == 1 and kept[0]["content"] == entry["content"], kept
    assert kept[0]["pinned"] is True, "留下的那条仍然是钉住的"


def memory_keep_puts_a_line_into_clpa():
    state, persona = start()
    state = play(state, persona, at(0), remember="他说今晚会来")
    entry = main_entry(state, 1)
    state = play(state, persona, at(0.02), remember="他走了")
    state = play(state, persona, at(1.5), ops=[beat(), glance()])
    request = MEM.abm_batch(state)
    MEM.apply_fold(state, request, "那晚他来了。", 9, keep=[entry["id"]])
    kept = MEM.of_layer(state, "clpa")
    assert [e["content"] for e in kept] == ["他说今晚会来"], kept


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
    # 设置页用日期排序：账本按真实分钟走，这个时刻在主人的钟上真的存在过
    # （T0 是 10.26 周一，第 4 天 = 10.29 周四）
    assert MEM.when_label(state, {"day": 4, "minute": 1200}) == "10.29 周四 20:00"
    assert MEM.when_label(state, {"day": 3, "minute": 60}) == "10.28 周三 01:00"
    assert MEM.when_label(state, {"day": 1, "minute": 1230}) == "10.26 周一 20:30"
    # 注入只说周几和钟点：几号在条目里，不该再念一遍
    assert MEM.when_short(state, {"day": 4, "minute": 840}) == "周四下午 14:00"
    assert MEM.when_short(state, {"day": 3, "minute": 60}) == "周三凌晨 01:00"
    # 没有 real_start（老存档）就退回相对日子，钟点仍然是真
    state["real_start"] = None
    assert MEM.when_label(state, {"day": 2, "minute": 605}) == "前天 10:05"
    assert MEM.when_short(state, {"day": 2, "minute": 605}) == "前天上午 10:05"


# ---------------------------------------------------------------------------
# SCM：约一个月淡掉，满了淘汰最不活跃的


def scm_is_forgotten_in_about_a_month():
    state, persona = start()
    entry = MEM.add(state, "scm", "summary", "那天一起吃了面", 0.5)
    start_minute = entry["t0"]
    assert MEM.activity(entry, start_minute + 29 * 24 * 60) > MEM.CLEAN_BELOW
    assert MEM.activity(entry, start_minute + 31 * 24 * 60) < MEM.CLEAN_BELOW
    state["clock"] = CL.from_abs(start_minute + 31 * 24 * 60)
    report = MEM.maintain(state)
    assert entry["id"] in report["forgotten"], report


def clpa_never_fades():
    """CLPA 不衰减，只能你手动删。"""
    state, persona = start()
    entry = MEM.add(state, "clpa", "summary", "那年秋天", 0.5, at={"day": 1, "minute": 600})
    state["clock"] = {"day": 2000, "minute": 600}
    assert MEM.activity(entry, CL.to_abs(state["clock"])) == 1.0
    report = MEM.maintain(state)
    assert entry["id"] not in report["forgotten"] and entry in MEM.entries(state)


def pinned_is_never_forgotten():
    state, persona = start()
    entry = MEM.add(state, "scm", "conversation", "第一次见面", 0.5, pinned=True)
    state["clock"] = CL.from_abs(entry["t0"] + 400 * 24 * 60)
    report = MEM.maintain(state)
    assert entry["id"] not in report["forgotten"] and MEM.activity(entry, CL.to_abs(state["clock"])) == 1.0


def scm_capacity_drops_the_least_active():
    state, persona = start()
    first = MEM.add(state, "scm", "summary", "最早的事", 0.5)
    state["clock"] = CL.add_minutes(state["clock"], 60)
    rest = [MEM.add(state, "scm", "summary", "第%d件事" % i, 0.5) for i in range(MEM.CAPACITY["scm"])]
    report = MEM.maintain(state)
    assert first["id"] in report["forgotten"], report
    assert len(MEM.of_layer(state, "scm")) == MEM.CAPACITY["scm"] and rest[-1] in MEM.entries(state)


# ---------------------------------------------------------------------------
# 日记：23:30 从这一天的 SCM 写一份文件，不删 SCM


def a_day_of_scm_asks_for_a_diary_after_half_past_eleven():
    """日记是定时任务：白天不催，23:30 之后才要一篇。"""
    state, persona = start()
    today = MEM.add(state, "scm", "summary", "今天一起吃了面", 0.9)
    assert MEM.diary_request(state) is None, "白天不要日记"
    state["clock"] = {"day": state["clock"]["day"], "minute": MEM.DIARY_MINUTE}
    request = MEM.diary_request(state)
    assert request and request["day"] == state["clock"]["day"], request
    assert request["ids"] == [today["id"]], request


def the_diary_keeps_scm_and_remembers_the_day():
    state, persona = start()
    today = MEM.add(state, "scm", "summary", "今天一起吃了面", 0.9)
    state["clock"] = {"day": state["clock"]["day"], "minute": MEM.DIARY_MINUTE}
    request = MEM.diary_request(state)
    done = MEM.apply_diary(state, request, "今天他来了，我们一起吃了面。")
    assert done["day"] == state["clock"]["day"] and done["ids"] == [today["id"]], done
    assert today in MEM.entries(state), "写日记不删 SCM"
    assert today["diary_day"] == state["clock"]["day"], today
    assert state["counters"]["last_diary_day"] == state["clock"]["day"]
    md = done["markdown"]
    assert md.startswith("# 第 1 天") and "我们一起吃了面" in md, md


def a_day_missed_at_2330_is_still_owed_tomorrow():
    """23:30 那会儿没人说话，第二天醒来也得把昨天补上，不能白丢。"""
    state, persona = start()
    MEM.add(state, "scm", "summary", "昨天一起吃了面", 0.9, at={"day": 1, "minute": 1300})
    state["clock"] = {"day": 3, "minute": MEM.DIARY_MINUTE}
    request = MEM.diary_request(state)
    assert request and request["day"] == 1, request
    MEM.apply_diary(state, request, "昨天他来了。")
    assert MEM.diary_request(state) is None, "补完之后不再重复要"


def a_day_missed_at_2330_is_still_owed_in_the_morning():
    """23:30 那会儿没写，过了午夜也还欠着，不能等到下一个 23:30。"""
    state, persona = start()
    MEM.add(state, "scm", "summary", "昨天一起吃了面", 0.9, at={"day": 1, "minute": 1300})
    state["clock"] = {"day": 2, "minute": 10}
    request = MEM.diary_request(state)
    assert request and request["day"] == 1, request


def the_same_day_is_not_written_twice():
    state, persona = start()
    MEM.add(state, "scm", "summary", "今天一起吃了面", 0.9)
    state["clock"] = {"day": state["clock"]["day"], "minute": MEM.DIARY_MINUTE}
    MEM.apply_diary(state, MEM.diary_request(state), "今天他来了。")
    MEM.add(state, "scm", "summary", "临睡前又聊了两句", 0.5,
            at={"day": state["clock"]["day"], "minute": MEM.DIARY_MINUTE + 10})
    assert MEM.diary_request(state) is None, "一天只写一次，后加的不再补"


def written_scm_does_not_block_the_next_days_diary():
    state, persona = start()
    MEM.add(state, "scm", "summary", "第一天一起吃面", 0.9)
    state["clock"]["minute"] = MEM.DIARY_MINUTE
    MEM.apply_diary(state, MEM.diary_request(state), "第一天你来了。")
    for day in (2, 3):
        state["clock"] = {"day": day, "minute": MEM.DIARY_MINUTE}
        today = MEM.add(state, "scm", "summary", "今天也一起吃了饭", 0.8)
        request = MEM.diary_request(state)
        assert request and request["day"] == day and request["ids"] == [today["id"]], request
        MEM.apply_diary(state, request, "今天又见到你了。")
        assert MEM.diary_request(state) is None


def an_empty_day_asks_for_nothing():
    state, persona = start()
    assert MEM.diary_request(state) is None


# ---------------------------------------------------------------------------
# 迁移


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
    assert by["我们是在雨夜认识的"]["layer"] == "clpa"
    assert by["第二天一起吃了面"]["layer"] == "clpa"
    assert by["吃面"]["summarized"] is True, "covered by the chapter"
    assert by["她生气了"]["summarized"] is False and by["她生气了"]["quotes"] == ["走开"]
    assert by["和好了"]["layer"] == "abm" and by["她生气了"]["layer"] == "scm"
    assert new["requests"] == {"memory_fold": None, "memory_diary": None}
    assert "last_chapter_turn" not in new["counters"] and new["counters"]["next"]["memory"] == 6
    assert MG.state_v2_to_v3(new) is new, "a schema-3 state passes through"


def migrating_in_the_morning_keeps_today_in_the_past():
    """早上 8 点升级，今天的旧回合不能落在中午（未来）、压过之后的新对话。"""
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
    newest = [e["content"] for e in MEM.of_layer(new, "abm") if e["type"] in MEM.KEEPS][-3:]
    assert newest == ["新回合0", "新回合1", "新回合2"], newest


# ---------------------------------------------------------------------------
# 注入：从 SCM / CLPA 取几条最相关的


def the_most_relevant_scm_lines_come_back():
    state, persona = start()
    sea = MEM.add(state, "scm", "summary", "那天我们去看海，风很大", 0.3, at={"day": 1, "minute": 600})
    MEM.add(state, "scm", "summary", "那天吃了一碗面", 0.3, at={"day": 1, "minute": 600})
    state["clock"] = {"day": 3, "minute": 600}
    quiet = MEM.select(state, "", MEM.SCM_BRIEF)
    cued = MEM.select(state, "还记得看海那次吗", MEM.SCM_BRIEF)
    assert cued and cued[0]["id"] == sea["id"], [e["content"] for e in cued]
    now = CL.to_abs(state["clock"])
    assert MEM.score(sea, now, MEM.cue_keywords(state, "还记得看海那次吗"), "together") > \
        MEM.score(sea, now, MEM.cue_keywords(state, ""), "together")
    assert quiet[0]["id"] != sea["id"], "without the cue the two tie and nothing pulls the sea forward"


def only_a_few_lines_are_carried():
    """brief 三条、完整五条：取回的越多，越是把上下文塞满。"""
    state, persona = start()
    for i in range(12):
        MEM.add(state, "scm", "summary", "第%d件旧事" % i, 0.5)
    assert len(MEM.inject(state, "", MEM.SCM_BRIEF)) == MEM.SCM_BRIEF
    assert len(MEM.inject(state, "", MEM.SCM_FULL)) == MEM.SCM_FULL


def each_line_carries_its_age():
    """SCM 是「多久前的记忆」：没有时间的记忆会读成刚发生的。"""
    state, persona = start()
    MEM.add(state, "scm", "summary", "那天一起看海", 0.5, at={"day": 1, "minute": 600})
    state["clock"] = {"day": 4, "minute": 600}
    rows = MEM.inject(state, "", MEM.SCM_BRIEF)
    assert rows and rows[0]["when"] == "周一上午 10:00", rows


def each_line_says_how_well_she_remembers_it():
    """四档：记忆犹新 / 大概记得 / 有些模糊了 / 记不起来了。"""
    state, persona = start()
    assert [MEM.clearness(v) for v in (1.0, 0.7, 0.5, 0.4, 0.2, 0.1, 0.05, 0.0)] == [
        "记忆犹新", "记忆犹新", "大概记得", "大概记得",
        "有些模糊了", "有些模糊了", "记不起来了", "记不起来了",
    ]
    fresh = MEM.add(state, "scm", "summary", "刚说完的话", 0.5, at={"day": 4, "minute": 600})
    old_one = MEM.add(state, "scm", "summary", "很久以前的事", 0.5, at={"day": 1, "minute": 600})
    MEM.touch(old_one, MEM.CL.to_abs({"day": 1, "minute": 600}), 0.3)
    state["clock"] = {"day": 4, "minute": 600}
    rows = {row["text"]: row["clear"] for row in MEM.inject(state, "", MEM.SCM_FULL)}
    assert rows["刚说完的话"] == "记忆犹新", rows
    assert rows["很久以前的事"] == "有些模糊了", rows


def the_threshold_drops_the_faint():
    state, persona = start()
    faint = MEM.add(state, "scm", "summary", "很久以前的一件小事", 0.02, at={"day": 1, "minute": 0})
    MEM.touch(faint, faint["t0"], 0.03)
    state["clock"] = {"day": 200, "minute": 0}
    assert faint not in MEM.select(state, "", MEM.SCM_BRIEF), "below 0.15 it is not brought up"
    faint["pinned"] = True
    assert faint in MEM.select(state, "", MEM.SCM_BRIEF), "a pinned memory always clears the threshold"


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
        MEM.add(state, "clpa", "summary", "那些日子里第%d件事，" % i + "细节" * 60, 0.9, pinned=True)
    ctx = CX.brief(state, persona, cue="细节")
    assert ctx["size_bytes"] <= 6 * 1024, ctx["size_bytes"]
    assert all(len(r["text"]) <= MEM.TEXT_MAX for r in ctx["memories"])


def mentioning_it_makes_it_stronger():
    state, persona = start()
    sea = MEM.add(state, "scm", "conversation", "那天我们去看海", 0.3)
    for i in range(9):
        MEM.add(state, "scm", "conversation", "别的事%d" % i, 0.3)
    state["real_at"] = at(0)
    later = commit(state, persona, at(0.5), player_input="想再去看海", ops=[beat(), glance()])
    plain = commit(state, persona, at(0.5), player_input="今天好累", ops=[beat(), glance()])
    now = CL.to_abs(later["clock"])
    strong = [e for e in MEM.entries(later) if e["id"] == sea["id"]][0]
    weak = [e for e in MEM.entries(plain) if e["id"] == sea["id"]][0]
    assert MEM.activity(strong, now) > MEM.activity(weak, now), (MEM.activity(strong, now), MEM.activity(weak, now))


# ---------------------------------------------------------------------------
# 审查发现的问题（回归测试）


def an_exchange_is_noted_without_the_model():
    """模型不交账也要记：宿主把两边的原话递过来，这里自己写成一条 ABM。"""
    state, persona = start()
    entry, duplicate = MEM.note_exchange(state, "灯还亮着吗", "亮着。你回来晚了。", turn=state["turn"])
    assert entry is not None and not duplicate, (entry, duplicate)
    assert entry["layer"] == "abm" and entry["type"] == "conversation", entry
    assert entry["content"] == "你：灯还亮着吗 她：亮着。你回来晚了。", entry["content"]
    assert entry["you"] == "灯还亮着吗", entry["you"]
    assert entry["exchanged"] is True, entry
    # 同一条再说一次不算新的一条：宿主会在重试时重发
    again, duplicate = MEM.note_exchange(state, "灯还亮着吗", "亮着。你回来晚了。", turn=state["turn"])
    assert duplicate and again["id"] == entry["id"], (again["id"], entry["id"])
    assert len(MEM.of_layer(state, "abm")) == 1, MEM.of_layer(state, "abm")


def noted_exchanges_still_reach_the_fold():
    """宿主记的那些带着同一个 turn 号，不能因此永远收不进 SCM。"""
    state, _persona = start()
    for i in range(MEM.CAPACITY["abm"]):
        MEM.note_exchange(state, "第%d句" % i, "嗯。", turn=state["turn"])
    request = MEM.abm_batch(state)
    assert request and len(request["ids"]) == MEM.CAPACITY["abm"], request


def an_alone_exchange_is_an_experience():
    """她一个人醒着的时候没有「你说的话」，那条要落成 experience。"""
    state, _persona = start()
    entry, _duplicate = MEM.note_exchange(state, "", "她把灯芯剪短了一截。", turn=state["turn"], together=False)
    assert entry is not None and entry["type"] == "experience", entry
    assert entry["content"] == "她把灯芯剪短了一截。", entry["content"]


def an_empty_exchange_writes_nothing():
    """一句话都没有就别写：空白条目会白占 ABM 的位置。"""
    state, _persona = start()
    entry, duplicate = MEM.note_exchange(state, "   ", "", turn=state["turn"])
    assert entry is None and not duplicate, (entry, duplicate)
    assert MEM.of_layer(state, "abm") == [], MEM.of_layer(state, "abm")


def a_busy_day_stays_whole_until_the_fold():
    """一天聊了 26 回合，收进 SCM 之前一条都不能丢。"""
    state, persona = start()
    for i in range(26):
        state = commit(state, persona, at(0.01 * i), remember="第%d件事" % i)
    request = MEM.abm_batch(state)
    texts = " ".join(e["content"] for e in MEM.sources(state, request))
    missing = [i for i in range(25) if ("第%d件事" % i) not in texts]
    assert not missing, "收进 SCM 的那一批要一个字不少：%s" % missing


def the_brief_stays_small_while_a_fold_is_due():
    """待交的汇总 / 日记不能把 brief 撑过 6 KB、把记忆挤没。"""
    from rp_soul_engine.projections import context as CX
    state, persona = start()
    for i in range(21):
        MEM.add(state, "abm", "conversation", "那天发生的第%d件事，" % i + "细节" * 55, 0.5,
                at={"day": 1, "minute": 600})
    for i in range(50):
        MEM.add(state, "clpa", "summary", "第%d天，" % i + "点滴" * 38, 0.5)
    state["clock"] = {"day": 20, "minute": 600}
    state["requests"]["memory_fold"] = MEM.abm_batch(state)
    state["clock"] = {"day": state["clock"]["day"], "minute": MEM.DIARY_MINUTE}
    state["requests"]["memory_diary"] = MEM.diary_request(state)
    brief = CX.brief(state, persona, cue="细节")
    assert brief["size_bytes"] <= 6 * 1024, brief["size_bytes"]
    assert brief["memories"], "memories survive the budget"
    assert brief["memory_fold_sources"]["more"] == 9 and len(brief["memory_fold_sources"]["sources"]) == 12
    full = CX.full(state, persona, cue="细节")
    assert len(full["memory_fold_sources"]["sources"]) == 21, "the full context has every source"


def saving_unchanged_fields_is_not_an_edit():
    """设置页只改 Pin / 备注，不该算「你改过」（RimTalk 给改过的 +0.3）。"""
    state, persona = start()
    entry = MEM.add(state, "scm", "conversation", "下雨那天", 0.5)
    MEM.edit(state, entry["id"], {"content": "下雨那天", "importance": 0.5, "keywords": list(entry["keywords"]),
                                  "activity": 1.0, "note": "备注", "pinned": True})
    assert entry["edited"] is False and entry["pinned"] is True and entry["note"] == "备注", entry
    MEM.edit(state, entry["id"], {"content": "下雨那天他来了"})
    assert entry["edited"] is True


def long_ascii_words_are_clipped():
    """网址片段之类的长英文词截到 20 个字符，设置页才存得回去。"""
    words = MEM.keywords("看 https://example.com/watch?v=dQw4w9WgXcQ supercalifragilisticexpialidocious")
    assert words and all(len(w) <= MEM.KEYWORD_LEN for w in words), words


def a_request_with_nothing_left_is_dropped():
    state, persona = start()
    entry = MEM.add(state, "scm", "summary", "那些日子", 0.5)
    state["requests"]["memory_diary"] = MEM.diary_request(state)
    MEM.remove(state, entry["id"])          # 你在设置页把它删了
    MEM.prune_requests(state)
    assert state["requests"]["memory_diary"] is None, "a request whose sources are gone has nothing to write"


def keywords_are_bigrams():
    assert MEM.keywords("下雨天") == ["下雨", "雨天"]
    assert MEM.keywords("Rain 很大") == ["很大", "rain"]


check("a turn is remembered in ABM", a_turn_is_remembered_in_abm)
check("without remember the summary is kept", without_remember_the_summary_is_kept)
check("importance follows the turn's feelings", importance_follows_the_feelings)
check("ABM is never injected", abm_is_never_injected)
check("a passing action is dropped after a day", a_passing_action_is_dropped_after_a_day)
check("passing actions do not bloat ABM", passing_actions_do_not_bloat_abm)
check("a full ABM asks to be folded", a_full_abm_asks_to_be_folded)
check("a quiet hour asks to be folded", a_quiet_hour_asks_to_be_folded)
check("the fold makes one SCM and clears the batch", the_fold_makes_one_scm_and_clears_the_batch)
check("a pinned milestone goes into CLPA", a_pinned_milestone_goes_into_clpa)
check("memory_keep puts a line into CLPA", memory_keep_puts_a_line_into_clpa)
check("a stage advance is pinned", a_stage_advance_is_pinned)
check("only the first promise is a milestone", only_the_first_promise_is_a_milestone)
check("a turn alone is an experience", an_alone_turn_is_an_experience)
check("memory follows undo (commit works on a copy)", memory_follows_undo)
check("time labels are lifelike", when_label_is_lifelike)
check("SCM is forgotten in about a month", scm_is_forgotten_in_about_a_month)
check("CLPA never fades", clpa_never_fades)
check("pinned is never forgotten", pinned_is_never_forgotten)
check("SCM over capacity drops the least active", scm_capacity_drops_the_least_active)
check("a day of SCM asks for a diary after 23:30", a_day_of_scm_asks_for_a_diary_after_half_past_eleven)
check("the diary keeps SCM and remembers the day", the_diary_keeps_scm_and_remembers_the_day)
check("a day missed at 23:30 is still owed tomorrow", a_day_missed_at_2330_is_still_owed_tomorrow)
check("a day missed at 23:30 is still owed in the morning", a_day_missed_at_2330_is_still_owed_in_the_morning)
check("the same day is not written twice", the_same_day_is_not_written_twice)
check("written SCM does not block the next day's diary", written_scm_does_not_block_the_next_days_diary)
check("an empty day asks for nothing", an_empty_day_asks_for_nothing)
check("the old chain becomes her memory", the_old_chain_becomes_her_memory)
check("the most relevant SCM lines come back", the_most_relevant_scm_lines_come_back)
check("only a few lines are carried", only_a_few_lines_are_carried)
check("each line carries its age", each_line_carries_its_age)
check("each line says how well she remembers it", each_line_says_how_well_she_remembers_it)
check("the threshold drops the faint (not the pinned)", the_threshold_drops_the_faint)
check("her secrets are in the context", her_secrets_are_in_context)
check("the brief stays within 6 KB", the_brief_stays_within_budget)
check("mentioning it makes it stronger", mentioning_it_makes_it_stronger)
check("an exchange is noted without the model", an_exchange_is_noted_without_the_model)
check("noted exchanges still reach the fold", noted_exchanges_still_reach_the_fold)
check("an alone exchange is an experience", an_alone_exchange_is_an_experience)
check("an empty exchange writes nothing", an_empty_exchange_writes_nothing)
check("a busy day stays whole until the fold", a_busy_day_stays_whole_until_the_fold)
check("the brief stays small while a fold is due", the_brief_stays_small_while_a_fold_is_due)
check("migrating in the morning keeps today in the past", migrating_in_the_morning_keeps_today_in_the_past)
check("saving unchanged fields is not an edit", saving_unchanged_fields_is_not_an_edit)
check("long ASCII words are clipped", long_ascii_words_are_clipped)
check("a request with nothing left is dropped", a_request_with_nothing_left_is_dropped)
check("keywords are two-character pieces", keywords_are_bigrams)
run("memories")
