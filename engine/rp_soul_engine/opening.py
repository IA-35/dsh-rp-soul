"""Start a session: persona in, state out. The engine never invents content.

What the old `opening.py` did - score world packs, roll cast combos, fill name
pools - is gone, because there are no world packs. What remains is the honest
part: take the persona the player wrote, place its cast on its map, put the
player in the first room, and open the clock on the real moment the session is
created. Determinism comes from the seed alone, so the same persona + same seed
always yields the same opening turn.
"""

from . import persona as PE
from .domain import clock as CL
from .domain import mood as MO
from .domain import relationship as RL
from .domain import rng as RNG
from .errors import INVALID_INPUT, detail

STATE_SCHEMA_VERSION = 1


def _start_clock(now):
    """Day one, at the real time of day the session opened.

    There is no "the story starts at 20:00" any more: it starts whenever the
    session is created, which is the only moment the engine can honestly point
    at.
    """
    moment = CL.parse_iso(now)
    minute = moment.hour * 60 + moment.minute if moment is not None else 8 * 60
    return {"day": 1, "minute": minute}


def _initial_location(persona, seed):
    """The first place: whatever the persona lists first, or a seeded pick."""
    places = sorted(persona["places"], key=lambda item: item["id"])
    weighted = [item for item in places if item["privacy"] != "public"]
    pool = weighted or places
    index = RNG.randint(seed, "opening.place", 0, len(pool) - 1)
    return pool[index]["id"]


def _place_cast(state, persona, seed):
    """Every character starts where their schedule says, else in the first place."""
    opening = _initial_location(persona, seed)
    fallback = opening
    for cid in sorted(state["characters"]):
        char = state["characters"][cid]
        if cid == state["player_id"]:
            char["status"]["location_id"] = opening
            continue
        minute = state["clock"]["minute"]
        placed = None
        for slot in char.get("schedule") or []:
            if slot["from"] <= minute < slot["to"] or (slot["from"] > slot["to"] and (minute >= slot["from"] or minute < slot["to"])):
                placed = slot["location_id"]
                break
        char["status"]["location_id"] = placed or fallback
    return opening


def _seed_relationships(state):
    """Every NPC starts with the player at its persona-declared stage.

    `start_stage` defaults to `stranger`; a persona that already says the two of
    them are master and maid should not open on 陌生 and contradict its own prose.
    """
    player = state["player_id"]
    for cid in sorted(state["characters"]):
        if cid == player:
            continue
        stage = state["characters"][cid].get("start_stage") or "stranger"
        RL._maybe_create(state, player, cid, stage=stage)
        RL._maybe_create(state, cid, player, stage=stage)



def new_session(persona, seed=None, player=None, now=None):
    """Build the initial state for a persona. Returns (state, warnings).

    `now` is the real ISO moment the session is created: day one of the story is
    that date, and the clock opens at that time of day. It is also the baseline
    the next turn measures its real-time gap against.
    """
    if persona is None:
        raise ValueError("persona is required")
    seed = seed or RNG.seed_of(persona["revision"])
    clock = _start_clock(now)
    cards = PE.characters(persona)
    cards[PE.PLAYER_ID] = PE.player_card(
        name=(player or {}).get("name") or "你",
        call=(player or {}).get("call"),
        gender=(player or {}).get("gender"),
        age=(player or {}).get("age") or 28,
        role=(player or {}).get("role") or "",
    )
    PE.render_cards(persona, cards)

    counters = {
        "next": {
            "scene": 1,
            "fact": 1,
            "event": 1,
            "thought": 1,
            "chapter": 1,
            "boundary": 1,
        },
        "major_action_turn": {},
        "offscreen_beat_turn": {},
        "last_chapter_turn": 0,
    }
    state = {
        "schema": STATE_SCHEMA_VERSION,
        "revision": 1,
        "seed": seed,
        "persona_id": persona["id"],
        "persona_revision": persona["revision"],
        "persona_title": persona["title"],
        "mood_base": persona["mood_base"],
        "mood_thresholds": dict(persona["mood_thresholds"]),
        "player_id": PE.PLAYER_ID,
        "turn": 0,
        "clock": clock,
        # `real_start` is the moment the session opened (diagnostics only);
        # `real_at` is the moment the last turn settled, which is what the next
        # turn measures real time against. Both come from the wall clock.
        "real_start": now,
        "real_at": now,
        "characters": cards,
        "relationships": {},
        "facts": {},
        "events": {},
        "counters": counters,
        "scene": {"id": None, "location_id": None, "present": [], "since": dict(clock), "responses": []},
        "memory": {"prologue": "", "chapters": [], "turns": [], "last_quotes": [], "open_action": ""},
        "preferences": {
            "offscreen_simulation": True,
            "pace": "standard",
            "explicitness": "standard",
        },
        "safety": {"paused": False, "boundaries": []},
        "requests": {"chapter_summary": False, "prologue": False},
        "undo_floor": 0,
        "session_id": None,
    }
    opening = _place_cast(state, persona, seed)
    state["scene"]["location_id"] = opening
    state["scene"]["id"] = "sc0"
    state["scene"]["present"] = sorted(
        cid for cid in state["characters"] if state["characters"][cid]["status"]["location_id"] == opening
    )
    state["scene"]["present"].sort(key=lambda cid: (cid != state["player_id"], cid))
    _seed_relationships(state)
    warnings = []
    if len(state["scene"]["present"]) == 1:
        warnings.append("开局地点只有玩家一个人：%s" % PE.place_name(persona, opening))
    return state, warnings


def check_persona(persona):
    """The one place a persona is rejected: returns [] or a list of details."""
    if not isinstance(persona, dict):
        return [detail("$.persona", "人设包必须是对象", "先由 rp-soul 解析 markdown 前置块", INVALID_INPUT)]
    validated, errors = PE.validate(persona)
    return errors


def preview(persona, seed=None):
    state, warnings = new_session(persona, seed=seed)
    present = [state["characters"][cid]["name"] for cid in state["scene"]["present"]]
    return {
        "seed": state["seed"],
        "clock": CL.label(state["clock"]),
        "place": PE.place_name(persona, state["scene"]["location_id"]),
        "present": present,
        "mood": {
            cid: MO.brief(state, cid)
            for cid in sorted(state["characters"])
            if cid != state["player_id"]
        },
        "warnings": warnings,
    }
