/* 真机接线测试：用真实 Python 侧车跑完整一局（mock 掉 DSH 的 ctx 与 tools）。
 * 验的是「Node 层 ↔ 引擎」的协议与语义：开局、读状态、交账、被驳回、心情面板、
 * 删情绪、存档、撤销、导出。任何一条不成立就抛错、退出码非 0。 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';
import { markWakeTurn, clearWakeTurn } from '../lib/wake.js';

const home = mkdtempSync(join(tmpdir(), 'souleng-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(join(home, 'rp-soul', 'preset.md'), '<!-- soul-part: 人设 -->' + String.fromCharCode(10) + [
  '---',
  'id: lin_wan',
  'title: 雨夜诊所',
  'name: 林晚',
  'role: 夜班医生',
  'age: 34',
  'gender: female',
  'adult_context: 独立执业五年的全科医生',
  'voices:',
  '  surface: 说话克制，先问诊再答话。',
  '  inner: 其实一直在等一句道歉。',
  'routine:',
  '  - {from: 0, to: 1439, doing: 在诊所值夜班}',
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
const handlers = new Map();
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  on(name, fn) { handlers.set(name, fn); return () => { handlers.delete(name); }; },
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
// noteBatchMinutes：攒着的一批多久没下文就自己落。默认半小时，测试里调成 3 秒
mod.apply(ctx, { maxBytes: 65536, noteBatchMinutes: 0.05 });

// ---- 1. 三个工具都注册了 ----
eq(tools.size, 3, '1. 注册了 3 个工具');
ok(tools.has('soul_state') && tools.has('soul_commit') && tools.has('soul_admin'), '1. 工具名齐全');
const commitProps = tools.get('soul_commit').parameters.properties;
const bridge = await import(new URL('../lib/engine-bridge.js', import.meta.url).href);
eq(commitProps.content_tags.items.enum, [...bridge.CONTENT_TAGS], '1. content_tags 枚举就是引擎的标签表');
eq(commitProps.action_mode.enum, [...bridge.ACTION_MODES], '1. action_mode 枚举就是引擎的五档');

const exec = { signal: undefined, agent: { id: 'conv-1' } };
const call = (name, args) => tools.get(name).execute(args, exec);

// ---- 2. start：从人设包开局 ----
const started = await call('soul_admin', {
  action: 'start',
  seed: 424242,
});
if (started.ok !== true) console.log('START FAIL', JSON.stringify(started, null, 2));
ok(started.ok === true, '2. start 成功（' + JSON.stringify(started.error ?? '') + '）');
ok(typeof started.session_id === 'string' && started.session_id.startsWith('s'), '2. 拿到引擎会话 id');
eq(started.turn, 0, '2. 开局 turn=0');
eq(started.persona.title, '雨夜诊所', '2. 人设标题来自前置块');
ok(started.revision >= 1, '2. revision 从 1 起算');
const sessionId = started.session_id;
let revision = started.revision;

// ---- 3. soul_state：只回她要看的，局面复述留给提示词快照 ----
const brief = await call('soul_state', {});
eq(brief.started, true, '3. started=true');
eq(brief.session_id, sessionId, '3. 会话 id 一致');
ok(brief.context !== undefined && brief.context !== null, '3. 带回 context');
eq(brief.context.world, undefined, '3. 没有 world 段');
ok(Array.isArray(brief.context.agency), '3. agency 是数组');
// 常识跟着提示词走（装配时按你这句话挑好），工具结果里再来一遍是重复；
// 记忆在快照里只有被这句话撞上的那几条，其余的在这里给模型自己翻。
ok(Array.isArray(brief.context.memories), '3. memories 在工具结果里（快照只放被勾起的那几条）');
eq(brief.context.common, undefined, '3. common 不在工具结果里（提示词里已有）');
ok(brief.context.mood !== undefined, '3. 心情块提到顶层');
has(JSON.stringify(brief.context.mood), 'band', '3. 心情带档位');
// 时间 / 在场 / 态度 / 名字这些每轮都在提示词里写着，工具结果不再复述。
eq(brief.context.clock, undefined, '3. 不再回 clock（提示词里已有）');
eq(brief.context.companion, undefined, '3. 不再回 companion 整块');
eq(brief.context.present_npcs, undefined, '3. 没有多角色的 present_npcs');

// ---- 4. 提示词快照：读过一次状态后 soul-engine 才有内容 ----
const snap1 = sections.get('soul-engine').text();
has(snap1, '当前现状', '4. soul-engine 输出账本');
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
    { op: 'npc_response', response: 'partial', note: '还行，就是雨大。' },
    // 回应本身不进 TA 自己的心情；信任变化才会留下一条记忆，供第 8–9 步删
    { op: 'relationship', trust_delta: 1, reason: '你问起 TA 今晚忙不忙' },
  ],
  content_tags: [],
  summary: '玩家进门，和林晚搭了两句。',
  remember: '他冒着雨进来，问我忙不忙，我心里松了一下',
  open_action: '林晚从里屋走出来了吗',
});
ok(committed.committed === true, '6. commit 成功（' + JSON.stringify(committed.error ?? '') + '）');
eq(committed.turn, 1, '6. turn 前进到 1');
ok(committed.revision > revision, '6. revision 递增');
revision = committed.revision;

// ---- 6b. 记忆与常识跟着提示词快照走，工具结果里不再重复一遍 ----
const recalled = await call('soul_state', { cue: '今晚雨真大' });
ok(Array.isArray(recalled.context?.her_knows), '6b. context 带 her_knows');
eq(recalled.context?.recent, undefined, '6b. 旧的 recent 摘要不再单独给');
// 常识由装配钩子按你这句话挑好、写进「想起来的」那段（见 prompt.mjs 第 8 条）。
ok(Array.isArray(recalled.context?.memories), '6b. memories 在工具结果里，供模型多回忆一点');
eq(recalled.context?.common, undefined, '6b. common 不进工具结果（提示词里已有）');

// ---- 6c. 常识库：工具 schema 收得下；注入靠提示词快照，不靠工具结果 ----
ok(
  Array.isArray(commitProps.common?.items?.required) && commitProps.common.items.required.includes('key'),
  '6c. soul_commit 能写 common',
);
eq(recalled.context?.common, undefined, '6c. 常识不进工具结果（提示词里已有）');

// ---- 6d. 宿主起的子代理不是她：读不到账本，也交不了账 ----
const childExec = { signal: undefined, agent: { id: 'child-1', session: { header: { origin: 'subagent' }, deriveMessages: () => [] } } };
eq((await tools.get('soul_state').execute({}, childExec)).started, false, '6d. 子代理读不到她的账本');
eq((await tools.get('soul_commit').execute({ action_mode: 'continue', summary: '子代理想交账' }, childExec)).committed, false,
  '6d. 子代理也交不了账');
const deepExec = { signal: undefined, agent: { id: 'child-2', session: { header: { delegationDepth: 1 }, deriveMessages: () => [] } } };
eq((await tools.get('soul_state').execute({}, deepExec)).started, false, '6d. 委派深度大于 0 的同样算子代理');

// ---- 6e. 这一轮交过账，回合结束宿主就不再记一条（哪怕她交完账又说了一句） ----
const { EngineClient } = await import(new URL('../lib/engine-client.js', import.meta.url).href);
const peek = new EngineClient({ dataDir: join(home, 'rp-soul', 'engine') });
// 宿主替她记的那条长这样：「你：… 她：…」；交账那条是她自己的记法，小动作另记一条 action
const notedOf = async () => (await peek.call('debug-memories', { session_id: sessionId })).entries.filter((e) => e.layer === 'abm' && e.content.startsWith('你：'));
const stopping = handlers.get('agent/turn-stopping');
ok(typeof stopping === 'function', '6e. 挂上了回合结束的钩子');
const talk = (said, reply) => [
  { id: 'u-' + said, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: said }] },
  { id: 'a-' + said, role: 'assistant', content: [{ type: 'text', text: reply }] },
];
const noteAgent = { id: 'conv-1', session: { deriveMessages: () => talk('今晚忙吗', '还行，就是雨大。') } };
const before6e = (await notedOf()).length;
const turnArgs = {
  action_mode: 'result', player_input: '今晚忙吗',
  operations: [{ op: 'npc_action', kind: 'observe', action: 'TA 抬头看了一眼窗外。', significant: false }],
  content_tags: [], summary: '你问 TA 忙不忙。', open_action: '等你接话',
};
const turnCommitted = await tools.get('soul_commit').execute(turnArgs, { signal: undefined, agent: noteAgent });
ok(turnCommitted.committed === true, '6e. 这一轮交了账（' + JSON.stringify(turnCommitted.error ?? '') + '）');
// 交完账她又说了一句：最后一条消息变了，但这一轮仍算交过
noteAgent.session = { deriveMessages: () => [...talk('今晚忙吗', '还行，就是雨大。'), { id: 'a-more', role: 'assistant', content: [{ type: 'text', text: '你先坐。' }] }] };
await stopping({ agent: noteAgent });
eq((await notedOf()).length, before6e, '6e. 交过账的那一轮只有交账那一条，不会再记一条「你：… 她：…」');
// 没交账：攒够几轮之后由宿主自己记一条（一条 ABM 讲的是一件事，不是一句话）
const lines = [['伞放哪儿', '门边就行。'], ['雨这么大', '伞还在门口。'], ['你带伞了吗', '我不用。'], ['那我走了', '路上慢点。']];
for (const [one, two] of lines) {
  noteAgent.session = { deriveMessages: () => talk(one, two) };
  await stopping({ agent: noteAgent });
}
const after6e = await notedOf();
eq(after6e.length, before6e + 1, '6e. 攒够几轮，宿主自己记一条');
ok(after6e.some((e) => String(e.content).includes('伞放哪儿') && String(e.content).includes('路上慢点')), '6e. 记的是这几轮铺开的样子');
// 子代理那一轮结束也不记
await stopping({ agent: { id: 'child-1', session: { header: { origin: 'subagent' }, deriveMessages: () => talk('把下面这一批收成一条', '那天雨很大。') } } });
eq((await notedOf()).length, after6e.length, '6e. 子代理那一轮结束不当成她的对话记下来');

// ---- 6f. 攒着的一批不会悄悄丢 ----
const waitFor = async (check, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !(await check())) await new Promise((r) => setTimeout(r, 100));
};
// agent 的一轮回复动辄上千字：两轮拼起来超过引擎 4000 字的上限，也得落下来（截短），不能整批被驳回
noteAgent.session = { deriveMessages: () => talk('先看看这个', '好'.repeat(1000)) };
await stopping({ agent: noteAgent });
noteAgent.session = { deriveMessages: () => talk('再说一遍'.repeat(200), '嗯'.repeat(2400)) };
await stopping({ agent: noteAgent });
await waitFor(async () => (await notedOf()).some((e) => String(e.content).includes('先看看这个')));
const longNoted = (await notedOf()).find((e) => String(e.content).includes('先看看这个'));
ok(longNoted !== undefined, '6f. 超过 4000 字的一批截短后照样记下，不会整批丢掉');
ok(longNoted !== undefined && String(longNoted.content).includes('再说一遍'), '6f. 截短时两轮都还在，不是只剩开头那一轮');
// 聊一句就走：搁够久（测试里 3 秒）没下文就自己落一条，不等下一轮
const beforeIdle = (await notedOf()).length;
noteAgent.session = { deriveMessages: () => talk('我先走了', '嗯，明天见。') };
await stopping({ agent: noteAgent });
eq((await notedOf()).length, beforeIdle, '6f. 一轮还不够落一条');
await waitFor(async () => (await notedOf()).length > beforeIdle);
ok((await notedOf()).some((e) => String(e.content).includes('我先走了')), '6f. 搁够久没下文，自己落下来');

// ---- 6g. 真实会话里交账失败过的那几次，原样再交一遍 ----
// 以前这几次全被驳回（字段名猜错、漏了 content_tags / player_input / open_action、
// 总结多了几个字、没要求的日记），模型只好改了再交、一轮最多交四次。
const replay = async (args, label) => {
  const out = await tools.get('soul_commit').execute(args, { signal: undefined, agent: noteAgent });
  ok(out.committed === true, label + '（' + JSON.stringify(out.error ?? '') + '）');
  if (out.committed === true) await call('soul_admin', { action: 'undo' });
  return out;
};
await replay({"action_mode": "wait", "player_input": "1", "summary": "主人只发来一个「1」，没头没尾。守岸人没懂，抬眼看过去，问他在数什么。", "remember": "他丢过来一个「1」，我看不懂，只好看着他。", "open_action": "等他说明这个「1」是什么意思。", "operations": [{"op": "npc_action", "kind": "silence", "note": "没出声，先抬眼看他"}], "acts_on_her": false}, '6g. npc_action 写成 note、漏了 content_tags：照样记上');
await replay({"action_mode": "continue", "content_tags": [], "operations": [{"action": "把 openclaw 卸载掉，npm 全局包和配置都清了，还剩三个项目没动", "kind": "action", "op": "npc_action", "significant": false}, {"op": "npc_state", "state": "平常"}], "summary": "清理 openclaw：卸载 npm 全局包，删掉配置与数据，释放 23.5G"}, '6g. kind 写成 action、npc_state 只写了一句心情、漏了原话和悬念：照样记上');
await replay({"action_mode": "wait", "acts_on_her": false, "content_tags": [], "player_input": "1", "summary": "主人只发来一个「1」，没头没尾。", "open_action": "等他说明这个「1」是什么意思。", "operations": [{"op": "offscreen_beat", "action": "他不在的这段时间，我把桌上那堆临时产物收了收，等着。"}, {"op": "npc_action", "kind": "observe", "action": "没出声，先把杯子转了半圈，抬眼看他", "significant": false}], "memory_fold": "那一天很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长", "memory_diary": "第四天。今天没什么特别的。"}, '6g. offscreen_beat 写成 action、总结超了几个字、没要求的日记：照样记上');
// 真的缺东西（心事没写分量和依据）还是要驳回，而且说得清缺什么
const missing = await tools.get('soul_commit').execute({"action_mode": "result", "acts_on_her": false, "player_input": "这个改动怎么被丢弃了？", "operations": [{"op": "add_thought", "text": "他半夜在翻一个提交的下落。"}, {"op": "npc_action", "kind": "observe", "action": "把灯往他那边推了推", "significant": false}], "summary": "他深夜问起一个提交的去向。", "open_action": "等他看完那个提交。"}, { signal: undefined, agent: noteAgent });
eq(missing.committed, false, '6g. add_thought 缺了 delta / basis_fact_id 仍然驳回（不替模型编数值）');
has(String(missing.error ?? ''), 'delta', '6g. 驳回理由点名缺的是 delta');
// 工具说明里写清了每个 op 的字段：模型第一次就能写对
has(tools.get('soul_commit').parameters.properties.operations.description, 'offscreen_beat {summary', '6g. 说明里写了 offscreen_beat 的字段是 summary');
has(tools.get('soul_commit').parameters.properties.operations.description, 'npc_action {action', '6g. 说明里写了 npc_action 的字段是 action');
await peek.stop();
// 后面的步骤按「只交过一回合」来数：把 6e 这一回合撤掉
const undo6e = await call('soul_admin', { action: 'undo' });
ok(undo6e.ok !== false, '6e. 撤掉这一节加的回合（' + JSON.stringify(undo6e.error ?? '') + '）');
revision = undo6e.revision ?? revision;

// ---- 7. stale revision 会被引擎拒，但带当前 revision ----
const staleClient = tools.get('soul_commit');
const stale = await staleClient.execute({ action_mode: 'continue', summary: '假装旧版本' }, {
  signal: undefined,
  agent: { id: 'conv-1' },
});
// 同会话内 revision 已同步，这次只是再交一次安静回合 → 仍会被「无可观察变化」拒
eq(stale.committed, false, '7. 再次空转仍被拒');

// ---- 8. mood_panel：心情面板有 thresholds 与 thoughts ----
// 只有她一个人：npc_id 可以省略
const panel = await call('soul_admin', { action: 'mood_panel' });
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
    thought_id: victim.id,
    reason: '测试手动删除',
  });
  ok(dropped.ok === true, '9. drop_thought 成功（' + JSON.stringify(dropped.error ?? '') + '）');
  const after = await call('soul_admin', { action: 'mood_panel', npc_id: 'lin_wan' });
  ok(!after.thoughts.some((t) => t.id === victim.id), '9. 该条已消失');
  ok(Array.isArray(after.deletions) && after.deletions.length >= 1, '9. 留下删除审计');
} else {
  ok(false, '9. 第 6 步的信任变化没有留下情绪条目');
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

// ---- 13. 全局作用域：换个 DSH 会话，读到的还是同一局 ----
const otherExec = { signal: undefined, agent: { id: 'conv-2' } };
const otherState = await tools.get('soul_state').execute({}, otherExec);
eq(otherState.started, true, '13. 另一个会话也能拿到状态');
eq(otherState.session_id, loaded.session_id, '13. 全局作用域下两个会话共用同一局');
const scopeStatus = await call('soul_admin', { action: 'status' });
eq(scopeStatus.scope, 'global', '13. status 报全局作用域');

async function checkWakeReveal(exec, scope) {
  const args = { action_mode: 'continue', player_input: '', content_tags: [], summary: '她整理抽屉。', open_action: '那封信还没给你看。' };
  const secret = await tools.get('soul_commit').execute({ ...args, operations: [
    { op: 'add_fact', key: 'wake.letter', text: '抽屉里有一封未寄出的信', scope: 'companion_only', origin: 'observed' },
  ] }, exec);
  ok(secret.committed, scope + '. 先记下她自己的秘密');
  const fid = secret.turns[0].applied.find((item) => item.op === 'add_fact').fact_id;
  const reveal = { ...args, operations: [{ op: 'reveal_fact', fact_id: fid }] };
  markWakeTurn(exec.agent.id);
  try {
    for (const extra of [{}, { together: true }]) {
      const rejected = await tools.get('soul_commit').execute({ ...reveal, ...extra }, exec);
      eq(rejected.committed, false, scope + '. 唤醒回合不能直接互通秘密');
      has(rejected.error, '你不在场', scope + '. 唤醒标记按 DSH 会话生效');
      const response = await tools.get('soul_commit').execute({ ...args, ...extra, operations: [
        { op: 'npc_response', response: 'genuine', note: '她轻声说晚安。' },
      ] }, exec);
      eq(response.committed, false, scope + '. 唤醒回合不能把自己的消息当成双方回应');
      has(response.error, '你不在场', scope + '. 模型也不能覆盖唤醒回合的在场判定');
    }
    const fresh = await tools.get('soul_state').execute({}, exec);
    ok(!(fresh.context.known_facts ?? fresh.context.player_facts ?? []).some((f) => f.id === fid), scope + '. 驳回后玩家仍不知道秘密');
  } finally {
    clearWakeTurn(exec.agent.id);
  }
  const accepted = await tools.get('soul_commit').execute(reveal, exec);
  ok(accepted.committed, scope + '. 玩家回来后可以正常告知');
}
await checkWakeReveal(exec, '13b. 全局作用域');

// ---- 14. 自动开局：没有局时 soul_state 自己开一局 ----
await call('soul_admin', { action: 'reset_mapping' });
const born = await call('soul_state', {});
eq(born.started, true, '14. 解绑后 soul_state 自动开局');
eq(born.autoStarted, true, '14. 标了 autoStarted');
ok(typeof born.session_id === 'string' && born.session_id.startsWith('s'), '14. 自动开局拿到会话 id');
ok(born.context !== undefined && born.context !== null, '14. 自动开局直接带回 context');

// 低心情的行动要能从宿主工具提交，并能在下一回合继续表达。
const hurt = await call('soul_commit', {
  action_mode: 'continue', player_input: '', operations: [
    { op: 'add_fact', key: 'hurt.first', text: '一件让她难过的事', scope: 'companion_only', origin: 'observed' },
    { op: 'add_fact', key: 'hurt.second', text: '另一件让她难过的事', scope: 'companion_only', origin: 'observed' },
  ], content_tags: [], summary: '她想起了两件事。', open_action: '她低下头。',
});
ok(hurt.committed, '14b. 记录情绪的事实依据');
const causes = hurt.turns[0].applied.filter((a) => a.op === 'add_fact').map((a) => a.fact_id);
const low = await call('soul_commit', {
  action_mode: 'continue', player_input: '', operations: causes.map((id, i) => ({ op: 'add_thought', label: '难过' + i, delta: -30, basis_fact_id: id })),
  content_tags: [], summary: '那些事让她很难过。', open_action: '她安静下来。',
});
ok(low.committed && low.context.mood.band === 'break', '14b. 她进入难过档');
for (const kind of ['silence', 'seek_comfort', 'change_topic', 'withdraw']) {
  has(tools.get('soul_commit').description, kind, '14b. 工具说明告诉模型怎样提交 ' + kind);
  const expression = await call('soul_commit', {
    action_mode: 'continue', player_input: '', operations: [{ op: 'npc_action', kind, action: '她按自己的习惯表达难过。' }],
    content_tags: [], summary: '她表达了当下的感受。', open_action: '她还没有缓过来。',
  });
  ok(expression.committed, '14b. 允许轻微表达 ' + kind + '：' + String(expression.error ?? ''));
  eq(expression.context.mood.band, 'break', '14b. 表达情绪不会自动把她变开心');
}

// ---- 15. 切回按会话作用域：两个会话各开各的局 ----
writeFileSync(join(home, 'rp-soul', 'config.json'), JSON.stringify({ engineScope: 'session' }), 'utf8');
const convA = await call('soul_state', {});
const convB = await tools.get('soul_state').execute({}, otherExec);
eq(convA.autoStarted, true, '15. 切到按会话后 conv-1 自动开新局');
eq(convB.autoStarted, true, '15. 切到按会话后 conv-2 自动开新局');
ok(convA.session_id !== convB.session_id, '15. 两个会话拿到不同的局');
const scopeStatus2 = await call('soul_admin', { action: 'status' });
eq(scopeStatus2.scope, 'session', '15. status 报按会话作用域');
await checkWakeReveal(exec, '15b. 按会话作用域');

// full 的底细和事件在 Python 里换了字段名，工具裁剪后仍要能读到。
const fullSetup = await call('soul_commit', {
  action_mode: 'result', player_input: '门锁密码是7319。', operations: [
    { op: 'add_fact', key: 'door.code', text: '门锁密码是7319', scope: 'shared', origin: 'observed' },
    { op: 'event_create', kind: 'deadline', title: '整理病历', with_player: false, in_minutes: 120, dedupe_key: 'clinic.paperwork' },
  ], content_tags: [], summary: '她记住了门锁密码，还有病历要整理。', open_action: '她准备整理病历。',
});
ok(fullSetup.committed, '15c. 记下双方事实和近期事件：' + String(fullSetup.error ?? ''));
for (const depth of ['brief', 'full']) {
  const state = await call('soul_state', { depth });
  ok(state.context.known_facts?.some((f) => f.text === '门锁密码是7319'), '15c. ' + depth + ' 保留双方事实');
  ok(state.context.due_soon?.some((e) => e.title === '整理病历'), '15c. ' + depth + ' 保留近期事件');
}

// ---- 16. 人设为空时 start 明确报错（不静默开局） ----
writeFileSync(join(home, 'rp-soul', 'config.json'), JSON.stringify({ engineScope: 'global' }), 'utf8');
writeFileSync(join(home, 'rp-soul', 'persona.md'), '   ' + String.fromCharCode(10), 'utf8');
writeFileSync(join(home, 'rp-soul', 'preset.md'), '   ' + String.fromCharCode(10), 'utf8');
const emptyStart = await call('soul_admin', { action: 'reset_mapping' }).then(() =>
  call('soul_admin', { action: 'start' }));
eq(emptyStart.ok, false, '16. 空人设拒绝开局');
has(JSON.stringify(emptyStart), '人设', '16. 报错提到人设');

// ---- 17. 切回全局：接管旧的会话局，不重开 ----
const adopted = await call('soul_state', {});
eq(adopted.started, true, '17. 切回全局后能直接用');
ok(adopted.session_id === convA.session_id || adopted.session_id === convB.session_id,
  '17. 接管的是某个旧的会话局，而不是新开一局');
const mapAfterAdopt = JSON.parse(readFileSync(join(home, 'rp-soul', 'engine-sessions.json'), 'utf8'));
ok(mapAfterAdopt.shared !== undefined, '17. 映射表里有了 shared');
ok(mapAfterAdopt['conv-1'] === undefined && mapAfterAdopt['conv-2'] === undefined,
  '17. 旧的会话键已清掉（不会两个键指向同一局各记各的）');

// ---- 18. 人设为空时自动开局也不硬开，而是降级 ----
// 先把映射表清干净：接管旧局是另一回事，这里要验的是「没有局、人设又空」。
writeFileSync(join(home, 'rp-soul', 'engine-sessions.json'), '{}', 'utf8');
const emptyBorn = await call('soul_state', {});
eq(emptyBorn.started, false, '18. 空人设下不自动开局');
has(JSON.stringify(emptyBorn), '按人设散文演', '18. 明确说降级到纯人设');

done('engine');
// 侧车是常驻子进程，测试进程要主动退出，否则事件循环被它的管道占着。
process.exit(0);
