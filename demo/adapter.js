/* ===========================================================================
   ADAPTER  —  the only file in demo/ that knows where a tool result comes from.
   ===========================================================================

   Everything else in the demo renders whatever this hands back and cannot tell
   the two sources apart. That is deliberate: the renderer has no branch that
   could flatter one path over the other.

   ---------------------------------------------------------------------------
   THE TWO CHANNELS, AS THE SERVER ACTUALLY BUILDS THEM
   ---------------------------------------------------------------------------
   This matters because it changes what this file has to do. Per
   src/protocol/envelope.ts and src/protocol/private-channel.ts, the private
   payload is NOT in the MCP response. It cannot be: the model reads tool
   results, so anything put there is one "just read it to me" away from being
   narrated. What comes back over MCP is a receipt.

     POST /mcp    tools/call -> structuredContent {
                    spoken, channel, privateDelivery | null, notifiedOthers,
                    sealedPointers[], underSoloWindow, serverLatencyMs,
                    data | null, note | null }

     GET  /inbox  ?peek=1, Bearer <the ASKER's own token> -> { deliveries: [
                    { id, tool, title, fields: [{label, value}],
                      sealed: [{label, appPath}], footnote } ] }

   So the left pane is fed from /mcp and the right pane is fed from /inbox, with
   two different credentials, which is exactly the architecture the demo claims.
   The right pane is not a rendering of something the model was told.

   A useful consequence: the demo never has to be told what counts as a
   protected value. Every field that arrives on /inbox is one, by construction.
   Live mode derives the verifier's list from the wire.

   ---------------------------------------------------------------------------
   SOURCES
   ---------------------------------------------------------------------------
     LIVE      Real server. Links a real OAuth 2.1 + PKCE account (via the
               /link helper in tools/serve.mjs, because a browser cannot read
               the Location header on the authorize redirect), then handshakes
               MCP over Streamable HTTP and measures every round trip.

     SCRIPTED  Fixtures from scenario.js, used only when nothing answers. The
               header badge says so in amber and the latency column shows a dash
               rather than an invented number.

   If the badge says LIVE (shape unknown), the server answered but normalise()
   could not find `spoken`. That function is the whole contract surface.
=========================================================================== */

