/* 新引擎第一阶段：内核与模块框架。
 * 用两个假模块验开关、依赖、ask / emit、关掉再打开；时间全是传进去的 now。 */
import { eq, ok, has, hasNot, done } from './_check.mjs';
import * as S from '../lib/engine/core/schema.js';
import * as R from '../lib/engine/core/registry.js';
import { newLedger, commit, commitSpec } from '../lib/engine/core/commit.js';
import { view } from '../lib/engine/core/context.js';
import * as T from '../lib/engine/core/time.js';

/** 递归冻结：被冻住的对象一旦被改就会抛，用来抓「commit 改了入参」。 */
const freeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freeze(v);
  }
  return o;
};

// ---- 假模块：一个记数，一个依赖它，一个要宿主能力 ----
const counter = {
  id: 'counter',
  label: '记数',
  fields: { mark: S.describe(S.str(20), '记一笔') },
  init: (_persona, now) => ({ count: 0, last_at: now, cancelled: [] }),
  validate: (_slice, input) => (input.mark === '坏' ? [{ path: '$.mark', reason: '不收「坏」', hint: '' }] : []),
  apply: (slice, input, ctx) => {
    if (input.mark === undefined) return slice;
    ctx.note('记了一笔');
    return { ...slice, count: slice.count + 1, last_at: ctx.now };
  },
  on: { 'event.cancelled': (slice, payload) => ({ ...slice, cancelled: [...slice.cancelled, payload.id] }) },
  answers: { count: (slice) => slice.count },
  // 读的时候现算：离上一笔多久了（关着期间时间照样在走）
  project: (slice, ctx) => ({ lines: ['记数：' + slice.count + '，上一笔 ' + T.ago(slice.last_at, ctx.now)], fields: { count: slice.count } }),
};
const follower = {
  id: 'follower',
  label: '跟随',
  requires: ['counter'],
  init: () => ({ seen: null }),
  apply: (slice, _input, ctx) => ({ seen: ctx.ask('counter.count') }),
};
const hosty = { id: 'hosty', label: '要宿主', requires: ['host:subagents'], init: () => ({}) };
const registry = R.createRegistry([counter, follower, hosty]);
const persona = { id: 'lin_wan', name: '林晚', routine: [{ from: '08:00', to: '18:00', doing: '在诊所上班' }, { from: '22:30', to: '06:30', doing: '睡觉' }] };

// ---- 1. 注册表与开关 ----
let threw = '';
try { R.createRegistry([counter, counter]); } catch (e) { threw = e.message; }
has(threw, '重复', '1. 模块 id 重复直接抛');
try { R.createRegistry([{ id: 'x', label: 'x', oops: 1 }]); } catch (e) { threw = e.message; }
has(threw, '不认识的键', '1. 模块里有不认识的键直接抛');
const allOn = R.resolve(registry, {}, { subagents: true });
eq(allOn.enabled, ['counter', 'follower', 'hosty'], '1. 没写开关的默认全开');
const counterOff = R.resolve(registry, { counter: false }, { subagents: true });
eq(counterOff.enabled, ['hosty'], '1. 关掉 counter，依赖它的 follower 跟着关');
has(counterOff.off.follower, '记数', '1. 写明 follower 为什么没开');
const noHost = R.resolve(registry, {}, {});
ok(!noHost.enabled.includes('hosty'), '1. 宿主没有子代理服务，hosty 开不起来');
has(noHost.off.hosty, 'subagents', '1. 写明缺的是宿主的哪样能力');

// ---- 2. 交账表跟着开关变 ----
const onSpec = commitSpec(registry, allOn.enabled);
const offSpec = commitSpec(registry, counterOff.enabled);
ok('mark' in onSpec.fields, '2. 模块开着：它的字段在交账表里');
ok(!('mark' in offSpec.fields), '2. 模块关着：它的字段不在交账表里');
has(onSpec.guide, 'mark', '2. 给模型的说明里有它');
hasNot(offSpec.guide, 'mark', '2. 关掉后说明里也没有');
has(onSpec.guide, 'summary（必填）', '2. 必填写在说明里');
ok(onSpec.json.properties.mark !== undefined && onSpec.json.required.includes('summary'), '2. JSON Schema 从同一份定义来');
try { R.fieldsOf(registry, ['counter'], { mark: S.str(5) }); threw = ''; } catch (e) { threw = e.message; }
has(threw, '同时归', '2. 两处认领同一个字段名直接抛');

