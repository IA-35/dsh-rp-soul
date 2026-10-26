"""Operations the model submits, each validated before it can change anything.

The shape is unchanged from the engine this was ported from: one spec table
for validation and documentation, one handler table, and a per-commit
TurnContext holding the bookkeeping nobody should have to remember.

Two things are new for the single-persona scenario:

* ``relationship`` now leaves a *mood* mark. The trust ledger answers "how
  does he judge me long term"; the mood bar answers "how is he right now".
  ``npc_response`` does not: his own choice of reply is not something done to
  him, and letting a refusal sink his own mood made low -> refuse -> lower
  slide straight into the break band.
* ``add_thought`` exists at all because the model occasionally knows about a
  sting the engine cannot derive (a name dropped in passing). It must name the
  fact it came from, so the settings page can show where a feeling came from
  and the user can delete it.

Handlers collect every problem for their operation and only then mutate, so a
rejected commit never leaves half a change behind.
"""

from .. import schema as S
from ..errors import INVARIANT_VIOLATION, INVALID_INPUT, NOT_FOUND, SAFETY_BLOCK, detail
from . import clock as CL
from . import agency as AG
from . import facts as FA
from . import mood as MO
from . import relationship as REL
from . import rng
from . import settlement
from . import simulation
from . import state as SS
from . import structure as ST

F = S.Field
FACT_KEY = S.Str(1, 80, r"[a-z0-9_]+(\.[a-z0-9_#]+){0,5}", "点分的 ASCII 小写键，例如 lin_wan.secret.press")
CLOCK = S.Obj({"day": F(S.Int(1, 100000)), "minute": F(S.Int(0, 1439))}, name="游戏时钟")
CONDITION = S.Obj(
    {
        "kind": F(S.Enum(*ST.CONDITION_KINDS)),
        "text": F(S.Str(1, 40)),
        "minutes": F(S.Nullable(S.Int(1, ST.MAX_ADVANCE_MINUTES)), required=False, default=None),
    },
    name="状况",
)


def _op(name, fields, desc):
    spec = {"op": F(S.Enum(name))}
    spec.update(fields)
    return S.Obj(spec, desc=desc, name=name)


SPECS = {}
DESCRIPTIONS = {}
HANDLERS = {}


def register(name, fields, desc, branch=True):
    def wrap(func):
        SPECS[name] = _op(name, fields, desc)
        DESCRIPTIONS[name] = desc
        HANDLERS[name] = (func, branch)
        return func

    return wrap


class TurnContext:
    """Mutable bookkeeping for one commit, over a working copy of the state."""

    def __init__(self, state, persona, commit, hooks=None):
        self.state = state
        self.persona = persona
        self.commit = commit
        self.mode = commit["action_mode"]
        self.authorized = commit["player_authorized"]
        self.turn = state["turn"] + 1
        self.errors = []
        self.applied = []
        self.resolved_events = []
        self.settlements = []
        self.roll_index = 0
        self.responses = {}
        self.actors = set()
        self.observable = False
        self.trust_start = {}
        self.stage_pairs = set()
        self.player_moved = False
        self.hooks = hooks or {}
        self.in_beat = None
        self.moved = {}
        self.relationship_reasons = []
        self.fact_index = 0
        self.event_index = 0
        self.beats = []
        self.beat_npcs = set()
        self.beats_after_time = set()
        self.required_beats = []
        self.beat_candidates = set(state["requests"].get("offscreen_beat_candidates") or [])
        self.thoughts = []
        self.debug_removed = []
        # Characters created by this commit (npc_action/introduce): the result
        # reports them so the caller knows the context must be full.
        self.new_characters = []
        # 回合开始那一刻的档位、在场名单与自主行动候选：门禁和候选校验都按这一刻判，
        # 和模型在 brief 里看到的一致，不随本回合中途加减的想法摇摆。
        npcs = SS.npcs(state)
        self.start_bands = {cid: MO.evaluate(state, cid)[1] for cid in npcs}
        self.start_present = set(state["scene"]["present"])
        self.start_kinds = {cid: [o["kind"] for o in AG.candidates(state, persona, cid, self.turn)] for cid in npcs}
        # 崩溃档里已经交了 provoke/leave 重大行动的 NPC
        self.break_actors = set()

    def band(self, cid):
        """The band this turn is judged by; characters created mid-commit read live."""
        if cid in self.start_bands:
            return self.start_bands[cid]
        return MO.evaluate(self.state, cid)[1]

    def fact_coord(self):
        self.fact_index += 1
        return [self.turn, self.fact_index]

    def event_coord(self):
        self.event_index += 1
        return [self.turn, self.event_index]

    def error(self, path, reason, hint=None, code=INVARIANT_VIOLATION):
        self.errors.append(detail(path, reason, hint, code))

    def name(self, cid):
        char = self.state["characters"].get(cid)
        return char["name"] if char else cid

    def frozen(self):
        return not self.state["preferences"]["offscreen_simulation"]


def _need_character(ctx, cid, path, errs, npc=False):
    if cid not in ctx.state["characters"]:
        errs.append(detail(path, "角色不存在：%s" % cid, "用上下文里列出的角色 ID", NOT_FOUND))
        return False
    if npc and cid == ctx.state["player_id"]:
        errs.append(detail(path, "这里需要 NPC，不能是玩家角色", None, INVARIANT_VIOLATION))
        return False
    return True


