"""Old saves (state schema 1, the multi-character engine) read as one companion.

State schema 1 came from the engine this was ported from: a cast, a map, NPCs
with relationships among themselves. Schema 2 is "you and me". The upgrade
keeps everything that was about her and the player and drops the rest:

* she is the persona's first ``tier: major`` cast member (tier defaults to
  major) - the same rule ``persona.from_legacy`` uses for the markdown file -
  or, if that id is not in the save, the first other character in it;
* her mood thoughts, her relationship with the player, what she and the
  player know: kept as they are; events she is part of, or that were the
  player's alone, are kept (as hers and the player's); an event between the
  player and someone who is dropped goes with that someone;
* other characters, NPC-to-NPC edges, places, the scene's location and the
  gossip bookkeeping: dropped;
* her schedule becomes a routine named after the places ("在诊所").

Pure functions, no I/O: storage (db.py migration 2) and the import path
(transfer.py) both call them, so a database and an export file upgrade the
same way.
"""

from . import persona as PE
from . import schema as S
from .domain import clock as CL
from .domain import relationship as RL
from .jsonio import copy

FROM_SCHEMA = 1
TO_SCHEMA = 2
TO_SCHEMA_V3 = 3
LATEST = 4
# 旧回合和章节只记了哪一天，不知道几点：一律当作那天中午
UNKNOWN_MINUTE = 720


def is_v1(state):
    return isinstance(state, dict) and state.get("schema") == FROM_SCHEMA


def companion_of(persona, state):
    """Her id in an old save."""
    player = state["player_id"]
    others = sorted(cid for cid in state["characters"] if cid != player)
    cast = [m for m in (persona or {}).get("cast") or [] if isinstance(m, dict)]
    major = next((m for m in cast if m.get("tier", "major") == "major"), None)
    if major is not None and major.get("id") in state["characters"] and major["id"] != player:
        return major["id"]
    majors = [cid for cid in others if (state["characters"][cid] or {}).get("tier") == "major"]
    return (majors or others or [None])[0]


def persona_v1_to_v2(persona):
    """The stored (already validated) old persona, as a schema-2 persona.

    Only the schema layer runs here, not the semantic checks: a save whose
    persona was good enough to play must not become unreadable because, say,
    the companion picked out of the old cast never had voices written.
    """
    if not PE.is_legacy(persona):
        return persona
    flat = PE.from_legacy(persona)
    normalized, errors = S.validate(PE.PERSONA, flat, "$.persona")
    if normalized is None:
        raise ValueError("旧人设转不成单人格式：%s" % PE.problems_text(errors))
    return normalized


def fact_v1_to_v2(fact, keep):
    """A fact with only the two of you left among the people who know it."""
    out = copy(fact)
    out["known_by"] = [cid for cid in fact.get("known_by") or [] if cid in keep]
    out["believed_by"] = [cid for cid in fact.get("believed_by") or [] if cid in keep]
    out["spreading"] = False
    return out


def _routine(card, persona):
    names = {p.get("id"): p.get("name") or p.get("id") for p in (persona or {}).get("places") or [] if isinstance(p, dict)}
    out = []
    for slot in card.get("schedule") or []:
        if isinstance(slot, dict) and {"from", "to"} <= set(slot):
            place = names.get(slot.get("location_id"), slot.get("location_id")) or "原地"
            out.append({"from": slot["from"], "to": slot["to"], "doing": ("在%s" % place)[:40]})
    return out


def _card(card, routine):
    out = {k: v for k, v in card.items() if k not in ("tier", "schedule", "status")}
    out["routine"] = routine
    out["status"] = {"conditions": list((card.get("status") or {}).get("conditions") or [])}
    return out


