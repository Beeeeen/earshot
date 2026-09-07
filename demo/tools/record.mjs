/**
 * Films the two-pane simulator as one continuous take, on the narration's clock.
 *
 *   npm run voice      # once; the clips and their word timings are the clock
 *   npm run record     # -> docs/broll/ui-take.mp4, dana-take.mp4, takes.json
 *
 * Every action below is scheduled at the absolute second a narrated word
 * begins (scripts/lib/timeline.mjs), so the assembler can lay this take under
 * the narration from t = 0 and the picture lands where the words do. The old
 * recorder shot one clip per beat by replaying the page to a state; that put
 * the solo window on screen half a minute before the sentence about it.
 *
 * The tool calls are real: the page drives a live MCP session over Streamable
 * HTTP against a FRESH server in src/, and the private pane is fetched from
 * /inbox with the asker's own token. A script picks the calls rather than a
 * model, which is why the narration never claims otherwise.
 *
 * Two takes:
 *   sarah   the whole story, beats 1-8, Sarah's linked account
 *   dana    the aide's own linked account asking on the same device: what her
 *           token is entitled to, in the server's words. Cut in under beat 8.
 *
 * The recorder refuses to keep a take in which a protected value reached the
 * room pane, and refuses to film the scripted fallback at all.
 *
 *   --take sarah|dana   film one of them only
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromePath, puppeteer, serveDemo, openDemo, ROOT } from './lib/browser.mjs';
import { screencast, framesToVideo } from './lib/screencast.mjs';
import { loadTimeline } from '../../scripts/lib/timeline.mjs';

const OUT = join(ROOT, 'docs', 'broll');
const WORK = join(ROOT, 'docs', '.assembly', 'frames');
const SPEED = 0.4; // the page's own pacing; slow enough that the in-flight status is readable

/* A recording must not inherit state from an earlier take: a solo window is
   server state and outlives a page reset, and every /inbox delivery accumulates. */
async function freshServer(port) {
  const child = spawn(process.execPath, ['dist/server.js', '--demo'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('MCP server did not start in 20s')), 20000);
    child.stdout.on('data', (b) => {
      const m = String(b).match(/listening on (http:\/\/\S+)/);
      if (m) { clearTimeout(bail); resolve(m[1]); }
    });
    child.on('exit', (c) => { clearTimeout(bail); reject(new Error('MCP server exited ' + c)); });
  });
  return { url, stop: () => child.kill() };
}

/* Staging only. Which pane is on screen when is presentation; what is written
   in the panes is never touched. */
const STAGE_CSS = `
  .stage { transition: grid-template-columns .9s cubic-bezier(.22,.7,.24,1), column-gap .9s cubic-bezier(.22,.7,.24,1); }
  .gutter { overflow: hidden; min-width: 0; }
  .gutter, .phone-pane { transition: opacity .55s ease; }
  body.stage-open .stage { grid-template-columns: minmax(0,1fr) 0 0; column-gap: 0; }
  body.stage-open .gutter, body.stage-open .phone-pane { opacity: 0; }
  .app { transition: row-gap .9s cubic-bezier(.22,.7,.24,1); }
  .strip { overflow: hidden; transition: height .9s cubic-bezier(.22,.7,.24,1), opacity .6s ease; }
  body.strip-hidden .strip { height: 0; opacity: 0; }
  body.strip-hidden .app { row-gap: 0; }
  body.pulse .presence li { animation: chipPulse 1.5s ease-out both; }
  body.pulse .presence li:nth-child(2) { animation-delay: .22s; }
  body.pulse .presence li:nth-child(3) { animation-delay: .44s; }
  body.pulse .presence li:nth-child(4) { animation-delay: .66s; }
  @keyframes chipPulse {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.06); box-shadow: 0 0 0 4px var(--amber-wash); border-color: var(--amber); }
    100% { transform: scale(1); }
  }
`;

/* Timestamps of what the page did, read back after the take, so the cut can be
   placed on the moment a card actually landed rather than on when it was asked for. */
