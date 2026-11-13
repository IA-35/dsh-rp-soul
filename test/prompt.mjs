/* 真实 Cordis + DSH SystemPrompt + 进程内引擎：首次装配不能依赖模型先调工具。 */
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../lib/engine/index.js';
import * as CM from '../lib/engine/modules/common/index.js';
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
const personaYaml = Object.entries({ id: 'lin_wan', name: '林晚', age: 31, gender: 'female', role: '医生' })
  .map(([key, value]) => key + ': ' + value).join(String.fromCharCode(10))
  + String.fromCharCode(10) + 'voices:' + String.fromCharCode(10) + '  surface: 说话克制' + String.fromCharCode(10) + '  inner: 总在算时间' + String.fromCharCode(10);
writeFileSync(join(home, 'rp-soul', 'persona.md'), personaYaml);
writeFileSync(join(home, 'rp-soul', 'preset.md'), '<!-- soul-part: 人设 -->' + String.fromCharCode(10) + persona.prose + String.fromCharCode(10));
process.env.DSH_HOME = home;
// 直接开同一个库灌数据：插件挂上后读的就是这一局（引擎无子进程、无会话映射表）。
const dataDir = join(home, 'rp-soul', 'engine');
const seed = createEngine({ dataDir });
const her = { ...persona.front, id: 'lin_wan', name: '林晚', revision: 'seed', mood_base: 60, start_stage: 'familiar' };
seed.start(her);
/** 灌一次交账，返回新的 revision。 */
const commitSeed = (open) => {
  const revision = seed.context({ persona: her }).revision;
  const out = seed.commit({ summary: '你们聊了一会儿。', open }, { persona: her, said: true, revision });
  if (!out.ok) throw new Error('灌数据失败：' + JSON.stringify(out.problems));
  return out.revision;
};
const storePath = join(home, 'rp-soul', 'config.json');
const agentA = { id: 'conversation-A' }, agentB = { id: 'conversation-B' };
const app = new Context();
let fiber;
let promptFiber;
// 宿主真正的 subagent 服务在测试环境里没有，这里放一个假的顶上：
// 记下每次调用，返回一句编好的汇总，验插件有没有走对这条路。
const subagentsSpawned = [];
app.provide('subagents');
app.set('subagents', {
  startActivation: async (spec) => {
    subagentsSpawned.push({ prompt: spec?.request?.prompt?.[0]?.text ?? '', label: spec?.label, provider: spec?.provider, delivery: spec?.delivery, signal: spec?.signal });
    return {
      childId: 's_fake',
      result: Promise.resolve({ output: [{ type: 'text', text: '那些天一直亮着灯，我在岸上等。\nKEEP: m1' }], stopReason: 'completed' }),
      dispose: async () => {},
    };
  },
});
const assemble = async (agent, signal) => app.systemPrompt.assemble(agent ? assembleContextFor(agent, signal) : {});
// 账本现在走「有序动态 runtime context」，不再是系统提示词的 section——
// 系统提示词必须恒定，前缀才能一路命中缓存。
const engineText = (assembly) => assembly.contexts.find((s) => s.name === 'soul-engine')?.text ?? '';
// 「她想起来的」单独一段：跟着你这句话变的东西都在这里，局面那段才能保持不变。
const recallText = (assembly) => assembly.contexts.find((s) => s.name === 'soul-recall')?.text ?? '';
try {
  const firstRevision = commitSeed('重启前留下的悬念A');
  ok(firstRevision > 0, '1. 灌进去一局，账本 revision 往前走');
  promptFiber = app.plugin(SystemPrompt, SystemPrompt.Config({ includeHarnessIdentity: false }));
  await promptFiber;
  fiber = app.plugin(plugin, plugin.Config({}));
  await fiber;

  // 没有 tools 服务，没有调用 soul_state：直接走宿主的真实装配入口。
  const first = await assemble(agentA);
  has(engineText(first), '重启前留下的悬念A', '1. 第一次装配就从已保存的局恢复账本');
  has(renderPrompt(first), persona.prose, '1. 最终系统提示保留人设');
  has(engineText(first), '心情：', '1. 动态上下文实际包含引擎状态');
  // 关键回归：账本绝不能回到系统提示词里，否则前缀哈希每回合都变、缓存全废。
  hasNot(renderPrompt(first), '心情：', '1. 系统提示词里不含引擎状态（前缀必须恒定）');
  const next = commitSeed('外部更新后的悬念A');
  has(engineText(await assemble(agentA)), '外部更新后的悬念A', '2. 下一次装配重新读取数据，不依赖工具更新缓存');
  eq(seed.context({ persona: her }).revision, next, '2. 装配读到的是最新 revision');

  // 最要紧的一条回归：账本变了，系统提示词必须**逐字节不变**。
  // 缓存按整段前缀的字节哈希命中，只要有一个字节变了，整个前缀就废。
  const promptA = renderPrompt(await assemble(agentA));
  commitSeed('外部更新后的悬念A');
  const promptB = renderPrompt(await assemble(agentA));
  eq(promptB, promptA, '2. 账本更新后系统提示词逐字节不变（缓存前缀可一直命中）');

  await fiber.dispose();
  fiber = app.plugin(plugin, plugin.Config({}));
  await fiber;
  has(engineText(await assemble(agentA)), '外部更新后的悬念A', '3. 插件重启后第一次装配仍有状态');

  // 全局只有一局：两个会话并行装配，读的是同一本账。
  const [pa, pb] = await Promise.all([assemble(agentA), assemble(agentB)]);
  has(engineText(pa), '外部更新后的悬念A', '4. 并行装配都读到这一局');
  eq(engineText(pb), engineText(pa), '4. 两个会话共用一本账，局面一致');

  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  try { await assemble(agentA, abort.signal); } catch { cancelled = true; }
  ok(cancelled, '5. 已取消的装配不继续加载状态');

  // 最要紧的一条：记忆和常识按「你这一次说的话」挑，不靠模型自己去调工具。
  // cue 从 agent 的会话里翻最后一条真实的用户消息，装配期就拿到。
  seed.changeCommon((rows) => [...rows, CM.make(rows, { key: ['deepseek', 'ds'], weight: 0.8, content: 'deepseek 是深度求索旗下的大语言模型。' })]);
  const sayTo = (agent, text) => {
    agent.session = { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] };
  };
  sayTo(agentA, '我平时用的是 ds 这个模型');
  const hit = await assemble(agentA);
  has(recallText(hit), '### 常识', '8. 命中关键词的常识跟着「想起来的」那段注入');
  has(recallText(hit), '深度求索', '8. 常识正文也在');
  hasNot(engineText(hit), '### 常识', '8. 常识不在局面那段：那段不该跟着你这句话变');
  sayTo(agentA, '今天下雨了，路上有点堵');
  const miss = await assemble(agentA);
  hasNot(recallText(miss), '### 常识', '8. 没命中就不出现');
  eq(engineText(miss), engineText(hit), '8. 换一句话，局面那段一字不变（宿主不会再追加一份）');
  // 注入给模型的上下文（goal、压缩摘要）也是 user 角色，但不是你说的话。
  agentA.session = {
    deriveMessages: () => [
      { role: 'user', source: { kind: 'goal-round' }, content: [{ type: 'text', text: '我平时用的是 ds 这个模型' }] },
    ],
  };
  hasNot(recallText(await assemble(agentA)), '### 常识', '8. 别人注入的上下文不算你说的话');
  // 宿主起的子代理也会走装配：它不是她，局面和想起来的都不给
  const child = { id: 'child-fold', session: { header: { origin: 'subagent' }, deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我平时用的是 ds 这个模型' }] },
  ] } };
  const childAssembly = await assemble(child);
  eq(engineText(childAssembly), '', '8. 子代理的装配里没有她的局面');
  eq(recallText(childAssembly), '', '8. 子代理的装配里也没有她想起来的');
  // 快照里已经写着局面了，别再让模型每轮白跑一趟 soul_state 才敢动笔。
  const snap = engineText(await assemble(agentA));
  hasNot(snap, '写之前用 soul_state', '8. 快照不要求每轮先调 soul_state');
  has(snap, '写完用 soul_commit 交账', '8. 快照仍要求交账');
  delete agentA.session;
  await fiber.dispose();

  // 新建一个干净的引擎目录，验证首次自动开局及两个装配同时发生的情况。
  writeFileSync(storePath, JSON.stringify({ engineDataDir: join(home, 'fresh-engine') }));
  fiber = app.plugin(plugin, plugin.Config({}));
  await fiber;
  const cold = await Promise.all([assemble(agentA), assemble(agentB)]);
  ok(cold.every((p) => engineText(p).includes('心情：')), '6. 全新安装第一次并行装配也有引擎状态');
  const fresh = createEngine({ dataDir: join(home, 'fresh-engine') });
  try {
    eq(fresh.context({ persona: her }).revision, 0, '6. 全局首次并行装配只开一局');
  } finally { fresh.close(); }

  await fiber.dispose();
  fiber = app.plugin(plugin, plugin.Config({ engineEnabled: false }));
  await fiber;
  eq(engineText(await assemble(agentA)), '', '7. 引擎关闭时不注入账本');
  done('prompt');
} finally {
  if (fiber) await fiber.dispose();
  seed.close();
  if (promptFiber) await promptFiber.dispose();
}
