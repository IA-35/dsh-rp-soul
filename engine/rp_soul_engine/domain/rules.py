"""规则表：能从外部文件读的那部分「引擎自己算」的判断。

现在只有一张：情境类想法（``data/situational.json``）。它以前硬编码在
``domain/structure.py`` 里，加减一条都要改代码；外置之后，改数值、改时长、
关掉某条，都只动那个 JSON。

**条件本身仍然留在代码里**：``domain/mood.py`` 的 ``CONDITION`` 注册表把
id 映射到一个判定函数。理由是条件要读 state（在场、事件、张力、身体状态、
钟点），那不是数据能表达的；而数值、文案、时长、开关是数据。

读法：先读包内的默认表，再看数据目录下的 ``rules/situational.json``——
有就整张替换（不是逐条合并，避免「我明明删了一条它还在」）。文件坏了
不抛错，退回默认表并记一条警告，引擎不能因为规则文件写错就起不来。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(os.path.dirname(HERE), "data", "situational.json")

# 数据目录下的覆盖文件（由 application.context 在构造时登记）
OVERRIDE_SUBDIR = "rules"
OVERRIDE_NAME = "situational.json"

_override_dir = None
_cache = {"key": None, "rows": None, "warning": None}


def set_data_dir(data_dir):
    """登记数据目录，供覆盖文件查找。重复登记同一目录是幂等的。"""
    global _override_dir
    _override_dir = data_dir
    _cache["key"] = None


def override_path():
    if not _override_dir:
        return None
    path = os.path.join(_override_dir, OVERRIDE_SUBDIR, OVERRIDE_NAME)
    return path if os.path.exists(path) else None


def _read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _stamp(path):
    try:
        info = os.stat(path)
        return (path, int(info.st_mtime), info.st_size)
    except OSError:
        return (path, 0, 0)


def _normalize(raw, source):
    """把一条读数规整成内部形状；不合法就丢掉这条（不抛错）。"""
    if not isinstance(raw, dict):
        return None
    rid = str(raw.get("id") or "").strip()
    label = str(raw.get("label") or "").strip()
    if not rid or not label:
        return None
    try:
        delta = int(raw.get("delta", 0))
    except (TypeError, ValueError):
        return None
    minutes = raw.get("expires_minutes")
    if minutes is not None:
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            minutes = None
        else:
            if minutes <= 0:
                minutes = None
    return {
        "id": rid,
        "label": label,
        "delta": delta,
        "minutes": minutes,
        "enabled": bool(raw.get("enabled", True)),
        "note": str(raw.get("note") or ""),
        "source": source,
    }


def situational():
    """当前生效的情境规则，按文件里的顺序。返回 (rows, warning)。"""
    path = override_path() or DEFAULT_FILE
    key = _stamp(path)
    if _cache["key"] == key:
        return _cache["rows"], _cache["warning"]
    rows, warning = [], None
    try:
        data = _read(path)
        raw = data.get("thoughts") if isinstance(data, dict) else data
        for item in raw or ():
            one = _normalize(item, "override" if path != DEFAULT_FILE else "default")
            if one is not None and one["enabled"]:
                rows.append(one)
        if not rows:
            raise ValueError("规则表是空的")
    except (OSError, ValueError) as exc:
        # 覆盖文件坏了就退回默认表；默认表坏了就返回空表（她只是不因情境掉心情）。
        warning = "规则表读不出来，已退回默认：%s（%s）" % (path, exc)
        rows = []
        if path != DEFAULT_FILE:
            try:
                data = _read(DEFAULT_FILE)
                raw = data.get("thoughts") if isinstance(data, dict) else data
                for item in raw or ():
                    one = _normalize(item, "default")
                    if one is not None and one["enabled"]:
                        rows.append(one)
            except (OSError, ValueError):
                rows = []
    _cache.update({"key": key, "rows": rows, "warning": warning})
    return rows, warning


def reset():
    """测试用：丢掉缓存。"""
    _cache.update({"key": None, "rows": None, "warning": None})
