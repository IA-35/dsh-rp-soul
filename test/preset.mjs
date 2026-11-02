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

// 块名里带换行：写出去不能把标记拆成两行（读回来就认不出是标记了）
const named = parsePreset(renderPreset([
  { name: '第一\n行', enabled: true, text: '甲。' },
  { name: '乙', enabled: true, text: '乙文。' },
]));
eq(named.blocks.map((b) => b.name), ['第一 行', '乙'], '1b. 块名里的换行压成空格，块还是两块');
eq(named.blocks.map((b) => b.text), ['甲。', '乙文。'], '1b. 正文没被换行的块名吞掉');
// 块里的空行和首行缩进：写出再读回来一字不差
const shaped = '    缩进的第一行\n下一行\n\n\n隔了两个空行的一段';
const kept = parsePreset(renderPreset([{ name: '排版', enabled: true, text: shaped }, { name: '后一块', enabled: true, text: '尾。' }]));
eq(kept.blocks[0].text, shaped, '1b. 块里的连续空行和首行缩进原样保留');
eq(kept.blocks[1].text, '尾。', '1b. 后一块不受影响');

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
mkdirSync(join(home, 'rp-soul', 'presets'), { recursive: true });
writeFileSync(join(home, 'SOUL.md'), '<!-- soul-part: 根目录 -->\n从 SOUL.md 搬过来的。\n', 'utf8');
writeFileSync(join(home, 'rp-soul', 'presets', '别的.md'), '<!-- soul-part: 目录里 -->\n预设目录里那份。\n', 'utf8');
writeFileSync(join(home, 'rp-soul', 'presets', 'rim.json'), JSON.stringify({
  version: 1, name: 'r', description: '别动我', entries: [
    { name: 'A', content: '目录里的 RimTalk 预设。', role: 'User', position: 'Absolute' },
    { name: '占位', content: '', role: 'System', position: 'Relative' },
  ],
}), 'utf8');
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

// 上传已经去掉：没有盘上位置的内容不收，预设原样不动
const beforeUpload = readFileSync(presetPath, 'utf8');
const upload = await call('POST', '/rp-soul/preset', {
  import: JSON.stringify({ name: 'r', entries: [{ name: 'A', content: '上传来的。' }] }),
});
eq(upload.statusCode, 400, '4. 上传（import）不再收');
eq(readFileSync(presetPath, 'utf8'), beforeUpload, '4. 被拒的上传没动预设文件');

const exported = await call('GET', '/rp-soul/preset?export=rimtalk');
eq(exported.statusCode, 200, '4. 导出 200');
eq(JSON.parse(exported.body).json.entries[0].content, '重写过的人设。', '4. 导出内容一致');

ok(existsSync(presetPath), '4. 预设文件还在');

// 从磁盘导入：先列出能吃的文件，再按 rel 读进来。
const listed = await call('GET', '/rp-soul/preset?files=1');
eq(listed.statusCode, 200, '5. 列可导入文件 200');
const rels = JSON.parse(listed.body).files.map((one) => one.rel);
eq(rels.length, 4, '5. 列了四个能吃的文件（默认那份也在，打开过别的还能切回来）');
ok(rels.indexOf('rp-soul/preset.md') >= 0, '5. 默认的 rp-soul/preset.md 在列表里');
ok(rels.indexOf('SOUL.md') >= 0 && rels.indexOf('rp-soul/presets/别的.md') >= 0 && rels.indexOf('rp-soul/presets/rim.json') >= 0, '5. 根目录 SOUL.md 与预设目录都在列表里');
eq(JSON.parse(listed.body).files.every((one) => one.bytes > 0), true, '5. 空文件不进列表');

const fromRoot = await call('POST', '/rp-soul/preset', { from: 'SOUL.md' });
eq(fromRoot.statusCode, 200, '5. 从 SOUL.md 导入 200');
eq(sections.get('soul-persona').text(), '从 SOUL.md 搬过来的。', '5. 导入后合成换成 SOUL.md 的内容');

const fromDir = await call('POST', '/rp-soul/preset', { from: 'rp-soul/presets/rim.json' });
eq(fromDir.statusCode, 200, '5. 从目录里的 RimTalk JSON 导入 200');
eq(sections.get('soul-persona').text(), '目录里的 RimTalk 预设。', '5. 目录里的 JSON 也认');

