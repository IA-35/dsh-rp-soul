"""The persona pack: one companion, "you and me", and the only thing the engine reads.

The engine was ported from a multi-character story engine (a cast, a map, NPCs
gossiping along a relationship web). rp-soul is a single companion, so the
persona is one person, flat:

    {
      "id": "lin_wan",             # ascii slug: the persona id *and* her id
      "title": "林晚",              # shown in the save list; defaults to name
      "revision": "8f3ac1...",     # sha256 of the composed prose + front matter
      "prose": "...",              # the composed text; the engine never parses it
      "person": "second",
      "clock_style": "hm",
      "name": "林晚", "call": "林医生", "age": 34, "gender": "female",
      "role": "夜班医生", "adult_context": "...", "appearance": "...",
      "voices": {"surface": "...", "inner": "..."},
      "start_stage": "familiar",
      "mood_base": 55,
      "mood_thresholds": {"open": 75, "closed": 45, "break": 25},
      "routine": [{"from": 540, "to": 1080, "doing": "在诊所上班"}],
      "rules": ["..."], "twists": ["..."]
    }

A file in the old shape (``places`` + ``cast``) is still read: the first major
cast member becomes her, and her schedule becomes a routine named after the
places ("在诊所"). Everything else of the old shape is dropped.

Design rule: **the engine validates a persona and never invents content.** If
a field is missing it is an error with a path and a hint, never a silent
default.
"""

import hashlib

from . import schema as S
from .errors import INVALID_INPUT, SAFETY_BLOCK, detail
from .domain import mood as MO
from .domain import state as SS
from .domain import structure as ST
from .domain import text as TX

NEWLINE = chr(10)

F = S.Field

VOICES = S.Obj({"surface": F(S.Str(1, 120)), "inner": F(S.Str(1, 120))}, name="语态")

# 作息：一天里某个时段她通常在做什么（分钟数，可跨午夜，如 1380→420 是夜里睡觉）
ROUTINE = S.Obj(
    {"from": F(S.Int(0, 1439)), "to": F(S.Int(0, 1439)), "doing": F(S.Str(1, 40))},
    name="作息",
)

PERSONA = S.Obj(
    {
        "id": F(S.Id()),
        "title": F(S.Str(1, 60)),
        "revision": F(S.Str(8, 64)),
        "prose": F(S.Str(0, 200000), required=False, default=""),
        "person": F(S.Enum(*ST.PERSONS), required=False, default="second"),
        "clock_style": F(S.Enum("hm", "shichen"), required=False, default="hm"),
        "name": F(S.Str(1, 40)),
        "call": F(S.Str(1, 40), required=False, default=None),
        "gender": F(S.Nullable(S.Enum(*ST.GENDERS)), required=False, default=None),
        "age": F(S.Nullable(S.Int(0, 120)), required=False, default=None),
        "role": F(S.Str(1, 60), required=False, default=""),
        "adult_context": F(S.Str(0, 120), required=False, default=""),
        "appearance": F(S.Str(1, 120), required=False, default=""),
        "voices": F(S.Nullable(VOICES), required=False, default=None),
        # 开局时她和你的关系阶段。人设里就写明是老相识还是素未谋面，
        # 不该一律从「陌生」熬起 —— 那和散文里写的身份自相矛盾。
        "start_stage": F(S.Enum(*ST.STAGES), required=False, default="stranger"),
        "routine": F(S.List(ROUTINE, max_items=12), required=False, default=[]),
        "mood_base": F(S.Int(0, 100), required=False, default=ST.MOOD_BASE),
        "mood_thresholds": F(
            # Every key is optional at the schema layer so that
            # mood.validate_thresholds() gets to speak: it reports a missing
            # key as INVARIANT_VIOLATION with the actual numbers in the hint,
            # which the model can act on, instead of a bare "missing field".
            S.Obj(
                {
                    "open": F(S.Int(0, 100), required=False),
                    "closed": F(S.Int(0, 100), required=False),
                    "break": F(S.Int(0, 100), required=False),
                }
            ),
            required=False,
            default=dict(ST.MOOD_THRESHOLDS),
        ),
        "rules": F(S.List(S.Str(1, 200)), required=False, default=[]),
        "twists": F(S.List(S.Str(1, 120)), required=False, default=[]),
    },
    name="人设",
)

PLAYER_ID = "player"

# 旧格式（places + cast）里有、新格式里没有的键：转换时丢掉
LEGACY_KEYS = ("places", "cast", "channels")
COMPANION_KEYS = ("name", "call", "gender", "age", "role", "adult_context", "appearance", "voices", "start_stage")


