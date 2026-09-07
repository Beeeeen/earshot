/**
 * Films the terminal shots: real commands, real output, typed and timed live.
 *
 *   node demo/tools/record-terminal.mjs [tsc] [testall] [--window | --emulator]
 *
 *   tsc       run tsc on the negative-compilation file and watch it fail
 *   testall   npm run test:all, its bytes also saved to docs/broll/test-all.txt
 *             so the card that quotes its latency line quotes THIS run
 *
 * Writes docs/broll/term-<shot>.mp4 and docs/broll/terminal.json, which maps
 * each event (command entered, command finished) to a second in that clip and
 * records which mode filmed it. The assembler cuts on those.
 *
 * Two ways to put a terminal on screen, and the file says which one was used:
 *
 *   --window    A real Windows Terminal window, fullscreen on the second
 *               monitor, grabbed off the desktop with a DPI-aware copy of
 *               ffmpeg. The shell types its own command (lib/term-runner.ps1);
 *               nothing is ever sent to whichever window you have focused.
 *               Windows blanks every capture while the workstation is locked,
 *               so this mode refuses to run on a locked desktop rather than
 *               hand back a black clip.
 *
 *   --emulator  The same commands run for real, and their output bytes — ANSI
 *               colours and all — are written into xterm.js (the terminal
 *               emulator inside VS Code) in headless Chrome as they arrive,
 *               after the command is typed into it character by character.
 *               Every character on screen came out of the command; the window
 *               around it is an emulator rather than a screen grab. This is
 *               the fallback for a locked desktop, and it says so in
 *               terminal.json.
 *
 * With neither flag: --window if the desktop is unlocked, otherwise --emulator.
 */
import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromePath, puppeteer, ROOT, DEMO } from './lib/browser.mjs';
import { screencast, framesToVideo } from './lib/screencast.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT = join(ROOT, 'docs', 'broll');
const WORK = join(ROOT, 'docs', '.assembly', 'terminal');
const RUNNER = join(ROOT, 'demo', 'tools', 'lib', 'term-runner.ps1');
const MON = (process.env.EARSHOT_REC_MONITOR ?? '3840,0,3840,2160').split(',').map(Number);
const PROFILE = 'Earshot demo';

/* The two shots. `show` is the exact line the viewer sees typed; it is also
   exactly what cmd.exe is handed, so the picture and the process agree. */
const SHOTS = {
  tsc: [
    { tag: 'type', show: 'type src\\negative\\interpolate-protected.neg.mts', pauseAfter: 1100 },
    { tag: 'tsc', show: 'npx tsc --noEmit --pretty --strict --module nodenext --types node src/negative/interpolate-protected.neg.mts', pauseAfter: 4000 },
  ],
  testall: [
    { tag: 'testall', show: 'npm run test:all', pauseAfter: 6000, save: 'test-all.txt' },
  ],
};

/* ------------------------------------------------------------- shared ---- */

async function locked() {
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH']);
    return /LogonUI\.exe/i.test(stdout);
  } catch { return false; }
}

/* ------------------------------------------------------------- window ---- */

async function dpiAwareFfmpeg() {
  const target = join(WORK, 'ffmpeg-dpi.exe');
  if (!existsSync(target)) {
    const { stdout } = await run('where', ['ffmpeg']);
    await copyFile(stdout.split(/\r?\n/)[0].trim(), target);
  }
  const key = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
  await run('reg', ['add', key, '/v', target, '/t', 'REG_SZ', '/d', '~ HIGHDPIAWARE', '/f']);
  return target;
}

async function writeProfileFragment() {
  const dir = join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows Terminal', 'Fragments', 'earshot-demo');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'earshot.json'), JSON.stringify({
    profiles: [{
      name: PROFILE,
      commandline: 'powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass',
      startingDirectory: ROOT,
      font: { face: 'Cascadia Mono', size: 16 },
      colorScheme: 'One Half Dark',
      padding: '18',
      scrollbarState: 'hidden',
      useAcrylic: false,
      opacity: 100,
      cursorShape: 'filledBox',
      bellStyle: 'none',
      suppressApplicationTitle: true,
      tabTitle: 'earshot',
      antialiasingMode: 'cleartype',
    }],
  }, null, 2));
}

function readEvents(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const [name, t] = line.trim().split(/\s+/);
      if (name && t) out[name] = Number(t);
    }
    return out;
  } catch { return {}; }
}

