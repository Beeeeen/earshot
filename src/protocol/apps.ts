/**
 * Earshot — the MCP Apps (`ui://`) card.
 *
 * Built against the MCP Apps extension, spec `2026-01-26` (Stable), using the
 * official `@modelcontextprotocol/ext-apps` helpers rather than hand-rolled
 * `_meta` — `registerAppTool`, `registerAppResource`, `getUiCapability`,
 * `RESOURCE_MIME_TYPE`, `EXTENSION_ID`. The base `@modelcontextprotocol/sdk`
 * has no MCP Apps support at 1.30.0; `ext-apps` is where it lives.
 *
 * ===========================================================================
 * READ THIS BEFORE CHANGING WHAT THE CARD RENDERS
 * ===========================================================================
 *
 * The card renders a RECEIPT — "four details went to your phone" — and never
 * the details. That is not a limitation we ran into; it is the only thing the
 * extension can honestly carry. Four facts, each checked by an executing
 * assertion in src/selftest/apps.check.ts or demo/tools/verify-card.mjs:
 *
 *  1. THE CARD BODY IS ON THE MODEL'S CHANNEL. A `ui://` resource is served by
 *     `resources/read`, an ordinary JSON-RPC method on the same authenticated
 *     `/mcp` session the model drives. We drive exactly that call from a
 *     non-renderer client and get the bytes back. So HTML is not a private
 *     place to put anything.
 *
 *  2. THE IFRAME HOLDS NO CREDENTIAL. The spec's default CSP is
 *     `connect-src 'none'`, widened only to origins the SERVER pre-declared in
 *     `_meta.ui.csp.connectDomains`, and the frame is an opaque origin
 *     (`sandbox="allow-scripts"`, no `allow-same-origin`). `McpUiHostContext`
 *     carries theme, styles, displayMode, dimensions, locale, timeZone,
 *     userAgent, platform, deviceCapabilities, safeAreaInsets and toolInfo —
 *     and no auth field of any kind. So `fetch('/inbox')` from the card is a
 *     401 even where CSP would allow the connection. Earshot's whole design is
 *     that `/inbox` needs the ASKER's token; the card cannot have one.
 *
 *  3. THE DESIGNED ALTERNATIVE ROUTES THROUGH THE HOST, WHICH IS THE THING WE
 *     REFUSE TO TRUST. The extension's answer to "my view needs authenticated
 *     data" is `tools/call` proxied by the host, with `_meta.ui.visibility:
 *     ["app"]` to hide the tool from the model. That is a host-enforced
 *     filter over a `tools/list` response, not a property of the data: the
 *     payload still leaves this process over `/mcp`, and whether the model
 *     ever sees it is the host's promise. "The host promises not to show the
 *     model" is precisely the after-the-fact filtering this project exists to
 *     reject, so we do not build on it. (Stated from the spec text and the
 *     SDK's dispatch, not from an experiment — we have no host to test the
 *     claim against.)
 *
 *  4. SO THE PRIVATE CHANNEL STAYS WHERE IT IS. `GET /inbox`, authenticated
 *     with the asker's own OAuth token, on a connection the model is not party
 *     to. The card's job is to make that boundary visible at the moment it
 *     applies.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CARD IS ALLOWED TO DISPLAY
 * ---------------------------------------------------------------------------
 * A fixed whitelist of five fields from the tool result the host hands it —
 * `privateDelivery.{deliveryId,fieldCount,recipient}`, `channel`, and
 * `sealedPointers.length`. Every one of those is already in the MCP response
 * for the same call, so displaying them adds no exposure. The card reads those
 * names and ignores everything else in the payload, which means a future tool
 * result that carried more could not be displayed by accident. That is not a
 * comment, it is `RENDERED_FIELDS` below, and demo/tools/verify-card.mjs feeds
 * the card a tool result with a medication name in it and asserts the rendered
 * DOM does not contain it.
 */

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

import { assertNoTaint } from '../core/protected.js';

/* -------------------------------------------------------------------------
 * Protocol identifiers, all from the official package rather than retyped.
 * ---------------------------------------------------------------------------
 */

/** `io.modelcontextprotocol/ui`. The key inside `capabilities.extensions`. */
export const UI_EXTENSION = EXTENSION_ID;

/** `text/html;profile=mcp-app`. A media-type PARAMETER, not a `+suffix`. */
export const CARD_MIME = RESOURCE_MIME_TYPE;

/** The MCP Apps extension's own protocol version, sent in `ui/initialize`. */
export const UI_PROTOCOL_VERSION = '2026-01-26';

