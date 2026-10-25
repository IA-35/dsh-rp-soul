"""What the model sees: a brief (every turn) and a full context (on demand).

The persona is prose plus a few structured lists; the engine's contribution is
the state it alone knows - who is present, what they feel, what they are now
inclined to do, what is due, what the player was told. The brief is kept under
6 KB by dropping whole lists, never by truncating a thought mid-sentence.

`persona` is the parsed pack (persona.py), so no world pack is read here; the
prose itself never enters the context - it is the system prompt's job.
"""

import json

from ..domain import agency as AG
from ..domain import clock as CL
from ..domain import facts as FA
from ..domain import mood as MO
from .. import persona as PE
from ..domain import relationship as RS
from ..domain import simulation as SI
from ..domain import state as SS
from ..domain import structure as ST

BRIEF_LIMIT = 6 * 1024
FULL_LIMIT = 20 * 1024
# size_bytes is added after fitting; its own bytes count toward the limit.
SIZE_FIELD_RESERVE = 24
LIMITS = {"due_soon": 10, "known_facts": 8, "recent": 3, "nearby": 5}

# Every session is opened from a persona; the field stays so a caller that
# remembers the old world-mode envelope does not break.
MODE = "persona"


def size_of(obj):
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _clock(state):
    return {
        "day": state["clock"]["day"],
        "minute": state["clock"]["minute"],
        "label": CL.label(state["clock"]),
    }


def _npc_brief(state, persona, cid, turn):
    char = state["characters"][cid]
    player = state["player_id"]
    to_player = SS.edge(state, cid, player) or {}
    mood = MO.brief(state, cid)
    entry = {
        "id": cid,
        "name": char["name"],
        "age": char["age"],
        "gender": char["gender"],
        "tier": char["tier"],
        "role": char["public_role"],
        "mood": {"value": mood["value"], "band": mood["band"]},
        "can_act": SS.can_act(state, cid, turn, MO.open_bonus(state, cid)),
        "trust_to_player": to_player.get("trust", 0),
        "tension": to_player.get("tension", 0),
        "stage": SS.stage_label(to_player.get("stage", "stranger")),
    }
    if mood.get("top"):
        # The three heaviest things on his mind, as labels plus how much each
        # one moves the mood right now: the model writes them into the scene,
        # it does not get to name them, and the numbers are the engine's.
        entry["mood"]["weighing"] = [
            {"label": row["label"], "delta": row["delta"]} for row in mood["top"]
        ]
    if char["status"]["conditions"]:
        entry["conditions"] = [c["text"] for c in char["status"]["conditions"]]
    # No goal/stance here: what he wants right now is measured from state and
    # already in context["agency"] (kind + weight + because). A typed-in
    # current_goal would just repeat a line the prose already carries.
    return entry


def player_facts(state, limit=None):
    """The player's facts, most relevant first (facts.player_score): about
    someone present, or recent. Storage answers this without reading every fact."""
    player = state["player_id"]
    present_ids = sorted(set(state["scene"]["present"]) - {player})
    present_names = [state["characters"][c]["name"] for c in present_ids]
    facts = FA.of(state).player_ranked(player, present_ids, present_names, state["turn"] - FA.RECENT_TURNS, limit)
    out = []
    for fact in facts:
        item = {"id": fact["id"], "text": fact["text"], "visibility": fact["visibility"]}
        if not fact["truth"]:
            item["believed_not_true"] = True
        if fact.get("thought_suppressed"):
            item["suppressed"] = True
        out.append(item)
    return out


def _events(state, limit=None):
    pending = [e for e in state["events"].values() if e["state"] == "pending"]
    pending.sort(key=lambda e: (CL.to_abs(e["due"]), e["id"]))
    now = CL.to_abs(state["clock"])
    out = []
    for event in pending[:limit] if limit else pending:
        item = {
            "id": event["id"],
            "kind": event["kind"],
            "title": event["title"],
            "in_minutes": CL.to_abs(event["due"]) - now,
            "due_label": CL.label(event["due"]),
        }
        if SS.player_involved(state, event):
            item["involves_player"] = True
        out.append(item)
    return out


