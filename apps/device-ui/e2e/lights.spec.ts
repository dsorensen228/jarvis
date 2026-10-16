import { test, expect } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';

test('tap toggles; hold opens room controls without toggling, fits and dismisses', async ({ page }, info) => {
  const requests = await setupSpotify(page, { ready: false });
  await page.route('**/api/config', route => route.fulfill({ json: { room_name: 'Office', voice_ui: true } }));
  const lights = Array.from({ length: 12 }, (_, i) => ({ id: `lamp-${i}`, name: i === 0 ? 'Desk lamp' : `Office light ${i}`, room: 'Office', available: i !== 2, power: i === 0 }));
  lights.push({ id: 'kitchen', name: 'Counter lights', room: 'Kitchen', available: true, power: false });
  await page.route('**/api/lights', route => route.fulfill({ json: lights }));
  const commands: any[] = [];
  let failed = false;
  await page.route('**/api/lights/control', route => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { succeeded: 1, failed: failed ? 1 : 0 } });
  });
  await page.goto('/#/standby');
  const icon = page.getByRole('button', { name: 'Toggle room lights', exact: true });
  await icon.tap();
  await expect.poll(() => requests.filter(r => r.path.endsWith('room-toggle')).length).toBe(1);
  await expect(icon).toBeEnabled();
  await icon.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  await page.waitForTimeout(600);
  await icon.dispatchEvent('pointerup');
  await icon.dispatchEvent('click');
  const menu = page.getByRole('dialog', { name: 'Lights' });
  await expect(menu).toBeVisible();
  expect(requests.filter(r => r.path.endsWith('room-toggle')).length).toBe(1);
  await expect(menu.getByRole('switch', { name: 'Desk lamp' })).toBeChecked();
  await expect(menu.getByRole('switch', { name: 'Office light 2' })).toBeDisabled();
  await menu.getByRole('switch', { name: 'Desk lamp' }).tap();
  expect(commands.at(-1)).toEqual({ scope: 'device', selector: 'lamp-0', action: 'turn_off' });
  await menu.getByRole('button', { name: 'All off', exact: true }).tap();
  expect(commands.at(-1)).toEqual({ scope: 'room', selector: 'Office', action: 'turn_off' });
  await page.screenshot({ path: info.outputPath('lights-office.png') });
  await menu.getByRole('button', { name: 'Kitchen', exact: true }).tap();
  await expect(menu.getByRole('switch', { name: 'Counter lights' })).toBeVisible();
  failed = true;
  await menu.getByRole('button', { name: 'All on', exact: true }).tap();
  expect(commands.at(-1)).toEqual({ scope: 'room', selector: 'Kitchen', action: 'turn_on' });
  await expect(menu.getByRole('alert')).toContainText('1 light');
  for (const button of await menu.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  expect(await menu.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await menu.getByRole('button', { name: 'Done', exact: true }).tap();
  await expect(menu).toHaveCount(0);
  await expect(icon).toBeFocused();
});

test('cancelled hold, load failure, retry, empty room and Escape stay usable', async ({ page }) => {
  const requests = await setupSpotify(page, { ready: false });
  await page.route('**/api/config', route => route.fulfill({ json: { room_name: 'Office', voice_ui: true } }));
  let unavailable = true;
  await page.route('**/api/lights', route => route.fulfill(unavailable ? { status: 503, json: {} } : { json: [] }));
  await page.goto('/#/standby');
  const icon = page.getByRole('button', { name: 'Toggle room lights', exact: true });
  await icon.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  await icon.dispatchEvent('pointercancel');
  await page.waitForTimeout(600);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests.filter(r => r.path.endsWith('room-toggle'))).toHaveLength(0);
  await icon.focus(); await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('dialog', { name: 'Lights' });
  await expect(menu.getByRole('alert')).toContainText("Couldn't reach");
  unavailable = false;
  await menu.getByRole('button', { name: 'Refresh' }).tap();
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(menu.getByText('No lights in this room.')).toBeVisible();
  await expect(menu.getByRole('button', { name: 'All on', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(icon).toBeFocused();
});

test('command failure keeps actual state and slow commands never trap the user', async ({ page }) => {
  await setupSpotify(page, { ready: false });
  await page.route('**/api/config', route => route.fulfill({ json: { room_name: 'Office', voice_ui: true } }));
  await page.route('**/api/lights', route => route.fulfill({ json: [{ id: 'desk', name: 'Desk lamp', room: 'Office', available: true, power: false }] }));
  let hold = false;
  let release: () => void = () => {};
  await page.route('**/api/lights/control', async route => {
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/#/standby');
  await page.getByRole('button', { name: 'Toggle room lights', exact: true }).press('ArrowDown');
  const menu = page.getByRole('dialog', { name: 'Lights' });
  const lamp = menu.getByRole('switch', { name: 'Desk lamp' });
  await lamp.tap();
  await expect(menu.getByRole('alert')).toContainText("Couldn't reach");
  await expect(lamp).not.toBeChecked();
  hold = true;
  await lamp.tap();
  await expect(lamp).toBeDisabled();
  await menu.getByRole('button', { name: 'Done', exact: true }).tap();
  await expect(menu).toHaveCount(0);
  release();
});
