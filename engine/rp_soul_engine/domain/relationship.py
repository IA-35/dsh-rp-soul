"""Directed relationship edges: trust, tension, stage.

One edge per direction, keyed "%s>%s", because A liking B says nothing about
B liking A. The *stage* is the exception: it is the pair's shared history, so
advancing it writes both directions in step and both sides need evidence from
the same turn.

Three hard rules, all enforced here rather than trusted to the model:

* trust moves at most MAX_TRUST_DELTA per turn and net (start -> end), so a
  model cannot ramp it by submitting two small operations;
* a stage advance needs evidence: the player acted this turn (result/attempt)
  *and* the other side answered partial/genuine; two NPCs need both to have
  acted;
* out-of-range values are reported, never silently clamped - a clamp would
  hide the model's mistake and let the story drift.

Every change appends to a capped history (12 rows) with the reason, so an
"undo" and a later "why is he cold" both have an answer.
"""

from ..errors import INVARIANT_VIOLATION, NOT_FOUND, detail
from . import state as SS
from . import structure as ST

HISTORY_CAP = 12


def new_edge(a, b, stage="stranger"):
    return {"from": a, "to": b, "trust": 0, "tension": 0, "stage": stage, "history": []}


def _maybe_create(state, a, b, stage="stranger"):
    key = SS.edge_key(a, b)
    edge = state["relationships"].get(key)
    if edge is None:
        edge = new_edge(a, b, stage)
        state["relationships"][key] = edge
    return edge


def evidence(ctx, a, b, path, errs):
    """What justifies a stage advance this turn. None + an error when absent."""
    player = ctx.state["player_id"]
    if player in (a, b):
        npc = b if a == player else a
        if ctx.mode not in ("result", "attempt"):
            errs.append(detail(
                path + ".stage_advance",
                "亲近进程前进需要玩家本回合的行动（result/attempt）",
                None, INVARIANT_VIOLATION,
            ))
            return None
        cooperative = [r for r in ctx.responses.get(npc, []) if r in ST.COOPERATIVE_RESPONSES]
        if not cooperative:
            errs.append(detail(
                path + ".stage_advance",
                "亲近进程前进需要同一回合里 %s 的 partial 或 genuine 回应" % ctx.name(npc),
                "先写 npc_response；阶段是双方共同经历的历史，不是一方说了算",
                INVARIANT_VIOLATION,
            ))
            return None
        return {"player_action_turn": ctx.turn, "npc_response": cooperative[-1]}
    if a not in ctx.actors or b not in ctx.actors:
        errs.append(detail(
            path + ".stage_advance",
            "两名 NPC 之间的阶段前进需要双方本回合都有行动或回应",
            None, INVARIANT_VIOLATION,
        ))
        return None
    return {"npc_actions_turn": ctx.turn}


