/* lib/engine/modules/memory/layers.js — 她的记忆：三层，跟着真实时间变淡（照 RimTalk-ExpandMemory）。
 *
 *   ABM   刚发生的：不衰减、不注入（这段对话本身就在上下文里）。满 20 条、或者停了一小时，
 *         宿主起子代理把这一批收成一条 SCM，ABM 清空重来。顺手的小动作不往下走，24 小时后丢掉。
 *   SCM   比一段对话活得久的情境记忆：每小时衰减 0.005（约 30 天淡掉），最多 50 条，满了先挤掉最不活跃的。
 *         注入的就是这一层（加上 CLPA）。
 *   CLPA  她认定要一直记着的：不衰减、不限条数，只有你能改能删。
 *   日记  每天一篇，由当天的 SCM 写成，落成文件（不在账本里）；这里只记「哪天写过了」。
 *
 * 活跃度不每小时写回：一条记着最后一次被碰时的值 a0 和时刻 t0，读的时候现算 a0 * (1 - rate) ^ 小时数。
 * 纯函数：全部返回新切片，不改入参。
 */

import * as T from "../../core/time.js";
import { keywords } from "./recall.js";

export const LAYERS = Object.freeze(["abm", "scm", "clpa"]);
export const LAYER_LABELS = Object.freeze({ abm: "ABM", scm: "SCM", clpa: "CLPA" });
const DECAY = { abm: 0, scm: 0.005, clpa: 0 };
/** null = 不限（CLPA 只有你能清）。 */
export const CAPACITY = Object.freeze({ abm: 20, scm: 50, clpa: null });
/** 停了这么久还没满，也要把 ABM 收成一条 SCM。 */
export const IDLE_MINUTES = 60;
/** 每天这个钟点之后，今天的日记才算该写了。 */
export const DIARY_MINUTE = 23 * 60 + 30;
const ACTION_LIFESPAN = 24 * 60;
export const CLEAN_BELOW = 0.025;
/** 往下走的类型；action 到期就丢。 */
const KEEPS = new Set(["conversation", "experience"]);
export const CONTENT_MAX = 4000;
export const SUMMARY_MAX = 600;
export const DIARY_MAX = 300;
const YOU_MAX = 60;
const CLEARNESS = [[0.7, "记忆犹新"], [0.4, "大概记得"], [0.1, "有些模糊了"], [0, "记不起来了"]];

export function init() {
  return { entries: [], next: 1, milestones: [], weighed: [], last_diary_day: null, diary_last: null };
}

const num = (entry) => Number(entry.id.slice(1));
const byTime = (a, b) => T.ms(a.at) - T.ms(b.at) || num(a) - num(b);
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** 这一刻的活跃度（Pin 的和 ABM 不衰减）。 */
export function activity(entry, now) {
  if (entry.pinned || entry.layer === "abm") return entry.a0;
  const hours = T.minutesBetween(entry.t0, now) / 60;
  return entry.a0 * (1 - DECAY[entry.layer]) ** hours;
}

export const clearness = (value) => CLEARNESS.find(([floor]) => value >= floor)[1];

/** 加一条，返回 { slice, entry }。 */
export function add(slice, { layer, type, content, importance, at, ...extra }) {
  const text = String(content).trim().slice(0, CONTENT_MAX);
  const entry = {
    id: "m" + slice.next,
    layer,
    type,
    content: text,
    importance: Math.round(clamp01(importance) * 1000) / 1000,
    a0: 1,
    t0: at,
    at,
    keywords: keywords(text),
    origin_ids: [],
    quotes: [],
    you: "",
    note: "",
    pinned: false,
    edited: false,
    ...extra,
  };
  return { slice: { ...slice, entries: [...slice.entries, entry], next: slice.next + 1 }, entry };
}

/**
 * 宿主替她记的这一段（回合结束时，不靠模型交作业）。同样的内容已经在 ABM 里就不再记
 * （宿主重试同一轮时会再来一次）。返回 { slice, entry, duplicate }。
 */
