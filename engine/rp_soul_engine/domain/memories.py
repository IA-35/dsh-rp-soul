"""Her memory: three layers that age with real time (after RimTalk-ExpandMemory).

    ABM   what just happened; does not decay, never enters the context (the
          conversation itself is already there). Up to twenty; past that, or
          after an hour of quiet, a subagent folds the batch into one SCM
          entry and ABM starts over empty. A passing action, never promoted,
          is dropped after 24 hours.
    SCM   the situation memory that outlives one conversation; decays 0.005
          per hour (about thirty days). Up to fifty; over fifty the least
          active go first. This is what gets recalled into the context, three
          to five entries at a time.
    日记  the diary: one file per day, written at 23:30 by a subagent from
          that day's SCM. It lives on disk, not in the state, and is never
          shown as a layer.
    CLPA  what she decided matters for good: no decay, no capacity, only you
          edit or delete them.

Activity follows ``activity *= 1 - rate`` every hour (RimTalk). Instead of
writing that back every hour, an entry keeps the activity it had when it was
last touched (``a0``) and when that was (``t0``, absolute minutes), and the
current value is computed on read: ``a0 * (1 - rate) ** hours``. Same numbers,
no per-turn rewrites, so undo, slots and exports stay consistent for free.

An entry below CLEAN_BELOW that is not pinned is forgotten. Pinned entries do
not decay, are never cleaned and never count against a layer's capacity.

Capture costs no model call: every committed turn leaves one entry in ABM
(her first-person ``remember`` line when the turn has one, else the summary),
an offscreen beat leaves an "experience", a minor action leaves an "action".
"""

import datetime
import math

from . import clock as CL
from .text import keywords, cue_keywords, KEYWORDS_MAX, KEYWORD_LEN

# 日记不在这里：它落盘成文件，不进 state
LAYERS = ("abm", "scm", "clpa")
LAYER_LABELS = {"abm": "ABM", "scm": "SCM", "clpa": "CLPA"}
DECAY = {"abm": 0.0, "scm": 0.005, "clpa": 0.0}
# None = unlimited: CLPA is only ever emptied by you
CAPACITY = {"abm": 20, "scm": 50, "clpa": None}
# 闲置这么久还没满，也要把 ABM 收成一条 SCM
ABM_IDLE_MINUTES = 60
# 日记是定时任务：每天这个点之后、且今天还没写过，才要一篇
DIARY_MINUTE = 23 * 60 + 30
NOW_LIFESPAN_MINUTES = 24 * 60
CLEAN_BELOW = 0.025
# 记得多清楚，四档。写进上下文时用它代替小数：模型读「有些模糊了」就够，
# 读 0.4317 只会让它把这个数当证据去推理。
# 边界取自 SCM 的衰减曲线：0.7 / 0.4 / 0.1 分别是 3 天、7.6 天、19 天。
CLEARNESS = ((0.7, "记忆犹新"), (0.4, "大概记得"), (0.1, "有些模糊了"), (0.0, "记不起来了"))
TYPES = ("conversation", "experience", "action", "summary")
# 留在 ABM 里过期后还要往下走的类型；动作类到期就丢（和 RimTalk 一样）
KEEPS = ("conversation", "experience")
CONTENT_MAX = 300
YOU_MAX = 60
# 一条 SCM 的正文长度（一批 ABM 合成一条）
SUMMARY_MAX = 300
# 一篇日记的正文长度
DIARY_MAX = 300


def entries(state):
    """Her memory entries, oldest first (the list lives in state["memory"])."""
    return state["memory"].setdefault("entries", [])


def normalize_legacy(state):
    """Old saves: the layer names changed, the entries move with them.

    now → abm, temp and days → scm (temp was the day's holding place, which SCM
    now is), events / years / chapter → clpa. The pending summary and journal
    requests are dropped: neither exists as a thing the model must write now.
    """
    memory = state.get("memory") or {}
    renamed = {"now": "abm", "temp": "scm", "days": "scm", "events": "clpa",
               "years": "clpa", "chapter": "clpa"}
    for entry in memory.get("entries") or []:
        entry["layer"] = renamed.get(entry.get("layer"), entry.get("layer"))
    requests = state.get("requests") or {}
    # 只清旧名字。memory_fold / memory_diary 是现在的请求，每次读存档都要留着，
    # 顺手 pop 掉的话「立即汇总」会在下一次 get-context 时凭空消失。
    for key in ("memory_summary", "memory_journal", "memory_archive"):
        requests.pop(key, None)
    for key in ("memory_fold", "memory_diary"):
        requests.setdefault(key, None)
    state["requests"] = requests
    return state


