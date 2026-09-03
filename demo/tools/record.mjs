/**
 * Records one clip per narration beat, each held for exactly as long as its
 * voice line runs.
 *
 *   npm run voice     # writes voice/durations.json
 *   npm run record    # -> docs/broll/01-room.webm, ...
 *
 * Editing then has no timing work in it: clip N goes under narration N. This
 * ordering is not a preference. Recording first and fitting narration to the
 * footage afterwards always reads as padded, because the words end and the
 * picture keeps going.
 *
 * The tool calls are real: the page drives a live MCP session over Streamable
 * HTTP against the server in src/, and the private pane is fetched from /inbox
 * with the asker's own token. A script picks the calls rather than a model,
 * which is why the narration never claims otherwise.
 *
 *   --scripted    record against fixtures instead of the live server
 *   --beat <id>   re-record one beat only
 */
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { join } from 'node:path';
import { chromePath, puppeteer, serveDemo, openDemo, ROOT } from './lib/browser.mjs';

const argv = process.argv.slice(2);
const only = argv.includes('--beat') ? argv[argv.indexOf('--beat') + 1] : null;
const scripted = argv.includes('--scripted');
const OUT = join(ROOT, 'docs', 'broll');

const spec = JSON.parse(await readFile(join(ROOT, 'voice', 'narration.json'), 'utf8'));
let durations = {};
try {
  durations = JSON.parse(await readFile(join(ROOT, 'voice', 'durations.json'), 'utf8'));
} catch {
  console.error('No voice/durations.json - run `npm run voice` first so each clip\n' +
                'can be held for the real length of its line. Refusing to guess.');
  process.exit(1);
}

/* -------------------------------------------------------------- SHOT LIST --
   Narration beats and scenario beats are different sequences, so the mapping is
   explicit rather than positional. `hold` is added on top of the narration
   length: a beat whose last half-second is a static frame cuts cleanly, and a
   beat that ends the instant the words do does not.                          */
const SHOTS = [
  { id: '01-room',            goto: 0, hold: 0.4, note: 'left pane only, presence chips, nothing has happened' },
  { id: '02-premise',         goto: 0, hold: 0.4, note: 'hold on the room while the premise lands' },
  { id: '03-third-option',    goto: 0, hold: 0.6, note: 'right pane and the two channel labels' },
  { id: '04-ordinary',        goto: 1, hold: 0.5, note: 'check_adherence: spoken answer AND the card' },
  { id: '05-shift',           goto: 1, hold: 1.2, note: 'hold on the split - the frame people remember' },
  { id: '06-verify',          goto: 2, hold: 0.8, note: 'the injection, then the byte-identical reply' },
  { id: '07-compile',         goto: 9, hold: 0.6, verify: 'Furosemide', note: 'search the transcript: 0 results' },
  { id: '08-identity',        goto: 3, hold: 0.5, advance: 5, note: 'bystander, then who_can_see, symptom, sealed, solo open+close' },
  { id: '09-cost-and-limits', goto: 9, hold: 0.5, note: 'ledger and the 0; latency table cut in at edit' },
  { id: '10-honest',          goto: 9, hold: 1.0, note: 'README limits and the repo URL cut in at edit' },
];

const secondsFor = (id) => {
  const d = durations[id];
  if (typeof d !== 'number') throw new Error(`no measured duration for narration beat "${id}"`);
  return d;
};
const sleep = (s) => new Promise((r) => setTimeout(r, Math.round(s * 1000)));

await mkdir(OUT, { recursive: true });
const server = await serveDemo(5211);
const pptr = await puppeteer();
const browser = await pptr.launch({
  executablePath: chromePath(),
  headless: false, // screencast needs a real window
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars',
         '--font-render-hinting=none', '--window-size=1928,1140'],
});

