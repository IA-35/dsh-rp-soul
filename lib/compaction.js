/**
 * compaction —— 无工具压缩（tool-free compaction）。
 *
 * 为什么需要替换宿主的 dsh-compaction-basic：
 * 1. 角色扮演里每一回合都有一次 soul_state + 一次 soul_commit，工具结果是被引擎
 *    加工过的 JSON（心情条、信任、未结事项），几十个字的信息占了上千 token。
 *    压缩时把它们连同工具 schema 一起送进摘要请求，等于花大钱请模型读一堆
 *    它根本不该复述的结构化数据。这里在摘要输入里把 tool-call / tool/result /
 *    只有推理的 step 全部删掉，摘要只总结「你们俩说了什么」。
 * 2. 删掉工具之后，摘要请求与真正的对话请求共享最长的公共前缀，provider 的
 *    KV 缓存能复用 —— 压缩这一次调用本身也变便宜。
 * 3. 摘要里明确交代「记忆资料、时间与账本会在压缩后重新提供，不要写进摘要」，
 *    否则模型会把刚注入的记忆块又抄进摘要，压缩完等于记忆写了两遍。
 *
 * 实现方式是继承宿主的 BasicCompactionEngine，只覆写 summarize 这一个钩子
 * （宿主注释原文：Override this sole hook for a template or remote summarizer）。
 * 区域选择、surface 事务、压缩锁全部沿用宿主实现 —— 那部分容易写错且与
 * 本插件的关注点无关。
 */

