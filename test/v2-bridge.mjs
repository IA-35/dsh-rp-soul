/* 新引擎第四阶段：engine: "js" 时插件挂的是新桥接。真实 cordis 容器 + 假工具宿主。
 * 第 5 段是上周真实会话里被驳回过的交账，按新合同的写法（连同模型常犯的小毛病）重放，要求一次过。 */
import { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';
import { makeV1Db } from './_v1-fixture.mjs';

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
eq(plugin.Config({}).engine, 'js', '0. 默认是新引擎');

const app = new Context();
const contexts = new Map();
app.provide('systemPrompt', {
  getSectionOrder: () => 120,
  getContextOrder: (name) => (name === 'WEB_SURFACE' ? 210 : undefined),
  section() { return () => {}; },
  context(def) { contexts.set(def.name, def); return () => { contexts.delete(def.name); }; },
});
const routes = [];
app.provide('webServer', { register(def) { routes.push(def); return () => {}; }, host: '127.0.0.1', protocol: 'http:' });
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
ok('remember' in tools.get('soul_commit').parameters.properties, '1. 交账表里有记忆模块的 remember');
ok(contexts.has('soul-engine'), '1. 快照照旧注册成动态上下文');

// ---- 2. 快照：第一次装配就地开局 ----
const a = agent('a1', '我回来了');
const snap = contexts.get('soul-engine').text(a);
has(snap, '## 【当前现状】', '2. 快照有标题');
has(snap, '时间：', '2. 快照有时间');
has(snap, '心情：', '2. 快照有心情');
ok(existsSync(join(home, 'rp-soul', 'engine', 'engine-v2.db')), '2. 库建在 rp-soul/engine/engine-v2.db');
eq(contexts.get('soul-recall').text(a), '', '2. 刚开局：「想起来的」是空的');

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

// ---- 7. 设置页「情绪」页：真 HTTP，和页面走的是同一条路 ----
const server = createServer((req, res) => {
  const route = routes.find((r) => r.kind === 'prefix' && req.url.startsWith(r.path));
  if (route) return route.handler(req, res);
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/rp-soul';
const json = async (path, init) => (await fetch(base + path, init)).json();
const eng = await json('/engine');
eq(eng.session?.session_id, 'main', '7. /engine 给出这一局（新引擎固定叫 main）');
const moods = await json('/engine/moods?session_id=main');
ok(moods.ok !== false, '7. 读情绪不再报「不支持」' + (moods.error ? '：' + moods.error : ''));
const her = moods.npcs?.[0];
eq(her?.name, '守岸人', '7. 一张卡，是她');
ok(Number.isInteger(her.value) && typeof her.band === 'string' && her.stage === 'familiar', '7. 心情、档位、阶段都在');
ok(moods.thresholds && Number.isInteger(moods.thresholds.open), '7. 阈值在');
const stored = her.thoughts.find((t) => t.kind === 'memory');
ok(stored !== undefined && typeof stored.id === 'string' && Number.isInteger(stored.remaining_minutes), '7. 记下的心事带 id 和剩余分钟');
ok(her.thoughts.some((t) => t.kind === 'situational' && t.label === '在场'), '7. 推出来的情境也列出来');
const del = await json('/engine/thought', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'main', npc_id: her.id, thought_id: stored.id, revision: moods.revision }) });
ok(del.ok !== false && del.deleted === stored.id, '7. 删掉一条心事' + (del.error ? '：' + del.error : ''));
const after = await json('/engine/moods?session_id=main');
ok(!after.npcs[0].thoughts.some((t) => t.id === stored.id), '7. 删掉的不见了');
ok(after.revision === moods.revision + 1, '7. 删除也算一次改动（revision 加一，能撤销）');
const again = await json('/engine/thought', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'main', npc_id: her.id, thought_id: stored.id }) });
ok(again.ok === false, '7. 再删一次：明说删不掉');
const facts = await json('/engine/facts?session_id=main');
ok(facts.ok === false && String(facts.error).includes('还不支持'), '7. 还没接上的页签照旧明说');