def of_layer(state, layer):
    return [e for e in entries(state) if e["layer"] == layer]


def activity(entry, now):
    """Current activity at absolute minute `now` (pinned and ABM do not decay)."""
    if entry.get("pinned") or entry["layer"] == "abm":
        return entry["a0"]
    hours = max(0, now - entry["t0"]) / 60.0
    return entry["a0"] * (1.0 - DECAY[entry["layer"]]) ** hours


def clearness(value):
    """How well she remembers something, in words."""
    for floor, name in CLEARNESS:
        if value >= floor:
            return name
    return CLEARNESS[-1][1]


def touch(entry, now, a0):
    entry["a0"] = round(a0, 6)
    entry["t0"] = now


def _next_id(state):
    counters = state["counters"]["next"]
    value = counters.get("memory", 1)
    counters["memory"] = value + 1
    return "m%d" % value


def add(state, layer, kind, content, importance, at=None, turn=None, **extra):
    """A new entry at full activity. Returns it."""
    now = CL.to_abs(state["clock"])
    at = dict(at or state["clock"])
    text = content.strip()[:CONTENT_MAX]
    entry = {
        "id": _next_id(state),
        "layer": layer,
        "type": kind,
        "content": text,
        "importance": round(max(0.0, min(1.0, importance)), 3),
        "a0": 1.0,
        "t0": now,
        "at": at,
        "turn": state["turn"] + 1 if turn is None else turn,
        "keywords": keywords(text),
        "origin_ids": [],
        "quotes": [],
        "you": "",
        "note": "",
        "pinned": False,
        "edited": False,
        "summarized": False,
    }
    entry.update(extra)
    entries(state).append(entry)
    return entry


# ---------------------------------------------------------------------------
# capture: what a committed turn leaves behind


def importance_of(ctx):
    """0.3 + the turn's emotional weight (|delta| of new thoughts / 30, up to 0.5)
    + 0.2 for a milestone. Her own measure, no model rating needed."""
    weight = 0
    for row in ctx.thoughts:
        thought = row.get("thought") if isinstance(row, dict) else None
        if thought:
            weight += abs(thought.get("delta") or 0)
    value = 0.3 + min(0.5, weight / 30.0)
    if _milestones(ctx):
        value += 0.2
    return min(1.0, value)


def _promises_with_player(ctx):
    player = ctx.state["player_id"]
    out = []
    for item in ctx.applied:
        if item.get("op") == "event_create" and item.get("kind") == "promise":
            event = ctx.state["events"].get(item.get("event_id")) or {}
            if player in (event.get("participants") or []):
                out.append(item["event_id"])
    return out


def _stage_moved(ctx):
    # REL.change 只在阶段真的变了时把这一对记进 stage_pairs
    return bool(ctx.stage_pairs)


def _milestones(ctx):
    """Which milestones this turn reaches: a stage advance, the first promise between you."""
    found = []
    if _stage_moved(ctx):
        found.append("stage")
    seen = ctx.state["counters"].get("milestones") or []
    if _promises_with_player(ctx) and "first_promise" not in seen:
        found.append("first_promise")
    return found


