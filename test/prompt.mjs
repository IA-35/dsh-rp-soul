/* 真实 Cordis + DSH SystemPrompt + Python 侧车：首次装配不能依赖模型先调工具。 */
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineClient } from '../lib/engine-client.js';
import * as plugin from '../lib/index.js';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const persona = {
  front: { id: 'lin_wan', name: '林晚', age: 31, gender: 'female', role: '医生',
    voices: { surface: '说话克制', inner: '总在算时间' },
    routine: [{ from: 0, to: 1439, doing: '在诊所工作' }] },
  prose: '林晚在这家诊所工作。', title: '雨夜诊所', persona_id: 'lin_wan',
};
const home = mkdtempSync(join(tmpdir(), 'soulprompt-'));
mkdirSync(join(home, 'rp-soul'));
writeFileSync(join(home, 'SOUL.md'), '---\n' + Object.entries({ id: 'lin_wan', name: '林晚', age: 31, gender: 'female', role: '医生' })
  .map(([key, value]) => `${key}: ${value}`).join('\n') + '\nvoices:\n  surface: 说话克制\n  inner: 总在算时间\n---\n' + persona.prose);
process.env.DSH_HOME = home;
const client = new EngineClient({ dataDir: join(home, 'rp-soul', 'engine') });
let request = 0;
const rid = () => 'prompt_request_' + (++request);
const start = async () => client.call('new-game', { request_id: rid(), persona, seed: 7 });
const commit = async (row, suspense) => {
  const data = await client.call('commit-turn', {
    session_id: row.session_id, request_id: rid(), expected_revision: row.revision,
    turns: [{ action_mode: 'result', player_input: '你好', operations: [], content_tags: [], summary: '你们聊了一会儿。', open_action: suspense }],
  });
  return { ...row, revision: data.revision, turn: data.turn };
};
const mappingPath = join(home, 'rp-soul', 'engine-sessions.json');
const storePath = join(home, 'rp-soul', 'config.json');
const agentA = { id: 'conversation-A' }, agentB = { id: 'conversation-B' };
const app = new Context();
let fiber;
let promptFiber;
const assemble = async (agent, signal) => app.systemPrompt.assemble(agent ? assembleContextFor(agent, signal) : {});
// 账本现在走「有序动态 runtime context」，不再是系统提示词的 section——
// 系统提示词必须恒定，前缀才能一路命中缓存。
const engineText = (assembly) => assembly.contexts.find((s) => s.name === 'soul-engine')?.text ?? '';
try {
  const a = await commit(await start(), '重启前留下的悬念A');
  const b = await commit(await start(), '另一局留下的悬念B');
  writeFileSync(mappingPath, JSON.stringify({ shared: a }));
  promptFiber = app.plugin(SystemPrompt, SystemPrompt.Config({ includeHarnessIdentity: false }));
  await promptFiber;
  fiber = app.plugin(plugin, plugin.Config({ files: ['SOUL.md'] }));
  await fiber;

  // 没有 tools 服务，没有调用 soul_state：直接走宿主的真实装配入口。
  const first = await assemble(agentA);
  has(engineText(first), '重启前留下的悬念A', '1. 第一次装配就从已保存的局恢复账本');
  has(renderPrompt(first), persona.prose, '1. 最终系统提示保留人设');
  has(engineText(first), '心情：', '1. 动态上下文实际包含引擎状态');
  // 关键回归：账本绝不能回到系统提示词里，否则前缀哈希每回合都变、缓存全废。
  hasNot(renderPrompt(first), '心情：', '1. 系统提示词里不含引擎状态（前缀必须恒定）');
  const next = await commit(a, '外部更新后的悬念A');
  has(engineText(await assemble(agentA)), '外部更新后的悬念A', '2. 下一次装配重新读取数据，不依赖工具更新缓存');
  eq(JSON.parse(readFileSync(mappingPath)).shared.revision, next.revision, '2. 会话映射也追上最新 revision');

  // 最要紧的一条回归：账本变了，系统提示词必须**逐字节不变**。
  // 缓存按整段前缀的字节哈希命中，只要有一个字节变了，整个前缀就废。
  const promptA = renderPrompt(await assemble(agentA));
  const again = await commit(next, '外部更新后的悬念A');
  const promptB = renderPrompt(await assemble(agentA));
  eq(promptB, promptA, '2. 账本更新后系统提示词逐字节不变（缓存前缀可一直命中）');

  await fiber.dispose();
  fiber = app.plugin(plugin, plugin.Config({ files: ['SOUL.md'] }));
  await fiber;
  has(engineText(await assemble(agentA)), '外部更新后的悬念A', '3. 插件重启后第一次装配仍有状态');

  const store = JSON.parse(readFileSync(storePath));
  writeFileSync(storePath, JSON.stringify({ ...store, engineScope: 'session' }));
  writeFileSync(mappingPath, JSON.stringify({ [agentA.id]: again, [agentB.id]: b }));
  const [pa, pb] = await Promise.all([assemble(agentA), assemble(agentB)]);
  has(engineText(pa), '外部更新后的悬念A', '4. 并行装配 A 使用自己的账本');
  hasNot(engineText(pa), '另一局留下的悬念B', '4. A 不串 B 的状态');
  has(engineText(pb), '另一局留下的悬念B', '4. 并行装配 B 使用自己的账本');
  hasNot(engineText(pb), '外部更新后的悬念A', '4. B 不串 A 的状态');
  eq(engineText(await assemble()), '', '4. 会话模式的无会话预览不借用别人的账本');

  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  try { await assemble(agentA, abort.signal); } catch { cancelled = true; }
  ok(cancelled, '5. 已取消的装配不继续加载状态');
  writeFileSync(mappingPath, JSON.stringify({ [agentA.id]: { ...next, session_id: 's_missing' }, [agentB.id]: b }));
  const missing = await assemble(agentA);
  // 读失败时沿用上一次的局面：装配链不能为了拿新状态卡住对话，也不能在
  // 一次超时后把局面整段抽走（那会让她的心情和在场凭空消失）。
  has(engineText(missing), '外部更新后的悬念A', '5. 账本读取失败就沿用上一次的局面');
  has(renderPrompt(missing), persona.prose, '5. 引擎读取失败仍保留人设提示');
  await fiber.dispose();

  // 新建一个干净的引擎目录，验证首次自动开局及两个装配同时发生的情况。
  writeFileSync(storePath, JSON.stringify({ ...store, engineScope: 'global', engineDataDir: join(home, 'fresh-engine') }));
  writeFileSync(mappingPath, '{}');
  fiber = app.plugin(plugin, plugin.Config({ files: ['SOUL.md'] }));
  await fiber;
  const cold = await Promise.all([assemble(agentA), assemble(agentB)]);
  ok(cold.every((p) => engineText(p).includes('心情：')), '6. 全新安装第一次并行装配也有引擎状态');
  const freshClient = new EngineClient({ dataDir: join(home, 'fresh-engine') });
  try {
    const sessions = await freshClient.call('list-sessions', {});
    eq(sessions.sessions.length, 1, '6. 全局首次并行装配只开一局');
  } finally { await freshClient.stop(); }

  await fiber.dispose();
  fiber = app.plugin(plugin, plugin.Config({ files: ['SOUL.md'], engineEnabled: false }));
  await fiber;
  eq(engineText(await assemble(agentA)), '', '7. 引擎关闭时不注入账本');
  done('prompt');
} finally {
  if (fiber) await fiber.dispose();
  await client.stop();
  if (promptFiber) await promptFiber.dispose();
}
