/* 运行时快照只留一条：用宿主真实的 Session（dsh-session）走一遍，
 * 宿主「文本变了才追加、记着的那条被替换了就照样追加」的规矩按 dsh-agent-loop 的 RuntimeContextProjection 模拟。 */
import { Session } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { eq, ok, done } from './_check.mjs';
import { compactSnapshots, bringsSnapshot, staleNodes, COMPACT_PER_STEP, LEGACY_PLACEHOLDER_KIND } from '../lib/snapshot-compact.js';

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

done('snapshot-compact');
