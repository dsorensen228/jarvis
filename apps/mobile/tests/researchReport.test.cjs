const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../lib/researchReport.ts');
const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleScope = { exports: {} };
vm.runInNewContext(output, { exports: moduleScope.exports, module: moduleScope, URL });
const { buildResearchReportDocument, isExternalReportUrl, isLocalReportUrl } = moduleScope.exports;
const colors = {
  background: '#000000', surface: '#0d0814', surfaceElevated: '#181022',
  text: '#e4ddea', textMuted: '#9f93b1', accent: '#7b4dff', border: '#241935',
};

test('wraps a sanitized fragment with its title escaped and an isolated document policy', () => {
  const html = buildResearchReportDocument('<article><h1>Findings</h1><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" /></svg></article>', colors, 'dark', '</title><script>bad()</script>');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(html.includes('<h1>Findings</h1>'));
  assert.ok(html.includes('<svg viewBox="0 0 10 10">'));
  assert.ok(html.includes('default-src \'none\''));
  assert.ok(html.includes('script-src \'none\''));
  assert.ok(html.includes('form-action \'none\''));
  assert.ok(html.includes('img-src data:'));
  assert.ok(html.includes('<base href="about:blank">'));
  assert.ok(html.includes('base-uri about:'));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<article>'));
  assert.ok(!html.includes('<script>'));
});

test('web reports resolve local anchors against their own srcdoc', () => {
  const html = buildResearchReportDocument('<a href="#source">Source</a><p id="source">Evidence</p>', colors, 'dark', 'Report', 'about:srcdoc');
  assert.ok(html.includes('<base href="about:srcdoc">'));
});

test('only http and https links may leave the report viewer', () => {
  for (const url of ['https://example.com/report?a=1#source', 'http://example.org/']) {
    assert.equal(isExternalReportUrl(url), true, url);
  }
  for (const url of ['javascript:alert(1)', 'file:///secret', 'data:text/html,hello', 'intent://app', '//example.com', '/v1/admin', 'https://name:password@example.com/', 'https://', ' https://example.com']) {
    assert.equal(isExternalReportUrl(url), false, url);
  }
});

test('local navigation accepts only the viewer document and its anchors', () => {
  for (const url of ['about:blank', 'about:blank#source', 'about:srcdoc', 'about:srcdoc#source']) {
    assert.equal(isLocalReportUrl(url), true, url);
  }
  for (const url of ['about:blank.example.com', 'about:blank?redirect=https://example.com', 'about:srcdoc/other', 'data:text/html,test', 'https://example.com']) {
    assert.equal(isLocalReportUrl(url), false, url);
  }
});
