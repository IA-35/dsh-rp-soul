"""Deterministic candidate actions for an autonomous NPC.

The original engine left "what does he do on his own" entirely to the model:
`npc_action` was free text plus a cooldown. For a single-character story that
is the weakest link - the character only ever reacts to the player.

Here the engine proposes two or three concrete candidates, each with a reason
drawn from state it can see (mood band, tension, pending events, what he
actually knows, the hour), and the model must pick one:

* every candidate carries the fact ids that justify it, and the op checks
  them against the character's information set, so he cannot act on
  something he was never told;
* scoring is a fixed table, ties broken by declaration order, so the same
  state always yields the same list (a redo of a turn does not change his
  mind);
* a random nudge comes from rng.unit(seed, "beat", turn, cid), which is
  derived from coordinates - undo and redo give the same nudge.

Nothing here mutates state; the caller decides what to write.
"""

from . import clock as CL
from . import mood as MO
from . import rng
from . import state as SS
from . import structure as ST

# (kind, reason-key) -> weight. Reasons, not story: the label is rendered from
# the persona's own places and cast, so no text lives here.
PRIOR_GOAL = 1.5
RECENT_TURNS = 3
NUDGE = 1.0


def _recent_facts(state, cid, turn):
    """Facts this character learned or was told in the last few turns."""
    out = []
    for fid in sorted(SS.info_set(state, cid)):
        fact = state["facts"].get(fid) or {}
        if turn - (fact.get("turn") or 0) <= RECENT_TURNS:
            out.append(fid)
    return out[:4]


def _pending_for(state, cid):
    return sorted(e["id"] for e in state["events"].values() if e["state"] == "pending" and cid in e["participants"])


def _due_soon(state, cid):
    now = CL.to_abs(state["clock"])
    soonest = None
    for e in state["events"].values():
        if e["state"] != "pending" or cid not in e["participants"]:
            continue
        left = CL.to_abs(e["due"]) - now
        soonest = left if soonest is None else min(soonest, left)
    return soonest


def _goal_kind(state, cid):
    goal = (state["characters"].get(cid) or {}).get("goal") or {}
    kind = goal.get("kind")
    return kind if kind in ST.AGENCY_KINDS else None


def score(state, cid, turn):
    """[(score, kind, basis_fact_ids, event_ids)] in declaration order."""
    band = MO.evaluate(state, cid)[1]
    edge = SS.edge(state, cid, state["player_id"])
    tension = edge["tension"] if edge else 0
    trust = edge["trust"] if edge else 0
    stage = SS.stage_index(edge["stage"]) if edge else 0
    present = SS.is_present(state, cid)
    char = state["characters"][cid]
    sick = any(c["kind"] in ST.INCAPACITATING for c in char["status"]["conditions"])
    hour = state["clock"]["minute"] // 60
    late = hour >= 23 or hour < 6
    recent = _recent_facts(state, cid, turn)
    pending = _pending_for(state, cid)
    due = _due_soon(state, cid)
    rows = []

    def add(kind, weight, basis=None, events=None):
        rows.append((float(weight), kind, list(basis or []), list(events or [])))

    # mood band is the loudest signal: a low bar narrows what he can do
    add("approach", 2.0 if band == "open" else 0.0)
    add("request", 1.0 if band == "open" else 0.0)
    add("observe", 1.0 if band in ("normal", "closed") else 0.0)
    add("provoke", 3.0 if band == "break" else (1.0 if band == "closed" else 0.0))
    add("leave", 3.0 if band == "break" else (0.5 if band == "closed" else 0.0))

    # unfinished business pulls him towards the player - he wants an answer
    if pending:
        add("request", 2.0, events=pending)
        if due is not None and due <= ST.DAY:
            add("approach", 2.0, events=pending)
    # a frayed thread is easier to pull than a calm one
    if tension >= 3:
        add("provoke", 2.0)
        add("observe", 1.0)
    # an established bond lets him close the distance unasked
    if trust >= 2 and stage >= 2:
        add("approach", 2.0)
    if trust <= -2:
        add("leave", 1.0)
        add("provoke", 1.0)
    # something he just learned is worth acting on
    if recent:
        add("observe", 2.0, basis=recent)
        add("request", 1.0, basis=recent)
    if sick:
        add("leave", 2.0)
        add("observe", 0.5)
    if late:
        add("leave", 1.0)
        add("observe", 0.5)
    if not present:
        # an absent character can only appear (approach) or stay out (observe)
        add("observe", 0.5)
    goal = _goal_kind(state, cid)
    if goal:
        add(goal, PRIOR_GOAL)

    # deterministic nudge: same state, same order, every replay
    nudge = {row[1]: rng.unit(state["seed"], "beat", turn, cid, row[1]) * NUDGE for row in rows}
    rows = [(score_ + nudge[kind], kind, basis, events) for (score_, kind, basis, events) in rows if score_ > 0]
    return rows


