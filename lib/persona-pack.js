/**
 * persona-pack —— 把 rp-soul 的 markdown 人设文件解析成引擎认识的人设包。
 *
 * 输入：若干 { rel, text }（rel 是相对 $DSH_HOME 的路径，只用于报错定位）。
 * 输出：{ front, prose, title, persona_id, frontRel, error }
 *
 * 设计要点：
 * - 只有**第一个**带 `---` 前置块的文件提供结构化字段，其余文件都是散文。
 *   理由：一个角色的人设不该被劈成两份 front-matter 再合并，谁覆盖谁说不清。
 * - prose 是所有文件正文（已剥掉前置块）按分隔符拼起来的完整文本，
 *   引擎的 revision = sha256(prose + front)，所以改散文或改前置块都会换存档版本。
 * - YAML 解析器是手写的（约 250 行），只覆盖人设真正会写的子集：
 *   嵌套映射、映射数组、行内列表、行内映射、块标量（| 与 >）、引号、数字、布尔、null。
 *   不引 js-yaml：这个插件的 runtime 依赖只有 dsh-home-paths 和 schemastery。
 * - 解析失败不抛异常，返回 { error }，让设置页能把行号指给用户看。
 */

const NULLS = new Set(["", "~", "null", "Null", "NULL"]);
const TRUES = new Set(["true", "True", "TRUE", "yes", "Yes", "on", "On"]);
const FALSES = new Set(["false", "False", "FALSE", "no", "No", "off", "Off"]);

/** 一个带行号的 YAML 错误。 */
export class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : "第 " + line + " 行：" + message);
    this.name = "YamlError";
    this.line = line;
  }
}

/** 行内扫描：在 depth 0 找冒号，要求后面是空白或行尾（YAML 的硬规则）。 */
function findColon(text) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = "";
      } else if (quote === '"' && ch === "\\") {
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (ch === ":" && depth === 0) {
      const after = text[i + 1];
      if (after === undefined || after === " " || after === "\t") return i;
    }
  }
  return -1;
}

/** 行内扫描：在 depth 0 按逗号切（引号与括号内的逗号不算）。 */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = "";
      } else if (quote === '"' && ch === "\\") {
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((item) => item.trim()).filter((item, index, all) => !(item === "" && all.length > 1));
}

/** 去引号；单引号里 '' 是一个字面单引号。 */
function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1).split("''").join("'");
  }
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** 一个标量：行内列表 / 行内映射 / 引号串 / 数字 / 布尔 / null / 普通串。 */
export function parseScalar(raw) {
  const text = raw.trim();
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new YamlError("行内列表没有闭合：" + text);
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTop(inner).map((item) => parseScalar(item));
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new YamlError("行内映射没有闭合：" + text);
    const inner = text.slice(1, -1).trim();
    const out = {};
    if (inner === "") return out;
    for (const entry of splitTop(inner)) {
      const colon = findColon(entry);
      if (colon < 0) throw new YamlError("行内映射缺少冒号：" + entry);
      out[unquote(entry.slice(0, colon))] = parseScalar(entry.slice(colon + 1));
    }
    return out;
  }
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);
  if (NULLS.has(text)) return null;
  if (TRUES.has(text)) return true;
  if (FALSES.has(text)) return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

/** 行首缩进宽度（tab 当 1，但拒绝 tab —— YAML 不允许用 tab 缩进）。 */
function indentOf(line, lineNo) {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") throw new YamlError("缩进不能用 tab", lineNo);
    else break;
  }
  return width;
}

