import { test, expect, type Page } from '@playwright/test';
import { emptyClock, readClock, setupClock } from './timers-fixture';

async function dialogFits(page: Page) {
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

test('independent timers pause, add time, restart, survive reload and remain available from other screens', async ({ page }, info) => {
  await setupClock(page); await page.goto('/#/timer');
  await page.getByRole('button', { name: 'Start 3 minute Tea timer', exact: true }).tap();
  await page.getByRole('button', { name: 'Start 25 minute Focus timer', exact: true }).tap();
  const tea = page.getByRole('article', { name: 'Tea timer', exact: true });
  const focus = page.getByRole('article', { name: 'Focus timer', exact: true });
  await expect(tea).toBeVisible(); await expect(focus).toBeVisible();
  await tea.getByRole('button', { name: 'Pause', exact: true }).tap();
  const paused = await tea.locator('.clock-countdown').innerText();
  await page.waitForTimeout(1100); await expect(tea.locator('.clock-countdown')).toHaveText(paused);
  await tea.getByRole('button', { name: '+1 min', exact: true }).tap();
  await expect.poll(async () => (await readClock(page)).timers.find(t => t.label === 'Tea')!.remainingMs).toBeGreaterThan(230000);
  await expect(focus.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.reload(); await expect(tea.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await tea.getByRole('button', { name: 'Resume', exact: true }).tap();
  await tea.getByRole('button', { name: 'Restart', exact: true }).tap();
  await expect(tea.locator('.clock-finish')).toContainText('Finishes');
  await page.screenshot({ path: info.outputPath('timers-running.png') });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const mini = page.getByRole('complementary', { name: 'Active timers' });
  await expect(mini).toContainText('2 timers');
  await mini.getByRole('button', { name: /^Open timers/ }).tap();
  await expect(tea).toBeVisible();
  await tea.getByRole('button', { name: 'Remove Tea timer', exact: true }).tap();
  await tea.getByRole('button', { name: 'Keep', exact: true }).tap(); await expect(tea).toBeVisible();
  await tea.getByRole('button', { name: 'Remove Tea timer', exact: true }).tap();
  await tea.getByRole('button', { name: 'Remove', exact: true }).tap(); await expect(tea).toHaveCount(0); await expect(focus).toBeVisible();
});

test('custom timer keypad and name keyboard are touchable and preserve the name caret', async ({ page }, info) => {
  await setupClock(page); await page.goto('/#/timer');
  await page.getByRole('button', { name: '+ Custom timer', exact: true }).tap();
  const dialog = page.getByRole('dialog', { name: 'New timer' });
  await dialog.getByRole('button', { name: 'Hours: 0', exact: true }).tap();
  await dialog.getByRole('button', { name: '1', exact: true }).tap();
  await dialog.getByRole('button', { name: 'Minutes: 5', exact: true }).tap();
  await dialog.getByRole('button', { name: '2', exact: true }).tap();
  await dialog.getByRole('button', { name: 'Seconds: 0', exact: true }).tap();
  await dialog.getByRole('button', { name: '3', exact: true }).tap();
  await expect(dialog).toContainText('1 hr 2 min 3 sec'); await dialogFits(page);
  await page.screenshot({ path: info.outputPath('timer-composer.png') });
  await dialog.getByRole('button', { name: /Timer name/ }).tap();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Tea time'); await name.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 3));
  const keyboard = page.getByRole('group', { name: 'On-screen keyboard' });
  await keyboard.getByRole('button', { name: 'm', exact: true }).tap();
  await expect(name).toHaveValue('m time');
  await page.getByRole('button', { name: 'Dinner', exact: true }).tap();
  await dialogFits(page);
  const doneBounds = await keyboard.getByRole('button', { name: 'Done', exact: true }).boundingBox();
  expect(doneBounds!.y + doneBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath('timer-name-keyboard.png') });
  await keyboard.getByRole('button', { name: 'Done', exact: true }).tap();
  await page.getByRole('button', { name: 'Start timer', exact: false }).last().tap();
  await expect(page.getByRole('article', { name: 'Dinner timer', exact: true })).toBeVisible();
  await expect.poll(async () => (await readClock(page)).timers[0].durationMs).toBe(3723000);
});

test('named alarms support weekday/custom schedules, individual snooze, edit, off, and delete undo', async ({ page }, info) => {
  await setupClock(page); await page.goto('/#/timer/alarms');
  await page.getByRole('button', { name: '+ New alarm', exact: true }).tap();
  await page.getByRole('button', { name: 'Weekdays', exact: true }).tap();
  await page.getByRole('button', { name: '15 min', exact: true }).tap();
  await page.getByRole('button', { name: /Alarm name/ }).tap();
  await page.getByRole('button', { name: 'Wake up', exact: true }).tap();
  await page.screenshot({ path: info.outputPath('alarm-name-keyboard.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).tap();
  // Done must finish name entry, never click through to Add alarm beneath it.
  await expect(page.getByRole('dialog', { name: 'New alarm', exact: true })).toBeVisible();
  await expect.poll(async () => (await readClock(page)).alarms.length).toBe(0);
  await dialogFits(page); await page.screenshot({ path: info.outputPath('alarm-editor.png') });
  await page.getByRole('button', { name: 'Add alarm', exact: true }).tap();
  const alarm = page.getByRole('article', { name: 'Wake up alarm', exact: true });
  await expect(alarm).toContainText('Weekdays'); await expect(alarm).toContainText('Snooze 15 min');
  await alarm.getByRole('button', { name: 'Edit Wake up alarm', exact: true }).tap();
  await page.getByRole('button', { name: 'Custom', exact: true }).tap();
  for(const name of ['Monday','Tuesday','Wednesday','Thursday','Friday']) await page.getByRole('button', { name, exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Save alarm', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Saturday', exact: true }).tap();
  await page.getByRole('button', { name: 'Save alarm', exact: true }).tap();
  await expect(alarm).toContainText('Sat');
  await alarm.getByRole('switch').tap(); await expect(alarm.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await alarm.getByRole('button', { name: 'Delete Wake up alarm', exact: true }).tap(); await expect(alarm).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).tap(); await expect(alarm.getByRole('switch')).toHaveAttribute('aria-checked','false');
  await page.reload(); await expect(alarm).toContainText('Snooze 15 min');
  await page.screenshot({ path: info.outputPath('alarms-list.png') });
});

test('simultaneous finished timers stay queued, restart one and dismiss the other without losing it', async ({ page }, info) => {
  const state = emptyClock(); const now = Date.now();
  state.timers = ['Pasta', 'Tea'].map((label, index) => ({ id: `timer-${index}`, label, status: 'running' as const, durationMs: 60000, remainingMs: 0, endTime: now - 1000, createdAt: now - 61000 }));
  await setupClock(page, state); await page.goto('/#/timer');
  const ring = page.getByRole('alertdialog');
  await expect(ring).toContainText('Pasta'); await expect(ring).toContainText('1 more waiting');
  await page.screenshot({ path: info.outputPath('timers-ringing.png') });
  await ring.getByRole('button', { name: 'Restart · 1 min', exact: true }).tap();
  await expect(ring.getByRole('heading', { name: 'Tea', exact: true })).toBeVisible();
  await ring.getByRole('button', { name: 'Dismiss', exact: true }).tap(); await expect(ring).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Pasta timer', exact: true })).toContainText('RUNNING');
});

test('a snoozed one-time alarm survives delete and undo, and its snooze can be cancelled while off', async ({ page }, info) => {
  const state = emptyClock(); const now = Date.now();
  state.alarms = [{ id: 'alarm-1', label: 'Wake up', hour: 7, minute: 0, enabled: true, repeat: { kind: 'once' }, snoozeMinutes: 5 }];
  state.alarmNextFireAt = { 'alarm-1': now - 1000 };
  await setupClock(page, state); await page.goto('/#/timer/alarms');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Snooze · 5 min', exact: true }).tap();
  const alarm = page.getByRole('article', { name: 'Wake up alarm', exact: true });
  await expect(alarm.getByRole('switch')).toHaveAttribute('aria-checked', 'false'); await expect(alarm).toContainText('Snoozed until');
  await page.reload(); await expect(alarm.getByRole('button', { name: 'Cancel snooze', exact: true })).toBeVisible();
  const deadline = (await readClock(page)).pendingSnoozes[0].fireAt;
  await alarm.getByRole('button', { name: 'Delete Wake up alarm', exact: true }).tap();
  await expect(alarm).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).tap();
  await expect(alarm).toContainText('Snoozed until');
  await expect.poll(async () => (await readClock(page)).pendingSnoozes[0]?.fireAt).toBe(deadline);
  await page.reload(); await expect(alarm.getByRole('button', { name: 'Cancel snooze', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('alarm-snoozed.png') });
  await alarm.getByRole('button', { name: 'Cancel snooze', exact: true }).tap(); await expect(alarm).not.toContainText('Snoozed until');
  await expect.poll(async () => (await readClock(page)).pendingSnoozes.length).toBe(0);
});

test('long voice labels and several pending alerts keep Dismiss and Snooze within reach', async ({ page }, info) => {
  const state = emptyClock(); const now = Date.now();
  const labels = [
    'Remember the dinner in the oven and check the vegetables before the family arrives',
    'Move the laundry into the dryer and bring the blue basket back upstairs afterward',
    'Make another pot of tea for everyone working on the long project in the afternoon',
  ].map(label => label.slice(0, 80));
  state.alarms = labels.map((label, index) => ({ id: `long-${index}`, label, hour: 7, minute: 0, enabled: true, repeat: { kind: 'once' as const }, snoozeMinutes: 10 }));
  state.alarmNextFireAt = Object.fromEntries(state.alarms.map(alarm => [alarm.id, now - 1000]));
  await setupClock(page, state); await page.goto('/#/timer/alarms');
  const ring = page.getByRole('alertdialog'); await expect(ring).toContainText('2 more waiting');
  for (const name of ['Snooze · 10 min', 'Dismiss & next']) {
    const bounds = await ring.getByRole('button', { name, exact: true }).boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await page.screenshot({ path: info.outputPath('alarms-long-ringing.png') });
  await ring.getByRole('button', { name: 'Dismiss & next', exact: true }).tap();
  await expect(ring.getByRole('heading')).toHaveText(labels[1]);
});

test('narrow screens keep both composers scrollable with reachable save actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await setupClock(page); await page.goto('/#/timer');
  expect(await page.locator('.clock-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '+ Custom timer', exact: true }).tap(); await dialogFits(page);
  await page.getByRole('button', { name: 'Start timer', exact: false }).last().tap();
  await expect(page.getByRole('article', { name: 'Timer timer', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Alarms', exact: true }).tap();
  await page.getByRole('button', { name: '+ New alarm', exact: true }).tap(); await dialogFits(page);
  await page.getByRole('button', { name: 'Add alarm', exact: true }).tap();
  await expect(page.getByRole('article', { name: 'Alarm alarm', exact: true })).toBeVisible();
});

test('voice timer creation adds a labeled timer without replacing an active one', async ({ page }) => {
  await setupClock(page); await page.goto('/#/timer');
  await page.getByRole('button', { name: 'Start 3 minute Tea timer', exact: true }).tap();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis-device-action', { detail: { type: 'client_action', action: 'start_timer', args: { seconds: 120, label: 'Voice pasta' } } })));
  await expect(page.getByRole('article', { name: 'Tea timer', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Voice pasta timer', exact: true })).toBeVisible();
  await expect.poll(async () => (await readClock(page)).timers.length).toBe(2);
});

test('voice stop timer silences the ringing timer and leaves the ongoing timer running', async ({ page }) => {
  const state = emptyClock(); const now = Date.now();
  state.timers = [
    { id: 'due', label: 'Finished tea', status: 'running', durationMs: 60000, remainingMs: 0, endTime: now - 1000, createdAt: now - 61000 },
    { id: 'ongoing', label: 'Long focus', status: 'running', durationMs: 1500000, remainingMs: 1200000, endTime: now + 1200000, createdAt: now - 300000 },
  ];
  await setupClock(page, state); await page.goto('/#/timer');
  await expect(page.getByRole('alertdialog').getByRole('heading')).toHaveText('Finished tea');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis-device-action', { detail: { type: 'client_action', action: 'stop_timer', args: {} } })));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Long focus timer', exact: true })).toContainText('RUNNING');
  await expect.poll(async () => (await readClock(page)).timers.map(timer => timer.id)).toEqual(['ongoing']);
});
