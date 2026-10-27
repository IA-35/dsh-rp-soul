"""Life-memory lifecycle; the core retains its own turn audit regardless."""

from ..domain import memories as MEM
from ..errors import INVALID_INPUT


def pay_requests(state, commit, turn):
    summarized = None
    journaled = None
    if commit["memory_summary"]:
        summarized = MEM.apply_summary(state, state["requests"].get("memory_summary"), commit["memory_summary"],
                                       turn, keep=commit["memory_keep"])
        state["requests"]["memory_summary"] = None
    if commit["memory_journal"]:
        done = MEM.apply_archive(state, state["requests"].get("memory_journal"), commit["memory_journal"], turn)
        journaled = dict(done, markdown=MEM.journal_markdown(state, done["text"], done["lines"]))
        state["requests"]["memory_journal"] = None
    return {"summarized": summarized, "journaled": journaled}


def after_turn(state, ctx, commit, base):
    _rounds, recalled = MEM.select(base, commit["player_input"], MEM.TOTAL_BRIEF)
    MEM.reinforce(state, [e["id"] for e in recalled if MEM.cued_by_words(e, commit["player_input"])])
    remembered = MEM.capture(state, ctx, commit)
    return {"remembered": [e["id"] for e in remembered], "forgetting": MEM.maintain(state)}


def close_record(state):
    state["requests"]["memory_summary"] = MEM.summary_request(state)
    state["requests"]["memory_journal"] = MEM.archive_request(state)


def project(state, persona, cue, full):
    fields = {"memories": MEM.inject(state, cue, MEM.TOTAL_FULL if full else MEM.TOTAL_BRIEF)}
    for key in ("memory_summary", "memory_journal"):
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
                "新的一天了，回顾今天发生的事，写一篇日记写入中期记忆「这几天」",
                "读上下文的 memory_summary_sources，把今天写成一篇日记放进「这几天」："
                "第一人称（我），①今天发生了什么 ②你当时的感受 ③保留 1~2 个具体细节，≤100 字；"
                "顺手把值得一直记着的 0~2 条经历 id 写进 memory_keep",
            )
    elif commit["memory_summary"]:
        ctx.error("$.memory_summary", "引擎没有要求每日总结", "去掉 memory_summary；跨天后引擎会在记录结束时要求", INVALID_INPUT)
    if requests.get("memory_journal"):
        if not commit["memory_journal"]:
            ctx.error(
                "$.memory_journal",
                "「这几天」满了，引擎要求把这个月写进她的日记",
                "读上下文的 memory_journal_sources，把这件事写成 ≤300 字放进 memory_journal",
            )
    elif commit["memory_journal"]:
        ctx.error("$.memory_journal", "引擎没有要求写日记", "去掉 memory_journal", INVALID_INPUT)
