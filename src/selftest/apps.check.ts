/**
 * MCP Apps conformance — the `ui://` card, driven over the real protocol.
 *
 * Every check here talks to a real server over Streamable HTTP with a real
 * OAuth token and asserts what came back on the wire. Nothing is stubbed, and
 * nothing asserts against a value this file computed itself: the card's bytes
 * are fetched with `resources/read` and then read.
 *
 * Checked against the MCP Apps extension spec `2026-01-26` (Stable) and the
 * official `@modelcontextprotocol/ext-apps@1.7.5` helpers.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THE CARD HOLDS A RECEIPT AND NOT THE PAYLOAD
 * ---------------------------------------------------------------------------
 * `resources/read` is an ordinary JSON-RPC method on the same authenticated
 * `/mcp` session the model drives. "the card is served over the model's own
 * session" proves it by issuing that call from a client whose `clientInfo`
 * says it is not a renderer, and reading the HTML out of the reply. The card
 * body is therefore on the model's channel, and putting a medication name
 * there would be strictly worse than putting it in `structuredContent` — the
 * same exposure, plus the false comfort of a "private" panel.
 *
 * The pair at the end makes it concrete on one delivery: the protected values
 * are fetched from `/inbox` with Sarah's own token and found; the card for the
 * same call is fetched over MCP and the same strings are absent.
 *
 * ---------------------------------------------------------------------------
 * 2. THE ALEXA+ CONTRADICTION, ASSERTED RATHER THAN ARGUED
 * ---------------------------------------------------------------------------
 * Amazon's MCP client-lifecycle page publishes the `initialize` Alexa+ sends:
 * `protocolVersion: "2025-03-26"`, `capabilities: {roots: {listChanged:
 * true}}`. That has no `extensions` key, so `getUiCapability` — the extension's
 * own helper — returns `undefined` for it, and a server following "Servers
 * SHOULD check client capabilities before registering UI-enabled tools" would
 * offer Alexa+ no card at all. Amazon's overview page says Alexa+ supports MCP
 * Apps. Both cannot be true.
 *
 * "an Alexa+-shaped client negotiates no UI extension" replays that request
 * verbatim and asserts the negotiation outcome the server observed. Earshot
 * sends the binding anyway and reports the outcome next to it, so the
 * contradiction is in the bytes rather than in a README.
 *
 * ---------------------------------------------------------------------------
 * 3. THE CARD NEEDS NOTHING THE IFRAME CANNOT DO
 * ---------------------------------------------------------------------------
 * The view runs under `default-src 'none'; script-src 'self' 'unsafe-inline';
 * style-src 'self' 'unsafe-inline'; connect-src 'none'` unless the server
 * widens it by naming domains in `_meta.ui.csp`. There is no `wasm-unsafe-eval`
 * anywhere in the spec or the SDK. "the card needs no capability the iframe
 * lacks" asserts the shipped bytes contain no external subresource, no
 * `fetch`, no credential handling and no WASM — so the empty CSP domain lists
 * are honest.
 */

import { getUiCapability } from '@modelcontextprotocol/ext-apps/server';

import { DEMO_INSTANT, FixedClock } from '../core/clock.js';
import { DEMO_SECRETS, DEMO_SECRET_FRAGMENTS, SARAH } from '../domain/seed.js';
import { CARD_CSP, CARD_MIME, CARD_URI, DELIVERING_TOOLS, UI_EXTENSION } from '../protocol/apps.js';
import { LATENCY_BUDGET_MS } from '../protocol/timing.js';
import { TOOLS } from '../tools/index.js';
import { startServer, type EarshotServerHandle } from '../server.js';
import { UI_CLIENT_CAPABILITIES, connectMcp, linkAccount } from './client.js';
import { assert, check, equal, excludes, group, includes } from './harness.js';

/** The same scan the envelope and the end-to-end suite use. */
function assertClean(text: string, where: string): void {
    for (const s of DEMO_SECRETS) excludes(text, s, `${where}: a protected value was on the wire`);
    for (const f of DEMO_SECRET_FRAGMENTS) excludes(text, f, `${where}: a protected fragment was on the wire`);
    excludes(text, '⟦earshot:', `${where}: a taint marker was on the wire`);
}

interface Reply {
    readonly status: number;
    readonly text: string;
    readonly sessionId: string | null;
}

/**
 * A raw JSON-RPC post with full control of the headers and the initialize
 * params. `client.ts` always sends the latest protocol version; the Alexa+
 * replay has to send 2025-03-26, so it cannot use it.
 */
