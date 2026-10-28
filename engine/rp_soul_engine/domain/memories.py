"""Her memory: four layers that age with real time (after RimTalk-ExpandMemory).

    刚刚 now     what just happened; does not decay. Up to ten; over ten the
                 oldest are archived, as they are, into 今日. A passing action,
                 never promoted, is dropped after 24 hours.
    今日 temp    the short-term archive: 刚刚's overflow, verbatim, in order.
                 Does not decay. The next day's daily summary reads all of it
                 (and whatever is still in 刚刚) and folds it into 这几天.
    这几天 days  the last month of her life; decays 0.005 per hour (about
                 thirty days to forget). Over thirty, the month is written out
                 to a journal file and the layer starts empty again.
    那些事 events what mattered enough to keep: no decay, no capacity, only
                 you delete them.

Activity follows ``activity *= 1 - rate`` every hour (RimTalk). Instead of
writing that back every hour, an entry keeps the activity it had when it was
last touched (``a0``) and when that was (``t0``, absolute minutes), and the
current value is computed on read: ``a0 * (1 - rate) ** hours``. Same numbers,
no per-turn rewrites, so undo, slots and exports stay consistent for free.

An entry below CLEAN_BELOW that is not pinned is forgotten. Pinned entries do
not decay, are never cleaned and never count against a layer's capacity.

Capture costs no model call: every committed turn leaves one entry in 刚刚
(her first-person ``remember`` line when the turn has one, else the summary),
an offscreen beat leaves an "experience", a minor action leaves an "action".
"""

import math

from . import clock as CL
from .text import keywords, cue_keywords, KEYWORDS_MAX, KEYWORD_LEN

LAYERS = ("now", "temp", "days", "events")
LAYER_LABELS = {"now": "刚刚", "temp": "今日", "days": "这几天", "events": "那些事"}
DECAY = {"now": 0.0, "temp": 0.0, "days": 0.005, "events": 0.0}
# None = unlimited: 那些事 is only ever emptied by you
CAPACITY = {"now": 10, "temp": 200, "days": 30, "events": None}
NOW_LIFESPAN_MINUTES = 24 * 60
CLEAN_BELOW = 0.025
TYPES = ("conversation", "experience", "action", "summary")
# 留在「刚刚」里过期后还要往下走的类型；动作类到期就丢（和 RimTalk 一样）
KEEPS = ("conversation", "experience")
CONTENT_MAX = 300
YOU_MAX = 60
# 每日总结的正文长度
SUMMARY_MAX = 100


def entries(state):
    """Her memory entries, oldest first (the list lives in state["memory"])."""
    return state["memory"].setdefault("entries", [])


def normalize_legacy(state):
    """Old saves: 那些年 is gone, and the monthly request is no longer an archive."""
    memory = state.get("memory") or {}
    for entry in memory.get("entries") or []:
        if entry.get("layer") in ("years", "chapter"):
            entry["layer"] = "events"
    requests = state.get("requests") or {}
    if "memory_archive" in requests:
        requests["memory_journal"] = requests.pop("memory_archive")
    return state


def of_layer(state, layer):
    return [e for e in entries(state) if e["layer"] == layer]


def activity(entry, now):
    """Current activity at absolute minute `now` (pinned and 刚刚 do not decay)."""
    if entry.get("pinned") or entry["layer"] == "now":
        return entry["a0"]
    hours = max(0, now - entry["t0"]) / 60.0
    return entry["a0"] * (1.0 - DECAY[entry["layer"]]) ** hours


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
    """Leave this turn's entries in 刚刚. Returns the entries added."""
    added = []
    milestones = _milestones(ctx)
    content = (commit.get("remember") or "").strip() or commit["summary"]
    kind = "conversation" if ctx.together else "experience"
    main = add(
        state, "now", kind, content, importance_of(ctx), turn=ctx.turn,
        quotes=list(commit.get("quotes") or [])[:3],
        you=(commit.get("player_input") or "").strip()[:YOU_MAX],
        remember=bool((commit.get("remember") or "").strip()),
    )
    added.append(main)
    if milestones:
        main["pinned"] = True
        main["milestone"] = milestones
        seen = state["counters"].setdefault("milestones", [])
        for name in milestones:
            if name == "first_promise" and name not in seen:
                seen.append(name)
    for beat in ctx.beats:
        added.append(add(state, "now", "experience", beat["summary"], 0.3, turn=ctx.turn))
    for item in ctx.applied:
        if item.get("op") == "npc_action" and not item.get("significant") and item.get("action"):
            added.append(add(state, "now", "action", item["action"], 0.2, turn=ctx.turn))
    return added