// ---- 8. 唤醒：交账里的 plan → 宿主问 next-wake 拿到下一次该醒的时刻 ----
ok('plan' in tools.get('soul_commit').parameters.properties && 'away' in tools.get('soul_commit').parameters.properties, '8. 交账表里有唤醒模块的字段');
await call('soul_state', {}, a); // 设置页刚删过一条心事：先重读一次局面
const planned = await call('soul_commit', { summary: '她说去巡一圈灯。', plan: { note: '去巡灯', in_minutes: 30 } }, a);
ok(planned.committed, '8. 带 plan 交账' + (planned.committed ? '' : '：' + JSON.stringify(planned)));
await json('/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wakeEnabled: true, wakeSessionId: 'a1', wakeQuiet: '' }) });
const woke = await json('/wake'); // 保存时重排是异步的：再读一次
eq(woke.state?.reason, 'plan', '8. 打开唤醒：下一次是她说好的那个时间' + (woke.state?.lastError ? '（' + woke.state.lastError + '）' : ''));
ok(Math.abs(Date.parse(woke.state.at) - (Date.now() + 30 * 60000)) < 120000, '8. 大约 30 分钟后');
await json('/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wakeEnabled: false }) });

// ---- 9. 设置页：常识库、自主行动记录、人设校验、模块开关 ----
const send = (path, method, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const added = await send('/engine/common', 'POST', { key: ['灯塔'], weight: 0.7, content: '灯塔每晚八点亮灯' });
ok(added.ok && added.count === 1 && added.receipt === '已加上', '9. 加一条常识' + (added.error ? '：' + added.error : ''));
const cid = added.rows[0].id;
has(contexts.get('soul-recall').text(agent('a1', '灯塔几点亮？')), '灯塔每晚八点亮灯', '9. 你手动加的直接生效：话里有关键词就注入');
eq(contexts.get('soul-recall').text(agent('a1', '今天下雨')), '', '9. 没命中不注入');
ok((await send('/engine/common', 'PUT', { common_id: cid, key: ['灯塔'], weight: 0.9, content: '灯塔每晚七点亮灯' })).rows[0].weight === 0.9, '9. 改一条');
ok((await send('/engine/common/limit', 'PUT', { limit: 3 })).limit === 3, '9. 改注入条数');
ok((await send('/engine/common', 'DELETE', { common_id: 'c99' })).ok === false, '9. 删不存在的：明说');
ok((await send('/engine/common', 'DELETE', { common_id: cid })).count === 0, '9. 删掉');
await call('soul_state', {}, a);
await call('soul_commit', { summary: '他说 DS 是 deepseek。', common: [{ key: ['ds'], content: 'DS 指 deepseek' }] }, a);
const pend = await json('/engine/common');
eq(pend.pending, 1, '9. 模型提的挂起等确认');
ok((await send('/engine/common/approve', 'POST', { common_id: pend.rows[0].id })).pending === 0, '9. 确认');
const act = await json('/engine/activity?session_id=main&limit=5');
ok(act.ok && act.rows.length > 0 && act.rows[0].summary === '他说 DS 是 deepseek。', '9. 自主行动记录：最近的在前' + (act.error ? '：' + act.error : ''));
const check = await json('/engine/persona');
eq(check.ok, true, '9. 人设校验：这份能用' + (check.error ? '（' + check.error + '）' : ''));
const mods = await json('/engine/modules');
eq(mods.modules.map((m) => m.id), ['mood', 'wake', 'common', 'memory'], '9. 模块清单');
const off = await send('/engine/modules', 'PUT', { modules: { mood: true, wake: true, common: false } });
ok(off.ok && off.modules.find((m) => m.id === 'common').on === false, '9. 关掉常识');
ok(!('common' in tools.get('soul_commit').parameters.properties), '9. 交账表立刻重挂，没有 common 了');
eq(contexts.get('soul-recall').text(agent('a1', 'DS 呢')), '', '9. 也不再注入');
ok((await json('/engine')).modules.find((m) => m.id === 'common').why === '你关掉了', '9. 引擎卡上看得到');
await send('/engine/modules', 'PUT', { modules: {} });
ok('common' in tools.get('soul_commit').parameters.properties, '9. 再打开就回来了');

// ---- 10. soul_admin：存档、导出、暂停 ----
ok((await call('soul_admin', { action: 'save', name: '灯塔' }, a)).ok, '10. 存档');
eq((await call('soul_admin', { action: 'list' }, a)).slots[0].name, '灯塔', '10. 列存档');
ok((await call('soul_admin', { action: 'load', name: '灯塔' }, a)).ok, '10. 读档');
ok(!(await call('soul_admin', { action: 'delete', name: '灯塔' }, a)).ok, '10. 删存档不带 confirm：挡住');
const exported = await call('soul_admin', { action: 'export' }, a);
ok(exported.ok && existsSync(exported.file), '10. 导出成文件');
ok((await call('soul_admin', { action: 'pause' }, a)).paused === true, '10. 暂停');
ok((await call('soul_admin', { action: 'resume' }, a)).paused === false, '10. 恢复');
ok(!('input' in (await call('soul_admin', { action: 'log', limit: 1 }, a)).log[0]), '10. log 不带每次交了什么（太长）');

// ---- 11. 设置页「记忆」页 ----
// 回合结束的钩子只加召回活跃度；ABM 的正文是她在交账时自己写的
const before11 = (await json('/engine/memories?session_id=main')).entries.length;
for (const [said, answer] of [['灯塔今晚亮吗', '亮，八点。'], ['我能上去看吗', '可以，小心台阶。'], ['好冷', '把外套给你。'], ['谢谢', '嗯。']]) {
  const ag = { agent: { id: 'a1', session: { header: {}, deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: said }] },
    { role: 'assistant', content: [{ type: 'text', text: answer }] },
  ] } } };
  await app.serial('agent/turn-stopping', ag);
}
eq((await json('/engine/memories?session_id=main')).entries.length, before11, '11. 钩子不再记原文：一句也没多');
contexts.get('soul-engine').text(a);
const wrote = await call('soul_commit', { summary: '他上来看了灯。', remember: '他摸黑上塔，到顶的时候风很大。' }, a);
ok(wrote.committed, '11. 她在交账时写了 remember：' + JSON.stringify(wrote));
const memo = await json('/engine/memories?session_id=main');
ok(memo.ok && memo.entries.some((e) => e.content === '他摸黑上塔，到顶的时候风很大。'), '11. ABM 里是她自己写的那一句' + (memo.error ? '：' + memo.error : ''));
ok(memo.counts && memo.capacity.abm === 20 && memo.capacity.clpa === null, '11. 各层条数和容量');
const one = memo.entries[0];
const edited = await send('/engine/memory', 'PUT', { session_id: 'main', memory_id: one.id, note: '设置页备注' });
ok(edited.ok && edited.receipt === '已保存', '11. 改一条' + (edited.error ? '：' + edited.error : ''));
eq((await json('/engine/memories?session_id=main')).entries[0].note, '设置页备注', '11. 改上了');
const req = await send('/engine/memory/request', 'POST', { session_id: 'main', kind: 'fold' });
ok(req.ok && typeof req.receipt === 'string' && req.receipt !== '', '11. 立即汇总：给回执（这里没有子代理服务）' + (req.error ? '：' + req.error : ''));
eq((await json('/engine/diaries?session_id=main')).diaries, [], '11. 还没写过日记');
ok((await send('/engine/memory', 'DELETE', { session_id: 'main', memory_id: one.id })).ok, '11. 删一条');

