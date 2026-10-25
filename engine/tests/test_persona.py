"""Persona validation: the engine must be loud, never inventive."""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rp_soul_engine import persona as PE
from tests.fixture import PERSONA
from tests.harness import check, run


def mutated(**kw):
    out = copy.deepcopy(PERSONA)
    out.update(kw)
    return out


def cast(**kw):
    item = copy.deepcopy(PERSONA["cast"][0])
    item.update(kw)
    return [item]


def rejects(raw, needle, code):
    got, errors = PE.validate(raw)
    assert got is None, "should have been rejected: %s" % PE.problems_text(errors)
    reasons = [item["reason"] for item in errors]
    codes = [item["code"] for item in errors]
    assert any(needle in reason for reason in reasons), reasons
    assert code in codes, codes


def accepts():
    got, errors = PE.validate(PERSONA)
    assert got is not None, PE.problems_text(errors)
    assert got["mood_thresholds"] == {"open": 72, "closed": 40, "break": 18}
    assert got["mood_base"] == 55


def defaults_are_filled():
    raw = copy.deepcopy(PERSONA)
    del raw["mood_thresholds"]
    del raw["mood_base"]
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    assert got["mood_thresholds"] == {"open": 75, "closed": 45, "break": 25}
    assert got["mood_base"] == 50


def character_cards():
    got, _ = PE.validate(PERSONA)
    cards = PE.characters(got)
    assert set(cards) == {"lin_wan", "zhou_yi"}
    lin = cards["lin_wan"]
    assert lin["call"] == "林医生"
    assert lin["public_role"] == "夜班医生"
    assert lin["mood"] == {"base": 55, "thoughts": []}
    assert lin["status"] == {"location_id": None, "conditions": []}


def placeholders_are_rendered():
    raw = copy.deepcopy(PERSONA)
    raw["cast"][0]["appearance"] = "白大褂上别着{npc.name}自己的牌子"
    raw["cast"][0]["voices"] = {"surface": "喊自己{player.name}", "inner": "总在算时间"}
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    cards = PE.characters(got)
    cards[PE.PLAYER_ID] = PE.player_card(name="陈默", gender="male", age=30, role="送药的人")
    PE.render_cards(got, cards)
    assert cards["lin_wan"]["appearance"] == "白大褂上别着林晚自己的牌子", cards["lin_wan"]["appearance"]
    assert cards["lin_wan"]["voices"]["surface"] == "喊自己陈默", cards["lin_wan"]["voices"]


def no_typed_in_goal_fields():
    # 动机由引擎测算，人设里不再接受 decision / goal / situation。
    for key in ("decision", "goal", "situation"):
        raw = copy.deepcopy(PERSONA)
        raw["cast"][0][key] = {"kind": "observe", "text": "随手填的"}
        got, errors = PE.validate(raw)
        assert got is None, "引擎不该再接受 %s" % key
        assert "未知字段" in PE.problems_text(errors), PE.problems_text(errors)


def player_card_shape():
    card = PE.player_card(name="陈默", gender="male", age=30)
    assert card["id"] == "player"
    assert card["mood"] is None, "the player's mood is never stored"
    assert card["age"] == 30


def from_markdown_ids():
    first = PE.from_markdown({"title": "雨夜诊所"}, "林晚是夜班医生。")
    again = PE.from_markdown({"title": "雨夜诊所"}, "林晚是夜班医生。")
    other = PE.from_markdown({"title": "另一个世界"}, "完全不同的人。")
    ascii_title = PE.from_markdown({"title": "Rain Clinic"}, "Lin Wan works nights.")
    assert first["id"] == again["id"], "the same title must give the same id"
    assert first["id"] != other["id"], "different titles must not collide"
    assert ascii_title["id"] == "rain_clinic"
    assert first["revision"] != other["revision"]
    assert len(first["revision"]) == 64
    assert first["prose"] == "林晚是夜班医生。"


def revision_changes_with_prose():
    one = PE.from_markdown({"title": "x"}, "a")
    two = PE.from_markdown({"title": "x"}, "b")
    assert one["revision"] != two["revision"]


def accepts_without_adult_context():
    got, errors = PE.validate(mutated(cast=cast(adult_context="")))
    assert got is not None, PE.problems_text(errors)
    cards = PE.characters(got)
    assert cards["lin_wan"]["public_role"] == "夜班医生", cards["lin_wan"]["public_role"]


