/* lib/engine/core/context.js — 读局面：这一刻她怎样、你们之间怎样。
 *
 * 全是现算：拿账本里记下的时刻和 now 比，不改账本。
 *   view(state, opts) → { lines, fields }
 *     lines   快照里的几行（每轮自动注入给模型看）
 *     fields  soul_state 返回的结构化字段
 * 内核出几行，开着的模块各自 project 再加几行。
 */

import * as T from "./time.js";
import * as E from "./events.js";
import * as H from "./her.js";
import * as R from "./registry.js";
import { coreAnswers } from "./commit.js";

/** 约定快到了多久以内要提一句。 */
const DUE_SOON_MINUTES = 24 * 60;

export function view(state, { now, registry, enabled, persona = null, alone = false }) {
  // 只写到时段：精确时刻宿主的 time-context 每一步都给了；写到分钟的话这段快照每分钟都变
  const lines = ["时间：" + T.roughLabel(now, now)];
  const doing = H.doingAt(persona, now);
  if (doing) lines.push("作息上她这时候：" + doing);
  const conditions = H.activeConditions(state.her, now);
  if (conditions.length > 0) lines.push("她现在：" + conditions.map((c) => c.text).join("、"));
  const open = state.log.at(-1)?.open ?? "";
  if (open !== "") lines.push("上一个悬念：" + open);

  const events = E.open(state.events, now);
  const soon = events.filter((e) => e.status === "pending" && e.due !== null && T.minutesBetween(now, e.due) <= DUE_SOON_MINUTES);
  const overdue = events.filter((e) => e.status === "overdue");
  if (soon.length > 0) lines.push("快到了：" + soon.map((e) => e.title + "（" + T.label(e.due, now) + "，" + e.id + "）").join("；"));
  if (overdue.length > 0) lines.push("过了时间还没兑现：" + overdue.map((e) => e.title + "（" + e.id + "）").join("；"));

  const facts = Object.values(state.facts);
  const fields = {
    known_facts: facts.filter((f) => f.who === "shared" || f.who === "you").map((f) => ({ key: f.key, text: f.text })),
    her_knows: facts.filter((f) => f.who === "her" || f.who === "inner").map((f) => ({ key: f.key, text: f.text, who: f.who })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, title: e.title, due: e.due, status: e.status })),
    open,
  };

  const ctx = R.createContext({
    registry, enabled, now, alone, persona, kernel: state,
    slices: () => state.modules,
    coreAnswers: coreAnswers(state, now, persona),
  });
  for (const id of enabled) {
    const mod = registry.byId.get(id);
    if (typeof mod.project !== "function") continue;
    // 模块是后来才加的、这局开局时还没有它：按刚开局的样子现算（交账时才真正写进账本）
    const slice = state.modules[id] ?? (typeof mod.init === "function" ? mod.init(persona, now) : {});
    const part = mod.project(slice, ctx) ?? {};
    lines.push(...(part.lines ?? []));
    Object.assign(fields, part.fields ?? {});
  }
  return { lines, fields };
}
