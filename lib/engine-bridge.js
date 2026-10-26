/**
 * engine-bridge —— 把 Python 引擎接进 DSH：三个工具 + 一段系统提示 + 会话映射。
 *
 * 分工：
 * - 人设（散文）由 index.js 的 section 提供，引擎一个字都不写；
 * - 引擎只负责「账本」：谁在场、几点、信任/张力、心情条、未结事件；
 * - 模型每回合先用 soul_state 拿状态，写完正文用 soul_commit 交账，
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

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { EngineClient, EngineError, enginePresent, probePython } from "./engine-client.js";

/** 引擎数据目录的默认位置（相对 $DSH_HOME）。 */
const ENGINE_DIR = "rp-soul/engine";
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

function writeJsonFile(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
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
 * 挂上引擎相关的一切。
 * @param {object} ctx cordis 上下文
 * @param {object} env {root, storePath, cfg, effective, persona}
 */
export function mountEngine(ctx, env) {
  const { root, cfg, persona } = env;
  /**
   * 最近一次 soul_state 拿到的上下文快照，按作用域键分开存。
   * 系统提示词的 provider 必须是同步函数，而引擎是异步的 —— 所以这里缓存一份，
   * 让「上一回合结束时的状态」能出现在下一回合的提示词里。工具返回的才是实时的。
   *
   * 早先这里是单例两变量，多会话交替时会互相盖掉：A 会话读一次状态，B 会话的提示词
   * 里就会冒出 A 的局面。改成 Map，键与引擎局一致。
   */
  const lastContexts = new Map();
  let lastContextKey = null;
  const rememberContext = (key, context) => {
    lastContexts.set(key, { context: context ?? null, at: new Date().toISOString() });
    lastContextKey = key;
  };
  const recallContext = () => {
    if (lastContextKey !== null) {
      const hit = lastContexts.get(lastContextKey);
      if (hit !== undefined) return hit;
    }
    // 兜底：没有任何一次读取时，取最新写入的那份（与旧行为一致）。
    let best = null;
    for (const row of lastContexts.values()) {
      if (best === null || String(row.at) > String(best.at)) best = row;
    }
    return best;
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
  const dropMapping = (key) => {
    const map = readSessions();
    if (map[key] === undefined) return;
    delete map[key];
    writeSessions(map);
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
  const autoStart = async (key, exec, options) => {
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

  ctx.inject(["tools"], (tctx) => {
    // -----------------------------------------------------------------------
    // soul_state
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_state",
      description: [
        "读取当前这局的状态：在场角色、地点与时间、各自的情绪（心情条数值与带情绪的事由）、",
        "彼此的信任/张力/关系阶段、未结的事件与线索、以及NPC「下一步可能做什么」的候选。",
        "写正文之前先调它。返回值里需要账本的部分（信任变化、情绪事由、关系推进）必须由",
        "soul_commit 交回引擎，别自己编。若返回 started=false，说明这一局开不起来，按提示退回纯人设演。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          depth: {
            type: "string",
            enum: ["brief", "full"],
            description: "brief 约 6KB，够日常；换地点/换人/新的一天/上回合被驳回时用 full（约 20KB）。",
          },
          want_twist: {
            type: "boolean",
            description: "玩家主动要转折时为 true，返回人设里预设的转折（没有就明说让你自己想）。",
          },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
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
        if (row === null) {
          // 全局账本就该「一进来就在」：没有局就地开一局，别让人先去点 soul_admin。
          // 开不起来（比如人设缺前置块）也不算失败 —— 退回纯人设模式，如实说一声。
          const born = await autoStart(key, exec, null);
          if (born.row === null) {
            return {
              started: false,
              hint: "没能自动开局（" + born.why + "）：这回合只按人设散文演，不要假装有账本。",
            };
          }
          row = born.row;
          rememberContext(key, born.data?.context ?? null);
          return { started: true, session_id: row.session_id, autoStarted: true, ...born.data };
        }
        const payload = { session_id: row.session_id, depth: args.depth ?? "brief" };
        // 时间按真实时钟走：引擎自己拿现在的时刻算跨度，这里不再传快进。
        if (args.want_twist === true) payload.want_twist = true;
        // 顺手把磁盘上的人设一起送过去：设置页改完名字/外貌/语态/作息，下一次
        // soul_state 就生效，不必为了看新内容重开一局。读不到就算了，不因此失败。
        const fresh = freshPersona();
        if (fresh.payload !== null) payload.persona = fresh.payload;
        try {
          const data = await engine().call("get-context", payload, { signal: exec.signal });
          setMapping(key, { ...row, revision: data.revision, turn: data.turn, seen_at: new Date().toISOString() });
          rememberContext(key, data.context ?? null);
          return { started: true, session_id: row.session_id, ...data };
        } catch (error) {
          return { started: true, session_id: row.session_id, error: describe(error) };
        }
      },
      presentCall: () => ({ card: "generic", title: "查看这局的状态", kind: "read" }),
      presentResult: () => ({ card: "generic", title: "状态已到手" }),
    }), "rp-soul tool soul_state");

    // -----------------------------------------------------------------------
    // soul_commit
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_commit",
      description: [
        "把这回合发生的事交给引擎记账。只用写「事」，不用写「数值」：信任怎么变、谁的心情被什么影响、",
        "事件是否到期，引擎按它自己的规则算。被驳回时会返回带 path 与原因的清单，照着改再调一次",
        "（最多两轮；两轮都不行就按驳回意见改正文，不要绕过）。",
        "action_mode：result=玩家说的话直接成了事实（不能作用于 NPC 的身体、意志、财物）；",
        "attempt=玩家在尝试，作用于 NPC 时成没成由 NPC 的回应决定（genuine 也算 attempt），不作用于任何 NPC 时写 acts_on: []；",
        "rewrite=玩家说「其实……」追溯设定，要 player_authorized 和至少一条 add_fact(origin: retcon)，仍是新的一回合；",
        "continue=玩家没说没做、wait=时间在走，这两种也至少要有一个可观察的变化（npc_action / enter_scene / add_fact 等）。",
        "心情档位按回合开始时 soul_state 里的 band 管：closed 档 npc_response 只能 refuse/negotiate/surface 且 note ≤30 字；",
        "break 档在场的人不能 npc_response，本回合必须有一条她的 npc_action(significant: true, kind: provoke 或 leave)，",
        "不受冷却限制，也顶替 attempt 所需的回应。其它档位下 significant: true 的 npc_action 必须写 kind，且取 agency 候选里的种类。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          action_mode: {
            type: "string",
            enum: [...ACTION_MODES],
            description: "本回合玩家行动的性质，含义见工具说明。要推翻上一回合重写用 replaces_turn，不是 rewrite。",
          },
          player_input: { type: "string", description: "玩家这回合原话（≤2000 字，引擎只回显不解析）；wait/continue 可省略。" },
          operations: {
            type: "array",
            description: "操作清单，按发生顺序，最多 40 条。常用：move / enter_scene / exit_scene / npc_response / npc_action / npc_state / add_fact / relationship / reveal_fact / event_create / event_resolve / add_thought / offscreen_beat。每条是 {op: 名字, ...该 op 的字段}。时间不用写：引擎按真实时钟自己结算。",
            items: { type: "object", additionalProperties: true },
          },
          summary: { type: "string", description: "本回合发生了什么（≤120 字），给下一回合的模型自己看。" },
          open_action: { type: "string", description: "留下的悬念或玩家可接的话头（≤80 字）。" },
          quotes: {
            type: "array",
            items: { type: "string" },
            description: "最多 3 句关键台词原文（每句 ≤80 字）。",
          },
          content_tags: {
            type: "array",
            items: { type: "string", enum: [...CONTENT_TAGS] },
            description: "本回合正文涉及的内容标签（最多 12 个，只能取枚举里的 id）：romance_light 轻度暧昧 / intimate 亲密 / explicit 直白性描写 / violence 暴力 / coercion_theme 胁迫 / humiliation 羞辱 / bodily_harm 身体伤害 / substance 酒精药物 / pregnancy 怀孕 / death 死亡 / workplace_power 职场权力 / infidelity 出轨 / crime 违法 / gambling 赌博 / workplace 职场 / nightlife 夜生活 / supernatural 超自然 / disaster 灾难 / custom 其它。用于检查玩家登记的边界；带 intimate 或 explicit 时必须写 intimate_participants。",
          },
          player_authorized: {
            type: "boolean",
            description: "玩家本人的话授权了玩家角色的移动、承诺、交易、同意或设定修改时为 true（rewrite 必须为 true，continue/wait 不能带）；不确定就别写。",
          },
          acts_on: {
            type: "array",
            items: { type: "string" },
            description: "玩家行动作用到的 NPC（身体、意志、财物）的 id 列表；每个都要有 npc_response（break 档的人用 provoke/leave 顶替）。attempt 不作用于任何 NPC 时写 []；result / rewrite 不能作用于 NPC。",
          },
          intimate_participants: {
            type: "array",
            items: { type: "string" },
            description: "content_tags 含 intimate 或 explicit 时必填：亲密参与者 id（含玩家，至少 2 人，都得在场）；其它时候不写。",
          },
          replaces_turn: {
            type: "integer",
            description: "「刚才那回合不算，改成……」：填当前最后一个回合的回合号，这次提交会替换掉那一回合（任何 action_mode 都可以）；其它情况省略。",
          },
        },
        required: ["action_mode"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
        const state = health();
        if (!state.ready) {
          return { committed: false, hint: "引擎不可用，本回合按纯提示词模式写；不要伪造账本。" };
        }
        const key = keyOf(exec);
        let row = rowFor(key);
        if (row === null) {
          // 直接交账也可以：没有局就地开一局，免得为了记一笔还得先跑一趟 soul_state。
          const born = await autoStart(key, exec, null);
          if (born.row === null) {
            return { committed: false, hint: "没能自动开局（" + born.why + "）：本回合不记账。" };
          }
          row = born.row;
        }
        const commit = {};
        for (const name of [
          "action_mode", "player_input", "player_authorized", "acts_on", "operations",
          "content_tags", "intimate_participants", "summary", "open_action", "quotes",
          "chapter_summary", "prologue", "replaces_turn",
        ]) {
          if (args[name] !== undefined) commit[name] = args[name];
        }
        const payload = {
          session_id: row.session_id,
          request_id: newRequestId(),
          expected_revision: row.revision,
          turns: [commit],
        };
        // 交账也带上现在的人设：这样「改完设置就直接开始写」也不用先读一次状态。
        const freshCommit = freshPersona();
        if (freshCommit.payload !== null) payload.persona = freshCommit.payload;
        try {
          const data = await engine().call("commit-turn", payload, { signal: exec.signal });
          setMapping(key, {
            ...row,
            revision: data.revision,
            turn: data.turn,
            updated_at: new Date().toISOString(),
          });
          // 关键：commit-turn 的返回值里带着提交后的新局面（service.py 的
          // `"context": project(state, ...)`）。不把它存进快照缓存，系统提示词里
          // 那截「当前局面」就永远停在上一次 soul_state 读到的时刻——心情、想法、
          // 时间全都是上一回合的旧值，直到模型下一次主动调 soul_state 才追上。
          // 交账之后局面一定会变，所以这里是刷新快照最该发生的地方。
          if (data.context !== undefined) rememberContext(key, data.context ?? null);
          return { committed: true, revision: data.revision, turn: data.turn, ...data };
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
              retry_hint: "局面已经变了：先调 soul_state 重新看一遍，再决定这回合怎么记。",
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
      presentCall: () => ({ card: "generic", title: "把这回合交给引擎", kind: "write" }),
      presentResult: () => ({ card: "generic", title: "引擎已记账" }),
    }), "rp-soul tool soul_commit");

    // -----------------------------------------------------------------------
    // soul_admin
    // -----------------------------------------------------------------------
    tctx.effect(() => tctx.tools.register({
      name: "soul_admin",
      description: [
        "这局的行政操作：start 开局、status 看引擎状态、undo 撤回上一回合、save/load/list/delete 存档、",
        "set_safety / set_preferences 调边界与偏好、mood_panel 看某人情绪面板、drop_thought 手动删一条情绪。",
        "开局只需要人设（设置页里勾选的文件），引擎不会替你编人物或地点。",
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
          start_location: { type: "string", description: "start 时指定开场地点 id；省略用人设的默认地点。" },
          present: {
            type: "array", items: { type: "string" },
            description: "start 时指定开场在场的角色 id；省略取该地点此刻排班在场的人。",
          },
          name: { type: "string", description: "save/load/delete 的存档名；不给名字时 save 用 auto-<回合数>。" },
          overwrite: { type: "boolean", description: "save 时同名覆盖。默认 false。" },
          confirm: { type: "boolean", description: "delete 必须为 true 才真删。" },
          boundary: { type: "string", description: "set_safety 的场景边界说明（哪些不做）。" },
          safety: { type: "object", additionalProperties: true, description: "set_safety 的其它结构化字段。" },
          preferences: {
            type: "object",
            additionalProperties: true,
            description: "set_preferences：{offscreen_simulation, person, pace, explicitness}。pace ∈ slow/standard/direct，explicitness ∈ subtle/standard/explicit，person ∈ first/second/third。",
          },
          npc_id: { type: "string", description: "mood_panel / drop_thought 的角色 id。" },
          thought_id: { type: "string", description: "drop_thought 要删的情绪条目 id（从 mood_panel 里取）。" },
          reason: { type: "string", description: "drop_thought 的原因（写进审计，可留空）。" },
        },
        required: ["action"],
      },
      output: { schema: JSON_OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
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
          if (typeof args.start_location === "string" && args.start_location !== "") {
            payload.start_location = args.start_location;
          }
          if (Array.isArray(args.present) && args.present.length > 0) {
            payload.present = args.present.filter((s) => typeof s === "string");
          }
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
        if (action === "mood_panel") {
          if (typeof args.npc_id !== "string" || args.npc_id === "") return { ok: false, error: "mood_panel 需要 npc_id" };
          try {
            const data = await engine().call(
              "debug-mood",
              { session_id: row.session_id, npc_id: args.npc_id },
              { signal: exec.signal },
            );
            return { ok: true, ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }
        if (action === "drop_thought") {
          if (typeof args.npc_id !== "string" || args.npc_id === "") return { ok: false, error: "drop_thought 需要 npc_id" };
          if (typeof args.thought_id !== "string" || args.thought_id === "") {
            return { ok: false, error: "drop_thought 需要 thought_id（先从 mood_panel 取）" };
          }
          return await sessionCall("debug-delete-thought", {
            npc_id: args.npc_id,
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
  const snapshotText = () => {
    if (cfg.engineEnabled === false) return "";
    const remembered = recallContext();
    const lastContext = remembered === null ? null : remembered.context;
    const lastContextAt = remembered === null ? null : remembered.at;
    if (lastContext === null || typeof lastContext !== "object") return "";
    const rows = [];
    const clock = lastContext.clock;
    if (typeof clock?.label === "string") rows.push("时间：" + clock.label);
    const place = lastContext.scene?.location;
    if (typeof place === "string" && place !== "") {
      const privacy = lastContext.scene?.privacy;
      rows.push("地点：" + place + (typeof privacy === "string" ? "（" + privacy + "）" : ""));
    }
    const cast = []
      .concat(Array.isArray(lastContext.present_npcs) ? lastContext.present_npcs : [])
      .concat(Array.isArray(lastContext.nearby) ? lastContext.nearby : []);
    if (cast.length > 0) {
      // 心情档位用设置页同一套中文，别让模型自己去猜 open 是什么意思。
      const BAND_ZH = { open: "开心", normal: "平稳", closed: "低落", break: "难过" };
      // 每条心事后面挂它对心情的实际影响（引擎算好的当前值，含衰减），
      // 照 RimWorld 的写法：想法（+3）。旧快照里 weighing 是纯字符串，兼容一下。
      const thoughtOf = (row) => {
        if (typeof row === "string") return row === "" ? null : row;
        if (row === null || typeof row !== "object") return null;
        const label = typeof row.label === "string" ? row.label : "";
        if (label === "") return null;
        const delta = Number.isFinite(row.delta) ? row.delta : null;
        if (delta === null || delta === 0) return label;
        return label + "（" + (delta > 0 ? "+" : "") + delta + "）";
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
    if (rows.length === 0) return "";
    const NL = String.fromCharCode(10);
    return "【当前局面（引擎账本，最近一次读取 " + String(lastContextAt ?? "") + "）】" + NL
      + rows.join(NL) + NL
      + "这段只是账本快照：写之前用 soul_state 拿最新状态，写完用 soul_commit 交账。";
  };

  // 插件卸载 / DSH 退出时收掉侧车进程，别留孤儿 python。
  ctx.effect(() => () => {
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
   * 「最近的想法」里，于是下一回合的系统提示词会继续说一条已经不存在的情绪。
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

  return { health, mappingOf, rowFor, dataDirOf, snapshotText, call, syncRevision, refreshContext, freshPersona, scopeOf };
}
