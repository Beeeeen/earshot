/**
 * Earshot — OAuth 2.1 authorisation server + protected-resource metadata.
 *
 * Hand-written on node:http rather than pulled from a framework, because the
 * pieces Alexa+ actually checks are few and worth being able to point at:
 *
 *   - authorization code + PKCE S256, mandatory, `plain` rejected (RFC 7636)
 *   - exact redirect-URI matching, no wildcards
 *   - no implicit grant, no resource-owner-password grant (OAuth 2.1)
 *   - one-time authorization codes, 60 s lifetime
 *   - refresh-token rotation: using a refresh token invalidates it
 *   - RFC 8414 authorization-server metadata
 *   - RFC 9728 protected-resource metadata + WWW-Authenticate on 401
 *   - RFC 8707 resource indicators, validated against this server's identity
 *   - RFC 7591 dynamic client registration
 *
 * Identity is the *only* thing this establishes. What a token holder may then
 * see is decided by the grant table in src/domain/authz.ts, never by the token.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import type { Clock } from '../core/clock.js';
import { assertMethodSupported, base64url, verifyChallenge } from './pkce.js';

export const SCOPES = ['care.read', 'care.write', 'ledger.read', 'solo.open'] as const;
export type Scope = (typeof SCOPES)[number];

const AUTH_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface RegisteredClient {
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    /** Public clients only. OAuth 2.1 + PKCE means no client secret is needed. */
    token_endpoint_auth_method: 'none';
    grant_types: string[];
    response_types: string[];
    scope: string;
}

interface AuthCode {
    code: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    personId: string;
    scopes: string[];
    resource: string | null;
    expiresAt: number;
    used: boolean;
}

interface IssuedToken {
    token: string;
    clientId: string;
    personId: string;
    scopes: string[];
    resource: string | null;
    expiresAt: number;
}

interface RefreshToken extends IssuedToken {
    rotated: boolean;
}

export interface HouseholdAccount {
    readonly id: string;
    readonly displayName: string;
    readonly relationship: string;
    readonly scopes: readonly Scope[];
}

export class OAuthError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status = 400) {
        super(message);
        this.name = 'OAuthError';
        this.code = code;
        this.status = status;
    }
}

export interface OAuthServerOptions {
    /** Public HTTPS base URL of this deployment, e.g. https://earshot.example.com */
    readonly issuer: string;
    readonly clock: Clock;
    readonly accounts: readonly HouseholdAccount[];
}

export class OAuthServer {
    readonly issuer: string;
    readonly #clock: Clock;
    readonly #accounts: readonly HouseholdAccount[];
    readonly #clients = new Map<string, RegisteredClient>();
    readonly #codes = new Map<string, AuthCode>();
    readonly #access = new Map<string, IssuedToken>();
    readonly #refresh = new Map<string, RefreshToken>();

    constructor(opts: OAuthServerOptions) {
        this.issuer = opts.issuer.replace(/\/+$/, '');
        this.#clock = opts.clock;
        this.#accounts = opts.accounts;
    }

    get accounts(): readonly HouseholdAccount[] {
        return this.#accounts;
    }

    /** The RFC 8707 resource identifier for the MCP endpoint. */
    get resourceIdentifier(): string {
        return `${this.issuer}/mcp`;
    }

    // -- metadata ----------------------------------------------------------

    authorizationServerMetadata(): unknown {
        return {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/oauth/authorize`,
            token_endpoint: `${this.issuer}/oauth/token`,
            registration_endpoint: `${this.issuer}/oauth/register`,
            revocation_endpoint: `${this.issuer}/oauth/revoke`,
            scopes_supported: [...SCOPES],
            response_types_supported: ['code'],
            // OAuth 2.1: implicit and password grants are gone.
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            resource_indicators_supported: true,
            service_documentation: `${this.issuer}/`
        };
    }

    protectedResourceMetadata(): unknown {
        return {
            resource: this.resourceIdentifier,
            authorization_servers: [this.issuer],
            scopes_supported: [...SCOPES],
            bearer_methods_supported: ['header'],
            resource_name: 'Earshot MCP',
            resource_documentation: `${this.issuer}/`
        };
    }

    wwwAuthenticate(error?: string, description?: string): string {
        const parts = [
            `Bearer realm="earshot"`,
            `resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"`
        ];
        if (error) parts.push(`error="${error}"`);
        if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
        return parts.join(', ');
    }

