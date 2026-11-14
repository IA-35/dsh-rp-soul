/**
 * engine-v2-memory —— 记忆模块的宿主那一半（新引擎）。
 *
 * ABM 的正文首选她自己写：回合结束时她在 soul_commit 里填 remember。
 * 但她七百多轮里只填过六次——光指望她主动写，记忆就是空的。所以这里还有一道兜底：
 * 她没写的回合，宿主把「你说了什么、她回了什么」攒起来，攒够几轮 / 够字数 /
 * 第一轮起搁了够久，就落一条原文进 ABM（就是旧引擎 noteTurn 那套，原样搬回来）。
 * 攒的确实就是我们对话的原文 —— 记的就是原话，不加工。
 * 她这一轮写过 remember 就跳过：那条更完整。
 *
 * 除此之外宿主还管两件她自己做不了的事：
 *   1. ABM 攒够了 / 欠着日记：起子代理收成一条 SCM、写成一篇日记，不等对话中的她交作业。
 *      provider 用 spawn（零父上下文），delivery: "caller"（结果只回到这里，不打扰对话）。
 *      喂给子代理的那批条目总量也有上限，超了每条平分额度。
 *   2. 被主子这句话勾起的记忆加一点活跃度（想起来的忘得慢），一轮一次。
 *
 * 写回引擎走 applyFold / applyDiary / noteMemory：不动 revision，模型手里的 revision 照样有效。
 * 日记落成文件：<数据目录>/../memory/diary-YYYY-MM-DD.md（即 rp-soul/memory/，和旧引擎同一处），
 * 第一行是「# 11月11日 · 周三」。
 */

import { dirname, join } from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dayTitle, CONTENT_MAX } from "./engine/modules/memory/layers.js";

const NL = "\n";
/** 收 SCM / 写日记时喂给子代理的那批条目一共多少字。 */
const SOURCE_BUDGET = 12000;
const FOLD_RETRY_MS = 5 * 60 * 1000;
const FOLD_GIVE_UP = 3;
const FOLD_TIMEOUT_MS = 2 * 60 * 1000;
const DIARY_MAX = 300;
/** 兜底录音：攒够这么多轮就落一条 ABM。 */
const BATCH_TURNS = 4;
/** 或者攒够这么多字（几轮「嗯」加起来也算够数）。 */
const BATCH_CHARS = 1200;
/** 或者从这一批第一轮起搁了这么久（聊两句就走的那批不能一直挂着）。 */
const BATCH_MINUTES = 30;
/** 录音铺开时的叫法：账本里「你」是主人，「她」是她。 */
const LEDGER_LABELS = Object.freeze({ you: "你", her: "她" });
/** 新写法：diary-2026-11-11.md（按日历日）。 */
export const DIARY_FILE = /^diary-(\d{4}-\d{2}-\d{2})\.md$/;
/** 旧引擎写法：diary-0014.md（按第几天）。同一处也认，老日记不用改名。 */
export const DIARY_NUMBERED = /^diary-(\d{4})\.md$/;

const FOLD_PROMPT = [
  "把下面这一批经历收成一条记忆，第一人称（我），用中文写。",
  "",
  "要求：",
  "1. **按时间顺序写**。每行前面都带着它发生的时间（「周六下午 15:50」这种），",
  "   照着那个先后排；不要把这批里后发生的事挪到前面。",
  "2. **每换一件事，要让人看得出是换了一件事**：用「后来」「接着」「那之后」",
  "   这类词接上，或者直接把这件事的时间点写出来（「快十二点的时候」「下午三点多」）。",
  "   不许两件事之间没有任何过渡就粘在一起。",
  "3. 一批里的事要是事与事之间没有因果关系，就分开写，别硬连成一句。",
  "4. 记得发生了什么、我当时的感受；留下带得住的细节（具体的话、动作、东西）。",
  "5. 不要分点，不要写「用户」「助手」这类词。写得像自己在回想这一天。",
  "6. 最多 {LIMIT} 字。宁可少写两件事，也不要把两件事压成一句。",
  "   只输出这条记忆本身，不要调用任何工具。",
  "7. 另外从这批里挑 0~2 条最值得一直记着的（真正的转折、承诺、第一次），",
  "   把它们前面的 id 用逗号写在最后一行，格式：KEEP: m12, m15 —— 没有就写 KEEP:",
  "",
  "这一批：",
].join(NL);

