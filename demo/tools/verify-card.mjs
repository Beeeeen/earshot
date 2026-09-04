/**
 * Proof that the `ui://` card renders — by rendering it, in Chrome, from bytes
 * fetched over the real protocol.
 *
 *     node demo/tools/verify-card.mjs
 *
 * A screenshot proves nothing a judge can check. This drives the whole path and
 * asserts what came out the other end:
 *
 *   1. A real Earshot server on an ephemeral port, real OAuth 2.1 + PKCE, real
 *      Streamable HTTP. Started by this script; no fixtures anywhere.
 *   2. demo/card-host.html is a real MCP Apps host: it declares the extension
 *      with `mimeTypes`, calls a tool, reads `_meta.ui.resourceUri`, fetches
 *      the view with `resources/read`, builds the spec's CSP from the
 *      resource's own `_meta.ui.csp`, injects it so Chrome enforces it, and
 *      runs the host half of the postMessage bridge.
 *   3. The card's own script completes `ui/initialize`, receives
 *      `ui/notifications/tool-result`, and paints.
 *   4. Then this script reads the rendered DOM INSIDE the sandboxed frame and
 *      checks it against the wire.
 *
 * The two checks that matter:
 *
 *   - the number on the card equals `privateDelivery.fieldCount` from the tool
 *     result, so the card is rendering live data rather than a placeholder;
 *   - no string from the server's own DEMO_SECRETS appears anywhere in the
 *     frame — including on a second run where a medication name is deliberately
 *     spliced into the payload the host hands the view (`?inject=1`). The card
 *     reads five named fields and ignores everything else, and that is the run
 *     that proves it rather than the comment that claims it.
 *
 * Exit code 0 if every assertion held, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEMO, ROOT, chromePath, puppeteer, serveDemo } from './lib/browser.mjs';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

let passed = 0;
let failed = 0;

function ok(name, detail) {
  passed += 1;
  console.log(`  ${GREEN}✓${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}
function bad(name, detail) {
  failed += 1;
  console.log(`  ${RED}✗ ${name}${RESET}`);
  if (detail) console.log(`      ${RED}${detail}${RESET}`);
}
function check(name, cond, detail) {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

/** Boot the real Earshot server on a port of its own. */
async function serveEarshot(port) {
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), EARSHOT_DEMO: '1', EARSHOT_START: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('earshot server did not start')), 10000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('listening on')) { clearTimeout(bail); resolve(); }
    });
    child.on('exit', (c) => { clearTimeout(bail); reject(new Error('earshot exited ' + c)); });
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