export function noteExchange(slice, { text, together = true, you = "", importance = 0.3, extra = {} }, now) {
  // 换行留着：一批是「你：… 她：…」一轮一组，靠换行分开
  const content = String(text ?? "").trim().slice(0, CONTENT_MAX);
  if (content === "") return { slice, entry: null, duplicate: false };
  const same = slice.entries.find((e) => e.layer === "abm" && KEEPS.has(e.type) && e.content === content);
  if (same !== undefined) return { slice, entry: same, duplicate: true };
  const made = add(slice, {
    layer: "abm", type: together ? "conversation" : "experience", content, importance, at: now,
    you: String(you).slice(0, YOU_MAX), exchanged: true, ...extra,
  });
  return { ...made, duplicate: false };
}

/** 清掉淡光的、超容量的、过期的小动作（ABM 由收成 SCM 那一步清，不在这里）。 */
export function maintain(slice, now) {
  let entries = slice.entries.filter((e) => !(e.layer === "abm" && !KEEPS.has(e.type) && !e.pinned
    && T.minutesBetween(e.at, now) >= ACTION_LIFESPAN));
  // 小动作垫着会让 ABM 胀过二十条：满了先丢最老的小动作，该收的那批一条不动
  const abm = entries.filter((e) => e.layer === "abm" && !e.pinned);
  if (abm.length > CAPACITY.abm) {
    const spare = abm.filter((e) => !KEEPS.has(e.type)).sort(byTime).slice(0, abm.length - CAPACITY.abm).map((e) => e.id);
    entries = entries.filter((e) => !spare.includes(e.id));
  }
  // 宿主收不了（没有子代理服务、一直失败）时 ABM 只进不出：超过两倍容量就丢最老的，别无限涨
  const kept = entries.filter((e) => e.layer === "abm" && !e.pinned).sort(byTime);
  if (kept.length > CAPACITY.abm * 2) {
    const old = new Set(kept.slice(0, kept.length - CAPACITY.abm * 2).map((e) => e.id));
    entries = entries.filter((e) => !old.has(e.id));
  }
  entries = entries.filter((e) => e.layer !== "scm" || e.pinned || activity(e, now) >= CLEAN_BELOW);
  const scm = entries.filter((e) => e.layer === "scm" && !e.pinned)
    .sort((a, b) => activity(a, now) - activity(b, now) || byTime(a, b));
  const over = scm.slice(0, Math.max(0, scm.length - CAPACITY.scm)).map((e) => e.id);
  if (over.length > 0) entries = entries.filter((e) => !over.includes(e.id));
  return entries.length === slice.entries.length ? slice : { ...slice, entries };
}

/**
 * 该收成一条 SCM 的那一批（id 按时间排），没有就是 null。
 *
 * 两个触发：满 20 条；或者停了一小时 —— 最近一条离现在已经一小时，或者中间有一段一小时的空白
 * （那就把空白之前的收掉：你隔了一小时再开口，刚说的这句不算进上一批）。
 * manual：设置页「立即汇总」，不等，ABM 里能收的全收。
 */
export function foldBatch(slice, now, { manual = false } = {}) {
  const waiting = slice.entries.filter((e) => e.layer === "abm" && KEEPS.has(e.type)).sort(byTime);
  if (waiting.length === 0) return null;
  if (manual) {
    const pool = waiting.filter((e) => !e.pinned);
    return pool.length === 0 ? null : waiting.map((e) => e.id);
  }
  const moments = [...waiting.map((e) => e.at), now];
  let cut = -1;
  for (let i = moments.length - 1; i > 0; i -= 1) {
    if (T.minutesBetween(moments[i - 1], moments[i]) >= IDLE_MINUTES) {
      cut = i;
      break;
    }
  }
  if (cut > 0) return waiting.slice(0, cut).map((e) => e.id);
  return waiting.filter((e) => !e.pinned).length >= CAPACITY.abm ? waiting.map((e) => e.id) : null;
}

