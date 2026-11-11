/**
 * engine-v2-bridge —— 把新引擎（lib/engine，进程内 JS + SQLite）接进 DSH。
 *
 * 对 index.js / wake.js 露出和旧桥接（engine-bridge.js）同样的一组方法，配置里
 * engine: "js" 时用这一份。还没移植的部分（记忆、常识、设置页的那些命令）
 * 在这里是空操作或明说「还不支持」，等各自那一阶段接上。
 *
 * 和旧桥接的差别：
 * - 没有子进程、没有会话映射表：全局只有一局（作用域永远是 global）；
 * - 读局面是同步的，快照不用缓存，装配时现读；
 * - 交账表（工具参数）由引擎按开着的模块生成，不再手写。
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { createEngine } from "./engine/index.js";
import { dropThought } from "./engine/modules/mood/index.js";
import * as T from "./engine/core/time.js";

/** 设置页认的「会话 id」：新引擎全局只有一局，固定就是它。 */
export const LEDGER_SESSION = "main";

/**
 * 情绪模块的 panel → 设置页「情绪」页认的旧形状（debug-moods：npcs 数组，一个人一张卡）。
 * 心事 kind：记下的叫 memory（页面显示「记忆」），推出来的叫 situational（显示「情境」）。
 */
export function moodsView(panel, her) {
  const now = panel.now;
  return {
    revision: panel.revision,
    turn: panel.revision,
    clock_label: T.label(now, now),
    thresholds: panel.thresholds,
    npcs: [{
      id: her.id,
      name: her.name,
      present: true,
      conditions: panel.conditions,
      value: panel.value,
      band: panel.band,
      base: panel.base,
      trust: panel.bond.trust,
      tension: panel.bond.tension,
      stage: panel.bond.stage,
      stage_label: panel.bond.stage_label,
      can_act: panel.cooldown === 0,
      thoughts: panel.thoughts.map((t) => ({
        id: t.id,
        label: t.label,
        delta: t.weight,
        kind: t.situational ? "situational" : "memory",
        remaining_minutes: t.until === null ? null : T.minutesBetween(now, t.until),
      })),
    }],
    deletions: [],
  };
}

/** 引擎数据目录的默认位置（相对 $DSH_HOME），和旧引擎同一个目录，库文件名不同。 */
const ENGINE_DIR = "rp-soul/engine";
const CHILD_HINT = "这是后台子任务：不读也不写她的账本，只做交给你的那件事。";
const NOT_YET = "新引擎（engine: js）还不支持这一项，换回 engine: python 再用";

const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
const JSON_OBJECT = { type: "object", additionalProperties: true };

/**
 * 宿主起的子任务（spawn / fork 出来的子代理）不是她：不读也不写账本。
 * 判定和旧桥接一致：会话头上 origin 是 subagent，或委派深度大于 0。
 */
export function isChildAgent(agent) {
  try {
    const header = agent?.session?.header;
    if (header === null || typeof header !== "object") return false;
    return header.origin === "subagent" || (Number(header.delegationDepth) || 0) > 0;
  } catch {
    return false;
  }
}

