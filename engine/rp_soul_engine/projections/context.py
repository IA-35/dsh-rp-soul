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
from ..domain import mood as MO
from ..domain import structure as ST
from .. import persona as PE
from ..domain import state as SS
from ..domain.text import cue_keywords
from .. import modules as MODULES

BRIEF_LIMIT = 6 * 1024
FULL_LIMIT = 20 * 1024
# size_bytes is added after fitting; its own bytes count toward the limit.
SIZE_FIELD_RESERVE = 24
LIMITS = {"due_soon": 10, "known_facts": 8, "her_knows": 5}

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


def _companion_brief(state, cid, turn):
    char = state["characters"][cid]
    player = state["player_id"]
    to_player = SS.edge(state, cid, player) or {}
    entry = {
        "id": cid,
        "name": char["name"],
        "age": char["age"],
        "gender": char["gender"],
        "role": char["public_role"],
        "present": SS.is_present(state, cid),
        "can_act": (MO.evaluate(state, cid)[1] == "break")
        or SS.can_act(state, cid, state["clock"], MO.open_bonus(state, cid)),
        "trust_to_player": to_player.get("trust", 0),
        "tension": to_player.get("tension", 0),
        "stage": SS.stage_label(to_player.get("stage", "stranger")),
    }
    doing = PE.doing_at(char, state["clock"]["minute"])
    if doing:
        # 作息说她这个点通常在做什么：写正文时的背景，不是命令
        entry["routine_now"] = doing
    if char["status"]["conditions"]:
        entry["conditions"] = [c["text"] for c in char["status"]["conditions"]]
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
    facts = FA.of(state).player_ranked(player, ids, names, CL.to_abs(state["clock"]), limit)
    out = []
    for fact in facts:
        item = {"id": fact["id"], "text": fact["text"], "visibility": fact["visibility"]}
        if not fact["truth"]:
            item["believed_not_true"] = True
        if fact.get("thought_suppressed"):
            item["suppressed"] = True
        out.append(item)
    return out


def her_knows(state, cue="", limit=LIMITS["her_knows"]):
    """What only she knows (her secrets, her real intentions, what she was told
    alone): RimTalk's common-knowledge track. Matched against the cue first,
    the most recent next; the player's own facts are known_facts."""
    her = SS.companion(state)
    player = state["player_id"]
    if not her:
        return []
    own = [f for f in FA.of(state).known_to(her) if player not in f["known_by"] and player not in f["believed_by"]]
    cue_keys = cue_keywords(state, cue)

    def match(fact):
        return sum(1 for key in cue_keys if key in fact["text"])

    own.sort(key=lambda f: (-match(f), -f["turn"], -FA.order(f)))
    out = []
    for fact in own[:limit]:
        item = {"id": fact["id"], "text": fact["text"], "visibility": fact["visibility"]}
        if not fact["truth"]:
            item["believes_but_untrue"] = True
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


# 引擎自己写的回合（唤醒线）不算玩家开口：她醒来不能把"多久没说话"清零。
ENGINE_TURNS = ("wake",)


def brief(state, persona, save=None, cue=""):
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
        "her_knows": her_knows(state, cue),
        "open_action": state["memory"].get("open_action") or "",
        "scene_responses": [r["response"] for r in scene.get("responses", [])[-3:]],
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
    contributed = MODULES.project(state, persona, cue)
    context.update(contributed["context"])
    context["companion"].update(contributed["companion"])
    _fit(context, BRIEF_LIMIT, ("known_facts", "her_knows", "due_soon", "scene_responses", "memories", "agency"))
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
    }
    if char.get("voices"):
        card["voices"] = dict(char["voices"])
    if char.get("routine"):
        card["routine"] = [dict(slot) for slot in char["routine"]]
    return card


def full(state, persona, save=None, cue=""):
    context = brief(state, persona, save, cue)
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
    contributed = MODULES.project(state, persona, cue, full=True)
    context.update(contributed["context"])
    context["card"].update(contributed["card"])
    context["persona"].update(contributed["persona"])
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
    options = AG.candidates(state, persona, her, state["turn"] + 1, at=state["clock"], limit=1)
    broken = MO.evaluate(state, her)[1] == "break"
    kind = options[0]["kind"] if options else "silence" if broken else "observe"
    return _template(
        state,
        {
            "action_mode": "attempt|result|continue|wait",
            "player_input": "<玩家原话>",
            "player_authorized": False,
            "acts_on_her": True,
            "operations": [
                {"op": "npc_response", "response": "refuse|negotiate|partial|surface|genuine", "note": "<TA怎么回应，<=80 字；surface 另写 true_intent>"},
                {"op": "npc_action", "kind": kind, "action": "<TA自己做了什么>", "significant": bool(options)},
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
    if dict(state["requests"]).get("memory_fold"):
        turn["memory_fold"] = "<读 memory_fold_sources，把这一批收成一条 SCM：第一人称（我），发生了什么、当时的感受，留下带得住的细节，<=300 字>"
        turn["memory_keep"] = ["<可选：值得一直记着的 0~2 条经历 id（会进 CLPA），没有就删掉这条>"]
    if dict(state["requests"]).get("memory_diary"):
        turn["memory_diary"] = "<读 memory_diary_sources，把这一天写成一篇日记：第一人称（我），按时间顺下来，感受和变化，<=300 字>"
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

    def memories_cut():
        while context.get("memories") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["memories"].pop()

    def agency_cut():
        while context.get("agency") and size_of(context) > FULL_LIMIT - SIZE_FIELD_RESERVE:
            context["agency"].pop()

    return [rules_cut, card_clipped, facts_cut, events_cut, memories_cut, agency_cut]


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
    # 每 pop 一次都重新全量 dumps 是 O(n²)：候选列表长、上限又小的时候，
    # 一回合能白白烧掉上百次序列化。这里改成二分找「这一项最多能留几个」——
    # 判定单调（留得越少越小），一次二分只要 log(n) 次测量，
    # 而与原来的逐条 pop 结果一致：先砍 key 在 order 里靠前的，砍到不能再砍再换下一项。
    for key in order:
        if size_of(context) <= limit:
            break
        if isinstance(context.get(key), dict):
            context[key] = {}
            continue
        lst = context.get(key)
        if not isinstance(lst, list) or not lst:
            continue
        total = len(lst)

        def size_with(keep):
            context[key] = lst[:keep]
            return size_of(context)

        context[key] = []
        if size_of(context) > limit:
            # 全砍空都不够：这一项帮不上忙，保持砍空，交给下一项。
            continue
        lo, hi = 0, total
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if size_with(mid) <= limit:
                lo = mid
            else:
                hi = mid - 1
        context[key] = lst[:lo]
    context["size_bytes"] = size_of(context)
