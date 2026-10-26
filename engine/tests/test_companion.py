"""你我之间的时间：分开一阵再回来时引擎怎么结算（直接调领域层，时间由测试给定）。

sidecar 读的是真实时钟，测不了「隔了一个半小时」；这里把 now 显式传进
commit_turn，覆盖离屏片段的要求、作息回看、「很久没见你」的余韵。
"""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rp_soul_engine import opening
from rp_soul_engine import persona as PE
from rp_soul_engine import schema as S
from rp_soul_engine.domain import simulation as SI
from rp_soul_engine.domain import turn as TU
from rp_soul_engine.errors import AppError
from tests.fixture import PERSONA
from tests.harness import check, run

T0 = "2026-10-26T20:00:00+08:00"
COMMIT = S.Obj(TU.commit_fields())


def persona(**kw):
    raw = copy.deepcopy(PERSONA)
    raw.update(kw)
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    return got


def commit(state, pack, ops, now, **kw):
    raw = {"action_mode": "continue", "player_input": "", "operations": ops, "content_tags": [],
           "summary": "她抬头看了你一眼。", "open_action": "等你开口。"}
    raw.update(kw)
    normalized, errors = S.validate(COMMIT, raw, "$")
    assert normalized is not None, errors
    return TU.commit_turn(state, pack, normalized, now=now)


def glance():
    return {"op": "npc_action", "action": "她抬头看了你一眼。"}


def beat(summary="她去楼下买了杯热豆浆。"):
    return {"op": "offscreen_beat", "summary": summary}


def rejected(fn):
    try:
        fn()
    except AppError as err:
        return err
    raise AssertionError("expected a rejection")


def labels(state):
    return [t["label"] for t in state["characters"]["lin_wan"]["mood"]["thoughts"]]


def an_hour_apart_requires_a_beat():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    err = rejected(lambda: commit(state, pack, [glance()], "2026-10-26T21:30:00+08:00"))
    assert any("必须有一段离屏片段" in d["reason"] for d in err.details), err.details
    preview = err.extra["preview"]
    her = preview["required_beats"][0]
    assert her["npc_id"] == "lin_wan", her
    assert her["routine"] == ["在诊所值夜班"], her


def the_beat_settles_the_time_apart():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    ops = [beat(), glance()]
    new, result = commit(state, pack, ops, "2026-10-26T21:30:00+08:00")
    assert result["simulation"]["offscreen_beats"][0]["summary"] == "她去楼下买了杯热豆浆。", result["simulation"]
    assert result["scene_changed"] is True, result


def a_beat_may_only_say_what_she_alone_knows():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    sub = {"op": "add_fact", "key": "her.call", "text": "她给你打过电话", "scope": "shared", "origin": "observed"}
    err = rejected(lambda: commit(state, pack, [dict(beat(), operations=[sub]), glance()], "2026-10-26T21:30:00+08:00"))
    assert any("离屏时你不在" in d["reason"] for d in err.details), err.details


def a_short_gap_allows_but_does_not_require_a_beat():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    commit(state, pack, [glance()], "2026-10-26T20:20:00+08:00")
    commit(state, pack, [beat(), glance()], "2026-10-26T20:20:00+08:00")


def a_long_absence_lingers():
    """隔了两天才回来：「很久没见你」挂一天，下一句话时还在。"""
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    state, _ = commit(state, pack, [beat(), glance()], "2026-10-28T20:00:00+08:00")
    assert "很久没见你" in labels(state), labels(state)
    state, _ = commit(state, pack, [glance()], "2026-10-28T20:05:00+08:00")
    assert "很久没见你" in labels(state), labels(state)


def routine_between_walks_the_gap():
    card = {"routine": [{"from": 540, "to": 1080, "doing": "上班"}, {"from": 1380, "to": 420, "doing": "睡觉"}]}
    night = SI.routine_between(card, {"day": 1, "minute": 1320}, {"day": 2, "minute": 600})
    assert night == ["睡觉", "上班"], night
    whole = SI.routine_between(card, {"day": 1, "minute": 0}, {"day": 3, "minute": 0})
    assert whole == ["上班", "睡觉"], whole
    assert SI.routine_between(card, {"day": 1, "minute": 0}, {"day": 1, "minute": 0}) == []


def a_frozen_world_asks_for_nothing():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    state["preferences"]["offscreen_simulation"] = False
    commit(state, pack, [glance()], "2026-10-26T23:00:00+08:00")


def only_two_people_on_stage():
    pack = persona()
    state, _ = opening.new_session(pack, seed=7, now=T0)
    assert sorted(state["characters"]) == ["lin_wan", "player"]
    assert state["scene"]["present"] == ["player", "lin_wan"]
    assert state["relationships"]["lin_wan>player"]["stage"] == "stranger"
    familiar = persona(start_stage="familiar")
    state, _ = opening.new_session(familiar, seed=7, now=T0)
    assert state["relationships"]["lin_wan>player"]["stage"] == "familiar"
    assert state["relationships"]["player>lin_wan"]["stage"] == "familiar"


check("an hour apart requires an offscreen beat", an_hour_apart_requires_a_beat)
check("the beat settles the time apart", the_beat_settles_the_time_apart)
check("a beat may only say what she alone knows", a_beat_may_only_say_what_she_alone_knows)
check("a short gap allows but does not require a beat", a_short_gap_allows_but_does_not_require_a_beat)
check("a long absence lingers for a day", a_long_absence_lingers)
check("routine_between walks the gap", routine_between_walks_the_gap)
check("a frozen world asks for no beat", a_frozen_world_asks_for_nothing)
check("only the two of you are on stage", only_two_people_on_stage)
run("companion")
