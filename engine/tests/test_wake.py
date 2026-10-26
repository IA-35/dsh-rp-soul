"""唤醒线（引擎侧）：她自己到点醒来。

两条线各测一遍：纯函数层（候选怎么算、安静时段怎么推、时间怎么换真），
再走 sidecar（plan_next 记进账本、next-wake 读出来、together 回合的门禁）。
"""

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import e2e
import fixture
from harness import check, raises, run
from stdio import Sidecar
from rp_soul_engine import opening
from rp_soul_engine.domain import clock as CL
from rp_soul_engine import persona as PE
from rp_soul_engine.domain import structure as ST
from rp_soul_engine.domain import wake as WK

DATA = e2e.temp_dir()
TZ = timezone(timedelta(hours=8))
NOW = "2026-10-26T21:00:00+08:00"


def fresh(now=NOW):
    """A brand-new state at a known wall-clock moment."""
    validated, errors = PE.validate(dict(fixture.PERSONA))
    assert not errors, errors
    state, _ = opening.new_session(validated, seed=7, now=now)
    return state


def with_sc(fn):
    def inner():
        with Sidecar(DATA) as s:
            fn(s)

    return inner


def wake_of(state, **kwargs):
    persona, errors = PE.validate(dict(fixture.PERSONA))
    assert not errors, errors
    return WK.next_wake(state, persona, **kwargs)


def her_action(text="她把水杯洗干净，倒扣在架子上。"):
    return {"op": "npc_action", "kind": "observe", "action": text, "significant": False,
            "basis_fact_ids": []}


# ---------------------------------------------------------------------------
# 安静时段


def quiet_parsing():
    assert WK.parse_quiet("00:00-08:00") == (0, 480), WK.parse_quiet("00:00-08:00")
    assert WK.parse_quiet("23:30-07:00") == (1410, 420)
    assert WK.parse_quiet("") is None
    assert WK.parse_quiet("bogus") is None
    assert WK.parse_quiet("08:00-08:00") is None


def quiet_window_wraps_midnight():
    quiet = WK.parse_quiet("23:30-07:00")
    assert WK.in_quiet({"day": 1, "minute": 1430}, quiet)
    assert WK.in_quiet({"day": 1, "minute": 60}, quiet)
    assert not WK.in_quiet({"day": 1, "minute": 720}, quiet)
    assert WK.quiet_end({"day": 1, "minute": 1430}, quiet) == {"day": 2, "minute": 420}
    assert WK.quiet_end({"day": 1, "minute": 720}, quiet) == {"day": 1, "minute": 720}
    assert WK.quiet_end({"day": 1, "minute": 60}, quiet) == {"day": 1, "minute": 420}


# ---------------------------------------------------------------------------
# 候选


def plan_candidate_wins_when_soonest():
    state = fresh()
    state["plan"] = {"note": "去洗澡", "until": {"day": 1, "minute": 1290}, "set_turn": 1}
    pick, rows = wake_of(state, miss_you_hours=0, routine=False)
    assert pick["reason"] == "plan", rows
    assert pick["why"] == "这是我说好做到的时间：去洗澡", pick
    assert pick["label"] == "她说好做到的时间"


def plan_is_cleared_by_null():
    state = fresh()
    state["plan"] = {"note": "去洗澡", "until": {"day": 1, "minute": 1290}, "set_turn": 1}
    state["plan"] = None
    pick, rows = wake_of(state, miss_you_hours=0, routine=False)
    assert pick is None and rows == []


def miss_you_grows_with_streak():
    state = fresh()
    state["last_player_at"] = state["real_at"]
    pick, _ = wake_of(state, miss_you_hours=6, routine=False, now=CL.parse_iso(NOW))
    assert pick["reason"] == "miss_you"
    assert pick["hours"] == 6, pick
    assert "6 小时没说话" in pick["why"], pick
    pick2, _ = wake_of(state, miss_you_hours=6, streak=2, routine=False, now=CL.parse_iso(NOW))
    assert pick2["hours"] == 24, pick2


def miss_you_off_when_zero():
    state = fresh()
    state["last_player_at"] = state["real_at"]
    pick, rows = wake_of(state, miss_you_hours=0, routine=False)
    assert pick is None and rows == []


