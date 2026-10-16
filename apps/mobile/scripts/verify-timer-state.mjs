import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function moduleUrl(path, replacements = {}) {
  let source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return url(Object.entries(replacements).reduce((text, [from, to]) => text.replaceAll(`'${from}'`, `'${to}'`), compiled));
}
const modelUrl = moduleUrl('../lib/timerState.ts');
const model = await import(modelUrl);
const { EMPTY_TIMER, MAX_TIMER_MS, reduceTimer, restoreTimer, timerRemaining, durationFromParts, matchesTimerNotification } = model;
const persistenceUrl = moduleUrl('../lib/timerPersistence.ts', { './timerState': modelUrl });
const { createTimerStore, TIMER_STORAGE_KEY, LEGACY_TIMER_STORAGE_KEY } = await import(persistenceUrl);
const formatUrl = moduleUrl('../lib/timerFormat.ts');
const { formatTimerClock } = await import(formatUrl);
const begin = (now = 1000) => reduceTimer(EMPTY_TIMER, { type: 'start', durationMs: 60_000, label: '  Tea   break ', now, id: 'a' });
function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } };
}
test('duration input clamps at submit, clocks round up and reject non-finite values', () => {
  assert.equal(durationFromParts('99', '99', '99'), MAX_TIMER_MS);
  assert.equal(durationFromParts('', '', ''), 0);
  assert.equal(formatTimerClock(1), '0:01'); assert.equal(formatTimerClock(3_661_000), '1:01:01');
  assert.equal(formatTimerClock(NaN), '0:00'); assert.equal(formatTimerClock(Infinity), '0:00');
  assert.equal(reduceTimer(EMPTY_TIMER, { type: 'start', durationMs: NaN, label: '', id: 'x', now: 0 }), EMPTY_TIMER);
});
test('pause preserves subsecond remaining, resume uses wall time, adding a minute preserves progress', () => {
  let state = begin(); assert.equal(state.label, 'Tea break');
  state = reduceTimer(state, { type: 'pause', now: 2250 }); assert.equal(timerRemaining(state, 99999), 58_750);
  state = reduceTimer(state, { type: 'add-minute', now: 3000 }); assert.equal(state.pausedRemainingMs, 118_750);
  state = reduceTimer(state, { type: 'resume', now: 100_000 }); assert.equal(state.endAtMs, 218_750);
  assert.equal(state.durationMs, 120_000);
});
test('expiration keeps completion visible after sound stops and restart resets its deadline', () => {
  let state = reduceTimer(begin(), { type: 'finish', now: 62_000 });
  assert.equal(state.status, 'alarming'); assert.equal(state.alarmedAtMs, 61_000);
  state = reduceTimer(state, { type: 'silence', now: 92_000 }); assert.equal(state.status, 'alarming'); assert.equal(state.silenced, true);
  state = reduceTimer(state, { type: 'restart', id: 'b', now: 100_000 }); assert.equal(state.endAtMs, 160_000); assert.equal(state.silenced, false);
});
test('stale deliveries and dismissals cannot mutate paused or replacement timers', () => {
  const state = begin(); const data = { timerId: state.id, revision: String(state.revision) };
  assert.equal(matchesTimerNotification(state, data), true);
  assert.equal(matchesTimerNotification(reduceTimer(state, { type: 'pause', now: 2000 }), data), false);
  assert.equal(matchesTimerNotification(reduceTimer(state, { type: 'restart', id: 'b', now: 2000 }), data), false);
  assert.equal(matchesTimerNotification(reduceTimer(state, { type: 'finish', now: 62_000 }), data), true);
});
test('legacy running and paused timers migrate, invalid storage is bounded, overdue timers stay silent', () => {
  const legacy = { v: 1, status: 'running', endAtMs: 61_000, pausedRemainingMs: null, durationMs: 60_000 };
  assert.equal(restoreTimer(JSON.stringify(legacy), 1000).endAtMs, 61_000);
  assert.equal(restoreTimer(JSON.stringify(legacy), 100_000).silenced, true);
  assert.equal(restoreTimer(JSON.stringify({ ...legacy, status: 'alarming', endAtMs: null }), 100_000).silenced, true);
  assert.equal(restoreTimer(JSON.stringify({ ...legacy, status: 'paused', pausedRemainingMs: 1234 }), 1000).pausedRemainingMs, 1234);
  assert.deepEqual(restoreTimer('{bad', 1000), EMPTY_TIMER);
  assert.equal(restoreTimer(JSON.stringify({ ...legacy, endAtMs: 10 ** 15 }), 1000).status, 'idle');
});
test('recent durations are unique, bounded, and retained after cancellation', () => {
  let state = EMPTY_TIMER;
  for (let n = 1; n <= 9; n++) state = reduceTimer(state, { type: 'start', durationMs: n * 1000, label: '', id: String(n), now: 0 });
  state = reduceTimer(state, { type: 'stop', now: 100 }); assert.deepEqual(state.recentDurations, [9000, 8000, 7000, 6000, 5000, 4000]);
});
test('storage migrates v1 only after a durable v2 write and keeps labels across process recreation', async () => {
  const storage = memory({ [LEGACY_TIMER_STORAGE_KEY]: JSON.stringify({ v: 1, status: 'paused', pausedRemainingMs: 5000, durationMs: 10000 }) });
  const store = createTimerStore(storage); await store.ready(); assert.equal(storage.values.has(LEGACY_TIMER_STORAGE_KEY), false);
  await store.dispatch({ type: 'start', durationMs: 30_000, label: 'Pasta', id: 'p', now: Date.now() });
  const recreated = createTimerStore(storage); await recreated.ready(); assert.equal(recreated.getSnapshot().state.label, 'Pasta');
  assert.equal(recreated.getSnapshot().state.status, 'running');
});
test('failed migration retains v1 and exposes persistence warning without breaking the timer', async () => {
  const storage = memory({ [LEGACY_TIMER_STORAGE_KEY]: JSON.stringify({ v: 1, status: 'paused', pausedRemainingMs: 5000, durationMs: 10000 }) });
  storage.setItem = async () => { throw Error('disk unavailable'); };
  const store = createTimerStore(storage); await store.ready();
  assert.equal(store.getSnapshot().storageError, true); assert.equal(storage.values.has(LEGACY_TIMER_STORAGE_KEY), true);
  assert.equal(store.getSnapshot().state.status, 'paused');
});
test('rapid actions cannot finish persisting in the wrong order', async () => {
  const storage = memory(); const writes = [];
  storage.setItem = async (key, value) => { await new Promise(r => setTimeout(r, 3)); writes.push(JSON.parse(value).status); storage.values.set(key, value); };
  const store = createTimerStore(storage); await store.ready();
  await Promise.all([store.dispatch({ type: 'start', durationMs: 60_000, label: 'Tea', id: 'a', now: Date.now() }), store.dispatch({ type: 'pause', now: Date.now() + 5 }), store.dispatch({ type: 'resume', now: Date.now() + 10 }), store.dispatch({ type: 'stop', now: Date.now() + 15 })]);
  assert.deepEqual(writes, ['running', 'paused', 'running', 'idle']); assert.equal(JSON.parse(storage.values.get(TIMER_STORAGE_KEY)).status, 'idle');
});

