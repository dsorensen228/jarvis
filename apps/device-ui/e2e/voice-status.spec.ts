import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

async function setupVoice(page: Page) {
  let events: WebSocketRoute;
  let taps = 0;
  await page.route('https://**/*', route => route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/config') return route.fulfill({ json: { device_id: 'test-voice', voice_ui: true, spotify_ready: false, music_tab_enabled: true } });
    if (path === '/api/voice/tap') {
      taps += 1;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/system/volume') return route.fulfill({ json: { percent: 50, muted: false } });
    if (path === '/api/lights/room-state') return route.fulfill({ json: { room_bound: false } });
    if (path === '/api/banter') return route.fulfill({ json: { paired: false } });
    return route.fulfill({ json: { items: [], timers: [], alarms: [] } });
  });
  const state = (phase: string, active = phase !== 'idle', connected = true) => {
    events.send(JSON.stringify({ type: 'voice.state', data: { phase, active, connected } }));
  };
  await page.routeWebSocket('**/api/events', socket => {
    events = socket;
    state('idle');
  });
  await page.goto('/#/standby');
  await expect(page.getByRole('button', { name: 'Start voice chat' })).toBeVisible();
  return { state, taps: () => taps };
}

const animation = (page: Page, pseudo: string) => page.locator('.avatar-wrap').evaluate(
  (node, element) => getComputedStyle(node, element).animationName, pseudo
);

test('actual voice events keep listening, thinking, and speaking distinct without shifting the clock', async ({ page }, testInfo) => {
  const voice = await setupVoice(page);
  const avatar = page.locator('.avatar-wrap');
  const status = page.locator('#standby-voice-status');
  const originalClock = await page.locator('.standby-clock').boundingBox();
  for (const [phase, label, motion, pseudo] of [
    ['connecting', 'Starting…', 'voice-thinking-orbit', '::after'],
    ['listening', 'Listening', 'voice-listening-ripple', '::after'],
    ['thinking', 'Thinking', 'voice-thinking-orbit', '::after'],
    ['speaking', 'Speaking', 'voice-speaking-breathe', '::before'],
    ['listening', 'Listening', 'voice-listening-ripple', '::after'],
  ]) {
    voice.state(phase);
    await expect(status).toHaveText(label);
    await expect(avatar).toHaveAttribute('aria-label', 'Stop voice chat');
    expect(await animation(page, pseudo)).toBe(motion);
    expect(await page.locator('.standby-clock').boundingBox()).toEqual(originalClock);
    const box = (await avatar.boundingBox())!;
    const nav = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
    expect(box.y - 26).toBeGreaterThanOrEqual(0);
    expect(originalClock!.y + originalClock!.height).toBeLessThan(nav.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (['listening', 'thinking', 'speaking'].includes(phase)) {
      await page.screenshot({ path: testInfo.outputPath(`voice-${phase}.png`) });
    }
    if (phase === 'thinking') {
      await page.clock.install();
      await page.clock.runFor(7000);
      await expect(status).toHaveText('Thinking');
    }
  }
  voice.state('idle');
  await expect(status).toBeEmpty();
  await expect(avatar).toHaveAttribute('aria-label', 'Start voice chat');
  expect(await animation(page, '::after')).toBe('none');
});

test('tap stops a thinking session immediately, and announcement speech does not imply a session', async ({ page }) => {
  const voice = await setupVoice(page);
  const avatar = page.locator('.avatar-wrap');
  voice.state('thinking');
  await expect(avatar).toHaveAttribute('aria-label', 'Stop voice chat');
  await avatar.click();
  await expect(page.locator('#standby-voice-status')).toBeEmpty();
  await expect.poll(voice.taps).toBe(1);
  voice.state('speaking', false);
  await expect(page.locator('#standby-voice-status')).toHaveText('Speaking');
  await expect(avatar).toHaveAttribute('aria-label', 'Start voice chat');
  voice.state('idle');
  await expect(avatar).not.toHaveClass(/voice-speaking/);
});

test('offline state suppresses stale animation and a fresh snapshot restores it', async ({ page }) => {
  const voice = await setupVoice(page);
  await page.clock.install();
  voice.state('thinking', true, false);
  await expect(page.locator('#standby-voice-status')).toHaveText('Thinking');
  await page.clock.runFor(3500);
  await expect(page.locator('.avatar-wrap')).toHaveClass(/voice-unreachable/);
  await expect(page.locator('#standby-voice-status')).toBeEmpty();
  expect(await animation(page, '::after')).toBe('none');
  voice.state('listening');
  await expect(page.locator('.avatar-wrap')).toHaveClass(/voice-listening/);
  await expect(page.locator('#standby-voice-status')).toHaveText('Listening');
});

test('reduced motion retains distinct solid and segmented rings with readable state labels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const voice = await setupVoice(page);
  voice.state('listening');
  await expect(page.locator('#standby-voice-status')).toHaveText('Listening');
  expect(await animation(page, '::after')).toBe('none');
  expect(await page.locator('.avatar-wrap').evaluate(node => getComputedStyle(node, '::after').backgroundImage)).toBe('none');
  voice.state('thinking');
  await expect(page.locator('#standby-voice-status')).toHaveText('Thinking');
  expect(await animation(page, '::after')).toBe('none');
  expect(await page.locator('.avatar-wrap').evaluate(node => getComputedStyle(node, '::after').backgroundImage)).toContain('conic-gradient');
});

test('a newer voice snapshot wins over a delayed tap failure', async ({ page }) => {
  const voice = await setupVoice(page);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/voice/tap', async route => {
    requested = true;
    await waiting;
    await route.fulfill({ status: 503, json: { detail: 'Late failure' } });
  });
  voice.state('thinking');
  const avatar = page.getByRole('button', { name: 'Stop voice chat' });
  await expect(avatar).toBeVisible();
  await avatar.click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('#standby-voice-status')).toBeEmpty();
  voice.state('speaking');
  await expect(page.locator('#standby-voice-status')).toHaveText('Speaking');
  const response = page.waitForResponse('**/api/voice/tap');
  release();
  await response;
  await page.clock.install();
  await page.clock.runFor(1500);
  await expect(page.locator('#standby-voice-status')).toHaveText('Speaking');
  await expect(page.getByText("Couldn't stop voice", { exact: true })).toHaveCount(0);
});
