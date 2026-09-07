/**
 * The three cards in the cut, rendered from the files they quote.
 *
 *   node demo/tools/render-cards.mjs      # -> docs/broll/card-{latency,limits,url}.mp4
 *
 *   latency   the 500 ms budget, this run's worst round-trip p95 (read from
 *             docs/broll/test-all.txt, the tee of the filmed `npm run test:all`),
 *             and the handler table from test/latency/RESULTS.md. Reveals in
 *             three steps timed to the words in beat 09.
 *   limits    README.md, "What this does not do", scrolled through beat 10.
 *   url       the repository, from `git remote`, for the last frame.
 *
 * Nothing on any card is typed here. If the source changes, the card changes.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromePath, puppeteer, ROOT, DEMO } from './lib/browser.mjs';
import { screencast, framesToVideo } from './lib/screencast.mjs';
import { loadTimeline } from '../../scripts/lib/timeline.mjs';

const run = promisify(execFile);
const OUT = join(ROOT, 'docs', 'broll');
const WORK = join(ROOT, 'docs', '.assembly', 'cards');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ data -- */

async function latencyData() {
  const md = await readFile(join(ROOT, 'test', 'latency', 'RESULTS.md'), 'utf8');
  const section = md.split('## Handler latency (ms)')[1].split('## ')[0];
  const rows = section.split('\n').filter((l) => /^\|\s*\w/.test(l) && !/^\|\s*Tool/.test(l) && !/^\|-/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([tool, min, median, p95, max, over]) => ({ tool, min, median, p95, max, over }));
  const slowest = /Slowest tool at P95: `(\w+)` at ([\d.]+) ms\*\* — ([\d.]+%) of the (\d+) ms platform budget/.exec(section);
  const method = /\*\*(\d+) warm-up iterations discarded, then (\d+) measured iterations per tool\*\*/.exec(md);

  const log = await readFile(join(OUT, 'test-all.txt'), 'utf8').catch(() => {
    throw new Error('docs/broll/test-all.txt is missing — film the terminal first (record-terminal.mjs testall)');
  });
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
  const worst = /worst p95: ([\d.]+) ms \(([^)]+)\); worst single call: ([\d.]+) ms; over budget: (\d+)/.exec(plain);
  const setup = /measured round-trip latency, (\d+) calls per tool, budget (\d+) ms/.exec(plain);
  const checks = /(\d+) checks passed/.exec(plain);
  if (!worst || !setup || !slowest || !checks) throw new Error('could not read the latency lines; the formats changed');
  return {
    budgetMs: Number(setup[2]), calls: Number(setup[1]),
    roundTrip: { p95: Number(worst[1]), tool: worst[2], worstCall: Number(worst[3]), over: Number(worst[4]) },
    handler: { rows, tool: slowest[1], p95: Number(slowest[2]), share: slowest[3], iterations: method ? Number(method[2]) : null },
    checks: Number(checks[1]),
  };
}