// ---- 3. 开局、交账是纯函数 ----
const t0 = '2026-11-11T20:00:00+08:00';
const opts = (now, extra = {}) => ({ now, registry, enabled: allOn.enabled, persona, ...extra });
const s0 = freeze(newLedger(persona, t0, registry));
eq(Object.keys(s0.modules).sort(), ['counter', 'follower', 'hosty'], '3. 开局时每个模块都有切片（关着的也有）');
eq(s0.revision, 0, '3. 新局 revision 0');
const r1 = commit(s0, { summary: '他进门，问她忙不忙。', mark: '一', open: '等他坐下' }, opts('2026-11-11T20:05:00+08:00', { said: true }));
ok(r1.ok, '3. 交账成功（' + JSON.stringify(r1.problems ?? '') + '）');
eq(s0.revision, 0, '3. 入参原样没动（被冻住也没抛）');
eq(r1.state.revision, 1, '3. revision 加一');
eq(r1.state.modules.counter.count, 1, '3. 模块 apply 生效');
eq(r1.state.modules.follower.seen, 1, '3. follower 通过 ask 读到了 counter 刚记的数');
eq(r1.state.you.last_said_at, '2026-11-11T20:05:00+08:00', '3. 你说了话：记下时刻');
ok(r1.notes.includes('记了一笔'), '3. 模块的话写进回执');

// ---- 4. 宽松与驳回 ----
const long = commit(r1.state, { summary: '长'.repeat(200), weird: 1 }, opts('2026-11-11T20:06:00+08:00'));
ok(long.ok, '4. 超长和不认识的字段不驳回');
eq(long.state.log.at(-1).summary.length, 120, '4. summary 截到 120 字');
ok(long.notes.some((n) => n.includes('截短')) && long.notes.some((n) => n.includes('weird')), '4. 回执说清改了什么、丢了什么');
eq(long.state.log.at(-1).open, '等他坐下', '4. 没写悬念就沿用上一个');
const bad = commit(r1.state, { summary: '她回应了。', her: { response: 'maybe' } }, opts('2026-11-11T20:06:00+08:00'));
ok(!bad.ok && bad.problems[0].path === '$.her.response', '4. 取值不认识就驳回，点名是哪个字段');
ok(!commit(r1.state, {}, opts('2026-11-11T20:06:00+08:00')).ok, '4. 没有 summary 驳回');
const veto = commit(r1.state, { summary: 'x', mark: '坏' }, opts('2026-11-11T20:06:00+08:00'));
ok(!veto.ok && veto.problems[0].path === '$.mark', '4. 模块自己的校验也能驳回');

// ---- 5. 事实 ----
const f1 = commit(r1.state, { summary: '他说起伞。', learned: [{ key: 'Rain Umbrella', text: '他把伞留在门边' }, { key: 'her.letter', text: '她藏着一封信', who: 'inner' }] }, opts('2026-11-11T20:10:00+08:00'));
ok(f1.ok, '5. 记事实');
ok(f1.state.facts['rain.umbrella']?.who === 'shared', '5. key 规整成小写点分；默认双方都知道');
const unknownReveal = commit(f1.state, { summary: 'x', reveal: ['nope'] }, opts('2026-11-11T20:11:00+08:00'));
ok(!unknownReveal.ok && unknownReveal.problems[0].hint.includes('her.letter'), '5. 说出一条不存在的事实：驳回，并列出她知道的');
const revealed = commit(f1.state, { summary: '她把信的事说了。', reveal: ['her.letter'] }, opts('2026-11-11T20:12:00+08:00'));
eq(revealed.state.facts['her.letter'].who, 'shared', '5. 说出来之后变成双方都知道');
ok(!commit(f1.state, { summary: 'x', learned: [{ key: 'a.b', text: '改设定', retcon: true }] }, opts('2026-11-11T20:12:00+08:00')).ok, '5. 改设定没有 consent：驳回');
const aloneFact = commit(f1.state, { summary: '她一个人想事。', learned: [{ key: 'x.y', text: '你知道的事' }] }, opts('2026-11-11T23:00:00+08:00', { alone: true }));
ok(!aloneFact.ok, '5. 你不在场：不能记「你也知道」的事');

