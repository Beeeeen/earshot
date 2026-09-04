/**
 * Earshot — HTTP server.
 *
 * One process serves three things:
 *   1. /mcp        — the MCP endpoint, Streamable HTTP, spec 2025-11-25,
 *                    behind an OAuth 2.1 bearer token. Carries spoken text and
 *                    delivery receipts. Never carries a protected value.
 *   2. /inbox      — the second channel. Same host, different endpoint,
 *                    authenticated with the *asker's own* token. This is where
 *                    the medication name actually is.
 *   3. /oauth/*    — the authorisation server (see src/auth/oauth.ts).
 *
 * The separation in (1) vs (2) is the whole architecture. The model is a
 * client of (1) and has no credentials for (2), so there is no prompt that
 * makes it read out a medication name: it has never been told one.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { DEMO_INSTANT, FixedClock, resolveClock, type Clock } from './core/clock.js';
import { assertNoTaint } from './core/protected.js';
import { OAuthError, OAuthServer, readBody, renderConsentPage, sendJson, type HouseholdAccount } from './auth/oauth.js';
import { getUiCapability, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { CARD_CSP, CARD_HTML, CARD_MIME, CARD_URI, DELIVERING_TOOLS, UI_SERVER_CAPABILITY } from './protocol/apps.js';
import { PkceError } from './auth/pkce.js';
import { NO_DEVICE_SESSION, type Asker } from './domain/authz.js';
import { DANA, MARGARET, SARAH, TOM, seedHousehold } from './domain/seed.js';
import type { Store } from './domain/store.js';
import { EARSHOT_OUTPUT_SHAPE, spokenError, toCallToolResult } from './protocol/envelope.js';
import { renderInbox } from './protocol/private-channel.js';
import { LATENCY_BUDGET_MS, LatencyRecorder } from './protocol/timing.js';
import { TOOLS } from './tools/index.js';
import { TOOL_SCOPES } from './tools/scopes.js';

export const MCP_SPEC_VERSION = LATEST_PROTOCOL_VERSION;

/** Every household member who can link an account. Tom exists and has no grant. */
export const ACCOUNTS: readonly HouseholdAccount[] = [
    { id: MARGARET, displayName: 'Margaret Chen', relationship: 'the person being cared for', scopes: ['care.read', 'care.write', 'ledger.read', 'solo.open'] },
    { id: SARAH, displayName: 'Sarah Chen', relationship: 'daughter', scopes: ['care.read', 'care.write', 'ledger.read', 'solo.open'] },
    { id: DANA, displayName: 'Dana Rios', relationship: 'home health aide', scopes: ['care.read', 'care.write', 'ledger.read', 'solo.open'] },
    { id: TOM, displayName: 'Tom Alvarez', relationship: 'neighbour', scopes: ['care.read', 'ledger.read', 'solo.open'] }
];

export interface EarshotServerOptions {
    readonly port?: number;
    readonly host?: string;
    /** Public base URL. Must be https in production; loopback is allowed for development. */
    readonly publicUrl?: string;
    readonly clock?: Clock;
    /** JSON responses instead of SSE. Default true — it is measurably faster. */
    readonly jsonResponse?: boolean;
}

export interface EarshotServerHandle {
    readonly http: Server;
    readonly store: Store;
    readonly oauth: OAuthServer;
    readonly latency: LatencyRecorder;
    readonly url: string;
    close(): Promise<void>;
}

