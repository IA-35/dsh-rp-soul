"""Real-time minute settlement keeps short-turn seconds across every write path."""

import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e
from harness import check, run
from rp_soul_engine.application import service
from rp_soul_engine.application.context import Context
from rp_soul_engine.domain import settlement as SETTLE
from rp_soul_engine.persistence import repo

T0 = "2026-10-26T12:00:00+08:00"


@contextmanager
def game():
    ctx = Context(str(Path(__file__).resolve().parents[1]), data_dir_arg=e2e.temp_dir())
    try:
        with patch.object(service, "now_iso", return_value=T0) as clock:
            opened = service.new_game(ctx, {"request_id": e2e.rid(), "persona": e2e.persona_payload(), "seed": 7})
            yield ctx, clock, opened
    finally:
        ctx.close()


def play(ctx, clock, row, at, player_input=""):
    clock.return_value = "2026-10-26T" + at + "+08:00"
    response = service.commit_turn(ctx, e2e.commit(row, mode="result", player_input=player_input))
    return dict(response, session_id=row["session_id"])


def consecutive_short_turns_accumulate():
    with game() as (ctx, clock, row):
        minutes = []
        for at in ("12:00:30", "12:01:00", "12:01:30", "12:02:00"):
            row = play(ctx, clock, row, at)
            minutes.append(row["clock"]["minute"])
        assert minutes == [720, 721, 721, 722], minutes


def previews_do_not_consume_remainder():
    with game() as (ctx, clock, row):
        row = play(ctx, clock, row, "12:00:30")
        clock.return_value = "2026-10-26T12:01:15+08:00"
        for _ in range(2):
            preview = service.get_context(ctx, {"session_id": row["session_id"]})
            assert preview["context"]["clock"]["minute"] == 721
        stored = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert stored["clock"]["minute"] == 720 and stored["real_at"] == T0, stored["real_at"]
        row = play(ctx, clock, row, "12:01:30")
        assert row["clock"]["minute"] == 721
        row = play(ctx, clock, row, "12:02:00")
        assert row["clock"]["minute"] == 722


def saves_loads_and_undo_keep_the_anchor():
    with game() as (ctx, clock, row):
        row = play(ctx, clock, row, "12:00:30")
        service.save_slot(ctx, {"session_id": row["session_id"], "request_id": e2e.rid(),
                                "expected_revision": row["revision"], "name": "seconds"})
        loaded = service.load_slot(ctx, {"request_id": e2e.rid(), "name": "seconds"})
        row = play(ctx, clock, loaded, "12:01:00")
        assert row["clock"]["minute"] == 721
        undone = service.undo_turn(ctx, {"session_id": row["session_id"], "request_id": e2e.rid(),
                                        "expected_revision": row["revision"]})
        row = play(ctx, clock, dict(undone, session_id=row["session_id"]), "12:01:30", player_input="我回来了")
        stored = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert row["clock"]["minute"] == 721, row["clock"]
        assert stored["real_at"] == "2026-10-26T12:01:00+08:00"
        assert stored["last_player_at"] == "2026-10-26T12:01:30+08:00", stored["last_player_at"]


def clock_rollback_does_not_count_the_same_time_twice():
    with game() as (ctx, clock, row):
        row = play(ctx, clock, row, "12:02:00")
        row = play(ctx, clock, row, "12:01:30")
        assert row["clock"]["minute"] == 722
        row = play(ctx, clock, row, "12:02:30")
        assert row["clock"]["minute"] == 722, row["clock"]
        row = play(ctx, clock, row, "12:03:00")
        assert row["clock"]["minute"] == 723


def replay_does_not_advance_or_consume_time():
    with game() as (ctx, clock, row):
        clock.return_value = "2026-10-26T12:00:30+08:00"
        request = e2e.commit(row, mode="result")
        committed = service.commit_turn(ctx, request)
        clock.return_value = "2026-10-26T12:00:50+08:00"
        replay = service.commit_turn(ctx, request)
        assert replay["replayed"] and replay["revision"] == committed["revision"]
        row = play(ctx, clock, dict(committed, session_id=row["session_id"]), "12:01:00")
        assert row["clock"]["minute"] == 721


