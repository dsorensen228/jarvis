import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { applyRuntimeAction as act, CATCH_UP_MS, clockNumber, emptyRuntime, MAX_RING_MS, MAX_TIMER_MS, migrateRuntime, normalizeAlarm, parseRuntime, tickRuntime, timerRemaining, timerToCancel, snapshotAlarm } from '../src/timer/timerRuntime.ts';
import { nextFireAfter } from '../src/timer/nextAlarm.ts';
import { ALARMS_KEY, parseAlarms } from '../src/timer/alarmStorage.ts';
import { loadTimerRuntime, saveTimerRuntime, SESSION_TIMER_KEY, TIMER_RUNTIME_KEY } from '../src/timer/timerSession.ts';
import type { Alarm, TimerRuntime } from '../src/timer/types.ts';

const originalTZ = process.env.TZ;
process.env.TZ = 'America/New_York';
after(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });
const morning = new Date(2026, 8, 28, 6, 59, 0).getTime();
const dueAt = morning + 60_000;
const alarm = (id: string, patch: Partial<Alarm> = {}): Alarm => ({ id, label: id, hour: 7, minute: 0, enabled: true, repeat: { kind: 'once' }, snoozeMinutes: 5, ...patch });
const scheduled = (alarms = [alarm('wake')]) => migrateRuntime(alarms, null, morning);
const start = (state: TimerRuntime, id: string, durationMs = 60_000, now = morning) => act(state, { type: 'start', id, durationMs, label: id }, now);

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete (globalThis as Record<string, unknown>).localStorage;
  if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete (globalThis as Record<string, unknown>).sessionStorage;
});
function stores() {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  return { local, session };
}

test('all simultaneous timers and alarms fire at the exact due instant and remain queued', () => {
  let state = start(start(scheduled([alarm('a'), alarm('b')]), 'tea'), 'pasta');
  assert.equal(tickRuntime(state, dueAt - 1).ringingQueue.length, 0);
  state = tickRuntime(state, dueAt);
  assert.equal(state.ringingQueue.length, 4);
  assert.deepEqual(new Set(state.ringingQueue.map((r) => r.label)), new Set(['a', 'b', 'tea', 'pasta']));
  assert.equal(state.ringingQueue.filter((r) => r.startedAt !== null).length, 1);
  assert.ok(state.alarms.every((a) => !a.enabled), 'one-off alarms disable as soon as they fire');
  assert.equal(state.alarms.length, 2, 'one-offs remain editable');
  state = start(state, 'later', 1000, dueAt);
  state = tickRuntime(state, dueAt + 1000);
  assert.equal(state.ringingQueue.length, 5, 'ringing never disarms other sources');
  const ids = new Set<string>();
  while (state.ringingQueue.length) { ids.add(state.ringingQueue[0].id); state = act(state, { type: 'dismiss' }, dueAt + 1000); }
  assert.equal(ids.size, 5);
});

test('repeated advance and reload do not duplicate expired timers or one-off alarms', () => {
  const state = tickRuntime(start(scheduled(), 'tea'), dueAt);
  assert.equal(tickRuntime(state, dueAt), state, 'idle clock tick is a no-op');
  const restored = parseRuntime(JSON.stringify(state), dueAt)!;
  assert.deepEqual(restored, state);
  const dismissed = act(act(restored, { type: 'dismiss' }, dueAt), { type: 'dismiss' }, dueAt);
  assert.equal(tickRuntime(dismissed, dueAt + 86_400_000).ringingQueue.length, 0);
  assert.equal(dismissed.alarms[0].enabled, false);
});

