/**
 * Earshot — the shape every tool returns.
 *
 * A tool result is split at the type level into what may be said out loud and
 * what may not. The two halves are not interchangeable:
 *
 *   - `spoken`   : SpokenText            — leaves over the MCP transport.
 *   - `privately`: PrivatePayload        — leaves ONLY over the out-of-band
 *                                          channel (GET /inbox, authenticated
 *                                          with the asker's own token). Never
 *                                          appears in an MCP response, so the
 *                                          model never sees it and therefore
 *                                          cannot narrate it.
 *   - `sealedRefs`: SealedRef[]          — not delivered at all. Only a
 *                                          pointer: "open the Earshot app".
 *   - `data`     : SpokenData            — structured mirror of `spoken`, for
 *                                          MCP `structuredContent`. Constrained
 *                                          to scalars, so a Protected value is
 *                                          not assignable here either.
 */

import type { Protected } from './protected.js';
import type { SpokenText } from './spoken.js';

/** One line on the card that appears on the asker's own device. */
export interface PrivateField {
    readonly label: string;
    /**
     * `Protected<..., 'private'>` — note the classification is pinned. A
     * `sealed` value is a compile error here, because sealed data does not
     * travel even on the private channel.
     */
    readonly value: Protected<string | number, 'private'>;
}

/** The card delivered out-of-band to the asker's linked device. */
export interface PrivatePayload {
    readonly title: string;
    readonly fields: readonly PrivateField[];
    /** Optional non-sensitive footnote, e.g. "Recorded 3 minutes ago." */
    readonly footnote?: SpokenText;
}

/** A fact that exists but is not delivered on any channel Earshot controls. */
export interface SealedRef {
    readonly label: string;
    readonly category: string;
    /** Deep link into the companion app. Contains no payload. */
    readonly appPath: string;
}

/** Scalars that are safe to put in `structuredContent`. Excludes objects. */
export type SpokenScalar = string | number | boolean | null;

/** Structured mirror of the spoken answer. A `Protected<T>` cannot be assigned. */
export type SpokenData = Readonly<Record<string, SpokenScalar | readonly SpokenScalar[]>>;

/** A private payload routed to someone other than the asker (e.g. a symptom alert). */
export interface Notification {
    readonly recipientId: string;
    readonly payload: PrivatePayload;
}

/** What every Earshot tool returns. */
export interface ToolResult {
    readonly spoken: SpokenText;
    readonly privately?: PrivatePayload;
    /** Out-of-band deliveries to third parties who hold a grant. */
    readonly notify?: readonly Notification[];
    readonly sealedRefs?: readonly SealedRef[];
    readonly data?: SpokenData;
    /**
     * True when this result was produced with a live solo window, i.e. the
     * asker declared they are alone and `private` facts were spoken aloud.
     * Recorded in the ledger; surfaced in `structuredContent` so the transcript
     * shows it.
     */
    readonly underSoloWindow?: boolean;
}

/** Convenience constructor so tools read cleanly. */
export function result(r: ToolResult): ToolResult {
    return r;
}
