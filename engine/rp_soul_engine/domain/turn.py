"""One narrative turn: validate and apply a commit on a working copy.

All-or-nothing: any invalid operation rejects the whole commit and the
caller's state is untouched (the working copy is discarded).

Order inside a commit:
  1. replaces_turn: restore the state before the replaced turn (same commit)
  2. the requests the record was written from (chapter summary, prologue):
     its first turn pays them, so the later turns see none
  3. the clock settles to the real moment first, in the fixed order of
     settlement.advance() (the offscreen step runs as a hook): the time apart
     happened *before* this turn, so an offscreen beat describes it and a
     thought or event written now starts at now. No operation moves the
     clock: the span is real time, not authored
  4. operations in order
  5. required offscreen beats, the break-band outburst, action mode, intimacy
     and safety checks
  6. invariants, then bookkeeping: memory, chapter archive, prologue

close_record runs once after the last turn of a record and sets what the
engine asks of the next record.
"""

from .. import schema as S
from ..errors import INVARIANT_VIOLATION, INVALID_INPUT, AppError, detail, top_code
from ..jsonio import copy
from . import clock as CL
from . import facts as FA
from . import invariants
from . import mood as MO
from . import ops as OPS
from . import simulation
from . import state as SS
from . import structure as ST

F = S.Field
MAX_MEMORY_TURNS = 40          # backstop only: chapter summaries keep it near 20
UNDO_KEEP = 30                 # undo points kept per session
REWRITE_OPS = ("add_fact", "npc_action", "npc_state", "offscreen_beat", "add_thought")


def commit_fields():
    """The commit schema. `player_input` is echoed back, never used by the engine."""
    return {
        "action_mode": F(S.Enum(*ST.ACTION_MODES),
                         desc="result 玩家的话成了事实 / attempt 玩家在尝试 / rewrite “其实……” / continue 玩家没说没做 / wait 时间在走"),
        "player_input": F(S.Str(0, 2000), desc="玩家这一句的原话（继续时可为空字符串）"),
        "player_authorized": F(S.Bool(), required=False, default=False,
                               desc="玩家本人的话授权了玩家角色的承诺、交易、同意或设定修改时为 true"),
        "acts_on_her": F(S.Nullable(S.Bool()), required=False, default=None,
                         desc="玩家这次行动是不是冲着TA（TA的身体、意志、东西）；attempt 不冲着TA时写 false"),
        "operations": F(S.List(OPS.op_spec(), max_items=40), desc="操作列表（可以为空数组）"),
        "content_tags": F(S.List(S.Enum(*ST.TAG_IDS), max_items=12, unique=True),
                          desc="本回合正文涉及的内容标签（可为空数组）；只用内置标签表里的 id"),
        "summary": F(S.Str(1, 120), desc="本回合发生了什么，第三方视角，≤120 字"),
        "open_action": F(S.Str(1, 80), desc="回合停在哪里、谁在等谁，≤80 字"),
        "quotes": F(S.List(S.Str(1, 80), max_items=3), required=False, default=[],
                    desc="≤3 条对后续有意义的原话，每条 ≤80 字"),
        "chapter_summary": F(S.Nullable(S.Str(1, 300)), required=False, default=None,
                             desc="requests.chapter_summary 为 true 时在记录的第一项必填：上一章的摘要，≤300 字"),
        "prologue": F(S.Nullable(S.Str(1, 300)), required=False, default=None,
                      desc="requests.prologue 为 true 时在记录的第一项必填：把旧前情与最早几章合并成一段，≤300 字"),
        "replaces_turn": F(S.Nullable(S.Int(1, 1000000)), required=False, default=None,
                           desc="“刚才不算，改成……”：填当前最后一个回合的回合号，只能写在记录的第一项"),
    }


def _raise(errors, **extra):
    code = top_code(errors, INVARIANT_VIOLATION)
    message = errors[0]["reason"] if len(errors) == 1 else "提交有 %d 处问题，状态没有改变" % len(errors)
    raise AppError(code, message, errors, **extra)


# ---------------------------------------------------------------------------
# undo and rewrite


def restore(snapshot, current):
    """The state before a turn, keeping what an undo never takes back.

    Player settings made after that turn (boundaries, pause, preferences), the
    session identity, the undo floor and the id counters (ids are never reused)
    come from `current`.
    """
    state = copy(snapshot)
    if "facts" not in snapshot:
        # Storage keeps facts outside the snapshot and has already reverted the
        # undone turn's fact changes (journal); keep its source.
        state["facts"] = current["facts"]
    state["session_id"] = current["session_id"]
    state["revision"] = current["revision"]
    state["undo_floor"] = current["undo_floor"]
    state["safety"] = copy(current["safety"])
    state["preferences"] = copy(current["preferences"])
    state["counters"]["next"] = copy(current["counters"]["next"])
    state["mood_base"] = current["mood_base"]
    state["mood_thresholds"] = copy(current["mood_thresholds"])
    return state


