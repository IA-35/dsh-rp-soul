"""The generic structure layer (DESIGN_DECISIONS.md D16).

Only structure lives here: stage tables, response spectrum, power structures,
twist categories, enums. No text tied to an era, place, trade or title; every
display string here must pass every world's forbidden-term scan.
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
POWER_STRUCTURES = ("player_high", "npc_high", "equal", "switchable")
SOCIAL_POSITIONS = ("low", "equal", "high")
TWIST_CATEGORIES = ("信息", "人事", "资源", "制度", "时限", "关系", "意外")
HOOK_KINDS = ("approach", "observe", "request", "accident")
BACKGROUND_FUNCTIONS = ("witness", "messenger", "obstacle", "rumor_source", "helper")
CHANNEL_FIDELITY = ("exact", "distorted")
PRIVACY = ("public", "semi", "private")
PRESSURE_SOURCES = ("institution", "person", "nature", "money", "rumor", "accident")
PRESSURE_FLAGS = ("timed", "leverage")
GENDERS = ("female", "male", "nonbinary")
TEMPLATE_GENDERS = ("any",) + GENDERS
NPC_GENDER_PREFERENCES = ("any", "mostly_female", "mostly_male", "female_only", "male_only", "mixed")
PERSONS = ("second", "first", "third")
TIERS = ("background", "supporting", "major")
PACES = ("slow", "standard", "direct")
EXPLICITNESS = ("subtle", "standard", "explicit")

FACT_VISIBILITY = ("public", "private", "inner")
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
SCENE_BREAK_MINUTES = 60

COOLDOWN_TURNS = 3
MAX_FIX_ATTEMPTS = 2

# Text ceilings, in characters without IDs and tags: a card or a pressure on
# stage goes into every full context (20 KB), so a long one squeezes the
# others (PROGRESS: 全部按建议执行（2026-10-16）).
TEMPLATE_TEXT_MAX = 1800
PRESSURE_TEXT_MAX = 450

# ---------------------------------------------------------------------------
# mood（RimWorld 式心情条：基准值 + 生效想法求和，阈值切 band）
#
# 两个轴分开：mood 是"此刻怎样"（短期、会回落），trust/stage 是"长期怎么
# 判断你"（慢变、有阶段）。band 只决定本回合的行为门禁，不写进存档。

MOOD_RANGE = (0, 100)
MOOD_BASE = 50
MOOD_THRESHOLDS = {"open": 75, "closed": 45, "break": 25}
MOOD_BANDS = ("open", "normal", "closed", "break")
MOOD_MAX_THOUGHTS = 20
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
MOOD_GATE = {
    "closed": {"stage_advance": "他现在的状态不会接受关系推进"},
    "break": {"npc_response": "他现在没法好好回应，只能挑衅或离开"},
}

# 情境类想法的来源与幅度（引擎自己算，模型一个字都不写）
SITUATIONAL_DELTA = {
    "present": 3,
    "absent": -2,
    "away_long": -5,
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
# 记忆类：由 op 触发，必须带 source_fact_id
RESPONSE_THOUGHTS = {
    "refuse": (-12, "refuse"),
    "negotiate": (-4, "tone"),
    "partial": (2, "tone"),
    "surface": (-6, "tone"),
    "genuine": (8, "tone"),
}
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
AGENCY_KINDS = ("approach", "observe", "request", "accident", "provoke", "leave")
AGENCY_GOAL_KINDS = {
    "approach": "接近玩家",
    "observe": "观察",
    "request": "提要求",
    "accident": "意外",
    "provoke": "挑衅",
    "leave": "离开",
}

# ---------------------------------------------------------------------------
# 通用字符串（用于自检/文档，不含任何世界专属词）

def generic_strings():
    """Every display string of the generic layer."""
    out = list(STAGE_LABELS.values()) + list(RESPONSE_LABELS.values())
    out += list(MOOD_BANDS)
    return out


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