test('headless Android controls hydrate storage and ignore stale events; native sync uses the latest state', async () => {
  const now = Date.now(); const original = begin(now); const storage = memory({ [TIMER_STORAGE_KEY]: JSON.stringify(original) });
  let firstWrite;
  const writeBarrier = new Promise(resolve => { firstWrite = resolve; });
  let blocked = true;
  const save = storage.setItem;
  storage.setItem = async (...args) => { if (blocked) { blocked = false; await writeBarrier; } await save(...args); };
  const store = createTimerStore(storage); globalThis.__timerTestStore = store;
  const calls = []; globalThis.__timerNotifee = {
    createChannel: async () => {}, getNotificationSettings: async () => ({ authorizationStatus: 1, android: { alarm: 1 } }),
    cancelNotification: async id => calls.push(['cancel', id]), cancelTriggerNotification: async id => calls.push(['cancel-trigger', id]),
    displayNotification: async notification => calls.push(['display', notification]), createTriggerNotification: async (notification, trigger) => calls.push(['trigger', notification, trigger]),
    onForegroundEvent: () => {}, onBackgroundEvent: () => {},
  };
  const nativeUrl = moduleUrl('../lib/androidTimerNotifee.ts', {
    './timerState': modelUrl, './timerFormat': formatUrl,
    './timerStore': url('export const timerStore = globalThis.__timerTestStore;'),
    'react-native': url('export const Platform = {OS:"android"};'),
    '@notifee/react-native': url('export default globalThis.__timerNotifee; export const AlarmType={SET_EXACT_AND_ALLOW_WHILE_IDLE:1}, AndroidImportance={DEFAULT:3,HIGH:4,LOW:2}, AndroidNotificationSetting={DISABLED:0,ENABLED:1}, AuthorizationStatus={AUTHORIZED:1}, EventType={DELIVERED:3,DISMISSED:0,PRESS:1,ACTION_PRESS:2}, TriggerType={TIMESTAMP:0};'),
  });
  const native = await import(nativeUrl);
  const note = { id: native.ANDROID_NOTIF_ID_ONGOING, data: { timerId: original.id, revision: String(original.revision) } };
  const pausing = native.handleAndroidTimerEvent(2, { notification: note, pressAction: { id: 'pause' } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(store.getSnapshot().state.status, 'paused');
  const paused = store.getSnapshot().state;
  const resuming = native.handleAndroidTimerEvent(2, { notification: { ...note, data: { timerId: paused.id, revision: String(paused.revision) } }, pressAction: { id: 'resume' } });
  await new Promise(r => setTimeout(r, 0)); firstWrite(); await Promise.all([pausing, resuming]);
  assert.equal(store.getSnapshot().state.status, 'running');
  assert.equal(calls.filter(c => c[0] === 'display').every(c => !c[1].title.includes('paused')), true);
  await native.handleAndroidTimerEvent(0, { notification: note });
  await native.handleAndroidTimerEvent(3, { notification: { ...note, id: native.ANDROID_NOTIF_ID_END } });
  assert.equal(store.getSnapshot().state.status, 'running');
  const live = store.getSnapshot().state;
  await native.handleAndroidTimerEvent(2, { notification: { ...note, data: { timerId: live.id, revision: String(live.revision) } }, pressAction: { id: 'cancel' } });
  const restartedProcess = createTimerStore(storage); await restartedProcess.ready(); assert.equal(restartedProcess.getSnapshot().state.status, 'idle');
});

test('denied Android notifications fail promptly, cancellation drains the queue, and a later grant schedules the remaining deadline', async () => {
  const original = begin(Date.now()); const storage = memory({ [TIMER_STORAGE_KEY]: JSON.stringify(original) });
  const store = createTimerStore(storage); await store.ready(); globalThis.__timerDeniedTestStore = store;
  const calls = []; let allowed = false; let alarmAllowed = true; let requests = 0;
  globalThis.__timerDeniedNotifee = {
    createChannel: async () => {}, getNotificationSettings: async () => ({ authorizationStatus: allowed ? 1 : 0, android: { alarm: alarmAllowed ? 1 : 0 } }),
    // Reproduce the native permanent-denial behavior: requesting permission never resolves.
    requestPermission: () => { requests++; return new Promise(() => {}); },
    cancelNotification: async id => calls.push(['cancel', id]), cancelTriggerNotification: async id => calls.push(['cancel-trigger', id]),
    displayNotification: async notification => calls.push(['display', notification]), createTriggerNotification: async (notification, trigger) => calls.push(['trigger', notification, trigger]),
    openNotificationSettings: async () => calls.push(['settings']), openAlarmPermissionSettings: async () => calls.push(['alarm-settings']),
  };
  const native = await import(moduleUrl('../lib/androidTimerNotifee.ts', {
    './timerState': modelUrl, './timerFormat': formatUrl,
    './timerStore': url('export const timerStore = globalThis.__timerDeniedTestStore;'),
    'react-native': url('export const Platform = {OS:"android"};'),
    '@notifee/react-native': url('export default globalThis.__timerDeniedNotifee; export const AlarmType={SET_EXACT_AND_ALLOW_WHILE_IDLE:1}, AndroidImportance={DEFAULT:3,HIGH:4,LOW:2}, AndroidNotificationSetting={DISABLED:0,ENABLED:1}, AuthorizationStatus={AUTHORIZED:1}, EventType={DELIVERED:3,DISMISSED:0,PRESS:1,ACTION_PRESS:2}, TriggerType={TIMESTAMP:0};'),
  }));
  let timeout;
  try {
    await assert.rejects(Promise.race([
      native.syncAndroidTimerNotifications(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('permission queue hung')), 200); }),
    ]), /Notifications are disabled/);
  } finally { clearTimeout(timeout); }
  assert.equal(requests, 0);
  calls.length = 0;
  await assert.rejects(native.handleAndroidTimerEvent(2, { notification: { id: native.ANDROID_NOTIF_ID_ONGOING,
    data: { timerId: original.id, revision: String(original.revision) } }, pressAction: { id: 'pause' } }), /Notifications are disabled/);
  const paused = store.getSnapshot().state;
  assert.equal(paused.status, 'paused');
  assert.ok(calls.some(([kind, id]) => kind === 'cancel-trigger' && id === native.ANDROID_NOTIF_ID_END));
  assert.ok(calls.some(([kind, id]) => kind === 'cancel' && id === native.ANDROID_NOTIF_ID_ONGOING));
  await native.handleAndroidTimerEvent(2, { notification: { id: native.ANDROID_NOTIF_ID_ONGOING,
    data: { timerId: paused.id, revision: String(paused.revision) } }, pressAction: { id: 'cancel' } });
  assert.equal(store.getSnapshot().state.status, 'idle');
  assert.ok(calls.some(([kind, id]) => kind === 'cancel-trigger' && id === native.ANDROID_NOTIF_ID_END));
  await store.dispatch({ type: 'start', durationMs: 60_000, label: 'Tea', id: 'after-denial', now: Date.now() });
  const deadline = store.getSnapshot().state.endAtMs;
  await native.openAndroidTimerNotificationSettings(); allowed = true;
  await native.syncAndroidTimerNotifications();
  assert.ok(calls.some(([kind]) => kind === 'settings'));
  assert.equal(calls.find(([kind]) => kind === 'trigger')[2].timestamp, deadline);
  assert.equal(store.getSnapshot().state.endAtMs, deadline);
  alarmAllowed = false;
  await assert.rejects(native.syncAndroidTimerNotifications(), /Exact alarms are disabled/);
  await native.openAndroidTimerNotificationSettings();
  assert.equal(calls.at(-1)[0], 'alarm-settings');
});