/** Seconds into the clip at which the runner's white marker bar flashed. */
async function findMarker(clip) {
  // A drive letter's colon is an option separator to the lavfi graph parser,
  // so the clip is named relative to its own folder.
  const graph = `movie=${basename(clip)},signalstats`;
  const { stdout } = await run('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', graph,
    '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'],
  { cwd: dirname(clip), maxBuffer: 1 << 26 });
  const rows = stdout.trim().split(/\r?\n/).map((l) => l.split(',').map(Number)).filter((r) => r.length >= 2);
  const base = rows[0][1];
  const hit = rows.find(([, y]) => y > base + 25);
  if (!hit) throw new Error(`no marker frame found in ${clip} (baseline YAVG ${base})`);
  return hit[0];
}

async function windowShot(name, ffmpeg) {
  const events = join(WORK, `${name}.events`);
  const go = join(WORK, `${name}.go`);
  await rm(events, { force: true });
  await rm(go, { force: true });
  const out = join(OUT, `term-${name}.mp4`);

  spawn('wt.exe', ['-w', 'new', '--pos', `${MON[0]},${MON[1]}`, '-F', '-p', PROFILE, '--title', 'earshot-rec',
    'powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUNNER,
    '-Shot', name, '-Go', go, '-Events', events, '-Root', ROOT],
  { detached: true, stdio: 'ignore' }).unref();
  await sleep(4000);

  const ff = spawn(ffmpeg, ['-y', '-v', 'error', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0',
    '-offset_x', String(MON[0]), '-offset_y', String(MON[1]), '-video_size', `${MON[2]}x${MON[3]}`, '-i', 'desktop',
    '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  await sleep(2000);
  await writeFile(go, 'go');

  const deadline = Date.now() + 8 * 60 * 1000;
  while (!readEvents(events).end) {
    if (Date.now() > deadline) throw new Error(`${name}: the runner never reported "end"`);
    await sleep(500);
  }
  await sleep(1000);
  ff.stdin.write('q');
  await new Promise((r) => ff.on('exit', r));

  const raw = readEvents(events);
  const marker = await findMarker(out);
  const rel = {};
  for (const [k, v] of Object.entries(raw)) rel[k] = Number((marker + (v - raw.marker) / 1000).toFixed(3));
  console.log(`  ${name}: marker at ${marker.toFixed(2)}s`, rel);
  return { file: basename(out), mode: 'window', events: rel };
}

/* ----------------------------------------------------------- emulator ---- */

async function xtermFiles() {
  const prefix = join(WORK, 'xterm');
  const lib = join(prefix, 'node_modules', '@xterm', 'xterm');
  const fit = join(prefix, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js');
  if (!existsSync(join(lib, 'lib', 'xterm.js')) || !existsSync(fit)) {
    console.log('  installing @xterm/xterm + addon-fit into docs/.assembly (one-off)');
    await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--silent',
      '@xterm/xterm@5.5.0', '@xterm/addon-fit@0.10.0'], { shell: true });
  }
  return { js: join(lib, 'lib', 'xterm.js'), css: join(lib, 'css', 'xterm.css'), fit };
}

function terminalHtml(x) {
  return `<!doctype html><meta charset="utf-8"><title>terminal</title>
  <link rel="stylesheet" href="${pathToFileURL(x.css).href}">
  <link rel="stylesheet" href="${pathToFileURL(join(DEMO, 'fonts', 'fonts.css')).href}">
  <style>
    body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#15191d}
    #t{position:absolute;left:34px;top:26px;right:34px;bottom:20px}
  </style>
  <div id="t"></div>
  <script src="${pathToFileURL(x.js).href}"></script>
  <script src="${pathToFileURL(x.fit).href}"></script>
  <script>
    const term = new Terminal({
      cols: 120, rows: 30, fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 25, lineHeight: 1.18, letterSpacing: 0, convertEol: true, cursorBlink: true, cursorStyle: 'block',
      scrollback: 5000, allowTransparency: false,
      theme: { background: '#15191d', foreground: '#d9dfe5', cursor: '#d9dfe5', selectionBackground: '#3a4149',
               black: '#15191d', red: '#ff7a88', green: '#4fe0d2', yellow: '#ffb627', blue: '#7fb4ff',
               magenta: '#bba5ff', cyan: '#4fe0d2', white: '#d9dfe5', brightBlack: '#8496a3', brightRed: '#ff7a88',
               brightGreen: '#4fe0d2', brightYellow: '#ffb627', brightBlue: '#7fb4ff', brightMagenta: '#bba5ff',
               brightCyan: '#4fe0d2', brightWhite: '#f3f6f8' },
    });
    window.term = term;
    window.termReady = false;
    // Open only once the font is in, then let the fit addon size the grid from
    // the cell xterm actually measured: a guessed row count that overshoots the
    // box leaves the last lines of output rendered below the visible edge.
    document.fonts.load("25px 'JetBrains Mono'").then(() => document.fonts.ready).then(() => {
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('t'));
      fit.fit();
      window.termGrid = { cols: term.cols, rows: term.rows };
      window.termReady = true;
    });
  </script>`;
}

async function emulatorShot(name, browser) {
  const x = await xtermFiles();
  const html = join(WORK, 'terminal.html');
  await writeFile(html, terminalHtml(x));
  const page = await browser.newPage();
  await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.termReady === true', { timeout: 15000 });
  console.log(`  ${name}: grid`, await page.evaluate(() => window.termGrid));
  await sleep(400);

  const out = join(OUT, `term-${name}.mp4`);
  const rec = await screencast(page, join(WORK, `frames-${name}`));
  const events = {};
  let queue = Promise.resolve();
  const write = (s) => { queue = queue.then(() => page.evaluate((t) => window.term.write(t), s)); return queue; };
  const prompt = `\x1b[2m${ROOT}>\x1b[0m`;

  await rec.start();
  await sleep(700);
  for (const step of SHOTS[name]) {
    await write(prompt);
    events[`${step.tag}-type`] = Number(rec.now().toFixed(3));
    for (const ch of step.show) {
      await write(ch);
      await sleep(38 + Math.floor(Math.random() * 42));
    }
    await sleep(450);
    await write('\r\n');
    events[`${step.tag}-enter`] = Number(rec.now().toFixed(3));

    // cmd.exe is handed the line exactly as shown, from the project root.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', step.show], {
      cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const feed = (b) => { chunks.push(b); write(b.toString('utf8')); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const code = await new Promise((r) => child.on('close', r));
    await queue;
    events[`${step.tag}-done`] = Number(rec.now().toFixed(3));
    events[`${step.tag}-exit`] = code;
    if (step.save) await writeFile(join(OUT, step.save), Buffer.concat(chunks));
    await write('\r\n');
    await sleep(step.pauseAfter);
  }
  const { frames, end } = await rec.stop();
  await page.close();
  await framesToVideo(frames, end, out);
  console.log(`  ${name}: ${frames.length} frames over ${end.toFixed(1)}s`, events);
  return { file: basename(out), mode: 'emulator', events };
}

/* --------------------------------------------------------------- main ---- */

const argv = process.argv.slice(2);
const shots = argv.filter((a) => !a.startsWith('-'));
const wantWindow = argv.includes('--window');
const wantEmulator = argv.includes('--emulator');
const which = shots.length ? shots : Object.keys(SHOTS);
for (const s of which) if (!SHOTS[s]) throw new Error(`unknown shot "${s}"; known: ${Object.keys(SHOTS).join(', ')}`);

await mkdir(OUT, { recursive: true });
await mkdir(WORK, { recursive: true });

const isLocked = await locked();
let mode = wantWindow ? 'window' : wantEmulator ? 'emulator' : isLocked ? 'emulator' : 'window';
if (mode === 'window' && isLocked) {
  throw new Error('the workstation is locked (LogonUI is running); Windows blanks every screen capture on the ' +
    'secure desktop. Unlock it and run again, or pass --emulator.');
}
console.log(`mode: ${mode}${isLocked ? ' (desktop is locked)' : ''}`);

let manifest = {};
try { manifest = JSON.parse(await readFile(join(OUT, 'terminal.json'), 'utf8')); } catch {}

if (mode === 'window') {
  await writeProfileFragment();
  const ffmpeg = await dpiAwareFfmpeg();
  for (const s of which) manifest[s] = await windowShot(s, ffmpeg);
} else {
  const pptr = await puppeteer();
  const browser = await pptr.launch({
    executablePath: chromePath(), headless: true,
    args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars', '--font-render-hinting=none',
      '--allow-file-access-from-files'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  try {
    for (const s of which) manifest[s] = await emulatorShot(s, browser);
  } finally {
    await browser.close();
  }
}
await writeFile(join(OUT, 'terminal.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${join(OUT, 'terminal.json')}`);
process.exit(0);
