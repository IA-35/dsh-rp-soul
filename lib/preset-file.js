/* lib/preset-file.js — 人设预设文件的分块解析与导入导出。
 *
 * 一份预设就是一个 markdown 文件，靠两行注释切块：
 *
 *     <!-- soul-part: 人设 -->
 *     你是守岸人……
 *
 *     <!-- soul-part-off: 草稿 -->
 *     这段留着但不注入。
 *
 * 没有标记的文件整份算一块，老文件原样能用。
 * RimTalk 那种 {entries:[{name, content, enabled}]} 的 JSON 也能吃进来。
 */

/** 块开头的标记。名字后面必须紧跟 `-->`，免得把正文里的普通注释认成块。 */
const ON_MARK = /^<!--\s*soul-part:\s*(.*?)\s*-->$/;
/** 关掉的块：内容照样留在文件里，只是不拼接。 */
const OFF_MARK = /^<!--\s*soul-part-off:\s*(.*?)\s*-->$/;

/** 单块默认名（老文件没有标记时用它）。 */
export const WHOLE_BLOCK = "人设";

/**
 * 把预设文本切成块。
 *
 * @param {string} text
 * @returns {{blocks: {name: string, enabled: boolean, text: string}[], marked: boolean}}
 *   marked=false 表示文件里一个标记都没有，blocks 里只有一块、名字是 WHOLE_BLOCK。
 */
export function parsePreset(text) {
  const rows = String(text ?? "").split(/\r?\n/);
  const blocks = [];
  let current = null;
  let marked = false;
  for (const line of rows) {
    const on = ON_MARK.exec(line);
    const off = OFF_MARK.exec(line);
    if (on !== null || off !== null) {
      marked = true;
      const match = on !== null ? on : off;
      const name = match[1].trim() === "" ? "未命名" : match[1].trim();
      if (current !== null) blocks.push({ name: current.name, enabled: current.enabled, text: trimBlock(current.lines) });
      current = { name, enabled: on !== null, lines: [] };
      continue;
    }
    if (current === null) {
      // 第一块标记之前的内容：有正文才算一块，纯空行直接丢。
      if (line.trim() === "") continue;
      current = { name: WHOLE_BLOCK, enabled: true, lines: [] };
    }
    current.lines.push(line);
  }
  if (current !== null) blocks.push({ name: current.name, enabled: current.enabled, text: trimBlock(current.lines) });
  if (!marked) {
    const whole = blocks.map((b) => b.text).filter((t) => t !== "").join("\n");
    return { blocks: whole === "" ? [] : [{ name: WHOLE_BLOCK, enabled: true, text: whole }], marked: false };
  }
  return { blocks: blocks.filter((b) => b.text !== "" || b.enabled), marked: true };
}

/** 去掉块首尾的空行，中间的空行留着。 */
function trimBlock(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

/**
 * 把块拼回预设文本。与 parsePreset 互逆（空块会被写成空段落，位置不丢）。
 *
 * @param {{name: string, enabled?: boolean, text: string}[]} blocks
 * @returns {string}
 */
export function renderPreset(blocks, { marked = true } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  // 原本就没分块的老文件（比如根目录的 SOUL.md），只剩一块且开着的话原样写回纯文本：
  // 改一句话不该让那份文件凭空多出一行块标记。
  if (!marked && list.length === 1 && list[0]?.enabled !== false) {
    const only = trimBlock(String(list[0]?.text ?? "").replace(/\r\n/g, "\n").split("\n"));
    return only === "" ? "" : only + "\n";
  }
  const parts = [];
  for (const block of list) {
    // 块名里的换行会把标记拆成两行，读回来就认不出是标记了：压成一个空格
    const raw = typeof block?.name === "string" ? block.name.replace(/[\r\n]+/g, " ").trim() : "";
    const name = raw !== "" ? raw : WHOLE_BLOCK;
    const off = block?.enabled === false;
    const mark = "<!-- soul-part" + (off ? "-off" : "") + ": " + name + " -->";
    // 只去掉首尾的空行（和 parsePreset 的 trimBlock 一样）：块里的连续空行、
    // 首行缩进都是排版，原样留着。以前整份文本最后一道「三个以上换行压成两个」
    // 会把块里刻意留的空行一起压掉，trim() 还会吃掉首行的缩进。
    const body = trimBlock(String(block?.text ?? "").replace(/\r\n/g, "\n").split("\n"));
    parts.push(body !== "" ? mark + "\n" + body : mark);
  }
  return parts.join("\n\n") + "\n";
}

/** 只把启用的块拼成最终注入的文本（块之间两个换行）。 */
export function composeBlocks(blocks, separator = "\n\n") {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.enabled !== false && String(block?.text ?? "").trim() !== "")
    .map((block) => String(block.text).trim())
    .join(separator);
}