/**
 * One static UI resource, not one per delivery.
 *
 * The extension's model is a template resource plus per-call data: the host
 * reads this once and then hands each tool result to the running view over
 * `ui/notifications/tool-result`. An earlier version of this file registered
 * `ui://earshot/card/{deliveryId}` and baked the receipt into the HTML
 * server-side, which put a URI per delivery into the model's context for no
 * gain and is not what `registerAppResource` accepts.
 */
export const CARD_URI = 'ui://earshot/card';

/**
 * `_meta.ui.csp` for the card. Every list is empty, and that is the
 * substantive statement rather than an oversight: the card issues no network
 * request, loads no external subresource, and frames nothing. The spec's
 * default when `csp` is omitted is already `connect-src 'none'`; declaring the
 * empty lists says the emptiness is intended.
 *
 * The four field names are the whole vocabulary the extension allows here —
 * domains, never CSP directives. A host "MAY further restrict but MUST NOT
 * allow undeclared domains".
 */
export const CARD_CSP = {
    connectDomains: [] as string[],
    resourceDomains: [] as string[],
    frameDomains: [] as string[],
    baseUriDomains: [] as string[]
} as const;

/**
 * The tools that produce an out-of-band delivery, and therefore have a card to
 * render. Hardcoding this is a claim, so `apps.check.ts` calls all eight tools
 * and asserts the observed set matches — a list that drifts fails the build
 * rather than binding a card to a tool that never renders one.
 */
export const DELIVERING_TOOLS: ReadonlySet<string> = new Set([
    'check_adherence',
    'log_dose',
    'report_symptom',
    'care_summary',
    'disclosure_ledger'
]);

/** The five names the card will display. Everything else in a result is ignored. */
export const RENDERED_FIELDS: readonly string[] = [
    'privateDelivery.deliveryId',
    'privateDelivery.fieldCount',
    'privateDelivery.recipient',
    'channel',
    'sealedPointers.length'
];

/**
 * What a client that supports MCP Apps declares in `initialize`. `mimeTypes`
 * is REQUIRED by the spec, and a server is expected to check that the client's
 * list actually contains the card's type before offering it a card.
 */
export const UI_CLIENT_CAPABILITY = { mimeTypes: [CARD_MIME] } as const;

/**
 * The server's half.
 *
 * Be precise about what this is: the MCP Apps spec (2026-01-26) defines only
 * the CLIENT declaration and tells servers to CHECK it — "Servers SHOULD check
 * client capabilities before registering UI-enabled tools" — so there is no
 * normative server-side declaration in the apps spec at all. The generic
 * extension framework does have both sides advertise, and under the current
 * core spec (2026-07-28) servers advertise theirs in the `server/discover`
 * response. Declaring it here is forward-compatible and costs nothing; it is
 * not us claiming the apps spec requires it.
 */
export const UI_SERVER_CAPABILITY = { [UI_EXTENSION]: {} } as const;

/* -------------------------------------------------------------------------
 * The card.
 *
 * One static HTML5 document. Inline CSS and one inline script, which is
 * exactly what the CSP allows: `script-src 'self' 'unsafe-inline'`,
 * `style-src 'self' 'unsafe-inline'`, no `wasm-unsafe-eval` anywhere in the
 * spec or the SDK. No external subresource, so `resourceDomains` stays empty.
 *
 * The script is the View half of the postMessage bridge. There is no
 * `window.openai` and no `window.mcp` — the bridge is raw JSON-RPC 2.0 to
 * `window.parent`, and the spec says so: "you don't need an SDK to 'talk MCP'
 * with the host". This is about forty lines because that is all it takes.
 * ---------------------------------------------------------------------------
 */