    // -- dynamic client registration (RFC 7591) ----------------------------

    register(body: Record<string, unknown>): RegisteredClient {
        const uris = body['redirect_uris'];
        if (!Array.isArray(uris) || uris.length === 0 || !uris.every(u => typeof u === 'string')) {
            throw new OAuthError('invalid_client_metadata', 'redirect_uris is required and must be a non-empty array');
        }
        for (const u of uris as string[]) {
            let parsed: URL;
            try {
                parsed = new URL(u);
            } catch {
                throw new OAuthError('invalid_redirect_uri', `not a URL: ${u}`);
            }
            const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
            if (parsed.protocol !== 'https:' && !loopback) {
                throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https, except loopback for development');
            }
        }
        const client: RegisteredClient = {
            client_id: `earshot-client-${base64url(randomBytes(9))}`,
            client_name: typeof body['client_name'] === 'string' ? (body['client_name'] as string) : 'unnamed client',
            redirect_uris: uris as string[],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: SCOPES.join(' ')
        };
        this.#clients.set(client.client_id, client);
        return client;
    }

    client(id: string): RegisteredClient | undefined {
        return this.#clients.get(id);
    }

    // -- authorize ---------------------------------------------------------

    /** Validate an /oauth/authorize request. Throws OAuthError on anything wrong. */
    validateAuthorizeRequest(q: URLSearchParams): {
        client: RegisteredClient;
        redirectUri: string;
        state: string | null;
        codeChallenge: string;
        scopes: string[];
        resource: string | null;
    } {
        const clientId = q.get('client_id');
        if (!clientId) throw new OAuthError('invalid_request', 'client_id is required');
        const client = this.#clients.get(clientId);
        if (!client) throw new OAuthError('invalid_client', `unknown client_id ${clientId}`, 401);

        const responseType = q.get('response_type');
        if (responseType !== 'code') {
            throw new OAuthError('unsupported_response_type', 'only response_type=code is supported (OAuth 2.1)');
        }

        const redirectUri = q.get('redirect_uri');
        if (!redirectUri) throw new OAuthError('invalid_request', 'redirect_uri is required');
        // Exact string match. No prefix matching, no wildcards.
        if (!client.redirect_uris.includes(redirectUri)) {
            throw new OAuthError('invalid_request', 'redirect_uri does not exactly match a registered URI');
        }

        assertMethodSupported(q.get('code_challenge_method') ?? undefined);
        const codeChallenge = q.get('code_challenge');
        if (!codeChallenge || codeChallenge.length < 43) {
            throw new OAuthError('invalid_request', 'code_challenge is required (PKCE S256)');
        }

        const requested = (q.get('scope') ?? SCOPES.join(' ')).split(/\s+/).filter(Boolean);
        const unknown = requested.filter(s => !(SCOPES as readonly string[]).includes(s));
        if (unknown.length > 0) throw new OAuthError('invalid_scope', `unknown scope(s): ${unknown.join(', ')}`);

        const resource = q.get('resource');
        if (resource !== null) {
            const normalised = resource.split('#')[0] ?? resource;
            if (normalised !== this.resourceIdentifier) {
                throw new OAuthError(
                    'invalid_target',
                    `resource indicator ${normalised} is not this server (${this.resourceIdentifier})`
                );
            }
        }

        return { client, redirectUri, state: q.get('state'), codeChallenge, scopes: requested, resource };
    }

