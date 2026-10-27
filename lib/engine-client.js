/**
 * engine-client —— rp-soul 引擎（Python 侧车）的常驻客户端。
 *
 * 为什么是常驻子进程而不是每次调用 `python -m rp_soul_engine <cmd>`：
 * 每回合至少要问两次状态（get-context + commit-turn），冷启动每次都要
 * 重新 import 三十几个模块、连一次 SQLite、读一遍人设 —— 在聊天循环里
 * 那是肉眼可见的卡顿。这里 spawn 一次，靠 stdin/stdout 走 JSON lines：
 *
 *     -> {"id": "c1", "command": "get-context", "payload": {...}}
 *     <- {"id": "c1", "ok": true, "data": {...}}
 *
 * 不进端口、不要鉴权、插件卸载时随进程一起回收。
 *
 * 失败语义：spawn 不了（机器上没有 Python）不算崩溃而是「引擎不可用」，
 * 调用方据此退化成人设提示词模式；引擎已启动但命令报错则抛 EngineError，
 * 里面带引擎给的结构化 details，模型能照着改。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 侧车协议版本；与 engine/rp_soul_engine/__init__.py 的 ENGINE_VERSION 对齐。 */
export const PROTOCOL = 1;

/** 引擎要求的 Python 下限。 */
export const MIN_PYTHON = [3, 10];

/** 单条命令的默认超时（毫秒）。开局要建整局状态，给得宽一点。 */
const DEFAULT_TIMEOUT = 30000;
/** stdout 行缓冲的上界（字符）：一行超长输出不能把内存吃掉。 */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

/** 探测 Python 时尝试的解释器（按顺序）。 */
const PYTHON_CANDIDATES = [
  { cmd: "python3", args: [] },
  { cmd: "python", args: [] },
  { cmd: "py", args: ["-3"] },
];

const HERE = dirname(fileURLToPath(import.meta.url));

/** 插件目录下的 engine/ 子目录（随插件一起分发，不需要 pip install）。 */
export function engineRoot() {
  return resolve(HERE, "..", "engine");
}

/** 探测结果缓存（五秒内不重复探）。 */
let probed = null;

/**
 * 找一个能跑的 Python。
 * @returns {{ok: true, cmd: string, args: string[], version: number[]}
 *          | {ok: false, reason: string, found?: object}}
 */
export function probePython() {
  if (probed !== null && Date.now() - probed.at < 5000) return probed.value;
  const override = process.env.RP_SOUL_PYTHON;
  const candidates = override
    ? [{ cmd: override, args: [] }].concat(PYTHON_CANDIDATES)
    : PYTHON_CANDIDATES;
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.cmd + " " + candidate.args.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const result = spawnSync(
      candidate.cmd,
      candidate.args.concat(["-c", "import sys;print('%d.%d' % sys.version_info[:2])"]),
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    if (result.error || result.status !== 0) continue;
    const text = String(result.stdout ?? "").trim();
    const match = /^(\d+)\.(\d+)$/.exec(text);
    if (!match) continue;
    const version = [Number(match[1]), Number(match[2])];
    const ok = version[0] > MIN_PYTHON[0]
      || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1]);
    if (!ok) {
      probed = { at: Date.now(), value: {
        ok: false,
        reason: "找到的 Python 是 " + version.join(".") + "，引擎需要 "
          + MIN_PYTHON.join(".") + " 或更新",
        found: { cmd: candidate.cmd, args: candidate.args, version },
      } };
      return probed.value;
    }
    probed = { at: Date.now(), value: { ok: true, cmd: candidate.cmd, args: candidate.args, version } };
    return probed.value;
  }
  probed = { at: Date.now(), value: {
    ok: false,
    reason: "没找到 Python " + MIN_PYTHON.join(".") + "+（试过 python3 / python / py -3；"
      + "可用环境变量 RP_SOUL_PYTHON 指定解释器）",
  } };
  return probed.value;
}

/** 引擎包是否在位（子目录 + __main__.py）。 */
export function enginePresent() {
  try {
    return existsSync(join(engineRoot(), "rp_soul_engine", "__main__.py"));
  } catch {
    return false;
  }
}