def capture(state, ctx, commit):
    """Leave this turn's entries in ABM. Returns the entries added."""
    added = []
    milestones = _milestones(ctx)
    content = (commit.get("remember") or "").strip() or commit["summary"]
    kind = "conversation" if ctx.together else "experience"
    main = add(
        state, "abm", kind, content, importance_of(ctx), turn=ctx.turn,
        quotes=list(commit.get("quotes") or [])[:3],
        you=(commit.get("player_input") or "").strip()[:YOU_MAX],
        remember=bool((commit.get("remember") or "").strip()),
    )
    added.append(main)
    # 这一轮的心事已经算进交账这条了，宿主之后记的条目别再算一遍
    weighed = state["counters"].setdefault("weighed_thoughts", [])
    for row in ctx.thoughts:
        thought = row.get("thought") if isinstance(row, dict) else None
        if thought and thought.get("id"):
            weighed.append("%s:%s" % (row.get("npc_id"), thought["id"]))
    del weighed[:-WEIGHED_KEEP]
    if milestones:
        main["pinned"] = True
        main["milestone"] = milestones
        seen = state["counters"].setdefault("milestones", [])
        for name in milestones:
            if name == "first_promise" and name not in seen:
                seen.append(name)
    for beat in ctx.beats:
        added.append(add(state, "abm", "experience", beat["summary"], 0.3, turn=ctx.turn))
    for item in ctx.applied:
        if item.get("op") == "npc_action" and not item.get("significant") and item.get("action"):
            added.append(add(state, "abm", "action", item["action"], 0.2, turn=ctx.turn))
    return added


SAID_MAX = 120
# 记住最近算过轻重的那些心事 id，够覆盖一小时里冒出来的就行
WEIGHED_KEEP = 50
REPLY_MAX = 120


def _said(text, limit):
    one = " ".join((text or "").split())
    return one if len(one) <= limit else one[: limit - 1] + "…"


def _exchange_importance(state):
    """宿主替她记的这一轮有多重：和交账那条同一把尺子（importance_of）。

    没有交账就没有这一轮的 ctx.thoughts，所以改看心情本身：最近一小时里冒出来、
    还没被哪一条记忆算过的事件型心事（memory 类；情境类的「在场」「很久没见你」
    每段都会刷新，不算），按 |delta| 加起来。
    「算过没有」按心事 id 记，不按时间比：宿主记的条目不推进时钟，同一分钟里
    记好几条是常事，按时间比会把同一份心情算进每一条。
    """
    now = CL.to_abs(state["clock"])
    weighed = state["counters"].setdefault("weighed_thoughts", [])
    weight = 0
    for cid, card in (state.get("characters") or {}).items():
        if cid == state.get("player_id"):
            continue
        for thought in ((card or {}).get("mood") or {}).get("thoughts") or []:
            key = "%s:%s" % (cid, thought.get("id"))
            if thought.get("kind") != "memory" or key in weighed:
                continue
            if (thought.get("since_abs") or 0) < now - ABM_IDLE_MINUTES:
                continue
            weight += abs(thought.get("delta") or 0)
            weighed.append(key)
    del weighed[:-WEIGHED_KEEP]
    return min(1.0, 0.3 + min(0.5, weight / 30.0))


def note_exchange(state, said, reply, turn=None, together=True, at=None):
    """A turn remembered straight from the exchange, without the model.

    RimTalk's rule: the memory comes from the event being intercepted, not from
    the model volunteering to write one down. So the host hands over what was
    actually said on both sides and this writes the ABM entry itself.

    Returns (entry, duplicate). A duplicate is the same exchange already noted
    (the host re-fires on a retried turn), and adds nothing.
    """
    said = _said(said, SAID_MAX)
    reply = _said(reply, REPLY_MAX)
    if not said and not reply:
        return None, False
    # 「你：… 她：…」：她说的话是这段记忆的主体，你的话是触发它的那半句
    if said and reply:
        content = "你：%s 她：%s" % (said, reply)
    else:
        content = said or reply
    for entry in entries(state):
        if entry["layer"] == "abm" and entry["type"] in KEEPS and entry["content"] == content:
            return entry, True
    entry = add(
        state, "abm", "conversation" if together else "experience", content, _exchange_importance(state),
        at=at, turn=turn,
        you=said[:YOU_MAX],
        exchanged=True,
    )
    return entry, False


# ---------------------------------------------------------------------------
# maintenance: once per commit, after capture


