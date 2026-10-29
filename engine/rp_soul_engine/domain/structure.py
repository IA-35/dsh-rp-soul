"""The generic structure layer: stage tables, response spectrum, enums.

rp-soul is one companion and the player ("you and me"); the multi-character
tables of the engine this was ported from (tiers, power structures, places,
channels, pressures) are gone. No text tied to an era, place, trade or title.
"""

# Relationship stages (NARRATIVE_RULES.md section 6). Worlds may relabel them.
STAGES = ("stranger", "acquainted", "familiar", "flirting", "testing", "intimate", "committed")
STAGE_LABELS = {
    "stranger": "陌生",
    "acquainted": "认识",
    "familiar": "熟络",
    "flirting": "暧昧",
    "testing": "试探",
    "intimate": "亲密",
    "committed": "稳定",
}

TRUST_RANGE = (-5, 5)
TENSION_RANGE = (0, 5)
MAX_TRUST_DELTA = 2  # per commit, per directed edge (default value table)

# NPC response spectrum (NARRATIVE_RULES.md section 3)
RESPONSES = ("refuse", "negotiate", "partial", "surface", "genuine")
RESPONSE_LABELS = {
    "refuse": "拒绝",
    "negotiate": "协商",
    "partial": "有限配合",
    "surface": "表面配合",
    "genuine": "真诚配合",
}
COOPERATIVE_RESPONSES = ("partial", "genuine")

ACTION_MODES = ("result", "attempt", "rewrite", "continue", "wait")
GENDERS = ("female", "male", "nonbinary")
PERSONS = ("second", "first", "third")
PACES = ("slow", "standard", "direct")
EXPLICITNESS = ("subtle", "standard", "explicit")

# 存储层的可见性（事实行里的 visibility 列）
FACT_VISIBILITY = ("public", "private", "inner")
# 模型写事实时用的范围：只有你我两个人，谁知道一目了然
#   shared 你们都知道 / player_only 只有你知道 / companion_only 只有她知道 / inner 她心里的
FACT_SCOPES = ("shared", "player_only", "companion_only", "inner")
# rumor 只留给旧存档里已有的事实：单角色没有传话的人
FACT_ORIGINS = ("setup", "observed", "told", "retcon", "offscreen", "rumor")
MODEL_FACT_ORIGINS = ("observed", "told", "retcon")  # setup/offscreen/rumor come from the engine or dedicated ops

EVENT_KINDS = ("promise", "deadline", "rumor", "opportunity", "foreshadow", "chance")
EVENT_TIERS = ("immediate", "near", "far")
EVENT_STATES = ("pending", "resolved", "cancelled")
# What happens when a pending event reaches its due time without being resolved.
DUE_OUTCOME = {
    "promise": "expired",
    "deadline": "expired",
    "opportunity": "expired",
    "foreshadow": "surfaced",
    "rumor": "surfaced",
}
MANUAL_OUTCOMES = {
    "promise": ("fulfilled",),
    "deadline": ("fulfilled",),
    "opportunity": ("fulfilled",),
    "foreshadow": ("surfaced",),
    "rumor": ("surfaced",),
    "chance": (),
}

CONDITION_KINDS = ("drunk", "asleep", "unconscious", "injured", "away", "busy", "other")
# Characters in these conditions never take part in intimate scenes.
INCAPACITATING = ("drunk", "asleep", "unconscious")

# The story clock is read off the real wall clock, so there are no anchors to
# skip to: a gap is however long the user was away, never a chosen span.
MINUTES_PER_DAY = 1440
MAX_ADVANCE_MINUTES = 30 * MINUTES_PER_DAY
# 隔这么久再说话就算新的一段相处（新场景）
SCENE_BREAK_MINUTES = 60

# 重大自主行动的冷却：按真实时间算，不按说了几句话。平常 1-3 分钟一来一回，
# 20 分钟意味着连续聊一小时她最多主动做 3 件「重大」的事。
ACTION_COOLDOWN_MINUTES = 20
# 心情 open 时放松到这个数（原来是 TURNS 减 1 回合）
ACTION_COOLDOWN_MINUTES_OPEN = 10
MAX_FIX_ATTEMPTS = 2

