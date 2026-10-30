/* 单文件预设：分块解析、RimTalk 互导、以及挂载后真的按预设合成。
 * 用真实 cordis 容器 + 真实 schemastery，不是 mock。 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';
import { composeBlocks, fromRimTalk, parsePreset, renderPreset, toRimTalk } from '../lib/preset-file.js';

// ---- 1. 分块解析 ----
const md = [
  '<!-- soul-part: 人设 -->',
  '你是守岸人。',
  '',
  '<!-- soul-part-off: 草稿 -->',
  '这段不注入。',
  '',
  '<!-- soul-part: 语气 -->',
  '温柔，沉静。',
  '',
].join('\n');
const parsed = parsePreset(md);
eq(parsed.marked, true, '1. 有标记时 marked');
eq(parsed.blocks.length, 3, '1. 三块');
eq(parsed.blocks[1].enabled, false, '1. soul-part-off 是关掉的块');
eq(composeBlocks(parsed.blocks), '你是守岸人。\n\n温柔，沉静。', '1. 合成只含启用的块');
eq(composeBlocks(parsePreset(renderPreset(parsed.blocks)).blocks), composeBlocks(parsed.blocks), '1. 写出再读回来合成不变');

const plain = parsePreset('守岸人，黑海岸的守望者。\n');
eq(plain.marked, false, '1. 没有标记的老文件 marked=false');
eq(plain.blocks.length, 1, '1. 没有标记就整份一块');

// ---- 2. 与 RimTalk 预设互导 ----
const rt = fromRimTalk({
  version: 1,
  name: '社区预设',
  entries: [
    { name: 'Base', content: '你说话简短。', enabled: true },
    { name: 'Off', content: '不该出现', enabled: false },
    { name: 'Empty', content: '   ' },
  ],
});
eq(rt.blocks.length, 2, '2. 空 content 的条目丢掉');
eq(composeBlocks(rt.blocks), '你说话简短。', '2. 关掉的条目不进合成');
const back = toRimTalk(rt.blocks, 'x', 'y');
eq(back.entries.length, 2, '2. 导出条目数一致');
eq(back.entries[0].role, 'System', '2. 导出都是 System');
let refused = '';
try { fromRimTalk({ foo: 1 }); } catch (error) { refused = error.message; }
has(refused, 'entries', '2. 不是 RimTalk 预设时说清缺什么');

// ---- 3. 挂载后按预设合成 ----
const home = mkdtempSync(join(tmpdir(), 'soulpreset-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
// 老的多文件还在，预设一旦存在就必须盖过它。
writeFileSync(join(home, 'SOUL.md'), '多文件里的一句。\n', 'utf8');
const presetPath = join(home, 'rp-soul', 'preset.md');
writeFileSync(presetPath, md, 'utf8');

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);
const app = new Context();
const sections = new Map();
const contexts = new Map();
const routes = [];
app.provide('systemPrompt', {
  getSectionOrder(name) {
    if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 120;
    if (name === 'DEPLOYMENT_PERSONA_SUFFIX') return 10320;
    return 0;
  },
  getContextOrder() { return undefined; },
  section(def) { sections.set(def.name, def); return () => { sections.delete(def.name); }; },
  context(def) { contexts.set(def.name, def); return () => { contexts.delete(def.name); }; },
});
app.provide('webServer', {
  register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; },
});
app.provide('connection', { requestRejection() { return undefined; } });

const fiber = app.plugin(plugin.apply, plugin.Config({ files: ['SOUL.md'] }));
await fiber;

eq(sections.get('soul-persona').text(), '你是守岸人。\n\n温柔，沉静。', '3. 有预设就只认预设，不再拼多文件');

// ---- 4. 路由：读、改块、导入 ----
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

const got = await call('GET', '/rp-soul/preset');
eq(got.statusCode, 200, '4. GET /preset 200');
eq(JSON.parse(got.body).blocks.length, 3, '4. 读回三块');

const saved = await call('POST', '/rp-soul/preset', {
  blocks: [{ name: '人设', enabled: true, text: '重写过的人设。' }],
});
eq(saved.statusCode, 200, '4. 存块 200');
eq(sections.get('soul-persona').text(), '重写过的人设。', '4. 存完立刻生效');
has(readFileSync(presetPath, 'utf8'), '<!-- soul-part: 人设 -->', '4. 落盘带块标记');

const imported = await call('POST', '/rp-soul/preset', {
  import: JSON.stringify({ name: 'r', entries: [{ name: 'A', content: '从 RimTalk 来的。' }] }),
});
eq(imported.statusCode, 200, '4. 导入 RimTalk JSON 200');
eq(sections.get('soul-persona').text(), '从 RimTalk 来的。', '4. 导入后合成变了');

const bad = await call('POST', '/rp-soul/preset', { import: '{"entries": []}' });
eq(bad.statusCode, 400, '4. 空预设导入被拒');

const exported = await call('GET', '/rp-soul/preset?export=rimtalk');
eq(exported.statusCode, 200, '4. 导出 200');
eq(JSON.parse(exported.body).json.entries[0].content, '从 RimTalk 来的。', '4. 导出内容一致');

ok(existsSync(presetPath), '4. 预设文件还在');

await fiber.dispose();
done('preset');
