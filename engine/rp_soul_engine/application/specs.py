"""Input specs for every command (the generated references read these)."""

from .. import schema as S
from ..domain import structure as ST
from ..domain.turn import commit_fields

F = S.Field
SESSION_ID = S.Str(3, 40, r"s_[a-z0-9]{2,38}", "会话 ID，形如 s_1a2b3c4d")
SLOT_NAME = S.Str(1, 60)


def session_write_fields():
    return {
        "session_id": F(SESSION_ID),
        "request_id": F(S.RequestId()),
        "expected_revision": F(S.Int(1, 10**9), desc="上一次返回的 revision"),
    }


def _obj(fields, name):
    return S.Obj(fields, name=name)


RECORD_MAX_TURNS = 12

# ---------------------------------------------------------------------------
# persona


PERSONA_PAYLOAD = S.Obj(
    {
        "front": F(S.Any("YAML 前置块解码后的对象"), required=False, default={},
                   desc="人设 markdown 的 --- 前置块；node 侧已解码成对象"),
        "prose": F(S.Str(0, 20000), required=False, default="",
                   desc="人设散文（前置块之后的正文），进系统提示词"),
        "title": F(S.Nullable(S.Str(1, 60)), required=False, default=None),
        "persona_id": F(S.Nullable(S.Id()), required=False, default=None),
    },
    name="人设包",
)

CHECK_PERSONA = _obj(
    {"persona": F(PERSONA_PAYLOAD), "strict": F(S.Bool(), required=False, default=True)},
    "check-persona",
)

PREVIEW_PERSONA = _obj(
    {
        "persona": F(PERSONA_PAYLOAD),
        "seed": F(S.Nullable(S.Int(1, 999999)), required=False, default=None),
    },
    "preview-persona",
)

NEW_GAME = _obj(
    {
        "request_id": F(S.RequestId()),
        "persona": F(PERSONA_PAYLOAD, desc="由 rp-soul 提供的人设包；引擎不发明任何人物或地点"),
        "seed": F(S.Nullable(S.Int(1, 999999)), required=False, default=None),
        "preferences": F(
            S.Obj(
                {
                    "offscreen_simulation": F(S.Bool(), required=False),
                    "person": F(S.Enum(*ST.PERSONS), required=False),
                    "pace": F(S.Enum(*ST.PACES), required=False, desc="节奏：slow / standard / direct；只影响写法"),
                    "explicitness": F(S.Enum(*ST.EXPLICITNESS), required=False, desc="尺度：subtle / standard / explicit；只影响写法"),
                },
                name="偏好",
            ),
            required=False,
            default={},
        ),
    },
    "new-game",
)

# ---------------------------------------------------------------------------
# 游戏进行


GET_CONTEXT = _obj(
    {
        "session_id": F(SESSION_ID),
        "depth": F(S.Enum("brief", "full"), required=False, default="brief"),
        "want_twist": F(S.Bool(), required=False, default=False,
                        desc="玩家说“来点转折”时为 true：返回 2–3 个类别不同的转折候选"),
        "persona": F(S.Nullable(PERSONA_PAYLOAD), required=False, default=None,
                     desc="磁盘上现在的人设包；给了就按它刷新这一局的静态事实（名字、外貌、语态、作息、心情基准），关系与剧情不动"),
    },
    "get-context",
)

COMMIT_TURN = _obj(
    dict(
        session_write_fields(),
        persona=F(S.Nullable(PERSONA_PAYLOAD), required=False, default=None,
                  desc="磁盘上现在的人设包；给了就先按它刷新这一局的静态事实再记这回合"),
        turns=F(
            S.List(S.Obj(commit_fields(), name="回合"), 1, RECORD_MAX_TURNS),
            desc="这次记录的回合，按发生的顺序；引擎逐项应用，全有或全无",
        ),
    ),
    "commit-turn",
)

UNDO_TURN = _obj(session_write_fields(), "undo-turn")

STATUS = _obj(
    {
        "session_id": F(SESSION_ID),
        "level": F(S.Enum("brief", "detail", "debug"), required=False, default="brief",
                   desc="brief 六行 / detail 状态+ / debug 调试"),
    },
    "status",
)

DEBUG_MOOD = _obj(
    {
        "session_id": F(SESSION_ID),
        "npc_id": F(S.Nullable(S.Id()), required=False, default=None, desc="TA的 id；省略即是TA"),
    },
    "debug-mood",
)

