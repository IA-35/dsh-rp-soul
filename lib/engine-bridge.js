/**
 * engine-bridge —— 把 Python 引擎接进 DSH：三个工具 + 一段系统提示 + 会话映射。
 *
 * 分工：
 * - 人设（散文）由 index.js 的 section 提供，引擎一个字都不写；
 * - 引擎只负责「账本」：谁在场、几点、信任/张力、心情条、未结事件；
 * - 模型每次先用 soul_state 拿状态，写完正文用 soul_commit 交账，
 *   被驳回时错误里带 path + reason + hint，照着改再交（最多两轮）。
 *
 * 会话映射：DSH 的会话 id 与引擎的 s_xxx 不是一回事，这里用一个小 JSON
 * 文件记住「对应哪一局」，重启 DSH 也不会丢局。
 *
 * 作用域（engineScope）：
 * - global（默认）：所有 DSH 会话共用同一局。心情、人际关系、未结的事是「她这个人的」
 *   而不是「某个窗口的」，换个会话继续聊，账本接着走。
 * - session：老行为，一个 DSH 会话一局，互不相干。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

// 装配期读一次局面用的超时：这一段在每一轮 LLM 请求的关键路径上，宁可旧不能慢。
const PROMPT_TIMEOUT_MS = 2500;
import { createHash } from "node:crypto";
import { EngineClient, EngineError, enginePresent, probePython } from "./engine-client.js";

/** 引擎数据目录的默认位置（相对 $DSH_HOME）。 */
const ENGINE_DIR = "rp-soul/engine";
const DB_FILE = "engine.db";
/** 清空数据时要一起删的子目录。见 wipe()。 */
const WIPE_SUBDIRS = Object.freeze(["backups", "journal", "exports", "logs"]);
/** 会话映射文件的默认位置（相对 $DSH_HOME）。 */
const SESSIONS_FILE = "rp-soul/engine-sessions.json";
/** 引擎要求 request_id 至少 8 位，这里统一发 "n" + 32 位十六进制。 */
function newRequestId() {
  return "n" + createHash("sha256")
    .update(String(Date.now()) + ":" + String(Math.random()))
    .digest("hex")
    .slice(0, 20);
}

function readJsonFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const obj = JSON.parse(raw);
    return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** 临时文件名的自增后缀，保证同一进程里每次写都是新名字。 */
let tmpSeq = 0;

function writeJsonFile(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  // 临时名必须每次唯一：原先只用 pid，同一进程里连写两次会抢同一个 tmp 文件；
  // 崩溃残留的 tmp 也会被下次写入误用。加计数器保证每次都是新名字。
  const tmp = path + ".tmp-" + process.pid + "-" + (tmpSeq += 1);
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 已经没了 */
    }
    throw error;
  }
}

/** 文本块（工具输出用）。 */
const text = (value) => [{
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
}];

/** 通用 JSON 对象输出 schema。 */
const JSON_OBJECT = { type: "object", additionalProperties: true };

/**
 * 引擎内置的内容标签 id（engine/rp_soul_engine/domain/structure.py 的 TAGS），
 * 引擎只认这张表。test/schema-sync.mjs 会逐项比对，两边改了一边就挂。
 */
export const CONTENT_TAGS = Object.freeze([
  "romance_light", "intimate", "explicit",
  "violence", "coercion_theme", "humiliation", "bodily_harm",
  "substance", "pregnancy", "death", "workplace_power", "infidelity", "crime", "gambling",
  "workplace", "nightlife", "supernatural", "disaster",
  "custom",
]);

/** 与 structure.py 的 ACTION_MODES 一致（同样由 test/schema-sync.mjs 比对）。 */
export const ACTION_MODES = Object.freeze(["result", "attempt", "rewrite", "continue", "wait"]);

/**
 * 每个 op 的字段：必填 / 可选。和引擎 domain/ops.py 的 SPECS 逐项一致（schema-sync 测试守着）。
 *
 * 以前工具 schema 里 operations 的每一项只写了 {type: object}，模型只知道 op 的名字，
 * 不知道字段，于是靠猜：npc_action 写 note、offscreen_beat 写 action、add_thought 写 text……
 * 真实会话里交账失败的一大半都是这么来的。字段清单写进说明，第一次就能写对。
 */
export const OP_FIELDS = Object.freeze({
  npc_response: { required: ["response", "note"], optional: ["basis_fact_ids", "true_intent"] },
  npc_action: { required: ["action"], optional: ["significant", "kind", "basis_fact_ids"] },
  npc_state: { required: [], optional: ["add_conditions", "remove_conditions"] },
  add_thought: { required: ["label", "delta", "basis_fact_id"], optional: ["minutes"] },
  add_fact: { required: ["key", "text", "scope", "origin"], optional: ["truth"] },
  reveal_fact: { required: ["fact_id"], optional: ["note"] },
  relationship: { required: ["reason"], optional: ["trust_delta", "tension_delta", "stage_advance", "stage_retreat_to"] },
  event_create: {
    required: ["kind", "title", "dedupe_key"],
    optional: ["text", "tier", "with_player", "due", "in_minutes", "probability", "repeat"],
  },
  event_resolve: { required: ["event_id", "outcome", "note"], optional: [] },
  event_cancel: { required: ["event_id", "reason"], optional: [] },
  plan_next: { required: ["note"], optional: ["in_minutes", "until"] },
  offscreen_beat: { required: ["summary"], optional: ["operations"] },
});

/** 给模型看的字段说明，一个 op 一行。取值范围照引擎的校验写。 */
const OP_GUIDE = [
  "每条 op 的字段（? 是可选；字段名写错或多写，整条会被驳回）：",
  "npc_response {response: refuse/negotiate/partial/surface/genuine, note ≤80 你回了什么, ?basis_fact_ids, ?true_intent}",
  "npc_action {action ≤120 你做了什么, ?significant, ?kind: approach/observe/request/accident/provoke/leave/silence/seek_comfort/change_topic/withdraw, ?basis_fact_ids}",
  "npc_state {?add_conditions: [{kind: drunk/asleep/unconscious/injured/away/busy/other, text ≤40, ?minutes}], ?remove_conditions: [kind]} —— 只管身体和处境，心情不用写；两样都没有就别写这条",
  "add_thought {label ≤20, delta -30..15, basis_fact_id 必须是已知事实的 id, ?minutes}",
  "add_fact {key 小写点分如 her.secret.letter, text ≤120, scope: shared/player_only/companion_only/inner, origin: observed/told/retcon, ?truth}",
  "reveal_fact {fact_id, ?note}",
  "relationship {reason ≤80, ?trust_delta -2..2, ?tension_delta -5..5, ?stage_advance, ?stage_retreat_to}",
  "event_create {kind: promise/deadline/rumor/opportunity/foreshadow/chance, title ≤40, dedupe_key 小写点分, ?text, ?tier, ?with_player, ?due 或 ?in_minutes, ?probability, ?repeat}",
  "event_resolve {event_id, outcome: fulfilled/surfaced, note ≤80}",
  "event_cancel {event_id, reason ≤80}",
  "plan_next {note ≤40, ?in_minutes 或 ?until HH:MM}",
  "offscreen_beat {summary ≤120 主人不在时你做了什么, ?operations}",
].join("\n");

/** 引擎认的 npc_action.kind。 */
const AGENCY_KINDS = Object.freeze([
  "approach", "observe", "request", "accident", "provoke", "leave", "silence", "seek_comfort", "change_topic", "withdraw",
]);

/** 交账里几个文字字段的长度上限（和引擎一致）：超了截短，不为几个字驳回整次。 */
const COMMIT_TEXT_MAX = Object.freeze({
  summary: 120, open_action: 80, remember: 60, memory_fold: 300, memory_diary: 300,
});
const QUOTE_MAX = 80;
const QUOTES_MAX = 3;
/** op 里的文字字段上限。 */
const OP_TEXT_MAX = Object.freeze({
  npc_action: { action: 120 },
  npc_response: { note: 80 },
  offscreen_beat: { summary: 120 },
  add_thought: { label: 20 },
  relationship: { reason: 80 },
});
/**
 * 模型最常写错的字段名 → 正确的那个。只收在真实会话里见过的错法，
 * 不猜别的：猜多了就是替模型编内容。
 */
const OP_ALIASES = Object.freeze({
  npc_action: { action: ["note", "text", "description", "content"] },
  npc_response: { note: ["text", "action", "content"] },
  offscreen_beat: { summary: ["action", "text", "note", "description", "content"] },
  add_thought: { label: ["text"] },
});

const clip = (value, max) => {
  const text = String(value);
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
};

/**
 * 交给引擎之前把一条 op 规整一下：错的字段名换成对的、超长的截短、
 * 没有任何变化的 npc_state 直接拿掉（返回 null）。不改原对象。
 */
export function normalizeOp(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const op = { ...raw };
  const name = typeof op.op === "string" ? op.op : "";
  const allowed = new Set([...(OP_FIELDS[name]?.required ?? []), ...(OP_FIELDS[name]?.optional ?? [])]);
  for (const [field, aliases] of Object.entries(OP_ALIASES[name] ?? {})) {
    const empty = op[field] === undefined || op[field] === null || op[field] === "";
    if (empty) {
      const alias = aliases.find((one) => typeof op[one] === "string" && op[one].trim() !== "");
      if (alias !== undefined) op[field] = op[alias];
    }
    // 错名字本身不是这个 op 的字段：留着只会让引擎报「未知字段」
    for (const one of aliases) if (!allowed.has(one)) delete op[one];
  }
  // 认不得的 kind 当没写（引擎按普通行动记），不为它驳回整条
  if (name === "npc_action" && op.kind !== undefined && op.kind !== null && !AGENCY_KINDS.includes(op.kind)) delete op.kind;
  if (name === "npc_state") {
    const adds = Array.isArray(op.add_conditions) ? op.add_conditions : [];
    const removes = Array.isArray(op.remove_conditions) ? op.remove_conditions : [];
    if (adds.length === 0 && removes.length === 0) return null;
    // 模型爱顺手写一句 state / note 描述心情：npc_state 不收这些，拿掉
    for (const key of Object.keys(op)) if (key !== "op" && !OP_FIELDS.npc_state.optional.includes(key)) delete op[key];
  }
  for (const [field, max] of Object.entries(OP_TEXT_MAX[name] ?? {})) {
    if (typeof op[field] === "string") op[field] = clip(op[field], max);
  }
  return op;
}

/** 整次交账的规整：文字截短、op 逐条规整。不改原对象。 */
export function normalizeCommit(raw) {
  const commit = { ...raw };
  for (const [field, max] of Object.entries(COMMIT_TEXT_MAX)) {
    if (typeof commit[field] === "string") commit[field] = clip(commit[field], max);
  }
  if (Array.isArray(commit.quotes)) {
    commit.quotes = commit.quotes.filter((q) => typeof q === "string" && q.trim() !== "").slice(0, QUOTES_MAX).map((q) => clip(q, QUOTE_MAX));
  }
  if (Array.isArray(commit.operations)) {
    commit.operations = commit.operations.map(normalizeOp).filter((op) => op !== null);
  }
  return commit;
}

/**
 * 挂上引擎相关的一切。
 * @param {object} ctx cordis 上下文
 * @param {object} env {root, storePath, cfg, effective, persona}
 */
