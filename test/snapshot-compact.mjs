/* 运行时快照只留一条：用宿主真实的 Session（dsh-session）走一遍，
 * 宿主「文本变了才追加、记着的那条被替换了就照样追加」的规矩按 dsh-agent-loop 的 RuntimeContextProjection 模拟。 */
import { Session } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { eq, ok, done } from './_check.mjs';
import { compactSnapshots, bringsSnapshot, staleNodes, installSnapshotCompaction, COMPACT_PER_STEP, LEGACY_PLACEHOLDER_KIND } from '../lib/snapshot-compact.js';

const user = (text, kind = 'user') => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } });

/** 宿主那一侧：记着最后一条快照；被替换掉就忘掉。 */
function host(session) {
  let retained;
  const track = () => {
    const nodes = new Set(session.surface.nodes);
    retained = null;
    for (const ev of [...session.snapshotEvents()].reverse()) {
      if (ev.type === 'user/message' && ev.data.source.kind === 'runtime-context') {
        retained = nodes.has(ev.seq) ? { seq: ev.seq, text: ev.data.content[0].text } : null;
        break;
      }
    }
  };
  return {
    /** pre-step 的默认处理器：文本和记着的不一样才带一条新快照。 */
    decide(text) {
      track();
      return { kind: 'enter', messages: retained?.text === text ? [] : [user(text, 'runtime-context')] };
    },
    /** step()：再比一次（我们可能刚把它记着的那条清掉了），不一样就追加。 */
    step(text) {
      track();
      if (retained?.text !== text) session.append('user/message', user(text, 'runtime-context'), { surfaceOp: 'append' });
    },
  };
}

const snapshotsSeen = (session) => session.deriveMessages().filter((m) => m.source?.kind === 'runtime-context').map((m) => m.content[0].text);

/** 走一步：宿主判 → 我们清 → 宿主追加 → 这一步里双方各说一句。 */
function runStep(session, h, text, turn, step) {
  const decision = h.decide(text);
  const cleared = compactSnapshots(session, { turn, step }, bringsSnapshot(decision));
  h.step(text);
  session.append('user/message', user('第 ' + turn + '.' + step + ' 步的对话'), { surfaceOp: 'append' });
  return cleared;
}

// ---- 1. 快照每步都变：任何时候模型只看到一条，就是最新的那条 ----
const s = Session.create('s1');
const h = host(s);
runStep(s, h, '时间：14:22', 1, 1);
eq(snapshotsSeen(s), ['时间：14:22'], '1. 第一步：一条');
eq(runStep(s, h, '时间：14:23', 1, 2), 1, '1. 新快照要来：旧的那条清掉');
eq(snapshotsSeen(s), ['时间：14:23'], '1. 第二步：还是一条，是新的');
for (let i = 4; i < 30; i += 1) runStep(s, h, '时间：14:' + String(20 + i), 2, i);
eq(snapshotsSeen(s).length, 1, '1. 走了几十步：模型看到的快照还是只有一条');
eq(snapshotsSeen(s)[0], '时间：14:49', '1. 是最新的');
ok(s.deriveMessages().some((m) => m.content[0]?.text === '第 1.1 步的对话'), '1. 对话本身一条没丢');
ok(!s.deriveMessages().some((m) => m.role === 'developer'), '1. 清掉的那些不变成别的消息发给模型');

// ---- 2. 快照没变：最新那条不动（不白白重写尾部） ----
const before = s.seq;
eq(runStep(s, h, '时间：14:49', 3, 1), 0, '2. 没变：一条都不清');
eq(s.seq, before + 1, '2. 日志里只多了这一步的那句对话');
eq(snapshotsSeen(s), ['时间：14:49'], '2. 还是那一条');

// ---- 3. 老会话：以前留下的「·」占位一并清掉，一步最多 200 条 ----
const old = Session.create('s2');
for (let i = 0; i < 250; i += 1) {
  old.append('user/message', user('快照 ' + i, 'runtime-context'), { surfaceOp: 'append' });
  old.append('user/message', user('·', LEGACY_PLACEHOLDER_KIND), { surfaceOp: 'append' });
}
old.append('user/message', user('最新快照', 'runtime-context'), { surfaceOp: 'append' });
eq(staleNodes(old, false).length, COMPACT_PER_STEP, '3. 一步最多清 ' + COMPACT_PER_STEP + ' 条');
compactSnapshots(old, { turn: 9, step: 1 }, false);
compactSnapshots(old, { turn: 9, step: 2 }, false);
compactSnapshots(old, { turn: 9, step: 3 }, false);
const left = old.deriveMessages();
eq(left.length, 1, '3. 清了三步：只剩最新那条快照');
eq(left[0].content[0].text, '最新快照', '3. 留下的是最新的');