def _undo_problem(current, turn, snapshot, path):
    if turn <= current["undo_floor"]:
        return detail(
            path, "第 %d 回合是本次读档或开局的那一回合，不能再往回退" % turn,
            "撤销最多退到本次读档或开局为止", INVARIANT_VIOLATION,
        )
    if snapshot is None or snapshot["turn"] != turn - 1:
        return detail(
            path, "第 %d 回合的撤销点已经不在了" % turn,
            "只保留最近 %d 回合的撤销点" % UNDO_KEEP, INVARIANT_VIOLATION,
        )
    return None


def undo(current, snapshot):
    """Undo the last turn. Returns (state, result); revision +1, turn -1."""
    turn = current["turn"]
    problem = _undo_problem(current, turn, snapshot, "$")
    if problem is not None:
        raise AppError(INVARIANT_VIOLATION, problem["reason"], [problem])
    state = restore(snapshot, current)
    state["revision"] = current["revision"] + 1
    return state, {"undone_turn": turn, "turn": state["turn"]}


def _replace_base(current, turn, snapshot):
    if turn != current["turn"]:
        _raise([detail(
            "$.replaces_turn", "只能改写当前最后一个回合（第 %d 回合）" % current["turn"],
            "replaces_turn 填 %d" % current["turn"], INVARIANT_VIOLATION,
        )])
    problem = _undo_problem(current, turn, snapshot, "$.replaces_turn")
    if problem is not None:
        _raise([problem])
    return restore(snapshot, current)


# ---------------------------------------------------------------------------
# checks


def _request_checks(ctx):
    commit = ctx.commit
    requests = ctx.state["requests"]
    if requests.get("chapter_summary"):
        if not commit["chapter_summary"]:
            ctx.error(
                "$.chapter_summary",
                "引擎要求这次记录的第一个回合附章节摘要",
                "把第 %d–%d 回合写成 ≤300 字的章节摘要，放进 chapter_summary"
                % (chapter_start(ctx.state), ctx.turn - 1),
            )
    elif commit["chapter_summary"]:
        ctx.error(
            "$.chapter_summary",
            "引擎没有要求章节摘要",
            "去掉 chapter_summary；章节在每 20 回合或跨日后由引擎要求，要求在记录结束时出现，由下一次记录的第一项补上",
            INVALID_INPUT,
        )
    if requests.get("prologue"):
        if not commit["prologue"]:
            ctx.error(
                "$.prologue",
                "章节超过上限，引擎要求把最早几章合并成一段前情",
                "读完整上下文的 prologue_merge，合并成 ≤300 字放进 prologue",
            )
    elif commit["prologue"]:
        ctx.error("$.prologue", "引擎没有要求前情", "去掉 prologue", INVALID_INPUT)


def _mode_checks(ctx):
    commit = ctx.commit
    mode = commit["action_mode"]
    her = ctx.her
    on_her = commit["acts_on_her"]
    if mode == "result" and on_her:
        ctx.error(
            "$.action_mode",
            "冲着TA（身体、意志、东西）的行动是尝试档，不是结果档",
            "改为 attempt，并附TA的回应（npc_response）",
        )
    if mode == "attempt":
        if on_her is None and not ctx.responses:
            ctx.error(
                "$.acts_on_her",
                "尝试档要么附TA的回应，要么用 acts_on_her: false 声明这次尝试不冲着TA",
                "冲着TA的尝试，结果由TA和处境决定：加一条 npc_response",
            )
        # 崩溃档里她回应不了；那条 provoke/leave 就是她对这次尝试的反应
        if on_her and her not in ctx.responses and her not in ctx.break_actors:
            ctx.error(
                "$.operations", "尝试冲着 %s，却没有TA的回应" % ctx.name(her),
                "加一条 npc_response（拒绝/协商/有限配合/表面配合/真诚配合）",
            )
    if mode in ("continue", "wait"):
        if commit["player_authorized"]:
            ctx.error("$.player_authorized", "继续/等待回合里玩家没有做决定，不能带 player_authorized", "去掉它")
        if not ctx.observable and not ctx.op_failed:
            ctx.error(
                "$.operations", "继续/等待回合至少要有一个可观察的变化",
                "让TA行动、状况变化或记下新的事（npc_action、npc_state、add_fact 等）",
            )
    if mode == "rewrite":
        if not commit["player_authorized"]:
            ctx.error("$.player_authorized", "“其实……”只能由玩家发起", "带 player_authorized: true")
        if on_her:
            ctx.error("$.acts_on_her", "“其实……”回合不冲着TA", "acts_on_her 留空；TA的反应用 npc_action、npc_state")
        retcons = [a for a in ctx.applied if a["op"] == "add_fact" and a.get("origin") == "retcon"]
        if not retcons and not ctx.op_failed:
            ctx.error("$.operations", "“其实……”回合至少要有一条追溯事实（add_fact，origin: retcon）")


