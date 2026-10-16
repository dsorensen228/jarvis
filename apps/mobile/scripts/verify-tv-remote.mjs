import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../lib/tvRemoteState.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { tvMedia, tvSources, tvStatus, tvSupports, tvSupportsKey, createTvCommandQueue } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const remote = { domain: 'remote', power: true, capabilities: ['remote_keys'] };
const media = { domain: 'media_player', power: true, app: 'Netflix', apps: ['Netflix', 'HDMI 1', 'YouTube', 'Netflix'], playback_state: 'playing' };
const device = { available: true, power: true, capabilities: ['remote_keys', 'app_launch', 'playback'], supported_keys: ['up', 'select', 'play'], components: [remote, media] };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function commandQueue() {
  const pending = [], errors = [], settled = [];
  const queue = createTvCommandQueue({ onPending: (n) => pending.push(n), onError: (e, id) => errors.push([e.message, id]), onSettled: (id) => settled.push(id) });
  return { queue, pending, errors, settled };
}

test('TV status and sources use the media component even when the remote is first', () => {
  assert.equal(tvMedia(device), media);
  assert.equal(tvStatus(device), 'Netflix · Playing');
  assert.deepEqual(tvSources(device), ['Netflix', 'HDMI 1', 'YouTube']);
  assert.deepEqual(tvSources(device, '  HDMI '), ['HDMI 1']);
  assert.equal(tvStatus({ ...device, available: false }), 'Unavailable');
  assert.equal(tvStatus({ ...device, components: [remote, { ...media, power: false }] }), 'Off');
});

test('unknown capabilities and optional remote keys are never assumed supported', () => {
  assert.equal(tvSupports(device, 'playback'), true);
  assert.equal(tvSupports(device, 'find_remote'), false);
  assert.equal(tvSupportsKey(device, 'up'), true);
  assert.equal(tvSupportsKey(device, 'find_remote'), false);
  assert.equal(tvSupportsKey({ ...device, supported_keys: undefined }, 'up'), false);
  assert.equal(tvStatus({ ...device, power: null, components: [{ domain: 'media_player', power: null }] }), 'State unknown');
});

test('rapid taps run once each in order, with at most eight commands outstanding', async () => {
  const { queue, pending } = commandQueue();
  const first = gate(); const calls = [];
  queue.select('tv-a');
  for (let i = 0; i < 8; i++) assert.equal(queue.enqueue('tv-a', async () => { calls.push(i); if (!i) await first.promise; }), true);
  assert.equal(queue.enqueue('tv-a', async () => calls.push(8)), false);
  assert.deepEqual(calls, [0]);
  first.resolve(); await flush();
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pending.at(-1), 0);
});

test('switching TVs discards unsent taps and old errors, while the next TV stays responsive', async () => {
  const { queue, errors, settled } = commandQueue();
  const first = gate(); const calls = [];
  queue.select('tv-a');
  queue.enqueue('tv-a', async () => { calls.push('a-running'); await first.promise; throw Error('old failure'); });
  queue.enqueue('tv-a', async () => calls.push('a-unsent'));
  queue.select('tv-b');
  assert.equal(queue.enqueue('tv-a', async () => calls.push('wrong-target')), false);
  queue.enqueue('tv-b', async () => calls.push('b'));
  first.resolve(); await flush();
  assert.deepEqual(calls, ['a-running', 'b']);
  assert.deepEqual(errors, []);
  assert.deepEqual(settled, ['tv-b']);
});

test('returning to the same TV does not revive a prior command result', async () => {
  const { queue, errors, settled } = commandQueue(); const first = gate();
  queue.select('tv-a');
  queue.enqueue('tv-a', async () => { await first.promise; throw Error('stale'); });
  queue.select('tv-b'); queue.select('tv-a');
  queue.enqueue('tv-a', async () => {});
  first.resolve(); await flush();
  assert.deepEqual(errors, []);
  assert.deepEqual(settled, ['tv-a']);
});

test('a failed tap is surfaced and cancels queued repeats; new input can retry', async () => {
  const { queue, errors, settled } = commandQueue(); const calls = [];
  queue.select('tv-a');
  queue.enqueue('tv-a', async () => { throw Error('unavailable'); });
  queue.enqueue('tv-a', async () => calls.push('next'));
  await flush();
  assert.deepEqual(errors, [['unavailable', 'tv-a']]);
  assert.deepEqual(calls, []);
  queue.enqueue('tv-a', async () => calls.push('retry'));
  await flush();
  assert.deepEqual(calls, ['retry']);
  const first = gate();
  queue.enqueue('tv-a', async () => first.promise);
  queue.enqueue('tv-a', async () => calls.push('cancelled'));
  queue.dispose(); first.resolve(); await flush();
  assert.deepEqual(calls, ['retry']);
  assert.equal(settled.length, 2);
  assert.equal(queue.enqueue('tv-a', async () => {}), false);
});


test('success callbacks only run for the current TV and never after failure', async () => {
  const { queue } = commandQueue(); const first = gate(); const successes = [];
  queue.select('tv-a');
  queue.enqueue('tv-a', async () => first.promise, () => successes.push('stale'));
  queue.select('tv-b');
  queue.enqueue('tv-b', async () => {}, () => successes.push('current'));
  first.resolve(); await flush();
  queue.enqueue('tv-b', async () => { throw Error('rejected'); }, () => successes.push('failed'));
  await flush();
  assert.deepEqual(successes, ['current']);
});