def brief(state, persona, save=None):
    player = state["player_id"]
    pchar = state["characters"][player]
    scene = state["scene"]
    present_npcs = [_npc_brief(state, persona, cid, state["turn"] + 1) for cid in scene["present"] if cid != player]
    nearby = [
        {"id": cid, "name": char["name"], "role": char["public_role"]}
        for cid, char in sorted(state["characters"].items())
        if cid not in scene["present"] and char["status"]["location_id"] == scene["location_id"]
    ][: LIMITS["nearby"]]
    context = {
        "depth": "brief",
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "mode": MODE,
        "clock": _clock(state),
        "scene": {
            "id": scene["id"],
            "location_id": scene["location_id"],
            "location": PE.place_name(persona, scene["location_id"]),
            "privacy": (PE.place(persona, scene["location_id"]) or {}).get("privacy"),
            "present": list(scene["present"]),
        },
        "player": {
            "name": pchar["name"],
            "title": pchar.get("call"),
            "age": pchar["age"],
            "gender": pchar["gender"],
            "role": pchar["public_role"],
        },
        "present_npcs": present_npcs,
        "nearby": nearby,
        "due_soon": _events(state, LIMITS["due_soon"]),
        "known_facts": player_facts(state, LIMITS["known_facts"]),
        "recent": [t["summary"] for t in state["memory"]["turns"][-LIMITS["recent"]:]],
        "last_quotes": list(state["memory"].get("last_quotes") or []),
        "open_action": state["memory"].get("open_action") or "",
        "scene_responses": [
            {"npc_id": r["npc_id"], "response": r["response"]} for r in scene.get("responses", [])[-3:]
        ],
        # What he might do next, from his own state: the model picks one or
        # ignores them all, but it cannot have him act out of nowhere.
        "agency": AG.brief(state, persona, state["turn"] + 1),
        "safety": {
            "paused": state["safety"]["paused"],
            "boundaries": [b["text"] for b in state["safety"]["boundaries"]],
        },
        "preferences": {
            "offscreen_simulation": state["preferences"]["offscreen_simulation"],
        },
        "save": save or {"current_slot": None, "turns_since_save": 0},
        "requests": dict(state["requests"]),
    }
    for key in ("pace", "explicitness"):
        if state["preferences"].get(key) != "standard":
            context["preferences"][key] = state["preferences"][key]
    chapters = state["memory"]["chapters"]
    if chapters and len(context["recent"]) < LIMITS["recent"]:
        # Right after a chapter closes its turns are archived; the chapter
        # summary keeps the thread until new turn summaries accumulate.
        context["last_chapter"] = chapters[-1]["summary"]
    _fit(context, BRIEF_LIMIT, ("known_facts", "due_soon", "nearby", "scene_responses", "recent", "last_quotes", "agency"))
    return context


def _card(state, persona, char):
    cid = char["id"]
    player = state["player_id"]
    card = {
        "id": cid,
        "name": char["name"],
        "call": char.get("call"),
        "age": char["age"],
        "gender": char["gender"],
        "tier": char["tier"],
        "role": char["public_role"],
        "adult_context": char.get("adult_context"),
        "appearance": char.get("appearance"),
        "location_id": char["status"]["location_id"],
        "present": cid in state["scene"]["present"],
        "can_act": SS.can_act(state, cid, state["turn"] + 1, MO.open_bonus(state, cid)),
        "to_player": (SS.edge(state, cid, player) or {}).get("stage"),
        "mood": MO.panel(state, cid),
    }
    if char.get("voices"):
        card["voices"] = dict(char["voices"])
    if char.get("schedule"):
        card["schedule"] = [dict(s) for s in char["schedule"]]
    return card


def full(state, persona, save=None):
    context = brief(state, persona, save)
    context["depth"] = "full"
    player = state["player_id"]
    pchar = state["characters"][player]
    context["player"].update(
        {
            "background": pchar.get("appearance"),
            "adult_context": pchar.get("adult_context"),
        }
    )
    # The prose is the system prompt's; the full context repeats only the
    # structured lists the persona also carries.
    context["persona"] = {
        "id": persona["id"],
        "title": persona["title"],
        "revision": persona["revision"],
        "person": persona["person"],
        "mood_base": persona["mood_base"],
        "mood_thresholds": dict(persona["mood_thresholds"]),
        "rules": list(persona.get("rules") or []),
        "twists": list(persona.get("twists") or []),
    }
    context["locations"] = [
        {
            "id": loc["id"],
            "name": loc["name"],
            "privacy": loc["privacy"],
            "detail": loc.get("detail"),
            "affordances": loc.get("affordances") or [],
            "visibility": loc.get("visibility") or [],
        }
        for loc in persona["places"]
    ]
    majors = [c for c in state["characters"].values() if c["id"] != player and c["tier"] in ("major", "supporting")]
    majors.sort(key=lambda c: (c["id"] not in state["scene"]["present"], c["id"]))
    context["characters"] = [_card(state, persona, c) for c in majors]
    context["background"] = [
        {
            "id": c["id"],
            "name": c["name"],
            "role": c["public_role"],
            "location_id": c["status"]["location_id"],
        }
        for c in sorted(state["characters"].values(), key=lambda c: c["id"])
        if c["tier"] == "background"
    ]
    relevant = {player} | {c["id"] for c in majors}
    context["relationships"] = [
        {
            "from": e["from"],
            "to": e["to"],
            "trust": e["trust"],
            "tension": e["tension"],
            "stage": SS.stage_label(e["stage"]),
            "recent": [h["reason"] for h in e["history"][-2:]],
        }
        for _, e in sorted(state["relationships"].items())
        if e["from"] in relevant and e["to"] in relevant
    ]
    # The brief lists are the head of these full lists; carrying both would
    # only repeat them.
    context.pop("known_facts", None)
    context.pop("due_soon", None)
    context["player_facts"] = player_facts(state, 30)
    context["events"] = _events(state)
    context["agency"] = AG.brief(state, persona, state["turn"] + 1)
    context["chapters"] = [c["summary"] for c in state["memory"]["chapters"][-3:]]
    context.pop("last_chapter", None)
    if state["memory"].get("prologue"):
        context["prologue"] = state["memory"]["prologue"]
    if state["requests"].get("prologue"):
        context["prologue_merge"] = SI.prologue_source(state)
    _fit_full(context)
    return context


