/* 真 HTTP + 真 Python 侧车：验 /rp-soul/engine* 这几条设置页路由。
 * 与 engine.mjs 的分工：那边验工具语义（mock ctx），这边验路线与 JSON 形状。 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { eq, ok, has, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulenghttp-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
const PRESET_HEAD = '<!-- soul-part: 人设 -->\n';
writeFileSync(join(home, 'rp-soul', 'preset.md'), PRESET_HEAD + [
  '---',
  'id: lin_wan',
  'title: 雨夜诊所',
  'name: 林晚',
  'role: 夜班医生',
  'age: 34',
  'gender: female',
  'adult_context: 独立执业五年的全科医生',
  'voices:',
  '  surface: 说话克制。',
  '  inner: 一直在等一句道歉。',
  'mood_base: 55',
  'mood_thresholds:',
  '  open: 72',
  '  closed: 40',
  '  break: 18',
  '---',
  '林晚是这家小诊所的夜班医生。',
].join('\n'), 'utf8');

const plugin = await import(new URL('../lib/index.js', import.meta.url).href);
const app = new Context();
const routes = [];
const sections = new Map();
app.provide('systemPrompt', {
  getSectionOrder: () => 120,
  section(def) { sections.set(def.name, def); return () => {}; },
});
app.provide('webServer', { register(def) { routes.push(def); return () => {}; }, host: '127.0.0.1', protocol: 'http:' });
app.provide('connection', { requestRejection() { return undefined; } });
const tools = new Map();
app.provide('tools', { register(def) { tools.set(def.name, def); return () => { tools.delete(def.name); }; } });
await app.plugin(plugin.apply, plugin.Config({}));

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
  try { body = JSON.parse(text); } catch { body = text.slice(0, 160); }
  return { status: res.status, body };
};

// ---- 1. GET /engine：健康 + 人设摘要 ----
const eng = await j('/rp-soul/engine');
eq(eng.status, 200, '1. /engine 200');
ok(eng.body.health !== undefined, '1. 带 health');
eq(eng.body.health.ready, true, '1. 引擎就绪（' + JSON.stringify(eng.body.health.python) + '）');
eq(eng.body.persona.title, '雨夜诊所', '1. 人设标题来自前置块');
eq(eng.body.persona.front.name, '林晚', '1. 前置块就是她一个人');
eq(eng.body.session, null, '1. 还没开局时 session 为 null');

// ---- 2. GET /engine/persona：真引擎校验 ----
const chk = await j('/rp-soul/engine/persona');
eq(chk.status, 200, '2. /engine/persona 200');
eq(chk.body.ok, true, '2. 校验通过（' + JSON.stringify(chk.body.error ?? '') + '）');
ok(chk.body.build !== undefined && chk.body.build.bytes > 0, '2. 带了人设摘要');

// ---- 2b. 人设不合格时，details 必须带 path/reason/hint（设置页靠它显示怎么改）----
const orig = (await j('/rp-soul/preset')).body.text;
ok(typeof orig === 'string' && orig.length > 100, '2b. 能读回原预设');
const NL = String.fromCharCode(10);
const BAD = ['---', 'id: broken', 'title: 缺东西的人设', 'bogus: 1', '---', '这里只有散文，没有前置块内容。'].join(NL);
const putBad = await j('/rp-soul/preset', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: BAD }),
});
eq(putBad.status, 200, '2b. 覆盖预设 200');
const bad = await j('/rp-soul/engine/persona');
eq(bad.status, 200, '2b. 坏人设不吃 500');
eq(bad.body.ok, false, '2b. 校验没通过');
ok(Array.isArray(bad.body.details) && bad.body.details.length >= 2, '2b. 带 details 数组（' + JSON.stringify(bad.body.error ?? '') + '）');
ok(bad.body.details.every((d) => typeof d.path === 'string' && typeof d.reason === 'string' && typeof d.hint === 'string'), '2b. 每条都有 path/reason/hint');
ok(bad.body.details.some((d) => d.path.includes('name')), '2b. 指出缺 name');
await j('/rp-soul/preset', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: orig }),
});
const back = await j('/rp-soul/engine/persona');
eq(back.body.ok, true, '2b. 恢复后校验通过（' + JSON.stringify(back.body.error ?? '') + '）');

// ---- 3. POST /config 能改 title / personaId ----
const saved = await j('/rp-soul/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '自定义标题', personaId: 'my_persona' }),
});
eq(saved.status, 200, '3. 写配置 200');
eq(saved.body.config.title, '自定义标题', '3. title 覆盖生效');
eq(saved.body.config.personaId, 'my_persona', '3. personaId 覆盖生效');

// ---- 4. 没开局时 mood 路由报错但不 500 ----
const mood0 = await j('/rp-soul/engine/mood?session_id=s_nope&npc_id=lin_wan');
eq(mood0.status, 200, '4. mood 路由不吃 500');
ok(typeof mood0.body.error === 'string', '4. 返回 error 文本');
const mood400 = await j('/rp-soul/engine/mood');
eq(mood400.status, 400, '4. 缺参数 400');

// ---- 5. DELETE /engine/thought 缺参数 400 ----
const del0 = await j('/rp-soul/engine/thought', { method: 'DELETE', body: '{}' });
eq(del0.status, 400, '5. 缺参数 400');

// ---- 6. 未知子路径 404 ----
const nope = await j('/rp-soul/engine/whatever');
eq(nope.status, 404, '6. 未知子路径 404');

// ---- 7. 真开一局 → 心情面板可见 → DELETE 删掉一条真的消失 ----
const exec = { signal: undefined, agent: { id: 'conv-http' } };
const started = await tools.get('soul_admin').execute({
  action: 'start',
  seed: 7,
}, exec);
ok(started.ok === true, '7. 开局成功（' + JSON.stringify(started.error ?? '') + '）');
const sid = started.session_id;

const eng2 = await j('/rp-soul/engine');
ok(eng2.body.session !== null && eng2.body.session.session_id === sid, '7. /engine 反映当前局');

const mood = await j('/rp-soul/engine/mood?session_id=' + encodeURIComponent(sid) + '&npc_id=lin_wan');
ok(Array.isArray(mood.body.thoughts), '7. 心情面板有 thoughts');
eq(mood.body.thresholds.open, 72, '7. 阈值来自人设');
// 开局不再自带情绪条目（situation.pressure 已删）：先提交一回合记一条事实，再拿它的 id 记一条情绪。
let latestRevision = started.revision;
if (mood.body.thoughts.length === 0) {
  const seeded = await tools.get('soul_commit').execute({
    action_mode: 'result',
    player_input: '我把伞靠在门边，说了句今天雨真大。',
    operations: [
      { op: 'add_fact', key: 'wet_umbrella', text: '门边靠着一把湿伞', scope: 'shared', origin: 'observed' },
    ],
    content_tags: [],
    summary: '玩家进门，把湿伞靠在门边。',
    open_action: '林晚会不会搭话',
  }, exec);
  ok(seeded.committed === true, '7. 记一条事实（' + JSON.stringify(seeded.error ?? '') + '）');
  latestRevision = seeded.revision;
  const applied = (seeded.turns || [])[0]?.applied || [];
  const factOp = applied.filter((a) => a.op === 'add_fact')[0];
  ok(factOp !== undefined, '7. 事实拿到 id');
  const seeded2 = await tools.get('soul_commit').execute({
    action_mode: 'continue',
    player_input: '',
    operations: [
      { op: 'add_thought', label: '雨太大了', delta: -4, basis_fact_id: factOp.fact_id },
    ],
    content_tags: [],
    summary: '林晚看了眼门边的湿伞。',
    open_action: '林晚还站在门口',
  }, exec);
  ok(seeded2.committed === true, '7. 造一条情绪（' + JSON.stringify(seeded2.error ?? '') + '）');
  latestRevision = seeded2.revision;
}
const mood2 = await j('/rp-soul/engine/mood?session_id=' + encodeURIComponent(sid) + '&npc_id=lin_wan');

if (mood2.body.thoughts.length > 0) {
  const victim = mood2.body.thoughts[0];
  const del = await j('/rp-soul/engine/thought', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sid,
      npc_id: 'lin_wan',
      thought_id: victim.id,
      revision: mood2.body.revision ?? latestRevision,
      reason: '设置页手动删除',
    }),
  });
  eq(del.status, 200, '7. 删除 200');
  eq(del.body.ok, true, '7. 删除成功（' + JSON.stringify(del.body.error ?? '') + '）');
  const after = await j('/rp-soul/engine/mood?session_id=' + encodeURIComponent(sid) + '&npc_id=lin_wan');
  ok(!after.body.thoughts.some((t) => t.id === victim.id), '7. 那条真的没了');
  ok(Array.isArray(after.body.deletions) && after.body.deletions.length >= 1, '7. 留了审计');
  const mapRaw = readFileSync(join(home, 'rp-soul', 'engine-sessions.json'), 'utf8');
  const map = JSON.parse(mapRaw);
  // 默认作用域是 global：所有 DSH 会话共用 "shared" 这一局，与 exec.agent.id 无关。
  eq(map['shared'].revision, del.body.revision, '7. 删完后会话映射的 revision 同步了');
} else {
  ok(false, '7. 开局居然没有情绪条目');
}

// ---- 7b. 记忆页：真引擎读 / 改 / 删 / 立即总结 ----
const mem400 = await j('/rp-soul/engine/memories');
eq(mem400.status, 400, '7b. /engine/memories 缺 session_id 400');
const mems = await j('/rp-soul/engine/memories?session_id=' + encodeURIComponent(sid));
eq(mems.status, 200, '7b. /engine/memories 200');
ok(mems.body.ok === true && Array.isArray(mems.body.entries) && mems.body.entries.length >= 1, '7b. 有记忆条目（' + JSON.stringify(mems.body.error ?? '') + '）');
eq(mems.body.layers.abm, 'ABM', '7b. 带三层名字');
const target = mems.body.entries.find((e) => e.type === 'conversation') ?? mems.body.entries[0];
const pinned = await j('/rp-soul/engine/memory', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sid, memory_id: target.id, revision: mems.body.revision, pinned: true, note: '设置页钉住' }),
});
eq(pinned.body.ok, true, '7b. 改记忆成功（' + JSON.stringify(pinned.body.error ?? '') + '）');
eq(pinned.body.memory.pinned, true, '7b. 钉住了');
const noId = await j('/rp-soul/engine/memory', { method: 'PUT', body: JSON.stringify({ session_id: sid }) });
eq(noId.status, 400, '7b. 缺 memory_id 400');
const mapAfterPin = JSON.parse(readFileSync(join(home, 'rp-soul', 'engine-sessions.json'), 'utf8'));
eq(mapAfterPin.shared.revision, pinned.body.revision, '7b. 改完同步了会话映射的 revision');
const asked = await j('/rp-soul/engine/memory/request', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sid, revision: pinned.body.revision, kind: 'fold' }),
});
eq(asked.body.ok, true, '7b. 立即总结成功（' + JSON.stringify(asked.body.error ?? '') + '）');
ok(asked.body.request.sources.length >= 1, '7b. 列出要总结的那几条');
const gone = await j('/rp-soul/engine/memory', {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: sid, memory_id: target.id, revision: asked.body.revision, reason: '测试删除' }),
});
eq(gone.body.ok, true, '7b. 删记忆成功（' + JSON.stringify(gone.body.error ?? '') + '）');
const memsAfter = await j('/rp-soul/engine/memories?session_id=' + encodeURIComponent(sid));
ok(!memsAfter.body.entries.some((e) => e.id === target.id), '7b. 那条真的没了');
eq(memsAfter.body.deletions[0].memory_id, target.id, '7b. 留了审计');

// ---- 8. GET /engine/session 能读上下文 ----
const ctxr = await j('/rp-soul/engine/session?session_id=' + encodeURIComponent(sid));
eq(ctxr.status, 200, '8. /engine/session 200');
ok(ctxr.body.context !== undefined && typeof ctxr.body.context === 'object', '8. 带回 context');
eq(ctxr.body.context.depth, 'brief', '8. 默认 brief');

// ---- 8b. GET /engine/diaries：读她的日记文件，新的在前；路径伸不出数据目录 ----
const diaryDir = join(home, 'rp-soul', 'engine', 'journal', sid);
mkdirSync(diaryDir, { recursive: true });
writeFileSync(join(diaryDir, 'diary-0001.md'), '# 第 1 天 · 周一\n\n第一天，他来得很晚。\n');
writeFileSync(join(diaryDir, 'diary-0002.md'), '# 第 2 天 · 周二\n\n下了一天雨。\n');
writeFileSync(join(diaryDir, 'notes.txt'), '不是日记');
const diaryList = await j('/rp-soul/engine/diaries?session_id=' + encodeURIComponent(sid));
eq(diaryList.body.ok, true, '8b. 日记读得出来（' + JSON.stringify(diaryList.body.error ?? '') + '）');
eq(diaryList.body.diaries.map((d) => d.day), [2, 1], '8b. 新的在前，别的文件不算');
eq(diaryList.body.diaries[0].title, '第 2 天 · 周二', '8b. 标题是第一行');
eq(diaryList.body.diaries[0].text, '下了一天雨。', '8b. 正文去掉了标题');
const sneaky = await j('/rp-soul/engine/diaries?session_id=' + encodeURIComponent('../../etc'));
eq(sneaky.body.ok, false, '8b. 不像会话 id 的一律拒掉（不拼进路径）');
const noDiary = await j('/rp-soul/engine/diaries?session_id=s_nothinghere');
eq(noDiary.body.diaries, [], '8b. 还没写过日记就是空列表');

// ---- 8c. POST /engine/common/approve：确认一条待确认的常识 ----
const missingCommon = await j('/rp-soul/engine/common/approve', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ common_id: 'c999' }),
});
eq(missingCommon.body.ok, false, '8c. 没有这条就报错');
const noCommonId = await j('/rp-soul/engine/common/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
eq(noCommonId.status, 400, '8c. 没带 common_id 就 400');

// ---- 9. DELETE /engine/wipe：从零开始 ----
// 先确认确实有东西可删，否则「删干净了」证明不了什么
const beforeWipe = await j('/rp-soul/engine/memories?session_id=' + encodeURIComponent(sid));
ok(Array.isArray(beforeWipe.body.entries) && beforeWipe.body.entries.length > 0, '9. 清空前有记忆');
const engineDir = join(home, 'rp-soul', 'engine');
ok(existsSync(join(engineDir, 'engine.db')), '9. 清空前有数据库');
mkdirSync(join(engineDir, 'backups'), { recursive: true });
writeFileSync(join(engineDir, 'backups', 'old.db'), 'x');

// 不带 confirm 必须被挡
const noConfirm = await j('/rp-soul/engine/wipe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
eq(noConfirm.status, 400, '9. 没有 confirm 就拒掉');

const wiped = await j('/rp-soul/engine/wipe', {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: true }),
});
eq(wiped.body.ok, true, '9. 清空成功（' + JSON.stringify(wiped.body.error ?? '') + '）');
eq(wiped.body.db, true, '9. 数据库被删');
// 删完会立刻开新局，engine.db 又会被建出来 —— 所以「删没删」看的是回执与新局内容，不是文件在不在
ok(wiped.body.backups >= 1, '9. 备份目录里那一份也被删了（' + wiped.body.backups + '）');
// 开了新局，且它跟旧局不是同一个
ok(typeof wiped.body.session_id === 'string' && wiped.body.session_id !== sid, '9. 新局已开好');

// 新局是空的：记忆一条都没有
const afterWipe = await j('/rp-soul/engine/memories?session_id=' + encodeURIComponent(wiped.body.session_id));
ok(Array.isArray(afterWipe.body.entries) && afterWipe.body.entries.length === 0, '9. 新局没有旧记忆');
eq(afterWipe.body.turn, 0, '9. 新局从第 0 回合开始');

// 人设没被动：前面的用例改过标题，所以只验「还读得出来、还是同一个人」
const personaAfter = await j('/rp-soul/engine');
ok(typeof personaAfter.body.persona?.title === 'string' && personaAfter.body.persona.title !== '', '9. 清空不动人设');

await new Promise((r) => server.close(r));
done('engine-http');
process.exit(0);
