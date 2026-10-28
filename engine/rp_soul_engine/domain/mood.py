"""Mood: a 0-100 bar fed by thoughts, and the behaviour gate it drives.

Two axes stay separate on purpose:

* ``mood``  - how he is *right now*: short-lived, fed by concrete things that
  just happened, falls back as thoughts fade.
* ``trust`` / ``stage`` - how he *judges you over time*: slow, staged, capped
  at +-2 per turn (see domain/relationship.py).

A band is derived from the value every time it is read, never stored: it is
current policy, not history. Nothing persistent happens when the value drops;
only this turn's operations are constrained (no RimWorld mental state).

Two kinds of thoughts, with different authors:

* ``situational`` - the engine computes them from state it already has
  (presence, clock, pending events, tension, conditions). The model writes
  no word for these.
* ``memory`` - raised by an operation and *required* to name the fact it
  comes from (``source_fact_id``), so he cannot be angry about something he
  was never told.

Decay: ``linear`` shrinks the effect towards zero as the expire time
approaches (peak_delta keeps the original size for display); ``none`` is a
hard cut at expiry (situational, and the few memories that never soften).
A thought whose current |delta| < THOUGHT_MIN_ABS is dropped.
"""

from ..errors import INVARIANT_VIOLATION, detail
from . import clock as CL
from . import state as SS
from . import structure as ST


def thresholds(state):
    """Persona-adjustable thresholds, already validated at load time."""
    return state.get("mood_thresholds") or ST.MOOD_THRESHOLDS


def base_of(state, cid):
    char = state["characters"].get(cid) or {}
    mood = char.get("mood") or {}
    return mood.get("base", ST.MOOD_BASE)


def current_delta(thought, now):
    """The thought's effect right now, after linear decay."""
    delta = thought["delta"]
    if thought.get("decay") != "linear":
        return delta
    expires = thought.get("expires_at")
    since = thought.get("since_abs")
    if expires is None or since is None or expires <= since:
        return delta
    if now >= expires:
        return 0
    left = (expires - now) / float(expires - since)
    return int(round(delta * left))


def evaluate(state, cid, now=None):
    """Recompute (value, band) for one character. Pure; no mutation."""
    now = CL.to_abs(state["clock"]) if now is None else now
    mood = (state["characters"].get(cid) or {}).get("mood") or {}
    total = mood.get("base", ST.MOOD_BASE)
    for thought in mood.get("thoughts") or []:
        total += current_delta(thought, now)
    lo, hi = ST.MOOD_RANGE
    value = max(lo, min(hi, total))
    return value, band(value, thresholds(state))


def band(value, limits=None):
    """Which behaviour band a value falls into."""
    limits = limits or ST.MOOD_THRESHOLDS
    if value >= limits["open"]:
        return "open"
    if value >= limits["closed"]:
        return "normal"
    if value >= limits["break"]:
        return "closed"
    return "break"


def gate(band_name, op):
    """None = allowed; a string = why this op is refused in that band."""
    return (ST.MOOD_GATE.get(band_name) or {}).get(op)


def open_bonus(state, cid):
    """Extra cooldown relief for a significant action in the open band."""
    _value, named = evaluate(state, cid)
    return ST.MOOD_OPEN_COOLDOWN_BONUS if named == "open" else 0


def sorted_thoughts(mood, now):
    """Thoughts by effect size (strongest first), ties by id: deterministic."""
    items = [(thought, current_delta(thought, now)) for thought in mood.get("thoughts") or []]
    items.sort(key=lambda pair: (-abs(pair[1]), pair[0]["id"]))
    return items


