"""Export and import of a whole game.

An export file is the exchange format: the complete state (facts included),
the persona snapshot the game was opened with, and the archive, with a
sha256 over everything else so that truncation and damage are found on
import. Validation happens before anything is written.
"""

import hashlib
import os
import re
import time

from .. import ENGINE_VERSION, RNG_VERSION, SAVE_FORMAT, STATE_SCHEMA_VERSION, paths
from ..errors import CONTENT_ERROR, INVALID_INPUT, UNSUPPORTED_VERSION, AppError, detail, fail
from ..jsonio import canonical, decode_bytes, dumps, loads_strict

MAX_IMPORT_BYTES = 32 * 1024 * 1024
DOC_KEYS = ("format", "schema_version", "rng_version", "engine_version", "exported_at", "source", "session", "checksum")
SESSION_KEYS = ("state", "persona", "archive")

# The minimum a state must carry to be worth importing. Anything deeper is
# the domain's business; these keys are what every projection reads.
STATE_KEYS = (
    "schema",
    "seed",
    "persona_id",
    "persona_title",
    "persona_revision",
    "turn",
    "clock",
    "characters",
    "relationships",
    "events",
    "counters",
    "scene",
    "memory",
    "preferences",
    "safety",
    "requests",
)


def checksum(doc):
    body = {k: v for k, v in doc.items() if k != "checksum"}
    return "sha256:" + hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()


def build(state, persona, archive, source, exported_at):
    """The export document for a complete state (facts as a dict)."""
    doc = {
        "format": SAVE_FORMAT,
        "schema_version": STATE_SCHEMA_VERSION,
        "rng_version": RNG_VERSION,
        "engine_version": ENGINE_VERSION,
        "exported_at": exported_at,
        "source": source,
        "session": {"state": state, "persona": persona, "archive": archive},
    }
    doc["checksum"] = checksum(doc)
    return doc


# ---------------------------------------------------------------------------
# where an export goes


def _safe_stem(text):
    stem = re.sub(r"[\/:*?\"<>|\s]+", "-", text).strip("-.") or "export"
    return stem[:40]


def export_target(ctx, path, stem, overwrite):
    """exports/<stem>-<time>.json by default; a path the user gave must be an
    absolute .json path outside the plugin directory, with no '..' in it."""
    if path is None:
        directory = paths.exports_dir(ctx.data_dir)
        os.makedirs(directory, exist_ok=True)
        base = os.path.join(directory, "%s-%s" % (_safe_stem(stem), time.strftime("%Y%m%d-%H%M%S")))
        target = base + ".json"
        counter = 1
        while os.path.exists(target):
            counter += 1
            target = "%s-%d.json" % (base, counter)
        return target
    problems = []
    parts = re.split(r"[\/]+", path)
    if ".." in parts:
        problems.append(detail("$.path", "路径里不能有 ..", "给出完整的绝对路径", INVALID_INPUT))
    if not os.path.isabs(path):
        problems.append(detail("$.path", "导出路径必须是绝对路径", "例如 D:\\备份\\人设.json；不给路径时写到数据目录的 exports/", INVALID_INPUT))
    if not path.lower().endswith(".json"):
        problems.append(detail("$.path", "导出文件要以 .json 结尾", None, INVALID_INPUT))
    if problems:
        fail(problems)
    target = os.path.normpath(path)
    if paths.is_inside(target, ctx.engine_root):
        fail([detail("$.path", "不能导出到插件目录里", "升级会替换插件目录，文件会丢失", INVALID_INPUT)])
    if not os.path.isdir(os.path.dirname(target)):
        fail([detail("$.path", "目录不存在：%s" % os.path.dirname(target), "先建好目录，或不给路径（写到数据目录的 exports/）", INVALID_INPUT)])
    if os.path.isdir(target):
        fail([detail("$.path", "这是一个目录", None, INVALID_INPUT)])
    if os.path.exists(target) and not overwrite:
        fail([detail("$.path", "文件已存在：%s" % target, "问用户是否覆盖；确认后带 overwrite: true", INVALID_INPUT)])
    return target


def write_file(target, doc):
    data = dumps(doc).encode("utf-8")
    temp = "%s.tmp-%d" % (target, os.getpid())
    with open(temp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, target)
    return len(data)


# ---------------------------------------------------------------------------
# import


def read_source(payload):
    """(document, original bytes or None) from `data`."""
    return payload["data"], None


def _keys(obj, expected, path, problems):
    if not isinstance(obj, dict):
        problems.append(detail(path, "应为对象", None, INVALID_INPUT))
        return False
    ok = True
    for key in expected:
        if key not in obj:
            problems.append(detail("%s.%s" % (path, key), "缺少字段", None, INVALID_INPUT))
            ok = False
    for key in obj:
        if key not in expected:
            problems.append(detail("%s.%s" % (path, key), "未知字段", None, INVALID_INPUT))
            ok = False
    return ok


