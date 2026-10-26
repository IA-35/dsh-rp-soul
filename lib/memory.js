/**
 * memory —— 跨会话记忆：把她和你真实说过的话归档下来，并在「会话开头」与
 * 「每次压缩之后」往上下文里放一段最近的聊天记录。
 *
 * 为什么要抄这一套（而不是每回合都塞）：
 * provider 的 KV 缓存按前缀复用。记忆块如果每回合重建、内容一变，整个前缀
 * 就作废，等于每回合都按全价重算。所以这里的策略是：
 *   - 只在「这个会话里还没有记忆块」或「上一次压缩发生在记忆块之后」时重建；
 *   - 重建时先把旧块从 surface 上摘掉（用 replace 换成空 system 消息），
 *     再把新块插到本步消息的最前面 —— 位置固定，内容在两次重建之间不变。
 * 这样两次压缩之间前缀稳定，记忆还不会丢。
 *
 * 与引擎账本的分工：
 *   - 引擎（engine/）存「结构化状态」：心情条、信任、未结的事；它只会写摘要。
 *   - 这里存「原始对话」：谁在什么时候说了什么，一字不删。
 * 压缩之后引擎状态靠 soul_state 重新读，而对话原文只能靠这份归档。
 */

import {
  MEMORY_DIR,
  ensureMemoryDir,
  readCursor,
  writeCursor,
  appendRecords,
  loadRecentTurns,
  renderHistory,
  recordOf,
  visibleText,
  memoryStats,
  clearMemory,
} from "./memory-store.js";

/** 记忆块的 source.kind：宿主据此把块与用户真话区分开的唯一标记。 */
export const MEMORY_SOURCE = "rp-soul-history";
/** 每页读多少事件（与 dsh-world 一致，128 是宿主分页的常见粒度）。 */
const PAGE = 128;

/**
 * 读一个会话的日志，找出「还留在 surface 上的记忆块」与「最后一次成功的压缩」。
 *
 * 记忆块会被压缩吞掉（压缩会把整段 surface 换成一个摘要），所以「块还在不在」
 * 不能靠内存状态，只能读日志。on surface 才需要摘，历史里的旧块不用管。
 * @returns {Promise<{reload: boolean, injected: Map<string, number>}>}
 */
export async function readMemoryState(ctx, session) {
  const injected = new Map();
  const surface = new Set(session.surface.nodes);
  let lastBlock = -1;
  let lastCompaction = -1;
  const handle = await ctx.sessionPersistence.open(session.id, "read");
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await handle.read(offset, PAGE);
      if (!page.events.length) break;
      for (const event of page.events) {
        const isBlock = event.type === "user/message" && event.data.source !== undefined && event.data.source.kind === MEMORY_SOURCE;
        if (isBlock && surface.has(event.seq)) injected.set(event.data.id, event.seq);
        if (event.seq < session.inheritedEventCount) continue;
        if (isBlock) lastBlock = event.seq;
        if (event.type === "compaction/end" && event.data.error === undefined) lastCompaction = event.seq;
      }
    }
  } finally {
    await handle.close();
  }
  // 没有块，或者压缩发生在块之后（块已被吞掉）→ 需要重建。
  return { reload: lastBlock < 0 || lastCompaction > lastBlock, injected };
}

/**
 * 把一段消息 JSON 渲染成记忆块文本。
 * 已在当前会话里出现过的消息不再重复（否则模型会看到同一句话说两遍）。
 * @returns {string} 空串表示没有可注入的记忆
 */
export function renderBlockText(root, opts) {
  const { turns, names, presentIds, homeOnly } = opts;
  const usable = [];
  for (const turn of turns) {
    const kept = turn.messages.filter((rec) => !presentIds.has(rec.m));
    if (kept.length === 0) continue;
    usable.push({ ...turn, messages: kept });
  }
  return renderHistory(usable, names, { homeOnly });
}

/**
 * 归档器：把宿主会话日志里新增的消息抄进记忆库。
 *
 * 串行队列：同一个会话的补齐任务不并发（否则游标会互相覆盖，出现重复或漏行）。
 * 增量：每个会话记住「上次读到哪个 seq」，下次从那儿往后读。
 */
