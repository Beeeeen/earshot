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
 *   - `private` only. A solo window never unseals a chart, an address or an
 *     insurance number — that is enforced by the type of `SoloSpeakable`.
 *   - Every field revealed writes its own ledger row, so `disclosure_ledger`
 *     can say "four things were spoken aloud on Wednesday afternoon".
 *
 * `underSolo(...)` is the only builder in the codebase that can put a
 * protected value into speech. It is one grep away from an auditor.
 */

import type { Protected } from '../core/protected.js';
import { SOLO_WINDOW_CAPABILITY, revealUnderSoloWindow } from '../core/protected.js';
import type { Speakable, SpokenText } from '../core/spoken.js';
import { isProtected } from '../core/protected.js';
import type { Store } from './store.js';
import { nextId } from './store.js';
import type { PersonId, SoloWindow } from './types.js';

/** Five minutes. Stated in the spec, and short on purpose. */
export const SOLO_WINDOW_MS = 5 * 60 * 1000;

export function openSoloWindow(
    store: Store,
    askerId: PersonId,
    subjectId: PersonId,
    deviceSessionId: string
): SoloWindow {
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

export interface SoloSpeechContext {
    readonly store: Store;
    readonly window: SoloWindow;
    readonly tool: string;
}

export class SoloWindowExpired extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'SoloWindowExpired';
    }
}

/**
 * The escape hatch. Curried so it reads as a tagged template at the call site:
 *
 *     underSolo(ctx)`She took ${med.name} ${med.strength} at ${time}.`
 *
 * Re-checks liveness at the moment of speech — a window that expired between
 * the authorisation check and the sentence being built does not speak.
 */
export function underSolo(ctx: SoloSpeechContext) {
    return (strings: TemplateStringsArray, ...values: SoloSpeakable[]): SpokenText => {
        const now = ctx.store.clock.now();
        if (ctx.window.revokedAt !== null || ctx.window.expiresAt.getTime() <= now.getTime()) {
            throw new SoloWindowExpired(
                `solo window ${ctx.window.id} is no longer open (expired ${ctx.window.expiresAt.toISOString()})`
            );
        }

        let out = strings[0] ?? '';
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (isProtected(v)) {
                const box = v as Protected<string | number, 'private'>;
                out += String(revealUnderSoloWindow(box, SOLO_WINDOW_CAPABILITY));
                ctx.store.appendLedger({
                    subjectId: ctx.window.subjectId,
                    actorId: ctx.window.askerId,
                    tool: ctx.tool,
                    channel: 'solo-window',
                    what: box.label,
                    detail: `spoken aloud under solo window ${ctx.window.id}`
                });
            } else {
                out += String(v);
            }
            out += strings[i + 1] ?? '';
        }
        return out as SpokenText;
    };
}
