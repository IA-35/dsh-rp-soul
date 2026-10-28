"""Fixed module boundaries preserve the normal roleplay flow."""

import copy
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fixture import PERSONA
from harness import check, run
from rp_soul_engine import opening, persona, schema, modules
from rp_soul_engine.domain import turn, memories
from rp_soul_engine.errors import AppError
from rp_soul_engine.projections import context

T0 = "2026-10-26T12:00:00+08:00"


def fresh():
    pack, errors = persona.validate(copy.deepcopy(PERSONA))
    assert not errors, errors
    state, _ = opening.new_session(pack, seed=7, now=T0)
    return state, pack


def commit_body(**changes):
    raw = {"action_mode": "continue", "player_input": "", "operations": [{"op": "npc_action", "action": "她整理书桌。"}],
           "content_tags": [], "summary": "她整理了书桌。", "open_action": "她放下书。"}
    raw.update(changes)
    normalized, errors = schema.validate(schema.Obj(turn.commit_fields()), raw)
    assert not errors, errors
    return normalized


def projections_are_composed_without_mutating_the_ledger():
    state, pack = fresh()
    before = copy.deepcopy(state)
    assert tuple(modules.REGISTRY) == ("mood", "memory", "agency", "wake")
    fields = modules.project(state, pack, full=True)
    assert fields["companion"]["mood"]["value"] == 55
    assert fields["context"]["memories"] == [] and fields["context"]["agency"]
    assert fields["card"]["mood"]["base"] == 55
    assert state == before


def lifecycle_keeps_memory_and_core_audit_together():
    state, pack = fresh()
    after, result = turn.commit_turn(state, pack, commit_body(remember="他坐在旁边，我安心了一点。"), now=T0)
    turn.close_record(after, [result])
    assert state["turn"] == 0 and state["memory"]["entries"] == []
    assert after["turn"] == 1 and len(after["memory"]["turns"]) == 1
    assert any(e["content"] == "他坐在旁边，我安心了一点。" for e in after["memory"]["entries"])
    assert context.full(after, pack)["companion"]["mood"]["band"] == "normal"


def an_implementation_can_be_replaced_at_one_registration():
    state, pack = fresh()
    replacement = SimpleNamespace(project=lambda *_: {"context": {"agency": [{"example": "replacement"}]}})
    with patch.dict(modules.REGISTRY, {"agency": replacement}):
        view = context.brief(state, pack)
        assert view["agency"] == [{"example": "replacement"}]
        assert "mood" in view["companion"] and "memories" in view
    assert "options" in context.brief(state, pack)["agency"][0]


def memory_validation_stays_inside_the_atomic_turn():
    state, pack = fresh()
    entry = memories.add(state, "scm", "conversation", "你留下了一把伞。", 0.8)
    state["requests"]["memory_fold"] = {"ids": [entry["id"]]}
    before = copy.deepcopy(state)
    try:
        turn.commit_turn(state, pack, commit_body(), now=T0)
    except AppError as err:
        assert "SCM" in str(err), str(err)
    else:
        raise AssertionError("pending fold must be validated")
    assert state == before


check("module projections compose without writes", projections_are_composed_without_mutating_the_ledger)
check("memory lifecycle shares the core transaction", lifecycle_keeps_memory_and_core_audit_together)
check("one registration replaces one implementation", an_implementation_can_be_replaced_at_one_registration)
check("module validation preserves atomic turns", memory_validation_stays_inside_the_atomic_turn)
run("modules")
