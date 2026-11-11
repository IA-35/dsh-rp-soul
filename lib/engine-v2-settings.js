/**
 * engine-v2-settings —— 设置页的命令（常识库、自主行动记录、人设校验）在新引擎下的实现。
 *
 * 桥接层的 call(command, payload) 先查这里。返回的形状照旧引擎（设置页前端不用改），
 * 失败一律抛 Error：路由层接住变成 { ok: false, error }。
 */

import * as CM from "./engine/modules/common/index.js";
import { STAGES, STAGE_ZH } from "./engine/modules/mood/bond.js";
import * as T from "./engine/core/time.js";

const RESPONSE_ZH = Object.freeze({
  refuse: "拒绝", negotiate: "讨价还价", partial: "答应了一部分", surface: "表面上答应", genuine: "真心答应",
});

/** 交账流水里的一条 → 「自主行动记录」页的一行。 */
export function activityRow(entry, names) {
  const input = entry.input ?? {};
  const her = input.her ?? {};
  const revision = Number(/^[ce](\d+)-/.exec(entry.id ?? "")?.[1] ?? 0);
  return {
    turn: revision,
    revision,
    kind: entry.edit ? "edit" : "commit",
    ...(entry.alone ? { mode: "alone" } : {}),
    created_at: entry.at,
    summary: entry.summary,
    open_action: entry.open ?? "",
    actions: input.act && her.did ? [{ kind: input.act.kind ?? "", kind_label: input.act.kind ?? "行动", name: names.her, text: her.did, significant: input.act.significant === true }] : [],
    beats: input.away ? [{ name: names.her, summary: input.away }] : [],
    responses: her.response ? [{ name: names.her, label: RESPONSE_ZH[her.response] ?? her.response, note: her.did ?? "" }] : [],
    relations: input.bond && (input.bond.trust || input.bond.tension || input.bond.stage)
      ? [{ from_name: names.her, to_name: names.you, trust: input.bond.trust ?? 0, tension: input.bond.tension ?? 0, stage_label: STAGE_ZH[input.bond.stage] ?? (input.bond.stage === "advance" ? "往前一步" : "") }]
      : [],
    thoughts: (input.feel ?? []).map((f) => ({ name: names.her, label: f.label, delta: f.delta })),
  };
}

/**
 * 新引擎读人设前置块里的这些字段：写错了在这里先说，不等开局才发现。
 * 返回问题清单（空 = 能用）。
 */
export function checkPersona(front) {
  const problems = [];
  const bad = (path, reason, hint = "") => problems.push({ path, reason, hint });
  if (front.mood_base !== undefined && !(Number.isInteger(front.mood_base) && front.mood_base >= 0 && front.mood_base <= 100)) {
    bad("mood_base", "要 0..100 的整数", "不写就是 50");
  }
  if (front.start_stage !== undefined && !STAGES.includes(front.start_stage)) {
    bad("start_stage", "不认识的阶段：" + JSON.stringify(front.start_stage), "可选：" + STAGES.join(" / "));
  }
  const limits = front.mood_thresholds;
  if (limits !== undefined) {
    const ints = limits !== null && typeof limits === "object" && ["open", "closed", "break"].every((k) => Number.isInteger(limits[k]));
    if (!ints || !(limits.break < limits.closed && limits.closed < limits.open)) bad("mood_thresholds", "要三个整数，break < closed < open", "不写就用默认的");
  }
  if (front.routine !== undefined && !Array.isArray(front.routine)) bad("routine", "要一个列表");
  (Array.isArray(front.routine) ? front.routine : []).forEach((slot, i) => {
    const minute = (v) => (Number.isInteger(v) && v >= 0 && v < 1440) || T.parseClock(v) !== null;
    if (slot === null || typeof slot !== "object") return bad("routine[" + i + "]", "要 { from, to, doing }");
    if (!minute(slot.from) || !minute(slot.to)) bad("routine[" + i + "]", "from / to 要是 HH:MM 或当天第几分钟（0..1439）");
    if (typeof slot.doing !== "string" || slot.doing.trim() === "") bad("routine[" + i + "].doing", "这一段在做什么，不能空着");
  });
  return problems;
}

const fail = (message) => { throw new Error(message); };

/**
 * 命令表。engine() 拿引擎（还没就绪会抛），persona() 拿当前人设（可能是 null）。
 */
export function settingsCommands({ engine, persona }) {
  const commonWrite = (change, receipt) => {
    const panel = engine().changeCommon(change);
    if (panel === null) fail("没有这条常识，或者关键词 / 内容是空的");
    return { ...panel, receipt };
  };
  const exists = (id) => (rows) => (rows.some((row) => row.id === id) ? rows : null);

  return {
    "debug-common": () => engine().common(),
    "add-common": (p) => commonWrite((rows) => {
      const row = CM.make(rows, p);
      return row === null ? null : [...rows, row];
    }, "已加上"),
    "edit-common": (p) => commonWrite((rows) => CM.edit(rows, String(p.common_id ?? ""), p), "已改好"),
    "delete-common": (p) => commonWrite((rows) => {
      const id = String(p.common_id ?? "");
      return exists(id)(rows) && rows.filter((row) => row.id !== id);
    }, "已删除"),
    "approve-common": (p) => commonWrite((rows) => {
      const id = String(p.common_id ?? "");
      return exists(id)(rows) && rows.map((row) => (row.id === id ? { ...row, pending: false } : row));
    }, "已确认，以后命中就会注入"),
    "set-common-limit": (p) => ({ ...engine().setCommonLimit(p.limit), receipt: "已改" }),

    "debug-activity": (p) => {
      const her = persona();
      const view = engine().context({ persona: her });
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(p.limit) || 20)));
      const names = { her: her?.name ?? "她", you: her?.player_name ?? "你" };
      const rows = engine().log(limit).map((entry) => activityRow(entry, names));
            return {
        revision: view.revision,
        turn: view.revision,
        clock_label: T.label(view.now, view.now),
        open_action: view.fields.open ?? "",
        counts: {
          turns: rows.length,
          actions: rows.filter((r) => r.actions.length > 0).length,
          beats: rows.filter((r) => r.beats.length > 0).length,
        },
        rows,
      };
    },

    // ---- 记忆页 ----
    "debug-memories": () => {
      const panel = engine().panel("memory", { persona: persona() });
      if (panel === null) fail("记忆模块关着");
      return { ...panel, clock_label: T.label(panel.now, panel.now) };
    },
    "edit-memory": (p) => {
      const done = engine().editMemory(String(p.memory_id ?? ""), p);
      if (done === null) fail("没有这条记忆");
      return { ...done, receipt: "已保存" };
    },
    "delete-memory": (p) => {
      const done = engine().removeMemory(String(p.memory_id ?? ""));
      if (done === null) fail("没有这条记忆");
      return { ...done, receipt: "已删除" };
    },
    "request-memory": (p) => {
      const kind = p.kind === "diary" ? "diary" : "fold";
      if (engine().memoryDue({ manual: true })[kind] === null) fail(kind === "fold" ? "ABM 里没有可以收的" : "没有欠着的日记（SCM 里还没有能写进日记的）");
      return { kind };
    },

    "preview-persona": (p) => {
      const front = p.persona?.front ?? {};
      const problems = checkPersona(front);
      if (problems.length === 0) return { ok: true };
      const error = new Error(problems.length + " 处问题");
      error.details = problems;
      throw error;
    },
  };
}
