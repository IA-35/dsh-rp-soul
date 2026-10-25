"""Offscreen beats: what an absent NPC did while the player was not there.

An offscreen beat records only that NPC's own actions, states, movements,
relations with other NPCs, facts, and events that do not involve the player.
It never touches the player character, never gives an NPC knowledge outside
its information set, and never settles an event the player is part of - those
constraints are what keep "the world keeps turning" from quietly rewriting the
story the player is in.

Twists and rumor spreading are gone: they were world-pack content. The mood
mark a beat leaves is derived, not authored, so an absent character's feelings
still move when something happens to him off screen.
"""

from .. import schema as S
from ..errors import INVARIANT_VIOLATION, NOT_FOUND, detail
from . import simulation
from . import state as SS
from .ops import SPECS, _flush, apply_op, register

F = S.Field

# Only operations that make sense for a character acting alone off screen.
BEAT_OPS = (
    "npc_state",
    "npc_action",
    "add_thought",
    "move",
    "add_fact",
    "relationship",
    "reveal_fact",
    "event_create",
    "event_resolve",
    "event_cancel",
)

ID_FIELDS = (
    "npc_id", "character_id", "from", "to", "known_by", "believed_by",
    "participants", "target_id", "basis_fact_id",
)


def beat_spec():
    return S.List(S.Tagged("op", {name: SPECS[name] for name in BEAT_OPS}, "离屏操作"), max_items=6)


def _mentions(op, cid):
    for field in ID_FIELDS:
        value = op.get(field)
        if value == cid or (isinstance(value, list) and cid in value):
            return True
    return False


def _actor_ok(ctx, npc, op):
    """The beat's subject must be the actor, the knower, or one edge end."""
    kind = op["op"]
    state = ctx.state
    if kind in ("npc_state", "npc_action", "add_thought"):
        return op["npc_id"] == npc
    if kind == "move":
        return op["character_id"] == npc
    if kind == "add_fact":
        return npc in op["known_by"] or npc in op["believed_by"]
    if kind == "relationship":
        return npc in (op["from"], op["to"])
    if kind == "reveal_fact":
        return npc in op["to"]
    if kind == "event_create":
        return npc in op["participants"]
    if kind in ("event_resolve", "event_cancel"):
        event = state["events"].get(op["event_id"])
        return event is None or npc in event["participants"]
    return False


@register(
    "offscreen_beat",
    {
        "npc_id": F(S.Id()),
        "summary": F(S.Str(1, 120)),
        "operations": F(S.List(S.Any("离屏操作"), max_items=6), required=False, default=[]),
    },
    "离屏片段：不在场的重要 NPC 在这段时间里做了什么。只能写上下文 `offscreen_beat_candidates` 或推进时间后要求的 NPC；子操作只能是这个 NPC 自己的行动、状态、心情、移动，NPC 之间的关系与消息，以及不涉及玩家的事件",
    branch=False,
)
def op_offscreen_beat(ctx, op, path):
    errs = []
    state = ctx.state
    npc = op["npc_id"]
    if simulation.frozen(state):
        errs.append(detail(path, "离屏推演已冻结，不产生离屏片段", "玩家打开离屏推演后再写", INVARIANT_VIOLATION))
    elif npc not in state["characters"]:
        errs.append(detail(path + ".npc_id", "角色不存在：%s" % npc, None, NOT_FOUND))
    else:
        if npc in ctx.beat_npcs:
            errs.append(detail(path + ".npc_id", "同一回合里 %s 只能有一段离屏片段" % ctx.name(npc), None, INVARIANT_VIOLATION))
        if npc not in ctx.beat_candidates and npc not in ctx.required_beats:
            hint = "只能写上下文 requests.offscreen_beat_candidates 里列出的、或时间结算后引擎点名要补的 NPC"
            errs.append(detail(path + ".npc_id", "%s 不在离屏片段的候选里" % ctx.name(npc), hint, INVARIANT_VIOLATION))
        if SS.is_present(state, npc):
            errs.append(detail(path + ".npc_id", "%s 在场，不是离屏" % ctx.name(npc), None, INVARIANT_VIOLATION))
    subs, problems = S.validate(beat_spec(), op["operations"], path + ".operations")
    errs.extend(problems)
    if subs is not None:
        player = state["player_id"]
        for index, sub in enumerate(subs):
            sub_path = "%s.operations[%d]" % (path, index)
            if _mentions(sub, player):
                errs.append(detail(sub_path, "离屏片段不能改变或牵涉玩家角色", "玩家角色只在台前行动", INVARIANT_VIOLATION))
            elif not _actor_ok(ctx, npc, sub):
                errs.append(detail(sub_path, "离屏片段里的操作必须是 %s 自己做的、自己知道的或与自己有关的" % ctx.name(npc), None, INVARIANT_VIOLATION))
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
