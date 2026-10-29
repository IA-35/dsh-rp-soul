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
from rp_soul_engine.domain import memories as MEM
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


def request(ctx, row, kind):
    conn = ctx.db()
    db.begin_write(conn)
    state = repo.load_session(conn, row["session_id"])["state"]
    entry = MEM.add(state, "abm" if kind == "fold" else "scm", "conversation", "你来陪我吃了午饭。", 0.7, turn=0)
    state["requests"]["memory_" + kind] = {"ids": [entry["id"]]}
    if kind == "diary":
        state["requests"]["memory_diary"]["day"] = 1
    repo.update_session(conn, state, T0)
    conn.execute("COMMIT")


def diary_commit_writes_a_file_and_replay_keeps_it():
    with game() as (ctx, clock, row):
        request(ctx, row, "diary")
        body = e2e.commit(row, ops=[ACTION], memory_diary="今天你来陪我吃午饭，我很开心。")
        result = service.commit_turn(ctx, body)
        diary = result["turns"][0].get("diary")
        assert diary and diary["day"] == 1 and diary["entries"] == 1, result["turns"][0]
        path = Path(diary["path"])
        text = path.read_text(encoding="utf-8")
        assert text.startswith("# 第 1 天") and "今天你来陪我吃午饭" in text, text
        replay = service.commit_turn(ctx, body)
        assert replay["replayed"] and replay["turns"][0]["diary"] == diary
        assert path.read_text(encoding="utf-8") == text


def separate_games_keep_their_own_diary_files():
    with game() as (ctx, clock, row):
        paths = []
        for day_text in ("这局的第一天。", "另一局的第一天。"):
            request(ctx, row, "diary")
            result = service.commit_turn(ctx, e2e.commit(row, ops=[ACTION], memory_diary=day_text))
            paths.append(Path(result["turns"][0]["diary"]["path"]))
            row = service.new_game(ctx, {"request_id": e2e.rid(), "persona": e2e.persona_payload(), "seed": 7})
        assert paths[0] != paths[1], paths
        assert "这局的第一天。" in paths[0].read_text(encoding="utf-8")
        assert "另一局的第一天。" in paths[1].read_text(encoding="utf-8")


def fold_receipt_names_the_new_scm_entry():
    with game() as (ctx, clock, row):
        request(ctx, row, "fold")
        result = service.commit_turn(ctx, e2e.commit(row, ops=[ACTION], memory_fold="你来陪我吃午饭，我记得你带来的汤。"))
        folded = result["turns"][0].get("folded")
        state = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert folded and MEM.find(state, folded)["layer"] == "scm", result["turns"][0]


def rejected_diary_commit_leaves_the_request_and_no_file():
    with game() as (ctx, clock, row):
        request(ctx, row, "diary")
        body = e2e.commit(row, together=False, memory_diary="今天的午饭。", ops=[
            {"op": "npc_response", "response": "genuine", "note": "谢谢。"},
        ])
        try:
            service.commit_turn(ctx, body)
        except service.AppError:
            pass
        else:
            raise AssertionError("a player response while apart must be rejected")
        state = repo.load_session(ctx.db(), row["session_id"])["state"]
        assert state["requests"]["memory_diary"]
        assert not list(Path(ctx.data_dir).rglob("diary-*.md"))


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


check("a diary commit writes its file and replays once", diary_commit_writes_a_file_and_replay_keeps_it)
check("separate games keep their own diary files", separate_games_keep_their_own_diary_files)
check("fold receipts identify the SCM entry", fold_receipt_names_the_new_scm_entry)
check("a rejected diary commit leaves no file", rejected_diary_commit_leaves_the_request_and_no_file)
def a_diary_due_after_the_last_commit_shows_up_in_the_snapshot():
    """23:30 的唤醒到达时，上一轮 commit 早过了：这一轮必须看得见该写日记了。"""
    with game() as (ctx, clock, row):
        conn = ctx.db()
        db.begin_write(conn)
        state = repo.load_session(conn, row["session_id"])["state"]
        MEM.add(state, "scm", "summary", "你今天来陪我吃了午饭。", 0.9, at={"day": 1, "minute": 1200})
        repo.update_session(conn, state, T0)
        conn.execute("COMMIT")
        clock.return_value = "2026-10-28T23:30:00+08:00"
        context = service.get_context(ctx, {"session_id": row["session_id"]})["context"]
        assert context.get("memory_diary_sources"), context


check("a diary due after the last commit shows in the snapshot",
      a_diary_due_after_the_last_commit_shows_up_in_the_snapshot)
check("read previews keep unanswered wake absence without writes", read_previews_keep_the_unanswered_wakes_absence)
check("a real reply restores presence within the same minute", a_real_reply_restores_presence_without_waiting_a_whole_minute)
run("continuity")
