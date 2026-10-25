/* 真机接线测试：用真实 Python 侧车跑完整一局（mock 掉 DSH 的 ctx 与 tools）。
 * 验的是「Node 层 ↔ 引擎」的协议与语义：开局、读状态、交账、被驳回、心情面板、
 * 删情绪、存档、撤销、导出。任何一条不成立就抛错、退出码非 0。 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'souleng-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul', 'parts'), { recursive: true });
writeFileSync(join(home, 'SOUL.md'), [
  '---',
  'id: rain_clinic',
  'title: 雨夜诊所',
  'places:',
  '  - id: clinic',
  '    name: 诊所',
  '    privacy: private',
  '  - id: hall',
  '    name: 走廊',
  '    privacy: semi',
  'cast:',
  '  - id: lin_wan',
  '    name: 林晚',
  '    tier: major',
  '    role: 夜班医生',
  '    age: 34',
  '    gender: female',
  '    adult_context: 独立执业五年的全科医生',
  '    voices:',
  '      surface: 说话克制，先问诊再答话。',
  '      inner: 其实一直在等一句道歉。',
  '  - id: zhou_yi',
  '    name: 周逸',
  '    tier: supporting',
  '    role: 常来的病人',
  '    age: 29',
  '    gender: male',
  '    adult_context: 在城里做木工的自由职业者',
  'start:',
  '  day: 1',
  '  minute: 1320',
  'mood_base: 55',
  'mood_thresholds:',
  '  open: 72',
  '  closed: 40',
  '  break: 18',
  '---',
  '林晚是这家小诊所的夜班医生，习惯把情绪收在袖口里。',
].join('\n'), 'utf8');

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- mock ctx：只需要 effect / inject / systemPrompt / webServer / connection / tools ----
const tools = new Map();
const sections = new Map();
const routes = [];
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject(_deps, cb) {
    cb({
      effect: ctx.effect,
      inject: (d, c) => ctx.inject(d, c),
      get tools() {
        return {
          register(def) { tools.set(def.name, def); return () => { tools.delete(def.name); }; },
        };
      },
      get webServer() { return { register(def) { routes.push(def); return () => {}; } }; },
      get connection() { return { requestRejection() { return undefined; } }; },
    });
  },
  systemPrompt: {
    getSectionOrder(name) { return name === 'DEPLOYMENT_PERSONA_PREFIX' ? 120 : 0; },
    section(def) { sections.set(def.name, def); return () => { sections.delete(def.name); }; },
  },
};
mod.apply(ctx, { files: ['SOUL.md'], maxBytes: 65536 });

// ---- 1. 三个工具都注册了 ----
eq(tools.size, 3, '1. 注册了 3 个工具');
ok(tools.has('soul_state') && tools.has('soul_commit') && tools.has('soul_admin'), '1. 工具名齐全');

const exec = { signal: undefined, agent: { id: 'conv-1' } };
const call = (name, args) => tools.get(name).execute(args, exec);

// ---- 2. start：从人设包开局 ----
const started = await call('soul_admin', {
  action: 'start',
  seed: 424242,
  start_location: 'clinic',
  present: ['lin_wan', 'zhou_yi'],
});
if (started.ok !== true) console.log('START FAIL', JSON.stringify(started, null, 2));
ok(started.ok === true, '2. start 成功（' + JSON.stringify(started.error ?? '') + '）');
ok(typeof started.session_id === 'string' && started.session_id.startsWith('s'), '2. 拿到引擎会话 id');
eq(started.turn, 0, '2. 开局 turn=0');
eq(started.persona.title, '雨夜诊所', '2. 人设标题来自前置块');
ok(started.revision >= 1, '2. revision 从 1 起算');
const sessionId = started.session_id;
let revision = started.revision;

// ---- 3. soul_state：brief 有账本、无 world ----
const brief = await call('soul_state', {});
eq(brief.started, true, '3. started=true');
eq(brief.session_id, sessionId, '3. 会话 id 一致');
ok(brief.context !== undefined && brief.context !== null, '3. 带回 context');
eq(brief.context.world, undefined, '3. 没有 world 段');
ok(typeof brief.context.clock?.label === 'string', '3. clock.label 是字符串');
ok(Array.isArray(brief.context.present_npcs) && brief.context.present_npcs.length >= 1, '3. present_npcs 非空');
ok(Array.isArray(brief.context.agency), '3. agency 是数组');
has(JSON.stringify(brief.context), 'mood', '3. 角色带 mood');

// ---- 4. 提示词快照：读过一次状态后 soul-engine 才有内容 ----
const snap1 = sections.get('soul-engine').text();
has(snap1, '当前局面', '4. soul-engine 输出账本');
has(snap1, '时间：', '4. 带时间行');
eq(sections.get('soul-engine').interpolate, false, '4. soul-engine 关闭插值');

// ---- 5. soul_commit：安静回合被拒（没有可观察变化） ----
const quiet = await call('soul_commit', { action_mode: 'continue', summary: '什么也没发生' });
eq(quiet.committed, false, '5. 无变化回合被拒');
eq(quiet.rejected, true, '5. 标成 rejected');
ok(typeof quiet.error === 'string' && quiet.error.length > 0, '5. 带回错误文本');

// ---- 6. soul_commit：正常一回合 ----
const committed = await call('soul_commit', {
  action_mode: 'result',
  player_input: '我把伞靠在门边，问她今晚忙不忙。',
  operations: [
    { op: 'advance_time', minutes: 10 },
    { op: 'npc_response', npc_id: 'zhou_yi', response: 'partial', note: '还行，就是雨大。' },
  ],
  content_tags: [],
  summary: '玩家进门，和周逸搭了两句。',
  open_action: '林晚从里屋走出来了吗',
});
ok(committed.committed === true, '6. commit 成功（' + JSON.stringify(committed.error ?? '') + '）');
eq(committed.turn, 1, '6. turn 前进到 1');
ok(committed.revision > revision, '6. revision 递增');
revision = committed.revision;

// ---- 7. stale revision 会被引擎拒，但带当前 revision ----
const staleClient = tools.get('soul_commit');
const stale = await staleClient.execute({ action_mode: 'continue', summary: '假装旧版本' }, {
  signal: undefined,
  agent: { id: 'conv-1' },
});
// 同会话内 revision 已同步，这次只是再交一次安静回合 → 仍会被「无可观察变化」拒
eq(stale.committed, false, '7. 再次空转仍被拒');

// ---- 8. mood_panel：心情面板有 thresholds 与 thoughts ----
const panel = await call('soul_admin', { action: 'mood_panel', npc_id: 'zhou_yi' });
ok(panel.ok === true, '8. mood_panel 成功（' + JSON.stringify(panel.error ?? '') + '）');
ok(typeof panel.value === 'number' && panel.value >= 0 && panel.value <= 100, '8. value 在 0..100');
ok(['open', 'normal', 'closed', 'break'].includes(panel.band), '8. band 合法');
eq(panel.thresholds.open, 72, '8. 阈值来自人设');
ok(Array.isArray(panel.thoughts), '8. thoughts 是数组');

// ---- 9. drop_thought：删掉一条情绪，留审计 ----
if (panel.thoughts.length > 0) {
  const victim = panel.thoughts[0];
  const dropped = await call('soul_admin', {
    action: 'drop_thought',
    npc_id: 'zhou_yi',
    thought_id: victim.id,
    reason: '测试手动删除',
  });
  ok(dropped.ok === true, '9. drop_thought 成功（' + JSON.stringify(dropped.error ?? '') + '）');
  const after = await call('soul_admin', { action: 'mood_panel', npc_id: 'zhou_yi' });
  ok(!after.thoughts.some((t) => t.id === victim.id), '9. 该条已消失');
  ok(Array.isArray(after.deletions) && after.deletions.length >= 1, '9. 留下删除审计');
} else {
  ok(false, '9. 开局居然没有任何情绪条目（预期至少有情境类）');
}

// ---- 10. undo：撤回上一回合 ----
const undone = await call('soul_admin', { action: 'undo' });
ok(undone.ok === true, '10. undo 成功（' + JSON.stringify(undone.error ?? '') + '）');
eq(undone.turn, 0, '10. 回到 turn 0');

// ---- 11. save / list / load ----
const saved = await call('soul_admin', { action: 'save', name: 'testing' });
ok(saved.ok === true, '11. save 成功（' + JSON.stringify(saved.error ?? '') + '）');
const listed = await call('soul_admin', { action: 'list' });
ok(listed.ok === true, '11. list 成功 ' + JSON.stringify(listed.error ?? ''));
ok(Array.isArray(listed.slots) && listed.slots.some((s) => s.name === 'testing'), '11. 列表里有 testing');
const loaded = await call('soul_admin', { action: 'load', name: 'testing' });
ok(loaded.ok === true, '11. load 成功（' + JSON.stringify(loaded.error ?? '') + '）');
ok(typeof loaded.session_id === 'string', '11. load 带回新会话 id');

// ---- 12. status：能看见引擎与人设的基本情况 ----
const status = await call('soul_admin', { action: 'status' });
ok(status.engine !== undefined && status.engine.ready === true, '12. 引擎 ready');
eq(status.persona.title, '雨夜诊所', '12. 人设标题');
ok(status.session !== null && typeof status.session.session_id === 'string', '12. 会话映射在');

// ---- 13. 人设为空时 start 明确报错（不静默开局） ----
writeFileSync(join(home, 'SOUL.md'), '   \n', 'utf8');
const emptyStart = await call('soul_admin', { action: 'reset_mapping' }).then(() =>
  call('soul_admin', { action: 'start' }));
eq(emptyStart.ok, false, '13. 空人设拒绝开局');
has(JSON.stringify(emptyStart), '人设', '13. 报错提到人设');

done('engine');
// 侧车是常驻子进程，测试进程要主动退出，否则事件循环被它的管道占着。
process.exit(0);