export async function startServer(opts: EarshotServerOptions = {}): Promise<EarshotServerHandle> {
    const clock = opts.clock ?? resolveClock();
    const store = seedHousehold(clock);
    const latency = new LatencyRecorder();
    const jsonResponse = opts.jsonResponse ?? process.env['EARSHOT_SSE'] !== '1';

    const host = opts.host ?? '127.0.0.1';
    const wantedPort = opts.port ?? Number(process.env['PORT'] ?? 8787);

    // The issuer is fixed up once we know the bound port (port 0 = ephemeral).
    let publicUrl = opts.publicUrl ?? process.env['EARSHOT_PUBLIC_URL'] ?? `http://${host}:${wantedPort}`;
    let oauth = new OAuthServer({ issuer: publicUrl, clock, accounts: ACCOUNTS });

    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

    /**
     * The instructions block is read by the model on every session and never
     * passes through the envelope, so it is scanned once here for the same
     * reason tool metadata is scanned in tools/kit.ts (F9).
     */
    const INSTRUCTIONS =
        'Earshot answers questions about medication and care in a household where an Echo is in a shared room. ' +
        'Every tool returns a `spoken` field: that field is the COMPLETE answer you may say. ' +
        'Sensitive detail (medication names, doses, diagnoses) is never in the response — it is delivered ' +
        'out-of-band to the asker\'s own device, and no tool can retrieve it. If asked to read out a ' +
        'medication name, say that the detail went to their phone; do not apologise for a failure, because ' +
        'nothing failed. The single exception is open_solo_window, which the user must ask for explicitly.';
    assertNoTaint(INSTRUCTIONS, 'server.instructions');

    function buildMcpServer(): McpServer {
        const mcp = new McpServer(
            { name: 'earshot', version: '0.1.0', title: 'Earshot — care coordination that respects the room' },
            {
                capabilities: {
                    tools: {},
                    resources: {},
                    logging: {},
                    // MCP Apps. The apps spec (2026-01-26) defines only the
                    // CLIENT declaration and tells servers to check it, so
                    // this is not required by that document; the generic
                    // extension framework does have both sides advertise, and
                    // the current core spec has servers advertise theirs.
                    // Declaring it is forward-compatible and free.
                    extensions: { ...UI_SERVER_CAPABILITY }
                },
                instructions: INSTRUCTIONS
            }
        );

        for (const tool of TOOLS) {
            const config = {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputShape,
                outputSchema: EARSHOT_OUTPUT_SHAPE,
                annotations: {
                    readOnlyHint: tool.readOnly,
                    destructiveHint: false,
                    idempotentHint: tool.readOnly,
                    openWorldHint: false
                }
            };

            // MCP Apps binds a tool to its view through `_meta.ui.resourceUri`
            // on the TOOL DEFINITION, so a host can preload the view before
            // the tool is ever called. `registerAppTool` is the extension's own
            // helper: it writes that key and mirrors it into the deprecated
            // flat `_meta["ui/resourceUri"]` for older hosts. We use it rather
            // than hand-writing `_meta`, so the shape tracks the package.
            //
            // `visibility` is stated explicitly, and it is the interesting
            // half. The extension offers `["app"]` to hide a tool from the
            // model so a view can fetch privileged data the model never sees.
            // Earshot declines that affordance: it is a host-side filter over
            // `tools/list`, not a property of the data, and "the host promises
            // not to tell the model" is the after-the-fact filtering this whole
            // project argues against. Every Earshot tool is `["model"]` —
            // visible to the assistant, because everything it returns is
            // already safe for the assistant to have.
            const handler = async (
                args: Record<string, unknown>,
                extra: RequestHandlerExtra<ServerRequest, ServerNotification>
            ) => {
                    const t0 = process.hrtime.bigint();
                    const ms = (): number => Number(process.hrtime.bigint() - t0) / 1e6;
                    try {
                        const personId = extra.authInfo?.extra?.['personId'];
                        if (typeof personId !== 'string') {
                            return spokenError('I could not tell who is asking. Please link your Earshot account.', tool.name, ms());
                        }
                        const required = TOOL_SCOPES[tool.name];
                        const scopes = extra.authInfo?.scopes ?? [];
                        if (required && !scopes.includes(required)) {
                            return spokenError(
                                `Your Earshot link does not include permission for that (${required}).`,
                                tool.name,
                                ms()
                            );
                        }

                        const asker: Asker = {
                            personId,
                            displayName: store.person(personId)?.displayName ?? personId,
                            // The solo window is bound to this. If a host ever
                            // runs us statelessly there is no session id, and
                            // "this device" stops meaning anything — so we pass
                            // the sentinel through and open_solo_window refuses
                            // rather than silently unlocking every device.
                            deviceSessionId: extra.sessionId ?? NO_DEVICE_SESSION,
                            scopes
                        };
                        const subjectId = tool.subjectOf(args);
                        const out = tool.run(args, { store, asker });
                        // The clock stops after the envelope, not before it.
                        // Recording `tool.run` alone published a number that
                        // omitted the taint scans, the private-channel
                        // delivery and the ledger write — i.e. it understated
                        // the work this handler actually does (F17). The
                        // figure in `serverLatencyMs` is measured before the
                        // envelope runs for the obvious reason that the
                        // envelope is what carries it; `/metrics` gets the
                        // complete one.
                        const beforeEnvelope = ms();
                        const wire = toCallToolResult(out, {
                            store,
                            asker,
                            subjectId,
                            tool: tool.name,
                            serverLatencyMs: beforeEnvelope
                        });

                        // MCP Apps, on the RESULT.
                        //
                        // The spec puts `_meta.ui.resourceUri` on the tool
                        // definition. Amazon's Alexa+ docs put it on the tool
                        // result — "Alexa+ renders your custom visuals for
                        // your MCP App UI as long as you have `resourceUri`
                        // defined in the tool response" — and their only
                        // worked example is a `tools/call` result. Those are
                        // two different places, so it goes in both. Unknown
                        // `_meta` keys are ignored by clients that do not want
                        // them, which is what `_meta` is for.
                        //
                        // It is emitted whether or not the client negotiated
                        // the extension, and that is a deliberate departure
                        // from "servers SHOULD check client capabilities".
                        // Alexa+'s documented `initialize` declares
                        // `capabilities: {roots: {listChanged: true}}` and
                        // nothing else, so a server that gates on negotiation
                        // would never offer Alexa+ a card while Amazon's own
                        // docs say Alexa+ renders one. Gating would be
                        // conformant and useless. Instead the negotiation
                        // OUTCOME is reported on the wire, next to the
                        // binding, so the contradiction is visible in the
                        // bytes rather than argued about in a README.
                        const hasDelivery =
                            (wire.structuredContent as { privateDelivery?: unknown } | undefined)?.privateDelivery != null;
                        // `getUiCapability` types its argument as the SDK's ClientCapabilities
                        // widened with `extensions`; under exactOptionalPropertyTypes the
                        // optional-property variance does not line up. The value is the
                        // right shape, so the cast is about strictness, not correctness.
                        const negotiated =
                            getUiCapability(
                                mcp.server.getClientCapabilities() as Parameters<typeof getUiCapability>[0]
                            ) !== undefined;
                        if (hasDelivery) {
                            wire._meta = {
                                ...(wire._meta ?? {}),
                                ui: { resourceUri: CARD_URI },
                                'ui/resourceUri': CARD_URI,
                                'earshot/uiExtensionNegotiated': negotiated
                            };
                        }

                        latency.record(tool.name, ms());
                        return wire;
                    } catch (err) {
                        const elapsed = ms();
                        latency.record(tool.name, elapsed);
                        const msg = err instanceof Error ? err.message : String(err);
                        // A LeakError must be loud. It means a protected value
                        // reached a channel it must not reach.
                        console.error(`[earshot] tool ${tool.name} failed: ${msg}`);
                        return spokenError('Something went wrong on my side. Nothing was disclosed.', tool.name, elapsed);
                    }
            };

            if (DELIVERING_TOOLS.has(tool.name)) {
                registerAppTool(
                    mcp,
                    tool.name,
                    { ...config, _meta: { ui: { resourceUri: CARD_URI, visibility: ['model'] } } },
                    handler as never
                );
            } else {
                mcp.registerTool(tool.name, config, handler as never);
            }
        }

        // ---- MCP Apps: the `ui://` card ---------------------------------
        //
        // One static view, registered with the extension's own
        // `registerAppResource`, which defaults the mime type to
        // `text/html;profile=mcp-app`. Read the header of
        // src/protocol/apps.ts before changing what it renders: a `ui://`
        // resource is served by `resources/read` over the same authenticated
        // session the model drives, so the card body is on the model's
        // channel and holds a receipt rather than a payload.
        //
        // The per-call data does not come from here. The host hands the tool
        // result to the running view over `ui/notifications/tool-result`, and
        // that result is a receipt by construction — see
        // src/protocol/envelope.ts.
        registerAppResource(
            mcp,
            'Earshot private card',
            CARD_URI,
            {
                title: 'Earshot private card',
                description:
                    'Shows that private detail was delivered out-of-band, and why this panel is not one of the places it went. Carries no payload.',
                mimeType: CARD_MIME,
                _meta: { ui: { csp: CARD_CSP } }
            },
            async uri => ({
                contents: [{ uri: uri.href, mimeType: CARD_MIME, text: CARD_HTML }],
                _meta: { ui: { csp: CARD_CSP } }
            })
        );

        mcp.registerResource(
            'latency',
            'earshot://metrics/latency',
            { title: 'Measured tool latency', description: 'Real per-tool timings from this process.', mimeType: 'application/json' },
            async uri => ({
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({ budgetMs: LATENCY_BUDGET_MS, tools: latency.all() }, null, 2)
                    }
                ]
            })
        );

        return mcp;
    }

    const http = createServer((req, res) => {
        void handle(req, res).catch(err => {
            console.error('[earshot] unhandled', err);
            if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
            else res.end();
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', publicUrl);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // Set the CORS headers on the response object itself, before any
        // dispatch. `sendJson` takes them as an argument, which covered the
        // 401 and the OAuth endpoints but NOT the authenticated /mcp success
        // path: once the request is handed to StreamableHTTPServerTransport
        // the SDK writes the response itself, so anything not already on `res`
        // is lost — including the exposure of `mcp-session-id`, without which
        // a browser client cannot continue the session. Headers set here are
        // merged into whatever `writeHead` the SDK does later.
        for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            // ---- discovery -------------------------------------------------
            if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') {
                sendJson(res, 200, oauth.authorizationServerMetadata(), corsHeaders());
                return;
            }
            if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
                sendJson(res, 200, oauth.protectedResourceMetadata(), corsHeaders());
                return;
            }

            // ---- registration ----------------------------------------------
            if (path === '/oauth/register' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
                sendJson(res, 201, oauth.register(body), corsHeaders());
                return;
            }

            // ---- authorize --------------------------------------------------
            if (path === '/oauth/authorize' && req.method === 'GET') {
                const validated = oauth.validateAuthorizeRequest(url.searchParams);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(renderConsentPage(oauth, url.searchParams, validated));
                return;
            }

            if (path === '/oauth/authorize/decision' && req.method === 'GET') {
                const validated = oauth.validateAuthorizeRequest(url.searchParams);
                const account = url.searchParams.get('account');
                if (!account) throw new OAuthError('invalid_request', 'account is required');
                const code = oauth.issueCode({
                    clientId: validated.client.client_id,
                    redirectUri: validated.redirectUri,
                    codeChallenge: validated.codeChallenge,
                    personId: account,
                    scopes: validated.scopes,
                    resource: validated.resource
                });
                const target = new URL(validated.redirectUri);
                target.searchParams.set('code', code);
                if (validated.state) target.searchParams.set('state', validated.state);
                res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
                res.end();
                return;
            }

            // ---- token ------------------------------------------------------
            if (path === '/oauth/token' && req.method === 'POST') {
                const params = new URLSearchParams(await readBody(req));
                sendJson(res, 200, oauth.exchange(params), corsHeaders());
                return;
            }
            if (path === '/oauth/revoke' && req.method === 'POST') {
                oauth.revoke(new URLSearchParams(await readBody(req)));
                sendJson(res, 200, {}, corsHeaders());
                return;
            }

            // ---- the second channel -----------------------------------------
            if (path === '/inbox' || path.startsWith('/inbox/')) {
                const auth = oauth.verifyBearer(req.headers.authorization);
                const personId = String(auth.extra?.['personId'] ?? '');
                const markRead = url.searchParams.get('peek') !== '1';
                sendJson(res, 200, renderInbox(store, personId, markRead), corsHeaders());
                return;
            }

            // ---- diagnostics -------------------------------------------------
            if (path === '/healthz') {
                sendJson(res, 200, {
                    ok: true,
                    mcpSpecVersion: MCP_SPEC_VERSION,
                    supported: SUPPORTED_PROTOCOL_VERSIONS,
                    transport: 'streamable-http',
                    jsonResponse,
                    now: clock.now().toISOString(),
                    sessions: sessions.size
                });
                return;
            }
            if (path === '/metrics') {
                const tools = latency.all();
                sendJson(res, 200, {
                    budgetMs: LATENCY_BUDGET_MS,
                    overBudgetTotal: tools.reduce((a, t) => a + t.overBudget, 0),
                    tools
                });
                return;
            }
            if (path === '/') {
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(
                    [
                        'Earshot — an Alexa+ MCP add-on that treats the room as an untrusted channel.',
                        '',
                        `MCP endpoint:      POST ${publicUrl}/mcp   (spec ${MCP_SPEC_VERSION}, Streamable HTTP)`,
                        `Private channel:   GET  ${publicUrl}/inbox (your own OAuth token; never the model's)`,
                        `Authorisation:     ${publicUrl}/.well-known/oauth-authorization-server`,
                        `Resource metadata: ${publicUrl}/.well-known/oauth-protected-resource`,
                        `Measured latency:  GET  ${publicUrl}/metrics`,
                        ''
                    ].join('\n')
                );
                return;
            }

            // ---- MCP ----------------------------------------------------------
            if (path === '/mcp') {
                const authed = req as IncomingMessage & { auth?: ReturnType<OAuthServer['verifyBearer']> };
                authed.auth = oauth.verifyBearer(req.headers.authorization);

                const sessionId = req.headers['mcp-session-id'];
                const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

                if (existing) {
                    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
                    await existing.transport.handleRequest(authed, res, body);
                    return;
                }

                if (req.method !== 'POST') {
                    sendJson(res, 400, { error: 'invalid_session', message: 'Mcp-Session-Id header is required' });
                    return;
                }

                const body = JSON.parse((await readBody(req)) || 'null');
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: jsonResponse,
                    onsessioninitialized: sid => {
                        sessions.set(sid, { transport, server });
                    },
                    onsessionclosed: sid => {
                        sessions.delete(sid);
                    }
                });
                const server = buildMcpServer();
                transport.onclose = () => {
                    if (transport.sessionId) sessions.delete(transport.sessionId);
                };
                // The SDK declares `Transport.onclose?: () => void` while the
                // concrete transport widens it to `(() => void) | undefined`.
                // Under `exactOptionalPropertyTypes` those are not assignable.
                // This is a tsconfig-strictness mismatch in the SDK's own
                // types, not a real incompatibility.
                await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
                await transport.handleRequest(authed, res, body);
                return;
            }

            sendJson(res, 404, { error: 'not_found', path });
        } catch (err) {
            if (err instanceof OAuthError) {
                const headers = err.status === 401 ? { 'www-authenticate': oauth.wwwAuthenticate(err.code, err.message) } : {};
                sendJson(res, err.status, { error: err.code, error_description: err.message }, { ...corsHeaders(), ...headers });
                return;
            }
            if (err instanceof PkceError) {
                sendJson(res, 400, { error: err.code, error_description: err.message }, corsHeaders());
                return;
            }
            throw err;
        }
    }

    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(wantedPort, host, () => resolve());
    });

    const addr = http.address() as AddressInfo;
    const bound = `http://${host}:${addr.port}`;
    if (!opts.publicUrl && !process.env['EARSHOT_PUBLIC_URL']) {
        publicUrl = bound;
        oauth = new OAuthServer({ issuer: publicUrl, clock, accounts: ACCOUNTS });
    }

    return {
        http,
        store,
        oauth,
        latency,
        url: publicUrl,
        close: () =>
            new Promise<void>(resolve => {
                for (const s of sessions.values()) void s.transport.close();
                sessions.clear();
                http.close(() => resolve());
                http.closeAllConnections?.();
            })
    };
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
        'access-control-expose-headers': 'mcp-session-id, www-authenticate',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
    };
}