/** 引擎返回的结构化错误。 */
export class EngineError extends Error {
  constructor(envelope) {
    const error = envelope && typeof envelope.error === "object" && envelope.error !== null
      ? envelope.error
      : {};
    super(typeof error.message === "string" ? error.message : "引擎报错");
    this.name = "EngineError";
    this.code = typeof error.code === "string" ? error.code : "ENGINE_ERROR";
    this.details = Array.isArray(error.details) ? error.details : [];
    this.errorId = error.error_id ?? null;
    this.log = error.log ?? null;
    this.nextRequestId = error.next_request_id ?? null;
    // STALE_REVISION 会在顶层附带当前 revision 与一小段上下文，直接留着用。
    this.currentRevision = Number.isFinite(error.current_revision) ? error.current_revision : null;
    this.context = error.context ?? null;
    this.body = error;
  }

  /** 给模型看的多行摘要：消息 + 最多三条 details（带 path 与 hint）。 */
  summary() {
    const rows = this.details.slice(0, 3).map((item) => {
      const path = item && typeof item.path === "string" ? item.path : "$";
      const reason = item && typeof item.reason === "string" ? item.reason : "";
      const hint = item && typeof item.hint === "string" && item.hint !== ""
        ? "（" + item.hint + "）"
        : "";
      return path + "：" + reason + hint;
    });
    const head = "[" + this.code + "] " + this.message;
    return rows.length === 0 ? head : head + "\n" + rows.join("\n");
  }
}

/**
 * 常驻侧车客户端。一个进程服务整个插件生命周期里的所有调用。
 */
export class EngineClient {
  /**
   * @param {object} options
   * @param {string} options.dataDir 引擎数据目录（绝对路径）
   * @param {number} [options.timeoutMs] 单条命令默认超时
   * @param {(text: string) => void} [options.log] 可选日志回调（诊断用）
   */
  constructor(options) {
    const opts = options ?? {};
    this.dataDir = typeof opts.dataDir === "string" ? opts.dataDir : "";
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.counter = 0;
    this.stderr = [];
    this.exited = null;
    this.startError = null;
  }

  /** 解释器与引擎包都在位？ */
  available() {
    return enginePresent() && probePython().ok;
  }

  /** 不可用的原因（给设置页和工具报错用）。 */
  unavailableReason() {
    if (!enginePresent()) {
      return "引擎包缺失：" + join(engineRoot(), "rp_soul_engine")
        + " 不存在，插件装坏了";
    }
    return probePython().reason;
  }

  /** 进程是否活着。 */
  get alive() {
    return this.child !== null && this.child.exitCode === null && this.child.killed !== true;
  }

