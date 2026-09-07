/**
 * Cuts the takes against the narration and writes docs/demo-assembly.mp4.
 *
 *   npm run voice                               # the clock
 *   npm run record                              # docs/broll/ui-take.mp4, dana-take.mp4, takes.json
 *   node demo/tools/record-terminal.mjs         # docs/broll/term-*.mp4, terminal.json, test-all.txt
 *   node demo/tools/render-cards.mjs            # docs/broll/card-*.mp4
 *   npm run assemble                            # this
 *   npm run captions                            # the matching .srt
 *
 * The edit decision list below is the whole cut. Every cut point is a narrated
 * word (`T.cue`) or a moment the page reported (takes.json / terminal.json),
 * so re-recording the voice re-times the picture without anyone touching a
 * number. Segments are trimmed to identical encoding parameters and joined
 * losslessly; the narration is laid under the joined picture as one stream,
 * decoded from the same wavs the timeline measured.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTimeline, mmss } from './lib/timeline.mjs';

const ROOT = process.cwd();
const BROLL = join(ROOT, 'docs', 'broll');
const WORK = join(ROOT, 'docs', '.assembly', 'cut');
const OUT = join(ROOT, 'docs', 'demo-assembly.mp4');

const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'pipe' });
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const need = (f) => { if (!existsSync(f)) throw new Error(`missing ${f} — see the header of scripts/assemble.mjs`); return f; };

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const T = loadTimeline(ROOT);
const takes = json(need(join(BROLL, 'takes.json')));
const term = json(need(join(BROLL, 'terminal.json')));
const UI = need(join(BROLL, takes.ui.file));
const DANA = need(join(BROLL, takes.dana.file));
const TSC = need(join(BROLL, term.tsc.file));
const TESTALL = need(join(BROLL, term.testall.file));
const CARD = (n) => need(join(BROLL, `card-${n}.mp4`));

const B = (id) => T.beat(id);
const b5 = B('05-shift'), b6 = B('06-verify'), b7 = B('07-compile'), b8 = B('08-identity');
const b9 = B('09-cost-and-limits'), b10 = B('10-honest');

/** When the page reported `what` for the first time after `after` (seconds into the UI take). */
const uiEvent = (what, after = 0, take = takes.ui) => {
  const e = take.events.find((x) => x.what === what && x.t > after);
  if (!e) throw new Error(`the take never reported "${what}" after ${after}s`);
  return e.t;
};

/* ------------------------------------------------------- the beat-6 insert --
   The injected _meta rides in the status pill only while the call is in flight,
   which at the page's pace is under two seconds — long enough to see, not long
   enough to read. Beat 6 is the sentence that explains it, so the frame from
   the moment of the call is held with the pill enlarged over a dimmed copy of
   the same frame. A real frame, magnified, not a card. */
function insertFromFrame(src, at, out, seconds) {
  const png = join(WORK, 'insert-src.png');
  ff(['-ss', at.toFixed(3), '-i', src, '-frames:v', '1', png]);
  const composed = join(WORK, 'insert.png');
  // Header row: brand | status pill | connection badge. Crop the pill's band.
  ff(['-i', png, '-filter_complex',
    '[0:v]split[bg][fg];' +
    '[bg]boxblur=10:2,eq=brightness=-0.28:saturation=0.85[bgd];' +
    '[fg]crop=1300:64:310:14,scale=1950:96:flags=lanczos,crop=1920:96,pad=1920:120:0:12:color=#070A0D@0.0,' +
    'drawbox=x=0:y=0:w=1920:h=120:color=#4FE0D2@0.55:t=2[pill];' +
    '[bgd][pill]overlay=0:(H-h)/2-140:format=auto',
    composed]);
  ff(['-loop', '1', '-i', composed, '-t', seconds.toFixed(3), ...ENC, out]);
  return out;
}

/* ------------------------------------------------------------------- EDL -- */