def short_turns_expire_thoughts_and_due_events():
    with game() as (ctx, clock, row):
        response = service.commit_turn(ctx, e2e.commit(row, mode="result", ops=[
            {"op": "add_fact", "key": "her.worry", "text": "她有一点担心。", "scope": "companion_only", "origin": "observed"},
            {"op": "add_thought", "label": "一时担心", "delta": -10, "basis_fact_id": "f1", "minutes": 1},
            {"op": "event_create", "kind": "deadline", "title": "烧水", "with_player": False,
             "in_minutes": 1, "dedupe_key": "her.water"},
        ]))
        row = dict(response, session_id=row["session_id"])
        row = play(ctx, clock, row, "12:00:30")
        assert not row["turns"][0]["resolved_events"]
        row = play(ctx, clock, row, "12:01:00")
        assert row["turns"][0]["resolved_events"][0]["event_id"] == "e1"
        thoughts = service.debug_mood(ctx, {"session_id": row["session_id"]})["thoughts"]
        assert not any(t["label"] == "一时担心" for t in thoughts), thoughts


def crossing_midnight_in_fifteen_minutes_is_not_a_gap():
    """23:50 说完话，00:05 又开口：只过去十五分钟，不能要她补离屏片段。"""
    assert SETTLE.tier_for(15) == "routine", "a quarter of an hour is a pause, not a gap"
    assert SETTLE.tier_for(59) == "brief"
    assert SETTLE.tier_for(60) == "full", "an hour is a real gap"


check("four 30-second turns advance two minutes", consecutive_short_turns_accumulate)
check("read previews never consume the remaining seconds", previews_do_not_consume_remainder)
check("save/load/undo retain seconds and actual player time", saves_loads_and_undo_keep_the_anchor)
check("wall-clock rollback never double-counts", clock_rollback_does_not_count_the_same_time_twice)
check("idempotent replay does not consume seconds", replay_does_not_advance_or_consume_time)
check("short turns settle expired thoughts and due events", short_turns_expire_thoughts_and_due_events)
check("crossing midnight in fifteen minutes is not a gap", crossing_midnight_in_fifteen_minutes_is_not_a_gap)


def _cooldown_state(at_minute, last_minute):
    return {
        "clock": {"day": 1, "minute": at_minute},
        "counters": {"major_action_at": {"lin_wan": {"day": 1, "minute": last_minute}}},
        "player_id": "player",
        "characters": {"lin_wan": {"id": "lin_wan"}},
    }


def cooldown_is_a_stretch_of_minutes():
    """20 分钟里连发 30 句只允许一次重大行动，第 21 分钟才可以。"""
    from rp_soul_engine.domain import state as SS
    from rp_soul_engine.domain import structure as ST
    assert SS.can_act(_cooldown_state(600, 600), "lin_wan") is False, "刚做完，不能马上再来"
    wait = ST.ACTION_COOLDOWN_MINUTES
    assert SS.can_act(_cooldown_state(600 + wait - 1, 600), "lin_wan") is False, "差一分钟还不行"
    assert SS.can_act(_cooldown_state(600 + wait, 600), "lin_wan") is True, "够了就行"
    short = ST.ACTION_COOLDOWN_MINUTES_OPEN
    assert SS.can_act(_cooldown_state(600 + short, 600), "lin_wan", bonus=1) is True, "open 档更短"
    assert SS.can_act(_cooldown_state(600 + short, 600), "lin_wan") is False, "平常档还要等"
    chatty = _cooldown_state(600, 600)
    chatty["turn"] = 999
    assert SS.can_act(chatty, "lin_wan") is False, "聊得再多也不缩短冷却"


def a_gap_of_a_day_is_still_a_gap():
    from rp_soul_engine.domain import state as SS
    state = _cooldown_state(60, 600)
    state["clock"] = {"day": 2, "minute": 60}
    assert SS.can_act(state, "lin_wan") is True, "隔了一天当然可以"


check("cooldown is a stretch of minutes", cooldown_is_a_stretch_of_minutes)
check("a gap of a day is still a gap", a_gap_of_a_day_is_still_a_gap)

def the_gap_reaches_the_context():
    """隔够久，「这段时间」真的进了 get-context 返回的 brief。"""
    with game() as (ctx, clock, row):
        play(ctx, clock, row, "12:00:00", player_input="我出门了")
        sid = row["session_id"]
        assert "since_last" not in service.get_context(ctx, {"session_id": sid})["context"], "刚说完不该有"
        clock.return_value = "2026-10-26T12:15:00+08:00"
        assert "since_last" not in service.get_context(ctx, {"session_id": sid})["context"], "15 分钟还不够"
        clock.return_value = "2026-10-26T12:16:00+08:00"
        block = service.get_context(ctx, {"session_id": sid})["context"]["since_last"]
        assert block["minutes"] == 16, block
        assert "her_routine" in block, block


check("the gap reaches the context", the_gap_reaches_the_context)
run("clock")
