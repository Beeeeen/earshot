/**
 * Devpost gallery assets.
 *
 *   node demo/tools/render-devpost.mjs
 *
 * Writes into docs/assets/:
 *   thumbnail.png      1200x630, the gallery card
 *   still-1..5.png     1600x1000, each with its caption set into the image
 *   captions.json      the same captions as text, for the upload form
 *
 * Two things worth knowing about how these are made:
 *
 * 1. Everything is supersampled. Pages are rendered at deviceScaleFactor 2 and
 *    then downsampled to the target size with Pillow/LANCZOS, because a gallery
 *    card is judged on whether the type looks sharp at a quarter size.
 *
 * 2. The thumbnail is composed, not screenshotted. It takes two real elements
 *    out of the running demo -- the spoken reply and the private card -- and
 *    arranges them next to one sentence. A raw screenshot of a two-pane app is
 *    unreadable at gallery size.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { puppeteer, chromePath, serveDemo, openDemo, ROOT, DEMO } from './lib/browser.mjs';
import { C, mark, SANS, MONO } from './lib/brand.mjs';

const OUT = join(ROOT, 'docs', 'assets');
const TMP = join(DEMO, '.shots', 'tmp');
const DSF = 2;

const STILLS = [
  { beat: 1, n: 1,
    cap: 'One Echo, three people, one of them not family. The answer is spoken; the drug name is not.' },
  { beat: 2, n: 2,
    cap: 'A prompt injection in the tool call orders it to speak the drug name. The spoken line comes back byte-identical.' },
  { beat: 5, n: 3, device: true,
    cap: 'The same answer in full, on the asker’s own device, over the MCP Apps card.' },
  { beat: 9, n: 4, raw: true,
    cap: 'Every word the room heard, searchable. “Furosemide”: no match, in 1,045 characters.' },
  { beat: 9, n: 5,
    cap: 'Four spoken answers, three channel shifts, two refusals, one sealed — and nothing protected said aloud.' },
];

/* --------------------------------------------------------------- helpers -- */

const png = (buf) => 'data:image/png;base64,' + Buffer.from(buf).toString('base64');

/** Renders `html` at w x h CSS px, supersampled, and writes it at exactly w x h. */
async function shoot(browser, html, w, h, file) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: DSF });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const big = join(TMP, 'big.png');
  await page.screenshot({ path: big, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  execFileSync('python', ['-c',
    'import sys;from PIL import Image;' +
    'im=Image.open(sys.argv[1]).convert("RGB");' +
    'im.resize((int(sys.argv[3]),int(sys.argv[4])),Image.LANCZOS).save(sys.argv[2],optimize=True)',
    big, file, String(w), String(h)]);
  return file;
}

const shell = (fontsDir, css, body) => `<!doctype html><meta charset="utf-8">
<style>
  @font-face{font-family:'Inter';font-weight:400 800;font-display:block;
             src:url('${fontsDir}/Inter-latin.woff2') format('woff2')}
  @font-face{font-family:'JetBrains Mono';font-weight:400 700;font-display:block;
             src:url('${fontsDir}/JetBrainsMono-latin.woff2') format('woff2')}
  *{box-sizing:border-box;margin:0}
  body{font-family:${SANS};background:${C.page};color:${C.ink};
       -webkit-font-smoothing:antialiased;overflow:hidden}
  ${css}
</style>${body}`;

const markSvg = (px) => `<svg viewBox="0 0 100 100" width="${px}" height="${px}">
  ${mark({ arc: C.amber, phone: C.cyan, w: 8 })}</svg>`;

/* ------------------------------------------------------------------ main -- */

await mkdir(OUT, { recursive: true });
await mkdir(TMP, { recursive: true });

const server = await serveDemo(5204);
const fontsDir = server.url + 'fonts';
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
});

