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
from .domain import memories as MEM
from .domain import relationship as RL
from .jsonio import copy

FROM_SCHEMA = 1
TO_SCHEMA = 2
LATEST = 3
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


def _entry(state, layer, kind, text, importance, day, a0_at, turn=0, **extra):
    """A migrated entry: starts fading from the migration, not from the day it happened.

    Today's turns sit at the current minute, never later: an entry in the future
    would outrank the conversations that follow the upgrade."""
    day = max(1, day)
    minute = min(UNKNOWN_MINUTE, state["clock"]["minute"]) if day >= state["clock"]["day"] else UNKNOWN_MINUTE
    at = {"day": day, "minute": minute}
    entry = MEM.add(state, layer, kind, text, importance, at=at, turn=turn, **extra)
    MEM.touch(entry, a0_at, 1.0)
    return entry


def state_v2_to_v3(state):
    """A schema-2 state with her memory in four layers. Pure; other schemas pass through.

    - the rolling turn log stays (`memory.turns`); each turn also becomes an
      entry: today's latest six in 刚刚, the rest in 这几天. Turns a chapter
      already covered count as summarised, so no daily summary repeats them;
    - every chapter becomes a 那些事 summary, the prologue one 那些年 chapter;
    - the chapter / prologue requests become memory_summary / memory_archive
      (recomputed when the next record closes).
    """
    if not isinstance(state, dict) or state.get("schema") != TO_SCHEMA:
        return state
    s = copy(state)
    memory = s["memory"]
    chapters = memory.pop("chapters", None) or []
    chapters = [c for c in chapters if isinstance(c, dict)]
    prologue = (memory.pop("prologue", "") or "").strip()
    counters = s["counters"]
    covered = counters.pop("last_chapter_turn", 0) or 0
    counters["next"].pop("chapter", None)
    counters["next"]["memory"] = 1
    counters.setdefault("milestones", [])
    memory["entries"] = []
    memory["last_archive_day"] = s["clock"]["day"]
    now = CL.to_abs(s["clock"])
    if prologue:
        first_day = min([c.get("day") or 1 for c in chapters] or [1])
        _entry(s, "years", "chapter", prologue, 0.6, first_day, now)
    for chapter in chapters:
        _entry(s, "events", "summary", chapter.get("summary") or "", 0.5, chapter.get("day") or 1, now,
               turn=chapter.get("to_turn") or 0)
    turns = [t for t in memory.get("turns") or [] if isinstance(t, dict) and (t.get("summary") or "").strip()]
    today = [t for t in turns if t.get("day") == s["clock"]["day"]][-MEM.CAPACITY["now"]:]
    for item in turns:
        layer = "now" if item in today else "days"
        _entry(s, layer, "conversation", item["summary"], 0.3, item.get("day") or 1, now,
               turn=item.get("turn") or 0, quotes=list(item.get("quotes") or [])[:3],
               summarized=(item.get("turn") or 0) <= covered)
    requests = s.setdefault("requests", {})
    requests.pop("chapter_summary", None)
    requests.pop("prologue", None)
    requests["memory_summary"] = None
    requests["memory_archive"] = None
    s["schema"] = LATEST
    return s


def upgrade(state, persona):
    """(state, persona) of any older save, brought to the latest schema."""
    if is_v1(state):
        state, persona = session_v1_to_v2(state, persona)
    return state_v2_to_v3(state), persona


def upgrade_state(state, persona):
    """Only the state (undo points, which keep no persona of their own)."""
    return upgrade(state, persona)[0]