async function limitsData() {
  const md = await readFile(join(ROOT, 'README.md'), 'utf8');
  const section = md.split('## What this does not do')[1].split('\n## ')[0];
  const items = [];
  for (const block of section.split(/\n(?=- )/)) {
    const text = block.replace(/^- /, '').replace(/\n\s+/g, ' ').trim();
    if (!text) continue;
    const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(text);
    const clean = (s) => esc(s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    items.push({ lead: clean(m ? m[1] : text), rest: clean(m ? m[2] : '') });
  }
  return items;
}

async function repoUrl() {
  const { stdout } = await run('git', ['-C', ROOT, 'remote', 'get-url', 'origin']);
  return stdout.trim().replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

/* ------------------------------------------------------------------ html -- */

const BASE = `
  <link rel="stylesheet" href="${pathToFileURL(join(DEMO, 'fonts', 'fonts.css')).href}">
  <link rel="stylesheet" href="${pathToFileURL(join(DEMO, 'tokens.css')).href}">
  <style>
    *{box-sizing:border-box} html{font-size:16px}
    body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--page);color:var(--ink);
         font-family:var(--sans);-webkit-font-smoothing:antialiased}
    .wrap{position:absolute;inset:0;padding:84px 150px}
    .kicker{font:700 15px/1 var(--sans);letter-spacing:.22em;text-transform:uppercase;color:var(--ink3);margin:0 0 18px}
    h1{margin:0;font-size:52px;font-weight:800;letter-spacing:-.025em;line-height:1.12}
    .mono{font-family:var(--mono)}
    .amber{color:var(--amber)} .cyan{color:var(--cyan)} .ink3{color:var(--ink3)} .ink2{color:var(--ink2)}
    .step{opacity:0;transform:translateY(14px);transition:opacity .55s ease,transform .55s cubic-bezier(.22,.7,.24,1)}
    body[data-step="1"] .s1, body[data-step="2"] .s1, body[data-step="2"] .s2,
    body[data-step="3"] .s1, body[data-step="3"] .s2, body[data-step="3"] .s3 {opacity:1;transform:none}
    code{font-family:var(--mono);font-size:.92em;color:var(--cyan)}
  </style>`;

function latencyHtml(d) {
  const pct = (ms) => Math.max(0.35, (ms / d.budgetMs) * 100);
  return `${BASE}<style>
    .budget{margin-top:34px;display:grid;gap:14px}
    .bar{position:relative;height:46px;border-radius:12px;border:1px solid var(--hairline-2);background:var(--ledger);overflow:hidden}
    .bar i{position:absolute;top:0;bottom:0;left:0;border-radius:12px 0 0 12px}
    .bar .rt{background:var(--amber);width:${pct(d.roundTrip.p95)}%}
    .bar .hd{background:var(--cyan);width:${pct(d.handler.p95)}%}
    .bar b{position:absolute;right:16px;top:50%;transform:translateY(-50%);font:600 17px/1 var(--mono);color:var(--ink3)}
    .legend{display:flex;gap:34px;font-size:22px;color:var(--ink2)}
    .legend b{font-family:var(--mono);font-weight:600;color:var(--ink)}
    .legend .sw{display:inline-block;width:14px;height:14px;border-radius:4px;margin-right:10px;vertical-align:-1px}
    .big{display:flex;align-items:baseline;gap:22px;margin-top:38px}
    .big .n{font:800 118px/1 var(--sans);letter-spacing:-.05em;font-variant-numeric:tabular-nums}
    .big .u{font-size:30px;color:var(--ink2)} .big small{font-size:20px;color:var(--ink3);display:block;margin-top:8px}
    table{border-collapse:collapse;margin-top:26px;width:100%;font-size:21px}
    th{font:700 14px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);text-align:right;padding:0 18px 10px 0}
    th:first-child,td:first-child{text-align:left}
    td{padding:7px 18px 7px 0;border-top:1px solid var(--hairline);text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink2)}
    td:first-child{font-family:var(--mono);color:var(--ink)} td.p{color:var(--cyan);font-weight:600}
    tr.worst td{background:var(--cyan-wash)}
    .foot{margin-top:16px;font-size:19px;color:var(--ink3)}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:70px;margin-top:8px}
  </style>
  <div class="wrap">
    <p class="kicker">Measured, not estimated</p>
    <h1>Alexa+ gives an add-on <span class="amber mono">${d.budgetMs} ms</span> per tool call.</h1>
    <div class="cols">
      <div>
        <div class="step s2">
          <div class="big"><span class="n amber">${d.roundTrip.p95}</span><span class="u">ms<small>worst p95 round trip, this run · <code class="mono">${esc(d.roundTrip.tool)}</code></small></span></div>
          <p class="foot">${d.calls} calls per tool over loopback, client clock — Amazon's network is not in this number. Worst single call ${d.roundTrip.worstCall} ms. Over budget: ${d.roundTrip.over}.</p>
        </div>
        <div class="step s1 budget" style="margin-top:44px">
          <div class="bar"><i class="rt s2 step"></i><i class="hd s3 step"></i><b>${d.budgetMs} ms budget</b></div>
          <div class="legend"><span class="s2 step"><i class="sw" style="background:var(--amber)"></i>round trip p95 <b>${d.roundTrip.p95} ms</b></span><span class="s3 step"><i class="sw" style="background:var(--cyan)"></i>handler p95 <b>${d.handler.p95} ms</b></span></div>
        </div>
      </div>
      <div class="step s3">
        <div class="big" style="margin-top:0"><span class="n cyan">${d.handler.p95}</span><span class="u">ms<small>worst handler p95 · the server's own work · <code>${esc(d.handler.tool)}</code> · ${d.handler.share} of budget</small></span></div>
        <table><thead><tr><th>tool</th><th>median</th><th>p95</th><th>max</th><th>over ${d.budgetMs}</th></tr></thead><tbody>
          ${d.handler.rows.map((r) => `<tr${r.tool === d.handler.tool ? ' class="worst"' : ''}><td>${esc(r.tool)}</td><td>${r.median}</td><td class="p">${r.p95}</td><td>${r.max}</td><td>${r.over}</td></tr>`).join('')}
        </tbody></table>
        <p class="foot">test/latency/RESULTS.md — ${d.handler.iterations ?? 'n'} measured iterations per tool, hrtime around the handler.</p>
      </div>
    </div>
  </div>`;
}

function limitsHtml(items) {
  return `${BASE}<style>
    .scroll{transition:transform 0s linear}
    ul{list-style:none;margin:30px 0 0;padding:0;display:grid;gap:26px;max-width:1520px}
    li{display:grid;grid-template-columns:18px 1fr;gap:22px;align-items:start}
    li i{display:block;width:12px;height:12px;border-radius:50%;background:var(--amber);margin-top:16px}
    li b{display:block;font-size:34px;font-weight:700;letter-spacing:-.015em;line-height:1.25}
    li span{display:block;font-size:24px;line-height:1.45;color:var(--ink2);margin-top:6px}
    .fade{position:absolute;left:0;right:0;bottom:0;height:160px;background:linear-gradient(rgba(7,10,13,0),var(--page) 70%);pointer-events:none}
    .head{position:absolute;left:150px;right:150px;top:84px;background:var(--page);padding-bottom:16px;z-index:2}
    .body{position:absolute;left:150px;right:150px;top:206px;bottom:0;overflow:hidden}
  </style>
  <div class="head"><p class="kicker">README · What this does not do</p><h1>Where it stops.</h1></div>
  <div class="body"><div class="scroll" id="scroll"><ul>
    ${items.map((it) => `<li><i></i><div><b>${it.lead}</b>${it.rest ? `<span>${it.rest}</span>` : ''}</div></li>`).join('')}
  </ul></div></div><div class="fade"></div>`;
}

function urlHtml(url) {
  return `${BASE}<style>
    .c{position:absolute;inset:0;display:grid;place-content:center;text-align:center;gap:26px}
    .u{font:600 64px/1.1 var(--mono);letter-spacing:-.02em;color:var(--ink)}
    .u b{color:var(--cyan);font-weight:600}
    .s{font-size:24px;color:var(--ink3)}
    .mark{width:88px;height:88px;margin:0 auto 10px}
  </style>
  <div class="c">
    <svg class="mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M9 13.5a11 11 0 0 1 0 13" fill="none" stroke="var(--amber)" stroke-width="3.2" stroke-linecap="round"/><path d="M16.5 9a18.5 18.5 0 0 1 0 22" fill="none" stroke="var(--amber)" stroke-width="3.2" stroke-linecap="round" opacity=".55"/><rect x="24.5" y="7.5" width="11" height="25" rx="3.4" fill="none" stroke="var(--cyan)" stroke-width="3.2"/><rect x="27.8" y="12.5" width="4.4" height="2.6" rx="1.3" fill="var(--cyan)"/></svg>
    <div class="u">${esc(url).replace(/(\/[^/]+)$/, '<b>$1</b>')}</div>
    <div class="s">README · What this does not do · Known findings · MIT</div>
  </div>`;
}

/* --------------------------------------------------------------- render -- */

async function record(browser, name, html, seconds, steps = []) {
  const file = join(WORK, `${name}.html`);
  await writeFile(file, `<!doctype html><meta charset="utf-8"><title>${name}</title>${html}`);
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 300));
  const rec = await screencast(page, join(WORK, name));
  await rec.start();
  for (const s of steps) {
    await rec.until(s.at);
    await page.evaluate(s.fn, s.arg);
  }
  await rec.until(seconds);
  const { frames, end } = await rec.stop();
  await page.close();
  const out = join(OUT, `card-${name}.mp4`);
  await framesToVideo(frames, end, out);
  console.log(`  ${name.padEnd(8)} ${end.toFixed(1)}s  ${frames.length} frames  -> ${out}`);
}