// ---- 6. 约定：到期是读出来的 ----
const p1 = commit(f1.state, { summary: '约了周末。', promise: [{ title: '周六去看海', due: '2026-11-14T10:00:00+08:00' }, { title: '交夜班报告', in_minutes: 60, kind: 'task' }] }, opts('2026-11-11T20:20:00+08:00'));
ok(p1.ok, '6. 新建约定');
eq(p1.state.events.e1.due, '2026-11-14T10:00:00+08:00', '6. 到期写真实时刻');
eq(p1.state.events.e2.due, '2026-11-11T21:20:00+08:00', '6. in_minutes 换成真实时刻');
const sat = view(p1.state, { now: '2026-11-14T12:00:00+08:00', registry, enabled: allOn.enabled, persona });
eq(sat.fields.events.find((e) => e.id === 'e1').status, 'overdue', '6. 过了周六 10 点：读出来就是过期，账本里什么都没写');
eq(p1.state.events.e1.state, 'pending', '6. 账本里它还是挂着');
has(sat.lines.join('\n'), '周六去看海（e1）', '6. 快照里提一句');
has(sat.lines.join('\n'), '过了时间还没兑现：交夜班报告（e2）', '6. 到期早的排前面');
const cancel = commit(p1.state, { summary: '下雨不去了。', promise: [{ cancel: 'e1', reason: '下雨' }] }, opts('2026-11-12T09:00:00+08:00'));
eq(cancel.state.modules.counter.cancelled, ['e1'], '6. 取消约定发出信号，开着的模块收到了');
const offCancel = commit(p1.state, { summary: '下雨不去了。', promise: [{ cancel: 'e1' }] }, opts('2026-11-12T09:00:00+08:00', { enabled: counterOff.enabled }));
eq(offCancel.state.modules.counter.cancelled, [], '6. 模块关着：信号没人听，它的切片原样不动');
ok(!commit(p1.state, { summary: 'x', promise: [{ done: 'e9' }] }, opts('2026-11-12T09:00:00+08:00')).ok, '6. 兑现一条不存在的：驳回');
ok(!commit(p1.state, { summary: 'x', promise: [{ title: '明天见' }] }, opts('2026-11-12T03:00:00+08:00', { alone: true })).ok, '6. 你不在场：不能新立你们之间的约定');
ok(commit(p1.state, { summary: 'x', promise: [{ title: '给花浇水', in_minutes: 30, kind: 'task' }] }, opts('2026-11-12T03:00:00+08:00', { alone: true })).ok, '6. 她自己的事可以');
const later = commit(cancel.state, { summary: '一个月后。' }, opts('2026-12-20T09:00:00+08:00'));
ok(later.state.events.e1 === undefined, '6. 取消了 30 天以上的，交账时清掉');

// ---- 7. 她的状况、作息、亲密门禁 ----
const sleep = commit(f1.state, { summary: '她睡了。', her: { state: { add: [{ kind: 'asleep', text: '睡着了', minutes: 120 }] } } }, opts('2026-11-11T23:00:00+08:00'));
has(view(sleep.state, { now: '2026-11-11T23:30:00+08:00', registry, enabled: [], persona }).lines.join('\n'), '她现在：睡着了', '7. 两小时内：还睡着');
hasNot(view(sleep.state, { now: '2026-11-12T01:30:00+08:00', registry, enabled: [], persona }).lines.join('\n'), '睡着了', '7. 过了两小时：读出来就醒了');
has(view(f1.state, { now: '2026-11-12T10:00:00+08:00', registry, enabled: [], persona }).lines.join('\n'), '在诊所上班', '7. 作息按钟点');
has(view(f1.state, { now: '2026-11-12T02:00:00+08:00', registry, enabled: [], persona }).lines.join('\n'), '睡觉', '7. 跨午夜的作息段');
const at = '2026-11-11T21:00:00+08:00';
ok(!commit(f1.state, { summary: 'x', tags: ['intimate'], her: { response: 'genuine' } }, opts(at)).ok, '7. 亲密场景没有 consent：驳回');
ok(!commit(f1.state, { summary: 'x', tags: ['intimate'], consent: true, her: { response: 'refuse' } }, opts(at)).ok, '7. 她拒绝了：驳回');
ok(commit(f1.state, { summary: 'x', tags: ['intimate'], consent: true, her: { response: 'genuine' } }, opts(at)).ok, '7. 你同意、她配合：放行');
ok(commit(f1.state, { summary: 'x', tags: ['intimate'], consent: true, act: { significant: true } }, opts(at, { enabled: [] })).ok === false, '7. 情绪关着时 act 不是字段，也就不能当「她主动」');
ok(!commit(sleep.state, { summary: 'x', tags: ['intimate'], consent: true, her: { response: 'genuine' } }, opts('2026-11-11T23:30:00+08:00')).ok, '7. 她睡着：驳回');
ok(!commit(f1.state, { summary: 'x', tags: ['intimate'], consent: true }, opts(at, { alone: true })).ok, '7. 你不在场：驳回');
ok(!commit(f1.state, { summary: 'x', her: { response: 'genuine' } }, opts(at, { alone: true })).ok, '7. 你不在场：没有要她回应的话');
const bounded = { ...f1.state, safety: { paused: false, boundaries: [{ text: '不要暴力', tags: ['violence'] }] } };
ok(!commit(bounded, { summary: 'x', tags: ['violence'] }, opts(at)).ok, '7. 碰到你登记的边界：驳回');
ok(!commit({ ...f1.state, safety: { paused: true, boundaries: [] } }, { summary: 'x', tags: ['romance_light'] }, opts(at)).ok, '7. 暂停时亲密内容：驳回');