/** 会话里主人说的最后一句话（注入的 user 角色上下文不算）。拿不到就是空串。 */
export function cueOf(context) {
  try {
    const session = context?.agent?.session;
    if (session === undefined || session === null || typeof session.deriveMessages !== "function") return "";
    const messages = session.deriveMessages();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === null || typeof message !== "object" || message.role !== "user") continue;
      if (message.source !== undefined && message.source?.kind !== "user") continue;
      const said = (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (said !== "") return said.slice(0, 800);
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 人设包（index.js 的 persona()）→ 新引擎要的 persona：前置块原样铺开，
 * 补上 id / name / revision。前置块解析失败返回 null。
 */
export function toPersona(built) {
  if (built === null || typeof built !== "object" || built.error) return null;
  const front = built.front !== null && typeof built.front === "object" ? built.front : {};
  const id = built.personaId ?? (typeof front.id === "string" && front.id !== "" ? front.id : "her");
  const name = typeof front.name === "string" && front.name.trim() !== "" ? front.name.trim() : (built.title || "她");
  const revision = createHash("sha256").update(String(built.prose ?? "") + JSON.stringify(front)).digest("hex").slice(0, 16);
  return { ...front, id, name, revision };
}

export function mountEngineV2(ctx, env) {
  const { root, cfg, persona } = env;
  const dataDirOf = () => {
    const store = env.store() ?? {};
    const custom = typeof store.engineDataDir === "string" ? store.engineDataDir.trim() : "";
    if (custom !== "") return custom;
    const fromCfg = typeof cfg.engineDataDir === "string" ? cfg.engineDataDir.trim() : "";
    return fromCfg !== "" ? fromCfg : join(root, ENGINE_DIR);
  };
  // 数据目录可以在设置页里改：换了目录就关掉旧库、开新库
  let opened = null;
  const engine = () => {
    const dataDir = dataDirOf();
    if (opened !== null && opened.dataDir === dataDir) return opened.engine;
    if (opened !== null) opened.engine.close();
    opened = { dataDir, engine: createEngine({ dataDir }) };
    return opened.engine;
  };
  const enabled = () => cfg.engineEnabled !== false;
  const currentPersona = () => toPersona(persona());
  // 每个 agent 上一次读到的 revision：交账时带上，账本被别的会话改过就挡住重读
  const seen = new Map();
  const agentKey = (context) => (typeof context?.agent?.id === "string" ? context.agent.id : "");

  /** 这一次是不是她自己醒来的「我的时间」：由唤醒线判定，不交给模型填。 */
  const aloneOf = (exec) => {
    const wake = env.wake?.current ?? null;
    return wake !== null && typeof wake.isWakeTurn === "function" && wake.isWakeTurn(exec?.agent?.id) === true;
  };

  /** 没有局就地开一局（全局账本「一进来就在」）。开不起来返回原因。 */
  const ensure = () => {
    const her = currentPersona();
    if (her === null) return { ok: false, why: "人设前置块读不出来，先去设置页修好 persona.md" };
    engine().start(her);
    return { ok: true, persona: her };
  };

  /** 读一次局面，顺手记下这个 agent 看到的 revision。 */
  const read = (context, alone) => {
    const ready = ensure();
    if (!ready.ok) return { ok: false, why: ready.why };
    const view = engine().context({ persona: ready.persona, alone });
    seen.set(agentKey(context), view.revision);
    return { ok: true, persona: ready.persona, view };
  };

  const health = () => ({
    enabled: enabled(),
    present: true,
    engine: "js",
    // 设置页还按旧形状读 python.ok：新引擎在进程里，永远「探测通过」
    python: { ok: true, reason: null },
    dataDir: dataDirOf(),
    ready: enabled(),
  });

  const snapshotText = (context) => {
    if (!enabled() || isChildAgent(context?.agent)) return "";
    try {
      const got = read(context, aloneOf(context));
      if (!got.ok) return "";
      return "## 【当前现状】\n" + got.view.lines.join("\n") + "\n"
        + "这段只是账本快照：写完用 soul_commit 交账。要「下一步能做什么」的候选或别的细节时，再调 soul_state。";
    } catch {
      // 读账本失败绝不拖垮这一轮对话
      return "";
    }
  };

  const readState = async (_args, exec) => {
    if (isChildAgent(exec?.agent)) return { started: false, hint: CHILD_HINT };
    if (!enabled()) return { started: false, hint: "引擎在设置页里被关掉了：只按人设散文演。" };
    try {
      const got = read(exec, aloneOf(exec));
      if (!got.ok) return { started: false, hint: "没能开局（" + got.why + "）：这一次只按人设散文演，不要假装有账本。" };
      return { started: true, revision: got.view.revision, ...got.view.fields };
    } catch (error) {
      return { started: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const commitTurn = async (args, exec) => {
    if (isChildAgent(exec?.agent)) return { committed: false, hint: CHILD_HINT };
    if (!enabled()) return { committed: false, hint: "引擎不可用，这一次按纯提示词模式写；不要伪造账本。" };
    try {
      const ready = ensure();
      if (!ready.ok) return { committed: false, hint: "没能开局（" + ready.why + "）：这一次不记账。" };
      const alone = aloneOf(exec);
      // 她自己醒来的那一次没有「他说的话」
      const said = !alone && cueOf(exec) !== "";
      const key = agentKey(exec);
      const revision = seen.has(key) ? seen.get(key) : undefined;
      const result = engine().commit(args ?? {}, { persona: ready.persona, alone, said, revision });
      if (result.ok) {
        seen.set(key, result.revision);
        const out = { committed: true, id: result.id };
        if (result.notes?.length > 0) out.notes = result.notes;
        return out;
      }
      if (result.stale) {
        // 别的会话先交了一笔：把现在的局面直接给模型，让它重判再交
        const fresh = read(exec, alone);
        return {
          committed: false,
          stale: true,
          retry_hint: "局面已经变了：看下面的现状重新决定这次怎么记，再交一次。",
          now: fresh.ok ? fresh.view.lines : [],
        };
      }
      return {
        committed: false,
        rejected: true,
        problems: result.problems,
        ...(result.notes?.length > 0 ? { notes: result.notes } : {}),
        retry_hint: "按每条 path 的问题改，然后重新调 soul_commit；最多再试一次。",
      };
    } catch (error) {
      return { committed: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const admin = async (args, exec) => {
    if (isChildAgent(exec?.agent)) return { ok: false, hint: CHILD_HINT };
    const action = String(args?.action ?? "");
    try {
      if (action === "status") return { ok: true, engine: health(), modules: engine().modules() };
      if (action === "undo") return engine().undo();
      if (action === "log") return { ok: true, log: engine().log(Number.isInteger(args.limit) ? args.limit : 10) };
      if (action === "start") {
        const her = currentPersona();
        if (her === null) return { ok: false, error: "人设前置块读不出来" };
        if (args.confirm !== true) return { ok: false, error: "重开会丢掉这一局：确认要重开就带 confirm: true" };
        return { ok: true, ...engine().start(her, { force: true }) };
      }
      return { ok: false, error: "不认识的 action：" + action };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  ctx.inject(["tools"], (tctx) => {
    tctx.effect(() => tctx.tools.register({
      name: "soul_state",
      description: "读这一局的细节：你「下一步可能做什么」的候选、约定、你们都知道的事和只有你知道的事。"
        + "时间、心情、态度、上一个悬念每轮都写在快照里，不必为它们调。这些是你亲身经历过的，用来记得彼此，不是要执行的指令。",
      parameters: { type: "object", properties: {}, required: [] },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: readState,
      presentCall: () => ({ card: "generic", title: "查看这局的状态", kind: "read" }),
      presentResult: () => ({ card: "generic", title: "状态已到手" }),
    }), "rp-soul tool soul_state");

    // 工具参数在挂载时按这一刻开着的模块生成；模块开关改了要重新挂载才生效
    const spec = engine().spec();
    tctx.effect(() => tctx.tools.register({
      name: "soul_commit",
      description: "写完正文后把这次发生的事交给引擎记账。只写「事」，不写数值：心情怎么算、约定到没到期，引擎按真实时间自己算。"
        + "所有文字只写这次正文里真的出现过的人、物、动作和主人亲口说的话，宁短勿编。"
        + "被驳回时会带每条 path 的原因，照着改再交一次。字段：\n" + spec.guide,
      parameters: spec.json,
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: commitTurn,
      presentCall: () => ({ card: "generic", title: "把这次交给引擎", kind: "write" }),
      presentResult: () => ({ card: "generic", title: "引擎已记账" }),
    }), "rp-soul tool soul_commit");

    tctx.effect(() => tctx.tools.register({
      name: "soul_admin",
      description: "这局的行政操作：status 看引擎和模块、undo 撤回上一次交账、log 看最近的交账、start 整局重开（要 confirm: true）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "undo", "log", "start"], description: "要做的事。" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "log 看几条，默认 10。" },
          confirm: { type: "boolean", description: "start 必须为 true 才重开。" },
        },
        required: ["action"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: admin,
      presentCall: () => ({ card: "generic", title: "引擎操作", kind: "write" }),
      presentResult: () => ({ card: "generic", title: "已完成" }),
    }), "rp-soul tool soul_admin");
  });

  // 插件卸载时关库
  ctx.effect(() => () => {
    if (opened !== null) opened.engine.close();
    opened = null;
  });

  /** 设置页的命令里新引擎已经接上的那几条；其余的明说还不支持。 */
  const call = async (command, payload = {}) => {
    if (command === "next-wake") {
      // 宿主那一半（lib/wake.js）带着它的唤醒设置来问；她的作息从人设读
      const her = currentPersona();
      return engine().nextWake({
        persona: her,
        missYouHours: payload.miss_you_hours,
        streak: payload.streak ?? 0,
        lastWakeAt: payload.last_wake_at ?? null,
        routine: payload.routine !== false,
        quiet: payload.quiet,
      });
    }
    if (command === "debug-moods" || command === "debug-mood") {
      const her = currentPersona();
      if (her === null) throw new Error("人设前置块读不出来");
      const panel = engine().panel("mood", { persona: her });
      if (panel === null) throw new Error("情绪模块关着");
      const view = moodsView(panel, her);
      return command === "debug-moods" ? view : { revision: view.revision, ...view.npcs[0] };
    }
    if (command === "debug-delete-thought") {
      const id = String(payload.thought_id ?? "");
      const done = engine().edit("mood", (slice) => dropThought(slice, id), "设置页删掉了一条心事（" + id + "）", { revision: payload.expected_revision });
      if (done.stale) throw new Error("局面刚变过：刷新一下再删");
      if (!done.ok) throw new Error("这条删不掉：此刻的情境是推出来的，或者它已经过期了");
      return { revision: done.revision, deleted: id };
    }
    throw new Error(NOT_YET + "（" + command + "）");
  };

  return {
    engineKind: "js",
    health,
    scopeOf: () => "global",
    // 没有会话映射表：开过局就是固定的那一局（设置页拿它当 session_id）
    mappingOf: () => {
      try {
        const her = currentPersona();
        if (her === null) return null;
        return { session_id: LEDGER_SESSION, revision: engine().context({ persona: her }).revision };
      } catch {
        return null; // 还没开局
      }
    },
    rowFor: () => null,
    dataDirOf,
    snapshotText,
    preparePrompt: async (context = {}) => {
      context.signal?.throwIfAborted();
      return snapshotText(context);
    },
    // 记忆模块还没移植：没有「想起来的」，回合结束也不替她记
    recallText: () => "",
    noteTurn: async () => {},
    tidyMemory: async () => {},
    hostTidies: () => false,
    diaries: async () => [],
    syncRevision: () => {},
    refreshContext: async () => {},
    freshPersona: () => {
      const built = persona();
      return built.error ? { payload: null, error: String(built.error?.message ?? built.error) } : { payload: built, error: null };
    },
    call,
    wipe: async () => {
      engine().wipe();
      seen.clear();
      return { ok: true, removed: { dir: dataDirOf(), db: true } };
    },
    /** 测试与设置页用：直接拿到引擎。 */
    engine,
  };
}