export function createArchiver(ctx, root) {
  const tails = new Map();
  let flushing = Promise.resolve();

  /** 读一个会话从游标之后的新事件并落盘。 */
  async function catchUpOne(sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined && live !== null) {
      try {
        await ctx.sessions.flush(live);
      } catch {
        /* 刷盘失败不影响读已有部分 */
      }
    }
    const handle = await ctx.sessionPersistence.open(sessionId, "read");
    const cursor = readCursor(root);
    let nextSeq = Number.isFinite(cursor[sessionId]) ? cursor[sessionId] : 0;
    let turn = 0;
    let written = 0;
    try {
      for (;;) {
        const page = await handle.read(nextSeq, PAGE);
        if (!page.events.length) break;
        const batch = [];
        for (const event of page.events) {
          if (event.type === "turn/start") turn = event.data.turn;
          const rec = recordOf(event, handle.header, handle.inheritedEventCount, turn, visibleText);
          if (rec !== null) batch.push(rec);
          nextSeq = event.seq + 1;
        }
        written += appendRecords(root, batch);
      }
    } finally {
      await handle.close();
    }
    const latest = readCursor(root);
    if (latest[sessionId] !== nextSeq) {
      latest[sessionId] = nextSeq;
      writeCursor(root, latest);
    }
    return written;
  }

  /** 排队补齐（同一会话串行，不同会话之间也串行 —— 量小，简单比并发重要）。 */
  function schedule(sessionId) {
    const tail = tails.get(sessionId) ?? Promise.resolve();
    const job = tail.then(() => catchUpOne(sessionId)).catch(() => 0);
    tails.set(sessionId, job.then(() => undefined, () => undefined));
    flushing = flushing.then(() => job).then(() => undefined, () => undefined);
    return job;
  }

  return { schedule, flush: () => flushing };
}

/** 记忆的展示名（她的名字 / 对用户的称呼）。 */
export function memoryNames(env) {
  const built = env.persona === undefined ? null : env.persona();
  const front = built === null || built === undefined ? {} : built.front ?? {};
  const selfName = typeof front.name === "string" && front.name.trim() !== "" ? front.name.trim() : "她";
  return { self: selfName, partner: "你" };
}

/** 设置页/工具用的记忆概况。 */
export function memoryOverview(root, turnsLimit) {
  const turns = loadRecentTurns(root, turnsLimit);
  return memoryStats(root, turns);
}

/** 列出当前所有活着的 agent；服务缺失时返回空数组。 */
function listAgents(ctx) {
  try {
    return ctx.agents.list();
  } catch {
    return [];
  }
}

/**
 * 把记忆接进 DSH：归档、注入、以及设置页的三条接口需要的读函数。
 *
 * @param {object} ctx cordis 上下文（需要 sessions 与 sessionPersistence）
 * @param {object} env {root, cfg, effective, persona}
 * @returns {{start: () => void, flush: () => Promise<void>, stats: Function, recent: Function, forget: Function}}
 */
