/* 极小的断言工具：任何一条不成立就抛错（未捕获 → 进程退出码非 0）。
 * 存在的理由：这 4 个测试原本只 console.log，数值不对也照样打印"通过"，
 * 当不了回归测试。现在全部改成"要么退出码 0 且打印 PASS n 项，要么非 0 并指出哪条挂了"。 */
import { strict as assert } from 'node:assert';

let passed = 0;

/** 深比较 */
export function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    throw new Error(`[FAIL] ${label}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
  passed += 1;
}

/** 真值断言 */
export function ok(cond, label) {
  if (!cond) throw new Error(`[FAIL] ${label}（实际值: ${JSON.stringify(cond)}）`);
  passed += 1;
}

/** 字符串包含 */
export function has(haystack, needle, label) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(`[FAIL] ${label}\n  期望包含: ${JSON.stringify(needle)}\n  实际: ${JSON.stringify(haystack)}`);
  }
  passed += 1;
}

/** 字符串不包含 */
export function hasNot(haystack, needle, label) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    throw new Error(`[FAIL] ${label}\n  不应包含: ${JSON.stringify(needle)}\n  实际: ${JSON.stringify(haystack)}`);
  }
  passed += 1;
}

/** 比较数字区间 */
export function between(n, lo, hi, label) {
  if (typeof n !== 'number' || n < lo || n > hi) throw new Error(`[FAIL] ${label}: ${n} 不在 [${lo}, ${hi}]`);
  passed += 1;
}

/** 打印通过数并正常退出 */
export function done(suite) {
  console.log(`PASS ${passed} 项断言 (${suite})`);
}
