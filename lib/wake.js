/**
 * 唤醒线：她按自己的时间醒来。
 *
 * 引擎（阶段①）只负责算「下一次该醒是什么时候、为什么」；这里负责真正叫醒她：
 * 定时器、额度、送达、唤醒回合的标记与用量统计。分工刻意分明 ——
 * 判断全在引擎（可测、纯函数），副作用全在这里（可失败、要退避）。
 *
 * 一次唤醒：到点 → 检查 → `agent.steer` 一条【我的时间】消息进指定会话 →
 * 她在那个回合里过自己的时间、用 plan_next 说好下一步 → 回合结束再算下一次。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 配置默认值，写进 `rp-soul/config.json`（与设置页同一个文件）。 */
export const WAKE_DEFAULTS = {
  wakeEnabled: false,
  wakeSessionId: "",
  wakeDailyLimit: 12,
  wakeDailyTokens: 300000,
  wakeQuiet: "00:00-08:00",
  wakeMissYou: 6,
  wakeRoutine: true,
};

export const WAKE_SOURCE = "rp-soul-wake";
const STATE_FILE = "rp-soul/wake.json";
const TEMPLATE_FILE = "rp-soul/wake.md";
/** 定时器最多睡这么久就重新对一次墙钟：电脑睡眠、改时间都不会漏响。 */
const SEGMENT_MS = 5 * 60 * 1000;
const RETRY_MINUTES = [1, 5, 15, 30, 60];
/** 她正在跟你说话时被唤醒会打断你：推后这么久。 */
const BUSY_PUSH_MS = 5 * 60 * 1000;
/** 你刚说过话就别叫醒她：还在聊，用不着她「醒」。 */
const RECENT_TALK_MS = 15 * 60 * 1000;

const DEFAULT_TEMPLATE = [
  "【我的时间】{when} 了{why}。",
  "{player} 不在。接下来做什么由我决定：可以自己做点什么，也可以在这里给 {player} 留一句话。",
  "做完用 soul_commit 记账，再用 plan_next 说好接下来做什么、做到几点；什么都不定，就按平常的时间叫我。",
].join("\n");

/** 本地日期串 YYYY-MM-DD，用来给额度划天。 */
export function localDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** 从 store 里读唤醒配置（缺的用默认值补），并夹到合理区间。 */
export function readWakeConfig(store) {
  const raw = store !== null && typeof store === "object" ? store : {};
  const quiet = typeof raw.wakeQuiet === "string" ? raw.wakeQuiet.trim() : WAKE_DEFAULTS.wakeQuiet;
  return {
    enabled: raw.wakeEnabled === true,
    sessionId: typeof raw.wakeSessionId === "string" ? raw.wakeSessionId.trim() : "",
    dailyLimit: clampInt(raw.wakeDailyLimit, 0, 200, WAKE_DEFAULTS.wakeDailyLimit),
    dailyTokens: clampInt(raw.wakeDailyTokens, 0, 100000000, WAKE_DEFAULTS.wakeDailyTokens),
    quiet: /^\d\d:\d\d-\d\d:\d\d$/.test(quiet) || quiet === "" ? quiet : WAKE_DEFAULTS.wakeQuiet,
    missYou: clampInt(raw.wakeMissYou, 0, 96, WAKE_DEFAULTS.wakeMissYou),
    routine: raw.wakeRoutine !== false,
  };
}