# ---------------------------------------------------------------------------
# mood（RimWorld 式心情条：基准值 + 生效想法求和，阈值切 band）
#
# 两个轴分开：mood 是"此刻怎样"（短期、会回落），trust/stage 是"长期怎么
# 判断你"（慢变、有阶段）。band 只决定本回合的行为门禁，不写进存档。

MOOD_RANGE = (0, 100)
MOOD_BASE = 50
MOOD_THRESHOLDS = {"open": 75, "closed": 45, "break": 25}
MOOD_BANDS = ("open", "normal", "closed", "break")
MOOD_MAX_MEMORY = 12
MOOD_MAX_SITUATIONAL = 8
THOUGHT_DELTA_RANGE = (-30, 15)
THOUGHT_DECAYS = ("linear", "none")
THOUGHT_KINDS = ("memory", "situational")
# |delta| 缩到这个值以下就删：不必留下一条毫无影响的噪声
THOUGHT_MIN_ABS = 1

# 时长量级（分钟）。参照 RW 的 thought 时长，但按文字节奏放宽。
HOUR = 60
DAY = 1440
THOUGHT_DURATION = {
    "tone": 6 * HOUR,             # 一句话的语气（partial / genuine）
    "refuse": 1 * DAY,            # 一次拒绝或敷衍
    "broken_promise": 5 * DAY,    # 承诺被毁、隐瞒被揭穿
    "stage": 10 * DAY,            # 阶段前进
    "rupture": 10 * DAY,          # 关系破裂
}

# 行为门禁：band + op → 拒绝原因（None = 放行）
# 档位在真实时间结算后、回合操作前冻结，与 brief 的时间预览一致。
MOOD_GATE = {
    "closed": {"stage_advance": "TA现在的状态不会接受关系推进"},
    "break": {
        "stage_advance": "TA现在的状态不会接受关系推进",
    },
}
# 低心情时这些行动也能表达对尝试的反应，但不构成亲密同意。
MOOD_REACTION_KINDS = ("provoke", "leave", "silence", "seek_comfort", "change_topic", "withdraw")

# 情境类想法的来源与幅度（引擎自己算，模型一个字都不写）
SITUATIONAL_DELTA = {
    "present": 3,
    "absent": -2,
    "away_long": -5,      # 隔了一天以上你才回来
    "event_due": -6,
    "event_overdue": -10,
    "tension": -6,
    "condition": -4,
    "late_hour": -3,
}
SITUATIONAL_EXPIRES = {
    "present": None,       # 条件成立期间生效
    "absent": None,
    "away_long": 1 * DAY,
    "event_due": None,
    "event_overdue": 1 * DAY,
    "tension": None,
    "condition": None,
    "late_hour": 6 * HOUR,
}
# 记忆类：由 op 触发，必须带 source_fact_id。
# NPC 自己选的回应（拒绝/配合）不进他自己的心情：心情由别人对他做了什么驱动
# （relationship 的信任变化、add_thought），否则低落→拒绝→更低落会一路滑进崩溃档。
RELATIONSHIP_THOUGHT_SCALE = 3      # trust 变化 × 3 作为一条想法
STAGE_ADVANCE_THOUGHT = (15, "stage")
EVENT_FAILED_THOUGHT = (-10, "refuse")

# 回应长度上限（字符）：收缩档下他不再长篇回应
MOOD_RESPONSE_LIMIT = {"open": None, "normal": None, "closed": 30, "break": 30}
# 敞开档允许的额外动作
MOOD_OPEN_COOLDOWN_BONUS = 1

# ---------------------------------------------------------------------------
# 自主行动（agency）：候选由引擎确定性生成，模型只能从列表里挑

AGENCY_MAX_CANDIDATES = 3
AGENCY_KINDS = ("approach", "observe", "request", "accident", "provoke", "leave",
                "silence", "seek_comfort", "change_topic", "withdraw")
AGENCY_GOAL_KINDS = {
    "approach": "主动找你",
    "observe": "在旁观察",
    "request": "提要求",
    "accident": "意外",
    "provoke": "刺你一句",
    "leave": "走开/冷场",
    "silence": "沉默",
    "seek_comfort": "寻求安慰",
    "change_topic": "转移话题",
    "withdraw": "独处",
}

