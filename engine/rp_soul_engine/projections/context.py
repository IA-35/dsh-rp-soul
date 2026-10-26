"""What the model sees: a brief (every turn) and a full context (on demand).

The persona is prose plus a few structured fields; the engine's contribution
is the state it alone knows - how she feels and why, what she is now inclined
to do, what her routine has her doing, what is due, what the player was told.
The brief is kept under 6 KB by dropping whole lists, never by truncating a
thought mid-sentence.

`persona` is the parsed pack (persona.py); the prose itself never enters the
context - it is the system prompt's job.
"""

import json

from ..domain import agency as AG
from ..domain import clock as CL
from ..domain import facts as FA
from ..domain import memories as MEM
from ..domain import mood as MO
from ..domain import ops as OPS
from .. import persona as PE
from ..domain import state as SS

BRIEF_LIMIT = 6 * 1024
FULL_LIMIT = 20 * 1024
# size_bytes is added after fitting; its own bytes count toward the limit.
SIZE_FIELD_RESERVE = 24
LIMITS = {"due_soon": 10, "known_facts": 8, "recent": 3}

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


def _plan_row(state):
    """Her standing plan in the shape context shows: {note, until, until_label}."""
    plan = OPS.current_plan(state)
    if plan is None:
        return None
    return {
        "note": plan["note"],
        "until": dict(plan["until"]),
        "until_label": CL.label(plan["until"]),
    }


def _companion_brief(state, cid, turn):
    char = state["characters"][cid]
    player = state["player_id"]
    to_player = SS.edge(state, cid, player) or {}
    mood = MO.brief(state, cid)
    entry = {
        "id": cid,
        "name": char["name"],
        "age": char["age"],
        "gender": char["gender"],
        "role": char["public_role"],
        "present": SS.is_present(state, cid),
        "mood": {"value": mood["value"], "band": mood["band"]},
        "can_act": SS.can_act(state, cid, turn, MO.open_bonus(state, cid)),
        "trust_to_player": to_player.get("trust", 0),
        "tension": to_player.get("tension", 0),
        "stage": SS.stage_label(to_player.get("stage", "stranger")),
    }
    doing = PE.doing_at(char, state["clock"]["minute"])
    if doing:
        # 作息说她这个点通常在做什么：写正文时的背景，不是命令
        entry["routine_now"] = doing
    if mood.get("top"):
        # The three heaviest things on her mind, as labels plus how much each
        # one moves the mood right now: the model writes them into the scene,
        # it does not get to name them, and the numbers are the engine's.
        entry["mood"]["weighing"] = [
            {"label": row["label"], "delta": row["delta"]} for row in mood["top"]
        ]
    if char["status"]["conditions"]:
        entry["conditions"] = [c["text"] for c in char["status"]["conditions"]]
    if cid == SS.companion(state):
        plan = _plan_row(state)
        if plan is not None:
            # 她说好做到几点：唤醒线靠它把她叫醒，写正文时也该看得见。
            entry["plan"] = plan
    # No goal/stance here: what she wants right now is measured from state and
    # already in context["agency"] (kind + weight + because).
    return entry


