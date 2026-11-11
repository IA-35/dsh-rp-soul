/* 新引擎第七阶段：记忆模块（三层、收成 SCM、日记、想起来）和它的宿主那一半。时间全是传进去的 now。 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';
import * as T from '../lib/engine/core/time.js';
import * as L from '../lib/engine/modules/memory/layers.js';
import * as RC from '../lib/engine/modules/memory/recall.js';
import { recallText } from '../lib/engine/modules/memory/index.js';
import { createEngine } from '../lib/engine/index.js';
import { mountMemoryHost, batchText, splitFold, foldLimit, clipMiddle, tidyText, budgetSources } from '../lib/engine-v2-memory.js';

const t0 = '2026-11-11T20:00:00+08:00'; // 周三
const at = (minutes) => T.addMinutes(t0, minutes);
const abm = (slice, text, minutes, extra = {}) => L.add(slice, { layer: 'abm', type: 'conversation', content: text, importance: 0.3, at: at(minutes), ...extra }).slice;

// ---- 1. 三层：记、去重、衰减 ----
let s = L.init();
const n1 = L.noteExchange(s, { text: '你：今天下雨了 她：我把伞放门口了' }, at(0));
ok(n1.entry.layer === 'abm' && n1.entry.type === 'conversation', '1. 宿主记的一段进 ABM');
ok(n1.entry.keywords.includes('下雨'), '1. 汉字两两切成关键词');
ok(L.noteExchange(n1.slice, { text: '你：今天下雨了 她：我把伞放门口了' }, at(1)).duplicate, '1. 同一段再来一次：不重复记');
eq(L.noteExchange(s, { text: '你：x', together: false }, at(0)).entry.type, 'experience', '1. 她自己醒着：记成 experience');
const scm = { id: 'm9', layer: 'scm', a0: 1, t0: at(0), pinned: false };
ok(Math.abs(L.activity(scm, at(30 * 1440)) - 0.995 ** 720) < 1e-9, '1. SCM 每小时衰减 0.005');
eq(L.activity({ ...scm, layer: 'clpa' }, at(30 * 1440)), 1, '1. CLPA 不衰减');
eq(L.clearness(0.5), '大概记得', '1. 清楚程度用词说');

// ---- 2. 什么时候收成一条 SCM ----
s = L.init();
for (let i = 0; i < 5; i += 1) s = abm(s, '第 ' + i + ' 句', i);
eq(L.foldBatch(s, at(10)), null, '2. 五条、刚说完：不收');
eq(L.foldBatch(s, at(70))?.length, 5, '2. 停了一小时：全收');
const gap = abm(s, '隔了两小时又开口', 130);
eq(L.foldBatch(gap, at(131)), ['m1', 'm2', 'm3', 'm4', 'm5'], '2. 中间停过一小时：收空白之前的，刚说的这句不算');
let full = L.init();
for (let i = 0; i < 20; i += 1) full = abm(full, '第 ' + i + ' 句', i);
eq(L.foldBatch(full, at(21))?.length, 20, '2. 满 20 条：收');
eq(L.foldBatch(abm(L.init(), 'x', 0), at(1), { manual: true })?.length, 1, '2. 立即汇总：不等');
const ms = abm(s, '我们第一次说好周末去看海', 6, { pinned: true, milestone: ['first_promise'] });
const folded = L.applyFold(ms, L.foldBatch(ms, at(70)), '今晚聊了很多。', ['m2'], at(70));
eq(folded.entries.filter((e) => e.layer === 'abm').length, 0, '2. 收完 ABM 清空');
const summary = folded.entries.find((e) => e.layer === 'scm');
eq(summary.at, at(6), '2. SCM 记着这批最晚那一刻');
eq(summary.origin_ids.length, 6, '2. 由哪几条合成的');
eq(folded.entries.filter((e) => e.layer === 'clpa').map((e) => e.content).sort(), ['第 1 句', '我们第一次说好周末去看海'].sort(), '2. KEEP 的和里程碑抄进 CLPA');
eq(L.applyFold(ms, ['m99'], 'x', [], at(70)), null, '2. 那一批已经没了：不凭空落一条');

// ---- 3. 清理 ----
let m = L.add(L.init(), { layer: 'abm', type: 'action', content: '倒了杯水', importance: 0.2, at: at(0) }).slice;
eq(L.maintain(m, at(25 * 60)).entries.length, 0, '3. 小动作过了 24 小时就丢');
m = L.add(L.init(), { layer: 'scm', type: 'summary', content: '很久以前', importance: 0.5, at: at(0) }).slice;
eq(L.maintain(m, at(800 * 60)).entries.length, 0, '3. SCM 淡光了就忘掉');
let many = L.init();
for (let i = 0; i < 52; i += 1) many = L.add(many, { layer: 'scm', type: 'summary', content: '第 ' + i + ' 段', importance: 0.5, at: at(i * 60) }).slice;
eq(L.maintain(many, at(52 * 60)).entries.length, 50, '3. SCM 最多 50 条：挤掉最不活跃的');
let flood = L.init();
for (let i = 0; i < 45; i += 1) flood = abm(flood, '没人收的第 ' + i + ' 句', i);
eq(L.maintain(flood, at(50)).entries.length, 40, '3. 收不了时 ABM 也不无限涨（两倍容量封顶）');

// ---- 4. 日记 ----
const day1 = L.add(L.init(), { layer: 'scm', type: 'summary', content: '今天一起淋了雨', importance: 0.5, at: at(0) }).slice;
eq(L.diaryDue(day1, at(60)), null, '4. 今天还没到 23:30：不写');
eq(L.diaryDue(day1, '2026-11-11T23:40:00+08:00')?.day, '2026-11-11', '4. 过了 23:30：写今天');
eq(L.diaryDue(day1, '2026-11-12T09:00:00+08:00')?.day, '2026-11-11', '4. 昨天欠着的：第二天补');
eq(L.diaryDue(day1, at(60), { manual: true })?.day, '2026-11-11', '4. 立即写日记：不等 23:30');
const wrote = L.applyDiary(day1, '2026-11-11', ['m1'], '今天下雨。');
eq(L.diaryDue(wrote, '2026-11-12T09:00:00+08:00'), null, '4. 写过的那天不再写');
eq(wrote.diary_last.text, '今天下雨。', '4. 记着最近一篇');
eq(L.diaryWakeAt(day1, at(60))?.at, '2026-11-11T23:30:00+08:00', '4. 唤醒：今天 23:30 叫醒她写');
eq(L.dayTitle('2026-11-11'), '11月11日 · 周三', '4. 日记标题');
eq(L.whenShort('2026-11-11T13:05:00+08:00'), '周三中午 13:05', '4. 注入用的时刻');
eq(L.whenLabel('2026-11-11T14:05:00+08:00'), '11.11 周三 14:05', '4. 设置页用的时刻');

// ---- 5. 设置页改、删 ----
const e1 = L.edit(day1, 'm1', { content: '今天一起淋了雨，她笑了' }, at(10)).entries[0];
ok(e1.edited && e1.keywords.includes('她笑'), '5. 改内容：算你改过，关键词跟着重算');
eq(L.edit(day1, 'm1', { activity: 0.4 }, at(10)).entries[0].a0, 0.4, '5. 改活跃度：从这个值重新开始衰减');
ok(L.edit(day1, 'm1', { pinned: true }, at(10)).entries[0].pinned, '5. Pin');
eq(L.edit(day1, 'm9', {}, at(10)), null, '5. 改不存在的：null');
eq(L.remove(day1, 'm1').entries.length, 0, '5. 删');

// ---- 6. 想起来 ----
eq(RC.keywords('DeepSeek 写代码'), ['写代', '代码', 'deepseek'], '6. 关键词：汉字两两 + 英文词');
const mem = L.add(L.add(L.init(), { layer: 'scm', type: 'summary', content: '那天一起去海边看日落', importance: 0.6, at: at(0) }).slice,
  { layer: 'scm', type: 'summary', content: '她把伞留在门边', importance: 0.5, at: at(10) }).slice;
const text = recallText(mem, '还记得海边吗', at(60));
has(text, '那天一起去海边看日落', '6. 你这句话勾起的那条注入');
hasNot(text, '伞', '6. 没被勾起的不注入');
has(text, '（周三晚上 20:00）', '6. 带着那是什么时候');
eq(recallText(mem, '今天吃什么', at(60)), '', '6. 什么都没勾起：空串');
has(recallText({ ...mem, diary_last: { day: '2026-11-11', text: '今天下雨。' } }, '', at(60), { firstTurn: true }), '你最近的一篇日记（11月11日 · 周三）', '6. 新会话第一轮带上最近一篇日记');

// ---- 7. 引擎：ABM 的正文是原文；交账只留原文里没有的；宿主记的不动 revision ----
const persona = { id: 'lin_wan', name: '林晚', mood_base: 55 };
let nowMs = Date.parse(t0);
const tick = (minutes) => { nowMs += minutes * 60000; };
// 目录结构照真的来：<根>/engine 是数据目录，日记落在 <根>/memory
const rootDir = mkdtempSync(join(tmpdir(), 'engine-memory-'));
const dataDir = join(rootDir, 'engine');
const engine = createEngine({ dataDir, clock: () => new Date(nowMs) });
const memOf = () => engine.panel('memory', { persona });
engine.start(persona);
engine.commit({ summary: '他说起下雨。', quotes: ['伞放门口了'], feel: [{ label: '他还记得', delta: 9, because: '他记得伞' }] }, { persona, said: true });
eq(memOf().counts.abm, 0, '7. 交账的 summary 不进记忆（那是第三人称的流水）');
const rev = engine.context({ persona }).revision;
tick(1);
ok(engine.noteExchange({ text: '你：今天下雨了\n她：伞放门口了，你别淋着。' }).id, '7. 宿主记原文');
const first = memOf().entries[0];
eq(first.quotes, ['伞放门口了'], '7. 交账挂着的原话并进这条原文');
ok(first.importance > 0.3, '7. 这一次的心事让它更重（' + first.importance + '）');
has(first.content, '你：今天下雨了\n她：', '7. 一轮一组，换行留着');
eq(engine.context({ persona }).revision, rev, '7. 宿主记的不动 revision');
ok(engine.commit({ summary: '接着聊。' }, { persona, said: true, revision: rev }).ok, '7. 模型拿着记之前的 revision 交账：照样过');
tick(1);
engine.commit({ summary: '说好周末去看海。', promise: [{ title: '去看海', in_minutes: 3000 }], away: '她下午去花店进了一批洋桔梗' }, { persona, said: true });
eq(memOf().entries[0].content, '她下午去花店进了一批洋桔梗', '7. away 原文里没有：交账时直接记成一段经历');
engine.noteExchange({ text: '你：周末去看海吧\n她：好，说定了。' });
const pinned = memOf().entries.find((e) => e.content.includes('说定了'));
ok(pinned.pinned && pinned.milestone.includes('first_promise'), '7. 第一次立约定：里程碑落在那一轮的原文上，钉住');
engine.noteExchange({ text: '你：嗯\n她：嗯。' });
ok(!memOf().entries.find((e) => e.content.includes('嗯。')).pinned, '7. 里程碑只并进一条');
tick(90);
const due = engine.memoryDue();
ok(due.fold !== null && due.fold.sources.length >= 3, '7. 停了一个半小时：该收了');
ok(engine.applyFold(due.fold.ids, '那晚聊了下雨和看海。', []).ok, '7. 收成一条 SCM');
eq(memOf().counts.abm, 0, '7. ABM 清空');
eq(memOf().counts.clpa, 1, '7. 里程碑进了 CLPA');
has(engine.recall('下雨的时候'), '那晚聊了下雨和看海。', '7. 你提到下雨：想起来');
const scmAct = () => memOf().entries.find((e) => e.layer === 'scm').activity;
tick(600);
const faded = scmAct();
ok(engine.reinforce('下雨的时候'), '7. 召回增强：被勾起的那条');
ok(Math.abs(scmAct() - Math.min(1, faded + 0.1)) < 1e-3, '7. 活跃度加 0.1（' + faded + ' → ' + scmAct() + '）');
ok(!engine.reinforce('明早几点出发'), '7. 没勾起：不加');
nowMs = Date.parse('2026-11-11T23:00:00+08:00');
eq(engine.nextWake({ persona, missYouHours: 0, routine: false, quiet: '' }).next?.reason, 'diary', '7. 今天有该写的：唤醒表里有 23:30 写日记');
nowMs = Date.parse('2026-11-11T23:40:00+08:00');
const owed = engine.memoryDue().diary;
ok(owed !== null && engine.applyDiary(owed.day, owed.ids, '今天下雨。').ok, '7. 写日记');
eq(engine.memoryDue().diary, null, '7. 写过就不欠了');
engine.setToggles({ memory: false });
eq(engine.recall('下雨'), '', '7. 关掉记忆：不再想起来');
eq(engine.noteExchange({ text: 'x' }), null, '7. 也不再记');
engine.setToggles({});

// ---- 8. 宿主那一半：攒批（不过子代理）、原文收窄、子代理整理、日记文件 ----
eq(clipMiddle('一二三四五六七八九十', 7), '一二三四…九十', '8. 掐中间留头尾');
eq(tidyText('看这段：\n```js\nconst a = 1;\n```\n好了'), '看这段： 〔代码〕 好了', '8. 代码块换成〔代码〕');
eq(budgetSources([{ text: 'a'.repeat(9000) }, { text: 'b'.repeat(9000) }], 12000).map((s) => s.text.length), [6000, 6000], '8. 喂子代理的总量超了：每条平分');
const prompts = [];
const fakeCtx = {
  get: (name) => (name === 'subagents' ? {
    startActivation: async ({ request, label }) => {
      prompts.push({ label, text: request.prompt[0].text });
      return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: label === '写日记' ? '今天下了雨，他记得伞。' : '那晚我们聊了下雨。\nKEEP: ' }] }), dispose: async () => {} };
    },
  } : name === 'agents' ? { get: () => liveAgent, roots: () => [liveAgent] } : undefined),
};
const turn = (said, answer) => ({ agent: { id: 'a1', session: { deriveMessages: () => [
  { role: 'user', content: [{ type: 'text', text: said }] },
  { role: 'assistant', content: [{ type: 'text', text: answer }] },
] } } });
const liveAgent = turn('x', 'y').agent;
const host = mountMemoryHost({
  ctx: fakeCtx, engine: () => engine, persona: () => persona,
  isChildAgent: () => false, cueOf: (c) => c.agent.session.deriveMessages()[0].content[0].text,
  dataDirOf: () => dataDir, aloneOf: () => false,
});
// 第二天：11 日的日记已经写过，这一天记下的要写进 12 日那篇
nowMs = Date.parse('2026-11-12T10:00:00+08:00');
const abmCount = () => memOf().counts.abm;
await host.noteTurn(turn('嗯', '嗯。'));
eq(abmCount(), 0, '8. 一轮「嗯」：先攒着');
engine.commit({ summary: '他问然后呢。' }, { persona, said: true });
await host.noteTurn(turn('然后呢', '然后她笑了。'));
await host.noteTurn(turn('真的吗', '真的。'));
await host.noteTurn(turn('那就好', '这一段很长：' + '她讲了很久很久。'.repeat(200) + '最后她问你明天还来吗？'));
eq(abmCount(), 1, '8. 攒够四轮落一条（交过账的那轮照样记）');
const written = memOf().entries[0].content;
has(written, '你：然后呢\n她：然后她笑了。', '8. 一轮一组铺开');
ok(written.includes('最后她问你明天还来吗？') && written.length < 1500, '8. 太长的回复掐中间：结尾那句问话留着，整条 ' + written.length + ' 字');
ok(!prompts.some((p) => p.label === '筛记忆'), '8. ABM 不过子代理');
eq(batchText([{ said: 'a', reply: 'b' }]), '你：a\n她：b', '8. batchText');
eq(splitFold('正文\nKEEP: m3, m4, m5', 300), { text: '正文', keep: ['m3', 'm4'] }, '8. KEEP 最多两条');
eq(foldLimit([{ when: 'a' }, { when: 'b' }, { when: 'b' }]), 340, '8. 多一个时间点多 40 字');
tick(70);
await host.tidyMemory({ agent: liveAgent });
ok(prompts.some((p) => p.label === '记忆整理'), '8. 停够一小时：起子代理收成 SCM');
eq(abmCount(), 0, '8. 收完 ABM 清空');
eq(host.tidyNow('fold'), 'nothing', '8. 再点立即汇总：没有可收的');
eq(host.tidyNow('diary'), 'started', '8. 立即写日记：后台起');
await new Promise((r) => setTimeout(r, 20));
const files = await host.diaries();
ok(files.length === 1 && files[0].text === '今天下了雨，他记得伞。' && files[0].title.includes('·'), '8. 日记落成文件，设置页读得到');
// 日记和旧引擎放一处：<数据目录的上一层>/memory（数据目录是 rp-soul/engine）
const journalDir = join(dataDir, '..', 'memory');
ok(existsSync(join(journalDir, 'diary-' + files[0].day + '.md')), '8. 文件在数据目录上一层的 memory 下');
has(readFileSync(join(journalDir, 'diary-' + files[0].day + '.md'), 'utf8'), '# ', '8. 第一行是标题');

// 旧引擎的日记叫 diary-0014.md（按第几天）：同一处也读得到，日期取文件修改时间
writeFileSync(join(journalDir, 'diary-0002.md'), '# 第 2 天 · 周三\n\n那天他带伞来了。\n', 'utf8');
const mixed = await host.diaries();
ok(mixed.length === 2, '8. 新的日历日命名和旧的编号命名一起列出来');
ok(mixed.some((f) => f.text === '那天他带伞来了。' && f.title === '第 2 天 · 周三'), '8. 旧日记也读得到，标题原样');
host.forget();
engine.close();

done('v2-memory');
