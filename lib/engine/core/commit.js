/* lib/engine/core/commit.js — 开一局，和一次交账。
 *
 *   newLedger(persona, now, registry)          一局刚开时的整份状态
 *   commitSpec(registry, enabled)              这一刻的交账表（内核字段 + 开着的模块字段）
 *   commit(state, input, opts)                 一次交账：{ ok, state, id, notes } 或 { ok: false, problems }
 *
 * commit 是纯函数：不读时钟（now 传进来）、不碰存储、不改入参。全有或全无：
 * 有一条 problem 就整次不生效，返回原样的问题清单。
 */

import * as S from "./schema.js";
import * as T from "./time.js";
import * as F from "./facts.js";
import * as E from "./events.js";
import * as H from "./her.js";
import * as R from "./registry.js";

export const LEDGER_VERSION = 1;
/** 账本里留最近多少次交账的流水（撤销与存档走快照，这里只给「她最近怎样」看）。 */
export const LOG_KEEP = 40;

/** 内核的交账字段（顺序就是工具说明里的顺序）。 */
export const CORE_FIELDS = Object.freeze({
  summary: S.required(S.describe(S.str(120), "这一次发生了什么，第三方一两句")),
  her: H.FIELDS.her,
  learned: F.FIELDS.learned,
  reveal: F.FIELDS.reveal,
  promise: E.FIELDS.promise,
  open: S.describe(S.str(80), "停在哪里、谁在等谁；不写就沿用上一个"),
  quotes: S.describe(S.list(S.str(80), 3), "值得留下的原话"),
  tags: H.FIELDS.tags,
  consent: H.FIELDS.consent,
});

/** 所有模块的切片都开出来（关着的也开：以后打开时直接能用）。 */
function initSlices(registry, persona, now, existing = {}) {
  const out = { ...existing };
  for (const mod of registry.list) {
    if (out[mod.id] === undefined) out[mod.id] = typeof mod.init === "function" ? mod.init(persona, now) : {};
  }
  return out;
}

export function newLedger(persona, now, registry) {
  return {
    v: LEDGER_VERSION,
    persona: { id: persona?.id ?? "", revision: persona?.revision ?? "" },
    revision: 0,
    started_at: now,
    last_commit_at: null,
    her: { name: persona?.name ?? "她", conditions: [] },
    you: { name: persona?.player_name ?? "你", last_said_at: null },
    facts: {},
    events: {},
    next: { event: 1 },
    scene: { since: now, responses: [] },
    log: [],
    safety: { paused: false, boundaries: [] },
    prefs: { pace: "standard", explicitness: "standard" },
    modules: initSlices(registry, persona, now),
  };
}

export function commitSpec(registry, enabled) {
  const { fields, owner } = R.fieldsOf(registry, enabled, CORE_FIELDS);
  return { fields, owner, spec: S.obj(fields), guide: S.guide(fields), json: S.jsonSchema(S.obj(fields)) };
}

/** 内核能回答的问题：模块用 ctx.ask("core.xxx") 来问。 */
export function coreAnswers(state, now, persona) {
  return {
    herKnows: (key) => F.herKnows(state.facts, key),
    knownKeys: () => F.keysHerKnows(state.facts),
    /** 她最近 minutes 分钟里知道的事实 key。 */
    recentFacts: (minutes) => Object.values(state.facts)
      .filter((f) => f.who !== "you" && T.minutesBetween(f.at, now) <= minutes && !T.before(now, f.at))
      .map((f) => f.key),
    openEvents: () => E.open(state.events, now),
    conditions: () => H.activeConditions(state.her, now),
    doing: () => H.doingAt(persona, now),
    lastSaidAt: () => state.you.last_said_at,
    minutesApart: () => (state.you.last_said_at ? T.minutesBetween(state.you.last_said_at, now) : null),
    sceneSince: () => state.scene.since,
    lastCommitAt: () => state.last_commit_at,
  };
}

/**
 * 一次交账。opts：
 *   now        这一刻（ISO）
 *   registry   模块清单；enabled 开着的模块 id
 *   persona    人设（作息等）
 *   alone      她自己醒来的那一次（你不在场）：由桥接层判断，不由模型填
 *   said       这一次你说了话（更新「你上次说话的时刻」）
 *   id         这次交账的 id（不给就按 revision 和时刻编一个）
 */
export function commit(state, rawInput, opts) {
  const { now, registry, enabled, persona = null, alone = false, said = false } = opts;
  const { spec } = commitSpec(registry, enabled);
  const checked = S.validate(spec, rawInput);
  if (checked.problems.length > 0) return { ok: false, problems: checked.problems, notes: checked.notes };
  const input = checked.value;

  let slices = initSlices(registry, persona, now, state.modules);
  let facts = state.facts;
  const ctx = R.createContext({
    registry, enabled, now, alone, persona, kernel: state,
    slices: () => slices,
    coreAnswers: { ...coreAnswers(state, now, persona), herKnows: (key) => F.herKnows(facts, key) },
  });
  // 模块要把一句话记成「她心里的」事实时用（心事的来由直接写一句话）
  ctx.noteInner = (text) => {
    const made = F.noteInner(facts, text, now);
    facts = made.facts;
    return made.key;
  };

  // ---- 校验：内核 + 每个开着的模块，全部问题一起报 ----
  const problems = [
    ...F.validate(state.facts, input, ctx),
    ...E.validate(state.events, input, ctx),
    ...H.validate(state, input, ctx),
  ];
  for (const id of enabled) {
    const mod = registry.byId.get(id);
    if (typeof mod.validate === "function") problems.push(...(mod.validate(slices[id], input, ctx) ?? []));
  }
  if (problems.length > 0) return { ok: false, problems, notes: checked.notes };

  // ---- 应用：内核先，模块按登记顺序 ----
  const newScene = T.isNewScene(state.last_commit_at, now);
  const base = newScene ? { ...state, scene: { since: now, responses: [] } } : state;
  facts = F.apply(facts, input, ctx);
  const ev = E.apply(base.events, base.next.event, input, ctx);
  const herPart = H.apply(base, input, ctx);
  for (const id of enabled) {
    const mod = registry.byId.get(id);
    if (typeof mod.apply === "function") slices = { ...slices, [id]: mod.apply(slices[id], input, ctx) ?? slices[id] };
  }
  slices = R.dispatch(registry, enabled, slices, ctx.signals, ctx);

  // ---- 落定：顺手清掉已经没影响的东西 ----
  for (const id of enabled) {
    const mod = registry.byId.get(id);
    if (typeof mod.tidy === "function") slices = { ...slices, [id]: mod.tidy(slices[id], now) ?? slices[id] };
  }
  const revision = state.revision + 1;
  const id = opts.id ?? "c" + revision + "-" + T.ms(now).toString(36);
  const open = input.open ?? state.log.at(-1)?.open ?? "";
  const entry = { id, at: now, summary: input.summary, open, quotes: input.quotes ?? [], ...(alone ? { alone: true } : {}) };
  const next = {
    ...base,
    revision,
    last_commit_at: now,
    facts,
    events: E.tidy(ev.events, now),
    next: { ...base.next, event: ev.next },
    her: herPart.her,
    scene: herPart.scene,
    you: said && !alone ? { ...base.you, last_said_at: now } : base.you,
    log: [...state.log, entry].slice(-LOG_KEEP),
    modules: slices,
  };
  if (newScene && state.last_commit_at !== null) ctx.note("隔了 " + T.minutesBetween(state.last_commit_at, now) + " 分钟，算新的一段");
  return { ok: true, state: next, id, notes: [...checked.notes, ...ctx.notes] };
}