/** 设置页 POST 过来的字段 → 写进 store 的那几个键。 */
export function wakeConfigPatch(body) {
  const patch = {};
  if (typeof body.wakeEnabled === "boolean") patch.wakeEnabled = body.wakeEnabled;
  if (typeof body.wakeSessionId === "string") patch.wakeSessionId = body.wakeSessionId.trim();
  if (body.wakeDailyLimit !== undefined) patch.wakeDailyLimit = clampInt(body.wakeDailyLimit, 0, 200, WAKE_DEFAULTS.wakeDailyLimit);
  if (body.wakeDailyTokens !== undefined) patch.wakeDailyTokens = clampInt(body.wakeDailyTokens, 0, 100000000, WAKE_DEFAULTS.wakeDailyTokens);
  if (typeof body.wakeQuiet === "string") {
    const quiet = body.wakeQuiet.trim();
    patch.wakeQuiet = quiet === "" || /^\d\d:\d\d-\d\d:\d\d$/.test(quiet) ? quiet : WAKE_DEFAULTS.wakeQuiet;
  }
  if (body.wakeMissYou !== undefined) patch.wakeMissYou = clampInt(body.wakeMissYou, 0, 96, WAKE_DEFAULTS.wakeMissYou);
  if (typeof body.wakeRoutine === "boolean") patch.wakeRoutine = body.wakeRoutine;
  return patch;
}

const emptyState = () => ({
  at: null,
  reason: null,
  why: null,
  day: null,
  count: 0,
  tokens: 0,
  streak: 0,
  lastError: null,
  lastFiredAt: null,
  lastDeliveredAt: null,
});

function readState(file) {
  try {
    if (!existsSync(file)) return emptyState();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object") return emptyState();
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    // 写不进磁盘不该让唤醒线停摆：内存里那份照样能驱动定时器。
  }
}

/**
 * 哪些会话此刻处在「她自己的时间」里。
 *
 * 桥接层的 soul_commit 靠它把 `together: false` 自动带上：唤醒回合不是你跟她说话，
 * 那回合里的约定、回应、冲着你的行动都不成立。放模块级是因为它必须被桥接层读到，
 * 而桥接层先于唤醒线挂载（唤醒线依赖桥接层的引擎调用）。
 */
const WAKE_TURNS = new Set();

export const isWakeTurn = (sessionId) => typeof sessionId === "string" && WAKE_TURNS.has(sessionId);
export const markWakeTurn = (sessionId) => { if (typeof sessionId === "string") WAKE_TURNS.add(sessionId); };
export const clearWakeTurn = (sessionId) => { WAKE_TURNS.delete(sessionId); };
export const clearAllWakeTurns = () => WAKE_TURNS.clear();

/** 唤醒消息的措辞：`rp-soul/wake.md` 可整份覆盖，占位符 {when} {why} {player}。 */
export function renderWakeText(options) {
  let template = DEFAULT_TEMPLATE;
  try {
    const file = join(options.root, TEMPLATE_FILE);
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      if (text !== "") template = text;
    }
  } catch {
    // 模板读不出来就用内置的：措辞丢了也比叫不醒好。
  }
  const when = options.when ?? "";
  const why = options.why !== null && options.why !== undefined && options.why !== "" ? "，这是我说好做到的时间：「" + options.why + "」" : "";
  return template
    .split("{when}").join(when)
    .split("{why}").join(why)
    .split("{player}").join(options.player ?? "你");
}

