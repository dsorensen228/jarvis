import { test, expect, type Page } from '@playwright/test';
const cameras = [{ id: 'front', name: 'Front door', kind: 'camera' }, { id: 'side', name: 'Side door', kind: 'camera' }];
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#352944"/></svg>';
async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('@jarvis_app/refreshToken', 'test-only');
    window.__RUNTIME_EXPO_PUBLIC__ = { EXPO_PUBLIC_API_URL: location.origin };
  });
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
  await page.route('**/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/refresh') return route.fulfill({ json: { access_token: token, refresh_token: 'test-only' } });
    if (path === '/v1/users/me') return route.fulfill({ json: { id: 'test', email: 'camera@example.test', name: 'Camera test', settings: {} } });
    if (path === '/v1/devices') return route.fulfill({ json: cameras });
    if (path.endsWith('/stream-session')) return route.fulfill({ json: { camera_token: path.includes('/front/') ? 'front-token' : 'side-token', expires_in: 900 } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'image/svg+xml', body: image });
    return route.fulfill({ json: [] });
  });
}
async function openCameras(page: Page) {
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (page.viewportSize()!.width < 1180) {
    await expect(menu).toBeVisible({ timeout: 15000 });
    await menu.click();
  }
  await page.getByText('Cameras', { exact: true }).click();
}

test('camera switching, readable controls, failed stream and retry', async ({ page }) => {
  await setup(page);
  await openCameras(page);
  await expect(page.getByRole('img', { name: 'Front door' })).toBeVisible();
  await page.route('**/v1/devices/side/camera/stream?*', route => route.fulfill({ status: 503 }));
  await page.getByRole('tab', { name: 'Side door' }).click();
  await expect(page.getByRole('img', { name: 'Front door' })).toBeHidden();
  await expect(page.getByText('Camera unavailable')).toBeVisible();
  await page.unroute('**/v1/devices/side/camera/stream?*');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Camera unavailable')).toBeHidden();
  await expect(page.getByRole('img', { name: 'Side door' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Side door' })).toHaveAttribute('aria-selected', 'true');
  expect(await page.getByRole('img', { name: 'Side door' }).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(960);
  for (const tab of await page.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('list failures are not empty states and can recover', async ({ page }) => {
  await setup(page);
  await page.route('**/v1/devices', route => route.fulfill({ status: 503 }));
  await openCameras(page);
  await expect(page.getByText('Could not load cameras')).toBeVisible();
  await expect(page.getByText('No cameras', { exact: true })).toBeHidden();
  await page.unroute('**/v1/devices');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Front door' })).toBeVisible();
  await page.route('**/v1/devices', route => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Refresh cameras' }).click();
  await expect(page.getByText('No cameras', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Front door' })).toHaveCount(0);
});

test('a late stream session cannot replace the camera selected in the meantime', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/devices/front/camera/stream-session', async route => {
    await pending;
    return route.fulfill({ json: { camera_token: 'late-front-token', expires_in: 900 } });
  });
  await openCameras(page);
  await expect(page.getByText('Connecting…')).toBeVisible();
  await page.getByRole('tab', { name: 'Side door' }).click();
  await expect(page.getByRole('img', { name: 'Side door' })).toBeVisible();
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/front/camera/stream-session'));
  release();
  await lateResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole('img', { name: 'Side door' })).toHaveAttribute('src', /side-token/);
  await expect(page.getByRole('img', { name: 'Front door' })).toBeHidden();
});
