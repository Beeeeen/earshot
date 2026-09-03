/**
 * Earshot — the solo window. The one and only exception to the invariant.
 *
 * The user says "I'm alone". We cannot verify that, and we do not pretend to.
 * What we can do is make the exception small, loud and auditable:
 *
 *   - 5 minutes, then it is gone. No renewal without asking again.
 *   - One asker. Sarah's window does not open anything for Dana.
 *   - One device. Bound to the MCP session id, so a window opened on the
 *     kitchen Echo does not unlock the bedroom one.
 *   - A grant is still required to open one, and still required per category
 *     to speak. The window relaxes *where* a fact may be said, never *who*
 *     may hear it: a viewer with no diagnosis grant does not get the diagnosis
 *     read out because she said she was alone.
 *   - `private` only. A solo window never unseals a chart, an address or an
 *     insurance number — that is enforced by the type of `SoloSpeakable` and
 *     again at runtime by `revealUnderSoloWindow`.
 *   - Every field revealed writes its own ledger row, so `disclosure_ledger`
 *     can say "four things were spoken aloud on Wednesday afternoon".
 *
 * `underSolo(...)` is the only builder in the codebase that can put a
 * protected value into speech. It is one grep away from an auditor.
 *
 * WHAT THE BINDING CAN AND CANNOT DO HERE
 *   `activeSoloWindow()` is a lookup: it finds the window for (asker, subject,
 *   device) and returns nothing if any of the three do not match. That is the
 *   check the tools use, and it holds. But a caller who obtains a `SoloWindow`
 *   some other way — reading `store.soloWindows` — used to be able to hand it
 *   to `underSolo` and speak, because `underSolo` re-checked only expiry and
 *   revocation (F4). It now takes an optional `reader` and verifies the asker
 *   and device against the window when one is supplied; every shipped call
 *   site supplies it. When it is absent, the window's own owner is treated as
 *   the reader — which is the honest reading of "a window nobody claimed" and
 *   is what keeps the grant check below meaningful in either case.
 */

import type { Protected } from '../core/protected.js';
import { SOLO_WINDOW_CAPABILITY, revealUnderSoloWindow } from '../core/protected.js';
import type { Speakable, SpokenText } from '../core/spoken.js';
import { isProtected } from '../core/protected.js';
import { canAsk, canReceivePrivate } from './authz.js';
import type { Store } from './store.js';
import { nextId } from './store.js';
import type { GrantCategory, PersonId, SoloWindow } from './types.js';

/** Five minutes. Stated in the spec, and short on purpose. */
export const SOLO_WINDOW_MS = 5 * 60 * 1000;

/** Refused before anything opened. Not a leak: nothing was disclosed. */
export class SoloWindowRefused extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'SoloWindowRefused';
    }
}

export function openSoloWindow(
    store: Store,
    askerId: PersonId,
    subjectId: PersonId,
    deviceSessionId: string
): SoloWindow {
    // The grant check belongs here, not only in the tool. A domain function
    // that opens a disclosure window for anyone who calls it is a hole waiting
    // for a second call site (F4c).
    const gate = canAsk(store, askerId, subjectId);
    if (!gate.allowed) {
        store.appendLedger({
            subjectId,
            actorId: askerId,
            tool: 'open_solo_window',
            channel: 'denied',
            category: 'transparency',
            what: 'solo window',
            detail: `refused: ${gate.reason}`
        });
        throw new SoloWindowRefused(
            `openSoloWindow: no grant on file — ${askerId} may not open a solo window over ${subjectId}`
        );
    }

    const now = store.clock.now();

    // Opening a new window on a device supersedes any window already open there.
    for (const w of store.soloWindows) {
        if (w.deviceSessionId === deviceSessionId && w.revokedAt === null && w.expiresAt.getTime() > now.getTime()) {
            w.revokedAt = now;
        }
    }

    const win: SoloWindow = {
        id: nextId('solo'),
        askerId,
        subjectId,
        deviceSessionId,
        openedAt: now,
        expiresAt: new Date(now.getTime() + SOLO_WINDOW_MS),
        revokedAt: null
    };
    store.soloWindows.push(win);
    store.appendLedger({
        subjectId,
        actorId: askerId,
        tool: 'open_solo_window',
        channel: 'solo-window',
        category: 'transparency',
        what: 'solo window opened',
        detail: `5 minutes, this device only, expires ${win.expiresAt.toISOString()}`
    });
    return win;
}

export function closeSoloWindow(store: Store, win: SoloWindow): void {
    if (win.revokedAt === null) win.revokedAt = store.clock.now();
}

/** The live window for this asker on this device, if any. */
export function activeSoloWindow(
    store: Store,
    askerId: PersonId,
    subjectId: PersonId,
    deviceSessionId: string
): SoloWindow | undefined {
    const nowMs = store.clock.now().getTime();
    return store.soloWindows.find(
        w =>
            w.askerId === askerId &&
            w.subjectId === subjectId &&
            w.deviceSessionId === deviceSessionId &&
            w.revokedAt === null &&
            w.expiresAt.getTime() > nowMs
    );
}