async function post(
    base: string,
    token: string,
    body: unknown,
    opts: { sessionId?: string | null; protocolVersion?: string } = {}
): Promise<Reply> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`
    };
    if (opts.protocolVersion) headers['mcp-protocol-version'] = opts.protocolVersion;
    if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text(), sessionId: res.headers.get('mcp-session-id') };
}

/** `_meta.ui`, the current binding location. */
function uiMetaOf(meta: unknown): Record<string, unknown> | null {
    if (typeof meta !== 'object' || meta === null) return null;
    const ui = (meta as Record<string, unknown>)['ui'];
    return typeof ui === 'object' && ui !== null ? (ui as Record<string, unknown>) : null;
}

export async function run(): Promise<void> {
    const clock = new FixedClock(DEMO_INSTANT);
    let handle: EarshotServerHandle | null = null;

    try {
        handle = await startServer({ port: 0, clock });
        const base = handle.url;
        const sarah = await linkAccount(base, SARAH);

        // A session that declares the extension, as an MCP Apps host does.
        const app = await connectMcp(base, sarah.accessToken, UI_CLIENT_CAPABILITIES);

        group('MCP Apps — declaration');

        await check('the extension identifier and mime type come from the official package', () => {
            // Retyping either of these is how a card silently stops rendering:
            // the mime type is a media-type PARAMETER, and a server that sends
            // plain `text/html` (or the OpenAI-lineage `text/html+skybridge`,
            // which appears in no version of this spec) fails the host's check.
            equal(UI_EXTENSION, 'io.modelcontextprotocol/ui', 'extension id');
            equal(CARD_MIME, 'text/html;profile=mcp-app', 'resource mime type');
            assert(CARD_URI.startsWith('ui://'), `the view uses the ui:// scheme, got ${CARD_URI}`);
        });

        await check('the server advertises the extension in capabilities.extensions', async () => {
            const r = await post(base, sarah.accessToken, {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: UI_CLIENT_CAPABILITIES,
                    clientInfo: { name: 'earshot-apps-conformance', version: '0.1.0' }
                }
            });
            equal(r.status, 200, 'initialize succeeded');
            includes(r.text, `"extensions":{"${UI_EXTENSION}":{}}`, 'declared on the wire');
        });

        await check('resources/list advertises the card with its mime type and CSP metadata', async () => {
            const list = await app.client.listResources();
            const card = list.resources.find(r => r.uri === CARD_URI);
            assert(
                card !== undefined,
                `${CARD_URI} is registered, got ${JSON.stringify(list.resources.map(r => r.uri))}`
            );
            equal(card.mimeType, CARD_MIME, 'the view declares the MCP Apps mime type');
            const ui = uiMetaOf(card._meta);
            assert(ui !== null, `_meta.ui is present, got ${JSON.stringify(card._meta)}`);
            const csp = ui['csp'] as Record<string, unknown> | undefined;
            assert(csp !== undefined, 'and carries a CSP declaration');
            // Domains, never directives — and all four lists empty, because
            // the card reaches nothing.
            for (const key of Object.keys(CARD_CSP)) {
                assert(Array.isArray(csp[key]), `${key} is a domain array`);
                equal((csp[key] as unknown[]).length, 0, `${key} is empty — the card connects to nothing`);
            }
        });

        await check('every delivering tool binds the card on its definition, and no other tool does', async () => {
            const list = await app.client.listTools();
            equal(list.tools.length, 8, 'all eight tools are listed');
            for (const t of list.tools) {
                const ui = uiMetaOf(t._meta);
                if (DELIVERING_TOOLS.has(t.name)) {
                    assert(ui !== null, `${t.name} should bind a view, got ${JSON.stringify(t._meta)}`);
                    equal(ui['resourceUri'], CARD_URI, `${t.name} binds the card`);
                    // `registerAppTool` mirrors the deprecated flat key for
                    // older hosts. Asserting it is asserting that the official
                    // helper actually ran, rather than hand-written _meta.
                    equal(
                        (t._meta as Record<string, unknown>)['ui/resourceUri'],
                        CARD_URI,
                        `${t.name} also carries the deprecated flat key, as registerAppTool writes it`
                    );
                    equal(
                        JSON.stringify(ui['visibility']),
                        '["model"]',
                        `${t.name} is visible to the model — Earshot declines the app-only affordance`
                    );
                } else {
                    assert(ui === null, `${t.name} delivers nothing privately and must not bind a view`);
                }
            }
        });

        await check('DELIVERING_TOOLS matches which tools actually produce a delivery', async () => {
            // The binding above rests on a hardcoded set, which is a claim, so
            // this calls all eight tools and checks the claim against what they
            // do. It found one on the first run: `log_dose` delivers a receipt
            // for the dose it recorded, and the set said it did not.
            //
            // On its own server, because the sweep calls `open_solo_window`,
            // and once a solo window is open `check_adherence` speaks the
            // detail on purpose and stops delivering — which would make every
            // later check in this file assert against a household in a state
            // no host would have put it in.
            const own = await startServer({ port: 0, clock: new FixedClock(DEMO_INSTANT) });
            try {
                const link = await linkAccount(own.url, SARAH);
                const s = await connectMcp(own.url, link.accessToken, UI_CLIENT_CAPABILITIES);
                const args: Record<string, Record<string, unknown>> = {
                    report_symptom: { description: 'Ankles swollen again since Tuesday', severity: 3 },
                    log_dose: { slot: 'evening' },
                    disclosure_ledger: { since: 'week' }
                };
                const observed = new Set<string>();
                for (const tool of TOOLS) {
                    const out = await s.client.callTool({ name: tool.name, arguments: args[tool.name] ?? {} });
                    const sc = (out.structuredContent ?? {}) as { privateDelivery?: unknown };
                    if (sc.privateDelivery) observed.add(tool.name);
                }
                await s.close();
                equal(
                    [...observed].sort().join(','),
                    [...DELIVERING_TOOLS].sort().join(','),
                    'the declared set and the observed set agree'
                );
            } finally {
                await own.close();
            }
        });

        group('MCP Apps — the binding on the result');

        await check('a tool result that delivered privately carries the view binding', async () => {
            const out = await app.client.callTool({ name: 'check_adherence', arguments: {} });
            const sc = out.structuredContent as { privateDelivery: { deliveryId: string } | null };
            assert(sc.privateDelivery !== null, 'the call produced a delivery');

            // The spec binds on the definition; Amazon's docs say Alexa+ reads
            // it from the response. Both, therefore.
            const ui = uiMetaOf(out._meta);
            assert(ui !== null, `the result carries _meta.ui, got ${JSON.stringify(out._meta)}`);
            equal(ui['resourceUri'], CARD_URI, 'and points at the card');
            equal(
                (out._meta as Record<string, unknown>)['earshot/uiExtensionNegotiated'],
                true,
                'this client declared the extension, and the server says so on the wire'
            );
        });

        await check('a tool result that spoke its whole answer carries no view binding', async () => {
            const out = await app.client.callTool({ name: 'who_can_see', arguments: {} });
            const sc = out.structuredContent as { privateDelivery: unknown };
            equal(sc.privateDelivery, null, 'nothing went out-of-band');
            assert(uiMetaOf(out._meta) === null, 'so there is no card to point at');
        });

        await check('an Alexa+-shaped client negotiates no UI extension', async () => {
            // Amazon's published initialize, verbatim, from
            // developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html
            const alexaCapabilities = { roots: { listChanged: true } };
            equal(
                getUiCapability(alexaCapabilities as Parameters<typeof getUiCapability>[0]),
                undefined,
                "the extension's own getUiCapability returns undefined for it"
            );

            const init = await post(base, sarah.accessToken, {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: alexaCapabilities,
                    clientInfo: { name: 'Alexa+ MCP Client', version: '1.0.0' }
                }
            });
            equal(init.status, 200, 'the handshake succeeds — it is a supported client');
            includes(init.text, '"protocolVersion":"2025-03-26"', 'negotiated down to the documented version');
            assert(init.sessionId !== null, 'and a session was established');
            await post(base, sarah.accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
                sessionId: init.sessionId,
                protocolVersion: '2025-03-26'
            });

            const call = await post(
                base,
                sarah.accessToken,
                { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_adherence', arguments: {} } },
                { sessionId: init.sessionId, protocolVersion: '2025-03-26' }
            );
            equal(call.status, 200, 'the tool call succeeds');
            includes(call.text, '"privateDelivery"', 'the detail still went out-of-band');
            // The finding, on the wire: a client shaped exactly like the one
            // Amazon documents did not negotiate the extension, and this
            // server says so in the same object that carries the binding.
            includes(
                call.text,
                '"earshot/uiExtensionNegotiated":false',
                'and the server reports that this client never declared MCP Apps'
            );
            includes(call.text, `"resourceUri":"${CARD_URI}"`, 'the binding is sent anyway, because Amazon says Alexa+ reads it');
        });

        group('MCP Apps — the card, read over the wire');

        let cardHtml = '';

        await check('resources/read returns the card as a real HTML5 document', async () => {
            const t0 = process.hrtime.bigint();
            const read = await app.client.readResource({ uri: CARD_URI });
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            equal(read.contents.length, 1, 'one content part');
            const part = read.contents[0] as { mimeType?: string; text?: string };
            equal(part.mimeType, CARD_MIME, 'served as an MCP App');
            cardHtml = String(part.text ?? '');
            assert(
                cardHtml.startsWith('<!doctype html'),
                `it is a document, got ${JSON.stringify(cardHtml.slice(0, 40))}`
            );
            includes(cardHtml, 'Not said out loud', 'and it is the card');
            assert(ms < LATENCY_BUDGET_MS, `read in ${ms.toFixed(1)} ms, budget ${LATENCY_BUDGET_MS} ms`);
        });

        await check('the card body contains no protected value', () => {
            assertClean(cardHtml, 'the ui:// card body');
        });

        await check('the card needs no capability the MCP Apps iframe lacks', () => {
            // default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src
            // 'none'; and no wasm-unsafe-eval anywhere in the spec or SDK.
            excludes(cardHtml, 'fetch(', 'no network request');
            excludes(cardHtml, 'XMLHttpRequest', 'no network request');
            excludes(cardHtml, 'WebSocket', 'no socket');
            excludes(cardHtml, 'Authorization', 'no credential handling');
            excludes(cardHtml, 'WebAssembly', 'no WASM');
            excludes(cardHtml, 'wasm', 'no WASM');
            excludes(cardHtml, 'src="http', 'no external script or image');
            excludes(cardHtml, 'href="http', 'no external stylesheet');
            excludes(cardHtml, '@import', 'no imported stylesheet');
            includes(cardHtml, '<style>', 'styling is inline, as the CSP requires');
        });

        await check('the card speaks the postMessage bridge, not a vendor global', () => {
            // There is no window.openai and no window.mcp. The bridge is raw
            // JSON-RPC 2.0 to window.parent, and the card does exactly that.
            excludes(cardHtml, 'window.openai', 'no OpenAI Apps SDK global');
            excludes(cardHtml, 'window.mcp', 'no invented global');
            includes(cardHtml, 'ui/initialize', 'it opens the handshake');
            includes(cardHtml, 'ui/notifications/initialized', 'and completes it');
            includes(cardHtml, 'ui/notifications/tool-result', 'and listens for its data');
            includes(cardHtml, 'postMessage', 'over postMessage');
        });

        group('MCP Apps — why the card holds a receipt and not the payload');

        await check("the card is served over the model's own session, by an ordinary JSON-RPC call", async () => {
            // This is the whole reason the card cannot hold the payload.
            // `resources/read` is not a private side channel to a renderer; it
            // is a method on /mcp, and this drives it as raw JSON-RPC on the
            // same authenticated session that just made a tool call, from a
            // client that is explicitly not a renderer.
            const init = await post(base, sarah.accessToken, {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'a-client-that-is-not-a-renderer', version: '0.1.0' }
                }
            });
            assert(init.sessionId !== null, 'session established');
            await post(base, sarah.accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
                sessionId: init.sessionId
            });
            const call = await post(
                base,
                sarah.accessToken,
                { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_adherence', arguments: {} } },
                { sessionId: init.sessionId }
            );
            const uri = String((JSON.parse(call.text) as { result: { _meta: { ui: { resourceUri: string } } } }).result._meta.ui.resourceUri);
            equal(uri, CARD_URI, 'the result told it where the view is');

            const read = await post(
                base,
                sarah.accessToken,
                { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri } },
                { sessionId: init.sessionId }
            );
            equal(read.status, 200, 'the same session that called the tool can read the card');
            includes(read.text, 'Not said out loud', 'and gets its bytes back');
            // Which is exactly why those bytes have to survive the leak scan.
            assertClean(read.text, 'resources/read over the model session');
        });

        await check('the payload for that same delivery is reachable — but only on /inbox, with her own token', async () => {
            const res = await fetch(`${base}/inbox?peek=1`, {
                headers: { authorization: `Bearer ${sarah.accessToken}` }
            });
            equal(res.status, 200, '/inbox answers her own token');
            const text = await res.text();
            const found = [...DEMO_SECRETS, ...DEMO_SECRET_FRAGMENTS].filter(s => text.includes(s));
            assert(found.length >= 3, `the detail really is on the other channel, found ${found.length} protected strings`);
            // The same strings, in the card the model can read: none.
            assertClean(cardHtml, 'the card, for the same delivery');
        });

        await check('and /inbox refuses the same request without her token', async () => {
            const res = await fetch(`${base}/inbox?peek=1`);
            equal(res.status, 401, 'no token, no payload');
            assertClean(await res.text(), 'the /inbox 401 body');
        });

        await app.close();
    } finally {
        if (handle) await handle.close();
    }
}
