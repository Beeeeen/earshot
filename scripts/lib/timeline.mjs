/**
 * The one clock every recorder and the assembler read.
 *
 * A beat's length is the decoded length of its narration, not the number
 * ffprobe prints for the mp3 container: those differ by a few milliseconds per
 * clip, and the recorder runs one continuous take against absolute times, so a
 * drift that is invisible on one beat lands the last action a quarter of a
 * second off the word it belongs to. Every mp3 is decoded once to a wav under
 * docs/.assembly/wav/ and that length is the beat length everywhere.
 *
 * `cue(beat, word, nth)` is the absolute time at which the synthesiser started
 * saying a word, from the word timings it wrote. Nothing in the cut is placed
 * by a number typed by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bare = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}'+-]/gu, '');

function decoded(root, id) {
  const dir = join(root, 'docs', '.assembly', 'wav');
  mkdirSync(dir, { recursive: true });
  const mp3 = join(root, 'voice', `${id}.mp3`);
  const wav = join(dir, `${id}.wav`);
  if (!existsSync(wav) || statSync(mp3).mtimeMs > statSync(wav).mtimeMs) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-ar', '48000', '-ac', '2', wav], { stdio: 'pipe' });
  }
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], {
    encoding: 'utf8',
  });
  return { wav, seconds: Number(out.trim()) };
}

export function loadTimeline(root) {
  const spec = JSON.parse(readFileSync(join(root, 'voice', 'narration.json'), 'utf8'));
  const beats = [];
  let t = 0;
  for (const b of spec.beats) {
    const { wav, seconds } = decoded(root, b.id);
    const words = JSON.parse(readFileSync(join(root, 'voice', `${b.id}.timings.json`), 'utf8'));
    beats.push({ ...b, wav, seconds, start: t, end: t + seconds, words });
    t += seconds;
  }
  const total = t;

  const beat = (id) => {
    const b = beats.find((x) => x.id === id);
    if (!b) throw new Error(`no narration beat "${id}"`);
    return b;
  };

  /** Absolute second at which the nth occurrence of `word` begins in beat `id`. */
  const cue = (id, word, nth = 1) => {
    const b = beat(id);
    let n = 0;
    for (const w of b.words) {
      if (bare(w.word) === bare(word) && ++n === nth) return b.start + w.start_ms / 1000;
    }
    throw new Error(`beat ${id} never says "${word}" (occurrence ${nth})`);
  };

  return { spec, beats, total, beat, cue };
}

export const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
