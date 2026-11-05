"""Memory receipts, diary files and player absence survive the full write/read path."""

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
from rp_soul_engine.persistence import db, repo

T0 = "2026-10-28T12:00:00+08:00"
ACTION = {"op": "npc_action", "action": "她收好杯子，继续等你。", "significant": False}


@contextmanager
def game():
    ctx = Context(str(Path(__file__).resolve().parents[1]), data_dir_arg=e2e.temp_dir())
    try:
        with patch.object(service, "now_iso", return_value=T0) as clock:
            row = service.new_game(ctx, {"request_id": e2e.rid(), "persona": e2e.persona_payload(), "seed": 7})
            yield ctx, clock, row
    finally:
        ctx.close()


def read_previews_keep_the_unanswered_wakes_absence():
    with game() as (ctx, clock, row):
        service.commit_turn(ctx, e2e.commit(row, ops=[ACTION], together=False))
        stored = repo.load_session(ctx.db(), row["session_id"])["state"]
        before = stored["characters"]["lin_wan"]["mood"]
        clock.return_value = "2026-10-28T12:01:00+08:00"
        for _ in range(2):
            context = service.get_context(ctx, {"session_id": row["session_id"]})["context"]
            labels = [t["label"] for t in context["companion"]["mood"]["weighing"]]
            assert "你不在" in labels and "在场" not in labels, labels
            panel = service.debug_mood(ctx, {"session_id": row["session_id"]})
            labels = [t["label"] for t in panel["thoughts"]]
            assert "你不在" in labels and "在场" not in labels, labels
            panels = service.debug_moods(ctx, {"session_id": row["session_id"]})
            assert "在场" not in str(panels), panels
        after = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert after["characters"]["lin_wan"]["mood"] == before
        assert after["real_at"] == stored["real_at"] and after["revision"] == stored["revision"]


def a_real_reply_restores_presence_without_waiting_a_whole_minute():
    with game() as (ctx, clock, row):
        wake = service.commit_turn(ctx, e2e.commit(row, ops=[ACTION], together=False))
        clock.return_value = "2026-10-28T12:00:30+08:00"
        replied = service.commit_turn(ctx, e2e.commit(dict(wake, session_id=row["session_id"]),
                                                     ops=[ACTION], player_input="我回来了。"))
        labels = [t["label"] for t in replied["context"]["companion"]["mood"]["weighing"]]
        assert "在场" in labels and "你不在" not in labels, labels
        state = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert state["last_player_at"] == clock.return_value


def an_old_ledger_drops_its_memory_on_load():
    """lite 没有记忆层：旧存档里的记忆条、待交的总结 / 日记读进来就扔掉，回合流水留着。"""
    with game() as (ctx, clock, row):
        service.commit_turn(ctx, e2e.commit(row, ops=[ACTION]))
        conn = ctx.db()
        db.begin_write(conn)
        state = repo.load_session(conn, row["session_id"])["state"]
        state["memory"]["entries"] = [{"id": "m1", "layer": "scm", "content": "旧版的一条记忆"}]
        state["memory"]["diary_last"] = {"day": 1, "text": "旧日记"}
        state["requests"] = {"memory_fold": {"ids": ["m1"]}, "memory_diary": None}
        state["counters"]["last_diary_day"] = 1
        repo.update_session(conn, state, T0)
        conn.execute("COMMIT")
        loaded = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert "entries" not in loaded["memory"] and "diary_last" not in loaded["memory"], loaded["memory"].keys()
        assert loaded["requests"] == {}, loaded["requests"]
        assert "last_diary_day" not in loaded["counters"], loaded["counters"].keys()
        assert len(loaded["memory"]["turns"]) == 1, "回合流水留着"
        # 读进来之后照常能交账
        service.commit_turn(ctx, e2e.commit({"session_id": row["session_id"], "revision": state["revision"]}, ops=[ACTION]))


