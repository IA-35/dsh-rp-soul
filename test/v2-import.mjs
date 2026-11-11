/* 新引擎第八阶段：导入旧引擎（Python）的存档。造一份带齐各种东西的旧库，导进来逐项核对。 */
import { makeV1Db } from './_v1-fixture.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';
import { createEngine } from '../lib/engine/index.js';
import { readV1, clockOf } from '../lib/engine/import-v1.js';

const dir = mkdtempSync(join(tmpdir(), 'import-v1-test-'));
const oldFile = join(dir, 'engine.db');

makeV1Db(oldFile);

// ---- 1. 读旧库、时钟换算 ----
const old = readV1(oldFile);
eq(old.sessionId, 's_old', '1. 读最近改过的那一局');
eq(old.facts.length, 4, '1. 删掉的事实不读');
const C = clockOf(old.state);
eq(C.fromClock({ day: 15, minute: 600 }), '2026-11-13T10:00:00+08:00', '1. 第 15 天 10:00 = 11 月 13 日 10:00（截到整分钟）');
eq(C.dayKey(12), '2026-11-10', '1. 第 12 天 = 11 月 10 日');

// ---- 2. 导进一个已经有局的新库 ----
let nowMs = Date.parse('2026-11-11T14:25:00+08:00');
const engine = createEngine({ dataDir: dir, clock: () => new Date(nowMs) });
const persona = { id: 'shorekeeper', name: '守岸人' };
engine.start(persona);
engine.changeCommon(() => [{ id: 'c1', key: ['灯塔'], weight: 0.9, content: '新库里的灯塔', origin: 'manual', at: null, pending: false }]);
const out = engine.importV1(oldFile, { persona });
ok(out.ok, '2. 导入成功');
for (const row of out.check) ok(row.ok, '2. 核对「' + row.item + '」' + (row.ok ? '' : '：旧 ' + JSON.stringify(row.old) + ' / 新 ' + JSON.stringify(row.now)));
eq(out.check.length, 8, '2. 八项都核对了');
eq(engine.slots().map((s) => s.name), ['导入前'], '2. 导入前的那一局存成了存档');
ok(out.notes.some((n) => n.includes('镇上的传言')), '2. 新引擎没有的那一类约定：说一声没带');

// ---- 3. 每样东西落到哪 ----
const view = engine.context({ persona });
eq(view.fields.events.map((e) => [e.id, e.kind, e.due]), [['e2', 'task', '2026-11-12T20:00:00+08:00'], ['e1', 'promise', '2026-11-13T10:00:00+08:00']], '3. 约定和她自己的事，到期换成真实时刻；兑现过的不带');
eq(view.fields.plan, { note: '去调灯', until: '2026-11-11T15:00:00+08:00', until_label: '今天 15:00' }, '3. 安排');
const panel = engine.panel('mood', { persona });
eq(panel.thoughts.filter((t) => !t.situational).map((t) => [t.label, t.until]), [['他把伞留给我', '2026-11-12T14:15:00+08:00']], '3. 记下的心事带着到期时刻；早就过期的不带');
eq(panel.conditions, ['在调灯'], '3. 她现在的状况：还没到期的');
eq(view.fields.bond, { trust: 2, tension: 1, stage: 'intimate' }, '3. 态度');
eq(view.fields.her_knows.map((f) => [f.key, f.who]), [['her.secret.letter', 'her']], '3. 只有她知道的');
eq(view.fields.known_facts.map((f) => f.key).sort(), ['rain.umbrella', 'you.cat'], '3. 你们都知道的、只有你知道的；谁都不知道的不带');
has(view.lines.join('\n'), '她的安排：去调灯', '3. 快照里有安排');
const memory = engine.panel('memory', { persona });
eq(memory.counts, { abm: 1, scm: 1, clpa: 1 }, '3. 记忆三层都带过来');
const m3 = memory.entries.find((e) => e.id === 'm3');
eq(m3.at, '2026-11-11T14:15:00+08:00', '3. 记忆的时刻换成真实时刻');
ok(!('turn' in m3), '3. 回合号丢掉');
ok(memory.entries.find((e) => e.id === 'm2').pinned, '3. 钉住的还钉着');
eq(engine.memoryDue({ manual: true }).diary, null, '3. 写过日记的那天（11 月 10 日）不会再写一遍');
eq(engine.log(10).map((e) => e.summary), ['调灯', '说好看海', '第一次'], '3. 流水按原来的顺序，撤掉的那次不带');
eq(engine.common().rows.map((r) => r.content), ['新库里的灯塔', 'DS 指 deepseek'], '3. 常识库：新库已有的保留，关键词重复的旧条目不带');
eq(out.diaryDays, { 12: '2026-11-10' }, '3. 日记按日历日搬');
const st = engine.context({ persona });
eq(st.fields.away_recent.map((a) => a.text), ['主人不在时她把灯罩擦了一遍'], '3. 离屏片段');

// ---- 4. 导进来以后照常交账、能读回导入前 ----
ok(engine.commit({ summary: '他回来了。', promise: [{ done: 'e1' }] }, { persona, said: true }).ok, '4. 导入后照常交账（兑现导进来的约定）');
ok(engine.load('导入前').ok, '4. 读档能回到导入前那一局');
eq(engine.context({ persona }).fields.events, [], '4. 回来了');
engine.close();

done('v2-import');
