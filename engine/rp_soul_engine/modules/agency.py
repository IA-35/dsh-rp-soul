"""Optional action suggestions. Basic NPC actions belong to the core."""

from ..domain import agency as AG


def project(state, persona, cue, full):
    return {"context": {"agency": AG.brief(state, persona, state["turn"] + 1, at=state["clock"])}}
