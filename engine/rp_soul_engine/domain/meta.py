"""Meta commands: boundaries, pause, preferences.

They change state (revision) but never advance the turn, and they write no
narrative. The tag table is the engine's built-in one, so a boundary can only
point at tags that actually exist.
"""

from ..errors import INVALID_INPUT, INVARIANT_VIOLATION, NOT_FOUND, AppError, detail
from . import facts as FA
from . import settlement
from . import state as SS
from . import structure as ST

PACE_LABELS = {"slow": "慢热", "standard": "标准", "direct": "直接"}
EXPLICITNESS_LABELS = {"subtle": "含蓄", "standard": "标准", "explicit": "直白"}
SHOWN_PREFERENCES = ("offscreen_simulation", "pace", "explicitness")
BOUNDARY_PREFIXES = ("不想看到", "不想要", "不要", "别写", "别", "不许")


def _bump(state):
    state["revision"] += 1
    state["facts"] = state["facts"].settle()  # meta commands never change facts
    return state


def _boundary_subject(text):
    for prefix in BOUNDARY_PREFIXES:
        if text.startswith(prefix):
            return text[len(prefix):].strip() or text
    return text


def set_boundary(state, action, text=None, tags=None, boundary_id=None):
    """Add or remove one player boundary. Returns (state|None, result)."""
    work = FA.working_copy(state)
    boundaries = work["safety"]["boundaries"]
    if action == "add":
        problems = [
            detail("$.tags[%d]" % i, "未知内容标签：%s" % tag,
                   "可用：%s；映射不上就用 custom" % "、".join(ST.TAG_IDS), INVALID_INPUT)
            for i, tag in enumerate(tags or [])
            if tag not in ST.TAG_IDS
        ]
        if not text:
            problems.append(detail("$.text", "边界要保留玩家的原话", None, INVALID_INPUT))
        if problems:
            raise AppError(INVALID_INPUT, problems[0]["reason"], problems)
        for boundary in boundaries:
            if boundary["text"] == text:
                return None, {
                    "boundary": boundary,
                    "receipt": "已记下：不会出现%s" % _boundary_subject(text),
                    "changed": False,
                }
        boundary = {
            "id": SS.next_id(work, "boundary", "b"),
            "text": text,
            "tags": list(tags) if tags else ["custom"],
            "created_turn": work["turn"],
        }
        boundaries.append(boundary)
        return _bump(work), {
            "boundary": boundary,
            "receipt": "已记下：不会出现%s" % _boundary_subject(text),
            "changed": True,
        }
    target = None
    for boundary in boundaries:
        if (boundary_id and boundary["id"] == boundary_id) or (text and boundary["text"] == text):
            target = boundary
    if target is None:
        raise AppError(
            NOT_FOUND,
            "没有找到这条边界",
            [detail(
                "$.boundary_id" if boundary_id else "$.text",
                "边界不存在",
                "现有边界：%s" % ("、".join("%s（%s）" % (b["text"], b["id"]) for b in boundaries) or "（无）"),
                NOT_FOUND,
            )],
        )
    work["safety"]["boundaries"] = [b for b in boundaries if b["id"] != target["id"]]
    return _bump(work), {"boundary": target, "receipt": "已撤销边界：%s" % target["text"], "changed": True}


def set_safety(state, paused, change_scene=False):
    """Pause / resume. A pause is a hard stop on intimacy and conflict."""
    work = FA.working_copy(state)
    safety = work["safety"]
    if change_scene and not paused:
        raise AppError(
            INVARIANT_VIOLATION,
            "“换个场景”会保持暂停",
            [detail("$.change_scene", "换场景时 paused 必须为 true", "恢复用 paused: false", INVARIANT_VIOLATION)],
        )
    if paused:
        was = safety["paused"]
        safety["paused"] = True
        if change_scene:
            scene = settlement.new_scene(work, "change_scene")
            return _bump(work), {
                "paused": True,
                "scene": scene,
                "receipt": "仍在暂停中，换到一个新的非亲密场景。",
                "changed": True,
            }
        if was:
            return None, {"paused": True, "receipt": "已暂停。说“继续”恢复，或说“换个场景”", "changed": False}
        return _bump(work), {"paused": True, "receipt": "已暂停。说“继续”恢复，或说“换个场景”", "changed": True}
    if not safety["paused"]:
        return None, {"paused": False, "receipt": "当前没有暂停", "changed": False}
    safety["paused"] = False
    # Resuming never continues an escalation: judgments are made again.
    work["scene"]["responses"] = []
    return _bump(work), {
        "paused": False,
        "receipt": "已恢复。从停下的地方重新开始，对方的反应重新判断。",
        "changed": True,
    }


def set_preferences(state, changes):
    """Style and simulation switches. Voice changes belong to the persona."""
    work = FA.working_copy(state)
    prefs = work["preferences"]
    receipts = []
    problems = []
    if "offscreen_simulation" in changes:
        value = bool(changes["offscreen_simulation"])
        prefs["offscreen_simulation"] = value
        suffix = "（离屏推演已停，世界冻结）" if not value else ""
        receipts.append("离屏推演：%s%s" % ("开" if value else "关", suffix))
    if "pace" in changes:
        if changes["pace"] not in ST.PACES:
            problems.append(detail("$.pace", "未知节奏：%s" % changes["pace"],
                                   "用 %s" % "、".join(ST.PACES), INVALID_INPUT))
        else:
            prefs["pace"] = changes["pace"]
            receipts.append("节奏：%s" % PACE_LABELS[changes["pace"]])
    if "explicitness" in changes:
        if changes["explicitness"] not in ST.EXPLICITNESS:
            problems.append(detail("$.explicitness", "未知尺度：%s" % changes["explicitness"],
                                   "用 %s" % "、".join(ST.EXPLICITNESS), INVALID_INPUT))
        else:
            prefs["explicitness"] = changes["explicitness"]
            receipts.append("尺度：%s" % EXPLICITNESS_LABELS[changes["explicitness"]])
    if problems:
        raise AppError(problems[0]["code"], problems[0]["reason"], problems)
    if not receipts:
        raise AppError(INVALID_INPUT, "没有要改的设置", [detail("$", "至少给一个设置", None, INVALID_INPUT)])
    return _bump(work), {
        "receipt": "；".join(receipts),
        "preferences": {k: prefs[k] for k in SHOWN_PREFERENCES},
        "changed": True,
    }