import { BlockAssembler, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import z from "@deepseek-ai/schemastery";

/** 摘要指令：中文、口语总结，不要标题列表。 */
export const SUMMARY_INSTRUCTION = [
  "现在暂停对话，改为执行上下文压缩：把上面这段会话里双方的交流整理成一段精炼的中文摘要，供你之后接着对话使用。",
  "保留用户的意图、情绪与关系进展、明确要求、重要事实、已作决定、未完成事项和最近进展；最后一条用户发言尽量按原意完整保留。以「以下是此前交流的摘要」开头的消息是更早的摘要，请与新内容合并成同一段。",
  "以【我的时间】开头的消息是她自己定的闹钟和留给自己的话，不是用户说的话；把它当作她自己的安排来记，不要算作对方发言。",
  "开头写着「这是我们最近的聊天记录」的记忆资料、系统提示里的人设与当前局面（心情、信任、时间、地点）都会在压缩后重新提供，不要写进摘要。工具调用过程已从会话中删除，不要提及工具。",
  "保留准确的姓名、日期、数字和称呼，分清每件事是谁说的、谁做的。不要标题、列表或分段，不要开头语，不要补写原文没有的事实，不要调用任何工具，直接输出摘要正文。",
].join("\n");

/**
 * 模型会照抄它在旧摘要里见过的引导句；框架自己会加一次，所以这里删掉。
 */
const LEAD_ECHO = /^以下是(?:此前|之前)交流的摘要[^：:]{0,40}[：:]\s*/;

/** 这些 source 是插件注入的资料，不算「真实对话」，压缩判定时要排除。 */
const INJECTED_SOURCES = new Set(["time-context", "rp-soul-history"]);

/** 内容块拼成纯文本（判定「还有没有真对话」用）。 */
function flatten(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * 把一段对话里的工具痕迹全部删掉。
 *
 * 具体做三件事：
 * - 整条 role==='tool' 删掉（工具结果）；
 * - assistant 消息里的 tool-call 块删掉，前后文本重新合并成一条；
 * - 只剩推理没有正文的 assistant step 整条丢掉（它本来只是为了发工具调用）。
 * @param {ReadonlyArray<object>} messages 压缩区间内的消息
 * @returns {Array<object>}
 */
export function toolFreeMessages(messages) {
  const kept = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role !== "assistant") {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((block) => block.type !== "tool-call");
    if (!content.some((block) => block.type !== "reasoning")) continue;
    const previous = kept[kept.length - 1];
    if (previous !== undefined && previous.role === "assistant") {
      kept[kept.length - 1] = { ...previous, content: [...previous.content, ...content] };
    } else {
      kept.push(content.length === message.content.length ? message : { ...message, content });
    }
  }
  return kept;
}

/** 删完工具之后还剩不剩「值得总结的对话」。 */
export function hasConversation(messages) {
  return messages.some((message) => {
    if (message.role !== "user" && message.role !== "assistant") return false;
    const kind = message.source === undefined ? undefined : message.source.kind;
    if (kind !== undefined && INJECTED_SOURCES.has(kind)) return false;
    return flatten(message.content) !== "";
  });
}

/** 从会话最新的请求头里取当前路由（provider/model），没有就用 agent 自己的。 */
function routedTarget(session, agent) {
  const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
  const config = header === undefined ? undefined : header.config;
  if (config !== undefined && typeof config.provider === "string" && typeof config.model === "string") {
    return { provider: config.provider, model: config.model };
  }
  const options = agent === undefined ? undefined : agent.options;
  if (options !== undefined && options !== null && typeof options.provider === "string" && options.provider !== ""
    && typeof options.model === "string" && options.model !== "") {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

/**
 * 无工具压缩引擎。
 *
 * 只覆写 summarize：其余（阈值、区域选择、surface 事务、压缩锁）全部继承宿主实现，
 * 因为那部分是「别写错」的代码，而不是「要定制」的代码。
 */
export default class SoulCompaction extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];

  static Config = z.object({
    thresholdRatio: z.number().default(0.9),
    headroomTokens: z.natural().default(65536),
    retainRatio: z.number(),
    retainTokens: z.natural(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.natural(),
    compactionRetries: z.natural(),
    maxOverflowRetries: z.natural(),
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      headroomTokens: z.natural(),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.natural(),
      compactionRetries: z.natural(),
      maxOverflowRetries: z.natural(),
    })),
    auto: z.boolean(),
  });

  /**
   * 覆写唯一钩子：把压缩区间改写成「无工具的摘要请求」。
   * @param {{tools?: Array<object>, messages: ReadonlyArray<object>}} input 宿主已经组好的重放前缀
   * @param {object} agent 提供 session / 路由信息
   * @param {AbortSignal} signal 取消信号
   * @returns {Promise<{summary: Array<object>, rawOutput: Array<object>, llmStreamCall: true, provider: string, model: string, maxTokens: number, usage?: object}>}
   */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const session = agent.session;
    const target = routedTarget(session, agent);
    if (target === undefined) throw new Error("rp-soul/compaction: 没有可用的 provider/model，无法生成摘要");
    const maxTokens = this.config && Number.isFinite(this.config.maxTokens) ? this.config.maxTokens : 65536;

    // 工具定义一并去掉：这些 schema 只为「让它继续调工具」而存在，摘要请求用不上，
    // 留着还会把请求体的前缀顶偏，缓存就白搭了。
    const replayed = toolFreeMessages(input.messages);
    if (!hasConversation(replayed)) throw new Error("rp-soul/compaction: 删掉工具之后没有可总结的对话");

    const request = [
      ...replayed,
      createUserMessage({ source: { kind: "rp-soul-summary-input" }, content: [{ type: "text", text: SUMMARY_INSTRUCTION }] }),
    ];
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      maxTokens,
      messages: request,
      // 刻意不传 tools / toolHistory：这是「无工具」压缩的核心。
      sessionId: session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    })) {
      assembler.push(chunk);
    }
    signal?.throwIfAborted();
    const finish = assembler.finish;
    if (finish.kind === "error" || finish.kind === "aborted") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    if (finish.kind === "max-tokens") {
      const error = new Error("rp-soul/compaction: 摘要撞上 token 上限被截断（这份摘要不能用，换更大 maxTokens 再来）");
      error.code = "MAX_TOKENS";
      throw error;
    }
    const rawOutput = assembler.blocks();
    if (rawOutput.some((block) => block.type === "image")) {
      throw new LlmError("rp-soul/compaction: 摘要不接受图片输出", "UNSUPPORTED_CONTENT");
    }
    const text = rawOutput
      .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
      .join(" ")
      .replace(/\s*\r?\n\s*/g, " ")
      .trim()
      .replace(LEAD_ECHO, "")
      .trim();
    if (text === "") throw new Error("rp-soul/compaction: 模型没有给出摘要正文");
    return {
      summary: [{ type: "text", text }],
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }
}