/**
 * 把 RimTalk 的预设 JSON 转成块。
 *
 * 它的形状是 `{version, name, description, entries: [{name, content, role, position, enabled}]}`。
 * 只取 name / content / enabled：role 与 position 是它拼消息时用的，这里的人设
 * 永远是系统提示词里的一段，硬塞进去只会误导。
 *
 * @returns {{blocks: object[], name: string, description: string}}
 * @throws {Error} 不是预设 JSON 时抛，消息里说清缺什么。
 */
export function fromRimTalk(json) {
  let data = json;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("不是合法的 JSON");
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("顶层必须是对象");
  const entries = Array.isArray(data.entries) ? data.entries : null;
  if (entries === null) throw new Error("没有 entries 数组（这看起来不是 RimTalk 预设）");
  const blocks = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (content.trim() === "") continue;
    blocks.push({
      name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : "未命名",
      enabled: entry.enabled !== false,
      text: content,
    });
  }
  if (blocks.length === 0) throw new Error("entries 里没有带 content 的条目");
  return {
    blocks,
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
  };
}

/**
 * 把改过的块写回一份已有的 RimTalk 预设 JSON。
 *
 * 和 toRimTalk 不同：这是「打开那份文件、改完存回去」，不是另导出一份。
 * 所以顶层的其它字段（description 之类）、每条原有的 role / position 都原样留着，
 * 只换 name / content / enabled。按名字认回原来那一条；认不出来的块当新条目，
 * 用 System / Relative。fromRimTalk 读的时候会跳过 content 为空的条目 ——
 * 那些在界面上根本看不见，用户没法删它们，写回时也就原样保留在末尾。
 *
 * @param {object|string} original 磁盘上那份 JSON（对象或原文）
 * @param {{name: string, enabled?: boolean, text: string}[]} blocks
 * @returns {object}
 */
export function mergeRimTalk(original, blocks) {
  let base = original;
  if (typeof base === "string") {
    try {
      base = JSON.parse(base);
    } catch {
      base = null;
    }
  }
  if (base === null || typeof base !== "object" || Array.isArray(base)) base = {};
  const old = Array.isArray(base.entries) ? base.entries : [];
  const used = new Set();
  const entries = (Array.isArray(blocks) ? blocks : []).map((block) => {
    const name = String(block?.name ?? "未命名");
    const at = old.findIndex((entry, i) => !used.has(i) && entry !== null && typeof entry === "object" && entry.name === name);
    if (at >= 0) used.add(at);
    const prev = at >= 0 ? old[at] : { role: "System", position: "Relative" };
    return { ...prev, name, content: String(block?.text ?? ""), enabled: block?.enabled !== false };
  });
  const hidden = old.filter((entry, i) => !used.has(i) && entry !== null && typeof entry === "object"
    && String(entry.content ?? "").trim() === "");
  return { ...base, version: base.version ?? 1, entries: [...entries, ...hidden] };
}

/** 导出成 RimTalk 能读回去的 JSON（自己也是这个格式，两边互认）。 */
export function toRimTalk(blocks, name = "", description = "") {
  return {
    version: 1,
    name: String(name ?? ""),
    description: String(description ?? ""),
    entries: (Array.isArray(blocks) ? blocks : []).map((block) => ({
      name: String(block?.name ?? "未命名"),
      content: String(block?.text ?? ""),
      role: "System",
      position: "Relative",
      enabled: block?.enabled !== false,
    })),
  };
}