export function secondsRemaining(store: Store, win: SoloWindow): number {
    return Math.max(0, Math.round((win.expiresAt.getTime() - store.clock.now().getTime()) / 1000));
}

/**
 * What may be interpolated while a solo window is open.
 *
 * Note the classification is pinned to `'private'`. A `Protected<T, 'sealed'>`
 * is not assignable, so no solo window can ever speak an address, an insurance
 * number or a chart — that is a compile error, not a runtime check.
 * Proof: src/negative/solo-speaks-sealed.neg.ts
 */
export type SoloSpeakable = Speakable | Protected<string | number, 'private'>;

/** Who is reading this out, from the access token and the transport session. */
export interface SoloReader {
    readonly personId: PersonId;
    readonly deviceSessionId: string;
}

export interface SoloSpeechContext {
    readonly store: Store;
    readonly window: SoloWindow;
    readonly tool: string;
    /**
     * The account and device this sentence is being built for. Supplied by
     * every tool; verified against the window before a word is revealed.
     */
    readonly reader?: SoloReader;
}

export class SoloWindowExpired extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'SoloWindowExpired';
    }
}

/** The reader tried to speak from a window that is not theirs, or not here. */
export class SoloWindowMismatch extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'SoloWindowMismatch';
    }
}

/** Substituted for a value the reader's grant does not cover. Carries no marker and no payload. */
function withheld(label: string): string {
    return `(${label} — not in your access)`;
}

/**
 * The escape hatch. Curried so it reads as a tagged template at the call site:
 *
 *     underSolo(ctx)`She took ${med.name} ${med.strength} at ${time}.`
 *
 * Re-checks, at the moment of speech:
 *   - liveness — a window that expired between the authorisation check and the
 *     sentence being built does not speak;
 *   - the reader — the asker and device must be the ones the window was opened
 *     for, when the caller says who is reading;
 *   - the grant, per interpolated value — the window says "nobody else is in
 *     the room", not "the grant table no longer applies".
 */
export function underSolo(ctx: SoloSpeechContext) {
    return (strings: TemplateStringsArray, ...values: SoloSpeakable[]): SpokenText => {
        const now = ctx.store.clock.now();
        if (ctx.window.revokedAt !== null || ctx.window.expiresAt.getTime() <= now.getTime()) {
            throw new SoloWindowExpired(
                `solo window ${ctx.window.id} is no longer open (expired ${ctx.window.expiresAt.toISOString()})`
            );
        }

        if (ctx.reader) {
            if (ctx.reader.personId !== ctx.window.askerId) {
                throw new SoloWindowMismatch(
                    `solo window ${ctx.window.id} was opened by another account; it unlocks nothing for ${ctx.reader.personId}`
                );
            }
            if (ctx.reader.deviceSessionId !== ctx.window.deviceSessionId) {
                throw new SoloWindowMismatch(
                    `solo window ${ctx.window.id} is bound to another device; it unlocks nothing here`
                );
            }
        }

        const readerId = ctx.reader?.personId ?? ctx.window.askerId;

        let out = strings[0] ?? '';
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (isProtected(v)) {
                const box = v as Protected<string | number, 'private'>;
                // Classification first, grant second. A `sealed` value that
                // was cast in here is a bug, not a policy question, and it
                // must abort the sentence loudly rather than being quietly
                // withheld like a category the reader simply lacks.
                if (box.classification !== 'private') {
                    revealUnderSoloWindow(box, SOLO_WINDOW_CAPABILITY);
                }
                const grant = canReceivePrivate(
                    ctx.store,
                    readerId,
                    ctx.window.subjectId,
                    box.category as GrantCategory
                );
                if (!grant.allowed) {
                    // Refuse the field, not the sentence: the rest of the
                    // answer is still owed to the asker, and the refusal is
                    // recorded as loudly as a disclosure would have been.
                    out += withheld(box.label);
                    ctx.store.appendLedger({
                        subjectId: ctx.window.subjectId,
                        actorId: readerId,
                        tool: ctx.tool,
                        channel: 'denied',
                        category: box.category as GrantCategory,
                        what: box.label,
                        detail: `not spoken under solo window ${ctx.window.id}: ${grant.reason}`
                    });
                } else {
                    out += String(revealUnderSoloWindow(box, SOLO_WINDOW_CAPABILITY));
                    ctx.store.appendLedger({
                        subjectId: ctx.window.subjectId,
                        actorId: readerId,
                        tool: ctx.tool,
                        channel: 'solo-window',
                        category: box.category as GrantCategory,
                        what: box.label,
                        detail: `spoken aloud under solo window ${ctx.window.id}`
                    });
                }
            } else {
                out += String(v);
            }
            out += strings[i + 1] ?? '';
        }
        return out as SpokenText;
    };
}
