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
 * 清掉作废的快照。返回清掉了几条；某一条清不动就跳过（只为省 token，绝不能连累这一轮）。
 * @param session  宿主的会话
 * @param position { turn, step }：pre-step 的位置，developer 消息要带
 * @param all      新快照要来了：全清
 */
export function compactSnapshots(session, position, all) {
  if (session === null || typeof session !== "object") return 0;
  if (typeof session.append !== "function" || typeof session.eventAt !== "function") return 0;
  const turn = Number.isInteger(position?.turn) ? position.turn : 0;
  const step = Number.isInteger(position?.step) ? position.step : 0;
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