def _basis(ctx, npc_id, fact_ids, path, errs):
    for index, fid in enumerate(fact_ids):
        if fid not in ctx.state["facts"]:
            errs.append(detail("%s[%d]" % (path, index), "事实不存在：%s" % fid, None, NOT_FOUND))
        elif not SS.knows(ctx.state, npc_id, fid):
            errs.append(
                detail(
                    "%s[%d]" % (path, index),
                    "%s 不知道事实 %s，不能以它为依据" % (ctx.name(npc_id), fid),
                    "NPC 只能依据自己知道或误信的事实行动；先让信息以合理途径传到对方",
                    INVARIANT_VIOLATION,
                )
            )


def _absent_actor_ok(ctx, npc_id, path, errs):
    if not SS.is_present(ctx.state, npc_id) and ctx.frozen() and ctx.in_beat is None:
        errs.append(detail(path, "离屏推演已冻结，不在场的 %s 不能行动" % ctx.name(npc_id), "等玩家打开离屏推演，或让对方先登场", INVARIANT_VIOLATION))
        return False
    return True


def _flush(ctx, errs):
    if errs:
        ctx.errors.extend(errs)
        return False
    return True


def _note(ctx, key, text, known_by, visibility="private", origin=None):
    """Record the fact behind a feeling. Returns the fact id.

    Every memory thought points at one of these, so "why is he upset" is
    answerable from the fact journal and a debug deletion has something to
    suppress.
    """
    state = ctx.state
    fid = SS.next_id(state, "fact", "f")
    state["facts"][fid] = {
        "id": fid,
        "key": key,
        "text": text,
        "truth": True,
        "known_by": list(known_by),
        "believed_by": [],
        "visibility": visibility,
        "origin": origin or ("offscreen" if ctx.in_beat else "observed"),
        "turn": ctx.turn,
        "spreading": False,
        "coord": ctx.fact_coord(),
    }
    return fid


# ---------------------------------------------------------------------------
# time


def advance(ctx, minutes, path, default=False, to_clock=None):
    """Settle the real time that passed since the last turn.

    Nothing here is model-authored: `minutes` is the real gap and `to_clock` is
    the moment it lands on, both computed from the wall clock by the caller.
    """
    report = settlement.advance(ctx.state, minutes, ctx.turn, ctx.hooks, to_clock=to_clock)
    report["default"] = default
    offscreen = report.get("offscreen") or {}
    report["preview"] = simulation.preview_payload(ctx.state, report, ctx.persona)
    for npc in offscreen.get("required", []):
        if npc not in ctx.required_beats:
            ctx.required_beats.append(npc)
    ctx.beat_candidates |= set(offscreen.get("required", [])) | set(offscreen.get("candidates", []))
    ctx.settlements.append(report)
    ctx.resolved_events.extend(report["resolved_events"])
    if report["scene"]:
        ctx.observable = True
    ctx.applied.append(
        {
            "op": "clock",
            "minutes": minutes,
            "default": default,
            "clock": dict(ctx.state["clock"]),
            "label": SS.clock_label(ctx.state),
            "new_scene": bool(report["scene"]),
        }
    )
    return report


# ---------------------------------------------------------------------------
# scene


@register(
    "move",
    {"character_id": F(S.Id()), "location_id": F(S.Id())},
    "角色移动到地点。玩家移动需要 result/attempt 模式并带 player_authorized；玩家换地点即换场景",
)
def op_move(ctx, op, path):
    errs = []
    cid, lid = op["character_id"], op["location_id"]
    if not _need_character(ctx, cid, path + ".character_id", errs):
        return _flush(ctx, errs)
    if SS.place(ctx.persona, lid) is None:
        errs.append(detail(path + ".location_id", "地点不在人设包里：%s" % lid, "用人设 places 里的 ID", NOT_FOUND))
    is_player = cid == ctx.state["player_id"]
    if is_player:
        if ctx.mode not in ("result", "attempt") or not ctx.authorized:
            errs.append(detail(path, "玩家角色的移动只能出现在 result/attempt 模式并带 player_authorized: true", "继续/等待回合里玩家角色不移动", INVARIANT_VIOLATION))
        if lid == ctx.state["scene"]["location_id"]:
            errs.append(detail(path + ".location_id", "玩家已经在这里", None, INVARIANT_VIOLATION))
    else:
        _absent_actor_ok(ctx, cid, path, errs)
    if not _flush(ctx, errs):
        return
    char = ctx.state["characters"][cid]
    char["status"]["location_id"] = lid
    scene = ctx.state["scene"]
    if is_player:
        scene["location_id"] = lid
        # NPCs who went ahead to the same place earlier in this commit are there.
        scene["present"] = [ctx.state["player_id"]] + [n for n, where in ctx.moved.items() if where == lid]
        settlement.new_scene(ctx.state, "location")
        ctx.player_moved = True
    else:
        ctx.moved[cid] = lid
        ctx.actors.add(cid)
        ctx.observable = True
        if lid == scene["location_id"]:
            if cid not in scene["present"]:
                scene["present"].append(cid)
        elif cid in scene["present"]:
            scene["present"].remove(cid)
    ctx.applied.append({"op": "move", "character_id": cid, "location_id": lid})