# ---------------------------------------------------------------------------
# 通用字符串（用于自检/文档，不含任何世界专属词）

def seq_of(item_id, prefix):
    """数字序，不是字符串序：「e10」排在「e9」后面。"""
    digits = item_id[len(prefix):] if item_id.startswith(prefix) else item_id
    return int(digits) if digits.isdigit() else 0



# ---------------------------------------------------------------------------
# 内容标签（内置 19 个，原样取自 adult-tension 的 content/tags.json）
#
# 标签不是世界观：它只用来表达"这一回合的正文里出现了什么"，好让玩家登记的
# 边界能被检查、让亲密场景被要求写明参与者。人设不需要、也不能改写它。

TAG_KINDS = ("intimacy", "conflict", "theme", "setting", "custom")
TAGS = (
    ("romance_light", "intimacy", "轻度暧昧", "眼神、试探、靠近、暧昧的言语，不涉及身体亲密"),
    ("intimate", "intimacy", "亲密", "亲吻、拥抱、抚摸等身体亲密；提交需写明亲密参与者"),
    ("explicit", "intimacy", "直白的性描写", "直白的性行为描写；提交需写明亲密参与者"),
    ("violence", "conflict", "暴力", "打斗、伤人、以暴力相威胁"),
    ("coercion_theme", "conflict", "胁迫", "要挟、把柄、以生计或秘密施压"),
    ("humiliation", "conflict", "羞辱", "当众贬低、刻意让人难堪"),
    ("bodily_harm", "conflict", "身体伤害", "受伤、流血、伤口处理"),
    ("substance", "theme", "酒精与药物", "喝酒、醉酒、药物"),
    ("pregnancy", "theme", "怀孕", "怀孕、避孕、生育"),
    ("death", "theme", "死亡", "死亡、丧事、濒死"),
    ("workplace_power", "theme", "职场权力关系", "上下级、雇佣、考核带来的不对等"),
    ("infidelity", "theme", "出轨", "有伴侣的一方与他人发生感情或亲密"),
    ("crime", "theme", "违法犯罪", "走私、造假、贿赂等违法行为"),
    ("gambling", "theme", "赌博", "赌局、欠赌债"),
    ("workplace", "setting", "职场", "故事主要发生在工作场所"),
    ("nightlife", "setting", "夜生活", "夜里的酒馆、食肆、娱乐场所"),
    ("supernatural", "setting", "超自然", "非人存在、法术、契约"),
    ("disaster", "setting", "灾难", "天灾、极端天气、断供"),
    ("custom", "custom", "自定义", "无法对应到上面任何标签的玩家边界，以原话登记"),
)
TAG_IDS = tuple(tag[0] for tag in TAGS)
TAG_LABELS = {tag[0]: tag[2] for tag in TAGS}
INTIMACY_TAGS = tuple(tag[0] for tag in TAGS if tag[1] == "intimacy")
# 这些标签要求提交写明亲密参与者
STRUCTURAL_INTIMACY_TAGS = ("intimate", "explicit")
CONFLICT_TAGS = tuple(tag[0] for tag in TAGS if tag[1] == "conflict")

# ---------------------------------------------------------------------------
# 唤醒线（她自己到点醒来）
#
# 候选全在账本里算：她的安排、你们的约定、她自己的事、想你了、作息换段。
# 时间先算成游戏时钟，再按「建局时刻 + 走过的分钟」换算成真实时刻。

WAKE_REASONS = ("plan", "promise", "event", "miss_you", "diary", "routine")
WAKE_REASON_LABELS = {
    "plan": "她说好做到的时间",
    "promise": "你们的约定",
    "event": "她自己的事",
    "miss_you": "想你了",
    "diary": "写日记的时间",
    "routine": "作息换段",
}
WAKE_LEAD_MINUTES = 30            # 约定到期前多久叫醒她
WAKE_MISS_YOU_HOURS = 6           # 你多久没说话算「想你了」（0 = 关）
WAKE_MISS_YOU_NEXT = (6, 12, 24)  # 没回话时逐次拉长
WAKE_QUIET = "00:00-08:00"        # 安静时段；只有她自己的安排能叫醒她
PLAN_NOTE_MAX = 40
