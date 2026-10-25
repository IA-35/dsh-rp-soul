"""The persona pack: what rp-soul owns, and the only thing the engine reads.

The old engine read a *world pack* (locations, cast templates, name pools,
rules, tension engines, pressure items, twists). All of that is content, and
all of it is gone. What replaces it is one structure the Node side builds from
the player's markdown files (``lib/persona-pack.js``) and hands to the engine:

    {
      "id": "lin_wan",            # ascii slug, stable
      "title": "雨夜诊所",         # shown in the save list
      "revision": "8f3ac1...",    # sha256 of the composed prose + front matter
      "prose": "...",             # the composed text; the engine never parses it
      "person": "second",         # narrative person
      "clock_style": "hm",
      "mood_base": 50,
      "mood_thresholds": {"open": 75, "closed": 45, "break": 25},
      "places": [{"id","name","detail","privacy","visibility":[],"affordances":[]}],
      "cast":   [{"id","name","call","gender","age","tier","role","adult_context",
                  "appearance","voices":{},"schedule":[]}],
      "rules":  ["..."],          # optional narration rules, plain text
      "channels": [...],          # optional: message routes between places
      "twists": [...]             # optional: engine may offer these later
    }

Design rule: **the engine validates a persona and never invents content.** If
a field is missing it is an error with a path and a hint, never a silent
default - a persona that quietly loses its cast would produce a story with
strangers in it.
"""

import hashlib

from . import schema as S
from .errors import INVALID_INPUT, SAFETY_BLOCK, detail
from .domain import mood as MO
from .domain import structure as ST
from .domain import text as TX

NEWLINE = chr(10)

F = S.Field

PLACE = S.Obj(
    {
        "id": F(S.Id()),
        "name": F(S.Str(1, 40)),
        "detail": F(S.Str(1, 200), required=False, default=""),
        "privacy": F(S.Enum(*ST.PRIVACY), required=False, default="semi"),
        "visibility": F(S.List(S.Str(1, 40)), required=False, default=[]),
        "affordances": F(S.List(S.Str(1, 40)), required=False, default=[]),
    },
    name="地点",
)

VOICES = S.Obj({"surface": F(S.Str(1, 120)), "inner": F(S.Str(1, 120))}, name="语态")

SCHEDULE = S.Obj(
    {"from": F(S.Int(0, 1439)), "to": F(S.Int(0, 1439)), "location_id": F(S.Id())},
    name="时段",
)

CAST = S.Obj(
    {
        "id": F(S.Id()),
        "name": F(S.Str(1, 40)),
        "call": F(S.Str(1, 40), required=False, default=None),
        "gender": F(S.Nullable(S.Enum(*ST.GENDERS)), required=False, default=None),
        "age": F(S.Nullable(S.Int(0, 120)), required=False, default=None),
        "tier": F(S.Enum(*ST.TIERS), required=False, default="major"),
        "role": F(S.Str(1, 60), required=False, default=""),
        "adult_context": F(S.Str(0, 120), required=False, default=""),
        "appearance": F(S.Str(1, 120), required=False, default=""),
        "voices": F(S.Nullable(VOICES), required=False, default=None),
        # 开局时她和玩家的关系阶段。人设里就写明是主仆、老相识还是素未谋面，
        # 不该让人人一律从「陌生」熬起 —— 那和散文里写的身份自相矛盾。
        "start_stage": F(S.Enum(*ST.STAGES), required=False, default="stranger"),
        "schedule": F(S.List(SCHEDULE, max_items=6), required=False, default=[]),
    },
    name="角色",
)

PERSONA = S.Obj(
    {
        "id": F(S.Id()),
        "title": F(S.Str(1, 60)),
        "revision": F(S.Str(8, 64)),
        "prose": F(S.Str(0, 200000), required=False, default=""),
        "person": F(S.Enum(*ST.PERSONS), required=False, default="second"),
        "clock_style": F(S.Enum("hm", "shichen"), required=False, default="hm"),
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
        "places": F(S.List(PLACE, min_items=1, max_items=40)),
        "cast": F(S.List(CAST, min_items=1, max_items=20)),
        "rules": F(S.List(S.Str(1, 200)), required=False, default=[]),
        "channels": F(
            S.List(S.Obj({"id": F(S.Id()), "from": F(S.Id()), "to": F(S.Id())})),
            required=False,
            default=[],
        ),
        "twists": F(S.List(S.Str(1, 120)), required=False, default=[]),
    },
    name="人设包",
)

PLAYER_ID = "player"


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


