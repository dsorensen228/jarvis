import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/codeTaskState.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { mergeTasks, mergeOutput, taskResult } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const task = (id, status = 'running', updated_at = '2026-09-27T12:00:00Z') => ({ id, status, updated_at, created_at: id, prompt: `Task ${id}` });
test('refresh preserves loaded history and newer streamed state', () => {
  const rows = mergeTasks([task('3', 'success', '2026-09-27T12:01:00Z'), task('2'), task('1')], [task('4'), task('3')], 'all');
  assert.deepEqual(rows.map((row) => row.id), ['4', '3', '2', '1']); assert.equal(rows[1].status, 'success');
});
test('active and history filters follow a task across completion', () => {
  assert.deepEqual(mergeTasks([task('1')], [task('1', 'success', '2026-09-27T12:01:00Z')], 'active'), []);
  assert.deepEqual(mergeTasks([], [task('1'), task('2', 'cancelled')], 'history').map((row) => row.id), ['2']);
});
test('resuming does not duplicate streamed output and caps retained activity', () => {
  const output = (seq) => ({ seq, kind: 'assistant', text: `${seq}` });
  const rows = mergeOutput(Array.from({ length: 500 }, (_, i) => output(i + 1)), [output(499), output(501)]);
  assert.equal(rows.length, 500); assert.equal(rows[0].seq, 2); assert.equal(rows.at(-1).seq, 501);
});
test('raw logs cannot masquerade as final output', () => {
  assert.equal(taskResult({ ...task('1'), stdout: '{"type":"item.started"}' }), null);
  assert.equal(taskResult({ ...task('1'), agent_output: { result: 'Done.' } }), 'Done.');
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