def brief(state, cid, top=3):
    """What the model sees: value, band, and the strongest few thoughts."""
    value, named = evaluate(state, cid)
    now = CL.to_abs(state["clock"])
    mood = (state["characters"].get(cid) or {}).get("mood") or {}
    rows = []
    for thought, delta in sorted_thoughts(mood, now)[:top]:
        if delta == 0:
            continue
        row = {"label": thought["label"], "delta": delta}
        # 多久以前的事了：刚冒出来的念头和昨天留下的分量不一样
        since = thought.get("since_abs")
        if since is not None:
            row["ago_minutes"] = max(0, now - since)
        if thought.get("kind") == "situational":
            row["kind"] = "situational"
        rows.append(row)
    return {"value": value, "band": named, "top": rows}


def panel(state, cid):
    """What the settings page shows: every thought with its remaining time."""
    value, named = evaluate(state, cid)
    now = CL.to_abs(state["clock"])
    rows = []
    mood = (state["characters"].get(cid) or {}).get("mood") or {}
    for thought, delta in sorted_thoughts(mood, now):
        row = {
            "id": thought["id"],
            "label": thought["label"],
            "delta": delta,
            "peak_delta": thought.get("delta"),
            "kind": thought["kind"],
            "decay": thought.get("decay"),
            "since_turn": thought.get("since_turn"),
        }
        if thought.get("source_fact_id"):
            row["source_fact_id"] = thought["source_fact_id"]
        expires = thought.get("expires_at")
        row["remaining_minutes"] = None if expires is None else max(0, expires - now)
        rows.append(row)
    return {"value": value, "band": named, "base": base_of(state, cid), "thoughts": rows}


# ---------------------------------------------------------------------------
# writing


def _next_id(state, cid):
    counters = state["counters"].setdefault("next_thought", {})
    value = counters.get(cid, 1)
    counters[cid] = value + 1
    return "th%d" % value


def _find(mood, label=None, source_fact_id=None):
    for thought in mood.get("thoughts") or []:
        if source_fact_id is not None and thought.get("source_fact_id") == source_fact_id and thought.get("kind") == "memory":
            return thought
        if label is not None and thought.get("label") == label and thought.get("kind") == "situational":
            return thought
    return None


def add_thought(state, cid, label, delta, kind, source_fact_id=None, minutes=None, decay=None, turn=None):
    """Add or refresh one thought. Returns the thought actually stored.

    A memory thought keyed by the same source fact is *refreshed* rather than
    duplicated: the same thing happening twice must not stack a dozen rows.
    """
    if kind not in ST.THOUGHT_KINDS:
        raise ValueError("unknown thought kind: %s" % kind)
    lo, hi = ST.THOUGHT_DELTA_RANGE
    delta = max(lo, min(hi, int(delta)))
    mood = (state["characters"][cid] or {}).get("mood")
    if mood is None:
        # The player card has no mood blob on purpose: the player is a slot, and
        # nothing about how the player feels is stored. A relationship change
        # whose `to` is the player still reaches here (op_relationship marks the
        # receiving side), so this is a no-op rather than a crash.
        return None
    now = CL.to_abs(state["clock"])
    existing = _find(mood, label=label if kind == "situational" else None, source_fact_id=source_fact_id)
    if existing is not None:
        existing["label"] = label
        existing["delta"] = delta
        existing["since_abs"] = now
        existing["since_turn"] = turn if turn is not None else state["turn"] + 1
        existing["expires_at"] = None if minutes is None else now + minutes
        return existing
    thought = {
        "id": _next_id(state, cid),
        "label": label,
        "delta": delta,
        "kind": kind,
        "decay": decay or ("linear" if kind == "memory" else "none"),
        "since_turn": turn if turn is not None else state["turn"] + 1,
        "since_abs": now,
        "expires_at": None if minutes is None else now + minutes,
    }
    if source_fact_id is not None:
        thought["source_fact_id"] = source_fact_id
    mood.setdefault("thoughts", []).append(thought)
    _enforce_cap(mood, now)
    return thought