// ---- 4. 宿主的 decision 怎么认 ----
ok(bringsSnapshot({ messages: [user('x', 'runtime-context')] }), '4. 带着 runtime-context 消息：新快照要来');
ok(!bringsSnapshot({ messages: [user('你好')] }), '4. 只有你的话：没有新快照');
ok(!bringsSnapshot(undefined), '4. 没有 decision：当没有');
eq(compactSnapshots(null, {}, true), 0, '4. 没有会话：什么都不做');

// ---- 5. 时机：pre-step 只记不写，等 step/start 落地之后（且挪进微任务）才真正清 ----
//
// 这一段是全套里最要紧的：写早了日志校验器就判
// `developer/message does not match an open turn and step`，整个会话读不回来。
const order = [];
const handlers = new Map();
const fakeCtx = { on: (name, fn) => { handlers.set(name, fn); return () => {}; } };
installSnapshotCompaction(fakeCtx);
const preStep = handlers.get('agent/pre-step');
const sessionEvent = handlers.get('session/event');
ok(preStep !== undefined && sessionEvent !== undefined, '5. 两个钩子都挂上了');

const fake = {
  seq: 1,
  writes: [],
  get surface() { return { nodes: [0] }; },
  eventAt: () => ({ type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '旧快照' }] } }),
  append(type, data) {
    order.push(type + '@' + this.seq);
    if (type === 'developer/message') this.writes.push({ turn: data.turn, step: data.step, seq: this.seq });
    this.seq += 1;
  },
};

const payload = { agent: { session: fake }, turn: 7, step: 3, signal: { aborted: false } };
const decision = { kind: 'enter', messages: [user('新快照来了', 'runtime-context')] };

await preStep(payload, async () => decision);
eq(fake.writes.length, 0, '5. pre-step 跑完：一条都没写（这正是以前炸掉的地方）');

// 宿主此刻才 append step/start；回调正在 append 的发布过程中，这里必须只记账
fake.append('step/start', { turn: 7, step: 3 });
sessionEvent(fake, { type: 'step/start', data: { turn: 7, step: 3 } });
eq(fake.writes.length, 0, '5. step/start 回调里不直接写（append 期间会拒绝回写）');

await Promise.resolve();
eq(fake.writes.length, 1, '5. 微任务里清掉一条');
eq(fake.writes[0].turn, 7, '5. 带的是已经打开的 turn');
eq(fake.writes[0].step, 3, '5. 带的是已经打开的 step');
ok(order.indexOf('step/start@1') < order.indexOf('developer/message@2'), '5. 写日志发生在 step/start 之后');
// turn/end 之前没等到 step/start：记录丢掉，不留给下一回合
const stale = { agent: { session: fake }, turn: 8, step: 1, signal: { aborted: false } };
await preStep(stale, async () => decision);
sessionEvent(fake, { type: 'turn/end', data: { turn: 8 } });
sessionEvent(fake, { type: 'step/start', data: { turn: 8, step: 1 } });
await Promise.resolve();
eq(fake.writes.length, 1, '5. 回合收了却没走到 step/start：不清、也不误清下一步');

// 被取消的那一步：不留记录，也不写日志
const aborted = { agent: { session: fake }, turn: 9, step: 1, signal: { aborted: true } };
await preStep(aborted, async () => decision);
sessionEvent(fake, { type: 'step/start', data: { turn: 9, step: 1 } });
await Promise.resolve();
eq(fake.writes.length, 1, '5. 取消的那一步不清');

// ---- 6. 真会话上跑一遍：清理写下去之后，日志里它是排在 step/start 后面的 ----
//
// 校验器（dsh-session-format-v3-to-v4）只认「已打开 step」里的 developer/message，
// 所以这里就按宿主 turn() 的真实顺序摆：turn/start → pre-step 记账 → step/start → 清理 → step/end。
const live = Session.create('s3');
live.append('user/message', user('上一轮留下的快照', 'runtime-context'), { surfaceOp: 'append' });
live.append('turn/start', { turn: 1 });
live.append('step/start', { turn: 1, step: 1 });
const stepStartSeq = live.seq - 1;
const cleared = compactSnapshots(live, { turn: 1, step: 1 }, true);
eq(cleared, 1, '6. 清掉一条旧快照');
live.append('user/message', user('这一轮的话'), { surfaceOp: 'append' });
live.append('step/end', { turn: 1, step: 1 });
live.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

