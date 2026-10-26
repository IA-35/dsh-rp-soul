"""When she should wake up on her own.

Everything here is derived from the ledger: her standing plan, the promises
you two made, her own business, how long you have been quiet, and the next
segment of her routine. Nothing is model-authored, and nothing mutates state.

Time is kept in two shapes and they are the same line:

* the story clock ({"day": N, "minute": M}) the engine advances by real time;
* the wall clock, as an aware ISO timestamp: `real_at` was the moment the last
  turn settled, and the difference between two clocks is the difference
  between two moments. So a future clock converts to a future timestamp by
  adding `CL.minutes_between(state["clock"], target)` to `real_at`.

The quiet window (default 00:00-08:00) only silences the candidates she did
not ask for: a plan she wrote herself is allowed to wake her at 03:00.
"""

from datetime import timedelta

from . import clock as CL
from . import ops
from .. import persona as PE
from . import structure as ST


def parse_quiet(text):
    """'00:00-08:00' -> (0, 480); an empty or broken value means no quiet hours."""
    if not text or not isinstance(text, str):
        return None
    parts = text.split("-")
    if len(parts) != 2:
        return None
    ends = []
    for part in parts:
        piece = part.strip()
        if len(piece) != 5 or piece[2] != ":":
            return None
        try:
            hour, minute = int(piece[:2]), int(piece[3:])
        except ValueError:
            return None
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return None
        ends.append(hour * 60 + minute)
    if ends[0] == ends[1]:
        return None
    return ends[0], ends[1]


def in_quiet(clock, quiet):
    """Is this minute inside the quiet window (which may wrap midnight)?"""
    if quiet is None:
        return False
    start, end = quiet
    minute = clock["minute"]
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


def quiet_end(clock, quiet):
    """The first clock minute at or after `clock` that is outside the quiet window."""
    if quiet is None or not in_quiet(clock, quiet):
        return clock
    start, end = quiet
    out = dict(clock)
    out["minute"] = end
    if CL.to_abs(out) < CL.to_abs(clock):
        out = CL.add_minutes(out, ST.MINUTES_PER_DAY)
    return out


def _base(state, now=None):
    """The wall-clock moment the current story clock stands on.

    Saves written before this line existed (or migrated from the old engine)
    carry neither `real_at` nor `real_start`; the story clock then stands on
    the moment we are asked, which is what the next turn will assume anyway.
    """
    base = CL.parse_iso(state.get("real_at")) or CL.parse_iso(state.get("real_start"))
    return base or now


def to_real(state, clock, now=None):
    """The wall-clock moment this story-clock moment lands on."""
    base = _base(state, now)
    if base is None:
        return None
    return (base + timedelta(minutes=CL.minutes_between(state["clock"], clock))).isoformat(timespec="seconds")


def _candidate(reason, clock, why, **extra):
    row = {"reason": reason, "label": ST.WAKE_REASON_LABELS[reason], "at": dict(clock), "why": why,
           "clock_label": CL.label(clock)}
    row.update(extra)
    return row


def _plan_candidates(state):
    plan = ops.current_plan(state)
    if plan is None:
        return []
    return [_candidate(
        "plan", plan["until"],
        "这是我说好做到的时间：%s" % plan["note"],
        note=plan["note"], set_turn=plan.get("set_turn"),
    )]


def _event_candidates(state):
    player = state["player_id"]
    out = []
    for eid in sorted(state["events"], key=lambda key: CL.to_abs(state["events"][key]["due"])):
        event = state["events"][eid]
        if event["state"] != "pending":
            continue
        if event["kind"] == "promise" and player in event["participants"]:
            at = CL.add_minutes(event["due"], -ST.WAKE_LEAD_MINUTES)
            if CL.to_abs(at) <= CL.to_abs(state["clock"]):
                at = dict(event["due"])
            out.append(_candidate(
                "promise", at,
                "离「%s」还有半小时" % event["title"],
                event_id=eid, title=event["title"], due=dict(event["due"]),
            ))
        elif player not in event["participants"]:
            out.append(_candidate(
                "event", dict(event["due"]),
                "「%s」到时间了" % event["title"],
                event_id=eid, title=event["title"], due=dict(event["due"]),
            ))
    return out