# -- commit template -----------------------------------------------------------


def commit_template(state, persona):
    """A commit-turn input to fill in, returned when a session starts (new
    game, load, import): the person on stage first and the operations most
    turns need, so the first turn needs no reading of operations. Angle
    brackets mark what to write; "a|b" means pick one. It sits beside the
    context and does not count toward its budget."""
    player = state["player_id"]
    present = [cid for cid in state["scene"]["present"] if cid != player]
    npc = present[0] if present else "<npc_id>"
    options = AG.candidates(state, persona, npc, state["turn"] + 1, limit=1) if present else []
    kind = options[0]["kind"] if options else "observe"
    return _template(
        state,
        {
            "action_mode": "attempt|result|continue|wait",
            "player_input": "<玩家原话>",
            "player_authorized": False,
            "acts_on": [npc],
            "operations": [
                {"op": "npc_response", "npc_id": npc, "response": "refuse|negotiate|partial|surface|genuine", "note": "<怎么回应，<=80 字；surface 另写 true_intent>"},
                {"op": "npc_action", "npc_id": npc, "kind": kind, "action": "<他自己做了什么>", "significant": True},
                {"op": "add_fact", "key": "<小写点分键，如 %s.secret.letter>" % (npc if present else "npc"), "text": "<正文里新写出、以后要用到的细节>", "visibility": "public", "origin": "observed"},
                {"op": "relationship", "from": npc, "to": player, "trust_delta": "<-2..2 的整数；关系没变就删掉这条>", "reason": "<为什么>"},
            ],
        },
    )


def _template(state, body):
    """A record holding one turn: the model copies the turn once for each turn
    it has kept back."""
    turn = dict(body)
    turn["content_tags"] = []
    turn["summary"] = "<第三方视角一两句>"
    turn["open_action"] = "<停在哪个未决动作>"
    turn["quotes"] = ["<本回合值得记住的原话，原样一句，<=80 字；没有就删掉这条>"]
    if state["requests"].get("chapter_summary"):
        from ..domain.turn import chapter_start

        turn["chapter_summary"] = "<第 %d-%d 回合的摘要，不含之后的事，第三方视角，<=300 字>" % (
            chapter_start(state),
            state["turn"],
        )
    if state["requests"].get("prologue"):
        turn["prologue"] = "<完整上下文 prologue_merge 合并成的前情，<=300 字>"
    return {
        "session_id": state["session_id"],
        "request_id": "<上一次返回的 next_request_id>",
        "expected_revision": "<上一次返回的 revision>",
        "encoding_check": "汉字",
        "turns": [turn],
    }


# -- full-context budget -------------------------------------------------------

CARD_SUMMARY_KEYS = ("id", "name", "call", "age", "gender", "tier", "role", "adult_context", "location_id", "present", "can_act", "to_player", "mood")
ROSTER_KEYS = ("id", "name", "tier", "role", "adult_context", "location_id", "present", "to_player")
ROSTER_CLIP = 24


def _fit_steps(context):
    """Trim in order until the full context fits; each step keeps it usable."""

    def locations_cut():
        context["locations"] = context["locations"][:6]

    def rules_cut():
        context["persona"]["rules"] = context["persona"]["rules"][:4]

    def background_cut():
        context["background"] = context["background"][:8]

    def cards_clipped():
        for card in context["characters"]:
            for key in list(card):
                if key not in CARD_SUMMARY_KEYS:
                    del card[key]

    def facts_cut():
        while context.get("player_facts") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["player_facts"].pop()

    def events_cut():
        while context.get("events") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["events"].pop()

    def chapters_cut():
        while context.get("chapters") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["chapters"].pop(0)

    def character_cut():
        while len(context["characters"]) > 6 and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["characters"].pop()

    def relationships_cut():
        while context["relationships"] and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["relationships"].pop()

    def agency_cut():
        while context.get("agency") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["agency"].pop()

    return [
        locations_cut,
        rules_cut,
        background_cut,
        cards_clipped,
        facts_cut,
        events_cut,
        chapters_cut,
        character_cut,
        relationships_cut,
        agency_cut,
    ]


def _fit_full(context):
    for step in _fit_steps(context):
        if size_of(context) <= FULL_LIMIT - SIZE_FIELD_RESERVE:
            break
        step()
    context["size_bytes"] = size_of(context)


def _fit(context, limit, order):
    """Trim lists in the given order until the context fits."""
    limit -= SIZE_FIELD_RESERVE
    if size_of(context) <= limit:
        context["size_bytes"] = size_of(context)
        return
    for key in order:
        value = context.get(key)
        if isinstance(value, dict):
            context[key] = {}
        while isinstance(context.get(key), list) and context[key] and size_of(context) > limit:
            context[key].pop()
        if size_of(context) <= limit:
            break
    context["size_bytes"] = size_of(context)