@register("enter_scene", {"character_id": F(S.Id())}, "角色登场，加入当前场景")
def op_enter_scene(ctx, op, path):
    errs = []
    cid = op["character_id"]
    if _need_character(ctx, cid, path + ".character_id", errs, npc=True) and SS.is_present(ctx.state, cid):
        errs.append(detail(path + ".character_id", "%s 已经在场" % ctx.name(cid), None, INVARIANT_VIOLATION))
    if not _flush(ctx, errs):
        return
    ctx.state["scene"]["present"].append(cid)
    ctx.state["characters"][cid]["status"]["location_id"] = ctx.state["scene"]["location_id"]
    ctx.observable = True
    ctx.applied.append({"op": "enter_scene", "character_id": cid})


@register(
    "exit_scene",
    {"character_id": F(S.Id()), "to_location_id": F(S.Nullable(S.Id()), required=False, default=None)},
    "角色离场；可写去向地点。玩家角色用 move",
)
def op_exit_scene(ctx, op, path):
    errs = []
    cid = op["character_id"]
    if _need_character(ctx, cid, path + ".character_id", errs, npc=True) and not SS.is_present(ctx.state, cid):
        errs.append(detail(path + ".character_id", "%s 不在场" % ctx.name(cid), None, INVARIANT_VIOLATION))
    target = op["to_location_id"]
    if target is not None and SS.place(ctx.persona, target) is None:
        errs.append(detail(path + ".to_location_id", "地点不在人设包里：%s" % target, None, NOT_FOUND))
    if not _flush(ctx, errs):
        return
    ctx.state["scene"]["present"].remove(cid)
    if target is not None:
        ctx.state["characters"][cid]["status"]["location_id"] = target
    ctx.observable = True
    ctx.applied.append({"op": "exit_scene", "character_id": cid, "to_location_id": target})


# ---------------------------------------------------------------------------
# NPC


def _mood_guard(ctx, npc, op_name, path, errs):
    """The band gate: a shrunken character cannot do what an open one can.

    The band is computed fresh from base + live thoughts, never stored, so
    nothing here can drift out of step with the mood panel.
    """
    band = ctx.band(npc)
    reason = MO.gate(band, op_name)
    if reason:
        errs.append(detail(
            path, reason,
            "他这回合开始时在 %s 档，换一个这个状态下真的做得到的写法" % band,
            INVARIANT_VIOLATION,
        ))
        return False
    return True


def _response_guard(ctx, npc, op, path, errs):
    """Closed band: only cold replies, and short ones (README 心情条档位表)."""
    band = ctx.band(npc)
    allowed = ST.MOOD_RESPONSES.get(band)
    if allowed and op["response"] not in allowed:
        errs.append(detail(
            path + ".response", "他这回合在 %s 档，回应不会是 %s" % (band, op["response"]),
            "改成 %s 之一" % "/".join(allowed), INVARIANT_VIOLATION,
        ))
    limit = ST.MOOD_RESPONSE_LIMIT.get(band)
    if limit is not None and len(op["note"]) > limit:
        errs.append(detail(
            path + ".note", "他这回合在 %s 档，回应最多 %d 字（现在 %d 字）" % (band, limit, len(op["note"])),
            "缩短 note", INVARIANT_VIOLATION,
        ))


@register(
    "npc_response",
    {
        "npc_id": F(S.Id()),
        "response": F(S.Enum(*ST.RESPONSES)),
        "note": F(S.Str(1, 80)),
        "basis_fact_ids": F(S.List(S.Id(), max_items=8, unique=True), required=False, default=[]),
        "true_intent": F(S.Nullable(S.Str(1, 120)), required=False, default=None),
    },
    "NPC 对玩家尝试的回应：refuse 拒绝 / negotiate 协商 / partial 有限配合 / surface 表面配合 / genuine 真诚配合。surface 必须写 true_intent（记为只有本人知道的事实）",
)
def op_npc_response(ctx, op, path):
    errs = []
    npc = op["npc_id"]
    if _need_character(ctx, npc, path + ".npc_id", errs, npc=True):
        if not SS.is_present(ctx.state, npc):
            errs.append(detail(path + ".npc_id", "%s 不在场，不能当面回应" % ctx.name(npc), "先 enter_scene", INVARIANT_VIOLATION))
        _basis(ctx, npc, op["basis_fact_ids"], path + ".basis_fact_ids", errs)
        if _mood_guard(ctx, npc, "npc_response", path + ".npc_id", errs):
            _response_guard(ctx, npc, op, path, errs)
    if op["response"] == "surface" and not op["true_intent"]:
        errs.append(detail(path + ".true_intent", "表面配合必须写明真实意图", "true_intent 会记为只有本人知道的事实", INVARIANT_VIOLATION))
    if op["response"] != "surface" and op["true_intent"]:
        errs.append(detail(path + ".true_intent", "只有 surface 回应需要 true_intent", None, INVARIANT_VIOLATION))
    if not _flush(ctx, errs):
        return
    entry = {"op": "npc_response", "npc_id": npc, "response": op["response"], "note": op["note"]}
    if op["response"] == "surface":
        fid = SS.next_id(ctx.state, "fact", "f")
        ctx.state["facts"][fid] = {
            "id": fid,
            "key": "%s.intent.t%d" % (npc, ctx.turn),
            "text": "%s的真实打算：%s" % (ctx.name(npc), op["true_intent"]),
            "truth": True,
            "known_by": [npc],
            "believed_by": [],
            "visibility": "private",
            "origin": "offscreen" if ctx.in_beat else "observed",
            "turn": ctx.turn,
            "spreading": False,
            "coord": ctx.fact_coord(),
        }
        entry["intent_fact_id"] = fid
    ctx.responses.setdefault(npc, []).append(op["response"])
    ctx.actors.add(npc)
    ctx.observable = True
    _note(
        ctx, "%s.response.t%d" % (npc, ctx.turn),
        "%s 对你说：%s（%s）" % (ctx.name(npc), ST.RESPONSE_LABELS[op["response"]], op["note"]),
        [ctx.state["player_id"], npc],
    )
    responses = ctx.state["scene"]["responses"]
    responses.append({"turn": ctx.turn, "npc_id": npc, "response": op["response"], "note": op["note"]})
    del responses[:-6]
    ctx.applied.append(entry)


