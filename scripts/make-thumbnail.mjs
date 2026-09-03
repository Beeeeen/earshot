/**
 * The Devpost gallery card.
 *
 *   npm run thumbnail        # → docs/thumbnail.png, 1500x1000 (3:2)
 *
 * It is displayed at roughly a quarter of this size in a grid of a few hundred
 * other cards, so it is built to survive that: one claim in type large enough to
 * read at 360px wide, three numbers under it, and a slice of the real app on the
 * right for texture rather than for detail. Same palette as the page itself.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = process.cwd();
const OUT = join(ROOT, 'docs', 'thumbnail.png');
const SHOT = `data:image/png;base64,${readFileSync(join(ROOT, 'docs', 'screenshot.png')).toString('base64')}`;

const W = 1500;
const H = 1000;

const stats = [
  ['1,000,000', 'rows in the tab'],
  ['27 KB', 'to the agent'],
  ['0', 'rows disclosed'],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.setContent(
    `<style>
       @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;800&display=swap');
       * { box-sizing: border-box; margin: 0; }
       body { width: ${W}px; height: ${H}px; display: flex; background: #fbfbfa;
              font-family: Inter, ui-sans-serif, system-ui, 'Segoe UI', sans-serif;
              color: #14181a; overflow: hidden; }
       .left { width: 58%; padding: 74px 60px 74px 74px; display: flex; flex-direction: column;
              justify-content: center; position: relative; }
       /* Pinned, so the claim and its numbers sit as one centred block instead of
          leaving a hole in the middle of the card. */
       .mark { position: absolute; top: 74px; left: 74px; }
       .mark { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 600; }
       .mark i { width: 34px; height: 34px; border-radius: 9px; background: #1f6f4a; display: block; }
       h1 { font-size: 82px; line-height: 1.02; letter-spacing: -.035em; font-weight: 800; }
       h1 em { font-style: normal; color: #1f6f4a; }
       .sub { margin-top: 28px; font-size: 27px; line-height: 1.35; color: #55635c; font-weight: 500;
              max-width: 640px; }
       .how { margin-top: 34px; padding-top: 30px; border-top: 2px solid #e2e7e4;
              font-size: 21px; font-weight: 600; color: #1f6f4a; letter-spacing: .01em; }
       .stats { margin-top: 52px; display: flex; gap: 46px; }
       .stat b { display: block; font-size: 42px; font-weight: 800; letter-spacing: -.02em; }
       .stat span { display: block; font-size: 20px; color: #6b7a73; margin-top: 4px; font-weight: 500; }
       .right { width: 42%; position: relative; background: #eef1ef; overflow: hidden; }
       /* Overscaled so there is something to crop: the screenshot was taken in a
          browser without WebMCP, and its status badge says so along the top. */
       .right img { position: absolute; left: 0; top: -9%; width: 100%; height: 118%;
                  object-fit: cover; object-position: 56% 50%; }
       .fade { position: absolute; inset: 0;
               background: linear-gradient(90deg, #fbfbfa 0%, rgba(251,251,250,0) 22%); }
     </style>
     <div class="left">
       <div class="mark"><i></i> Blindfold</div>
       <h1>Analyse a file your AI could <em>never read</em></h1>
       <div class="sub">A million rows of payroll in the tab. The agent runs the
         whole analysis and never receives a single row.</div>
       <div class="how">Eight WebMCP tools · DuckDB-WASM in the tab · no server, no upload</div>
       <div class="stats">
         ${stats.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')}
       </div>
     </div>
     <div class="right"><img src="${SHOT}"><div class="fade"></div></div>`,
    { waitUntil: 'networkidle0' },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT });
} finally {
  await browser.close();
}
console.log(`wrote ${OUT}  (${W}x${H}, 3:2)`);
