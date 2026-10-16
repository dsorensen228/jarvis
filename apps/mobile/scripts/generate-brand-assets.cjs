const path = require('node:path');
const Jimp = require('jimp-compact');

const repoRoot = path.resolve(__dirname, '../../..');
const assetsDir = path.join(repoRoot, 'apps/mobile/assets');

async function generateBrandAssets() {
  const source = await Jimp.read(path.join(repoRoot, 'assets/branding/jarvis-geometric.png'));
  const resized = (size) => source.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
  const write = (image, name) => image.writeAsync(path.join(assetsDir, name));

  for (const name of ['jarvis.png', 'jarvis_foreground.png', 'logo.png', 'logo_transparent.png']) {
    await write(resized(1024), name);
  }
  await write(resized(64), 'favicon_64.png');

  // Keep the portrait inside Android's adaptive icon mask. The selected artwork
  // is opaque; only the surrounding padding is transparent on the foreground.
  await write(new Jimp(1024, 1024, 0x00000000).composite(resized(800), 112, 112), 'jarvis_adaptive_foreground.png');
  await write(new Jimp(1024, 1024, 0x000000ff), 'jarvis_adaptive_background.png');
  await write(new Jimp(2048, 2048, 0x000000ff).composite(resized(1408), 320, 320), 'splash.png');
}

generateBrandAssets().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