def promise_wakes_half_an_hour_early():
    state = fresh()
    state["events"]["e1"] = {
        "id": "e1", "kind": "promise", "title": "陪她去看海", "text": "",
        "tier": "near", "state": "pending", "due": {"day": 3, "minute": 600},
        "participants": [state["player_id"], "lin_wan"], "turn": 1,
        "outcome": None, "resolved_turn": None, "note": None, "probability": None,
        "dedupe_key": None, "coord": [1, 1], "repeat": None,
    }
    pick, _ = wake_of(state, miss_you_hours=0, routine=False)
    assert pick["reason"] == "promise", pick
    assert pick["at"] == {"day": 3, "minute": 570}, pick
    assert "还有半小时" in pick["why"], pick


def own_business_wakes_on_time():
    state = fresh()
    state["events"]["e2"] = {
        "id": "e2", "kind": "deadline", "title": "交班", "text": "",
        "tier": "near", "state": "pending", "due": {"day": 1, "minute": 1380},
        "participants": ["lin_wan"], "turn": 1,
        "outcome": None, "resolved_turn": None, "note": None, "probability": None,
        "dedupe_key": None, "coord": [1, 1], "repeat": None,
    }
    pick, _ = wake_of(state, miss_you_hours=0, routine=False)
    assert pick["reason"] == "event", pick
    assert pick["at"] == {"day": 1, "minute": 1380}, pick


def routine_wakes_at_next_segment():
    persona, _ = PE.validate(dict(fixture.PERSONA))
    persona["routine"] = [
        {"from": 480, "to": 1079, "doing": "在诊所上班"},
        {"from": 1080, "to": 479, "doing": "回家休息"},
    ]
    state = fresh()
    assert state["clock"]["minute"] == 1260, state["clock"]
    pick, _ = WK.next_wake(state, persona, miss_you_hours=0)
    assert pick["reason"] == "routine", pick
    assert pick["at"] == {"day": 2, "minute": 480}, pick
    assert "08:00" in pick["why"], pick


def quiet_hours_hold_back_everything_but_her_plan():
    state = fresh()
    state["clock"] = {"day": 1, "minute": 60}
    persona, _ = PE.validate(dict(fixture.PERSONA))
    persona["routine"] = [{"from": 30, "to": 479, "doing": "在诊所上班"}]
    pick, _ = WK.next_wake(state, persona, miss_you_hours=0, quiet_text="00:00-08:00")
    assert pick["reason"] == "routine", pick
    # 现在 01:00，00:30 那一段已经开始了，下一次换段是明天 00:30，被安静时段推到 08:00
    assert pick["at"] == {"day": 2, "minute": 480}, pick
    assert pick.get("quiet_shifted") is True, pick
    assert "08:00" in pick["why"], pick
    state["plan"] = {"note": "写病历", "until": {"day": 1, "minute": 90}, "set_turn": 1}
    pick2, _ = WK.next_wake(state, persona, miss_you_hours=0, quiet_text="00:00-08:00")
    assert pick2["reason"] == "plan", pick2
    assert pick2["at"] == {"day": 1, "minute": 90}, pick2


def paused_means_no_candidates():
    state = fresh()
    state["safety"]["paused"] = True
    state["last_player_at"] = state["real_at"]
    pick, rows = wake_of(state)
    assert pick is None and rows == []


def real_time_conversion_matches_clock():
    state = fresh()
    assert WK.to_real(state, state["clock"]) == "2026-10-26T21:00:00+08:00"
    later = CL.add_minutes(state["clock"], 90)
    assert WK.to_real(state, later) == "2026-10-26T22:30:00+08:00"
    assert WK._clock_at_real(state, CL.parse_iso("2026-10-26T22:30:00+08:00")) == later


# ---------------------------------------------------------------------------
# sidecar：plan_next / next-wake / together


def plan_next_is_recorded(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "plan_next", "note": "去洗澡", "in_minutes": 30}])
    data = s.ok("commit-turn", body)
    plan = s.ok("next-wake", {"session_id": sid})["plan"]
    assert plan["note"] == "去洗澡", plan
    assert plan["set_turn"] == 1, plan
    later = CL.add_minutes(data["turns"][0]["applied"][-1]["until"], 0)
    assert plan["until"] == later, plan


