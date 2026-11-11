/* 新引擎第二阶段：情绪模块（心事与心情、态度、自主行动）。
 * 规则从旧引擎的 mood / relationship / agency 翻过来；时间全是传进去的 now。 */
import { eq, ok, has, hasNot, done } from './_check.mjs';
import * as R from '../lib/engine/core/registry.js';
import { newLedger, commit } from '../lib/engine/core/commit.js';
import { view } from '../lib/engine/core/context.js';
import * as T from '../lib/engine/core/time.js';
import mood from '../lib/engine/modules/mood/index.js';

const registry = R.createRegistry([mood]);
const ON = ['mood'];
const persona = { id: 'lin_wan', name: '林晚', mood_base: 55 };
const t0 = '2026-11-11T20:00:00+08:00';
const at = (minutes) => T.addMinutes(t0, minutes);
const run = (state, input, now, extra = {}) => commit(state, input, { now, registry, enabled: ON, persona: extra.persona ?? persona, said: true, ...extra });
const look = (state, now, extra = {}) => view(state, { now, registry, enabled: extra.enabled ?? ON, persona: extra.persona ?? persona, alone: extra.alone ?? false });
const moodOf = (state, now, extra) => look(state, now, extra).fields.mood;
const labels = (m) => m.thoughts.map((t) => t.label);

// 开局并先聊一句，有了「你上次说话的时刻」
const s0 = run(newLedger(persona, t0, registry), { summary: '他进门了。', learned: [{ key: 'rain.umbrella', text: '他把伞留在门边' }] }, t0).state;

// ---- 1. 基准与在场 ----
const m0 = moodOf(s0, at(1));
eq(m0.base, 55, '1. 基准值取人设的 mood_base');
eq(m0.value, 58, '1. 你在场：+3');
eq(m0.band, 'normal', '1. 平稳');
ok(labels(moodOf(s0, at(1), { alone: true })).includes('你不在'), '1. 她自己醒着：你不在 −2');
ok(!labels(moodOf(s0, at(1), { alone: true })).includes('在场'), '1. 她自己醒着：没有在场');

// ---- 2. 心事：来由是事实 key 或一句话 ----
const f1 = run(s0, { summary: '他把伞给她。', feel: [{ label: '他把伞留给了我', delta: 6, because: 'rain.umbrella' }] }, at(5));
ok(f1.ok, '2. 来由是她知道的事实');
const bogus = run(s0, { summary: 'x', feel: [{ label: '半夜还在查', delta: 3, because: 'late_night.check' }] }, at(5));
// 真实会话里驳回过两次（late_night_check / her_work_power_audit）：不再驳回，退回成心事本身并说一声
ok(bogus.ok && bogus.notes.some((n) => n.includes('late_night.check')), '2. 编了一个不存在的 key：不驳回，记一条说明');
ok(Object.values(bogus.state.facts).some((f) => f.who === 'inner' && f.text === '半夜还在查'), '2. 来由退回成这条心事本身');
const snake = run(s0, { summary: 'x', feel: [{ label: '半夜还在查', delta: 3, because: 'late_night_check' }] }, at(5));
ok(snake.ok && !Object.values(snake.state.facts).some((f) => f.text === 'late_night_check'), '2. 下划线的 key 也当 key 认，不把它当一句话存');
const same = run(s0, {
  summary: '他说起电源的活。',
  learned: [{ key: 'her_work_power_audit', text: '他被分去负责机器人电源设计' }],
  feel: [{ label: '替他留意', delta: 8, because: 'her_work_power_audit' }],
}, at(5));
ok(same.ok && same.state.modules.mood.thoughts.some((t) => t.because === 'her_work_power_audit'), '2. 同一次里先记事实再拿它当来由：认');
const sentence = run(s0, { summary: 'x', feel: [{ label: '他今天来晚了', delta: -4, because: '他说好八点到，九点才来' }] }, at(5));
ok(sentence.ok, '2. 来由直接写一句话也行');
ok(Object.values(sentence.state.facts).some((f) => f.who === 'inner' && f.text.includes('九点才来')), '2. 那句话记成了她心里的事实');
ok(!run(s0, { summary: 'x', feel: [{ label: '凭空', delta: -5 }] }, at(5)).ok, '2. 没写来由：驳回（不许凭空扣心情）');

