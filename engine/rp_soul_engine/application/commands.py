"""Command registry: the single table of every command the sidecar serves.

Every entry names its handler lazily (module, function) so a cold process
imports only what the command needs. `input` is one of:
  none      - takes no input (an empty object is accepted)
  optional  - input may be omitted entirely
  required  - input must be an object
`category` groups commands for the generated references.
"""


class Command:
    __slots__ = ("name", "module", "func", "input", "category", "summary", "spec")

    def __init__(self, name, module, func, input, category, summary, spec=None):
        self.name = name
        self.module = module
        self.func = func
        self.input = input
        self.category = category
        self.summary = summary
        self.spec = spec

    def as_dict(self):
        return {
            "name": self.name,
            "input": self.input,
            "category": self.category,
            "summary": self.summary,
            "spec": self.spec,
        }


COMMANDS = {}
APP = "rp_soul_engine.application."


def _register(*args, **kwargs):
    command = Command(*args, **kwargs)
    COMMANDS[command.name] = command


_register("doctor", APP + "doctor", "run", "none", "diagnostic", "检查环境并完成首次初始化（幂等）")
_register("version", APP + "info", "version", "none", "read", "引擎、存档格式、state schema、RNG 版本")
_register("list-commands", APP + "info", "commands", "none", "read", "全部命令与输入形态")
_register("check-persona", APP + "service", "check_persona", "required", "read", "校验一份人设包，返回问题清单", "CHECK_PERSONA")
_register("preview-persona", APP + "service", "preview_persona", "required", "read", "用一份人设开个局看看（不写库）", "PREVIEW_PERSONA")
_register("new-game", APP + "service", "new_game", "required", "create", "开局：由人设包建立会话", "NEW_GAME")
_register("get-context", APP + "service", "get_context", "required", "read", "当前上下文（brief / full）", "GET_CONTEXT")
_register("commit-turn", APP + "service", "commit_turn", "required", "session_write", "叙事回合：提交操作，返回结果与下一回合上下文", "COMMIT_TURN")
_register("undo-turn", APP + "service", "undo_turn", "required", "session_write", "撤销上一回合（最多退到本次读档或开局）", "UNDO_TURN")
_register("save-slot", APP + "service", "save_slot", "required", "session_write", "存档（省略名字时存到当前槽或自动命名）", "SAVE_SLOT")
_register("load-slot", APP + "service", "load_slot", "required", "create", "读档：创建新的会话副本，原存档不变", "LOAD_SLOT")
_register("list-slots", APP + "service", "list_slots", "none", "read", "存档列表")
_register("delete-slot", APP + "service", "delete_slot", "required", "session_write", "删除存档（需要 confirm: true）", "DELETE_SLOT")
_register("list-sessions", APP + "service", "list_sessions", "optional", "read", "最近的会话（续玩、恢复）", "LIST_SESSIONS")
_register("export-save", APP + "service", "export_save", "required", "read", "把会话或存档导出为对象（带完整性校验值）", "EXPORT_SAVE")
_register("import-save", APP + "service", "import_save", "required", "create", "导入导出对象，得到一个新会话（可同时写入存档槽）", "IMPORT_SAVE")
_register("set-boundary", APP + "service", "set_boundary", "required", "session_write", "登记或撤销硬边界", "SET_BOUNDARY")
_register("set-safety", APP + "service", "set_safety", "required", "session_write", "暂停、恢复、换个场景", "SET_SAFETY")
_register("set-preferences", APP + "service", "set_preferences", "required", "session_write", "离屏推演、节奏、尺度", "SET_PREFERENCES")
_register("status", APP + "service", "status", "required", "read", "状态：brief 六行 / detail 状态+ / debug 调试", "STATUS")
_register("next-wake", APP + "service", "next_wake", "required", "read", "她下一次该醒过来的时间与理由（只读）", "NEXT_WAKE")
_register("debug-mood", APP + "service", "debug_mood", "required", "read", "某个角色的心情面板（每个 thought 一条）", "DEBUG_MOOD")
_register("debug-delete-thought", APP + "service", "debug_delete_thought", "required", "session_write", "设置页调试：手动删掉一条 thought", "DEBUG_DELETE_THOUGHT")
_register("debug-moods", APP + "service", "debug_moods", "required", "read", "设置页情绪页：所有 NPC 的心情面板与对玩家的关系", "DEBUG_MOODS")
_register("debug-memories", APP + "service", "debug_memories", "required", "read", "设置页记忆页：四层记忆、待交的总结 / 归档、删除审计", "DEBUG_MEMORIES")
_register("edit-memory", APP + "service", "edit_memory", "required", "session_write", "设置页记忆页：改一条记忆（内容 / 重要度 / 活跃度 / 关键词 / 备注 / Pin）", "EDIT_MEMORY")
_register("delete-memory", APP + "service", "delete_memory", "required", "session_write", "设置页记忆页：删一条记忆（留审计）", "DELETE_MEMORY")
_register("request-memory", APP + "service", "request_memory", "required", "session_write", "设置页记忆页：立即总结 / 立即归档（下一次提交执行）", "REQUEST_MEMORY")
_register("debug-activity", APP + "service", "debug_activity", "required", "read", "设置页自主行动页：最近若干回合的行动、离屏片段与关系变化", "DEBUG_ACTIVITY")
_register("debug-facts", APP + "service", "debug_facts", "required", "read", "设置页常识库：她知道的事", "DEBUG_FACTS")
_register("delete-fact", APP + "service", "delete_fact", "required", "session_write", "设置页常识库：删一条事实（留审计）", "DELETE_FACT")


def get(name):
    return COMMANDS.get(name)


def table():
    return [COMMANDS[name].as_dict() for name in sorted(COMMANDS)]
