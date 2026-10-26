"""Start a session: persona in, state out. The engine never invents content.

There is one companion and the player, and no map: the session opens with the
two of them together, on the real moment it is created. Determinism comes from
the seed alone, so the same persona + same seed always yields the same opening.
"""

from . import STATE_SCHEMA_VERSION
from . import persona as PE
from .domain import clock as CL
from .domain import mood as MO
from .domain import relationship as RL
from .domain import rng as RNG
from .errors import INVALID_INPUT, detail


def _start_clock(now):
    """Day one, at the real time of day the session opened.

    There is no "the story starts at 20:00" any more: it starts whenever the
    session is created, which is the only moment the engine can honestly point
    at.
    """
    moment = CL.parse_iso(now)
    minute = moment.hour * 60 + moment.minute if moment is not None else 8 * 60
    return {"day": 1, "minute": minute}


def _seed_relationship(state, cid, stage):
    """She starts with the player at her persona-declared stage.

    `start_stage` defaults to `stranger`; a persona that already says the two of
    them are old friends should not open on 陌生 and contradict its own prose.
    """
    player = state["player_id"]
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
    her = PE.companion_card(persona)
    cards = {
        her["id"]: her,
        PE.PLAYER_ID: PE.player_card(
            name=(player or {}).get("name") or "你",
            call=(player or {}).get("call"),
            gender=(player or {}).get("gender"),
            age=(player or {}).get("age") or 28,
            role=(player or {}).get("role") or "",
        ),
    }
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
        # 一段相处：隔一小时以上再说话就是新的一段（settlement.new_scene）
        "scene": {"id": "sc0", "present": [PE.PLAYER_ID, her["id"]], "since": dict(clock), "responses": []},
        # 她自己定下的下一件事：{"note": "去洗澡", "until": {"day","minute"}, "set_turn": N}
        # 旧存档没有这个键，读的地方一律用 .get("plan")
        "plan": None,
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
    _seed_relationship(state, her["id"], her.get("start_stage") or "stranger")
    return state, []


def check_persona(persona):
    """The one place a persona is rejected: returns [] or a list of details."""
    if not isinstance(persona, dict):
        return [detail("$.persona", "人设包必须是对象", "先由 rp-soul 解析 markdown 前置块", INVALID_INPUT)]
    validated, errors = PE.validate(persona)
    return errors


def preview(persona, seed=None):
    state, warnings = new_session(persona, seed=seed)
    cid = persona["id"]
    return {
        "seed": state["seed"],
        "clock": CL.label(state["clock"]),
        "name": persona["name"],
        "doing": PE.doing_at(persona, state["clock"]["minute"]),
        "mood": {cid: MO.brief(state, cid)},
        "warnings": warnings,
    }
