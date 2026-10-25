"""Read helpers over the session state dict. No mutation except id allocation.

A session state holds only engine-owned facts about the fiction: characters,
relationships, facts, events, scene, clock, mood thoughts, memory. Everything
that used to come from a world pack (locations, cast templates, name pools)
now comes from the persona pack and is read-only for the engine.
"""

import hashlib

from ..jsonio import canonical
from . import clock as CL
from . import facts as FA
from . import structure as ST

# Per-session identity: a loaded copy of a game differs only in these.
SESSION_FIELDS = ("session_id", "undo_floor")


def digest(state):
    """Digest of the game itself: same seed, persona and commands, same digest."""
    clean = {k: v for k, v in FA.full_state(state).items() if k not in SESSION_FIELDS}
    return hashlib.sha256(canonical(clean).encode("utf-8")).hexdigest()


def next_id(state, kind, prefix):
    counters = state["counters"]["next"]
    # A kind added after a save was written starts at 1 instead of raising:
    # old saves must keep loading, and ids never collide because the counter
    # only goes forward from here.
    value = counters.get(kind, 1)
    counters[kind] = value + 1
    return "%s%d" % (prefix, value)


def character(state, cid):
    return state["characters"].get(cid)


def is_npc(state, cid):
    return cid in state["characters"] and cid != state["player_id"]


def present(state):
    return state["scene"]["present"]


def is_present(state, cid):
    return cid in state["scene"]["present"]


def edge_key(a, b):
    return "%s>%s" % (a, b)


def edge(state, a, b):
    return state["relationships"].get(edge_key(a, b))


def info_set(state, cid):
    """Fact ids the character knows or (mis)believes."""
    return {fact["id"] for fact in FA.of(state).known_to(cid)}


def knows(state, cid, fid):
    fact = state["facts"].get(fid) if isinstance(state["facts"], dict) else FA.of(state).get(fid)
    return fact is not None and (cid in fact["known_by"] or cid in fact["believed_by"])


def stage_index(stage):
    return ST.STAGES.index(stage)


def stage_label(stage):
    return ST.STAGE_LABELS[stage]


def clock_label(state):
    return CL.label(state["clock"])


def real_span(state, now):
    """(minutes, clock) for a turn happening at the real moment `now`.

    `real_at` is when the last turn settled, so the span is the real time
    between then and now and the clock moves that many minutes on. Counting
    minutes instead of re-deriving the time of day keeps day one anchored to
    where the story actually is: a session left alone over midnight, or for a
    few days, lands exactly where real time says it is.

    Time only goes forward: a wall clock that was adjusted backwards settles as
    zero rather than rewinding the story.
    """
    if CL.parse_iso(now) is None:
        return 0, dict(state["clock"])
    minutes = CL.real_minutes_between(state.get("real_at"), now)
    if minutes <= 0:
        # A wall clock set back, or two turns inside the same minute: the story
        # never rewinds, so this settles as no time at all.
        return 0, dict(state["clock"])
    return minutes, CL.add_minutes(state["clock"], minutes)


def place(persona, lid):
    for item in persona.get("places") or []:
        if item["id"] == lid:
            return item
    return None


def can_act(state, cid, turn=None, bonus=0):
    """Whether a significant autonomous action is off cooldown for the next turn."""
    turn = state["turn"] + 1 if turn is None else turn
    last = state["counters"]["major_action_turn"].get(cid)
    return last is None or turn - last >= max(1, ST.COOLDOWN_TURNS - bonus)


def player_involved(state, event):
    return state["player_id"] in event["participants"]


def npcs(state):
    return sorted(cid for cid in state["characters"] if cid != state["player_id"])


def mood_of(state, cid):
    return (state["characters"].get(cid) or {}).get("mood") or {}
