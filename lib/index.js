/**
 * soul-persona —— 从一份预设文件读取人设，注入成一段系统提示。
 *
 * 每次组装系统提示时读取文件，因此修改后无需重启，下一条请求即生效。
 *
 * 实现要点：
 * - 使用自定义 section 名 soul-persona（order 与全局 persona 前缀相同），
 *   不与 dsh-system-prompt 自己的 deployment:persona-prefix 冲突，
 *   因此可以在全局（profile 层）挂载。
 * - text 是 provider 函数：缺文件 / 空文件 / 超限时返回空串，
 *   空 section 在渲染时会被丢弃，不影响其它提示片段。
 * - section 声明 interpolate: false，persona 文本按字面渲染，不会被当成 {{变量}} 插值。
 * - 人设只有一份：$DSH_HOME/rp-soul/preset.md，靠 `<!-- soul-part: 名字 -->` 分块，
 *   勾掉的块留在文件里但不注入。多文件拼接那套已经删掉了。
 * - 设置页改的是本插件自己的存储文件（默认 $DSH_HOME/rp-soul/config.json），
 *   不走 cordis.yml —— 那份配置需要热替换才生效，改完立刻生效是这个插件的卖点。
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep, dirname, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { buildPersona, parseYaml, splitFrontMatter, stringifyYaml } from "./persona-pack.js";
import { EngineClient, EngineError, enginePresent, probePython } from "./engine-client.js";
import { mountEngine } from "./engine-bridge.js";
import { mountWake, readWakeConfig, wakeConfigPatch } from "./wake.js";
import { composeBlocks, fromRimTalk, parsePreset, renderPreset, toRimTalk } from "./preset-file.js";

export const name = "soul-persona";

export const inject = ["systemPrompt"];

export const Config = z.object({
  separator: z.string().default("\n\n"),
  maxBytes: z.number().min(1024).max(1048576).default(65536),
  storeFile: z.string().default("rp-soul/config.json"),
  engineEnabled: z.boolean().default(true),
  engineScope: z.union([z.const("global"), z.const("session")]).default("global"),
  engineDataDir: z.string().default(""),
  engineTimeoutMs: z.number().min(1000).max(120000).default(30000),
  engineSessions: z.string().default("rp-soul/engine-sessions.json"),
  title: z.string().default(""),
  personaId: z.string().default(""),
});

const ROUTE_PREFIX = "/rp-soul";
/**
 * 回合结束时写 ABM 与判「该收了」的上限。
 * turn-stopping 是 serial 的，等太久回合关不上；这两件事失败都只是少记一次。
 */
const NOTE_TIMEOUT_MS = 2500;
const BODY_LIMIT = 1048576;
/**
 * 引擎人设（结构化字段）单独一个文件，不再从散文里第一个前置块抠。
 * 这样可以拿表单整份重写它，而散文只负责人设提示词、保持人写人读的样子。
 */
const ENGINE_PERSONA_REL = "rp-soul/persona.md";
/**
 * 人设预设：一份 markdown，靠 `<!-- soul-part: 名字 -->` 切块。
 * 有这个文件就只认它，不再拼接 config 里的一串 files —— 多文件那种排法
 * 改一句话要翻好几个文件，还没法整份给人。见 lib/preset-file.js。
 */
const PRESET_REL = "rp-soul/preset.md";
/** 预设目录：导入时在这里找能吃的文件。 */
const PRESET_DIR = "rp-soul/presets";
/** 原子写临时文件的自增后缀，保证同一进程内并发写不抢同一个名字。 */
let tmpSeq = 0;