def abm_batch(state):
    """The ABM entries due to be folded into one SCM, or None.

    Two triggers, RimTalk's: the layer is full (twenty), or it has been quiet
    for an hour. A passing action is never part of a batch -- it either expired
    or it is still fresh, and it is not worth an SCU.
    """
    now = CL.to_abs(state["clock"])
    # 这一回合刚记下的那几条不算：一批是「之前说过的话」。把它们算进来的话，
    # 停一小时再开口时最新的一条正好是刚说的，闲置永远凑不满一小时。
    # 宿主替模型记的那几条（exchanged）不受这条限制：turn 只有 commit-turn
    # 会推进，它们全带着同一个 turn 号，按「本回合」排除的话永远收不进 SCM。
    waiting = [e for e in entries(state) if e["layer"] == "abm" and e["type"] in KEEPS
               and (e.get("exchanged") or e.get("turn") != state["turn"])]
    # 钉住的不占名额，但照样随这批一起收走（apply_fold 把它送进 CLPA）。
    # 判空要用 waiting 而不是 pool：只剩里程碑时也得按闲置收走，否则它们
    # 永远留在 ABM 里，而 maintain 又把 pinned 一律 keep，哪一层都不回收。
    pool = [e for e in waiting if not e.get("pinned")]
    if not waiting:
        return None
    idle = now - max(CL.to_abs(e["at"]) for e in waiting) >= ABM_IDLE_MINUTES
    if len(pool) < CAPACITY["abm"] and not idle:
        return None
    return {"ids": [e["id"] for e in sorted(waiting, key=lambda e: (CL.to_abs(e["at"]), _num(e)))]}


def maintain(state):
    """Forget the faded, enforce capacities, drop the expired actions.

    ABM is emptied by the fold, not here: a batch that is due stays untouched
    until apply_fold turns it into an SCM entry.
    Returns what went.
    """
    now = CL.to_abs(state["clock"])
    report = {"forgotten": [], "dropped": []}
    items = entries(state)
    keep = []
    for entry in items:
        if entry["layer"] != "abm":
            keep.append(entry)
            continue
        if entry["type"] in KEEPS or entry.get("pinned"):
            keep.append(entry)
        elif now - CL.to_abs(entry["at"]) >= NOW_LIFESPAN_MINUTES:
            # a passing action is dropped, never promoted
            report["dropped"].append(entry["id"])
        else:
            keep.append(entry)
    items[:] = keep
    # 动作类垫着 ABM 会让它胀过二十条：满的时候就先把最老的动作丢掉，
    # 应收的那批一条不动（它们等 fold）。
    limit_abm = CAPACITY["abm"]
    in_abm = [e for e in items if e["layer"] == "abm" and not e.get("pinned")]
    if len(in_abm) > limit_abm:
        spare = sorted([e for e in in_abm if e["type"] not in KEEPS],
                       key=lambda e: (CL.to_abs(e["at"]), _num(e)))
        for entry in spare[: len(in_abm) - limit_abm]:
            items.remove(entry)
            report["dropped"].append(entry["id"])
    # forgotten: SCM ages out; CLPA never fades, ABM is emptied by the fold
    faded = [e for e in items if e["layer"] == "scm" and not e.get("pinned")
             and activity(e, now) < CLEAN_BELOW]
    for entry in faded:
        items.remove(entry)
        report["forgotten"].append(entry["id"])
    # SCM over capacity: the least active goes
    limit = CAPACITY["scm"]
    pool = [e for e in items if e["layer"] == "scm" and not e.get("pinned")]
    pool.sort(key=lambda e: (activity(e, now), CL.to_abs(e["at"]), _num(e)))
    for entry in pool[: max(0, len(pool) - limit)]:
        items.remove(entry)
        report["forgotten"].append(entry["id"])
    return report


def _num(entry):
    return int(entry["id"][1:])


# ---------------------------------------------------------------------------
# folding: a batch of ABM becomes one SCM entry (the subagent writes the text);
# the diary is a file written at 23:30 from the day's SCM


def sources(state, request):
    """The entries a request names that still exist, oldest first."""
    wanted = set((request or {}).get("ids") or [])
    return [e for e in entries(state) if e["id"] in wanted]