def change(ctx, a, b, trust_delta, tension_delta, stage_advance, stage_retreat_to, reason, path):
    """Validate and apply one relationship change. Returns (record|None, errs)."""
    errs = []
    state = ctx.state
    for cid, key in ((a, "from"), (b, "to")):
        if cid not in state["characters"]:
            errs.append(detail("%s.%s" % (path, key), "角色不存在：%s" % cid, None, NOT_FOUND))
    if a == b:
        errs.append(detail(path, "关系的两端不能是同一个人", None, INVARIANT_VIOLATION))
    if errs:
        return None, errs
    key = SS.edge_key(a, b)
    current = state["relationships"].get(key)
    # A relationship needs a scene: two people who never met cannot have one.
    if current is None and not (SS.is_present(state, a) and SS.is_present(state, b)) and ctx.in_beat is None:
        errs.append(detail(
            path,
            "%s 与 %s 还没有实际接触过，关系要在两人同场时建立" % (ctx.name(a), ctx.name(b)),
            None, INVARIANT_VIOLATION,
        ))
    if not trust_delta and not tension_delta and not stage_advance and stage_retreat_to is None:
        errs.append(detail(path, "关系没有任何变化", None, INVARIANT_VIOLATION))
    if stage_advance and stage_retreat_to is not None:
        errs.append(detail(path, "不能同时前进与后退", None, INVARIANT_VIOLATION))
    player = state["player_id"]
    if a == player and (trust_delta or tension_delta) and ctx.mode not in ("result", "attempt"):
        errs.append(detail(
            path, "玩家角色对别人的态度只随玩家自己的行动变化",
            "不替玩家下情绪结论", INVARIANT_VIOLATION,
        ))
    trust = current["trust"] if current else 0
    tension = current["tension"] if current else 0
    stage = current["stage"] if current else "stranger"
    start = ctx.trust_start.setdefault(key, trust)
    new_trust = trust + trust_delta
    new_tension = tension + tension_delta
    if not ST.TRUST_RANGE[0] <= new_trust <= ST.TRUST_RANGE[1]:
        errs.append(detail(
            path + ".trust_delta", "信任将变成 %d，超出 -5..5" % new_trust,
            "不会自动截断，换一个幅度", INVARIANT_VIOLATION,
        ))
    elif abs(new_trust - start) > ST.MAX_TRUST_DELTA:
        errs.append(detail(
            path + ".trust_delta", "一个回合里信任净变化不能超过 %d" % ST.MAX_TRUST_DELTA,
            None, INVARIANT_VIOLATION,
        ))
    if not ST.TENSION_RANGE[0] <= new_tension <= ST.TENSION_RANGE[1]:
        errs.append(detail(
            path + ".tension_delta", "张力将变成 %d，超出 0..5" % new_tension,
            "不会自动截断，换一个幅度", INVARIANT_VIOLATION,
        ))
    pair = frozenset((a, b))
    new_stage = stage
    why = None
    if stage_advance:
        index = SS.stage_index(stage)
        if index + 1 >= len(ST.STAGES):
            errs.append(detail(path + ".stage_advance", "已经是最后一个阶段", None, INVARIANT_VIOLATION))
        elif pair in ctx.stage_pairs:
            errs.append(detail(path + ".stage_advance", "同一回合里这对关系只能前进一个阶段", None, INVARIANT_VIOLATION))
        else:
            new_stage = ST.STAGES[index + 1]
            why = evidence(ctx, a, b, path, errs)
    if stage_retreat_to is not None:
        if SS.stage_index(stage_retreat_to) >= SS.stage_index(stage):
            errs.append(detail(
                path + ".stage_retreat_to", "后退的目标必须低于当前阶段（%s）" % stage,
                None, INVARIANT_VIOLATION,
            ))
        else:
            new_stage = stage_retreat_to
    if errs:
        return None, errs

    if current is None:
        current = _maybe_create(state, a, b, stage)
    changes = []
    if trust_delta:
        current["trust"] = new_trust
        changes.append("trust%+d" % trust_delta)
    if tension_delta:
        current["tension"] = new_tension
        changes.append("tension%+d" % tension_delta)
    if new_stage != stage:
        changes.append("stage:%s" % new_stage)
        ctx.stage_pairs.add(pair)
        current["stage"] = new_stage
        other = _maybe_create(state, b, a, new_stage)
        other["stage"] = new_stage
        other["history"].append({"turn": ctx.turn, "change": "stage:%s" % new_stage, "reason": reason})
        del other["history"][:-HISTORY_CAP]
    record = {"turn": ctx.turn, "change": ",".join(changes), "reason": reason}
    if why:
        record["evidence"] = why
    current["history"].append(record)
    del current["history"][:-HISTORY_CAP]
    ctx.relationship_reasons.append(reason)
    return {
        "from": a,
        "to": b,
        "trust": current["trust"],
        "tension": current["tension"],
        "stage": current["stage"],
        "trust_delta": trust_delta,
        "stage_changed": new_stage != stage,
    }, []


def pair_stage(state, a, b):
    """The shared stage, read from either direction."""
    edge = SS.edge(state, a, b)
    return edge["stage"] if edge else "stranger"


def summary(state, cid, player=None, limit=8):
    """Who matters to this character right now, strongest bond first."""
    player = player or state["player_id"]
    rows = []
    for key, edge in state["relationships"].items():
        if edge["from"] != cid:
            continue
        rows.append({
            "character_id": edge["to"],
            "name": (state["characters"].get(edge["to"]) or {}).get("name", edge["to"]),
            "trust": edge["trust"],
            "tension": edge["tension"],
            "stage": edge["stage"],
            "stage_label": SS.stage_label(edge["stage"]),
        })
    rows.sort(key=lambda row: (-abs(row["trust"]), -row["tension"], row["character_id"]))
    return rows[:limit]
