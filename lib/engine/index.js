/* lib/engine/index.js — 新引擎对外的 API。桥接层、设置页只认这里。
 *
 *   const engine = createEngine({ dataDir, toggles, host })
 *   engine.start(persona)                       开一局（已有就不动，force 才重开）
 *   engine.context({ persona, alone })          这一刻的局面：{ revision, lines, fields }
 *   engine.commit(input, { persona, alone, said, revision })
 *   engine.undo()                               撤销上一次交账
 *   engine.spec()                               这一刻的交账表（给工具注册与说明用）
 *   engine.modules()                            模块清单与开关状态
 *   engine.setToggles(toggles)                  改开关
 *   engine.panel(moduleId, { persona })         某个模块此刻的完整数据（设置页用）
 *   engine.edit(moduleId, change, summary)      设置页手动改一个模块（留一条流水，能撤销）
 *   engine.nextWake({ persona, ...options })    她下一次该什么时候自己醒（唤醒模块关着就是 null）
 *   engine.recall(cue, { firstTurn })           主人这句话勾起的记忆和常识（一段文本，没有就是空串）
 *   engine.common() / changeCommon(fn) / setCommonLimit(n)   设置页「常识库」
 *   engine.save(name) / slots() / load(name) / dropSlot(name) / exportAll()   存档与导出
 *   engine.setPaused(paused)                    安全暂停：暂停时亲密与冲突内容一律驳回
 *   engine.noteExchange / memoryDue / applyFold / applyDiary / editMemory / removeMemory   记忆（宿主在背后写，不动 revision）
 *   engine.wipe()                               清空全部引擎数据
 *
 * 「现在」只在这一层读（clock 可注入，测试里随便造），往下全是传进去的。
 */

import { join } from "node:path";
import * as T from "./core/time.js";
import * as R from "./core/registry.js";
import { newLedger, commit as commitPure, commitSpec, coreAnswers, LOG_KEEP } from "./core/commit.js";
import { view } from "./core/context.js";
import { openStore } from "./store.js";
import mood from "./modules/mood/index.js";
import wake from "./modules/wake/index.js";
import * as WAKE from "./modules/wake/schedule.js";
import common, * as CM from "./modules/common/index.js";
import memory, * as MEM from "./modules/memory/index.js";
import * as ML from "./modules/memory/layers.js";

/** 内置模块，顺序就是交账里执行的顺序（记忆在最后：它要读情绪这一次刚记下的心事）。 */
export const BUILTIN = Object.freeze([mood, wake, common, memory]);
export const DB_FILE = "engine-v2.db";

const nowIso = (clock) => T.iso(clock().getTime());