def _merge(state, layer, kind, text, picked, turn):
    importance = sum(e["importance"] for e in picked) / len(picked) if picked else 0.5
    latest = max(picked, key=lambda e: (CL.to_abs(e["at"]), _num(e))) if picked else None
    entry = add(state, layer, kind, text, importance, at=latest["at"] if latest else None, turn=turn)
    merged = []
    for source in picked:
        merged.extend(source["keywords"])
    entry["keywords"] = list(dict.fromkeys(entry["keywords"] + merged))[:KEYWORDS_MAX]
    entry["origin_ids"] = [e["id"] for e in picked]
    return entry


def apply_fold(state, request, text, turn, keep=()):
    """A batch of ABM becomes one SCM entry; the batch is consumed.

    SCM is where a conversation outlives itself, so the entry keeps the time it
    happened: `at` is the batch's latest moment, and `when_label` turns that
    back into 「三小时前」 when it is recalled.

    `keep` names the 0~2 entries the subagent judged worth remembering for
    good: they are copied into CLPA before the batch is cleared. Pinned entries
    go there too -- a milestone must not depend on a model happening to name it.
    """
    picked = sources(state, request)
    for source in picked:
        if source["id"] in keep or source.get("pinned"):
            important = add(state, "clpa", source["type"], source["content"], source["importance"],
                            at=dict(source["at"]), turn=turn, pinned=bool(source.get("pinned")))
            important["keywords"] = list(source["keywords"])
            important["origin_ids"] = [source["id"]]
    entry = _merge(state, "scm", "summary", text, picked, turn)
    gone = set(e["id"] for e in picked)
    entries(state)[:] = [e for e in entries(state) if e["id"] not in gone]
    return entry


def manual_fold_request(state):
    """「立即汇总」: the whole ABM, without waiting for it to fill up or go quiet."""
    ids = [e["id"] for e in entries(state) if e["layer"] == "abm" and e["type"] in KEEPS
           and not e.get("pinned")]
    return {"ids": ids} if ids else None


def diary_sources(state):
    """The earliest day's SCM that the diary has not taken yet (no clock check).

    Not just today: if 23:30 passed while nobody was talking, the day it was
    due for is still owed, and writing it tomorrow must not lose it.
    """
    today = state["clock"]["day"]
    written = (state.get("counters") or {}).get("last_diary_day") or 0
    pool = [e for e in entries(state)
            if e["layer"] == "scm" and not e.get("pinned") and written < e["at"]["day"] <= today]
    if not pool:
        return None, []
    day = min(e["at"]["day"] for e in pool)
    return day, [e["id"] for e in sorted(pool, key=lambda e: (CL.to_abs(e["at"]), _num(e)))
                 if e["at"]["day"] == day]


def diary_request(state):
    """What the 23:30 diary still has to write, once per day.

    A scheduled task, not a nightly deadline the model owes on its first word:
    before 23:30 nothing is asked for, and a day already written is not asked
    for again even if later turns add more to it.
    """
    day, ids = diary_sources(state)
    if not ids:
        return None
    # 欠着昨天以前的，就是过了点没写成：什么时候想起来都该补。
    # 只看「当前是不是过了 23:30」的话，跨过午夜就永远补不上了。
    if day >= state["clock"]["day"] and state["clock"]["minute"] < DIARY_MINUTE:
        return None
    return {"day": day, "ids": ids}


def apply_diary(state, request, text):
    """Mark today's SCM as written into the diary; nothing is removed.

    The diary is a file, not a layer: SCM keeps what it has (it ages out on its
    own), and each entry only learns which day it was written down for, so the
    next 23:30 does not write the same day twice.
    """
    day = request["day"]
    written = []
    for entry in sources(state, request):
        entry["diary_day"] = day
        written.append(entry["id"])
    state["counters"]["last_diary_day"] = day
    # 最近一篇留在账本里：换了会话的第一轮要带上它（文件在盘上，引擎读快照时不翻盘）
    state["memory"]["diary_last"] = {"day": day, "text": text}
    return {"day": day, "text": text, "ids": written,
            "markdown": diary_markdown(state, text, day)}


def diary_markdown(state, text, day=None):
    """One day's diary, written the way she would keep one."""
    return "# %s\n\n%s\n" % (_day_text(state, day if day is not None else state["clock"]["day"]), text)


