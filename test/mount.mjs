/* 用真实的 cordis 容器 + 真实 schemastery 加载插件（不是 mock），逐条断言。
 * 验的是：ESM 依赖解析、Config 校验与默认值、inject 等待、effect 注册与回收。 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulreal-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(
  join(home, 'rp-soul', 'preset.md'),
  '# 人设预设\n\n<!-- soul-part: 身份 -->\n身份：夜航船的领航员。\n\n<!-- soul-part: 口吻 -->\n口吻：克制，不解释。\n',
  'utf8'
);

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- 1. 模块导出形态 ----
eq(plugin.name, 'soul-persona', '1. 插件 name');
eq(plugin.inject, ['systemPrompt'], '1. 只 inject systemPrompt（webServer/connection 走可选注入）');
eq(typeof plugin.Config, 'function', '1. 导出了 schemastery Config');

// ---- 2. Config 默认值与校验 ----
const cfgDefault = plugin.Config({});
eq(cfgDefault.separator, '\n\n', '2. separator 默认两个换行');
eq(cfgDefault.maxBytes, 65536, '2. maxBytes 默认 65536');
eq(cfgDefault.storeFile, 'rp-soul/config.json', '2. storeFile 默认路径');
// 多文件那套已经删了：这几个键不该还留在 Config 里
eq(cfgDefault.files, undefined, '2. 不再有 files 配置项');
eq(cfgDefault.annotate, undefined, '2. 不再有 annotate 配置项');

// maxBytes 下界 1024 必须被 schemastery 拒（不是静默夹紧）
let clamped = null;
try { clamped = plugin.Config({ maxBytes: 12 }); } catch { clamped = 'threw'; }
ok(clamped === 'threw', '2. maxBytes 过小时 Config() 直接抛错');

// ---- 3. 真实 cordis 挂载 ----
const app = new Context();
const sections = new Map();
const contexts = new Map();
const routes = [];
app.provide('systemPrompt', {
  // 与宿主 SECTION_ORDERS 对齐：persona-prefix 在最前，persona-suffix 在最后。
  getSectionOrder(name) {
    if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 120;
    if (name === 'DEPLOYMENT_PERSONA_SUFFIX') return 10320;
    return 0;
  },
  // 与宿主 CONTEXT_ORDERS 对齐，验证账本落在动态上下文的末尾。
  getContextOrder(name) { return name === 'WEB_SURFACE' ? 210 : undefined; },
  section(def) { sections.set(def.name, def); return () => { sections.delete(def.name); }; },
  context(def) { contexts.set(def.name, def); return () => { contexts.delete(def.name); }; },
});
app.provide('webServer', {
  register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; },
});
app.provide('connection', { requestRejection() { return undefined; } });

const fiber = app.plugin(plugin.apply, plugin.Config({ maxBytes: 65536 }));
await fiber;

ok(sections.has('soul-persona'), '3. 挂载后 soul-persona section 已注册');
eq(sections.get('soul-persona').order, 10321, '3. soul-persona 排在系统提示最末（persona-suffix 之后）');
// 账本改走动态 context：系统提示词必须完全不含每回合会变的内容。
ok(!sections.has('soul-engine'), '3. soul-engine 不再是系统提示词的 section');
ok(contexts.has('soul-engine'), '3. soul-engine 注册为动态 runtime context');
eq(contexts.get('soul-engine').order, 220, '3. 账本落在动态上下文末尾（WEB_SURFACE 210 之后）');
eq(contexts.get('soul-engine').interpolate, false, '3. 账本关闭插值');
eq(routes.length, 1, '3. 注册了 1 条路由');
eq(routes[0].kind, 'prefix', '3. 路由 kind=prefix');
eq(routes[0].path, '/rp-soul', '3. 路由 path');

const composed = sections.get('soul-persona').text();
has(composed, '夜航船的领航员', '3. 合成含第一块');
has(composed, '克制，不解释', '3. 合成含第二块');
hasNot(composed, '<!-- soul-part:', '3. 标记本身不进提示词');
ok(composed.indexOf('夜航船') < composed.indexOf('克制'), '3. 顺序 = 块在文件里的顺序');

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

// 关掉一块：合成里就该少一句，而且不用重启
const presetUrl = '/rp-soul/preset';
const before = await call('GET', presetUrl);
const beforeBody = JSON.parse(before.body);
const blocks = beforeBody.blocks.map((b) => (b.name === '口吻' ? { ...b, enabled: false } : b));
const r1 = await call('POST', presetUrl, { blocks });
eq(r1.statusCode, 200, '4. POST /preset 200');
hasNot(sections.get('soul-persona').text(), '克制，不解释', '4. 勾掉的块立刻不再注入（无需重启）');
has(sections.get('soul-persona').text(), '夜航船的领航员', '4. 没勾掉的那块还在');
const r1b = await call('POST', '/rp-soul/config', { maxBytes: 8192 });
eq(r1b.statusCode, 200, '4. POST /config 200');
const store = JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8'));
eq(store.maxBytes, 8192, '4. store 落盘 maxBytes');
eq(store.files, undefined, '4. store 不再写 files');

// ---- 5. store 优先级高于 cordis 配置 ----
const r2 = await call('POST', '/rp-soul/config', { maxBytes: 2048 });
eq(r2.statusCode, 200, '5. 二次改配置 200');
eq(JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8')).maxBytes, 2048, '5. store 覆盖 cordis 值');

// ---- 6. fiber 释放后全部回收 ----
await fiber.dispose();
eq(sections.size, 0, '6. dispose 后 section 已全部撤回');
eq(contexts.size, 0, '6. dispose 后动态 context 已全部撤回');
eq(routes.length, 0, '6. dispose 后路由已撤');

done('mount');
