import { test, expect } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';

const cameras = [{ id: 'front', device_name: 'Front door' }, { id: 'side', device_name: 'Side door' }];
const frame = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#352944"/></svg>';

test('camera list distinguishes loading, error and empty states and can retry', async ({ page }) => {
  await setupSpotify(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let failed = true;
  await page.route('**/api/cameras', async route => {
    await pending;
    return failed ? route.fulfill({ status: 503 }) : route.fulfill({ json: [] });
  });
  await page.goto('/#/cameras');
  await expect(page.getByText('Loading cameras…')).toBeVisible();
  await expect(page.getByText('No cameras')).toBeHidden();
  release();
  await expect(page.getByText('Could not load cameras')).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No cameras')).toBeVisible();
});

test('switching clears old frames and failures have visible recovery without covering controls', async ({ page }) => {
  await setupSpotify(page);
  await page.route('**/api/cameras', route => route.fulfill({ json: cameras }));
  let failed = true;
  await page.route('**/api/cameras/*/snapshot?*', route => {
    if (failed && route.request().url().includes('/side/')) return route.fulfill({ status: 503 });
    return route.fulfill({ contentType: 'image/svg+xml', body: frame });
  });
  await page.goto('/#/cameras');
  await expect(page.getByRole('img', { name: 'Front door' })).toBeVisible();
  await page.getByRole('tab', { name: 'Side door' }).click();
  await expect(page.getByRole('img', { name: 'Front door' })).toBeHidden();
  await expect(page.getByText('Camera unavailable')).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  failed = false;
  await retry.click();
  await expect(page.getByRole('img', { name: 'Side door' })).toBeVisible();
  await expect(page.getByText('Camera unavailable')).toBeHidden();
  for (const tab of await page.getByRole('tab').all()) {
    const box = await tab.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect((await page.locator('.cameras-stream-area').boundingBox())!.y).toBeLessThan(80);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test('a slow snapshot can finish within the device proxy timeout', async ({ page }) => {
  await setupSpotify(page);
  await page.clock.install({ time: new Date('2026-10-02T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-02T00:00:01Z'));
  await page.route('**/api/cameras', route => route.fulfill({ json: cameras }));
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/cameras/*/snapshot?*', async route => {
    requested();
    await pending;
    return route.fulfill({ contentType: 'image/svg+xml', body: frame });
  });
  await page.goto('/#/cameras');
  await started;
  await page.clock.runFor(15000);
  await expect(page.getByText('Camera unavailable')).toBeHidden();
  release();
  await expect(page.getByRole('img', { name: 'Front door' })).toBeVisible();
});
