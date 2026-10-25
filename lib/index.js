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
import { buildPersona } from "./persona-pack.js";
import { EngineClient, EngineError, enginePresent, probePython } from "./engine-client.js";
import { mountEngine } from "./engine-bridge.js";

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

  /** 当前生效的人设包（散文 + 前置块），供引擎与设置页共用。 */
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
    return buildPersona({
      parts,
      separator: eff.separator,
      annotate: eff.annotate,
      maxBytes: eff.maxBytes,
      title: eff.title,
      personaId: eff.personaId,
    });
  };

  const store = () => readStore(storePath);
  const bridge = mountEngine(ctx, { root, storePath, cfg, effective, persona, store });

  ctx.effect(() => ctx.systemPrompt.section({
    name: "soul-persona",
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
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

  // 引擎账本快照：紧跟在人设后面（人设先立人，账本再立事）。
  // 它只反映「上一次 soul_state 读到的局面」，实时状态由工具返回，
  // 这样提示词段落保持同步、不引入 await。
  ctx.effect(() => ctx.systemPrompt.section({
    name: "soul-engine",
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") + 1,
    interpolate: false,
    text: () => {
      try {
        return bridge.snapshotText();
      } catch {
        return "";
      }
    },
  }), "soul-engine.section()");

  // 设置页接口只在 web 侧有意义：CLI/TUI 组合里没有 webServer，人设照常生效即可。
  // connection 服务用于信任栅栏（防跨站请求打本地接口），缺它就干脆不开路由，
  // 免得暴露一组无鉴权的读写文件接口。
  ctx.inject(["webServer", "connection"], (wctx) => {
    wctx.effect(() => wctx.webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler: (req, res) => handleRoute(wctx, req, res, { root, storePath, cfg, effective, persona, bridge }),
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
    const text = readOne(abs, budget).trim();
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
  const session = bridge.mappingOf("shared") ?? latestSession(rows);
  return {
    health,
    persona: {
      title: built.title,
      personaId: built.personaId,
      bytes: built.bytes,
      files: built.files,
      front: built.front,
      error: built.error,
    },
    sessionsFile: join(root, cfg.engineSessions ?? "rp-soul/engine-sessions.json"),
    sessions: rows.map((r) => ({ key: r.key, session_id: r.row?.session_id ?? null, turn: r.row?.turn ?? null })),
    session,
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
      return sendJson(res, 200, snapshot(root, storePath, cfg));
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
      if (typeof body.engineDataDir === "string") next.engineDataDir = body.engineDataDir.trim();
      writeStore(storePath, next);
      return sendJson(res, 200, { ok: true, config: effectiveFrom(cfg, next) });
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
        const data = await env.bridge.call(
          "get-context",
          { session_id: raw, depth: url.searchParams.get("depth") === "full" ? "full" : "brief" },
          {},
        );
        return sendJson(res, 200, data);
      } catch (error) {
        return sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
      }
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