// tpad holds a source's last frame if a cut runs past its end (a terminal
// clip ends when the runner exits; the narration may still be talking), and
// the length check below refuses a cut that came out short for any other reason.
const ENC = ['-r', '30', '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,tpad=stop_mode=clone:stop_duration=120',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-video_track_timescale', '90000', '-an'];
const seconds = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

const cuts = [];
const seg = (from, to, src, srcAt, note) => cuts.push({ from, to, src, srcAt: Math.max(0, srcAt), note });
const ui = (from, to, note) => seg(from, to, UI, from, note);

// Beats 1-5: the continuous take, on its own clock.
ui(0, b6.start, 'room → phone → strip → the injected ask');

// Beat 6: the pill with the injection, enlarged, until "This is what came back"; then the answer.
const calling = uiEvent('now:calling', b5.start) + 0.45;
const cameBack = T.cue('06-verify', 'This');
const insert = insertFromFrame(UI, calling, join(WORK, 'insert.mp4'), cameBack - b6.start);
seg(b6.start, cameBack, insert, 0, 'detail: the _meta injection in the status pill');
ui(cameBack, T.cue('07-compile', 'And'), 'the byte-identical reply, the ledger row; then the transcript search');

// Beat 7: "And it isn't a filter…" cuts to the terminal; the compiler error lands on "This is what happens".
const tscCut = T.cue('07-compile', 'And');
const tscLand = T.cue('07-compile', 'This') - 0.15;
seg(tscCut, b7.end, TSC, term.tsc.events['tsc-done'] - (tscLand - tscCut), 'real terminal: cat the negative file, tsc fails');

// Beat 8: Sarah's page; "The aide" cuts to Dana's own session, her answer landing on "device"; back for the solo window.
const danaFrom = T.cue('08-identity', 'aide') - 0.35;
const danaTo = T.cue('08-identity', 'And');
const danaAnswer = uiEvent('transcript:2', 0, takes.dana);
ui(b7.end, danaFrom, 'her daughter gets the full card');
seg(danaFrom, danaTo, DANA, danaAnswer - (T.cue('08-identity', 'device') - danaFrom), "Dana's token: what her access covers");
ui(danaTo, b8.end, 'open_solo_window, the ledger row');

// Beat 9: the latency card until "Three hundred and twenty-two"; the test runner's summary lands on "pass".
const nineCut = T.cue('09-cost-and-limits', 'Three');
seg(b9.start, nineCut, CARD('latency'), 0, 'latency card: budget, round trip, handler table');
seg(nineCut, b9.end, TESTALL, term.testall.events['testall-done'] - (T.cue('09-cost-and-limits', 'pass') - nineCut),
  'real terminal: npm run test:all, 322 and the 13 named findings');

// Beat 10: the README limits, then the repo URL from "All of that is in the readme".
const tenCut = T.cue('10-honest', 'All');
seg(b10.start, tenCut, CARD('limits'), 0, 'README: what this does not do');
seg(tenCut, T.total, CARD('url'), 0, 'repo URL');

/* ---------------------------------------------------------------- render -- */

// Sanity: the cuts tile [0, total] exactly, in order.
let cursor = 0;
for (const c of cuts) {
  if (Math.abs(c.from - cursor) > 0.002) throw new Error(`gap in the EDL at ${cursor.toFixed(3)}s → ${c.from.toFixed(3)}s (${c.note})`);
  if (c.to <= c.from) throw new Error(`empty cut: ${c.note}`);
  cursor = c.to;
}
if (Math.abs(cursor - T.total) > 0.002) throw new Error(`EDL ends at ${cursor}, narration at ${T.total}`);

const parts = [];
cuts.forEach((c, i) => {
  const out = join(WORK, `seg-${String(i).padStart(2, '0')}.mp4`);
  ff(['-ss', c.srcAt.toFixed(3), '-i', c.src, '-t', (c.to - c.from).toFixed(3), ...ENC, out]);
  const got = seconds(out);
  if (Math.abs(got - (c.to - c.from)) > 0.07) {
    throw new Error(`cut "${c.note}" is ${got.toFixed(2)}s, wanted ${(c.to - c.from).toFixed(2)}s (source ${c.src} from ${c.srcAt.toFixed(2)}s)`);
  }
  parts.push(out);
  console.log(`  ${mmss(c.from).padStart(5)} – ${mmss(c.to).padStart(5)}  ${(c.to - c.from).toFixed(1).padStart(5)}s  ${c.note}`);
});

const list = join(WORK, 'concat.txt');
writeFileSync(list, parts.map((p) => `file '${p.split('\\').join('/')}'`).join('\n') + '\n');
const picture = join(WORK, 'picture.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]);
const pictureSeconds = seconds(picture);
if (Math.abs(pictureSeconds - T.total) > 0.25) {
  throw new Error(`picture is ${pictureSeconds.toFixed(2)}s but the narration is ${T.total.toFixed(2)}s`);
}

// One narration track, decoded from the wavs the timeline measured, so the
// beat boundaries in the audio are the beat boundaries the picture was cut to.
const wavs = T.beats.map((b) => b.wav);
const narration = join(WORK, 'narration.wav');
ff([...wavs.flatMap((w) => ['-i', w]), '-filter_complex',
  wavs.map((_, i) => `[${i}:a]`).join('') + `concat=n=${wavs.length}:v=0:a=1[a]`, '-map', '[a]', narration]);

ff(['-i', picture, '-i', narration, '-map', '0:v:0', '-map', '1:a:0',
  '-af', `afade=t=in:st=0:d=0.25,afade=t=out:st=${(T.total - 0.45).toFixed(2)}:d=0.45`,
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', OUT]);

const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', OUT], { encoding: 'utf8' });
console.log(`\n${OUT}\n${probe.trim()}`);
console.log(`${mmss(T.total)} narration — limit is 3:00`);