// ---- 12. soul_admin import：导入旧引擎的存档，日记按日历日搬 ----
makeV1Db(join(home, 'rp-soul', 'engine', 'engine.db'));
mkdirSync(join(home, 'rp-soul', 'engine', 'journal', 's_old'), { recursive: true });
writeFileSync(join(home, 'rp-soul', 'engine', 'journal', 's_old', 'diary-0012.md'), '# 第 12 天 · 周二\n\n今天修了一天灯。\n', 'utf8');
ok(!(await call('soul_admin', { action: 'import' }, a)).ok, '12. 不带 confirm：挡住');
const imported = await call('soul_admin', { action: 'import', confirm: true }, a);
ok(imported.ok && imported.all_match, '12. 导入，逐项都对上' + (imported.ok ? '' : '：' + imported.error) + (imported.all_match === false ? JSON.stringify(imported.check.filter((r) => !r.ok)) : ''));
eq(imported.diaries, 1, '12. 搬了一篇日记');
const moved = (await json('/engine/diaries?session_id=main')).diaries;
eq(moved.map((d) => [d.day, d.title, d.text]), [['2026-11-10', '11月10日 · 周二', '今天修了一天灯。']], '12. 设置页读得到，标题换成日历日');
ok((await call('soul_admin', { action: 'list' }, a)).slots.some((x) => x.name === '导入前'), '12. 导入前那一局存成了存档');
server.close();

await fiber.dispose();
done('v2-bridge');
