/**
 * Contract: Spotify search tiles keep current column width but show the full
 * square album cover (not a short clipped strip). Grid rows must size to the
 * cover's 1:1 box instead of stretching/compressing tiles into the viewport.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(__dirname, '..', 'src', 'styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

function fail(msg) {
  console.error(`verify-spotify-search-covers: ${msg}`);
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

const cover = ruleBody('.spotify-tile-cover-wrap');
if (!hasDecl(cover, 'aspect-ratio', '1')) {
  fail('.spotify-tile-cover-wrap must keep aspect-ratio:1 for square covers');
}
if (!hasDecl(cover, 'width', '100%')) {
  fail('.spotify-tile-cover-wrap must keep width:100% (column width unchanged)');
}
if (!hasDecl(cover, 'flex-shrink', '0')) {
  fail('.spotify-tile-cover-wrap must flex-shrink:0 so the flex tile cannot crush cover height');
}

const tile = ruleBody('.spotify-tile');
if (!hasDecl(tile, 'align-self', 'start')) {
  fail('.spotify-tile must align-self:start so grid stretch cannot clip covers');
}
if (!hasDecl(tile, 'height', 'max-content') && !hasDecl(tile, 'min-height', 'max-content')) {
  fail('.spotify-tile must size to cover+label (height/min-height: max-content)');
}

const grid = ruleBody('.spotify-grid');
if (!hasDecl(grid, 'align-content', 'start')) {
  fail('.spotify-grid must align-content:start so auto rows are not compressed into equal short bands');
}

console.log('verify-spotify-search-covers: ok');