test('pause, add time, resume, restart, and remove preserve independent wall-clock timers', () => {
  let state = start(start(emptyRuntime(), 'tea'), 'pasta', 120_000);
  state = act(state, { type: 'pause', id: 'tea' }, morning + 20_000);
  assert.equal(state.timers[0].remainingMs, 40_000);
  state = act(state, { type: 'add-time', id: 'tea', durationMs: 60_000 }, morning + 40_000);
  assert.equal(state.timers[0].status, 'paused');
  assert.equal(state.timers[0].remainingMs, 100_000);
  state = act(state, { type: 'resume', id: 'tea' }, morning + 50_000);
  assert.equal(state.timers[0].endTime, morning + 150_000);
  assert.equal(timerRemaining(state.timers[1], morning + 50_000), 70_000);
  state = tickRuntime(state, morning + 150_000);
  assert.equal(state.ringingQueue.length, 2);
  state = act(state, { type: 'restart', id: 'tea' }, morning + 151_000);
  assert.equal(state.timers[0].remainingMs, 120_000);
  assert.ok(state.ringingQueue.every((r) => r.kind !== 'timer' || r.timerId !== 'tea'));
  state = act(state, { type: 'remove-timer', id: 'pasta' }, morning + 152_000);
  assert.equal(state.ringingQueue.length, 0);
  assert.equal(state.timers.length, 1);
});

test('adding time to a ringing timer rearms it and removes only its own alert', () => {
  let state = tickRuntime(start(start(emptyRuntime(), 'tea'), 'pasta'), dueAt);
  state = act(state, { type: 'add-time', id: 'tea', durationMs: 60_000 }, dueAt);
  assert.equal(state.timers.find((t) => t.id === 'tea')!.endTime, dueAt + 60_000);
  assert.equal(state.ringingQueue.length, 1);
  assert.equal(state.ringingQueue[0].label, 'pasta');
});

test('reload keeps running deadlines and paused remaining time without extending either', () => {
  let state = start(start(emptyRuntime(), 'tea'), 'pasta');
  state = act(state, { type: 'pause', id: 'tea' }, morning + 10_000);
  const restored = parseRuntime(JSON.stringify(state), morning + 20_000)!;
  assert.equal(restored.timers[0].remainingMs, 50_000);
  assert.equal(timerRemaining(restored.timers[1], morning + 20_000), 40_000);
});

test('legacy migration retains bedroom weekday alarm and expired session timer', () => {
  const legacy = { id: '9cdb370c-2d4a-41ea-83da-39bced0179fa', hour: 7, minute: 30, enabled: false, repeat: { kind: 'custom', weekdays: [1, 2, 3, 4, 5] } };
  const alarms = parseAlarms(JSON.stringify([legacy]));
  const state = migrateRuntime(alarms, { endTime: morning - CATCH_UP_MS - 1 }, morning);
  assert.equal(state.alarms[0].id, legacy.id);
  assert.equal(state.alarms[0].enabled, false);
  assert.equal(state.alarms[0].label, 'Alarm');
  assert.equal(state.alarms[0].snoozeMinutes, 10);
  assert.deepEqual(state.alarms[0].repeat, legacy.repeat);
  assert.equal(state.ringingQueue[0].kind, 'timer');
  assert.equal(state.ringingQueue[0].silent, true, 'old timer remains visible without a surprise ring');
  assert.equal(migrateRuntime([], { endTime: morning - 1000 }, morning).ringingQueue[0].silent, false);
});

test('migration clears legacy session only after successful durable runtime save', () => {
  const { local, session } = stores();
  local.setItem(ALARMS_KEY, JSON.stringify([alarm('wake')]));
  session.setItem(SESSION_TIMER_KEY, JSON.stringify({ mode: 'running', endTime: dueAt }));
  const state = loadTimerRuntime(morning);
  assert.equal(state.timers[0].endTime, dueAt);
  const setItem = local.setItem.bind(local);
  local.setItem = () => { throw new Error('quota'); };
  assert.equal(saveTimerRuntime(state), false);
  assert.notEqual(session.getItem(SESSION_TIMER_KEY), null);
  local.setItem = setItem;
  assert.equal(saveTimerRuntime(state), true);
  assert.equal(session.getItem(SESSION_TIMER_KEY), null);
  assert.notEqual(local.getItem(TIMER_RUNTIME_KEY), null);
  assert.equal(loadTimerRuntime(morning + 1000).timers.length, 1);
});

