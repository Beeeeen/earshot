/**
 * Proves demo/adapter.js really speaks MCP, before src/ exists.
 *
 *   node demo/tools/verify-live.mjs
 *
 * Starts the test double in mock-mcp.mjs, points the demo at it, plays every
 * beat, and then asserts on what ended up on screen. It is checking the wire,
 * not the story: handshake, session id, SSE-framed tools/call, real measured
 * latency, and -- the one that matters -- that a server the page has never seen
 * before can hand it a completely different patient and drug, declare its own
 * list of protected values, and the transcript still comes out clean.
 *
 * Exit code 0 means the live path works end to end. Run it again against the
 * real server the moment src/ is up: node demo/tools/verify-live.mjs --server URL
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { puppeteer, chromePath, serveDemo, openDemo, DEMO } from './lib/browser.mjs';

const argv = process.argv.slice(2);
const custom = argv.indexOf('--server') >= 0 ? argv[argv.indexOf('--server') + 1] : null;
// Not 8787: that is where the real server lives, and a silent port clash
// makes this suite look like a product bug.
const MOCK_PORT = 8791;

async function startMock(leak) {
  const child = spawn(process.execPath,
    [join(DEMO, 'tools', 'mock-mcp.mjs'), '--port', String(MOCK_PORT)],
    { stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, MOCK_LEAK: leak ? '1' : '0' } });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('mock did not start')), 8000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('mock MCP')) { clearTimeout(t); res(); }
    });
  });
  return child;
}

let mock = custom ? null : await startMock(false);
const target = custom || `http://localhost:${MOCK_PORT}/mcp`;

const server = await serveDemo(5206);
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
});

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

try {
  const { page, errors } = await openDemo(browser, server.url,
    `server=${encodeURIComponent(target)}&speed=8&still=9`);

  const r = await page.evaluate(() => {
    const A = window.EarshotAdapter.state;
    const corpus = window.EarshotApp.roomCorpus();
    const declared = window.EarshotApp.state.declared;
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      mode: A.mode,
      url: A.url,
      server: A.server,
      tools: A.tools.map((t) => t.name),
      shapeWarning: A.shapeWarning,
      error: A.error,
      badge: document.getElementById('conn-txt').textContent,
      counter: document.getElementById('counter').textContent,
      declared: declared.map((d) => d.value),
      chips: [...document.querySelectorAll('.qchip')].map((b) => b.dataset.q),
      // real measured round-trips written into the ledger by the adapter
      latencies: [...document.querySelectorAll('.lms')]
        .map((e) => e.textContent.trim())
        .filter((t) => /ms$/.test(t))
        .map((t) => Number(t.replace(' ms', ''))),
      leaks: declared.filter((d) => [d.value].concat(d.alts || [])
        .some((t) => new RegExp(esc(t), 'i').test(corpus))).map((d) => d.value),
      phoneHasDeclared: declared.filter((d) =>
        new RegExp(esc(d.value), 'i').test(window.EarshotApp.phoneCorpus())).map((d) => d.value),
      utterances: document.querySelectorAll('.utt').length,
      cards: document.querySelectorAll('.card').length,
      breach: !document.getElementById('breach').hidden,
      corpusChars: corpus.length,
    };
  });
  await page.close();

  check('handshake completed, mode is live', r.mode === 'live', r.mode + ' — ' + (r.error || 'no error'));
  check('server identified itself', !!r.server, JSON.stringify(r.server));
  check('tools/list returned tools', r.tools.length > 0, r.tools.join(', '));
  check('tool results had a shape the adapter understood', !r.shapeWarning,
    r.shapeWarning ? 'normalise() fell back to content[].text — fix it in adapter.js' : 'structuredContent');
  check('badge says LIVE', /LIVE/.test(r.badge), r.badge.replace(/\n/g, ' / '));
  check('spoken answers rendered', r.utterances > 0, r.utterances + ' utterances');
  check('private cards rendered', r.cards > 0, r.cards + ' cards');
  check('server declared its own protected values', r.declared.length > 0, r.declared.join(', '));
  check('verifier chips follow the server, not the fixtures',
    r.chips.length > 0 && r.chips.every((c) => r.declared.includes(c)), r.chips.join(', '));
  check('those values DO reach the phone', r.phoneHasDeclared.length > 0,
    r.phoneHasDeclared.join(', ') || 'none — the demo would be vacuously clean');
  check('and NONE of them reach the transcript', r.leaks.length === 0,
    r.leaks.length ? 'LEAKED: ' + r.leaks.join(', ') : `clean across ${r.corpusChars} characters`);
  check('counter reads 0', r.counter === '0', r.counter);
  check('no breach overlay', !r.breach, String(r.breach));
  check('round-trips are real measurements', r.latencies.length > 0 && r.latencies.every((n) => n >= 0),
    r.latencies.length ? r.latencies.join(', ') + ' ms' : 'none recorded');
  const slow = r.latencies.filter((n) => n >= 500);
  check('every round-trip under the 500 ms ceiling in SPEC.md', slow.length === 0,
    r.latencies.length ? `max ${Math.max(...r.latencies)} ms` : 'n/a');
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  /* ---- and now the same server, deliberately leaking -------------------- */
  if (mock) {
    mock.kill();
    mock = await startMock(true);
    const bad = await openDemo(browser, server.url,
      `server=${encodeURIComponent(target)}&speed=8&still=2`);
    const b = await bad.page.evaluate(() => ({
      counter: document.getElementById('counter').textContent,
      breach: !document.getElementById('breach').hidden,
      breachTxt: document.getElementById('breach-txt').textContent,
      roomHit: document.querySelector('.vcol-room').dataset.hit,
    }));
    await bad.page.close();

    check('a leaking server is caught, not rendered quietly',
      b.breach && b.counter !== '0' && b.roomHit === '1',
      `counter=${b.counter} breach=${b.breach} search=${b.roomHit === '1' ? 'red' : 'green'}`);
    check('the breach names the value that got out',
      /Apixaban/.test(b.breachTxt), b.breachTxt.slice(0, 90));
  }
} finally {
  await browser.close();
  server.stop();
  if (mock) mock.kill();
}

console.log(`\ntarget: ${target}\n`);
let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} ${c.detail ?? ''}`);
}
console.log(bad ? `\n${bad} of ${checks.length} checks failed` : `\nall ${checks.length} checks pass`);
process.exit(bad ? 1 : 0);
