/* lib/engine/import-v1.js — 一次性导入旧引擎（Python）的存档。
 *
 *   readV1(file)                 读旧的 engine.db（只读）：最近一局的状态、事实表、交账流水、常识库
 *   convertV1(old, registry)     旧 → 新：{ ledger, log, common, diaryDays }（纯函数）
 *   compareV1(old, view, panels) 逐项核对（设计文档 0.1 第 3 条）：心情与每条心事、态度、事实与谁知道、未结束的约定、安排
 *
 * 时间：旧引擎的游戏时钟 {day, minute} 跟着真实时间走，最后一次交账时 clock 对应 real_at。
 * 所以任何一个 {day, minute} = real_at + (它 − clock) 分钟；绝对分钟数（since_abs、t0、expires_at）同理。
 * 回合号丢掉：要时刻的地方用那一回合交账的时刻（turn_log.created_at）。
 */

import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import * as T from "./core/time.js";
import { newLedger } from "./core/commit.js";

const MINUTES_PER_DAY = 1440;
const LOG_KEEP = 40;
const AWAY_KEEP = 10;

/** 读旧库：最近改过的那一局。没有局返回 null。 */
export function readV1(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT session_id, state FROM sessions ORDER BY updated_at DESC LIMIT 1").get();
    if (row === undefined) return null;
    const state = JSON.parse(inflateSync(row.state).toString("utf8"));
    const facts = db.prepare("SELECT data, suppressed FROM facts WHERE session_id = ? ORDER BY n").all(row.session_id)
      .filter((r) => !r.suppressed).map((r) => JSON.parse(r.data));
    const turns = db.prepare("SELECT turn, kind, summary, open_action, undone, created_at FROM turn_log WHERE session_id = ? ORDER BY id").all(row.session_id);
    const hasCommon = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'common'").get() !== undefined;
    const common = hasCommon
      ? db.prepare("SELECT id, key, weight, content, origin, pending FROM common ORDER BY n").all()
        .map((r) => ({ id: r.id, key: JSON.parse(r.key), weight: r.weight, content: r.content, origin: r.origin, pending: r.pending === 1 }))
      : [];
    return { sessionId: row.session_id, state, facts, turns, common };
  } finally {
    db.close();
  }
}

const absOf = (clock) => (clock && Number.isFinite(clock.day) ? (clock.day - 1) * MINUTES_PER_DAY + clock.minute : null);

/** 旧时钟 → ISO 的换算器。 */
export function clockOf(state) {
  const anchor = state.real_at ?? state.real_start;
  const anchorAbs = absOf(state.clock);
  const offset = T.offsetOf(anchor);
  // 旧时钟只到分钟：锚点也截到整分钟，换出来的时刻才是 10:00 而不是 10:00:26
  const anchorMs = Math.floor(T.ms(anchor) / 60000) * 60000;
  const fromAbs = (abs) => (Number.isFinite(abs) ? T.iso(anchorMs + (abs - anchorAbs) * 60000, offset) : null);
  return {
    fromAbs,
    fromClock: (clock) => fromAbs(absOf(clock)),
    /** 第 d 天 → 那一天的日历日 YYYY-MM-DD（取当天中午，免得落在边上）。 */
    dayKey: (day) => (Number.isFinite(day) ? T.dayKey(fromAbs((day - 1) * MINUTES_PER_DAY + 720)) : null),
  };
}

/** 她是哪一个：不是玩家的那个角色。 */
const herIdOf = (state) => Object.keys(state.characters ?? {}).find((id) => id !== state.player_id) ?? null;

function whoOf(fact, herId, playerId) {
  const knowers = new Set(fact.known_by ?? []);
  if (knowers.has(herId) && knowers.has(playerId)) return "shared";
  if (knowers.has(herId)) return "her";
  if (knowers.has(playerId)) return "you";
  return null;
}

/**
 * 旧 → 新。返回 { ledger, log, common, diaryDays, notes }：
 *   ledger     新账本（内核 + 各模块切片）
 *   log        全部交账流水（新的 log 表用），ledger.log 只留最近 40 条
 *   common     常识库
 *   diaryDays  { 第几天: "YYYY-MM-DD" }（搬日记文件用）
 *   notes      丢掉了什么（给人看）
 */
