/**
 * 运行时快照只留一条：把作废的快照从模型看到的对话里拿掉。
 *
 * 宿主（dsh-agent-loop 的 RuntimeContextProjection）的规矩是「文本一变就往尾部追加一条
 * user 消息，从不回收旧的」：为了前缀缓存，它只追加不替换。我们的快照几乎每一步都在变
 * （时间到分钟、想法的「多久以前」、跟着你这句话变的「想起来的」），一轮四五条，长会话就是上千条。
 *
 * surface 没有「删除」操作，但宿主把**内容为空的 developer 消息**投影成「没有消息」
 * （dsh-session 的 deriveEventMessage）。所以把旧快照原地 replace 成一条空的 developer 消息，
 * 它就从发给模型的对话里消失了——节点还在日志里，模型看不到，也不占 token。
 *
 * 什么时候清哪些：
 * - 这一步宿主要追加新快照（pre-step 的 decision.messages 里带着 runtime-context 消息）：
 *   旧快照**全部**清掉，包括最新那条。宿主在 step() 里会重新比一次，发现它记着的那条
 *   被替换了（retained 变成 null），照样把新的追加上。于是任何时候模型只看到一条。
 * - 这一步快照没变：最新那条留着（动它就要白白重写一遍尾部、废掉缓存），只清更早的残留。
 * 以前的版本把旧快照换成一个「·」的 user 消息，那些占位也在这里一并清掉。
 */

import { randomUUID } from "node:crypto";

/** 宿主产出的运行时快照，靠 message.source.kind 认。 */
export const SNAPSHOT_SOURCE_KIND = "runtime-context";
/** 以前的版本留下的「·」占位（user 消息）。 */
export const LEGACY_PLACEHOLDER_KIND = "rp-soul:compacted-snapshot";
/** 一步最多清几条：清一条就要往日志追一条事件。老会话里攒的几百条分几步清完。 */
export const COMPACT_PER_STEP = 200;
/** 找「开着的 step」时最多往回看多少条事件：正常一步里没这么多事件，超了就当不确定。 */
export const OPEN_SCAN_LIMIT = 2000;

const isSnapshot = (event) => event?.type === "user/message" && event.data?.source?.kind === SNAPSHOT_SOURCE_KIND;
const isLegacyPlaceholder = (event) => event?.type === "user/message" && event.data?.source?.kind === LEGACY_PLACEHOLDER_KIND;

/** 这一步宿主是不是要追加一条新快照。 */
export function bringsSnapshot(decision) {
  return Array.isArray(decision?.messages) && decision.messages.some((m) => m?.source?.kind === SNAPSHOT_SOURCE_KIND);
}

/**
 * 找出这一步该清掉的节点（seq 列表，新的在前）。
 * @param session 宿主的会话（要有 surface.nodes 和 eventAt）
 * @param all     true：快照全清（新快照要来了）；false：留下最新的一条快照
 */
export function staleNodes(session, all) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const out = [];
  let keptNewest = all;
  for (let i = nodes.length - 1; i >= 0 && out.length < COMPACT_PER_STEP; i -= 1) {
    let event;
    try {
      event = session.eventAt(nodes[i]);
    } catch {
      continue;
    }
    if (isLegacyPlaceholder(event)) {
      out.push(nodes[i]);
      continue;
    }
    if (!isSnapshot(event)) continue;
    if (!keptNewest) {
      keptNewest = true;
      continue;
    }
    out.push(nodes[i]);
  }
  return out;
}

/**
 * 挂上「等 step/start 落地之后才清理」的两个钩子。
 *
 * 时序是硬要求，不是讲究：宿主的会话日志校验器（dsh-session-format-v3-to-v4 的
 * requireStep）只认「已打开的 turn + 已打开的 step」里的 developer/message，而 step
 * 是在 `session.append("step/start")` 那一刻才打开的（dsh-agent-loop 的 turn()）。
 * 以前我们在 agent/pre-step 里直接写，于是这一步要清的几百条全都落在 step 还没开的时候，
 * 日志一读回来就判 `developer/message does not match an open turn and step`——
 * 整个会话「回话损坏」。
 *
 * 所以拆成两半：pre-step 只记下「这一步要清多少」，等 session/event 真收到 step/start
 * 再动手。而这时的回调还在 append 的发布过程中（session 会拒绝回写），必须挪进微任务。
 * dsh-mnemon 的快照回收也是这个形态，可以对照着看。
 *
 * @param ctx 插件上下文（只要 on 方法；测试时可以给个假的）
 */