def _break_action(ctx, npc, op, path, errs):
    """A significant act in the break band is the outburst: provoke or leave only."""
    if op["kind"] not in ST.BREAK_ACTION_KINDS:
        errs.append(detail(
            path + ".kind", "%s 这回合在崩溃档，重大行动只能是 %s" % (ctx.name(npc), "/".join(ST.BREAK_ACTION_KINDS)),
            "kind 写 provoke 或 leave", INVARIANT_VIOLATION,
        ))


def _candidate_kind(ctx, npc, op, path, errs):
    """A significant act must be one the engine proposed at the start of the turn."""
    kinds = ctx.start_kinds.get(npc)
    if kinds is None:
        # created by this commit: no candidates were computed for it
        return
    if op["kind"] is None:
        errs.append(detail(
            path + ".kind", "重大行动必须写 kind", "取 agency 候选里的种类：%s" % ("/".join(kinds) or "无"),
            INVALID_INPUT,
        ))
    elif kinds and op["kind"] not in kinds:
        errs.append(detail(
            path + ".kind", "%s 此刻更可能 %s，不是 %s" % (ctx.name(npc), "/".join(kinds), op["kind"]),
            "换成候选里的种类，或写成非重大行动（significant: false）", INVARIANT_VIOLATION,
        ))


@register(
    "npc_action",
    {
        "npc_id": F(S.Id()),
        "action": F(S.Str(1, 120)),
        "significant": F(S.Bool(), required=False, default=False),
        "kind": F(S.Nullable(S.Enum(*ST.AGENCY_KINDS)), required=False, default=None),
        "target_id": F(S.Nullable(S.Id()), required=False, default=None),
        "basis_fact_ids": F(S.List(S.Id(), max_items=8, unique=True), required=False, default=[]),
    },
    "NPC 自主行动。significant: true 的重大行动（主动接近、揭发、交易、离开、表白、挑衅等）受冷却限制，且必须写 kind、取本回合 agency 候选里的种类；"
    "崩溃档（break）的在场 NPC 本回合必须有一条 significant 的 provoke/leave（不受冷却限制，也顶替 attempt 所需的 npc_response）；依据事实必须在其信息集中",
)
def op_npc_action(ctx, op, path):
    errs = []
    npc = op["npc_id"]
    if _need_character(ctx, npc, path + ".npc_id", errs, npc=True):
        _absent_actor_ok(ctx, npc, path, errs)
        _basis(ctx, npc, op["basis_fact_ids"], path + ".basis_fact_ids", errs)
        outburst = op["significant"] and ctx.band(npc) == "break"
        if outburst:
            _break_action(ctx, npc, op, path, errs)
        elif op["significant"]:
            _candidate_kind(ctx, npc, op, path, errs)
        bonus = MO.open_bonus(ctx.state, npc) if op["significant"] else 0
        if op["significant"] and not outburst and not SS.can_act(ctx.state, npc, ctx.turn, bonus):
            last = ctx.state["counters"]["major_action_turn"][npc]
            errs.append(
                detail(
                    path + ".significant",
                    "%s 在冷却中：第 %d 回合刚有过重大行动" % (ctx.name(npc), last),
                    "第 %d 回合起才能再有重大行动；这回合写成非重大行动，或让能行动的人出手" % (last + max(1, ST.COOLDOWN_TURNS - bonus)),
                    INVARIANT_VIOLATION,
                )
            )
        if op["kind"] is not None and op["kind"] not in ST.AGENCY_KINDS:
            errs.append(detail(path + ".kind", "未知的行动种类：%s" % op["kind"], "用 agency 候选给出的 kind", INVALID_INPUT))
    if op["target_id"] is not None:
        _need_character(ctx, op["target_id"], path + ".target_id", errs)
    if not _flush(ctx, errs):
        return
    if op["significant"]:
        ctx.state["counters"]["major_action_turn"][npc] = ctx.turn
        if ctx.band(npc) == "break":
            ctx.break_actors.add(npc)
    ctx.actors.add(npc)
    ctx.observable = True
    # The log in the settings page reads this back, so the action text and the
    # target have to be recorded here: the operation itself is not stored.
    ctx.applied.append({
        "op": "npc_action", "npc_id": npc, "significant": op["significant"],
        "kind": op["kind"], "action": op["action"], "target_id": op["target_id"],
    })