export function convertV1(old, registry, persona = null) {
  const s = old.state;
  const C = clockOf(s);
  const herId = herIdOf(s);
  const her = s.characters?.[herId] ?? {};
  const player = s.characters?.[s.player_id] ?? {};
  const now = s.real_at ?? s.real_start;
  const notes = [];
  // 回合号 → 那一回合交账的时刻
  const turnAt = new Map(old.turns.filter((t) => !t.undone).map((t) => [t.turn, t.created_at]));
  const atTurn = (turn) => turnAt.get(turn) ?? now;

  const base = newLedger({ id: s.persona_id, revision: s.persona_revision, name: her.name, player_name: player.name, ...(persona ?? {}) }, s.real_start ?? now, registry);

  // ---- 内核 ----
  const facts = {};
  for (const f of old.facts) {
    const who = whoOf(f, herId, s.player_id);
    if (who === null || typeof f.key !== "string") continue;
    facts[f.key] = { key: f.key, text: String(f.text ?? "").slice(0, 200), who, at: C.fromClock(f.at) ?? now };
  }
  const events = {};
  let maxEvent = 0;
  for (const e of Object.values(s.events ?? {})) {
    if (e.state !== "pending") continue;
    const withYou = (e.participants ?? []).includes(s.player_id);
    const kind = e.kind === "promise" && withYou ? "promise" : !withYou ? "task" : null;
    if (kind === null) {
      notes.push("约定「" + e.title + "」是旧引擎的 " + e.kind + "，新引擎没有这一类，没带过来");
      continue;
    }
    events[e.id] = { id: e.id, kind, title: e.title, due: C.fromClock(e.due), state: "pending", created_at: atTurn(e.created_turn) };
    maxEvent = Math.max(maxEvent, Number(String(e.id).slice(1)) || 0);
  }
  const conditions = (her.status?.conditions ?? [])
    .map((c) => ({ kind: c.kind, text: c.text, since: atTurn(c.since_turn), until: c.until ? C.fromClock(c.until) : null }))
    .filter((c) => c.until === null || T.before(now, c.until));
  const kept = old.turns.filter((t) => t.kind === "commit" && !t.undone);
  const log = kept.map((t, i) => ({
    id: "i" + (i + 1) + "-" + T.ms(t.created_at).toString(36),
    at: t.created_at,
    summary: t.summary ?? "",
    open: t.open_action ?? "",
    quotes: [],
    imported: true,
  }));

  // ---- 情绪 ----
  const rel = s.relationships?.[herId + ">" + s.player_id] ?? {};
  const stored = (her.mood?.thoughts ?? []).filter((t) => t.kind !== "situational");
  if ((her.mood?.thoughts ?? []).length > stored.length) notes.push("情境心事（在场、很久没见你这类）没带：新引擎读局面时现算");
  const thoughts = stored.map((t, i) => ({
    id: "t" + (i + 1),
    label: t.label,
    delta: t.delta,
    kind: "stored",
    source: "feel",
    because: null,
    since: C.fromAbs(t.since_abs) ?? now,
    until: t.expires_at === null || t.expires_at === undefined ? null : C.fromAbs(t.expires_at),
  })).filter((t) => t.until === null || T.before(now, t.until));
  const history = (rel.history ?? []).map((h) => {
    const m = /^(trust|tension)([+-]\d+)$/.exec(h.change ?? "");
    return { at: atTurn(h.turn), trust: m?.[1] === "trust" ? Number(m[2]) : 0, tension: m?.[1] === "tension" ? Number(m[2]) : 0, reason: h.reason ?? "" };
  });
  const mood = {
    ...base.modules.mood,
    base: Number.isInteger(her.mood?.base) ? her.mood.base : base.modules.mood.base,
    thoughts,
    next: thoughts.length + 1,
    bond: { trust: rel.trust ?? 0, tension: rel.tension ?? 0, stage: rel.stage ?? base.modules.mood.bond.stage, history },
    major_action_at: C.fromClock(s.counters?.major_action_at?.[herId]),
  };

  // ---- 唤醒 ----
  const planUntil = s.plan?.until ? C.fromClock(s.plan.until) : null;
  const away = (s.memory?.turns ?? []).flatMap((t) => (t.offscreen ?? []).map((o) => ({ at: atTurn(t.turn), since: null, text: o.summary })))
    .slice(-AWAY_KEEP);
  const wake = { plan: s.plan?.note && planUntil ? { note: s.plan.note, until: planUntil, set_at: atTurn(s.plan.set_turn) } : null, away };

  // ---- 记忆 ----
  const diaryDays = {};
  const dayKey = (day) => {
    const key = C.dayKey(day);
    if (key !== null) diaryDays[day] = key;
    return key;
  };
  const entries = (s.memory?.entries ?? []).map(({ turn, summarized, remember, at, t0, diary_day, ...e }) => ({
    ...e,
    at: C.fromClock(at) ?? now,
    t0: C.fromAbs(t0) ?? now,
    ...(Number.isFinite(diary_day) ? { diary_day: dayKey(diary_day) } : {}),
  }));
  const memory = {
    ...base.modules.memory,
    entries,
    next: s.counters?.next?.memory ?? entries.length + 1,
    milestones: s.counters?.milestones ?? [],
    last_diary_day: Number.isFinite(s.counters?.last_diary_day) ? dayKey(s.counters.last_diary_day) : null,
    diary_last: s.memory?.diary_last ? { day: dayKey(s.memory.diary_last.day), text: s.memory.diary_last.text } : null,
  };

  const ledger = {
    ...base,
    started_at: s.real_start ?? now,
    last_commit_at: now,
    her: { name: her.name ?? base.her.name, conditions },
    you: { name: player.name ?? base.you.name, last_said_at: s.last_player_at ?? null },
    facts,
    events,
    next: { event: maxEvent + 1 },
    scene: { since: C.fromClock(s.scene?.since) ?? now, responses: [] },
    log: log.slice(-LOG_KEEP),
    safety: { paused: s.safety?.paused === true, boundaries: s.safety?.boundaries ?? [] },
    prefs: { pace: s.preferences?.pace ?? "standard", explicitness: s.preferences?.explicitness ?? "standard" },
    modules: { ...base.modules, mood, wake, memory },
  };
  return { ledger, log, common: old.common.map((c) => ({ ...c, at: null })), diaryDays, notes };
}