const made = [];
try {
  /* ---------------------------------------------------------- thumbnail -- */
  {
    const { page } = await openDemo(browser, server.url,
      'speed=8&still=2', { width: 1920, height: 1080, deviceScaleFactor: DSF });

    /* The NEWEST card, scrolled into view first. Taking `.card` grabs the
       oldest one, which by this beat has scrolled out of the phone and clips
       to an empty rectangle -- a silently blank panel on the finished card. */
    const clipOf = async (sel) => {
      const box = await page.evaluate((s) => {
        const all = document.querySelectorAll(s);
        const e = all[all.length - 1];
        e.scrollIntoView({ block: 'nearest' });
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, sel);
      if (box.y < 0 || box.height < 40 || box.width < 40) {
        throw new Error(`${sel} is not fully on screen (${JSON.stringify(box)}) — ` +
                        'it would have been captured blank');
      }
      return png(await page.screenshot({ clip: box }));
    };
    // Only the card is taken as a picture. The spoken line is set as type: a
    // crop of it lands about 9px tall on a gallery card, which is decoration
    // pretending to be evidence.
    const cardImg = await clipOf('.card');
    // Live mode has no synthetic refusal flag -- the server's answer is the
    // answer -- so fall back to the newest spoken line.
    const said = await page.evaluate(() => {
      const all = document.querySelectorAll('.utt-alexa .said');
      const refused = document.querySelector('.utt-alexa[data-refused] .said');
      return (refused || all[all.length - 1]).textContent;
    });
    await page.close();

    const stats = [
      ['0', 'protected values spoken aloud'],
      ['3', 'tiers: spoken · private · sealed'],
    ];

    const html = shell(fontsDir, `
      body{width:1200px;height:630px;display:grid;grid-template-columns:640px 560px}
      .l{padding:52px 30px 46px 56px;display:flex;flex-direction:column}
      .brand{display:flex;align-items:center;gap:13px;font-size:26px;font-weight:700}
      h1{margin-top:auto;font-size:53px;line-height:1.06;letter-spacing:-0.032em;
         font-weight:800;max-width:14ch}
      h1 em{font-style:normal;color:${C.cyan}}
      .sub{margin-top:20px;font-size:20px;line-height:1.4;color:${C.ink2};max-width:34ch}
      .stats{margin-top:auto;padding-top:26px;display:flex;gap:26px;
             border-top:1px solid rgba(185,198,208,.18)}
      .stat b{display:block;font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:1}
      .stat:nth-child(1) b{color:${C.cyan}}
      .stat span{display:block;margin-top:7px;font-size:14px;line-height:1.3;color:${C.ink3};
                 max-width:15ch}
      .r{position:relative;padding:38px 36px;display:flex;flex-direction:column;
         background:
         radial-gradient(120% 90% at 85% 15%, rgba(79,224,210,.11), transparent 62%),
         radial-gradient(100% 80% at 0% 65%, rgba(255,182,39,.10), transparent 60%),
         ${C.tile};
         border-left:1px solid rgba(185,198,208,.14);overflow:hidden}
      .lbl{display:flex;align-items:center;gap:8px;
           font:700 13px/1 ${SANS};letter-spacing:.15em;text-transform:uppercase}
      .lbl-a{color:${C.amber}} .lbl-b{color:${C.cyan}}
      .quote{margin-top:15px;padding-left:18px;border-left:4px solid ${C.amber};
             font-size:27px;line-height:1.28;font-weight:600;letter-spacing:-.017em}
      .hop{margin:22px 0 20px;display:flex;align-items:center;gap:13px;
           font:700 13px/1 ${SANS};letter-spacing:.15em;text-transform:uppercase;color:${C.cyan}}
      .hop .rule{flex:1;height:1px;background:linear-gradient(90deg,
                 rgba(79,224,210,.55),rgba(79,224,210,.12))}
      .cardwrap{position:relative;margin-top:14px;flex:1;min-height:0;overflow:hidden;
                border-radius:13px;box-shadow:0 20px 46px rgba(0,0,0,.62);
                outline:1px solid rgba(79,224,210,.4)}
      .cardwrap img{width:100%;display:block}
      /* The card is taller than the space. Fade the cut so it reads as "there
         is more of this", not as a screenshot that ran out of room. */
      .cardwrap::after{content:'';position:absolute;inset:auto 0 0 0;height:80px;
                       background:linear-gradient(rgba(16,21,25,0),rgba(16,21,25,.97))}
    `, `
      <div class="l">
        <div class="brand">${markSvg(34)} Earshot</div>
        <h1>The room hears the answer. <em>Only her phone hears the drug name.</em></h1>
        <p class="sub">An Alexa+ MCP add-on for shared-device care. One rule: a protected
           value can never appear in anything the assistant says out loud.</p>
        <div class="stats">${stats.map(([n, l]) =>
          `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>
      </div>
      <div class="r">
        <span class="lbl lbl-a">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor">
            <path d="M3 7h2.6L9 4v12l-3.4-3H3z"/></svg>
          Said out loud, to everyone present
        </span>
        <p class="quote">“${said}”</p>
        <div class="hop">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v13"/><path d="M6.5 12 12 17.5 17.5 12"/></svg>
          channel shift<span class="rule"></span>
        </div>
        <span class="lbl lbl-b">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2"><rect x="5.5" y="2.5" width="9" height="15" rx="2.2"/></svg>
          Her phone, and only hers
        </span>
        <div class="cardwrap"><img src="${cardImg}"></div>
      </div>`);

    made.push(await shoot(browser, html, 1200, 630, join(OUT, 'thumbnail.png')));
  }

  /* ------------------------------------------------------------- stills -- */
  for (const s of STILLS) {
    const q = `speed=8&still=${s.beat}` + (s.raw ? '&raw=1' : '');
    const { page } = await openDemo(browser, server.url, q,
      { width: 1600, height: 900, deviceScaleFactor: DSF });

    let shot;
    if (s.device) {
      // A close-up needs its own frame, not a 1600px-wide page shrunk down.
      const box = await page.$eval('.phone-pane .device', (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x - 18, y: r.y - 18, width: r.width + 36, height: r.height + 36 };
      });
      shot = png(await page.screenshot({ clip: box }));
    } else {
      shot = png(await page.screenshot({ clip: { x: 0, y: 0, width: 1600, height: 900 } }));
    }
    await page.close();

    const body = s.device
      ? `<div class="frame device"><img src="${shot}"></div>`
      : `<div class="frame"><img class="full" src="${shot}"></div>`;

    const html = shell(fontsDir, `
      body{width:1600px;height:1000px;display:flex;flex-direction:column}
      .frame{height:900px;position:relative;overflow:hidden;background:${C.page}}
      img.full{width:1600px;height:900px;display:block}
      .device{display:grid;place-items:center;
        background:radial-gradient(80% 70% at 50% 40%, rgba(79,224,210,.09), transparent 65%),${C.page}}
      .device img{height:840px;width:auto;filter:drop-shadow(0 24px 60px rgba(0,0,0,.65))}
      .cap{height:100px;flex:none;display:flex;align-items:center;gap:20px;
           padding:0 40px;background:${C.tile};border-top:3px solid ${C.amber}}
      .n{font:800 20px/1 ${MONO};color:${C.page};background:${C.amber};
         width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}
      .cap p{font-size:27px;line-height:1.3;font-weight:600;letter-spacing:-.012em}
      .who{margin-left:auto;display:flex;align-items:center;gap:11px;flex:none;
           font:700 16px/1 ${SANS};color:${C.ink3};letter-spacing:.04em}
    `, `${body}
      <div class="cap">
        <span class="n">${s.n}</span>
        <p>${s.cap}</p>
        <span class="who">${markSvg(26)} Earshot</span>
      </div>`);

    made.push(await shoot(browser, html, 1600, 1000, join(OUT, `still-${s.n}.png`)));
  }

  await writeFile(join(OUT, 'captions.json'), JSON.stringify({
    thumbnail: 'The room hears the answer. Only her phone hears the drug name.',
    stills: STILLS.map((s) => ({ file: `still-${s.n}.png`, caption: s.cap })),
  }, null, 2) + '\n');
  made.push(join(OUT, 'captions.json'));
} finally {
  await browser.close();
  server.stop();
  await rm(TMP, { recursive: true, force: true });
}

for (const f of made) console.log('  ' + f);