window.EarshotAdapter = (function () {
  'use strict';

  const PROTOCOL = '2025-11-25';
  const params = new URLSearchParams(location.search);

  /* 127.0.0.1 first, deliberately. src/server.ts binds 127.0.0.1, and on
     Windows `localhost` resolves to ::1 before 127.0.0.1, so the friendlier
     spelling is the one that fails. */
  const CANDIDATES = params.get('server')
    ? [params.get('server')]
    : [
        'http://127.0.0.1:8787/mcp',
        'http://localhost:8787/mcp',
        'http://127.0.0.1:3000/mcp',
        'http://localhost:8080/mcp',
      ];

  const FORCE_SCRIPTED = params.get('mode') === 'scripted';
  /* Everything goes through the same-origin proxy in tools/serve.mjs, because
     the server's authenticated /mcp replies carry no CORS headers today (see
     the note on /x/* there). `?direct=1` talks to the server straight, which
     is what you want against a fixed server or a real HTTPS deployment. */
  const DIRECT = params.get('direct') === '1';
  const PERSON = params.get('person') || 'sarah';
  const PROBE_MS = Number(params.get('probems') || 2500);

  const state = {
    mode: 'probing',      // 'probing' | 'live' | 'scripted'
    url: null,            // the /mcp endpoint
    base: null,           // origin the /inbox and /oauth routes hang off
    token: params.get('token') || null,
    person: PERSON,
    tools: [],
    sessionId: null,
    server: null,
    error: null,
    shapeWarning: false,
    seenDeliveries: [],   // ids already rendered, so /inbox is not re-rendered
    secrets: null,        // the server's own must-never-be-spoken list
    id: 0,
  };

  /* --------------------------------------------------------- transport ---- */

  function headers(extra) {
    const h = Object.assign({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    }, extra || {});
    if (state.sessionId) h['Mcp-Session-Id'] = state.sessionId;
    if (state.token) h.Authorization = 'Bearer ' + state.token;
    return h;
  }

  /* A Streamable HTTP response is either a JSON body or an SSE stream carrying
     one message. src/server.ts defaults to JSON and flips to SSE with
     EARSHOT_SSE=1, so both have to work. */
  async function readBody(res) {
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/event-stream')) return text ? JSON.parse(text) : null;
    const data = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    return data ? JSON.parse(data) : null;
  }

  async function rpc(url, method, params_, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 10000);
    const body = { jsonrpc: '2.0', method: method, params: params_ || {} };
    const isNotification = method.startsWith('notifications/');
    if (!isNotification) body.id = ++state.id;

    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) state.sessionId = sid;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail.slice(0, 140) : ''));
      }
      const msg = isNotification ? null : await readBody(res);
      if (msg && msg.error) throw new Error(msg.error.message || 'JSON-RPC error');
      return { result: msg ? msg.result : null, ms: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------- link ----- */

  /* The phone linking its account. Done by tools/serve.mjs on this page's own
     origin -- see the comment on /link there for why it cannot be done here. */
  async function linkAccount(base) {
    const res = await fetch('/link?base=' + encodeURIComponent(base) +
                            '&person=' + encodeURIComponent(state.person));
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error('link failed: ' + (j.error || res.status));
    }
    const j = await res.json();
    state.token = j.accessToken;
    return j;
  }

  /* ------------------------------------------------------------- probe ---- */

  async function handshake(url) {
    state.sessionId = null;
    const init = await rpc(url, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'earshot-demo', version: '1.0.0' },
    }, PROBE_MS);
    await rpc(url, 'notifications/initialized', {}, PROBE_MS).catch(() => {});
    const list = await rpc(url, 'tools/list', {}, PROBE_MS);
    return {
      tools: (list.result && list.result.tools) || [],
      server: (init.result && init.result.serverInfo) || null,
    };
  }

  /* Where this page actually POSTs. Same origin unless ?direct=1. */
  function mcpUrl(base) {
    return DIRECT ? base + '/mcp' : '/x/mcp?base=' + encodeURIComponent(base);
  }
  function inboxUrl(base) {
    return DIRECT ? base + '/inbox?peek=1'
                  : '/x/inbox?peek=1&base=' + encodeURIComponent(base);
  }

  async function probe() {
    if (FORCE_SCRIPTED) {
      state.mode = 'scripted';
      state.error = 'forced with ?mode=scripted';
      return state;
    }
    for (const candidate of CANDIDATES) {
      const base = candidate.replace(/\/mcp\/?$/, '');
      const url = mcpUrl(base);
      try {
        // A server that wants no OAuth is still a server. Link if we can, carry
        // on without a token if we cannot, and let the handshake be the thing
        // that decides whether this endpoint is usable.
        if (!state.token) {
          await linkAccount(base).catch(function (e) {
            console.warn('[earshot] no OAuth link (' + e.message +
                         ') - trying the handshake unauthenticated');
          });
        }
        const info = await handshake(url);
        state.mode = 'live';
        state.url = url;
        state.base = base;
        state.tools = info.tools;
        state.server = info.server;
        state.secrets = await fetchSecrets();
        state.error = null;
        return state;
      } catch (err) {
        state.error = (err && err.message ? err.message : String(err)) + '  [' + base + ']';
        state.token = params.get('token') || null;
      }
    }
    state.mode = 'scripted';
    return state;
  }

  /* The strings the server itself says must never be spoken. See /secrets in
     tools/serve.mjs for where this comes from and why it is not derived from
     the inbox. */
  async function fetchSecrets() {
    try {
      const res = await fetch('/secrets');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const chips = j.chips || [];
      return (j.scan || []).map((v) => ({
        label: 'Protected', value: v, alts: [], chip: chips.indexOf(v) >= 0,
      }));
    } catch (err) {
      console.warn('[earshot] no /secrets — the verifier has nothing ' +
                   'authoritative to check against: ' + err.message);
      return null;
    }
  }

  /* ------------------------------------------------------------ /inbox ---- */

  /* The second channel. Same host, different endpoint, the asker's own token.
     Returns only deliveries this page has not already put on screen. */
  async function fetchNewDeliveries() {
    const res = await fetch(inboxUrl(state.base), {
      headers: { Authorization: 'Bearer ' + state.token },
    });
    if (!res.ok) throw new Error('inbox HTTP ' + res.status);
    const j = await res.json();
    const all = (j && j.deliveries) || [];
    const fresh = all.filter((d) => state.seenDeliveries.indexOf(d.id) < 0);
    for (const d of fresh) state.seenDeliveries.push(d.id);
    return fresh;
  }

  function cardFromDelivery(d) {
    return {
      title: d.title || 'Private detail',
      source: (d.tool || '') + ' · /inbox',
      rows: (d.fields || []).map((f, i) => ({
        k: f.label,
        v: String(f.value),
        hero: i === 0,
      })).concat(d.footnote ? [{ k: 'Note', v: String(d.footnote) }] : []),
    };
  }

  function cardFromSealed(pointers) {
    return {
      title: 'Sealed — app only',
      source: 'sealedPointers · no value on any channel',
      tier: 'sealed',
      rows: pointers.map((p) => ({ k: p.label, v: '•••• •••••••', masked: true })),
      action: 'Open in Earshot',
    };
  }

  /* --------------------------------------------------------- normalise ---- */

  const CHANNEL_STATES = {
    'spoken-only': ['spoken'],
    'spoken+private-delivery': ['spoken', 'shifted'],
    'spoken+app-pointer': ['spoken', 'sealed'],
    'spoken-under-solo-window': ['solo'],
  };

  function trim(s, n) {
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  /* NOT derived from what came back on /inbox. That reads as the rigorous
     choice and is the opposite: the inbox also carries the reporter's name and
     a severity score, so it reports "Sarah" as leaked the second Sarah opens
     her mouth. The list comes from the server's own DEMO_SECRETS instead. */

  /* The whole contract surface between this demo and the MCP server. */
  function normalise(result, ms, deliveries) {
    const sc = (result && result.structuredContent) || null;
    let o = sc;

    if (!o || typeof o.spoken !== 'string') {
      // Last resort: a plain-text tool. The left pane still works, the right
      // pane stays empty, and the badge is marked so nobody films this by
      // accident thinking the card is broken.
      state.shapeWarning = true;
      const text = (result && Array.isArray(result.content)
        ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ')
        : '') || '';
      console.warn('[earshot] tool result had no structuredContent.spoken — ' +
                   'see normalise() in demo/adapter.js', result);
      o = { spoken: text, channel: 'spoken-only', sealedPointers: [] };
    }

    const fresh = deliveries || [];
    const sealed = (o.sealedPointers && o.sealedPointers.length) ? o.sealedPointers : null;
    const tier = o.channel === 'spoken+app-pointer' ? 'sealed'
               : o.privateDelivery ? 'private' : 'spoken';

    const out = {
      spoken: o.spoken,
      private: fresh.length ? cardFromDelivery(fresh[fresh.length - 1])
             : sealed ? cardFromSealed(sealed) : null,
      tier: tier,
      refused: null,
      protected: state.secrets,
      note: o.note || null,
      ms: typeof ms === 'number' ? ms : null,
      serverMs: typeof o.serverLatencyMs === 'number' ? o.serverLatencyMs : null,
      source: 'live',
      raw: result,
    };

    const states = CHANNEL_STATES[o.channel] || ['spoken'];
    out.disclosures = states.map((st) => {
      if (st === 'spoken') {
        return { state: 'spoken', what: 'Spoken answer', detail: trim(o.spoken, 46) };
      }
      if (st === 'shifted') {
        const r = o.privateDelivery;
        return { state: 'shifted',
                 what: r.fieldCount + ' field' + (r.fieldCount === 1 ? '' : 's'),
                 detail: '→ ' + r.recipient + '’s ' + r.channel + ', over /inbox' };
      }
      if (st === 'sealed') {
        return { state: 'sealed', what: sealed.map((p) => p.label).join(', '),
                 detail: 'pointer only, no value on any channel' };
      }
      return { state: 'solo', what: 'Solo window', detail: 'private detail spoken on purpose, logged' };
    });

    for (const n of o.notifiedOthers || []) {
      out.disclosures.push({ state: 'shifted', what: n.fieldCount + ' fields to ' + n.recipient,
                             detail: 'holds a grant, notified out-of-band' });
    }
    return out;
  }

  /* -------------------------------------------------------------- call ---- */

  async function call(beat) {
    const fixtures = window.EARSHOT_SCENARIO.FIXTURES;

    if (state.mode === 'live' && beat.tool) {
      try {
        const r = await rpc(state.url, 'tools/call',
          { name: beat.tool, arguments: beat.args || {} });
        let fresh = [];
        const sc = r.result && r.result.structuredContent;
        if (sc && sc.privateDelivery) {
          fresh = await fetchNewDeliveries().catch((e) => {
            console.warn('[earshot] /inbox unreachable: ' + e.message);
            return [];
          });
        }
        return normalise(r.result, r.ms, fresh);
      } catch (err) {
        // A live server that fails mid-demo must not silently become a fixture.
        state.error = err && err.message ? err.message : String(err);
        state.mode = 'scripted';
        window.dispatchEvent(new CustomEvent('earshot:degraded', { detail: state.error }));
      }
    }

    const f = fixtures[beat.id];
    if (!f) return null;
    return Object.assign({}, f, { ms: null, source: 'scripted' });
  }

  return {
    state: state,
    probe: probe,
    call: call,
    normalise: normalise,
    candidates: CANDIDATES,
  };
})();