const writes = live.snapshotEvents().filter((e) => e.type === 'developer/message');
eq(writes.length, 1, '6. 日志里确实写了一条 developer/message');
ok(writes[0].seq > stepStartSeq, '6. 它排在 step/start 之后（写早了整份会话就读不回来）');
eq(writes[0].data.turn, 1, '6. turn 对得上');
eq(writes[0].data.step, 1, '6. step 对得上');
ok(!live.deriveMessages().some((m) => m.role === 'developer'), '6. 模型那边看不到它');
eq(snapshotsSeen(live), [], '6. 旧快照已经从模型看到的对话里消失');
ok(live.deriveMessages().some((m) => m.content[0]?.text === '这一轮的话'), '6. 对话本身还在');

// ---- 7. 拿宿主真正读日志用的那个校验器验一遍：新的写法过，旧的写法必挂 ----
//
// 这一段是给未来的人看的：以后谁想「顺手把它挪回 pre-step」，这里会立刻红。
// 校验器是 DSH 的包，不一定在插件的依赖里；取不到就跳过（不当失败）。
let relationships = null;
try {
  const mod = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
  if (typeof mod.assertReleasedV4Relationships === 'function') relationships = mod.assertReleasedV4Relationships;
} catch {
  // 插件自己的 node_modules 里只有 dsh-session；校验器躺在宿主那一层。顺着 dsh-session
  // 的实际安装位置往旁边找同样的包名，绝不写死本机路径。
  try {
    const { createRequire } = await import('node:module');
    const { dirname, resolve: resolvePath } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const require = createRequire(import.meta.url);
    // → <…>/node_modules/@deepseek-ai/dsh-session/lib/index.js
    const sessionEntry = require.resolve('@deepseek-ai/dsh-session');
    const peer = resolvePath(dirname(sessionEntry), '..', '..', 'dsh-session-format-v3-to-v4', 'lib', 'index.js');
    const mod = await import(pathToFileURL(peer).href);
    if (typeof mod.assertReleasedV4Relationships === 'function') relationships = mod.assertReleasedV4Relationships;
  } catch { /* 没装就跳过 */ }
}

if (relationships === null) {
  console.log('SKIP 7. 这台机器上没有 dsh-session-format-v3-to-v4，跳过校验器对照');
} else {
  const known = new Set([
    'turn/start', 'turn/end', 'step/start', 'step/end',
    'user/message', 'developer/message', 'assistant/message', 'assistant/attempt', 'system/message',
    'tool/call', 'tool/result', 'session/end-seed', 'agent/inbox/spliced', 'request/header', 'workspace/changes',
  ]);
  const artifactOf = (s) => ({ events: s.snapshotEvents(), inheritedEventCount: 0, header: { id: s.id, createdAt: Date.now(), origin: 'root' } });
  const dev = () => ({ id: randomUUID(), role: 'developer', content: [], source: { kind: LEGACY_PLACEHOLDER_KIND } });
  const verify = (session) => relationships(artifactOf(session), known);

  // 先垫一条上一轮的快照，这一轮把它 replace 掉——和真实场景一模一样
  const seed = (s) => {
    s.append('turn/start', { turn: 1 });
    s.append('step/start', { turn: 1, step: 1 });
    const snapshotSeq = s.seq;
    s.append('user/message', user('上一轮的快照', 'runtime-context'), { surfaceOp: 'append' });
    s.append('step/end', { turn: 1, step: 1 });
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    s.append('turn/start', { turn: 2 });
    return snapshotSeq;
  };

  // 旧的写法：step/start 之前就写
  const bad = Session.create('bad');
  const badSnap = seed(bad);
  bad.append('developer/message', { turn: 2, step: 1, message: dev() }, {
    surfaceOp: { op: 'replace', startSeq: badSnap, endSeq: badSnap }, sourceEventSeqs: [badSnap],
  });
  bad.append('step/start', { turn: 2, step: 1 });
  bad.append('step/end', { turn: 2, step: 1 });
  bad.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  let oldRejected = false;
  try { verify(bad); } catch (error) { oldRejected = /does not match an open turn and step/.test(String(error?.message)); }
  ok(oldRejected, '7. 旧写法（step/start 之前写）被校验器判为损坏——这正是那次「回话损坏」');

  // 新的写法：step/start 之后
  const good = Session.create('good');
  const goodSnap = seed(good);
  good.append('step/start', { turn: 2, step: 1 });
  good.append('developer/message', { turn: 2, step: 1, message: dev() }, {
    surfaceOp: { op: 'replace', startSeq: goodSnap, endSeq: goodSnap }, sourceEventSeqs: [goodSnap],
  });
  good.append('step/end', { turn: 2, step: 1 });
  good.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  let newOk = true;
  try { verify(good); } catch { newOk = false; }
  ok(newOk, '7. 新写法（step/start 之后写）整份日志过校验器');
}

done('snapshot-compact');

