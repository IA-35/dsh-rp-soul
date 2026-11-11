/* lib/engine/core/schema.js — 交账表的字段定义：一份定义，生成三样东西。
 *
 *   validate(spec, value)  校验并规整（补默认值、截短、丢掉不认识的字段）
 *   jsonSchema(spec)       给 DSH 注册工具用的 JSON Schema
 *   guide(fields)          给模型看的一行一行字段说明
 *
 * 三样都从同一份 spec 来，所以「说明里写的」和「实际收的」不会对不上。
 *
 * 宽松的原则：能补默认值的补上，超长的截短、不认识的字段丢掉，这些都只记一条 note；
 * 只有「类型不对」「取值不在范围里」这种猜不出本意的，才记 problem（整次交账驳回）。
 */

/** 造一个 spec：kind 决定怎么校验，其余是说明与默认值。 */
const make = (kind, extra) => Object.freeze({ kind, required: false, desc: "", ...extra });

export const str = (max, opts = {}) => make("str", { max, ...opts });
export const int = (lo, hi, opts = {}) => make("int", { lo, hi, ...opts });
export const bool = (opts = {}) => make("bool", opts);
export const oneOf = (values, opts = {}) => make("enum", { values: Object.freeze([...values]), ...opts });
export const list = (item, max, opts = {}) => make("list", { item, max, ...opts });
export const obj = (fields, opts = {}) => make("obj", { fields: Object.freeze({ ...fields }), ...opts });
/** 真实时刻：完整的 ISO，或者不带偏移的 "2026-11-15T10:00"（按本机时区理解）。 */
export const time = (opts = {}) => make("time", opts);
/** 任选其一的几种形状（比如约定的「新建 / 兑现 / 取消」），按 key 判断是哪一种。 */
export const variants = (shapes, opts = {}) => make("variants", { shapes: Object.freeze({ ...shapes }), ...opts });

/** 把 spec 标成必填（返回新 spec，不改原来的）。 */
export const required = (spec) => Object.freeze({ ...spec, required: true });
/** 给 spec 配一句说明。 */
export const describe = (spec, desc) => Object.freeze({ ...spec, desc });

const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "数组" : typeof v === "object" ? "对象" : typeof v);

/**
 * 校验 value。返回 { value, problems, notes }：
 * problems 非空 = 这一次要驳回；notes 是「替你改了什么」，写进回执。
 */
export function validate(spec, value, path = "$") {
  const out = { problems: [], notes: [] };
  const result = check(spec, value, path, out);
  return { value: result, problems: out.problems, notes: out.notes };
}

function problem(out, path, reason, hint = "") {
  out.problems.push({ path, reason, hint });
  return undefined;
}

