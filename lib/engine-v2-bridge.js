/**
 * engine-v2-bridge —— 把新引擎（lib/engine，进程内 JS + SQLite）接进 DSH。
 *
 * 对 index.js / wake.js 露出和旧桥接（engine-bridge.js）同样的一组方法，配置里
 * engine: "js" 时用这一份。还没移植的部分（设置页上的事实页签）
 * 在这里是空操作或明说「还不支持」，等各自那一阶段接上。
 *
 * 和旧桥接的差别：
 * - 没有子进程、没有会话映射表：全局只有一局（作用域永远是 global）；
 * - 读局面是同步的，快照不用缓存，装配时现读；
 * - 交账表（工具参数）由引擎按开着的模块生成，不再手写。
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createEngine } from "./engine/index.js";
import { dropThought } from "./engine/modules/mood/index.js";
import { settingsCommands } from "./engine-v2-settings.js";
import { mountMemoryHost, isFirstTurn, DIARY_FILE, DIARY_NUMBERED } from "./engine-v2-memory.js";
import { dayTitle } from "./engine/modules/memory/layers.js";
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
  /** 模块开关：rp-soul/config.json 的 modules: { memory: false, … }，没写的默认开。 */
  const togglesOf = () => {
    const modules = (env.store() ?? {}).modules;
    return modules !== null && typeof modules === "object" && !Array.isArray(modules) ? modules : {};
  };
  // 数据目录可以在设置页里改：换了目录就关掉旧库、开新库
  let opened = null;
  const engine = () => {
    const dataDir = dataDirOf();
    if (opened !== null && opened.dataDir === dataDir) return opened.engine;
    if (opened !== null) opened.engine.close();
    opened = { dataDir, engine: createEngine({ dataDir, toggles: togglesOf() }) };
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

  /** 导出写成 <数据目录>/exports/rp-soul-<时刻>.json，返回文件路径。 */
  const exportTo = (data) => {
    const dir = join(dataDirOf(), "exports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rp-soul-" + data.exported_at.replace(/[:+]/g, "-").slice(0, 19) + ".json");
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return file;
  };

  /**
   * 导入旧引擎的存档：数据目录下的 engine.db（只读，不删），日记文件按日历日搬到 journal/main。
   * 返回逐项核对（心情与心事、态度、事实与谁知道、未结束的约定、安排）。
   */
  const importOld = async () => {
    const file = join(dataDirOf(), "engine.db");
    if (!existsSync(file)) return { ok: false, error: "数据目录下没有旧的 engine.db：" + file };
    const out = engine().importV1(file, { persona: currentPersona() });
    if (!out.ok) return { ok: false, error: out.reason };
    seen.clear();
    memoryHost.forget();
    let diaries = 0;
    // 旧引擎的日记本来就在 rp-soul/memory/ 下（diary-0002.md …），
    // 和新引擎的 journalDir() 是同一处，先从那儿找；找不到再退回旧的 journal/<sessionId>/
    const fromMemory = memoryHost.journalDir();
    const fromJournal = join(dataDirOf(), "journal", out.sessionId);
    for (const [day, key] of Object.entries(out.diaryDays)) {
      const numbered = "diary-" + String(day).padStart(4, "0") + ".md";
      const old = [join(fromMemory, numbered), join(fromJournal, numbered)].find((p) => existsSync(p));
      if (old === undefined) continue;
      // 旧日记的标题是「# 第 12 天 · 周二」：换成日历日的标题，正文原样
      const body = readFileSync(old, "utf8").replace(/\r\n/g, "\n").split("\n");
      const text = (body[0].startsWith("# ") ? body.slice(1) : body).join("\n").trim();
      mkdirSync(fromMemory, { recursive: true });
      writeFileSync(join(fromMemory, "diary-" + key + ".md"), "# " + dayTitle(key) + "\n\n" + text + "\n", "utf8");
      diaries += 1;
    }
    registerCommit();
    return { ok: true, from: file, check: out.check, all_match: out.check.every((r) => r.ok), notes: out.notes, diaries };
  };

  const admin = async (args, exec) => {
    if (isChildAgent(exec?.agent)) return { ok: false, hint: CHILD_HINT };
    const action = String(args?.action ?? "");
    try {
      if (action === "status") return { ok: true, engine: health(), modules: engine().modules() };
      if (action === "undo") return engine().undo();
      // 流水里存着每次交了什么（input），给设置页看的；这里只要摘要
      if (action === "log") return { ok: true, log: engine().log(Number.isInteger(args.limit) ? args.limit : 10).map(({ input, ...entry }) => entry) };
      const name = typeof args.name === "string" ? args.name.trim().slice(0, 40) : "";
      if (action === "save") return name === "" ? { ok: false, error: "save 要带 name" } : engine().save(name, { overwrite: args.overwrite === true });
      if (action === "list") return { ok: true, slots: engine().slots() };
      if (action === "load") return name === "" ? { ok: false, error: "load 要带 name（先用 list 看有哪些）" } : engine().load(name);
      if (action === "delete") {
        if (name === "") return { ok: false, error: "delete 要带 name" };
        if (args.confirm !== true) return { ok: false, error: "删掉存档找不回来：确认要删就带 confirm: true" };
        return engine().dropSlot(name);
      }
      if (action === "export") return { ok: true, file: exportTo(engine().exportAll()) };
      if (action === "pause" || action === "resume") return engine().setPaused(action === "pause");
      if (action === "import") {
        if (args.confirm !== true) return { ok: false, error: "导入旧存档会换掉现在这一局（先存成「导入前」存档，读档能回来）：确认就带 confirm: true" };
        return await importOld();
      }
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

  /** 重挂 soul_commit（工具宿主就绪后才有）。 */
  let registerCommit = () => {};

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

    // 工具参数按这一刻开着的模块生成：设置页改了模块开关就摘下来、按新的交账表重挂
    let dropCommit = null;
    registerCommit = () => {
      if (dropCommit !== null) void dropCommit();
      const spec = engine().spec();
      dropCommit = tctx.effect(() => tctx.tools.register({
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
    };
    registerCommit();

    tctx.effect(() => tctx.tools.register({
      name: "soul_admin",
      description: "这局的行政操作：status 看引擎和模块、undo 撤回上一次交账（读档也能撤）、log 看最近的交账、"
        + "save / list / load / delete 命名存档、export 把这一局导出成文件、pause / resume 安全暂停（主人说停下时用）、"
        + "import 导入旧引擎的存档（主人要求时才用，要 confirm: true）、start 整局重开（要 confirm: true）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "undo", "log", "save", "list", "load", "delete", "export", "pause", "resume", "import", "start"], description: "要做的事。" },
          name: { type: "string", description: "save / load / delete 的存档名。" },
          overwrite: { type: "boolean", description: "save 时覆盖同名存档。" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "log 看几条，默认 10。" },
          confirm: { type: "boolean", description: "start、delete、import 必须为 true。" },
        },
        required: ["action"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: admin,
      presentCall: () => ({ card: "generic", title: "引擎操作", kind: "write" }),
      presentResult: () => ({ card: "generic", title: "已完成" }),
    }), "rp-soul tool soul_admin");
  });

  // 记忆的宿主那一半：回合结束替她记、起子代理整理、日记文件（lib/engine-v2-memory.js）
  const memoryHost = mountMemoryHost({
    ctx,
    engine,
    persona: currentPersona,
    isChildAgent,
    cueOf,
    dataDirOf,
    aloneOf,
    batchMinutes: () => (Number.isFinite(cfg.noteBatchMinutes) && cfg.noteBatchMinutes > 0 ? cfg.noteBatchMinutes : undefined),
    // 写完日记，唤醒表里「该写日记了」那条就作废了：重排一次，免得她过一会儿又醒来写同一篇
    onWrote: () => { void env.wake?.current?.reschedule?.()?.catch?.(() => {}); },
  });

  // 插件卸载时关库
  ctx.effect(() => () => {
    memoryHost.forget();
    if (opened !== null) opened.engine.close();
    opened = null;
  });

  // 常识库、自主行动记录、人设校验（lib/engine-v2-settings.js）
  const commands = settingsCommands({ engine, persona: currentPersona });

  /** 设置页的命令里新引擎已经接上的那几条；其余的明说还不支持。 */
  const call = async (command, payload = {}) => {
    if (Object.hasOwn(commands, command)) return commands[command](payload);
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
    /** 模块清单与开关（设置页「引擎」卡那一排）。 */
    modules: () => engine().modules(),
    /** 改开关：引擎立刻按新的算，交账表重挂。调用方负责把 toggles 写进 config.json。 */
    setModules: (toggles) => {
      const list = engine().setToggles(toggles);
      registerCommit();
      return list;
    },
    dataDirOf,
    snapshotText,
    preparePrompt: async (context = {}) => {
      context.signal?.throwIfAborted();
      return snapshotText(context);
    },
    // 「想起来的」：被你这句话勾起的记忆、命中的常识，新会话第一轮再带上最近一篇日记
    recallText: (context = {}) => {
      if (!enabled() || isChildAgent(context?.agent)) return "";
      try {
        return engine().recall(cueOf(context), { firstTurn: isFirstTurn(context) });
      } catch {
        return ""; // 引擎没就绪：不注入，不挡对话
      }
    },
    noteTurn: async (context) => {
      if (!enabled() || !ensure().ok) return null;
      return memoryHost.noteTurn(context);
    },
    tidyMemory: async (context) => {
      if (enabled()) await memoryHost.tidyMemory(context);
    },
    /** 设置页「立即汇总 / 立即写日记」。 */
    tidyNow: (kind) => memoryHost.tidyNow(kind === "diary" ? "diary" : "fold"),
    hostTidies: () => false,
    diaries: async () => memoryHost.diaries(),
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
      memoryHost.forget();
      // 日记是文件：一起删掉（清空说的是「会话、心情、记忆、常识、存档、日记」）。
      // rp-soul/memory/ 里只放日记，但只删 diary-*.md，别的文件留着。
      const dir = memoryHost.journalDir();
      let removedDiaries = 0;
      for (const name of await readdir(dir).catch(() => [])) {
        if (DIARY_FILE.exec(name) === null && DIARY_NUMBERED.exec(name) === null) continue;
        await rm(join(dir, name), { force: true });
        removedDiaries += 1;
      }
      return { ok: true, removed: { dir: dataDirOf(), db: true, diaries: removedDiaries } };
    },
    /** 测试与设置页用：直接拿到引擎。 */
    engine,
  };
}
