"""心情档位门禁：崩溃档不死锁、收缩档只给冷回应、重大行动必须取候选种类。

林晚基准 55，阈值 open 72 / closed 40 / break 18。两条 -30 的记忆把她压到崩溃档，
一条 -30 压到收缩档（在场 +3，深夜 -3，都还落在 18..40 之内）。
"""

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
    """开局 → 林晚登场并知道两件事 → 挂 `hits` 条 -30 的记忆。返回 (sid, rev)。"""
    sid, rev, _ = e2e.start(s)
    rev = commit(s, sid, rev, [
        {"op": "enter_scene", "character_id": "lin_wan"},
        {"op": "add_fact", "key": "x.lie", "text": "你撒了谎", "known_by": ["lin_wan"],
         "visibility": "private", "origin": "observed"},
        {"op": "add_fact", "key": "x.smash", "text": "你砸了药柜", "known_by": ["lin_wan"],
         "visibility": "private", "origin": "observed"},
    ])
    ops = [{"op": "add_thought", "npc_id": "lin_wan", "label": "被骗", "delta": -30, "basis_fact_id": "f1"},
           {"op": "add_thought", "npc_id": "lin_wan", "label": "药柜", "delta": -30, "basis_fact_id": "f2"}][:hits]
    if ops:
        rev = commit(s, sid, rev, ops)
    return sid, rev


def band_of(s, sid):
    return s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["band"]


def outburst(kind="leave", text="她甩开手，往门口走。"):
    return {"op": "npc_action", "npc_id": "lin_wan", "kind": kind, "action": text, "significant": True}


ATTEMPT = {"mode": "attempt", "player_input": "我去拉她的手", "acts_on": ["lin_wan"]}


# ---------------------------------------------------------------------------
# 崩溃档


def break_attempt_commits_with_an_outburst(s):
    """原来的死锁：attempt 作用于崩溃档的她，带不带回应都提交不了。"""
    sid, rev = sink(s, 2)
    assert band_of(s, sid) == "break"
    commit(s, sid, rev, [outburst()], **ATTEMPT)


def break_refuses_a_response(s):
    sid, rev = sink(s, 2)
    ops = [{"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "甩开"}, outburst()]
    err = rejected(s, sid, rev, ops, **ATTEMPT)
    assert "没法好好回应" in reasons(err), err


def break_demands_an_outburst(s):
    sid, rev = sink(s, 2)
    quiet = {"op": "npc_action", "npc_id": "lin_wan", "kind": "observe", "action": "她盯着你。", "significant": False}
    err = rejected(s, sid, rev, [quiet])
    assert "崩溃档" in reasons(err), err


def break_outburst_must_be_provoke_or_leave(s):
    sid, rev = sink(s, 2)
    err = rejected(s, sid, rev, [outburst(kind="approach", text="她走过来。")])
    assert "provoke/leave" in reasons(err), err


def break_outburst_ignores_cooldown(s):
    sid, rev = sink(s, 2)
    rev = commit(s, sid, rev, [outburst()])
    assert band_of(s, sid) == "break"
    commit(s, sid, rev, [outburst(kind="provoke", text="她回头丢下一句狠话。")])


def break_is_judged_at_turn_start(s):
    """本回合先加两条好心情也躲不掉：档位按回合开始那一刻判。"""
    sid, rev = sink(s, 2)
    lift = [{"op": "add_thought", "npc_id": "lin_wan", "label": "缓一缓", "delta": 15, "basis_fact_id": fid}
            for fid in ("f1", "f2")]
    err = rejected(s, sid, rev, lift)
    assert "崩溃档" in reasons(err), err


# ---------------------------------------------------------------------------
# 收缩档


def closed_refuses_a_warm_response(s):
    sid, rev = sink(s, 1)
    assert band_of(s, sid) == "closed"
    ops = [{"op": "npc_response", "npc_id": "lin_wan", "response": "genuine", "note": "好。"}]
    err = rejected(s, sid, rev, ops, **ATTEMPT)
    assert "refuse/negotiate/surface" in str(err), err


def closed_caps_the_reply(s):
    sid, rev = sink(s, 1)
    ops = [{"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "不" * 31}]
    err = rejected(s, sid, rev, ops, **ATTEMPT)
    assert "最多 30 字" in reasons(err), err


def closed_allows_a_short_refusal(s):
    sid, rev = sink(s, 1)
    ops = [{"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "她把手抽了回去。"}]
    commit(s, sid, rev, ops, **ATTEMPT)


def refusal_does_not_sink_her_further(s):
    """收缩档只能冷回应；冷回应若还扣她自己的分，就是一路滑进崩溃档。"""
    sid, rev = sink(s, 1)
    before = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["value"]
    ops = [{"op": "npc_response", "npc_id": "lin_wan", "response": "refuse", "note": "她把手抽了回去。"}]
    commit(s, sid, rev, ops, **ATTEMPT)
    after = s.ok("debug-mood", {"session_id": sid, "npc_id": "lin_wan"})["value"]
    assert after >= before - 1, (before, after)  # 只允许线性衰减带来的取整误差


# ---------------------------------------------------------------------------
# 重大行动必须取候选种类


def significant_action_needs_a_kind(s):
    sid, rev = sink(s, 0)
    op = {"op": "npc_action", "npc_id": "lin_wan", "action": "她开口了。", "significant": True}
    err = rejected(s, sid, rev, [op])
    assert "必须写 kind" in reasons(err), err


def significant_action_outside_candidates_is_refused(s):
    sid, rev = sink(s, 0)
    # accident 从不由引擎打分，永远不会是候选
    op = {"op": "npc_action", "npc_id": "lin_wan", "kind": "accident", "action": "她碰翻了药瓶。", "significant": True}
    err = rejected(s, sid, rev, [op])
    assert "不是 accident" in reasons(err), err


def minor_action_may_be_any_kind(s):
    sid, rev = sink(s, 0)
    op = {"op": "npc_action", "npc_id": "lin_wan", "kind": "accident", "action": "她碰翻了药瓶。", "significant": False}
    commit(s, sid, rev, [op])


check("break: an attempt on her commits with an outburst", with_sc(break_attempt_commits_with_an_outburst))
check("break: npc_response is refused", with_sc(break_refuses_a_response))
check("break: a turn without an outburst is refused", with_sc(break_demands_an_outburst))
check("break: the outburst is provoke or leave", with_sc(break_outburst_must_be_provoke_or_leave))
check("break: the outburst ignores cooldown", with_sc(break_outburst_ignores_cooldown))
check("break: judged at turn start", with_sc(break_is_judged_at_turn_start))
check("closed: a warm response is refused", with_sc(closed_refuses_a_warm_response))
check("closed: the reply is capped at 30 chars", with_sc(closed_caps_the_reply))
check("closed: a short refusal commits", with_sc(closed_allows_a_short_refusal))
check("closed: a refusal does not sink her further", with_sc(refusal_does_not_sink_her_further))
check("agency: a significant action needs a kind", with_sc(significant_action_needs_a_kind))
check("agency: a kind outside the candidates is refused", with_sc(significant_action_outside_candidates_is_refused))
check("agency: a minor action may be any kind", with_sc(minor_action_may_be_any_kind))
run("mood gates")