@register(
    "npc_state",
    {
        "npc_id": F(S.Id()),
        "add_conditions": F(S.List(CONDITION, max_items=4), required=False, default=[]),
        "remove_conditions": F(S.List(S.Enum(*ST.CONDITION_KINDS), max_items=7, unique=True), required=False, default=[]),
    },
    "更新 NPC 的状况（醉意、睡眠、受伤、外出等）；minutes 表示多久后自动消退。情绪不在这里改：心情由引擎按事实计算，要留下一条情绪用 add_thought",
)
def op_npc_state(ctx, op, path):
    errs = []
    npc = op["npc_id"]
    if _need_character(ctx, npc, path + ".npc_id", errs, npc=True):
        _absent_actor_ok(ctx, npc, path, errs)
    if not op["add_conditions"] and not op["remove_conditions"]:
        errs.append(detail(path, "没有任何变化", "至少给 add_conditions 或 remove_conditions 之一", INVARIANT_VIOLATION))
    if not _flush(ctx, errs):
        return
    status = ctx.state["characters"][npc]["status"]
    removed = set(op["remove_conditions"])
    status["conditions"] = [c for c in status["conditions"] if c["kind"] not in removed]
    for cond in op["add_conditions"]:
        until = CL.add_minutes(ctx.state["clock"], cond["minutes"]) if cond["minutes"] else None
        status["conditions"] = [c for c in status["conditions"] if c["kind"] != cond["kind"]]
        status["conditions"].append({"kind": cond["kind"], "text": cond["text"], "until": until, "since_turn": ctx.turn})
    ctx.observable = True
    ctx.applied.append({"op": "npc_state", "npc_id": npc, "conditions": [c["kind"] for c in status["conditions"]]})


@register(
    "add_thought",
    {
        "npc_id": F(S.Id()),
        "label": F(S.Str(1, 20)),
        "delta": F(S.Int(*ST.THOUGHT_DELTA_RANGE)),
        "basis_fact_id": F(S.Id()),
        "minutes": F(S.Nullable(S.Int(1, 30 * ST.MINUTES_PER_DAY)), required=False, default=None),
    },
    "给 NPC 记一条情绪（引擎算不出来的那种，比如一句随口提到的话扎了他）。必须指明依据的事实；幅度 -30..+15；不写 minutes 用默认时长",
)
def op_add_thought(ctx, op, path):
    errs = []
    npc = op["npc_id"]
    if _need_character(ctx, npc, path + ".npc_id", errs, npc=True):
        _basis(ctx, npc, [op["basis_fact_id"]], path + ".basis_fact_id", errs)
    if not _flush(ctx, errs):
        return
    minutes = op["minutes"] or ST.THOUGHT_DURATION["tone"]
    thought = MO.add_thought(
        ctx.state, npc, op["label"], op["delta"], "memory",
        source_fact_id=op["basis_fact_id"], minutes=minutes, turn=ctx.turn,
    )
    ctx.thoughts.append({"npc_id": npc, "thought": thought})
    ctx.observable = True
    ctx.applied.append({
        "op": "add_thought", "npc_id": npc, "thought_id": thought["id"],
        "label": op["label"], "delta": thought["delta"],
    })


# ---------------------------------------------------------------------------
# knowledge


@register(
    "add_fact",
    {
        "key": F(FACT_KEY),
        "text": F(S.Str(1, 120)),
        "truth": F(S.Bool(), required=False, default=True),
        "known_by": F(S.List(S.Id(), max_items=20, unique=True), required=False, default=[]),
        "believed_by": F(S.List(S.Id(), max_items=20, unique=True), required=False, default=[]),
        "visibility": F(S.Enum(*ST.FACT_VISIBILITY)),
        "origin": F(S.Enum(*ST.MODEL_FACT_ORIGINS)),
        "spread": F(S.Bool(), required=False, default=False),
    },
    "记录一条事实。public 在场者自动知道；private 只有 known_by；inner 是内心，只属于一个 NPC 且永不传播。误信用 truth: false + believed_by。正文里新写出、之后要继承的细节都要用它记下",
)
def op_add_fact(ctx, op, path):
    errs = []
    state = ctx.state
    if op["origin"] == "retcon" and (ctx.mode != "rewrite" or ctx.in_beat is not None):
        errs.append(detail(path + ".origin", "追溯事实只能在玩家说“其实……”的改写回合登记", "action_mode 用 rewrite，并带 player_authorized", INVARIANT_VIOLATION))
    elif ctx.mode == "rewrite" and ctx.in_beat is None and op["origin"] != "retcon":
        errs.append(detail(path + ".origin", "“其实……”回合里的新事实都是追溯：origin 用 retcon", None, INVARIANT_VIOLATION))
    if op["truth"] and op["believed_by"]:
        errs.append(detail(path + ".believed_by", "真事实用 known_by；believed_by 只用于 truth: false 的误信", None, INVARIANT_VIOLATION))
    if not op["truth"] and not op["believed_by"]:
        errs.append(detail(path + ".believed_by", "假事实（误信）必须写明谁相信它", None, INVARIANT_VIOLATION))
    if op["visibility"] == "inner":
        knowers = op["known_by"]
        if len(knowers) != 1 or knowers[0] == state["player_id"] or not op["truth"] or op["believed_by"] or op["spread"]:
            errs.append(detail(path, "内心事实只能属于一个 NPC 本人，必须为真，且永不传播", None, INVARIANT_VIOLATION))
    elif op["visibility"] == "private" and not op["known_by"] and not op["believed_by"]:
        errs.append(detail(path + ".known_by", "私密事实至少要有一个知情人", None, INVARIANT_VIOLATION))
    if op["truth"] and op["origin"] != "retcon":
        existing = next(iter(FA.of(state).by_key(op["key"])), None)
        if existing is not None:
            errs.append(
                detail(
                    path + ".key",
                    "同键的真事实已存在（%s：%s）" % (existing["id"], existing["text"][:30]),
                    "有人新得知这件事用 reveal_fact；情况有变化就换一个新键",
                    INVARIANT_VIOLATION,
                )
            )
    if not _flush(ctx, errs):
        return
    known = list(op["known_by"])
    if op["visibility"] == "public":
        for cid in state["scene"]["present"]:
            if cid not in known:
                known.append(cid)
    fid = _note(ctx, op["key"], op["text"], known, op["visibility"], op["origin"])
    state["facts"][fid]["believed_by"] = list(op["believed_by"])
    state["facts"][fid]["truth"] = op["truth"]
    state["facts"][fid]["spreading"] = bool(op["spread"])
    ctx.observable = True
    ctx.applied.append({"op": "add_fact", "fact_id": fid, "key": op["key"], "origin": state["facts"][fid]["origin"], "known_by": known})


