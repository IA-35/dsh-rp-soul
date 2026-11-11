/* 新引擎第四阶段：engine: "js" 时插件挂的是新桥接。真实 cordis 容器 + 假工具宿主。
 * 第 5 段是上周真实会话里被驳回过的交账，按新合同的写法（连同模型常犯的小毛病）重放，要求一次过。 */
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulv2bridge-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(join(home, 'rp-soul', 'preset.md'), '<!-- soul-part: 人设 -->\n' + [
  '---',
  'id: shorekeeper',
  'title: 守岸人',
  'name: 守岸人',
  'mood_base: 55',
  'start_stage: familiar',
  '---',
  '守岸人守着一座灯塔。',
].join('\n'), 'utf8');

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);
eq(plugin.Config({}).engine, 'python', '0. 默认还是旧引擎');

const app = new Context();
const contexts = new Map();
app.provide('systemPrompt', {
  getSectionOrder: () => 120,
  getContextOrder: (name) => (name === 'WEB_SURFACE' ? 210 : undefined),
  section() { return () => {}; },
  context(def) { contexts.set(def.name, def); return () => { contexts.delete(def.name); }; },
});
app.provide('webServer', { register() { return () => {}; } });
app.provide('connection', { requestRejection() { return undefined; } });
const tools = new Map();
app.provide('tools', { register(def) { tools.set(def.name, def); return () => { tools.delete(def.name); }; } });
// 试用的开法：rp-soul/config.json 里写 engine: js（插件配置保持默认 python）
writeFileSync(join(home, 'rp-soul', 'config.json'), JSON.stringify({ engine: 'js' }), 'utf8');
const fiber = app.plugin(plugin.apply, plugin.Config({}));
await fiber;

/** 一个 agent：会话里主人最后说的是 said。 */
const agent = (id, said = '', header = {}) => ({
  agent: {
    id,
    session: { header, deriveMessages: () => (said === '' ? [] : [{ role: 'user', content: [{ type: 'text', text: said }] }]) },
  },
});
const call = (name, args, exec) => tools.get(name).execute(args, exec);

// ---- 1. 挂上了：三个工具，定义加起来比旧的 11 KB 小 ----
eq([...tools.keys()].sort(), ['soul_admin', 'soul_commit', 'soul_state'], '1. 三个工具都注册了');
const bytes = [...tools.values()].reduce((n, t) => n + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })), 0);
ok(bytes < 11 * 1024, '1. 工具定义一共 ' + bytes + ' 字节，小于 11 KB');
ok('feel' in tools.get('soul_commit').parameters.properties, '1. 交账表里有情绪模块的字段');
ok(contexts.has('soul-engine'), '1. 快照照旧注册成动态上下文');

// ---- 2. 快照：第一次装配就地开局 ----
const a = agent('a1', '我回来了');
const snap = contexts.get('soul-engine').text(a);
has(snap, '## 【当前现状】', '2. 快照有标题');
has(snap, '时间：', '2. 快照有时间');
has(snap, '心情：', '2. 快照有心情');
ok(existsSync(join(home, 'rp-soul', 'engine', 'engine-v2.db')), '2. 库建在 rp-soul/engine/engine-v2.db');
eq(contexts.get('soul-recall').text(a), '', '2. 记忆还没移植：「想起来的」是空的');

// ---- 3. soul_state / soul_commit ----
const st = await call('soul_state', {}, a);
ok(st.started && Array.isArray(st.events) && Array.isArray(st.known_facts), '3. soul_state 回结构化字段');
const c1 = await call('soul_commit', { summary: '他进门了，她抬头看他。', her: { response: 'genuine', did: '放下笔' } }, a);
ok(c1.committed, '3. 交账成功');
const bad = await call('soul_commit', { summary: 'x', her: { response: 'maybe' } }, a);
ok(!bad.committed && bad.rejected && bad.problems.length > 0 && typeof bad.retry_hint === 'string', '3. 驳回带 problems 和 retry_hint');

