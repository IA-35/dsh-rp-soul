/* 新引擎第三阶段：存储（node:sqlite）与对外 API。用临时目录和假时钟。 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, done } from './_check.mjs';
import { createEngine, DB_FILE } from '../lib/engine/index.js';
import { openStore } from '../lib/engine/store.js';

const dataDir = mkdtempSync(join(tmpdir(), 'engine-v2-'));
let nowMs = Date.parse('2026-11-11T20:00:00+08:00');
const clock = () => new Date(nowMs);
const tick = (minutes) => { nowMs += minutes * 60000; };
const persona = { id: 'lin_wan', name: '林晚', mood_base: 55 };
let engine = createEngine({ dataDir, clock });

// ---- 1. 开局 ----
let threw = '';
try { engine.context({ persona }); } catch (e) { threw = e.code; }
eq(threw, 'NO_LEDGER', '1. 没开局时读局面：明说还没开局');
eq(engine.start(persona).created, true, '1. 开一局');
eq(engine.start(persona).created, false, '1. 已经有一局：不重开');
ok(existsSync(join(dataDir, DB_FILE)), '1. 库文件建在数据目录里');
const c0 = engine.context({ persona });
eq(c0.revision, 0, '1. 新局 revision 0');
has(c0.lines.join('\n'), '心情：平稳', '1. 局面里有情绪模块的几行');

// ---- 2. 交账、stale ----
tick(5);
const r1 = engine.commit({ summary: '他进门了。', learned: [{ key: 'rain.umbrella', text: '他把伞留在门边' }] }, { persona, said: true, revision: 0 });
ok(r1.ok, '2. 交账成功');
eq(r1.revision, 1, '2. revision 加一');
const stale = engine.commit({ summary: '旧的那份。' }, { persona, revision: 0 });
ok(!stale.ok && stale.stale && stale.revision === 1, '2. 拿着旧 revision 交：挡住，并告诉现在是几');
const rejected = engine.commit({ summary: 'x', her: { response: 'maybe' } }, { persona, revision: 1 });
ok(!rejected.ok && !rejected.stale && rejected.problems.length > 0, '2. 校验不过：带问题清单');
eq(engine.context({ persona }).revision, 1, '2. 被驳回的那次什么都没写');
tick(5);
ok(engine.commit({ summary: '他说起周末。', promise: [{ title: '周六去看海', in_minutes: 3000 }] }, { persona, said: true }).ok, '2. 不带 revision 也能交（设置页这类场合）');

// ---- 3. 撤销 ----
eq(engine.log().map((e) => e.summary), ['他说起周末。', '他进门了。'], '3. 流水新的在前');
const u1 = engine.undo();
ok(u1.ok, '3. 撤销上一次');
eq(u1.revision, 3, '3. 撤销后 revision 继续往上加（不往回退）');
const afterUndo = engine.context({ persona });
ok(!afterUndo.fields.events.some((e) => e.title === '周六去看海'), '3. 那次交账记下的约定没了');
ok(afterUndo.fields.known_facts.some((f) => f.key === 'rain.umbrella'), '3. 更早的那次还在');
eq(engine.log().map((e) => e.summary), ['他进门了。'], '3. 流水里那一条也撤掉了');
ok(!engine.commit({ summary: 'x' }, { persona, revision: 2 }).ok, '3. 撤销之后，拿着撤销前的 revision 交：挡住');
ok(engine.undo().ok, '3. 再撤销一次');
ok(!engine.undo().ok, '3. 撤到开局就没有可撤销的了');

// ---- 4. 重开进程：数据都还在 ----
tick(5);
engine.commit({ summary: '他坐下了。', bond: { trust: 1, reason: '他坐下陪她' } }, { persona, said: true });
const before = engine.context({ persona });
engine.close();
engine = createEngine({ dataDir, clock });
eq(engine.context({ persona }).fields.bond, before.fields.bond, '4. 关掉重开：账本原样读回来');
eq(engine.log().length, 1, '4. 流水也在');

// ---- 5. 一次交账在一个事务里：中途失败什么都不留 ----
const store = openStore(join(dataDir, DB_FILE));
const row = store.ledger();
const count = store.undoable();
let failed = false;
try {
  // summary 是 NOT NULL：快照和账本都写了，记流水那一步失败 → 整个回滚
  store.commit({ before: row.state, after: { ...row.state, revision: row.revision + 1 }, id: 'broken', entry: { at: 'x', summary: null }, now: 'x' });
} catch {
  failed = true;
}
ok(failed, '5. 记流水那一步失败');
eq(store.ledger().revision, row.revision, '5. 账本没变');
eq(store.undoable(), count, '5. 快照也没多一份');
store.close();

// ---- 6. 快照只留 30 份 ----
for (let i = 0; i < 35; i += 1) {
  tick(1);
  engine.commit({ summary: '第 ' + i + ' 次' }, { persona });
}
let undos = 0;
while (engine.undo().ok) undos += 1;
eq(undos, 30, '6. 最多能撤销 30 次');

// ---- 7. 模块开关 ----
eq(engine.modules(), [{ id: 'mood', label: '情绪', on: true, why: null }, { id: 'wake', label: '唤醒', on: true, why: null }, { id: 'common', label: '常识', on: true, why: null }], '7. 默认都开着');
engine.setToggles({ mood: false });
eq(engine.modules()[0].on, false, '7. 关掉');
ok(!('feel' in engine.spec().fields), '7. 关掉后交账表里没有它的字段');
ok(!engine.context({ persona }).lines.join('\n').includes('心情'), '7. 局面里也没有它');
engine.setToggles({});
ok('feel' in engine.spec().fields, '7. 再打开就回来了');
has(engine.spec().guide, 'feel', '7. 说明里也有');

// ---- 8. 清空 ----
engine.wipe();
threw = '';
try { engine.context({ persona }); } catch (e) { threw = e.code; }
eq(threw, 'NO_LEDGER', '8. 清空后就是没开局');
eq(engine.log().length, 0, '8. 流水也没了');
eq(engine.start(persona).created, true, '8. 清空后能重新开局');

// ---- 9. 快照不跟着分钟变（宿主文本一变就追加一条，分钟级会让快照越攒越多） ----
nowMs = Date.parse('2026-11-12T20:00:00+08:00');
const at20 = engine.context({ persona }).lines.join('\n');
tick(7);
eq(engine.context({ persona }).lines.join('\n'), at20, '9. 过了 7 分钟、什么都没发生：快照一字不变');
tick(60 * 3);
ok(engine.context({ persona }).lines.join('\n') !== at20, '9. 跨进深夜：快照才变');
// ---- 10. 存档、读档、导出、暂停 ----
engine.commit({ summary: '存档前。', learned: [{ key: 'slot.before', text: '存档前知道的' }] }, { persona, said: true });
ok(engine.save('周末').ok, '10. 存一份');
ok(!engine.save('周末').ok, '10. 同名不覆盖');
ok(engine.save('周末', { overwrite: true }).ok, '10. 带 overwrite 才覆盖');
tick(5);
engine.commit({ summary: '存档后。', learned: [{ key: 'slot.after', text: '存档后才知道的' }] }, { persona, said: true });
eq(engine.slots().map((x) => x.name), ['周末'], '10. 存档列表');
const revBefore = engine.context({ persona }).revision;
const loaded = engine.load('周末');
ok(loaded.ok && loaded.revision === revBefore + 1, '10. 读档：revision 接着往上加');
const keys = () => engine.context({ persona }).fields.known_facts.map((f) => f.key);
ok(keys().includes('slot.before') && !keys().includes('slot.after'), '10. 读回存档那一刻');
ok(engine.undo().ok && keys().includes('slot.after'), '10. 读档也能撤销');
ok(!engine.load('没有').ok, '10. 读不存在的：明说');
const dump = engine.exportAll();
ok(dump.ledger.revision === engine.context({ persona }).revision && Array.isArray(dump.common), '10. 导出：整份账本 + 常识库');
ok(engine.setPaused(true).changed, '10. 暂停');
ok(!engine.commit({ summary: 'x', tags: ['intimate'], consent: true, her: { response: 'genuine' } }, { persona, said: true }).ok, '10. 暂停时亲密内容驳回');
ok(!engine.setPaused(true).changed, '10. 再暂停一次：没变化');
ok(engine.setPaused(false).changed, '10. 恢复');
ok(engine.dropSlot('周末').ok && engine.slots().length === 0, '10. 删存档');
engine.close();

done('v2-store');