function isBlank(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * 块解析：把「有缩进的行列表」递归成 JS 值。
 * 结构只有两种：映射（key: value）与序列（- value）。
 * @returns {[value, nextIndex]}
 */
function parseBlock(lines, index, indent) {
  if (index >= lines.length) return [null, index];
  const first = lines[index];
  if (first.indent !== indent) throw new YamlError("缩进不一致（期望 " + indent + " 空格）", first.no);
  if (first.text === "-" || first.text.startsWith("- ")) {
    return parseSeq(lines, index, indent);
  }
  return parseMap(lines, index, indent);
}

function parseSeq(lines, index, indent) {
  const out = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (!(line.text === "-" || line.text.startsWith("- "))) break;
    const rest = line.text === "-" ? "" : line.text.slice(2);
    const gap = line.raw.length - line.raw.trimStart().length + 2;
    if (rest.trim() === "") {
      // "-" 单独一行：值在下一个更深缩进的块里。
      cursor += 1;
      if (cursor >= lines.length || lines[cursor].indent <= indent) {
        out.push(null);
        continue;
      }
      const [value, next] = parseBlock(lines, cursor, lines[cursor].indent);
      out.push(value);
      cursor = next;
      continue;
    }
    const colon = findColon(rest);
    if (colon >= 0) {
      // "- key: value" —— 一个映射条目，后续同缩进的 key 也属于这个元素。
      const inlineKey = unquote(rest.slice(0, colon));
      const inlineValue = rest.slice(colon + 1).trim();
      const memberIndent = gap;
      const entry = {};
      if (inlineValue !== "") {
        entry[inlineKey] = parseScalar(inlineValue);
        cursor += 1;
      } else {
        cursor += 1;
        if (cursor < lines.length && lines[cursor].indent > indent) {
          const [value, next] = parseBlock(lines, cursor, lines[cursor].indent);
          entry[inlineKey] = value;
          cursor = next;
        } else {
          entry[inlineKey] = null;
        }
      }
      // 同一个元素里后面的同级 key
      while (cursor < lines.length && lines[cursor].indent === memberIndent && !lines[cursor].text.startsWith("- ")) {
        const [more, next] = parseMap(lines, cursor, memberIndent);
        Object.assign(entry, more);
        cursor = next;
      }
      out.push(entry);
      continue;
    }
    out.push(parseScalar(rest));
    cursor += 1;
  }
  return [out, cursor];
}

function parseMap(lines, index, indent) {
  const out = {};
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent !== indent) break;
    if (line.text === "-" || line.text.startsWith("- ")) break;
    const colon = findColon(line.text);
    if (colon < 0) throw new YamlError("缺少冒号：" + line.text, line.no);
    const key = unquote(line.text.slice(0, colon));
    const value = line.text.slice(colon + 1).trim();
    if (value === "|" || value === ">" || /^[|>][+-]?$/.test(value)) {
      const [text, next] = readBlockScalar(lines, cursor + 1, indent, value[0] === ">");
      out[key] = text;
      cursor = next;
      continue;
    }
    if (value !== "") {
      out[key] = parseScalar(value);
      cursor += 1;
      continue;
    }
    cursor += 1;
    if (cursor < lines.length && lines[cursor].indent > indent) {
      const [child, next] = parseBlock(lines, cursor, lines[cursor].indent);
      out[key] = child;
      cursor = next;
    } else if (cursor < lines.length && lines[cursor].indent === indent && (lines[cursor].text === "-" || lines[cursor].text.startsWith("- "))) {
      // YAML 允许 "key:\n- a\n- b"（序列与 key 同缩进）。
      const [child, next] = parseSeq(lines, cursor, indent);
      out[key] = child;
      cursor = next;
    } else {
      out[key] = null;
    }
  }
  return [out, cursor];
}

/** | 与 > 两块标量：按第一行的缩进定基准，剥掉公共前缀。 */
function readBlockScalar(lines, index, parentIndent, folded) {
  const collected = [];
  let cursor = index;
  let base = -1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.raw.trim() !== "" && line.indent <= parentIndent) break;
    if (line.raw.trim() !== "" && base < 0) base = line.indent;
    collected.push(line);
    cursor += 1;
  }
  const rows = collected.map((line) => (line.raw.trim() === "" ? "" : line.raw.slice(base < 0 ? 0 : base)));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return [rows.join(folded ? " " : "\n"), cursor];
}

/**
 * 把 YAML 文本解析成 JS 值。空文档返回 null。
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  const rows = String(text ?? "").split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    if (isBlank(raw)) {
      // 空行保留给块标量用，但普通解析要跳过；这里用 indent=-1 标记。
      lines.push({ raw, no: i + 1, indent: -1, text: "" });
      continue;
    }
    const indent = indentOf(raw, i + 1);
    lines.push({ raw, no: i + 1, indent, text: raw.trim() });
  }
  // 去掉开头与结尾的空行；中间的空行对映射/序列无语义（块标量自己重读原文）。
  let start = 0;
  while (start < lines.length && lines[start].indent < 0) start += 1;
  if (start >= lines.length) return null;
  const usable = lines.slice(start).filter((line, index, all) => {
    if (line.indent >= 0) return true;
    // 中间空行保留：readBlockScalar 用 raw 判定
    return index > 0 && index < all.length - 1;
  });
  const [value, cursor] = parseBlock(usable, 0, usable[0].indent);
  const leftover = usable.slice(cursor).filter((line) => line.indent >= 0);
  if (leftover.length > 0) throw new YamlError("多余的缩进或内容：" + leftover[0].text, leftover[0].no);
  return value;
}

/**
 * 切掉文件开头的 `---` 前置块。
 * 只认文件第一行就是 `---`（允许前面有空行）；没有闭合行时报错，避免把正文吃掉。
 * @returns {{front: string|null, body: string, startLine: number}}
 */
