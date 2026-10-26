import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mountWake, readWakeConfig } from '../lib/wake.js';
import { eq, ok, done } from './_check.mjs';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (fn, wait) => { timers.set(++timerId, { fn, wait }); return timerId; };
globalThis.clearTimeout = (id) => timers.delete(id);
const disposers = [];
let resolveAgent;
let resolveSchedule;
let scheduleDeferred = false;
let steered = 0;
let asks = 0;
const store = { wakeEnabled: true, wakeSessionId: 'conversation' };
const ctx = {
  on() { return () => {}; },
  effect(fn) { disposers.push(fn()); },
  inject(names, cb) {
    if (names.includes('sessionController')) cb({ sessionController: {
      resolveAgent: () => new Promise((resolve) => { resolveAgent = resolve; }),
    } });
  },
};
const future = () => ({ next: { at_real: new Date(Date.now() + 3600000).toISOString(), reason: 'plan' } });
const bridge = {
  scopeOf: () => 'global', mappingOf: () => ({ session_id: 's1' }),
  call: async () => { asks++; return scheduleDeferred ? await new Promise((resolve) => { resolveSchedule = resolve; }) : future(); },
};
const wake = mountWake(ctx, { root: mkdtempSync(join(tmpdir(), 'soulwake-lifecycle-')), store: () => store, bridge });
try {
  eq(readWakeConfig({ wakeEnabled: false }).enabled, false, 'existing wake switch controls lifecycle');
  wake.start();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(timers.size, 1, 'enabled wake schedules one timer');
  store.wakeEnabled = false;
  await wake.reschedule();
  eq(timers.size, 0, 'disabling wake cancels pending timer');
  const before = asks;
  await wake.reschedule();
  eq(asks, before, 'disabled wake does not query engine');
  store.wakeEnabled = true;
  await wake.reschedule();
  eq(timers.size, 1, 'reenabling wake schedules again');

  const firing = wake.fireNow();
  store.wakeEnabled = false;
  await wake.reschedule();
  store.wakeEnabled = true;
  await wake.reschedule();
  resolveAgent({ agent: { status: 'idle', steer: () => { steered++; } } });
  eq((await firing).ok, false, 'in-flight delivery is cancelled even after reenable');
  eq(steered, 0, 'disable during resolveAgent never delivers stale wake');

  scheduleDeferred = true;
  const pending = wake.reschedule();
  store.wakeEnabled = false;
  await wake.reschedule();
  resolveSchedule(future());
  await pending;
  eq(timers.size, 0, 'stale engine scheduling result cannot rearm disabled wake');
  eq(wake.snapshot().state.at, null, 'disabled scheduling clears stale pending timestamp');
  ok([...timers.values()].every((timer) => timer.wait > 0), 'disabled wake cannot start zero-delay timer loops');
  done('wake-lifecycle');
} finally {
  for (const off of disposers) off?.();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
