/* lib/engine/core/facts.js — 事实与「谁知道」。
 *
 * 只有你和她两个人，所以「谁知道」只有四种：
 *   shared 你们都知道 / you 只有你知道 / her 只有她知道 / inner 她心里的（她知道，也从没说出口）
 * 事实按 key 存（rain.umbrella 这种），key 就是它的身份，不另编号。
 */

import * as S from "./schema.js";

export const WHO = Object.freeze(["shared", "you", "her", "inner"]);
const HER_KNOWS = new Set(["shared", "her", "inner"]);
const YOU_KNOW = new Set(["shared", "you"]);

export const FIELDS = Object.freeze({
  learned: S.describe(S.list(S.obj({
    key: S.required(S.describe(S.str(60), "小写点分的名字，如 rain.umbrella；同一个 key 再写一次就是改它")),
    text: S.required(S.str(120)),
    who: S.describe(S.oneOf(WHO, { default: "shared" }), "谁知道，默认 shared"),
    retcon: S.describe(S.bool(), "改了以前的设定（要 consent）"),
  }), 6), "这一次新知道的事。是你们之间的事（他养了只猫），不是常识（DS 指的是什么）"),
  reveal: S.describe(S.list(S.str(60), 6), "她把只有她知道的事说出来了：写那条事实的 key"),
});

/** key 规整：去空白、小写、空格换点。 */
export function normalizeKey(key) {
  return String(key ?? "").trim().toLowerCase().replace(/\s+/g, ".");
}

/** 她知道这条事实吗。 */
export function herKnows(facts, key) {
  const fact = facts[normalizeKey(key)];
  return fact !== undefined && HER_KNOWS.has(fact.who);
}

/** 你知道这条事实吗。 */
export function youKnow(facts, key) {
  const fact = facts[normalizeKey(key)];
  return fact !== undefined && YOU_KNOW.has(fact.who);
}

/** 她知道的事实的 key（报错时列给模型挑），最近的在前，最多 limit 条。 */
export function keysHerKnows(facts, limit = 8) {
  return Object.values(facts)
    .filter((f) => HER_KNOWS.has(f.who))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map((f) => f.key + "（" + f.text.slice(0, 12) + "）");
}

/** 一句话 → 一个稳定的 key：同一句话总是同一个 key（给「心事的来由直接写一句话」用）。 */
export function keyForSentence(text) {
  let hash = 5381;
  for (const ch of String(text)) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  return "her.thought." + hash.toString(36);
}

/** 记一条「她心里的」事实，返回 { facts, key }（不改入参）。已经有了就原样返回。 */
export function noteInner(facts, text, now) {
  const key = keyForSentence(text);
  if (facts[key] !== undefined) return { facts, key };
  return { facts: { ...facts, [key]: { key, text: String(text).slice(0, 120), who: "inner", at: now } }, key };
}

/** 交账前检查：她不在场时只能记她自己知道的；改设定要你同意；说出来的得是她知道的。 */
export function validate(facts, input, ctx) {
  const problems = [];
  (input.learned ?? []).forEach((item, i) => {
    const path = "$.learned[" + i + "]";
    if (normalizeKey(item.key) === "") problems.push({ path: path + ".key", reason: "key 不能是空的", hint: "" });
    if (ctx.alone && YOU_KNOW.has(item.who)) {
      problems.push({ path: path + ".who", reason: "你不在场，这一次只能记她自己知道的（her / inner）", hint: "" });
    }
    if (item.retcon === true && input.consent !== true) {
      problems.push({ path: path + ".retcon", reason: "改以前的设定要你本人同意", hint: "带上 consent: true，而且只在你亲口这么说的时候" });
    }
  });
  (input.reveal ?? []).forEach((key, i) => {
    const path = "$.reveal[" + i + "]";
    const fact = facts[normalizeKey(key)];
    if (ctx.alone) {
      problems.push({ path, reason: "你不在场，她没法把事情告诉你", hint: "" });
    } else if (fact === undefined) {
      problems.push({ path, reason: "没有这条事实：" + key, hint: "她知道的：" + keysHerKnows(facts).join("、") });
    } else if (fact.who !== "her" && fact.who !== "inner") {
      problems.push({ path, reason: "这条你本来就知道", hint: "" });
    }
  });
  return problems;
}

/** 记下这一次新知道的、说出来的事实，返回新的事实表。 */
export function apply(facts, input, ctx) {
  let next = { ...facts };
  for (const item of input.learned ?? []) {
    const key = normalizeKey(item.key);
    const prev = next[key];
    next = {
      ...next,
      [key]: { key, text: item.text, who: item.who ?? "shared", at: prev?.at ?? ctx.now, ...(prev ? { updated_at: ctx.now } : {}),
        ...(item.retcon ? { retcon: true } : {}) },
    };
    ctx.note(prev ? "改了「" + key + "」" : "记下「" + key + "」");
  }
  for (const raw of input.reveal ?? []) {
    const key = normalizeKey(raw);
    next = { ...next, [key]: { ...next[key], who: "shared", revealed_at: ctx.now } };
    ctx.note("她说出了「" + key + "」");
  }
  return next;
}