def state_v1_to_v2(state, persona):
    """An old state (with or without its facts) as a schema-2 state. Pure."""
    if not is_v1(state):
        return state
    s = copy(state)
    player = s["player_id"]
    her = companion_of(persona, s)
    if her is None:
        raise ValueError("旧存档里除了玩家没有别的角色")
    keep = {player, her}
    chars = s["characters"]
    s["characters"] = {
        player: _card(chars[player], []),
        her: _card(chars[her], _routine(chars[her], persona)),
    }
    edges = {key: edge for key, edge in (s.get("relationships") or {}).items() if edge["from"] in keep and edge["to"] in keep}
    s["relationships"] = edges
    stage = (edges.get("%s>%s" % (her, player)) or edges.get("%s>%s" % (player, her)) or {}).get("stage", "stranger")
    RL._maybe_create(s, her, player, stage)
    RL._maybe_create(s, player, her, stage)
    scene = s.get("scene") or {}
    s["scene"] = {
        "id": scene.get("id"),
        "present": [player, her],
        "since": scene.get("since") or dict(s["clock"]),
        "responses": [r for r in scene.get("responses") or [] if r.get("npc_id") == her],
    }
    events = {}
    for eid, event in (s.get("events") or {}).items():
        people = list(event.get("participants") or [])
        if her not in people and set(people) != {player}:
            continue  # 和她无关、又牵涉别的角色的事（比如你和周奕的约定）：跟着那个角色一起走
        event["participants"] = [her] + ([player] if player in people else [])
        events[eid] = event
    s["events"] = events
    counters = s.get("counters") or {}
    for key in ("major_action_turn", "offscreen_beat_turn", "next_thought"):
        if isinstance(counters.get(key), dict):
            counters[key] = {cid: value for cid, value in counters[key].items() if cid in keep}
    (s.get("requests") or {}).pop("offscreen_beat_candidates", None)
    if isinstance(s.get("facts"), dict):
        s["facts"] = {fid: fact_v1_to_v2(fact, keep) for fid, fact in s["facts"].items()}
    s["persona_id"] = her
    s["schema"] = TO_SCHEMA
    return s


def session_v1_to_v2(state, persona):
    """(state, persona) of an old save, upgraded together: her id comes from
    the old persona, so the state goes first."""
    return state_v1_to_v2(state, persona), persona_v1_to_v2(persona)


def keep_of(state):
    """The two ids an upgraded state keeps (for rewriting stored fact rows)."""
    return set(state["characters"])


# ---------------------------------------------------------------------------
# schema 2 -> 3: the turns / chapters / prologue chain becomes her memory


def state_v2_to_v3(state):
    """A schema-2 state, upgraded. Pure; other schemas pass through.

    lite 没有记忆层：旧的章节摘要和前情（chapters / prologue）直接丢掉，回合流水
    （memory.turns）原样留着 —— 那是记账，不是记忆。
    """
    if not isinstance(state, dict) or state.get("schema") != TO_SCHEMA:
        return state
    s = copy(state)
    memory = s["memory"]
    memory.pop("chapters", None)
    memory.pop("prologue", None)
    counters = s["counters"]
    counters.pop("last_chapter_turn", None)
    counters["next"].pop("chapter", None)
    requests = s.setdefault("requests", {})
    for key in ("chapter_summary", "prologue", "memory_summary", "memory_journal"):
        requests.pop(key, None)
    s["schema"] = TO_SCHEMA_V3
    return s


def state_v3_to_v4(state):
    """A schema-3 state whose rules read the clock instead of counting turns.

    Nothing about the story changes, only where the bookkeeping lives:

    - the cooldown marker becomes a clock instant. An old marker cannot be
      turned into one, so it is dropped: worst case she may take one big move
      right after the upgrade;
    - the write-only offscreen marker goes away;
    - the full-context marker starts empty, so the next commit gets one;
    - a fact learned under the old rule ("within the last five commits") gets
      the current clock as its instant; every other fact gets None and simply
      does not count as recent.
    """
    if not isinstance(state, dict) or state.get("schema") != TO_SCHEMA_V3:
        return state
    s = copy(state)
    counters = s.setdefault("counters", {})
    counters.pop("major_action_turn", None)
    counters.pop("offscreen_beat_turn", None)
    counters["major_action_at"] = {}
    counters["full_context_at"] = None
    now = dict(s["clock"])
    for fact in (s.get("facts") or {}).values():
        if "at" in fact:
            continue
        fact["at"] = dict(now) if (fact.get("turn") or 0) >= s["turn"] - 5 else None
    s["schema"] = LATEST
    return s


def upgrade(state, persona):
    """(state, persona) of any older save, brought to the latest schema."""
    if is_v1(state):
        state, persona = session_v1_to_v2(state, persona)
    return state_v3_to_v4(state_v2_to_v3(state)), persona


def upgrade_state(state, persona):
    """Only the state (undo points, which keep no persona of their own)."""
    return upgrade(state, persona)[0]
