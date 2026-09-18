/**
 * soul-persona —— 从 $DSH_HOME/SOUL.md 读取人设，注入系统提示。
 *
 * 每次组装系统提示时读取文件，因此修改 SOUL.md 后**无需重启**，
 * 下一条请求即生效（文件很小，逐次读取开销可忽略）。
 *
 * 实现要点：
 * - 使用自定义 section 名 "soul-persona"（order 与全局 persona 前缀相同），
 *   不与 dsh-system-prompt 自己的 deployment:persona-prefix 冲突，
 *   因此可以在全局（profile 层）挂载。
 * - text 是 provider 函数：缺文件 / 空文件 / 超限时返回 ""，
 *   空 section 在渲染时会被丢弃，不影响其它提示片段。
 * - 对文本里的 "{{" 做零宽转义，防止被当成严格模板变量导致渲染报错。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";

/** Cordis 插件名（也用作注册段落的身份）。 */
export const name = "soul-persona";

/** 需要注入的服务。 */
export const inject = ["systemPrompt"];

/** 插件配置。 */
export const Config = z.object({
  /** 要读取的文件名，默认 SOUL.md（相对 $DSH_HOME）。 */
  fileName: z.string().default("SOUL.md"),
  /** 内容上限（字节），防止把超长文本灌进上下文。 */
  maxBytes: z.number().min(1).max(1048576).default(65536),
});

/**
 * 插件入口：注册一个有序系统提示片段，内容来自 $DSH_HOME/<fileName>。
 * @param ctx - cordis 上下文（含 systemPrompt 服务）。
 * @param config - { fileName, maxBytes }。
 */
export function apply(ctx, config) {
  const { fileName, maxBytes } = config ?? {};
  ctx.effect(() => ctx.systemPrompt.section({
    // 放行在最前：与部署级 persona 前缀同一档位（order 0）。
    name: "soul-persona",
    order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
    text: () => readSoulText(fileName, maxBytes),
  }), "soul-persona.section()");
}

/** 读取并转义人设文本；任何异常都返回空串（渲染时被丢弃）。 */
function readSoulText(fileName, maxBytes = 65536) {
  try {
    const file = join(resolveDshHome(), fileName);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return "";
    const text = readFileSync(file, "utf8");
    // 转义 "{{"：renderPrompt 对未知变量引用会抛错。
    // 插入零宽空格（U+200B）打断匹配，对模型阅读无感知。
    return text.includes("{{") ? text.replaceAll("{{", "{\u200b{") : text;
  } catch {
    return "";
  }
}