def _break_checks(ctx):
    """Break band: if she was with you at the start of the turn, she lashes out or leaves.

    The band is the one the turn started in, so a commit cannot dodge it by
    adding a cheerful thought first. A rewrite turn only restates the past.
    """
    if ctx.mode == "rewrite":
        return
    player = ctx.state["player_id"]
    if player not in ctx.start_present:
        return
    for cid in sorted(ctx.start_present - {player}):
        if ctx.start_bands.get(cid) == "break" and cid not in ctx.break_actors:
            ctx.error(
                "$.operations",
                "%s 这回合在崩溃档，必须有一条重大的 provoke 或 leave" % ctx.name(cid),
                "加一条 npc_action：npc_id %s、significant: true、kind: provoke 或 leave（不受冷却限制）" % cid,
            )


def _beat_checks(ctx):
    """Every NPC a large real-time gap named must get an offscreen beat,
    written after the gap: the beat is what they did while nobody was there."""
    missing = [npc for npc in ctx.required_beats if npc not in ctx.beats_after_time]
    if not missing:
        return None
    report = ctx.settlements[0]
    names = "、".join(ctx.name(npc) for npc in missing)
    hint = "用 offscreen_beat 补一段 %s 在你不在时做了什么；错误附带的 preview 给出TA的作息、此刻倾向与知道的事" % names
    for npc in missing:
        ctx.error("$.operations", "隔了这么久，%s 必须有一段离屏片段" % ctx.name(npc), hint)
    return report["preview"]


def _intimacy_checks(ctx):
    commit = ctx.commit
    tags = set(commit["content_tags"])
    if not tags & set(ST.STRUCTURAL_INTIMACY_TAGS):
        return
    her = ctx.her
    if not SS.is_present(ctx.state, her):
        ctx.error("$.content_tags", "%s 不在你身边" % ctx.name(her))
    if commit["action_mode"] not in ("result", "attempt") or not commit["player_authorized"]:
        ctx.error("$.player_authorized", "亲密场景里玩家的同意只能来自玩家本人的指令（result/attempt + player_authorized）")
    cooperative = [r for r in ctx.responses.get(her, []) if r in ST.COOPERATIVE_RESPONSES]
    if not cooperative and her not in ctx.significant_actors():
        ctx.error(
            "$.operations",
            "%s 在这一回合里没有 partial/genuine 回应或主动行动" % ctx.name(her),
            "每一步都要有TA可见的回应；没有回应就不能继续",
        )


# ---------------------------------------------------------------------------
# long-term memory


def chapter_start(state):
    counters = state["counters"]
    return 1 if counters["chapter"] == 1 and not state["memory"]["chapters"] else counters["last_chapter_turn"] + 1


def _close_chapter(state, turn, summary):
    """Archive the turns before `turn` and the ended events; add the chapter."""
    memory = state["memory"]
    counters = state["counters"]
    archive = []
    kept = []
    for entry in memory["turns"]:
        if entry["turn"] < turn:
            archive.append(("turn", entry))
        else:
            kept.append(entry)
    memory["turns"] = kept
    for eid in sorted(state["events"], key=lambda e: int(e[1:])):
        event = state["events"][eid]
        if event["state"] != "pending" and event["resolved_turn"] is not None and event["resolved_turn"] < turn:
            archive.append(("event", event))
            del state["events"][eid]
    days = [payload["day"] for kind, payload in archive if kind == "turn"]
    chapter = {
        "index": len(memory["chapters"]) + 1,
        "from_turn": chapter_start(state),
        "to_turn": turn - 1,
        "day": days[-1] if days else state["clock"]["day"],
        "summary": summary,
    }
    counters["last_chapter_turn"] = turn - 1
    memory["chapters"].append(chapter)
    return chapter, archive


def _merge_prologue(state, text):
    memory = state["memory"]
    merged = memory["chapters"][: simulation.PROLOGUE_MERGE]
    memory["chapters"] = memory["chapters"][simulation.PROLOGUE_MERGE:]
    archive = [("chapter", chapter) for chapter in merged]
    if memory["prologue"]:
        archive.insert(0, ("prologue", {"text": memory["prologue"]}))
    memory["prologue"] = text
    return archive


def _simulation_result(ctx):
    report = ctx.settlements[0]
    preview = report["preview"]
    sim = {key: preview[key] for key in ("tier", "minutes", "crossed_day") if key in preview}
    for key in ("moved", "spread", "expired_conditions", "expired_thoughts"):
        if preview.get(key):
            sim[key] = preview[key]
    if preview.get("frozen") and report["tier"] != "routine":
        sim["frozen"] = True
    if ctx.beats:
        sim["offscreen_beats"] = list(ctx.beats)
    if report["tier"] == "routine" and len(sim) <= 3:
        return None
    return sim