const outside = await call('POST', '/rp-soul/preset', { from: 'rp-soul/presets/不存在.md' });
eq(outside.statusCode, 400, '5. 不在列表里的路径被拒');
has(JSON.parse(outside.body).error, '没有可导入的文件', '5. 拒绝理由说清楚');

const escape = await call('POST', '/rp-soul/preset', { from: '../etc/passwd' });
eq(escape.statusCode, 400, '5. 越界路径被拒');

// ---- 6. 导入就是「打开那份文件」：之后改的是它本身，不是一份副本 ----
const presetBefore = readFileSync(presetPath, 'utf8');
const openRoot = await call('POST', '/rp-soul/preset', { from: 'SOUL.md' });
eq(JSON.parse(openRoot.body).rel, 'SOUL.md', '6. 打开之后，当前预设就是 SOUL.md');
eq(JSON.parse((await call('GET', '/rp-soul/preset')).body).rel, 'SOUL.md', '6. 再读一次也还是它（记在设置里）');
const editRoot = await call('POST', '/rp-soul/preset', { blocks: [{ name: '根目录', enabled: true, text: '在 SOUL.md 里直接改的。' }] });
eq(editRoot.statusCode, 200, '6. 存块 200');
has(readFileSync(join(home, 'SOUL.md'), 'utf8'), '在 SOUL.md 里直接改的。', '6. 改动写回了 SOUL.md 本身');
eq(readFileSync(presetPath, 'utf8'), presetBefore, '6. rp-soul/preset.md 没被动过（不再有副本）');
eq(sections.get('soul-persona').text(), '在 SOUL.md 里直接改的。', '6. 注入的也是 SOUL.md 的内容');

// 没分块的老文件：只改一块的话写回去还是纯文本，不凭空加上块标记
writeFileSync(join(home, 'rp-soul', 'presets', '纯文本.md'), '一份没分块的老人设。\n', 'utf8');
await call('POST', '/rp-soul/preset', { from: 'rp-soul/presets/纯文本.md' });
await call('POST', '/rp-soul/preset', { blocks: [{ name: '人设', enabled: true, text: '改过的老人设。' }] });
eq(readFileSync(join(home, 'rp-soul', 'presets', '纯文本.md'), 'utf8'), '改过的老人设。\n', '6. 没分块的文件写回去还是纯文本');

// RimTalk 的 JSON：写回去还是它能读的 JSON，role / position / 描述 / 空条目原样留着
await call('POST', '/rp-soul/preset', { from: 'rp-soul/presets/rim.json' });
const editRim = await call('POST', '/rp-soul/preset', { blocks: [
  { name: 'A', enabled: true, text: '改过的 RimTalk 预设。' },
  { name: '新加的', enabled: false, text: '后来加的一块。' },
] });
eq(editRim.statusCode, 200, '6. JSON 预设存块 200');
const rim = JSON.parse(readFileSync(join(home, 'rp-soul', 'presets', 'rim.json'), 'utf8'));
eq(rim.description, '别动我', '6. 顶层的其它字段原样留着');
eq(rim.entries[0].content, '改过的 RimTalk 预设。', '6. 改的那条写回去了');
eq([rim.entries[0].role, rim.entries[0].position], ['User', 'Absolute'], '6. 原来那条的 role / position 没被冲掉');
ok(rim.entries.some((e) => e.name === '新加的' && e.enabled === false), '6. 新加的块成了一条新条目');
ok(rim.entries.some((e) => e.name === '占位' && e.content === ''), '6. 界面上看不见的空条目没被删掉');
eq(sections.get('soul-persona').text(), '改过的 RimTalk 预设。', '6. 注入的是 JSON 里启用的那几条');

// 整份覆盖一份 RimTalk JSON：读不通的不收，不然等于把人设写坏
const brokenRim = await call('POST', '/rp-soul/preset', { text: '{oops' });
eq(brokenRim.statusCode, 400, '6. 往 RimTalk JSON 里整份写一段读不通的被拒');
eq(JSON.parse(readFileSync(join(home, 'rp-soul', 'presets', 'rim.json'), 'utf8')).entries[0].content, '改过的 RimTalk 预设。', '6. 被拒之后那份 JSON 没被动');
// 打开过的那份被删了：自动退回默认那份，人设不会变空
const { rmSync } = await import('node:fs');
rmSync(join(home, 'rp-soul', 'presets', 'rim.json'));
eq(JSON.parse((await call('GET', '/rp-soul/preset')).body).rel, 'rp-soul/preset.md', '6. 那份没了就退回 rp-soul/preset.md');

await fiber.dispose();
done('preset');