test('blocked and malformed storage never crashes and malformed v2 falls back to legacy', () => {
  const { local, session } = stores();
  local.setItem(TIMER_RUNTIME_KEY, '{"version":2}');
  session.setItem(SESSION_TIMER_KEY, JSON.stringify({ mode: 'running', endTime: dueAt }));
  assert.equal(loadTimerRuntime(morning).timers.length, 1);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.doesNotThrow(() => loadTimerRuntime(morning));
  assert.equal(saveTimerRuntime(emptyRuntime()), false);
});

test('invalid fractional times, weekdays, snoozes and unbounded timer inputs are rejected', () => {
  for (const patch of [{ hour: 7.5 }, { minute: NaN }, { repeat: { kind: 'weekly', weekday: 1.5 } }, { repeat: { kind: 'custom', weekdays: [] } }, { snoozeMinutes: 0 }]) {
    assert.equal(normalizeAlarm({ ...alarm('bad'), ...patch }), null);
  }
  for (const durationMs of [NaN, Infinity, -1000, 0, MAX_TIMER_MS + 1]) assert.equal(start(emptyRuntime(), 'bad', durationMs).timers.length, 0);
  assert.equal(parseRuntime('{broken', morning), null);
});

test('snooze uses each alarm duration, survives reload and keeps disabled one-off alarm', () => {
  let state = tickRuntime(scheduled([alarm('wake', { snoozeMinutes: 3 })]), dueAt);
  state = act(state, { type: 'snooze', id: 's1' }, dueAt);
  assert.equal(state.pendingSnoozes[0].fireAt, dueAt + 180_000);
  assert.equal(state.alarms[0].enabled, false);
  state = parseRuntime(JSON.stringify(state), dueAt + 179_999)!;
  assert.equal(state.ringingQueue.length, 0);
  state = tickRuntime(state, dueAt + 180_000);
  assert.equal(state.pendingSnoozes.length, 0);
  assert.equal(state.ringingQueue[0].label, 'wake');
  assert.equal(state.ringingQueue[0].kind === 'alarm' && state.ringingQueue[0].snoozeMinutes, 3);
  assert.equal(tickRuntime(state, dueAt + 180_000).ringingQueue.length, 1);
});

test('cancel snooze works for disabled one-offs and at the exact snooze deadline', () => {
  const first = act(tickRuntime(scheduled(), dueAt), { type: 'snooze', id: 's1' }, dueAt);
  const cancelled = act(first, { type: 'cancel-snooze', id: 'wake' }, dueAt + 1000);
  assert.equal(tickRuntime(cancelled, dueAt + 300_000).ringingQueue.length, 0);
  const atDeadline = act(first, { type: 'cancel-snooze', id: 'wake' }, dueAt + 300_000);
  assert.equal(atDeadline.ringingQueue.length, 0);
  assert.equal(atDeadline.pendingSnoozes.length, 0);
});

test('disabling or deleting an alarm cancels its snooze without affecting other sources', () => {
  const state = act(tickRuntime(scheduled(), dueAt), { type: 'snooze', id: 's1' }, dueAt);
  assert.equal(act(state, { type: 'update-alarm', id: 'wake', patch: { enabled: false } }, dueAt).pendingSnoozes.length, 0);
  assert.equal(act(state, { type: 'remove-alarm', id: 'wake' }, dueAt).pendingSnoozes.length, 0);
});

test('silent overdue alert yields to fresh timer while remaining visibly queued', () => {
  let state = migrateRuntime([], { endTime: morning - CATCH_UP_MS - 1 }, morning);
  state = start(state, 'fresh', 1000);
  state = tickRuntime(state, morning + 1000);
  assert.equal(state.ringingQueue[0].label, 'fresh');
  assert.equal(state.ringingQueue[0].silent, false);
  assert.equal(state.ringingQueue[1].silent, true);
  state = act(state, { type: 'dismiss' }, morning + 1000);
  assert.equal(state.ringingQueue.length, 1);
  assert.equal(state.ringingQueue[0].label, 'Timer');
});