export function splitFrontMatter(text) {
  const rows = String(text ?? "").split(/\r?\n/);
  let index = 0;
  while (index < rows.length && rows[index].trim() === "") index += 1;
  if (index >= rows.length || rows[index].trim() !== "---") {
    return { front: null, body: String(text ?? ""), startLine: 0 };
  }
  const open = index;
  for (let i = open + 1; i < rows.length; i += 1) {
    if (rows[i].trim() === "---") {
      return {
        front: rows.slice(open + 1, i).join("\n"),
        body: rows.slice(i + 1).join("\n"),
        startLine: open + 1,
      };
    }
  }
  throw new YamlError("前置块没有闭合（缺少第二行 ---）", open + 1);
}

/** 这个词在 YAML 里会被读成非字符串，导出时必须加引号。 */
const RESERVED_SCALARS = new Set(["", "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE"]);

/**
 * 把 JS 标量写成 YAML 标量。
 * 中文不需要引号；只在会被解析成别的类型、或含结构字符时才加双引号。
 */
export function scalarText(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  const text = String(value);
  if (RESERVED_SCALARS.has(text)) return JSON.stringify(text);
  if (/^-?\d+(\.\d+)?$/.test(text)) return JSON.stringify(text);
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text)) return JSON.stringify(text);
  if (/:\s|\s#|\s$/.test(text)) return JSON.stringify(text);
  return text;
}

/**
 * 把 JS 值写成 YAML 文本（块状）。只覆盖人设用到的形状：映射、序列、标量。
 * 与 parseYaml 对称：写出来的东西一定能被自己读回来。
 */
export function stringifyYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + "[]";
    const lines = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const inner = blockOf(item, indent + 2);
        if (inner.length === 0) {
          lines.push(pad + "- {}");
          continue;
        }
        lines.push(pad + "- " + inner[0].trimStart());
        for (let i = 1; i < inner.length; i += 1) lines.push(inner[i]);
        continue;
      }
      if (Array.isArray(item)) {
        lines.push(pad + "- " + (item.length === 0 ? "[]" : JSON.stringify(item).split(",").join(", ")));
        continue;
      }
      lines.push(pad + "- " + scalarText(item));
    }
    return lines.join("\n");
  }
  if (value !== null && typeof value === "object") {
    const inner = blockOf(value, indent);
    return inner.length === 0 ? pad + "{}" : inner.join("\n");
  }
  return pad + scalarText(value);
}

/** 映射的每一行（递归），不处理外层缩进以外的花哨东西。 */
function blockOf(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(pad + key + ": []");
        continue;
      }
      lines.push(pad + key + ":");
      lines.push(stringifyYaml(value, indent + 2));
      continue;
    }
    if (value !== null && typeof value === "object") {
      const inner = blockOf(value, indent + 2);
      if (inner.length === 0) {
        lines.push(pad + key + ": {}");
        continue;
      }
      lines.push(pad + key + ":");
      lines.push(inner.join("\n"));
      continue;
    }
    lines.push(pad + key + ": " + scalarText(value));
  }
  return lines;
}

/** 从散文里找第一个一级标题当标题；找不到就退到文件名。 */
export function titleFromProse(prose, fallback) {
  for (const line of String(prose ?? "").split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (match) return match[1].trim().slice(0, 60);
  }
  return fallback;
}

/** 人设 markdown 的扩展名白名单（与 index.js 保持一致）。 */
const PERSONA_EXT = new Set([".md", ".txt", ".markdown"]);