# ---------------------------------------------------------------------------
# maintenance: once per commit, after capture


def _awaiting_summary(entry):
    """A conversation or experience of 刚刚 / 今日 / 这几天 no daily summary has covered yet.

    RimTalk summarises every in-game day on the hour, so 这几天 never fades
    before its day is written down. Here the summary waits for the next commit,
    which may come days later: until its day is summarised such an entry is
    neither forgotten nor pushed out by capacity, or a long absence would erase
    the day before you left without a trace.
    """
    if entry["layer"] == "temp":
        return not entry.get("summarized")
    return entry["layer"] in ("now", "days") and entry["type"] in KEEPS and not entry.get("summarized")


def _archive(state, picked):
    """The oldest 刚刚 lines move into 今日 one by one, exactly as they are.

    Nothing is merged and no model is asked: 今日 is only a holding place until
    the next day's daily summary reads the whole day at once.
    """
    for entry in picked:
        entry["layer"] = "temp"
    return picked


def maintain(state):
    """Hand this stretch of 刚刚 to 今日, forget the faded, enforce capacities.

    Returns what moved/went.
    """
    now = CL.to_abs(state["clock"])
    report = {"moved": [], "forgotten": [], "dropped": [], "archived": []}
    items = entries(state)
    keep = []
    for entry in items:
        if entry["layer"] != "now":
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
    # 刚刚 是「这一段相处里的」，不是「最近十条」：开了新的一段（隔了一小时
    # 以上，或者换了场景），上一段说的整体挪进今日。Pin 住的不动。
    since = CL.to_abs(state["scene"]["since"]) if state.get("scene") else None
    # 迁移来的旧存档时钟可能退到 scene.since 之前；那种时候整段都算「这一段」，
    # 不能凭 «at < since» 把刚拿到的对话全推走。
    if since is not None and since <= now:
        stale = [
            e
            for e in items
            if e["layer"] == "now"
            and not e.get("pinned")
            and e["type"] in KEEPS
            and CL.to_abs(e["at"]) < since
        ]
        if stale:
            _archive(state, stale)
            report["archived"].extend(e["id"] for e in stale)
    # 这一段里说得再多，也最多留十条（token 预算）：最老的挪进今日
    current = [e for e in items if e["layer"] == "now" and not e.get("pinned") and e["type"] in KEEPS]
    current.sort(key=lambda e: (CL.to_abs(e["at"]), _num(e)))
    spill = current[: max(0, len(current) - CAPACITY["now"])]
    if spill:
        _archive(state, spill)
        report["archived"].extend(e["id"] for e in spill)
    # forgotten (not before its day is summarised; 那些事 never fades)
    faded = [e for e in items if e["layer"] in ("days",) and not e.get("pinned") and not _awaiting_summary(e)
             and activity(e, now) < CLEAN_BELOW]
    for entry in faded:
        items.remove(entry)
        report["forgotten"].append(entry["id"])
    # 今日 / 这几天 over capacity: the least active goes (not what awaits its summary)
    for layer in ("temp", "days"):
        limit = CAPACITY[layer]
        if limit is None:
            continue
        pool = [e for e in items if e["layer"] == layer and not e.get("pinned") and not _awaiting_summary(e)]
        counted = sum(1 for e in items if e["layer"] == layer and not e.get("pinned"))
        pool.sort(key=lambda e: (activity(e, now), CL.to_abs(e["at"]), _num(e)))
        for entry in pool[: max(0, counted - limit)]:
            items.remove(entry)
            report["forgotten"].append(entry["id"])
    return report


def _num(entry):
    return int(entry["id"][1:])


# ---------------------------------------------------------------------------
# daily summary: today's 刚刚 + 今日 fold into one 这几天 line, and the day is
# written into the journal file


ARCHIVE_MAX = 300
# 跨过午夜后，最近这一小时说的话仍留在「刚刚」：醒来交昨天的总结时，
# 刚才的对话不该被并进一句摘要、也不该从「最近几轮原话」里消失
RECENT_KEEP_MINUTES = 60


