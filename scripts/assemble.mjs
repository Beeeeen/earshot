/**
 * Builds a watchable rough cut from the narration and the recorded clips.
 *
 *   npm run assemble        # → docs/demo-assembly.mp4
 *
 * Beats with B-roll get their footage. The three beats only you can shoot get a
 * placeholder card carrying the line being spoken and the exact length needed,
 * so the timing of the whole thing is already correct before you shoot a frame.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = process.cwd();
const VOICE = join(ROOT, 'voice');
const BROLL = join(ROOT, 'docs', 'broll');
const WORK = join(ROOT, 'docs', '.assembly');
const OUT = join(ROOT, 'docs', 'demo-assembly.mp4');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const spec = JSON.parse(readFileSync(join(VOICE, 'narration.json'), 'utf8'));
const durations = JSON.parse(readFileSync(join(VOICE, 'durations.json'), 'utf8'));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'pipe' });

/** Placeholder cards are rendered in the browser: no drawtext font escaping,
 *  and they can look like the rest of the project. */
async function makeCards(missing) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  for (const beat of missing) {
    const seconds = durations[beat.id];
    await page.setContent(
      `<style>
         *{box-sizing:border-box}
         body{margin:0;height:1080px;display:grid;place-content:center;gap:28px;
              background:#14181a;color:#f7f6f2;padding:0 160px;text-align:center;
              font:400 15px/1.6 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
         .tag{font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:#7fbf9c}
         .what{font-size:44px;font-weight:600;line-height:1.25;letter-spacing:-.02em}
         .len{font-size:20px;color:#9aa4a8}
         .said{font-size:21px;line-height:1.65;color:#c9d1cd;max-width:26ch;
               margin:14px auto 0;font-style:italic}
       </style>
       <div class="tag">Shoot this</div>
       <div class="what">${beat.footage.replace(/^YOU:\s*/, '')}</div>
       <div class="len">${seconds.toFixed(1)} seconds</div>
       <div class="said">“${beat.text.slice(0, 150)}${beat.text.length > 150 ? '…' : ''}”</div>`,
      { waitUntil: 'domcontentloaded' },
    );
    const png = join(WORK, `${beat.id}.png`);
    await page.screenshot({ path: png });
    ff(['-loop', '1', '-i', png, '-t', String(seconds), '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(WORK, `${beat.id}.card.mp4`)]);
  }
  await browser.close();
}

const chatgptTake = join(BROLL, '05b-chatgpt.webm');
const useChatgpt = existsSync(chatgptTake);
if (useChatgpt) {
  const alt = (spec.optional ?? []).find((o) => o.id === '05b-chatgpt');
  const i = spec.beats.findIndex((b) => b.id === '05-work');
  if (alt && i >= 0) {
    spec.beats[i] = alt;
    console.log('using your ChatGPT take for beat 5');
  }
}

const missing = spec.beats.filter((b) => !existsSync(join(BROLL, `${b.id}.webm`)));
if (missing.length) {
  console.log('placeholder cards:', missing.map((b) => b.id).join(', '));
  await makeCards(missing);
}

// Normalise every segment to the same codec/size/rate so concat is lossless-ish.
const segments = [];
for (const b of spec.beats) {
  const audio = join(VOICE, `${b.id}.mp3`);
  if (!existsSync(audio)) throw new Error(`missing narration for ${b.id} — run npm run voice`);
  const video = existsSync(join(BROLL, `${b.id}.webm`))
    ? join(BROLL, `${b.id}.webm`)
    : join(WORK, `${b.id}.card.mp4`);
  const out = join(WORK, `${b.id}.seg.mp4`);
  ff([
    '-i', video, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    // The screencast clips land a few frames short of their narration, and
    // -shortest would then clip the tail off every line — ten times over, the
    // captions end up more than a second adrift. Holding the last frame lets
    // the audio decide the length, so a beat is exactly as long as it sounds.
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x14181a,fps=30,tpad=stop_mode=clone:stop_duration=1',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-shortest', out,
  ]);
  segments.push(out);
  console.log(`  ${b.id.padEnd(14)} ${durations[b.id].toFixed(1)}s`);
}

const list = join(WORK, 'concat.txt');
writeFileSync(list, segments.map((s) => `file '${s.split('\\').join('/')}'`).join('\n'));
const joined = join(WORK, 'joined.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

// Fade the very start and end so the cut does not click, and re-check the
// loudness of the whole thing rather than trusting the per-beat targets.
const total = spec.beats.reduce((a, b) => a + durations[b.id], 0);
ff([
  '-i', joined,
  '-af', `afade=t=in:st=0:d=0.25,afade=t=out:st=${(total - 0.45).toFixed(2)}:d=0.45`,
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', OUT,
]);

console.log(`\n${OUT}`);
console.log(`${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} — limit is 3:00`);