test('audio cap advances the next alert without silently dismissing the old one', () => {
  let state = tickRuntime(start(start(emptyRuntime(), 'one'), 'two'), dueAt);
  const previous = state.ringingQueue[0].id;
  state = tickRuntime(state, dueAt + MAX_RING_MS);
  assert.notEqual(state.ringingQueue[0].id, previous);
  assert.equal(state.ringingQueue[0].silent, false);
  assert.equal(state.ringingQueue[0].startedAt, dueAt + MAX_RING_MS);
  assert.equal(state.ringingQueue.find((r) => r.id === previous)!.silent, true);
});

test('tomorrow repeat rings after reload despite yesterday undismissed alert; old history is bounded', () => {
  let state = tickRuntime(scheduled([alarm('daily', { repeat: { kind: 'daily' } })]), dueAt);
  for (let day = 1; day <= 30; day++) {
    const at = dueAt + day * 86_400_000;
    state = parseRuntime(JSON.stringify(state), at)!;
    assert.equal(state.ringingQueue[0].fireAt, at);
    assert.equal(state.ringingQueue[0].silent, false);
    assert.equal(state.ringingQueue.length, 2);
    assert.equal(state.ringingQueue[1].occurrences, day);
  }
});

test('label edits preserve scheduled occurrence; enable resets a fired one-off to next valid time', () => {
  const before = scheduled();
  const edited = act(before, { type: 'update-alarm', id: 'wake', patch: { label: 'School' } }, morning + 1000);
  assert.equal(edited.alarmNextFireAt.wake, dueAt);
  let after = tickRuntime(edited, dueAt);
  after = act(after, { type: 'update-alarm', id: 'wake', patch: { enabled: true } }, dueAt);
  assert.equal(after.alarmNextFireAt.wake, dueAt + 86_400_000);
  assert.equal(after.ringingQueue.length, 0);
});

test('recent timer presets are bounded and deduplicated by label and duration', () => {
  let state = emptyRuntime();
  for (let i = 0; i < 8; i++) state = start(state, String(i), 60_000 + i * 1000);
  assert.equal(state.recentTimers.length, 6);
  state = act(state, { type: 'start', id: 'repeat', durationMs: 67_000, label: '7' }, morning);
  assert.equal(state.recentTimers.length, 6);
  assert.equal(state.recentTimers[0].label, '7');
});

test('calendar schedules honor exact time, weekday zero, and custom weekdays', () => {
  assert.equal(nextFireAfter(new Date(dueAt), 7, 0, { kind: 'once' }).getTime(), dueAt + 86_400_000);
  const saturday = new Date(2026, 9, 3, 8);
  assert.equal(nextFireAfter(saturday, 7, 30, { kind: 'weekly', weekday: 0 }).getDay(), 0);
  const monday = nextFireAfter(saturday, 7, 30, { kind: 'custom', weekdays: [1, 2, 3, 4, 5] });
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 7);
  assert.throws(() => nextFireAfter(saturday, 7, 30, { kind: 'custom', weekdays: [] }), RangeError);
});

