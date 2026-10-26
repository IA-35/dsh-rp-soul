/**
 * soul-persona —— 从 $DSH_HOME 下若干文本文件读取人设，按顺序拼成一段系统提示。
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
 * - 多文件：files 是相对 $DSH_HOME 的路径数组，按数组顺序拼接。
 * - 设置页改的是本插件自己的存储文件（默认 $DSH_HOME/rp-soul/config.json），
 *   不走 cordis.yml —— 那份配置需要热替换才生效，改完立刻生效是这个插件的卖点。
 *   cordis.yml 里的 fileName / files 只作为首次运行的种子。
 */

import { readFileSync, statSync, existsSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, sep, dirname, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { buildPersona, parseYaml, splitFrontMatter, stringifyYaml } from "./persona-pack.js";
import { EngineClient, EngineError, enginePresent, probePython } from "./engine-client.js";
import { mountEngine } from "./engine-bridge.js";
import { mountWake, readWakeConfig, wakeConfigPatch } from "./wake.js";

export const name = "soul-persona";

export const inject = ["systemPrompt"];

export const Config = z.object({
  fileName: z.string().default("SOUL.md"),
  files: z.array(String).default([]),
  separator: z.string().default("\n\n"),
  annotate: z.boolean().default(false),
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
const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);
const BODY_LIMIT = 1048576;
const PART_DIR = "rp-soul/parts";
/** 首装自动生成的角色档案（放在可写目录 rp-soul/parts 下）。 */
const PROFILE_REL = PART_DIR + "/角色档案.md";
/**
 * 引擎人设（结构化字段）单独一个文件，不再从散文里第一个前置块抠。
 * 这样可以拿表单整份重写它，而散文只负责人设提示词、保持人写人读的样子。
 */
const ENGINE_PERSONA_REL = "rp-soul/persona.md";

export function apply(ctx, config) {
  const cfg = config ?? {};
  const root = safeRoot();
  const storePath = join(root, cfg.storeFile ?? "rp-soul/config.json");
  const effective = () => effectiveFrom(cfg, readStore(storePath));

  // 首装落地：把种子文件建出来，避免设置页一进来就一片红「缺失」。
  // 只建不建内容 —— 空文件等人自己写；已有文件绝不覆盖。
  try {
    ensureSeeds(root, storePath, cfg);
  } catch {
    // 磁盘只读 / 权限不足时静默跳过：人设仍按已有文件生效。
  }

  /**
   * 当前生效的人设包（散文 + 引擎结构化字段），供引擎与设置页共用。
   *
   * 结构化字段只认 rp-soul/persona.md；散文文件里的前置块一律剥掉、不参与解析
   * （散文是给人读的，里面出现 `---` 只当分隔线，不该被当成配置）。
   * persona.md 不存在时退回老行为：从第一个带前置块的散文文件里取。
   */
  const persona = () => {
    const eff = effective();
    const parts = [];
    for (const rel of eff.files) {
      const abs = withinRoot(root, rel);
      if (abs === undefined) continue;
      const text = readOne(abs, eff.maxBytes);
      if (text.trim() === "") continue;
      parts.push({ rel, text });
    }
    const enginePersona = readEnginePersona(root, eff);
    return buildPersona({
      parts,
      separator: eff.separator,
      annotate: eff.annotate,
      maxBytes: eff.maxBytes,
      title: eff.title,
      personaId: eff.personaId,
      front: enginePersona.value,
      frontRel: enginePersona.rel,
    });
  };

  const store = () => readStore(storePath);
  // 唤醒线要先看到「这一局有没有开局」，桥接层先建；唤醒线自己的引用反过来交给
  // 桥接层：soul_commit 得知道当前回合是不是她的「我的时间」，从而自动带 together: false。
  const wakeRef = { current: null };
  const bridge = mountEngine(ctx, { root, storePath, cfg, effective, persona, store, wake: wakeRef });
  const wake = mountWake(ctx, { root, store, bridge, log: (line) => { try { ctx.logger?.warn?.(line); } catch { /* 没有 logger 就算了 */ } } });
  wakeRef.current = wake;
  // 唤醒线自己判断宿主支不支持：没有 sessionController（命令行）就整条不启用，
  // 设置页那边照样能读配置、能看状态，只是 mounted 为 false。
  wake.start();

  // 位置：系统提示的最末尾。上下文缓存按前缀命中，而账本快照几乎每回合都在变
  // （时间、心情、想法），排在开头会让它后面的一切——工具定义、交付物约定、
  // 结构化输出——每回合跟着失效。排在末尾，变的那一段后面没有东西可被带坏。
  // 人设排在账本前面：它稳，账本才是每回合动的那一小段。
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
  // 只要有一个字节每回合在变，整段前缀就作废——把它挪到最后只是让后面没东西
  // 跟着失效，它自己仍在前缀里，仍然每回合重刷几十 K token。
  //
  // 动态 context 由宿主渲染成一条 user 角色的快照消息、追加在对话尾部；宿主只在
  // 文本真的变了时才追加（dsh-agent-loop 的 RuntimeContextProjection），所以系统
  // 提示词从此恒定，前缀能一路命中，每回合新增的只有尾部那几十字节。
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

  // 宿主没有 `context()`（旧版 DSH）时退回原来的 section 方案，至少功能不丢。
  if (typeof ctx.systemPrompt.context === "function") {
    ctx.effect(() => ctx.systemPrompt.context({
      name: "soul-engine",
      order: bottomContextOrder(),
      interpolate: false,
      text: engineText,
    }), "soul-engine.context()");
  } else {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "soul-engine",
      order: bottomOrder() + 2,
      interpolate: false,
      text: engineText,
    }), "soul-engine.section()");
  }

  // 装配钩子：先让侧车把账本读进缓存（异步），再在装配结果里把这一段刷新成最新文本。
  //
  // 注意只能改**动态 context**那一条——宿主在 `assemble()` 里同步求值 context，
  // 等 waterfall 跑到这里时，条目里已经是上一次读到的旧快照，必须就地替换。
  // 系统提示词的 section 一概不碰：碰了前缀哈希就变，缓存全废。
  if (typeof ctx.on === "function") {
    ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
      const text = await bridge.preparePrompt(context);
      const result = await next();
      const entry = result.contexts.find((row) => row.name === "soul-engine");
      if (entry !== undefined) entry.text = text;
      // 旧宿主（没有 context()）退回 section 方案时，才需要改 section 文本。
      else {
        const section = result.sections.find((row) => row.name === "soul-engine");
        if (section !== undefined) section.text = text;
      }
      return result;
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
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = storePath + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, storePath);
}

