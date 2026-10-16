import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let javascript: string;
let stylesheet: string;

test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchReportViewer } from './src/ResearchReportViewer';
const root = createRoot(document.getElementById('root'));
window.mountReport = (props) => root.render(createElement(ResearchReportViewer, {
  ...props, onClose: () => root.render(createElement('p', null, 'Report closed')),
}));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    outdir: 'viewer-test-output',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  javascript = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  stylesheet = `${await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')}\n${result.outputFiles.find(file => file.path.endsWith('.css'))!.text}`;
});

async function mountReport(page: Page, html: string, title = 'Research report') {
  await page.setContent('<button id="opener">Open report</button><div id="root"></div>');
  await page.locator('#opener').focus();
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: javascript });
  await page.evaluate(() => {
    (window as any).readingEvents = [];
    window.addEventListener('jarvis-report-reading', event => (window as any).readingEvents.push((event as CustomEvent).detail.active));
  });
  await page.evaluate(props => (window as any).mountReport(props), { html, title });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.frameLocator('iframe').locator('main')).toBeVisible();
}

test('report keeps semantic tables, static diagrams and in-document section links', async ({ page }, info) => {
  await mountReport(page, `<h1>Storage comparison</h1><a href="#sources">Sources</a>
    <div class="table-wrap"><table><caption>Cost</caption><tr><th scope="col">Type</th><th scope="col">Price</th></tr><tr><td>Battery</td><td>$100</td></tr></table></div>
    <figure><svg viewBox="0 0 400 100" role="img" aria-label="Capacity"><title>Capacity chart</title><rect x="5" y="5" width="200" height="40" fill="#bf5af2"/><text x="10" y="70">Battery</text></svg><figcaption>Stored energy</figcaption></figure>
    ${'<p>Report detail.</p>'.repeat(30)}<h2 id="sources">Sources used</h2><p>Published findings.</p>`);
  const report = page.frameLocator('iframe');
  await expect(report.getByRole('table', { name: 'Cost' })).toBeVisible();
  await expect(report.getByRole('columnheader', { name: 'Type' })).toBeVisible();
  await expect(report.getByRole('img', { name: 'Capacity' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('report-reader.png') });
  await report.getByRole('link', { name: 'Sources', exact: true }).tap();
  await expect(report.getByRole('heading', { name: 'Sources used' })).toBeInViewport();
  await page.getByRole('button', { name: 'Increase report text size' }).tap();
  await expect(report.getByRole('heading', { name: 'Sources used' })).toBeInViewport();
  expect(page.frames().find(frame => frame.parentFrame())!.url()).toBe('about:srcdoc#sources');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('report cannot execute code, load external assets, or navigate to sources', async ({ page, context }) => {
  const externalRequests: string[] = [];
  page.on('request', request => externalRequests.push(request.url()));
  const title = 'Report </title><script>window.top.escaped=true</script>';
  await mountReport(page, `<h1>Safe report</h1>
    <script>window.top.escaped=true</script><style>body{background-image:url(https://escape.invalid/style)}</style>
    <meta http-equiv="refresh" content="0;url=https://escape.invalid/refresh"><base href="https://escape.invalid/">
    <iframe src="https://escape.invalid/frame"></iframe><img src="https://escape.invalid/image" onerror="window.top.escaped=true">
    <form action="https://escape.invalid/form"><button>Submit</button></form>
    <a href="https://example.com/source?a=1&amp;b=2" target="_top" ping="https://escape.invalid/ping">Source page</a>
    <a href="javascript:window.top.escaped=true">Invalid source</a><a href="//escape.invalid">Relative source</a>
    <svg viewBox="0 0 200 80"><a href="https://escape.invalid/svg"><text y="20">SVG link</text></a><foreignObject><iframe src="https://escape.invalid/foreign"></iframe></foreignObject><animate attributeName="href" values="https://escape.invalid"/><rect width="100" height="40" fill="url(https://escape.invalid/fill)" onclick="window.top.escaped=true"/></svg>`, title);
  const frame = page.locator('iframe');
  const report = page.frameLocator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(report.locator('script, iframe, img, form, foreignObject, animate, [onclick], [onerror]')).toHaveCount(0);
  await expect(report.locator('head meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'.*script-src 'none'/);
  await expect(report.getByText('https://example.com/source?a=1&b=2', { exact: true })).toBeVisible();
  await report.getByText('Source page', { exact: true }).tap();
  await expect(report.getByRole('heading', { name: 'Safe report' })).toBeVisible();
  await expect(report.locator('a[href]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).escaped)).toBeUndefined();
  expect(externalRequests).toEqual([]);
  expect(context.pages()).toHaveLength(1);
});

test('touch controls resize the report within readable bounds and return focus on close', async ({ page }) => {
  await mountReport(page, '<h1>A report</h1><p>Readable body text.</p>', 'Comparison report');
  const dialog = page.getByRole('dialog', { name: 'Comparison report' });
  const smaller = dialog.getByRole('button', { name: 'Decrease report text size' });
  const larger = dialog.getByRole('button', { name: 'Increase report text size' });
  const back = dialog.getByRole('button', { name: 'Back to research task' });
  expect(await page.evaluate(() => (window as any).readingEvents)).toEqual([true]);
  for (const control of [smaller, larger, back]) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  const body = page.frameLocator('iframe').locator('body');
  await expect(body).toHaveCSS('font-size', '16px');
  const effectiveTextSize = async () => {
    const fontSize = await body.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const frameScale = await page.locator('iframe').evaluate(element => element.getBoundingClientRect().width / element.clientWidth);
    return Math.round(fontSize * frameScale);
  };
  await larger.tap();
  await expect.poll(effectiveTextSize).toBe(18);
  await larger.tap(); await larger.tap();
  await expect.poll(effectiveTextSize).toBe(22);
  await expect(larger).toBeDisabled();
  for (let index = 0; index < 4; index += 1) await smaller.tap();
  await expect.poll(effectiveTextSize).toBe(14);
  await expect(smaller).toBeDisabled();
  await back.tap();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#opener')).toBeFocused();
  expect(await page.evaluate(() => (window as any).readingEvents)).toEqual([true, false]);
});

test('report fits a compact 480 by 320 screen with scrollable wide tables', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 });
  await mountReport(page, '<h1>Comparison</h1><table><tr><th>Detailed technology description</th><th>Expected cost over lifetime</th><th>Storage capacity</th><th>Availability</th></tr><tr><td>Battery technology</td><td>$100,000</td><td>1,000 kWh</td><td>Available now</td></tr></table>', 'A long research title that should not hide the reading controls');
  const report = page.frameLocator('iframe');
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await report.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(report.getByRole('table')).toBeVisible();
  await report.getByRole('table').tap();
  // The sandbox owns keyboard events while the iframe has focus; the kiosk's Back control stays reachable.
  await page.getByRole('button', { name: 'Back to research task' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