test('spring DST gap shifts once and does not drift later days', () => {
  const gap = nextFireAfter(new Date(2026, 2, 7, 23), 2, 30, { kind: 'daily' });
  assert.equal(gap.toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(nextFireAfter(gap, 2, 30, { kind: 'daily' }).toISOString(), '2026-03-09T06:30:00.000Z');
});

test('fall DST overlap fires once, including a reload between duplicate wall times', () => {
  const first = nextFireAfter(new Date('2026-11-01T04:00:00Z'), 1, 30, { kind: 'daily' });
  assert.equal(first.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(nextFireAfter(new Date('2026-11-01T06:00:00Z'), 1, 30, { kind: 'daily' }).toISOString(), '2026-11-02T06:30:00.000Z');
  let state = migrateRuntime([alarm('fall', { hour: 1, minute: 30, repeat: { kind: 'daily' } })], null, new Date('2026-11-01T04:00:00Z').getTime());
  state = tickRuntime(state, first.getTime());
  state = act(state, { type: 'dismiss' }, first.getTime());
  state = parseRuntime(JSON.stringify(state), new Date('2026-11-01T06:30:00Z').getTime())!;
  assert.equal(state.ringingQueue.length, 0);
  assert.equal(new Date(state.alarmNextFireAt.fall).toISOString(), '2026-11-02T06:30:00.000Z');
});

test('dismiss targets the touched alert when a fresh one is promoted during the same action', () => {
  let state = tickRuntime(start(emptyRuntime(), 'old', 1000), morning + 1000);
  state = start(state, 'fresh', MAX_RING_MS, morning + 1000);
  state = act(state, { type: 'dismiss' }, morning + 1000 + MAX_RING_MS);
  assert.equal(state.ringingQueue.length, 1);
  assert.equal(state.ringingQueue[0].label, 'fresh');
  assert.equal(state.ringingQueue[0].silent, false);
});

test('snooze targets rendered alarm after priority changes and stale dismiss cannot clear next alert', () => {
  let state = tickRuntime(scheduled(), dueAt);
  const displayed = state.ringingQueue[0].id;
  state = start(state, 'fresh', MAX_RING_MS, dueAt);
  state = tickRuntime(state, dueAt + MAX_RING_MS);
  state = act(state, { type: 'snooze', id: 's1', eventId: displayed }, dueAt + MAX_RING_MS);
  assert.equal(state.ringingQueue[0].label, 'fresh');
  assert.equal(state.pendingSnoozes[0].alarmId, 'wake');
  const fresh = state.ringingQueue[0].id;
  state = act(state, { type: 'dismiss', id: displayed }, dueAt + MAX_RING_MS);
  assert.equal(state.ringingQueue[0].id, fresh);
});

test('voice stop selects ringing timer before unrelated active timers, while labels remain explicit', () => {
  let state = tickRuntime(start(scheduled(), 'tea'), dueAt);
  state = start(state, 'pasta', 60_000, dueAt);
  assert.equal(state.ringingQueue[0].kind, 'alarm', 'another alarm may be shown before the timer');
  assert.equal(timerToCancel(state), 'tea');
  assert.equal(timerToCancel(state, ' PASTA '), 'pasta');
  assert.equal(timerToCancel(state, 'missing'), null);
  state = act(state, { type: 'remove-timer', id: timerToCancel(state)! }, dueAt);
  assert.equal(state.timers.find((timer) => timer.id === 'pasta')!.status, 'running');
  assert.equal(state.ringingQueue.length, 1);
  assert.equal(timerToCancel(state), 'pasta');
});

test('delete Undo restores disabled one-off snooze with its exact original deadline', () => {
  let state = act(tickRuntime(scheduled(), dueAt), { type: 'snooze', id: 's1' }, dueAt);
  const before = state.pendingSnoozes[0].fireAt;
  const snapshot = snapshotAlarm(state, 'wake', dueAt + 1000)!;
  state = act(state, { type: 'remove-alarm', id: 'wake' }, dueAt + 1000);
  assert.equal(state.pendingSnoozes.length, 0);
  state = act(state, { type: 'restore-alarm', snapshot }, dueAt + 2000);
  assert.equal(state.alarms[0].enabled, false);
  assert.equal(state.pendingSnoozes[0].fireAt, before);
  assert.equal(state.pendingSnoozes[0].id, 's1');
  const restored = state;
  assert.equal(act(state, { type: 'restore-alarm', snapshot }, dueAt + 2000), restored, 'repeated Undo must not duplicate an active ID');
});

test('Undo collects one-off alarm or snooze that became due while deleted exactly once', () => {
  const initialStates = [scheduled(), act(tickRuntime(scheduled(), dueAt), { type: 'snooze', id: 's1' }, dueAt)];
  for (const original of initialStates) {
    const deleteAt = original.pendingSnoozes.length ? dueAt + 1000 : morning + 1000;
    const restoreAt = original.pendingSnoozes[0]?.fireAt ?? dueAt;
    const snapshot = snapshotAlarm(original, 'wake', deleteAt)!;
    let state = act(original, { type: 'remove-alarm', id: 'wake' }, deleteAt);
    state = act(state, { type: 'restore-alarm', snapshot }, restoreAt);
    assert.equal(state.ringingQueue.length, 1);
    assert.equal(state.ringingQueue[0].fireAt, restoreAt);
    assert.equal(state.alarms[0].enabled, false);
    assert.equal(state.pendingSnoozes.length, 0);
    assert.equal(tickRuntime(state, restoreAt), state);
  }
});

test('Undo preserves repeat deadline and queued alert audio age without resurrecting another ID', () => {
  let state = tickRuntime(scheduled([alarm('daily', { repeat: { kind: 'daily' } })]), dueAt);
  const snapshot = snapshotAlarm(state, 'daily', dueAt + 1000)!;
  const nextDay = snapshot.nextFireAt;
  const originalAlertId = snapshot.ringingQueue[0].id;
  state = act(state, { type: 'remove-alarm', id: 'daily' }, dueAt + 1000);
  state = act(state, { type: 'restore-alarm', snapshot }, dueAt + 2000);
  assert.equal(state.alarmNextFireAt.daily, nextDay);
  assert.equal(state.ringingQueue[0].id, originalAlertId);
  assert.equal(state.ringingQueue[0].startedAt, dueAt);
  assert.equal(snapshotAlarm(state, 'missing', dueAt), null);
  const malicious = { ...snapshot, alarm: { ...snapshot.alarm, id: '__proto__' } };
  assert.equal(act(state, { type: 'restore-alarm', snapshot: malicious }, dueAt + 2000), state);
});

test('voice clock inputs accept explicit zero and numeric strings without treating null as midnight', () => {
  for (const value of [null, undefined, '', '   ', false, true, [], {}]) {
    assert.equal(normalizeAlarm({ ...alarm('voice'), hour: clockNumber(value), minute: 0 }), null);
  }
  assert.equal(normalizeAlarm({ ...alarm('voice'), hour: clockNumber('0'), minute: clockNumber(0) })!.hour, 0);
  assert.equal(normalizeAlarm({ ...alarm('voice'), hour: clockNumber('7.5') }), null);
});

test('new voice timer at capacity replaces only the oldest acknowledged finished card', () => {
  let state = emptyRuntime();
  for (let i = 0; i < 32; i++) state = start(state, `done-${i}`, 1000, morning + i * 10);
  state = tickRuntime(state, morning + 2000);
  while (state.ringingQueue.length) state = act(state, { type: 'dismiss' }, morning + 2000);
  assert.equal(state.timers.length, 32);
  state = act(state, { type: 'start', id: 'voice-new', durationMs: 60_000, label: 'Pasta' }, morning + 3000);
  assert.equal(state.timers.length, 32);
  assert.equal(state.timers.some((timer) => timer.id === 'done-0'), false);
  assert.equal(state.timers.find((timer) => timer.id === 'voice-new')!.status, 'running');
  assert.deepEqual(state.timers.filter((timer) => timer.status === 'finished').map((timer) => timer.id), Array.from({ length: 31 }, (_, i) => `done-${i + 1}`));
  assert.equal(state.recentTimers.length, 6);
});

test('capacity never evicts running, paused, or unacknowledged finished timers', () => {
  let active = emptyRuntime();
  for (let i = 0; i < 32; i++) active = start(active, `active-${i}`);
  active = act(active, { type: 'pause', id: 'active-0' }, morning);
  assert.equal(start(active, 'blocked'), active);
  assert.equal(active.timers[0].status, 'paused');
  const unacknowledged = tickRuntime(active, dueAt);
  assert.equal(unacknowledged.ringingQueue.length, 31);
  assert.equal(start(unacknowledged, 'still-blocked', 60_000, dueAt), unacknowledged);
  const acknowledged = act(unacknowledged, { type: 'dismiss' }, dueAt);
  const acknowledgedId = unacknowledged.ringingQueue[0].kind === 'timer' ? unacknowledged.ringingQueue[0].timerId : '';
  const accepted = start(acknowledged, 'allowed', 60_000, dueAt);
  assert.equal(accepted.timers.length, 32);
  assert.equal(accepted.timers.some((timer) => timer.id === acknowledgedId), false);
  assert.equal(accepted.timers[0].status, 'paused');
  assert.deepEqual(accepted.ringingQueue, acknowledged.ringingQueue);
});
