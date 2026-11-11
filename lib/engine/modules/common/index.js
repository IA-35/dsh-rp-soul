/* lib/engine/modules/common/index.js — 常识模块：「关键词 → 一条常识」，全局一张表，不属于任何一局。
 *
 * 一条：{ id: "c1", key: ["deepseek", "ds"], weight: 0.8, content: "…", origin: "manual" | "turn", pending, at }
 * 你这句话里出现了关键词才注入（查表，不是背景知识）；同一句命中多条按权重排。
 * 模型交账时提的（common 字段）一律挂起，等你在设置页点「确认」才生效；你手动加的直接生效。
 *
 * 这里只有纯函数。表存在 store 的 common 表里，交账时由 engine 和账本在同一个事务里写。
 */

import * as S from "../../core/schema.js";

export const KEY_MAX = 24;
export const KEYS_MAX = 12;
export const CONTENT_MAX = 200;
export const LIMIT_DEFAULT = 4;
const LIMIT_RANGE = [2, 4];
const WEIGHT_DEFAULT = 0.5;

const FIELD = S.describe(S.list(S.obj({
  key: S.required(S.describe(S.list(S.str(KEY_MAX), KEYS_MAX), "触发它的关键词（主人的话里出现才会想起来）")),
  content: S.required(S.describe(S.str(CONTENT_MAX), "这条常识")),
}), 3), "换一局也成立的客观知识，比如「DS 指的是 deepseek」。你们之间的事（他养了一只猫）写 learned，不是常识。提了要主人在设置页确认才生效");

const order = (row) => Number(String(row.id).slice(1)) || 0;

/** 关键词统一小写、去空白、去重，保持顺序。 */
export function normalizeKeys(keys) {
  const out = [];
  for (const key of keys ?? []) {
    const text = String(key).trim().toLowerCase();
    if (text !== "" && !out.includes(text)) out.push(text.slice(0, KEY_MAX));
  }
  return out.slice(0, KEYS_MAX);
}

const clampWeight = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : WEIGHT_DEFAULT;
};

export function limitOf(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(LIMIT_RANGE[1], Math.max(LIMIT_RANGE[0], n)) : LIMIT_DEFAULT;
}

export const nextId = (rows) => "c" + (Math.max(0, ...rows.map(order)) + 1);

/** 新的一条。content / key 不合法返回 null。 */
export function make(rows, { key, weight, content }, { origin = "manual", at = null } = {}) {
  const keys = normalizeKeys(Array.isArray(key) ? key : [key]);
  const text = String(content ?? "").trim().slice(0, CONTENT_MAX);
  if (keys.length === 0 || text === "") return null;
  return { id: nextId(rows), key: keys, weight: clampWeight(weight), content: text, origin, at, pending: origin !== "manual" };
}

const isWord = (ch) => /^[a-z0-9]$/.test(ch);

/**
 * 这句话触发这条了吗。「ds」这种两个字母的关键词在中文里容易误撞：
 * 英文和数字按词边界比（前后不能紧挨着英文字母或数字），中文按子串比。
 */
export function hits(row, cue) {
  const text = String(cue ?? "").toLowerCase();
  if (text === "") return false;
  return row.key.some((key) => {
    if (!/^[\x00-\x7f]+$/.test(key)) return text.includes(key);
    for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
      if (!isWord(text[at - 1] ?? "") && !isWord(text[at + key.length] ?? "")) return true;
    }
    return false;
  });
}

/** 命中的、已确认的，权重高的在前；同权重关键词多的（更具体）在前。 */
export function select(rows, cue, limit = LIMIT_DEFAULT) {
  return rows
    .filter((row) => !row.pending && hits(row, cue))
    .sort((a, b) => b.weight - a.weight || b.key.length - a.key.length || order(a) - order(b))
    .slice(0, Math.max(1, limit));
}

/** 渲染成一段；没有命中就是空字符串。冒号前放这句里真正触发的那个关键词。 */
export function render(found, cue) {
  if (found.length === 0) return "";
  const text = String(cue ?? "").toLowerCase();
  return ["### 常识", ...found.map((row) => "- " + (row.key.find((k) => text.includes(k)) ?? row.key[0]) + "： " + row.content)].join("\n");
}

/**
 * 把模型提的并进表里，一律挂起。关键词完全相同的当同一条：还挂着的用新说法覆盖，
 * 你确认过（或手动加）的不动 —— 模型改不掉你点过头的东西。返回 { rows, touched }。
 */
export function merge(rows, proposals, at) {
  let next = rows;
  const touched = [];
  for (const item of proposals) {
    const fresh = make(next, item, { origin: "turn", at });
    if (fresh === null) continue;
    const same = next.find((row) => row.key.length === fresh.key.length && fresh.key.every((k) => row.key.includes(k)));
    if (same !== undefined && !same.pending) continue;
    if (same !== undefined) {
      next = next.map((row) => (row.id === same.id ? { ...row, content: fresh.content, at } : row));
      touched.push(same.id);
      continue;
    }
    next = [...next, fresh];
    touched.push(fresh.id);
  }
  return { rows: next, touched };
}

/** 设置页改一条：只改给了的字段。找不到返回 null。 */
export function edit(rows, id, { key, weight, content } = {}) {
  const found = rows.find((row) => row.id === id);
  if (found === undefined) return null;
  const keys = key === undefined || key === null ? found.key : normalizeKeys(Array.isArray(key) ? key : [key]);
  const text = content === undefined || content === null ? found.content : String(content).trim().slice(0, CONTENT_MAX);
  if (keys.length === 0 || text === "") return null;
  const changed = { ...found, key: keys, content: text, weight: weight === undefined || weight === null ? found.weight : clampWeight(weight) };
  return rows.map((row) => (row.id === id ? changed : row));
}

/** 设置页「常识库」页认的形状。 */
export function panel(rows, limit) {
  return {
    count: rows.length,
    pending: rows.filter((row) => row.pending).length,
    limit,
    rows: [...rows].sort((a, b) => order(a) - order(b)),
  };
}

export default {
  id: "common",
  label: "常识",
  fields: { common: FIELD },
  apply(slice, input, ctx) {
    // 真正写进常识表的是 engine（和账本同一个事务）；这里只在回执里说一声
    if (!input.common?.length) return slice;
    // 她自己醒着的那一次没有主人的话，提不出「主人说的常识」：不驳回，丢掉并说一声
    ctx.note(ctx.alone ? "你不在场，这次提的常识没收" : "提了 " + input.common.length + " 条常识，等主人在设置页确认");
    return slice;
  },
};
