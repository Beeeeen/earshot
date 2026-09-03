/**
 * Renders the add-on icon set into addon-package/icons/.
 *
 *   node demo/tools/render-icons.mjs
 *
 * Amazon's manifest wants six light-theme sizes; the dark set is optional and
 * is produced too. Each file is rendered by screenshotting the SVG at exactly
 * its target size rather than resampling one big PNG, so the stroke weight is
 * chosen per size instead of being smeared by a downscale.
 *
 * Tiles are opaque and full-bleed: a store that applies its own rounded mask
 * gets a clean result, and one that does not still gets a finished square.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { puppeteer, chromePath, ROOT } from './lib/browser.mjs';
import { iconSvg } from './lib/brand.mjs';

const SIZES = [72, 64, 88, 126, 180, 241];
const OUT = join(ROOT, 'addon-package', 'icons');

await mkdir(OUT, { recursive: true });

const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars'],
});

const written = [];
try {
  const page = await browser.newPage();
  for (const theme of ['light', 'dark']) {
    for (const px of SIZES) {
      await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;width:${px}px;height:${px}px;overflow:hidden}
                svg{display:block}</style>${iconSvg(theme, px)}`,
        { waitUntil: 'load' },
      );
      const file = join(OUT, `icon-${theme}-${px}x${px}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: px, height: px } });
      written.push(file);
    }
  }
} finally {
  await browser.close();
}

for (const f of written) console.log('  ' + f);
console.log(`${written.length} icons written to ${OUT}`);
