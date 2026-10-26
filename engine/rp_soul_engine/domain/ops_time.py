"""Offscreen beats: what she did while you were apart.

When you come back after a while (16+ minutes allows a beat, an hour or a new
day requires one), the time apart gets a short beat: what she did, felt and
learned on her own. It records only her own actions, states, feelings, facts
she alone knows, and events that do not involve the player - those
constraints keep "she has a life of her own" from quietly rewriting the story
you are in.
"""

from .. import schema as S
from ..errors import INVARIANT_VIOLATION, detail
from . import simulation
from .ops import SPECS, _flush, apply_op, register

F = S.Field

# Only operations that make sense for her on her own.
BEAT_OPS = (
    "npc_state",
    "npc_action",
    "add_thought",
    "add_fact",
    "event_create",
    "event_resolve",
    "event_cancel",
)


def beat_spec():
    return S.List(S.Tagged("op", {name: SPECS[name] for name in BEAT_OPS}, "离屏操作"), max_items=6)


@register(
    "offscreen_beat",
    {
        "summary": F(S.Str(1, 120)),
        "operations": F(S.List(S.Any("离屏操作"), max_items=6), required=False, default=[]),
    },
    "离屏片段：你不在的这段时间TA做了什么（参考上下文里TA的作息）。隔了 16 分钟以上才能写，隔了一小时以上或跨天必须写；"
    "子操作只能是TA自己的行动、状况、心情、只有TA知道的事，以及不涉及你的事件",
    branch=False,
)
def op_offscreen_beat(ctx, op, path):
    errs = []
    state = ctx.state
    npc = ctx.her
    if simulation.frozen(state):
        errs.append(detail(path, "离屏推演已关闭，不产生离屏片段", "玩家打开离屏推演后再写", INVARIANT_VIOLATION))
    else:
        if npc in ctx.beat_npcs:
            errs.append(detail(path, "同一回合里只能有一段离屏片段", None, INVARIANT_VIOLATION))
        if npc not in ctx.beat_candidates and npc not in ctx.required_beats:
            errs.append(detail(
                path, "你们刚刚还在说话，这段时间不算分开",
                "离屏片段只在隔了 16 分钟以上再回来时写", INVARIANT_VIOLATION,
            ))
    subs, problems = S.validate(beat_spec(), op["operations"], path + ".operations")
    errs.extend(problems)
    if not _flush(ctx, errs):
        return
    outer = ctx.applied
    ctx.applied = []
    ctx.in_beat = npc
    try:
        for index, sub in enumerate(subs):
            apply_op(ctx, sub, "%s.operations[%d]" % (path, index))
    finally:
        sub_applied = ctx.applied
        ctx.applied = outer
        ctx.in_beat = None
    ctx.beat_npcs.add(npc)
    if ctx.settlements:
        ctx.beats_after_time.add(npc)
    ctx.beats.append({"npc_id": npc, "summary": op["summary"]})
    state["counters"]["offscreen_beat_turn"][npc] = ctx.turn
    ctx.observable = True
    ctx.applied.append({"op": "offscreen_beat", "npc_id": npc, "summary": op["summary"], "applied": sub_applied})
