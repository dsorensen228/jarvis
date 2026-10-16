import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchCodeTasks, fetchCodeTaskOutput, followUpCodeTask, fetchResearchTasks, fetchResearchTask, fetchResearchTaskOutput, fetchResearchReport, createResearchTask, cancelResearchTask, startResearchTaskRecording, stopResearchTaskRecording, type CodeTask } from '../src/api.ts';
import { mergeTasks, mergeOutput, taskResult } from '../src/codeTaskState.ts';

const task = (id: string, status: CodeTask['status'] = 'running', updated_at = '2026-09-27T12:00:00Z'): CodeTask => ({ id, status, updated_at, created_at: id, prompt: `Task ${id}`, workflow_id: id });
test('refresh keeps loaded history, deduplicates page boundaries, and preserves newer live updates', () => {
  const rows = mergeTasks([task('3', 'success', '2026-09-27T12:01:00Z'), task('2'), task('1')], [task('4'), task('3')], 'all');
  assert.deepEqual(rows.map((row) => row.id), ['4', '3', '2', '1']);
  assert.equal(rows[1].status, 'success');
});
test('status transition removes finished tasks from active results', () => {
  const rows = mergeTasks([task('1')], [task('1', 'success', '2026-09-27T12:01:00Z')], 'active');
  assert.deepEqual(rows, []);
  assert.deepEqual(mergeTasks([], [task('1'), task('2', 'cancelled')], 'history').map((row) => row.id), ['2']);
});
test('resumed output is deduplicated and bounded in sequence order', () => {
  const output = (seq: number) => ({ seq, kind: 'assistant' as const, text: `${seq}`, created_at: '' });
  const rows = mergeOutput(Array.from({ length: 500 }, (_, i) => output(i + 1)), [output(499), output(501)]);
  assert.equal(rows.length, 500); assert.equal(rows[0].seq, 2); assert.equal(rows.at(-1)?.seq, 501);
});
test('final result never mistakes stdout for the agent answer', () => {
  assert.equal(taskResult({ ...task('1'), stdout: '{"type":"item.started"}' }), null);
  assert.equal(taskResult({ ...task('1'), agent_output: { result: 'Done.' } }), 'Done.');
});
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('list, output, and follow-up preserve the API contract and opaque cursor', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json({}); };
  await fetchCodeTasks('history', 'opaque+/=');
  await fetchCodeTaskOutput('task/1', 34);
  await followUpCodeTask('task/1', 'Run the checks again');
  const query = new URL(calls[0].url, 'http://localhost').searchParams;
  assert.equal(query.get('view'), 'history'); assert.equal(query.get('cursor'), 'opaque+/='); assert.equal(query.get('limit'), '30');
  assert.equal(calls[1].url, '/api/code-tasks/task%2F1/output?after=34&limit=100');
  assert.equal(calls[2].options?.method, 'POST');
  assert.equal(calls[2].url, '/api/code-tasks/task%2F1/follow-up');
  assert.deepEqual(JSON.parse(String(calls[2].options?.body)), { prompt: 'Run the checks again' });
});
test('follow-up errors remain actionable and do not look successful', async () => {
  globalThis.fetch = async () => Response.json({ detail: 'Task is unavailable' }, { status: 404 });
  await assert.rejects(() => followUpCodeTask('missing', 'Keep going'), /Task is unavailable/);
});

test('authoritative short page removes completed rows missing from active results', () => {
  const rows = mergeTasks([task('2'), task('1')], [task('2')], 'active', true);
  assert.deepEqual(rows.map((row) => row.id), ['2']);
});
test('timestamp offsets cannot regress a newer status update', () => {
  const rows = mergeTasks([task('1', 'success', '2026-09-27T12:01:00+00:00')], [task('1', 'running', '2026-09-27T12:00:00Z')], 'all');
  assert.equal(rows[0].status, 'success');
  const equalInstant = mergeTasks([task('1', 'running', '2026-09-27T12:00:00Z')], [task('1', 'success', '2026-09-27T12:00:00+00:00')], 'all');
  assert.equal(equalInstant[0].status, 'success');
});

test('research requests stay isolated, encode IDs and cursors, and carry report depth', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json({}); };
  await fetchResearchTasks('active', 'cursor+/=');
  await fetchResearchTask('research/1');
  await fetchResearchTaskOutput('research/1', 12);
  await createResearchTask('Compare batteries', 'gpt-6-sol', 'in_depth');
  await cancelResearchTask('research/1');
  await startResearchTaskRecording();
  await stopResearchTaskRecording();
  const controller = new AbortController();
  await fetchResearchReport('research/1', controller.signal);
  const query = new URL(calls[0].url, 'http://localhost').searchParams;
  assert.equal(query.get('view'), 'active'); assert.equal(query.get('cursor'), 'cursor+/=');
  assert.equal(calls[1].url, '/api/research-tasks/research%2F1');
  assert.equal(calls[2].url, '/api/research-tasks/research%2F1/output?after=12&limit=100');
  assert.deepEqual(JSON.parse(String(calls[3].options?.body)), { prompt: 'Compare batteries', model: 'gpt-6-sol', verbosity: 'in_depth' });
  assert.equal(calls[4].url, '/api/research-tasks/research%2F1/cancel');
  assert.equal(calls[5].url, '/api/research-tasks/recording/start');
  assert.equal(calls[6].url, '/api/research-tasks/recording/stop');
  assert.equal(calls[7].url, '/api/research-tasks/research%2F1/report');
  assert.equal(calls[7].options?.signal, controller.signal);
  assert.equal(calls[7].options?.cache, 'no-store');
  assert.ok(calls.every(call => call.url.startsWith('/api/research-tasks')));
});
