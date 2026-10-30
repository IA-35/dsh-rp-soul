"""One narrative turn: validate and apply a commit on a working copy.

All-or-nothing: any invalid operation rejects the whole commit and the
caller's state is untouched (the working copy is discarded).

Order inside a commit:
  1. replaces_turn: restore the state before the replaced turn (same commit)
  2. the requests the record was written from (her daily memory summary,
     the periodic archive): its first turn pays them, so the later turns see none
  3. the clock settles to the real moment first, in the fixed order of
     settlement.advance() (the offscreen step runs as a hook): the time apart
     happened *before* this turn, so an offscreen beat describes it and a
     thought or event written now starts at now. No operation moves the
     clock: the span is real time, not authored
  4. operations in order
  5. required offscreen beats, the break-band expression, action mode, intimacy
     and safety checks
  6. invariants, then bookkeeping: the turn log, her memory (summary and
     archive paid by this turn, this turn's entries, ageing)

close_record runs once after the last turn of a record and sets what the
engine asks of the next record.
"""

from .. import schema as S
from ..errors import INVARIANT_VIOLATION, INVALID_INPUT, AppError, detail, top_code
from ..jsonio import copy
from . import clock as CL
from . import common as CM
from . import facts as FA
from . import invariants
from . import memories as MEM
from . import mood as MO
from . import ops as OPS
from . import simulation
from . import state as SS
from . import structure as ST
from .. import modules as MODULES

F = S.Field
MAX_MEMORY_TURNS = 40          # the rolling turn log; her memory lives in memories.py
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
        "remember": F(S.Nullable(S.Str(1, 60)), required=False, default=None,
                      desc="可选：TA 会怎么记得这件事，第一人称、带当时的感受，≤60 字；不写就用 summary 记"),
        "open_action": F(S.Str(1, 80), desc="回合停在哪里、谁在等谁，≤80 字"),
        "quotes": F(S.List(S.Str(1, 80), max_items=3), required=False, default=[],
                    desc="≤3 条对后续有意义的原话，每条 ≤80 字"),
        "memory_fold": F(S.Nullable(S.Str(1, MEM.SUMMARY_MAX)), required=False, default=None,
                         desc="requests.memory_fold 有值时在第一项必填：读 memory_fold_sources，把这一批 ABM 收成一条 SCM（第一人称，保留发生了什么和当时的感受，带得住的细节，≤300 字）"),
        "memory_diary": F(S.Nullable(S.Str(1, MEM.DIARY_MAX)), required=False, default=None,
                          desc="requests.memory_diary 有值时在第一项必填：读 memory_diary_sources，把这一天写成一篇日记（第一人称，按时间顺下来，记得感受和变化，≤300 字）"),
        "memory_keep": F(S.List(S.Str(1, 40), max_items=2), required=False, default=[],
                         desc="可选：这一批里值得一直记着的 0~2 条经历 id；它们会被单独放进 CLPA，不随这一批淡掉"),
        "common": F(
            S.List(
                S.Obj(
                    {
                        "key": F(S.List(S.Str(1, CM.KEY_MAX), min_items=1, max_items=CM.KEYS_MAX),
                                 desc="触发词，命中任意一个就会被想起来；写会用到的叫法（简称、英文名、别名）"),
                        "weight": F(S.Num(*CM.WEIGHT_RANGE), required=False, default=0.5,
                                    desc="权重 0~1：同时命中好几条时，权重高的先注入"),
                        "content": F(S.Str(1, CM.CONTENT_MAX), desc="一条常识本身，客观陈述，不带情绪"),
                    },
                    name="common",
                ),
                max_items=3,
            ),
            required=False,
            default=[],
            desc="可选：总结 SCM 或写日记时，顺手记下 0~3 条以后还会用到的客观常识（一个名词、一个简称指代什么）。写在他以前没解释过、以后还会提到的东西上；你们之间的事属于记忆，不要写在这里",
        ),
        "replaces_turn": F(S.Nullable(S.Int(1, 1000000)), required=False, default=None,
                           desc="“刚才不算，改成……”：填当前最后一个回合的回合号，只能写在记录的第一项"),
        "together": F(S.Bool(), required=False, default=True,
                      desc="这一回合你们在不在一起；她自己醒来的那个回合是 false（由桥接层自动带，模型不用填）"),
        "host_memory": F(S.Bool(), required=False, default=False,
                         desc="宿主会在回合结束后自己收 ABM、写日记（由桥接层自动带，模型不用填）；带上时 memory_fold / memory_diary 不再是必填"),
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