// ---- 8. 一段相处、流水 ----
const near = commit(r1.state, { summary: '接着聊。', her: { response: 'partial' } }, opts('2026-11-11T20:30:00+08:00'));
eq(near.state.scene.responses, ['partial'], '8. 同一段：回应接着记');
const apart = commit(near.state, { summary: '第二天。', her: { response: 'genuine' } }, opts('2026-11-12T09:00:00+08:00'));
eq(apart.state.scene, { since: '2026-11-12T09:00:00+08:00', responses: ['genuine'] }, '8. 隔了一小时以上：新的一段，从这一刻起');
ok(apart.notes.some((n) => n.includes('新的一段')), '8. 回执里说一句');
let s = r1.state;
for (let i = 0; i < 45; i += 1) s = commit(s, { summary: '第 ' + i + ' 次' }, opts(T.addMinutes('2026-11-11T21:00:00+08:00', i))).state;
eq(s.log.length, 40, '8. 流水只留最近 40 次');
eq(s.log.at(-1).summary, '第 44 次', '8. 最新的在最后');
eq(s.you.last_said_at, '2026-11-11T20:05:00+08:00', '8. 这几次你没说话：你上次说话的时刻不变');

// ---- 9. 关掉再打开：切片原样留着，打开那一下现算就对 ----
let off = r1.state;
for (const t of ['2026-11-11T21:00:00+08:00', '2026-11-12T09:00:00+08:00']) {
  off = commit(off, { summary: '关着的时候', mark: '一' }, opts(t, { enabled: counterOff.enabled })).state;
}
eq(off.modules.counter, r1.state.modules.counter, '9. 关着期间：它的切片一点没动，多写的字段也被丢掉');
const backOn = view(off, { now: '2026-11-13T20:05:00+08:00', registry, enabled: allOn.enabled, persona });
has(backOn.lines.join('\n'), '上一笔 2 天前', '9. 再打开：从记下的时刻现算，关着的两天算进去了');
eq(backOn.fields.count, 1, '9. 它的字段回到 soul_state 里');
const offView = view(off, { now: '2026-11-13T20:05:00+08:00', registry, enabled: counterOff.enabled, persona });
hasNot(offView.lines.join('\n'), '记数', '9. 关着时快照里没有它');
ok(offView.fields.count === undefined, '9. 关着时 soul_state 里也没有它');

// ---- 10. 模块把一句话记成她心里的事实 ----
const inner = {
  id: 'inner', label: '心事',
  fields: { why: S.str(60) },
  init: () => ({ keys: [] }),
  apply: (slice, input, ctx) => (input.why ? { keys: [...slice.keys, ctx.noteInner(input.why)] } : slice),
};
const reg2 = R.createRegistry([inner]);
const st = newLedger(persona, t0, reg2);
const noted = commit(st, { summary: '她想了想。', why: '他今天来得很晚' }, { now: t0, registry: reg2, enabled: ['inner'], persona });
const key = noted.state.modules.inner.keys[0];
eq(noted.state.facts[key]?.who, 'inner', '10. 一句话自动记成「她心里的」事实');
eq(commit(noted.state, { summary: '又想了想。', why: '他今天来得很晚' }, { now: t0, registry: reg2, enabled: ['inner'], persona }).state.modules.inner.keys[1], key, '10. 同一句话总是同一个 key');

done('v2-core');