const DIARY_PROMPT = [
  "下面是我这一天记下的事。把它写成一篇日记，第一人称（我），用中文写。",
  "",
  "要求：",
  "1. 按时间顺下来，记得当时的感受和心情的变化；留一两个具体的细节。",
  "2. 不要分点，不要写「用户」「助手」这类词，不要编没发生的事。",
  "3. 最多 300 字。只输出日记正文，不要标题，不要调用任何工具。",
  "",
].join(NL);

/** 掐中间留头尾：超了 n 字，留前三分之二和后三分之一，中间写「……」。 */
export function clipMiddle(text, n) {
  if (text.length <= n) return text;
  const head = Math.ceil((n - 1) * 2 / 3);
  const tail = n - 1 - head;
  return text.slice(0, head) + "…" + (tail > 0 ? text.slice(-tail) : "");
}

/** 一批条目喂给子代理之前：总量超了就每条平分额度、各自掐中间。 */
export function budgetSources(sources, budget = SOURCE_BUDGET) {
  const total = sources.reduce((sum, s) => sum + s.text.length, 0);
  if (total <= budget) return sources;
  const share = Math.max(80, Math.floor(budget / Math.max(1, sources.length)));
  return sources.map((s) => ({ ...s, text: clipMiddle(s.text, share) }));
}

/** 这是不是这个会话的第一轮（她还一句话都没说过）：新会话第一轮要带上最近一篇日记。 */
export function isFirstTurn(context) {
  try {
    const messages = context?.agent?.session?.deriveMessages?.() ?? [];
    return !messages.some((m) => m?.role === "assistant"
      && (Array.isArray(m.content) ? m.content : []).some((b) => b?.type === "text" && String(b.text ?? "").trim() !== ""));
  } catch {
    return false;
  }
}

/** 这一批该给多少字：一个时间点 300 字，多一个时间点多 40 字，最多 600。 */
export const foldLimit = (sources) => Math.min(300 + 40 * Math.max(0, new Set(sources.map((s) => s.when)).size - 1), 600);

/** 从子代理的输出里拆出正文和 KEEP 行。 */
export function splitFold(text, limit = 300) {
  const keep = [];
  const kept = [];
  for (const line of String(text ?? "").split(NL)) {
    const match = /^\s*KEEP\s*[:：]\s*(.*)$/i.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    for (const id of match[1].split(/[,，\s]+/)) if (/^m\d+$/.test(id.trim())) keep.push(id.trim());
  }
  return { text: kept.join(NL).trim().slice(0, limit), keep: keep.slice(0, 2) };
}

const outputText = (result) => (Array.isArray(result?.output) ? result.output : [])
  .filter((block) => block?.type === "text" && typeof block.text === "string")
  .map((block) => block.text)
  .join(NL);

/**
 * 挂上记忆的宿主那一半。deps：
 *   ctx            插件 Context（拿 subagents / agents 服务）
 *   engine()       新引擎（还没就绪会抛）
 *   isChildAgent / cueOf / dataDirOf / aloneOf / onWrote
 */
