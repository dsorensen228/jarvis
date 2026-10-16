import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { CodeTask, FactoryMode } from '../src/api';
import { setupSpotify } from './spotify-fixture';

type FactoryRequest = { path: string; method: string; body: any; query: URLSearchParams };
const timestamp = '2026-10-15T12:00:00Z';
const activeStatuses = new Set(['pending', 'queued', 'running', 'cancel_requested']);

function task(mode: FactoryMode, id: string, prompt: string, status: CodeTask['status']): CodeTask {
  return {
    id, prompt, status, model: 'gpt-6-sol', repository: 'workspace', workflow_id: id,
    created_at: timestamp, updated_at: timestamp, started_at: timestamp,
    completed_at: status === 'success' ? timestamp : null, exit_code: status === 'success' ? 0 : null,
    agent_output: null, stdout: null, stderr: null, error: null, changed_paths: [],
    self_update_scheduled: false, parent_task_id: null, output_seq: 0, task_type: mode,
    ...(mode === 'research' ? { verbosity: 'standard' as const, report_available: status === 'success' } : {}),
  };
}

async function setupFactory(page: Page) {
  await setupSpotify(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
  });
  let voiceEvents: WebSocketRoute;
  await page.routeWebSocket('**/api/events', socket => {
    voiceEvents = socket;
    socket.send(JSON.stringify({ type: 'voice.state', data: { active: false, phase: 'idle', connected: true } }));
  });
  await page.route('**/api/config', route => route.fulfill({ json: {
    device_id: 'test-kiosk', voice_ui: true, coding_tasks_enabled: true, music_tab_enabled: false,
    spotify_ready: false, spotify_client_id: null, spotify_player_name: 'Office',
  } }));
  const state = {
    calls: [] as FactoryRequest[],
    tasks: {
      code: [task('code', 'code-active', 'Fix the wake word', 'running'), task('code', 'code-done', 'Improve timers', 'success')],
      research: [task('research', 'research-active', 'Compare battery storage', 'running'), task('research', 'research-done', 'Compare grid storage', 'success')],
    } as Record<FactoryMode, CodeTask[]>,
    transcript: { code: 'Code prompt draft', research: 'Research prompt draft' },
    pageSize: 30,
    outputPages: false,
    reportFailures: 0,
    listFailures: 0,
    voice: (active: boolean) => voiceEvents.send(JSON.stringify({ type: 'voice.state', data: { active, phase: active ? 'listening' : 'idle', connected: true } })),
  };
  await page.route(/\/api\/(?:code|research)-tasks(?:\/|\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const mode: FactoryMode = url.pathname.startsWith('/api/research-tasks') ? 'research' : 'code';
    const base = `/api/${mode}-tasks`;
    const suffix = url.pathname.slice(base.length);
    const body = request.postDataJSON();
    state.calls.push({ path: url.pathname, method: request.method(), body, query: url.searchParams });
    if (suffix === '/recording/start') return route.fulfill({ json: { recording: true } });
    if (suffix === '/recording/stop') return route.fulfill({ json: { transcript: state.transcript[mode] } });
    if (!suffix && request.method() === 'POST') {
      const created = { ...task(mode, `${mode}-created`, body.prompt, 'pending'), ...body };
      state.tasks[mode].unshift(created);
      return route.fulfill({ status: 202, json: created });
    }
    if (!suffix) {
      if (state.listFailures > 0) {
        state.listFailures -= 1;
        return route.fulfill({ status: 503, json: { detail: 'Factory unavailable. Try again.' } });
      }
      const view = url.searchParams.get('view') ?? 'all';
      const rows = state.tasks[mode].filter(row => view === 'all' || (view === 'active' ? activeStatuses.has(row.status) : !activeStatuses.has(row.status)));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const end = offset + state.pageSize;
      return route.fulfill({ json: { items: rows.slice(offset, end), next_cursor: end < rows.length ? String(end) : null } });
    }
    const [, id, action] = suffix.split('/');
    const selected = state.tasks[mode].find(row => row.id === id);
    if (!selected) return route.fulfill({ status: 404, json: { detail: 'Task not found' } });
    if (action === 'cancel') {
      selected.status = 'cancel_requested';
      selected.updated_at = '2026-10-15T12:01:00Z';
      return route.fulfill({ json: selected });
    }
    if (action === 'follow-up') {
      const followUp = { ...task('code', 'code-follow-up', body.prompt, 'queued'), parent_task_id: id };
      state.tasks.code.unshift(followUp);
      return route.fulfill({ status: 202, json: followUp });
    }
    if (action === 'report') {
      if (state.reportFailures > 0) {
        state.reportFailures -= 1;
        return route.fulfill({ status: 503, json: { detail: 'Report is temporarily unavailable.' } });
      }
      return route.fulfill({ headers: { 'Cache-Control': 'no-store' }, json: {
        task_id: id, html: '<h1>Storage findings</h1><p>Battery storage supplies short duration power.</p>',
      } });
    }
    if (action === 'events') {
      return route.fulfill({ status: 503, json: { detail: 'Stream disconnected; use saved output.' } });
    }
    if (action === 'output') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const seq = state.outputPages && after < 3 ? after + 1 : after;
      return route.fulfill({ json: {
        items: seq > after ? [{ seq, kind: 'assistant', text: `Research activity ${seq}`, created_at: timestamp }] : [],
        next_after: seq, has_more: state.outputPages && seq < 3, truncated: false,
        task: { ...selected, output_seq: seq },
      } });
    }
    return route.fulfill({ json: selected });
  });
  return state;
}