def summary_request(state):
    """The oldest complete day with unsummarised 刚刚/今日 conversations, or None.

    "Complete" is a day before today: RimTalk groups by the oldest finished
    period, so a day still going on is never summarised half-way. What was said
    in the last hour stays in 刚刚 even across midnight, so the recent rounds
    the model reads are not cut off by the clock turning over.
    """
    today = state["clock"]["day"]
    now = CL.to_abs(state["clock"])
    days = {}
    for entry in entries(state):
        if entry["layer"] in ("now", "temp") and not entry.get("summarized") and entry["at"]["day"] < today                 and (entry["layer"] == "temp" or entry["type"] in KEEPS):
            if now - CL.to_abs(entry["at"]) < RECENT_KEEP_MINUTES:
                continue
            days.setdefault(entry["at"]["day"], []).append(entry["id"])
    if not days:
        return None
    day = min(days)
    return {"day": day, "ids": days[day]}


def archive_request(state):
    """这几天 is full: the whole month goes into the journal file and is cleared."""
    ids = [e["id"] for e in entries(state) if e["layer"] == "days"]
    if len(ids) < CAPACITY["days"]:
        return None
    return {"ids": ids}


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


def apply_summary(state, request, text, turn, keep=()):
    """One day of 刚刚/今日 becomes one 这几天 entry; the sources are consumed.

    `keep` names the 0~2 entries the model judged worth remembering for good:
    they are copied into 那些事 before the day is folded away. Pinned entries
    go there too: a milestone must not depend on the model happening to name it.
    """
    picked = sources(state, request)
    for source in picked:
        if source["id"] in keep or source.get("pinned"):
            important = add(state, "events", source["type"], source["content"], source["importance"],
                            at=dict(source["at"]), turn=turn, pinned=bool(source.get("pinned")))
            important["keywords"] = list(source["keywords"])
            important["origin_ids"] = [source["id"]]
    entry = _merge(state, "days", "summary", text, picked, turn)
    gone = set(e["id"] for e in picked)
    entries(state)[:] = [e for e in entries(state) if e["id"] not in gone]
    return entry


def apply_archive(state, request, text, turn):
    """The month's 这几天 become one journal file; the entries are cleared.

    Nothing new is added to memory: the written file is the record, and 这几天
    starts over from empty. The returned `lines` are what the file is built from.
    """
    picked = [e for e in sources(state, request) if e["layer"] == "days"]
    lines = [{"day": e["at"]["day"], "text": e["content"]} for e in sorted(picked, key=lambda e: (CL.to_abs(e["at"]), _num(e)))]
    gone = set(e["id"] for e in picked)
    entries(state)[:] = [e for e in entries(state) if e["id"] not in gone]
    return {"gone": sorted(gone), "text": text, "lines": lines, "day": state["clock"]["day"]}


def journal_markdown(state, text, lines):
    """One month's 这几天 written the way she would keep a diary."""
    first, last = lines[0]["day"], lines[-1]["day"]
    body = ["# %s" % text, "", "> %s — %s" % (_day_text(state, first), _day_text(state, last)), ""]
    body.extend("- **%s** %s" % (_day_text(state, line["day"]), line["text"]) for line in lines)
    return "\n".join(body) + "\n"


def _day_text(state, day):
    weekday = _weekday(state, day)
    return "第 %d 天%s" % (day, " · " + weekday if weekday else "")


def manual_summary_request(state):
    """「立即总结」: everything not yet summarised in 刚刚 / 今日, today included."""
    ids = [e["id"] for e in entries(state) if e["layer"] in ("now", "temp") and not e.get("summarized")
           and (e["layer"] == "temp" or e["type"] in KEEPS)]
    return {"day": state["clock"]["day"], "ids": ids} if ids else None


def manual_journal_request(state):
    """「立即归档」: every summarised 这几天 entry, without waiting to fill up."""
    ids = [e["id"] for e in entries(state) if e["layer"] == "days"]
    return {"ids": ids} if ids else None


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
    """Drop a pending summary / journal whose sources are all gone (deleted on
    the settings page), so the model is never asked to write one from nothing."""
    requests = state["requests"]
    if requests.get("memory_summary") and not sources(state, requests["memory_summary"]):
        requests["memory_summary"] = None
    journal = requests.get("memory_journal")
    if journal and not [e for e in sources(state, journal) if e["layer"] == "days"]:
        requests["memory_journal"] = None


BRIEF_SOURCES = 12
BRIEF_SOURCE_TEXT = 30