def validate(raw):
    """Return (persona, errors). Never raises; never fills in content."""
    persona, errors = S.validate(PERSONA, raw, "$.persona")
    if persona is None:
        return None, errors
    errors = []
    places = {}
    for index, item in enumerate(persona["places"]):
        if item["id"] in places:
            errors.append(detail("$.persona.places[%d].id" % index, "地点 id 重复：%s" % item["id"], None, INVALID_INPUT))
        places[item["id"]] = item
    seen = set()
    majors = 0
    for index, member in enumerate(persona["cast"]):
        base = "$.persona.cast[%d]" % index
        cid = member["id"]
        if cid == PLAYER_ID:
            errors.append(detail(base + ".id", "%s 是玩家角色保留 id" % PLAYER_ID, "换一个 id", INVALID_INPUT))
        if cid in seen:
            errors.append(detail(base + ".id", "角色 id 重复：%s" % cid, None, INVALID_INPUT))
        seen.add(cid)
        if member["age"] is None:
            errors.append(detail(base + ".age", "缺少年龄", "整数；引擎不会替你填", INVALID_INPUT))
        elif member["age"] < 18:
            errors.append(detail(base + ".age", "年龄 %d 小于 18" % member["age"], "所有角色都必须年满 18 岁", SAFETY_BLOCK))
        if member["gender"] is None:
            errors.append(detail(base + ".gender", "缺少性别", "female / male / nonbinary；代词与称呼靠它", INVALID_INPUT))
        # adult_context 只是「一句话交代成年身份」的补充说明，可为空：
        # 年龄已经在上面强制校验过，不靠这段文字把关。
        if member["tier"] == "major":
            majors += 1
            if member["voices"] is None:
                errors.append(detail(base + ".voices", "major 角色需要表里两层语态", "surface / inner 各一句；只有重要角色有", INVALID_INPUT))
        for slot_index, slot in enumerate(member["schedule"]):
            if slot["location_id"] not in places:
                errors.append(
                    detail(
                        "%s.schedule[%d].location_id" % (base, slot_index),
                        "地点不存在：%s" % slot["location_id"],
                        "可用地点：%s" % "、".join(sorted(places)),
                        INVALID_INPUT,
                    )
                )
    if not majors:
        errors.append(detail("$.persona.cast", "至少要有一个 major 角色", "tier 省略时默认就是 major", INVALID_INPUT))
    errors.extend(MO.validate_thresholds(persona["mood_thresholds"]))
    for slot_index, channel in enumerate(persona["channels"]):
        for key in ("from", "to"):
            if channel[key] not in places:
                errors.append(detail("$.persona.channels[%d].%s" % (slot_index, key), "地点不存在：%s" % channel[key], None, INVALID_INPUT))
    return (None if errors else persona), errors


def place(persona, lid):
    for item in persona.get("places") or []:
        if item["id"] == lid:
            return item
    return None


def place_name(persona, lid):
    found = place(persona, lid)
    return found["name"] if found else lid


def characters(persona):
    """Runtime character dicts keyed by id; the player slot is added by opening.py."""
    out = {}
    for member in persona["cast"]:
        cid = member["id"]
        out[cid] = {
            "id": cid,
            "name": member["name"],
            "call": member["call"] or member["name"],
            "tier": member["tier"],
            "age": member["age"],
            "gender": member["gender"],
            "adult_context": member["adult_context"],
            # role 与 adult_context 都是可选的：两个都空就退回名字，
            # 不能因为省略了说明字段就炸在公开身份上。
            "public_role": member["role"] or (member["adult_context"] or "")[:20] or member["name"],
            "appearance": member["appearance"],
            "voices": member["voices"],
            "start_stage": member["start_stage"],
            "schedule": list(member["schedule"]),
            "status": {"location_id": None, "conditions": []},
            "mood": MO.initial(persona["mood_base"]),
        }
    return out


def player_card(name="你", call=None, gender=None, age=28, role=""):
    """A minimal player card: the player is a slot, never engine-invented content."""
    return {
        "id": PLAYER_ID,
        "name": name,
        "call": call or name,
        "tier": "major",
        "age": age,
        "gender": gender,
        "adult_context": "成年玩家角色（%d 岁）%s" % (age, ("，" + role) if role else ""),
        "public_role": role,
        "appearance": "",
        "voices": None,
        "schedule": [],
        "status": {"location_id": None, "conditions": []},
        "mood": None,
    }


def render_cards(persona, cards):
    """Resolve {npc.name}-style placeholders inside persona-provided text.

    The persona is written by a human, so it may address a character by
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
    raw.setdefault("title", title or "未命名人设")
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