def day_label(state, day):
    """「第 3 天 · 周二」：日记的标题，也是注入时那篇日记的抬头。"""
    return _day_text(state, day)


def _day_text(state, day):
    weekday = _weekday(state, day)
    return "第 %d 天%s" % (day, " · " + weekday if weekday else "")


def find(state, memory_id):
    return next((e for e in entries(state) if e["id"] == memory_id), None)


def edit(state, memory_id, changes):
    """The settings page's edits, in place. Returns the entry or None.

    Changing what she remembers (content, importance, keywords) marks it as
    edited by you, which RimTalk scores higher; activity restarts its decay
    from the value you set; pinning freezes it where it is.
    """
    entry = find(state, memory_id)
    if entry is None:
        return None
    now = CL.to_abs(state["clock"])
    if changes.get("pinned") is not None and changes["pinned"] != entry.get("pinned"):
        # 取消 Pin 时从当前值接着衰减，钉上时把当前值冻住
        touch(entry, now, activity(entry, now))
        entry["pinned"] = changes["pinned"]
    # 只有真的改了「她记得什么」才算你改过（RimTalk 给改过的加分）；原样送回来的不算
    content = changes.get("content")
    if content is not None and content.strip()[:CONTENT_MAX] != entry["content"]:
        entry["content"] = content.strip()[:CONTENT_MAX]
        if changes.get("keywords") is None:
            entry["keywords"] = keywords(entry["content"])
        entry["edited"] = True
    importance = changes.get("importance")
    if importance is not None and round(max(0.0, min(1.0, importance)), 3) != entry["importance"]:
        entry["importance"] = round(max(0.0, min(1.0, importance)), 3)
        entry["edited"] = True
    if changes.get("keywords") is not None:
        wanted = list(dict.fromkeys(k.strip()[:KEYWORD_LEN] for k in changes["keywords"] if k.strip()))[:KEYWORDS_MAX]
        if wanted != entry["keywords"]:
            entry["keywords"] = wanted
            entry["edited"] = True
    if changes.get("activity") is not None and abs(changes["activity"] - activity(entry, now)) > 1e-6:
        touch(entry, now, max(0.0, min(1.0, changes["activity"])))
    if changes.get("note") is not None:
        entry["note"] = changes["note"]
    return entry


def remove(state, memory_id):
    entry = find(state, memory_id)
    if entry is not None:
        entries(state).remove(entry)
    return entry


def prune_requests(state):
    """Drop a pending fold / diary whose sources are all gone (deleted on the
    settings page), so nothing is written from an empty batch."""
    requests = state["requests"]
    for key in ("memory_fold", "memory_diary"):
        if requests.get(key) and not sources(state, requests[key]):
            requests[key] = None


BRIEF_SOURCES = 12
BRIEF_SOURCE_TEXT = 30


def request_view(state, request, compact=False):
    """What the model reads to write a fold or a diary: the sources, in order."""
    if not request:
        return None
    picked = sources(state, request)
    if compact:
        # brief 里一条一行「时间 · 内容」，截短
        shown = picked[-BRIEF_SOURCES:]
        out = {"sources": [
            "%s · %s" % (when_short(state, e["at"]),
                         e["content"] if len(e["content"]) <= BRIEF_SOURCE_TEXT else e["content"][:BRIEF_SOURCE_TEXT - 1] + "…")
            for e in shown
        ]}
    else:
        shown = picked
        out = {"sources": [{"id": e["id"], "when": when_short(state, e["at"]), "text": e["content"]} for e in shown]}
    if compact and len(shown) < len(picked):
        # brief 只有 6 KB：多的那些在 depth=full 里
        out["more"] = len(picked) - len(shown)
    if "day" in request:
        out["day"] = request["day"]
    return out


# ---------------------------------------------------------------------------
# injection: quota harvesting (RimTalk's UnifiedMemoryInjector + DynamicMemoryInjection)

