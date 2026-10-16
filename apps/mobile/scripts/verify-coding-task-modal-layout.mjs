/**
 * Contract: Code Factory task modals must fit inside the window on narrow
 * Android cover screens (Galaxy Z Fold 3 ≈ 340×926 dp). Percentage maxHeight
 * with flex:1 overflows the y-axis so footer actions stay unreachable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

/** Fold 3 cover approximation used by CodingTasksTab narrow layout (~340dp wide). */
const FOLD3_COVER = { width: 340, height: 926 };

async function loadLayoutModule() {
  const sourcePath = path.join(root, 'lib/codingTaskModalLayout.ts');
  assert.ok(fs.existsSync(sourcePath), 'lib/codingTaskModalLayout.ts must exist');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
    fileName: sourcePath,
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  return import(dataUrl);
}

test('codingTaskSheetMaxHeight fits Fold 3 cover after backdrop padding', async () => {
  const { codingTaskSheetMaxHeight, CODING_TASK_MODAL_BACKDROP_PADDING } = await loadLayoutModule();

  const max = codingTaskSheetMaxHeight(FOLD3_COVER.height);
  assert.equal(CODING_TASK_MODAL_BACKDROP_PADDING, 12);
  assert.equal(max, FOLD3_COVER.height - 24);
  assert.ok(max < FOLD3_COVER.height, 'sheet must leave room for backdrop padding');
  assert.ok(max > 700, 'Fold cover still has a usable sheet height');
});

test('codingTaskSheetMaxHeight subtracts safe-area insets', async () => {
  const { codingTaskSheetMaxHeight } = await loadLayoutModule();
  const max = codingTaskSheetMaxHeight(800, { topInset: 24, bottomInset: 16, padding: 12 });
  assert.equal(max, 800 - 24 - 24 - 16);
});

test('CodingTasksTab bounds detail modal with pixel maxHeight, not flex+percent', () => {
  const source = fs.readFileSync(
    path.join(root, 'components/jarvis/CodingTasksTab.tsx'),
    'utf8',
  );

  assert.match(source, /codingTaskSheetMaxHeight/);
  assert.doesNotMatch(
    source,
    /detailModal:\s*\{\s*flex:\s*1,\s*maxHeight:\s*['"]92%['"]/,
  );
  assert.match(source, /maxHeight:\s*sheetMaxHeight/);
});