def plan_next_until_form(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "plan_next", "note": "看书", "until": "23:40"}])
    s.ok("commit-turn", body)
    plan = s.ok("next-wake", {"session_id": sid})["plan"]
    assert plan["until"]["minute"] == 23 * 60 + 40, plan
    assert plan["until_label"].endswith("23:40"), plan


def plan_next_needs_exactly_one_time(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "plan_next", "note": "睡觉"}])
    err = s.fail("commit-turn", body)
    assert "in_minutes 与 until" in err["message"], err
    body2 = e2e.commit({"session_id": sid, "revision": rev},
                       ops=[{"op": "plan_next", "note": "睡觉", "in_minutes": 30, "until": "23:00"}])
    err2 = s.fail("commit-turn", body2)
    assert "in_minutes 与 until" in err2["message"], err2


def plan_shows_in_context(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "plan_next", "note": "去洗澡", "in_minutes": 45}])
    s.ok("commit-turn", body)
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief"})["context"]
    plan = ctx["companion"].get("plan")
    assert plan and plan["note"] == "去洗澡", ctx["companion"]
    assert plan["until_label"], plan


def next_wake_lists_the_plan_first(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "plan_next", "note": "去洗澡", "in_minutes": 30}])
    s.ok("commit-turn", body)
    out = s.ok("next-wake", {"session_id": sid, "miss_you_hours": 0, "routine": False})
    assert out["next"]["reason"] == "plan", out["next"]
    assert out["next"]["at_real"].endswith("+08:00"), out["next"]
    assert out["paused"] is False
    assert out["clock"]["label"]


def next_wake_is_read_only(s):
    sid, rev, _ = e2e.start(s)
    out = s.ok("next-wake", {"session_id": sid})
    again = s.ok("next-wake", {"session_id": sid})
    for key in ("revision", "clock", "plan", "candidates", "next", "paused"):
        assert out[key] == again[key], "%s 变了：next-wake 不该改任何东西" % key
    status = s.ok("status", {"session_id": sid, "level": "brief"})
    assert status["revision"] == 1, status
def together_false_blocks_player_side_ops(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "npc_response", "response": "genuine", "note": "嗯。"}],
                      together=False)
    err = s.fail("commit-turn", body)
    assert err["code"] == "INVARIANT_VIOLATION", err
    assert "你不在场" in err["message"], err
    assert "等你回来" in err["details"][0]["hint"], err


def together_false_rejects_player_modes(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[her_action()], mode="result", player_input="我回来了。", together=False)
    err = s.fail("commit-turn", body)
    assert "只能是她自己的时间" in err["message"], err


def together_false_allows_her_own_time(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=[her_action()], together=False)
    data = s.ok("commit-turn", body)
    assert data["revision"] == rev + 1, data
    moods = s.ok("debug-mood", {"session_id": sid})
    labels = [t["label"] for t in moods["thoughts"]]
    assert "你不在" in labels, labels
    assert "在场" not in labels, labels


def player_input_records_the_last_word(s):
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev}, ops=[her_action()],
                      player_input="我先去睡了。")
    s.ok("commit-turn", body)
    out = s.ok("next-wake", {"session_id": sid, "miss_you_hours": 6})
    assert out["next"]["reason"] == "miss_you", out["next"]
    assert out["next"]["hours"] == 6, out["next"]


def old_state_without_plan_still_reads(s):
    """旧存档没有 plan 这个键：next-wake 不能因此炸掉。"""
    sid, rev, _ = e2e.start(s)
    out = s.ok("next-wake", {"session_id": sid})
    assert out["plan"] is None, out


def old_state_without_real_at_still_wakes():
    """迁移来的存档没有 real_at / real_start：时钟站在此刻，想你了照样能算出来。"""
    state = fresh()
    for key in ("real_at", "real_start"):
        state.pop(key, None)
    now = datetime(2026, 10, 26, 21, 0, tzinfo=TZ)
    pick, rows = WK.next_wake(state, None, 6, 0, True, ST.WAKE_QUIET, now)
    miss = [row for row in rows if row["reason"] == "miss_you"]
    assert miss, rows
    at = CL.parse_iso(miss[0]["at_real"])
    assert at == now + timedelta(hours=6), miss[0]
    # 没有 real_at 时，别的候选（比如她自己的安排）也要照样有真实时刻
    state["plan"] = {"note": "去洗澡", "until": CL.add_minutes(state["clock"], 20), "set_turn": 1}
    pick, rows = WK.next_wake(state, None, 6, 0, True, ST.WAKE_QUIET, now)
    assert pick["reason"] == "plan", pick
    assert CL.parse_iso(pick["at_real"]) == now + timedelta(minutes=20), pick


