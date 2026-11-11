/* lib/engine/core/time.js — 只有真实时间。
 *
 * 所有时刻都是带时区偏移的 ISO 字符串（2026-11-11T21:40:00+08:00）。
 * 这里的函数一律不读系统时钟：「现在」由调用方传进来，测试里随便造。
 * 唯一读环境的是 localOffset()：给一个时刻配上本机的时区偏移。
 */

const MINUTE = 60 * 1000;
/** 两次交账隔这么久，就是新的一段相处。 */
export const SCENE_BREAK_MINUTES = 60;

/** ISO 字符串 → 毫秒；认不出来返回 NaN（调用方自己决定怎么办）。 */
export function ms(iso) {
  if (typeof iso !== "string" || iso === "") return Number.NaN;
  return Date.parse(iso);
}

/** 是不是一个能用的时刻。 */
export function isTime(iso) {
  return Number.isFinite(ms(iso));
}

/** 本机在这一刻的时区偏移（分钟，东八区 = 480）。 */
export function localOffset(atMs) {
  return -new Date(atMs).getTimezoneOffset();
}

const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0");

/** 毫秒 → 带偏移的 ISO（精确到秒）。offsetMinutes 不给就用本机的。 */
export function iso(atMs, offsetMinutes = localOffset(atMs)) {
  const shifted = new Date(atMs + offsetMinutes * MINUTE);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  return shifted.getUTCFullYear() + "-" + pad(shifted.getUTCMonth() + 1) + "-" + pad(shifted.getUTCDate())
    + "T" + pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes()) + ":" + pad(shifted.getUTCSeconds())
    + sign + pad(Math.abs(offsetMinutes) / 60) + ":" + pad(Math.abs(offsetMinutes) % 60);
}

/** 一个 ISO 字符串自带的时区偏移（分钟）；没写偏移的按本机算。 */
export function offsetOf(text) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(text ?? ""));
  if (m !== null) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  if (/Z$/i.test(String(text ?? ""))) return 0;
  return localOffset(ms(text));
}

/** 在 base 这个时刻上加 n 分钟，保持 base 的时区偏移。 */
export function addMinutes(base, n) {
  return iso(ms(base) + n * MINUTE, offsetOf(base));
}

/** from 到 to 过了多少整分钟。往回走（改了系统时间）一律当 0。 */
export function minutesBetween(from, to) {
  const delta = ms(to) - ms(from);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.floor(delta / MINUTE);
}

/** a 是否早于 b（认不出来的时刻当作「不早于」）。 */
export function before(a, b) {
  const x = ms(a);
  const y = ms(b);
  return Number.isFinite(x) && Number.isFinite(y) && x < y;
}

/** 这个时刻在它自己的时区里是几点几分：返回当天第几分钟（0..1439）。 */
export function minuteOfDay(text) {
  const at = ms(text) + offsetOf(text) * MINUTE;
  const d = new Date(at);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 这个时刻的日历日 "YYYY-MM-DD"（按它自己的时区，不按机器现在的时区）。 */
export function dayKey(text) {
  const d = new Date(ms(text) + offsetOf(text) * MINUTE);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

/** "HH:MM" → 当天第几分钟；格式不对返回 null。 */
export function parseClock(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}

/** 从 now 起，下一次到 "HH:MM" 的时刻（今天这个钟点已过就是明天的）。 */
export function nextClock(now, hhmm) {
  const target = parseClock(hhmm);
  if (target === null) return null;
  const current = minuteOfDay(now);
  const wait = target > current ? target - current : target - current + 1440;
  // 对齐到整分钟：now 带着秒数时，直接加分钟会落在 23:00:37 这种时刻
  const seconds = Math.floor((ms(now) % MINUTE + MINUTE) % MINUTE / 1000);
  return iso(ms(now) + wait * MINUTE - seconds * 1000, offsetOf(now));
}

/** 隔了这么久再交账，算不算新的一段相处。没有上一次就算。 */
export function isNewScene(lastAt, now) {
  if (!isTime(lastAt)) return true;
  return minutesBetween(lastAt, now) >= SCENE_BREAK_MINUTES;
}

/** 给人看的时刻：「今天 21:40」「昨天 08:05」「11月9日 21:40」。 */
export function label(text, now) {
  if (!isTime(text)) return "";
  const minute = minuteOfDay(text);
  const clock = pad(minute / 60) + ":" + pad(minute % 60);
  const day = dayKey(text);
  if (isTime(now)) {
    if (day === dayKey(now)) return "今天 " + clock;
    if (day === dayKey(addMinutes(now, -1440))) return "昨天 " + clock;
  }
  const [, mo, da] = day.split("-");
  return Number(mo) + "月" + Number(da) + "日 " + clock;
}

/** 「多久以前」：刚刚 / 12 分钟前 / 3 小时前 / 2 天前。 */
export function ago(text, now) {
  const minutes = minutesBetween(text, now);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  if (minutes < 1440) return Math.floor(minutes / 60) + " 小时前";
  return Math.floor(minutes / 1440) + " 天前";
}
