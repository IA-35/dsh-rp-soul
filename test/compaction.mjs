/* 无工具压缩：断言 toolFreeMessages 真的把工具痕迹删干净，且引擎类形态正确。
 * 不跑真 LLM：只验「送给摘要请求的那段消息」是什么样子。 */
import { eq, ok, has, hasNot, done } from './_check.mjs';
import SoulCompaction, { SUMMARY_INSTRUCTION, toolFreeMessages, hasConversation } from '../lib/compaction.js';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

// ---- 1. 引擎形态 ----
eq(typeof SoulCompaction, 'function', '1. 默认导出是类');
ok(SoulCompaction.prototype instanceof BasicCompactionEngine, '1. 继承了宿主的 BasicCompactionEngine');
eq(SoulCompaction.inject, ['llm', 'tokenMeter', 'sessions'], '1. 依赖 llm/tokenMeter/sessions');
eq(typeof SoulCompaction.prototype.summarize, 'function', '1. 覆写了 summarize 钩子');
ok(typeof SoulCompaction.Config === 'function', '1. 带 schemastery Config');
const cfg = SoulCompaction.Config({});
eq(cfg.thresholdRatio, 0.9, '1. 默认阈值 0.9');
eq(cfg.headroomTokens, 65536, '1. 默认预留 65536');

// ---- 2. 摘要指令的要点都在 ----
has(SUMMARY_INSTRUCTION, '不要写进摘要', '2. 指令要求不要把记忆资料写进摘要');
has(SUMMARY_INSTRUCTION, '工具调用过程已从会话中删除', '2. 指令告知工具过程已删');
has(SUMMARY_INSTRUCTION, '【我的时间】', '2. 指令区分闹钟消息');
has(SUMMARY_INSTRUCTION, '不要调用任何工具', '2. 指令禁止摘要时调工具');

// ---- 3. toolFreeMessages ----
const mk = (role, content, source) => (source === undefined ? { role, content } : { role, content, source });
const input = [
  mk('system', [{ type: 'text', text: '你是守岸人' }]),
  mk('user', [{ type: 'text', text: '我回来了' }], { kind: 'user' }),
  mk('assistant', [{ type: 'reasoning', text: '先看看局面' }, { type: 'tool-call', id: 't1', name: 'soul_state' }]),
  mk('tool', [{ type: 'text', text: '{"mood":56}' }]),
  mk('assistant', [{ type: 'text', text: '嗯，鞋在门口。' }]),
  mk('user', [{ type: 'text', text: '记忆块' }], { kind: 'rp-soul-history' }),
  mk('user', [{ type: 'image' }], { kind: 'user' }),
  mk('user', [{ type: 'text', text: '今天有点累' }], { kind: 'user' }),
];
const out = toolFreeMessages(input);
eq(out.length, 6, '3. 8 条消息删掉 tool 与「只有推理」的 step 后剩 6 条');
eq(out.map((m) => m.role).join(','), 'system,user,assistant,user,user,user', '3. 只剩 system/user/assistant，工具整条消失');
ok(!JSON.stringify(out).includes('tool-call'), '3. 没有残留 tool-call 块');
ok(!JSON.stringify(out).includes('mood":56'), '3. 工具结果 JSON 没有进摘要输入');
eq(out[2].content.map((b) => b.type).join('+'), 'text', '3. 只剩推理的 step 被丢弃，正文单独留下');
has(JSON.stringify(out), '鞋在门口', '3. 合并后 assistant 正文保留');
const onlyReasoning = toolFreeMessages([mk('assistant', [{ type: 'reasoning', text: 'x' }, { type: 'tool-call', name: 'y' }])]);
eq(onlyReasoning.length, 0, '3. 只有推理+工具调用的助手消息整条删掉');
const untouched = [mk('user', [{ type: 'text', text: 'hi' }], { kind: 'user' })];
ok(toolFreeMessages(untouched)[0] === untouched[0], '3. 无需改写时原对象直接透传（不做无谓复制）');

// ---- 4. hasConversation ----
ok(!hasConversation(out.filter((m) => m.role === 'system')), '4. 只有 system 不算有对话');
ok(!hasConversation([mk('user', [{ type: 'text', text: '记忆' }], { kind: 'rp-soul-history' })]), '4. 注入的记忆块不算真对话');
ok(!hasConversation([mk('user', [{ type: 'text', text: '时间' }], { kind: 'time-context' })]), '4. 时间块不算真对话');
ok(hasConversation(out), '4. 有真人发言就算有对话');
ok(!hasConversation([mk('user', [{ type: 'text', text: '   ' }], { kind: 'user' })]), '4. 空白文本不算有对话');

done('compaction');
