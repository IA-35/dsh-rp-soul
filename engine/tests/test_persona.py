"""Persona validation: the engine must be loud, never inventive."""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rp_soul_engine import persona as PE
from tests.fixture import LEGACY_PERSONA, PERSONA
from tests.harness import check, run


def mutated(**kw):
    out = copy.deepcopy(PERSONA)
    out.update(kw)
    return out


def without(*keys):
    out = copy.deepcopy(PERSONA)
    for key in keys:
        out.pop(key, None)
    return out


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
    raw = without("mood_thresholds", "mood_base")
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    assert got["mood_thresholds"] == {"open": 75, "closed": 45, "break": 25}
    assert got["mood_base"] == 50


def companion_card():
    got, _ = PE.validate(PERSONA)
    card = PE.companion_card(got)
    assert card["id"] == "lin_wan"
    assert card["call"] == "林医生"
    assert card["public_role"] == "夜班医生"
    assert card["mood"] == {"base": 55, "thoughts": []}
    assert card["status"] == {"conditions": []}
    assert card["routine"] == [{"from": 0, "to": 1439, "doing": "在诊所值夜班"}]


def placeholders_are_rendered():
    raw = mutated(appearance="白大褂上别着{npc.name}自己的牌子", voices={"surface": "喊自己{player.name}", "inner": "总在算时间"})
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    cards = {"lin_wan": PE.companion_card(got), PE.PLAYER_ID: PE.player_card(name="陈默", gender="male", age=30, role="送药的人")}
    PE.render_cards(got, cards)
    assert cards["lin_wan"]["appearance"] == "白大褂上别着林晚自己的牌子", cards["lin_wan"]["appearance"]
    assert cards["lin_wan"]["voices"]["surface"] == "喊自己陈默", cards["lin_wan"]["voices"]


def no_typed_in_goal_fields():
    # 动机由引擎测算，人设里不再接受 decision / goal / situation。
    for key in ("decision", "goal", "situation"):
        got, errors = PE.validate(mutated(**{key: {"kind": "observe", "text": "随手填的"}}))
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


def title_defaults_to_her_name():
    raw = PE.from_markdown({"id": "lin_wan", "name": "林晚"}, "")
    assert raw["title"] == "林晚", raw["title"]


def revision_changes_with_prose():
    one = PE.from_markdown({"title": "x"}, "a")
    two = PE.from_markdown({"title": "x"}, "b")
    assert one["revision"] != two["revision"]


def accepts_without_adult_context():
    got, errors = PE.validate(mutated(adult_context=""))
    assert got is not None, PE.problems_text(errors)
    assert PE.companion_card(got)["public_role"] == "夜班医生"


def public_role_falls_back_to_name():
    # role 与 adult_context 都省略：公开身份退回名字，不能因为缺说明字段就炸。
    raw = without("role")
    raw["adult_context"] = ""
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    assert PE.companion_card(got)["public_role"] == "林晚"


def routine_across_midnight():
    holder = {"routine": [{"from": 1380, "to": 420, "doing": "睡觉"}, {"from": 540, "to": 1080, "doing": "上班"}]}
    assert PE.doing_at(holder, 1400) == "睡觉"
    assert PE.doing_at(holder, 60) == "睡觉"
    assert PE.doing_at(holder, 600) == "上班"
    assert PE.doing_at(holder, 500) is None


def legacy_cast_becomes_her():
    """The old places + cast shape: the first major member is her, her schedule a routine."""
    got, errors = PE.validate(copy.deepcopy(LEGACY_PERSONA))
    assert got is not None, PE.problems_text(errors)
    assert got["id"] == "lin_wan", got["id"]
    assert got["name"] == "林晚"
    assert got["start_stage"] == "familiar"
    assert got["routine"] == [
        {"from": 1200, "to": 360, "doing": "在诊所"},
        {"from": 361, "to": 1199, "doing": "在走廊"},
    ], got["routine"]
    assert "cast" not in got and "places" not in got


def legacy_through_from_markdown():
    front = {k: v for k, v in LEGACY_PERSONA.items() if k not in ("revision", "prose")}
    raw = PE.from_markdown(front, "林晚是夜班医生。")
    got, errors = PE.validate(raw)
    assert got is not None, PE.problems_text(errors)
    assert got["id"] == "lin_wan" and got["title"] == "雨夜诊所"


def start_stage_defaults_to_stranger():
    got, errors = PE.validate(PERSONA)
    assert got is not None, PE.problems_text(errors)
    assert got["start_stage"] == "stranger"


def start_stage_is_carried_into_the_card():
    got, errors = PE.validate(mutated(start_stage="familiar"))
    assert got is not None, PE.problems_text(errors)
    assert PE.companion_card(got)["start_stage"] == "familiar"


check("accepts a good persona", accepts)
check("fills engine defaults, not content", defaults_are_filled)
check("builds her card", companion_card)
check("renders placeholders in persona text", placeholders_are_rendered)
check("人设不再接受手填的 decision/goal/situation", no_typed_in_goal_fields)
check("player card has no mood", player_card_shape)
check("from_markdown ids are stable and distinct", from_markdown_ids)
check("title defaults to her name", title_defaults_to_her_name)
check("revision tracks the prose", revision_changes_with_prose)
check("routine wraps across midnight", routine_across_midnight)
check("the old cast shape is read as her", legacy_cast_becomes_her)
check("the old cast shape passes through from_markdown", legacy_through_from_markdown)
check("underage is a SAFETY_BLOCK", lambda: rejects(mutated(age=17), "小于 18", "SAFETY_BLOCK"))
check("thresholds must be ordered", lambda: rejects(mutated(mood_thresholds={"open": 30, "closed": 60, "break": 20}), "break < closed < open", "INVARIANT_VIOLATION"))
check("thresholds must be complete", lambda: rejects(mutated(mood_thresholds={"open": 75, "closed": 45}), "缺少 break", "INVARIANT_VIOLATION"))
check("mood_base must be in range", lambda: rejects(mutated(mood_base=140), "超出范围", "INVALID_INPUT"))
check("both voices are required", lambda: rejects(without("voices"), "表里两层语态", "INVALID_INPUT"))
check("player id is reserved", lambda: rejects(mutated(id="player"), "保留 id", "INVALID_INPUT"))
check("adult_context is optional", accepts_without_adult_context)
check("public_role falls back to name", public_role_falls_back_to_name)
check("start_stage defaults to stranger", start_stage_defaults_to_stranger)
check("start_stage is carried into the card", start_stage_is_carried_into_the_card)
check("start_stage must be a known stage", lambda: rejects(mutated(start_stage="soulmate"), "不在允许范围内", "INVALID_INPUT"))
check("age is required", lambda: rejects(without("age"), "缺少年龄", "INVALID_INPUT"))
check("gender is required", lambda: rejects(without("gender"), "缺少性别", "INVALID_INPUT"))
check("name is required", lambda: rejects(without("name"), "缺少", "INVALID_INPUT"))
check("unknown fields are rejected", lambda: rejects(mutated(bogus=1), "未知字段", "INVALID_INPUT"))
check("routine slots need a doing", lambda: rejects(mutated(routine=[{"from": 0, "to": 10}]), "缺少", "INVALID_INPUT"))
check("ids must be ascii slugs", lambda: rejects(mutated(id="Lin Wan"), "格式不合法", "INVALID_INPUT"))

run("persona")
