import { test, expect, type Locator, type Page } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';

// Every integration is intercepted by setupSpotify. No test contacts a household TV.
const remoteKeys = ['home', 'back', 'up', 'down', 'left', 'right', 'select', 'rewind', 'fast_forward', 'replay', 'info', 'play', 'enter', 'backspace', 'search'];
const television = (id = 'office', name = 'Office TV') => ({
  id, name, room: 'Office', model: 'Roku TV', available: true, power: true,
  app: 'Work MBP', app_id: 'tvinput.hdmi1', apps: ['Home', 'Netflix', 'Disney Plus', 'Work MBP', 'HDMI\u00a04\u00a0(eARC)', 'Live\u00a0TV'],
  muted: null, volume_percent: null, playback_state: 'on', media_title: '', media_channel: '',
  supported_keys: [...remoteKeys, 'volume_up', 'volume_down', 'volume_mute', 'channel_up', 'channel_down', 'find_remote'],
  capabilities: ['app_launch', 'mute', 'playback', 'power', 'remote_keys', 'volume', 'text_input', 'search', 'channel_tune', 'find_remote'],
  is_room_default: id === 'office',
});

type Command = { id: string; action: string; parameters: Record<string, unknown> };

async function setupTV(page: Page) {
  await setupSpotify(page, { ready: false });
  const state = {
    screens: [television('living', 'Living Room TV'), television()],
    requests: [] as Command[],
    readFailure: '', commandFailure: '', reads: 0,
    holdCommand: undefined as Promise<void> | undefined,
  };
  await page.route('**/api/screens', async route => {
    state.reads += 1;
    if (state.readFailure) return route.fulfill({ status: 503, json: { detail: state.readFailure } });
    return route.fulfill({ json: state.screens });
  });
  await page.route('**/api/screens/*/commands', async route => {
    const { action, parameters } = route.request().postDataJSON();
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    state.requests.push({ id, action, parameters });
    if (state.holdCommand) await state.holdCommand;
    if (state.commandFailure) return route.fulfill({ status: 503, json: { detail: state.commandFailure } });
    return route.fulfill({ json: { ok: true } });
  });
  return state;
}

async function reachable(page: Page, control: Locator, minimumSize = 44) {
  await expect(control).toBeVisible();
  const rect = await control.boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(nav!.y + 1);
  expect(rect!.width).toBeGreaterThanOrEqual(minimumSize);
  expect(rect!.height).toBeGreaterThanOrEqual(minimumSize);
  // A geometrically visible button can still be covered by the fixed kiosk chrome.
  expect(await control.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || !!hit && el.contains(hit);
  })).toBe(true);
}

test('all remote controls fit above navigation on the real touchscreen sizes', async ({ page }, info) => {
  await setupTV(page); await page.goto('/#/tv');
  await expect(page.getByLabel('Screen', { exact: true })).toHaveValue('office');
  await expect(page.getByText('Work MBP', { exact: true })).toBeVisible();
  for (const name of ['Home', 'Back', 'Options', 'Replay', 'Up', 'Left', 'OK', 'Right', 'Down', 'Rewind', 'Play / pause', 'Fast forward', 'Power', 'Volume up', 'Volume down', 'Mute', 'Apps & inputs', 'Keyboard', 'More']) {
    await reachable(page, page.getByRole('button', { name, exact: true }));
  }
  expect(await page.locator('.tv-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('tv-remote.png') });
});

test('compact landscape keeps navigation and volume touch targets in reach', async ({ page }, info) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await setupTV(page); await page.goto('/#/tv');
  for (const name of ['Home', 'Back', 'Options', 'Replay', 'Up', 'Left', 'OK', 'Right', 'Down', 'Rewind', 'Play / pause', 'Fast forward', 'Power', 'Volume up', 'Volume down', 'Mute', 'Apps & inputs', 'Keyboard', 'More']) {
    await reachable(page, page.getByRole('button', { name, exact: true }));
  }
  await page.screenshot({ path: info.outputPath('tv-remote-compact.png') });
});

test('installed apps and renamed inputs launch exact sources, with actionable failure feedback', async ({ page }, info) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  await page.getByRole('button', { name: 'Apps & inputs', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Open Netflix', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('tv-apps.png') });
  await page.getByRole('button', { name: 'Open Netflix', exact: true }).tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'select_source', parameters: { source: 'Netflix' } });
  // Renamed inputs and nonbreaking spaces are valid HA sources, not app guesses.
  const input = page.getByRole('button', { name: 'Open HDMI 4 (eARC)', exact: true });
  await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apps & inputs', exact: true }).tap();
  state.commandFailure = 'TV did not accept the command';
  await input.tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'select_source', parameters: { source: 'HDMI\u00a04\u00a0(eARC)' } });
  await expect(page.getByText('TV did not accept the command', { exact: true })).toBeVisible();
  await reachable(page, page.getByRole('button', { name: 'Back to remote', exact: true }));
});

