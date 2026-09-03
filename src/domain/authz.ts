/**
 * Earshot — authorisation.
 *
 * Identity comes from the OAuth access token and nothing else. No voice print,
 * no device-id inference: the platform does not promise to give us either, so
 * we do not pretend to have them. See README "What Earshot does not do".
 *
 * Authorisation is an explicit grant table, set by the subject or their proxy.
 * The absence of a row is a denial, and the denial is *spoken* — telling
 * someone "you don't have access" is not itself a disclosure.
 */

import type { Store } from './store.js';
import type { GrantCategory, PersonId } from './types.js';

/**
 * Sentinel for "the transport gave us no session id".
 *
 * Everything else degrades gracefully without one; the solo window does not,
 * because a window that is not bound to one device is not a window. Tools that
 * depend on device identity refuse when they see this rather than treating all
 * devices as the same device.
 */
export const NO_DEVICE_SESSION = '__no-device-session__';

/** Who is asking, on which device (MCP session), about whom. */
export interface Asker {
    readonly personId: PersonId;
    readonly displayName: string;
    /** MCP session id. Stands in for "this one Echo in this one room". */
    readonly deviceSessionId: string;
    readonly scopes: readonly string[];
}

export interface Decision {
    readonly allowed: boolean;
    /** Safe to say out loud. Never contains the fact being protected. */
    readonly reason: string;
}

const ALLOW: Decision = { allowed: true, reason: 'granted' };

/**
 * May `viewer` receive `private`-class facts about `subject` in `category`,
 * over the out-of-band channel?
 */
export function canReceivePrivate(
    store: Store,
    viewerId: PersonId,
    subjectId: PersonId,
    category: GrantCategory
): Decision {
    const grant = store.grantFor(viewerId, subjectId);
    if (!grant) return { allowed: false, reason: 'no grant on file' };
    if (grant.level !== 'private') return { allowed: false, reason: 'grant covers spoken facts only' };
    if (!grant.categories.includes(category)) {
        return { allowed: false, reason: `grant does not cover ${category}` };
    }
    return ALLOW;
}

/**
 * May `viewer` ask about `subject` at all? Anyone with any grant may ask the
 * `spoken`-class questions: whether a dose was taken, when the next one is.
 */
export function canAsk(store: Store, viewerId: PersonId, subjectId: PersonId): Decision {
    if (viewerId === subjectId) return ALLOW;
    const grant = store.grantFor(viewerId, subjectId);
    if (!grant) return { allowed: false, reason: 'no grant on file' };
    return ALLOW;
}

/**
 * `sealed` is never granted through the grant table. There is no code path
 * that delivers it; the only answer is a pointer into the app.
 */
export function canReceiveSealed(): Decision {
    return { allowed: false, reason: 'sealed facts are only available in the Earshot app' };
}

/** Everyone who currently holds a grant over `subject`. Deliberately loud. */
export function viewersOf(store: Store, subjectId: PersonId): {
    person: { id: PersonId; displayName: string; relationship: string };
    level: 'spoken' | 'private';
    categories: readonly GrantCategory[];
}[] {
    return store
        .grantsForSubject(subjectId)
        .map(g => {
            const p = store.requirePerson(g.viewerId);
            return {
                person: { id: p.id, displayName: p.displayName, relationship: p.relationship },
                level: g.level,
                categories: g.categories
            };
        })
        .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName));
}