const shots = only ? SHOTS.filter((s) => s.id === only) : SHOTS;
if (only && shots.length === 0) {
  console.error(`No shot called "${only}". Known: ${SHOTS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let mode = null;
try {
  for (const shot of shots) {
    const secs = secondsFor(shot.id);
    const query = `${scripted ? 'mode=scripted&' : ''}speed=1&still=${shot.goto}`;
    const { page, errors } = await openDemo(browser, server.url, query);

    if (mode === null) {
      mode = await page.evaluate(() => window.EarshotAdapter?.state?.mode ?? 'unknown');
      if (!scripted && mode !== 'live') {
        console.error(
          `\nThe page is in "${mode}" mode, so this would record fixtures while the\n` +
          `narration says the calls are real. Start the server first:\n` +
          `    npm run build && node dist/server.js --demo\n` +
          `Or pass --scripted if you genuinely mean to record the fallback.`);
        process.exit(1);
      }
    }

    const recorder = await page.screencast({ path: join(OUT, `${shot.id}.webm`) });
    if (shot.advance) {
      /* Several scenario beats under one narration line. Advance with next(),
         never gotoBeat(): gotoBeat resets the *page* and replays from zero,
         but a solo window is state on the *server* and outlives that reset —
         so a replay re-runs the early beats with the window already open, and
         the server then speaks, correctly, things the narration says it never
         speaks. Moving forward only cannot hit that. */
      const each = secs / (shot.advance + 1);
      await sleep(each);
      for (let i = 0; i < shot.advance; i++) {
        await page.evaluate(() => window.EarshotApp.next());
        await sleep(each);
      }
    } else if (shot.verify) {
      await sleep(secs * 0.45);
      await page.evaluate((q) => window.EarshotApp.verify(q), shot.verify);
      await sleep(secs * 0.55);
    } else {
      await sleep(secs);
    }
    await sleep(shot.hold);
    await recorder.stop();

    /* CDP screencast only emits a frame when something changes, so a beat that
       is deliberately still -- the room before anything happens, the hold on
       the split -- produces an empty file. Those beats are exactly the ones the
       edit needs most, so fall back to a still held for the same duration
       rather than losing the shot. */
    const clip = join(OUT, `${shot.id}.webm`);
    let framesCaptured = true;
    if (await stat(clip).then((f) => f.size === 0).catch(() => true)) {
      framesCaptured = false;
      const png = join(OUT, `${shot.id}.png`);
      await page.screenshot({ path: png });
      await unlink(clip).catch(() => {});
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png,
        '-t', String(secs + shot.hold), '-r', '30', '-c:v', 'libvpx-vp9',
        '-b:v', '2M', '-pix_fmt', 'yuv420p', clip]);
      await unlink(png).catch(() => {});
    }

    const probe = await page.evaluate(() => {
      const S = window.EARSHOT_SCENARIO;
      const corpus = window.EarshotApp.roomCorpus();
      return {
        counter: document.getElementById('counter').textContent,
        hits: S.PROTECTED.filter((p) => [p.value].concat(p.alts || []).some(
          (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(corpus))).map((p) => p.label),
      };
    });
    await page.close();

    const bad = probe.hits.length > 0 || probe.counter.trim() !== '0';
    console.log(
      `  ${bad ? 'LEAK' : ' ok '}  ${shot.id.padEnd(20)} ${secs.toFixed(1)}s + ${shot.hold}s` +
      `  counter=${probe.counter.trim()}${framesCaptured ? '' : '  [still]'}` +
      (probe.hits.length ? `  SPOKEN: ${probe.hits.join(', ')}` : '') +
      (errors.length ? `  page errors: ${errors.length}` : ''));
    if (bad) {
      console.error('\nA protected value reached the room pane. Not recording over this.');
      process.exit(1);
    }
  }
} finally {
  await browser.close();
  await server.close?.();
}

const total = shots.reduce((a, s) => a + secondsFor(s.id) + s.hold, 0);
console.log(`\n${shots.length} clip(s) in ${OUT}`);
console.log(`footage ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}` +
            `  (narration ${spec.beats.length} beats; hard limit 3:00)`);
process.exit(0); // puppeteer keeps a handle open on Windows
