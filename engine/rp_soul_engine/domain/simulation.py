"""Offscreen simulation, propagation and context requests (steps 4-6).

These live behind `settlement.advance` hooks so the order stays fixed and
testable. Two ideas do the work:

* **he keeps living when you are not there.** Each character may carry a
  ``schedule`` (a list of {from, to, location_id} in minutes-of-day); a time
  skip moves him along it. That is how a character can be somewhere else when
  you come back, without the model inventing a reason.
* **what he knows travels along the edges you built.** A spreading fact moves
  one hop per neighbour, with a chance derived from (seed, fact coords,
  neighbour, turn, hop) - a redo of a turn spreads it the same way.

Twists are gone: they were world-pack content. Everything here is derived
from state plus the persona's read-only cast/places.
"""

from . import agency as AG
from . import clock as CL
from . import facts as FA
from . import rng
from . import state as SS
from . import structure as ST

SPREAD_CHANCE = 0.5
MAX_SPREAD_HOPS = 3
MAX_REQUIRED_BEATS = 3
MAX_CANDIDATES = 3
CHAPTER_EVERY = 20
CHAPTER_CAP = 10
PROLOGUE_MERGE = 5


def frozen(state):
    return not state["preferences"]["offscreen_simulation"]


def hooks(turn):
    """Settlement steps 4-5 for a commit of the given turn."""
    return {
        "offscreen": lambda state, report: offscreen(state, report, turn),
        "propagation": lambda state, report: propagation(state, report, turn),
        "requests": lambda state, report: settlement_requests(state, report, turn),
    }


def _absent_majors(state):
    present = set(state["scene"]["present"])
    return sorted(
        cid
        for cid, char in state["characters"].items()
        if cid != state["player_id"] and char["tier"] == "major" and cid not in present
    )


def _priority(state, cid):
    """Who most needs a beat: pending business first, then longest silence."""
    pending = sum(1 for e in state["events"].values() if e["state"] == "pending" and cid in e["participants"])
    last_beat = state["counters"]["offscreen_beat_turn"].get(cid, 0)
    return (-min(pending, 1), last_beat, cid)


def beat_candidates(state, turn):
    if frozen(state):
        return []
    ready = [cid for cid in _absent_majors(state) if SS.can_act(state, cid, turn)]
    ready.sort(key=lambda cid: _priority(state, cid))
    return ready[:MAX_CANDIDATES]


def required_beats(state):
    if frozen(state):
        return []
    majors = _absent_majors(state)
    majors.sort(key=lambda cid: _priority(state, cid))
    return majors[:MAX_REQUIRED_BEATS]


def schedule_location(char, minute):
    """Where the schedule puts him at this minute of the day, if anywhere."""
    for slot in char.get("schedule") or []:
        start, end = slot["from"], slot["to"]
        if start <= end and start <= minute <= end:
            return slot["location_id"]
        if start > end and (minute >= start or minute <= end):
            return slot["location_id"]
    return None


def offscreen(state, report, turn):
    """Step 4. Returns the offscreen part of the settlement report."""
    if frozen(state):
        return {"frozen": True, "tier": report["tier"], "moved": [], "required": [], "candidates": []}
    present = set(state["scene"]["present"])
    moved = []
    for cid in sorted(state["characters"]):
        char = state["characters"][cid]
        if cid == state["player_id"] or cid in present or char["tier"] == "background":
            continue
        target = schedule_location(char, state["clock"]["minute"])
        if target and target != char["status"]["location_id"]:
            char["status"]["location_id"] = target
            moved.append({"character_id": cid, "location_id": target})
    tier = report["tier"]
    required = required_beats(state) if tier == "full" else []
    candidates = beat_candidates(state, turn) if tier in ("brief", "full") else []
    return {"frozen": False, "tier": tier, "moved": moved, "required": required, "candidates": candidates}


def _npc_knowers(state, fact):
    people = fact["known_by"] if fact["truth"] else fact["believed_by"]
    return [cid for cid in people if cid != state["player_id"]]


def _neighbors(state, cid):
    out = set()
    for edge in state["relationships"].values():
        if edge["from"] == cid:
            out.add(edge["to"])
        elif edge["to"] == cid:
            out.add(edge["from"])
    out.discard(state["player_id"])
    return sorted(out)