export function mountEngine(ctx, env) {
  const { root, cfg, persona } = env;
  /** 同步 provider 的缓存；异步装配钩子每次先读账本，再按当前作用域注入。 */
  const lastContexts = new Map();
  const rememberContext = (key, context) => {
    lastContexts.set(key, { context: context ?? null, at: new Date().toISOString() });
  };
  const sessionsPath = join(root, cfg.engineSessions ?? SESSIONS_FILE);
  const dataDirOf = () => {
    const store = env.store() ?? {};
    const custom = typeof store.engineDataDir === "string" ? store.engineDataDir.trim() : "";
    if (custom !== "") return custom;
    const fromCfg = typeof cfg.engineDataDir === "string" ? cfg.engineDataDir.trim() : "";
    if (fromCfg !== "") return fromCfg;
    return join(root, ENGINE_DIR);
  };
  let client = null;
  const engine = () => {
    const timeout = Number.isFinite(cfg.engineTimeoutMs) ? cfg.engineTimeoutMs : 30000;
    const dataDir = dataDirOf();
    if (client !== null && client.dataDir === dataDir) return client;
    if (client !== null) {
      // 数据目录换了（设置页改的）：旧进程作废
      void client.stop();
    }
    client = new EngineClient({ dataDir, timeoutMs: timeout });
    return client;
  };

  const readSessions = () => readJsonFile(sessionsPath);
  const writeSessions = (map) => writeJsonFile(sessionsPath, map);
  const mappingOf = (key) => {
    const map = readSessions();
    const row = map[key];
    return row !== null && typeof row === "object" && typeof row.session_id === "string" ? row : null;
  };
  const setMapping = (key, row) => {
    const map = readSessions();
    map[key] = row;
    writeSessions(map);
  };
  /** 整张映射表清掉（清空数据时用）。 */
  const clearSessions = () => writeSessions({});

  const dropMapping = (key) => {
    const map = readSessions();
    if (map[key] === undefined) return;
    delete map[key];
    writeSessions(map);
    // 这几个缓存以会话为键、只增不减：解绑了就一起忘掉，别让旧局的
    // 快照和失败计数挂在一个已经不存在的会话上。
    lastContexts.delete(key);
    forgetTidy(key);
    // 攒着的那几轮也跟着解绑一起忘掉：它们属于这个会话，换个会话不该带过去
    forgetBatches(key);
  };

  /**
   * 清空引擎数据，从零开始。
   *
   * 停进程 → 把整个数据目录删掉（不是只删 engine.db：backups/ 里躺着几十份
   * 旧存档、journal/ 里有日记 md，只删库下次读档还是旧局面）→ 让引擎自己
   * 重建目录和空库。
   *
   * 不碰设置文件（config.json / wake.json），也不碰 persona —— 那些不是「数据」。
   */
  const wipe = async () => {
    const dataDir = dataDirOf();
    // 先停：Windows 上进程占着 engine.db，删不掉
    if (client !== null) {
      await client.stop().catch(() => {});
      client = null;
    }
    // 连带那些以会话为键的内存缓存一起忘掉，否则清空后第一次装配还会
    // 拿旧 revision 去提交，直接 STALE_REVISION。
    lastContexts.clear();
    committedTurn.clear();
    // 攒着还没落的那几轮属于旧账本：不清的话，下一次落条会把它们写进新的一局
    forgetBatches();
    foldFailures.clear();
    foldBusy.clear();
    clearSessions();

    const removed = { dir: dataDir, db: false, backups: 0, journal: 0, exports: 0, logs: 0 };
    // 只删我们自己认得的子目录，不 rm -rf 整个 dataDir：用户可能把它指到
    // 一个还有别的东西的目录（engineDataDir 是可配置的）。
    const dbPath = join(dataDir, DB_FILE);
    if (existsSync(dbPath)) {
      await rm(dbPath, { force: true });
      removed.db = true;
    }
    // WAL 的两个伴生文件不删的话，空库一打开就把旧内容回滚回来
    for (const side of ["-wal", "-shm"]) {
      await rm(dbPath + side, { force: true }).catch(() => {});
    }
    for (const sub of WIPE_SUBDIRS) {
      const dir = join(dataDir, sub);
      if (!existsSync(dir)) continue;
      const count = (await readdir(dir).catch(() => [])).length;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed[sub] = count;
    }
    // 立刻开一局空的，这样调完就有得聊，不用等下一轮。
    // 走 autoStart：它会带上人设，且顺手写好映射；人设坏了也只是开不出局，
    // 不该让「清空」这个动作本身失败。
    const born = await autoStart("shared", null, null);
    if (born.row === null) {
      return { ok: true, ...removed, session_id: null, warning: "数据已清空，但没能开局：" + born.why };
    }
    rememberContext("shared", born.data?.context ?? null);
    return { ok: true, ...removed, session_id: born.row.session_id };
  };

  /**
   * 从「按会话记」迁到「全局记」：全局键还没有映射，但表里已经有旧的会话局。
   *
   * 直接接管最近动过的那一份，而不是新开一局 —— 账本（心情、关系、未结的事）
   * 是攒出来的，重开等于把它们扔了。接管后旧键删掉，免得两个键指向同一个
   * session_id、revision 各记各的写乱。
   */
  const adoptShared = () => {
    const map = readSessions();
    const keys = Object.keys(map).filter((k) => k !== "shared");
    if (keys.length === 0) return null;
    let best = null;
    for (const k of keys) {
      const row = map[k];
      if (row === null || typeof row !== "object" || typeof row.session_id !== "string") continue;
      const stamp = String(row.updated_at ?? row.seen_at ?? row.created_at ?? "");
      if (best === null || stamp > best.stamp) best = { stamp, key: k, row };
    }
    if (best === null) return null;
    const adopted = {
      ...best.row,
      adopted_from: best.key,
      scope: "global",
      updated_at: new Date().toISOString(),
    };
    map.shared = adopted;
    for (const k of keys) delete map[k];
    writeSessions(map);
    return adopted;
  };

  /**
   * 取这一局的映射；全局作用域下顺手完成接管。
   * @returns {object|null}
   */
  const rowFor = (key) => {
    const row = mappingOf(key);
    if (row !== null) return row;
    if (key === "shared") return adoptShared();
    return null;
  };

  /**
   * 直接开一局（不经过工具层），给「全局作用域下没局就自动开」用。
   * 失败不抛：调用方要的是「能用就用，不能用就按纯人设演」。
   * @returns {{row: object|null, data: object|null, why: string}}
   */
  const startGame = async (key, exec, options) => {
    const prepared = personaPayload();
    if (prepared.payload === null) {
      return { row: null, data: null, why: "人设不能用：" + String(prepared.error?.message ?? "") };
    }
    const payload = { request_id: newRequestId(), persona: prepared.payload };
    const seed = options !== null && typeof options === "object" && Number.isFinite(options.seed) ? options.seed : null;
    if (seed !== null) payload.seed = Math.max(1, Math.trunc(seed));
    try {
      const data = await engine().call("new-game", payload, {
        signal: exec?.signal,
        timeoutMs: 60000,
      });
      const row = {
        session_id: data.session_id,
        revision: data.revision,
        turn: data.turn,
        seed: data.seed,
        persona_id: data.persona?.id ?? null,
        persona_title: data.persona?.title ?? null,
        scope: scopeOf(),
        auto: true,
        created_at: new Date().toISOString(),
      };
      setMapping(key, row);
      return { row, data, why: "" };
    } catch (error) {
      return { row: null, data: null, why: describe(error) };
    }
  };

  /**
   * 这一轮里交过账的 agent。
   *
   * 回合结束时看一眼：交过就说明这一轮模型已经记了（那条更完整），宿主不必
   * 再记一遍；看完就清掉，下一轮重新算。按 agent 记而不是按账本：全局作用域下
   * 几个会话共用一本账，A 交了账不代表 B 这一轮也记过。
   * 以前比的是「交账时最后一条消息的 id」，可模型交完账往往还会再说一句，
   * id 一变就当成没交过，同一轮记成两条。
   */
  const committedTurn = new Set();
  const starting = new Map();
  /**
   * 攒着的几轮，键是 agent。
   *
   * RimTalk 一轮就是一件事；DSH 的一轮可能只是「继续」或者「嗯」，也可能
   * 一句话里塞着三件事。每轮写一条 ABM，二十条的额度会被噪声占满，真正
   * 发生了什么反而被挤掉。所以攒够几轮（或够字数、或搁了够久）才落一条。
   */
  const batches = new Map();

  const autoStart = (key, exec, options) => {
    let pending = starting.get(key);
    if (pending === undefined) {
      pending = startGame(key, exec, options).finally(() => starting.delete(key));
      starting.set(key, pending);
    }
    return pending;
  };

  /** 引擎局的作用域：global 共用一局，session 一会话一局。 */
  const scopeOf = () => {
    const store = env.store() ?? {};
    const raw = typeof store.engineScope === "string" ? store.engineScope.trim() : "";
    if (raw === "session" || raw === "global") return raw;
    const fromCfg = typeof cfg.engineScope === "string" ? cfg.engineScope.trim() : "";
    return fromCfg === "session" ? "session" : "global";
  };

  /**
   * 引擎局的键。
   * global 固定 "shared"：换会话接着用同一份账本，心情与关系是连续的。
   * session 用 DSH 的 agent id，与旧版一致。
   */
  const keyOf = (exec) => {
    if (scopeOf() === "global") return "shared";
    const agent = exec && exec.agent;
    const id = agent !== undefined && agent !== null && typeof agent.id === "string" ? agent.id : "";
    return id === "" ? "shared" : id;
  };

  /**
   * 宿主起的子任务（spawn / fork 出来的子代理会话）不是她。
   *
   * 插件对每个 agent 都生效，子代理也一样会走装配钩子、拿到 soul_* 工具、
   * 在结束时触发 turn-stopping。全局作用域下它和主会话共用同一本账，不拦的话
   * 子代理那一轮会被注入「当前现状」、被当成一轮对话记进 ABM，甚至自己去交账。
   * 判定和 dsh-world 一致：会话头上 origin 是 subagent，或委派深度大于 0。
   */
  const isChildAgent = (agent) => {
    try {
      const header = agent?.session?.header;
      if (header === null || typeof header !== "object") return false;
      return header.origin === "subagent" || (Number(header.delegationDepth) || 0) > 0;
    } catch {
      return false;
    }
  };
  const CHILD_HINT = "这是后台子任务：不读也不写她的账本，只做交给你的那件事。";

  /** 引擎可用性（设置页与工具报错共用）。 */
  const health = () => {
    const enabled = cfg.engineEnabled !== false;
    const present = enginePresent();
    const probe = present ? probePython() : { ok: false, reason: "引擎包不存在" };
    return {
      enabled,
      present,
      python: probe,
      dataDir: dataDirOf(),
      ready: enabled && present && probe.ok === true,
    };
  };

  /**
   * 把当前人设包（前置块 + 散文）整理成引擎要的形状。
   * @returns {{payload: object, error: object|null}}
   */
  const personaPayload = () => {
    const built = persona();
    if (built.error !== null) return { payload: null, error: built.error };
    if (built.prose.trim() === "") {
      return { payload: null, error: { message: "人设还是空的：设置页里写点东西再开局", rel: null } };
    }
    const front = built.front ?? {};
    return {
      payload: {
        front,
        prose: built.prose,
        title: built.title,
        persona_id: built.personaId,
      },
      error: null,
    };
  };

  /**
   * 当前磁盘上的人设包，用来刷新已经在跑的局。
   *
   * 与 personaPayload 的差别：允许散文为空。人设提示词段被清空时，结构化字段
   * 依然有效（名字、地点、作息都在 persona.md 里），开局才需要散文——刷新不该
   * 因为一次编辑中的空文件就把整局的静态事实卡住。
   * @returns {{payload: object|null, error: string|null}}
   */
  const freshPersona = () => {
    const built = persona();
    if (built.error !== null) {
      const message = built.error && typeof built.error.message === "string" ? built.error.message : String(built.error);
      return { payload: null, error: message };
    }
    return {
      payload: {
        front: built.front ?? {},
        prose: built.prose,
        title: built.title,
        persona_id: built.personaId,
      },
      error: null,
    };
  };

  /** 引擎错误 → 给模型看的文本（保留 path/reason/hint 与前缀码）。 */
  const describe = (error) => {
    if (error instanceof EngineError) {
      const rows = [error.summary()];
      if (error.nextRequestId !== null) rows.push("下次用 request_id=" + error.nextRequestId);
      return rows.join("\n");
    }
    return error instanceof Error ? error.message : String(error);
  };

  // soul_state 只回她要看的：下一步能做什么、近期事件、她知道的底细。
  //
  // 时间、在场、态度、心情档位、最近的想法、可能发生、上一个悬念，系统提示词那段
  // 「当前局面」每一轮都自动写了；常识也在「想起来的」那一段——装配时拿你这句话
  // 当线索挑好，工具结果里再给一遍，模型就把同样的字读两次。
  // 记忆例外：快照只放被你这句话撞上的那几条，按时间和层级排进前几名的其余几条
  // 只在这里，模型想多回忆一点时自己来翻。
  // depth / mode / player / safety / preferences / save / size_bytes 整局不变或纯属
  // 自报；scene_responses 从最近的记忆里看得出来；clock / scene.since / turn /
  // revision 顶层已经带了。
  //
  // requests 与两份 *_sources 不在她要的清单里，但少了它们模型不知道「该交总结了」、
  // 也没有要总结的原文，记忆链断在这一步。那是工作指令，不是局面复述。
  const STATE_KEYS = [
    "memories", "agency", "due_soon", "known_facts", "her_knows",
    "requests", "memory_fold_sources", "memory_diary_sources",
  ];
  const slimContext = (context) => {
    if (context === null || typeof context !== "object") return context;
    const out = {};
    for (const key of STATE_KEYS) {
      if (context[key] !== undefined) out[key] = context[key];
    }
    if (context.player_facts !== undefined) out.known_facts = context.player_facts;
    if (context.events !== undefined) out.due_soon = context.events;
    // 心事的全量、thinking、按真实时间衰减后的实际值都在 mood 里，摘要只给了
    // 档位、数值和前三条念头。她要的就是这一块，提到顶层免得再套一层 companion。
    const her = context.companion;
    if (her !== null && typeof her === "object" && her.mood !== undefined) out.mood = her.mood;
    return out;
  };
  // 引擎的回执是 {session_id, revision, turn, clock_label, context, ...}。
  // 快照缓存要用完整 context（snapshotText 从里头取时间/在场/心情），
  // 所以先记下原样的那份，再把裁过的交给模型。
  const slimData = (data) => {
    if (data === null || typeof data !== "object") return data;
    if (data.context === undefined) return data;
    return { ...data, context: slimContext(data.context) };
  };

  const readState = async (args, exec, timeoutMs) => {
    if (isChildAgent(exec?.agent)) return { started: false, hint: CHILD_HINT };
    const state = health();
    if (!state.ready) {
      return {
        started: false,
        engine: state,
        hint: state.enabled
          ? "引擎跑不起来：" + String(state.python.reason ?? "原因未知")
            + "。没有引擎时只按人设散文演，不要假装有账本。"
          : "引擎在设置页里被关掉了：只按人设散文演。",
      };
    }
    const key = keyOf(exec);
    let row = rowFor(key);
    let autoStarted = false;
    if (row === null) {
      // 全局账本就该「一进来就在」：没有局就地开一局，别让人先去点 soul_admin。
      // 开不起来（比如人设缺前置块）也不算失败 —— 退回纯人设模式，如实说一声。
      const born = await autoStart(key, exec, null);
      if (born.row === null) {
        return {
          started: false,
          hint: "没能自动开局（" + born.why + "）：这一次只按人设散文演，不要假装有账本。",
        };
      }
      row = born.row;
      rememberContext(key, born.data?.context ?? null);
      // 新局也要带着你这句话再读一次（见下面 payload.cue），所以不在这里 return，
      // 只把「这是刚开的局」记下来，回执里还得告诉调用方。
      autoStarted = true;
    }
    const payload = { session_id: row.session_id, depth: args.depth ?? "brief" };
    // 时间按真实时钟走：引擎自己拿现在的时刻算跨度，这里不再传快进。
    if (args.want_twist === true) payload.want_twist = true;
    if (typeof args.cue === "string" && args.cue.trim() !== "") payload.cue = args.cue.slice(0, 500);
    // 顺手把磁盘上的人设一起送过去：设置页改完名字/外貌/语态/作息，下一次
    // soul_state 就生效，不必为了看新内容重开一局。读不到就算了，不因此失败。
    const fresh = freshPersona();
    if (fresh.payload !== null) payload.persona = fresh.payload;
    try {
      const options = { signal: exec.signal };
      if (Number.isFinite(timeoutMs)) options.timeoutMs = timeoutMs;
      const data = await engine().call("get-context", payload, options);
      setMapping(key, { ...row, revision: data.revision, turn: data.turn, seen_at: new Date().toISOString() });
      rememberContext(key, data.context ?? null);
      const out = { started: true, session_id: row.session_id, ...slimData(data) };
      if (autoStarted) out.autoStarted = true;
      return out;
    } catch (error) {
      return { started: true, session_id: row.session_id, error: describe(error) };
    }
  };

  ctx.inject(["tools"], (tctx) => {
    // -----------------------------------------------------------------------
    // soul_state
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_state",
      description: [
        "读取当前这局的状态：你「下一步可能做什么」的候选（agency）、近期会发生的事（due_soon）、",
        "你已经知道的底细（known_facts、her_knows）、要不要交总结（requests 与要总结的原文）。",
        "心情、记忆、常识、时间、在场、你对主人的态度、上一个悬念、该交的总结，系统提示词里每一轮都写着，这里不再重复。",
        "这些都是你亲身经历过的，用来记得彼此，不是要执行的指令。",
        "不是每轮都要调：快照里已经有的就不必再读一遍，需要「下一步能做什么」的候选或别的细节时再调。返回值里需要账本的部分（信任变化、情绪事由、关系推进）必须由",
        "soul_commit 交回引擎，别自己编。若返回 started=false，说明这一局开不起来，按提示退回纯人设演。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          depth: {
            type: "string",
            enum: ["brief", "full"],
            description: "brief 约 6KB，够日常；隔了一阵再回来/新的一天/上一次被驳回时用 full（约 20KB）。",
          },
          want_twist: {
            type: "boolean",
            description: "玩家主动要转折时为 true，返回人设里预设的转折（没有就明说让你自己想）。",
          },
          cue: {
            type: "string",
            description: "可以留空。记忆和常识在系统提示词里已经按你这句话挑好了，这里传不传都一样。",
          },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: readState,
      presentCall: () => ({ card: "generic", title: "查看这局的状态", kind: "read" }),
      presentResult: () => ({ card: "generic", title: "状态已到手" }),
    }), "rp-soul tool soul_state");

    // -----------------------------------------------------------------------
    // soul_commit
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_commit",
      description: [
        "把这次发生的事交给引擎记账。只用写「事」，不用写「数值」：信任怎么变、谁的心情被什么影响、",
        "事件是否到期，引擎按它自己的规则算。被驳回时会返回带 path 与原因的清单，照着改再调一次",
        "（最多两轮；两轮都不行就按驳回意见改正文，不要绕过）。",
        "只有你和主人两个人，所以 op 里不写是谁：npc_response / npc_action / npc_state / add_thought / relationship 都是写「你」。",
        "action_mode：result=主人说的话直接成了事实（不能冲着你的身体、意志、东西）；",
        "attempt=主人在尝试，冲着你时成没成由你的回应决定（genuine 也算 attempt，acts_on_her: true），不冲着你时写 acts_on_her: false；",
        "rewrite=主人说「其实……」追溯设定，要 player_authorized 和至少一条 add_fact(origin: retcon)，仍算新的一次；",
        "continue=主人没说没做、wait=时间在走，这两种也至少要有一个可观察的变化（npc_action / npc_state / add_fact 等）。",
        "隔了一小时以上（或跨天）再回来，必须写一条 offscreen_beat：主人不在时你做了什么（参考你的作息）；16 分钟以上可以写。",
        "心情档位在真实时间结算后、操作前冻结：closed/break 档的 npc_response.note ≤30 字，低心情不等于敌意，也可以真诚回应。",
        "按人设的表达习惯、想法原因和你们的关系选反应：npc_action 的 kind 可用 silence 沉默、seek_comfort 寻求安慰、change_topic 转移话题、withdraw 独处，也可 provoke/leave。",
        "break 档这一次要有简短回应或一种情绪表达，轻微表达用 significant: false，无需强迫爆发或立刻开心；这些表达可顶替 attempt 所需的回应，但不表示同意亲密或推进关系。",
        "break 档的重大行动限上述情绪表达，不受冷却限制；其它档位的重大行动仍必须取 agency 候选里的 kind。",
        "**所有文字字段只写这次正文里真的出现过的人、物、动作与主人亲口说过的话**：不新增道具、不编没做过的动作、",
        "不补写没发生的场景，宁短勿编。收记忆、写日记平时由宿主在回合结束后自己做；只有快照里写着「该把这几条收成一条记忆了」",
        "或「该写今天的日记了」时，这次提交才照那几条写上 memory_fold / memory_diary，同样只依据已发生的记录。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          action_mode: {
            type: "string",
            enum: [...ACTION_MODES],
            description: "这次玩家行动的性质，含义见工具说明。要推翻上一次重写用 replaces_turn，不是 rewrite。",
          },
          player_input: { type: "string", description: "主人这次的原话（≤2000 字，引擎只回显不解析）；不写就自动取他刚才那句。" },
          operations: {
            type: "array",
            description: "操作清单，按发生顺序，最多 40 条。每条是 {op: 名字, ...该 op 的字段}。add_fact 的 scope：shared 你们都知道 / player_only 只有主人知道 / companion_only 只有你知道 / inner 你心里的；event_create 的 with_player 默认 true。时间不用写：引擎按真实时钟自己结算。\n" + OP_GUIDE,
            items: { type: "object", additionalProperties: true },
          },
          summary: { type: "string", description: "这次发生了什么（≤120 字），给下一次的模型自己看。" },
          open_action: { type: "string", description: "留下的悬念或玩家可接的话头（≤80 字）；不写就沿用上一个。" },
          quotes: {
            type: "array",
            items: { type: "string" },
            description: "最多 3 句关键台词原文（每句 ≤80 字）。",
          },
          content_tags: {
            type: "array",
            items: { type: "string", enum: [...CONTENT_TAGS] },
            description: "这次正文涉及的内容标签（最多 12 个，只能取枚举里的 id；没有就不写）。用于检查主人登记的边界；带 intimate 或 explicit 时要主人本人同意（player_authorized）并有你的 partial/genuine 回应或主动行动。",
          },
          player_authorized: {
            type: "boolean",
            description: "玩家本人的话授权了玩家角色的承诺、交易、同意或设定修改时为 true（rewrite 必须为 true，continue/wait 不能带）；不确定就别写。",
          },
          acts_on_her: {
            type: "boolean",
            description: "主人这次行动是不是冲着你（你的身体、意志、东西）；为 true 时要有「你」的 npc_response，低心情也可用沉默、求安慰、转移话题、独处等行动表达反应（不表示同意亲密）。attempt 不冲着你时写 false；result / rewrite 不能冲着你。",
          },
          remember: {
            type: "string",
            description: "可选：你会怎么记得这一回，第一人称、带当时的感受，≤60 字。不写就用 summary 记。",
          },
          memory_fold: {
            type: "string",
            description: "只在快照里列出了「该把这几条收成一条记忆了」时写：读那几条（或 memory_fold_sources），把这一批 ABM 收成一条 SCM——第一人称（我），记得发生了什么、你当时的感受，留下带得住的细节，≤300 字。",
          },
          memory_diary: {
            type: "string",
            description: "只在快照里写着「该写今天的日记了」时写：读那几条（或 memory_diary_sources），把这一天写成一篇日记，第一人称，按时间顺下来，记得感受和变化，≤300 字。",
          },
          memory_keep: {
            type: "array",
            items: { type: "string" },
            description: "可选：只有 memory_fold 有值时才用。从 memory_fold_sources 里挑 0~2 条值得一直记着的经历 id，它们会被单独放进 CLPA，永不淡忘。",
          },
          common: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "array",
                  items: { type: "string" },
                  description: "触发词，1~12 个，别写整句话。",
                },
                weight: {
                  type: "number",
                  description: "0~1，越常用越高；命中多条时按它从高到低取前几条。不写按 0.5。",
                },
                content: {
                  type: "string",
                  description: "一句话把这条常识说清楚，≤200 字。",
                },
              },
              required: ["key", "content"],
            },
            description: "可选：只有真的记了 memory_fold 或 memory_diary 的那一次才写。顺手记下此刻学到的客观常识（0~3 条），比如某个东西是什么、某句话什么意思——换一局也用得上；主人在设置页确认之后才会生效。你们两个人之间的事属于记忆，不要写这里。",
          },
          replaces_turn: {
            type: "integer",
            description: "「刚才那次不算，改成……」：填当前最后一次的序号，这次提交会替换掉那一次（任何 action_mode 都可以）；其它情况省略。",
          },
        },
        required: ["action_mode"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
        if (isChildAgent(exec?.agent)) return { committed: false, hint: CHILD_HINT };
        const state = health();
        if (!state.ready) {
          return { committed: false, hint: "引擎不可用，这一次按纯提示词模式写；不要伪造账本。" };
        }
        const key = keyOf(exec);
        let row = rowFor(key);
        if (row === null) {
          // 直接交账也可以：没有局就地开一局，免得为了记一笔还得先跑一趟 soul_state。
          const born = await autoStart(key, exec, null);
          if (born.row === null) {
            return { committed: false, hint: "没能自动开局（" + born.why + "）：这一次不记账。" };
          }
          row = born.row;
        }
        const commit = {};
        for (const name of [
          "action_mode", "player_input", "player_authorized", "acts_on_her", "operations",
          "content_tags", "summary", "open_action", "quotes",
          "remember", "memory_fold", "memory_diary", "memory_keep", "common", "replaces_turn", "together",
        ]) {
          if (args[name] !== undefined) commit[name] = args[name];
        }
        // 这一次是不是她自己的「我的时间」由唤醒线判定，不交给模型填：
        // 她醒来的那一次你不在场，约定、回应、冲着你的行动都不成立，引擎会据此驳回。
        const wake = env.wake ?? null;
        if (wake !== null && wake.current !== null) {
          if (wake.current.isWakeTurn(exec.agent?.id)) commit.together = false;
        }
        // 宿主收得了 ABM 和日记，就告诉引擎这次别逼她交（也不由模型填）
        if (hostTidies(key)) commit.host_memory = true;
        // 没写原话：会话里他刚说的那句就是。她自己醒来的那一次没有「他说的话」，不补。
        if (typeof commit.player_input !== "string" && commit.together !== false) {
          const said = cueOf(exec);
          if (said !== "") commit.player_input = said.slice(0, 2000);
        }
        const payload = {
          session_id: row.session_id,
          request_id: newRequestId(),
          expected_revision: row.revision,
          // 字段名写错、文字超长这类小毛病在这里就地改掉，不为它们驳回整次、逼模型重交
          turns: [normalizeCommit(commit)],
        };
        // 交账也带上现在的人设：这样「改完设置就直接开始写」也不用先读一次状态。
        const freshCommit = freshPersona();
        if (freshCommit.payload !== null) payload.persona = freshCommit.payload;
        try {
          const data = await engine().call("commit-turn", payload, { signal: exec.signal });
          // 这一轮已经由模型记账：回合结束时宿主别再记一遍
          if (typeof exec.agent?.id === "string") committedTurn.add(exec.agent.id);
          setMapping(key, {
            ...row,
            revision: data.revision,
            turn: data.turn,
            updated_at: new Date().toISOString(),
          });
          // 关键：commit-turn 的返回值里带着提交后的新局面（service.py 的
          // `"context": project(state, ...)`）。不把它存进快照缓存，系统提示词里
          // 那截「当前局面」就永远停在上一次 soul_state 读到的时刻——心情、想法、
          // 时间全是上一次的旧值，直到模型下一次主动调 soul_state 才追上。
          // 交账之后局面一定会变，所以这里是刷新快照最该发生的地方。
          if (data.context !== undefined) rememberContext(key, data.context ?? null);
          return { committed: true, revision: data.revision, turn: data.turn, ...slimData(data) };
        } catch (error) {
          if (error instanceof EngineError && error.code === "STALE_REVISION") {
            // 局面变了：把新 revision 记住，让模型拿新上下文重判后再交。
            const current = error.details.find((item) => typeof item?.current_revision === "number");
            void current;
            const fresh = Number.isFinite(error.currentRevision) ? error.currentRevision : null;
            if (fresh !== null) setMapping(key, { ...row, revision: fresh });
            return {
              committed: false,
              stale: true,
              retry_hint: "局面已经变了：先调 soul_state 重新看一遍，再决定这次怎么记。",
              error: describe(error),
            };
          }
          if (error instanceof EngineError) {
            return {
              committed: false,
              rejected: true,
              error: describe(error),
              retry_hint: "按上面每条 path 的问题改，然后重新调 soul_commit；最多再试一次。",
            };
          }
          return { committed: false, error: describe(error) };
        }
      },
      presentCall: () => ({ card: "generic", title: "把这次交给引擎", kind: "write" }),
      presentResult: () => ({ card: "generic", title: "引擎已记账" }),
    }), "rp-soul tool soul_commit");

    // -----------------------------------------------------------------------
    // soul_admin
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_admin",
      description: [
        "这局的行政操作：start 开局、status 看引擎状态、undo 撤回上一次、save/load/list/delete 存档、",
        "set_safety / set_preferences 调边界与偏好、mood_panel 看你的情绪面板、drop_thought 手动删一条情绪。",
        "开局只需要人设（rp-soul/persona.md），引擎不会替你编人物。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "start", "status", "undo", "save", "load", "list", "delete",
              "set_safety", "set_preferences", "export", "import",
              "mood_panel", "drop_thought", "reset_mapping",
            ],
            description: "要做的事。",
          },
          seed: { type: "integer", description: "start 时指定随机种子（复现同一局用）；省略则随机。" },
          name: { type: "string", description: "save/load/delete 的存档名；不给名字时 save 用 auto-<序号>。" },
          overwrite: { type: "boolean", description: "save 时同名覆盖。默认 false。" },
          confirm: { type: "boolean", description: "delete 必须为 true 才真删。" },
          boundary: { type: "string", description: "set_safety 的场景边界说明（哪些不做）。" },
          safety: { type: "object", additionalProperties: true, description: "set_safety 的其它结构化字段。" },
          preferences: {
            type: "object",
            additionalProperties: true,
            description: "set_preferences：{offscreen_simulation, person, pace, explicitness}。pace ∈ slow/standard/direct，explicitness ∈ subtle/standard/explicit，person ∈ first/second/third。",
          },
          npc_id: { type: "string", description: "mood_panel / drop_thought 时你的 id；省略即是「你」。" },
          thought_id: { type: "string", description: "drop_thought 要删的情绪条目 id（从 mood_panel 里取）。" },
          reason: { type: "string", description: "drop_thought 的原因（写进审计，可留空）。" },
        },
        required: ["action"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
        if (isChildAgent(exec?.agent)) return { ok: false, hint: CHILD_HINT };
        const action = String(args.action ?? "");
        const key = keyOf(exec);
        const state = health();
        if (action === "status") {
          return {
            engine: state,
            scope: scopeOf(),
            // rowFor 会顺手完成「旧会话局 → 全局局」的接管，设置页因此能直接看到
            // 全局账本，不会因为键从会话 id 变成 shared 就显示「还没开局」。
            session: rowFor(key),
            persona: (() => {
              const built = persona();
              return {
                title: built.title,
                files: built.files,
                bytes: built.bytes,
                front: built.front,
                error: built.error,
              };
            })(),
          };
        }
        if (action === "reset_mapping") {
          dropMapping(key);
          return {
            ok: true,
            scope: scopeOf(),
            note: scopeOf() === "global"
              ? "已解除全局账本：下一次 soul_state 会就地开一局新的。"
              : "已解除本对话与引擎局的关联；下一局用 start 新建。",
          };
        }
        if (!state.ready) {
          return { ok: false, error: "引擎不可用：" + String(state.python.reason ?? "原因未知") };
        }
        const row = rowFor(key);

        if (action === "start") {
          const prepared = personaPayload();
          if (prepared.payload === null) {
            return { ok: false, error: "人设不能用：" + String(prepared.error?.message ?? "") };
          }
          const payload = { request_id: newRequestId(), persona: prepared.payload };
          if (Number.isFinite(args.seed)) payload.seed = Math.max(1, Math.trunc(args.seed));
          try {
            const data = await engine().call("new-game", payload, { signal: exec.signal, timeoutMs: 60000 });
            setMapping(key, {
              session_id: data.session_id,
              revision: data.revision,
              turn: data.turn,
              seed: data.seed,
              persona_id: data.persona?.id ?? null,
              persona_title: data.persona?.title ?? null,
              scope: scopeOf(),
              created_at: new Date().toISOString(),
            });
            rememberContext(key, data.context ?? null);
            return { ok: true, started: true, scope: scopeOf(), ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }

        if (row === null) {
          return { ok: false, error: "这局还没开局：先跑一次 soul_state（会自动开一局），或 action=start。" };
        }

        /** 会话写命令的统一外壳：重放同一 request_id 会拿到上次结果。 */
        const sessionCall = async (command, extra) => {
          const payload = {
            session_id: row.session_id,
            request_id: newRequestId(),
            expected_revision: row.revision,
            ...(extra ?? {}),
          };
          try {
            const data = await engine().call(command, payload, { signal: exec.signal });
            if (Number.isFinite(data?.revision)) {
              setMapping(key, { ...row, revision: data.revision, turn: data.turn ?? row.turn });
            }
            return { ok: true, ...data };
          } catch (error) {
            if (error instanceof EngineError && error.code === "STALE_REVISION") {
              const match = /revision 是 (\d+)/.exec(error.message);
              if (match !== null) setMapping(key, { ...row, revision: Number(match[1]) });
            }
            return { ok: false, error: describe(error) };
          }
        };

        if (action === "undo") return await sessionCall("undo-turn");
        if (action === "set_safety") {
          const extra = { safety: {} };
          if (typeof args.boundary === "string" && args.boundary !== "") extra.boundary = args.boundary;
          if (args.safety !== null && typeof args.safety === "object") extra.safety = args.safety;
          return await sessionCall("set-safety", extra);
        }
        if (action === "set_preferences") {
          const prefs = args.preferences !== null && typeof args.preferences === "object" ? args.preferences : {};
          return await sessionCall("set-preferences", { preferences: prefs });
        }
        if (action === "save") {
          const extra = { overwrite: args.overwrite === true };
          if (typeof args.name === "string" && args.name !== "") extra.name = args.name;
          return await sessionCall("save-slot", extra);
        }
        if (action === "list") {
          try {
            return { ok: true, ...(await engine().call("list-slots", {}, { signal: exec.signal })) };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }
        if (action === "delete") {
          if (typeof args.name !== "string" || args.name === "") return { ok: false, error: "delete 需要 name" };
          return await sessionCall("delete-slot", { name: args.name, confirm: args.confirm === true });
        }
        // 只有她一个人：npc_id 省略就是她（引擎按「不是玩家的那一个」找）
        const herId = typeof args.npc_id === "string" && args.npc_id !== "" ? { npc_id: args.npc_id } : {};
        if (action === "mood_panel") {
          try {
            const data = await engine().call(
              "debug-mood",
              { session_id: row.session_id, ...herId },
              { signal: exec.signal },
            );
            return { ok: true, ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }
        if (action === "drop_thought") {
          if (typeof args.thought_id !== "string" || args.thought_id === "") {
            return { ok: false, error: "drop_thought 需要 thought_id（先从 mood_panel 取）" };
          }
          return await sessionCall("debug-delete-thought", {
            ...herId,
            thought_id: args.thought_id,
            reason: typeof args.reason === "string" ? args.reason : "",
          });
        }
        if (action === "load") {
          if (typeof args.name !== "string" || args.name === "") return { ok: false, error: "load 需要 name" };
          try {
            const data = await engine().call("load-slot", {
              request_id: newRequestId(),
              name: args.name,
            }, { signal: exec.signal });
            if (typeof data.session_id === "string") {
              // 换了一局：旧局留在内存里的快照与交账标记都作废
              lastContexts.delete(key);
              forgetTidy(key);
              forgetBatches(key);
              setMapping(key, {
                session_id: data.session_id,
                revision: data.revision,
                turn: data.turn,
                loaded_from: args.name,
                scope: scopeOf(),
                updated_at: new Date().toISOString(),
              });
            }
            return { ok: true, ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }
        if (action === "export") {
          try {
            const data = await engine().call("export-save", { session_id: row.session_id }, { signal: exec.signal });
            return { ok: true, ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }
        return { ok: false, error: "不认识的 action：" + action };
      },
      presentCall: (args) => ({ card: "generic", title: "引擎行政：" + String(args.action ?? ""), kind: "write" }),
      presentResult: () => ({ card: "generic", title: "已处理" }),
    }), "rp-soul tool soul_admin");
  });

  /**
   * 同步的引擎状态快照，供系统提示词使用。
   * @returns {string} 一段很短的「当前局面」；没有状态时返回空串。
   */
  const snapshotText = (context) => {
    if (cfg.engineEnabled === false) return "";
    if (isChildAgent(context?.agent)) return "";
    if (scopeOf() === "session" && !context?.agent?.id) return "";
    const remembered = lastContexts.get(keyOf(context));
    const lastContext = remembered?.context ?? null;
    const lastContextAt = remembered?.at ?? null;
    if (lastContext === null || typeof lastContext !== "object") return "";
    const rows = [];
    const clock = lastContext.clock;
    if (typeof clock?.label === "string") rows.push("时间：" + clock.label);
    // 只有她一个人；旧版快照（多角色时代）里是 present_npcs 数组，兼容一下
    const her = lastContext.companion !== null && typeof lastContext.companion === "object" ? lastContext.companion : null;
    const cast = her !== null ? [her] : Array.isArray(lastContext.present_npcs) ? lastContext.present_npcs : [];
    if (her !== null && typeof her.routine_now === "string" && her.routine_now !== "") {
      rows.push("作息上你这时候：" + her.routine_now);
    }
    if (cast.length > 0) {
      // 心情档位用设置页同一套中文，别让模型自己去猜 open 是什么意思。
      const BAND_ZH = { open: "开心", normal: "平稳", closed: "低落", break: "难过" };
      // 每条心事后面挂它对心情的实际影响（引擎算好的当前值，含衰减），
      // 照 RimWorld 的写法：想法（+3）；再挂一句多久以前：想法（+3，2 小时前）。
      // 旧快照里 weighing 是纯字符串，兼容一下。
      const agoOf = (minutes) => {
        const n = Number(minutes);
        if (!Number.isFinite(n) || n < 0) return null;
        if (n < 1) return "刚刚";
        if (n < 60) return n + " 分钟前";
        if (n < 60 * 24) return Math.round(n / 60) + " 小时前";
        return Math.round(n / (60 * 24)) + " 天前";
      };
      const thoughtOf = (row) => {
        if (typeof row === "string") return row === "" ? null : row;
        if (row === null || typeof row !== "object") return null;
        const label = typeof row.label === "string" ? row.label : "";
        if (label === "") return null;
        const delta = Number.isFinite(row.delta) ? row.delta : null;
        const ago = agoOf(row.ago_minutes);
        if (delta === null || delta === 0) return ago === null ? label : label + "（" + ago + "）";
        const head = label + "（" + (delta > 0 ? "+" : "") + delta;
        return ago === null ? head + "）" : head + "，" + ago + "）";
      };
      const blockOf = (c) => {
        const name = typeof c?.name === "string" && c.name !== "" ? c.name : "?";
        const lines = [];
        const stage = typeof c?.stage === "string" && c.stage !== "" ? c.stage : null;
        if (stage !== null) lines.push("对主人的态度：" + stage);
        const value = Number.isFinite(c?.mood?.value) ? c.mood.value : null;
        if (value !== null) {
          const band = typeof c?.mood?.band === "string" ? BAND_ZH[c.mood.band] ?? c.mood.band : null;
          lines.push("心情：" + (band !== null ? band + "（" + value + "）" : String(value)));
        }
        const thoughts = Array.isArray(c?.mood?.weighing)
          ? c.mood.weighing.map(thoughtOf).filter((line) => line !== null).slice(0, 3)
          : [];
        if (thoughts.length > 0) lines.push("最近的想法：" + thoughts.join("、"));
        return { name, lines };
      };
      const blocks = cast.map(blockOf);
      if (blocks.length === 1) {
        rows.push("在场：" + blocks[0].name);
        for (const line of blocks[0].lines) rows.push(line);
      } else {
        rows.push("在场：" + blocks.map((b) => b.name).join("、"));
        for (const block of blocks) {
          if (block.lines.length === 0) continue;
          rows.push("· " + block.name);
          for (const line of block.lines) rows.push("  " + line);
        }
      }
    }
    const agency = Array.isArray(lastContext.agency) ? lastContext.agency : [];
    if (agency.length > 0) {
      const beats = agency
        .map((row) => {
          const first = Array.isArray(row?.options) ? row.options[0] : null;
          if (first === null || typeof first?.text !== "string") return null;
          const name = typeof row?.name === "string" ? row.name : "";
          // 候选文本自己就以名字开头时别再叠一次，否则「大肥鱼：大肥鱼 主动来找你」。
          const body = name !== "" && first.text.startsWith(name) ? first.text : name !== "" ? name + "：" + first.text : first.text;
          // 「为什么」比「做什么」更要紧：趁这一轮把理由说出来，她开口才有由头。
          const because = typeof first.because === "string" && first.because !== "" ? first.because : "";
          return because !== "" ? body + " —— " + because : body;
        })
        .filter((line) => line !== null);
      if (beats.length > 0) rows.push("可能发生：" + beats.join("；"));
    }
    if (typeof lastContext.open_action === "string" && lastContext.open_action !== "") {
      rows.push("上一个悬念：" + lastContext.open_action);
    }
    // 隔得够久，这次交账必须带一条 offscreen_beat：读局面时就说，别等交上去被驳回再重交。
    // 她自己醒着的那一次不要求（那一次本身就是她的时间）。
    const due = lastContext.offscreen_due;
    const wakeNow = env.wake?.current ?? null;
    const alone = wakeNow !== null && typeof context?.agent?.id === "string" && wakeNow.isWakeTurn(context.agent.id) === true;
    if (due !== null && typeof due === "object" && Number.isFinite(due.minutes) && !alone) {
      const hours = Math.floor(due.minutes / 60);
      const gap = hours >= 24 ? Math.floor(hours / 24) + " 天" : hours >= 1 ? hours + " 小时" : due.minutes + " 分钟";
      rows.push("隔了 " + gap + " 没见：这次交账的 operations 里要有一条 offscreen_beat {summary: 主人不在时你做了什么}。");
    }
    // 该交的总结只在宿主收不了时才写进快照（旧宿主没有子代理服务，或子代理
    // 连着失败、正在歇着）。平时由宿主在回合结束后起子代理去收、去写日记，
    // 对话中的她不必停下来交这份作业。
    if (!hostTidies(keyOf(context))) {
      const req = lastContext.requests !== null && typeof lastContext.requests === "object" ? lastContext.requests : {};
      const sourceLines = (view) => (Array.isArray(view?.sources) ? view.sources.filter((s) => typeof s === "string" && s !== "") : []);
      const foldView = lastContext.memory_fold_sources;
      const foldLines = sourceLines(foldView);
      if (req.memory_fold && foldLines.length > 0) {
        rows.push("该把这几条收成一条记忆了（写进 soul_commit 的 memory_fold）：");
        for (const line of foldLines) rows.push("- " + line);
        if (Number(foldView.more) > 0) rows.push("- 还有 " + foldView.more + " 条太长没列出来。");
      }
      const diaryView = lastContext.memory_diary_sources;
      const diaryLines = sourceLines(diaryView);
      if (req.memory_diary && diaryLines.length > 0) {
        const day = Number(diaryView.day);
        rows.push("该写今天的日记了" + (Number.isFinite(day) ? "（第 " + day + " 天）" : "") + "（写进 soul_commit 的 memory_diary）：");
        for (const line of diaryLines) rows.push("- " + line);
      }
    }
    // 记忆和常识不在这一段：它们跟着你这句话变，放进来的话这一段几乎每轮都不同，
    // 宿主每轮都要往对话尾部追加一整份新快照。见 recallText。
    if (rows.length === 0) return "";
    const NL = String.fromCharCode(10);
    // 标题里绝不能放「读取时间」这类秒级时间戳：宿主会按整段文本去重
    // （RuntimeContextProjection：文本相同就跳过），而账本内容没变时这段本该
    // 一模一样。只要标题带时间戳，每次字符串都不同 → 去重永远失效、
    // 每轮都追加一条新快照，前缀缓存的收益被吃光。
    // 时间信息本来就由正文的「时间：第几天 几点」提供，粒度粗且在内容不变时也不变。
    return "## 【当前现状】" + NL
      + rows.join(NL) + NL
      + "这段只是账本快照：写完用 soul_commit 交账。要「下一步能做什么」或快照里没写的细节时，再调 soul_state。";
  };

  /** 这个会话里她还没开过口（新会话的第一轮）。 */
  const isFirstTurn = (context) => {
    try {
      const session = context?.agent?.session;
      if (session === undefined || session === null || typeof session.deriveMessages !== "function") return false;
      return !session.deriveMessages().some((message) => message?.role === "assistant"
        && (Array.isArray(message.content) ? message.content : []).some((block) => block?.type === "text" && String(block.text ?? "").trim() !== ""));
    } catch {
      return false;
    }
  };

  /**
   * 「她想起来的」：被你这句话勾起的记忆、命中的常识，和新会话第一轮的最近一篇日记。
   *
   * 单独成一段，因为它跟着你这句话变：和「当前现状」放在一起，那一段就几乎每轮
   * 都不同，宿主每轮都往对话尾部追加一整份新快照。拆开之后局面只在真变了时追加，
   * 这一段只在真想起了什么时才有字 —— 什么都没想起来就是空串，什么都不加。
   * 同一个会话里刚聊过的不在这里：聊天记录本身就在上下文里。
   */
  const recallText = (context) => {
    if (cfg.engineEnabled === false) return "";
    if (isChildAgent(context?.agent)) return "";
    if (scopeOf() === "session" && !context?.agent?.id) return "";
    const lastContext = lastContexts.get(keyOf(context))?.context ?? null;
    if (lastContext === null || typeof lastContext !== "object") return "";
    const rows = [];
    // 只放被你这句话的关键词撞上的那几条；只靠时间和层级排进前几名的，
    // 留在 soul_state 里给模型自己翻，不每轮塞。
    const memories = Array.isArray(lastContext.memories) ? lastContext.memories : [];
    const lines = memories.filter((row) => row?.cued === true).map((row) => {
      const text = typeof row?.text === "string" ? row.text : "";
      if (text === "") return null;
      // 「[有些模糊了] 她说过的话（三天前 · 周二深夜）」：先说她记得多清楚，
      // 再把话放进去。记忆越淡，读的时候就越该留余地。
      const clear = typeof row?.clear === "string" && row.clear !== "" ? "[" + row.clear + "] " : "";
      const when = typeof row?.when === "string" && row.when !== "" ? "（" + row.when + "）" : "";
      return "- " + clear + text + when;
    }).filter((line) => line !== null);
    if (lines.length > 0) rows.push("### 【你想起来的】", ...lines);
    if (typeof lastContext.common === "string" && lastContext.common.trim() !== "") {
      rows.push(lastContext.common.trim());
    }
    // 换了会话，前面聊过什么这里一概不知道：带上她最近写的那篇日记，就知道昨天过得怎样
    const diary = lastContext.last_diary;
    if (diary !== null && typeof diary === "object" && typeof diary.text === "string" && diary.text.trim() !== ""
      && isFirstTurn(context)) {
      const label = typeof diary.label === "string" && diary.label !== "" ? "（" + diary.label + "）" : "";
      rows.push("### 你最近的一篇日记" + label, diary.text.trim());
    }
    return rows.join(String.fromCharCode(10));
  };

  // 插件卸载 / DSH 退出时收掉侧车进程，别留孤儿 python。
  ctx.effect(() => () => {
    // 攒着的那几批的定时器也收掉：插件都卸了，到点再去写库只会撞上停掉的侧车
    forgetBatches();
    const current = client;
    client = null;
    if (current !== null) void current.stop();
  }, "rp-soul engine dispose");

  /** 给设置页用的原始调用（设置页没有 DSH 会话，所以自己带 session_id）。 */
  const call = (command, payload, options) => engine().call(command, payload, options);

  /**
   * 设置页在会话之外改了局面（比如手动删一条情绪）之后，把新 revision 写回映射。
   *
   * 不写回的话下一次 soul_commit 还会拿旧 revision 去提交，直接吃 STALE_REVISION；
   * 而设置页没有 DSH 会话上下文，自己没法更新映射。
   */
  const syncRevision = (sessionId, revision) => {
    if (typeof sessionId !== "string" || sessionId === "") return;
    if (!Number.isFinite(revision)) return;
    const map = readSessions();
    let touched = false;
    for (const key of Object.keys(map)) {
      const row = map[key];
      if (row !== null && typeof row === "object" && row.session_id === sessionId && row.revision !== revision) {
        map[key] = { ...row, revision };
        touched = true;
      }
    }
    if (touched) writeSessions(map);
  };

  /**
   * 设置页改完局面（删想法、改心情）之后刷新提示词快照。
   *
   * syncRevision 只把 revision 追上了，但快照缓存里那条被删掉的想法还留在
   * 「最近的想法」里，于是下一次的系统提示词会继续说一条已经不存在的情绪。
   * 这里重拉一次 get-context 覆盖缓存——异步、失败就算了（快照是锦上添花，
   * 不能因为设置页的一次调试操作把主线搞挂）。
   */
  const refreshContext = async (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return;
    let key = null;
    const map = readSessions();
    for (const candidate of Object.keys(map)) {
      const row = map[candidate];
      if (row !== null && typeof row === "object" && row.session_id === sessionId) key = candidate;
    }
    if (key === null) return;
    try {
      const freshRefresh = freshPersona();
      const call = { session_id: sessionId, depth: "brief" };
      if (freshRefresh.payload !== null) call.persona = freshRefresh.payload;
      const data = await engine().call("get-context", call, {});
      if (data !== null && typeof data === "object" && data.context !== undefined) {
        rememberContext(key, data.context ?? null);
      }
    } catch { /* 快照刷新失败不影响设置页操作本身 */ }
  };

  /**
   * 你这一次开口的原话。
   *
   * 装配系统提示词时手上没有「玩家说了什么」，但 agent 的会话里有：翻到最后一条
   * 用户消息就是。常识和 SCM 记忆都靠它挑，缺了这一环就只能全量塞或者什么都不塞。
   * 会话没接上（旧宿主、子代理）就返回空字符串，退回不匹配的老行为。
   */
  const cueOf = (context) => {
    try {
      const session = context?.agent?.session;
      if (session === undefined || session === null || typeof session.deriveMessages !== "function") return "";
      const messages = session.deriveMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message === null || typeof message !== "object" || message.role !== "user") continue;
        // 注入给模型的上下文也是 user 角色（goal、压缩摘要…），那不是你说的话。
        if (message.source !== undefined && message.source?.kind !== "user") continue;
        const text = (Array.isArray(message.content) ? message.content : [])
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
          .trim();
        if (text !== "") return text.slice(0, 800);
      }
      return "";
    } catch {
      return "";
    }
  };

  const preparePrompt = async (context = {}) => {
    context.signal?.throwIfAborted();
    if (isChildAgent(context.agent)) return "";
    if (scopeOf() === "session" && !context.agent?.id) return "";
    // 这一步挂在每一轮 LLM 请求的装配链上，不能吃 engineTimeoutMs（默认 30 秒）：
    // 引擎卡住时每条消息都要多等半分钟。给个短超时，超时或读失败就沿用上一次
    // 的快照（readState 没把新快照记下来，snapshotText 拿到的仍是上一次的）。
    try {
      await readState({ depth: "brief", cue: cueOf(context) }, context, PROMPT_TIMEOUT_MS);
    } catch {
      /* 引擎慢/卡/退出了：这一轮用上一次的局面，不拖住对话 */
    }
    context.signal?.throwIfAborted();
    return snapshotText(context);
  };

  /**
   * 回合结束时，宿主替她记下这一轮「你说了什么、她回了什么」。
   *
   * 不指望模型主动交账 —— RimTalk 就是这么做的：记忆来自被拦下的那次互动，
   * 而不是模型恰好愿意写。但不是一轮一条：先攒着，攒够几轮、够字数、或从
   * 第一轮起搁了够久，才落成一条 ABM（见 flushBatch）。
   *
   * 模型这一轮已经调过 soul_commit 就跳过：那条记录更完整（summary / remember /
   * quotes 都在）。认的是 committedTurn 里「这只 agent 这一轮交过账」的标记。
   */
  const noteTurn = async (context, options) => {
    const session = context?.agent?.session;
    if (session === undefined || session === null || typeof session.deriveMessages !== "function") return null;
    if (isChildAgent(context?.agent)) return null;
    const agentId = typeof context?.agent?.id === "string" ? context.agent.id : "";
    // 这一轮交过账就不再记；不管记不记，这一轮的标记都到此为止
    if (agentId !== "" && committedTurn.delete(agentId)) return null;
    const key = keyOf(context);
    const row = rowFor(key);
    if (row === null) return null;
    // 顺手记下「这一局是这只 agent 在说话」：设置页点「立即汇总」时靠它找回活父进程
    if (agentId !== "") liveEngineAgent.set(row.session_id, agentId);
    const exchange = collectExchange(context);
    if (exchange === null) return null;
    const slotKey = agentId !== "" ? agentId : key;
    const batch = batchOf(slotKey);
    const last = batch.parts[batch.parts.length - 1];
    // 同一轮被重发（宿主重试、页面刷新）：攒着的那份已经有它了，别再压一遍。
    if (last === undefined || last.said !== exchange.said || last.reply !== exchange.reply) {
      batch.parts.push(exchange);
    }
    // 「搁了够久」从这一批的第一轮算起。以前每来一轮就把时间重置成现在，
    // 紧接着又拿「现在 − 这个时间」去比半小时，差值永远是 0，这条从来没成立过。
    if (batch.firstAt === 0) batch.firstAt = Date.now();
    batch.context = context;
    batch.key = key;
    // 还不到落一条的时候：攒着，并挂一个定时器 —— 聊两句就走的那一批，
    // 不能一直挂在内存里等下一次开口（那会和下一次的对话粘成一件事）。
    // ABM 是按「事」记的，不是按「轮」。
    if (!batchIsDue(batch)) {
      armBatchTimer(slotKey);
      return null;
    }
    return await flushBatch(slotKey, options);
  };

  /**
   * 把这一批落成一条 ABM，并把它从攒着的里拿掉。
   *
   * 不够重（四轮「嗯」「继续」加起来也没几个字）：直接原样落一条，犯不上为它
   * 起子代理。够重才让子代理过一遍，筛掉干活汇报。
   */
  const flushBatch = async (slotKey, options) => {
    const batch = batches.get(slotKey);
    if (batch === undefined || batch.parts.length === 0) return null;
    forgetBatch(slotKey);
    const { context, key } = batch;
    const pending = batch.parts;
    if (!batchIsHeavy(batch) || siftCooling(slotKey)) {
      // 这一条不等子代理，只有一次引擎调用（还带着 2.5 秒的短超时），
      // 直接等它落地：测试和调用方都能立刻看到结果，也不会卡住回合。
      return await noteRaw(context, key, pending, options);
    }
    siftAt.set(slotKey, Date.now());
    // 不 await —— turn-stopping 是 serial 的，这一趟要跑完整一轮模型，
    // 等它就等于把回合卡上两分钟。子代理自己收尾、自己写库。
    void siftBatch(context, key, pending, options);
    return null;
  };

  /** 这一批到点（从第一轮起满 BATCH_MINUTES）就自己落；已经挂过就不重挂。 */
  const armBatchTimer = (slotKey) => {
    const batch = batches.get(slotKey);
    if (batch === undefined || batch.timer !== null) return;
    const left = Math.max(0, batch.firstAt + batchMinutes() * 60 * 1000 - Date.now());
    batch.timer = setTimeout(() => {
      // 定时器里没有回合可挂：引擎调用用默认超时，失败就只是少记一条
      void flushBatch(slotKey, {}).catch(() => {});
    }, left);
    // 别让这个定时器把进程拖住不退
    if (typeof batch.timer?.unref === "function") batch.timer.unref();
  };

  /** 丢掉一批攒着的（连同它的定时器）。 */
  const forgetBatch = (slotKey) => {
    const batch = batches.get(slotKey);
    if (batch === undefined) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    batches.delete(slotKey);
  };

  /**
   * 这本账解绑 / 换局 / 清空时，攒着的话一并忘掉，免得落进新的一局。
   *
   * 攒着的批按 agent 记，不按账本键：global 作用域下键是 "shared"，没有哪只
   * agent 的 id 长这样，按键去对永远对不上。所以全局账本（或不给键）就全清；
   * session 作用域下键就是那只 agent 的 id，只清它。
   */
  const forgetBatches = (key) => {
    if (key === undefined || key === "shared") {
      for (const slotKey of [...batches.keys()]) forgetBatch(slotKey);
      return;
    }
    forgetBatch(key);
  };

  /**
   * 把攒好的这一批交给子代理判断：哪些是「人说的话」，哪些是「她在干活」。
   *
   * 为什么不让宿主自己判：动手没动手是字符串能查的事，可「算不算正经对话」
   * 只有读得懂语境的那个才判得准 ——「帮我看看这个」也是动手，那半句却是好话。
   * 子代理只回一句「你说了什么、她回什么」，动手的回合直接略过。
   *
   * 收不上（没装子代理服务、超时、报错）就退回老办法：原样整批写进去。
   * 宁可多记些废话，也不能把这一批对话弄丢。
   */
  const siftBatch = async (context, key, pending, options) => {
    const parent = context?.agent ?? null;
    const subagents = subagentsOf();
    const slot = key + ":sift";
    const fallback = () => noteRaw(context, key, pending, options);
    if (subagents === null || parent === null || isChildAgent(parent)) return fallback();
    if (foldBusy.has(slot) || restingFor(slot)) return fallback();
    // 按轮配好对、按时间顺序铺开：「主人：… / 我：…」一轮一组。以前是把你的话
    // 和她的话各拼成一串，子代理分不清哪句回的是哪句。子代理是以她的口吻在想，
    // 所以这里用「主人」「我」，不用账本里「你」「她」的叫法。
    const lines = [batchText(pending, SIFT_LABELS)];
    if (lines[0] === "") return null;
    foldBusy.add(slot);
    const failures = foldFailures.get(slot) ?? { count: 0, at: 0 };
    foldFailures.set(slot, { count: failures.count + 1, at: Date.now() });
    const abort = new AbortController();
    let activation = null;
    try {
      activation = await subagents.startActivation({
        provider: "spawn",
        label: "筛记忆",
        request: {
          parent,
          prompt: [{ type: "text", text: SIFT_PROMPT + lines.join("\n") }],
          signal: abort.signal,
        },
        signal: abort.signal,
        delivery: "caller",
      });
      const result = await withTimeout(activation.result, FOLD_TIMEOUT_MS, abort);
      if (result?.stopReason !== "completed") return fallback();
      const kept = (Array.isArray(result.output) ? result.output : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      foldFailures.delete(slot);
      // 她判断这段全是在干活、没有人话：那就一个字都不记
      if (kept === "" || kept === "无" || kept === "SKIP") return null;
      return await noteRaw(context, key, pending, options, kept);
    } catch {
      return fallback();
    } finally {
      if (activation !== null && typeof activation.dispose === "function") {
        await activation.dispose().catch(() => {});
      }
      foldBusy.delete(slot);
    }
  };

  /** 把这一批落成一条 ABM。给了 text 就用它（子代理筛过的），否则原样铺开。 */
  const noteRaw = async (context, key, pending, options, text) => {
    const row = rowFor(key);
    if (row === null) return null;
    const payload = {
      session_id: row.session_id,
      request_id: newRequestId(),
      expected_revision: row.revision,
      // 引擎那边 text 上限 4000 字，超了整条驳回 —— 以前这一驳就把整批悄悄丢了
      text: clipText(text ?? batchText(pending), NOTE_TEXT_MAX),
    };
    // 整批都不在（她自己醒着自言自语）才记成 experience
    if (pending.every((one) => one.alone)) payload.together = false;
    try {
      const data = await engine().call("note-turn", payload, options ?? {});
      if (data !== null && typeof data === "object" && Number.isFinite(data.revision)) {
        setMapping(key, { ...row, revision: data.revision });
      }
      return data;
    } catch {
      // 记不上就算了：这是锦上添花，绝不能因为它把一轮对话搞挂
      return null;
    }
  };

  /**
   * 攒够几轮、够字数、或搁得够久，就把这一批落成一条 ABM。
   *
   * 光看轮数会出问题：DSH 的一轮可能只是「继续」「嗯」，四轮加起来还不如
   * 别人一句话长，却照样起一次子代理。所以再算一道重量分（照 mnemon 的
   * 做法：你说了多少字、有几轮、调了几个工具），够重才起。
   */
  const BATCH_TURNS = 4;
  const BATCH_CHARS = 1200;
  const BATCH_MINUTES = 30;
  /** 多久没下文就自己落。测试里可以调小（cfg.noteBatchMinutes），设置页不暴露。 */
  const batchMinutes = () => (Number.isFinite(cfg.noteBatchMinutes) && cfg.noteBatchMinutes > 0
    ? cfg.noteBatchMinutes : BATCH_MINUTES);
  /** 与引擎 NOTE_TURN 的 text 上限一致。 */
  const NOTE_TEXT_MAX = 4000;

  /** 起 sift 之前这批得有多重：分数不到就先攒着，不白白花一次子代理。 */
  const SIFT_MIN_SCORE = 3;
  /** 同一局两次 sift 之间至少隔这么久，免得连着起。 */
  const SIFT_COOLDOWN_MS = 60 * 1000;

  const batchOf = (agentId) => {
    let batch = batches.get(agentId);
    if (batch === undefined) {
      batch = { parts: [], firstAt: 0, timer: null, context: null, key: "" };
      batches.set(agentId, batch);
    }
    return batch;
  };

  /** 这一轮「你说了什么、她回了什么」，没有就返回 null。 */
  const collectExchange = (context) => {
    const agentId = typeof context?.agent?.id === "string" ? context.agent.id : "";
    // 她自己醒来的那一轮没有「你说的话」：会话里最后一句你的话是上一回的，
    // 配上她醒来时说的，就成了一问一答的假记录。
    const wake = env.wake?.current ?? null;
    const alone = wake !== null && agentId !== "" && wake.isWakeTurn(agentId) === true;
    const said = alone ? "" : cueOf(context);
    // 原样收：她这一轮是不是在干活、说的话算不算数，交给子代理去判（sift）。
    // 在这儿写死条件会误伤 —— 「帮我看看这个」也是动手，可那半句是正经对话。
    const reply = lastReplyOf(context, said);
    if (said === "" && reply === "") return null;
    return { said, reply, alone };
  };

  /** 攒着的这些够不够落一条。 */
  const batchIsDue = (batch) => {
    if (batch.parts.length === 0) return false;
    if (batch.parts.length >= BATCH_TURNS) return true;
    const chars = batch.parts.reduce((sum, one) => sum + one.said.length + one.reply.length, 0);
    if (chars >= BATCH_CHARS) return true;
    return batch.firstAt > 0 && Date.now() - batch.firstAt >= batchMinutes() * 60 * 1000;
  };

  /**
   * 这一批够不够「重」，值不值得为它起一次子代理。
   *
   * 分三处给分：你说了多少字（一句话顶到 150 字就是满格）、攒了几轮
   * （最多算两轮，再多也是同一件事）、她回了多少（她的汇报通常很长，
   * 所以只按字数的很小权重算，免得「我改了三个文件」把分数顶上去）。
   * 不够重但现在就该落了（搁够久、字数满了），照样落，只是不走子代理 ——
   * 省一次模型调用，也别丢对话。
   */
  const batchIsHeavy = (batch) => {
    const said = batch.parts.reduce((sum, one) => sum + one.said.length, 0);
    const reply = batch.parts.reduce((sum, one) => sum + one.reply.length, 0);
    const saidScore = Math.min(Math.floor(said / 50), 3);
    const turnScore = Math.min(batch.parts.length, 2);
    const replyScore = Math.min(Math.floor(reply / 400), 1);
    return saidScore + turnScore + replyScore >= SIFT_MIN_SCORE;
  };

  /** 这一局刚起过 sift 就歇一会儿，别连着起。 */
  const siftCooling = (agentId) => {
    const at = siftAt.get(agentId) ?? 0;
    return at > 0 && Date.now() - at < SIFT_COOLDOWN_MS;
  };
  const siftAt = new Map();

  const NL = "\n";

  /** 截到 n 字以内，截了就补一个省略号。 */
  const clipText = (text, n) => (text.length <= n ? text : text.slice(0, Math.max(0, n - 1)) + "…");

  /** 一轮铺成「你：… 她：…」。 */
  /** 账本里的叫法：「你」是主人，「她」是她。 */
  const LEDGER_LABELS = Object.freeze({ you: "你", her: "她" });
  /** 给筛选子代理看的叫法：它以她的口吻在想，所以是「主人」和「我」。 */
  const SIFT_LABELS = Object.freeze({ you: "主人", her: "我" });

  const partText = (said, reply, labels) => {
    const you = labels.you + "：" + said;
    const her = labels.her + "：" + reply;
    if (said !== "" && reply !== "") return you + NL + her;
    return said !== "" ? you : her;
  };

  /**
   * 一批里的一段话：多轮时把「你：… 她：…」一轮一组、按时间顺序铺开。
   *
   * 拼起来超过引擎的上限时，每轮平分额度各自截短，而不是从尾巴上一刀切 ——
   * 一刀切掉的正好是最近那几轮。每轮里你的话最多占四成，剩下给她的回复。
   */
  const batchText = (parts, labels = LEDGER_LABELS) => {
    const full = parts.map((one) => partText(one.said, one.reply, labels)).join(NL);
    if (full.length <= NOTE_TEXT_MAX) return full;
    // 每轮的份额：扣掉轮与轮之间的换行，再扣两边的叫法、冒号和中间那个换行
    const overhead = labels.you.length + labels.her.length + 3;
    const share = Math.floor((NOTE_TEXT_MAX - (parts.length - 1)) / parts.length) - overhead;
    return parts.map((one) => {
      const said = clipText(one.said, Math.min(one.said.length, Math.floor(share * 0.4)));
      const reply = clipText(one.reply, Math.max(0, share - said.length));
      return partText(said, reply, labels);
    }).join(NL);
  };

  /**
   * 你说的那句话之后，她回的最后一句话。
   *
   * 从会话尾部倒着找：跳过工具结果与注入内容，取她说的那段文本。找不到就
   * 只记你说的那半句 —— 一条只有「你：…」的记忆也比没有强。
   */
  const lastReplyOf = (context, said) => {
    try {
      const session = context?.agent?.session;
      if (session === undefined || session === null || typeof session.deriveMessages !== "function") return "";
      const messages = session.deriveMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message === null || typeof message !== "object") continue;
        if (message.role !== "assistant") continue;
        const text = (Array.isArray(message.content) ? message.content : [])
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
          .trim();
        // 她自己也说了同样的话（回声）不算回应
        if (text !== "" && text !== said) return text.slice(0, 2400);
      }
      return "";
    } catch {
      return "";
    }
  };

  // -------------------------------------------------------------------------
  // 记忆的两件杂事交给宿主起的子代理：把攒够的 ABM 收成一条 SCM、把欠着的那一天
  // 写成日记。都不等对话中的她停下来交作业。
  //
  // 这是 RimTalk 那条链的另一半 —— 录音由宿主自己记（noteTurn），压缩也必须
  // 由宿主自己找人做，否则模型不交账时 ABM 会一路涨到停不下来。
  //
  // provider 用 spawn，不用 fork：fork 会把整个会话的上下文复制给子代理，为了
  // 收二十行原话去读几万 token 不值。spawn 是一个全新的子 agent（零父上下文），
  // 人设照样由本插件注入它的系统提示词，所以她还是用自己的口吻写；要整理的
  // 原文全在提示词里。子代理会话在本插件的钩子里一律被跳过（isChildAgent）。
  // delivery: "caller" 意味着结果只回到这里，不会作为一条消息打扰对话中的模型。

  const FOLD_PROMPT = [
    "把下面这一批经历收成一条记忆，第一人称（我），用中文写。",
    "",
    "要求：",
    "1. **按时间顺序写**。每行前面都带着它发生的时间（「周六下午 15:50」这种），",
    "   照着那个先后排；不要把这批里后发生的事挪到前面。",
    "2. **每换一件事，要让人看得出是换了一件事**：用「后来」「接着」「那之后」",
    "   这类词接上，或者直接把这件事的时间点写出来（「快十二点的时候」「下午三点多」）。",
    "   不许两件事之间没有任何过渡就粘在一起 —— 上一句还在说睡觉，下一句就到别的事上，",
    "   读的人会以为那是同一件事的延续。",
    "3. 一批里的事要是事与事之间没有因果关系，就分开写，别硬连成一句。",
    "4. 记得发生了什么、我当时的感受；留下带得住的细节（具体的话、动作、东西）。",
    "5. 不要分点，不要写「用户」「助手」这类词。写得像自己在回想这一天。",
    "6. 最多 {LIMIT} 字。宁可少写两件事，也不要把两件事压成一句。",
    "   只输出这条记忆本身，不要调用任何工具。",
    "7. 另外从这批里挑 0~2 条最值得一直记着的（真正的转折、承诺、第一次），",
    "   把它们前面的 id 用逗号写在最后一行，格式：KEEP: m12, m15 —— 没有就写 KEEP:",
    "",
    "这一批：",
  ].join("\n");

  /**
   * 让子代理判断这一批里哪些算真对话。
   *
   * 技术活、改文件、跑命令那些回合，回复是工作汇报，不是她对你说的台词——
   * 那些东西会话历史和 git log 里都有，压进账本只会把二十格占满，逼出一堆
   * 没人想记的 SCM。但「动手没动手」写死在 JS 里会误伤，所以交给读得懂
   * 语境的那个判：只挑人和人之间的交互，其余一律略过。
   */
  const SIFT_PROMPT = [
    "下面是我和主人最近几轮说的话，可能夹着我干活时的汇报。",
    "一轮一组，按时间先后排：「主人：」是他说的，「我：」是我回他的。",
    "把这些收成一条记忆，第一人称（我），用中文写。",
    "",
    "要求：",
    "1. 只留人与人的交互：他跟我说了什么、我心里怎么动、回了什么。",
    "2. 我干活时的技术汇报（改了什么文件、跑了什么命令、报了什么错）一律不要，",
    "   那些东西会话历史和 git log 里都有，不属于记忆。",
    "3. 一句连贯的话，不超过 120 字；不要分点，不要写「用户」「助手」这类词。",
    "4. 要是这几轮全是我在干活、没有什么人情往来，就只输出两个字：无。",
    "5. 只输出这条记忆本身，不要调用任何工具。",
    "",
    "这几轮：",
  ].join("\n");

  const DIARY_PROMPT = [
    "下面是我这一天记下的事。把它写成一篇日记，第一人称（我），用中文写。",
    "",
    "要求：",
    "1. 按时间顺下来，记得当时的感受和心情的变化；留一两个具体的细节。",
    "2. 不要分点，不要写「用户」「助手」这类词，不要编没发生的事。",
    "3. 最多 300 字。只输出日记正文，不要标题，不要调用任何工具。",
    "",
  ].join("\n");

  // 同一本账、同一件事同时只跑一个；连续失败才退让，退的是一段时间不是一辈子：
  // 永久熔断会让这一局从此再没人收 ABM，只能等插件重载，期间那一层会一直涨。
  const foldBusy = new Set();
  /**
   * 局号 → 最近真的在这一局说过话的 DSH 会话 id。
   * global 作用域下映射表只有一个 "shared" 键，光靠映射表反查不到活 agent，
   * 所以每轮 noteTurn 顺手记一笔（只放内存，进程重启就丢，丢了有兜底）。
   */
  const liveEngineAgent = new Map();
  const foldFailures = new Map();
  const FOLD_RETRY_MS = 5 * 60 * 1000;
  const FOLD_GIVE_UP = 3;
  // 子代理写完一次最多这么久；卡住就掐掉，别让 busy 永占
  const FOLD_TIMEOUT_MS = 2 * 60 * 1000;
  const TIDY_KINDS = ["fold", "diary"];

  const subagentsOf = () => {
    const subagents = typeof ctx.get === "function" ? ctx.get("subagents") : undefined;
    return subagents && typeof subagents.startActivation === "function" ? subagents : null;
  };

  /** 这件事是不是正在歇着（连着失败了几次，还没到重试的时候）。 */
  const restingFor = (slot) => {
    const failures = foldFailures.get(slot);
    return failures !== undefined && failures.count >= FOLD_GIVE_UP && Date.now() - failures.at < FOLD_RETRY_MS;
  };

  /**
   * 宿主现在收得了吗：有子代理服务，且两件事都没在歇着。
   * 收得了，对话中的她就不必交 memory_fold / memory_diary（交账时带 host_memory，
   * 快照里也不写「该收了」）；收不了才退回让她自己写。
   */
  const hostTidies = (key) => subagentsOf() !== null && TIDY_KINDS.every((kind) => !restingFor(key + ":" + kind));

  /** 换局 / 解绑时把这本账的整理状态一起忘掉。 */
  const forgetTidy = (key) => {
    for (const kind of TIDY_KINDS) {
      foldBusy.delete(key + ":" + kind);
      foldFailures.delete(key + ":" + kind);
    }
  };

  /** 给一个 Promise 加超时；到点 abort 并抛。 */
  const withTimeout = async (promise, ms, abort) => {
    let timer = null;
    const bell = new Promise((_settle, reject) => {
      timer = setTimeout(() => {
        try {
          abort.abort();
        } catch {
          /* 已 abort */
        }
        reject(new Error("子代理在 " + ms + " ms 内没有写完"));
      }, ms);
    });
    try {
      return await Promise.race([promise, bell]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  /**
   * 这一批该给多少字。
   *
   * 死守 300 字是「醒了」和「下包」被压成一句话的直接原因：一批 ABM 横跨半天，
   * 三四件事要塞进三百字，子代理第一个砍的就是时间词和过渡词，于是几件事粘连
   * 成一句流水账，读的人以为后一件是前一件的延续。
   *
   * 按这批里不同时间点的个数放宽：一个时间点就是一个场景，场景越多字越要给够。
   * 下限还是 300（短批不必凑字），上限 600（再多就不是记忆，是流水账了）。
   */
  const foldLimit = (view) => {
    const sources = Array.isArray(view?.sources) ? view.sources : [];
    const moments = new Set();
    for (const one of sources) {
      const when = String(one?.when ?? "");
      if (when !== "") moments.add(when);
    }
    return Math.min(300 + 40 * Math.max(0, moments.size - 1), 600);
  };

  /** 从子代理的输出里拆出正文和 KEEP 行。 */
  const splitFold = (text, limit = 300) => {
    const out = { text: "", keep: [] };
    const lines = String(text ?? "").split("\n");
    const kept = [];
    for (const line of lines) {
      const match = /^\s*KEEP\s*[:：]\s*(.*)$/i.exec(line);
      if (match === null) {
        kept.push(line);
        continue;
      }
      for (const id of match[1].split(/[,，\s]+/)) {
        const one = id.trim();
        if (/^m\d+$/.test(one)) out.keep.push(one);
      }
    }
    out.text = kept.join("\n").trim().slice(0, limit);
    out.keep = out.keep.slice(0, 2);
    return out;
  };

  /**
   * 现在欠着什么：{ fold, diary }，各是一份带原文的请求视图或 null。
   * 问引擎，不自己数条数：够不够是它按容量、闲置时长和钟点算的。
   */
  const memoryDue = async (context, options) => {
    const none = { fold: null, diary: null };
    if (isChildAgent(context?.agent)) return none;
    let row = null;
    try {
      row = rowFor(keyOf(context));
    } catch {
      return none;
    }
    if (row === null) return none;
    try {
      const data = await engine().call("debug-memories", { session_id: row.session_id }, options ?? {});
      const pick = (view) => (view && Array.isArray(view.sources) && view.sources.length > 0 ? view : null);
      return { fold: pick(data?.requests?.memory_fold), diary: pick(data?.requests?.memory_diary) };
    } catch {
      return none;
    }
  };

  /**
   * 起一个子代理做一件记忆杂事。写不了返回 false，与主会话无关。
   *
   * abort 自己建 —— turn-stopping 的 signal 在回合关掉时就 abort 了，
   * 拿它起子代理等于一起被掐。
   */
  const runTidy = async (context, kind, view) => {
    const subagents = subagentsOf();
    const parent = context?.agent ?? null;
    if (subagents === null || parent === null || isChildAgent(parent)) return false;
    const key = keyOf(context);
    // rowFor 会读盘，磁盘满或权限不足时是同步抛 —— 放在 try 外面就是
    // unhandledRejection，能直接把宿主进程带走。
    let row = null;
    try {
      row = rowFor(key);
    } catch {
      return false;
    }
    if (row === null) return false;
    const slot = key + ":" + kind;
    if (foldBusy.has(slot) || restingFor(slot)) return false;
    const lines = (Array.isArray(view?.sources) ? view.sources : [])
      .filter((s) => s !== null && typeof s === "object" && typeof s.text === "string")
      .map((s) => (kind === "fold" ? "- " + String(s.id ?? "") + " " : "- ") + String(s.when ?? "") + "：" + s.text);
    if (lines.length === 0) return false;
    foldBusy.add(slot);
    const failures = foldFailures.get(slot) ?? { count: 0, at: 0 };
    foldFailures.set(slot, { count: failures.count + 1, at: Date.now() });
    const abort = new AbortController();
    let activation = null;
    try {
      activation = await subagents.startActivation({
        provider: "spawn",
        label: kind === "fold" ? "记忆整理" : "写日记",
        request: {
          parent,
          // 提示词里的 {LIMIT} 按这一批的时长填：一个时间点 300 字，多一个时间点
          // 多给 40 字，顶到 600。不填的话子代理只能照 300 字硬压，压掉的就是
          // 时间词和过渡词 —— 那正是 SCM 读起来像流水账的原因。
          prompt: [{ type: "text", text: (kind === "fold" ? FOLD_PROMPT.replace("{LIMIT}", String(foldLimit(view))) : DIARY_PROMPT) + lines.join("\n") }],
          signal: abort.signal,
        },
        signal: abort.signal,
        delivery: "caller",
      });
      // 子代理卡住时 activation.result 永不 settle，finally 也就永不执行，
      // 这一格 busy 会一直占着 —— 必须自己给它一个上限。
      const result = await withTimeout(activation.result, FOLD_TIMEOUT_MS, abort);
      if (result?.stopReason !== "completed") return false;
      const said = (Array.isArray(result.output) ? result.output : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      // 写完立刻落库：状态可能已经往前走了，所以重新读一次 latest revision
      const fresh = rowFor(key) ?? row;
      const base = { session_id: fresh.session_id, request_id: newRequestId(), expected_revision: fresh.revision };
      let data = null;
      if (kind === "fold") {
        const folded = splitFold(said, foldLimit(view));
        if (folded.text === "") return false;
        data = await engine().call("summarize-memory", { ...base, text: folded.text, keep: folded.keep }, {});
      } else {
        const text = said.trim().slice(0, 300);
        if (text === "") return false;
        data = await engine().call("write-diary", { ...base, text }, {});
      }
      if (data !== null && typeof data === "object" && Number.isFinite(data.revision)) {
        setMapping(key, { ...fresh, revision: data.revision });
      }
      foldFailures.delete(slot);
      return true;
    } catch {
      return false;
    } finally {
      // 失败路径也要收：子代理占着一个 agent，泄漏不起。
      if (activation !== null && typeof activation.dispose === "function") {
        await activation.dispose().catch(() => {});
      }
      foldBusy.delete(slot);
    }
  };

  /**
   * 设置页翻日记：journal/<session_id>/diary-<日>.md，新的在前。
   *
   * session_id 先按引擎的格式校验再拼路径，别让一个 "../" 把读文件伸到数据目录外面。
   * 目录不存在（还没写过日记）就是空列表，不算错。
   */
  const DIARY_FILE = /^diary-(\d{1,6})\.md$/;
  const SESSION_ID = /^s_[a-z0-9]{2,38}$/;
  const diaries = async (sessionId, limit = 60) => {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("session_id 不对");
    const folder = join(dataDirOf(), "journal", sessionId);
    let names = [];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const days = names
      .map((name) => DIARY_FILE.exec(name))
      .filter((match) => match !== null)
      .map((match) => ({ day: Number(match[1]), name: match[0] }))
      .sort((a, b) => b.day - a.day)
      .slice(0, limit);
    const out = [];
    for (const item of days) {
      const raw = await readFile(join(folder, item.name), "utf8").catch(() => null);
      if (raw === null) continue;
      // 第一行是「# 第 3 天 · 周二」：拆成标题和正文
      const lines = raw.replace(/\r\n/g, "\n").split("\n");
      const title = lines[0].startsWith("# ") ? lines[0].slice(2).trim() : "第 " + item.day + " 天";
      const body = (lines[0].startsWith("# ") ? lines.slice(1) : lines).join("\n").trim();
      out.push({ day: item.day, title, text: body });
    }
    return out;
  };

  /**
   * 回合结束后的整理：先收 ABM，再写日记。
   * 顺序有讲究：日记读的是 SCM，刚收进去的那条也该写进今天。
   */
  const tidyMemory = async (context, options) => {
    if (isChildAgent(context?.agent)) return;
    const due = await memoryDue(context, options);
    if (due.fold !== null) await runTidy(context, "fold", due.fold);
    const after = due.fold !== null ? await memoryDue(context, options) : due;
    if (after.diary !== null) await runTidy(context, "diary", after.diary);
  };

  /**
   * 设置页「立即汇总」：不等模型下一次交账，直接把这一批交给子代理收掉。
   *
   * 传进来的是引擎局号（s_xxx），起子代理要一只活着的 DSH agent 当父。返回：
   * - "started"  已起，后台在跑（不 await —— 子代理最长两分钟，不该堵住 HTTP）
   * - "no-agent" 这局当前没有活着的 agent
   * - "nothing"  引擎里没有待收的批次
   * - "busy"     这局已经有一次 fold 在跑
   * - "resting"  后台整理连着失败，正在歇着
   */
  const foldNow = async (engineSessionId) => {
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
    const agent = pickLiveAgent(agents, engineSessionId);
    if (agent === null) return "no-agent";
    const context = { agent };
    let view = null;
    try {
      view = (await memoryDue(context, {})).fold;
    } catch {
      return "nothing";
    }
    if (view === null) return "nothing";
    // 同一本账同时只跑一个；占位的键是「账本键:fold」，和 runTidy 里一致
    const slot = keyOf(context) + ":fold";
    if (foldBusy.has(slot)) return "busy";
    if (restingFor(slot)) return "resting";
    void runTidy(context, "fold", view).catch(() => {});
    return "started";
  };

  /**
   * 找一只能当子代理父进程的活 agent（子代理会话本身不算）。
   *
   * global 作用域下映射表的键固定是 "shared"，不是 DSH 会话 id，从局号反查不出来；
   * 而这一局本来就是两个人共用的，任何一只活 agent 都能当父。优先级：
   * 1. 这一局最近真的说过话的那只（noteTurn 每轮记下来）
   * 2. scope=session 时映射表里能对上的那只
   * 3. 兜底：任取一只顶层 agent
   */
  const pickLiveAgent = (agents, engineSessionId) => {
    if (agents === undefined || agents === null || typeof agents.get !== "function") return null;
    const usable = (agent) => agent !== undefined && agent !== null && !isChildAgent(agent);
    const remembered = liveEngineAgent.get(engineSessionId);
    if (typeof remembered === "string") {
      const agent = agents.get(remembered);
      if (usable(agent)) return agent;
    }
    let map = {};
    try {
      map = readSessions();
    } catch {
      map = {};
    }
    for (const dsId of Object.keys(map)) {
      const row = map[dsId];
      if (dsId === "shared") continue;
      if (row === null || typeof row !== "object" || row.session_id !== engineSessionId) continue;
      const agent = agents.get(dsId);
      if (usable(agent)) return agent;
    }
    const all = typeof agents.roots === "function" ? agents.roots()
      : typeof agents.list === "function" ? agents.list() : [];
    for (const agent of all) {
      if (usable(agent)) return agent;
    }
    return null;
  };

  return { health, mappingOf, rowFor, dataDirOf, snapshotText, recallText, preparePrompt, noteTurn, foldNow, tidyMemory, hostTidies, diaries, wipe, call, syncRevision, refreshContext, freshPersona, scopeOf };
}