def a_commit_without_the_often_forgotten_fields_goes_through():
    """模型常漏的 player_input / content_tags / open_action 不再让整次交账被驳回：
    前两个当空，悬念沿用上一个。"""
    with game() as (ctx, clock, row):
        first = service.commit_turn(ctx, e2e.commit(row, ops=[ACTION]))
        body = {
            "session_id": row["session_id"], "request_id": e2e.rid(), "expected_revision": first["revision"],
            "turns": [{"action_mode": "wait", "operations": [ACTION], "summary": "她又看了一眼门口。"}],
        }
        result = service.commit_turn(ctx, body)
        assert result["turn"] == first["turn"] + 1, result
        state = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert state["memory"]["open_action"] == "她等着他开口。", state["memory"]["open_action"]


def a_missing_basis_fact_names_the_ones_she_knows():
    """依据的事实编错了：报错里列出 TA 知道的事实 id，照着挑一个就对。"""
    with game() as (ctx, clock, row):
        known = service.commit_turn(ctx, e2e.commit(row, ops=[
            ACTION, {"op": "add_fact", "key": "rain_umbrella", "text": "你把伞留在门边。", "scope": "shared", "origin": "observed"},
        ]))
        body = e2e.commit({"session_id": row["session_id"], "revision": known["revision"]}, ops=[
            ACTION, {"op": "add_thought", "label": "半夜还在查东西", "delta": 3, "basis_fact_id": "late_night_check"},
        ])
        try:
            service.commit_turn(ctx, body)
        except service.AppError as exc:
            hints = " ".join(str(d.get("hint") or "") for d in exc.details)
            assert "你把伞留在门边" in hints and "（" in hints, hints
        else:
            raise AssertionError("不存在的依据应当驳回")


def the_context_says_ahead_when_an_offscreen_beat_is_due():
    """隔了一小时以上：读局面时就说「这次要带离屏片段」，别等交上去被驳回再重交。"""
    with game() as (ctx, clock, row):
        service.commit_turn(ctx, e2e.commit(row, ops=[ACTION]))
        near = service.get_context(ctx, {"session_id": row["session_id"], "depth": "brief"})["context"]
        assert "offscreen_due" not in near, near.get("offscreen_due")
        clock.return_value = "2026-10-28T14:30:00+08:00"
        later = service.get_context(ctx, {"session_id": row["session_id"], "depth": "brief"})["context"]
        assert later.get("offscreen_due", {}).get("minutes", 0) >= 60, later.get("offscreen_due")


check("an old ledger drops its memory on load", an_old_ledger_drops_its_memory_on_load)
check("a commit without the often forgotten fields goes through", a_commit_without_the_often_forgotten_fields_goes_through)
check("a missing basis fact names the ones she knows", a_missing_basis_fact_names_the_ones_she_knows)
check("the context says ahead when an offscreen beat is due", the_context_says_ahead_when_an_offscreen_beat_is_due)
def trimming_undo_points_keeps_the_hand_deleted_record():
    """turn 0 不是回合，是「设置页手动删过」的凭据。清理旧撤销点时把它
    一起删掉，revert_turn_facts 就认不出哪些事实该保持消失。"""
    with game() as (ctx, clock, row):
        conn = ctx.db()
        db.begin_write(conn)
        sid = row["session_id"]
        for turn in (1, 2, 3):
            repo.put_undo_point(conn, sid, turn, repo.load_session(conn, sid)["state"])
        for turn in (0, 2):
            conn.execute(
                "INSERT OR IGNORE INTO fact_journal(session_id, turn, id, before) VALUES(?,?,?,?)",
                (sid, turn, "f_by_hand", "{}"),
            )
        repo.trim_undo_points(conn, sid, 30)
        left = [r[0] for r in conn.execute(
            "SELECT turn FROM fact_journal WHERE session_id=? ORDER BY turn", (sid,)).fetchall()]
        conn.execute("COMMIT")
        assert 0 in left, left
        assert 2 in left, left


check("trimming undo points keeps the hand deleted record",
      trimming_undo_points_keeps_the_hand_deleted_record)

check("read previews keep unanswered wake absence without writes", read_previews_keep_the_unanswered_wakes_absence)
check("a real reply restores presence within the same minute", a_real_reply_restores_presence_without_waiting_a_whole_minute)
run("continuity")