function check(spec, value, path, out) {
  if (value === undefined || value === null) {
    if (spec.required) return problem(out, path, "缺少必填字段", spec.desc);
    return spec.default !== undefined ? structuredClone(spec.default) : undefined;
  }
  switch (spec.kind) {
    case "str": {
      if (typeof value !== "string") return problem(out, path, "要字符串，给的是" + typeName(value));
      const text = value.trim();
      if (text === "") {
        if (spec.required) return problem(out, path, "不能是空的", spec.desc);
        return undefined;
      }
      if (spec.max !== undefined && text.length > spec.max) {
        out.notes.push(path + " 超过 " + spec.max + " 字，截短了");
        return text.slice(0, spec.max - 1) + "…";
      }
      return text;
    }
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) return problem(out, path, "要整数，给的是 " + JSON.stringify(value));
      if (value < spec.lo || value > spec.hi) return problem(out, path, "要在 " + spec.lo + ".." + spec.hi + " 之间，给的是 " + value);
      return value;
    }
    case "bool":
      if (typeof value !== "boolean") return problem(out, path, "要 true / false，给的是 " + JSON.stringify(value));
      return value;
    case "enum":
      if (!spec.values.includes(value)) return problem(out, path, "取值 " + JSON.stringify(value) + " 不认识", "可选：" + spec.values.join(" / "));
      return value;
    case "time": {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        return problem(out, path, "认不出这个时刻：" + JSON.stringify(value), "写成 2026-11-15T10:00 这样");
      }
      return value.trim();
    }
    case "list": {
      const items = Array.isArray(value) ? value : [value];
      let kept = items;
      if (spec.max !== undefined && items.length > spec.max) {
        out.notes.push(path + " 最多 " + spec.max + " 条，多的丢掉了");
        kept = items.slice(0, spec.max);
      }
      const result = [];
      kept.forEach((item, i) => {
        const one = check(spec.item, item, path + "[" + i + "]", out);
        if (one !== undefined) result.push(one);
      });
      return result;
    }
    case "obj": {
      if (typeof value !== "object" || Array.isArray(value)) return problem(out, path, "要对象，给的是" + typeName(value));
      const result = {};
      for (const [key, sub] of Object.entries(spec.fields)) {
        const one = check(sub, value[key], path + "." + key, out);
        if (one !== undefined) result[key] = one;
      }
      for (const key of Object.keys(value)) {
        if (!(key in spec.fields)) out.notes.push(path + "." + key + " 不认识，丢掉了");
      }
      return result;
    }
    case "variants": {
      if (typeof value !== "object" || Array.isArray(value)) return problem(out, path, "要对象，给的是" + typeName(value));
      const name = Object.keys(spec.shapes).find((key) => value[key] !== undefined && value[key] !== null);
      if (name === undefined) return problem(out, path, "认不出是哪一种", "带上其中一个：" + Object.keys(spec.shapes).join(" / "));
      return check(spec.shapes[name], value, path, out);
    }
    default:
      return problem(out, path, "未知的字段类型 " + spec.kind);
  }
}

/** spec → JSON Schema（给 DSH 注册工具用）。 */
export function jsonSchema(spec) {
  const base = spec.desc ? { description: spec.desc } : {};
  switch (spec.kind) {
    case "str": return { type: "string", ...base };
    case "time": return { type: "string", ...base };
    case "int": return { type: "integer", minimum: spec.lo, maximum: spec.hi, ...base };
    case "bool": return { type: "boolean", ...base };
    case "enum": return { type: "string", enum: [...spec.values], ...base };
    case "list": return { type: "array", items: jsonSchema(spec.item), ...base };
    case "obj": {
      const properties = {};
      const req = [];
      for (const [key, sub] of Object.entries(spec.fields)) {
        properties[key] = jsonSchema(sub);
        if (sub.required) req.push(key);
      }
      return { type: "object", properties, ...(req.length > 0 ? { required: req } : {}), ...base };
    }
    case "variants":
      return { anyOf: Object.values(spec.shapes).map(jsonSchema), ...base };
    default:
      return base;
  }
}

/** 一个 spec 的类型写成人话：字符串 ≤120 / 整数 -2..2 / refuse | genuine …。 */
function typeText(spec) {
  switch (spec.kind) {
    case "str": return spec.max !== undefined ? "≤" + spec.max + " 字" : "文字";
    case "time": return "时刻";
    case "int": return spec.lo + ".." + spec.hi;
    case "bool": return "true/false";
    case "enum": return spec.values.join(" | ");
    case "list": return "[" + typeText(spec.item) + "]";
    case "obj":
      return "{" + Object.entries(spec.fields).map(([k, s]) => (s.required ? "" : "?") + k + ": " + typeText(s)).join(", ") + "}";
    case "variants":
      return Object.values(spec.shapes).map(typeText).join(" 或 ");
    default: return "?";
  }
}

/** 字段表 → 给模型看的说明，一个顶层字段一行。 */
export function guide(fields) {
  return Object.entries(fields)
    .map(([key, spec]) => (spec.required ? key + "（必填）" : key) + " " + typeText(spec) + (spec.desc ? "：" + spec.desc : ""))
    .join("\n");
}