/**
 * 逐项核对：旧的原样 vs 导入后新引擎读出来的。返回 [{ item, old, now, ok }]。
 * view 是 engine.context()，moodPanel 是 engine.panel("mood")，now 是读它们的那一刻
 * （旧的那份也按这一刻算：到期的心事、过了点的安排两边都不算）。
 */
export function compareV1(old, view, moodPanel, now) {
  const s = old.state;
  const herId = herIdOf(s);
  const her = s.characters?.[herId] ?? {};
  const rel = s.relationships?.[herId + ">" + s.player_id] ?? {};
  const C = clockOf(s);
  const rows = [];
  const add = (item, was, is) => rows.push({ item, old: was, now: is, ok: JSON.stringify(was) === JSON.stringify(is) });
  add("心情基准", her.mood?.base ?? null, moodPanel?.base ?? null);
  const storedOld = (her.mood?.thoughts ?? []).filter((t) => t.kind !== "situational" && (t.expires_at == null || T.before(now, C.fromAbs(t.expires_at))))
    .map((t) => t.label + "(" + t.delta + ")").sort();
  const storedNew = (moodPanel?.thoughts ?? []).filter((t) => !t.situational).map((t) => t.label + "(" + t.delta + ")").sort();
  add("记下的心事", storedOld, storedNew);
  add("态度：信任", rel.trust ?? 0, view.fields.bond?.trust ?? null);
  add("态度：张力", rel.tension ?? 0, view.fields.bond?.tension ?? null);
  add("态度：阶段", rel.stage ?? null, view.fields.bond?.stage ?? null);
  const whoOld = old.facts.map((f) => f.key + "=" + whoOf(f, herId, s.player_id)).filter((x) => !x.endsWith("=null")).sort();
  const whoNew = [...view.fields.known_facts.map((f) => f.key + "=shared"), ...view.fields.her_knows.map((f) => f.key + "=" + f.who)];
  // known_facts 里 shared 和 you 混在一起：按旧的谁知道去对
  const youKeys = new Set(old.facts.filter((f) => whoOf(f, herId, s.player_id) === "you").map((f) => f.key));
  add("事实与谁知道", whoOld, whoNew.map((x) => (youKeys.has(x.split("=")[0]) ? x.split("=")[0] + "=you" : x)).sort());
  const openOld = Object.values(s.events ?? {}).filter((e) => e.state === "pending" && (e.kind === "promise" || !(e.participants ?? []).includes(s.player_id)))
    .map((e) => e.title + "@" + C.fromClock(e.due)).sort();
  add("未结束的约定", openOld, view.fields.events.map((e) => e.title + "@" + e.due).sort());
  const planOld = s.plan?.note && T.before(now, C.fromClock(s.plan.until)) ? s.plan.note + "@" + C.fromClock(s.plan.until) : null;
  const planNew = view.fields.plan ? view.fields.plan.note + "@" + view.fields.plan.until : null;
  add("她的安排", planOld, planNew);
  return rows;
}
