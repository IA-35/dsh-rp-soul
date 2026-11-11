/* lib/engine/modules/mood/thoughts.js — 心事与心情档位。
 *
 * 心情 = 基准值 + 这一刻还在起作用的心事之和，夹在 0..100，按阈值切成四档：
 *   open 开心 / normal 平稳 / closed 低落 / break 难过
 *
 * 心事有两种来处：
 *   记下的（stored）：模型写的 feel、信任变化、关系推进——真发生了的事，写进切片。
 *   推出来的（derived）：在场 / 你不在 / 很久没见你 / 约定落空 / 快到期 / 还绷着 / 身体不对劲 / 大半夜被打扰——
 *     全由这一刻的局面推出来，从不写进账本。所以你周一才回来、撤销了一次交账，结果都一样。
 * 心事都带 since / until（真实时刻）；记下的那种按剩余时间线性变淡。
 */

import * as T from "../../core/time.js";

export const BASE = 50;
export const THRESHOLDS = Object.freeze({ open: 75, closed: 45, break: 25 });
export const BANDS = Object.freeze(["open", "normal", "closed", "break"]);
export const BAND_ZH = Object.freeze({ open: "开心", normal: "平稳", closed: "低落", break: "难过" });
export const DELTA_RANGE = Object.freeze([-30, 15]);
/** 记下的心事最多留这么多条；多了按「这一刻的分量」淘汰最弱的。 */
const STORED_CAP = 12;

const HOUR = 60;
const DAY = 1440;
/** 几种常见的持续时长（分钟）。 */
export const DURATION = Object.freeze({ tone: 6 * HOUR, refuse: DAY, broken_promise: 5 * DAY, stage: 10 * DAY });
/** 模型写的心事不写时长时，默认持续一天。 */
export const FEEL_DEFAULT_MINUTES = DAY;

/**
 * 情境心事：条件 → 一条推出来的心事。delta 与时长沿用旧引擎的 situational.json。
 * when(ctx, extra) 返回 null（不成立）或 { since, until }（until 为 null 表示「条件在就一直在」）。
 */
export const SITUATIONAL = Object.freeze([
  { id: "present", label: "在场", delta: 3 },
  { id: "absent", label: "你不在", delta: -2 },
  { id: "away_long", label: "很久没见你", delta: -5, minutes: DAY },
  { id: "event_overdue", label: "约定落空了", delta: -10, minutes: DAY },
  { id: "event_due", label: "有件该办的事快到期", delta: -6 },
  { id: "tension", label: "你们之间还绷着", delta: -6 },
  { id: "condition", label: "身体不太对劲", delta: -4 },
  { id: "late_hour", label: "大半夜被打扰", delta: -3, minutes: 6 * HOUR },
]);
const INCAPACITATING = new Set(["drunk", "asleep", "unconscious"]);
const isLate = (iso) => {
  const hour = Math.floor(T.minuteOfDay(iso) / 60);
  return hour >= 23 || hour < 6;
};

/** 这一刻成立的情境心事（推出来的，不写账本）。 */
export function situational(slice, ctx) {
  const now = ctx.now;
  const out = [];
  const add = (row, since, until = null) => out.push({ label: row.label, delta: row.delta, kind: "situational", since, until });
  const row = (id) => SITUATIONAL.find((r) => r.id === id);
  if (ctx.alone) add(row("absent"), now);
  else add(row("present"), ctx.ask("core.sceneSince") ?? now);
  if (slice.back_at && T.before(now, T.addMinutes(slice.back_at, DAY))) add(row("away_long"), slice.back_at, T.addMinutes(slice.back_at, DAY));
  for (const e of ctx.ask("core.openEvents") ?? []) {
    if (e.kind !== "promise" || e.due === null) continue;
    if (e.status === "overdue" && T.before(now, T.addMinutes(e.due, DAY))) add(row("event_overdue"), e.due, T.addMinutes(e.due, DAY));
  }
  const soon = (ctx.ask("core.openEvents") ?? []).some((e) => e.status === "pending" && e.due !== null && T.minutesBetween(now, e.due) <= DAY);
  if (soon) add(row("event_due"), now);
  if ((slice.bond?.tension ?? 0) >= 3) add(row("tension"), now);
  if ((ctx.ask("core.conditions") ?? []).some((c) => INCAPACITATING.has(c.kind))) add(row("condition"), now);
  const said = ctx.ask("core.lastSaidAt");
  if (said && isLate(said) && T.before(now, T.addMinutes(said, 6 * HOUR))) add(row("late_hour"), said, T.addMinutes(said, 6 * HOUR));
  return out;
}

