/**
 * Contract: Cameras page must fit the kiosk viewport without vertical scrolling.
 * Camera JPEGs are larger than the leftover pane (e.g. 960×540 on an 800×480
 * display), so the shell must be viewport-bounded and the stream must fill its
 * pane with object-fit:contain — not grow from intrinsic image height.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(__dirname, '..', 'src', 'styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

function fail(msg) {
  console.error(`verify-camera-fit: ${msg}`);
  process.exit(1);
}

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm');
  const match = css.match(re);
  if (!match) fail(`missing rule for ${selector}`);
  return match[1];
}

function hasDecl(body, property, valueSubstr) {
  const re = new RegExp(
    `${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*[^;]*${valueSubstr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'i',
  );
  return re.test(body);
}

const shell = ruleBody('.device-shell');
if (!hasDecl(shell, 'height', '100dvh') && !hasDecl(shell, 'height', '100%')) {
  fail('.device-shell must set height to the viewport (100% / 100dvh)');
}
if (!hasDecl(shell, 'max-height', '100dvh') && !hasDecl(shell, 'max-height', '100%')) {
  fail('.device-shell must cap max-height to the viewport so content cannot grow the page');
}
if (!hasDecl(shell, 'overflow', 'hidden')) {
  fail('.device-shell must overflow:hidden so the document never scrolls');
}

const streamArea = ruleBody('.cameras-stream-area');
if (!hasDecl(streamArea, 'min-height', '0')) {
  fail('.cameras-stream-area must allow flex shrink (min-height:0)');
}
if (!hasDecl(streamArea, 'overflow', 'hidden')) {
  fail('.cameras-stream-area must overflow:hidden');
}
if (!hasDecl(streamArea, 'position', 'relative')) {
  fail('.cameras-stream-area must be position:relative for the absolute stream pane');
}

const streamInner = ruleBody('.cameras-stream-inner');
if (!hasDecl(streamInner, 'position', 'absolute')) {
  fail('.cameras-stream-inner must be position:absolute so the img has a definite box');
}
if (!hasDecl(streamInner, 'inset', '0') && !(hasDecl(streamInner, 'top', '0') && hasDecl(streamInner, 'bottom', '0'))) {
  fail('.cameras-stream-inner must fill the stream area (inset:0)');
}

const stream = ruleBody('.cam-stream');
if (!hasDecl(stream, 'object-fit', 'contain')) {
  fail('.cam-stream must object-fit:contain (letterbox, never crop)');
}
const fillsBox =
  (hasDecl(stream, 'width', '100%') && hasDecl(stream, 'height', '100%')) ||
  (hasDecl(stream, 'max-width', '100%') && hasDecl(stream, 'max-height', '100%') && hasDecl(stream, 'width', '100%') && hasDecl(stream, 'height', '100%'));
if (!fillsBox) {
  fail('.cam-stream must size to its pane (width/height 100%) so intrinsic JPEG size cannot force scroll');
}

console.log('verify-camera-fit: ok');
