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
 *   engine.wipe()                               清空全部引擎数据
 *
 * 「现在」只在这一层读（clock 可注入，测试里随便造），往下全是传进去的。
 */

import { join } from "node:path";
import * as T from "./core/time.js";
import * as R from "./core/registry.js";
import { newLedger, commit as commitPure, commitSpec } from "./core/commit.js";
import { view } from "./core/context.js";
import { openStore } from "./store.js";
import mood from "./modules/mood/index.js";

/** 内置模块，顺序就是交账里执行的顺序。 */
export const BUILTIN = Object.freeze([mood]);
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
      const out = view(state, { now: nowIso(clock), registry, enabled, persona, alone });
      return { revision: state.revision, ...out };
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
      try {
        store.commit({ before, after: result.state, id: result.id, entry: result.state.log.at(-1), now });
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