export function mountMemory(ctx, env) {
  const { root, cfg, effective } = env;
  const archiver = createArchiver(ctx, root);
  /** 每个会话的记忆状态（要不要重建、旧块在哪）。 */
  const states = new WeakMap();
  const attaching = new WeakMap();
  const disposers = [];

  /** 记忆轮数：设置页可改，默认 60（比 dsh-world 的 200 小，因为这里一轮可能很长）。 */
  const turnsLimit = () => {
    const eff = effective();
    const n = Number(eff.memoryTurns);
    return Number.isFinite(n) ? Math.min(400, Math.max(0, Math.trunc(n))) : 60;
  };

  /**
   * 记忆开关。
   *
   * 关掉之后不再往上下文里塞记忆块（旧块也不摘，等下一次压缩自然带走），
   * 但归档继续 —— 用户重新打开时历史是连续的，而不是从打开那一刻才开始记。
   */
  const injectEnabled = () => effective().memoryEnabled !== false;

  /**
   * 一个会话要不要归档。
   *
   * 只归档「主会话」：子代理（subagent）与 fork 出来的子会话说的话不属于她和你
   * 的相处，收进来会污染记忆。engineScope=session 时不限会话，因为每个窗口
   * 都是独立的一局。
   */
  const belongs = (session) => {
    const header = session.header;
    if (header.origin === "subagent") return false;
    if ((header.delegationDepth ?? 0) > 0) return false;
    return true;
  };

  /** 首次见到一个会话：补齐归档 + 读出记忆块状态。 */
  async function attach(session) {
    if (!belongs(session) || states.has(session)) return;
    const pending = attaching.get(session);
    if (pending !== undefined) return pending;
    const job = (async () => {
      await archiver.schedule(session.id);
      states.set(session, await readMemoryState(ctx, session));
    })();
    attaching.set(session, job);
    try {
      await job;
    } finally {
      attaching.delete(session);
    }
  }

  /**
   * 重建记忆块：先把还留在 surface 上的旧块退休，再生成一个新块。
   *
   * 退休用 system/message + replace：user/message 不能 replace 成空（消息内容
   * 校验会拒），而 system 消息可以是空串，且不会在模型眼里留下痕迹。
   */
  async function freshBlock(session, state, turn, step) {
    const { createSystemMessage, createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const present = new Set();
    for (const message of session.deriveMessages()) {
      if (message.role === "assistant") present.add(message.id);
      else if (message.role === "user" && message.source !== undefined && message.source.kind === "user") present.add(message.id);
    }
    for (const message of session.deriveMessages()) {
      if (message.source === undefined || message.source.kind !== MEMORY_SOURCE) continue;
      const seq = state.injected.get(message.id);
      if (seq === undefined) throw new Error("rp-soul: 旧的记忆块在 surface 上找不到位置，无法替换");
      if (!session.surface.nodes.includes(seq)) continue;
      session.append("system/message", { turn, step, message: createSystemMessage("") }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      state.injected.delete(message.id);
    }
    const limit = turnsLimit();
    if (limit === 0) return undefined;
    const turns = loadRecentTurns(root, limit);
    const text = renderBlockText(root, { turns, names: memoryNames(env), presentIds: present });
    if (text === "") return undefined;
    return createUserMessage({ content: [{ type: "text", text }], source: { kind: MEMORY_SOURCE, form: "recall" } });
  }

  /**
   * 注册事件钩子。返回 void —— 与会话生命周期无关，插件卸载由 ctx.effect 收尾。
   *
   * 测试替身（以及某些精简组合）只提供最小 ctx，没有 on()；此时什么钩子都不挂，
   * 归档与注入自然不生效，但插件其余部分（人设、引擎、设置页）照常工作。
   */
  function start() {
    if (typeof ctx.on !== "function") return;
    // 归档：说完话就抄一份（异步、失败不炸回合）。
    disposers.push(ctx.on("session/event", (session, event) => {
      if (!belongs(session)) return;
      const state = states.get(session);
      const compacted = event.type === "compaction/end" && event.data.error === undefined;
      if (state !== undefined && event.type === "user/message" && event.data.source !== undefined && event.data.source.kind === MEMORY_SOURCE) {
        state.injected.set(event.data.id, event.seq);
      }
      if (state !== undefined && compacted) state.reload = true;
      const worth = event.type === "assistant/message"
        || event.type === "turn/start"
        || event.type === "turn/end"
        || compacted
        || (event.type === "user/message" && event.data.source !== undefined && event.data.source.kind === "user");
      if (worth) void archiver.schedule(session.id).catch(() => {});
    }));

    // 第一步之前把记忆块插到消息最前面。
    disposers.push(ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      const { agent, turn, step, signal } = payload;
      // 空的第一步会结束回合；之后再插只会白费一次重建。
      if (decision.kind !== "enter" || (step === 1 && decision.messages.length === 0) || signal.aborted) return decision;
      const { session } = agent;
      if (!belongs(session) || !injectEnabled()) return decision;
      await attach(session);
      void archiver.schedule(session.id).catch(() => {});
      signal.throwIfAborted();
      const state = states.get(session);
      if (state === undefined || !state.reload) return decision;
      const block = await freshBlock(session, state, turn, step);
      if (block === undefined) {
        state.reload = false;
        return decision;
      }
      state.reload = false;
      return { ...decision, messages: [block, ...decision.messages] };
    }));

    // 已经在跑的会话：挂上状态（新会话走 agent/created）。
    for (const agent of listAgents(ctx)) void attach(agent.session);
    disposers.push(ctx.on("agent/created", async ({ agent }) => {
      await attach(agent.session);
      return undefined;
    }));
  }

  function stop() {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    return archiver.flush();
  }

  return {
    start,
    stop,
    flush: () => archiver.flush(),
    /** 最近若干轮（设置页展示用）。 */
    recent: (limit) => loadRecentTurns(root, limit),
    /** 概况：天数、字节、轮数、目录、注入上限。 */
    stats: () => Object.assign(memoryStats(root, loadRecentTurns(root, turnsLimit())), { turnsLimit: turnsLimit() }),
    /** 清空记忆（设置页「忘掉」）。 */
    forget: () => {
      const cleared = forgetAll(root);
      for (const agent of listAgents(ctx)) {
        const state = states.get(agent.session);
        if (state !== undefined) state.reload = true;
      }
      return cleared;
    },
    turnsLimit,
    memoryDir: MEMORY_DIR,
  };
}

/** 清空记忆库（文件清空、游标重置）。 */
function forgetAll(root) {
  ensureMemoryDir(root);
  const cleared = clearMemory(root);
  writeCursor(root, {});
  return cleared;
}
