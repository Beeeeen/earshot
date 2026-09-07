# demo/

The two-pane simulator that gets filmed. Left pane is the spoken channel —
literally everything within earshot. Right pane is the asker's own phone. The
strip along the bottom is the ledger, the count of protected values ever spoken
aloud, and a search box so a viewer can check that count by hand.

## Run it

```
node demo/tools/serve.mjs          # http://localhost:5174/
```

It has to be served, not opened from `file://`: the page talks to the MCP
server with `fetch`, and a `file://` page has a null origin no CORS policy can
allow.

| key | |
|---|---|
| `Space` / `→` | next beat |
| `←` | back |
| `R` | reset |
| `A` | autoplay |
| `/` | focus the search box |

Everything sizes off the viewport, so the same layout fills any 16:9 window.
Capture at **1920x1080 or larger** — at 1280x720 the smallest labels land near
9px, which survives the screen but not the compression.


| query param | |
|---|---|
| `?auto=1` | play straight through, for recording |
| `?speed=3` | run the beat timings faster |
| `?still=4` | jump to beat 4, hide the key hints (used by the renderers) |
| `?raw=1` | with `?still=`, open the raw transcript overlay |
| `?server=URL` | point at a specific MCP endpoint |
| `?mode=scripted` | force fixtures even when a server is up |
| `?direct=1` | skip the same-origin proxy and talk to the server directly |
| `?person=dana` | link as somebody else — `sarah` (default), `margaret`, `dana`, `tom` |

## Running it live

```
npx tsc -p tsconfig.json && node dist/server.js    # the real server, :8787
node demo/tools/serve.mjs                          # the demo,        :5174
```

On load the page links a real OAuth 2.1 + PKCE account, handshakes MCP over
Streamable HTTP, and drives the eight real tools. The badge goes cyan —
**LIVE · earshot · 8 tools** — and the ledger shows a measured round-trip per
call. With nothing listening it falls back to the fixtures in `scenario.js`,
the badge reads **SCRIPTED** in amber, and the latency column shows a dash
rather than a made-up number.

**Both panes, and where each is fed from.** This is the architecture, so the
demo has to honour it: the private payload is not in the MCP response and
cannot be. Per `src/protocol/private-channel.ts`, putting it there would put it
in the model's context, which is the after-the-fact filtering this project
exists to argue against.

| pane | endpoint | credential |
|---|---|---|
| left, the room | `POST /mcp` → `structuredContent.spoken` | the session's token |
| right, her phone | `GET /inbox` → `deliveries[].fields` | **the asker's own** token |

So the right pane is not a rendering of something the model was told. It is a
second fetch, with a second credential, to a second endpoint.

### The three helper routes in `serve.mjs`

| route | why it exists |
|---|---|
| `/link` | Does the OAuth hop in Node. The browser cannot: `Location` on the authorize redirect is not in the server's `expose-headers`, and `redirect: 'manual'` hands JS an opaque response. |
| `/x/mcp`, `/x/inbox` | Same-origin proxy. See the CORS note below. `?direct=1` bypasses it. |
| `/secrets` | The server's own `DEMO_SECRETS` from `dist/domain/seed.js` — the canonical list of strings that must never be spoken, the same one `src/selftest` greps raw response bodies with. The verifier checks against this, not against a list the demo invented. |

### Known server-side issue

**Fixed.** The authenticated `/mcp` success path used to return no CORS headers:
`corsHeaders()` was applied to `sendJson` replies — the 401 had them — but once a
request was handed to `StreamableHTTPServerTransport` the SDK wrote the response
itself and they were lost, so a browser could not read the reply or
`mcp-session-id`. The fix landed upstream in `src/server.ts`: headers are set
directly on `res` before any dispatch, so they survive whatever `writeHead` the
SDK does later. The demo still proxies through its own origin (that choice
stands regardless — Alexa+ talks server-to-server and will not care either way),
but a plain browser MCP client no longer needs to.

### If the badge says `LIVE (shape unknown)`

The server answered but `normalise()` in `adapter.js` could not find `spoken`.
That function is the whole contract surface and it is about thirty lines.

## Files

| | |
|---|---|
| `index.html` `styles.css` `tokens.css` | the page. Tokens are gated by `tools/check-contrast.py` |
| `scenario.js` | the beat script, the protected-value list, and the fixtures |
| `adapter.js` | **the only file that knows where a result comes from** |
| `card-host.html` | our own MCP Apps host, for rendering the `ui://` card |
| `app.js` | the engine, the invariant guard, the verifier |
| `fonts/` | Inter + JetBrains Mono, vendored so a recording never depends on wifi |

