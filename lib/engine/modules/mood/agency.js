/* lib/engine/modules/mood/agency.js — 她下一步可能做什么。
 *
 * 候选由这一刻的局面确定性地打分得出（心情、态度、还挂着的约定、刚知道的事、身体、钟点），
 * 模型只能从里面挑「重大行动」；不重大的随口举动不受限制。
 * 重大行动有冷却：上一次之后 20 分钟（开心时 10 分钟）；难过时只能做情绪反应，不受冷却限制。
 */

import * as S from "../../core/schema.js";
import * as T from "../../core/time.js";

export const KINDS = Object.freeze(["approach", "observe", "request", "accident", "provoke", "leave", "silence", "seek_comfort", "change_topic", "withdraw"]);
export const KIND_ZH = Object.freeze({
  approach: "主动找你", observe: "在旁观察", request: "提要求", accident: "意外", provoke: "刺你一句",
  leave: "走开/冷场", silence: "沉默", seek_comfort: "寻求安慰", change_topic: "转移话题", withdraw: "独处",
});
/** 低落、难过时也能做的情绪反应。 */
export const REACTIONS = Object.freeze(new Set(["provoke", "leave", "silence", "seek_comfort", "change_topic", "withdraw"]));
const COOLDOWN = 20;
const COOLDOWN_OPEN = 10;
const MAX_CANDIDATES = 3;
const RECENT_MINUTES = 30;
const DAY = 1440;

export const FIELD = S.describe(S.obj({
  significant: S.describe(S.bool(), "her.did 是一次重大行动（要过冷却、要是候选里的）"),
  kind: S.describe(S.oneOf(KINDS), "重大行动是哪一种：从「可能发生」的候选里挑"),
}), "只在 her.did 是她主动的一件大事时写");

/** 冷却好了没有：返回还要等的分钟数（0 = 好了）。 */
export function cooldownLeft(majorAt, band, now) {
  if (!majorAt || band === "break") return 0;
  const wait = band === "open" ? COOLDOWN_OPEN : COOLDOWN;
  return Math.max(0, wait - T.minutesBetween(majorAt, now));
}