const CARD_CSS = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:16px 18px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
background:var(--color-background-primary,#101519);color:var(--color-text-primary,#e8edf2)}
.h{display:flex;align-items:baseline;gap:8px;margin:0 0 2px}
.h b{font-size:14px;font-weight:600}
.h i{font-style:normal;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#FFB627}
.lede{margin:9px 0 12px;font-size:15px}
.lede em{font-style:normal;color:#4FE0D2;font-weight:600}
ul{margin:0 0 12px;padding:0;list-style:none;display:grid;gap:5px}
li{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:6px;border:1px solid #263039}
.bar{flex:1;height:8px;border-radius:4px;
background:repeating-linear-gradient(90deg,#2b3742 0 10px,#1b232a 10px 18px)}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:#6f7d8a}
li.rest{border-style:dashed;justify-content:center}
.why{margin:0;padding:11px 0 0;border-top:1px solid #263039;font-size:11.5px;line-height:1.5;color:#9aa7b4}
.why b{color:#c9d4de;font-weight:600}
.meta{margin:8px 0 0;font:10.5px/1.4 ui-monospace,"JetBrains Mono",Menlo,monospace;color:#5d6b78}`;

/**
 * The View script.
 *
 * Written with string concatenation rather than template literals so it can
 * live inside a TypeScript template literal without escaping, and so nothing
 * in it can be mistaken for server-side interpolation. There is no
 * interpolation: this text is a constant, and the only data it ever renders
 * arrives at runtime from the host.
 */
const CARD_JS = `(function(){
  "use strict";
  var host = window.parent;
  var seq = 0;
  var pending = {};

  function send(msg){ if (host && host !== window) host.postMessage(msg, "*"); }
  function request(method, params){
    var id = ++seq;
    return new Promise(function(resolve, reject){
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params){ send({ jsonrpc: "2.0", method: method, params: params }); }

  function text(id, value){ var el = document.getElementById(id); if (el) el.textContent = value; }

  /* The whitelist. Five named reads, no iteration over the payload, so a
     result that carried more than the receipt could not be displayed. */
  function render(result){
    var sc = (result && result.structuredContent) || {};
    var pd = sc.privateDelivery || null;
    var sealed = Array.isArray(sc.sealedPointers) ? sc.sealedPointers.length : 0;
    var n = pd && typeof pd.fieldCount === "number" ? pd.fieldCount : 0;
    var who = pd && typeof pd.recipient === "string" ? pd.recipient + "'s" : "the asker's";
    var id = pd && typeof pd.deliveryId === "string" ? pd.deliveryId : "";
    var channel = typeof sc.channel === "string" ? sc.channel : "";

    document.body.setAttribute("data-earshot-rendered", "1");
    text("count", String(n));
    text("plural", n === 1 ? " detail" : " details");
    text("who", who);
    text("meta", [channel, id].filter(Boolean).join(" \\u00b7 "));
    text("sealed", sealed > 0
      ? sealed + " further fact" + (sealed === 1 ? "" : "s") + " went on no channel at all."
      : "");

    var ul = document.getElementById("rows");
    if (ul){
      ul.textContent = "";
      var shown = Math.min(n, 6);
      for (var i = 0; i < shown; i++){
        var li = document.createElement("li");
        var bar = document.createElement("span"); bar.className = "bar";
        var tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "withheld";
        li.appendChild(bar); li.appendChild(tag); ul.appendChild(li);
      }
      if (n > shown){
        var rest = document.createElement("li");
        rest.className = "rest";
        var t = document.createElement("span"); t.className = "tag";
        t.textContent = "and " + (n - shown) + " more, also withheld";
        rest.appendChild(t); ul.appendChild(rest);
      }
    }
    notify("ui/notifications/size-changed", {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    });
  }

  window.addEventListener("message", function(e){
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending[m.id]){
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params || {});
  });

  request("ui/initialize", {
    protocolVersion: "${UI_PROTOCOL_VERSION}",
    appInfo: { name: "earshot-private-card", title: "Earshot — not said out loud", version: "0.1.0" },
    appCapabilities: {}
  }).then(function(result){
    notify("ui/notifications/initialized", {});
    var ctx = result && result.hostContext;
    if (ctx && ctx.toolInfo && ctx.toolInfo.result) render(ctx.toolInfo.result);
  }).catch(function(){
    /* No host answered. The card is being read outside a renderer — by the
       model over resources/read, most likely. It stays exactly as it is:
       a page with nothing in it, which is the honest state. */
  });
})();`;

/**
 * The card document. A constant: this function takes no arguments and can
 * therefore not be persuaded to interpolate anything.
 */
export function renderCard(): string {
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Earshot — not said out loud</title>
<style>${CARD_CSS}</style></head>
<body>
<div class="h"><b>Not said out loud</b><i>private channel</i></div>
<p class="lede"><em id="count">0</em><span id="plural"> details</span> went to
<span id="who">the asker's</span> own device. None were spoken, and none are on this card.</p>
<ul id="rows"></ul>
<p class="meta" id="sealed"></p>
<p class="why"><b>This panel is blank on purpose.</b> It is served to the
assistant over the assistant's own connection, so anything printed here is
something the assistant can read — which would put back exactly what was moved.
The detail is on your device, behind your own sign-in. The assistant has no
credential for it, and neither does this card.</p>
<p class="meta" id="meta"></p>
<script>${CARD_JS}</script>
</body></html>`;
    // The card's bytes leave over `/mcp` like anything else, so they run the
    // same tripwire the envelope runs.
    assertNoTaint(html, 'apps.renderCard');
    return html;
}

/** The rendered card, computed once. */
export const CARD_HTML = renderCard();