def _enforce_cap(mood, now):
    """Keep at most MOOD_MAX_MEMORY memory + MOOD_MAX_SITUATIONAL situational.

    Dropped first: the weakest effect; ties by oldest. Deterministic.
    """
    thoughts = mood.get("thoughts") or []
    for kind, cap in (("memory", ST.MOOD_MAX_MEMORY), ("situational", ST.MOOD_MAX_SITUATIONAL)):
        same = [t for t in thoughts if t["kind"] == kind]
        if len(same) <= cap:
            continue
        same.sort(key=lambda t: (abs(current_delta(t, now)), t["since_turn"], t["id"]))
        doomed = set(t["id"] for t in same[: len(same) - cap])
        mood["thoughts"] = [t for t in thoughts if t["id"] not in doomed]
        thoughts = mood["thoughts"]


def remove_thought(state, cid, thought_id):
    """Debug deletion from the settings page. Returns the removed thought."""
    mood = SS.mood_of(state, cid)
    for index, thought in enumerate(mood.get("thoughts") or []):
        if thought["id"] == thought_id:
            return mood["thoughts"].pop(index)
    return None


def settle(state, turn):
    """End-of-turn decay: drop expired and negligible thoughts.

    Runs inside settlement step 3 (the same clock walk that expires
    conditions), so a long time skip ages thoughts exactly once.
    """
    now = CL.to_abs(state["clock"])
    expired = []
    for cid in sorted(state["characters"]):
        mood = state["characters"][cid].get("mood")
        if not mood:
            continue
        keep = []
        for thought in mood.get("thoughts") or []:
            expires = thought.get("expires_at")
            delta = current_delta(thought, now)
            if expires is not None and now >= expires:
                expired.append({"character_id": cid, "label": thought["label"], "kind": thought["kind"]})
                continue
            if abs(delta) < ST.THOUGHT_MIN_ABS:
                faded = thought.get("decay") == "linear"
                expired.append({"character_id": cid, "label": thought["label"], "kind": thought["kind"], "faded": faded})
                continue
            keep.append(thought)
        mood["thoughts"] = keep
    return expired


# ---------------------------------------------------------------------------
# situational thoughts: computed by the engine, never written by the model


def refresh_situational(state, turn, gap=0, player_absent=False):
    """Recompute the engine-owned thoughts. Idempotent.

    Called after the clock moved; `gap` is how many real minutes passed since
    the last turn. Each situational thought is derived from state (presence,
    how long you were away, pending events, tension, conditions, hour).

    An untimed one that no longer applies simply disappears. A timed one
    ("很久没见你" for a day, "大半夜被打扰" for six hours) is a mood that
    lingers: it stays until it expires even after its cause is gone, and a
    cause that is still there refreshes it.
    """
    now = CL.to_abs(state["clock"])
    player = state["player_id"]
    # `player_absent` is the wake-line turn (together: false): she is alone even
    # though the player card stays in the scene, because the scene cannot drop
    # the player (invariants) and presence is not the same question as company.
    player_present = SS.is_present(state, player) and not player_absent
    planned = {}
    for cid in SS.npcs(state):
        char = state["characters"][cid]
        rows = []
        present = SS.is_present(state, cid)
        if present and player_present:
            rows.append(("在场", ST.SITUATIONAL_DELTA["present"], None))
        elif not player_present:
            rows.append(("你不在", ST.SITUATIONAL_DELTA["absent"], None))
        if player_present and gap >= ST.DAY:
            rows.append(("很久没见你", ST.SITUATIONAL_DELTA["away_long"], ST.SITUATIONAL_EXPIRES["away_long"]))
        due = [e for e in state["events"].values() if e["state"] == "pending" and cid in e["participants"]]
        if due:
            soonest = min(CL.to_abs(e["due"]) for e in due)
            if soonest <= now:
                rows.append(("有件该办的事已经过期", ST.SITUATIONAL_DELTA["event_overdue"], ST.SITUATIONAL_EXPIRES["event_overdue"]))
            elif soonest - now <= ST.DAY:
                rows.append(("有件该办的事快到期", ST.SITUATIONAL_DELTA["event_due"], None))
        edge = SS.edge(state, cid, player)
        if edge and edge["tension"] >= 3:
            rows.append(("你们之间还绷着", ST.SITUATIONAL_DELTA["tension"], None))
        for cond in char["status"]["conditions"]:
            if cond["kind"] in ST.INCAPACITATING:
                rows.append(("身体不太对劲", ST.SITUATIONAL_DELTA["condition"], None))
                break
        hour = state["clock"]["minute"] // 60
        if present and (hour >= 23 or hour < 6):
            rows.append(("大半夜被打扰", ST.SITUATIONAL_DELTA["late_hour"], ST.SITUATIONAL_EXPIRES["late_hour"]))
        planned[cid] = rows
    for cid, rows in planned.items():
        mood = state["characters"][cid]["mood"]
        mood["thoughts"] = [
            t for t in mood.get("thoughts") or []
            if t["kind"] != "situational" or (t.get("expires_at") is not None and t["expires_at"] > now)
        ]
        for label, delta, minutes in rows:
            add_thought(state, cid, label, delta, "situational", minutes=minutes, turn=turn)
    return planned


