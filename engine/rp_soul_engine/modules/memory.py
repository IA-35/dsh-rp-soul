"""Life-memory lifecycle; the core retains its own turn audit regardless."""

from ..domain import memories as MEM
from ..errors import INVALID_INPUT


def pay_requests(state, commit, turn):
    summarized = archived = None
    if commit["memory_summary"]:
        summarized = MEM.apply_summary(state, state["requests"].get("memory_summary"), commit["memory_summary"], turn)
        state["requests"]["memory_summary"] = None
    if commit["memory_archive"]:
        archived = MEM.apply_archive(state, state["requests"].get("memory_archive"), commit["memory_archive"], turn)
        state["requests"]["memory_archive"] = None
    return {"summarized": summarized, "archived": archived}


def after_turn(state, ctx, commit, base):
    _rounds, recalled = MEM.select(base, commit["player_input"], MEM.TOTAL_BRIEF)
    MEM.reinforce(state, [e["id"] for e in recalled if MEM.cued_by_words(e, commit["player_input"])])
    remembered = MEM.capture(state, ctx, commit)
    return {"remembered": [e["id"] for e in remembered], "forgetting": MEM.maintain(state)}


def close_record(state):
    state["requests"]["memory_summary"] = MEM.summary_request(state)
    state["requests"]["memory_archive"] = MEM.archive_request(state)


def project(state, persona, cue, full):
    fields = {"memories": MEM.inject(state, cue, MEM.TOTAL_FULL if full else MEM.TOTAL_BRIEF)}
    for key in ("memory_summary", "memory_archive"):
        view = MEM.request_view(state, state["requests"].get(key), compact=not full)
        if view is not None:
            fields[key + "_sources"] = view
    return {"context": fields}


def before_turn(state, ctx):
    commit = ctx.commit
    requests = ctx.state["requests"]
    if requests.get("memory_summary"):
        if not commit["memory_summary"]:
            ctx.error(
                "$.memory_summary",
                "新的一天了，引擎要求这次记录的第一个回合把那一天记成一条「那些事」",
                "读上下文的 memory_summary_sources，用第一人称写成 ≤80 字放进 memory_summary",
            )
    elif commit["memory_summary"]:
        ctx.error("$.memory_summary", "引擎没有要求每日总结", "去掉 memory_summary；跨天后引擎会在记录结束时要求", INVALID_INPUT)
    if requests.get("memory_archive"):
        if not commit["memory_archive"]:
            ctx.error(
                "$.memory_archive",
                "又过了半个月，引擎要求把这些日子归成一段「那些年」",
                "读上下文的 memory_archive_sources，合并成 ≤60 字放进 memory_archive",
            )
    elif commit["memory_archive"]:
        ctx.error("$.memory_archive", "引擎没有要求归档", "去掉 memory_archive", INVALID_INPUT)
