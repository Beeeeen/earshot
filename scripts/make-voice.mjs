/**
 * Narration for the demo video.
 *
 *   npm run voice
 *
 * Synthesises voice/narration.json into one mp3 per beat with Edge TTS, using
 * the same helper and voice pool as the content-factory pipeline next door.
 * Writes voice/cut-sheet.md with the measured duration of each clip, which is
 * what the recording script reads to hold each shot for exactly as long as the
 * words take.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VOICE_DIR = join(ROOT, 'voice');
const HELPER =
  process.env.EDGE_TTS_HELPER ??
  'c:/Users/BenYang/Documents/Beeeeen/content-factory/app/internal/tts/edge_tts_helper.py';

const spec = JSON.parse(readFileSync(join(VOICE_DIR, 'narration.json'), 'utf8'));
mkdirSync(VOICE_DIR, { recursive: true });

/**
 * The clearest tell of a synthesised read is that every line moves at the same
 * speed. A person slows for the line that matters and picks up through the
 * connective tissue, so each beat carries its own rate and the delivery has a
 * shape.
 */
const rateFor = (beat) => beat.rate ?? spec.rate;

/**
 * What separates a recorded voice from a synthesised one is mostly not the
 * synthesis -- it is that nobody put the result through a desk. High-pass out
 * the rumble, dip where TTS gets boxy, lift presence and air, compress gently
 * (heavy compression flattens the delivery, which is the opposite of warmth),
 * add a room so small you only notice it when it is gone, and land on the
 * loudness target video platforms expect.
 */
const MASTER = [
  'highpass=f=75',
  'equalizer=f=220:t=q:w=1.2:g=-2.5',
  'equalizer=f=2800:t=q:w=1.8:g=2',
  'equalizer=f=9500:t=h:g=2.5',
  'acompressor=threshold=-20dB:ratio=2.2:attack=15:release=240:makeup=1.5',
  'aecho=0.9:0.25:22:0.09',
  'loudnorm=I=-16:TP=-1.5:LRA=11',
].join(',');

const durationOf = (file) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }).trim(),
  );

const results = [];
let total = 0;

for (const beat of [...spec.beats, ...(spec.optional ?? [])]) {
  const txt = join(VOICE_DIR, `${beat.id}.txt`);
  const mp3 = join(VOICE_DIR, `${beat.id}.mp3`);
  const timings = join(VOICE_DIR, `${beat.id}.timings.json`);
  writeFileSync(txt, beat.text, 'utf8');

  const raw = join(VOICE_DIR, `${beat.id}.raw.mp3`);
  execFileSync(
    'python',
    [HELPER, '--text-file', txt, '--voice', spec.voice, `--rate=${rateFor(beat)}`,
      '--out-audio', raw, '--out-timings', timings],
    { stdio: 'pipe' },
  );
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', MASTER,
    '-c:a', 'libmp3lame', '-b:a', '192k', mp3], { stdio: 'pipe' });
  rmSync(raw, { force: true });

  const seconds = durationOf(mp3);
  const isOptional = (spec.optional ?? []).some((o) => o.id === beat.id);
  if (!isOptional) total += seconds;
  results.push({ ...beat, seconds, isOptional });
  console.log(`  ${beat.id.padEnd(14)} ${seconds.toFixed(1)}s   rate ${rateFor(beat)}`);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`\ntotal narration: ${mmss(total)} (limit 3:00)`);
if (total > 165) console.log('WARNING: too close to the 3:00 cap — trim a beat.');

// Durations the recorder reads, so the visuals hold as long as the words do.
writeFileSync(
  join(VOICE_DIR, 'durations.json'),
  JSON.stringify(Object.fromEntries(results.map((r) => [r.id, r.seconds])), null, 2) + '\n',
);

const sheet = [
  '# Cut sheet',
  '',
  `Voice: \`${spec.voice}\` at rate \`${spec.rate}\`. Regenerate with \`npm run voice\`.`,
  '',
  `**Total narration ${mmss(total)}**, against a 3:00 limit. Leave the gaps between`,
  'clips short — the numbers below are speech only.',
  '',
  '| # | Clip | Length | Footage |',
  '|---|---|---|---|',
  ...results.map((r, i) => `| ${i + 1} | \`voice/${r.id}.mp3\` | ${r.seconds.toFixed(1)}s | ${r.footage} |`),
  '',
  '## What you still have to shoot',
  '',
  'Nothing. Every required beat is recorded in `docs/broll/`. The optional swap',
  'above is the only thing a camera would add.',
  '',
  '## Assembling',
  '',
  '`npm run assemble` already does this and writes `docs/demo-assembly.mp4`:',
  'every beat in order, narration laid under it, and a card standing in for each',
  'shot that is yours. Watch that first — the pacing of the finished video is',
  'already in it.',
  '',
  'To finish by hand instead:',
  '',
  '1. Lay the nine narration clips end to end, in order.',
  '2. Put `docs/broll/<id>.webm` under its own clip. Each was recorded to the',
  '   measured length of that line, so nothing needs stretching.',
  '3. Replace the three cards with your footage, cut to the same length.',
  '4. Word-level timings are in `voice/*.timings.json` if you want to cut on a',
  '   specific word.',
  '',
].join('\n');

writeFileSync(join(VOICE_DIR, 'cut-sheet.md'), sheet + '\n');
console.log('wrote voice/cut-sheet.md and voice/durations.json');