// ---- 4. 两个会话共用一本账：拿着旧局面交的那个被挡住，并直接拿到新局面 ----
const b = agent('b1', '在吗');
contexts.get('soul-engine').text(a);
contexts.get('soul-engine').text(b);
ok((await call('soul_commit', { summary: 'b 先交了一笔。' }, b)).committed, '4. b 先交');
const stale = await call('soul_commit', { summary: 'a 拿着旧局面交。' }, a);
ok(!stale.committed && stale.stale && stale.now.some((l) => l.startsWith('时间：')), '4. a 被挡住，回执里带着现在的局面');
ok((await call('soul_commit', { summary: 'a 重判后再交。' }, a)).committed, '4. a 重交就过了');

// ---- 5. 上周真实驳回过的交账，按新合同重放：都要一次过 ----
const replay = [
  ['主人只发来「1」（旧：未知字段 note、缺 content_tags）', {
    summary: '主人只发来一个「1」，没头没尾。她没懂，抬眼看过去，问他在数什么。',
    open: '等他说明这个「1」是什么意思。',
    her: { did: '没出声，先抬眼看他', note: '没出声' },
    act: { significant: false, kind: 'silence' },
    content_tags: [],
  }],
  ['隔了两天回来（旧：必须补离屏片段、没要求写日记）', {
    summary: '他隔了两天回来，丢下一份文件就没声了。',
    memory_diary: '第四天。上午一直在收尾……',
    encoding_check: '汉字',
    expected_revision: 32,
  }],
  ['清理 openclaw（旧：kind 取值不对、npc_state 空、缺 open_action）', {
    summary: '清理 openclaw：卸载 npm 全局包，删掉配置与数据，释放 23.5G。',
    her: { did: '把 openclaw 卸载掉，还剩三个项目没动', state: {} },
    operand_mode: 'continue',
  }],
  ['GLB 工具交付（旧：plan_next 缺 in_minutes / until）', {
    summary: '给他做的 GLB 压缩工具补上 prune 步骤，四个测试全过，文档写完交付。',
    her: { did: '把结果交给他' },
    open: '等他看看新加的那一步用起来顺不顺手',
    quotes: [],
  }],
  ['半夜查提交（旧：basis_fact_id 不存在）', {
    summary: '他半夜在找一个提交，她告诉他没丢。',
    her: { response: 'genuine', did: '把灯往他那边推了推' },
    feel: [{ label: '半夜还在查东西', delta: 3, because: 'late_night_check' }],
  }],
  ['电源摸查（旧：同一次里先记事实再引用）', {
    summary: '他说被分去负责机器人电源设计，想从整机上模仿学习。',
    her: { response: 'genuine', did: '说会把查到的东西一条条摊给他看' },
    learned: [{ key: 'her_work_power_audit', text: '主人被分配负责机器人电源设计，本人不了解这方面' }],
    feel: [{ label: '替他留意', delta: 8, because: 'her_work_power_audit', minutes: 60 }],
    bond: {},
  }],
  ['摘要写长了', {
    summary: '这是一段写得太长的摘要。'.repeat(12),
  }],
];
for (const [name, input] of replay) {
  contexts.get('soul-engine').text(a);
  const got = await call('soul_commit', input, a);
  ok(got.committed, '5. ' + name + (got.committed ? '' : '：' + JSON.stringify(got.problems ?? got.error)));
}

// ---- 6. 子代理不碰账本；还没移植的设置页命令明说 ----
const child = agent('c1', '帮我查一下', { origin: 'subagent' });
eq(contexts.get('soul-engine').text(child), '', '6. 子代理不注入快照');
ok(!(await call('soul_commit', { summary: 'x' }, child)).committed, '6. 子代理不能交账');
const admin = await call('soul_admin', { action: 'status' }, a);
ok(admin.ok && admin.engine.engine === 'js' && admin.modules[0].id === 'mood', '6. soul_admin status');
const log = await call('soul_admin', { action: 'log', limit: 3 }, a);
eq(log.log.length, 3, '6. soul_admin log');
ok((await call('soul_admin', { action: 'undo' }, a)).ok, '6. soul_admin undo');
ok(!(await call('soul_admin', { action: 'start' }, a)).ok, '6. 重开不带 confirm：挡住');
hasNot(snap, '{{', '6. 快照里没有模板变量');

await fiber.dispose();
done('v2-bridge');
