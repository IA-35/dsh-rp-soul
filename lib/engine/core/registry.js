/* lib/engine/core/registry.js — 模块清单、开关、依赖，以及模块之间说话的两种方式。
 *
 * 模块之间不直接调用：
 *   ctx.ask("mood.band")      读别人；对方关着（或没这个回答）就拿到 null
 *   ctx.emit("event.failed")  通知别人；对方关着就没人听
 * 所以关掉任何一个模块，其它照常跑。
 *
 * 一个模块的形状见 docs/engine-js-design.md 第 2.1 节。这里只认这些键：
 *   id label requires settings fields init view tidy validate apply on answers project host panel
 */

/** 内核的名字：ctx.ask("core.xxx") 问的是内核。内核没有开关。 */
export const CORE = "core";

const KNOWN_KEYS = new Set([
  "id", "label", "requires", "settings", "fields", "init", "view", "tidy",
  "validate", "apply", "on", "answers", "project", "host", "panel",
]);

/**
 * 登记一组模块（顺序就是它们在交账里执行的顺序）。
 * 形状不对直接抛：这是写代码时的错，不是运行时的情况。
 */
export function createRegistry(modules) {
  const byId = new Map();
  for (const mod of modules) {
    if (mod === null || typeof mod !== "object") throw new Error("模块必须是对象");
    if (typeof mod.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(mod.id)) throw new Error("模块 id 不合法：" + mod.id);
    if (mod.id === CORE) throw new Error("「core」留给内核");
    if (byId.has(mod.id)) throw new Error("模块 id 重复：" + mod.id);
    for (const key of Object.keys(mod)) {
      if (!KNOWN_KEYS.has(key)) throw new Error("模块 " + mod.id + " 有不认识的键：" + key);
    }
    byId.set(mod.id, mod);
  }
  return Object.freeze({ list: Object.freeze([...modules]), byId });
}

/**
 * 按开关和依赖算出哪些模块真的开着。
 *
 * toggles：{ memory: false }，没写的默认开。
 * host：宿主有什么能力，比如 { subagents: true }；模块 requires 里写 "host:subagents"。
 * 返回 { enabled: [id…]（按登记顺序）, off: { id: 为什么没开 } }。
 */
export function resolve(registry, toggles = {}, host = {}) {
  const off = {};
  for (const mod of registry.list) {
    if (toggles[mod.id] === false) off[mod.id] = "你关掉了";
  }
  // 依赖可能一层套一层：一直算到没有新的模块被关掉为止
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of registry.list) {
      if (off[mod.id] !== undefined) continue;
      for (const need of mod.requires ?? []) {
        if (need.startsWith("host:")) {
          const cap = need.slice(5);
          if (host[cap] !== true) off[mod.id] = "宿主没有「" + cap + "」";
        } else if (!registry.byId.has(need)) {
          off[mod.id] = "依赖的模块不存在：" + need;
        } else if (off[need] !== undefined) {
          off[mod.id] = "依赖的「" + registry.byId.get(need).label + "」没开";
        }
        if (off[mod.id] !== undefined) {
          changed = true;
          break;
        }
      }
    }
  }
  const enabled = registry.list.map((mod) => mod.id).filter((id) => off[id] === undefined);
  return { enabled: Object.freeze(enabled), off: Object.freeze(off) };
}

/**
 * 交账表：内核字段 + 开着的模块字段。两个地方认领同一个字段名是写代码时的错，直接抛。
 */
export function fieldsOf(registry, enabled, coreFields) {
  const fields = { ...coreFields };
  const owner = Object.fromEntries(Object.keys(coreFields).map((key) => [key, CORE]));
  for (const id of enabled) {
    for (const [key, spec] of Object.entries(registry.byId.get(id).fields ?? {})) {
      if (owner[key] !== undefined) throw new Error("字段 " + key + " 同时归 " + owner[key] + " 和 " + id);
      owner[key] = id;
      fields[key] = spec;
    }
  }
  return { fields, owner };
}

/**
 * 一次交账 / 一次读局面用的 ctx。
 *
 * slices()：取当前各模块切片（交账过程中会变，所以每次现取）。
 * coreAnswers：内核能回答的问题 { knows: (key) => … }。
 */
export function createContext({ registry, enabled, now, alone = false, persona = null, slices, kernel, coreAnswers = {} }) {
  const on = new Set(enabled);
  const signals = [];
  const notes = [];
  const ctx = {
    now,
    alone,
    persona,
    kernel,
    /** 这个模块开着吗。 */
    isOn: (id) => id === CORE || on.has(id),
    /** 问一句：「模块.问题」，对方关着或不会答就是 null。 */
    ask(name, ...args) {
      const dot = name.indexOf(".");
      if (dot <= 0) return null;
      const id = name.slice(0, dot);
      const key = name.slice(dot + 1);
      if (id === CORE) {
        const fn = coreAnswers[key];
        return typeof fn === "function" ? fn(...args) ?? null : null;
      }
      if (!on.has(id)) return null;
      const fn = registry.byId.get(id)?.answers?.[key];
      if (typeof fn !== "function") return null;
      return fn(slices()[id], ctx, ...args) ?? null;
    },
    /** 发一个信号；交账在所有模块 apply 完之后统一分发。 */
    emit(name, payload = {}) {
      signals.push({ name, payload });
    },
    /** 在回执里说一句。 */
    note(text) {
      if (typeof text === "string" && text !== "") notes.push(text);
    },
    signals,
    notes,
  };
  return ctx;
}

/** 把攒下的信号发给开着的模块，返回新的切片表（不改入参）。 */
export function dispatch(registry, enabled, slices, signals, ctx) {
  let next = slices;
  for (const { name, payload } of signals) {
    for (const id of enabled) {
      const handler = registry.byId.get(id).on?.[name];
      if (typeof handler !== "function") continue;
      next = { ...next, [id]: handler(next[id], payload, ctx) };
    }
  }
  return next;
}