def thoughts_from_trust(state, cid, delta, fact_id, turn):
    """Trust moving is felt immediately, at three times its size."""
    if not delta:
        return None
    # Phrased from inside the character it belongs to: these labels are the
    # NPC's own mood entries and are fed to the model as such, so no pronouns
    # pointing at the NPC itself (the gender is persona data, not a constant).
    label = "心里对你多了几分信任" if delta > 0 else "心里对你的分量掉了"
    return add_thought(
        state, cid, label, int(delta) * ST.RELATIONSHIP_THOUGHT_SCALE, "memory",
        source_fact_id=fact_id, minutes=ST.THOUGHT_DURATION["tone"], turn=turn,
    )


def thoughts_from_stage(state, cid, fact_id, turn):
    """A stage advance is the biggest single lift in the system."""
    delta, scale = ST.STAGE_ADVANCE_THOUGHT
    return add_thought(
        state, cid, "你们更近了", delta, "memory",
        source_fact_id=fact_id, minutes=ST.THOUGHT_DURATION[scale], turn=turn,
    )


def thoughts_from_event_failed(state, cid, fact_id, turn):
    delta, scale = ST.EVENT_FAILED_THOUGHT
    return add_thought(
        state, cid, "事情搞砸了", delta, "memory",
        source_fact_id=fact_id, minutes=ST.THOUGHT_DURATION[scale], turn=turn,
    )


# ---------------------------------------------------------------------------
# initial state / persona validation


def initial(base=None, thresholds=None):
    """The mood blob a new character starts with."""
    return {"base": ST.MOOD_BASE if base is None else base, "thoughts": []}


def validate_thresholds(limits, path="$.persona.mood_thresholds"):
    """0 <= break < closed < open <= 100, checked loudly (never silently)."""
    errors = []
    if not isinstance(limits, dict):
        return [detail(path, "mood_thresholds 必须是对象", '形如 {"open": 75, "closed": 45, "break": 25}', INVARIANT_VIOLATION)]
    for key in ("open", "closed", "break"):
        if key not in limits:
            errors.append(detail("%s.%s" % (path, key), "缺少 %s" % key, None, INVARIANT_VIOLATION))
            continue
        value = limits[key]
        if not isinstance(value, int) or isinstance(value, bool):
            errors.append(detail("%s.%s" % (path, key), "%s 必须是整数" % key, None, INVARIANT_VIOLATION))
        elif not ST.MOOD_RANGE[0] <= value <= ST.MOOD_RANGE[1]:
            errors.append(detail("%s.%s" % (path, key), "%s 超出 0..100" % key, None, INVARIANT_VIOLATION))
    if errors:
        return errors
    if not limits["break"] < limits["closed"] < limits["open"]:
        errors.append(detail(
            path, "必须满足 break < closed < open",
            "当前 %d / %d / %d" % (limits["break"], limits["closed"], limits["open"]),
            INVARIANT_VIOLATION,
        ))
    return errors
