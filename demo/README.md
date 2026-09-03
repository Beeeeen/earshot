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

## Connecting the real server

On load the page probes `localhost:8787/mcp`, `:3000/mcp`, `:8080/mcp` and
completes an MCP handshake against the first that answers. The header badge then
reads **LIVE** in cyan with the server name and tool count, and the ledger shows
a measured round-trip in ms per call.

With nothing listening it falls back to the fixtures in `scenario.js` and the
badge reads **SCRIPTED** in amber. Scripted mode shows a dash for latency rather
than a made-up number.

Two things the server has to do for a browser to reach it:

- CORS with `Access-Control-Expose-Headers: Mcp-Session-Id`. Without that
  header the handshake succeeds and every subsequent call fails, because the
  browser cannot read the session id it is required to echo back.
- Answer the `OPTIONS` preflight that a POST with `Content-Type:
  application/json` plus `MCP-Protocol-Version` always triggers.

The result shape the page wants is documented at the top of `adapter.js`.
`normalise()` is the whole contract surface; if the badge says
`LIVE (shape unknown)`, that function is the only thing to fix.

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

`verify-live.mjs` runs `tools/mock-mcp.mjs`, a test double with a different
patient and a different drug from the fixtures, so a pass means the words on
screen came over the wire. Its last two checks point the demo at a server that
deliberately leaks, and assert the counter moves off 0 and the page goes red.

Point it at the real thing once `src/` is up:

```
node demo/tools/verify-live.mjs --server http://localhost:PORT/mcp
```

## Renderers

```
node demo/tools/render-icons.mjs       # -> addon-package/icons/  (6 sizes x 2 themes)
node demo/tools/render-carousel.mjs    # -> addon-package/carousel-1-600x900.png + assets.json
node demo/tools/render-devpost.mjs     # -> docs/assets/ thumbnail + 5 captioned stills
```
