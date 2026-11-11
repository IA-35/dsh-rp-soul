/* lib/engine/modules/wake/schedule.js — 她下一次该什么时候自己醒。
 *
 * 全从账本推出来：她的安排、你们的约定、她自己的事、你多久没说话、作息的下一段。
 * 纯函数：now 传进来，不改账本。真正的定时器、额度、送达在宿主那一半（lib/wake.js）。
 *
 * 安静时段（默认 00:00-08:00）只压住她没要求的那些：她自己定的安排凌晨三点也能叫醒她。
 */

import * as T from "../../core/time.js";

/** 同一时刻有几个候选时，按这个顺序取。 */
export const REASONS = Object.freeze(["plan", "promise", "event", "miss_you", "diary", "routine"]);
export const REASON_LABELS = Object.freeze({
  plan: "她说好做到的时间",
  promise: "你们的约定",
  event: "她自己的事",
  miss_you: "想你了",
  diary: "写日记的时间",
  routine: "作息换段",
});
/** 约定到期前多久叫醒她。 */
export const LEAD_MINUTES = 30;
/** 「想你了」：你一直没回，一次比一次隔得久（小时）。 */
export const MISS_YOU_NEXT = Object.freeze([6, 12, 24]);
export const DEFAULTS = Object.freeze({ missYouHours: 6, quiet: "00:00-08:00", routine: true });

/** "00:00-08:00" → [0, 480]；空的、写坏的、首尾相同的都算没有安静时段。 */
export function parseQuiet(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const parts = text.split("-");
  if (parts.length !== 2) return null;
  const ends = parts.map((p) => T.parseClock(p));
  if (ends.some((e) => e === null) || ends[0] === ends[1]) return null;
  return ends;
}

/** 这个时刻落在安静时段里吗（时段可以跨午夜）。 */
export function inQuiet(at, quiet) {
  if (quiet === null) return false;
  const [start, end] = quiet;
  const minute = T.minuteOfDay(at);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

const hhmm = (minute) => String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
const toMinute = (v) => (typeof v === "number" ? v : T.parseClock(v));

/** 在安静时段里就推到它结束的那一刻，否则原样。 */
function afterQuiet(at, quiet) {
  if (!inQuiet(at, quiet)) return at;
  return T.nextClock(at, hhmm(quiet[1]));
}

const row = (reason, at, why, extra = {}) => ({ reason, label: REASON_LABELS[reason], at, why, ...extra });

function planRows(plan, now) {
  if (plan === null || plan === undefined || !T.before(now, plan.until)) return [];
  return [row("plan", plan.until, plan.note)];
}

/** 约定：到期前半小时（来不及就到期那一刻）；她自己的事：到期那一刻。过了时间的不再叫。 */
function eventRows(events, now) {
  const out = [];
  for (const e of Object.values(events)) {
    if (e.state !== "pending" || e.due === null || !T.before(now, e.due)) continue;
    if (e.kind === "promise") {
      const lead = T.addMinutes(e.due, -LEAD_MINUTES);
      out.push(row("promise", T.before(now, lead) ? lead : e.due, "离「" + e.title + "」还有半小时", { event_id: e.id }));
    } else {
      out.push(row("event", e.due, "「" + e.title + "」到时间了", { event_id: e.id }));
    }
  }
  return out;
}

/**
 * 「想你了」：从你上次说话起隔 hours 小时；她已经醒过、你还没回，就从她上次醒来起、隔得越来越久。
 * 算出来的时刻已经过了就是一分钟后。
 */
function missYouRows(state, now, { missYouHours, streak, lastWakeAt }) {
  if (!missYouHours) return [];
  const said = state.you.last_said_at;
  let base = said ?? state.started_at;
  let gap = missYouHours;
  for (let i = 0; i < Math.max(0, Math.trunc(streak)); i += 1) gap = MISS_YOU_NEXT[Math.min(i + 1, MISS_YOU_NEXT.length - 1)];
  if (streak > 0 && T.isTime(lastWakeAt) && T.before(base, lastWakeAt)) base = T.iso(T.ms(lastWakeAt), T.offsetOf(now));
  let at = T.addMinutes(base, gap * 60);
  if (!T.before(now, at)) at = T.addMinutes(now, 1);
  const hours = Math.floor(T.minutesBetween(said ?? base, at) / 60);
  return [row("miss_you", at, state.you.name + " 已经 " + hours + " 小时没说话了")];
}

/** 日记：记忆模块说今天有该写的（diary: { day, at }），到点叫醒她，醒来那一轮结束时宿主写。 */
function diaryRows(diary, now) {
  if (diary === null || diary === undefined) return [];
  const why = diary.day === T.dayKey(now) ? "该把今天写进日记了" : diary.day + " 的日记还欠着，该补上了";
  return [row("diary", diary.at, why)];
}

/** 作息的下一段从几点开始。 */
function routineRows(persona, now) {
  const starts = (persona?.routine ?? [])
    .map((slot) => ({ minute: toMinute(slot.from), doing: slot.doing ?? "换个样子" }))
    .filter((s) => s.minute !== null);
  if (starts.length === 0) return [];
  const next = starts
    .map((s) => ({ ...s, at: T.nextClock(now, hhmm(s.minute)) }))
    .sort((a, b) => T.ms(a.at) - T.ms(b.at))[0];
  return [row("routine", next.at, "", { doing: next.doing })];
}

const routineWhy = (at, doing) => "到 " + hhmm(T.minuteOfDay(at)) + " 了，按平常该「" + doing + "」了";

/**
 * 所有候选，早的在前。options：{ missYouHours, streak, lastWakeAt, routine, quiet, diary }。
 * 每一条 { reason, label, at, at_real, why, quiet_shifted? }（at_real 和 at 是同一个时刻，宿主认这个名字）。
 */
export function candidates(state, plan, { now, persona = null, ...options } = {}) {
  if (state.safety?.paused) return [];
  // 没给的（undefined）用默认值；给了 0 / "" 就是关掉
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, streak: 0, lastWakeAt: null, ...given };
  const quiet = parseQuiet(opts.quiet);
  const rows = [
    ...planRows(plan, now),
    ...eventRows(state.events, now),
    ...missYouRows(state, now, opts),
    ...diaryRows(opts.diary, now),
    ...(opts.routine ? routineRows(persona, now) : []),
  ];
  return rows
    .map((r) => {
      // 她自己的安排不受安静时段管
      const at = r.reason === "plan" ? r.at : afterQuiet(r.at, quiet);
      const shifted = at !== r.at ? { quiet_shifted: true } : {};
      const why = r.reason === "routine" ? routineWhy(at, r.doing) : r.why;
      return { ...r, at, at_real: at, why, ...shifted };
    })
    .sort((a, b) => T.ms(a.at) - T.ms(b.at) || REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason));
}

/** 最早的那条，连同全部候选。 */
export function next(state, plan, opts) {
  const all = candidates(state, plan, opts);
  return { next: all[0] ?? null, all };
}