def _mode_checks(ctx):
    commit = ctx.commit
    mode = commit["action_mode"]
    her = ctx.her
    on_her = commit["acts_on_her"]
    if not ctx.together:
        # 你不在场：这一回合没有「玩家做了什么」，只能是她自己的时间。
        if mode in ("result", "attempt", "rewrite"):
            ctx.error(
                "$.action_mode",
                "你不在场，这一回合只能是她自己的时间：action_mode 写 continue（她做了点事）或 wait（时间在走）",
                "她在唤醒回合里说的话由她自己决定；等你回来再说与你有关的事",
            )
        if on_her is not None:
            ctx.error("$.acts_on_her", "你不在场，这一回合没有冲着你的事", "acts_on_her 留空")
        if commit["player_authorized"]:
            ctx.error("$.player_authorized", "你不在场，不能替你授权任何事", "player_authorized 留空")
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
        # 低心情时沉默或独处也可以是反应，不必为了过账强迫她说话。
        if on_her and her not in ctx.responses and her not in ctx.mood_reactions:
            ctx.error(
                "$.operations", "尝试冲着 %s，却没有TA的回应" % ctx.name(her),
                "加一条 npc_response；低心情也可用 silence、seek_comfort、change_topic、withdraw 等行动表达反应",
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


def _beat_checks(ctx):
    """Every NPC a large real-time gap named must get an offscreen beat,
    written after the gap: the beat is what they did while nobody was there."""
    if not ctx.together:
        # 这一回合本身就是她的时间，不必再补一段「你不在时她做了什么」
        return None
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
    if not ctx.together:
        ctx.error("$.content_tags", "你不在场，这一回合不可能有亲密场景", "换个写法：写她自己这半天的事")
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
# her memory: the summary and archive this turn pays


def _archive_ended_events(state, turn):
    """Events that ended before this turn leave the live state (they stay in the archive table)."""
    rows = []
    for eid in sorted(state["events"], key=lambda e: int(e[1:])):
        event = state["events"][eid]
        if event["state"] != "pending" and event["resolved_turn"] is not None and event["resolved_turn"] < turn:
            rows.append(("event", event))
            del state["events"][eid]
    return rows


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
    ctx.significant_actors = lambda: {a["npc_id"] for a in ctx.applied
                                     if a["op"] == "npc_action" and a["kind"] not in ST.MOOD_REACTION_KINDS}
    before_clock = dict(work["clock"])
    MODULES.run(work, "before_turn", ctx)
    span, to_clock, settled_at = SS.real_span(work, now)
    work["real_at"] = settled_at
    OPS.advance(ctx, span, "$", default=True, to_clock=to_clock, player_absent=not ctx.together)
    ctx.capture_start()
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
    MODULES.run(work, "validate_turn", ctx)
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
    work["together"] = ctx.together
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
    payment = MODULES.run(work, "pay_requests", commit, ctx.turn).get("memory", {})
    folded, diary = payment.get("folded"), payment.get("diary")
    learned = payment.get("common") or []
    archive = _archive_ended_events(work, ctx.turn) if folded else []
    memory["turns"].append(entry)
    overflow = memory["turns"][:-MAX_MEMORY_TURNS]
    if overflow:
        archive.extend(("turn", old) for old in overflow)
        del memory["turns"][:-MAX_MEMORY_TURNS]
    # 你说过话的那一刻：唤醒线的「想你了」以它为基准。
    if commit["player_input"].strip():
        work["last_player_at"] = now
    # 说好做到的时间已经过了：这条安排就算兑现完了，不能拿它反复把她叫醒。
    plan = OPS.current_plan(work)
    if plan is not None and CL.to_abs(plan["until"]) <= CL.to_abs(work["clock"]):
        OPS.clear_plan(work)
    memory["open_action"] = commit["open_action"]
    memory["last_quotes"] = list(commit["quotes"])
    memory_result = MODULES.run(work, "after_turn", ctx, commit, base).get("memory", {})
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
        "folded": folded["id"] if folded else None,
        "diary": diary,
        "remembered": memory_result.get("remembered", []),
        "forgetting": memory_result.get("forgetting", {}),
        # 模型在这次总结 / 写日记里顺手记下的常识，由 application 写进全局库
        "learned_common": learned,
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
