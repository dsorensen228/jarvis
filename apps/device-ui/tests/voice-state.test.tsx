import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceUiStateFromEvent } from '../src/VoiceTurnContext.tsx';
import {
  jarvisAvatarAriaLabel,
  jarvisAvatarPhaseClass,
  jarvisAvatarStatusLabel,
} from '../src/jarvisAvatar.ts';

test('a conversation keeps listening, waiting, and playback visibly distinct', () => {
  const events = [
    { active: false, phase: 'idle' },
    { active: true, phase: 'connecting' },
    { active: true, phase: 'listening' },
    { active: true, phase: 'thinking' },
    { active: true, phase: 'speaking' },
    { active: true, phase: 'listening' },
    { active: false, phase: 'idle' },
  ];
  const states = events.map(voiceUiStateFromEvent);
  assert.deepEqual(states.map(({ phase }) => phase), events.map(({ phase }) => phase));
  assert.deepEqual(
    states.map((state) => jarvisAvatarStatusLabel({ ...state, jarvisUnreachable: false })),
    ['', 'Starting…', 'Listening', 'Thinking', 'Speaking', 'Listening', '']
  );
  assert.deepEqual(
    states.map((state) => jarvisAvatarPhaseClass({ ...state, jarvisUnreachable: false })),
    ['', ' voice-connecting', ' voice-listening', ' voice-thinking', ' voice-speaking', ' voice-listening', '']
  );
  for (const state of states) {
    assert.equal(
      jarvisAvatarAriaLabel({ ...state, jarvisUnreachable: false }),
      state.voiceTurn ? 'Stop voice chat' : 'Start voice chat'
    );
  }
});

test('announcements show speech without claiming there is a session to stop', () => {
  const state = voiceUiStateFromEvent({ active: false, phase: 'speaking' });
  const input = { ...state, jarvisUnreachable: false };
  assert.equal(state.voiceTurn, false);
  assert.equal(jarvisAvatarStatusLabel(input), 'Speaking');
  assert.equal(jarvisAvatarPhaseClass(input), ' voice-speaking');
  assert.equal(jarvisAvatarAriaLabel(input), 'Start voice chat');
});

test('unreachable state takes priority over a stale listening or thinking phase', () => {
  for (const phase of ['listening', 'thinking', 'speaking'] as const) {
    const input = { phase, voiceTurn: true, jarvisUnreachable: true };
    assert.equal(jarvisAvatarPhaseClass(input), ' voice-unreachable');
    assert.equal(jarvisAvatarStatusLabel(input), '');
    assert.equal(jarvisAvatarAriaLabel(input), "Can't reach Jarvis");
  }
});

test('errors keep the real session stop action and transient start remains cancelable', () => {
  for (const voiceTurn of [false, true]) {
    const input = { phase: 'error' as const, voiceTurn, jarvisUnreachable: false };
    assert.equal(jarvisAvatarStatusLabel(input), 'Voice error');
    assert.equal(jarvisAvatarAriaLabel(input), voiceTurn ? 'Stop voice chat' : 'Start voice chat');
  }
  assert.equal(jarvisAvatarAriaLabel({
    phase: 'connecting', voiceTurn: false, jarvisUnreachable: false,
  }), 'Stop voice chat');
});

test('unrecognized event phases have a safe fallback without inventing a session', () => {
  assert.deepEqual(voiceUiStateFromEvent({ active: true, phase: 'unknown' }), {
    voiceTurn: true, phase: 'listening',
  });
  assert.deepEqual(voiceUiStateFromEvent({ active: 'false', phase: 'unknown' }), {
    voiceTurn: false, phase: 'idle',
  });
});
