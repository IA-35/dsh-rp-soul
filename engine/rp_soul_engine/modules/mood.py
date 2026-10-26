"""Mood lifecycle and projections; no persistence or host I/O."""

from ..domain import mood as MO, state as SS


def settle(state, report, turn, player_absent):
    report["expired_thoughts"] = MO.settle(state, turn)
    if report["minutes"] > 0 or player_absent:
        MO.refresh_situational(state, turn, gap=report["minutes"], player_absent=player_absent)
        report["steps"].append("mood")


def project(state, persona, cue, full):
    cid = SS.companion(state)
    brief = MO.brief(state, cid)
    mood = {"value": brief["value"], "band": brief["band"]}
    if brief.get("top"):
        mood["weighing"] = [{"label": row["label"], "delta": row["delta"]} for row in brief["top"]]
    return {"companion": {"mood": mood},
            "card": {"mood": MO.panel(state, cid)} if full else {},
            "persona": {"mood_base": persona["mood_base"], "mood_thresholds": dict(persona["mood_thresholds"])}}


def validate_turn(state, ctx):
    """Break band: a reply or a personal expression, including a minor one.

    The band is the one the turn started in, so a commit cannot dodge it by
    adding a cheerful thought first. A rewrite turn only restates the past.
    """
    if ctx.mode == "rewrite" or not ctx.together:
        return
    player = ctx.state["player_id"]
    if player not in ctx.start_present:
        return
    for cid in sorted(ctx.start_present - {player}):
        if ctx.start_bands.get(cid) == "break" and cid not in ctx.responses and cid not in ctx.mood_reactions:
            ctx.error(
                "$.operations",
                "%s 这回合在崩溃档，要有回应或符合人设的情绪表达" % ctx.name(cid),
                "可以简短回应，也可用 silence、seek_comfort、change_topic、withdraw 等行动；不要求重大行动",
            )
