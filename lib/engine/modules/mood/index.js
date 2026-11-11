/* lib/engine/modules/mood/index.js — 情绪模块：心事与心情、她对你的态度、她下一步可能做什么。
 *
 * 这三样放在一个模块里，因为它们一直互相读：心情低落时不接受关系推进；
 * 自主行动的候选按心情和态度打分；信任变化会在心情里留下一条心事。
 * 档位在这一次交账开始时定下（按交账前的局面现算），整次交账都用它。
 */

import * as S from "../../core/schema.js";
import * as T from "../../core/time.js";
import * as TH from "./thoughts.js";
import * as BOND from "./bond.js";
import * as AG from "./agency.js";

const DAY = 1440;
/** 一个字符串长得像事实的 key（小写点分），就当它是 key；否则当它是一句话。 */
// 像一个事实 key：小写字母数字，带点或下划线（rain.umbrella、late_night_check）。带空格或汉字的是一句话
const looksLikeKey = (text) => /^[a-z0-9]+([._][a-z0-9]+)+$/.test(text);

const FEEL = S.describe(S.list(S.obj({
  label: S.required(S.describe(S.str(20), "这条心事，她自己的口吻")),
  delta: S.required(S.describe(S.int(...TH.DELTA_RANGE), "对心情的影响，正是变好")),
  because: S.required(S.describe(S.str(120), "来由：她知道的一条事实的 key，或者直接写一句话")),
  minutes: S.describe(S.int(1, 43200), "持续多久（分钟），不写就是一天"),
}), 4), "她心里多了点什么。不能凭空扣心情：每条都要有来由");

function init(persona, now) {
  return {
    base: Number.isInteger(persona?.mood_base) ? persona.mood_base : TH.BASE,
    thoughts: [],
    next: 1,
    bond: BOND.init(persona),
    major_action_at: null,
    back_at: null,
    started_at: now,
  };
}

function validate(slice, input, ctx) {
  const mood = TH.evaluate(slice, ctx);
  // feel 的来由不在这里挡：认不出的 key 在 apply 里退回成「这条心事本身」并记一条说明
  const problems = [];
  problems.push(...BOND.validate(slice.bond, input, mood.band));
  problems.push(...AG.validate(input, mood, slice.bond, slice.major_action_at, ctx));
  return problems;
}

function apply(slice, input, ctx) {
  let thoughts = slice.thoughts;
  let next = slice.next;
  const add = (thought) => {
    thoughts = TH.addThought(thoughts, { ...thought, id: "t" + next }, ctx.now);
    next += 1;
  };
  for (const feel of input.feel ?? []) {
    // apply 时这次 learned 的事实已经记上了，同一次里先记事实再拿它当来由也认
    const known = looksLikeKey(feel.because) && ctx.ask("core.herKnows", feel.because);
    if (looksLikeKey(feel.because) && !known) ctx.note("feel 的来由「" + feel.because + "」不是她知道的事实，按这条心事本身记了");
    const key = known ? feel.because : ctx.noteInner(looksLikeKey(feel.because) ? feel.label : feel.because);
    add({ label: feel.label, delta: feel.delta, because: key, minutes: feel.minutes, source: "feel" });
  }
  if (BOND.isEmpty(input.bond)) ctx.note("bond 没写任何变化，当没写");
  const { bond, moved } = BOND.apply(slice.bond, input, ctx.now);
  if (moved?.trust) {
    add({
      label: moved.trust > 0 ? "心里对你多了几分信任" : "心里对你的分量掉了",
      delta: moved.trust * 3, because: "bond.trust", minutes: TH.DURATION.tone, source: "bond",
    });
  }
  if (moved?.advanced) {
    add({ label: "你们更近了", delta: 15, because: "bond.stage." + moved.stage, minutes: TH.DURATION.stage, source: "bond" });
    ctx.note("关系往前走了一步：" + BOND.STAGE_ZH[moved.stage]);
  }
  // 你隔了一天以上才回来：这件事发生在这一刻，记下来；「很久没见你」由它推出来
  const apart = ctx.ask("core.minutesApart");
  const backAt = !ctx.alone && apart !== null && apart >= DAY ? ctx.now : slice.back_at;
  const majorAt = input.act?.significant === true ? ctx.now : slice.major_action_at;
  return { ...slice, thoughts, next, bond, back_at: backAt, major_action_at: majorAt };
}

function tidy(slice, now) {
  return { ...slice, thoughts: TH.tidy(slice.thoughts, now) };
}

/** 快照几行 + soul_state 字段，全按这一刻现算。 */
function project(slice, ctx) {
  const mood = TH.evaluate(slice, ctx);
  const top = mood.thoughts.slice(0, 3).map((t) => ({
    label: t.label,
    weight: t.weight,
    ago: T.ago(t.since, ctx.now),
    rough: T.roughAgo(t.since, ctx.now),
    ...(t.kind === "situational" ? { situational: true } : {}),
  }));
  const options = AG.candidates(mood, slice.bond, slice.major_action_at, ctx);
  const lines = [
    "对主人的态度：" + BOND.STAGE_ZH[slice.bond.stage],
    "心情：" + TH.BAND_ZH[mood.band] + "（" + mood.value + "）",
  ];
  if (top.length > 0) {
    lines.push("最近的想法：" + top.map((t) => t.label + "（" + (t.weight > 0 ? "+" : "") + t.weight + (t.situational ? "" : "，" + t.rough) + "）").join("、"));
  }
  if (options.length > 0) {
    lines.push("可能发生：" + options.slice(0, 2).map((o) => o.text + (o.because ? " —— " + o.because : "")).join("；"));
  }
  return {
    lines,
    fields: {
      mood: { value: mood.value, band: mood.band, base: slice.base, thoughts: top.map(({ rough, ...t }) => t) },
      bond: { trust: slice.bond.trust, tension: slice.bond.tension, stage: slice.bond.stage },
      agency: options,
    },
  };
}

/** 设置页「情绪」页要的全部：每条心事（含推出来的）、阈值、态度、冷却。 */
function panel(slice, ctx) {
  const mood = TH.evaluate(slice, ctx);
  return {
    value: mood.value,
    band: mood.band,
    base: slice.base,
    thresholds: TH.thresholdsOf(ctx.persona),
    bond: { trust: slice.bond.trust, tension: slice.bond.tension, stage: slice.bond.stage, stage_label: BOND.STAGE_ZH[slice.bond.stage] },
    cooldown: AG.cooldownLeft(slice.major_action_at, mood.band, ctx.now),
    conditions: (ctx.ask("core.conditions") ?? []).map((c) => c.text),
    thoughts: mood.thoughts.map((t) => ({
      id: t.id ?? null,
      label: t.label,
      delta: t.delta,
      weight: t.weight,
      situational: t.kind === "situational",
      since: t.since ?? null,
      until: t.until ?? null,
    })),
  };
}

/** 设置页手动删一条记下的心事；推出来的（此刻的情境）删不掉。返回新切片，找不到返回 null。 */
export function dropThought(slice, id) {
  if (!slice.thoughts.some((t) => t.id === id)) return null;
  return { ...slice, thoughts: slice.thoughts.filter((t) => t.id !== id) };
}

export default {
  id: "mood",
  label: "情绪",
  fields: { feel: FEEL, bond: BOND.FIELD, act: AG.FIELD },
  init,
  validate,
  apply,
  tidy,
  answers: {
    band: (slice, ctx) => TH.evaluate(slice, ctx).band,
    value: (slice, ctx) => TH.evaluate(slice, ctx).value,
    stage: (slice) => slice.bond.stage,
  },
  project,
  panel,
};