export function createEngine({ dataDir, file, modules = BUILTIN, toggles = {}, host = {}, clock = () => new Date() } = {}) {
  const registry = R.createRegistry(modules);
  const store = openStore(file ?? join(dataDir, DB_FILE));
  let switches = { ...toggles };
  const resolved = () => R.resolve(registry, switches, host);

  const current = () => {
    const row = store.ledger();
    if (row === null) {
      const error = new Error("还没开局");
      error.code = "NO_LEDGER";
      throw error;
    }
    return row.state;
  };

  /** 拿一份读局面用的 ctx（模块之间 ask 要用）。 */
  const contextFor = (state, now, persona = null, alone = false) => R.createContext({
    registry, enabled: resolved().enabled, now, alone, persona, kernel: state,
    slices: () => state.modules,
    coreAnswers: coreAnswers(state, now, persona),
  });

  /**
   * 记忆模块关着、还没开局：null。否则 change(slice, ctx, now) 返回 { slice, out }，
   * slice 原地写回（不动 revision，模型手里的 revision 照样有效）。
   */
  const patchMemory = (change, persona = null) => {
    const row = store.ledger();
    if (row === null || !resolved().enabled.includes("memory")) return null;
    const now = nowIso(clock);
    const state = row.state;
    const slice = state.modules.memory ?? ML.init();
    const done = change(slice, contextFor(state, now, persona), now);
    if (done === null || done.slice === slice) return done?.out ?? null;
    store.replace({ ...state, modules: { ...state.modules, memory: ML.maintain(done.slice, now) } }, now);
    return done.out;
  };

  /**
   * 不算交账的一次改动（设置页改、读档、暂停）：换成 next，revision 加一，记一条流水，
   * 和交账一样先存快照（能撤销）。不动「上次交账」的时刻。
   */
  const rewrite = (before, next, summary) => {
    const now = nowIso(clock);
    const rev = before.revision + 1;
    const id = "e" + rev + "-" + T.ms(now).toString(36);
    const entry = { id, at: now, summary, open: before.log.at(-1)?.open ?? "", quotes: [], edit: true };
    const after = { ...next, revision: rev, log: [...next.log, entry].slice(-LOG_KEEP) };
    store.commit({ before, after, id, entry, now });
    return { ok: true, id, revision: rev };
  };

  return {
    registry,

    /** 开一局。已经有一局时什么都不做（force: true 才整局重开）。 */
    start(persona, { force = false } = {}) {
      const existing = store.ledger();
      if (existing !== null && !force) return { created: false, revision: existing.revision };
      const now = nowIso(clock);
      const state = newLedger(persona, now, registry);
      store.create(state, now);
      return { created: true, revision: state.revision };
    },

    /** 这一刻的局面（只读，不写账本）。 */
    context({ persona = null, alone = false } = {}) {
      const state = current();
      const { enabled } = resolved();
      const now = nowIso(clock);
      const out = view(state, { now, registry, enabled, persona, alone });
      return { revision: state.revision, now, ...out };
    },

    /**
     * 交账。revision 是调用方读局面时拿到的那个：账本已经往前走了就返回 stale，
     * 调用方重新读一遍局面再决定怎么记。
     */
    commit(input, { persona = null, alone = false, said = false, revision } = {}) {
      const before = current();
      if (revision !== undefined && revision !== before.revision) {
        return { ok: false, stale: true, revision: before.revision, problems: [{ path: "$", reason: "局面已经变了", hint: "重新读一遍局面再交" }] };
      }
      const now = nowIso(clock);
      const { enabled } = resolved();
      const result = commitPure(before, input, { now, registry, enabled, persona, alone, said });
      if (!result.ok) return { ok: false, revision: before.revision, problems: result.problems, notes: result.notes };
      // 模型提的常识：并进全局常识表（挂起等确认），和账本同一个事务。她自己醒着的那一次不收
      const proposed = enabled.includes("common") && !alone && result.input.common?.length ? result.input.common : null;
      const commonRows = proposed === null ? undefined : CM.merge(store.commonRows(), proposed, now).rows;
      // 流水里多存一份这次交了什么（账本里的那 40 条不存，免得账本越来越大）：给「自主行动记录」页看
      const entry = { ...result.state.log.at(-1), input: result.input };
      try {
        store.commit({ before, after: result.state, id: result.id, entry, now, common: commonRows });
      } catch (error) {
        if (error.stale) return { ok: false, stale: true, revision: error.revision, problems: [{ path: "$", reason: "局面已经变了", hint: "重新读一遍局面再交" }] };
        throw error;
      }
      return { ok: true, id: result.id, revision: result.state.revision, notes: result.notes };
    },

    /** 撤销上一次交账；没有可撤销的返回 { ok: false }。 */
    undo() {
      const done = store.undo(nowIso(clock));
      if (done === null) return { ok: false, reason: "没有可以撤销的" };
      return { ok: true, undone: done.undone, revision: done.state.revision, left: store.undoable() };
    },

    /** 某个开着的模块此刻的完整数据（模块自己的 panel）；关着或没有 panel 返回 null。 */
    panel(moduleId, { persona = null, alone = false } = {}) {
      const state = current();
      const { enabled } = resolved();
      const mod = registry.byId.get(moduleId);
      if (!enabled.includes(moduleId) || typeof mod?.panel !== "function") return null;
      const now = nowIso(clock);
      const ctx = R.createContext({
        registry, enabled, now, alone, persona, kernel: state,
        slices: () => state.modules,
        coreAnswers: coreAnswers(state, now, persona),
      });
      // 这一局开局时还没有这个模块：按刚开局的样子现算
      const slice = state.modules[moduleId] ?? (typeof mod.init === "function" ? mod.init(persona, now) : {});
      return { revision: state.revision, now, ...mod.panel(slice, ctx) };
    },

    /**
     * 设置页手动改一个模块：change(切片) 返回新切片，返回 null 表示没找到要改的。
     * 和交账一样写快照、记一条流水（能撤销）；不算一次交账（不动「上次交账」的时刻）。
     */
    edit(moduleId, change, summary, { revision } = {}) {
      const before = current();
      if (revision !== undefined && revision !== before.revision) return { ok: false, stale: true, revision: before.revision };
      const next = change(before.modules[moduleId]);
      if (next === null || next === undefined) return { ok: false, revision: before.revision };
      return rewrite(before, { ...before, modules: { ...before.modules, [moduleId]: next } }, summary);
    },

    /**
     * 她下一次该什么时候自己醒：{ next, all }。唤醒模块关着、还没开局都是 { next: null, all: [] }。
     * options：{ missYouHours, streak, lastWakeAt, routine, quiet }（宿主的唤醒设置）。
     */
    nextWake({ persona = null, ...options } = {}) {
      const row = store.ledger();
      if (row === null || !resolved().enabled.includes("wake")) return { next: null, all: [] };
      const now = nowIso(clock);
      const diary = resolved().enabled.includes("memory") ? ML.diaryWakeAt(row.state.modules.memory ?? ML.init(), now) : null;
      return WAKE.next(row.state, row.state.modules.wake?.plan ?? null, { now, persona, diary, ...options });
    },

    /** 主人这句话勾起的记忆和常识（firstTurn：新会话第一轮再带上最近一篇日记）；什么都没有就是空串。 */
    recall(cue, { firstTurn = false } = {}) {
      const { enabled } = resolved();
      const parts = [];
      const row = enabled.includes("memory") ? store.ledger() : null;
      if (row !== null) parts.push(MEM.recallText(row.state.modules.memory ?? ML.init(), cue, nowIso(clock), { firstTurn }));
      if (enabled.includes("common")) parts.push(CM.render(CM.select(store.commonRows(), cue, CM.limitOf(store.commonLimit() ?? CM.LIMIT_DEFAULT)), cue));
      return parts.filter((p) => p !== "").join("\n");
    },

    /** 设置页「常识库」：{ count, pending, limit, rows }。 */
    common() {
      return CM.panel(store.commonRows(), CM.limitOf(store.commonLimit() ?? CM.LIMIT_DEFAULT));
    },

    /** 改常识表：change(rows) 返回新表，返回 null 表示没找到 / 不合法（什么都不写）。 */
    changeCommon(change) {
      const next = change(store.commonRows());
      if (next === null || next === undefined) return null;
      store.putCommon(next);
      return this.common();
    },

    setCommonLimit(limit) {
      store.setCommonLimit(CM.limitOf(limit));
      return this.common();
    },

    /** 存一份命名存档。同名的已经有了要 overwrite: true。 */
    save(name, { label = "", overwrite = false } = {}) {
      const state = current();
      const saved = store.saveSlot({ name, label: label || name, state, now: nowIso(clock), overwrite });
      return saved ? { ok: true, name, revision: state.revision } : { ok: false, reason: "已经有叫「" + name + "」的存档：要覆盖就带 overwrite: true" };
    },

    slots() {
      return store.slots();
    },

    /** 读档：整局换成那份存档（读档前的局面存成快照，撤销能回来）。 */
    load(name) {
      const saved = store.slot(name);
      if (saved === null) return { ok: false, reason: "没有叫「" + name + "」的存档" };
      const before = current();
      // 读回来的流水、revision 都接着现在的往下记：拿着读档前 revision 的交账照样被挡住
      return rewrite(before, { ...saved, log: saved.log ?? [] }, "读档「" + name + "」");
    },

    dropSlot(name) {
      return store.deleteSlot(name) ? { ok: true } : { ok: false, reason: "没有叫「" + name + "」的存档" };
    },

    /** 导出：这一局整份状态 + 全局常识库（写成文件由调用方决定）。 */
    exportAll() {
      return { v: 1, exported_at: nowIso(clock), ledger: current(), common: store.commonRows() };
    },

    /** 安全暂停 / 恢复。返回 { ok, paused, changed }。 */
    setPaused(paused) {
      const before = current();
      if (before.safety.paused === paused) return { ok: true, paused, changed: false };
      const done = rewrite(before, { ...before, safety: { ...before.safety, paused } }, paused ? "暂停：亲密与冲突内容先停下" : "恢复");
      return { ...done, paused, changed: true };
    },

    /**
     * 宿主替她记的一段（回合结束时）：{ text, together, you }。返回 { id, duplicate } 或 null（没记）。
     */
    noteExchange({ text, together = true, you = "" }, { persona = null } = {}) {
      return patchMemory((slice, ctx) => {
        const made = MEM.noteExchange(slice, { text, together, you }, ctx);
        if (made.entry === null) return null;
        return { slice: made.slice, out: { id: made.entry.id, duplicate: made.duplicate } };
      }, persona);
    },

    /** 被主人这句话勾起的记忆加一点活跃度（回合结束时一轮一次）。返回加了几条。 */
    reinforce(cue) {
      return patchMemory((slice, _ctx, now) => {
        const next = MEM.reinforce(slice, cue, now);
        return next === null ? null : { slice: next, out: { ok: true } };
      }) !== null;
    },

    /** 现在欠着的整理：{ fold: { ids, sources } | null, diary: { day, ids, sources } | null }。manual：设置页点的，不等。 */
    memoryDue({ manual = false } = {}) {
      const row = store.ledger();
      if (row === null || !resolved().enabled.includes("memory")) return { fold: null, diary: null };
      const now = nowIso(clock);
      const slice = row.state.modules.memory ?? ML.init();
      const fold = ML.foldBatch(slice, now, { manual });
      const diary = ML.diaryDue(slice, now, { manual });
      return {
        fold: fold === null ? null : { ids: fold, sources: ML.sources(slice, fold) },
        diary: diary === null ? null : { ...diary, sources: ML.sources(slice, diary.ids) },
      };
    },

    /** 子代理收好的一批：ids 收成一条 SCM，keep 里的抄进 CLPA。返回新 SCM 的 id 或 null（那一批已经没了）。 */
    applyFold(ids, text, keep = []) {
      return patchMemory((slice, _ctx, now) => {
        const next = ML.applyFold(slice, ids, text, keep, now);
        return next === null ? null : { slice: next, out: { ok: true } };
      });
    },

    /** 子代理写好的日记：那一天的 SCM 记下「写进日记了」。 */
    applyDiary(day, ids, text) {
      return patchMemory((slice) => ({ slice: ML.applyDiary(slice, day, ids, text), out: { ok: true, day } }));
    },

    /** 设置页改 / 删一条记忆。找不到返回 null。 */
    editMemory(id, changes) {
      return patchMemory((slice, _ctx, now) => {
        const next = ML.edit(slice, id, changes, now);
        return next === null ? null : { slice: next, out: { ok: true, id } };
      });
    },

    removeMemory(id) {
      return patchMemory((slice) => {
        const next = ML.remove(slice, id);
        return next === null ? null : { slice: next, out: { ok: true, id } };
      });
    },

    /** 这一刻的交账表：fields / guide（给模型的说明）/ json（给工具注册）。 */
    spec() {
      const { fields, guide, json } = commitSpec(registry, resolved().enabled);
      return { fields, guide, json };
    },

    /** 模块清单：每个模块开没开、为什么没开。 */
    modules() {
      const { enabled, off } = resolved();
      return registry.list.map((mod) => ({ id: mod.id, label: mod.label, on: enabled.includes(mod.id), why: off[mod.id] ?? null }));
    },

    setToggles(next) {
      switches = { ...next };
      return this.modules();
    },

    /** 最近的交账流水，新的在前。 */
    log(limit) {
      return store.log(limit);
    },

    wipe() {
      store.wipe();
    },

    close() {
      store.close();
    },
  };
}