/** 种子文件清单：cordis 里配的 files（或 fileName），再加一份角色档案。 */
function seedRels(cfg) {
  const fromCfg = Array.isArray(cfg.files) && cfg.files.length > 0
    ? cfg.files.filter(isRelString).map((s) => String(s).trim())
    : [typeof cfg.fileName === "string" && cfg.fileName.trim() ? cfg.fileName.trim() : "SOUL.md"];
  const out = [];
  for (const rel of fromCfg.concat([PROFILE_REL])) {
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * 首次运行落地：缺哪个种子文件就建个空文件（0 字节），绝不覆盖已有内容。
 * 存储配置还没写过时，顺手把种子清单写进去，设置页一进来就能看到它们。
 * @returns {string[]} 本次真正创建的文件（相对路径）。
 */
function ensureSeeds(root, storePath, cfg) {
  const created = [];
  for (const rel of seedRels(cfg)) {
    const abs = withinRoot(root, rel);
    if (abs === undefined) continue;
    if (existsSync(abs)) continue;
    writeAtomic(abs, "");
    created.push(rel);
  }
  if (created.length === 0) return created;
  const store = readStore(storePath);
  if (store === null) {
    writeStore(storePath, { files: seedRels(cfg) });
  } else if (Array.isArray(store.files) && created.includes(PROFILE_REL) && !store.files.includes(PROFILE_REL)) {
    // 老用户升级：角色档案刚建出来，接在清单末尾，让它真的参与合成。
    writeStore(storePath, { ...store, files: store.files.concat([PROFILE_REL]) });
  }
  return created;
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
 * @returns {{files: string[], separator: string, annotate: boolean, maxBytes: number, enabled: boolean, source: string}}
 */
function effectiveFrom(cfg, store) {
  const seededFiles = Array.isArray(cfg.files) && cfg.files.length > 0
    ? cfg.files.filter(isRelString)
    : [typeof cfg.fileName === "string" && cfg.fileName.trim() ? cfg.fileName.trim() : "SOUL.md"];
  const base = {
    files: seededFiles,
    separator: typeof cfg.separator === "string" ? cfg.separator : "\n\n",
    annotate: cfg.annotate === true,
    maxBytes: clampInt(cfg.maxBytes, 1024, 1048576, 65536),
    enabled: true,
    engineScope: cfg.engineScope === "session" ? "session" : "global",
    title: typeof cfg.title === "string" && cfg.title.trim() !== "" ? cfg.title.trim() : null,
    personaId: typeof cfg.personaId === "string" && cfg.personaId.trim() !== "" ? cfg.personaId.trim() : null,
  };
  if (store === null) return { ...base, source: "config" };
  return {
    files: Array.isArray(store.files) ? store.files.filter(isRelString) : base.files,
    separator: typeof store.separator === "string" ? store.separator : base.separator,
    annotate: typeof store.annotate === "boolean" ? store.annotate : base.annotate,
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

/** 读单个文件；缺失 / 空 / 非文件 / 超限都返回空串。 */
function readOne(abs, maxBytes) {
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size === 0) return "";
    const text = readFileSync(abs, "utf8");
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
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
 * 按配置顺序把多个文件拼成最终人设文本。
 * @returns 拼接后的文本（原样保留，section 已声明 interpolate: false）；无可用内容时返回空串。
 */
function composeText(root, eff) {
  const budget = eff.maxBytes;
  const pieces = [];
  let used = 0;
  for (const rel of eff.files) {
    const abs = withinRoot(root, rel);
    if (abs === undefined) continue;
    const text = stripFrontMatter(readOne(abs, budget)).trim();
    if (text === "") continue;
    const chunk = eff.annotate ? "<!-- soul-part: " + rel + " -->\n" + text : text;
    const joiner = pieces.length === 0 ? "" : eff.separator;
    const remaining = budget - used;
    if (remaining <= 0) break;
    const piece = joiner + chunk;
    if (piece.length > remaining) {
      pieces.push(piece.slice(0, remaining));
      used = budget;
      break;
    }
    pieces.push(piece);
    used += piece.length;
  }
  return pieces.join("");
}

/**
 * 列出 $DSH_HOME 下可选的文本文件（最多两层深，跳过重目录），供设置页下拉选择。
 */
function listLibrary(root) {
  const SKIP = new Set([
    "node_modules", ".git", "sessions", "storages", "versions", "logs",
    "profiles", "cache", "tmp", "attachments", "jobs", "skills",
  ]);
  const out = [];
  const walk = (dirAbs, prefix, depth) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) {
        if (depth >= 2 || SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dirAbs, entry.name), rel, depth + 1);
      } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
        out.push(rel);
      }
    }
  };
  walk(root, "", 0);
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, 400);
}