export function apply(ctx, config) {
  const cfg = config ?? {};
  const root = safeRoot();
  const storePath = join(root, cfg.storeFile ?? "rp-soul/config.json");
  const effective = () => effectiveFrom(cfg, readStore(storePath));

  /**
   * 当前生效的人设包（散文 + 引擎结构化字段），供引擎与设置页共用。
   *
   * 结构化字段只认 rp-soul/persona.md；散文文件里的前置块一律剥掉、不参与解析
   * （散文是给人读的，里面出现 `---` 只当分隔线，不该被当成配置）。
   * persona.md 不存在时退回老行为：从第一个带前置块的散文文件里取。
   */
  const persona = () => {
    const eff = effective();
    // 预设文件优先：它就是人设，块名与启用状态都在里面写着。
    const preset = readPreset(root);
    const parts = [];
    const text = composeBlocks(preset.blocks, eff.separator);
    if (text.trim() !== "") parts.push({ rel: PRESET_REL, text });
    const enginePersona = readEnginePersona(root, eff);
    return buildPersona({
      parts,
      separator: eff.separator,
      maxBytes: eff.maxBytes,
      title: eff.title,
      personaId: eff.personaId,
      front: enginePersona.value,
      frontRel: enginePersona.rel,
      // persona.md 解析失败时 value 是空字典；错误必须一起传下去，
      // 否则人设会静默退化成空白，谁也不知道为什么。
      frontError: enginePersona.error,
    });
  };

  const store = () => readStore(storePath);
  // 唤醒线要先看到「这一局有没有开局」，桥接层先建；唤醒线自己的引用反过来交给
  // 桥接层：soul_commit 得知道这一次是不是她的「我的时间」，从而自动带 together: false。
  const wakeRef = { current: null };
  const bridge = mountEngine(ctx, { root, storePath, cfg, effective, persona, store, wake: wakeRef });
  const wake = mountWake(ctx, { root, store, bridge, log: (line) => { try { ctx.logger?.warn?.(line); } catch { /* 没有 logger 就算了 */ } } });
  wakeRef.current = wake;
  // 唤醒线自己判断宿主支不支持：没有 sessionController（命令行）就整条不启用，
  // 设置页那边照样能读配置、能看状态，只是 mounted 为 false。
  wake.start();

  // 位置：系统提示的最末尾。上下文缓存按前缀命中，而账本快照几乎每次都在变
  // （时间、心情、想法），排在开头会让它后面的一切——工具定义、交付物约定、
  // 结构化输出——每次跟着失效。排在末尾，变的那一段后面没有东西可被带坏。
  // 人设排在账本前面：它稳，账本才是每次动的那一小段。
  const bottomOrder = () => {
    const prefix = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX");
    const suffix = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX");
    const base = Number.isFinite(prefix) ? prefix : 0;
    // 宿主给了 persona-suffix 就用它当锚（它本来就是最后一段）；
    // 拿不到或比 prefix 还靠前，就退回「prefix + 10200」，与宿主的表一致。
    if (Number.isFinite(suffix) && suffix > base) return suffix;
    return base + 10200;
  };

  ctx.effect(() => ctx.systemPrompt.section({
    name: "soul-persona",
    order: bottomOrder() + 1,
    // 人设是自然语言，按字面渲染：关掉 {{变量}} 插值，
    // 免得角色设定里出现 {{...}} 时被 renderPrompt 当成严格模板变量而抛错。
    interpolate: false,
    text: () => {
      try {
        const eff = effective();
        return eff.enabled ? composeText(root, eff) : "";
      } catch {
        return "";
      }
    },
  }), "soul-persona.section()");

  // 账本快照走「有序动态 runtime context」，不进系统提示词。
  //
  // 为什么不再放 section：上下文缓存按**整段前缀的字节哈希**命中，系统提示词里
  // 只要有一个字节每次在变，整段前缀就作废——把它挪到最后只是让后面没东西
  // 跟着失效，它自己仍在前缀里，仍然每次重刷几十 K token。
  //
  // 动态 context 由宿主渲染成一条 user 角色的快照消息、追加在对话尾部；宿主只在
  // 文本真的变了时才追加（dsh-agent-loop 的 RuntimeContextProjection），所以系统
  // 提示词从此恒定，前缀能一路命中，每次新增的只有尾部那几十字节。
  //
  // 顺序落在动态上下文的末尾（宿主的 WEB_SURFACE=210 之后），保证它就是最后一段。
  const bottomContextOrder = () => {
    const web = typeof ctx.systemPrompt.getContextOrder === "function"
      ? ctx.systemPrompt.getContextOrder("WEB_SURFACE")
      : undefined;
    return (Number.isFinite(web) ? web : 210) + 10;
  };

  const engineText = (context) => {
    try {
      return bridge.snapshotText(context);
    } catch {
      return "";
    }
  };
  // 「她想起来的」单独一段：跟着你这句话变，和局面放一起会让局面那段每轮都不同。
  const recallText = (context) => {
    try {
      return bridge.recallText(context);
    } catch {
      return "";
    }
  };

  // 宿主没有 `context()`（旧版 DSH）时退回原来的 section 方案，至少功能不丢。
  if (typeof ctx.systemPrompt.context === "function") {
    ctx.effect(() => ctx.systemPrompt.context({
      name: "soul-engine",
      order: bottomContextOrder(),
      interpolate: false,
      text: engineText,
    }), "soul-engine.context()");
    ctx.effect(() => ctx.systemPrompt.context({
      name: "soul-recall",
      order: bottomContextOrder() + 1,
      interpolate: false,
      text: recallText,
    }), "soul-recall.context()");
  } else {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "soul-engine",
      order: bottomOrder() + 2,
      interpolate: false,
      text: engineText,
    }), "soul-engine.section()");
    ctx.effect(() => ctx.systemPrompt.section({
      name: "soul-recall",
      order: bottomOrder() + 3,
      interpolate: false,
      text: recallText,
    }), "soul-recall.section()");
  }

  // 装配钩子：先让侧车把账本读进缓存（异步），再在装配结果里把这一段刷新成最新文本。
  //
  // 注意只能改**动态 context**那一条——宿主在 `assemble()` 里同步求值 context，
  // 等 waterfall 跑到这里时，条目里已经是上一次读到的旧快照，必须就地替换。
  // 系统提示词的 section 一概不碰：碰了前缀哈希就变，缓存全废。
  //
  // 时序：preparePrompt 必须排在 next() **之后**。宿主装配时本来就会同步求值一次
  // context（拿到的是上一次的缓存），所以先 next() 让装配走完，再异步刷新并覆盖文本，
  // 既不拖慢装配，也不会因为引擎卡住（30s 超时）阻塞每一次 LLM 请求。
  if (typeof ctx.on === "function") {
    ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
      const result = await next();
      // 取消了的装配就不必再读账本：既省一次往返，也让取消如实向上冒泡。
      if (context?.signal?.aborted === true) {
        throw context.signal.reason ?? new Error("已取消");
      }
      const row = Array.isArray(result.contexts)
        ? result.contexts.find((item) => item?.name === "soul-engine")
        : undefined;
      if (row === undefined) {
        // 旧宿主（没有 context()）退回 section 方案时，才需要改 section 文本。
        const section = Array.isArray(result.sections)
          ? result.sections.find((item) => item?.name === "soul-engine")
          : undefined;
        if (section === undefined) return result;
        try {
          section.text = await bridge.preparePrompt(context);
          const recall = result.sections.find((item) => item?.name === "soul-recall");
          if (recall !== undefined) recall.text = recallText(context);
        } catch (error) {
          // 刷新失败就保留装配时的旧快照，绝不让一次读账本失败拖垮整轮对话；
          // 但取消必须原样抛出，那是调用方的意图，不是故障。
          if (context?.signal?.aborted === true) throw error;
        }
        return result;
      }
      try {
        row.text = await bridge.preparePrompt(context);
        // preparePrompt 刚把账本读进缓存，「想起来的」也按这一次的你这句话刷新
        const recall = result.contexts.find((item) => item?.name === "soul-recall");
        if (recall !== undefined) recall.text = recallText(context);
      } catch (error) {
        if (context?.signal?.aborted === true) throw error;
      }
      return result;
    });

    // 回合结束时自己记一笔，不等模型交账。
    //
    // RimTalk 的做法：记忆来自被拦下的那次互动，而不是模型恰好愿意写。模型
    // 忘了调 soul_commit（很常见，尤其在它只顾着写正文的时候）这一轮就彻底
    // 没了；挂在这里，说了什么、回了什么，账本一定收得到。
    // turn-stopping 是 serial 的，等这一趟写完再让回合关掉；失败不外抛，
    // 记账失败绝不能把一轮已经写好的对话判成出错。
    ctx.on("agent/turn-stopping", async (payload) => {
      const context = { agent: payload?.agent ?? null };
      // turn-stopping 是 serial 的：这里每多等一秒，回合就多一秒关不上。
      // 引擎卡住时宁可这一轮不记，也不能陪着它等满默认的三十秒。
      // 不传 signal：那个 signal 在回合被取消时会 abort，跟着它一起放弃
      // 就等于把这一轮的对话彻底丢掉。
      const hurry = { timeoutMs: NOTE_TIMEOUT_MS };
      try {
        await bridge.noteTurn(context, hurry);
      } catch {
        // 静默：这条记录是附带品
      }
      // ABM 攒够了就交给子代理收成一条，欠着日记就让子代理写。这一步自己判、
      // 自己起、自己收，不占着 turn-stopping（那会让人等到回合关不上），也不等
      // 模型交账。子代理那次要走完整一轮模型，绝不能挂在回合上；也绝不能让它
      // 的异常变成 unhandledRejection 把宿主带走。收不上就攒着，下一轮再看。
      void bridge.tidyMemory(context, hurry).catch(() => {});
    });
  }

  // 设置页接口只在 web 侧有意义：CLI/TUI 组合里没有 webServer，人设照常生效即可。
  // connection 服务用于信任栅栏（防跨站请求打本地接口），缺它就干脆不开路由，
  // 免得暴露一组无鉴权的读写文件接口。
  ctx.inject(["webServer", "connection"], (wctx) => {
    wctx.effect(() => wctx.webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler: (req, res) => handleRoute(wctx, req, res, { root, storePath, cfg, effective, persona, bridge, wake }),
    }), "soul-persona route");
  });
}

