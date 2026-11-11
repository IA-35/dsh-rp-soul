/* 新引擎第五阶段：唤醒模块（她的安排、离屏片段、下一次该醒的时间）。时间全是传进去的 now。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';
import * as R from '../lib/engine/core/registry.js';
import { newLedger, commit } from '../lib/engine/core/commit.js';
import { view } from '../lib/engine/core/context.js';
import * as T from '../lib/engine/core/time.js';
import mood from '../lib/engine/modules/mood/index.js';
import wake from '../lib/engine/modules/wake/index.js';
import * as W from '../lib/engine/modules/wake/schedule.js';
import { createEngine } from '../lib/engine/index.js';

const registry = R.createRegistry([mood, wake]);
const ON = ['mood', 'wake'];
const persona = {
  id: 'lin_wan', name: '林晚', mood_base: 55,
  routine: [{ from: '07:30', to: '12:00', doing: '在花店' }, { from: '12:00', to: '22:30', doing: '看书' }, { from: '22:30', to: '07:30', doing: '睡觉' }],
};
const t0 = '2026-11-11T20:00:00+08:00';
const at = (minutes) => T.addMinutes(t0, minutes);
const run = (state, input, now, extra = {}) => commit(state, input, { now, registry, enabled: extra.enabled ?? ON, persona, said: true, ...extra });
const look = (state, now, extra = {}) => view(state, { now, registry, enabled: extra.enabled ?? ON, persona, alone: extra.alone ?? false });
const reasons = (problems) => problems.map((p) => p.path + ' ' + p.reason).join('；');

const s0 = run(newLedger(persona, t0, registry), { summary: '他进门了。' }, t0).state;

// ---- 1. 她的安排 ----
const p1 = run(s0, { summary: '她说去洗澡。', plan: { note: '去洗澡', until: '21:00' } }, at(5));
ok(p1.ok, '1. 记下安排（HH:MM）');
eq(p1.state.modules.wake.plan.until, '2026-11-11T21:00:00+08:00', '1. HH:MM 换成今天的真实时刻');
has(look(p1.state, at(10)).lines.join('\n'), '她的安排：去洗澡（到 今天 21:00）', '1. 快照里有这条安排');
eq(look(p1.state, at(10)).fields.plan.note, '去洗澡', '1. soul_state 里也有');
const p2 = run(s0, { summary: '她说再看会儿书。', plan: { note: '看书', until: '07:30' } }, at(5));
eq(p2.state.modules.wake.plan.until, '2026-11-12T07:30:00+08:00', '1. 今天这个钟点过了：明天的');
const p3 = run(s0, { summary: 'x', plan: { note: '打个盹', in_minutes: 20 } }, at(5));
eq(p3.state.modules.wake.plan.until, at(25), '1. in_minutes 也行');
const p4 = run(s0, { summary: 'x', plan: { note: '发呆' } }, at(5));
ok(p4.ok && p4.state.modules.wake.plan.until === at(65), '1. 没写做到几点：不驳回，先按一小时记');
ok(p4.notes.some((n) => n.includes('60 分钟')), '1. 并且说一声');
const p5 = run(s0, { summary: 'x', plan: { note: '发呆', until: '明早' } }, at(5));
ok(!p5.ok && p5.problems[0].path === '$.plan.until', '1. 认不出的时刻：驳回，指明哪个字段');
const p6 = run(s0, { summary: 'x', plan: { note: '发呆', until: '2026-11-11T19:00:00+08:00' } }, at(5));
ok(!p6.ok, '1. 做到的时刻已经过了：驳回');
const p7 = run(p1.state, { summary: '她改主意了。', plan: { note: '先吹头发', in_minutes: 10 } }, at(8));
eq(p7.state.modules.wake.plan.note, '先吹头发', '1. 新的安排替换旧的');
ok(look(p1.state, at(61)).fields.plan === null, '1. 过了点就不算数了');
eq(run(p1.state, { summary: '她洗完了。' }, at(62)).state.modules.wake.plan, null, '1. 过了点的安排在下一次交账时清掉');

// ---- 2. 离屏片段 ----
const late = run(s0, { summary: '他回来了。' }, at(90));
ok(!late.ok && late.problems.some((p) => p.path === '$.away'), '2. 隔了一个半小时、没写 away：驳回 ' + reasons(late.problems ?? []));
has(look(s0, at(90)).lines.join('\n'), '这次交账要写 away', '2. 快照里提前说了');
ok(look(s0, at(90)).fields.away_due, '2. soul_state 里 away_due');
hasNot(look(s0, at(30)).lines.join('\n'), 'away', '2. 隔半小时：不提');
eq(look(s0, at(30)).lines.join('\n'), look(s0, at(50)).lines.join('\n'), '2. 一小时以内，快照不跟着分钟变');
const back = run(s0, { summary: '他回来了。', away: '她在窗边把那本书看完了' }, at(90));
ok(back.ok, '2. 写了 away：过');
eq(back.state.modules.wake.away.at(-1).text, '她在窗边把那本书看完了', '2. 离屏片段记下了');
eq(back.state.modules.wake.away.at(-1).since, t0, '2. 记着是从哪一刻起的');
hasNot(look(back.state, at(95)).lines.join('\n'), '要写 away', '2. 补上之后快照里不再提');
ok(run(s0, { summary: '她自己醒着。' }, at(90), { alone: true, said: false }).ok, '2. 她自己醒来的那一次：不要求 away');
ok(run(s0, { summary: '他回来了。' }, at(90), { enabled: ['mood'] }).ok, '2. 关掉唤醒：不再要求 away');
ok(run(newLedger(persona, t0, registry), { summary: '第一次。' }, at(600)).ok, '2. 一次都没交过：不要求');

// ---- 3. 下一次该醒：各种来由 ----
const opts = { now: at(10), persona, quiet: '00:00-08:00', missYouHours: 6 };
const plain = W.candidates(s0, null, opts);
eq(plain.map((r) => r.reason), ['routine', 'miss_you'], '3. 没有安排和约定：作息换段、想你了');
eq(plain[0].at, '2026-11-11T22:30:00+08:00', '3. 作息的下一段从 22:30 开始');
eq(plain[0].why, '到 22:30 了，按平常该「睡觉」了', '3. 作息的理由');
eq(plain[1].at, '2026-11-12T08:00:00+08:00', '3. 想你了：20:00 + 6 小时落在安静时段，推到 08:00');
ok(plain[1].quiet_shifted, '3. 标了被安静时段推过');
eq(plain[1].at_real, plain[1].at, '3. 宿主认的 at_real 也在');

const withPlan = W.candidates(s0, p1.state.modules.wake.plan, opts);
eq(withPlan[0].reason, 'plan', '3. 她的安排最早');
eq(withPlan[0].why, '去洗澡', '3. 安排的理由就是她说的那件事（宿主再包一层「我说好做到的时间」）');
const night = W.candidates(s0, { note: '起来看流星', until: '2026-11-12T03:00:00+08:00' }, opts);
eq(night.find((r) => r.reason === 'plan').at, '2026-11-12T03:00:00+08:00', '3. 她自己的安排不受安静时段管');

const promised = run(s0, { summary: '说好去看海。', promise: [{ title: '去看海', due: '2026-11-11T21:00' }, { title: '取快递', in_minutes: 120, kind: 'task' }] }, at(1)).state;
const ev = W.candidates(promised, null, opts);
eq(ev.find((r) => r.reason === 'promise')?.at, '2026-11-11T20:30:00+08:00', '3. 约定：提前半小时');
eq(ev.find((r) => r.reason === 'event')?.at, at(121), '3. 她自己的事：到期那一刻');
eq(W.candidates(promised, null, { ...opts, now: at(45) }).find((r) => r.reason === 'promise')?.at, '2026-11-11T21:00:00+08:00', '3. 来不及提前半小时：到期那一刻');
ok(!W.candidates(promised, null, { ...opts, now: at(70) }).some((r) => r.reason === 'promise'), '3. 过了时间的约定不再叫她');

// ---- 4. 想你了：一次比一次隔得久；安静时段、开关 ----
const missAt = (o) => W.candidates(s0, null, { ...opts, routine: false, quiet: '', ...o })[0].at;
eq(missAt({}), at(360), '4. 没有安静时段：整 6 小时');
eq(missAt({ now: at(400) }), at(401), '4. 已经过了：一分钟后');
eq(missAt({ now: at(400), streak: 1, lastWakeAt: at(370) }), T.addMinutes(at(370), 720), '4. 醒过一次你没回：从那次起隔 12 小时');
eq(missAt({ now: at(1200), streak: 3, lastWakeAt: at(1100) }), T.addMinutes(at(1100), 1440), '4. 再往后隔 24 小时');
ok(!W.candidates(s0, null, { ...opts, missYouHours: 0, routine: false }).length, '4. 想你了设成 0：关掉；作息也关：没有候选');
eq(W.candidates(s0, null, { now: at(10), persona, missYouHours: undefined, quiet: undefined }).length, 2, '4. 没给的设置用默认值');
const paused = { ...s0, safety: { ...s0.safety, paused: true } };
eq(W.candidates(paused, p1.state.modules.wake.plan, opts), [], '4. 你按了暂停：不叫她');
eq(W.parseQuiet('23:00-07:00'), [1380, 420], '4. 安静时段可以跨午夜');
ok(W.inQuiet('2026-11-11T23:30:00+08:00', [1380, 420]) && !W.inQuiet('2026-11-11T07:00:00+08:00', [1380, 420]), '4. 结束那一分钟不算安静');
eq(W.parseQuiet('坏的'), null, '4. 写坏的安静时段当没有');

// ---- 5. 引擎 API：nextWake ----
let nowMs = Date.parse(t0);
const engine = createEngine({ dataDir: mkdtempSync(join(tmpdir(), 'engine-wake-')), clock: () => new Date(nowMs) });
eq(engine.nextWake({ persona }), { next: null, all: [] }, '5. 还没开局：不叫');
engine.start(persona);
ok(engine.commit({ summary: '她说去洗澡。', plan: { note: '去洗澡', in_minutes: 40 } }, { persona, said: true }).ok, '5. 交账带 plan');
const nw = engine.nextWake({ persona, quiet: '00:00-08:00', missYouHours: 6, routine: true });
eq(nw.next.reason, 'plan', '5. 最早的是她的安排');
eq(nw.next.at_real, '2026-11-11T20:40:00+08:00', '5. 时刻对');
engine.setToggles({ wake: false });
eq(engine.nextWake({ persona }).next, null, '5. 关掉唤醒：不叫');
ok(!('plan' in engine.spec().fields) && !('away' in engine.spec().fields), '5. 关掉后交账表里没有 plan / away');
engine.setToggles({});
ok('away' in engine.spec().fields, '5. 再打开就回来了');
engine.close();

// ---- 6. 这一局是唤醒模块加进来之前开的：照样读、照样交 ----
const old = newLedger(persona, t0, R.createRegistry([mood]));
const oldView = look(old, at(5));
ok(oldView.fields.plan === null && oldView.fields.away_due === false, '6. 账本里还没有唤醒的切片：按刚开局现算');
ok(run(old, { summary: 'x', plan: { note: '看书', in_minutes: 30 } }, at(5)).ok, '6. 交账时补上切片');

done('v2-wake');