test('typing preserves case and spaces, supports caret editing, and sends text once', async ({ page }, info) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  await page.getByRole('button', { name: 'Keyboard', exact: true }).tap();
  const input = page.getByRole('textbox', { name: 'Text to send to TV', exact: true });
  await input.fill('A new Show!');
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 5));
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' });
  for (const key of await keyboard.getByRole('button').all()) await reachable(page, key);
  await reachable(page, page.getByRole('button', { name: 'Search TV', exact: true }));
  await reachable(page, page.getByRole('button', { name: 'Send text', exact: true }));
  await keyboard.getByRole('button', { name: 'b', exact: true }).tap();
  await expect(input).toHaveValue('A b Show!');
  await page.screenshot({ path: info.outputPath('tv-keyboard.png') });
  await page.getByRole('button', { name: 'Send text', exact: true }).first().tap();
  await expect.poll(() => state.requests.filter(row => row.action === 'text')).toEqual([{ id: 'office', action: 'text', parameters: { text: 'A b Show!' } }]);
  await expect(input).toHaveValue('');
  await input.fill('Space Jam');
  await page.getByRole('button', { name: 'Search TV', exact: true }).tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'search', parameters: { query: 'Space Jam' } });
  await page.getByRole('button', { name: 'Back to remote', exact: true }).tap();
  await page.getByRole('button', { name: 'More', exact: true }).tap();
  await page.getByRole('button', { name: 'Backspace on TV', exact: true }).tap();
  await page.getByRole('button', { name: 'Enter on TV', exact: true }).tap();
  await expect.poll(() => state.requests.filter(row => row.action === 'key').map(row => row.parameters.key)).toEqual(['backspace', 'enter']);
});

test('rapid navigation stays ordered and queued commands never migrate to a different TV', async ({ page }) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  let release!: () => void;
  state.holdCommand = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Up', exact: true }).tap();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByRole('button', { name: 'Right', exact: true }).tap();
  await page.getByRole('button', { name: 'OK', exact: true }).tap();
  expect(state.requests).toEqual([{ id: 'office', action: 'key', parameters: { key: 'up' } }]);
  release(); state.holdCommand = undefined;
  await expect.poll(() => state.requests.map(row => row.parameters.key)).toEqual(['up', 'right', 'select']);
  state.requests.length = 0;
  state.holdCommand = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Down', exact: true }).tap();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByRole('button', { name: 'Left', exact: true }).tap();
  await page.getByLabel('Screen', { exact: true }).selectOption('living');
  release(); state.holdCommand = undefined;
  await page.getByRole('button', { name: 'Home', exact: true }).tap();
  await expect.poll(() => state.requests.some(row => row.id === 'living' && row.parameters.key === 'home')).toBe(true);
  expect(state.requests.filter(row => row.parameters.key === 'left')).toEqual([]);
});

test('failed state refresh blocks stale actions until retry succeeds', async ({ page }) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeEnabled();
  state.readFailure = 'Home Assistant is unavailable';
  await page.getByRole('button', { name: 'Refresh TVs', exact: true }).tap();
  await expect(page.getByText('Home Assistant is unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeDisabled();
  await reachable(page, page.getByRole('button', { name: 'Retry', exact: true }));
  state.readFailure = '';
  await page.getByRole('button', { name: 'Retry', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeEnabled();
  expect(state.requests).toEqual([]);
});

test('unavailable TVs remain selectable and unsupported controls do not pretend to work', async ({ page }) => {
  const state = await setupTV(page);
  state.screens[0].available = false;
  state.screens[1].capabilities = ['app_launch', 'remote_keys', 'playback', 'text_input'];
  state.screens[1].supported_keys = remoteKeys;
  await page.goto('/#/tv');
  for (const name of ['Volume up', 'Volume down', 'Mute', 'Power']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.count()) await expect(button).toBeDisabled();
  }
  await page.getByLabel('Screen', { exact: true }).selectOption('living');
  await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]);
});

test('channel tuning and remote finder use only their supported actions', async ({ page }, info) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  await page.getByRole('button', { name: 'More', exact: true }).tap();
  await page.getByRole('button', { name: 'Find remote', exact: true }).tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'find_remote', parameters: {} });
  const keypad = page.locator('.tv-channel-keys');
  for (const digit of ['5', '.', '1']) {
    const key = keypad.getByRole('button', { name: digit, exact: true });
    await key.scrollIntoViewIfNeeded();
    await reachable(page, key);
    await key.tap();
  }
  await expect(page.getByRole('textbox', { name: 'TV channel', exact: true })).toHaveValue('5.1');
  await page.getByRole('button', { name: 'Tune channel', exact: true }).tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'channel', parameters: { channel: '5.1' } });
  await page.screenshot({ path: info.outputPath('tv-more.png') });
});