def _slug(text, fallback=None):
    """An ascii id from a human title, or fallback when the title has none.

    A Chinese title yields nothing here, and two personas both called 雨夜诊所
    would otherwise collide on the same id. Rather than inventing a readable
    but silently shared id, the caller falls back to a hash-suffixed one.
    """
    keep = []
    for char in text.strip().lower():
        if char.isascii() and char.isalnum():
            keep.append(char)
        elif char in " -_":
            keep.append("_")
    out = "".join(keep).strip("_")
    while "__" in out:
        out = out.replace("__", "_")
    return out[:36] or fallback


def is_legacy(raw):
    return isinstance(raw, dict) and "cast" in raw


def from_legacy(raw):
    """The old multi-character shape, read as one companion. Returns a new dict.

    She is the first ``tier: major`` member (tier defaults to major), else the
    first member. Her schedule becomes a routine: "在<地点名>". The rest of the
    cast, the places and the channels are dropped.
    """
    cast = [m for m in raw.get("cast") or [] if isinstance(m, dict)]
    member = next((m for m in cast if m.get("tier", "major") == "major"), cast[0] if cast else {})
    names = {p.get("id"): p.get("name") or p.get("id") for p in raw.get("places") or [] if isinstance(p, dict)}
    out = {k: v for k, v in raw.items() if k not in LEGACY_KEYS}
    for key in COMPANION_KEYS:
        if key in member:
            out[key] = member[key]
    if "id" in member:
        out["id"] = member["id"]
    if member.get("name") or raw.get("title"):
        out.setdefault("title", raw.get("title") or member.get("name"))
    routine = []
    for slot in member.get("schedule") or []:
        if isinstance(slot, dict) and {"from", "to"} <= set(slot):
            place = names.get(slot.get("location_id"), slot.get("location_id")) or "原地"
            routine.append({"from": slot["from"], "to": slot["to"], "doing": ("在%s" % place)[:40]})
    if routine:
        out["routine"] = routine
    return out


def validate(raw):
    """Return (persona, errors). Never raises; never fills in content."""
    if is_legacy(raw):
        raw = from_legacy(raw)
    persona, errors = S.validate(PERSONA, raw, "$.persona")
    if persona is None:
        return None, errors
    errors = []
    if persona["id"] == PLAYER_ID:
        errors.append(detail("$.persona.id", "%s 是玩家角色保留 id" % PLAYER_ID, "换一个 id", INVALID_INPUT))
    if persona["age"] is None:
        errors.append(detail("$.persona.age", "缺少年龄", "整数；引擎不会替你填", INVALID_INPUT))
    elif persona["age"] < 18:
        errors.append(detail("$.persona.age", "年龄 %d 小于 18" % persona["age"], "必须年满 18 岁", SAFETY_BLOCK))
    if persona["gender"] is None:
        errors.append(detail("$.persona.gender", "缺少性别", "female / male / nonbinary；代词与称呼靠它", INVALID_INPUT))
    if persona["voices"] is None:
        errors.append(detail("$.persona.voices", "需要表里两层语态", "surface / inner 各一句", INVALID_INPUT))
    errors.extend(MO.validate_thresholds(persona["mood_thresholds"]))
    return (None if errors else persona), errors


def doing_at(holder, minute):
    """What her routine says she is usually doing at this minute of the day, if anything.

    `holder` is anything with a ``routine`` list: the persona or her card.
    """
    for slot in holder.get("routine") or []:
        start, end = slot["from"], slot["to"]
        if start <= end and start <= minute <= end:
            return slot["doing"]
        if start > end and (minute >= start or minute <= end):
            return slot["doing"]
    return None


def companion_card(persona):
    """Her runtime card; the player slot is added by opening.py."""
    return {
        "id": persona["id"],
        "name": persona["name"],
        "call": persona["call"] or persona["name"],
        "age": persona["age"],
        "gender": persona["gender"],
        "adult_context": persona["adult_context"],
        # role 与 adult_context 都是可选的：两个都空就退回名字，
        # 不能因为省略了说明字段就炸在公开身份上。
        "public_role": persona["role"] or (persona["adult_context"] or "")[:20] or persona["name"],
        "appearance": persona["appearance"],
        "voices": persona["voices"],
        "start_stage": persona["start_stage"],
        "routine": [dict(slot) for slot in persona["routine"]],
        "status": {"conditions": []},
        "mood": MO.initial(persona["mood_base"]),
    }


def player_card(name="你", call=None, gender=None, age=28, role=""):
    """A minimal player card: the player is a slot, never engine-invented content."""
    return {
        "id": PLAYER_ID,
        "name": name,
        "call": call or name,
        "age": age,
        "gender": gender,
        "adult_context": "成年玩家角色（%d 岁）%s" % (age, ("，" + role) if role else ""),
        "public_role": role,
        "appearance": "",
        "voices": None,
        "routine": [],
        "status": {"conditions": []},
        "mood": None,
    }


