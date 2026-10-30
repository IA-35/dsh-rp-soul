/* 用真实的 node:http 服务器跑宿主路由 handler，逐条断言 express 风格 req/res 用法没错。
 * 这层专门验「框架边界」：状态码、header、超限断开、404 回退。 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { eq, ok, has, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulhttp-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
const NL = String.fromCharCode(10);
writeFileSync(
  join(home, 'rp-soul', 'preset.md'),
  '<!-- soul-part: 人设 -->' + NL + '你是旧书店的店主，话少。' + NL,
  'utf8'
);

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

const app = new Context();
const routes = [];
app.provide('systemPrompt', {
  getSectionOrder: () => 120,
  section() { return () => {}; },
});
app.provide('webServer', { register(def) { routes.push(def); return () => {}; }, host: '127.0.0.1', protocol: 'http:' });
app.provide('connection', {
  // 模拟 DSH 的信任栅栏：真实宿主里没有 Origin 的跨站请求会被拦，这里放行
  requestRejection(req) { return undefined; },
});
await app.plugin(plugin.apply, plugin.Config({}));

eq(routes.length, 1, '0. 注册了一条前缀路由');

const server = createServer((req, res) => {
  for (const r of routes) {
    if (r.kind === 'prefix' && req.url.startsWith(r.path)) return r.handler(req, res);
  }
  res.statusCode = 404; res.end('no route');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const j = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
};

const post = (path, payload) => j(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

// ---- GET /state ----
const st = await j('/rp-soul/state');
eq(st.status, 200, '1. GET /state 200');
eq(st.headers['cache-control'], 'no-store', '1. /state 禁缓存');
eq(st.body.config.files, undefined, '1. 配置里不再有多文件清单');
eq(st.body.preset.rel, 'rp-soul/preset.md', '1. /state 回预设路径');
eq(st.body.preset.blocks.length, 1, '1. /state 回一块');
has(st.body.composed.preview, '旧书店的店主', '1. /state 回合成预览');
eq(st.body.composed.chars, st.body.composed.preview.length, '1. chars 与 preview 长度一致');
ok(!('error' in st.body), '1. /state 无 error 字段');

// ---- GET /preset ----
const f = await j('/rp-soul/preset');
eq(f.status, 200, '2. GET /preset 200');
has(f.body.text, '旧书店的店主', '2. 读到正确内容');
eq(f.body.blocks[0].name, '人设', '2. 块名取自 soul-part 标记');

// ---- POST /preset：按块写回 ----
const saved = await post('/rp-soul/preset', {
  blocks: [
    { name: '身份', enabled: true, text: '你是旧书店的店主。' },
    { name: '口吻', enabled: false, text: '说话用短句。' },
  ],
});
eq(saved.status, 200, '3. POST /preset 200');
eq(saved.body.blocks.length, 2, '3. 写回两块');
has(readFileSync(join(home, 'rp-soul', 'preset.md'), 'utf8'), 'soul-part-off: 口吻', '3. 勾掉的那块写成 off 标记');

// ---- 大请求体 413 ----
const big = await post('/rp-soul/preset', { text: 'x'.repeat(1200000) });
eq(big.status, 413, '4. >1MB 请求体被 413');
ok(typeof big.body.error === 'string' && big.body.error.includes('1048576'), '4. 413 文案带上限数值');
has(readFileSync(join(home, 'rp-soul', 'preset.md'), 'utf8'), 'soul-part-off: 口吻', '4. 磁盘未被写坏');

// ---- 坏输入 400 ----
const badBlocks = await post('/rp-soul/preset', { blocks: 'not an array' });
eq(badBlocks.status, 400, '5. blocks 不是数组被 400');
const badJson = await post('/rp-soul/preset', { import: '{oops' });
eq(badJson.status, 400, '5. 导入坏 JSON 被 400');

// ---- 未注册路径 ----
eq((await j('/rp-soul/nope')).status, 404, '6. 未注册子路径 404');
eq((await j('/rp-soul/file?rel=SOUL.md')).status, 404, '6. 旧的 /file 已下线');

// ---- 错误方法 ----
const wrong = await j('/rp-soul/config', { method: 'DELETE' });
ok(wrong.status === 405 || wrong.status === 404 || wrong.status === 400, '7. 不支持的方法不返回 200');

await new Promise((r) => server.close(r));
await app.fiber?.dispose?.();
done('http');