// ---- 3. 线性变淡、到期消失、同一来由不叠加 ----
const fade = run(s0, { summary: 'x', feel: [{ label: '有点委屈', delta: -10, because: 'rain.umbrella', minutes: 600 }] }, at(10)).state;
eq(moodOf(fade, at(10 + 300)).thoughts.find((t) => t.label === '有点委屈').weight, -5, '3. 过了一半时间：分量剩一半');
ok(!labels(moodOf(fade, at(10 + 600))).includes('有点委屈'), '3. 到期：读出来就没了');
const again = run(fade, { summary: 'x', feel: [{ label: '还是委屈', delta: -8, because: 'rain.umbrella' }] }, at(20)).state;
eq(again.modules.mood.thoughts.filter((t) => t.because === 'rain.umbrella').length, 1, '3. 同一个来由再记一次是刷新，不叠加');
let many = s0;
for (let i = 0; i < 15; i += 1) many = run(many, { summary: 'x', feel: [{ label: '第' + i + '件', delta: i + 1 > 15 ? 15 : i + 1, because: '第 ' + i + ' 件小事' }] }, at(30 + i)).state;
eq(many.modules.mood.thoughts.length, 12, '3. 记下的心事最多 12 条');
ok(!many.modules.mood.thoughts.some((t) => t.label === '第0件'), '3. 淘汰的是分量最弱的');
const tidied = run(fade, { summary: '很久以后。' }, at(10 + 700)).state;
ok(!tidied.modules.mood.thoughts.some((t) => t.label === '有点委屈'), '3. 交账时顺手清掉已经没分量的');

// ---- 4. 态度：信任、张力、阶段 ----
const trust = run(s0, { summary: '他问她忙不忙。', bond: { trust: 1, reason: '他问起她忙不忙' } }, at(5)).state;
eq(trust.modules.mood.bond.trust, 1, '4. 信任 +1');
ok(moodOf(trust, at(6)).thoughts.some((t) => t.label === '心里对你多了几分信任' && t.weight === 3), '4. 信任变化留下一条 ×3 的心事');
ok(!labels(moodOf(trust, at(5 + 6 * 60))).includes('心里对你多了几分信任'), '4. 六小时后它就淡没了');
ok(!run(s0, { summary: 'x', bond: { trust: 3 } }, at(5)).ok, '4. 一次最多 ±2');
let high = s0;
for (let i = 0; i < 4; i += 1) high = run(high, { summary: 'x', bond: { trust: 2, reason: '又一件好事' } }, at(5 + i)).state;
eq(high.modules.mood.bond.trust, 5, '4. 信任夹在 5 以内，不驳回');
const empty = run(s0, { summary: 'x', bond: { reason: '没变' } }, at(5));
ok(empty.ok && empty.notes.some((n) => n.includes('bond')), '4. 什么都没变：不驳回，当没写并说一声');
eq(empty.state.modules.mood.bond.history.length, 0, '4. 当没写：态度历史里不多一条');
const noYes = run(s0, { summary: 'x', bond: { stage: 'advance', reason: '更近了' } }, at(5));
ok(!noYes.ok && noYes.problems.some((p) => p.hint.includes('genuine')), '4. 前进阶段要她这一次是配合的');
const adv = run(s0, { summary: 'x', her: { response: 'genuine' }, bond: { stage: 'advance', reason: '更近了' } }, at(5));
ok(adv.ok, '4. 她配合：前进一个阶段');
eq(adv.state.modules.mood.bond.stage, 'acquainted', '4. 陌生 → 认识');
ok(moodOf(adv.state, at(6)).thoughts.some((t) => t.label === '你们更近了' && t.weight === 15), '4. 前进阶段：+15 的心事');
ok(adv.notes.some((n) => n.includes('认识')), '4. 回执里说一句');
ok(!run(adv.state, { summary: 'x', bond: { stage: 'familiar' } }, at(6)).ok, '4. 「退回」到更高的阶段：驳回');
eq(run(adv.state, { summary: 'x', bond: { stage: 'stranger', reason: '冷下来' } }, at(6)).state.modules.mood.bond.stage, 'stranger', '4. 退回更低的阶段');