# 只从 SCM 取几条最相关的。ABM 不注入：这段对话本身就在上下文里。
SCM_BRIEF = 3                   # brief 6 KB：三条
SCM_FULL = 5                    # 完整上下文：五条
THRESHOLD = 0.15                # memoryScoreThreshold
LAYER_BONUS = {"abm": 1.0, "scm": 0.85, "clpa": 0.5}
LAYER_WEIGHT = 0.2
PINNED_BONUS = 0.5
EDITED_BONUS = 0.3
ACTIVITY_WEIGHT = 0.1
RECALL_BOOST = 0.1
TEXT_MAX = 80
# 场景动态权重（SceneAnalyzer）：你在 = 社交场景；她一个人 = 普通场景
SCENES = {
    "together": {"time_decay": 0.05, "importance": 0.2, "keyword": 0.25, "window_days": 30},
    "alone": {"time_decay": 0.3, "importance": 0.3, "keyword": 0.35, "window_days": 3},
}




def _time_score(entry, now, scene):
    age = max(0, now - CL.to_abs(entry["at"])) / 1440.0
    if age > scene["window_days"]:
        return math.exp(-(age - scene["window_days"]) * 2.0) * 0.1
    return math.exp(-age * scene["time_decay"])


def _keyword_score(entry, cue_keys):
    if not cue_keys or not entry.get("keywords"):
        return 0.0
    mine, theirs = set(entry["keywords"]), set(cue_keys)
    jaccard = len(mine & theirs) / float(len(mine | theirs))
    contained = sum(0.2 for key in cue_keys if key in entry["content"])
    return min(1.0, jaccard + contained)


def score(entry, now, cue_keys, scene):
    weights = SCENES[scene]
    value = _time_score(entry, now, weights)
    value += entry["importance"] * weights["importance"]
    value += _keyword_score(entry, cue_keys) * weights["keyword"]
    value += LAYER_BONUS[entry["layer"]] * LAYER_WEIGHT
    if entry.get("pinned"):
        value += PINNED_BONUS
    if entry.get("edited"):
        value += EDITED_BONUS
    value += activity(entry, now) * ACTIVITY_WEIGHT
    return value


def select(state, cue="", total=SCM_BRIEF):
    """The SCM lines worth carrying into this turn, best first.

    ABM is not read here: whatever was just said is already in the conversation,
    so recalling it would only repeat the transcript. CLPA competes on the same
    scale but carries a small layer bonus, so a milestone beats a passing
    afternoon when the numbers are close.
    """
    now = CL.to_abs(state["clock"])
    scene = "together" if (cue or "").strip() else "alone"
    cue_keys = cue_keywords(state, cue)
    scored = []
    for entry in entries(state):
        if entry["layer"] == "abm" or entry["type"] == "action":
            continue
        # 快淡光的不提：光靠层级加分也过得了阈值，那样阈值就形同虚设
        if not entry.get("pinned") and activity(entry, now) < CLEAN_BELOW:
            continue
        value = score(entry, now, cue_keys, scene)
        if value >= THRESHOLD:
            scored.append((value, entry))
    scored.sort(key=lambda pair: (-pair[0], -CL.to_abs(pair[1]["at"]), -_num(pair[1])))
    return [entry for _value, entry in scored[: max(0, total)]]


def _clip(text):
    return text if len(text) <= TEXT_MAX else text[: TEXT_MAX - 1] + "…"


def inject(state, cue="", total=SCM_BRIEF):
    """What the context carries: a few recalled SCM / CLPA lines, each with its age.

    The age is the point: 「三天前」 and 「一小时前」 weigh differently to her, and
    a line with no time on it reads as if it happened just now.
    """
    now = CL.to_abs(state["clock"])
    rows = []
    for entry in select(state, cue, total):
        item = {
            "layer": LAYER_LABELS[entry["layer"]],
            "when": when_short(state, entry["at"]),
            "clear": clearness(activity(entry, now)),
            "text": _clip(entry["content"]),
        }
        if entry.get("pinned"):
            item["pinned"] = True
        # 真被你这句话勾起来的（关键词撞上了），快照只放这几条；
        # 只靠时间和层级凑进前几名的，留在 soul_state 里给模型自己翻。
        if cued_by_words(entry, cue):
            item["cued"] = True
        rows.append(item)
    return rows


