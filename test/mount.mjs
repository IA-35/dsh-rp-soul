/* 用真实的 cordis 容器 + 真实 schemastery 加载插件（不是 mock），逐条断言。
 * 验的是：ESM 依赖解析、Config 校验与默认值、inject 等待、effect 注册与回收。 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulreal-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(join(home, 'SOUL.md'), '身份：夜航船的领航员。\n', 'utf8');
writeFileSync(join(home, 'TONE.md'), '口吻：克制，不解释。\n', 'utf8');

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- 1. 模块导出形态 ----
eq(plugin.name, 'soul-persona', '1. 插件 name');
eq(plugin.inject, ['systemPrompt'], '1. 只 inject systemPrompt（webServer/connection 走可选注入）');
eq(typeof plugin.Config, 'function', '1. 导出了 schemastery Config');

// ---- 2. Config 默认值与校验 ----
const cfgDefault = plugin.Config({});
eq(cfgDefault.fileName, 'SOUL.md', '2. fileName 默认 SOUL.md');
eq(cfgDefault.separator, '\n\n', '2. separator 默认两个换行');
eq(cfgDefault.annotate, false, '2. annotate 默认 false');
eq(cfgDefault.maxBytes, 65536, '2. maxBytes 默认 65536');
eq(cfgDefault.storeFile, 'rp-soul/config.json', '2. storeFile 默认路径');
eq(cfgDefault.files, [], '2. files 未给时是空数组（effectiveFrom 会回退到 fileName）');

const cfgGiven = plugin.Config({ files: ['SOUL.md', 'TONE.md'], annotate: true });
eq(cfgGiven.files, ['SOUL.md', 'TONE.md'], '2. files 原样保留');
eq(cfgGiven.annotate, true, '2. annotate 覆盖成功');

// maxBytes 下界 1024 必须被 schemastery 拒（不是静默夹紧）
let clamped = null;
try { clamped = plugin.Config({ maxBytes: 12 }); } catch { clamped = 'threw'; }
ok(clamped === 'threw', '2. maxBytes 过小时 Config() 直接抛错');

// ---- 3. 真实 cordis 挂载 ----
const app = new Context();
const sections = new Map();
const routes = [];
app.provide('systemPrompt', {
  // 与宿主 SECTION_ORDERS 对齐：persona-prefix 在最前，persona-suffix 在最后。
  getSectionOrder(name) {
    if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 120;
    if (name === 'DEPLOYMENT_PERSONA_SUFFIX') return 10320;
    return 0;
  },
  section(def) { sections.set(def.name, def); return () => { sections.delete(def.name); }; },
});
app.provide('webServer', {
  register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; },
});
app.provide('connection', { requestRejection() { return undefined; } });

const fiber = app.plugin(plugin.apply, plugin.Config({ files: ['SOUL.md', 'TONE.md'], annotate: true }));
await fiber;

ok(sections.has('soul-persona'), '3. 挂载后 soul-persona section 已注册');
ok(sections.has('soul-engine'), '3. 挂载后 soul-engine section 已注册');
eq(sections.get('soul-persona').order, 10321, '3. soul-persona 排在系统提示最末（persona-suffix 之后）');
eq(sections.get('soul-engine').order, 10322, '3. soul-engine 紧跟人设，仍在最末');
ok(sections.get('soul-engine').order > 9900, '3. 账本快照排在结构化输出之后，不拖累前面的缓存');
eq(routes.length, 1, '3. 注册了 1 条路由');
eq(routes[0].kind, 'prefix', '3. 路由 kind=prefix');
eq(routes[0].path, '/rp-soul', '3. 路由 path');

const composed = sections.get('soul-persona').text();
has(composed, '夜航船的领航员', '3. 合成含 SOUL.md');
has(composed, '克制，不解释', '3. 合成含 TONE.md');
has(composed, '<!-- soul-part: SOUL.md -->', '3. annotate=true 带分段注释');
ok(composed.indexOf('夜航船') < composed.indexOf('克制'), '3. 拼接顺序 = files 数组顺序');

// ---- 4. 路由改配置后立即生效 ----
const route = routes[0];
const call = (method, url, body) => new Promise((resolve) => {
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(c, hd) { this.statusCode = c; if (hd) Object.assign(this.headers, hd); return this; },
    end(chunk) { if (chunk) this.body += chunk; resolve(this); },
  };
  const req = {
    method, url, headers: { host: 'localhost' },
    on(ev, cb) {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (ev === 'end') cb();
      return this;
    },
  };
  route.handler(req, res);
});

const r1 = await call('POST', '/rp-soul/config', {
  files: ['TONE.md'], annotate: false, separator: '\n\n', enabled: true, maxBytes: 8192,
});
eq(r1.statusCode, 200, '4. POST /config 200');
eq(sections.get('soul-persona').text(), '口吻：克制，不解释。', '4. 改配置后合成文本立即变化（无需重启）');
const store = JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8'));
eq(store.files, ['TONE.md'], '4. store 落盘 files');
eq(store.annotate, false, '4. store 落盘 annotate');
eq(store.maxBytes, 8192, '4. store 落盘 maxBytes');

// ---- 5. store 优先级高于 cordis 配置 ----
const r2 = await call('POST', '/rp-soul/config', { maxBytes: 2048 });
eq(r2.statusCode, 200, '5. 二次改配置 200');
eq(JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8')).maxBytes, 2048, '5. store 覆盖 cordis 值');

// ---- 6. fiber 释放后全部回收 ----
await fiber.dispose();
eq(sections.size, 0, '6. dispose 后 section 已全部撤回');
eq(routes.length, 0, '6. dispose 后路由已撤');

done('mount');
