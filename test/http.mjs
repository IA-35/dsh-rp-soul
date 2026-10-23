/* 用真实的 node:http 服务器跑宿主路由 handler，逐条断言 express 风格 req/res 用法没错。
 * 这层专门验「框架边界」：状态码、header、超限断开、扩展名白名单、404 回退。 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { eq, ok, has, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulhttp-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(join(home, 'SOUL.md'), '# 人设\n\n你是旧书店的店主，话少。\n', 'utf8');

function readdirSyncRoot() {
  const out = [];
  const walk = (abs, prefix) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name;
      if (e.isDirectory()) walk(join(abs, e.name), rel);
      else out.push(rel);
    }
  };
  walk(home, '');
  return out;
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

const app = new Context();
let section = null;
const routes = [];
app.provide('systemPrompt', {
  getSectionOrder: () => 120,
  section(def) { section = def; return () => {}; },
});
app.provide('webServer', { register(def) { routes.push(def); return () => {}; }, host: '127.0.0.1', protocol: 'http:' });
app.provide('connection', {
  // 模拟 DSH 的信任栅栏：真实宿主里没有 Origin 的跨站请求会被拦，这里放行
  requestRejection(req) { return undefined; },
});
await app.plugin(plugin.apply, plugin.Config({ files: ['SOUL.md'] }));

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

// ---- GET /state ----
const st = await j('/rp-soul/state');
eq(st.status, 200, '1. GET /state 200');
eq(st.headers['cache-control'], 'no-store', '1. /state 禁缓存');
// 首装种子：cordis 的 SOUL.md + 自动创建的角色档案。
eq(st.body.config.files, ['SOUL.md', 'rp-soul/parts/角色档案.md'], '1. /state 回 config.files（含首装种子）');
has(st.body.composed.preview, '旧书店的店主', '1. /state 回合成预览');
eq(st.body.composed.chars, st.body.composed.preview.length, '1. chars 与 preview 长度一致');
ok(!('error' in st.body), '1. /state 无 error 字段');

// ---- GET /file ----
const f = await j('/rp-soul/file?rel=SOUL.md');
eq(f.status, 200, '2. GET /file 200');
has(f.body.text, '旧书店的店主', '2. 读到正确内容');

// ---- 中文文件名往返 ----
const n = await j('/rp-soul/new', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '语气 说明', text: '说话用短句。\n' }),
});
eq(n.status, 200, '3. POST /new 200');
eq(n.body.rel, 'rp-soul/parts/语气 说明.md', '3. 中文文件名保留');
const back = await j('/rp-soul/file?rel=' + encodeURIComponent(n.body.rel));
eq(back.status, 200, '3. 中文名读回 200');
eq(back.body.text, '说话用短句。\n', '3. 中文名内容往返一致');

// ---- 大请求体 413 ----
const big = await j('/rp-soul/file', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rel: 'SOUL.md', text: 'x'.repeat(1200000) }),
});
eq(big.status, 413, '4. >1MB 请求体被 413');
ok(typeof big.body.error === 'string' && big.body.error.includes('1048576'), '4. 413 文案带上限数值');
eq(readFileSync(join(home, 'SOUL.md'), 'utf8').startsWith('# 人设'), true, '4. 磁盘未被写坏');

// ---- 扩展名白名单 ----
const badExt = await j('/rp-soul/file', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rel: 'evil.exe', text: 'x' }),
});
eq(badExt.status, 400, '5. .exe 被 400');
has(badExt.body.error, '.md', '5. 400 文案提示允许的扩展名');

// ---- 越界路径 ----
const trav = await j('/rp-soul/file?rel=' + encodeURIComponent('../../../windows/win.ini'));
eq(trav.status, 400, '6. 路径穿越被 400');

// ---- 乱码文件名（U+FFFD）必须被 400，不许落盘 ----
// 真实踩过：客户端按 GBK 送中文名，Node 按 UTF-8 解出 �，
// 旧版会照单全收，在磁盘上建出一个乱码文件名。
const REPLACEMENT = String.fromCharCode(0xfffd);
const mojibake = await j('/rp-soul/new', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'rp-soul/parts/' + REPLACEMENT + REPLACEMENT + '.md', text: '' }),
});
eq(mojibake.status, 400, '9. U+FFFD 文件名被 400');
ok(
  readdirSyncRoot().every((n) => !n.includes(REPLACEMENT)),
  '9. 磁盘上没留下乱码文件'
);
const mojiPut = await j('/rp-soul/file', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rel: REPLACEMENT + '.md', text: 'x' }),
});
eq(mojiPut.status, 400, '9. PUT 的乱码 rel 也被 400');

// ---- 未注册路径 ----
eq((await j('/rp-soul/nope')).status, 404, '7. 未注册子路径 404');

// ---- 错误方法 ----
const wrong = await j('/rp-soul/config', { method: 'DELETE' });
ok(wrong.status === 405 || wrong.status === 404 || wrong.status === 400, '8. 不支持的方法不返回 200');

await new Promise((r) => server.close(r));
await app.fiber?.dispose?.();
done('http');
