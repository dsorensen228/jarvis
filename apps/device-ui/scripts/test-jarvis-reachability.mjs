/**
 * Unit checks for Jarvis reachability chrome on the voice kiosk.
 * Bundles the TypeScript helper with esbuild so Node 20 can run it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = mkdtempSync(join(tmpdir(), 'jarvis-reachability-'));
const outfile = join(outdir, 'jarvisReachability.mjs');

await esbuild.build({
  entryPoints: [join(__dirname, '../src/jarvisReachability.ts')],
  outfile,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

const { JARVIS_OFFLINE_GRACE_MS, shouldShowJarvisUnreachable } = await import(
  pathToFileURL(outfile).href
);

function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    rmSync(outdir, { recursive: true, force: true });
    throw err;
  }
}

check('healthy connection stays quiet', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: true,
      backendConnected: true,
      unreachableForMs: 60_000,
    }),
    false
  );
});

check('brief backend drop stays quiet within grace', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: true,
      backendConnected: false,
      unreachableForMs: JARVIS_OFFLINE_GRACE_MS - 1,
    }),
    false
  );
});

check('sustained backend drop shows unreachable', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: true,
      backendConnected: false,
      unreachableForMs: JARVIS_OFFLINE_GRACE_MS,
    }),
    true
  );
});

check('local events socket down shows unreachable after grace', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: false,
      backendConnected: true,
      unreachableForMs: JARVIS_OFFLINE_GRACE_MS,
    }),
    true
  );
});

check('startup before first voice.state stays quiet within grace', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: true,
      backendConnected: null,
      unreachableForMs: JARVIS_OFFLINE_GRACE_MS - 1,
    }),
    false
  );
});

check('no voice.state after grace shows unreachable', () => {
  assert.equal(
    shouldShowJarvisUnreachable({
      eventsOpen: true,
      backendConnected: null,
      unreachableForMs: JARVIS_OFFLINE_GRACE_MS,
    }),
    true
  );
});

rmSync(outdir, { recursive: true, force: true });
console.log('test-jarvis-reachability: all passed');