def player_facts(state, limit=None):
    """The player's facts, most relevant first (facts.player_score): about
    her, or recent. Storage answers this without reading every fact."""
    player = state["player_id"]
    her = SS.companion(state)
    ids = [her] if her else []
    names = [state["characters"][her]["name"]] if her else []
    facts = FA.of(state).player_ranked(player, ids, names, state["turn"] - FA.RECENT_TURNS, limit)
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
    her = SS.companion(state)
    context = {
        "depth": "brief",
        "session_id": state["session_id"],
        "revision": state.get("revision", 0),
        "turn": state["turn"],
        "mode": MODE,
        "clock": _clock(state),
        "scene": {
            "id": scene["id"],
            "since": CL.label(scene["since"]),
        },
        "player": {
            "name": pchar["name"],
            "title": pchar.get("call"),
            "age": pchar["age"],
            "gender": pchar["gender"],
            "role": pchar["public_role"],
        },
        "companion": _companion_brief(state, her, state["turn"] + 1),
        "due_soon": _events(state, LIMITS["due_soon"]),
        "known_facts": player_facts(state, LIMITS["known_facts"]),
        "recent": [t["summary"] for t in state["memory"]["turns"][-LIMITS["recent"]:]],
        "last_quotes": list(state["memory"].get("last_quotes") or []),
        "open_action": state["memory"].get("open_action") or "",
        "scene_responses": [r["response"] for r in scene.get("responses", [])[-3:]],
        # What she might do next, from her own state: the model picks one or
        # ignores them all, but it cannot have her act out of nowhere.
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
    # 引擎要她写每日总结 / 归档时，把要写的那些记忆一起给出来（不论 brief 还是 full）
    for key in ("memory_summary", "memory_archive"):
        view = MEM.request_view(state, state["requests"].get(key))
        if view is not None:
            context[key + "_sources"] = view
    _fit(context, BRIEF_LIMIT, ("known_facts", "due_soon", "scene_responses", "recent", "last_quotes", "agency"))
    return context


def _card(state, char):
    """Her full card: who she is (static, from the persona) plus her mood panel."""
    cid = char["id"]
    card = {
        "id": cid,
        "name": char["name"],
        "call": char.get("call"),
        "age": char["age"],
        "gender": char["gender"],
        "role": char["public_role"],
        "adult_context": char.get("adult_context"),
        "appearance": char.get("appearance"),
        "mood": MO.panel(state, cid),
    }
    if char.get("voices"):
        card["voices"] = dict(char["voices"])
    if char.get("routine"):
        card["routine"] = [dict(slot) for slot in char["routine"]]
    return card


def full(state, persona, save=None):
    context = brief(state, persona, save)
    context["depth"] = "full"
    player = state["player_id"]
    her = SS.companion(state)
    pchar = state["characters"][player]
    context["player"].update(
        {
            "background": pchar.get("appearance"),
            "adult_context": pchar.get("adult_context"),
        }
    )
    # The prose is the system prompt's; the full context repeats only the
    # structured fields the persona also carries.
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
    context["card"] = _card(state, state["characters"][her])
    edge = SS.edge(state, her, player) or {}
    context["relationship"] = {
        "trust": edge.get("trust", 0),
        "tension": edge.get("tension", 0),
        "stage": SS.stage_label(edge.get("stage", "stranger")),
        "recent": [h["reason"] for h in (edge.get("history") or [])[-4:]],
    }
    # The brief lists are the head of these full lists; carrying both would
    # only repeat them.
    context.pop("known_facts", None)
    context.pop("due_soon", None)
    context["player_facts"] = player_facts(state, 30)
    context["events"] = _events(state)
    _fit_full(context)
    return context


# -- commit template -----------------------------------------------------------


def commit_template(state, persona):
    """A commit-turn input to fill in, returned when a session starts (new
    game, load, import): the operations most turns need, so the first turn
    needs no reading of operations. Angle brackets mark what to write; "a|b"
    means pick one. It sits beside the context and does not count toward its
    budget."""
    her = SS.companion(state)
    options = AG.candidates(state, persona, her, state["turn"] + 1, limit=1)
    kind = options[0]["kind"] if options else "observe"
    return _template(
        state,
        {
            "action_mode": "attempt|result|continue|wait",
            "player_input": "<玩家原话>",
            "player_authorized": False,
            "acts_on_her": True,
            "operations": [
                {"op": "npc_response", "response": "refuse|negotiate|partial|surface|genuine", "note": "<TA怎么回应，<=80 字；surface 另写 true_intent>"},
                {"op": "npc_action", "kind": kind, "action": "<TA自己做了什么>", "significant": True},
                {"op": "add_fact", "key": "<小写点分键，如 %s.secret.letter>" % her, "text": "<正文里新写出、以后要用到的细节>", "scope": "shared", "origin": "observed"},
                {"op": "relationship", "trust_delta": "<-2..2 的整数；关系没变就删掉这条>", "reason": "<为什么>"},
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
    turn["remember"] = "<可选：TA 会怎么记得这件事，第一人称、带感受，<=60 字；不写就删掉这条>"
    if state["requests"].get("memory_summary"):
        turn["memory_summary"] = "<memory_summary_sources 那一天，第一人称写成一条：发生了什么、什么感受，相似的合并注明次数，<=80 字>"
    if state["requests"].get("memory_archive"):
        turn["memory_archive"] = "<memory_archive_sources 这些日子，第一人称归成一段篇章：里程碑和长期变化，<=60 字>"
    return {
        "session_id": state["session_id"],
        "request_id": "<上一次返回的 next_request_id>",
        "expected_revision": "<上一次返回的 revision>",
        "encoding_check": "汉字",
        "turns": [turn],
    }


# -- full-context budget -------------------------------------------------------

CARD_SUMMARY_KEYS = ("id", "name", "call", "age", "gender", "role", "adult_context", "mood")


def _fit_steps(context):
    """Trim in order until the full context fits; each step keeps it usable."""

    def rules_cut():
        context["persona"]["rules"] = context["persona"]["rules"][:4]

    def card_clipped():
        for key in list(context["card"]):
            if key not in CARD_SUMMARY_KEYS:
                del context["card"][key]

    def facts_cut():
        while context.get("player_facts") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["player_facts"].pop()

    def events_cut():
        while context.get("events") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["events"].pop()

    def agency_cut():
        while context.get("agency") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["agency"].pop()

    return [rules_cut, card_clipped, facts_cut, events_cut, agency_cut]


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
