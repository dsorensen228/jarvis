import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../lib/codeTaskPageRequests.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { CodeTaskPageRequests } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('repeated end events during refresh coalesce into one page using its updated cursor', async () => {
  const requests = new CodeTaskPageRequests();
  const calls = [];
  let cursor = 'before-refresh';
  let releaseRefresh;
  const response = new Promise((resolve) => { releaseRefresh = resolve; });
  const load = async (more) => {
    if (more && !cursor) return;
    const request = requests.begin(more);
    if (!request) return;
    calls.push(more ? cursor : 'head');
    cursor = more ? null : await response;
    if (requests.finish(request, true, cursor != null) && cursor) await load(true);
  };
  const refresh = load(false);
  await Promise.all([load(true), load(true), load(true)]);
  assert.deepEqual(calls, ['head']);
  releaseRefresh('after-refresh');
  await refresh;
  assert.deepEqual(calls, ['head', 'after-refresh']);
});

test('end events during a page request do not queue another page', () => {
  const requests = new CodeTaskPageRequests();
  const current = requests.begin(true);
  assert.equal(requests.begin(true), null);
  assert.equal(requests.begin(true), null);
  assert.equal(requests.finish(current, true, true), false);
});

test('failed refresh drops pending pagination without an automatic retry loop', () => {
  const requests = new CodeTaskPageRequests();
  const failed = requests.begin(false);
  requests.begin(true);
  assert.equal(requests.finish(failed, false, true), false);
  const laterRefresh = requests.begin(false);
  assert.ok(laterRefresh);
  assert.equal(requests.finish(laterRefresh, true, true), false);
});

test('view, visibility, or unmount reset discards pending intent and isolates stale completion', () => {
  const requests = new CodeTaskPageRequests();
  const previous = requests.begin(false);
  requests.begin(true);
  requests.reset();
  const current = requests.begin(false);
  assert.ok(current);
  assert.equal(requests.finish(previous, true, true), false);
  assert.equal(requests.begin(false), null, 'old completion must not release the new request');
  assert.equal(requests.finish(current, true, true), false, 'old pagination intent must not survive reset');
});

test('a refreshed page with no next cursor drops the deferred request', () => {
  const requests = new CodeTaskPageRequests();
  const current = requests.begin(false);
  requests.begin(true);
  assert.equal(requests.finish(current, true, false), false);
  const later = requests.begin(false);
  assert.equal(requests.finish(later, true, true), false);
});