def _text(state, persona, cid, kind, events):
    """One short line, built from persona places and the current scene."""
    name = (state["characters"].get(cid) or {}).get("name") or cid
    places = persona.get("places") or []
    here = state["scene"]["location_id"]
    place = SS.place(persona, here) or {}
    place_name = place.get("name") or here
    other = None
    for item in places:
        if item["id"] != here:
            other = item.get("name") or item["id"]
            break
    titles = {e["title"] for e in state["events"].values() if e["id"] in events}
    topic = next(iter(sorted(titles))) if titles else None
    if kind == "approach":
        return "%s 主动走近，提起%s" % (name, topic) if topic else "%s 主动来找你" % name
    if kind == "observe":
        return "%s 没出声，只是看着" % name
    if kind == "request":
        return "%s 开口要一个答复：%s" % (name, topic) if topic else "%s 开口要一个答复" % name
    if kind == "provoke":
        return "%s 用一句话刺过来" % name
    if kind == "leave":
        return "%s 转身走了%s" % (name, "，往%s去" % other if other else "")
    return "%s 在%s遇到点意外" % (name, place_name)


def candidates(state, persona, cid, turn=None, limit=None):
    """Up to AGENCY_MAX_CANDIDATES proposals, strongest first. Pure."""
    turn = state["turn"] + 1 if turn is None else turn
    limit = limit or ST.AGENCY_MAX_CANDIDATES
    if not SS.can_act(state, cid, turn, MO.open_bonus(state, cid)):
        return []
    if not SS.is_npc(state, cid):
        return []
    rows = score(state, cid, turn)
    rows.sort(key=lambda row: (-row[0], ST.AGENCY_KINDS.index(row[1])))
    out = []
    seen = set()
    for score_, kind, basis, events in rows:
        if kind in seen:
            continue
        seen.add(kind)
        out.append({
            "kind": kind,
            "label": ST.AGENCY_GOAL_KINDS.get(kind, kind),
            "text": _text(state, persona, cid, kind, events),
            "weight": round(score_, 3),
            "basis_fact_ids": basis,
            "event_ids": events,
        })
        if len(out) >= limit:
            break
    return out


def brief(state, persona, turn=None):
    """What the prompt shows: the strongest candidate per NPC, no walls of text."""
    turn = state["turn"] + 1 if turn is None else turn
    rows = []
    for cid in SS.npcs(state):
        options = candidates(state, persona, cid, turn, limit=2)
        if not options:
            continue
        rows.append({
            "character_id": cid,
            "name": (state["characters"].get(cid) or {}).get("name", cid),
            "options": options,
        })
    return rows


def allowed(state, persona, cid, kind, basis_fact_ids=None, turn=None):
    """Whether a proposed action is one of today's candidates. (ok, reason)."""
    options = candidates(state, persona, cid, turn)
    if not options:
        return False, "他现在不该有自主行动（冷却中，或不是 NPC）"
    picked = next((o for o in options if o["kind"] == kind), None)
    if picked is None:
        kinds = "/".join(o["kind"] for o in options)
        return False, "此刻他更可能 %s；换个方向，或写成非重大行动" % kinds
    allowed_ids = set(picked["basis_fact_ids"])
    for fid in basis_fact_ids or []:
        if fid not in allowed_ids:
            return False, "这条行动的依据只能是它自己看到/听到的事：%s" % ("、".join(sorted(allowed_ids)) or "无")
    return True, None