// --- entry point -----------------------------------------------------------

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain || process.env['EARSHOT_START'] === '1') {
    // `--demo` freezes the clock at DEMO_INSTANT so the household — and every
    // number any tool speaks — is identical on every take.
    const demo = process.argv.includes('--demo') || process.env['EARSHOT_DEMO'] === '1';
    const opts: EarshotServerOptions = {
        ...(demo ? { clock: new FixedClock(DEMO_INSTANT) } : {}),
        ...(process.env['HOST'] ? { host: process.env['HOST'] } : {})
    };

    startServer(opts)
        .then(h => {
            console.log(`[earshot] listening on ${h.url}`);
            console.log(`[earshot] MCP spec ${MCP_SPEC_VERSION}, Streamable HTTP, OAuth 2.1 + PKCE (S256)`);
            console.log(`[earshot] latency budget ${LATENCY_BUDGET_MS} ms — measured at ${h.url}/metrics`);
            if (demo) {
                console.log(`[earshot] --demo: clock frozen at ${DEMO_INSTANT.toISOString()}, household seeded deterministically`);
                console.log(`[earshot] accounts: ${ACCOUNTS.map(a => a.id).join(', ')} (pick one on the consent screen)`);
            }
            const shutdown = (): void => {
                void h.close().then(() => process.exit(0));
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
        })
        .catch(err => {
            console.error('[earshot] failed to start', err);
            process.exit(1);
        });
}
