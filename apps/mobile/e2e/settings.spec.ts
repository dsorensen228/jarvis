import { expect, test, type Locator, type Page } from '@playwright/test';

const userName = 'Alexandra Example';
const userEmail = 'alexandra.example@example.test';
const voiceName = 'Upstairs landing voice interface';
const cameraName = 'Front entrance package delivery camera';
const lastRoom = 'Room 30 — Upstairs studio and reading room';
type DeviceRow = { id: string; name: string; kind: string; room: string; base_url: string | null; metadata: Record<string, unknown>; [key: string]: unknown };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('@jarvis_app/refreshToken', 'test-only');
    window.__RUNTIME_EXPO_PUBLIC__ = { EXPO_PUBLIC_API_URL: location.origin, EXPO_PUBLIC_APK_DOWNLOAD_URL: 'https://downloads.example.test/jarvis.apk' };
  });
  const state = {
    settings: { jarvis_personality: 1 } as Record<string, unknown>,
    failPreference: false, preferenceGate: null as ReturnType<typeof deferred> | null,
    failDevices: false, failDeviceSave: false, deviceGate: null as ReturnType<typeof deferred> | null,
    failSnapshot: false, requests: [] as Array<{ method: string; path: string; body: any }>,
    devices: [
      { id: 'voice-one', name: voiceName, kind: 'voice', room: 'Kitchen', base_url: null, metadata: { doorbell_alerts_enabled: false, unrelated: 'keep-me' } },
      { id: 'camera-one', name: cameraName, kind: 'camera', room: 'Entrance', base_url: 'https://camera.example.test/proxy/door', metadata: { describe_scene_prompt: 'Watch for packages', is_main_describe_camera: true }, callback_configured: true },
    ] as DeviceRow[],
  };
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = route.request().postData() ? route.request().postDataJSON() : null;
    state.requests.push({ method, path, body });
    if (path === '/v1/auth/refresh') return route.fulfill({ json: { access_token: token, refresh_token: 'test-only' } });
    if (path === '/v1/users/me' && method === 'PATCH') {
      if (state.preferenceGate) await state.preferenceGate.promise;
      if (state.failPreference) return route.fulfill({ status: 503, json: { detail: 'Preferences temporarily unavailable' } });
      Object.assign(state.settings, body.settings);
      return route.fulfill({ json: { status: 'ok' } });
    }
    if (path === '/v1/users/me') return route.fulfill({ json: { id: 'test', name: userName, email: userEmail, settings: state.settings } });
    if (path === '/v1/rooms') return route.fulfill({ json: Array.from({ length: 30 }, (_, i) => ({ id: `room-${i + 1}`, name: `Room ${String(i + 1).padStart(2, '0')} — Upstairs studio and reading room` })) });
    if (path === '/v1/users') return route.fulfill({ json: [{ id: 'test', name: userName, username: userEmail }] });
    if (path === '/v1/devices' && method === 'GET') return route.fulfill(state.failDevices ? { status: 503, json: { detail: 'Device list unavailable' } } : { json: state.devices });
    if (path === '/v1/devices' && method === 'POST') {
      if (state.deviceGate) await state.deviceGate.promise;
      if (state.failDeviceSave) return route.fulfill({ status: 503, json: { detail: 'Could not save device' } });
      const { callback_token, ...fields } = body;
      const created = { id: 'created-device', ...fields, metadata: body.metadata || {}, callback_configured: Boolean(callback_token) };
      state.devices.push(created);
      return route.fulfill({ json: created });
    }
    const match = path.match(/^\/v1\/devices\/([^/]+)$/);
    if (match && method === 'PATCH') {
      if (state.deviceGate) await state.deviceGate.promise;
      if (state.failDeviceSave) return route.fulfill({ status: 503, json: { detail: 'Could not save device' } });
      const device = state.devices.find(row => row.id === match[1])!;
      const { callback_token, ...fields } = body;
      Object.assign(device, fields, { metadata: { ...device.metadata, ...body.metadata }, ...(callback_token ? { callback_configured: true } : {}) });
      return route.fulfill({ json: device });
    }
    if (match && method === 'DELETE') {
      if (state.failDeviceSave) return route.fulfill({ status: 503, json: { detail: 'Could not remove device' } });
      state.devices = state.devices.filter(row => row.id !== match[1]);
      return route.fulfill({ json: { status: 'ok' } });
    }
    if (path.endsWith('/camera/stream-session')) return route.fulfill({ json: { camera_token: 'test-camera-token', snapshot_path: '/v1/devices/camera-one/camera/snapshot', expires_in: 900 } });
    if (path.endsWith('/camera/snapshot')) return route.fulfill(state.failSnapshot ? { status: 503, body: 'Camera unavailable' } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#222"/></svg>' });
    return route.fulfill({ json: [] });
  });
  return state;
}
async function openSettings(page: Page) {
  await page.goto('/');
  if (page.viewportSize()!.width < 1180) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}