const OBSERVE = () => {
  window.__ev = [];
  const push = (what) => window.__ev.push({ what, t: performance.now() });
  const now = document.getElementById('now');
  new MutationObserver(() => push('now:' + now.dataset.k)).observe(now, { attributes: true, attributeFilter: ['data-k'] });
  for (const id of ['transcript', 'cards', 'ledger']) {
    const el = document.getElementById(id);
    new MutationObserver(() => push(id + ':' + el.children.length)).observe(el, { childList: true });
  }
  for (const id of ['raw', 'solo']) {
    const el = document.getElementById(id);
    new MutationObserver(() => push(id + ':' + (el.hidden ? 'hidden' : 'shown'))).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
};

async function audit(page) {
  return page.evaluate(() => {
    const S = window.EARSHOT_SCENARIO;
    const corpus = window.EarshotApp.roomCorpus();
    const rx = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return {
      breached: window.EarshotApp.audit(),
      counter: document.getElementById('counter').textContent.trim(),
      hits: S.PROTECTED.filter((p) => [p.value].concat(p.alts || []).some((t) => rx(t).test(corpus))).map((p) => p.label),
    };
  });
}

async function film(browser, server, mcp, take, T) {
  const person = take === 'dana' ? '&person=dana' : '';
  const query = `server=${encodeURIComponent(mcp.url + '/mcp')}&speed=${SPEED}&still=0${person}`;
  const { page, errors } = await openDemo(browser, server.url, query);

  const mode = await page.evaluate(() => window.EarshotAdapter?.state?.mode ?? 'unknown');
  if (mode !== 'live') {
    throw new Error(`the page is in "${mode}" mode; this would film fixtures while the narration says the calls are real`);
  }
  await page.addStyleTag({ content: STAGE_CSS });
  await page.evaluate(OBSERVE);

  const plan = [];
  const at = (t, name, fn) => plan.push({ t, name, fn });
  const evalIn = (fn) => () => page.evaluate(fn);
  let end;

  if (take === 'sarah') {
    await page.evaluate(() => document.body.classList.add('stage-open', 'strip-hidden'));
    // 1. The room. Her question lands on "asks"; the spoken answer follows it.
    at(T.cue('01-room', 'asks') + 0.25, 'ask: did Mom take her medication', evalIn(() => { window.EarshotApp.next(); }));
    // 2. "...heard by whoever is standing there": the presence chips pulse.
    at(T.cue('02-premise', 'whoever') - 0.25, 'presence pulse', evalIn(() => document.body.classList.add('pulse')));
    // 3. "Earshot does the third thing": the phone slides in, card already on it.
    at(T.cue('03-third-option', 'Earshot'), 'phone pane in', evalIn(() => document.body.classList.remove('stage-open')));
    // 4. The ledger and the counter rise with "Most questions aren't sensitive".
    at(T.beat('04-ordinary').start + 0.25, 'strip in', evalIn(() => document.body.classList.remove('strip-hidden')));
    // 5. "Now ask it to say the drug name": the injected call goes on the wire.
    at(T.beat('05-shift').start + 0.15, 'ask: say the medication name (injected _meta)', evalIn(() => { window.EarshotApp.next(); }));
    // 7. "Everything it has ever said out loud is searchable": type the drug name.
    at(T.beat('07-compile').start + 0.15, 'search transcript for the medication', evalIn(() => {
      window.EarshotApp.state.cursor = 8; window.EarshotApp.next();
    }));
    // 8. Back from the terminal; then "when you really are alone".
    at(T.beat('08-identity').start - 0.15, 'close raw overlay', evalIn(() => window.EarshotApp.closeRaw()));
    at(T.cue('08-identity', 'And'), 'open_solo_window', evalIn(() => {
      window.EarshotApp.state.cursor = 6; window.EarshotApp.next();
    }));
    end = T.beat('08-identity').end + 0.6;
  } else {
    // Dana's own linked session. The question is the one src/demo.ts gives her
    // in scene 4; the answer is whatever the server says to her token.
    await page.evaluate(() => {
      const chan = document.querySelector('.phone-pane .chan');
      for (const n of chan.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = " Dana's phone";
      document.querySelector('#v-phone + span').childNodes[0].textContent = "on Dana's phone";
      for (const li of document.querySelectorAll('.presence li')) li.classList.toggle('asker', li.textContent.includes('Dana'));
      const S = window.EARSHOT_SCENARIO;
      S.beats[6].ask = { who: 'dana', text: 'Alexa, send me her care summary so I know what to give her.' };
    });
    at(0.4, 'ask: care summary (Dana token)', evalIn(() => {
      window.EarshotApp.state.cursor = 5; window.EarshotApp.next();
    }));
    end = 9.0;
  }

  const rec = await screencast(page, join(WORK, take));
  await rec.start();
  // Pin the page's clock to the recorder's AFTER start(): the screenshot inside
  // start() takes half a second, and reading the page clock before it would
  // report every event that much late.
  const pageT0 = await page.evaluate(() => performance.now());
  const recAtT0 = rec.now();
  for (const step of plan) {
    await rec.until(step.t);
    await step.fn();
    console.log(`  ${rec.now().toFixed(2).padStart(7)}s  ${step.name}`);
  }
  await rec.until(end);
  const { frames, end: recorded } = await rec.stop();

  const events = (await page.evaluate(() => window.__ev))
    .map((e) => ({ what: e.what, t: Number(((e.t - pageT0) / 1000 + recAtT0).toFixed(3)) }));
  const probe = await audit(page);
  await page.close();

  const bad = probe.breached > 0 || probe.hits.length > 0 || probe.counter !== '0';
  console.log(`  ${bad ? 'LEAK' : ' ok '}  ${take}: ${frames.length} frames over ${recorded.toFixed(1)}s, counter=${probe.counter}` +
    (probe.hits.length ? `  SPOKEN: ${probe.hits.join(', ')}` : '') +
    (errors.length ? `  page errors: ${errors.length}` : ''));
  if (bad) throw new Error('a protected value reached the room pane; not keeping this take');

  const file = `${take === 'sarah' ? 'ui' : 'dana'}-take.mp4`;
  await framesToVideo(frames, recorded, join(OUT, file));
  return { file, end: recorded, plan: plan.map((p) => ({ name: p.name, at: p.t })), events };
}

const argv = process.argv.slice(2);
const only = argv.includes('--take') ? argv[argv.indexOf('--take') + 1] : null;
const takes = only ? [only] : ['sarah', 'dana'];

const T = loadTimeline(ROOT);
await mkdir(OUT, { recursive: true });
const server = await serveDemo(5211);
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars', '--font-render-hinting=none'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});

let manifest = {};
try { manifest = JSON.parse(await readFile(join(OUT, 'takes.json'), 'utf8')); } catch {}

try {
  for (const take of takes) {
    const mcp = await freshServer(8791);
    console.log(`\n${take}: fresh MCP server at ${mcp.url}`);
    try {
      manifest[take === 'sarah' ? 'ui' : 'dana'] = await film(browser, server, mcp, take, T);
    } finally {
      mcp.stop();
    }
  }
  await writeFile(join(OUT, 'takes.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nwrote ${join(OUT, 'takes.json')}`);
} finally {
  await browser.close();
  await server.stop?.();
}
process.exit(0); // puppeteer keeps a handle open on Windows
