/* lib/engine/modules/memory/index.js — 记忆模块：她记得什么。
 *
 * 交账表里没有它的字段：不让模型交作业。ABM 的正文是宿主在回合结束时记下的原文（engine.noteExchange），
 * 交账的 summary 是第三人称的流水，不进记忆。交账只留下原文里没有的东西：
 *   away（你不在时她做了什么）记成一段经历，顺手的小动作记成 action；
 *   这次碰到的里程碑和值得留下的原话先挂在 pending 上，宿主下一次记原文时并进那一条（钉住、带上原话）。
 * 收成 SCM、写日记由宿主起子代理去做（engine-v2-memory.js），写回来走 engine 的 apply* 方法。
 *
 * 一条有多重：0.3 + 这段时间里冒出来的心事的分量（|delta| / 30，最多 0.5）+ 里程碑 0.2。
 * 心事从情绪模块问（软依赖：情绪关着就按 0.3）；算过的心事 id 记下来，别被两条记忆各算一遍。
 */

import * as L from "./layers.js";
import * as RC from "./recall.js";

/** 往回看多久的心事来定轻重。 */
const WEIGH_MINUTES = 60;
const WEIGHED_KEEP = 50;
const MILESTONE_BONUS = 0.2;
/** 被勾起一次加多少活跃度。 */
const RECALL_BOOST = 0.1;

/** 这段时间里还没被哪条记忆算过的心事，算出分量。返回 { importance, weighed }。 */
export function weigh(slice, ctx, extra = 0) {
  const recent = ctx.ask("mood.recentThoughts", WEIGH_MINUTES) ?? [];
  const fresh = recent.filter((t) => !(slice.weighed ?? []).includes(t.id));
  const weight = fresh.reduce((sum, t) => sum + Math.abs(t.delta), 0);
  return {
    importance: Math.min(1, 0.3 + Math.min(0.5, weight / 30) + extra),
    weighed: [...(slice.weighed ?? []), ...fresh.map((t) => t.id)].slice(-WEIGHED_KEEP),
  };
}

/** 这次交账碰到的里程碑：关系往前走了一步、你们第一次立约定。 */
function milestonesOf(slice, input) {
  const found = [];
  if (input.bond?.stage === "advance") found.push("stage");
  const promised = (input.promise ?? []).some((p) => p.title !== undefined && (p.kind ?? "promise") === "promise");
  if (promised && !slice.milestones.includes("first_promise")) found.push("first_promise");
  return found;
}

/** 交账留下的：离屏片段、小动作；里程碑和原话挂起来等原文。 */
function apply(slice, input, ctx) {
  const milestones = ctx.alone ? [] : milestonesOf(slice, input);
  let next = slice;
  if (milestones.length > 0 || input.quotes?.length) {
    const pending = slice.pending ?? { milestones: [], quotes: [] };
    next = {
      ...next,
      milestones: [...new Set([...next.milestones, ...milestones])],
      pending: {
        milestones: [...new Set([...pending.milestones, ...milestones])],
        quotes: [...pending.quotes, ...(input.quotes ?? [])].slice(-3),
      },
    };
  }
  if (input.away) next = L.add(next, { layer: "abm", type: "experience", content: input.away, importance: 0.3, at: ctx.now }).slice;
  if (input.act && input.act.significant !== true && input.her?.did) {
    next = L.add(next, { layer: "abm", type: "action", content: input.her.did, importance: 0.2, at: ctx.now }).slice;
  }
  return next;
}

/**
 * 宿主记的这一段原文，连同挂着的里程碑和原话：返回 { slice, entry, duplicate }。
 * 一条有多重：0.3 + 这段时间的心事分量 + 有里程碑再加 0.2。
 */
export function noteExchange(slice, { text, together, you }, ctx) {
  const pending = slice.pending ?? { milestones: [], quotes: [] };
  const hasMilestone = pending.milestones.length > 0;
  const { importance, weighed } = weigh(slice, ctx, hasMilestone ? MILESTONE_BONUS : 0);
  const extra = {
    ...(pending.quotes.length > 0 ? { quotes: pending.quotes } : {}),
    ...(hasMilestone ? { pinned: true, milestone: pending.milestones } : {}),
  };
  const made = L.noteExchange({ ...slice, weighed }, { text, together, you, importance, extra }, ctx.now);
  if (made.entry === null || made.duplicate) return { ...made, slice };
  const { pending: _done, ...rest } = made.slice;
  return { ...made, slice: rest };
}

/** 被你这句话勾起的那几条加一点活跃度（想起来的忘得慢）。没有勾起的返回 null。 */
export function reinforce(slice, cue, now) {
  const hit = RC.select(slice.entries, { cue, now, activity: L.activity, cleanBelow: L.CLEAN_BELOW })
    .filter((row) => row.cued).map((row) => row.entry.id);
  if (hit.length === 0) return null;
  return {
    ...slice,
    entries: slice.entries.map((e) => (hit.includes(e.id) ? { ...e, a0: Math.min(1, L.activity(e, now) + RECALL_BOOST), t0: now } : e)),
  };
}

/** 想起来的几条（打分最高的），{ layer, when, clear, text, cued }。 */
export function recalled(slice, cue, now, total = RC.RECALL_TOTAL) {
  return RC.select(slice.entries, { cue, now, total, activity: L.activity, cleanBelow: L.CLEAN_BELOW })
    .map(({ entry, cued }) => ({
      layer: L.LAYER_LABELS[entry.layer],
      when: L.whenShort(entry.at),
      clear: L.clearness(L.activity(entry, now)),
      text: RC.clip(entry.content),
      ...(entry.pinned ? { pinned: true } : {}),
      cued,
    }));
}

/**
 * 「你想起来的」那一段：只放被你这句话勾起的；新会话第一轮再带上最近一篇日记（换了会话，前面聊过什么这里一概不知道）。
 * 什么都没想起来就是空串，不占上下文。
 */
export function recallText(slice, cue, now, { firstTurn = false } = {}) {
  const rows = [];
  const lines = recalled(slice, cue, now).filter((r) => r.cued).map((r) => "- [" + r.clear + "] " + r.text + "（" + r.when + "）");
  if (lines.length > 0) rows.push("### 【你想起来的】", ...lines);
  if (firstTurn && slice.diary_last?.text) rows.push("### 你最近的一篇日记（" + L.dayTitle(slice.diary_last.day) + "）", slice.diary_last.text);
  return rows.join("\n");
}

function project(slice, ctx) {
  // 快照里不放：想起来的那一段跟着你这句话变，放进快照就会每句都追加一份新快照
  return {
    lines: [],
    fields: {
      memories: recalled(slice, "", ctx.now, 5).map(({ cued, ...r }) => r),
      ...(slice.diary_last ? { last_diary: { day: slice.diary_last.day, label: L.dayTitle(slice.diary_last.day), text: slice.diary_last.text } } : {}),
    },
  };
}

/** 设置页「记忆」页：全部条目 + 现在欠着的整理。 */
function panel(slice, ctx) {
  const fold = L.foldBatch(slice, ctx.now);
  const diary = L.diaryDue(slice, ctx.now);
  return {
    ...L.panel(slice, ctx.now),
    requests: {
      memory_fold: fold === null ? null : { sources: L.sources(slice, fold) },
      memory_diary: diary === null ? null : { day: diary.day, sources: L.sources(slice, diary.ids) },
    },
    deletions: [],
  };
}

export default {
  id: "memory",
  label: "记忆",
  init: L.init,
  apply,
  tidy: L.maintain,
  project,
  panel,
};
