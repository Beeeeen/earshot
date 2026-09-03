/**
 * Shared puppeteer plumbing for every renderer in demo/tools/.
 *
 * puppeteer-core is not in earshot's package.json (the server owns that file
 * and two agents editing it is a bad trade), so this resolves it from the
 * sibling blindfold checkout, which already has it, and falls back to a local
 * install if one ever appears. If you would rather vendor it:
 *
 *     npm i -D puppeteer-core        # then this file finds it without the shim
 *
 * Nothing else in demo/ imports puppeteer, so this is the only place that has
 * to change.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = join(DEMO, '..');

const FALLBACKS = [
  join(ROOT, '..', 'blindfold', 'node_modules', 'puppeteer-core'),
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function chromePath() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Edge binary.');
  }
  return found;
}

export async function puppeteer() {
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    for (const dir of FALLBACKS) {
      if (!existsSync(dir)) continue;
      const require = createRequire(join(dir, 'package.json'));
      const entry = require.resolve('puppeteer-core');
      return (await import(pathToFileURL(entry).href)).default;
    }
    throw new Error(
      'puppeteer-core not found. Either `npm i -D puppeteer-core` in earshot, ' +
      'or check that ../blindfold/node_modules/puppeteer-core exists.',
    );
  }
}

/** Boots demo/tools/serve.mjs on a free-ish port and resolves its base URL. */
export async function serveDemo(port = 5199) {
  const child = spawn(process.execPath, [join(DEMO, 'tools', 'serve.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('demo on')) { clearTimeout(bail); resolve(); }
    });
    child.on('exit', (c) => { clearTimeout(bail); reject(new Error('server exited ' + c)); });
  });
  return {
    url: `http://localhost:${port}/`,
    stop: () => child.kill(),
  };
}

/**
 * Opens the demo at a given beat and waits until it has finished rendering it.
 * `?still=N` makes app.js replay beats 0..N and hide the keyboard hints, and
 * sets window.EarshotReady when it is done.
 */
export async function openDemo(browser, base, query, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport ?? { width: 1920, height: 1080, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + 'index.html' + (query ? '?' + query : ''), {
    waitUntil: 'networkidle0',
  });
  await page.waitForFunction('window.EarshotReady === true', { timeout: 25000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 350));
  return { page, errors };
}
