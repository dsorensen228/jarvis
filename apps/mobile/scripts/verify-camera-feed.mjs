import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/cameraFeed.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { pollCamera } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('switching cameras or leaving the tab ignores an in-flight result', async () => {
  let resolve;
  const values = [], errors = [];
  const stop = pollCamera(() => new Promise(done => { resolve = done; }), value => values.push(value), error => errors.push(error), () => 100);
  stop(); resolve('old camera'); await flush();
  assert.deepEqual(values, []); assert.deepEqual(errors, []);
});

test('an in-flight failure after leaving does not update UI or retry', async () => {
  let reject, requests = 0;
  const errors = [];
  const stop = pollCamera(() => { requests++; return new Promise((_, fail) => { reject = fail; }); }, () => {}, error => errors.push(error), () => 10, 10);
  stop(); reject(new Error('offline')); await flush();
  assert.deepEqual(errors, []); assert.equal(requests, 1);
});

test('failure recovers sequentially and stopping clears the next refresh', async () => {
  let requests = 0;
  const errors = [], values = [];
  let recovered;
  const ready = new Promise(resolve => { recovered = resolve; });
  const stop = pollCamera(async () => {
    requests++;
    if (requests === 1) throw new Error('offline');
    return 'frame';
  }, value => { values.push(value); recovered(); }, error => errors.push(error.message), () => 100, 1);
  await ready; stop(); await flush();
  assert.deepEqual(errors, ['offline']); assert.deepEqual(values, ['frame']); assert.equal(requests, 2);
});
