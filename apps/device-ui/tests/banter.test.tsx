import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BanterButton } from '../src/ui/BanterButton.tsx';
import { INTERACTIONS_MUTE_LONG_PRESS_MS } from '../src/jarvisAvatar.ts';
import { fetchBanterState, postBanterTrigger, type BanterState } from '../src/api.ts';

const ready: BanterState = {
  paired: true,
  available: true,
  busy: false,
  status: 'ready',
  source_device_id: 'sherman',
};

function render(state: BanterState | null, overrides = {}) {
  return renderToStaticMarkup(
    <BanterButton
      standby={true}
      state={state}
      pending={false}
      voiceActive={false}
      onClick={() => undefined}
      onMuteToggle={() => undefined}
      {...overrides}
    />
  );
}

test('robot control appears only on standby with a confirmed Sherman pairing', () => {
  assert.equal(render(null), '');
  assert.equal(render({ ...ready, paired: false, status: 'unpaired' }), '');
  assert.equal(render(ready, { standby: false }), '');
  const html = render(ready);
  assert.match(html, /Start a Sherman and Jarvis interaction/);
  assert.match(html, /long-press to mute interactions/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /\sdisabled=/);
});

test('offline pairing stays visible and tap-blocked but still long-pressable', () => {
  const html = render({ ...ready, available: false, status: 'offline' });
  assert.match(html, /Sherman is unavailable/);
  assert.match(html, /long-press to mute interactions/);
  assert.doesNotMatch(html, /\sdisabled=/);
  assert.match(html, /aria-disabled="true"/);
});

test('queued, running, and in-flight requests prevent a second trigger', () => {
  for (const status of ['queued', 'running'] as const) {
    const html = render({ ...ready, status, busy: true });
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /\sdisabled=/);
  }
  assert.match(render(ready, { pending: true }), /aria-disabled="true"/);
});

test('active voice sessions block tap but muted interactions stay long-pressable', () => {
  assert.match(render(ready, { voiceActive: true }), /can chat when idle/);
  assert.match(render(ready, { voiceActive: true }), /aria-disabled="true"/);
  assert.doesNotMatch(render(ready, { voiceActive: true }), /\sdisabled=/);

  const muted = render(ready, { interactionsMuted: true });
  assert.match(muted, /Interactions muted — long-press to unmute/);
  assert.doesNotMatch(muted, /\sdisabled=/);
  assert.doesNotMatch(muted, /aria-disabled="true"/);
  assert.match(muted, /aria-pressed="true"/);
  // Same single diagonal slash the volume mute glyph uses — nothing else.
  assert.match(muted, /M19 5l-14 14/);
});

test('unmuted sherman robot has no mute slash', () => {
  const html = render(ready);
  assert.doesNotMatch(html, /M19 5l-14 14/);
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

test('sherman mute hold matches system volume long-press threshold', () => {
  assert.equal(INTERACTIONS_MUTE_LONG_PRESS_MS, 500);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('browser uses only the local pairing and trigger facade', async () => {
  const calls: [unknown, unknown][] = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options?.method || 'GET']);
    return Response.json(ready);
  };
  assert.deepEqual(await fetchBanterState(), ready);
  assert.deepEqual(await postBanterTrigger(), ready);
  assert.deepEqual(calls, [['/api/banter', 'GET'], ['/api/banter/trigger', 'POST']]);
});

test('trigger rejection preserves the actionable server error', async () => {
  globalThis.fetch = async () => Response.json({ detail: 'Sherman is offline' }, { status: 409 });
  await assert.rejects(postBanterTrigger, /Sherman is offline/);
});
