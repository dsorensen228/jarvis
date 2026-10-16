import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIGH_HZ, LOW_HZ, PEAK_GAIN, STEP_MS, startAlarmToneLoop, stopAlarmToneLoop } from '../src/timer/alarmTone.ts';

test('asynchronous audio resume cannot revive dismissed alerts or orphan a queue loop', async (t) => {
  const originalWindow = globalThis.window;
  let state = 'suspended';
  let nextId = 0;
  const pending: Array<() => void> = [];
  const intervals = new Map<number, () => void>();
  const tones: number[] = [];
  const gains: number[] = [];
  class AudioContextMock {
    get state() { return state; }
    currentTime = 0;
    destination = {};
    resume() { return new Promise<void>(resolve => pending.push(() => { state = 'running'; resolve(); })); }
    createOscillator() {
      let frequency = 0;
      return { type: '', frequency: { setValueAtTime(value: number) { frequency = value; } }, connect() {}, start() { tones.push(frequency); }, stop() {} };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime(value: number) { gains.push(value); } }, connect() {} }; }
  }
  globalThis.window = {
    AudioContext: AudioContextMock,
    setInterval(callback: () => void, delay: number) { assert.equal(delay, STEP_MS); const id = ++nextId; intervals.set(id, callback); return id; },
    clearInterval(id: number) { intervals.delete(id); },
  } as unknown as Window & typeof globalThis;
  try {
    await t.test('dismiss while resume is pending never starts sound later', async () => {
      const starting = startAlarmToneLoop();
      assert.equal(pending.length, 1);
      stopAlarmToneLoop(); pending.shift()!(); const stop = await starting; stop();
      assert.equal(intervals.size, 0); assert.deepEqual(tones, []);
    });
    await t.test('switching queued alerts keeps only the newest asynchronous start', async () => {
      state = 'suspended';
      const first = startAlarmToneLoop(); stopAlarmToneLoop(); const second = startAlarmToneLoop();
      assert.equal(pending.length, 2);
      pending.pop()!(); const stopSecond = await second;
      assert.equal(intervals.size, 1);
      pending.shift()!(); const stopFirst = await first; stopFirst();
      assert.equal(intervals.size, 1); assert.deepEqual(tones, [LOW_HZ]);
      [...intervals.values()][0](); assert.deepEqual(tones, [LOW_HZ, HIGH_HZ]);
      assert.ok(gains.includes(PEAK_GAIN));
      stopSecond(); assert.equal(intervals.size, 0);
    });
    await t.test('late cleanup from an already-started alert cannot stop its replacement', async () => {
      const stopFirst = await startAlarmToneLoop();
      const stopSecond = await startAlarmToneLoop();
      assert.equal(intervals.size, 1);
      stopFirst(); assert.equal(intervals.size, 1);
      stopSecond(); assert.equal(intervals.size, 0);
    });
  } finally {
    stopAlarmToneLoop();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  }
});