def _miss_you_candidates(state, hours, streak=0, now=None, last_wake_at=None):
    if not hours:
        return []
    player_at = CL.parse_iso(state.get("last_player_at"))
    base = player_at or _base(state, now)
    if base is None:
        return []
    if last_wake_at is not None and player_at is not None and player_at > last_wake_at:
        streak = 0
    span = ST.WAKE_MISS_YOU_NEXT
    gap = hours
    for index in range(max(0, int(streak))):
        gap = span[min(index + 1, len(span) - 1)]
    if streak and last_wake_at is not None and last_wake_at > base:
        base = last_wake_at
    at = base + timedelta(hours=gap)
    if now is not None and at <= now:
        at = now + timedelta(minutes=1)
    clock = _clock_at_real(state, at, now)
    if clock is None:
        return []
    player = (state["characters"].get(state["player_id"]) or {}).get("name") or "你"
    return [_candidate(
        "miss_you", clock,
        "%s 已经 %d 小时没说话了" % (player, int((at - (player_at or base)).total_seconds() // 3600)),
        player_name=player, hours=gap, at_real=at.isoformat(timespec="seconds"),
    )]


def _clock_at_real(state, moment, now=None):
    """Inverse of to_real: which story-clock minute a wall-clock moment is."""
    base = _base(state, now)
    if base is None:
        return None
    minutes = int((moment - base).total_seconds() // 60)
    return CL.add_minutes(state["clock"], minutes)


def _routine_candidates(state, persona):
    routine = (persona or {}).get("routine") or []
    if not routine:
        return []
    now = state["clock"]["minute"]
    starts = sorted(slot["from"] for slot in routine)
    ahead = [start for start in starts if start > now]
    target = ahead[0] if ahead else starts[0]
    clock = dict(state["clock"])
    clock["minute"] = target
    if CL.to_abs(clock) <= CL.to_abs(state["clock"]):
        clock = CL.add_minutes(clock, ST.MINUTES_PER_DAY)
    doing = PE.doing_at(persona, target) or "换个样子"
    return [_candidate(
        "routine", clock,
        "到 %s 了，按平常该「%s」了" % (CL.hm(clock["minute"]), doing),
        doing=doing,
    )]


def candidates(state, persona, miss_you_hours=None, streak=0, routine=True, quiet=None, now=None, last_wake_at=None):
    """Every wake candidate in clock order. Pure."""
    if (state.get("safety") or {}).get("paused"):
        return []
    hours = ST.WAKE_MISS_YOU_HOURS if miss_you_hours is None else miss_you_hours
    rows = []
    rows.extend(_plan_candidates(state))
    rows.extend(_event_candidates(state))
    rows.extend(_miss_you_candidates(state, hours, streak, now, last_wake_at))
    if routine:
        rows.extend(_routine_candidates(state, persona))
    out = []
    for row in rows:
        clock = row["at"]
        if CL.to_abs(clock) <= CL.to_abs(state["clock"]):
            clock = CL.add_minutes(state["clock"], 1)
        if row["reason"] != "plan":
            moved = quiet_end(clock, quiet)
            if CL.to_abs(moved) != CL.to_abs(clock):
                clock = moved
                row["quiet_shifted"] = True
                if row["reason"] == "routine":
                    # 换段被安静时段推到早上：理由里的时刻也要跟着改，否则说的是 00:00
                    row["why"] = "到 %s 了，按平常该「%s」了" % (CL.hm(clock["minute"]), row["doing"])
        if clock != row["at"]:
            row["at_real"] = to_real(state, clock, now)
        row["at"] = clock
        row["clock_label"] = CL.label(clock)
        row["at_real"] = row.get("at_real") or to_real(state, clock, now)
        out.append(row)
    out.sort(key=lambda row: (CL.to_abs(row["at"]), ST.WAKE_REASONS.index(row["reason"])))
    return out


def next_wake(state, persona, miss_you_hours=None, streak=0, routine=True, quiet_text=None, now=None, last_wake_at=None):
    """The earliest candidate plus the whole list, or (None, []) when she stays asleep."""
    quiet = parse_quiet(quiet_text if quiet_text is not None else ST.WAKE_QUIET)
    rows = candidates(state, persona, miss_you_hours, streak, routine, quiet, now, last_wake_at)
    if not rows:
        return None, []
    return rows[0], rows