export function mountMemoryHost(deps) {
  const { ctx, engine, isChildAgent, cueOf, dataDirOf, aloneOf } = deps;
  const busy = new Set();
  const failures = new Map();
  /** 攒着还没落的对话原文，按 agent 分槽。 */
  const batches = new Map();
  /** 最近在这一局说过话的 agent：设置页点「立即汇总」时拿它当子代理的父。 */
  let liveAgentId = null;

  const subagentsOf = () => {
    const subagents = typeof ctx.get === "function" ? ctx.get("subagents") : undefined;
    return subagents && typeof subagents.startActivation === "function" ? subagents : null;
  };
  const resting = (slot) => {
    const f = failures.get(slot);
    return f !== undefined && f.count >= FOLD_GIVE_UP && Date.now() - f.at < FOLD_RETRY_MS;
  };

  /** 起一个子代理跑一段提示词，返回它写的字；失败 / 超时返回 null。 */
  const ask = async (parent, label, prompt, slot) => {
    const subagents = subagentsOf();
    if (subagents === null || parent === null || isChildAgent(parent) || busy.has(slot) || resting(slot)) return null;
    busy.add(slot);
    const before = failures.get(slot) ?? { count: 0, at: 0 };
    failures.set(slot, { count: before.count + 1, at: Date.now() });
    const abort = new AbortController();
    let activation = null;
    let timer = null;
    try {
      activation = await subagents.startActivation({
        provider: "spawn",
        label,
        request: { parent, prompt: [{ type: "text", text: prompt }], signal: abort.signal },
        signal: abort.signal,
        delivery: "caller",
      });
      // 子代理卡住时 result 永不 settle：自己给个上限，到点掐掉
      const bell = new Promise((_ok, fail) => {
        timer = setTimeout(() => { abort.abort(); fail(new Error("子代理超时")); }, FOLD_TIMEOUT_MS);
      });
      const result = await Promise.race([activation.result, bell]);
      if (result?.stopReason !== "completed") return null;
      failures.delete(slot);
      return outputText(result);
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (activation !== null && typeof activation.dispose === "function") await activation.dispose().catch(() => {});
      busy.delete(slot);
    }
  };

  /**
   * 回合结束：给被这句话勾起的记忆加一点活跃度，并把她没写的那些轮攒成一条 ABM。
   *
   * 她不写 remember 的时候（七百多轮里六百多次），至少这段对话本身要留下来 ——
   * 攒够几轮 / 够字数 / 搁够久就落一条原文，和旧引擎那一套一样。
   */
  const noteTurn = async (context) => {
    const agent = context?.agent;
    if (typeof agent?.session?.deriveMessages !== "function" || isChildAgent(agent)) return null;
    const agentId = typeof agent.id === "string" ? agent.id : "";
    if (agentId !== "") liveAgentId = agentId;
    // 她自己醒来的那一轮没有「你说的话」：会话里最后一句你的话是上一回的，
    // 配上她醒来时说的，就成了一问一答的假记录。
    const alone = aloneOf(context);
    const said = alone ? "" : cueOf(context);
    if (said !== "") {
      try {
        engine().reinforce(said);
      } catch {
        /* 加不上不要紧 */
      }
    }
    const reply = lastReplyOf(context, said);
    if (said === "" && reply === "") return null;
    return remember(said, reply, alone, context);
  };

  /** 攒着的那几轮（按 agent 分槽）：攒够就落一条 ABM。 */
  const remember = (said, reply, alone, context) => {
    const slot = typeof context?.agent?.id === "string" ? context.agent.id : "all";
    let batch = batches.get(slot);
    if (batch === undefined) {
      batch = { parts: [], firstAt: 0, timer: null, context: null };
      batches.set(slot, batch);
    }
    const last = batch.parts[batch.parts.length - 1];
    // 同一轮被重发（宿主重试、页面刷新）：攒着的那份已经有它了，别再压一遍
    if (last === undefined || last.said !== said || last.reply !== reply) {
      batch.parts.push({ said, reply, alone });
    }
    if (batch.firstAt === 0) batch.firstAt = Date.now();
    batch.context = context;
    if (!batchIsDue(batch)) {
      armBatchTimer(slot);
      return null;
    }
    forgetBatch(slot);
    return noteRaw(batch.parts);
  };

  /** 攒着的这些够不够落一条。 */
  const batchIsDue = (batch) => {
    if (batch.parts.length === 0) return false;
    if (batch.parts.length >= BATCH_TURNS) return true;
    const chars = batch.parts.reduce((sum, one) => sum + one.said.length + one.reply.length, 0);
    if (chars >= BATCH_CHARS) return true;
    return batch.firstAt > 0 && Date.now() - batch.firstAt >= BATCH_MINUTES * 60 * 1000;
  };

  /** 聊两句就走的那一批不能一直挂在内存里等下一次开口（那会和下一次的对话粘成一件事）。 */
  const armBatchTimer = (slot) => {
    const batch = batches.get(slot);
    if (batch === undefined || batch.timer !== null) return;
    const left = Math.max(0, batch.firstAt + BATCH_MINUTES * 60 * 1000 - Date.now());
    batch.timer = setTimeout(() => {
      const due = batches.get(slot);
      if (due === undefined) return;
      forgetBatch(slot);
      void Promise.resolve(noteRaw(due.parts)).catch(() => {});
    }, left);
    if (typeof batch.timer?.unref === "function") batch.timer.unref();
  };

  const forgetBatch = (slot) => {
    const batch = batches.get(slot);
    if (batch === undefined) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    batches.delete(slot);
  };

  /** 把这一批落成一条 ABM：就是原文，不加工。落不上就算了，下一批再记。 */
  const noteRaw = (parts) => {
    const text = batchText(parts);
    if (text === "") return null;
    try {
      engine().noteMemory(text);
    } catch {
      // 记不上就算了：这是附带品，绝不能因为它把一轮对话搞挂
    }
    return null;
  };

  /** 一轮铺成「你：… 她：…」。 */
  const partText = (said, reply) => {
    const you = LEDGER_LABELS.you + "：" + said;
    const her = LEDGER_LABELS.her + "：" + reply;
    if (said !== "" && reply !== "") return you + NL + her;
    return said !== "" ? you : her;
  };

  /** 截到 n 字以内，截了就补一个省略号。 */
  const clipText = (text, n) => (text.length <= n ? text : text.slice(0, Math.max(0, n - 1)) + "…");

  /** 一批：多轮时「你：… 她：…」一轮一组按顺序铺开；超上限就每轮平分额度各自截短。 */
  const batchText = (parts) => {
    const full = parts.map((one) => partText(one.said, one.reply)).join(NL);
    if (full.length <= CONTENT_MAX) return full;
    const overhead = LEDGER_LABELS.you.length + LEDGER_LABELS.her.length + 3;
    const share = Math.floor((CONTENT_MAX - (parts.length - 1)) / parts.length) - overhead;
    return parts.map((one) => {
      const said = clipText(one.said, Math.min(one.said.length, Math.floor(share * 0.4)));
      const reply = clipText(one.reply, Math.max(0, share - said.length));
      return partText(said, reply);
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

  /** 日记和旧引擎放一处：<数据目录的上一层>/memory（数据目录是 rp-soul/engine）。 */
  const journalDir = () => join(dirname(dataDirOf()), "memory");

  /** 起子代理做一件整理（fold / diary），写回引擎。写成了返回 true。 */
  const runTidy = async (parent, kind, view) => {
    if (view === null || view.sources.length === 0) return false;
    if (kind === "fold") {
      const limit = foldLimit(view.sources);
      const lines = budgetSources(view.sources).map((s) => "- " + s.id + " " + s.when + "：" + s.text);
      const said = await ask(parent, "记忆整理", FOLD_PROMPT.replace("{LIMIT}", String(limit)) + lines.join(NL), "fold");
      if (said === null) return false;
      const folded = splitFold(said, limit);
      if (folded.text === "") return false;
      return engine().applyFold(view.ids, folded.text, folded.keep) !== null;
    }
    const lines = budgetSources(view.sources).map((s) => "- " + s.when + "：" + s.text);
    const said = await ask(parent, "写日记", DIARY_PROMPT + lines.join(NL), "diary");
    const text = (said ?? "").trim().slice(0, DIARY_MAX);
    if (text === "") return false;
    await mkdir(journalDir(), { recursive: true });
    await writeFile(join(journalDir(), "diary-" + view.day + ".md"), "# " + dayTitle(view.day) + NL + NL + text + NL, "utf8");
    return engine().applyDiary(view.day, view.ids, text) !== null;
  };

  /** 回合结束后的整理：先收 ABM，再写日记（日记读 SCM，刚收进去的那条也该写进今天）。 */
  const tidyMemory = async (context) => {
    const parent = context?.agent ?? null;
    if (parent === null || isChildAgent(parent)) return;
    let wrote = false;
    try {
      wrote = await runTidy(parent, "fold", engine().memoryDue().fold);
      wrote = (await runTidy(parent, "diary", engine().memoryDue().diary)) || wrote;
    } catch {
      return; // 收不上就攒着，下一轮再看
    }
    if (wrote) deps.onWrote?.();
  };

  /**
   * 设置页「立即汇总 / 立即写日记」：不等，后台起子代理。返回
   * started / no-agent / nothing / busy / resting（和旧桥接一样的那几个词）。
   */
  const tidyNow = (kind) => {
    const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
    const usable = (agent) => agent !== undefined && agent !== null && !isChildAgent(agent);
    let parent = liveAgentId !== null && typeof agents?.get === "function" ? agents.get(liveAgentId) : undefined;
    if (!usable(parent)) {
      const all = typeof agents?.roots === "function" ? agents.roots() : typeof agents?.list === "function" ? agents.list() : [];
      parent = all.find(usable);
    }
    if (!usable(parent)) return "no-agent";
    const view = engine().memoryDue({ manual: true })[kind];
    if (view === null) return "nothing";
    if (busy.has(kind)) return "busy";
    if (resting(kind)) return "resting";
    void runTidy(parent, kind, view).then((wrote) => { if (wrote) deps.onWrote?.(); }).catch(() => {});
    return "started";
  };

  /**
   * 设置页翻日记：新的在前。目录不存在（还没写过）就是空列表。
   * 两种文件名都认：新的 diary-2026-11-11.md 直接用文件名里的日期；
   * 旧的 diary-0014.md 只有「第几天」，日期取文件的修改时间（旧引擎就是那天写的）。
   */
  const diaries = async (limit = 60) => {
    let names = [];
    try {
      names = await readdir(journalDir());
    } catch {
      return [];
    }
    const rows = [];
    for (const name of names) {
      const named = DIARY_FILE.exec(name);
      if (named !== null) {
        rows.push({ day: named[1], file: name });
        continue;
      }
      if (DIARY_NUMBERED.exec(name) === null) continue;
      const meta = await stat(join(journalDir(), name)).catch(() => null);
      if (meta === null) continue;
      const at = new Date(meta.mtimeMs);
      const day = at.getFullYear() + "-" + String(at.getMonth() + 1).padStart(2, "0") + "-" + String(at.getDate()).padStart(2, "0");
      rows.push({ day, file: name });
    }
    rows.sort((a, b) => (a.day === b.day ? a.file.localeCompare(b.file) : a.day.localeCompare(b.day)));
    const out = [];
    for (const row of rows.reverse().slice(0, limit)) {
      const raw = await readFile(join(journalDir(), row.file), "utf8").catch(() => null);
      if (raw === null) continue;
      const lines = raw.replace(/\r\n/g, NL).split(NL);
      const titled = lines[0].startsWith("# ");
      out.push({ day: row.day, title: titled ? lines[0].slice(2).trim() : dayTitle(row.day), text: (titled ? lines.slice(1) : lines).join(NL).trim() });
    }
    return out;
  };

  /** 清空 / 换局 / 卸载：忘掉子代理的失败计数、攒着没落的那几批、说话的那一局。 */
  const forget = () => {
    failures.clear();
    for (const slot of [...batches.keys()]) forgetBatch(slot);
    liveAgentId = null;
  };

  return { noteTurn, tidyMemory, tidyNow, diaries, forget, journalDir };
}