// ---- 5. 推出来的心事（不写账本） ----
const lowPersona = { ...persona, mood_base: 40 };
const sad = run(newLedger(lowPersona, t0, registry), { summary: '他进门了。' }, t0, { persona: lowPersona }).state;
eq(moodOf(sad, at(1), { persona: lowPersona }).band, 'closed', '5. 基准 40 + 在场 3：低落');
const lowAdv = run(sad, { summary: 'x', her: { response: 'genuine' }, bond: { stage: 'advance' } }, at(5), { persona: lowPersona });
ok(!lowAdv.ok && lowAdv.problems.some((p) => p.reason.includes('低落')), '5. 低落时不接受关系推进');
const back = run(s0, { summary: '隔了两天他回来了。' }, at(2 * 1440));
ok(labels(moodOf(back.state, at(2 * 1440 + 1))).includes('很久没见你'), '5. 隔了一天以上你才回来：很久没见你');
ok(!labels(moodOf(back.state, at(3 * 1440 + 1))).includes('很久没见你'), '5. 一天以后就淡了');
const promise = run(s0, { summary: '约好了。', promise: [{ title: '周六去看海', due: '2026-11-14T10:00:00+08:00' }] }, at(10)).state;
ok(labels(moodOf(promise, '2026-11-13T12:00:00+08:00')).includes('有件该办的事快到期'), '5. 一天之内就到期：快到期');
const missed = moodOf(promise, '2026-11-14T12:00:00+08:00');
ok(labels(missed).includes('约定落空了'), '5. 过了 10 点没兑现：约定落空，账本里什么都没写');
eq(promise.modules.mood.thoughts.length, 0, '5. 记下的心事里确实没有它');
ok(!labels(moodOf(promise, '2026-11-15T11:00:00+08:00')).includes('约定落空了'), '5. 一天以后淡了');
const tense = run(s0, { summary: '吵起来了。', bond: { tension: 3, reason: '吵了一架' } }, at(10)).state;
ok(labels(moodOf(tense, at(11))).includes('你们之间还绷着'), '5. 张力到 3：还绷着');
const drunk = run(s0, { summary: '她喝多了。', her: { state: { add: [{ kind: 'drunk', text: '喝多了', minutes: 120 }] } } }, at(10)).state;
ok(labels(moodOf(drunk, at(11))).includes('身体不太对劲'), '5. 喝多了：身体不太对劲');
ok(!labels(moodOf(drunk, at(10 + 121))).includes('身体不太对劲'), '5. 酒醒了就没了');
const late = run(s0, { summary: '半夜还在聊。' }, '2026-11-12T00:30:00+08:00').state;
ok(labels(moodOf(late, '2026-11-12T01:00:00+08:00')).includes('大半夜被打扰'), '5. 半夜还在聊：大半夜被打扰');
ok(!labels(moodOf(late, '2026-11-12T07:00:00+08:00')).includes('大半夜被打扰'), '5. 六小时后淡了');
const customPersona = { ...persona, mood_thresholds: { open: 90, closed: 70, break: 30 } };
eq(moodOf(s0, at(1), { persona: customPersona }).band, 'closed', '5. 阈值按人设：58 在 70 以下是低落');

