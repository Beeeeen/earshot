/**
 * A real OAuth 2.1 + PKCE client and a real MCP client, used by the self-test
 * and by the demo. Nothing here is a stub: it registers, authorises, exchanges
 * a code for a token with a genuine S256 verifier, and speaks Streamable HTTP.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { challengeFor, createVerifier } from '../auth/pkce.js';

export const REDIRECT_URI = 'http://127.0.0.1:59999/callback';

export interface LinkedAccount {
    readonly personId: string;
    readonly clientId: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly scopes: string[];
}

export async function registerClient(baseUrl: string, name = 'Earshot self-test'): Promise<string> {
    const res = await fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT_URI] })
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { client_id: string };
    return body.client_id;
}

export function authorizeUrl(
    baseUrl: string,
    args: {
        clientId: string;
        challenge: string;
        method?: string;
        state?: string;
        scope?: string;
        resource?: string;
        redirectUri?: string;
    }
): string {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: args.clientId,
        redirect_uri: args.redirectUri ?? REDIRECT_URI,
        code_challenge: args.challenge,
        code_challenge_method: args.method ?? 'S256',
        scope: args.scope ?? 'care.read care.write ledger.read solo.open',
        state: args.state ?? 'xyz'
    });
    if (args.resource) q.set('resource', args.resource);
    return `${baseUrl}/oauth/authorize?${q.toString()}`;
}

/** Follows exactly what a human clicking the consent button does. */
export async function pickAccount(baseUrl: string, authUrl: string, account: string): Promise<Response> {
    const u = new URL(authUrl);
    u.pathname = '/oauth/authorize/decision';
    u.searchParams.set('account', account);
    return fetch(u.toString(), { redirect: 'manual' });
}

export async function exchange(baseUrl: string, params: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString()
    });
}

/** The whole flow, end to end, the way a household member's device would do it. */
export async function linkAccount(baseUrl: string, personId: string): Promise<LinkedAccount> {
    const clientId = await registerClient(baseUrl);
    const verifier = createVerifier();
    const challenge = challengeFor(verifier);

    const authUrl = authorizeUrl(baseUrl, { clientId, challenge, resource: `${baseUrl}/mcp` });
    const redirect = await pickAccount(baseUrl, authUrl, personId);
    if (redirect.status !== 302) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`);
    const location = redirect.headers.get('location');
    if (!location) throw new Error('no Location header on the authorization redirect');
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error(`no code in redirect: ${location}`);

    const tokenRes = await exchange(baseUrl, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
    });
    if (!tokenRes.ok) throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const t = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };

    return {
        personId,
        clientId,
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        scopes: t.scope.split(' ').filter(Boolean)
    };
}

export interface McpSession {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport;
    close(): Promise<void>;
}

export async function connectMcp(baseUrl: string, accessToken: string): Promise<McpSession> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    const client = new Client(
        { name: 'earshot-selftest', version: '0.1.0' },
        { capabilities: {} }
    );
    // Same `exactOptionalPropertyTypes` mismatch as on the server side: the
    // SDK's Transport interface declares `sessionId?: string` while the
    // concrete transport widens it. Not a real incompatibility.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    return {
        client,
        transport,
        close: async () => {
            await client.close();
        }
    };
}

/**
 * A raw JSON-RPC round trip, bypassing the SDK client, so the self-test can
 * read the exact bytes on the wire and grep them for secrets.
 */
export async function rawCall(
    baseUrl: string,
    accessToken: string,
    sessionId: string | null,
    method: string,
    params: unknown,
    id: number
): Promise<{ status: number; text: string; sessionId: string | null; headers: Headers }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    return {
        status: res.status,
        text: await res.text(),
        sessionId: res.headers.get('mcp-session-id'),
        headers: res.headers
    };
}

/** Initialise a raw session and return its session id. */
export async function rawInitialize(baseUrl: string, accessToken: string): Promise<{ sessionId: string; body: string }> {
    const r = await rawCall(baseUrl, accessToken, null, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'earshot-raw', version: '0.1.0' }
    }, 1);
    if (!r.sessionId) throw new Error(`no session id returned: ${r.status} ${r.text}`);
    await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${accessToken}`,
            'mcp-session-id': r.sessionId,
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    return { sessionId: r.sessionId, body: r.text };
}
