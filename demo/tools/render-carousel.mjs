/**
 * The 600x900 carousel image for the add-on listing, plus the asset manifest.
 *
 *   node demo/tools/render-carousel.mjs        # run render-icons.mjs first
 *
 * Writes addon-package/carousel-1-600x900.png and addon-package/assets.json,
 * the latter listing every icon and carousel image with its alt text, so the
 * submission form can be filled from one file. Alt text is asserted at <=250
 * characters here rather than trusted to be short enough.
 *
 * Portrait, and read top to bottom: what the room got, then the shift, then
 * what only she got. Same order as the demo reads left to right.
 */
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { puppeteer, chromePath, serveDemo, openDemo, ROOT } from './lib/browser.mjs';
import { C, mark, SANS } from './lib/brand.mjs';

const PKG = join(ROOT, 'addon-package');
const W = 600;
const H = 900;
const DSF = 2;

const ALT =
  'Earshot for Alexa+. The Echo says out loud: “I can’t put that one in the ' +
  'room. It’s on your phone.” Below it, the private card on the asker’s own ' +
  'phone showing medication, dose and diagnosis. Protected values spoken ' +
  'aloud: 0.';

if (ALT.length > 250) {
  throw new Error(`alt text is ${ALT.length} characters, limit is 250`);
}

await mkdir(PKG, { recursive: true });

const server = await serveDemo(5205);
const fontsDir = server.url + 'fonts';
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
});

let out;
try {
  const { page } = await openDemo(browser, server.url, 'speed=8&still=2',
    { width: 1920, height: 1080, deviceScaleFactor: DSF });
  const box = await page.$eval('.card', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cardImg = 'data:image/png;base64,' +
    Buffer.from(await page.screenshot({ clip: box })).toString('base64');
  const said = await page.$eval('.utt-alexa[data-refused] .said', (e) => e.textContent);
  await page.close();

  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:'Inter';font-weight:400 800;font-display:block;
               src:url('${fontsDir}/Inter-latin.woff2') format('woff2')}
    *{box-sizing:border-box;margin:0}
    body{width:${W}px;height:${H}px;padding:40px 36px 34px;overflow:hidden;
         font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased;
         display:flex;flex-direction:column;
         background:
           radial-gradient(90% 45% at 88% 6%, rgba(255,182,39,.13), transparent 62%),
           radial-gradient(95% 45% at 8% 72%, rgba(79,224,210,.13), transparent 62%),
           ${C.page}}
    .brand{display:flex;align-items:center;gap:12px;font-size:25px;font-weight:700}
    h1{margin-top:22px;font-size:40px;line-height:1.08;letter-spacing:-.032em;font-weight:800}
    h1 em{font-style:normal;color:${C.cyan}}
    .lbl{display:flex;align-items:center;gap:8px;margin-top:30px;
         font:700 13px/1 ${SANS};letter-spacing:.15em;text-transform:uppercase}
    .lbl-a{color:${C.amber}} .lbl-b{color:${C.cyan}}
    .quote{margin-top:13px;padding-left:16px;border-left:4px solid ${C.amber};
           font-size:23px;line-height:1.3;font-weight:600;letter-spacing:-.015em}
    .hop{margin-top:22px;display:flex;align-items:center;gap:12px;color:${C.cyan};
         font:700 13px/1 ${SANS};letter-spacing:.15em;text-transform:uppercase}
    .hop .rule{flex:1;height:1px;
               background:linear-gradient(90deg,rgba(79,224,210,.55),rgba(79,224,210,.1))}
    img.card{margin-top:13px;width:100%;border-radius:13px;
             box-shadow:0 18px 44px rgba(0,0,0,.6);outline:1px solid rgba(79,224,210,.4)}
    .foot{margin-top:auto;padding-top:22px;display:flex;align-items:center;gap:18px;
          border-top:1px solid rgba(185,198,208,.2)}
    .foot b{font-size:52px;font-weight:800;line-height:.9;letter-spacing:-.04em;color:${C.cyan}}
    .foot span{font-size:16px;line-height:1.3;color:${C.ink2};font-weight:600}
    .foot i{display:block;font-style:normal;font-size:13px;color:${C.ink3};font-weight:500;
            margin-top:3px}
  </style>
  <div class="brand">
    <svg viewBox="0 0 100 100" width="32" height="32">
      ${mark({ arc: C.amber, phone: C.cyan, w: 8 })}</svg> Earshot
  </div>
  <h1>The room hears the answer.<br><em>Only her phone hears<br>the drug name.</em></h1>

  <span class="lbl lbl-a">
    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
      <path d="M3 7h2.6L9 4v12l-3.4-3H3z"/></svg>
    Said out loud, to everyone present
  </span>
  <p class="quote">“${said}”</p>

  <div class="hop">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 4v13"/><path d="M6.5 12 12 17.5 17.5 12"/></svg>
    channel shift<span class="rule"></span>
  </div>
  <span class="lbl lbl-b" style="margin-top:14px">
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
         stroke-width="2"><rect x="5.5" y="2.5" width="9" height="15" rx="2.2"/></svg>
    Her phone, and only hers
  </span>
  <img class="card" src="${cardImg}">

  <div class="foot">
    <b>0</b>
    <span>protected values spoken aloud
      <i>three tiers: spoken · private · sealed</i></span>
  </div>`;

  const shot = await browser.newPage();
  await shot.setViewport({ width: W, height: H, deviceScaleFactor: DSF });
  await shot.setContent(html, { waitUntil: 'networkidle0' });
  await shot.evaluate(() => document.fonts.ready);
  const big = join(PKG, '.carousel-2x.png');
  await shot.screenshot({ path: big, clip: { x: 0, y: 0, width: W, height: H } });
  await shot.close();

  out = join(PKG, 'carousel-1-600x900.png');
  execFileSync('python', ['-c',
    'import sys,os;from PIL import Image;' +
    'im=Image.open(sys.argv[1]).convert("RGB");' +
    'im.resize((600,900),Image.LANCZOS).save(sys.argv[2],optimize=True);' +
    'os.remove(sys.argv[1])', big, out]);
} finally {
  await browser.close();
  server.stop();
}

/* ------------------------------------------------------- the asset manifest */
const icons = (await readdir(join(PKG, 'icons'))).filter((f) => f.endsWith('.png')).sort();
const grouped = { light: {}, dark: {} };
for (const f of icons) {
  const m = /^icon-(light|dark)-(\d+)x\1?\d*/.exec(f) || /^icon-(light|dark)-(\d+)x(\d+)\.png$/.exec(f);
  if (m) grouped[m[1]][m[2]] = 'icons/' + f;
}

await writeFile(join(PKG, 'assets.json'), JSON.stringify({
  name: 'Earshot',
  summary: 'Care coordination for a device the whole room can hear.',
  icons: {
    light: grouped.light,
    dark: grouped.dark,
    note: 'Light-theme icons are the dark tile, for display on light surfaces; ' +
          'dark-theme icons are the near-white tile. All opaque, full-bleed, ' +
          'safe under any rounded mask.',
  },
  carousel: [{ file: 'carousel-1-600x900.png', width: 600, height: 900, alt: ALT }],
}, null, 2) + '\n');

console.log('  ' + out);
console.log('  ' + join(PKG, 'assets.json'));
console.log(`  alt text: ${ALT.length}/250 characters`);