def cued_by_words(entry, words):
    """Whether your own words touch this memory (a recall, not just a context slot)."""
    return bool(words) and _keyword_score(entry, keywords(words)) > 0


def reinforce(state, ids):
    """Recalled entries come back a little (from MemoryBank: what is thought of fades slower)."""
    now = CL.to_abs(state["clock"])
    wanted = set(ids)
    touched = []
    for entry in entries(state):
        if entry["id"] in wanted and entry["layer"] != "abm":
            touch(entry, now, min(1.0, activity(entry, now) + RECALL_BOOST))
            touched.append(entry["id"])
    return touched


# ---------------------------------------------------------------------------
# reading


def when_short(state, at):
    """Injected form: 周四下午 14:00 —— the weekday and the exact minute, no date.

    The entry itself already carries its day and minute; what the model needs is
    which day and which hour. 「周四下午」 alone is too coarse to be a moment, so
    the clock stays. Falls back to 今天/昨天 when an old save has no anchor.
    """
    weekday = _weekday(state, at["day"])
    clock = CL.hm(at["minute"])
    part = _part_of_day(at["minute"])
    head = weekday or _ago_head(state, at["day"])
    return "%s%s %s" % (head, part, clock)


def when_label(state, at):
    """Settings-page form: 10.29 周四 14:00 —— the date is there to sort by.

    Not 「三天前」 and not 「周四晚上」: the ledger runs on the minutes actually
    spent, so this moment exists on your clock too, and a memory stamped with
    the real date and minute is something that happened rather than a summary
    of roughly when. Falls back to the day count when an old save has no
    anchor to project onto the calendar.
    """
    weekday = _weekday(state, at["day"])
    clock = CL.hm(at["minute"])
    start = CL.parse_iso_loose(state.get("real_start"))
    if start is not None:
        date = start.date() + datetime.timedelta(days=at["day"] - 1)
        stamp = "%d.%d" % (date.month, date.day)
        return "%s %s %s" % (stamp, weekday, clock) if weekday else "%s %s" % (stamp, clock)
    head = weekday or _ago_head(state, at["day"])
    return "%s %s" % (head, clock)


def _ago_head(state, day):
    """No anchor (an old save): count back from now, the clock stays real."""
    ago = state["clock"]["day"] - day
    return {0: "今天", 1: "昨天", 2: "前天"}.get(ago, "%d 天前" % ago if ago > 0 else "今天")


def _part_of_day(minute):
    hour = minute // 60
    for upto, name in ((5, "凌晨"), (9, "早上"), (12, "上午"), (14, "中午"), (18, "下午"), (23, "晚上"), (24, "深夜")):
        if hour < upto:
            return name
    return "深夜"


WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def _weekday(state, day):
    start = CL.parse_iso_loose(state.get("real_start"))
    if start is None:
        return ""
    return WEEKDAYS[(start.weekday() + day - 1) % 7]


def row(state, entry, now=None):
    """The settings-page / debug view of one entry, with its live activity."""
    now = CL.to_abs(state["clock"]) if now is None else now
    out = {k: entry[k] for k in ("id", "layer", "type", "content", "importance", "pinned", "edited", "note", "turn")}
    out["layer_label"] = LAYER_LABELS[entry["layer"]]
    out["activity"] = round(activity(entry, now), 4)
    out["at"] = dict(entry["at"])
    out["when"] = when_label(state, entry["at"])
    out["keywords"] = list(entry["keywords"])
    out["origin_ids"] = list(entry.get("origin_ids") or [])
    if entry.get("quotes"):
        out["quotes"] = list(entry["quotes"])
    if entry.get("you"):
        out["you"] = entry["you"]
    if entry.get("milestone"):
        out["milestone"] = list(entry["milestone"])
    return out


def panel(state):
    """Every entry, newest first, grouped counts per layer."""
    now = CL.to_abs(state["clock"])
    rows = [row(state, e, now) for e in reversed(entries(state))]
    counts = {layer: sum(1 for e in entries(state) if e["layer"] == layer) for layer in LAYERS}
    return {"entries": rows, "counts": counts, "capacity": dict(CAPACITY), "layers": dict(LAYER_LABELS)}