async function chooseMode(page: Page, mode: 'Code' | 'Research') {
  const button = page.getByRole('button', { name: mode, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: mode === 'Code' ? 'Research' : 'Code', exact: true })).toHaveAttribute('aria-pressed', 'false');
}

async function recordPrompt(page: Page, mode: 'coding' | 'research') {
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `New ${mode} task` });
  await dialog.getByRole('button', { name: 'Push to record', exact: true }).click();
  await dialog.getByRole('button', { name: 'Push to stop', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeEnabled();
  return dialog;
}

test('Factory preserves independent filters, drafts and scroll between Code and Research', async ({ page }) => {
  const state = await setupFactory(page);
  for (let index = 0; index < 18; index += 1) {
    state.tasks.code.push(task('code', `code-old-${index}`, `Code history ${index}`, 'success'));
    state.tasks.research.push(task('research', `research-old-${index}`, `Research history ${index}`, 'success'));
  }
  await page.goto('/#/code');
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.getByText('Code history 5', { exact: true })).toBeAttached();
  const codeDraft = await recordPrompt(page, 'coding');
  await codeDraft.getByRole('radio', { name: 'Terra', exact: true }).click();
  await codeDraft.getByRole('button', { name: 'Close new task', exact: true }).click();
  const list = page.locator('.code-task-list:visible');
  await list.evaluate(element => { element.scrollTop = 240; });
  const originalScroll = await list.evaluate(element => element.scrollTop);
  expect(originalScroll).toBeGreaterThan(100);
  await chooseMode(page, 'Research');
  await expect(page.getByRole('tab', { name: /^All(?: tasks)?$/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Fix the wake word', { exact: true })).not.toBeVisible();
  await page.getByRole('tab', { name: 'Active', exact: true }).click();
  const researchDraft = await recordPrompt(page, 'research');
  await expect(researchDraft.getByText('Research prompt draft', { exact: true })).toBeVisible();
  await researchDraft.getByRole('radio', { name: 'Astra', exact: true }).click();
  await researchDraft.getByRole('radio', { name: 'Concise', exact: true }).click();
  await researchDraft.getByRole('button', { name: 'Close new task', exact: true }).click();
  await chooseMode(page, 'Code');
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(originalScroll);
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  await expect(codeDraft.getByText('Code prompt draft', { exact: true })).toBeVisible();
  await expect(codeDraft.getByRole('radio', { name: 'Terra', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(codeDraft.getByRole('radiogroup', { name: 'Report detail' })).toHaveCount(0);
  await codeDraft.getByRole('button', { name: 'Close new task', exact: true }).click();
  await chooseMode(page, 'Research');
  await expect(page.getByRole('tab', { name: 'Active', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  await expect(researchDraft.getByText('Research prompt draft', { exact: true })).toBeVisible();
  await expect(researchDraft.getByRole('radio', { name: 'Astra', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(researchDraft.getByRole('radio', { name: 'Concise', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(state.calls.filter(call => call.method === 'POST' && /^\/api\/(code|research)-tasks$/.test(call.path))).toHaveLength(0);
});

test('research recording submits the reviewed prompt, model and detail without a coding request', async ({ page }, testInfo) => {
  const state = await setupFactory(page);
  state.transcript.research = '  Compare battery chemistry  ';
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await expect(page.getByRole('button', { name: /Compare battery storage/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('research-list.png') });
  const dialog = await recordPrompt(page, 'research');
  await expect(dialog.getByRole('radio', { name: 'Sol', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('radio', { name: 'Standard', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: 'Astra', exact: true }).click();
  await dialog.getByRole('radio', { name: 'In depth', exact: true }).click();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const label of ['Terra', 'Sol', 'Astra', 'Concise', 'Standard', 'In depth']) {
    const radio = dialog.getByRole('radio', { name: label, exact: true });
    await expect(radio).toBeInViewport();
    expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('research-review.png') });
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toBeVisible();
  expect(state.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([
    '/api/research-tasks/recording/start', '/api/research-tasks/recording/stop', '/api/research-tasks',
  ]);
  expect(state.calls.find(call => call.path === '/api/research-tasks' && call.method === 'POST')?.body).toEqual({
    prompt: 'Compare battery chemistry', model: 'gpt-6-astra', verbosity: 'in_depth',
  });
  await expect(page.getByRole('button', { name: 'Follow up', exact: true })).toHaveCount(0);
});

test('research drains activity pages, polls for updates and cancels without coding streams', async ({ page }) => {
  const state = await setupFactory(page);
  state.outputPages = true;
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare battery storage/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Research task details' });
  for (const seq of [1, 2, 3]) await expect(dialog.getByText(`Research activity ${seq}`, { exact: true })).toBeAttached();
  const outputCalls = () => state.calls.filter(call => call.path === '/api/research-tasks/research-active/output');
  await expect.poll(() => outputCalls().filter(call => call.query.get('after') === '3').length).toBeGreaterThanOrEqual(2);
  expect(outputCalls().slice(0, 3).map(call => call.query.get('after'))).toEqual(['0', '1', '2']);
  await expect(dialog.getByRole('button', { name: 'Follow up', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(dialog.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel task', exact: true })).toHaveCount(0);
  expect(state.calls.some(call => call.path === '/api/research-tasks/research-active/cancel' && call.method === 'POST')).toBe(true);
  expect(state.calls.some(call => /\/research-tasks\/.*\/(events|follow-up)$/.test(call.path))).toBe(false);
  expect(state.calls.some(call => call.path.startsWith('/api/code-tasks/'))).toBe(false);
});

test('failed report loading retries and the full-screen report returns to research details', async ({ page }) => {
  const state = await setupFactory(page);
  state.reportFailures = 1;
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  const details = page.getByRole('dialog', { name: 'Research task details' });
  await details.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.getByText('Report is temporarily unavailable.', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Storage findings' })).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith('/research-done/report'))).toHaveLength(2);
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
  const report = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Back to research task' }) });
  const box = (await report.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  expect(box.width).toBe(page.viewportSize()!.width);
  expect(box.height).toBe(page.viewportSize()!.height);
  await report.getByRole('button', { name: 'Back to research task' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Close task details' }).click();
  await expect(page.getByRole('button', { name: /Compare grid storage/ })).toBeVisible();
});

test('closing task details aborts report loading and ignores a late report response', async ({ page }) => {
  await setupFactory(page);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/research-tasks/research-done/report', async route => {
    await waiting;
    await route.fulfill({ json: { task_id: 'research-done', html: '<h1>Late report</h1>' } }).catch(() => {});
  });
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  const details = page.getByRole('dialog', { name: 'Research task details' });
  await details.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Loading report…', exact: true })).toBeDisabled();
  await details.getByRole('button', { name: 'Close task details' }).click();
  release();
  await expect(details).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: /Compare battery storage/ }).click();
  await expect(details.getByText('Compare battery storage', { exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('reading a report suspends idle standby and Back starts a fresh idle interval', async ({ page }) => {
  await setupFactory(page);
  await page.clock.install();
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  await page.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Storage findings' })).toBeVisible();
  await page.clock.fastForward(6 * 60 * 1000);
  await expect(page).toHaveURL(/#\/code$/);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Storage findings' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to research task' }).click();
  await page.clock.fastForward(299000);
  await expect(page).toHaveURL(/#\/code$/);
  await page.clock.fastForward(2000);
  await expect(page).toHaveURL(/#\/standby$/);
});

test('a ringing timer closes the reader and leaves alarm dismissal available', async ({ page }) => {
  await setupFactory(page);
  await page.clock.install();
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  await page.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis-device-action', {
    detail: { type: 'client_action', action: 'start_timer', args: { seconds: 2, label: 'Research timer' } },
  })));
  await page.clock.fastForward(1000);
  await expect(page.locator('iframe')).toBeVisible();
  await page.clock.fastForward(2000);
  const alarm = page.getByRole('alertdialog');
  await expect(alarm.getByRole('heading', { name: 'Research timer' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toHaveCount(0);
  await alarm.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(alarm).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toBeVisible();
});

test('a voice session closes the reader and leaves the stop control operable', async ({ page }) => {
  const state = await setupFactory(page);
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  await page.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  state.voice(true);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop voice chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop voice chat', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toBeVisible();
});

test('a door camera preview closes the report then restores the research selection', async ({ page }) => {
  await setupFactory(page);
  await page.route('**/api/cameras', route => route.fulfill({ json: [{ id: 'front', device_name: 'Front door' }] }));
  await page.route('**/api/cameras/front/snapshot?*', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#352944"/></svg>',
  }));
  await page.clock.install();
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('button', { name: /Compare grid storage/ }).click();
  await page.getByRole('button', { name: 'Read report', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis-device-action', {
    detail: { type: 'client_action', action: 'show_camera_preview', args: { camera_device_id: 'front' } },
  })));
  await expect(page).toHaveURL(/#\/cameras\/front$/);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Research task details' })).toHaveCount(0);
  await expect(page.locator('.cam-stream:visible')).toBeVisible();
  expect(await page.locator('.cam-stream:visible').evaluate(image => {
    const box = image.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === image;
  })).toBe(true);
  await page.clock.fastForward(10000);
  await expect(page).toHaveURL(/#\/code$/);
  const details = page.getByRole('dialog', { name: 'Research task details' });
  await expect(details.getByText('Compare grid storage', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Read report', exact: true })).toBeEnabled();
});

test('coding still creates and queues follow-ups through coding endpoints', async ({ page }) => {
  const state = await setupFactory(page);
  await page.goto('/#/code');
  const dialog = await recordPrompt(page, 'coding');
  await expect(dialog.getByRole('radiogroup', { name: 'Report detail' })).toHaveCount(0);
  await dialog.getByRole('radio', { name: 'Terra', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Coding task details' });
  await details.getByRole('button', { name: 'Follow up', exact: true }).click();
  state.transcript.code = 'Add the regression test';
  const followUp = page.getByRole('dialog', { name: 'Queue a follow-up' });
  await followUp.getByRole('button', { name: 'Push to record', exact: true }).click();
  await followUp.getByRole('button', { name: 'Push to stop', exact: true }).click();
  await followUp.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect(details.getByText('Add the regression test', { exact: true })).toBeVisible();
  expect(state.calls.find(call => call.path === '/api/code-tasks' && call.method === 'POST')?.body).toEqual({ prompt: 'Code prompt draft', model: 'gpt-5.6-terra' });
  expect(state.calls.find(call => call.path === '/api/code-tasks/code-created/follow-up')?.body).toEqual({ prompt: 'Add the regression test' });
  expect(state.calls.some(call => call.path.startsWith('/api/research-tasks'))).toBe(false);
});

test('research history retains older pages across refresh and fits the touchscreen', async ({ page }) => {
  const state = await setupFactory(page);
  state.pageSize = 10;
  state.tasks.research = Array.from({ length: 25 }, (_, index) => task('research', `history-${String(index).padStart(2, '0')}`, `Storage history ${index}`, 'success'));
  await page.goto('/#/code');
  await chooseMode(page, 'Research');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  const list = page.locator('.code-task-list:visible');
  await expect(page.getByText('Storage history 9', { exact: true })).toBeAttached();
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText('Storage history 19', { exact: true })).toBeAttached();
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText('Storage history 24', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
  await expect(page.getByText('Storage history 24', { exact: true })).toBeAttached();
  state.listFailures = 1;
  await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Factory unavailable. Try again.');
  await expect(page.getByText('Storage history 24', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.calls.filter(call => call.path === '/api/research-tasks').some(call => call.query.get('cursor') === '10')).toBe(true);
  expect(state.calls.filter(call => call.path === '/api/research-tasks').some(call => call.query.get('cursor') === '20')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const nav = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(listBox.height).toBeGreaterThan(100);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(nav.y);
  for (const name of ['Code', 'Research', '+ New task']) {
    const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
  }
});