/** rel 去掉目录与扩展名，做标题兜底。 */
function stemOf(rel) {
  const name = String(rel ?? "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 把若干文件拼成人设包。
 *
 * @param {object} options
 * @param {{rel: string, text: string}[]} options.parts 按顺序排列的文件（rel 仅用于报错）
 * @param {string} [options.separator] 文件之间的分隔符
 * @param {boolean} [options.annotate] 是否给每段加 `<!-- soul-part: rel -->` 注释
 * @param {string} [options.title] 显式标题（覆盖散文里的一级标题）
 * @param {string} [options.personaId] 显式 id
 * @param {number} [options.maxBytes] prose 的字节预算；超出会被裁掉
 * @param {object} [options.front] 独立 persona 文件解析出来的结构化字段。
 *   给出时优先用它，parts 里的前置块一律只被剥掉、不再参与结构化字段。
 * @param {string} [options.frontRel] 上面那份 front 来自哪个文件（只用于报错与展示）
 * @returns {{front: object, prose: string, title: string, personaId: string|null,
 *            files: string[], frontRel: string|null, bytes: number, error: {message: string, rel: string} | null}}
 */
export function buildPersona(options) {
  const opts = options ?? {};
  const parts = Array.isArray(opts.parts) ? opts.parts : [];
  const separator = typeof opts.separator === "string" ? opts.separator : "\n\n";
  const annotate = opts.annotate === true;
  const budget = Number.isFinite(opts.maxBytes) ? Math.max(0, Math.trunc(opts.maxBytes)) : 200000;
  const files = [];
  const external = opts.front !== null && typeof opts.front === "object" && !Array.isArray(opts.front)
    ? opts.front
    : null;
  let front = external ?? {};
  let frontRel = external !== null ? (typeof opts.frontRel === "string" ? opts.frontRel : null) : null;
  const bodies = [];
  let used = 0;
  let error = null;

  for (const part of parts) {
    const rel = typeof part?.rel === "string" ? part.rel : "";
    const ext = rel.lastIndexOf(".") >= 0 ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
    if (rel !== "" && !PERSONA_EXT.has(ext)) {
      error = { message: "不支持的扩展名：" + rel + "（只认 .md / .txt / .markdown）", rel };
      break;
    }
    let split;
    try {
      split = splitFrontMatter(part?.text ?? "");
    } catch (err) {
      error = { message: err instanceof Error ? err.message : String(err), rel };
      break;
    }
    if (split.front !== null) {
      // 给了独立 persona 文件时，正文里的前置块只当格式、不当字段：
      // 已经被剥进 split.body 之外，结构化字段一律以那个文件为准。
      if (external === null && frontRel === null) {
        try {
          const parsed = parseYaml(split.front);
          if (parsed === null) front = {};
          else if (typeof parsed !== "object" || Array.isArray(parsed)) {
            error = { message: "前置块顶层必须是映射（key: value），收到 " + (Array.isArray(parsed) ? "列表" : typeof parsed), rel };
            break;
          } else front = parsed;
          frontRel = rel;
        } catch (err) {
          error = { message: err instanceof Error ? err.message : String(err), rel };
          break;
        }
      }
      // 第二个及以后的前置块：静默忽略（正文保留），只有第一个文件算结构化字段。
    }
    const body = split.body.trim();
    files.push(rel);
    if (body === "") continue;
    const chunk = annotate ? "<!-- soul-part: " + rel + " -->\n" + body : body;
    const joiner = bodies.length === 0 ? "" : separator;
    const piece = joiner + chunk;
    const remaining = budget - used;
    if (remaining <= 0) break;
    if (piece.length > remaining) {
      bodies.push(piece.slice(0, remaining));
      used = budget;
      break;
    }
    bodies.push(piece);
    used += piece.length;
  }

  const prose = bodies.join("");
  const explicitTitle = typeof opts.title === "string" && opts.title.trim() !== "" ? opts.title.trim().slice(0, 60) : null;
  const title = explicitTitle
    ?? (typeof front.title === "string" && front.title.trim() !== "" ? front.title.trim().slice(0, 60) : null)
    ?? titleFromProse(prose, stemOf(frontRel ?? files[0] ?? "人设"));
  const personaId = typeof opts.personaId === "string" && opts.personaId.trim() !== ""
    ? opts.personaId.trim()
    : (typeof front.id === "string" && front.id.trim() !== "" ? front.id.trim() : null);

  return {
    front,
    prose,
    title,
    personaId,
    files,
    frontRel,
    bytes: Buffer.byteLength(prose, "utf8"),
    error,
  };
}
