/**
 * Ensures `vite build` produced hashed JS/CSS under dist/assets.
 * Run as npm postbuild so an empty or missing output fails loudly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'dist', 'assets');

function fail(msg) {
  console.error(`verify-dist: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(assetsDir)) {
  fail(
    'dist/assets missing. Run `npm run build` from the jarvis_device_ui directory (or `npm run build:jarvis-device-ui` from the repo root).'
  );
}

const files = fs.readdirSync(assetsDir);
const hashed = files.filter((f) => /\.(js|css)$/.test(f) && f.startsWith('index-'));
if (hashed.length < 2) {
  fail(
    `expected hashed index-*.js and index-*.css in dist/assets; found: ${files.join(', ') || '(empty)'}`
  );
}

console.log('verify-dist: ok —', hashed.join(', '));
