/**
 * Static server for the demo. No dependencies on purpose -- one less thing to
 * install on a machine that is about to record a submission video.
 *
 *   node demo/tools/serve.mjs            # http://localhost:5174/
 *   node demo/tools/serve.mjs --port 80
 *
 * The demo needs to be served rather than opened from file:// because it talks
 * to the MCP server with fetch(), and a file:// page has a null origin that no
 * CORS policy can allow.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

/* ---------------------------------------------------------------- /link ----
 * Stands in for the phone doing its OAuth 2.1 + PKCE link. Real flow against
 * the real authorisation server -- register, authorize, consent, exchange --
 * it is only here rather than in the page because the browser cannot read the
 * `Location` header on the authorize redirect (it is not in the server's
 * access-control-expose-headers, and `redirect: 'manual'` gives JS an opaque
 * response). Node can, so it does the hop and hands back the token.
 *
 *   GET /link?base=http://127.0.0.1:8787&person=sarah
 *     -> { personId, accessToken, scopes }
 *
 * The token that comes back is the asker's own, and the page then uses it for
 * both /mcp and /inbox -- which is the point, because /inbox is where the
 * medication name actually is.
 */
const REDIRECT_URI = 'http://127.0.0.1:59999/callback';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function link(base, person) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Earshot demo simulator', redirect_uris: [REDIRECT_URI] }),
  });
  if (reg.status !== 201) throw new Error(`register ${reg.status}: ${await reg.text()}`);
  const { client_id } = await reg.json();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const q = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: REDIRECT_URI,
    code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'care.read care.write ledger.read solo.open',
    state: b64url(randomBytes(9)), resource: `${base}/mcp`, account: person,
  });
  const dec = await fetch(`${base}/oauth/authorize/decision?${q}`, { redirect: 'manual' });
  if (dec.status !== 302) throw new Error(`authorize ${dec.status}: ${await dec.text()}`);
  const code = new URL(dec.headers.get('location')).searchParams.get('code');
  if (!code) throw new Error('no code on the authorize redirect');

  const tok = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    }).toString(),
  });
  if (!tok.ok) throw new Error(`token ${tok.status}: ${await tok.text()}`);
  const t = await tok.json();
  return { personId: person, accessToken: t.access_token, scopes: (t.scope ?? '').split(' ').filter(Boolean) };
}

const DEMO = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ROOT = normalize(join(DEMO, '..'));
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 5174));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);

    /* ------------------------------------------------------------ /x/* ----
     * Same-origin proxy to the Earshot server.
     *
     * Needed because as of this writing the AUTHENTICATED success path on
     * /mcp comes back with no CORS headers at all: src/server.ts builds them
     * in corsHeaders() and applies them to its own sendJson replies, but once
     * a request is handed to StreamableHTTPServerTransport the SDK writes the
     * response and they are lost. The 401 has them; the 200 does not. A
     * browser therefore cannot read the reply, and cannot read
     * `mcp-session-id` either.
     *
     * Fix upstream: set them on `res` before handing off to the transport.
     * When that lands, `?direct=1` skips this proxy entirely.
     */
    if (path === '/x/mcp' || path === '/x/inbox') {
      const base = (url.searchParams.get('base') || '').replace(/\/+$/, '');
      const up = base + (path === '/x/mcp' ? '/mcp'
                                           : '/inbox' + (url.searchParams.get('peek') ? '?peek=1' : ''));
      const fwd = {};
      for (const h of ['content-type', 'accept', 'authorization',
                       'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
        if (req.headers[h]) fwd[h] = req.headers[h];
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await fetch(up, {
        method: req.method,
        headers: fwd,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const out = { 'Cache-Control': 'no-store' };
      for (const h of ['content-type', 'mcp-session-id', 'www-authenticate']) {
        const v = r.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
      return;
    }

    /* --------------------------------------------------------- /secrets ----
     * The canonical list of strings that must never reach the spoken channel,
     * read out of the built server itself (src/domain/seed.ts exports
     * DEMO_SECRETS, "built from the same literals used to seed the store, so
     * the leak scan cannot drift out of sync with the data it is scanning
     * for"). It is the same list src/selftest greps raw response bodies with.
     *
     * The demo verifies against this rather than against a list of its own,
     * and rather than against "every field that came back on /inbox" -- that
     * second one sounds rigorous and is not: the inbox also carries the
     * reporter's name and a severity, so it flags "Sarah" as leaked the moment
     * Sarah speaks.
     *
     * In a deployed system this would come from the server over HTTP. Reading
     * dist/ is a dev-harness shortcut, and it fails loudly rather than
     * silently falling back if the build is missing.
     */
    if (path === '/secrets') {
      try {
        const seed = await import(
          pathToFileURL(join(ROOT, 'dist', 'domain', 'seed.js')).href);
        const scan = [...new Set([...(seed.DEMO_SECRETS ?? []),
                                  ...(seed.DEMO_SECRET_FRAGMENTS ?? [])])]
          .filter((v) => typeof v === 'string' && v.length >= 3);
        const chips = (seed.DEMO_SECRET_FRAGMENTS ?? []).slice(0, 6);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
           .end(JSON.stringify({ scan, chips, source: 'dist/domain/seed.js' }));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'run `npx tsc -p tsconfig.json` first — ' + err.message }));
      }
      return;
    }

    if (path === '/link') {
      const base = url.searchParams.get('base');
      const person = url.searchParams.get('person') ?? 'sarah';
      try {
        const out = await link(base.replace(/\/+$/, ''), person);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
           .end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
      return;
    }

    if (path.endsWith('/')) path += 'index.html';

    // Contain everything under demo/. normalize() collapses ../ first, so a
    // request for /../../secrets resolves outside ROOT and is refused here.
    const file = normalize(join(DEMO, path));
    if (!file.startsWith(DEMO)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
  }
}).listen(PORT, () => {
  console.log(`demo on http://localhost:${PORT}/`);
  console.log('  ?auto=1          play straight through, for recording');
  console.log('  ?still=4         jump to beat 4 and hide the key hints');
  console.log('  ?server=URL      point at a specific MCP endpoint');
  console.log('  ?mode=scripted   force fixtures even if a server is up');
});