def render_cards(persona, cards):
    """Resolve {npc.name}-style placeholders inside persona-provided text.

    The persona is written by a human, so it may address her or the player by
    placeholder; after this pass every card holds literal text and no other
    module ever has to render anything.
    """
    scopes = {cid: TX.binding(card) for cid, card in cards.items()}
    for cid, card in cards.items():
        own = dict(scopes)
        own["npc"] = scopes[cid]
        own["player"] = scopes.get(PLAYER_ID, scopes[cid])
        for key in ("appearance", "adult_context", "public_role"):
            if isinstance(card.get(key), str):
                card[key] = TX.render(card[key], own)
        if card.get("voices"):
            card["voices"] = {k: TX.render(v, own) for k, v in card["voices"].items()}
    return cards


STATIC_CARD_FIELDS = (
    "name",
    "call",
    "age",
    "gender",
    "adult_context",
    "public_role",
    "appearance",
    "voices",
    "routine",
)


def apply_static(state, persona):
    """Copy the persona's *static* facts onto a running state, in place.

    A session stores the persona it opened with, so editing `persona.md` after
    the story started used to change nothing until a new session was begun — the
    settings page would show one thing and the prompt another. What a persona
    says about *who she is* (name, how she is called, age, role, looks, voices,
    routine) and the mood baseline is static, so a read may refresh it.

    She is matched as "the one character who is not the player", not by id, so
    renaming the persona id does not cut her off from her own story.

    Deliberately not touched: ``start_stage`` once anything has happened, and
    the clock, the relationship, thoughts and facts - those are the story.

    Returns a small report; never raises.
    """
    card = companion_card(persona)
    cid = SS.companion(state)
    restaged = []
    if cid is not None:
        char = state["characters"][cid]
        for key in STATIC_CARD_FIELDS:
            char[key] = card[key]
        if isinstance(char.get("mood"), dict):
            # base is the baseline; thoughts are the live part and stay put.
            char["mood"]["base"] = persona["mood_base"]
        # start_stage describes the *opening* of the relationship, so once
        # anything has happened it must not be replayed over the live stage. A
        # pair that is still untouched has no story to lose, though - and the
        # player who wrote "亲密" in the file expects to see it.
        if _restage(state, cid, persona):
            restaged.append(cid)
        # Placeholders like {npc.name} were rendered once at opening against the
        # old names, so a rename would otherwise leave stale text in the card.
        render_cards(persona, state["characters"])
    state["mood_base"] = persona["mood_base"]
    state["mood_thresholds"] = dict(persona["mood_thresholds"])
    state["persona_id"] = persona["id"]
    state["persona_title"] = persona["title"]
    state["persona_revision"] = persona["revision"]
    return {
        "revision": persona["revision"],
        "updated": [cid] if cid else [],
        "restaged": restaged,
    }


def _restage(state, cid, persona):
    """Put the persona's start_stage on a pair nothing has happened to yet.

    "Nothing happened" is the engine's own bookkeeping: zero trust, zero tension
    and an empty history on both directions. The moment any of those moved, the
    live stage is the truth and the file has no say over it any more.
    """
    if not persona.get("start_stage"):
        return False
    player = state["player_id"]
    edges = [
        (state.get("relationships") or {}).get("%s>%s" % (player, cid)),
        (state.get("relationships") or {}).get("%s>%s" % (cid, player)),
    ]
    live = [edge for edge in edges if edge is not None]
    if not live:
        return False
    for edge in live:
        if (edge.get("trust") or 0) != 0 or (edge.get("tension") or 0) != 0 or (edge.get("history") or []):
            return False
    for edge in live:
        edge["stage"] = persona["start_stage"]
    return True


def problems_text(errors, limit=6):
    """Compact one-line summary for the settings page and the CLI."""
    rows = ["%s：%s" % (item["path"], item["reason"]) for item in errors[:limit]]
    if len(errors) > limit:
        rows.append("…还有 %d 条" % (len(errors) - limit))
    return "；".join(rows)


def from_markdown(front, prose, title=None, persona_id=None):
    """Assemble a persona dict from a parsed front-matter block + prose.

    `front` is the raw mapping decoded by the Node side; every content field is
    optional here because :func:`validate` is what decides whether a persona is
    usable. This function only fills engine-level defaults (id / title /
    revision) - never content.
    """
    body = prose or ""
    raw = dict(front or {})
    if is_legacy(raw):
        raw = from_legacy(raw)
    raw.setdefault("title", title or raw.get("name") or "未命名人设")
    if "id" not in raw:
        slug = _slug(persona_id or raw["title"])
        if slug is None:
            # No ascii in the title: hash it so different titles stay apart,
            # and leave the readable name in `title` where a human sees it.
            slug = "persona_" + hashlib.sha256(raw["title"].encode("utf-8")).hexdigest()[:8]
        raw["id"] = slug
    raw["revision"] = hashlib.sha256(
        (body + NEWLINE + repr(sorted(raw.items()))).encode("utf-8")
    ).hexdigest()
    raw["prose"] = body
    return raw
