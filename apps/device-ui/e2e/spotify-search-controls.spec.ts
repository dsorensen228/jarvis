import { test, expect } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';

test('touch keyboard edits at the caret and keeps Search and Hide reachable', async ({ page }) => {
  await setupSpotify(page);
  await page.goto('/#/spotify/search');
  const field = page.getByRole('searchbox');
  await field.fill('pink floyd');
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' });
  await expect(keyboard).toBeVisible();
  await field.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 4));
  await keyboard.getByRole('button', { name: 'n', exact: true }).tap();
  await expect(field).toHaveValue('n floyd');
  await keyboard.getByRole('button', { name: 'i', exact: true }).tap();
  await expect(field).toHaveValue('ni floyd');
  await keyboard.getByRole('button', { name: 'Backspace', exact: true }).click();
  await expect(field).toHaveValue('n floyd');
  const inputBox = await field.boundingBox();
  const keyboardBox = await keyboard.boundingBox();
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(keyboardBox!.y);
  for (const name of ['Search', 'Hide keyboard']) {
    const bounds = await keyboard.getByRole('button', { name, exact: true }).boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await keyboard.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(keyboard).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Play track n floyd by/ })).toBeVisible();
  await field.click();
  await page.getByRole('button', { name: 'Hide keyboard', exact: true }).click();
  await expect(keyboard).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Now playing' })).toBeVisible();
});

test('search reconnects inline after a temporary SDK interruption', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify/search');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__emitSpotify('not_ready', { device_id: 'office-sdk-id' }));
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  expect(requests.some((request) => request.path === '/api/spotify/disconnect')).toBe(false);
});

test('queue actions explain that music must start on this device first', async ({ page }) => {
  await setupSpotify(page, { empty: true });
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('A Song');
  await page.getByRole('searchbox').press('Enter');
  const queue = page.getByRole('button', { name: 'Add A Song to queue', exact: true });
  await expect(queue).toBeDisabled();
  await expect(queue).toHaveAttribute('title', /Start music on this device/);
  await expect(page.getByRole('button', { name: /Play track A Song by/ })).toBeEnabled();
});

test('explicit sign-out clears populated device favorites and recent searches', async ({ page }) => {
  await setupSpotify(page);
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Saved Song');
  await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Save Saved Song to favorites on this device/ }).click();
  const stored = () => page.evaluate(() => ({
    favorites: JSON.parse(localStorage.getItem('jarvis.spotify.favorites.v1') || '[]'),
    searches: JSON.parse(localStorage.getItem('jarvis.spotify.recent-searches.v1') || '[]'),
  }));
  await expect.poll(async () => (await stored()).favorites.length).toBe(1);
  await expect.poll(async () => (await stored()).searches.length).toBe(1);
  await page.getByRole('link', { name: 'Music', exact: true }).click();
  await page.getByLabel('Spotify account menu').click();
  await page.getByRole('button', { name: 'Sign out of Spotify', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect Spotify', exact: true })).toBeVisible();
  await expect.poll(stored).toEqual({ favorites: [], searches: [] });
});