async function openHost(browser, demoBase, earshotUrl, query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
  const errors = [];
  const cspViolations = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => errors.push('request failed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy/i.test(t)) cspViolations.push(t);
    else if (m.type() === 'error') errors.push(t);
  });
  const url = `${demoBase}card-host.html?server=${encodeURIComponent(earshotUrl)}${query ? '&' + query : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.EarshotHostReady === true || window.EarshotHostError', { timeout: 25000 });
  const err = await page.evaluate('window.EarshotHostError || null');
  if (err) throw new Error('host failed: ' + err);
  // The frame paints on the tool-result notification, one message turn later.
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error('no iframe was created');
  await frame.waitForFunction('document.body.getAttribute("data-earshot-rendered") === "1"', { timeout: 15000 });
  return { page, frame, errors, cspViolations };
}

async function main() {
  console.log(`${BOLD}Earshot — MCP Apps card, rendered and checked${RESET}`);

  const secrets = await import(pathToFileURL(join(ROOT, 'dist', 'domain', 'seed.js')).href).catch(() => null);
  if (!secrets) {
    console.log(`${RED}run \`npx tsc -p tsconfig.json\` first${RESET}`);
    process.exit(1);
  }
  const scan = [...new Set([...(secrets.DEMO_SECRETS ?? []), ...(secrets.DEMO_SECRET_FRAGMENTS ?? [])])]
    .filter((s) => typeof s === 'string' && s.length >= 3);

  const earshot = await serveEarshot(8799);
  const demo = await serveDemo(5198);
  const browser = await (await puppeteer()).launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    console.log(`\n${BOLD}the ordinary path${RESET}`);
    const run1 = await openHost(browser, demo.url, earshot.url);
    const state = await run1.page.evaluate(() => ({
      cardBytes: window.EarshotHost.cardHtml.length,
      csp: window.EarshotHost.csp,
      delivery: window.EarshotHost.toolResult.structuredContent.privateDelivery,
      resourceUri: window.EarshotHost.toolResult._meta.ui.resourceUri,
      negotiated: window.EarshotHost.toolResult._meta['earshot/uiExtensionNegotiated'],
    }));

    check('the host negotiated the MCP Apps extension', state.negotiated === true,
      `earshot/uiExtensionNegotiated = ${state.negotiated}`);
    check('the tool result carried a ui:// binding', String(state.resourceUri).startsWith('ui://'),
      state.resourceUri);
    check('the card came off resources/read', state.cardBytes > 1500, `${state.cardBytes} bytes`);
    check('the enforced CSP forbids network access',
      state.csp.includes("connect-src 'self'") && !/connect-src[^;]*https?:/.test(state.csp),
      state.csp.split('; ').find((d) => d.startsWith('connect-src')));
    check('no CSP violation while rendering', run1.cspViolations.length === 0,
      run1.cspViolations.join(' | '));
    check('no script error inside the host or the view', run1.errors.length === 0,
      run1.errors.join(' | '));

    const rendered = await run1.frame.evaluate(() => ({
      count: document.getElementById('count').textContent,
      who: document.getElementById('who').textContent,
      meta: document.getElementById('meta').textContent,
      rows: document.querySelectorAll('#rows li').length,
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
    }));

    check('the card rendered the field count from the wire',
      rendered.count === String(state.delivery.fieldCount),
      `card says "${rendered.count}", the tool result said ${state.delivery.fieldCount}`);
    check('the card rendered the recipient from the wire',
      rendered.who === `${state.delivery.recipient}'s`,
      `card says "${rendered.who}", the tool result said "${state.delivery.recipient}"`);
    check('the card rendered the delivery id from the wire',
      rendered.meta.includes(state.delivery.deliveryId),
      `card meta line: "${rendered.meta}"`);
    // Six masked rows plus, when there are more than six, one row saying how
    // many are not drawn. The card must never claim fewer than it received.
    const n = state.delivery.fieldCount;
    check('the withheld rows account for every field',
      rendered.rows === Math.min(n, 6) + (n > 6 ? 1 : 0) &&
        // innerText reflects text-transform, and that row is uppercased.
        (n <= 6 || rendered.text.toLowerCase().includes(`and ${n - 6} more`)),
      `${rendered.rows} rows for ${n} fields`);
    check('the card says what it is', rendered.text.includes('Not said out loud'));

    const leaked1 = scan.filter((s) => rendered.html.includes(s));
    check('no protected value anywhere in the rendered card', leaked1.length === 0,
      leaked1.join(', '));

    // And the payload really does exist — otherwise "the card is clean" is
    // trivially true and proves nothing.
    const inboxText = await run1.page.evaluate(() => document.getElementById('inbox').innerText);
    const onPhone = scan.filter((s) => inboxText.includes(s));
    check('the same protected values ARE on /inbox, fetched with her own token',
      onPhone.length >= 3, `${onPhone.length} found on the phone pane, 0 on the card`);

    console.log(`\n${BOLD}the adversarial path  ${DIM}?inject=1 — a medication name spliced into the view's payload${RESET}`);
    const run2 = await openHost(browser, demo.url, earshot.url, 'inject=1');
    const injected = await run2.frame.evaluate(() => document.documentElement.outerHTML);
    const hostSaw = await run2.page.evaluate(
      () => JSON.stringify(window.EarshotHost.sentToView),
    );
    const smuggled = scan.filter((s) => hostSaw.includes(s));
    check('the host really did hand the view a payload containing a medication name',
      smuggled.length > 0,
      smuggled.length > 0 ? `spliced in: ${smuggled.join(', ')}` : 'otherwise this run proves nothing');
    const leaked2 = scan.filter((s) => injected.includes(s)).concat(
      injected.includes('Furosemide') ? ['Furosemide'] : [],
    );
    check('the card still renders nothing outside its whitelist', leaked2.length === 0,
      leaked2.join(', '));

    await run1.page.close();
    await run2.page.close();
  } finally {
    await browser.close();
    demo.stop();
    earshot.stop();
  }

  console.log('');
  if (failed > 0) {
    console.log(`${RED}${BOLD}${failed} failed${RESET}, ${passed} passed`);
    console.log(`CARD_VERIFY_RESULT ${JSON.stringify({ passed, failed })}`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}${passed} checks passed${RESET} — the card rendered in Chrome from bytes fetched over MCP`);
  console.log(`CARD_VERIFY_RESULT ${JSON.stringify({ passed, failed })}`);
  process.exit(0);
}

void DEMO;
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
