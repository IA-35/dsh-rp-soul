"""Global invariants: the last net after every commit.

Operations validate themselves; this pass catches anything an operation
missed. Any violation rejects the whole commit. It knows nothing about any
particular persona: only the generic structure layer and the state schema.
"""

from ..errors import INVARIANT_VIOLATION, SAFETY_BLOCK, detail
from . import clock as CL
from . import facts as FA
from . import structure as ST
from . import mood as MO


def check(state, before_clock=None):
    problems = []

    def bad(path, reason, code=INVARIANT_VIOLATION):
        problems.append(detail(path, reason, "这是引擎的最后一道检查；请修正提交", code))

    chars = state["characters"]
    player = state["player_id"]
    if player not in chars:
        bad("$.state.characters", "玩家角色缺失")
    if len(chars) != 2:
        bad("$.state.characters", "只能有你和TA两个人（现在 %d 个）" % len(chars))
    for cid, char in chars.items():
        base = "$.state.characters.%s" % cid
        age = char.get("age")
        if cid != player:
            if not isinstance(age, int):
                bad(base + ".age", "角色 %s 缺少明确年龄" % cid)
            elif age < 18:
                bad(base + ".age", "角色 %s 年龄 %d 小于 18" % (cid, age), SAFETY_BLOCK)
            # adult_context 只是「一句话交代成年身份」的补充说明，人设里可以不写：
            # 年龄这一关已经在上面把住了，这里不再要求它非空。
        mood = char.get("mood")
        if cid != player:
            if not isinstance(mood, dict):
                bad(base + ".mood", "角色 %s 缺少心情记录" % cid)
            else:
                for thought in mood.get("thoughts") or []:
                    if thought["kind"] not in ST.THOUGHT_KINDS:
                        bad(base + ".mood.thoughts", "想法种类非法：%s" % thought["kind"])
                    lo, hi = ST.THOUGHT_DELTA_RANGE
                    if not lo <= thought["delta"] <= hi:
                        bad(base + ".mood.thoughts", "想法幅度超出范围：%s" % thought["delta"])
                    if thought["kind"] == "memory" and not thought.get("source_fact_id"):
                        bad(base + ".mood.thoughts", "记忆类想法必须指向一条事实")
                    if thought.get("source_fact_id") and thought["source_fact_id"] not in state["facts"]:
                        bad(base + ".mood.thoughts", "想法依据的事实不存在：%s" % thought["source_fact_id"])
                for key in ("base",):
                    if not isinstance(mood.get(key), int):
                        bad(base + ".mood." + key, "心情基准值必须是整数")
    if before_clock is not None and CL.to_abs(state["clock"]) < CL.to_abs(before_clock):
        bad("$.state.clock", "时钟倒流")
    scene = state["scene"]
    if player not in scene["present"]:
        bad("$.state.scene.present", "玩家角色必须在当前场景")
    if len(set(scene["present"])) != len(scene["present"]):
        bad("$.state.scene.present", "在场名单有重复")
    for cid in scene["present"]:
        if cid not in chars:
            bad("$.state.scene.present", "在场的人不存在：%s" % cid)
    facts = state["facts"]
    # A commit checks the facts it created or changed; the rest were checked
    # when they were written and have not changed since.
    checked = facts.changed_facts() if isinstance(facts, FA.FactView) else FA.of(state).all()
    for fact in checked:
        fid = fact["id"]
        base = "$.state.facts.%s" % fid
        for cid in fact["known_by"] + fact["believed_by"]:
            if cid not in chars:
                bad(base, "知情人不存在：%s" % cid)
        if fact["visibility"] == "inner":
            if len(fact["known_by"]) != 1 or fact["believed_by"] or fact.get("spreading"):
                bad(base, "内心事实只能属于本人、不能传播")
        if fact["truth"] and fact["believed_by"]:
            bad(base, "真事实不能有误信者")
    now = CL.to_abs(state["clock"])
    for eid, event in state["events"].items():
        base = "$.state.events.%s" % eid
        if event["state"] not in ST.EVENT_STATES:
            bad(base, "事件状态非法")
        if event["state"] == "pending" and CL.to_abs(event["due"]) <= now:
            bad(base, "未结束事件的到期时间必须晚于现在")
        if event["state"] != "pending" and event["outcome"] is None:
            bad(base, "已结束事件缺少结果")
    for key, edge in state["relationships"].items():
        base = "$.state.relationships.%s" % key
        if not ST.TRUST_RANGE[0] <= edge["trust"] <= ST.TRUST_RANGE[1]:
            bad(base, "信任超出范围")
        if not ST.TENSION_RANGE[0] <= edge["tension"] <= ST.TENSION_RANGE[1]:
            bad(base, "张力超出范围")
        if edge["stage"] not in ST.STAGES:
            bad(base, "阶段非法")
        if edge["from"] not in chars or edge["to"] not in chars:
            bad(base, "关系端点不存在")
    limits = state.get("mood_thresholds") or {}
    for problem in MO.validate_thresholds(limits, "$.state.mood_thresholds"):
        problems.append(problem)
    return problems