@register(
    "reveal_fact",
    {"fact_id": F(S.Id()), "to": F(S.List(S.Id(), 1, 20, unique=True)), "note": F(S.Nullable(S.Str(1, 80)), required=False, default=None)},
    "让某些人得知已经存在的事实（当面说、被听见、看到证据）。不会改变事实本身",
)
def op_reveal_fact(ctx, op, path):
    errs = []
    state = ctx.state
    fact = state["facts"].get(op["fact_id"])
    if fact is None:
        errs.append(detail(path + ".fact_id", "事实不存在：%s" % op["fact_id"], None, NOT_FOUND))
    for index, cid in enumerate(op["to"]):
        if _need_character(ctx, cid, "%s.to[%d]" % (path, index), errs):
            if not SS.is_present(state, cid) and ctx.in_beat is None:
                errs.append(detail("%s.to[%d]" % (path, index), "%s 不在场，不能在这一幕里得知这件事" % ctx.name(cid), "等离屏推演或以后当面告知", INVARIANT_VIOLATION))
    if not _flush(ctx, errs):
        return
    added = []
    for cid in op["to"]:
        if cid not in fact["known_by"]:
            fact["known_by"].append(cid)
            added.append(cid)
    ctx.observable = True
    ctx.applied.append({"op": "reveal_fact", "fact_id": fact["id"], "to": added})


# ---------------------------------------------------------------------------
# relationships


@register(
    "relationship",
    {
        "from": F(S.Id()),
        "to": F(S.Id()),
        "trust_delta": F(S.Int(-ST.MAX_TRUST_DELTA, ST.MAX_TRUST_DELTA), required=False, default=0),
        "tension_delta": F(S.Int(-5, 5), required=False, default=0),
        "stage_advance": F(S.Bool(), required=False, default=False),
        "stage_retreat_to": F(S.Nullable(S.Enum(*ST.STAGES)), required=False, default=None),
        "reason": F(S.Str(1, 80)),
    },
    "有向关系变化（from 对 to）：信任 -5..5（一个回合净变化 ≤2）、张力 0..5、亲近进程前进一个阶段（需要同一回合里玩家的行动 + 对方的 partial/genuine 回应）或后退。原因必填",
)
def op_relationship(ctx, op, path):
    errs = []
    a, b = op["from"], op["to"]
    if a == b:
        errs.append(detail(path, "关系的两端不能是同一个人", None, INVARIANT_VIOLATION))
    _mood_guard(ctx, b, "stage_advance", path + ".to", errs) if op["stage_advance"] else None
    if not _flush(ctx, errs):
        return
    before = SS.edge(ctx.state, a, b) or {}
    record, problems = REL.change(
        ctx, a, b, op["trust_delta"], op["tension_delta"],
        op["stage_advance"], op["stage_retreat_to"], op["reason"], path,
    )
    if problems:
        ctx.errors.extend(problems)
        return
    after = SS.edge(ctx.state, a, b) or {}
    player = ctx.state["player_id"]
    if op["trust_delta"]:
        # The edge a>b is *a's* attitude toward b, so the feeling lands on a.
        # The player card carries ``"mood": None`` on purpose (the player is a
        # slot, nothing about how they feel is stored), so a move that starts
        # at the player is recorded in the ledger and felt by nobody.
        fid = _note(
            ctx, "%s.trust.t%d" % (a, ctx.turn),
            "%s 对 %s 的信任 %+d：%s" % (ctx.name(a), ctx.name(b), op["trust_delta"], op["reason"]),
            [player, a, b],
        )
        if a != player:
            thought = MO.thoughts_from_trust(ctx.state, a, op["trust_delta"], fid, ctx.turn)
            if thought is not None:
                ctx.thoughts.append({"npc_id": a, "thought": thought})
    if op["stage_advance"] and after.get("stage") != before.get("stage"):
        fid = _note(
            ctx, "%s.stage.t%d" % (a, ctx.turn),
            "%s 与 %s 的关系进入 %s：%s" % (ctx.name(a), ctx.name(b), ST.STAGE_LABELS[after["stage"]], op["reason"]),
            [player, a, b],
        )
        # The stage is the pair's shared history, so both directions moved: the
        # one NPC in the pair is the one who feels it.
        felt_by = a if a != player else b
        if felt_by != player:
            thought = MO.thoughts_from_stage(ctx.state, felt_by, fid, ctx.turn)
            if thought is not None:
                ctx.thoughts.append({"npc_id": felt_by, "thought": thought})
    ctx.observable = True
    ctx.relationship_reasons.append(op["reason"])
    ctx.applied.append({
        "op": "relationship", "from": a, "to": b,
        "trust": after.get("trust"), "tension": after.get("tension"), "stage": after.get("stage"),
    })


