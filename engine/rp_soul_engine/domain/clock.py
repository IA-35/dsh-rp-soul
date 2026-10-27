"""The story clock: {"day": N, "minute": 0..1439}. Time never flows back.

It is not an in-game clock the model can push around: every turn moves it by
exactly the real time that passed, so a session left alone for five minutes
or five days both land where the wall clock says they should.
"""

from datetime import datetime

from .structure import MINUTES_PER_DAY

CN_DIGITS = "零一二三四五六七八九"
SHICHEN = ("子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥")


def to_abs(clock):
    return (clock["day"] - 1) * MINUTES_PER_DAY + clock["minute"]


def parse_iso(text):
    """Parse one of the engine's stored ISO timestamps (None stays None).

    Strict on purpose: the sidecar validates user-supplied times with it, and
    a bad value has to come back as INVALID_INPUT instead of silently None.
    Reading a *stored* column is a different matter — see parse_iso_loose.
    """
    if not text:
        return None
    return datetime.fromisoformat(str(text).replace("Z", "+00:00"))


def parse_iso_loose(text):
    """Like parse_iso, but unreadable input is None instead of an exception.

    For columns already sitting in the database: an imported save carrying a
    bad `real_at` made every single settlement raise, and import never checks
    it, so one bad export bricked the game for good. Unreadable means "no
    anchor", which every caller already handles.
    """
    try:
        return parse_iso(text)
    except (TypeError, ValueError):
        return None


def real_minutes_between(earlier, later):
    """Whole minutes of real time between two stored ISO timestamps."""
    first, second = parse_iso(earlier), parse_iso(later)
    if first is None or second is None:
        return 0
    return int((second - first).total_seconds() // 60)


def from_abs(total):
    return {"day": total // MINUTES_PER_DAY + 1, "minute": total % MINUTES_PER_DAY}


def add_minutes(clock, minutes):
    return from_abs(to_abs(clock) + minutes)


def cn_number(value):
    """Chinese numerals for day counts (1..9999)."""
    if value < 10:
        return CN_DIGITS[value]
    if value < 20:
        return "十" + (CN_DIGITS[value - 10] if value > 10 else "")
    if value < 100:
        tens, ones = divmod(value, 10)
        return CN_DIGITS[tens] + "十" + (CN_DIGITS[ones] if ones else "")
    return str(value)


def day_label(day):
    return "第%s天" % cn_number(day)


def hm(minute):
    return "%02d:%02d" % divmod(minute, 60)


def shichen(minute):
    # 子时 is 23:00-01:00; each 时辰 spans two hours.
    index = ((minute + 60) // 120) % 12
    return SHICHEN[index] + "时"


def label(clock, style="hm"):
    text = "%s %s" % (day_label(clock["day"]), hm(clock["minute"]))
    if style == "shichen":
        text = "%s %s（%s）" % (day_label(clock["day"]), shichen(clock["minute"]), hm(clock["minute"]))
    return text


def minutes_between(a, b):
    return to_abs(b) - to_abs(a)


def compare(a, b):
    return (to_abs(a) > to_abs(b)) - (to_abs(a) < to_abs(b))
