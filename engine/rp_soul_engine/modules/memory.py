"""Life-memory lifecycle; the core retains its own turn audit regardless."""

from ..domain import common as CM
from ..domain import memories as MEM
from ..errors import INVALID_INPUT


def pay_requests(state, commit, turn):
    folded = None
    diary = None
    if commit.get("memory_fold"):
        request = state["requests"].get("memory_fold")
        # 宿主起的子代理可能先把这一批收走了：此时再按模型这几句话落一条 SCM
        # 就是凭空多出来一段没有来源的记忆，宁可不收。
        # （宿主收完会记下 host_paid，before_turn 据此放行，不驳提交。）
        if request and MEM.sources(state, request):
            folded = MEM.apply_fold(state, request, commit["memory_fold"],
                                    turn, keep=commit.get("memory_keep") or ())
        state["requests"]["memory_fold"] = None
    if commit.get("memory_diary"):
        request = state["requests"].get("memory_diary")
        if request:
            diary = MEM.apply_diary(state, request, commit["memory_diary"])
        state["requests"]["memory_diary"] = None
    return {"folded": folded, "diary": diary, "common": _learned(commit, turn, "fold" if folded else "diary")}


def _learned(commit, turn, origin):
    """这次总结 / 写日记里提到的常识。

    只有真的收了 SCM 或写了日记的那一回才算 —— 模型不能靠随手丢一条
    common 就往全局库里写字。
    """
    if not (commit.get("memory_fold") or commit.get("memory_diary")):
        return []
    found = []
    for raw in commit.get("common") or ():
        item = CM.from_model(raw, turn, origin=origin)
        if item is not None:
            found.append(item)
    return found


def after_turn(state, ctx, commit, base):
    cue = commit.get("player_input") or ""
    recalled = MEM.select(base, cue, MEM.SCM_BRIEF)
    MEM.reinforce(state, [e["id"] for e in recalled if MEM.cued_by_words(e, cue)])
    remembered = MEM.capture(state, ctx, commit)
    return {"remembered": [e["id"] for e in remembered], "forgetting": MEM.maintain(state)}


def close_record(state):
    state["requests"]["memory_fold"] = MEM.abm_batch(state)
    state["requests"]["memory_diary"] = MEM.diary_request(state)


def project(state, persona, cue, full):
    total = MEM.SCM_FULL if full else MEM.SCM_BRIEF
    fields = {"memories": MEM.inject(state, cue, total)}
    for key in ("memory_fold", "memory_diary"):
        view = MEM.request_view(state, state["requests"].get(key), compact=not full)
        if view is not None:
            fields[key + "_sources"] = view
    return {"context": fields}


def _host_paid(state, kind):
    """这一回合的这一笔，宿主已经替模型做过了。

    模型是在上一份上下文里看到「该收了」的，而宿主可能在那一轮结束时就把
    它收掉了。此时它照样交 memory_fold，不该把整次提交驳回去。
    """
    paid = state["counters"].get("host_paid") or {}
    return paid.get(kind) == state["turn"]


def before_turn(state, ctx):
    commit = ctx.commit
    requests = ctx.state["requests"]
    if requests.get("memory_fold"):
        if not commit.get("memory_fold"):
            ctx.error(
                "$.memory_fold",
                "ABM 该收进 SCM 了",
                "读上下文的 memory_fold_sources，把这一批收成一条 SCM：第一人称（我），"
                "记得发生了什么、你当时的感受，留下带得住的细节，≤300 字；"
                "顺手把值得一直记着的 0~2 条经历 id 写进 memory_keep（会进 CLPA）",
            )
    elif commit.get("memory_fold") and not _host_paid(state, "fold"):
        ctx.error("$.memory_fold", "引擎没有要求收 ABM", "去掉 memory_fold；ABM 满了或者搁置一小时，引擎会自己要", INVALID_INPUT)
    if requests.get("memory_diary"):
        if not commit.get("memory_diary"):
            ctx.error(
                "$.memory_diary",
                "该写今天的日记了",
                "读上下文的 memory_diary_sources，把这一天写成一篇日记（第一人称，按时间顺下来，≤300 字）",
            )
    elif commit.get("memory_diary"):
        ctx.error("$.memory_diary", "引擎没有要求写日记", "去掉 memory_diary；每晚 23:30 引擎会自己要", INVALID_INPUT)