/** 一条心事这一刻的分量：记下的按剩余时间线性变淡；到期就是 0。 */
export function weightOf(thought, now) {
  if (thought.until !== null && !T.before(now, thought.until)) return 0;
  if (thought.kind === "situational" || thought.until === null || thought.decay === "none") return thought.delta;
  const total = T.ms(thought.until) - T.ms(thought.since);
  if (!(total > 0)) return thought.delta;
  const left = (T.ms(thought.until) - T.ms(now)) / total;
  return Math.round(thought.delta * Math.min(1, Math.max(0, left)));
}

/** 这一刻在起作用的全部心事（记下的 + 推出来的），分量大的在前。 */
export function active(slice, ctx) {
  const stored = (slice.thoughts ?? []).map((t) => ({ ...t, weight: weightOf(t, ctx.now) }));
  const derived = situational(slice, ctx).map((t) => ({ ...t, weight: t.delta }));
  return [...stored, ...derived]
    .filter((t) => t.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.id ?? "").localeCompare(b.id ?? ""));
}

/** 阈值：人设里写了就用人设的。 */
export function thresholdsOf(persona) {
  const limits = persona?.mood_thresholds;
  const okay = limits && Number.isInteger(limits.open) && Number.isInteger(limits.closed) && Number.isInteger(limits.break)
    && limits.break < limits.closed && limits.closed < limits.open;
  return okay ? limits : THRESHOLDS;
}

export function bandOf(value, limits = THRESHOLDS) {
  if (value >= limits.open) return "open";
  if (value >= limits.closed) return "normal";
  if (value >= limits.break) return "closed";
  return "break";
}

/** 这一刻的心情：{ value, band, thoughts }。 */
export function evaluate(slice, ctx) {
  const thoughts = active(slice, ctx);
  const total = (slice.base ?? BASE) + thoughts.reduce((sum, t) => sum + t.weight, 0);
  const value = Math.max(0, Math.min(100, total));
  return { value, band: bandOf(value, thresholdsOf(ctx.persona)), thoughts };
}

/**
 * 记一条心事（返回新的心事列表，不改入参）。同一个来由（because）再记一次是刷新，不是叠加：
 * 同一件事发生两次，不该堆出一打心事。
 */
export function addThought(list, thought, now) {
  const minutes = thought.minutes ?? FEEL_DEFAULT_MINUTES;
  const fresh = {
    id: thought.id,
    label: thought.label,
    delta: Math.max(DELTA_RANGE[0], Math.min(DELTA_RANGE[1], thought.delta)),
    kind: "stored",
    source: thought.source,
    because: thought.because ?? null,
    since: now,
    until: minutes === null ? null : T.addMinutes(now, minutes),
  };
  const same = thought.because ? list.findIndex((t) => t.because === thought.because && t.source === thought.source) : -1;
  const next = same >= 0 ? list.map((t, i) => (i === same ? { ...fresh, id: t.id } : t)) : [...list, fresh];
  return capStored(next, now);
}

/** 超过上限就淘汰这一刻分量最弱的（一样弱的淘汰最早的）。 */
function capStored(list, now) {
  if (list.length <= STORED_CAP) return list;
  const ranked = [...list].sort((a, b) => Math.abs(weightOf(a, now)) - Math.abs(weightOf(b, now)) || a.since.localeCompare(b.since));
  const doomed = new Set(ranked.slice(0, list.length - STORED_CAP).map((t) => t.id));
  return list.filter((t) => !doomed.has(t.id));
}

/** 交账落定时：到期的、淡到 0 的记下的心事清掉。 */
export function tidy(list, now) {
  return list.filter((t) => weightOf(t, now) !== 0);
}