def request_view(state, request, compact=False):
    """What the model reads to write a summary or archive: the sources, in order."""
    if not request:
        return None
    picked = sources(state, request)
    if compact:
        # brief 里一条一行「时间 · 内容」，截短
        shown = picked[-BRIEF_SOURCES:]
        out = {"sources": [
            "%s · %s" % (when_label(state, e["at"]),
                         e["content"] if len(e["content"]) <= BRIEF_SOURCE_TEXT else e["content"][:BRIEF_SOURCE_TEXT - 1] + "…")
            for e in shown
        ]}
    else:
        shown = picked
        out = {"sources": [{"id": e["id"], "when": when_label(state, e["at"]), "text": e["content"]} for e in shown]}
    if compact and len(shown) < len(picked):
        # brief 只有 6 KB：多的那些在 depth=full 里
        out["more"] = len(picked) - len(shown)
    if "day" in request:
        out["day"] = request["day"]
    return out


# ---------------------------------------------------------------------------
# injection: quota harvesting (RimTalk's UnifiedMemoryInjector + DynamicMemoryInjection)

# 刚刚整层原样放（十轮），其余全从所有层里打分取
ROUNDS = CAPACITY["now"]
TOTAL_BRIEF = 15                # brief 6 KB：刚刚十条 + 打分补五条
TOTAL_FULL = 20                 # maxInjectedMemories
THRESHOLD = 0.15                # memoryScoreThreshold
LAYER_BONUS = {"now": 1.0, "temp": 0.85, "days": 0.7, "events": 0.5}
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


def recent_rounds(state, count=ROUNDS):
    """The latest conversations / experiences still in 刚刚, newest first."""
    pool = [e for e in entries(state) if e["layer"] == "now" and e["type"] in KEEPS]
    pool.sort(key=lambda e: (CL.to_abs(e["at"]), _num(e)), reverse=True)
    return pool[:count]


def select(state, cue="", total=TOTAL_BRIEF):
    """(rounds, picked): the recent rounds as they are, then the best-scored of the rest."""
    now = CL.to_abs(state["clock"])
    scene = "together" if (cue or "").strip() else "alone"
    rounds = recent_rounds(state)
    taken = set(e["id"] for e in rounds)
    cue_keys = cue_keywords(state, cue)
    scored = []
    for entry in entries(state):
        if entry["id"] in taken or entry["type"] == "action":
            continue
        value = score(entry, now, cue_keys, scene)
        if value >= THRESHOLD:
            scored.append((value, entry))
    scored.sort(key=lambda pair: (-pair[0], -CL.to_abs(pair[1]["at"]), -_num(pair[1])))
    return rounds, [entry for _value, entry in scored[: max(0, total - len(rounds))]]


def _clip(text):
    return text if len(text) <= TEXT_MAX else text[: TEXT_MAX - 1] + "…"


def inject(state, cue="", total=TOTAL_BRIEF):
    """What the context carries: the rounds (with your words and her quotes), then the recalled."""
    rounds, picked = select(state, cue, total)
    rows = []
    for entry in rounds + picked:
        item = {"layer": LAYER_LABELS[entry["layer"]], "when": when_label(state, entry["at"]), "text": _clip(entry["content"])}
        if entry in rounds:
            if entry.get("you"):
                item["you"] = entry["you"]
            if entry.get("quotes"):
                item["said"] = list(entry["quotes"])
        if entry.get("pinned"):
            item["pinned"] = True
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
        if entry["id"] in wanted and entry["layer"] != "now":
            touch(entry, now, min(1.0, activity(entry, now) + RECALL_BOOST))
            touched.append(entry["id"])
    return touched


# ---------------------------------------------------------------------------
# reading


def when_label(state, at):
    """Life-like time: 今天 / 昨天 / 前天 / N 天前, plus the weekday and the time of day."""
    today = state["clock"]["day"]
    ago = today - at["day"]
    head = {0: "今天", 1: "昨天", 2: "前天"}.get(ago, "%d 天前" % ago if ago > 0 else "今天")
    weekday = _weekday(state, at["day"])
    return "%s · %s%s" % (head, weekday, _part_of_day(at["minute"]))


WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def _weekday(state, day):
    start = CL.parse_iso(state.get("real_start"))
    if start is None:
        return ""
    return WEEKDAYS[(start.weekday() + day - 1) % 7]


def _part_of_day(minute):
    hour = minute // 60
    for upto, name in ((5, "凌晨"), (9, "早上"), (12, "上午"), (14, "中午"), (18, "下午"), (23, "晚上"), (24, "深夜")):
        if hour < upto:
            return name
    return "深夜"


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