## The MCP Apps host — `card-host.html`

A second page, separate from the filmed simulator, because it answers a
different question: **does the `ui://` card actually render?**

We have no access to Alexa+, so we cannot show it rendering there. What we can
do is implement the host side of the MCP Apps extension ourselves and render the
card for real. That is all this page is, it says so on itself, and it is never
presented as Alexa+.

```
node dist/server.js                # the real server, :8787
node demo/tools/serve.mjs          # then open http://localhost:5174/card-host.html
```

It links a real OAuth account, `initialize`s declaring
`capabilities.extensions["io.modelcontextprotocol/ui"] = {mimeTypes:
["text/html;profile=mcp-app"]}` (`mimeTypes` is REQUIRED — a host that omits it
has not declared support), calls `check_adherence`, reads `_meta.ui.resourceUri`
off the result, fetches the view with `resources/read`, builds the CSP from the
resource's own `_meta.ui.csp` using the template in the spec, injects it so
Chrome enforces it, and then runs the host half of the postMessage bridge:
answer `ui/initialize`, wait for `ui/notifications/initialized`, send
`ui/notifications/tool-result`.

Beside it, `GET /inbox` with the asker's own token. The two panes are the whole
argument: the medication names are visibly in one and visibly not in the other,
and both came off the same server milliseconds apart.

| query param | |
|---|---|
| `?server=URL` | which Earshot to talk to (default `http://127.0.0.1:8787`) |
| `?person=dana` | link as somebody else |
| `?inject=1` | splice a medication name into the payload handed to the view, to show the card ignores every field outside its whitelist |

**Why the card holds a receipt and not the payload.** A `ui://` resource is
served by `resources/read`, an ordinary JSON-RPC method on the same
authenticated `/mcp` session the model drives — `src/selftest/apps.check.ts`
drives exactly that call and gets the bytes back. So the card body is on the
model's channel. And the iframe holds no credential: the spec's default CSP is
`connect-src 'none'`, the frame is an opaque origin, and `McpUiHostContext`
carries no auth field of any kind. There is no path from the server to the view
that does not cross the model's context, so the card shows what the MCP response
already contained — a count, a recipient, a delivery id — and says why it cannot
show more.

## Checks

```
python demo/tools/check-contrast.py    # palette gate: WCAG, CIE L*, CIEDE2000 + dichromacy
node demo/tools/smoke.mjs              # renders every beat, re-checks the invariant from outside the page
node demo/tools/verify-live.mjs        # drives the demo against a real MCP server, including a leaking one
node demo/tools/verify-card.mjs        # renders the ui:// card in Chrome and checks it against the wire
```

`verify-card.mjs` (`npm run verify:card`) starts a real server and the demo
server, opens `card-host.html` in headless Chrome, waits for the card to paint,
and then reads the DOM **inside the sandboxed frame**: the number on the card
must equal `privateDelivery.fieldCount` from the tool result, the recipient and
delivery id must match, and no string in the server's own `DEMO_SECRETS` may
appear anywhere in the frame. It runs a second time with `?inject=1`, where a
medication name is deliberately spliced into the payload the host hands the
view, and asserts the rendered DOM stays clean — the card reads five named
fields and ignores everything else, and that run is what proves it. 15 checks,
and it needs Chrome, which is why it is not in `npm run test:all`.

With no arguments, `verify-live.mjs` runs `tools/mock-mcp.mjs` on :8791 — a
test double that mirrors the real envelope and serves its own `/inbox`, but
with different data, so a pass means the words on screen came over the wire.
Its last two checks point the demo at a server that deliberately leaks
(`MOCK_LEAK=1`) and assert the counter moves off 0 and the page goes red.

Against the real server:

```
node demo/tools/verify-live.mjs --server http://127.0.0.1:8787/mcp
```

That run checks, among other things, that every string in the server's own
protected list appears on the phone and none of them appears in the transcript,
and that every round trip is inside the 500 ms ceiling in SPEC.md.

## Renderers

```
node demo/tools/render-icons.mjs       # -> addon-package/icons/  (6 sizes x 2 themes)
node demo/tools/render-carousel.mjs    # -> addon-package/carousel-1-600x900.png + assets.json
node demo/tools/render-devpost.mjs     # -> docs/assets/ thumbnail + 5 captioned stills
```
