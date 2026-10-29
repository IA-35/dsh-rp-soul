/* 唤醒线运行时的回归测试：纯函数 + 挂载后的定时/额度/送达行为。
 * 全程打桩（不碰真宿主、不碰真引擎），靠注入的假 sessionController 观察副作用。 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const wakeMod = await import(new URL('../lib/wake.js', import.meta.url).href);
const {
  WAKE_DEFAULTS, WAKE_SOURCE, localDay, readWakeConfig, wakeConfigPatch,
  renderWakeText, dueAt, mountWake, isWakeTurn, markWakeTurn, clearAllWakeTurns,
  nextDayStart,
} = wakeMod;

// ---- 0. 额度用完也要在第二天自己回来 ----
// 唤醒表只由「你说话 / 回合结束 / 设置页保存 / 手动」这些事件重算，没有纯时间
// 驱动。额度用尽时若把 at 清成 null，arm() 见到 null 就不再挂表，于是没人说话
// 的一整天里，她一次也不会醒过来。
const rollover = nextDayStart(new Date(2026, 9, 29, 16, 30, 0));
const rolloverDate = new Date(rollover);
eq(rolloverDate.getDate(), 30, '0. 额度回血时刻落在第二天');
eq(rolloverDate.getHours() * 60 + rolloverDate.getMinutes(), 5, '0. 零点过五分就回血');
ok(rollover > new Date(2026, 9, 29, 23, 59, 0).getTime(), '0. 回血在当天 23:59 之后');

// ---- 1. 配置读取与夹紧 ----
const d = readWakeConfig(null);
eq(d.enabled, false, '1. 默认不开');
eq(d.sessionId, '', '1. 默认没指定会话');
eq(d.dailyLimit, 12, '1. 默认每天 12 次');
eq(d.dailyTokens, 300000, '1. 默认每天 30 万 token');
eq(d.quiet, '00:00-08:00', '1. 默认安静时段');
eq(d.missYou, 6, '1. 默认 6 小时算想你');
eq(d.routine, true, '1. 默认作息换段算唤醒源');

const weird = readWakeConfig({ wakeDailyLimit: 9999, wakeDailyTokens: -5, wakeMissYou: 500, wakeQuiet: 'luanqi' });
eq(weird.dailyLimit, 200, '1. 次数夹到上限 200');
eq(weird.dailyTokens, 0, '1. token 夹到下界 0');
eq(weird.missYou, 96, '1. 想你阈值夹到上限 96');
eq(weird.quiet, WAKE_DEFAULTS.wakeQuiet, '1. 坏掉的安静时段回落到默认');
eq(readWakeConfig({ wakeQuiet: '' }).quiet, '', '1. 空字符串表示没有安静时段');
eq(readWakeConfig({ wakeRoutine: false }).routine, false, '1. 可以关掉作息换段');

// ---- 2. 设置页回写的字段过滤 ----
const patch = wakeConfigPatch({ wakeEnabled: 'yes', wakeSessionId: '  s_ab12  ', wakeDailyLimit: 3, wakeRoutine: false, other: 1 });
eq(patch.wakeEnabled, undefined, '2. 非布尔的开关不认');
eq(patch.wakeSessionId, 's_ab12', '2. 会话 id 去空格');
eq(patch.wakeDailyLimit, 3, '2. 次数原样');
eq(patch.wakeRoutine, false, '2. 开关原样');
eq(Object.keys(patch).includes('other'), false, '2. 未知字段不写进配置');
eq(wakeConfigPatch({ wakeQuiet: 'bad' }).wakeQuiet, WAKE_DEFAULTS.wakeQuiet, '2. 坏安静时段回落到默认');

// ---- 3. 日记事与 ISO 解析 ----
eq(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05', '3. 本地日期串');
eq(dueAt('2026-10-23T23:00:00+08:00'), Date.parse('2026-10-23T23:00:00+08:00'), '3. ISO 带偏移能解析');
eq(dueAt(''), null, '3. 空串当没有');
eq(dueAt('not-a-time'), null, '3. 坏值当没有');
eq(dueAt(null), null, '3. null 当没有');

// ---- 4. 唤醒措辞 ----
const root = mkdtempSync(join(tmpdir(), 'soulwake-'));
mkdirSync(join(root, 'rp-soul'), { recursive: true });
const plain = renderWakeText({ root, when: '23:00', why: null, player: 'xiaolin' });
has(plain, '【我的时间】23:00', '4. 默认模板带时刻标记');
hasNot(plain, '{why}', '4. 占位符都被替换');
hasNot(plain, '{when}', '4. 时刻占位符被替换');

const withPlan = renderWakeText({ root, when: '23:00', why: 'qu xizao', player: 'xiaolin' });
has(withPlan, 'qu xizao', '4. 有计划时说明理由');

const withDiary = renderWakeText({ root, when: '23:30', reason: 'diary', why: '该把今天写进日记了', player: 'xiaolin' });
has(withDiary, '该把今天写进日记了', '4. 日记那次要说清为什么醒');
hasNot(withDiary, '这是我说好做到的时间', '4. 日记不是我说好的时间，不能套那句');

writeFileSync(join(root, 'rp-soul', 'wake.md'), 'hi {when}{why}\n', 'utf8');
const custom = renderWakeText({ root, when: '07:30', why: 'shuijiao', player: 'xiaolin' });
has(custom, 'hi 07:30', '4. 模板文件整份覆盖');
has(custom, 'shuijiao', '4. 模板里的 why 也被展开');
writeFileSync(join(root, 'rp-soul', 'wake.md'), '   \n', 'utf8');
has(renderWakeText({ root, when: '09:00' }), '【我的时间】', '4. 空模板文件按没有处理');

// ---- 5. 宿主没给接口时不启 ----
const bare = { on() { throw new Error('should not register'); } };
const notMounted = mountWake(bare, { root, store: () => ({}), bridge: null, log: () => {} });
notMounted.start();
eq(notMounted.snapshot().mounted, false, '5. 没有 inject 时静默不启');
eq(notMounted.snapshot().state.at, null, '5. 没挂载就没有下次时刻');
eq(await notMounted.listSessions(), [], '5. 没挂载时会话列表为空');

// ---- 6. 真挂载：定时、额度、送达 ----
const handlers = {};
const disposers = [];
const steered = [];
const flushed = [];
let resolveReturn = {
  agent: { id: 'agent-1', session: { id: 's_ab12' }, status: 'idle', steer: (m) => steered.push(m) },
};
let askReply = { next: { at_real: new Date(Date.now() + 3600_000).toISOString(), reason: 'plan', why: 'qu xizao' } };
let askCalls = 0;
let askError = null;
let askedPayload = null;

const storeObj = {
  wakeEnabled: true,
  wakeSessionId: 's_ab12',
  wakeDailyLimit: 2,
  wakeDailyTokens: 0,
  wakeMissYou: 6,
  wakeQuiet: '',
};
const bridge = {
  scopeOf: () => 'global',
  mappingOf: (key) => (key === 'shared' ? { session_id: 's_ab12', revision: 3, turn: 1 } : null),
  call: async (_command, payload) => {
    askedPayload = payload;
    askCalls += 1;
    if (askError !== null) throw new Error(askError);
    return askReply;
  },
};
const ctx = {
  on(name, fn) { handlers[name] = fn; return () => { delete handlers[name]; }; },
  inject(_names, cb) {
    cb({
      sessions: { flush: async (s) => { flushed.push(s?.id ?? null); return true; } },
      sessionController: {
        resolveAgent: async () => resolveReturn,
        list: async () => ({
          items: [
            { sessionId: 's_old', updatedAt: 100, running: false, projections: { values: { title: 'old' } } },
            { sessionId: 's_sub', updatedAt: 300, origin: 'subagent' },
            { sessionId: 's_new', updatedAt: 200, running: true, projections: { values: { title: 'new' } } },
            { sessionId: 's_blank', updatedAt: 50, projections: { values: {} } },
          ],
        }),
      },
    });
  },
  effect(fn) { disposers.push(fn(() => {})); },
  sessions: { flush: async (s) => { flushed.push(s?.id ?? null); return true; } },
};

const wake = mountWake(ctx, { root, store: () => storeObj, bridge, log: () => {} });
wake.start();
await new Promise((r) => setTimeout(r, 30));

eq(askCalls, 1, '6. 启动即问一次 next-wake');
eq(wake.snapshot().state.reason, 'plan', '6. 记下唤醒理由');
eq(wake.snapshot().state.why, 'qu xizao', '6. 记下计划内容');
ok(wake.snapshot().state.at !== null, '6. 记下次唤醒时刻');
eq(String(wake.snapshot().state.when).length, 5, '6. 记下钟点 HH:MM');
eq(wake.snapshot().mounted, true, '6. 已挂载');
eq(disposers.length, 1, '6. 注册了一个 effect 用于卸载');

const list = await wake.listSessions();
eq(list.map((x) => x.sessionId), ['s_new', 's_old', 's_blank'], '6. 会话列表滤掉 subagent 并倒序');
eq(list[0].title, 'new', '6. 列表带会话标题');
eq(list[2].title, '（未命名）', '6. 没有标题时给占位');
eq(list[0].running, true, '6. 列表带运行状态');

const first = await wake.fireNow();
eq(first.ok, true, '6. 手动叫醒成功');
eq(steered.length, 1, '6. 送达了一条消息');
has(steered[0].content[0].text, '【我的时间】', '6. 消息带【我的时间】标记');
eq(steered[0].source.kind, WAKE_SOURCE, '6. 消息来源标记为唤醒线');
eq(steered[0].content[0].text.includes('qu xizao'), false, '6. 手动叫醒不带计划理由');
eq(isWakeTurn('s_ab12'), true, '6. 送达后该会话进入唤醒回合');
eq(flushed.length, 1, '6. 送达后 flush 了一次会话');
eq(wake.snapshot().state.count, 1, '6. 计入今天的次数');
eq(wake.snapshot().state.at, null, '6. 送达后清空待唤醒时刻');
await wake.reschedule();
eq(askedPayload.last_wake_at, wake.snapshot().state.lastDeliveredAt, '6. 重算时带上真实送达时刻');
eq(askedPayload.streak, 1, '6. 一次送达后按第二段间隔等待');
const afterDelivery = { ...askedPayload };
await wake.reschedule();
eq(askedPayload.last_wake_at, afterDelivery.last_wake_at, '6. 重复重算不会重新开始等待');

const second = await wake.fireNow();
eq(second.ok, true, '6. 第二次仍然可以');
const third = await wake.fireNow();
eq(third.ok, false, '6. 超过每日次数被拒');
has(third.error, '今天的次数用完了', '6. 拒绝理由说明次数用完');
eq(steered.length, 2, '6. 被拒的那次没有送达');
eq(wake.snapshot().state.count, 2, '6. 被拒的这次不计数');

storeObj.wakeDailyLimit = 0;
handlers['session/event']({ id: 'another-conversation' }, { type: 'user/message', data: { source: { kind: 'user' } } });
eq(wake.snapshot().state.streak, 2, '6. 其它会话说话不算回复她');
handlers['session/event']({ id: 's_ab12' }, { type: 'user/message', data: { source: { kind: 'user' } } });
eq(wake.snapshot().state.streak, 0, '6. 指定会话里回复她就重置连续未回复次数');
const talking = await wake.fireNow();
eq(talking.ok, false, '6. 你刚说过话时叫不醒');
has(talking.error, '你刚说过话', '6. 说明是在等你这句话结束');
eq(steered.length, 2, '6. 推后时没有送达');
eq(isWakeTurn('s_ab12'), false, '6. 你说话即清掉唤醒回合标记');

// 会话在跑
resolveReturn = { agent: { id: 'agent-1', session: { id: 's_x' }, status: 'running', steer: (m) => steered.push(m) } };
const wake2 = mountWake(ctx, { root: mkdtempSync(join(tmpdir(), 'soulwake2-')), store: () => ({ wakeEnabled: true, wakeSessionId: 's_x', wakeDailyLimit: 0 }), bridge: { ...bridge, mappingOf: () => ({ session_id: 's_x', revision: 1, turn: 1 }) }, log: () => {} });
wake2.start();
await new Promise((r) => setTimeout(r, 30));
const running = await wake2.fireNow();
eq(running.ok, false, '6. 会话在跑时叫不醒');
has(running.error, '会话正在跑', '6. 说明会话在跑');
eq(steered.length, 2, '6. 会话在跑时没有送达');

// 会话不在了
resolveReturn = { error: { code: 'session/not-found', message: 'gone' } };
const wake3 = mountWake(ctx, { root: mkdtempSync(join(tmpdir(), 'soulwake3-')), store: () => ({ wakeEnabled: true, wakeSessionId: 's_y', wakeDailyLimit: 0 }), bridge: { ...bridge, mappingOf: () => ({ session_id: 's_y', revision: 1, turn: 1 }) }, log: () => {} });
wake3.start();
await new Promise((r) => setTimeout(r, 30));
const gone = await wake3.fireNow();
eq(gone.ok, false, '6. 会话不在时叫不醒');
has(gone.error, '会话不在了', '6. 说明会话不在了');
eq(wake3.snapshot().state.at, null, '6. 会话不在就清掉待唤醒时刻');

// 还没开局
const wake4 = mountWake(ctx, { root: mkdtempSync(join(tmpdir(), 'soulwake4-')), store: () => ({ wakeEnabled: true, wakeSessionId: 's_none' }), bridge: { ...bridge, mappingOf: () => null }, log: () => {} });
wake4.start();
await new Promise((r) => setTimeout(r, 30));
eq(wake4.snapshot().state.at, null, '6. 没开局时算不出唤醒时刻');

// 引擎报错
askError = 'engine down';
const wake5 = mountWake(ctx, { root: mkdtempSync(join(tmpdir(), 'soulwake5-')), store: () => ({ wakeEnabled: true, wakeSessionId: 's_ab12', wakeDailyTokens: 0 }), bridge, log: () => {} });
wake5.start();
await new Promise((r) => setTimeout(r, 30));
eq(wake5.snapshot().state.at, null, '6. 引擎报错时没有下次时刻');
has(wake5.snapshot().state.lastError, 'engine down', '6. 引擎错误被记下来');
askError = null;

// 关掉后不再问引擎
storeObj.wakeEnabled = false;
const before = askCalls;
await wake.reschedule();
eq(askCalls, before, '6. 关掉之后不再问引擎');

// 重启后的长时间未回复：保留送达锚点，协议计数不超过引擎上限。
const longRoot = mkdtempSync(join(tmpdir(), 'soulwake-long-'));
mkdirSync(join(longRoot, 'rp-soul'));
const deliveredAt = '2026-10-25T05:00:00Z';
writeFileSync(join(longRoot, 'rp-soul', 'wake.json'), JSON.stringify({ streak: 50, lastDeliveredAt: deliveredAt }));
const longWake = mountWake(ctx, { root: longRoot, store: () => ({ wakeEnabled: true, wakeSessionId: 's_long' }), bridge, log: () => {} });
longWake.start();
await longWake.reschedule();
eq(askedPayload.streak, 20, '6. 长期未回复仍在协议允许的计数范围内');
eq(askedPayload.last_wake_at, deliveredAt, '6. 重启后仍从已送达时刻等待');
handlers['session/event']({ id: 's_long' }, { type: 'user/message', data: { source: { kind: WAKE_SOURCE } } });
eq(longWake.snapshot().state.streak, 50, '6. 唤醒消息本身不算玩家回复');
handlers['session/event']({ id: 's_long' }, { type: 'user/message', data: { source: { kind: 'user' } } });
eq(JSON.parse(readFileSync(join(longRoot, 'rp-soul', 'wake.json'), 'utf8')).streak, 0, '6. 玩家回复后的重置也写入磁盘');

// 卸载
storeObj.wakeEnabled = true;
markWakeTurn('s_ab12');
for (const off of disposers) off();
eq(isWakeTurn('s_ab12'), false, '6. 卸载时清掉唤醒回合标记');
clearAllWakeTurns();

// ---- 7. 状态落盘 ----
ok(readFileSync(join(root, 'rp-soul', 'wake.json'), 'utf8').includes('"count"'), '7. 状态写进了 wake.json');

done('wake');