# ---------------------------------------------------------------------------
# events


@register(
    "event_create",
    {
        "kind": F(S.Enum(*ST.EVENT_KINDS)),
        "title": F(S.Str(1, 40)),
        "text": F(S.Nullable(S.Str(1, 120)), required=False, default=None),
        "tier": F(S.Nullable(S.Enum(*ST.EVENT_TIERS)), required=False, default=None),
        "participants": F(S.List(S.Id(), 1, 12, unique=True)),
        "due": F(CLOCK, required=False),
        "in_minutes": F(S.Int(1, 400 * ST.MINUTES_PER_DAY), required=False),
        "probability": F(S.Nullable(S.Num(0, 1, lo_open=True, hi_open=True)), required=False, default=None),
        "dedupe_key": F(FACT_KEY),
        "repeat": F(S.Bool(), required=False, default=False),
    },
    "创建事件（约定、截止、风声、机会、伏笔、概率事件）。due 与 in_minutes 二选一且必须晚于现在；chance 必须带 probability，到期由引擎掷骰；涉及玩家的承诺需要 player_authorized；dedupe_key 与未结束事件不能重复",
)
def op_event_create(ctx, op, path):
    errs = []
    state = ctx.state
    for index, cid in enumerate(op["participants"]):
        _need_character(ctx, cid, "%s.participants[%d]" % (path, index), errs)
    given = [k for k in ("due", "in_minutes") if k in op]
    due = None
    if len(given) != 1:
        errs.append(detail(path, "due 与 in_minutes 必须且只能给一个", None, INVARIANT_VIOLATION))
    else:
        due = op["due"] if "due" in op else CL.add_minutes(state["clock"], op["in_minutes"])
        if CL.to_abs(due) <= CL.to_abs(state["clock"]):
            errs.append(detail(path + ".due", "到期时间必须晚于现在（%s）" % SS.clock_label(state), None, INVARIANT_VIOLATION))
    if op["kind"] == "chance" and op["probability"] is None:
        errs.append(detail(path + ".probability", "概率事件必须带 probability", "结果由引擎在到期时掷骰", INVARIANT_VIOLATION))
    if op["kind"] != "chance" and op["probability"] is not None:
        errs.append(detail(path + ".probability", "只有 chance 事件带 probability", None, INVARIANT_VIOLATION))
    player = state["player_id"]
    if op["kind"] == "promise" and player in op["participants"] and ctx.in_beat is None:
        if ctx.mode not in ("result", "attempt") or not ctx.authorized:
            errs.append(detail(path, "涉及玩家角色的承诺只能在玩家本人答应时成立（result/attempt + player_authorized）", None, INVARIANT_VIOLATION))
    if ctx.in_beat is not None and player in op["participants"]:
        errs.append(detail(path + ".participants", "离屏片段不能创建涉及玩家角色的事件", None, INVARIANT_VIOLATION))
    key = op["dedupe_key"]
    used = state["counters"].setdefault("event_keys", {}).get(key, 0)
    if any(e["state"] == "pending" and e["dedupe_key"].split("#")[0] == key for e in state["events"].values()):
        errs.append(detail(path + ".dedupe_key", "已有同一去重键的未结束事件：%s" % key, "推进或结束那个事件，而不是再建一个", INVARIANT_VIOLATION))
    elif used and not op["repeat"]:
        errs.append(detail(path + ".dedupe_key", "去重键 %s 已被结束的事件用过" % key, "确实是重复发生时带 repeat: true", INVARIANT_VIOLATION))
    if not _flush(ctx, errs):
        return
    state["counters"]["event_keys"][key] = used + 1
    if used:
        key = "%s#%d" % (key, used + 1)
    tier = op["tier"]
    if tier is None:
        minutes = CL.minutes_between(state["clock"], due)
        tier = "immediate" if minutes <= 60 else ("near" if minutes <= 2 * ST.MINUTES_PER_DAY else "far")
    eid = SS.next_id(state, "event", "e")
    state["events"][eid] = {
        "id": eid,
        "kind": op["kind"],
        "tier": tier,
        "title": op["title"],
        "text": op["text"],
        "participants": list(op["participants"]),
        "due": due,
        "probability": op["probability"],
        "dedupe_key": key,
        "state": "pending",
        "outcome": None,
        "created_turn": ctx.turn,
        "resolved_turn": None,
        "note": None,
        "coord": ctx.event_coord(),
    }
    ctx.observable = True
    ctx.applied.append({"op": "event_create", "event_id": eid, "kind": op["kind"], "due": due})