    /** Issue an authorization code once the account holder has picked themselves. */
    issueCode(args: {
        clientId: string;
        redirectUri: string;
        codeChallenge: string;
        personId: string;
        scopes: string[];
        resource: string | null;
    }): string {
        const account = this.#accounts.find(a => a.id === args.personId);
        if (!account) throw new OAuthError('access_denied', `no Earshot account for ${args.personId}`);
        const granted = args.scopes.filter(s => (account.scopes as readonly string[]).includes(s));
        const code = base64url(randomBytes(32));
        this.#codes.set(code, {
            code,
            clientId: args.clientId,
            redirectUri: args.redirectUri,
            codeChallenge: args.codeChallenge,
            personId: args.personId,
            scopes: granted,
            resource: args.resource,
            expiresAt: this.#clock.now().getTime() + AUTH_CODE_TTL_MS,
            used: false
        });
        return code;
    }

    // -- token -------------------------------------------------------------

    exchange(params: URLSearchParams): Record<string, unknown> {
        const grantType = params.get('grant_type');
        if (grantType === 'authorization_code') return this.#exchangeCode(params);
        if (grantType === 'refresh_token') return this.#exchangeRefresh(params);
        if (grantType === 'password' || grantType === 'implicit') {
            throw new OAuthError('unsupported_grant_type', `${grantType} was removed in OAuth 2.1`);
        }
        throw new OAuthError('unsupported_grant_type', `unsupported grant_type: ${grantType ?? '(none)'}`);
    }

    #exchangeCode(params: URLSearchParams): Record<string, unknown> {
        const code = params.get('code');
        const verifier = params.get('code_verifier');
        const clientId = params.get('client_id');
        const redirectUri = params.get('redirect_uri');

        if (!code) throw new OAuthError('invalid_request', 'code is required');
        if (!verifier) throw new OAuthError('invalid_request', 'code_verifier is required (PKCE is mandatory)');
        if (!clientId) throw new OAuthError('invalid_request', 'client_id is required');

        const entry = this.#codes.get(code);
        if (!entry) throw new OAuthError('invalid_grant', 'unknown authorization code');
        if (entry.used) {
            // Replay. Burn everything issued from this code.
            this.#codes.delete(code);
            throw new OAuthError('invalid_grant', 'authorization code has already been used');
        }
        if (entry.expiresAt < this.#clock.now().getTime()) {
            this.#codes.delete(code);
            throw new OAuthError('invalid_grant', 'authorization code expired');
        }
        if (entry.clientId !== clientId) throw new OAuthError('invalid_grant', 'code was issued to a different client');
        if (redirectUri !== null && redirectUri !== entry.redirectUri) {
            throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
        }

        verifyChallenge(verifier, entry.codeChallenge);

        entry.used = true;
        this.#codes.delete(code);
        return this.#issueTokens(entry.clientId, entry.personId, entry.scopes, entry.resource);
    }

    #exchangeRefresh(params: URLSearchParams): Record<string, unknown> {
        const token = params.get('refresh_token');
        const clientId = params.get('client_id');
        if (!token) throw new OAuthError('invalid_request', 'refresh_token is required');
        const entry = this.#refresh.get(token);
        if (!entry) throw new OAuthError('invalid_grant', 'unknown refresh token');
        if (entry.rotated) {
            // Reuse of a rotated refresh token: revoke the whole family.
            this.#refresh.delete(token);
            for (const [k, v] of this.#refresh) if (v.personId === entry.personId) this.#refresh.delete(k);
            throw new OAuthError('invalid_grant', 'refresh token was already used; family revoked');
        }
        if (entry.expiresAt < this.#clock.now().getTime()) {
            this.#refresh.delete(token);
            throw new OAuthError('invalid_grant', 'refresh token expired');
        }
        if (clientId !== null && clientId !== entry.clientId) {
            throw new OAuthError('invalid_grant', 'refresh token was issued to a different client');
        }
        entry.rotated = true;
        return this.#issueTokens(entry.clientId, entry.personId, entry.scopes, entry.resource);
    }

    #issueTokens(clientId: string, personId: string, scopes: string[], resource: string | null): Record<string, unknown> {
        const now = this.#clock.now().getTime();
        const accessToken = base64url(randomBytes(32));
        const refreshToken = base64url(randomBytes(32));
        this.#access.set(accessToken, {
            token: accessToken,
            clientId,
            personId,
            scopes,
            resource,
            expiresAt: now + ACCESS_TOKEN_TTL_MS
        });
        this.#refresh.set(refreshToken, {
            token: refreshToken,
            clientId,
            personId,
            scopes,
            resource,
            expiresAt: now + REFRESH_TOKEN_TTL_MS,
            rotated: false
        });
        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            refresh_token: refreshToken,
            scope: scopes.join(' ')
        };
    }

    revoke(params: URLSearchParams): void {
        const token = params.get('token');
        if (!token) return;
        this.#access.delete(token);
        const r = this.#refresh.get(token);
        if (r) this.#refresh.delete(token);
    }

    // -- resource-server side ---------------------------------------------

    /** Validate a bearer token. Returns the MCP SDK's AuthInfo, or throws. */
    verifyBearer(header: string | undefined): AuthInfo {
        if (!header) throw new OAuthError('invalid_token', 'missing Authorization header', 401);
        const m = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (!m) throw new OAuthError('invalid_token', 'Authorization header must be "Bearer <token>"', 401);
        const presented = m[1] as string;

        // Constant-time lookup over the issued set: a Map hit alone would leak
        // nothing useful here, but the comparison is cheap to do properly.
        let found: IssuedToken | undefined;
        for (const [k, v] of this.#access) {
            const a = Buffer.from(k);
            const b = Buffer.from(presented);
            if (a.length === b.length && timingSafeEqual(a, b)) {
                found = v;
                break;
            }
        }
        if (!found) throw new OAuthError('invalid_token', 'unknown or revoked access token', 401);
        if (found.expiresAt < this.#clock.now().getTime()) {
            this.#access.delete(found.token);
            throw new OAuthError('invalid_token', 'access token expired', 401);
        }

        const info: AuthInfo = {
            token: found.token,
            clientId: found.clientId,
            scopes: found.scopes,
            expiresAt: Math.floor(found.expiresAt / 1000),
            extra: { personId: found.personId }
        };
        if (found.resource) return { ...info, resource: new URL(found.resource) };
        return info;
    }

    /** For diagnostics only; never exposed over HTTP. */
    stats(): { clients: number; codes: number; access: number; refresh: number } {
        return {
            clients: this.#clients.size,
            codes: this.#codes.size,
            access: this.#access.size,
            refresh: this.#refresh.size
        };
    }
}

