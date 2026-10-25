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
 * 文件记住「这个 DSH 会话对应哪一局」，重启 DSH 也不会丢局。
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
 * 挂上引擎相关的一切。
 * @param {object} ctx cordis 上下文
 * @param {object} env {root, storePath, cfg, effective, persona}
 */
export function mountEngine(ctx, env) {
  const { root, cfg, persona } = env;
  /**
   * 最近一次 soul_state 拿到的上下文快照。
   * 系统提示词的 provider 必须是同步函数，而引擎是异步的 —— 所以这里缓存一份，
   * 让「上一回合结束时的状态」能出现在下一回合的提示词里。工具返回的才是实时的。
   */
  let lastContext = null;
  let lastContextAt = null;
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

  /** 当前 DSH 会话的引擎局（没有则 null）。 */
  const keyOf = (exec) => {
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
        "soul_commit 交回引擎，别自己编。若返回 started=false，说明还没开局，先用 soul_admin 的 start。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          depth: {
            type: "string",
            enum: ["brief", "full"],
            description: "brief 约 6KB，够日常；换地点/换人/新的一天/上回合被驳回时用 full（约 20KB）。",
          },
          preview_minutes: {
            type: "integer",
            description: "想快进多少分钟再写：返回目标时刻会到期的事件与必须交代的离屏动静，但不改状态。",
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
        const row = mappingOf(keyOf(exec));
        if (row === null) {
          return {
            started: false,
            hint: "这局还没开局。调 soul_admin 的 action=start 建一局；"
              + "人设取自设置页里勾选的文件。",
          };
        }
        const payload = { session_id: row.session_id, depth: args.depth ?? "brief" };
        if (Number.isFinite(args.preview_minutes)) {
          payload.preview_time = { minutes: Math.max(1, Math.trunc(args.preview_minutes)) };
        }
        if (args.want_twist === true) payload.want_twist = true;
        try {
          const data = await engine().call("get-context", payload, { signal: exec.signal });
          setMapping(keyOf(exec), { ...row, revision: data.revision, turn: data.turn, seen_at: new Date().toISOString() });
          lastContext = data.context ?? null;
          lastContextAt = new Date().toISOString();
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
        "action_mode：result=玩家的行动成功了；attempt=试过但没成；rewrite=改写上一回合；",
        "continue=什么也没发生只推进了时间；wait=在等。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          action_mode: {
            type: "string",
            enum: ["result", "attempt", "rewrite", "continue", "wait"],
            description: "本回合玩家行动的性质。rewrite 会覆盖上一回合而不是新增一回合。",
          },
          player_input: { type: "string", description: "玩家这回合原话（改写成不超过 500 字）；wait/continue 可省略。" },
          operations: {
            type: "array",
            description: "操作清单，按发生顺序，最多 40 条。常用：advance_time / move / enter_scene / exit_scene / npc_response / npc_action / npc_state / add_fact / relationship / reveal_fact / event_create / event_resolve / add_thought / offscreen_beat。每条是 {op: 名字, ...该 op 的字段}。",
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
            items: { type: "string" },
            description: "最多 12 个内容标签（如 kiss / confession / violence），供存档检索与分级。",
          },
          player_authorized: {
            type: "boolean",
            description: "玩家明确同意了涉及他自己身体的安排时为 true；不确定就别写 true。",
          },
          acts_on: {
            type: "array",
            items: { type: "string" },
            description: "action_mode=attempt 时必填：玩家试图影响谁（角色 id 列表）。",
          },
          intimate_participants: {
            type: "array",
            items: { type: "string" },
            description: "涉及亲密场景的参与者 id（只在确有其事时写）。",
          },
          replaces_turn: {
            type: "integer",
            description: "action_mode=rewrite 时填要改写的回合号；其它情况省略。",
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
        const row = mappingOf(key);
        if (row === null) {
          return { committed: false, hint: "这局还没开局：先调 soul_admin action=start。" };
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
        try {
          const data = await engine().call("commit-turn", payload, { signal: exec.signal });
          setMapping(key, {
            ...row,
            revision: data.revision,
            turn: data.turn,
            updated_at: new Date().toISOString(),
          });
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
          start_minute: { type: "integer", description: "start 时指定开场分钟数（0=00:00）；省略用人设设定。" },
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
            session: mappingOf(key),
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
          return { ok: true, note: "已解除本对话与引擎局的关联；下一局用 start 新建。" };
        }
        if (!state.ready) {
          return { ok: false, error: "引擎不可用：" + String(state.python.reason ?? "原因未知") };
        }
        const row = mappingOf(key);

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
          if (Number.isFinite(args.start_minute)) {
            payload.start_minute = Math.min(1439, Math.max(0, Math.trunc(args.start_minute)));
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
              created_at: new Date().toISOString(),
            });
            return { ok: true, started: true, ...data };
          } catch (error) {
            return { ok: false, error: describe(error) };
          }
        }

        if (row === null) {
          return { ok: false, error: "这局还没开局：先 action=start。" };
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
      const parts = cast.map((c) => {
        const name = typeof c?.name === "string" ? c.name : "?";
        const band = typeof c?.mood?.band === "string" ? c.mood.band : null;
        const value = Number.isFinite(c?.mood?.value) ? c.mood.value : null;
        const stage = typeof c?.stage === "string" ? c.stage : null;
        return name
          + (value !== null ? "（心情 " + value + (band !== null ? " " + band : "") + "）" : "")
          + (stage !== null ? "［" + stage + "］" : "");
      });
      rows.push("在场/相关：" + parts.join("、"));
    }
    const agency = Array.isArray(lastContext.agency) ? lastContext.agency : [];
    if (agency.length > 0) {
      const beats = agency
        .map((row) => {
          const first = Array.isArray(row?.options) ? row.options[0] : null;
          return first !== null && typeof first?.text === "string"
            ? (typeof row?.name === "string" ? row.name + "：" : "") + first.text
            : null;
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

  return { health, mappingOf, dataDirOf, snapshotText, call };
}
