/**
 * PKCE (RFC 7636), S256 only.
 *
 * OAuth 2.1 requires PKCE on every authorization-code flow, and Alexa+ requires
 * S256 specifically. `plain` is rejected rather than silently accepted, because
 * accepting `plain` is the same as not doing PKCE at all.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type CodeChallengeMethod = 'S256';

export function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Client-side helper, used by the self-test to drive a genuine PKCE flow. */
export function createVerifier(): string {
    return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
    return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export class PkceError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'PkceError';
        this.code = code;
    }
}

/** RFC 7636 §4.1: 43-128 chars from the unreserved set. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function assertMethodSupported(method: string | undefined): CodeChallengeMethod {
    if (method === undefined) {
        throw new PkceError('invalid_request', 'code_challenge_method is required; only S256 is supported');
    }
    if (method !== 'S256') {
        throw new PkceError(
            'invalid_request',
            `code_challenge_method "${method}" is not supported. OAuth 2.1 with Alexa+ requires S256.`
        );
    }
    return 'S256';
}

export function verifyChallenge(verifier: string, expectedChallenge: string): void {
    if (!VERIFIER_RE.test(verifier)) {
        throw new PkceError('invalid_grant', 'code_verifier is not a valid RFC 7636 verifier');
    }
    const actual = Buffer.from(challengeFor(verifier));
    const expected = Buffer.from(expectedChallenge);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new PkceError('invalid_grant', 'code_verifier does not match code_challenge');
    }
}
