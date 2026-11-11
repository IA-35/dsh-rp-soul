/* lib/engine/modules/mood/bond.js — 她对你的态度：信任、张力、阶段。
 *
 * 和心情是两条轴：心情是「此刻怎样」，会回落；态度是「她长期怎么看你」，慢慢变、分阶段。
 * 态度变了会在心情里留下一条心事（信任 ×3、阶段前进 +15）。
 */

import * as S from "../../core/schema.js";

export const STAGES = Object.freeze(["stranger", "acquainted", "familiar", "flirting", "testing", "intimate", "committed"]);
export const STAGE_ZH = Object.freeze({
  stranger: "陌生", acquainted: "认识", familiar: "熟络", flirting: "暧昧", testing: "试探", intimate: "亲密", committed: "稳定",
});
const TRUST_RANGE = [-5, 5];
const TENSION_RANGE = [0, 5];
const HISTORY_KEEP = 12;
const COOPERATIVE = new Set(["partial", "genuine"]);

export const FIELD = S.describe(S.obj({
  trust: S.describe(S.int(-2, 2), "信任这一次变了多少"),
  tension: S.describe(S.int(-5, 5), "张力这一次变了多少"),
  stage: S.describe(S.oneOf(["advance", ...STAGES]), "advance 前进一个阶段；写一个更低的阶段名就是退回去"),
  reason: S.describe(S.str(80), "为什么变"),
}), "她对你的态度变了才写；前进阶段要她这一次是配合的（partial / genuine），心情低落时不接受");

export function init(persona) {
  const start = STAGES.includes(persona?.start_stage) ? persona.start_stage : "stranger";
  return { trust: 0, tension: 0, stage: start, history: [] };
}

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/** band：这一刻的心情档位（由调用方现算好传进来）。 */
/** 写了 bond 却什么都没变（{} 或全是 0）：不驳回，当没写。 */
export const isEmpty = (change) => change !== undefined && !change.trust && !change.tension && change.stage === undefined;

export function validate(bond, input, band) {
  const change = input.bond;
  if (change === undefined || isEmpty(change)) return [];
  const problems = [];
  if (change.stage === "advance") {
    if (STAGES.indexOf(bond.stage) >= STAGES.length - 1) problems.push({ path: "$.bond.stage", reason: "已经是最后一个阶段", hint: "" });
    if (band === "closed" || band === "break") problems.push({ path: "$.bond.stage", reason: "她现在心情" + (band === "break" ? "难过" : "低落") + "，不会接受关系推进", hint: "" });
    if (!COOPERATIVE.has(input.her?.response)) {
      problems.push({ path: "$.bond.stage", reason: "关系往前走，要她这一次是配合的", hint: "写 her.response: partial 或 genuine；阶段是两个人一起走的，不是一方说了算" });
    }
  } else if (change.stage !== undefined && STAGES.indexOf(change.stage) >= STAGES.indexOf(bond.stage)) {
    problems.push({ path: "$.bond.stage", reason: "退回去的阶段要比现在（" + STAGE_ZH[bond.stage] + "）低", hint: "" });
  }
  return problems;
}

/** 返回 { bond, moved }：moved 记下这一次真变了什么（给心情模块留心事用）。 */
export function apply(bond, input, now) {
  const change = input.bond;
  if (change === undefined || isEmpty(change)) return { bond, moved: null };
  const trust = clamp(bond.trust + (change.trust ?? 0), TRUST_RANGE);
  const tension = clamp(bond.tension + (change.tension ?? 0), TENSION_RANGE);
  const stage = change.stage === "advance" ? STAGES[STAGES.indexOf(bond.stage) + 1] : change.stage ?? bond.stage;
  const moved = { trust: trust - bond.trust, tension: tension - bond.tension, advanced: change.stage === "advance", stage };
  const record = { at: now, trust: moved.trust, tension: moved.tension, stage: stage !== bond.stage ? stage : undefined, reason: change.reason ?? "" };
  return {
    bond: { trust, tension, stage, history: [...bond.history, record].slice(-HISTORY_KEEP) },
    moved,
  };
}