/**
 * 一批 ABM 收成一条 SCM，这一批清掉。keep 是子代理挑的 0~2 条，连同 Pin 的（里程碑）抄进 CLPA。
 * 返回新切片；ids 一条都不在了（设置页删光了）返回 null。
 */
export function applyFold(slice, ids, text, keep = [], now) {
  const picked = slice.entries.filter((e) => ids.includes(e.id)).sort(byTime);
  if (picked.length === 0) return null;
  let next = slice;
  for (const source of picked) {
    if (!keep.includes(source.id) && !source.pinned) continue;
    const made = add(next, { layer: "clpa", type: source.type, content: source.content, importance: source.importance, at: source.at, pinned: source.pinned === true });
    next = { ...made.slice, entries: made.slice.entries.map((e) => (e.id === made.entry.id ? { ...e, keywords: source.keywords, origin_ids: [source.id] } : e)) };
  }
  const latest = picked.at(-1);
  const importance = picked.reduce((sum, e) => sum + e.importance, 0) / picked.length;
  const made = add(next, { layer: "scm", type: "summary", content: String(text).slice(0, SUMMARY_MAX), importance, at: latest.at, t0: now });
  const merged = [...new Set([...made.entry.keywords, ...picked.flatMap((e) => e.keywords)])].slice(0, 32);
  const gone = new Set(picked.map((e) => e.id));
  return {
    ...made.slice,
    entries: made.slice.entries
      .filter((e) => !gone.has(e.id))
      .map((e) => (e.id === made.entry.id ? { ...e, keywords: merged, origin_ids: picked.map((p) => p.id) } : e)),
  };
}

/**
 * 欠着的最早那一天的日记：{ day, ids }，没有就是 null。
 * 不只看今天：23:30 那会儿没人说话，那一天照样欠着，明天想起来也要补。今天的要过了 23:30 才算该写。
 * manual：设置页「立即写日记」，今天的不等 23:30。
 */
export function diaryDue(slice, now, { manual = false } = {}) {
  const today = T.dayKey(now);
  const pool = slice.entries.filter((e) => e.layer === "scm" && !e.pinned && !e.diary_day
    && (slice.last_diary_day === null || T.dayKey(e.at) > slice.last_diary_day) && T.dayKey(e.at) <= today);
  if (pool.length === 0) return null;
  const day = pool.map((e) => T.dayKey(e.at)).sort()[0];
  if (!manual && day === today && T.minuteOfDay(now) < DIARY_MINUTE) return null;
  return { day, ids: pool.filter((e) => T.dayKey(e.at) === day).sort(byTime).map((e) => e.id) };
}

/** 唤醒用：今天有该写进日记的，那就 23:30 叫醒她一次（已经过了就是现在）。 */
export function diaryWakeAt(slice, now) {
  const owed = diaryDue(slice, now, { manual: true });
  if (owed === null) return null;
  if (owed.day < T.dayKey(now) || T.minuteOfDay(now) >= DIARY_MINUTE) return { day: owed.day, at: T.addMinutes(now, 1) };
  return { day: owed.day, at: T.nextClock(now, "23:30") };
}

/** 那一天写进日记了：SCM 只记下「写进了哪天」，不删。 */
export function applyDiary(slice, day, ids, text) {
  return {
    ...slice,
    entries: slice.entries.map((e) => (ids.includes(e.id) ? { ...e, diary_day: day } : e)),
    last_diary_day: day,
    diary_last: { day, text: String(text).slice(0, DIARY_MAX) },
  };
}

/**
 * 设置页改一条。改了「她记得什么」（内容、重要度、关键词）算你改过；活跃度从你给的值重新开始衰减；
 * Pin 上就冻在这一刻的值。找不到返回 null。
 */
