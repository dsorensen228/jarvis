import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  jarvisAvatarAriaLabel,
  jarvisAvatarPhaseClass,
  INTERACTIONS_MUTE_LONG_PRESS_MS,
} from '../src/jarvisAvatar.ts';
import { postInteractionsMute } from '../src/api.ts';

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
  'utf8'
);

test('long-press mute uses the same hold threshold as system volume', () => {
  assert.equal(INTERACTIONS_MUTE_LONG_PRESS_MS, 500);
});

test('device styles never grey or slash the Jarvis avatar for interactions mute', () => {
  assert.doesNotMatch(stylesCss, /voice-interactions-muted/);
});

test('interactions mute never restyles or relabels the Jarvis avatar', () => {
  assert.equal(
    jarvisAvatarPhaseClass({
      jarvisUnreachable: false,
      phase: 'listening',
    }),
    ' voice-listening'
  );
  assert.equal(
    jarvisAvatarPhaseClass({
      jarvisUnreachable: true,
      phase: 'idle',
    }),
    ' voice-unreachable'
  );
  assert.equal(
    jarvisAvatarAriaLabel({
      jarvisUnreachable: false,
      phase: 'idle',
      voiceTurn: false,
    }),
    'Start voice chat'
  );
  assert.equal(
    jarvisAvatarAriaLabel({
      jarvisUnreachable: false,
      phase: 'listening',
      voiceTurn: true,
    }),
    'Stop voice chat'
  );
  assert.doesNotMatch(
    jarvisAvatarAriaLabel({
      jarvisUnreachable: false,
      phase: 'idle',
      voiceTurn: false,
    }),
    /mute/i
  );
});

test('unmuted avatar is tap-only with no long-press mute cue', () => {
  assert.equal(
    jarvisAvatarPhaseClass({
      jarvisUnreachable: false,
      phase: 'idle',
    }),
    ''
  );
  assert.doesNotMatch(
    jarvisAvatarAriaLabel({
      jarvisUnreachable: false,
      phase: 'idle',
      voiceTurn: false,
    }),
    /long-press/i
  );
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('browser posts interactions mute to the local voice facade', async () => {
  const calls: [unknown, unknown][] = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options?.method || 'GET']);
    return Response.json({
      ok: true,
      active: false,
      phase: 'idle',
      connected: true,
      interactions_muted: true,
    });
  };
  assert.deepEqual(await postInteractionsMute(true), {
    ok: true,
    active: false,
    phase: 'idle',
    connected: true,
    interactions_muted: true,
  });
  assert.deepEqual(calls, [['/api/voice/interactions-mute', 'POST']]);
});
