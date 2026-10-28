"""Deterministic candidate actions for her, on her own initiative.

The original engine left "what does she do on her own" entirely to the model:
`npc_action` was free text plus a cooldown. For a companion that is the
weakest link - she only ever reacts to the player.

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

# Reasons, not story: the text names her and the pending business, nothing
# else is invented here.
# 「她刚知道的事」是半小时内知道的，不是「最近三句里」知道的。
RECENT_MINUTES = 30
NUDGE = 1.0


def _fact_at(fact):
    at = fact.get("at")
    return None if at is None else CL.to_abs(at)


def _recent_facts(state, cid, now):
    """Facts this character learned or was told in the last half hour."""
    out = []
    for fid in sorted(SS.info_set(state, cid)):
        fact = state["facts"].get(fid) or {}
        at = _fact_at(fact)
        if at is not None and now - at <= RECENT_MINUTES:
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


def _band_reason(band, value, weighing):
    """Why the mood band is what it is, in the persona's own vocabulary.

    `weighing` are the labels mood.py already put on his mind ("你不在",
    "有件该办的事快到期"). Reusing them keeps one vocabulary for "why" instead
    of inventing a second one here. Band names match README's 开心/平稳/低落/难过
    so the prompt and the settings page say the same word.
    """
    named = {"open": "心情开心", "normal": "心情平稳", "closed": "心情低落", "break": "心情难过"}
    head = "%s（%d）" % (named.get(band, "心情"), value)
    if weighing:
        return head + "，" + "、".join(weighing[:2])
    return head


def _clock_of(state, at):
    return state["clock"] if at is None else at


def score(state, cid, turn, at=None):
    """[(score, kind, basis_fact_ids, event_ids, reason)] in declaration order.

    `turn` only seeds the deterministic nudge (a replay must land on the same
    list); every rule below reads the clock, never the count of messages.

    `reason` is a short "why" phrase built from state the character can see, so
    the prompt can say why he leans that way instead of only what he leans
    toward. Several contributions to the same kind carry several reasons; the
    caller keeps the candidate with the highest score and merges theirs.
    """
    mood = MO.brief(state, cid)
    band = mood["band"]
    value = mood["value"]
    weighing = [row.get("label") for row in mood.get("top") or [] if row.get("label")]
    edge = SS.edge(state, cid, state["player_id"])
    tension = edge["tension"] if edge else 0
    trust = edge["trust"] if edge else 0
    stage = SS.stage_index(edge["stage"]) if edge else 0
    present = SS.is_present(state, cid)
    char = state["characters"][cid]
    sick = any(c["kind"] in ST.INCAPACITATING for c in char["status"]["conditions"])
    hour = state["clock"]["minute"] // 60
    late = hour >= 23 or hour < 6
    recent = _recent_facts(state, cid, CL.to_abs(_clock_of(state, at)))
    pending = _pending_for(state, cid)
    due = _due_soon(state, cid)
    rows = []
    band_reason = _band_reason(band, value, weighing)

    def add(kind, weight, basis=None, events=None, reason=None):
        rows.append((float(weight), kind, list(basis or []), list(events or []), reason))

    # mood band is the loudest signal: a low bar narrows what he can do
    add("approach", 2.0 if band == "open" else 0.0, reason=band_reason)
    add("request", 1.0 if band == "open" else 0.0, reason=band_reason)
    add("observe", 1.0 if band in ("normal", "closed") else 0.0, reason=band_reason)
    low = band in ("closed", "break")
    add("silence", 2.0 if low else 0.0, reason=band_reason)
    add("change_topic", 2.0 if low else 0.0, reason=band_reason)
    add("withdraw", 2.0 if low else 0.0, reason=band_reason)
    if low and trust >= 1:
        add("seek_comfort", 3.0, reason="虽然难过，还是信任你（信任 %d），想有人陪一会儿" % trust)
    if low and trust < 0:
        add("withdraw", 3.0, reason="心里难受又不太信任你，想自己缓一会儿")

    # unfinished business pulls him towards the player - he wants an answer
    if pending:
        titles = [state["events"][eid].get("title") or "那件事" for eid in pending]
        add("request", 2.0, events=pending, reason="还有件事没个答复：" + titles[0])
        if due is not None and due <= ST.DAY:
            add("approach", 2.0, events=pending, reason="有件该办的事快到期：" + titles[0])
    # a frayed thread is easier to pull than a calm one
    if tension >= 3:
        add("provoke", 2.0, reason="你们之间还绷着（张力 %d）" % tension)
        add("observe", 1.0, reason="你们之间还绷着，得先看清楚")
    # an established bond lets him close the distance unasked
    if trust >= 2 and stage >= 2:
        add("approach", 2.0, reason="已经熟了（信任 %d），敢自己凑过来" % trust)
    if trust <= -2:
        add("leave", 1.0, reason="信不过你（信任 %d）" % trust)
        add("provoke", 1.0, reason="信不过你（信任 %d）" % trust)
    # something he just learned is worth acting on
    if recent:
        add("observe", 2.0, basis=recent, reason="刚知道点事，正琢磨")
        add("request", 1.0, basis=recent, reason="刚知道点事，想问个明白")
    if sick:
        add("leave", 2.0, reason="身体不太对劲")
        add("observe", 0.5, reason="身体不太对劲，不太想动")
    if late:
        add("leave", 1.0, reason="这么晚了，想收场")
        add("observe", 0.5, reason="这么晚了，不想多说话")
    if not present:
        # an absent character can only appear (approach) or stay out (observe)
        add("observe", 0.5, reason="这会儿不在场")

    # No手填 goal prior here on purpose: what he wants right now is what these
    # state terms say it is. A static "current goal" typed into the persona
    # would outrank every live signal with the same weight on every turn, which
    # is the opposite of an engine-measured intent.

    # deterministic nudge: same state, same order, every replay
    nudge = {row[1]: rng.unit(state["seed"], "beat", turn, cid, row[1]) * NUDGE for row in rows}
    rows = [
        (score_ + nudge[kind], kind, basis, events, reasons)
        for (score_, kind, basis, events, reasons) in rows
        if score_ > 0
    ]
    return rows


def _text(state, persona, cid, kind, events):
    """One short line: her name and, when there is one, the pending business."""
    name = (state["characters"].get(cid) or {}).get("name") or cid
    titles = {e["title"] for e in state["events"].values() if e["id"] in events}
    topic = next(iter(sorted(titles))) if titles else None
    if kind == "approach":
        return "%s 主动凑过来，提起%s" % (name, topic) if topic else "%s 主动来找你" % name
    if kind == "observe":
        return "%s 没出声，只是看着你" % name
    if kind == "request":
        return "%s 开口要一个答复：%s" % (name, topic) if topic else "%s 开口要一个答复" % name
    if kind == "provoke":
        return "%s 用一句话刺过来" % name
    if kind == "leave":
        return "%s 不想再说了，转身走开" % name
    if kind == "silence":
        return "%s 安静下来，暂时没有开口" % name
    if kind == "seek_comfort":
        return "%s 试着告诉你自己的难过，想有人陪一会儿" % name
    if kind == "change_topic":
        return "%s 暂时放下这个话题，转而说起别的事" % name
    if kind == "withdraw":
        return "%s 想自己待一会儿，慢慢缓过来" % name
    return "%s 遇到点意外" % name


def candidates(state, persona, cid, turn=None, limit=None, at=None):
    """Up to AGENCY_MAX_CANDIDATES proposals, strongest first. Pure.

    Whether she may make a big move is asked of the clock, so a burst of short
    messages cannot burn her cooldown in five minutes of wall time.
    """
    turn = state["turn"] + 1 if turn is None else turn
    at = _clock_of(state, at)
    limit = limit or ST.AGENCY_MAX_CANDIDATES
    broken = MO.evaluate(state, cid)[1] == "break"
    if not broken and not SS.can_act(state, cid, at, MO.open_bonus(state, cid)):
        return []
    if not SS.is_npc(state, cid):
        return []
    rows = score(state, cid, turn, at)
    if broken:
        rows = [row for row in rows if row[1] in ST.MOOD_REACTION_KINDS]
    rows.sort(key=lambda row: (-row[0], ST.AGENCY_KINDS.index(row[1])))
    # Whichever row wins a kind, every reason that pushed that kind belongs on
    # it: a candidate with "心情压得低" alone hides the event that is due.
    reasons_of = {}
    for _score, kind, _basis, _events, reason in rows:
        if reason and reason not in reasons_of.setdefault(kind, []):
            reasons_of[kind].append(reason)
    out = []
    seen = set()
    for score_, kind, basis, events, _reason in rows:
        if kind in seen:
            continue
        seen.add(kind)
        reasons = reasons_of.get(kind) or []
        out.append({
            "kind": kind,
            "label": ST.AGENCY_GOAL_KINDS.get(kind, kind),
            "text": _text(state, persona, cid, kind, events),
            "weight": round(score_, 3),
            "basis_fact_ids": basis,
            "event_ids": events,
            "reasons": reasons[:3],
            "because": _because(reasons),
        })
        if len(out) >= limit:
            break
    return out


def _because(reasons):
    """One clause a prompt can append verbatim; empty when there is nothing to say.

    Kept short on purpose: this line rides inside a system-prompt snapshot next
    to the clock and the cast, and a wall of text there costs more than it tells.
    """
    kept = [r.strip() for r in reasons if isinstance(r, str) and r.strip()][:2]
    if not kept:
        return ""
    line = "因为" + "，而且".join(kept)
    return line if len(line) <= 90 else line[:89] + "…"


def brief(state, persona, turn=None, at=None):
    """What the prompt shows: her strongest candidates, no walls of text."""
    turn = state["turn"] + 1 if turn is None else turn
    rows = []
    for cid in SS.npcs(state):
        options = candidates(state, persona, cid, turn, at=at, limit=2)
        if not options:
            continue
        rows.append({
            "character_id": cid,
            "name": (state["characters"].get(cid) or {}).get("name", cid),
            "options": options,
        })
    return rows

