/* lib/engine/core/events.js — 你们的约定（promise）和她自己的事（task）。
 *
 * 到期这件事不写进账本：一条还挂着、到期时刻已经过了的，读的时候就算「过期了」。
 * 交账只记真发生的：新建、兑现、取消。
 */

import * as S from "./schema.js";
import * as T from "./time.js";

export const KINDS = Object.freeze(["promise", "task"]);
/** 结束了（兑现 / 取消）或过期了这么久的，交账时顺手清掉。 */
const KEEP_DAYS = 30;

export const FIELDS = Object.freeze({
  promise: S.describe(S.list(S.variants({
    title: S.obj({
      title: S.required(S.str(40)),
      due: S.describe(S.time(), "到期的真实时刻，如 2026-11-15T10:00"),
      in_minutes: S.describe(S.int(1, 576000), "或者：从现在起多少分钟后到期"),
      kind: S.describe(S.oneOf(KINDS, { default: "promise" }), "promise 你们之间说定的 / task 她自己的事"),
    }),
    done: S.obj({ done: S.required(S.describe(S.str(20), "兑现了：写约定的 id")), note: S.str(80) }),
    cancel: S.obj({ cancel: S.required(S.describe(S.str(20), "不做了：写约定的 id")), reason: S.str(80) }),
  }), 6), "约定：新建写 title，兑现写 done，取消写 cancel"),
});

/** 这一刻一条事件处于什么状态：pending / overdue / done / cancelled。 */
export function status(event, now) {
  if (event.state !== "pending") return event.state;
  return event.due !== null && T.before(event.due, now) ? "overdue" : "pending";
}

/** 还挂着的（含已过期的），到期早的在前。 */
export function open(events, now) {
  return Object.values(events)
    .filter((e) => e.state === "pending")
    .map((e) => ({ ...e, status: status(e, now) }))
    .sort((a, b) => (a.due ?? "~").localeCompare(b.due ?? "~"));
}

const dueOf = (item, now) => {
  if (item.due !== undefined) return T.iso(T.ms(item.due), T.offsetOf(now));
  if (item.in_minutes !== undefined) return T.addMinutes(now, item.in_minutes);
  return null;
};

const pendingIds = (events) => Object.keys(events).filter((id) => events[id].state === "pending");

export function validate(events, input, ctx) {
  const problems = [];
  (input.promise ?? []).forEach((item, i) => {
    const path = "$.promise[" + i + "]";
    if (item.title !== undefined) {
      if (ctx.alone && (item.kind ?? "promise") === "promise") {
        problems.push({ path, reason: "你不在场，不能新立你们之间的约定", hint: "她自己的事写 kind: task" });
      }
      const due = dueOf(item, ctx.now);
      if (due !== null && !T.before(ctx.now, due)) {
        problems.push({ path: path + ".due", reason: "到期时刻得在现在之后", hint: "" });
      }
      return;
    }
    const id = item.done ?? item.cancel;
    const event = events[id];
    if (event === undefined || event.state !== "pending") {
      problems.push({ path, reason: "没有还挂着的「" + id + "」", hint: "还挂着的：" + (pendingIds(events).join("、") || "没有") });
    } else if (ctx.alone && event.kind === "promise") {
      problems.push({ path, reason: "你不在场，你们之间的约定要等你回来再说", hint: "" });
    }
  });
  return problems;
}

/** 返回 { events, next }：next 是下一个可用的编号。 */
export function apply(events, nextId, input, ctx) {
  let next = { ...events };
  let counter = nextId;
  for (const item of input.promise ?? []) {
    if (item.title !== undefined) {
      const id = "e" + counter;
      counter += 1;
      next = { ...next, [id]: { id, kind: item.kind ?? "promise", title: item.title, due: dueOf(item, ctx.now), state: "pending", created_at: ctx.now } };
      ctx.note("记下约定 " + id + "「" + item.title + "」");
      continue;
    }
    const id = item.done ?? item.cancel;
    const done = item.done !== undefined;
    next = { ...next, [id]: { ...next[id], state: done ? "done" : "cancelled", closed_at: ctx.now, ...(item.note || item.reason ? { note: item.note ?? item.reason } : {}) } };
    if (!done) ctx.emit("event.cancelled", { id, kind: next[id].kind, title: next[id].title });
    ctx.note((done ? "兑现了 " : "取消了 ") + id + "「" + next[id].title + "」");
  }
  return { events: next, next: counter };
}

/** 结束了 30 天以上的、过期 30 天以上的清掉（清不清读出来都一样，只为账本不越攒越多）。 */
export function tidy(events, now) {
  const cutoff = T.addMinutes(now, -KEEP_DAYS * 1440);
  const kept = {};
  for (const [id, e] of Object.entries(events)) {
    const endedAt = e.state === "pending" ? (status(e, now) === "overdue" ? e.due : null) : e.closed_at;
    if (endedAt !== null && T.before(endedAt, cutoff)) continue;
    kept[id] = e;
  }
  return kept;
}