DEBUG_MOODS = _obj(
    {
        "session_id": F(SESSION_ID),
    },
    "debug-moods",
)

DEBUG_ACTIVITY = _obj(
    {
        "session_id": F(SESSION_ID),
        "limit": F(S.Int(1, 50), required=False, default=20,
                   desc="读最近多少条回合记录（最多 50）"),
    },
    "debug-activity",
)

DEBUG_DELETE_THOUGHT = _obj(
    dict(
        session_write_fields(),
        npc_id=F(S.Nullable(S.Id()), required=False, default=None, desc="TA的 id；省略即是TA"),
        thought_id=F(S.Id()),
        reason=F(S.Nullable(S.Str(1, 120)), required=False, default=None,
                 desc="为什么要删（写进审计日志）"),
    ),
    "debug-delete-thought",
)

# ---------------------------------------------------------------------------
# 存档


SAVE_SLOT = _obj(
    dict(
        session_write_fields(),
        name=F(S.Nullable(SLOT_NAME), required=False, default=None),
        overwrite=F(S.Bool(), required=False, default=False),
        save_as=F(S.Bool(), required=False, default=False),
    ),
    "save-slot",
)

LOAD_SLOT = _obj({"request_id": F(S.RequestId()), "name": F(SLOT_NAME)}, "load-slot")

DELETE_SLOT = _obj(
    dict(
        session_write_fields(),
        name=F(SLOT_NAME),
        confirm=F(S.Bool(), required=False, default=False, desc="玩家确认删除后才为 true"),
    ),
    "delete-slot",
)

LIST_SESSIONS = _obj({"limit": F(S.Int(1, 20), required=False, default=10)}, "list-sessions")

EXPORT_SAVE = _obj(
    {
        "session_id": F(S.Nullable(SESSION_ID), required=False, default=None,
                        desc="导出这个会话的当前状态"),
        "slot": F(S.Nullable(SLOT_NAME), required=False, default=None, desc="或导出这个存档"),
        "path": F(S.Nullable(S.Str(1, 400)), required=False, default=None,
                  desc="用户明确给出的绝对 .json 路径；不给时写到数据目录的 exports/"),
        "overwrite": F(S.Bool(), required=False, default=False),
    },
    "export-save",
)

IMPORT_SAVE = _obj(
    {
        "request_id": F(S.RequestId()),
        "data": F(S.Any("导出的 JSON 对象"), desc="玩家粘贴或 node 侧读文件后的导出内容"),
        "slot": F(S.Nullable(SLOT_NAME), required=False, default=None,
                  desc="同时写入这个存档槽（可省略）"),
        "overwrite": F(S.Bool(), required=False, default=False,
                       desc="存档名已被占用时，玩家确认覆盖"),
    },
    "import-save",
)

# ---------------------------------------------------------------------------
# 设置


SET_BOUNDARY = _obj(
    dict(
        session_write_fields(),
        action=F(S.Enum("add", "remove"), desc="add 登记 / remove 撤销"),
        text=F(S.Nullable(S.Str(1, 80)), required=False, default=None,
               desc="玩家的原话，例如“不要涉及怀孕”"),
        tags=F(S.List(S.Enum(*ST.TAG_IDS), max_items=6, unique=True), required=False, default=[],
               desc="映射到的内容标签；映射不上就留空（记为 custom，由你自己遵守）"),
        boundary_id=F(S.Nullable(S.Id()), required=False, default=None, desc="撤销时可用边界 ID"),
    ),
    "set-boundary",
)

SET_SAFETY = _obj(
    dict(
        session_write_fields(),
        paused=F(S.Bool(), desc="true 暂停 / false 恢复"),
        change_scene=F(S.Bool(), required=False, default=False,
                       desc="“换个场景”：保持暂停，换到新的非亲密场景"),
    ),
    "set-safety",
)

SET_PREFERENCES = _obj(
    dict(
        session_write_fields(),
        offscreen_simulation=F(S.Bool(), required=False),
        person=F(S.Enum(*ST.PERSONS), required=False),
        pace=F(S.Enum(*ST.PACES), required=False, desc="节奏：slow / standard / direct；只影响写法"),
        explicitness=F(S.Enum(*ST.EXPLICITNESS), required=False, desc="尺度：subtle / standard / explicit；只影响写法"),
    ),
    "set-preferences",
)

# ---------------------------------------------------------------------------
# 无输入


EMPTY = S.Obj({}, name="空")
