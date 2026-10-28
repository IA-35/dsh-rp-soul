"""The time apart, and the requests for the next commit (settlement steps 4-5).

These live behind `settlement.advance` hooks so the order stays fixed and
testable. The idea is **she keeps living when you are not there**: when you
come back after a while, the engine says what her routine had her doing in the
meantime, and a long enough gap asks the model for an offscreen beat - what
she actually did - before the scene picks up again.

Everything here is derived from state plus the persona's read-only routine.
"""

from .. import persona as PE
from . import agency as AG
from . import clock as CL
from . import facts as FA
from . import state as SS
from . import structure as ST
from .. import modules as MODULES

# 回看作息时的采样步长（分钟）：一天最多 96 个点，够分辨每一段
ROUTINE_STEP = 15


def frozen(state):
    return not state["preferences"]["offscreen_simulation"]


def hooks(turn):
    """Settlement steps 4-5 for a commit of the given turn."""
    return {
        "offscreen": lambda state, report: offscreen(state, report, turn),
        "requests": lambda state, report: settlement_requests(state, report, turn),
    }


def routine_between(card, start, end):
    """What her routine had her doing between two clocks, in order, no repeats.

    A gap of a day or more has been through her whole routine, so it is listed
    whole; a shorter gap is sampled every ROUTINE_STEP minutes.
    """
    total = CL.minutes_between(start, end)
    if total <= 0:
        return []
    if total >= ST.MINUTES_PER_DAY:
        return list(dict.fromkeys(slot["doing"] for slot in card.get("routine") or []))
    out = []
    for offset in list(range(0, total, ROUTINE_STEP)) + [total]:
        minute = (start["minute"] + offset) % ST.MINUTES_PER_DAY
        doing = PE.doing_at(card, minute)
        if doing and doing not in out:
            out.append(doing)
    return out


def offscreen(state, report, turn):
    """Step 4: what the real time apart asks of this commit.

    `brief` (16+ minutes) allows an offscreen beat for her; `full` (an hour or
    more, or a new day) requires one.
    """
    tier = report["tier"]
    cid = SS.companion(state)
    if frozen(state):
        return {"frozen": True, "tier": tier, "required": [], "candidates": []}
    required = [cid] if cid and tier == "full" else []
    candidates = [cid] if cid and tier in ("brief", "full") else []
    return {"frozen": False, "tier": tier, "required": required, "candidates": candidates}


def settlement_requests(state, report, turn):
    """Step 5 during a skip: whether a new day began (her daily summary follows)."""
    return {"crossed_day": report["crossed_day"]}


def finalize_requests(state, crossed_day):
    """Step 5 once per record, after every operation: what the next record pays.

    Her daily memory summary (the oldest finished day that is not summarised
    yet) and, once 这几天 fills up, the month's diary entry.
    """
    MODULES.run(state, "close_record")
    return state["requests"]


def preview_npc(state, cid, report, persona=None):
    """Her side of the time apart: what her routine had her doing, what she is
    now inclined to do, and the last few things she knows."""
    char = state["characters"][cid]
    known = FA.of(state).known_to(cid)
    known.sort(key=lambda f: (f["turn"], FA.order(f)))
    # 她此刻想干什么不来自人设：和在场时用的是同一套候选（agency.candidates）。
    goal = None
    if persona is not None:
        options = AG.candidates(state, persona, cid, state["turn"] + 1, at=state["clock"], limit=1)
        if options:
            goal = options[0].get("text")
    return {
        "npc_id": cid,
        "name": char["name"],
        "goal": goal,
        "routine": routine_between(char, report["from"], report["to"]),
        "knows": [{"id": f["id"], "text": f["text"]} for f in known[-5:]],
    }


def preview_payload(state, report, persona=None):
    """What the elapsed real time settled, right after steps 1-4.

    Built at the same point for the commit result and for its summary, so what
    the model is told happened is exactly what was settled.
    """
    off = report.get("offscreen") or {}
    return {
        "from": dict(report["from"], label=CL.label(report["from"])),
        "to": dict(report["to"], label=CL.label(report["to"])),
        "minutes": report["minutes"],
        "tier": report["tier"],
        "crossed_day": report["crossed_day"],
        "new_scene": bool(report["scene"]),
        "resolved_events": [dict(e) for e in report["resolved_events"]],
        "expired_conditions": [dict(c) for c in report["expired_conditions"]],
        "expired_thoughts": [dict(t) for t in report.get("expired_thoughts") or []],
        "frozen": bool(off.get("frozen")),
        "required_beats": [preview_npc(state, cid, report, persona) for cid in off.get("required", [])],
        "beat_candidates": list(off.get("candidates", [])),
    }


def label(state):
    return CL.label(state["clock"])
