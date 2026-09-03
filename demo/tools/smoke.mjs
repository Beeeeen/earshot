/**
 * Renders every beat of the demo and reports what it found, so layout problems
 * and console errors surface without opening a browser by hand.
 *
 *   node demo/tools/smoke.mjs                # writes demo/.shots/beat-N.png
 *   node demo/tools/smoke.mjs --beat 5
 *
 * It also re-checks the invariant from outside the page: for every beat it
 * reads the rendered transcript back out and greps it for each protected
 * value. That is the same check app.js does, run by a different process, which
 * is the only version of it worth trusting.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { puppeteer, chromePath, serveDemo, openDemo, DEMO } from './lib/browser.mjs';

const argv = process.argv.slice(2);
const one = argv.indexOf('--beat') >= 0 ? Number(argv[argv.indexOf('--beat') + 1]) : null;
const OUT = join(DEMO, '.shots');

const server = await serveDemo(5199);
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars',
         '--font-render-hinting=none'],
});

await mkdir(OUT, { recursive: true });
let bad = 0;

try {
  const { page } = await openDemo(browser, server.url, 'mode=scripted&speed=8&still=0');
  const beatCount = await page.evaluate(() => window.EARSHOT_SCENARIO.beats.length);
  await page.close();

  const beats = one === null ? [...Array(beatCount).keys()] : [one];

  for (const n of beats) {
    const { page, errors } = await openDemo(
      browser, server.url, `mode=scripted&speed=8&still=${n}`);

    const probe = await page.evaluate(() => {
      const S = window.EARSHOT_SCENARIO;
      const corpus = window.EarshotApp.roomCorpus();
      const hits = S.PROTECTED
        .filter((p) => [p.value].concat(p.alts || [])
          .some((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(corpus)))
        .map((p) => p.label);
      const doc = document.documentElement;
      return {
        counter: document.getElementById('counter').textContent,
        hits,
        chars: corpus.length,
        utterances: document.querySelectorAll('.utt').length,
        cards: document.querySelectorAll('.card').length,
        ledger: document.querySelectorAll('.lrow').length,
        overflowX: doc.scrollWidth > doc.clientWidth,
        overflowY: doc.scrollHeight > doc.clientHeight,
        breach: !document.getElementById('breach').hidden,
        clipped: [...document.querySelectorAll('.said, .lwhat, .card dd, .counter-h, .counter')]
          .filter((e) => {
            const cs = getComputedStyle(e);
            // Display type set tighter than its own font size always reports
            // scrollHeight > clientHeight; that is the leading, not a clip.
            const tight = parseFloat(cs.lineHeight) < parseFloat(cs.fontSize);
            // An ellipsis is a decision, not an accident. A ledger row is a
            // log line and is allowed to trail off; a headline is not.
            const truncates = cs.textOverflow === 'ellipsis';
            return (!tight && e.scrollHeight > e.clientHeight + 2) ||
                   (!truncates && e.scrollWidth > e.clientWidth + 2);
          })
          .map((e) => (e.className || e.tagName) + ': ' + e.textContent.slice(0, 42))
          .slice(0, 4),
      };
    });

    await page.screenshot({ path: join(OUT, `beat-${n}.png`) });
    await page.close();

    const problems = [];
    if (probe.hits.length) problems.push('LEAK ' + probe.hits.join(','));
    if (probe.counter !== String(probe.hits.length)) problems.push('counter disagrees');
    if (probe.overflowX) problems.push('h-scroll');
    if (probe.overflowY) problems.push('v-scroll');
    if (probe.clipped.length) problems.push('clipped: ' + probe.clipped.join(' | '));
    if (errors.length) problems.push('console: ' + errors.slice(0, 2).join(' | '));
    if (problems.length) bad++;

    console.log(
      `beat ${String(n).padStart(2)}  counter=${probe.counter}  ` +
      `utt=${String(probe.utterances).padStart(2)} cards=${probe.cards} ` +
      `ledger=${String(probe.ledger).padStart(2)} chars=${String(probe.chars).padStart(4)}  ` +
      (problems.length ? 'PROBLEM  ' + problems.join(' ; ') : 'ok'));
  }
} finally {
  await browser.close();
  server.stop();
}

console.log(bad ? `\n${bad} beat(s) with problems` : '\nall beats clean');
process.exit(bad ? 1 : 0);