# ---------------------------------------------------------------------------


def commit_turn(state, persona, commit, undo_snapshot=None, now=None):
    """Return (new_state, result) or raise AppError with every problem found.

    `undo_snapshot` is the stored state from before turn `replaces_turn`
    (loaded by the application); that turn is undone in this same commit.

    `now` is the real moment this turn happens (an ISO timestamp, so the record
    stays reproducible). The clock is read off it: `real_at` is the moment the
    last turn settled, and the difference between the two is the span this turn
    pays for. The model never chooses it.
    """
    replaced = commit["replaces_turn"]
    base = _replace_base(state, replaced, undo_snapshot) if replaced is not None else state
    work = FA.working_copy(base)
    ctx = OPS.TurnContext(work, persona, commit, simulation.hooks(work["turn"] + 1))
    ctx.significant_actors = lambda: {a["npc_id"] for a in ctx.applied if a["op"] == "npc_action"}
    before_clock = dict(work["clock"])
    _request_checks(ctx)
    span, to_clock = SS.real_span(work, now)
    work["real_at"] = now
    OPS.advance(ctx, span, "$", default=True, to_clock=to_clock)
    for index, op in enumerate(commit["operations"]):
        path = "$.operations[%d]" % index
        if ctx.mode == "rewrite" and op["op"] not in REWRITE_OPS:
            ctx.error(
                path + ".op",
                "“其实……”回合不能用 %s" % op["op"],
                "只允许追溯事实（add_fact，origin: retcon）与TA的反应（npc_action、npc_state、add_thought）",
            )
            continue
        OPS.apply_op(ctx, op, path)
    ctx.op_failed = bool(ctx.errors)
    preview = _beat_checks(ctx)
    _break_checks(ctx)
    _mode_checks(ctx)
    _intimacy_checks(ctx)
    for problem in OPS.check_safety_tags(work, commit["content_tags"]):
        ctx.errors.append(problem)
    if not ctx.errors:
        ctx.errors.extend(invariants.check(work, before_clock))
    if ctx.errors:
        if preview is not None:
            _raise(ctx.errors, preview=preview)
        _raise(ctx.errors)

    # -- bookkeeping --------------------------------------------------------
    work["turn"] = ctx.turn
    work["revision"] = state["revision"] + 1
    memory = work["memory"]
    entry = {
        "turn": ctx.turn,
        "day": work["clock"]["day"],
        "mode": commit["action_mode"],
        "summary": commit["summary"],
        "open_action": commit["open_action"],
        "quotes": list(commit["quotes"]),
    }
    if ctx.beats:
        entry["offscreen"] = [{"npc_id": b["npc_id"], "summary": b["summary"]} for b in ctx.beats]
    archive = []
    chapter = None
    if commit["chapter_summary"]:
        chapter, archive = _close_chapter(work, ctx.turn, commit["chapter_summary"])
        work["requests"]["chapter_summary"] = False
    if commit["prologue"]:
        archive.extend(_merge_prologue(work, commit["prologue"]))
        work["requests"]["prologue"] = False
    memory["turns"].append(entry)
    overflow = memory["turns"][:-MAX_MEMORY_TURNS]
    if overflow:
        archive.extend(("turn", old) for old in overflow)
        del memory["turns"][:-MAX_MEMORY_TURNS]
    memory["open_action"] = commit["open_action"]
    memory["last_quotes"] = list(commit["quotes"])
    crossed_day = work["clock"]["day"] > before_clock["day"]
    work["facts"] = work["facts"].settle()
    scene_changed = any(s["scene"] for s in ctx.settlements)
    result = {
        "turn": ctx.turn,
        "applied": ctx.applied,
        "resolved_events": ctx.resolved_events,
        "thoughts": list(ctx.thoughts),
        "simulation": _simulation_result(ctx),
        "clock": dict(work["clock"], label=CL.label(work["clock"])),
        "time_settled": span,
        "scene_changed": scene_changed,
        "crossed_day": crossed_day,
        "chapter": chapter,
        "replaced_turn": replaced,
        "mood": {
            cid: MO.brief(work, cid)
            for cid in SS.npcs(work)
        },
        # internal, for the application: archive rows and the replaced turn's undo base
        "archive": [{"kind": kind, "payload": payload} for kind, payload in archive],
        "undo_base": base if replaced is not None else None,
    }
    return work, result


def close_record(state, results):
    """After the last turn of a record, in place: what the engine asks of the
    next record. A request raised by a turn in the middle waits until here, so
    the next record's first turn is the one that pays it."""
    crossed_day = any(result["crossed_day"] for result in results)
    return simulation.finalize_requests(state, crossed_day)