def _pending_event(ctx, eid, path, errs):
    event = ctx.state["events"].get(eid)
    if event is None:
        if _archived(ctx.state, eid):
            errs.append(detail(path, "事件 %s 早已结束并随章节归档，终态不可修改" % eid, None, INVARIANT_VIOLATION))
        else:
            errs.append(detail(path, "事件不存在：%s" % eid, None, NOT_FOUND))
        return None
    if event["state"] != "pending":
        errs.append(detail(path, "事件 %s 已经结束（%s），终态不可修改" % (eid, event["outcome"]), None, INVARIANT_VIOLATION))
        return None
    return event


def _archived(state, eid):
    """Event ids are never reused: a past id missing from the state was archived."""
    number = eid[1:] if eid.startswith("e") else ""
    return number.isdigit() and 0 < int(number) < state["counters"]["next"]["event"]


def _player_deal_guard(ctx, event, path, errs):
    player = ctx.state["player_id"]
    if event["kind"] == "promise" and player in event["participants"]:
        if ctx.in_beat is not None:
            errs.append(detail(path, "离屏片段不能兑现或取消涉及玩家角色的事件", None, INVARIANT_VIOLATION))
        elif ctx.mode not in ("result", "attempt") or not ctx.authorized:
            errs.append(detail(path, "涉及玩家角色的承诺，其兑现与取消要由玩家本人决定（result/attempt + player_authorized）", None, INVARIANT_VIOLATION))


@register(
    "event_resolve",
    {"event_id": F(S.Id()), "outcome": F(S.Enum("fulfilled", "surfaced")), "note": F(S.Str(1, 80))},
    "在到期前结束事件：约定、截止、机会用 fulfilled（兑现）；伏笔、风声用 surfaced（提前浮出）。概率事件只能由引擎到期掷骰",
)
def op_event_resolve(ctx, op, path):
    errs = []
    event = _pending_event(ctx, op["event_id"], path + ".event_id", errs)
    if event is not None:
        allowed = ST.MANUAL_OUTCOMES[event["kind"]]
        if op["outcome"] not in allowed:
            if not allowed:
                errs.append(detail(path + ".outcome", "概率事件的结果只能由引擎在到期时掷骰", None, INVARIANT_VIOLATION))
            else:
                errs.append(detail(path + ".outcome", "%s 事件只能以 %s 结束" % (event["kind"], "/".join(allowed)), None, INVARIANT_VIOLATION))
        _player_deal_guard(ctx, event, path, errs)
    if not _flush(ctx, errs):
        return
    event["state"] = "resolved"
    event["outcome"] = op["outcome"]
    event["resolved_turn"] = ctx.turn
    event["note"] = op["note"]
    ctx.observable = True
    ctx.applied.append({"op": "event_resolve", "event_id": event["id"], "outcome": op["outcome"]})


@register("event_cancel", {"event_id": F(S.Id()), "reason": F(S.Str(1, 80))}, "因剧情取消未结束的事件（outcome: cancelled_by_story）")
def op_event_cancel(ctx, op, path):
    errs = []
    event = _pending_event(ctx, op["event_id"], path + ".event_id", errs)
    if event is not None:
        _player_deal_guard(ctx, event, path, errs)
    if not _flush(ctx, errs):
        return
    event["state"] = "cancelled"
    event["outcome"] = "cancelled_by_story"
    event["resolved_turn"] = ctx.turn
    event["note"] = op["reason"]
    ctx.observable = True
    ctx.applied.append({"op": "event_cancel", "event_id": event["id"]})


# ---------------------------------------------------------------------------
# registry surface


def op_spec():
    """The tagged union the commit schema uses for one operation."""
    return S.Tagged("op", dict(SPECS), "操作")


def apply_op(ctx, op, path):
    handler, _branch = HANDLERS[op["op"]]
    handler(ctx, op, path)


def check_safety_tags(state, tags):
    """Hard boundaries and pause, for a set of content tags. Returns details.

    A boundary is the player's own wording registered under one or more tags;
    a clash rejects the commit with SAFETY_BLOCK, never as a story cost.
    """
    problems = []
    safety = state.get("safety") or {}
    for boundary in safety.get("boundaries") or []:
        clash = sorted((set(boundary["tags"]) & set(tags)) - {"custom"})
        if clash:
            problems.append(
                detail(
                    "$.content_tags",
                    "与玩家登记的边界冲突：%s" % boundary["text"],
                    "换一个不涉及 %s 的写法；硬边界不能被折算成剧情代价" % "、".join(clash),
                    SAFETY_BLOCK,
                )
            )
    if safety.get("paused"):
        blocked = sorted(set(tags) & (set(ST.INTIMACY_TAGS) | set(ST.CONFLICT_TAGS)))
        if blocked:
            problems.append(
                detail(
                    "$.content_tags",
                    "玩家已暂停，亲密与冲突内容都不能继续：%s" % "、".join(blocked),
                    "回到中性叙述；等玩家明确恢复",
                    SAFETY_BLOCK,
                )
            )
    return problems


def catalog():
    """Operation names and their one-line descriptions, for the context."""
    return [{"op": name, "desc": DESCRIPTIONS[name]} for name in sorted(SPECS)]


# Offscreen beats register themselves on import (they live in their own module
# because only a subset of operations is legal for a character acting alone).
from . import ops_time  # noqa: E402,F401
