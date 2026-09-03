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

The **authenticated** `/mcp` success path returns no CORS headers at all.
`src/server.ts` builds them in `corsHeaders()` and applies them to its own
`sendJson` replies — the 401 has them — but once a request is handed to
`StreamableHTTPServerTransport` the SDK writes the response and they are lost.
A browser therefore cannot read the reply, nor `mcp-session-id`.

Fix is one line upstream: set them on `res` before handing off to the
transport. Until then the demo proxies through its own origin. Alexa+ itself
talks server-to-server and will not care, but any browser MCP client will.

### If the badge says `LIVE (shape unknown)`

The server answered but `normalise()` in `adapter.js` could not find `spoken`.
That function is the whole contract surface and it is about thirty lines.

## Files

| | |
|---|---|
| `index.html` `styles.css` `tokens.css` | the page. Tokens are gated by `tools/check-contrast.py` |
| `scenario.js` | the beat script, the protected-value list, and the fixtures |
| `adapter.js` | **the only file that knows where a result comes from** |
| `app.js` | the engine, the invariant guard, the verifier |
| `fonts/` | Inter + JetBrains Mono, vendored so a recording never depends on wifi |

## Checks

```
python demo/tools/check-contrast.py    # palette gate: WCAG, CIE L*, CIEDE2000 + dichromacy
node demo/tools/smoke.mjs              # renders every beat, re-checks the invariant from outside the page
node demo/tools/verify-live.mjs        # drives the demo against a real MCP server, including a leaking one
```

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