const T = loadTimeline(ROOT);
await mkdir(OUT, { recursive: true });
await mkdir(WORK, { recursive: true });
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(), headless: true,
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars', '--font-render-hinting=none',
    '--allow-file-access-from-files'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
try {
  const b9 = T.beat('09-cost-and-limits');
  const b10 = T.beat('10-honest');
  const setStep = (n) => { document.body.dataset.step = String(n); };

  // 09: budget first, the round trip on "slowest", the handler table on "but the server's own work".
  await record(browser, 'latency', latencyHtml(await latencyData()), T.cue('09-cost-and-limits', 'Three') - b9.start + 0.5, [
    { at: 0.15, fn: setStep, arg: 1 },
    { at: T.cue('09-cost-and-limits', 'slowest') - b9.start, fn: setStep, arg: 2 },
    { at: T.cue('09-cost-and-limits', 'but') - b9.start, fn: setStep, arg: 3 },
  ]);

  // 10: the limits, scrolled so the whole section passes; the URL takes over on "All of that".
  const limitsSeconds = T.cue('10-honest', 'All') - b10.start + 0.5;
  await record(browser, 'limits', limitsHtml(await limitsData()), limitsSeconds, [
    { at: 1.6, fn: (secs) => {
      const el = document.getElementById('scroll');
      const travel = el.scrollHeight - el.parentElement.clientHeight + 40;
      el.style.transition = `transform ${secs}s cubic-bezier(.45,.05,.55,.95)`;
      el.style.transform = `translateY(-${Math.max(0, travel)}px)`;
    }, arg: Math.max(1, limitsSeconds - 3.4) },
  ]);

  await record(browser, 'url', urlHtml(await repoUrl()), T.total - T.cue('10-honest', 'All') + 0.5);
} finally {
  await browser.close();
}
process.exit(0);
