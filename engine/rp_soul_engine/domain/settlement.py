"""Settlement of elapsed time, in a fixed order:

1. clock forward to the real moment (a gap of >= 60 minutes starts a new
   stretch of time together, a new scene)
2. due events, by (due, id): expire, roll chance events, surface foreshadows
3. timed conditions expire, then mood thoughts age
4. offscreen: what the time apart asks of this commit (by span tier)
5. context requests for the next commit

The span is never authored: it is however much real time passed since the last
settled moment (`state["real_at"]`). The model cannot skip ahead, because a
skip that never happened would settle events that are not due yet.

Step 3 is where mood joins: thoughts and conditions share one clock walk, so
a long gap ages a feeling exactly once and never twice. That matters because a
linear-decayed thought is a function of the clock - if two code paths both
"ticked" it, a 5-day grudge would evaporate in a 6-hour gap.
"""

from . import clock as CL
from . import facts as FA
from . import rng
from . import state as SS
from . import structure as ST
from .. import modules as MODULES


def tier_for(minutes):
    """How much the time apart asks, by how long it actually was.

    Crossing midnight is not a gap by itself: if you were talking at 23:50 and
    again at 00:05 there is nothing she did while you were away, so the day
    boundary must not turn fifteen minutes into "an hour apart".
    """
    if minutes >= 60:
        return "full"
    if minutes >= 16:
        return "brief"
    return "routine"


def preview(state, now):
    """Project elapsed time without consuming the stored turn's absence."""
    work = FA.working_copy(state)
    minutes, clock, settled_at = SS.real_span(work, now)
    work["real_at"] = settled_at
    advance(work, minutes, work["turn"] + 1, to_clock=clock)
    return work


def new_scene(state, reason):
    counters = state["counters"]["next"]
    scene_id = "sc%d" % counters["scene"]
    counters["scene"] += 1
    state["scene"]["id"] = scene_id
    state["scene"]["since"] = dict(state["clock"])
    # Interaction judgments never outlive their scene.
    state["scene"]["responses"] = []
    return {"scene_id": scene_id, "reason": reason}


def settle_events(state, until_clock, turn):
    due = [
        e
        for e in state["events"].values()
        if e["state"] == "pending" and CL.to_abs(e["due"]) <= CL.to_abs(until_clock)
    ]
    due.sort(key=lambda e: (CL.to_abs(e["due"]), e["id"]))
    resolved = []
    for event in due:
        if event["kind"] == "chance":
            # Stable coordinates (creating turn, creation index), never the id:
            # an undone and redone turn gets the same roll.
            coord = event.get("coord") or [event["created_turn"], event["id"]]
            roll = rng.unit(state["seed"], "event", coord[0], coord[1])
            outcome = "hit" if roll < event["probability"] else "miss"
        else:
            outcome = ST.DUE_OUTCOME[event["kind"]]
        event["state"] = "resolved"
        event["outcome"] = outcome
        event["resolved_turn"] = turn
        resolved.append({
            "event_id": event["id"],
            "kind": event["kind"],
            "title": event["title"],
            "outcome": outcome,
            "due": dict(event["due"]),
            "participants": list(event["participants"]),
        })
    return resolved


def expire_conditions(state, until_clock):
    now = CL.to_abs(until_clock)
    expired = []
    for cid in sorted(state["characters"]):
        char = state["characters"][cid]
        conditions = char["status"]["conditions"]
        keep = []
        for cond in conditions:
            if cond.get("until") is not None and CL.to_abs(cond["until"]) <= now:
                expired.append({"character_id": cid, "kind": cond["kind"], "text": cond["text"]})
            else:
                keep.append(cond)
        char["status"]["conditions"] = keep
    return expired


def advance(state, minutes, turn, hooks=None, to_clock=None, player_absent=False):
    """Move the clock forward and settle. Returns the settlement report.

    `minutes` is how much real time passed; `to_clock` is the clock that moment
    maps to. When `to_clock` is given the clock is set to it instead of being
    incremented, so a session left alone for three days lands on the right day
    rather than on "day one, minute 4323".

    `hooks` lets later stages plug the offscreen step and request
    computation into steps 4-5 without changing the order.
    """
    hooks = hooks or {}
    before = dict(state["clock"])
    state["clock"] = dict(to_clock) if to_clock is not None else CL.add_minutes(before, minutes)
    crossed_day = state["clock"]["day"] > before["day"]
    report = {
        "from": before,
        "to": dict(state["clock"]),
        "minutes": minutes,
        "tier": tier_for(minutes),
        "crossed_day": crossed_day,
        "steps": ["clock"],
        "scene": None,
        "resolved_events": [],
        "expired_conditions": [],
        "expired_thoughts": [],
        "offscreen": None,
        "requests": None,
    }
    if minutes >= ST.SCENE_BREAK_MINUTES:
        report["scene"] = new_scene(state, "time_skip")
    if minutes > 0 or player_absent:
        # 唤醒回合哪怕一秒都没过去，也要重算一次情境：她一个人醒着，
        # 「你不在」这件事本身就写在她心上。
        report["resolved_events"] = settle_events(state, state["clock"], turn)
        report["steps"].append("events")
        report["expired_conditions"] = expire_conditions(state, state["clock"])
        report["steps"].append("status")
    MODULES.run(state, "settle", report, turn, player_absent)
    if "offscreen" in hooks:
        report["offscreen"] = hooks["offscreen"](state, report)
    report["steps"].append("offscreen")
    if "requests" in hooks:
        report["requests"] = hooks["requests"](state, report)
    report["steps"].append("requests")
    return report