export function installSnapshotCompaction(ctx) {
  /** 每个会话各记各的：主 agent 与子 agent 可能同时在跑。 */
  const pending = new Map();

  ctx.on("agent/pre-step", async (payload, next) => {
    // 先 next()：宿主的默认处理器在那里判这一步有没有新快照，要按它的结果决定清多少。
    const decision = await next();
    try {
      const session = payload?.agent?.session ?? null;
      if (session === null || typeof session !== "object") return decision;
      if (decision?.kind === "reject" || payload?.signal?.aborted === true) {
        pending.delete(session);
        return decision;
      }
      pending.set(session, {
        turn: Number.isInteger(payload?.turn) ? payload.turn : -1,
        step: Number.isInteger(payload?.step) ? payload.step : -1,
        all: bringsSnapshot(decision),
        signal: payload?.signal ?? null,
      });
    } catch {
      // 记不下就不清，这一步照原样走完
      pending.delete(payload?.agent?.session ?? null);
    }
    return decision;
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    const record = pending.get(session);
    if (record === void 0) return;
    if (event?.type === "turn/end") {
      // 这一步没走到 step/start 就收回合了：丢掉记录，别留给下一回合
      pending.delete(session);
      return;
    }
    if (event?.type !== "step/start") return;
    if (event?.data?.turn !== record.turn || event?.data?.step !== record.step) return;
    pending.delete(session);
    queueMicrotask(() => {
      if (record.signal?.aborted === true) return;
      try {
        compactSnapshots(session, record, record.all);
      } catch {
        // 清理只为省 token，失败绝不能连累这一轮
      }
    });
  });
}

/**
 * 从日志尾部往回找「此刻开着的是哪个 step」。
 *
 * 往回扫，第一个碰到的生命周期事件就说明局面：step/start 表示开着（它的 turn 一定还开着，
 * 因为 turn/start 排在它前面、中间不会夹 turn/end）；碰到 step/end、turn/start、turn/end
 * 都表示没有开着的 step。扫到上限还没碰到就返回 null（当作不确定，不硬猜）。
 *
 * 这是给 compactSnapshots 兜底的：日志校验器只认「已打开 turn + 已打开 step」里的
 * developer/message，写早了整份会话就读不回来，而这个损失是不可逆的。与其相信调用方
 * 传进来的位置，不如自己问一句日志。
 *
 * @param session 宿主的会话
 * @returns {{turn: number, step: number} | null}
 */
export function openPosition(session) {
  if (typeof session?.snapshotEvents !== "function") return null;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  const floor = Math.max(0, events.length - OPEN_SCAN_LIMIT);
  for (let i = events.length - 1; i >= floor; i -= 1) {
    const event = events[i];
    switch (event?.type) {
      case "step/start": {
        const turn = event.data?.turn;
        const step = event.data?.step;
        return Number.isInteger(turn) && Number.isInteger(step) ? { turn, step } : null;
      }
      case "step/end":
      case "turn/start":
      case "turn/end":
        return null;
      default:
        break;
    }
  }
  return null;
}

/**
 * 清掉作废的快照。返回清掉了几条；某一条清不动就跳过（只为省 token，绝不能连累这一轮）。
 * @param session  宿主的会话
 * @param position { turn, step }：must be an open step（见 installSnapshotCompaction）；
 *                 能被日志核对时以日志为准，核对不出 open step 就一条都不写
 * @param all      新快照要来了：全清
 */
export function compactSnapshots(session, position, all) {
  if (session === null || typeof session !== "object") return 0;
  if (typeof session.append !== "function" || typeof session.eventAt !== "function") return 0;
  // 写下去之前先问日志：现在真有开着的 step 吗？没有就一条都别写——
  // 那不是「少清一点」，那是把整份会话写成读不回来的样子（不可逆）。
  const open = openPosition(session);
  if (open === null) return 0;
  const turn = open.turn;
  const step = open.step;
  let done = 0;
  for (const seq of staleNodes(session, all)) {
    try {
      session.append("developer/message", {
        turn,
        step,
        message: { id: randomUUID(), role: "developer", source: { kind: LEGACY_PLACEHOLDER_KIND }, content: [] },
      }, {
        surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      done += 1;
    } catch {
      // 跳过这一条
    }
  }
  return done;
}