async function withinViewport(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('navigation remains reachable in a short viewport and opens settings', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  const phone = page.viewportSize()!.width < 1180;
  if (phone) await page.getByRole('button', { name: 'Open menu' }).click();
  const nav = page.getByTestId('navigation-panel');
  await expect(nav).toBeVisible();
  const bounds = await nav.boundingBox();
  expect(bounds!.y + bounds!.height).toBeCloseTo(page.viewportSize()!.height, 0);
  if (phone) expect(bounds!.y).toBe(0);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 480 });
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeInViewport();
  const shortBounds = await nav.boundingBox();
  expect(shortBounds!.y + shortBounds!.height).toBeCloseTo(480, 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (phone) await expect(nav).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

for (const width of [320, 344, 1440]) {
  test(`settings destinations and preference recovery remain usable at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== (width < 1180 ? 'phone' : 'desktop'));
    await page.setViewportSize({ width, height: width < 1180 ? 800 : 900 });
    const state = await setup(page);
    await openSettings(page);
    for (const name of ['Account', 'Preferences', 'Jarvis devices', 'App & connections']) await withinViewport(page, page.getByRole('button', { name, exact: true }));
    await page.screenshot({ path: testInfo.outputPath(`settings-home-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const photo = page.getByRole('button', { name: 'Change profile photo', exact: true });
    await expect(photo.locator('..').getByText(userEmail, { exact: true })).toBeVisible();
    await withinViewport(page, photo);
    await page.screenshot({ path: testInfo.outputPath(`settings-account-${width}.png`), animations: 'disabled' });
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await page.getByRole('button', { name: 'Jarvis tone', exact: true }).click();
    state.failPreference = true;
    state.preferenceGate = deferred();
    const strong = page.getByRole('button', { name: 'Jarvis tone: Strong', exact: true });
    await withinViewport(page, strong);
    await strong.click();
    await expect(strong).toBeDisabled();
    state.preferenceGate.resolve();
    await expect(page.getByRole('alert')).toContainText(/could not save/i);
    expect(state.settings.jarvis_personality).toBe(1);
    state.failPreference = false;
    await strong.click();
    await expect(strong).toHaveAttribute('aria-selected', 'true');
    expect(state.settings.jarvis_personality).toBe(3);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    state.failPreference = true;
    await page.getByRole('button', { name: 'Light theme', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/sync/i);
    await expect(page.getByRole('button', { name: 'Light theme', exact: true })).toHaveAttribute('aria-selected', 'true');
    await openSettings(page);
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Light theme', exact: true })).toHaveAttribute('aria-selected', 'true');
    await noHorizontalOverflow(page);
  });
}

test('connection diagnostics report partial readiness, recover, and expose the Android download', async ({ page, context }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width < 1180 ? 320 : 1440, height: 800 });
  await setup(page);
  let healthStatus = 503;
  let ready = false;
  let gate = deferred();
  await page.route('**/health/ready', async route => {
    await gate.promise;
    return route.fulfill({ status: healthStatus, json: { database: true, llm: ready, speech: { asr: true, tts: true } } });
  });
  await context.route('https://downloads.example.test/**', route => route.fulfill({ contentType: 'text/plain', body: 'test download' }));
  await openSettings(page);
  await page.getByRole('button', { name: 'App & connections', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check connection', exact: true });
  await check.click();
  await expect(check).toBeDisabled();
  gate.resolve();
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(3);
  healthStatus = 200;
  ready = true;
  await check.click();
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(4);
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);
  const download = page.getByRole('button', { name: 'Download Android app', exact: true });
  await withinViewport(page, download);
  const popupPromise = page.waitForEvent('popup');
  await download.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://downloads.example.test/jarvis.apk');
  await popup.close();
  await page.getByRole('button', { name: 'About Jarvis', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Jarvis', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'App & connections', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

for (const width of [320, 344, 1440]) {
  test(`guided device creation, long room choices and unsaved edits at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== (width < 1180 ? 'phone' : 'desktop'));
    await page.setViewportSize({ width, height: width < 1180 ? 800 : 900 });
    const state = await setup(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Jarvis devices', exact: true }).click();
    for (const name of [voiceName, cameraName]) await withinViewport(page, page.getByRole('button', { name: `Manage device: ${name}`, exact: true }));
    await noHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`settings-devices-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Add device', exact: true }).click();
    await page.getByRole('button', { name: 'Voice interface', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Enter a device name');
    const newName = 'Library and upstairs landing voice interface';
    await page.getByRole('textbox', { name: 'Device name', exact: true }).fill(newName);
    await expect(page.getByRole('textbox', { name: 'Callback URL', exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Room', exact: true }).click();
    await page.setViewportSize({ width, height: 360 });
    const room = page.getByRole('radio', { name: lastRoom, exact: true });
    await withinViewport(page, room);
    await room.click();
    await expect(room).toHaveCount(0);
    await page.setViewportSize({ width, height: width < 1180 ? 800 : 900 });
    await page.getByRole('switch', { name: 'Announce person detections', exact: true }).click();
    state.failDeviceSave = true;
    state.deviceGate = deferred();
    const add = page.getByRole('button', { name: 'Add device', exact: true });
    await withinViewport(page, add);
    await add.click();
    await expect(add).toBeDisabled();
    await expect.poll(() => state.requests.filter(request => request.path === '/v1/devices' && request.method === 'POST').length).toBe(1);
    state.deviceGate.resolve();
    await expect(page.getByRole('alert')).toContainText('Could not save device');
    await expect(page.getByRole('button', { name: 'Room', exact: true })).toContainText(lastRoom);
    await expect(page.getByRole('switch', { name: 'Announce person detections', exact: true })).toHaveAttribute('aria-checked', 'true');
    state.failDeviceSave = false;
    await add.click();
    await expect(page.getByRole('heading', { name: newName, exact: true })).toBeVisible();
    const creates = state.requests.filter(request => request.path === '/v1/devices' && request.method === 'POST');
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toMatchObject({ name: newName, kind: 'voice', base_url: null, room: lastRoom, metadata: { doorbell_alerts_enabled: true } });
    await expect(page.getByRole('heading', { name: 'Device', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.screenshot({ path: testInfo.outputPath(`settings-device-overview-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Assignments', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`settings-assignments-${width}.png`), animations: 'disabled' });
    await page.getByRole('textbox', { name: 'Device name', exact: true }).fill('Unsaved device name');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByText('Discard unsaved changes?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Device name', exact: true })).toHaveValue('Unsaved device name');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByRole('heading', { name: newName, exact: true })).toBeVisible();
    expect(state.requests.filter(request => request.method === 'PATCH' && request.path.startsWith('/v1/devices/'))).toHaveLength(0);
    await noHorizontalOverflow(page);
  });
}

test('camera configuration, snapshot retry and removal retain the device until successful', async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width < 1180 ? 344 : 1440, height: 800 });
  const state = await setup(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Jarvis devices', exact: true }).click();
  await page.getByRole('button', { name: `Manage device: ${cameraName}`, exact: true }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  const url = page.getByRole('textbox', { name: 'Callback URL', exact: true });
  await expect(url).toHaveValue('https://camera.example.test/proxy/door');
  await expect(page.getByLabel('Callback secret', { exact: true })).toHaveValue('');
  await url.fill('https://camera.example.test/proxy/front-door');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: cameraName, exact: true })).toBeVisible();
  const connectionRequest = state.requests.find(request => request.path === '/v1/devices/camera-one' && request.method === 'PATCH')!;
  expect(connectionRequest.body.base_url).toBe('https://camera.example.test/proxy/front-door');
  expect(connectionRequest.body).not.toHaveProperty('callback_token');
  await page.getByRole('button', { name: 'Camera behavior', exact: true }).click();
  await page.getByRole('textbox', { name: 'Scene instructions', exact: true }).fill('Look for parcels near the front entrance.');
  await page.getByRole('switch', { name: 'Default describe-scene camera', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: cameraName, exact: true })).toBeVisible();
  expect(state.devices.find(device => device.id === 'camera-one')!.metadata).toMatchObject({ describe_scene_prompt: 'Look for parcels near the front entrance.', is_main_describe_camera: false });
  state.failSnapshot = true;
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('button', { name: 'Load snapshot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Camera unavailable');
  state.failSnapshot = false;
  await page.getByRole('button', { name: 'Retry snapshot', exact: true }).click();
  const image = page.getByRole('img', { name: `Snapshot from ${cameraName}`, exact: true });
  await expect(image).toBeVisible();
  await withinViewport(page, image);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(800);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Remove device', exact: true }).click();
  await page.getByRole('button', { name: 'Keep device', exact: true }).click();
  expect(state.requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('button', { name: 'Remove device', exact: true }).click();
  state.failDeviceSave = true;
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not remove device');
  expect(state.devices.some(device => device.id === 'camera-one')).toBe(true);
  state.failDeviceSave = false;
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Manage device: ${cameraName}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Manage device: ${voiceName}`, exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test('a failed inventory request is visible and can recover without pretending the list is empty', async ({ page }) => {
  const state = await setup(page);
  state.failDevices = true;
  await openSettings(page);
  await page.getByRole('button', { name: 'Jarvis devices', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not refresh devices');
  await expect(page.getByText(/No devices are registered/)).toHaveCount(0);
  state.failDevices = false;
  await page.getByRole('button', { name: 'Refresh devices', exact: true }).click();
  await expect(page.getByRole('button', { name: `Manage device: ${voiceName}`, exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('camera setup validates the callback and saves its secret with the device', async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width < 1180 ? 320 : 1440, height: 800 });
  const state = await setup(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Jarvis devices', exact: true }).click();
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  await page.getByRole('textbox', { name: 'Device name', exact: true }).fill('New porch camera');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/callback/i);
  expect(state.requests.filter(request => request.path === '/v1/devices' && request.method === 'POST')).toHaveLength(0);
  await page.getByRole('textbox', { name: 'Callback URL', exact: true }).fill('https://camera.example.test/porch');
  await page.getByLabel('Callback secret', { exact: true }).fill('test-camera-secret');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('textbox', { name: 'Scene instructions', exact: true }).fill('Describe packages by the door.');
  await page.getByRole('switch', { name: 'Default describe-scene camera', exact: true }).click();
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New porch camera', exact: true })).toBeVisible();
  const creates = state.requests.filter(request => request.path === '/v1/devices' && request.method === 'POST');
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({ name: 'New porch camera', kind: 'camera', base_url: 'https://camera.example.test/porch', callback_token: 'test-camera-secret', metadata: { describe_scene_prompt: 'Describe packages by the door.', is_main_describe_camera: true } });
  expect(state.requests.filter(request => request.path.endsWith('/registration'))).toHaveLength(0);
  await noHorizontalOverflow(page);
});
