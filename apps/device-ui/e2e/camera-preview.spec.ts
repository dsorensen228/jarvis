import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';
import { emptyClock } from './timers-fixture';

async function setupPreview(page: Page, path = '/standby', cameraListReady?: Promise<void>) {
  await setupSpotify(page, { ready: false });
  let events: WebSocketRoute;
  const snapshots: string[] = [];
  await page.routeWebSocket('**/api/events', socket => {
    events = socket;
    socket.send(JSON.stringify({ type: 'voice.state', data: { active: false, phase: 'idle', connected: true } }));
  });
  await page.route('**/api/cameras', async route => {
    await cameraListReady;
    return route.fulfill({ json: [
      { id: 'front', device_name: 'Front door' },
      { id: 'side door', device_name: 'Side door' },
    ] });
  });
  await page.route('**/api/cameras/*/snapshot?*', route => {
    snapshots.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]));
    return route.fulfill({ contentType: 'image/svg+xml', body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#352944"/></svg>' });
  });
  await page.goto(`/#${path}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Freeze time after bootstrap so the 9,999/10,000 ms boundary is deterministic.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const action = (action: string, args: Record<string, unknown>) => events.send(JSON.stringify({
    type: 'client.action', data: { action, arguments: args },
  }));
  return { action, show: (camera: unknown) => action('show_camera_preview', { camera_device_id: camera }), snapshots };
}

test('door alert shows its camera for ten seconds and restores standby without history entries', async ({ page }) => {
  const preview = await setupPreview(page);
  const historyLength = await page.evaluate(() => history.length);
  preview.show('side door');
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await expect(page.getByRole('tab', { name: 'Side door' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cam-stream:visible')).toBeVisible();
  expect(preview.snapshots).toContain('side door');
  await page.clock.runFor(9999);
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await page.clock.runFor(1);
  await expect(page).toHaveURL(/#\/standby$/);
  await expect(page.getByRole('button', { name: 'Start voice chat' })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test('return keeps the complete nested location, history state, and unfinished editor', async ({ page }) => {
  await page.addInitScript(() => history.replaceState({ usr: { selected: 'saved-view' } }, ''));
  const preview = await setupPreview(page, '/timer/alarms?view=weekday#draft');
  await page.getByRole('button', { name: '+ New alarm' }).click();
  await page.getByRole('button', { name: 'Alarm name Add a name' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('School run draft');
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await expect(page.getByRole('dialog', { name: 'Alarm name' })).toBeHidden();
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/timer\/alarms\?view=weekday#draft$/);
  await expect(page.getByRole('dialog', { name: 'Alarm name' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('School run draft');
  expect(await page.evaluate(() => history.state.usr)).toEqual({ selected: 'saved-view' });
});

test('overlapping and repeated alerts extend the preview and retain one original return screen', async ({ page }) => {
  const preview = await setupPreview(page, '/timer/alarms');
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await page.clock.runFor(6000);
  preview.show('side door');
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await page.clock.runFor(6000);
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  preview.show('side door');
  // Wait for the event to replace history state even though the URL is unchanged.
  await expect.poll(() => page.evaluate(() => history.state.usr.cameraPreview)).toBe(3);
  await page.clock.runFor(9999);
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await page.clock.runFor(1);
  await expect(page).toHaveURL(/#\/timer\/alarms$/);
});

test('manual navigation wins, including selecting the previewed camera itself', async ({ page }) => {
  const preview = await setupPreview(page, '/timer');
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await page.getByRole('tab', { name: 'Front door' }).click();
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  preview.show('side door');
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/standby$/);
});

test('explicit voice navigation cancels the return and new previews start from the chosen screen', async ({ page }) => {
  const preview = await setupPreview(page);
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  preview.action('navigate_device_ui', { destination: 'timer_alarms' });
  await expect(page).toHaveURL(/#\/timer\/alarms$/);
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/timer\/alarms$/);
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/timer\/alarms$/);
});

test('near-expired idle timeout cannot interrupt the preview or discard its return screen', async ({ page }) => {
  const preview = await setupPreview(page, '/timer/alarms');
  await page.clock.fastForward(299_000);
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await page.clock.runFor(9999);
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await page.clock.runFor(1);
  await expect(page).toHaveURL(/#\/timer\/alarms$/);
});

test('bad metadata is ignored and an unavailable camera still returns on time', async ({ page }) => {
  const preview = await setupPreview(page);
  for (const bad of [null, '', '   ', 42, {}]) preview.show(bad);
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/standby$/);
  await page.route('**/api/cameras/front/snapshot?*', route => route.fulfill({ status: 503 }));
  preview.show('front');
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await expect(page.getByText('Camera unavailable')).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(/#\/standby$/);
});

test('a delayed camera list on the hidden screen cannot replace the announced camera', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const preview = await setupPreview(page, '/cameras', waiting);
  preview.show('side door');
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  release();
  await expect(page.getByRole('tab', { name: 'Side door' })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(9999);
  await expect(page).toHaveURL(/#\/cameras\/side%20door$/);
  await page.clock.runFor(1);
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await expect(page.getByRole('tab', { name: 'Front door' })).toHaveAttribute('aria-selected', 'true');
});

for (const alreadyRinging of [true, false]) {
  test(`camera takes priority over an alarm ${alreadyRinging ? 'already ringing' : 'due during the preview'}`, async ({ page }) => {
    await page.addInitScript(({ state, alreadyRinging }) => {
      Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
      Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
      const now = Date.now();
      state.timers = [{ id: 'tea', label: 'Tea', status: 'running', durationMs: 60_000,
        remainingMs: 0, endTime: now + (alreadyRinging ? -1000 : 5000), createdAt: now - 60_000 }];
      localStorage.setItem('jarvis_timer_runtime_v2', JSON.stringify(state));
    }, { state: emptyClock(), alreadyRinging });
    const preview = await setupPreview(page);
    if (alreadyRinging) await expect(page.getByRole('alertdialog')).toBeVisible();
    preview.show('front');
    await expect(page).toHaveURL(/#\/cameras\/front$/);
    await page.clock.runFor(6000);
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(page.locator('.cam-stream:visible')).toBeVisible();
    // Test real hit visibility as well as geometry, so an opaque overlay cannot cover the feed.
    expect(await page.locator('.cam-stream:visible').evaluate(image => {
      const rect = image.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === image;
    })).toBe(true);
    await page.clock.runFor(4000);
    await expect(page).toHaveURL(/#\/standby$/);
    await expect(page.getByRole('alertdialog')).toContainText('Tea');
    await expect(page.getByRole('alertdialog')).toBeVisible();
  });
}