def propagation(state, report, turn):
    """Step 5: spreading facts travel exactly along relationship edges."""
    if frozen(state):
        return {"frozen": True, "spread": []}
    tier = report["tier"]
    hops = {"routine": 0, "brief": 1}.get(tier, 3 if report["minutes"] >= ST.MINUTES_PER_DAY else 2)
    spread = []
    for hop in range(hops):
        for fact in FA.of(state).spreading():
            fact = FA.edit(state, fact["id"])
            knowers = _npc_knowers(state, fact)
            reached = []
            for knower in sorted(knowers):
                for neighbor in _neighbors(state, knower):
                    if neighbor in fact["known_by"] or neighbor in fact["believed_by"] or neighbor in reached:
                        continue
                    coord = fact.get("coord") or [fact["turn"], fact["id"]]
                    if rng.unit(state["seed"], "spread", coord[0], coord[1], neighbor, turn, hop) < SPREAD_CHANCE:
                        reached.append(neighbor)
            target = fact["known_by"] if fact["truth"] else fact["believed_by"]
            target.extend(reached)
            if reached:
                spread.append({"fact_id": fact["id"], "to": reached, "hop": hop + 1})
            fact["spread_hops"] = fact.get("spread_hops", 0) + 1
            if fact["spread_hops"] >= MAX_SPREAD_HOPS:
                fact["spreading"] = False
    return {"frozen": False, "hops": hops, "spread": spread}


def settlement_requests(state, report, turn):
    """Step 6 during a skip: what the *next* record must provide."""
    return {
        "chapter_summary": report["crossed_day"] or (turn - state["counters"]["last_chapter_turn"] >= CHAPTER_EVERY),
        "offscreen_beat_candidates": list((report.get("offscreen") or {}).get("candidates", [])),
    }


def finalize_requests(state, crossed_day):
    """Step 6 once per record, after every operation."""
    requests = state["requests"]
    memory = state["memory"]
    requests["chapter_summary"] = crossed_day or (state["turn"] - state["counters"]["last_chapter_turn"] >= CHAPTER_EVERY)
    requests["prologue"] = len(memory["chapters"]) > CHAPTER_CAP
    return requests


def prologue_source(state):
    """What the model merges into the prologue when requests.prologue is set."""
    chapters = state["memory"]["chapters"][:PROLOGUE_MERGE]
    return {
        "previous": state["memory"]["prologue"],
        "chapters": [
            {"index": c["index"], "from_turn": c["from_turn"], "to_turn": c["to_turn"], "summary": c["summary"]}
            for c in chapters
        ],
    }


def preview_npc(state, cid, persona=None):
    char = state["characters"][cid]
    known = FA.of(state).known_to(cid)
    known.sort(key=lambda f: (f["turn"], FA.order(f)))
    # `goal` 不再来自人设：离屏那一拍他想干什么，由引擎按当下状态算出来，
    # 和在场时用的是同一套候选（agency.candidates）。
    goal = None
    if persona is not None:
        options = AG.candidates(state, persona, cid, state["turn"] + 1, limit=1)
        if options:
            goal = options[0].get("text")
    return {
        "npc_id": cid,
        "name": char["name"],
        "goal": goal,
        "location_id": char["status"]["location_id"],
        "knows": [{"id": f["id"], "text": f["text"]} for f in known[-5:]],
    }


def preview_payload(state, report, persona=None):
    """What the elapsed real time settled, right after steps 1-5.

    Built at the same point for the commit result and for its summary, so what
    the model is told happened is exactly what was settled.

    `persona` is only needed to score what a required NPC is now inclined to
    do; without it `goal` stays None instead of falling back to a typed-in one.
    """
    off = report.get("offscreen") or {}
    spread = (report.get("propagation") or {}).get("spread") or []
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
        "moved": [dict(m) for m in off.get("moved", [])],
        "spread": [dict(s) for s in spread],
        "required_beats": [preview_npc(state, cid, persona) for cid in off.get("required", [])],
        "beat_candidates": list(off.get("candidates", [])),
    }


def label(state):
    return CL.label(state["clock"])
