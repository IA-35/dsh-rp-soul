/* lib/engine/modules/memory/recall.js — 关键词与「想起来」。
 *
 * 关键词不用分词器：汉字连续段切成两两一组，英文数字按词。
 * 想起来的打分照 RimTalk（UnifiedMemoryInjector）：时间、重要度、关键词、层级、Pin、改过、活跃度。
 * 只有被你这句话的关键词撞上的才注入；只靠时间和层级排进前几名的，留在 soul_state 里给模型自己翻。
 */

import * as T from "../../core/time.js";

export const KEYWORDS_MAX = 32;
const KEYWORD_LEN = 20;

/** 汉字段两两一组 + 英文数字词（小写），去重，最多 32 个。 */
export function keywords(...texts) {
  const out = [];
  for (const text of texts) {
    const source = String(text ?? "");
    for (const run of source.match(/[一-鿿]+/g) ?? []) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    }
    for (const word of source.match(/[A-Za-z0-9]{2,}/g) ?? []) out.push(word.toLowerCase().slice(0, KEYWORD_LEN));
  }
  return [...new Set(out)].slice(0, KEYWORDS_MAX);
}

/** 注入几条；只取 SCM 和 CLPA（ABM 是这段对话本身）。 */
export const RECALL_TOTAL = 3;
const THRESHOLD = 0.15;
const LAYER_BONUS = { abm: 1, scm: 0.85, clpa: 0.5 };
const LAYER_WEIGHT = 0.2;
const PINNED_BONUS = 0.5;
const EDITED_BONUS = 0.3;
const ACTIVITY_WEIGHT = 0.1;
const TEXT_MAX = 80;
/** 你在 = 社交场景；她一个人 = 普通场景。 */
const SCENES = {
  together: { decay: 0.05, importance: 0.2, keyword: 0.25, windowDays: 30 },
  alone: { decay: 0.3, importance: 0.3, keyword: 0.35, windowDays: 3 },
};

function timeScore(entry, now, scene) {
  const days = T.minutesBetween(entry.at, now) / 1440;
  if (days > scene.windowDays) return Math.exp(-(days - scene.windowDays) * 2) * 0.1;
  return Math.exp(-days * scene.decay);
}

export function keywordScore(entry, cueKeys) {
  if (cueKeys.length === 0 || entry.keywords.length === 0) return 0;
  const mine = new Set(entry.keywords);
  const shared = cueKeys.filter((k) => mine.has(k)).length;
  const union = new Set([...entry.keywords, ...cueKeys]).size;
  const contained = cueKeys.filter((k) => entry.content.includes(k)).length * 0.2;
  return Math.min(1, shared / union + contained);
}

/** 打分最高的几条，{ entry, score, cued }。activity 由调用方传进来（layers.activity），免得互相引用。 */
export function select(entries, { cue = "", now, total = RECALL_TOTAL, activity, cleanBelow }) {
  const scene = SCENES[String(cue).trim() !== "" ? "together" : "alone"];
  const cueKeys = keywords(cue);
  return entries
    .filter((e) => e.layer !== "abm" && e.type !== "action" && (e.pinned || activity(e, now) >= cleanBelow))
    .map((e) => {
      const hit = keywordScore(e, cueKeys);
      const score = timeScore(e, now, scene) + e.importance * scene.importance + hit * scene.keyword
        + LAYER_BONUS[e.layer] * LAYER_WEIGHT + (e.pinned ? PINNED_BONUS : 0) + (e.edited ? EDITED_BONUS : 0)
        + activity(e, now) * ACTIVITY_WEIGHT;
      return { entry: e, score, cued: hit > 0 };
    })
    .filter((row) => row.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score || T.ms(b.entry.at) - T.ms(a.entry.at))
    .slice(0, Math.max(0, total));
}

export const clip = (text) => (text.length <= TEXT_MAX ? text : text.slice(0, TEXT_MAX - 1) + "…");