// ---- 6. 自主行动：候选、冷却、难过时只做情绪反应 ----
const happyPersona = { ...persona, mood_base: 80 };
const happy = run(newLedger(happyPersona, t0, registry), { summary: '他进门了。' }, t0, { persona: happyPersona }).state;
const options = look(happy, at(1), { persona: happyPersona }).fields.agency;
ok(options.length > 0 && options.length <= 3, '6. 最多三个候选');
eq(options[0].kind, 'approach', '6. 开心时最想做的是主动找你');
ok(options[0].text.startsWith('林晚'), '6. 候选的话以她名字开头');
has(options[0].because, '心情开心', '6. 带着为什么');
const actNow = run(happy, { summary: '她凑过来。', her: { did: '她主动凑过来' }, act: { significant: true, kind: 'approach' } }, at(2), { persona: happyPersona });
ok(actNow.ok, '6. 从候选里挑一个重大行动');
eq(look(actNow.state, at(5), { persona: happyPersona }).fields.agency, [], '6. 刚做完：冷却中，没有候选');
ok(!run(actNow.state, { summary: 'x', her: { did: '又凑过来' }, act: { significant: true, kind: 'approach' } }, at(5), { persona: happyPersona }).ok, '6. 冷却中再来一次：驳回');
ok(run(actNow.state, { summary: 'x', her: { did: '又凑过来' }, act: { significant: true, kind: 'approach' } }, at(13), { persona: happyPersona }).ok, '6. 开心时冷却只有 10 分钟');
ok(!run(happy, { summary: 'x', her: { did: '刺他一句' }, act: { significant: true, kind: 'provoke' } }, at(2), { persona: happyPersona }).ok, '6. 不在候选里的：驳回');
ok(run(happy, { summary: 'x', her: { did: '随手递了杯水' } }, at(2), { persona: happyPersona }).ok, '6. 不重大的随口举动不受限制');
const breakPersona = { ...persona, mood_base: 10 };
const broken = run(newLedger(breakPersona, t0, registry), { summary: '他进门了。' }, t0, { persona: breakPersona }).state;
const bOptions = look(broken, at(1), { persona: breakPersona }).fields.agency.map((o) => o.kind);
ok(bOptions.length > 0 && bOptions.every((k) => ['provoke', 'leave', 'silence', 'seek_comfort', 'change_topic', 'withdraw'].includes(k)), '6. 难过时候选只有情绪反应');
ok(!run(broken, { summary: 'x', her: { did: '凑过来' }, act: { significant: true, kind: 'approach' } }, at(2), { persona: breakPersona }).ok, '6. 难过时不能主动凑过来');
const w1 = run(broken, { summary: 'x', her: { did: '一个人走开' }, act: { significant: true, kind: 'withdraw' } }, at(2), { persona: breakPersona });
ok(w1.ok && run(w1.state, { summary: 'x', her: { did: '还是不说话' }, act: { significant: true, kind: 'silence' } }, at(3), { persona: breakPersona }).ok, '6. 难过时的情绪反应不受冷却限制');
ok(run(happy, { summary: 'x', tags: ['intimate'], consent: true, her: { did: '她主动吻了他' }, act: { significant: true, kind: 'approach' } }, at(2), { persona: happyPersona }).ok, '6. 她主动（重大行动）也算亲密门禁里的「配合」');

// ---- 7. 快照 ----
const lines = look(trust, at(6)).lines.join('\n');
has(lines, '对主人的态度：陌生', '7. 快照里有态度');
has(lines, '心情：平稳', '7. 有心情档位');
has(lines, '心里对你多了几分信任（+3，1 分钟前）', '7. 想法带分量和多久以前');
has(lines, '可能发生：', '7. 有候选');

// ---- 8. 关掉情绪：内核照常跑 ----
const plain = commit(s0, { summary: '他坐下了。', feel: [{ label: 'x', delta: 3, because: 'rain.umbrella' }], bond: { trust: 1 } }, { now: at(5), registry, enabled: [], persona, said: true });
ok(plain.ok, '8. 情绪关着：交账照常');
eq(plain.state.modules.mood, s0.modules.mood, '8. 它的切片一点没动');
ok(plain.notes.some((n) => n.includes('feel')) && plain.notes.some((n) => n.includes('bond')), '8. 它的字段当不认识的丢掉，回执里说一句');
const offLines = look(s0, at(5), { enabled: [] }).lines.join('\n');
hasNot(offLines, '心情', '8. 快照里没有心情');
hasNot(offLines, '可能发生', '8. 也没有候选');

done('v2-mood');