test('polling follows playback changes without replacing the selected TV', async ({ page }) => {
  await page.clock.install();
  const state = await setupTV(page); await page.goto('/#/tv');
  await page.getByLabel('Screen', { exact: true }).selectOption('living');
  const before = state.reads;
  state.screens[0].app = 'Disney Plus';
  state.screens[0].playback_state = 'playing';
  await page.clock.runFor(10_100);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(page.getByLabel('Screen', { exact: true })).toHaveValue('living');
  await expect(page.locator('.tv-current')).toContainText('Disney Plus');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(state.requests).toEqual([]);
});

test('large app libraries stay scrollable and leave the remote navigation accessible', async ({ page }, info) => {
  const state = await setupTV(page);
  state.screens[1].apps = [...state.screens[1].apps, ...Array.from({ length: 30 }, (_, index) => `Channel ${index + 1}`)];
  await page.goto('/#/tv');
  await page.getByRole('button', { name: 'Apps & inputs', exact: true }).tap();
  const lastSource = page.getByRole('button', { name: 'Open Channel 30', exact: true });
  await lastSource.scrollIntoViewIfNeeded();
  await reachable(page, lastSource);
  await reachable(page, page.getByRole('button', { name: 'Back to remote', exact: true }));
  await page.screenshot({ path: info.outputPath('tv-long-apps.png') });
  await lastSource.tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'office', action: 'select_source', parameters: { source: 'Channel 30' } });
});

test('unknown power and mute remain unknown after a toggle request', async ({ page }) => {
  const state = await setupTV(page);
  Object.assign(state.screens[1], { power: null, app: '', muted: null, playback_state: 'unknown' });
  await page.goto('/#/tv');
  await expect(page.locator('.tv-current')).toContainText('Power unknown');
  const mute = page.getByRole('button', { name: 'Mute', exact: true });
  await expect(mute).not.toHaveAttribute('aria-pressed');
  await mute.tap();
  await expect.poll(() => state.requests).toEqual([{ id: 'office', action: 'mute_toggle', parameters: {} }]);
  await expect(mute).toBeEnabled();
  await expect(mute).not.toHaveAttribute('aria-pressed');
  await expect(page.getByRole('button', { name: 'Play / pause', exact: true })).toBeVisible();
});

test('a late command failure from the previous TV does not poison the selected remote', async ({ page }) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  let release!: () => void;
  state.holdCommand = new Promise<void>(resolve => { release = resolve; });
  state.commandFailure = 'Previous TV stopped responding';
  await page.getByRole('button', { name: 'Up', exact: true }).tap();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByLabel('Screen', { exact: true }).selectOption('living');
  const failedResponse = page.waitForResponse(response => response.url().endsWith('/api/screens/office/commands') && response.status() === 503);
  release(); state.holdCommand = undefined;
  await failedResponse;
  await expect(page.getByRole('button', { name: 'Power', exact: true })).toBeEnabled();
  await expect(page.getByText('Previous TV stopped responding')).toHaveCount(0);
  state.commandFailure = '';
  await page.getByRole('button', { name: 'Right', exact: true }).tap();
  await expect.poll(() => state.requests).toContainEqual({ id: 'living', action: 'key', parameters: { key: 'right' } });
  await expect(page.getByText('Previous TV stopped responding')).toHaveCount(0);
});

test('successful text delivery retains a new draft entered during the request', async ({ page }) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  await page.getByRole('button', { name: 'Keyboard', exact: true }).tap();
  const input = page.getByRole('textbox', { name: 'Text to send to TV', exact: true });
  let release!: () => void;
  state.holdCommand = new Promise<void>(resolve => { release = resolve; });
  await input.fill('First phrase');
  await page.getByRole('button', { name: 'Send text', exact: true }).tap();
  await expect.poll(() => state.requests.length).toBe(1);
  await input.fill('Second phrase');
  release(); state.holdCommand = undefined;
  await expect(page.getByRole('button', { name: 'Send text', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('Second phrase');
  expect(state.requests).toEqual([{ id: 'office', action: 'text', parameters: { text: 'First phrase' } }]);
});

test('removing the selected TV on refresh cancels queued commands to it', async ({ page }) => {
  const state = await setupTV(page); await page.goto('/#/tv');
  let release!: () => void;
  state.holdCommand = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Up', exact: true }).tap();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByRole('button', { name: 'Left', exact: true }).tap();
  state.screens = state.screens.filter(screen => screen.id !== 'office');
  await page.getByRole('button', { name: 'Refresh TVs', exact: true }).tap();
  await expect(page.getByLabel('Screen', { exact: true })).toHaveValue('living');
  release(); state.holdCommand = undefined;
  await page.getByRole('button', { name: 'Right', exact: true }).tap();
  await expect.poll(() => state.requests.some(row => row.id === 'living' && row.parameters.key === 'right')).toBe(true);
  expect(state.requests.filter(row => row.parameters.key === 'left')).toEqual([]);
});
