"""低心情的表达：可以沉默、求安慰、转移话题或独处，不强制爆发。

林晚基准 55，阈值 open 72 / closed 40 / break 18。两条 -30 的记忆把她压到崩溃档，
一条 -30 压到收缩档（在场 +3，深夜 -3，都还落在 18..40 之内）。
"""

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import e2e
from harness import check, raises, run
from stdio import Sidecar

DATA = e2e.temp_dir()


def with_sc(fn):
    def inner():
        with Sidecar(DATA) as s:
            fn(s)

    return inner


def commit(s, sid, rev, ops, **extra):
    data = s.ok("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=ops, **extra))
    return data["revision"]


def rejected(s, sid, rev, ops, **extra):
    return s.fail("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, ops=ops, **extra))


def reasons(err):
    return " | ".join(d["reason"] for d in err.get("details") or [])


def sink(s, hits):
    """开局 → 林晚知道两件事 → 挂 `hits` 条 -30 的记忆。返回 (sid, rev)。"""
    sid, rev, _ = e2e.start(s)
    rev = commit(s, sid, rev, [
        {"op": "add_fact", "key": "x.lie", "text": "你撒了谎", "scope": "companion_only",
         "origin": "observed"},
        {"op": "add_fact", "key": "x.smash", "text": "你砸了药柜", "scope": "companion_only",
         "origin": "observed"},
    ])
    ops = [{"op": "add_thought", "label": "被骗", "delta": -30, "basis_fact_id": "f1"},
           {"op": "add_thought", "label": "药柜", "delta": -30, "basis_fact_id": "f2"}][:hits]
    if ops:
        rev = commit(s, sid, rev, ops)
    return sid, rev


def band_of(s, sid):
    return s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["band"]


def outburst(kind="leave", text="她甩开手，往门口走。"):
    return {"op": "npc_action", "kind": kind, "action": text, "significant": True}


ATTEMPT = {"mode": "attempt", "player_input": "我去拉她的手", "acts_on_her": True}


# ---------------------------------------------------------------------------
# 崩溃档


def break_attempt_commits_with_an_outburst(s):
    """原来的死锁：attempt 作用于崩溃档的她，带不带回应都提交不了。"""
    sid, rev = sink(s, 2)
    assert band_of(s, sid) == "break"
    commit(s, sid, rev, [outburst()], **ATTEMPT)


def break_allows_a_short_response(s):
    sid, rev = sink(s, 2)
    ops = [{"op": "npc_response", "response": "genuine", "note": "先陪我坐一会儿，好吗。"}]
    commit(s, sid, rev, ops, **ATTEMPT)


def break_requires_a_response_or_expression(s):
    sid, rev = sink(s, 2)
    quiet = {"op": "npc_action", "kind": "observe", "action": "她盯着你。", "significant": False}
    err = rejected(s, sid, rev, [quiet])
    assert "崩溃档" in reasons(err), err


def break_major_action_must_express_her_mood(s):
    sid, rev = sink(s, 2)
    err = rejected(s, sid, rev, [outburst(kind="approach", text="她走过来。")])
    assert "silence" in str(err) and "seek_comfort" in str(err), err


def break_outburst_ignores_cooldown(s):
    sid, rev = sink(s, 2)
    rev = commit(s, sid, rev, [outburst()])
    assert band_of(s, sid) == "break"
    commit(s, sid, rev, [outburst(kind="provoke", text="她回头丢下一句狠话。")])


def break_is_judged_at_turn_start(s):
    """同回合先抬高心情，也不能绕过回合开始时的关系门禁。"""
    sid, rev = sink(s, 2)
    lift = [{"op": "add_thought", "label": "缓一缓", "delta": 15, "basis_fact_id": fid}
            for fid in ("f1", "f2")]
    err = rejected(s, sid, rev, lift + [
        {"op": "npc_response", "response": "genuine", "note": "先陪我坐一会儿吧。"},
        {"op": "relationship", "stage_advance": True, "reason": "她愿意说话了"},
    ], **ATTEMPT)
    assert "不会接受关系推进" in reasons(err), err


SOFT_ACTIONS = {
    "silence": "她垂下眼，安静地坐了一会儿。",
    "seek_comfort": "她轻声问，你能陪我坐一会儿吗。",
    "change_topic": "她停了一下，问起窗外的雨。",
    "withdraw": "她说想自己待会儿，去窗边坐下。",
}


def low_mood_allows_small_personal_reactions(s):
    for hits in (1, 2):
        sid, rev = sink(s, hits)
        for kind, text in SOFT_ACTIONS.items():
            rev = commit(s, sid, rev, [{"op": "npc_action", "kind": kind, "action": text}], **ATTEMPT)
        assert band_of(s, sid) in ("closed", "break")


def break_personal_reactions_work_on_cooldown(s):
    sid, rev = sink(s, 2)
    for kind, text in SOFT_ACTIONS.items():
        rev = commit(s, sid, rev, [outburst(kind, text)])


def low_mood_expression_does_not_advance_the_relationship(s):
    for hits in (1, 2):
        sid, rev = sink(s, hits)
        err = rejected(s, sid, rev, [
            {"op": "npc_response", "response": "genuine", "note": "陪我坐一会儿吧。"},
            {"op": "relationship", "stage_advance": True, "reason": "她愿意说话了"},
        ], **ATTEMPT)
        assert "不会接受关系推进" in reasons(err), err


def a_mood_reaction_is_not_intimacy_consent(s):
    sid, rev = sink(s, 2)
    for kind, text in SOFT_ACTIONS.items():
        err = rejected(s, sid, rev, [{"op": "npc_action", "kind": kind, "action": text}],
                       **ATTEMPT, player_authorized=True, tags=["intimate"])
        assert "没有 partial/genuine" in reasons(err), err


def break_candidates_offer_personal_expressions(s):
    sid, rev = sink(s, 2)
    seen = s.ok("get-context", {"session_id": sid})["context"]
    options = seen["agency"][0]["options"]
    assert any(o["kind"] in SOFT_ACTIONS for o in options), options
    assert all(o["because"] for o in options), options
    rev = commit(s, sid, rev, [{"op": "relationship", "trust_delta": 2, "reason": "你一直认真听着"},
                               {"op": "npc_action", "kind": "silence", "action": SOFT_ACTIONS["silence"]}], **ATTEMPT)
    seen = s.ok("get-context", {"session_id": sid})["context"]
    options = seen["agency"][0]["options"]
    assert options[0]["kind"] == "seek_comfort", options
    rev = commit(s, sid, rev, [outburst("seek_comfort", SOFT_ACTIONS["seek_comfort"])])
    again = s.ok("get-context", {"session_id": sid})["context"]
    assert again["agency"] and again["companion"]["can_act"], again
    activity = s.ok("debug-activity", {"session_id": sid})
    assert activity["rows"][0]["actions"][0]["kind_label"] == "寻求安慰", activity


# ---------------------------------------------------------------------------
# 收缩档


def closed_allows_a_warm_response(s):
    sid, rev = sink(s, 1)
    assert band_of(s, sid) == "closed"
    ops = [{"op": "npc_response", "response": "genuine", "note": "好。"}]
    commit(s, sid, rev, ops, **ATTEMPT)


def closed_caps_the_reply(s):
    sid, rev = sink(s, 1)
    ops = [{"op": "npc_response", "response": "refuse", "note": "不" * 31}]
    err = rejected(s, sid, rev, ops, **ATTEMPT)
    assert "最多 30 字" in reasons(err), err


def closed_allows_a_short_refusal(s):
    sid, rev = sink(s, 1)
    ops = [{"op": "npc_response", "response": "refuse", "note": "她把手抽了回去。"}]
    commit(s, sid, rev, ops, **ATTEMPT)


def refusal_does_not_sink_her_further(s):
    """她选择拒绝不该再扣自己的心情，造成越拒绝越难过的循环。"""
    sid, rev = sink(s, 1)
    before = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["value"]
    ops = [{"op": "npc_response", "response": "refuse", "note": "她把手抽了回去。"}]
    commit(s, sid, rev, ops, **ATTEMPT)
    after = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["value"]
    assert after >= before - 1, (before, after)  # 只允许线性衰减带来的取整误差


# ---------------------------------------------------------------------------
# 重大行动必须取候选种类


def significant_action_needs_a_kind(s):
    sid, rev = sink(s, 0)
    op = {"op": "npc_action", "action": "她开口了。", "significant": True}
    err = rejected(s, sid, rev, [op])
    assert "必须写 kind" in reasons(err), err


def significant_action_outside_candidates_is_refused(s):
    sid, rev = sink(s, 0)
    # accident 从不由引擎打分，永远不会是候选
    op = {"op": "npc_action", "kind": "accident", "action": "她碰翻了药瓶。", "significant": True}
    err = rejected(s, sid, rev, [op])
    assert "不是 accident" in reasons(err), err


def minor_action_may_be_any_kind(s):
    sid, rev = sink(s, 0)
    op = {"op": "npc_action", "kind": "accident", "action": "她碰翻了药瓶。", "significant": False}
    commit(s, sid, rev, [op])


@contextmanager
def elapsed_game():
    from rp_soul_engine.application import service
    from rp_soul_engine.application.context import Context

    ctx = Context(str(Path(__file__).resolve().parents[1]), data_dir_arg=e2e.temp_dir())
    try:
        with patch.object(service, "now_iso", return_value="2026-10-26T12:00:00+08:00") as clock:
            opened = service.new_game(ctx, {"request_id": e2e.rid(), "persona": e2e.persona_payload(), "seed": 7})
            ops = []
            for i in (1, 2):
                ops.extend([
                    {"op": "add_fact", "key": "hurt.n%d" % i, "text": "一件让她难过的事", "scope": "shared", "origin": "observed"},
                    {"op": "add_thought", "label": "难过%d" % i, "delta": -30, "basis_fact_id": "f%d" % i, "minutes": 60},
                ])
            ops.append({"op": "event_create", "kind": "deadline", "title": "交班", "with_player": False,
                        "in_minutes": 30, "dedupe_key": "her.handover"})
            row = service.commit_turn(ctx, e2e.commit(opened, mode="result", ops=ops))
            row["session_id"] = opened["session_id"]
            assert row["context"]["companion"]["mood"]["band"] == "break"
            clock.return_value = "2026-10-26T14:00:00+08:00"
            yield ctx, row
    finally:
        ctx.close()


def elapsed_mood_reads_recover_without_writing():
    from rp_soul_engine.application import service
    from rp_soul_engine.persistence import repo

    with elapsed_game() as (ctx, row):
        sid = row["session_id"]
        for depth in ("brief", "full"):
            seen = service.get_context(ctx, {"session_id": sid, "depth": depth})
            assert seen["context"]["companion"]["mood"]["band"] == "normal", seen["context"]["companion"]
            assert seen["context"]["clock"]["minute"] == 840
            assert seen["revision"] == row["revision"] and seen["turn"] == row["turn"]
        assert service.debug_mood(ctx, {"session_id": sid})["band"] == "normal"
        assert service.debug_moods(ctx, {"session_id": sid})["npcs"][0]["band"] == "normal"
        assert service.status(ctx, {"session_id": sid})["mood"]["lin_wan"]["band"] == "normal"
        stored = repo.load_session(ctx.db(), sid)["state"]
        assert stored["clock"]["minute"] == 720 and stored["real_at"] == "2026-10-26T12:00:00+08:00"
        assert len(stored["characters"]["lin_wan"]["mood"]["thoughts"]) == 2
        assert stored["events"]["e1"]["state"] == "pending"
        assert repo.count_rows(ctx.db(), "turn_log", sid) == 2


def elapsed_mood_commit_keeps_the_absence_and_undo():
    from rp_soul_engine.application import service
    from rp_soul_engine.errors import AppError
    from rp_soul_engine.persistence import repo

    with elapsed_game() as (ctx, row):
        service.get_context(ctx, {"session_id": row["session_id"]})
        response = {"op": "npc_response", "response": "genuine", "note": "已经缓过来了，进来坐吧。"}
        body = e2e.commit(row, mode="attempt", player_input="我回来了", acts_on_her=True, ops=[response])
        try:
            service.commit_turn(ctx, body)
        except AppError as err:
            why = " | ".join(d["reason"] for d in err.details)
            assert "离屏片段" in why and "崩溃档" not in why and "没法好好回应" not in why, why
        else:
            raise AssertionError("reading must not consume the absence's offscreen beat")
        body["request_id"] = e2e.rid()
        body["turns"][0]["operations"].insert(0, {"op": "offscreen_beat", "summary": "她忙完交班，坐下来休息。"})
        done = service.commit_turn(ctx, body)
        assert done["turns"][0]["time_settled"] == 120
        assert done["turns"][0]["resolved_events"][0]["event_id"] == "e1"
        assert done["context"]["companion"]["mood"]["band"] == "normal"
        service.undo_turn(ctx, {"session_id": row["session_id"], "request_id": e2e.rid(), "expected_revision": done["revision"]})
        stored = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert stored["clock"]["minute"] == 720 and stored["events"]["e1"]["state"] == "pending"


def elapsed_mood_commit_recovers_without_a_read():
    from rp_soul_engine.application import service

    with elapsed_game() as (ctx, row):
        done = service.commit_turn(ctx, e2e.commit(row, ops=[
            {"op": "offscreen_beat", "summary": "她交完班后休息了一会儿。"},
            {"op": "npc_response", "response": "genuine", "note": "已经缓过来了。"},
        ]))
        assert done["context"]["companion"]["mood"]["band"] == "normal"


check("elapsed time: reads recover mood without writing", elapsed_mood_reads_recover_without_writing)
check("elapsed time: commit keeps the absence and undo", elapsed_mood_commit_keeps_the_absence_and_undo)
check("elapsed time: commit recovers without a prior read", elapsed_mood_commit_recovers_without_a_read)
check("break: an attempt on her commits with an outburst", with_sc(break_attempt_commits_with_an_outburst))
check("break: a short sincere response is allowed", with_sc(break_allows_a_short_response))
check("break: a response or personal expression is required", with_sc(break_requires_a_response_or_expression))
check("break: a major action must express her mood", with_sc(break_major_action_must_express_her_mood))
check("break: the outburst ignores cooldown", with_sc(break_outburst_ignores_cooldown))
check("break: judged at turn start", with_sc(break_is_judged_at_turn_start))
check("closed: a warm response is allowed", with_sc(closed_allows_a_warm_response))
check("closed: the reply is capped at 30 chars", with_sc(closed_caps_the_reply))
check("closed: a short refusal commits", with_sc(closed_allows_a_short_refusal))
check("closed: a refusal does not sink her further", with_sc(refusal_does_not_sink_her_further))
check("agency: a significant action needs a kind", with_sc(significant_action_needs_a_kind))
check("agency: a kind outside the candidates is refused", with_sc(significant_action_outside_candidates_is_refused))
check("agency: a minor action may be any kind", with_sc(minor_action_may_be_any_kind))
check("low mood: small personal reactions are allowed", with_sc(low_mood_allows_small_personal_reactions))
check("break: personal reactions work on cooldown", with_sc(break_personal_reactions_work_on_cooldown))
check("low mood: a warm reply does not advance the relationship", with_sc(low_mood_expression_does_not_advance_the_relationship))
check("low mood: an expression is not intimacy consent", with_sc(a_mood_reaction_is_not_intimacy_consent))
check("break: candidates reflect mood and trust", with_sc(break_candidates_offer_personal_expressions))
run("mood gates")
