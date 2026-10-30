"""常识库：一堆「关键词 → 一条常识」，全局共享，不属于任何一局。

一条的形状：

    {"id": "c1", "key": ["deepseek", "ds"], "weight": 0.8,
     "content": "deepseek 是深度求索旗下的大语言模型。", "turn": 3, "at": null,
     "origin": "manual"}

`weight` 只在同一句话命中多条时用来排序：说了「DS 给我写个关于米饭的代码」，
命中两条就按权重从高到低排。没有命中的不注入 —— 这一层不是背景知识，是查表。

这里只用纯函数：落库在 persistence.repo，读出来传进 select()。
"""

from ..jsonio import copy

KEY_MAX = 24
KEYS_MAX = 12
CONTENT_MAX = 200
WEIGHT_RANGE = (0.0, 1.0)
# 注入几条：设置页可以改，默认这个
LIMIT_DEFAULT = 4
LIMIT_RANGE = (2, 4)
ORIGINS = ("manual", "fold", "diary")


def _order(entry):
    return int(entry["id"][1:])


def normalize_keys(keys):
    """关键词统一小写、去空白、去重，保持顺序。"""
    seen = []
    for key in keys or []:
        text = str(key).strip().lower()
        if text and text not in seen:
            seen.append(text)
    return seen


def make(fid, keys, weight, content, turn=None, at=None, origin="manual"):
    return {
        "id": fid,
        "key": normalize_keys(keys),
        "weight": round(float(weight), 2),
        "content": str(content).strip(),
        "turn": turn,
        "at": at,
        "origin": origin,
        # 你在设置页手动加的直接生效；模型提的要等你点「确认」
        "pending": False,
    }


def hits(entry, cue):
    """这条常识被这句话触发了吗：任何一个关键词出现在话里就算触发。

    「ds」这种两字母关键词在中文里很容易误撞，所以要求关键词是独立的
    一段：英文和数字按词边界比，中文按子串比。
    """
    text = str(cue or "").lower()
    if not text:
        return False
    for key in entry["key"]:
        if key.isascii():
            start = text.find(key)
            while start != -1:
                before = text[start - 1] if start > 0 else ""
                after = text[start + len(key)] if start + len(key) < len(text) else ""
                if not (before.isalnum() or after.isalnum()):
                    return True
                start = text.find(key, start + 1)
        elif key in text:
            return True
    return False


def select(rows, cue, limit=LIMIT_DEFAULT):
    """命中的常识，权重高的在前，最多 limit 条。

    权重相同就看谁说得多：同一个关键词下，比它更具体的那条更容易被想起来，
    所以关键词多的排前面。
    """
    found = [e for e in rows if not e.get("pending") and hits(e, cue)]
    found.sort(key=lambda e: (-e["weight"], -len(e["key"]), _order(e)))
    return found[: max(1, int(limit))]


def render(entries, cue):
    """渲染成一段 —— 没有命中就是空字符串，不占上下文。

    冒号前放这句里真正触发的那个关键词，模型才知道这条常识是怎么被想起来的。
    """
    if not entries:
        return ""
    lines = ["### 常识"]
    for entry in entries:
        key = next((k for k in entry["key"] if k in str(cue or "").lower()), entry["key"][0])
        lines.append("- %s： %s" % (key, entry["content"]))
    return "\n".join(lines)


def limit_of(value):
    """设置页给的条数；越界就夹到允许范围里。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return LIMIT_DEFAULT
    low, high = LIMIT_RANGE
    return max(low, min(high, number))


def from_model(raw, turn, at=None, origin="fold"):
    """模型在总结 / 写日记时顺带提到的一条常识。字段缺了就当没提。"""
    if not isinstance(raw, dict):
        return None
    keys = normalize_keys(raw.get("key") or raw.get("keys") or [])
    content = str(raw.get("content") or "").strip()
    if not keys or not content:
        return None
    try:
        weight = float(raw.get("weight", 0.5))
    except (TypeError, ValueError):
        weight = 0.5
    low, high = WEIGHT_RANGE
    weight = max(low, min(high, weight))
    return {"key": keys, "weight": round(weight, 2), "content": content[:CONTENT_MAX], "turn": turn, "at": at, "origin": origin,
            "pending": True}


def merge(rows, fresh, next_id):
    """把模型提到的新常识并进库里，一律挂起等你确认。

    关键词完全相同的当成同一条：还挂着的就用新说法覆盖；你已经确认过（或
    手动加）的不动 —— 模型不能改掉你点过头的东西。
    返回 (新的库, 改动过的 id 列表)。
    """
    rows = [copy(e) for e in rows]
    touched = []
    for item in fresh:
        same = next((e for e in rows if set(e["key"]) == set(item["key"])), None)
        if same is not None and not same.get("pending"):
            continue
        if same is not None:
            same.update({"weight": item["weight"], "content": item["content"], "turn": item["turn"], "at": item["at"], "origin": item["origin"]})
            touched.append(same["id"])
            continue
        rows.append(dict(item, id=next_id(rows)))
        touched.append(rows[-1]["id"])
    return rows, touched


def next_id(rows):
    biggest = max([_order(e) for e in rows], default=0)
    return "c%d" % (biggest + 1)


def panel(rows, limit=LIMIT_DEFAULT):
    return {
        "count": len(rows),
        "pending": sum(1 for e in rows if e.get("pending")),
        "limit": limit,
        "rows": sorted(rows, key=_order),
    }
