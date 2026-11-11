/* lib/engine/modules/wake/index.js — 唤醒模块：你不在时她的时间。
 *
 *   plan  她说好接下来做什么、做到几点：到点叫醒她一次（新的替换旧的）
 *   away  离屏片段：隔了一小时以上再交账，要补一句「你不在的这段时间她做了什么」
 *
 * 下一次该醒是什么时候由 schedule.js 推出来；定时器、额度、送达在宿主那一半（lib/wake.js）。
 * 关掉这个模块：她只活在你在的时候，也不再要求补离屏片段。
 */

import * as S from "../../core/schema.js";
import * as T from "../../core/time.js";

/** 离上次交账隔了这么久，这一次要写 away。 */
export const AWAY_MINUTES = 60;
/** 离屏片段留最近几段（给 soul_state 和以后的记忆模块看）。 */
const AWAY_KEEP = 10;
/** plan 没写做到几点：先按这么久记，别为这个驳回整次交账。 */
const PLAN_DEFAULT_MINUTES = 60;

const PLAN = S.describe(S.obj({
  note: S.required(S.describe(S.str(40), "接下来做什么")),
  until: S.describe(S.str(30), "做到几点：HH:MM（今天这个钟点已经过了就是明天的），或者真实时刻 2026-11-15T10:00"),
  in_minutes: S.describe(S.int(1, 1440), "或者：做多少分钟"),
}), "她说好接下来做什么、做到几点（until 和 in_minutes 写一个）。到点会叫醒她一次；新的替换旧的");

const AWAY = S.describe(S.str(120), "你不在的这段时间她做了什么（参考作息）。离上次交账超过一小时就要写");

function init() {
  return { plan: null, away: [] };
}

/** plan.until → 真实时刻；认不出返回 null。 */
function untilOf(plan, now) {
  if (plan.until !== undefined) {
    const clock = T.parseClock(plan.until);
    if (clock !== null) return T.nextClock(now, plan.until);
    return T.isTime(plan.until) ? T.iso(T.ms(plan.until), T.offsetOf(now)) : null;
  }
  return T.addMinutes(now, plan.in_minutes ?? PLAN_DEFAULT_MINUTES);
}

/** 离上次交账多少分钟；没交过返回 null。 */
function sinceLast(ctx) {
  const last = ctx.ask("core.lastCommitAt");
  return last === null ? null : T.minutesBetween(last, ctx.now);
}

/** 这一次要不要补离屏片段：她自己醒着的那一次不用（那一次本身就是她的时间）。 */
const awayDue = (ctx) => !ctx.alone && (sinceLast(ctx) ?? 0) >= AWAY_MINUTES;

function validate(slice, input, ctx) {
  const problems = [];
  if (input.plan !== undefined) {
    const until = untilOf(input.plan, ctx.now);
    if (until === null) {
      problems.push({ path: "$.plan.until", reason: "认不出这个时刻：" + JSON.stringify(input.plan.until), hint: "写 23:00 这样的钟点，或者用 in_minutes" });
    } else if (!T.before(ctx.now, until)) {
      problems.push({ path: "$.plan.until", reason: "做到几点得在现在之后", hint: "" });
    }
  }
  if (input.away === undefined && awayDue(ctx)) {
    problems.push({
      path: "$.away",
      reason: "离上次交账隔了 " + sinceLast(ctx) + " 分钟，要补一句你不在时她做了什么",
      hint: "away: 一两句，她这段时间在做什么（参考作息）",
    });
  }
  return problems;
}

function apply(slice, input, ctx) {
  let plan = slice.plan;
  if (input.plan !== undefined) {
    if (input.plan.until === undefined && input.plan.in_minutes === undefined) {
      ctx.note("plan 没写做到几点，先按 " + PLAN_DEFAULT_MINUTES + " 分钟记了");
    }
    plan = { note: input.plan.note, until: untilOf(input.plan, ctx.now), set_at: ctx.now };
    ctx.note("记下她的安排「" + plan.note + "」，到 " + T.label(plan.until, ctx.now));
  }
  let away = slice.away;
  if (input.away !== undefined) {
    const last = ctx.ask("core.lastCommitAt");
    away = [...away, { at: ctx.now, since: last, text: input.away }].slice(-AWAY_KEEP);
  }
  return { ...slice, plan, away };
}

/** 过了点的安排清掉（到点那一次已经叫醒过她了）。 */
function tidy(slice, now) {
  if (slice.plan !== null && !T.before(now, slice.plan.until)) return { ...slice, plan: null };
  return slice;
}

/** 还算数的安排（到点之前）。 */
export const activePlan = (slice, now) => (slice?.plan && T.before(now, slice.plan.until) ? slice.plan : null);

function project(slice, ctx) {
  const plan = activePlan(slice, ctx.now);
  const due = awayDue(ctx);
  const lines = [];
  if (plan !== null) lines.push("她的安排：" + plan.note + "（到 " + T.label(plan.until, ctx.now) + "）");
  // 提前说，免得交上去才被驳回。只在跨过一小时那一下变一次，不跟着分钟变
  if (due) lines.push("离上次交账超过一小时：这次交账要写 away（你不在时她做了什么）");
  return {
    lines,
    fields: {
      plan: plan === null ? null : { note: plan.note, until: plan.until, until_label: T.label(plan.until, ctx.now) },
      away_due: due,
      away_recent: slice.away.slice(-3).map((a) => ({ at: a.at, text: a.text })),
    },
  };
}

export default {
  id: "wake",
  label: "唤醒",
  fields: { plan: PLAN, away: AWAY },
  init,
  validate,
  apply,
  tidy,
  project,
};