def public_role_falls_back_to_name():
    # role 与 adult_context 都省略：公开身份退回名字，不能因为缺说明字段就炸。
    item = copy.deepcopy(PERSONA["cast"][0])
    item.pop("role", None)
    item["adult_context"] = ""
    got, errors = PE.validate(mutated(cast=[item]))
    assert got is not None, PE.problems_text(errors)
    cards = PE.characters(got)
    assert cards["lin_wan"]["public_role"] == "林晚", cards["lin_wan"]["public_role"]


check("accepts a good persona", accepts)
check("fills engine defaults, not content", defaults_are_filled)
check("builds character cards", character_cards)
check("renders placeholders in persona text", placeholders_are_rendered)
check("人设不再接受手填的 decision/goal/situation", no_typed_in_goal_fields)
check("player card has no mood", player_card_shape)
check("from_markdown ids are stable and distinct", from_markdown_ids)
check("revision tracks the prose", revision_changes_with_prose)
check("underage is a SAFETY_BLOCK", lambda: rejects(mutated(cast=cast(age=17, id="kid")), "小于 18", "SAFETY_BLOCK"))
check("thresholds must be ordered", lambda: rejects(mutated(mood_thresholds={"open": 30, "closed": 60, "break": 20}), "break < closed < open", "INVARIANT_VIOLATION"))
check("thresholds must be complete", lambda: rejects(mutated(mood_thresholds={"open": 75, "closed": 45}), "缺少 break", "INVARIANT_VIOLATION"))
check("mood_base must be in range", lambda: rejects(mutated(mood_base=140), "超出范围", "INVALID_INPUT"))
check("major needs both voices", lambda: rejects(mutated(cast=[dict(copy.deepcopy(PERSONA["cast"][1]), tier="major")]), "表里两层语态", "INVALID_INPUT"))
check("schedule must point at a place", lambda: rejects(mutated(cast=cast(schedule=[{"from": 0, "to": 10, "location_id": "nowhere"}])), "地点不存在", "INVALID_INPUT"))
check("cast ids must be unique", lambda: rejects(mutated(cast=[copy.deepcopy(PERSONA["cast"][0]), dict(copy.deepcopy(PERSONA["cast"][1]), id="lin_wan")]), "角色 id 重复", "INVALID_INPUT"))
check("player id is reserved", lambda: rejects(mutated(cast=cast(id="player")), "保留 id", "INVALID_INPUT"))
check("at least one major", lambda: rejects(mutated(cast=[copy.deepcopy(PERSONA["cast"][1])]), "至少要有一个 major", "INVALID_INPUT"))
check("adult_context is optional", accepts_without_adult_context)
check("public_role falls back to name", public_role_falls_back_to_name)


def start_stage_defaults_to_stranger():
    got, errors = PE.validate(PERSONA)
    assert got is not None, PE.problems_text(errors)
    assert got["cast"][0]["start_stage"] == "stranger"


def start_stage_is_carried_into_the_card():
    got, errors = PE.validate(mutated(cast=cast(start_stage="familiar")))
    assert got is not None, PE.problems_text(errors)
    assert PE.characters(got)["lin_wan"]["start_stage"] == "familiar"


check("start_stage defaults to stranger", start_stage_defaults_to_stranger)
check("start_stage is carried into the card", start_stage_is_carried_into_the_card)
check("start_stage must be a known stage", lambda: rejects(mutated(cast=cast(start_stage="soulmate")), "不在允许范围内", "INVALID_INPUT"))
check("age is required", lambda: rejects(mutated(cast=cast(age=None)), "缺少年龄", "INVALID_INPUT"))
check("gender is required", lambda: rejects(mutated(cast=cast(gender=None)), "缺少性别", "INVALID_INPUT"))
check("place ids must be unique", lambda: rejects(mutated(places=[{"id": "clinic", "name": "诊所"}, {"id": "clinic", "name": "走廊"}], cast=cast(schedule=[])), "地点 id 重复", "INVALID_INPUT"))
check("unknown fields are rejected", lambda: rejects(mutated(bogus=1), "未知字段", "INVALID_INPUT"))
check("places cannot be empty", lambda: rejects(mutated(places=[]), "至少需要 1 项", "INVALID_INPUT"))
check("channels must point at places", lambda: rejects(mutated(channels=[{"id": "c1", "from": "clinic", "to": "nowhere"}]), "地点不存在", "INVALID_INPUT"))
check("ids must be ascii slugs", lambda: rejects(mutated(places=[{"id": "Clinic Room", "name": "诊所"}], cast=cast(schedule=[])), "格式不合法", "INVALID_INPUT"))

run("persona")
