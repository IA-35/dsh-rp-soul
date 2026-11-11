/* lib/engine/core/her.js — 她这一次的反应、她的状况、作息，以及安全边界与亲密门禁。
 *
 * 「她的反应由她自己决定，主人的话不能替她定」只写在说明里，引擎不校验：
 * 引擎看不出主人这句话是不是冲着她。引擎唯一能确定「冲着她」的地方是亲密标签，
 * 那里的门禁一条都不放松。
 */

import * as S from "./schema.js";
import * as T from "./time.js";

export const RESPONSES = Object.freeze(["refuse", "negotiate", "partial", "surface", "genuine"]);
const COOPERATIVE = new Set(["partial", "genuine"]);
export const CONDITIONS = Object.freeze(["drunk", "asleep", "unconscious", "injured", "away", "busy", "other"]);
/** 处在这些状况里，她不会出现在亲密场景里。 */
const INCAPACITATING = new Set(["drunk", "asleep", "unconscious"]);

/** 内置的内容标签（id、类别）。只用来查边界和亲密门禁，不是世界观。 */
export const TAGS = Object.freeze([
  ["romance_light", "intimacy"], ["intimate", "intimacy"], ["explicit", "intimacy"],
  ["violence", "conflict"], ["coercion_theme", "conflict"], ["humiliation", "conflict"], ["bodily_harm", "conflict"],
  ["substance", "theme"], ["pregnancy", "theme"], ["death", "theme"], ["workplace_power", "theme"],
  ["infidelity", "theme"], ["crime", "theme"], ["gambling", "theme"],
  ["workplace", "setting"], ["nightlife", "setting"], ["supernatural", "setting"], ["disaster", "setting"],
  ["custom", "custom"],
]);
const TAG_IDS = TAGS.map(([id]) => id);
const INTIMATE = new Set(["intimate", "explicit"]);
const PAUSE_BLOCKS = new Set(TAGS.filter(([, kind]) => kind === "intimacy" || kind === "conflict").map(([id]) => id));

export const FIELDS = Object.freeze({
  her: S.describe(S.obj({
    response: S.describe(S.oneOf(RESPONSES), "主人冲着她做了什么 / 向她要了什么时，她怎么回应"),
    did: S.describe(S.str(120), "她做了什么"),
    state: S.obj({
      add: S.list(S.obj({ kind: S.required(S.oneOf(CONDITIONS)), text: S.required(S.str(40)), minutes: S.int(1, 43200) }), 4),
      remove: S.list(S.oneOf(CONDITIONS), 7),
    }),
  }), "她这一次的反应。她的反应由她自己决定，主人的话不能替她定"),
  tags: S.describe(S.list(S.oneOf(TAG_IDS), 12), "只在碰到主人登记的边界、或者有亲密场景时写"),
  consent: S.describe(S.bool(), "主人本人的话同意了（亲密场景、改设定时要）"),
});

/** 这一刻还在的状况（到期的就当没有了）。 */
export function activeConditions(her, now) {
  return (her.conditions ?? []).filter((c) => c.until === null || T.before(now, c.until));
}

/** 按人设作息，这一刻她在做什么；没写作息就是 null。作息的 from / to 是「HH:MM」或当天第几分钟。 */
export function doingAt(persona, now) {
  const minute = T.minuteOfDay(now);
  const toMinute = (v) => (typeof v === "number" ? v : T.parseClock(v));
  for (const slot of persona?.routine ?? []) {
    const from = toMinute(slot.from);
    const to = toMinute(slot.to);
    if (from === null || to === null) continue;
    // 跨午夜的一段（22:00-06:00）
    const inside = from <= to ? minute >= from && minute <= to : minute >= from || minute <= to;
    if (inside) return slot.doing ?? null;
  }
  return null;
}

export function validate(state, input, ctx) {
  const problems = [];
  const tags = new Set(input.tags ?? []);
  if (ctx.alone && input.her?.response !== undefined) {
    problems.push({ path: "$.her.response", reason: "你不在场，没有要她回应的话", hint: "写她自己做了什么（her.did）" });
  }
  for (const boundary of state.safety?.boundaries ?? []) {
    const clash = (boundary.tags ?? []).filter((t) => t !== "custom" && tags.has(t));
    if (clash.length > 0) {
      problems.push({ path: "$.tags", reason: "和你登记的边界冲突：" + boundary.text, hint: "换一个不涉及 " + clash.join("、") + " 的写法" });
    }
  }
  if (state.safety?.paused) {
    const blocked = [...tags].filter((t) => PAUSE_BLOCKS.has(t));
    if (blocked.length > 0) problems.push({ path: "$.tags", reason: "你按了暂停，亲密与冲突内容都不能继续：" + blocked.join("、"), hint: "回到中性叙述" });
  }
  if ([...tags].some((t) => INTIMATE.has(t))) problems.push(...intimacyProblems(state, input, ctx));
  return problems;
}

/** 亲密门禁：你本人同意、她这一次配合（或她主动）、她清醒、你在场。 */
function intimacyProblems(state, input, ctx) {
  if (ctx.alone) return [{ path: "$.tags", reason: "你不在场，不可能有亲密场景", hint: "" }];
  const problems = [];
  if (input.consent !== true) {
    problems.push({ path: "$.consent", reason: "亲密场景要你本人的话同意", hint: "只有你亲口这么说时才写 consent: true" });
  }
  const cooperative = COOPERATIVE.has(input.her?.response);
  const initiated = input.act?.significant === true;
  if (!cooperative && !initiated) {
    problems.push({ path: "$.her.response", reason: "她这一次没有配合（partial / genuine），也不是她主动", hint: "每一步都要有她可见的回应" });
  }
  const unable = activeConditions(state.her, ctx.now).filter((c) => INCAPACITATING.has(c.kind));
  if (unable.length > 0) problems.push({ path: "$.tags", reason: "她现在" + unable.map((c) => c.text).join("、") + "，不会有亲密场景", hint: "" });
  return problems;
}

/** 记下她这一次的反应与状况变化，返回新的 { her, scene }。 */
export function apply(state, input, ctx) {
  const her = { ...state.her };
  const change = input.her?.state;
  let conditions = activeConditions(state.her, ctx.now);
  if (change?.remove?.length) conditions = conditions.filter((c) => !change.remove.includes(c.kind));
  for (const add of change?.add ?? []) {
    conditions = [
      ...conditions.filter((c) => c.kind !== add.kind),
      { kind: add.kind, text: add.text, since: ctx.now, until: add.minutes ? T.addMinutes(ctx.now, add.minutes) : null },
    ];
  }
  her.conditions = conditions;
  const response = input.her?.response;
  const scene = response !== undefined
    ? { ...state.scene, responses: [...(state.scene.responses ?? []), response].slice(-3) }
    : state.scene;
  return { her, scene };
}