/** 单个文件的元信息（给设置页列表用）。 */
function fileInfo(root, rel) {
  const abs = withinRoot(root, rel);
  if (abs === undefined) return { rel, exists: false, bytes: 0, mtimeMs: 0, error: "路径不合法" };
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { rel, exists: false, bytes: 0, mtimeMs: 0, error: "不是文件" };
    return { rel, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { rel, exists: false, bytes: 0, mtimeMs: 0 };
  }
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

/** 原子写文本文件。 */
function writeAtomic(abs, text) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + ".tmp-" + process.pid;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, abs);
}

/** 组装给设置页的一份快照。 */
function snapshot(root, storePath, cfg) {
  const store = readStore(storePath);
  const eff = effectiveFrom(cfg, store);
  const composed = eff.enabled ? composeText(root, eff) : "";
  return {
    root,
    storePath,
    config: eff,
    store,
    files: eff.files.map((rel) => fileInfo(root, rel)),
    library: listLibrary(root),
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
      files: built.files,
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

    if (rest === "file") {
      if (method === "GET") {
        const rel = url.searchParams.get("rel") ?? "";
        const abs = withinRoot(root, rel);
        if (abs === undefined) return sendJson(res, 400, { error: "路径不合法" });
        return sendJson(res, 200, { rel, text: readOne(abs, 1048576), exists: existsSync(abs) });
      }
      if (method === "PUT" || method === "POST") {
        const body = await readJson(req);
        const rel = typeof body.rel === "string" ? body.rel : "";
        const abs = withinRoot(root, rel);
        if (abs === undefined) return sendJson(res, 400, { error: "路径不合法" });
        if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
          return sendJson(res, 400, { error: "只允许写 .md / .txt 文件" });
        }
        const text = typeof body.text === "string" ? body.text : "";
        if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
          return sendJson(res, 413, { error: "文件超过 " + BODY_LIMIT + " 字节" });
        }
        writeAtomic(abs, text);
        return sendJson(res, 200, { ok: true, file: fileInfo(root, rel) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (rest === "new") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const rawName = typeof body.name === "string" ? body.name : "";
      const fileName = safeBaseName(rawName);
      if (fileName === "") return sendJson(res, 400, { error: "文件名不合法" });
      const rel = PART_DIR + "/" + fileName;
      const abs = withinRoot(root, rel);
      if (abs === undefined) return sendJson(res, 400, { error: "路径不合法" });
      if (!existsSync(abs)) writeAtomic(abs, typeof body.text === "string" ? body.text : "");
      return sendJson(res, 200, { ok: true, rel, file: fileInfo(root, rel) });
    }

    if (rest === "config") {
      if (method === "GET") return sendJson(res, 200, { config: env.effective() });
      if (method !== "POST" && method !== "PUT") {
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const body = await readJson(req);
      const current = readStore(storePath) ?? {};
      const next = { ...current };
      if (Array.isArray(body.files)) {
        next.files = body.files.filter(isRelString).map((s) => String(s).trim());
      }
      if (typeof body.separator === "string") next.separator = body.separator;
      if (typeof body.annotate === "boolean") next.annotate = body.annotate;
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

    // 设置页「记忆」页：四层记忆、待交的总结 / 归档、删除审计（只读）。
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

    // 设置页「自主行动」页：最近若干回合的行动、离屏片段与关系变化（只读）。
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
        // 删掉的想法必须从提示词快照里消失，否则下一回合还会跟着「最近的想法」
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
