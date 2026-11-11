/* 新引擎第六阶段：常识模块（关键词 → 一条常识，全局一张表；模型提的要确认）。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';
import * as CM from '../lib/engine/modules/common/index.js';
import { createEngine } from '../lib/engine/index.js';
import { checkPersona, activityRow } from '../lib/engine-v2-settings.js';

// ---- 1. 纯函数：命中、排序、渲染 ----
const ds = { id: 'c1', key: ['deepseek', 'ds'], weight: 0.8, content: 'deepseek 是深度求索的大模型。', pending: false };
const rice = { id: 'c2', key: ['米饭'], weight: 0.5, content: '米饭要先泡半小时。', pending: false };
const wait = { id: 'c3', key: ['猫'], weight: 0.9, content: '还没确认的。', pending: true };
ok(CM.hits(ds, 'DS 给我写段代码'), '1. 英文关键词：大小写不敏感');
ok(!CM.hits(ds, 'dsh 插件又挂了'), '1. 英文关键词按词边界：dsh 不算 ds');
ok(CM.hits(ds, '用ds写'), '1. 紧挨着汉字也算一个词');
ok(CM.hits(rice, '今晚吃米饭'), '1. 中文按子串');
eq(CM.select([rice, ds, wait], 'DS 帮我煮米饭，再喂猫').map((r) => r.id), ['c1', 'c2'], '1. 权重高的在前；没确认的不注入');
eq(CM.select([rice, ds], 'DS 和米饭', 1).length, 1, '1. 最多注入 limit 条');
eq(CM.render([ds], 'DS 写代码'), '### 常识\n- ds： deepseek 是深度求索的大模型。', '1. 冒号前是真正触发的那个关键词');
eq(CM.render([], 'x'), '', '1. 没命中：空串，不占上下文');
eq(CM.normalizeKeys([' DS ', 'ds', '', 'DeepSeek']), ['ds', 'deepseek'], '1. 关键词小写、去空白、去重');
eq(CM.limitOf(9), 4, '1. 条数夹到 2..4');
eq(CM.limitOf('x'), 4, '1. 坏值用默认');

// ---- 2. 合并模型提的：一律挂起；你点过头的模型改不掉 ----
const m1 = CM.merge([ds], [{ key: ['米饭'], content: '米饭要泡。' }, { key: ['ds', 'deepseek'], content: '模型想改掉它' }], 'T');
eq(m1.rows.length, 2, '2. 新的加进来，和已确认的关键词完全相同的不动');
ok(m1.rows[1].pending && m1.rows[1].origin === 'turn', '2. 模型提的挂起');
eq(m1.rows[0].content, ds.content, '2. 你确认过的那条没被改');
const m2 = CM.merge(m1.rows, [{ key: ['米饭'], content: '米饭要泡一小时。' }], 'T2');
eq(m2.rows.find((r) => r.id === 'c2').content, '米饭要泡一小时。', '2. 还挂着的：用新说法覆盖');
eq(CM.make([], { key: [], content: 'x' }), null, '2. 没有关键词：不收');
eq(CM.edit([ds], 'c9', { content: 'x' }), null, '2. 改不存在的：null');
eq(CM.edit([ds], 'c1', { weight: 3 })[0].weight, 1, '2. 权重夹到 0..1');

// ---- 3. 引擎：交账提常识 → 挂起 → 确认 → 命中才注入 ----
const persona = { id: 'lin_wan', name: '林晚' };
let nowMs = Date.parse('2026-11-11T20:00:00+08:00');
const engine = createEngine({ dataDir: mkdtempSync(join(tmpdir(), 'engine-common-')), clock: () => new Date(nowMs) });
engine.start(persona);
const c1 = engine.commit({ summary: '他说 DS 就是 deepseek。', common: [{ key: ['ds', 'deepseek'], content: 'DS 指的是 deepseek' }] }, { persona, said: true });
ok(c1.ok, '3. 带 common 交账');
ok(c1.notes.some((n) => n.includes('等主人在设置页确认')), '3. 回执里说要等确认');
eq(engine.common().pending, 1, '3. 常识库里多了一条挂起的');
eq(engine.recall('DS 是什么'), '', '3. 没确认：不注入');
engine.changeCommon((rows) => rows.map((r) => ({ ...r, pending: false })));
has(engine.recall('DS 是什么'), 'DS 指的是 deepseek', '3. 确认之后命中就注入');
eq(engine.recall('今天下雨'), '', '3. 没命中：不注入');
engine.commit({ summary: '她自己醒着。', common: [{ key: ['雨'], content: '下雨要带伞' }] }, { persona, alone: true });
eq(engine.common().count, 1, '3. 她自己醒着的那一次：不收常识');
ok(!engine.commit({ summary: 'x', common: [{ content: '缺关键词' }] }, { persona }).ok, '3. common 缺 key：驳回（字段校验）');
eq(engine.setCommonLimit(2).limit, 2, '3. 改注入条数');
engine.setToggles({ common: false });
eq(engine.recall('DS 是什么'), '', '3. 关掉常识模块：不注入');
ok(!('common' in engine.spec().fields), '3. 交账表里也没有 common');
engine.setToggles({});
ok(engine.undo().ok && engine.common().count === 1, '3. 撤销交账不动常识库（它不属于这一局）');

// ---- 4. 自主行动记录：流水里带着这次交了什么 ----
nowMs += 5 * 60000;
engine.commit({ summary: '她把灯推过去。', her: { response: 'genuine', did: '把灯往他那边推了推' }, act: { significant: false, kind: 'approach' }, feel: [{ label: '他还醒着', delta: 2, because: '他半夜还在' }], bond: { trust: 1, reason: '他陪着' } }, { persona, said: true });
const row = activityRow(engine.log(1)[0], { her: '林晚', you: '你' });
eq(row.responses[0].label, '真心答应', '4. 回应换成中文');
eq(row.actions[0].text, '把灯往他那边推了推', '4. 行动');
eq(row.thoughts[0].label, '他还醒着', '4. 留下的情绪');
eq(row.relations[0].trust, 1, '4. 关系变化');
ok(Number.isInteger(row.turn) && row.turn > 0, '4. 第几次取自交账 id');
ok(!('input' in engine.context({ persona }).fields), '4. 账本里那 40 条不带 input');
engine.close();

// ---- 5. 人设校验 ----
eq(checkPersona({ mood_base: 55, start_stage: 'familiar', routine: [{ from: '07:30', to: 720, doing: '在花店' }] }), [], '5. 合法的人设：没有问题');
const bad = checkPersona({ mood_base: 150, start_stage: 'lover', mood_thresholds: { open: 30, closed: 50, break: 10 }, routine: [{ from: '25:00', to: 60, doing: '' }] });
eq(bad.map((p) => p.path), ['mood_base', 'start_stage', 'mood_thresholds', 'routine[0]', 'routine[0].doing'], '5. 每一处问题都指出来');

done('v2-common');