/** 把引擎给的 ISO 时刻换成毫秒；坏值返回 null（当成「这一轮不算」）。 */
export function dueAt(iso) {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 挂上唤醒线。宿主缺接口（非 web 组合）时静默不启，其余功能不受影响。
 *
 * @param {object} ctx 宿主 Context
 * @param {object} env `{ root, storePath, cfg, store, bridge, log }`
 */
export function mountWake(ctx, env) {
  const { root, store, bridge } = env;
  const statePath = join(root, STATE_FILE);
  const state = readState(statePath);
  const save = () => writeState(statePath, state);
  const log = env.log ?? (() => {});
  let handle = null;
  let stopped = false;
  let busy = false;
  let generation = 0;
  let retryAt = 0;
  let retries = 0;
  let lastPartnerSpoke = 0;
  let host = null;
  /** 会话落盘：sessions 服务只在桌面宿主里有，拿不到就跳过（steer 已经进了内存队列）。 */
  let flushSession = async () => {};

  const config = () => readWakeConfig(store());
  const sessionOf = () => config().sessionId;

  /** 引擎局在映射表里的键：全局作用域下一局共用，会话作用域一会话一局。 */
  const keyOf = (sessionId) => (bridge.scopeOf() === "global" ? "shared" : sessionId);

  const rowFor = () => {
    const sessionId = sessionOf();
    if (sessionId === "") return null;
    const row = bridge.mappingOf(keyOf(sessionId));
    return row !== null && typeof row.session_id === "string" ? row : null;
  };

  const dayRoll = () => {
    const today = localDay(new Date());
    if (state.day !== today) {
      state.day = today;
      state.count = 0;
      state.tokens = 0;
    }
  };

  /** 今天还有额度吗；没有就返回该说的话。 */
  const overQuota = (cfg) => {
    dayRoll();
    if (cfg.dailyLimit > 0 && state.count >= cfg.dailyLimit) return "今天的次数用完了（" + state.count + "/" + cfg.dailyLimit + "）";
    if (cfg.dailyTokens > 0 && state.tokens >= cfg.dailyTokens) return "今天的 token 用完了（" + state.tokens + "/" + cfg.dailyTokens + "）";
    return null;
  };

  /** 问引擎下一次该什么时候醒；失败不抛，记一条错误并且不再定时。 */
  const ask = async (ticket) => {
    const cfg = config();
    if (!cfg.enabled || stopped) return null;
    const sessionId = sessionOf();
    if (sessionId === "") return null;
    const row = rowFor();
    if (row === null) {
      // 还没开局（或是新会话还没跑第一回合）：没有账本就没法算，等下一次 commit 再说。
      state.at = null;
      state.reason = null;
      state.why = null;
      save();
      return null;
    }
    const payload = {
      session_id: row.session_id,
      miss_you_hours: cfg.missYou,
      streak: Math.min(state.streak, 20),
      last_wake_at: state.lastDeliveredAt,
      routine: cfg.routine,
      quiet: cfg.quiet,
    };
    try {
      const data = await bridge.call("next-wake", payload, {});
      if (ticket !== generation || stopped || !config().enabled) return null;
      const next = data !== null && typeof data === "object" ? data.next : null;
      state.lastError = null;
      if (next === null || typeof next !== "object") {
        state.at = null;
        state.reason = null;
        state.why = null;
      } else {
        state.at = typeof next.at_real === "string" ? next.at_real : null;
        state.reason = typeof next.reason === "string" ? next.reason : null;
        state.why = typeof next.why === "string" ? next.why : null;
      }
      save();
      return state.at;
    } catch (error) {
      if (ticket !== generation || stopped || !config().enabled) return null;
      state.lastError = error instanceof Error ? error.message : String(error);
      save();
      return null;
    }
  };

  const clearTimer = () => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };

  /** 挂下一个定时器：最多睡 5 分钟再对一次墙钟。 */
  const arm = () => {
    clearTimer();
    if (stopped || busy || !config().enabled) return;
    const at = dueAt(state.at);
    if (at === null) return;
    const target = Math.max(at, retryAt);
    const wait = Math.min(Math.max(0, target - Date.now()), SEGMENT_MS);
    handle = setTimeout(() => {
      handle = null;
      if (stopped || !config().enabled) return;
      const now = Date.now();
      const due = dueAt(state.at);
      if (due !== null && Math.max(due, retryAt) > now) {
        arm();
        return;
      }
      void fire();
    }, wait);
  };

  const backoff = () => {
    const minutes = RETRY_MINUTES[Math.min(retries++, RETRY_MINUTES.length - 1)];
    retryAt = Date.now() + minutes * 60000;
    arm();
    return minutes;
  };

  /** 到点了：检查、送达、记账。任何一步不满足都记原因并改期，不抛。 */
  const fire = async () => {
    if (busy || stopped) return { delivered: false, error: "唤醒线正忙" };
    busy = true;
    const ticket = generation;
    clearTimer();
    try {
      const cfg = config();
      const sessionId = sessionOf();
      const reason = state.reason;
      if (host === null) {
        // 没挂宿主时也要把时刻清掉：否则 finally 里的 arm() 会拿同一个过去时刻
        // 反复重挂，变成 0ms 的忙循环把 CPU 打满。
        state.at = null;
        save();
        return { delivered: false, error: "唤醒线没挂载（缺桌面宿主）" };
      }
      if (!cfg.enabled) return { delivered: false, error: "唤醒线关着" };
      if (sessionId === "") return { delivered: false, error: "还没指定她醒在哪场对话" };
      const quota = overQuota(cfg);
      if (quota !== null) {
        state.lastError = quota;
        state.streak += 1;
        state.at = null;
        save();
        return { delivered: false, error: quota };
      }
      // 你刚说过话：你们还在聊，用不着她「醒」。推后一会儿，不改额度。
      if (lastPartnerSpoke !== 0 && Date.now() - lastPartnerSpoke < RECENT_TALK_MS) {
        state.lastError = "你刚说过话，等她这一会儿";
        save();
        retryAt = Date.now() + BUSY_PUSH_MS;
        arm();
        return { delivered: false, error: "你刚说过话，等她这一会儿" };
      }
      const agent = await host.resolveAgent(sessionId);
      if (ticket !== generation || stopped || !config().enabled || sessionOf() !== sessionId) {
        return { delivered: false, error: "唤醒配置已变更，取消本次唤醒" };
      }
      if (agent === undefined || agent === null) {
        state.lastError = "会话不在了";
        state.at = null;
        save();
        return { delivered: false, error: "会话不在了" };
      }
      if (agent.status === "running") {
        state.lastError = "会话正在跑，推后 5 分钟";
        save();
        retryAt = Date.now() + BUSY_PUSH_MS;
        arm();
        return { delivered: false, error: "会话正在跑，推后 5 分钟" };
      }
      const text = renderWakeText({
        root,
        when: state.when ?? "",
        why: reason === "plan" ? state.why : null,
        player: state.playerName ?? "你",
      });
      agent.steer(createUserMessage({ source: { kind: WAKE_SOURCE }, content: [{ type: "text", text }] }));
      markWakeTurn(sessionId);
      await flushSession(agent.session);
      dayRoll();
      state.count += 1;
      state.streak += 1;
      state.lastDeliveredAt = new Date().toISOString();
      state.lastError = null;
      state.at = null;
      state.reason = null;
      state.why = null;
      retryAt = 0;
      retries = 0;
      save();
      return { delivered: true };
    } catch (error) {
      const minutes = (() => {
        state.lastError = (error instanceof Error ? error.message : String(error)) + "，稍后重试";
        save();
        return backoff();
      })();
      log("wake delivery failed, retry in " + String(minutes) + " min");
      return { delivered: false, error: state.lastError };
    } finally {
      busy = false;
      arm();
    }
  };

  /** 重算并重新挂表（commit 成功、turn 结束、改配置、插件启动都走这里）。 */
  const reschedule = async () => {
    const ticket = ++generation;
    clearTimer();
    if (stopped || !config().enabled) {
      state.at = null;
      state.reason = null;
      state.why = null;
      retryAt = 0;
      save();
      return;
    }
    await ask(ticket);
    if (ticket !== generation || stopped || !config().enabled) return;
    // 让唤醒消息里的时刻与她看到的一致：用引擎给的下一次时刻的钟点。
    const at = dueAt(state.at);
    if (at !== null) {
      const d = new Date(at);
      state.when = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    save();
    arm();
  };

  /** 设置页「现在叫醒一次」：绕过时刻与安静时段，但照样计入今天的次数。 */
  const fireNow = async () => {
    const cfg = config();
    const quota = overQuota(cfg);
    if (quota !== null) return { ok: false, error: quota };
    state.reason = "manual";
    state.why = "";
    const now = new Date();
    state.when = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const out = await fire();
    if (out.delivered === true) return { ok: true, count: state.count };
    return { ok: false, error: out.error ?? "没能叫醒她" };
  };

  const snapshot = () => ({
    config: config(),
    state: {
      at: state.at,
      reason: state.reason,
      why: state.why,
      when: state.when ?? null,
      day: state.day,
      count: state.count,
      tokens: state.tokens,
      streak: state.streak,
      lastError: state.lastError,
      lastDeliveredAt: state.lastDeliveredAt,
      retryAt: retryAt === 0 ? null : new Date(retryAt).toISOString(),
    },
    mounted: host !== null,
  });

  const start = () => {
    if (typeof ctx.on !== "function") return;
    if (typeof ctx.inject !== "function") return;
    // sessionController 只有装了桌面宿主才有：CLI/TUI 下不启唤醒线。
    // sessions 用来把 steer 进去的消息立刻落盘；没有它也能跑，只是晚一点落盘。
    // sessions 单独注入：它只用来把 steer 的消息立刻落盘，缺了不该整条线不启。
    if (typeof ctx.inject === "function") {
      ctx.inject(["sessions"], (sctx) => {
        const service = sctx.sessions;
        if (service !== null && typeof service === "object" && typeof service.flush === "function") {
          flushSession = async (session) => {
            try {
              await service.flush(session);
            } catch {
              // 会话已经关了：不阻断唤醒。
            }
          };
        }
      });
    }
    ctx.inject(["sessionController"], (hctx) => {
      host = {
        resolveAgent: async (sessionId) => {
          const found = await hctx.sessionController.resolveAgent(sessionId);
          if (found !== null && typeof found === "object") {
            if ("agent" in found) return found.agent;
            if (found.error?.code === "session/not-found") return undefined;
          }
          return undefined;
        },
        /** 设置页「指定会话」下拉的数据源：最近更新的在前，跳过 subagent。 */
        list: async () => {
          const out = [];
          const controller = new AbortController();
          try {
            const value = await hctx.sessionController.list({}, controller.signal);
            for (const item of Array.isArray(value?.items) ? value.items : []) {
              if (item === null || typeof item !== "object") continue;
              if (item.origin === "subagent") continue;
              const title = item.projections?.values?.title;
              out.push({
                sessionId: String(item.sessionId ?? ""),
                title: typeof title === "string" && title !== "" ? title : "（未命名）",
                updatedAt: Number(item.updatedAt) || 0,
                running: item.running === true,
              });
            }
          } catch {
            // 列不出来不该让设置页整块报错：给一份空清单，前端显示「还没有会话」。
          }
          out.sort((a, b) => b.updatedAt - a.updatedAt);
          return out;
        },
      };
      const offs = [
        ctx.on("session/event", (session, event) => {
          if (session === null || session === undefined) return;
          const cfg = config();
          const watching = cfg.sessionId !== "" && session.id === cfg.sessionId;
          if (event.type === "user/message") {
            const source = event.data?.source;
            if (source?.kind === "user") {
              // 你在唤醒回合里说话了：这就变回「你们在一起」，账本按 together 记。
              clearWakeTurn(session.id);
              if (watching) {
                lastPartnerSpoke = Date.now();
                state.streak = 0;
                save();
                void reschedule();
              }
            }
            return;
          }
          if (!watching) return;
          if (event.type === "assistant/message" && isWakeTurn(session.id)) {
            const usage = event.data?.usage;
            if (usage !== null && typeof usage === "object") {
              const total = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadTokens) || 0);
              dayRoll();
              state.tokens += total;
              save();
            }
            return;
          }
          if (event.type === "turn/end") {
            clearWakeTurn(session.id);
            void reschedule();
          }
        }),
      ];
      ctx.effect(() => () => {
        for (const off of offs) {
          try {
            off();
          } catch {
            // 卸载时的清理失败不该影响下一次加载。
          }
        }
        host = null;
        stopped = true;
        generation++;
        clearTimer();
        clearAllWakeTurns();
      }, "rp-soul wake dispose");
      void reschedule();
    });
  };

  const listSessions = async () => (host === null ? [] : host.list());

  return { start, reschedule, snapshot, fireNow, config, listSessions, isWakeTurn, markWakeTurn, clearWakeTurn };
}