// ---------------------------------------------------------------------------
// 配置与合成
// ---------------------------------------------------------------------------

/** $DSH_HOME 的绝对路径；解析失败时退回 cwd，保证插件仍能加载。 */
function safeRoot() {
  try {
    return resolve(resolveDshHome());
  } catch {
    return resolve(process.cwd());
  }
}

/** 整数夹逼；非数字回落 fallback。 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 读存储文件；缺失或损坏都返回 null（视作还没配置过）。 */
function readStore(storePath) {
  try {
    const raw = readFileSync(storePath, "utf8");
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** 原子写 JSON（先写 .tmp 再 rename），避免保存到一半崩溃留下半截文件。 */
function writeStore(storePath, obj) {
  writeAtomic(storePath, JSON.stringify(obj, null, 2) + "\n");
}
/**
 * 是不是一个合法的相对路径字符串。
 * 顺带拒掉 U+FFFD（�）：那是「字节流不是合法 UTF-8」被解码后的产物。
 * 遇到它说明调用方送来的编码不对（典型：客户端用 GBK 发中文名），
 * 放进去就会在磁盘上建出一个乱码文件名 —— 宁可 400 让人改，也不留垃圾。
 */
function isRelString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (trimmed.includes("�")) return false;
  return true;
}

/**
 * 把 cordis 种子配置与存储文件合并成一份完整生效配置。
 * @returns {{separator: string, maxBytes: number, enabled: boolean, source: string}}
 */
function effectiveFrom(cfg, store) {
  const base = {
    separator: typeof cfg.separator === "string" ? cfg.separator : "\n\n",
    maxBytes: clampInt(cfg.maxBytes, 1024, 1048576, 65536),
    enabled: true,
    engineScope: cfg.engineScope === "session" ? "session" : "global",
    title: typeof cfg.title === "string" && cfg.title.trim() !== "" ? cfg.title.trim() : null,
    personaId: typeof cfg.personaId === "string" && cfg.personaId.trim() !== "" ? cfg.personaId.trim() : null,
  };
  if (store === null) return { ...base, source: "config" };
  return {
    separator: typeof store.separator === "string" ? store.separator : base.separator,
    maxBytes: clampInt(store.maxBytes, 1024, 1048576, base.maxBytes),
    enabled: typeof store.enabled === "boolean" ? store.enabled : true,
    engineScope: store.engineScope === "session" ? "session" : store.engineScope === "global" ? "global" : base.engineScope,
    title: typeof store.title === "string" && store.title.trim() !== "" ? store.title.trim() : base.title,
    personaId: typeof store.personaId === "string" && store.personaId.trim() !== "" ? store.personaId.trim() : base.personaId,
    source: "store",
  };
}

/**
 * 把 rel 解析成 root 下的绝对路径；任何越界（.. / 绝对路径 / 盘符）都返回 undefined。
 */
function withinRoot(root, rel) {
  if (!isRelString(rel)) return undefined;
  const cleaned = rel.split(String.fromCharCode(92)).join("/").replace(/^\/+/, "").trim();
  if (cleaned === "") return undefined;
  if (cleaned.split("/").some((part) => part === "..")) return undefined;
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return undefined;
  return abs;
}

/** 读单个文件；缺失 / 空 / 非文件都返回空串，超限的部分按字节裁掉。 */
function readOne(abs, maxBytes) {
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size === 0) return "";
    let text = readFileSync(abs, "utf8");
    // maxBytes 是字节预算，判断就得按字节：中文一字符三字节，按 .length 算会超三倍。
    if (Buffer.byteLength(text, "utf8") > maxBytes) text = sliceByBytes(text, maxBytes);
    return text;
  } catch {
    return "";
  }
}