  /** 起进程（幂等）。 */
  start() {
    if (this.child !== null) return this.child;
    if (this.startError !== null) throw this.startError;    if (!enginePresent()) {
      this.startError = new Error(this.unavailableReason());
      throw this.startError;
    }
    const python = probePython();
    if (!python.ok) {
      this.startError = new Error(python.reason);
      throw this.startError;
    }
    if (this.dataDir === "") {
      this.startError = new Error("引擎数据目录没有配置");
      throw this.startError;
    }
    const args = python.args.concat(["-m", "rp_soul_engine", "--data-dir", this.dataDir]);
    const child = spawn(python.cmd, args, {
      cwd: engineRoot(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
      },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(String(chunk ?? "")));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk ?? "");
      this.stderr.push(text);
      if (this.stderr.length > 40) this.stderr.shift();
      this.log("[rp-soul engine stderr] " + text.trim());
    });
    child.on("error", (error) => {
      // spawn 失败时不会触发 exit，所以 child 必须在这里置回 null：
      // 否则 start() 第一行的 `if (this.child !== null)` 会永远短路，
      // 引擎从此再也起不来，只能重载插件。
      this.startError = error instanceof Error ? error : new Error(String(error));
      if (this.child === child) this.child = null;
      this._rejectAll(this.startError);
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal, at: Date.now() };
      if (this.child === child) this.child = null;
      this._rejectAll(new Error(
        "引擎进程退出了（code=" + String(code) + " signal=" + String(signal) + "）"
        + (this.stderr.length > 0
          ? "；最后的 stderr：" + this.stderr.join("").trim().slice(-500)
          : ""),
      ));
    });
    this.child = child;
    return child;
  }

  /**
   * 一条命令超时且已无人在等时，杀掉卡住的子进程。
   * 不这样做的话，串行的引擎会一直堵在这条命令后面，之后的每条都超时。
   */
  _killStuck(child) {
    if (child === null || this.child !== child) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退了 */
    }
    this.child = null;
  }

  /** 关掉进程（插件卸载 / 测试收尾）。 */
  async stop() {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    this._rejectAll(new Error("引擎客户端已关闭"));
    try {
      child.stdin.end();
    } catch {
      /* 管道已关 */
    }
    await new Promise((wait) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已经退了 */
        }
        wait();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        wait();
      });
    });
  }

  /**
   * 发一条命令。
   * @param {string} command 引擎命令名（new-game / get-context / commit-turn …）
   * @param {object} [payload] 命令输入
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<object>} 引擎返回的 data
   */
  async call(command, payload, options) {
    const opts = options ?? {};
    this.start();
    const child = this.child;
    if (child === null) throw this.startError ?? new Error("引擎进程没能启动");
    this.counter += 1;
    const id = "c" + this.counter;
    const line = JSON.stringify({ id, command, payload: payload ?? {} }) + "\n";
    const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this.timeoutMs;
    return await new Promise((settle, reject) => {
      const waiter = { };
      const finish = (fn, value) => {
        if (waiter.timer !== null && waiter.timer !== undefined) clearTimeout(waiter.timer);
        if (waiter.onAbort !== null && waiter.onAbort !== undefined && opts.signal) {
          try {
            opts.signal.removeEventListener("abort", waiter.onAbort);
          } catch {
            /* 已解除 */
          }
        }
        this.pending.delete(id);
        fn(value);
      };
      waiter.finish = finish;
      waiter.settle = settle;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        finish(reject, new Error("引擎在 " + timeout + " ms 内没有回答命令 "
          + command + "（id=" + id + "）"));
        // 引擎是单进程串行吃 stdin 的：一条命令超时后它还堵在前面算，后面每条
        // 都会跟着超时。没有别的命令在等时说明它真卡住了，直接杀掉让下次重起。
        if (this.pending.size === 0) this._killStuck(child);
      }, timeout);
      waiter.onAbort = null;
      if (opts.signal) {
        if (opts.signal.aborted) {
          finish(reject, new Error("调用已取消（" + command + "）"));
          return;
        }
        waiter.onAbort = () => finish(reject, new Error("调用已取消（" + command + "）"));
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.pending.set(id, waiter);
      try {
        child.stdin.write(line, "utf8");
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 收一行 stdout，按 id 派回。 */
  _onData(chunk) {
    this.buffer += chunk;
    // 缓冲上界：引擎若吐一行超长 JSON（或 traceback 误写到 stdout），
    // 不能让它把内存吃掉。超了就丢掉这半行，等下一个换行重新对齐。
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.log("[rp-soul engine] 输出行超过 " + MAX_BUFFER_CHARS + " 字符，丢弃");
      this.buffer = "";
      return;
    }
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() !== "") this._dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  _dispatch(line) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      this.log("[rp-soul engine] 无法解析的一行输出：" + line.slice(0, 200));
      return;
    }
    const id = envelope && typeof envelope.id === "string" ? envelope.id : "";
    const waiter = this.pending.get(id);
    if (waiter === undefined) {
      this.log("[rp-soul engine] 收到无人认领的回复（id=" + id + "）");
      return;
    }
    if (envelope.ok === true) waiter.finish(waiter.settle, envelope.data ?? {});
    else waiter.finish(waiter.reject, new EngineError(envelope));
  }

  _rejectAll(error) {
    const rows = Array.from(this.pending.values());
    this.pending.clear();
    for (const waiter of rows) waiter.finish(waiter.reject, error);
  }
}
