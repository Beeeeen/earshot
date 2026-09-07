/**
 * Frame capture over the DevTools protocol, timed by the wall clock.
 *
 * Chrome's screencast only emits a frame when something on the page changed,
 * so a recording is a sparse list of frames with the moment each arrived. That
 * is exactly what an edit needs: hold each frame until the next one, and a
 * beat that is deliberately still costs two frames instead of an empty file.
 * It also does not care what size the physical display is, which matters on a
 * machine whose desktop is smaller than the 1920x1080 the demo is captured at.
 *
 *   const rec = await screencast(page, workDir);
 *   await rec.start();               // t = 0
 *   ... drive the page ...
 *   const { frames, end } = await rec.stop();
 *   await framesToVideo(frames, end, 'out.mp4');
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function screencast(page, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const client = await page.createCDPSession();
  const frames = [];
  let started = null;
  let n = 0;
  let writes = Promise.resolve();

  client.on('Page.screencastFrame', ({ data, sessionId }) => {
    const arrived = performance.now();
    const file = join(dir, `f${String(++n).padStart(5, '0')}.png`);
    frames.push({ t: started === null ? 0 : (arrived - started) / 1000, file });
    writes = writes.then(() => writeFile(file, Buffer.from(data, 'base64')));
    client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await client.send('Page.startScreencast', {
    format: 'png', maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
  });

  const now = () => (performance.now() - started) / 1000;
  return {
    now,
    /** Marks t = 0 and pins a full screenshot there, so the first frame is never missing. */
    async start() {
      const file = join(dir, 'f00000.png');
      await page.screenshot({ path: file });
      started = performance.now();
      frames.unshift({ t: 0, file });
    },
    async until(t) {
      const ms = Math.round((t - now()) * 1000);
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    },
    async stop() {
      const end = now();
      await client.send('Page.stopScreencast');
      await writes;
      const file = join(dir, 'f99999.png');
      await page.screenshot({ path: file });
      frames.push({ t: end, file });
      await client.detach();
      return { frames, end };
    },
  };
}

/** Sparse timed frames -> constant-rate 1080p30 mp4 (each frame held until the next). */
export async function framesToVideo(frames, end, out) {
  // The concat list lives with the frames, not next to the finished clip.
  const list = join(dirname(frames[0].file), 'concat.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    const d = Math.max(0.001, next - frames[i].t);
    lines.push(`file '${frames[i].file.split('\\').join('/')}'`, `duration ${d.toFixed(4)}`);
  }
  // The concat demuxer drops the last duration unless the file is listed again.
  lines.push(`file '${frames[frames.length - 1].file.split('\\').join('/')}'`);
  await writeFile(list, lines.join('\n') + '\n');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-movflags', '+faststart', '-t', end.toFixed(3), out]);
  return out;
}