def a_quiet_commit(ops):
    return {
        "action_mode": "continue",
        "player_input": "",
        "player_authorized": False,
        "acts_on_her": None,
        "operations": ops,
        "content_tags": [],
        "summary": "她把水杯洗干净。",
        "open_action": "她擦干手。",
        "quotes": [],
        "memory_summary": None,
        "memory_archive": None,
        "replaces_turn": None,
        "together": True,
    }


def plan_is_dropped_once_it_is_done():
    """安排的时间已经过去：这条安排就算做完了，不能拿它反复叫醒她。"""
    from rp_soul_engine.domain import turn as TN

    state = fresh()
    persona, _ = PE.validate(dict(fixture.PERSONA))
    # 开局 21:00；安排说好 20:50，已经过去了
    state["plan"] = {"note": "去洗澡", "until": {"day": 1, "minute": 1250}, "set_turn": 0}
    after, _ = TN.commit_turn(state, persona, a_quiet_commit([her_action()]),
                             now="2026-10-26T21:30:00+08:00")
    assert after["plan"] is None, after.get("plan")


def plan_survives_a_turn_that_ends_before_its_time():
    from rp_soul_engine.domain import turn as TN

    state = fresh()
    persona, _ = PE.validate(dict(fixture.PERSONA))
    # 安排说好 22:30，这一回合 21:30 结束：还没到，留着
    state["plan"] = {"note": "去洗澡", "until": {"day": 1, "minute": 1350}, "set_turn": 0}
    after, _ = TN.commit_turn(state, persona, a_quiet_commit([her_action()]),
                             now="2026-10-26T21:30:00+08:00")
    assert after["plan"] and after["plan"]["note"] == "去洗澡", after.get("plan")


CASES = [
    ("安静时段解析", quiet_parsing),
    ("安静时段跨午夜", quiet_window_wraps_midnight),
    ("她说好的时间排在最前", plan_candidate_wins_when_soonest),
    ("plan 置空就没有候选", plan_is_cleared_by_null),
    ("想你了按 6/12/24 拉长", miss_you_grows_with_streak),
    ("想你了可以关掉", miss_you_off_when_zero),
    ("约定提前半小时叫", promise_wakes_half_an_hour_early),
    ("她自己的事到点叫", own_business_wakes_on_time),
    ("作息换段叫", routine_wakes_at_next_segment),
    ("安静时段只挡不是她安排的", quiet_hours_hold_back_everything_but_her_plan),
    ("暂停时不叫", paused_means_no_candidates),
    ("游戏时钟换真实时间", real_time_conversion_matches_clock),
    ("plan_next 记进账本", with_sc(plan_next_is_recorded)),
    ("plan_next 的 until 形态", with_sc(plan_next_until_form)),
    ("plan_next 时间二选一", with_sc(plan_next_needs_exactly_one_time)),
    ("上下文看得见她的安排", with_sc(plan_shows_in_context)),
    ("next-wake 把安排排第一", with_sc(next_wake_lists_the_plan_first)),
    ("next-wake 只读", with_sc(next_wake_is_read_only)),
    ("together 关掉时不能给回应", with_sc(together_false_blocks_player_side_ops)),
    ("together 关掉时不能是玩家的回合", with_sc(together_false_rejects_player_modes)),
    ("together 关掉时她过自己的时间", with_sc(together_false_allows_her_own_time)),
    ("你说过话的时刻被记下", with_sc(player_input_records_the_last_word)),
    ("旧存档没有 plan 也能读", with_sc(old_state_without_plan_still_reads)),
    ("迁移来的存档没有 real_at 也能算", old_state_without_real_at_still_wakes),
    ("安排做完了就清掉", plan_is_dropped_once_it_is_done),
    ("安排没到点就留着", plan_survives_a_turn_that_ends_before_its_time),
]

for name, fn in CASES:
    check(name, fn)

run("wake")