def check(doc):
    """Validate an export document. Returns (state, persona, archive) or
    raises AppError with every problem found."""
    problems = []
    if not _keys(doc, DOC_KEYS, "$", problems):
        fail(problems, "导入文件缺少必要的部分或带了未知字段")
    if doc["format"] != SAVE_FORMAT:
        fail([detail("$.format", "不是 rp-soul 引擎的导出文件", None, INVALID_INPUT)])
    version = doc["schema_version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        fail([detail("$.schema_version", "版本号非法", None, INVALID_INPUT)])
    if version > STATE_SCHEMA_VERSION:
        raise AppError(
            UNSUPPORTED_VERSION,
            "这个导出文件来自更新版本的引擎（格式 %d > %d）" % (version, STATE_SCHEMA_VERSION),
            [detail("$.schema_version", "格式 %d 比当前支持的 %d 新" % (version, STATE_SCHEMA_VERSION), "升级插件后再导入；没有写入任何数据", UNSUPPORTED_VERSION)],
        )
    if doc["rng_version"] != RNG_VERSION:
        raise AppError(
            UNSUPPORTED_VERSION,
            "随机算法版本不同（%s，本版本 %d），导入后无法复现同样的结果" % (doc["rng_version"], RNG_VERSION),
            [detail("$.rng_version", "随机算法版本不受支持", "用相同版本的插件导入", UNSUPPORTED_VERSION)],
        )
    if doc["checksum"] != checksum(doc):
        fail([detail("$.checksum", "校验值不符：文件被改动过或已损坏", "请重新导出；没有写入任何数据", INVALID_INPUT)])
    session = doc["session"]
    if not _keys(session, SESSION_KEYS, "$.session", problems):
        fail(problems)
    state, persona, archive = session["state"], session["persona"], session["archive"]
    problems.extend(_state_problems(state))
    problems.extend(_persona_problems(persona))
    problems.extend(_archive_problems(archive))
    if problems:
        fail(problems, "导入文件有 %d 处问题，没有写入任何数据" % len(problems) if len(problems) > 1 else None)
    return state, persona, archive


def _state_problems(state):
    problems = []
    if not isinstance(state, dict):
        return [detail("$.session.state", "应为对象", None, INVALID_INPUT)]
    for key in STATE_KEYS:
        if key not in state:
            problems.append(detail("$.session.state.%s" % key, "缺少字段", None, INVALID_INPUT))
    if problems:
        return problems
    if state["schema"] != STATE_SCHEMA_VERSION:
        problems.append(detail("$.session.state.schema", "状态版本 %r 不是 %d" % (state["schema"], STATE_SCHEMA_VERSION),
                               "导出文件与引擎版本不一致", UNSUPPORTED_VERSION))
    # Turn 0 is the opening: a save taken before the first commit is legitimate.
    if not isinstance(state["turn"], int) or state["turn"] < 0:
        problems.append(detail("$.session.state.turn", "回合号非法", None, INVALID_INPUT))
    if not isinstance(state["characters"], dict) or not state["characters"]:
        problems.append(detail("$.session.state.characters", "角色表为空或格式不对", None, INVALID_INPUT))
    if not isinstance(state.get("facts"), dict):
        problems.append(detail("$.session.state.facts", "facts 应是对象（id -> fact）", None, INVALID_INPUT))
    for fid, fact in (state.get("facts") or {}).items():
        if not isinstance(fact, dict) or fact.get("id") != fid:
            problems.append(detail("$.session.state.facts.%s" % fid, "fact 的 id 与键不一致", None, INVALID_INPUT))
            break
    clock = state["clock"]
    if not isinstance(clock, dict) or not isinstance(clock.get("minute"), int):
        problems.append(detail("$.session.state.clock", "时钟格式不对", None, INVALID_INPUT))

    if not isinstance(clock.get("labels"), (dict, type(None))):
        problems.append(detail("$.session.state.clock.labels", "labels 格式不对", None, INVALID_INPUT))
    return problems


def _persona_problems(persona):
    problems = []
    if not isinstance(persona, dict):
        return problems
    # The persona travels with the save so a file can be read on a machine that
    # never saw the markdown: everything the engine reads back must be present.
    for key in ("id", "title", "revision", "name", "prose", "mood_thresholds"):
        if key not in persona:
            problems.append(detail("$.session.persona.%s" % key, "缺少字段", None, CONTENT_ERROR))
    return problems


def _archive_problems(archive):
    problems = []
    if not isinstance(archive, list):
        return problems
    for index, item in enumerate(archive):
        path = "$.session.archive[%d]" % index
        if not isinstance(item, dict):
            problems.append(detail(path, "应为对象", None, INVALID_INPUT))
            break
        for key in ("kind", "turn", "payload"):
            if key not in item:
                problems.append(detail(path + "." + key, "缺少字段", None, INVALID_INPUT))
    return problems