/**
 * 读引擎人设文件（rp-soul/persona.md），解析成结构化字段。
 *
 * 文件不存在 → 返回 value:null，调用方退回「散文里第一个前置块」的老行为。
 * 文件存在但解析失败 → value:{} 且 error 带上原因：宁可让人设校验报错，
 * 也不要悄悄拿半份配置去开局。
 * @returns {{rel: string, exists: boolean, text: string, value: object|null, error: string|null}}
 */
function readEnginePersona(root, eff) {
  const rel = ENGINE_PERSONA_REL;
  const abs = withinRoot(root, rel);
  const empty = { rel, exists: false, text: "", value: null, error: null };
  if (abs === undefined || !existsSync(abs)) return empty;
  const text = readOne(abs, eff.maxBytes);
  if (text.trim() === "") return { rel, exists: true, text, value: {}, error: null };
  try {
    const split = splitFrontMatter(text);
    // 允许整个文件就是纯 YAML（不带 --- 包裹），表单写出来的就是这种。
    const raw = split.front !== null ? split.front : text;
    const parsed = parseYaml(raw);
    if (parsed === null) return { rel, exists: true, text, value: {}, error: null };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { rel, exists: true, text, value: {}, error: "顶层必须是映射（key: value）" };
    }
    return { rel, exists: true, text, value: parsed, error: null };
  } catch (error) {
    return {
      rel,
      exists: true,
      text,
      value: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 把结构化字段写回引擎人设文件。写之前必须过一遍 parseYaml，写出去读不回来就是灾难。 */
function writeEnginePersona(root, value) {
  const abs = withinRoot(root, ENGINE_PERSONA_REL);
  if (abs === undefined) throw new Error("路径不合法：" + ENGINE_PERSONA_REL);
  const text = stringifyYaml(value ?? {}) + "\n";
  const check = parseYaml(text);
  if (check === null || typeof check !== "object" || Array.isArray(check)) {
    throw new Error("人设序列化失败：写出去的内容读不回来");
  }
  writeAtomic(abs, text);
  return { rel: ENGINE_PERSONA_REL, text, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * 把散文（人设提示词）里的前置块剥掉。
 * 结构化字段已经搬去 persona.md，散文里的 `---` 只剩装饰作用，
 * 原样注入提示词只会浪费 token 还容易被模型当成指令。
 */
function stripFrontMatter(text) {
  try {
    const split = splitFrontMatter(text);
    return split.front === null ? text : split.body;
  } catch {
    return text;
  }
}

/**
 * 按 UTF-8 字节数截断，绝不把多字节字符劈成半个（原来用 slice 会切出乱码）。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceByBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * 按配置顺序把多个文件拼成最终人设文本。
 * @returns 拼接后的文本（原样保留，section 已声明 interpolate: false）；无可用内容时返回空串。
 */
function composeText(root, eff) {
  return composePreset(root, eff) ?? "";
}

/**
 * 读人设预设文件。
 *
 * @returns {{rel: string, exists: boolean, text: string, marked: boolean,
 *   blocks: {name: string, enabled: boolean, text: string}[]}}
 */
function readPreset(root) {
  const abs = withinRoot(root, PRESET_REL);
  const empty = { rel: PRESET_REL, exists: false, text: "", marked: false, blocks: [] };
  if (abs === undefined || !existsSync(abs)) return empty;
  let text = "";
  try {
    if (statSync(abs).size > 0) text = readFileSync(abs, "utf8");
  } catch {
    return empty;
  }
  const parsed = parsePreset(text);
  return { rel: PRESET_REL, exists: true, text, marked: parsed.marked, blocks: parsed.blocks };
}

/**
 * 列出可以导入的文件：预设目录下的所有 md/json/txt，外加根目录的 SOUL.md。
 *
 * 用户不一定记得自己把预设放哪了，让他从列表里点比从文件对话框里翻快得多
 * （浏览器那边还有个隐患：文件框在某些宿主里根本不弹）。只列一层，
 * 以及最近改过的排前面。
 *
 * @returns {{rel: string, bytes: number, at: number, kind: string}[]}
 */
function listImports(root) {
  const out = [];
  const seen = new Set();
  const add = (rel, abs) => {
    if (seen.has(rel)) return;
    let stat = null;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size === 0) return;
    const ext = extname(abs).toLowerCase();
    const kind = ext === ".json" ? "rimtalk" : ext === ".md" || ext === ".txt" ? "markdown" : "";
    if (kind === "") return;
    seen.add(rel);
    out.push({ rel, bytes: stat.size, at: Math.round(stat.mtimeMs), kind });
  };
  // 根目录的 SOUL.md：老用户的存量就放在这儿，最该被一眼看到
  add("SOUL.md", join(root, "SOUL.md"));
  let names = [];
  try {
    names = readdirSync(join(root, PRESET_DIR));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    add(PRESET_DIR + "/" + name, join(root, PRESET_DIR, name));
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 有预设就按预设拼，没有返回 null 让调用方退回多文件老路。 */
function composePreset(root, eff) {
  const preset = readPreset(root);
  if (!preset.exists || preset.blocks.length === 0) return null;
  // 块里可能带着老文件留下的前置块（--- ... ---），它只给引擎的表单看，
  // 原样注入等于把配置念给模型听，还容易被当成指令。
  const text = stripFrontMatter(composeBlocks(preset.blocks, eff.separator)).trim();
  if (text === "") return null;
  if (Buffer.byteLength(text, "utf8") <= eff.maxBytes) return text;
  return sliceByBytes(text, eff.maxBytes);
}
// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** 发送 JSON 响应。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 读请求体（文本，带上限）。 */
/**
 * 读请求体并解码为 UTF-8 文本。
 * 超过 BODY_LIMIT 时抛 status=413 的错误而不 destroy 连接 —— destroy 会让浏览器
 * 只看到 net::ERR_CONNECTION_RESET，拿不到任何错误文案。
 */
function readBody(req) {
  return new Promise((resolveOuter, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        overflow = true;
        chunks.length = 0;
        req.resume(); // 排空剩余数据，好让响应还能正常写回去
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        const error = new Error("请求体超过 " + BODY_LIMIT + " 字节");
        error.status = 413;
        reject(error);
        return;
      }
      resolveOuter(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** 读并解析 JSON 请求体。 */
async function readJson(req) {
  const raw = await readBody(req);
  if (raw.trim() === "") return {};
  const obj = JSON.parse(raw);
  return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
}

/**
 * 鉴权栅栏：与 dsh-host-open-in-app / dsh-prompt-setting 一致，
 * 进入任何路由逻辑之前先挡掉不可信请求。缺 connection 服务时拒绝（fail closed）。
 * @returns true 表示已经应答，handler 必须立刻返回。
 */
function rejected(ctx, req, res) {
  const connection = Reflect.get(ctx, "connection");
  if (connection === undefined || connection === null) {
    sendJson(res, 503, {
      code: "trust-fence-unavailable",
      message: "connection 服务不可用，拒绝提供设置接口",
    });
    return true;
  }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
}

/** 原子写文本文件。临时名带自增后缀，同一进程内并发写不会抢同一个文件。 */
function writeAtomic(abs, text) {
  mkdirSync(dirname(abs), { recursive: true });
  tmpSeq += 1;
  const tmp = abs + ".tmp-" + process.pid + "-" + tmpSeq;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, abs);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 已经没了 */
    }
    throw error;
  }
}

/** 组装给设置页的一份快照。 */
function snapshot(root, storePath, cfg) {
  const store = readStore(storePath);
  const eff = effectiveFrom(cfg, store);
  const composed = eff.enabled ? composeText(root, eff) : "";
  const preset = readPreset(root);
  return {
    root,
    storePath,
    config: eff,
    store,
    // 设置页用它判断「走预设还是走多文件」：预设存在就只认预设。
    preset: {
      rel: PRESET_REL,
      exists: preset.exists,
      marked: preset.marked,
      text: preset.text,
      blocks: preset.blocks,
    },
    composed: {
      chars: composed.length,
      bytes: Buffer.byteLength(composed, "utf8"),
      preview: composed.slice(0, 2000),
    },
  };
}

/** 最近一次写入/更新的那条会话映射（设置页不知道 DSH 会话 id，只能看最近活跃的局）。 */
function latestSession(rows) {
  let best = null;
  for (const row of rows) {
    if (row === null || typeof row.row !== "object" || row.row === null) continue;
    const stamp = String(row.row.updated_at ?? row.row.seen_at ?? row.row.created_at ?? "");
    if (best === null || stamp > best.stamp) best = { stamp, key: row.key, row: row.row };
  }
  return best === null ? null : Object.assign({ key: best.key }, best.row);
}

/** 设置页「引擎」卡需要的全部只读信息。 */
function engineSnapshot(env) {
  const { root, cfg, persona, bridge } = env;
  const health = bridge.health();
  const built = persona();
  const map = readStore(join(root, cfg.engineSessions ?? "rp-soul/engine-sessions.json")) ?? {};
  const rows = Object.keys(map).map((key) => ({ key, row: map[key] }));
  // 全局作用域下只有 "shared" 一行；旧的会话行若还在，也一并交给设置页看见。
  const session = bridge.mappingOf("shared") ?? latestSession(rows);
  return {
    health,
    scope: bridge.scopeOf(),
    scopeHint: bridge.scopeOf() === "global"
      ? "全局：所有会话共用一个引擎局，心情与关系是连续的。"
      : "按会话：每个 DSH 会话各自一局。",
    persona: {
      title: built.title,
      personaId: built.personaId,
      bytes: built.bytes,
      front: built.front,
      frontRel: built.frontRel,
      error: built.error,
    },
    personaFile: personaFileInfo(env, built),
    sessionsFile: join(root, cfg.engineSessions ?? "rp-soul/engine-sessions.json"),
    sessions: rows.map((r) => ({ key: r.key, session_id: r.row?.session_id ?? null, turn: r.row?.turn ?? null })),
    session,
  };
}

/**
 * 设置页「唤醒」页签需要的全部信息：配置、状态、可指定的会话。
 *
 * 会话列表来自宿主的 sessionController；没有桌面宿主（CLI/TUI）时列表为空，
 * 页签会显示「还没有会话」，但配置照样能改。
 */
async function wakePage(env) {
  const wake = env.wake ?? null;
  const store = readStore(env.storePath) ?? {};
  const config = readWakeConfig(store);
  const snapshot = wake === null ? null : wake.snapshot();
  const sessions = wake === null ? [] : await wake.listSessions();
  return {
    config,
    state: snapshot === null ? null : snapshot.state,
    mounted: snapshot === null ? false : snapshot.mounted,
    sessions,
    // 唤醒线要的引擎局：全局作用域下一律是 "shared"，会话作用域按会话 id 分开。
    engineSession: env.bridge.mappingOf(env.bridge.scopeOf() === "global" ? "shared" : config.sessionId) ?? null,
  };
}

/**
 * 设置页「引擎人设」表单要读的那份文件（独立维护，不再混在散文里）。
 *
 * 文件还不存在时，把「散文里第一个前置块」当作迁移来源返回（source: "legacy"），
 * 表单于是能拿着老配置直接改，不必让人重新手抄一遍。保存一次就落到 persona.md。
 */
function personaFileInfo(env, built) {
  const eff = env.effective();
  const read = readEnginePersona(env.root, eff);
  const abs = withinRoot(env.root, ENGINE_PERSONA_REL);
  let bytes = 0;
  let mtimeMs = 0;
  if (abs !== undefined) {
    try {
      const stat = statSync(abs);
      bytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      // 文件不存在：保持 0，交给 exists 区分
    }
  }
  const legacy = built !== undefined && built !== null && typeof built.front === "object" && built.front !== null
    ? built.front
    : {};
  const value = read.exists ? (read.value ?? {}) : legacy;
  let preview = "";
  try {
    preview = stringifyYaml(value) + "\n";
  } catch {
    preview = "";
  }
  return {
    rel: ENGINE_PERSONA_REL,
    exists: read.exists,
    bytes,
    mtimeMs,
    front: value,
    source: read.exists ? "file" : (Object.keys(legacy).length > 0 ? "legacy" : "empty"),
    legacyRel: built?.frontRel ?? null,
    preview,
    error: read.error,
  };
}

/** 把文件名收敛成安全的 basename（禁止路径分隔符与 ..）。 */
function safeBaseName(rawName) {
  const noSep = rawName.split("/").join("-").split(String.fromCharCode(92)).join("-");
  const noDots = noSep.split("..").join("");
  const cleaned = noDots.replace(/[<>:"|?*]/g, "").trim();
  if (cleaned === "") return "";
  return extname(cleaned).toLowerCase() === ".md" ? cleaned : cleaned + ".md";
}

/**
 * 路由分发。前缀路由收到的是完整 URL，所以按前缀切掉自己那一段再分发。
 */
async function handleRoute(ctx, req, res, env) {
  const { root, storePath, cfg } = env;
  try {
    if (rejected(ctx, req, res)) return;
    const url = new URL(String(req.url ?? "/"), "http://localhost");
    const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");
    const method = (req.method ?? "GET").toUpperCase();

    if (rest === "state") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const snap = snapshot(root, storePath, cfg);
      if (env.wake !== undefined && env.wake !== null) snap.wake = env.wake.snapshot();
      return sendJson(res, 200, snap);
    }


    if (rest === "preset") {
      const preset = readPreset(root);
      const view = () => ({
        rel: PRESET_REL,
        exists: preset.exists,
        marked: preset.marked,
        text: preset.text,
        blocks: preset.blocks,
        composed: composeBlocks(preset.blocks, env.effective().separator),
      });
      if (method === "GET") {
        const want = url.searchParams.get("export") ?? "";
        if (want === "rimtalk") {
          return sendJson(res, 200, { json: toRimTalk(preset.blocks, env.effective().title ?? "", "") });
        }
        // 能导入的文件：让前端列出来点，比开文件对话框可靠
        if (url.searchParams.has("files")) return sendJson(res, 200, { files: listImports(root) });
        return sendJson(res, 200, view());
      }
      if (method !== "POST" && method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      let blocks = null;
      let raw = typeof body.text === "string" ? body.text : null;
      // 从磁盘上某份文件导入：前端只报个 rel，读盘由这里做。
      if (typeof body.from === "string" && body.from.trim() !== "") {
        const from = body.from.trim();
        if (!listImports(root).some((one) => one.rel === from)) {
          return sendJson(res, 400, { error: "这个位置没有可导入的文件：" + from });
        }
        const abs = withinRoot(root, from);
        if (abs === undefined) return sendJson(res, 400, { error: "路径不合法" });
        try {
          raw = readFileSync(abs, "utf8");
        } catch (error) {
          return sendJson(res, 400, { error: "读不出这个文件：" + (error instanceof Error ? error.message : String(error)) });
        }
      }
      if (typeof body.import === "string" || (body.import !== null && typeof body.import === "object")) {
        // RimTalk 的 preset.json：只留名字、正文、启用状态，role/position 丢掉。
        try {
          blocks = fromRimTalk(body.import).blocks;
        } catch (error) {
          return sendJson(res, 400, { error: "导入失败：" + (error instanceof Error ? error.message : String(error)) });
        }
      } else if (Array.isArray(body.blocks)) {
        blocks = body.blocks.map((b) => ({
          name: typeof b?.name === "string" ? b.name : "未命名",
          enabled: b?.enabled !== false,
          text: typeof b?.text === "string" ? b.text : "",
        }));
      } else if (raw !== null && raw.trim().startsWith("{")) {
        // 盘上的 .json 也当 RimTalk 预设吃
        try {
          blocks = fromRimTalk(raw).blocks;
        } catch (error) {
          return sendJson(res, 400, { error: "导入失败：" + (error instanceof Error ? error.message : String(error)) });
        }
      }
      // 直接给整份文本也行：解析完照样能列块，写出去也还是那份文本。
      const text = blocks !== null ? renderPreset(blocks) : raw;
      if (text === null) return sendJson(res, 400, { error: "要 text、blocks 或 import 其中一个" });
      if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
        return sendJson(res, 413, { error: "文件超过 " + BODY_LIMIT + " 字节" });
      }
      const abs = withinRoot(root, PRESET_REL);
      if (abs === undefined) return sendJson(res, 400, { error: "路径不合法" });
      writeAtomic(abs, text);
      const after = readPreset(root);
      return sendJson(res, 200, {
        ok: true,
        rel: PRESET_REL,
        marked: after.marked,
        text: after.text,
        blocks: after.blocks,
        composed: composeBlocks(after.blocks, env.effective().separator),
      });
    }


    if (rest === "config") {
      if (method === "GET") return sendJson(res, 200, { config: env.effective() });
      if (method !== "POST" && method !== "PUT") {
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const body = await readJson(req);
      const current = readStore(storePath) ?? {};
      const next = { ...current };
      if (typeof body.separator === "string") next.separator = body.separator;
      if (typeof body.enabled === "boolean") next.enabled = body.enabled;
      if (body.maxBytes !== undefined) {
        next.maxBytes = clampInt(body.maxBytes, 1024, 1048576, 65536);
      }
      if (typeof body.title === "string") next.title = body.title.trim();
      if (typeof body.personaId === "string") next.personaId = body.personaId.trim();
      if (typeof body.engineEnabled === "boolean") next.engineEnabled = body.engineEnabled;
      if (body.engineScope === "global" || body.engineScope === "session") next.engineScope = body.engineScope;
      if (typeof body.engineDataDir === "string") next.engineDataDir = body.engineDataDir.trim();
      Object.assign(next, wakeConfigPatch(body));
      writeStore(storePath, next);
      if (env.wake != null) void env.wake.reschedule();
      return sendJson(res, 200, { ok: true, config: effectiveFrom(cfg, next) });
    }

    if (rest === "wake") {
      if (method === "GET") return sendJson(res, 200, await wakePage(env));
      if (method !== "POST" && method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const current = readStore(storePath) ?? {};
      const next = { ...current, ...wakeConfigPatch(body) };
      writeStore(storePath, next);
      if (env.wake !== undefined && env.wake !== null) void env.wake.reschedule();
      return sendJson(res, 200, { ok: true, ...(env.wake !== undefined && env.wake !== null ? env.wake.snapshot() : {}) });
    }

    if (rest === "wake/now") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      if (env.wake === undefined || env.wake === null) return sendJson(res, 200, { ok: false, error: "唤醒线没挂载" });
      const out = await env.wake.fireNow();
      return sendJson(res, 200, { ...out, ...env.wake.snapshot() });
    }

    if (rest === "engine") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, engineSnapshot(env));
    }

    // 清空引擎数据、从零开始。DELETE 必须带 confirm: true —— 这一步会删掉
    // 全部会话、备份与日记，不可撤销。
    if (rest === "engine/wipe") {
      if (method !== "DELETE" && method !== "POST") {
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const body = await readJson(req);
      if (body.confirm !== true) {
        return sendJson(res, 400, { error: "需要 confirm: true（这一步会删掉全部会话、备份与日记）" });
      }
      try {
        const result = await env.bridge.wipe();
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (rest === "engine/session") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const raw = url.searchParams.get("session_id") ?? "";
      if (raw === "") return sendJson(res, 400, { error: "需要 session_id" });
      try {
        const payload = { session_id: raw, depth: url.searchParams.get("depth") === "full" ? "full" : "brief" };
        // 设置页读的就是「现在这一刻的局面」：把磁盘上的人设一并送进去，
        // 于是它显示的地点名、角色卡与提示词里的一致，不用等下一次 soul_state。
        const fresh = env.bridge.freshPersona();
        if (fresh.payload !== null) payload.persona = fresh.payload;
        const data = await env.bridge.call("get-context", payload, {});
        return sendJson(res, 200, data);
      } catch (error) {
        return sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 引擎人设文件：GET 读结构化字段（表单初值），PUT 整份覆盖写回。
    if (rest === "engine/persona-file") {
      if (method === "GET") return sendJson(res, 200, { ok: true, ...personaFileInfo(env, env.persona()) });
      if (method !== "PUT" && method !== "POST") {
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const body = await readJson(req);
      const front = body.front;
      if (front === null || typeof front !== "object" || Array.isArray(front)) {
        return sendJson(res, 400, { error: "front 必须是对象" });
      }
      try {
        writeEnginePersona(root, front);
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return sendJson(res, 200, { ok: true, ...personaFileInfo(env) });
    }

    // 设置页的人设试跑：只校验与预览，不落盘、不建局。
    if (rest === "engine/persona") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const built = env.persona();
      if (!env.bridge.health().ready) {
        return sendJson(res, 200, { ok: false, error: "引擎不可用，先装 Python 3.10+" });
      }
      try {
        const data = await env.bridge.call("preview-persona", {
          persona: { front: built.front ?? {}, prose: built.prose, title: built.title, persona_id: built.personaId },
        }, {});
        return sendJson(res, 200, { ok: true, build: { title: built.title, bytes: built.bytes, files: built.files }, ...data });
      } catch (error) {
        // 引擎的报错是「N 处问题」的摘要，真正能改的东西在 details 里（path + reason + hint）。
        const details = Array.isArray(error?.details) ? error.details : [];
        return sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          details: details.map((item) => ({
            path: typeof item?.path === "string" ? item.path : "",
            reason: typeof item?.reason === "string" ? item.reason : "",
            hint: typeof item?.hint === "string" ? item.hint : "",
          })),
        });
      }
    }

    // 情绪面板与手动删条目（m03587：设置页可 debug 删除）。
    if (rest === "engine/mood") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      const npcId = url.searchParams.get("npc_id") ?? "";
      if (sessionId === "" || npcId === "") {
        return sendJson(res, 400, { error: "需要 session_id 与 npc_id" });
      }
      try {
        const data = await env.bridge.call("debug-mood", { session_id: sessionId, npc_id: npcId }, {});
        return sendJson(res, 200, data);
      } catch (error) {
        return sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「情绪」页：所有 NPC 的心情面板一次取完（只读，不写库）。
    if (rest === "engine/moods") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "") return sendJson(res, 400, { error: "需要 session_id" });
      try {
        const data = await env.bridge.call("debug-moods", { session_id: sessionId }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「记忆」页：ABM / SCM / CLPA 三层、待交的总结 / 日记、删除审计（只读）。
    if (rest === "engine/memories") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "") return sendJson(res, 400, { error: "需要 session_id" });
      try {
        const data = await env.bridge.call("debug-memories", { session_id: sessionId }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「记忆」页：她写过的日记（落在磁盘上的 md），新的在前。
    if (rest === "engine/diaries") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "") return sendJson(res, 400, { error: "需要 session_id" });
      try {
        return sendJson(res, 200, { ok: true, diaries: await env.bridge.diaries(sessionId) });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「常识库」页：确认一条模型提的常识，确认了才会被注入。
    if (rest === "engine/common/approve") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const commonId = typeof body.common_id === "string" ? body.common_id : "";
      if (commonId === "") return sendJson(res, 400, { error: "需要 common_id" });
      try {
        const data = await env.bridge.call("approve-common", {
          request_id: "cmn" + randomBytes(8).toString("hex"),
          common_id: commonId,
        }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「常识库」页：她知道的事。GET 只读；DELETE 手动删一条（留审计）。
    if (rest === "engine/facts") {
      if (method === "DELETE") {
        const body = await readJson(req);
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        const factId = typeof body.fact_id === "string" ? body.fact_id : "";
        if (sessionId === "" || factId === "") return sendJson(res, 400, { error: "需要 session_id / fact_id" });
        try {
          const data = await env.bridge.call("delete-fact", {
            session_id: sessionId,
            request_id: "fact" + randomBytes(8).toString("hex"),
            expected_revision: Number.isFinite(body.revision) ? body.revision : undefined,
            fact_id: factId,
          }, {});
          env.bridge.syncRevision(sessionId, data && data.revision);
          void env.bridge.refreshContext(sessionId);
          return sendJson(res, 200, { ok: true, ...data });
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "") return sendJson(res, 400, { error: "需要 session_id" });
      try {
        const data = await env.bridge.call("debug-facts", { session_id: sessionId }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「常识库」页：关键词 + 权重 + 一条常识，全局共享（不挂会话）。
    if (rest === "engine/common" || rest === "engine/common/limit") {
      const isLimit = rest === "engine/common/limit";
      const allowed = isLimit ? method === "PUT" : method === "GET" || method === "POST" || method === "PUT" || method === "DELETE";
      if (!allowed) return sendJson(res, 405, { error: "method not allowed" });
      try {
        if (method === "GET") {
          const data = await env.bridge.call("debug-common", {}, {});
          return sendJson(res, 200, { ok: true, ...data });
        }
        const body = await readJson(req);
        const requestId = "cmn" + randomBytes(8).toString("hex");
        if (isLimit) {
          const data = await env.bridge.call("set-common-limit", { request_id: requestId, limit: body.limit }, {});
          return sendJson(res, 200, { ok: true, ...data });
        }
        if (method === "POST") {
          const data = await env.bridge.call("add-common", {
            request_id: requestId,
            key: body.key,
            weight: body.weight,
            content: body.content,
          }, {});
          return sendJson(res, 200, { ok: true, ...data });
        }
        const commonId = typeof body.common_id === "string" ? body.common_id : "";
        if (commonId === "") return sendJson(res, 400, { error: "需要 common_id" });
        const command = method === "DELETE" ? "delete-common" : "edit-common";
        const data = await env.bridge.call(command, {
          request_id: requestId,
          common_id: commonId,
          key: method === "PUT" ? body.key : undefined,
          weight: method === "PUT" ? body.weight : undefined,
          content: method === "PUT" ? body.content : undefined,
        }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「记忆」页的写操作：改 / 删一条记忆，立即总结 / 归档。
    // 写完同步会话映射的 revision、刷新提示词快照（和删情绪一样）。
    if (rest === "engine/memory" || rest === "engine/memory/request") {
      const isRequest = rest === "engine/memory/request";
      const allowed = isRequest ? method === "POST" : method === "PUT" || method === "DELETE";
      if (!allowed) return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const sessionId = typeof body.session_id === "string" ? body.session_id : "";
      const memoryId = typeof body.memory_id === "string" ? body.memory_id : "";
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (sessionId === "" || (isRequest ? kind === "" : memoryId === "")) {
        return sendJson(res, 400, { error: isRequest ? "需要 session_id / kind" : "需要 session_id / memory_id" });
      }
      const payload = {
        session_id: sessionId,
        request_id: "mem" + randomBytes(8).toString("hex"),
        expected_revision: Number.isFinite(body.revision) ? body.revision : undefined,
      };
      let command;
      if (isRequest) {
        command = "request-memory";
        payload.kind = kind;
      } else if (method === "DELETE") {
        command = "delete-memory";
        payload.memory_id = memoryId;
        if (typeof body.reason === "string" && body.reason !== "") payload.reason = body.reason;
      } else {
        command = "edit-memory";
        payload.memory_id = memoryId;
        for (const key of ["content", "importance", "activity", "keywords", "note", "pinned"]) {
          if (body[key] !== undefined) payload[key] = body[key];
        }
      }
      try {
        const data = await env.bridge.call(command, payload, {});
        env.bridge.syncRevision(sessionId, data && data.revision);
        void env.bridge.refreshContext(sessionId);
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 设置页「自主行动」页：最近几次的行动、离屏片段与关系变化（只读）。
    if (rest === "engine/activity") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (sessionId === "") return sendJson(res, 400, { error: "需要 session_id" });
      const raw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(raw) ? clampInt(raw, 1, 50, 20) : 20;
      try {
        const data = await env.bridge.call("debug-activity", { session_id: sessionId, limit }, {});
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (rest === "engine/thought") {
      if (method !== "DELETE") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const sessionId = typeof body.session_id === "string" ? body.session_id : "";
      const npcId = typeof body.npc_id === "string" ? body.npc_id : "";
      const thoughtId = typeof body.thought_id === "string" ? body.thought_id : "";
      if (sessionId === "" || npcId === "" || thoughtId === "") {
        return sendJson(res, 400, { error: "需要 session_id / npc_id / thought_id" });
      }
      try {
        const data = await env.bridge.call("debug-delete-thought", {
          session_id: sessionId,
          request_id: "del" + randomBytes(8).toString("hex"),
          expected_revision: Number.isFinite(body.revision) ? body.revision : undefined,
          npc_id: npcId,
          thought_id: thoughtId,
          reason: typeof body.reason === "string" ? body.reason : "",
        }, {});
        env.bridge.syncRevision(sessionId, data && data.revision);
        // 删掉的想法必须从提示词快照里消失，否则下一次还会跟着「最近的想法」
        // 一起注进系统提示词（用户实测：注入的心情没更新）。
        void env.bridge.refreshContext(sessionId);
        return sendJson(res, 200, { ok: true, ...data });
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return sendJson(res, 404, { error: "no route for " + url.pathname });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error?.status === "number" ? error.status : 500;
    sendJson(res, status, { error: message });
  }
}