/** 同样的局面、同样的时刻，永远同样的微小扰动（10 分钟一档，不靠随机数）。 */
function nudge(seed, kind, now) {
  let hash = 2166136261;
  for (const ch of seed + "|" + kind + "|" + Math.floor(T.ms(now) / 600000)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  return (hash % 1000) / 1000;
}

/**
 * 打分：[{ kind, weight, reasons, events, facts }]，按分数从高到低、同分按 KINDS 顺序。
 * mood：{ value, band, thoughts }；bond：{ trust, tension, stage }。
 */
export function score(mood, bond, ctx) {
  const rows = [];
  const add = (kind, weight, reason, extra = {}) => { if (weight > 0) rows.push({ kind, weight, reason, ...extra }); };
  const weighing = mood.thoughts.slice(0, 2).map((t) => t.label);
  const bandReason = "心情" + { open: "开心", normal: "平稳", closed: "低落", break: "难过" }[mood.band] + "（" + mood.value + "）" + (weighing.length ? "，" + weighing.join("、") : "");
  const low = mood.band === "closed" || mood.band === "break";
  const stageIndex = ["stranger", "acquainted", "familiar", "flirting", "testing", "intimate", "committed"].indexOf(bond.stage);

  add("approach", mood.band === "open" ? 2 : 0, bandReason);
  add("request", mood.band === "open" ? 1 : 0, bandReason);
  add("observe", mood.band === "normal" || mood.band === "closed" ? 1 : 0, bandReason);
  for (const kind of ["silence", "change_topic", "withdraw"]) add(kind, low ? 2 : 0, bandReason);
  if (low && bond.trust >= 1) add("seek_comfort", 3, "虽然难过，还是信任你（信任 " + bond.trust + "），想有人陪一会儿");
  if (low && bond.trust < 0) add("withdraw", 3, "心里难受又不太信任你，想自己缓一会儿");

  const pending = (ctx.ask("core.openEvents") ?? []).filter((e) => e.kind === "promise");
  if (pending.length > 0) {
    const first = pending[0];
    add("request", 2, "还有件事没个答复：" + first.title, { events: pending.map((e) => e.id) });
    if (first.due !== null && T.minutesBetween(ctx.now, first.due) <= DAY) add("approach", 2, "有件该办的事快到期：" + first.title, { events: [first.id] });
  }
  if (bond.tension >= 3) {
    add("provoke", 2, "你们之间还绷着（张力 " + bond.tension + "）");
    add("observe", 1, "你们之间还绷着，得先看清楚");
  }
  if (bond.trust >= 2 && stageIndex >= 2) add("approach", 2, "已经熟了（信任 " + bond.trust + "），敢自己凑过来");
  if (bond.trust <= -2) {
    add("leave", 1, "信不过你（信任 " + bond.trust + "）");
    add("provoke", 1, "信不过你（信任 " + bond.trust + "）");
  }
  const recent = ctx.ask("core.recentFacts", RECENT_MINUTES) ?? [];
  if (recent.length > 0) {
    add("observe", 2, "刚知道点事，正琢磨", { facts: recent });
    add("request", 1, "刚知道点事，想问个明白", { facts: recent });
  }
  if ((ctx.ask("core.conditions") ?? []).some((c) => ["drunk", "asleep", "unconscious"].includes(c.kind))) {
    add("leave", 2, "身体不太对劲");
    add("observe", 0.5, "身体不太对劲，不太想动");
  }
  const hour = Math.floor(T.minuteOfDay(ctx.now) / 60);
  if (hour >= 23 || hour < 6) {
    add("leave", 1, "这么晚了，想收场");
    add("observe", 0.5, "这么晚了，不想多说话");
  }
  if (ctx.alone) add("observe", 0.5, "你这会儿不在");

  const seed = (ctx.kernel?.persona?.id ?? "") + (ctx.kernel?.started_at ?? "");
  return rows.map((r) => ({ ...r, weight: r.weight + nudge(seed, r.kind, ctx.now) }));
}

/** 她名字开头的一句话，有约定就带上约定。 */
function textOf(name, kind, title) {
  switch (kind) {
    case "approach": return title ? name + " 主动凑过来，提起" + title : name + " 主动来找你";
    case "observe": return name + " 没出声，只是看着你";
    case "request": return title ? name + " 开口要一个答复：" + title : name + " 开口要一个答复";
    case "provoke": return name + " 用一句话刺过来";
    case "leave": return name + " 不想再说了，转身走开";
    case "silence": return name + " 安静下来，暂时没有开口";
    case "seek_comfort": return name + " 试着告诉你自己的难过，想有人陪一会儿";
    case "change_topic": return name + " 暂时放下这个话题，转而说起别的事";
    case "withdraw": return name + " 想自己待一会儿，慢慢缓过来";
    default: return name + " 遇到点意外";
  }
}

/** 最多三个候选；冷却没好就一个都没有。难过时只留情绪反应。 */
export function candidates(mood, bond, majorAt, ctx, limit = MAX_CANDIDATES) {
  if (cooldownLeft(majorAt, mood.band, ctx.now) > 0) return [];
  let rows = score(mood, bond, ctx);
  if (mood.band === "break") rows = rows.filter((r) => REACTIONS.has(r.kind));
  rows.sort((a, b) => b.weight - a.weight || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const reasons = {};
  for (const r of rows) if (r.reason && !(reasons[r.kind] ??= []).includes(r.reason)) reasons[r.kind].push(r.reason);
  const name = ctx.kernel?.her?.name ?? "她";
  const titles = Object.fromEntries((ctx.ask("core.openEvents") ?? []).map((e) => [e.id, e.title]));
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    const why = (reasons[r.kind] ?? []).slice(0, 2);
    out.push({
      kind: r.kind,
      label: KIND_ZH[r.kind],
      text: textOf(name, r.kind, r.events?.length ? titles[r.events[0]] : null),
      weight: Math.round(r.weight * 1000) / 1000,
      because: why.length ? ("因为" + why.join("，而且")).slice(0, 90) : "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 重大行动的校验：难过时只能是情绪反应；否则要过冷却、要是候选里的。 */
export function validate(input, mood, bond, majorAt, ctx) {
  const act = input.act;
  if (act?.significant !== true) return [];
  const problems = [];
  if (input.her?.did === undefined) problems.push({ path: "$.her.did", reason: "重大行动要写她做了什么", hint: "" });
  if (act.kind === undefined) {
    problems.push({ path: "$.act.kind", reason: "重大行动要写是哪一种", hint: "从「可能发生」的候选里挑" });
    return problems;
  }
  if (mood.band === "break") {
    if (!REACTIONS.has(act.kind)) problems.push({ path: "$.act.kind", reason: "她现在难过，重大行动只能是情绪反应", hint: "可选：" + [...REACTIONS].join(" / ") });
    return problems;
  }
  const wait = cooldownLeft(majorAt, mood.band, ctx.now);
  if (wait > 0) {
    problems.push({ path: "$.act.significant", reason: "上一次重大行动刚过去不久，还要 " + wait + " 分钟", hint: "这一次写成不重大的（去掉 act）" });
    return problems;
  }
  const kinds = candidates(mood, bond, majorAt, ctx).map((c) => c.kind);
  if (!kinds.includes(act.kind)) problems.push({ path: "$.act.kind", reason: "「" + KIND_ZH[act.kind] + "」不在这一刻的候选里", hint: "候选：" + (kinds.join(" / ") || "没有") });
  return problems;
}