/** The consent screen. Deliberately plain: it names what is being granted. */
export function renderConsentPage(
    server: OAuthServer,
    q: URLSearchParams,
    validated: { scopes: string[]; client: RegisteredClient }
): string {
    const rows = server.accounts
        .map(a => {
            const next = new URLSearchParams(q);
            next.set('account', a.id);
            return `<li><a class="pick" href="/oauth/authorize/decision?${next.toString()}">
                <strong>${escapeHtml(a.displayName)}</strong>
                <span>${escapeHtml(a.relationship)}</span>
            </a></li>`;
        })
        .join('\n');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Link your Earshot account</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;color:#1c1917}
  h1{font-size:1.35rem;margin:0 0 .25rem}
  p.sub{color:#57534e;margin:0 0 1.5rem}
  ul{list-style:none;padding:0;margin:0 0 1.5rem}
  a.pick{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;
    padding:.9rem 1rem;border:1px solid #d6d3d1;border-radius:.6rem;margin-bottom:.6rem;
    text-decoration:none;color:inherit}
  a.pick:hover{border-color:#0c4a6e;background:#f0f9ff}
  a.pick span{color:#78716c;font-size:.9rem}
  .scopes{background:#fafaf9;border:1px solid #e7e5e4;border-radius:.6rem;padding:1rem;font-size:.9rem}
  code{font:13px ui-monospace,monospace;background:#f5f5f4;padding:.1rem .3rem;border-radius:.25rem}
</style></head><body>
<h1>Link your Earshot account</h1>
<p class="sub"><strong>${escapeHtml(validated.client.client_name)}</strong> is asking to connect to Earshot. Choose who you are.</p>
<ul>${rows}</ul>
<div class="scopes">
  <p style="margin:.2rem 0 .6rem"><strong>What this grants</strong></p>
  <p style="margin:0 0 .6rem">${validated.scopes.map(s => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>
  <p style="margin:0">Linking establishes <em>who you are</em>. It does not decide what you can see —
  that comes from the grant table Margaret controls, and it can be revoked without unlinking.</p>
</div>
</body></html>`;
}

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Read a request body with a hard size cap. */
export async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limitBytes) {
                reject(new OAuthError('invalid_request', 'request body too large', 413));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers
    });
    res.end(text);
}