export function edit(slice, id, changes, now) {
  const found = slice.entries.find((e) => e.id === id);
  if (found === undefined) return null;
  let e = { ...found };
  if (typeof changes.pinned === "boolean" && changes.pinned !== e.pinned) e = { ...e, a0: activity(e, now), t0: now, pinned: changes.pinned };
  if (typeof changes.content === "string" && changes.content.trim() !== "" && changes.content.trim() !== e.content) {
    e = { ...e, content: changes.content.trim().slice(0, CONTENT_MAX), edited: true, ...(changes.keywords === undefined ? { keywords: keywords(changes.content) } : {}) };
  }
  if (Number.isFinite(changes.importance) && clamp01(changes.importance) !== e.importance) e = { ...e, importance: clamp01(changes.importance), edited: true };
  if (Array.isArray(changes.keywords)) {
    const wanted = [...new Set(changes.keywords.map((k) => String(k).trim().slice(0, 20)).filter((k) => k !== ""))].slice(0, 32);
    if (wanted.join() !== e.keywords.join()) e = { ...e, keywords: wanted, edited: true };
  }
  if (Number.isFinite(changes.activity) && Math.abs(changes.activity - activity(e, now)) > 1e-6) e = { ...e, a0: clamp01(changes.activity), t0: now };
  if (typeof changes.note === "string") e = { ...e, note: changes.note.slice(0, 200) };
  return { ...slice, entries: slice.entries.map((x) => (x.id === id ? e : x)) };
}

export function remove(slice, id) {
  if (!slice.entries.some((e) => e.id === id)) return null;
  return { ...slice, entries: slice.entries.filter((e) => e.id !== id) };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const weekday = (at) => WEEKDAYS[new Date(T.dayKey(at) + "T00:00:00Z").getUTCDay()];
const hm = (at) => {
  const m = T.minuteOfDay(at);
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
};
const PARTS = [[5, "凌晨"], [9, "早上"], [12, "上午"], [14, "中午"], [18, "下午"], [23, "晚上"], [24, "深夜"]];
const partOf = (at) => PARTS.find(([upto]) => Math.floor(T.minuteOfDay(at) / 60) < upto)[1];

/** 注入用：「周四下午 14:00」—— 哪天、几点，不写日期。 */
export const whenShort = (at) => weekday(at) + partOf(at) + " " + hm(at);
/** 设置页用：「11.11 周三 14:00」—— 带日期，好排序。 */
export const whenLabel = (at) => {
  const [, mo, da] = T.dayKey(at).split("-");
  return Number(mo) + "." + Number(da) + " " + weekday(at) + " " + hm(at);
};
/** 日记标题：「11月11日 · 周三」。 */
export const dayTitle = (day) => {
  const [, mo, da] = day.split("-");
  return Number(mo) + "月" + Number(da) + "日 · " + weekday(day + "T12:00:00Z");
};

/** 一批 / 一天的原文，给子代理读：[{ id, when, text }]。 */
export const sources = (slice, ids) => slice.entries.filter((e) => ids.includes(e.id)).sort(byTime)
  .map((e) => ({ id: e.id, when: whenShort(e.at), text: e.content }));

/** 设置页「记忆」页：全部条目（新的在前）、各层条数。 */
export function panel(slice, now) {
  const rows = [...slice.entries].reverse().map((e) => ({
    id: e.id,
    layer: e.layer,
    layer_label: LAYER_LABELS[e.layer],
    type: e.type,
    content: e.content,
    importance: e.importance,
    pinned: e.pinned,
    edited: e.edited,
    note: e.note,
    activity: Math.round(activity(e, now) * 10000) / 10000,
    at: e.at,
    when: whenLabel(e.at),
    keywords: e.keywords,
    origin_ids: e.origin_ids,
    ...(e.quotes?.length ? { quotes: e.quotes } : {}),
    ...(e.you ? { you: e.you } : {}),
    ...(e.milestone ? { milestone: e.milestone } : {}),
  }));
  const counts = Object.fromEntries(LAYERS.map((layer) => [layer, slice.entries.filter((e) => e.layer === layer).length]));
  return { entries: rows, counts, capacity: { ...CAPACITY }, layers: { ...LAYER_LABELS } };
}
