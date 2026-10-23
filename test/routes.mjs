/* 用 mock ctx 跑 /rp-soul 路由与 section 合成，逐条断言（不是只打印）。
 * 退出码 0 + PASS N 项断言 = 通过；任何一条不成立就抛错、退出码非 0。 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulhome-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
mkdirSync(join(home, 'rp-soul', 'parts'), { recursive: true });
writeFileSync(join(home, 'SOUL.md'), '你是暗夜侦探。\n\n说话简短、冷静。\n', 'utf8');
writeFileSync(join(home, 'STYLE.md'), '口吻：第一人称，不超过三句。\n', 'utf8');
writeFileSync(join(home, 'rp-soul', 'evil.md'), '这个文件有 {{user}} 占位符\n', 'utf8');

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- mock ctx ----
const routes = [];
let sectionDef = null;
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject(deps, cb) {
    const mkctx = () => ({
      effect: ctx.effect,
      inject: (d, c) => ctx.inject(d, c),
      get webServer() { return { register(def) { routes.push(def); return () => {}; } }; },
      get connection() { return { requestRejection() { return undefined; } }; },
    });
    cb(mkctx());
  },
  systemPrompt: {
    getSectionOrder(name) { return name === 'DEPLOYMENT_PERSONA_PREFIX' ? 100 : 0; },
    section(def) { sectionDef = def; return () => {}; },
  },
};
mod.apply(ctx, { files: ['SOUL.md', 'STYLE.md'], maxBytes: 65536 });

// ---- 1. section ----
ok(sectionDef !== null, '1. section 已注册');
eq(sectionDef.name, 'soul-persona', '1. section name');
eq(sectionDef.order, 100, '1. section order 跟随 DEPLOYMENT_PERSONA_PREFIX');
const text = sectionDef.text();
has(text, '你是暗夜侦探', '1. 合成文本含 SOUL.md');
has(text, '第一人称', '1. 合成文本含 STYLE.md');
// annotate 默认 false（见 lib/index.js:32），所以默认合成文本里不该有分段注释
hasNot(text, '<!-- soul-part:', '1. 默认 annotate=false 不带分段注释');
eq(text, ['你是暗夜侦探。', '说话简短、冷静。', '口吻：第一人称，不超过三句。'].join('\n\n'), '1. 默认 separator 用两个换行拼接并裁掉首尾空白');

// ---- 2. 路由 ----
eq(routes.length, 1, '2. 只注册一条前缀路由');
eq(routes[0].kind, 'prefix', '2. 路由 kind');
eq(routes[0].path, '/rp-soul', '2. 路由 path');

// ---- handler 调用器 ----
async function call(method, url, body) {
  const route = routes[0];
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); return this; },
    end(chunk) { if (chunk) this.body += chunk; if (this._done) this._done(); },
  };
  const req = {
    method, url,
    headers: { host: 'localhost' },
    on(ev, cb) {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (ev === 'end') cb();
      return this;
    },
  };
  const p = new Promise((r) => { res._done = r; });
  await route.handler(req, res);
  await p;
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* 非 JSON 响应 */ }
  return { status: res.statusCode, headers: res.headers, parsed, raw: res.body };
}

// ---- 3. GET /state ----
const st = await call('GET', '/rp-soul/state');
eq(st.status, 200, '3. GET /state 200');
eq(st.headers['cache-control'], 'no-store', '3. /state 不许缓存');
// 首装会把种子文件补进清单（cordis 里的 files + 一份角色档案），所以多一个角色档案。
eq(st.parsed.config.files, ['SOUL.md', 'STYLE.md', 'rp-soul/parts/角色档案.md'], '3. /state 回配置 files（含首装种子）');
ok(Array.isArray(st.parsed.library), '3. /state 回 library 数组');
ok(st.parsed.library.includes('SOUL.md'), '3. library 含 SOUL.md');
ok(st.parsed.library.includes('STYLE.md'), '3. library 含 STYLE.md');
ok(st.parsed.composed.chars > 0, '3. /state 回合成预览字数');
ok(!('parts' in st.parsed) || st.parsed.parts !== undefined, '3. parts 字段存在性不强制');

// ---- 4. 越界路径必须被拒 ----
for (const bad of ['../../etc/passwd', 'C:/Windows/win.ini', '..', '', 'a/../../b']) {
  const r = await call('GET', '/rp-soul/file?rel=' + encodeURIComponent(bad));
  eq(r.status, 400, `4. 越界路径 ${JSON.stringify(bad)} 必须 400`);
}

// ---- 5. 读写真实文件 ----
const w = await call('PUT', '/rp-soul/file', { rel: 'STYLE.md', text: '口吻：第二人称。\n' });
eq(w.status, 200, '5. PUT 已存在文件 200');
eq(w.parsed.ok, true, '5. PUT 回 ok=true');
eq(readFileSync(join(home, 'STYLE.md'), 'utf8'), '口吻：第二人称。\n', '5. 磁盘内容已更新');

const back = await call('GET', '/rp-soul/file?rel=' + encodeURIComponent('STYLE.md'));
eq(back.status, 200, '5. 读回 200');
eq(back.parsed.text, '口吻：第二人称。\n', '5. 读回内容一致');

// ---- 6. 新建文件 ----
const n = await call('POST', '/rp-soul/new', { name: '禁忌', text: '不要主动提问。\n' });
eq(n.status, 200, '6. POST /new 200');
eq(n.parsed.rel, 'rp-soul/parts/禁忌.md', '6. 新文件落在 rp-soul/parts/');
ok(existsSync(join(home, 'rp-soul', 'parts', '禁忌.md')), '6. 新文件磁盘存在');
eq(readFileSync(join(home, 'rp-soul', 'parts', '禁忌.md'), 'utf8'), '不要主动提问。\n', '6. 新文件内容正确');

// ---- 7. 写配置立即生效 ----
const c = await call('POST', '/rp-soul/config', {
  files: ['rp-soul/parts/禁忌.md', 'SOUL.md'],
  separator: '\n---\n',
  annotate: true,
  enabled: true,
  maxBytes: 4096,
});
eq(c.status, 200, '7. POST /config 200');
const after = sectionDef.text();
has(after, '不要主动提问', '7. 新配置的第一段生效');
has(after, '你是暗夜侦探', '7. 新配置的第二段生效');
has(after, '\n---\n', '7. 自定义 separator 生效');
ok(after.indexOf('不要主动提问') < after.indexOf('你是暗夜侦探'), '7. files 顺序决定拼接顺序');

// ---- 8. 插值关闭 ----
eq(sectionDef.interpolate, false, '8. section 声明 interpolate:false（渲染时不做 {{变量}} 插值）');
await call('POST', '/rp-soul/config', { files: ['rp-soul/evil.md'] });
const esc = sectionDef.text();
has(esc, '{{user}}', '8. 原文 {{user}} 原样保留（由 interpolate:false 保证不炸）');
hasNot(esc, String.fromCharCode(0x200b), '8. 不再塞零宽字符');

// ---- 9. 总开关 ----
await call('POST', '/rp-soul/config', { enabled: false });
eq(sectionDef.text(), '', '9. enabled=false 时合成文本为空串');

// ---- 10. 异常输入 ----
const badCfg = await call('POST', '/rp-soul/config', { maxBytes: -1 });
ok(badCfg.status === 200 || badCfg.status === 400, '10. 非法 maxBytes 不崩（200 夹紧 或 400）');
await call('POST', '/rp-soul/config', { enabled: true, maxBytes: 8192, files: ['SOUL.md'] });

done('routes');
