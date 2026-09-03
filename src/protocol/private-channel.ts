/**
 * Earshot — the second channel.
 *
 * This is the only module in the codebase that calls `revealToPrivateChannel`.
 * Everything it produces goes into `store.deliveries`, which is served by
 * `GET /inbox` — a different endpoint, authenticated with the *asker's own*
 * OAuth access token.
 *
 * WHY NOT `structuredContent`?
 *   Because the model reads the tool result. Putting the medication name in
 *   `structuredContent` and hoping the model does not narrate it is exactly
 *   the after-the-fact filtering this project exists to argue against. The MCP
 *   response carries a delivery receipt — an id, a count, a channel name — and
 *   nothing else. The payload never enters the model's context, so there is no
 *   prompt, jailbreak or "please just read it to me" that can extract it.
 */

import { PRIVATE_CHANNEL_CAPABILITY, revealToPrivateChannel } from '../core/protected.js';
import type { PrivatePayload, SealedRef } from '../core/result.js';
import type { Store } from '../domain/store.js';
import { nextId } from '../domain/store.js';
import { ALL_CATEGORIES, type Delivery, type LedgerCategory, type PersonId } from '../domain/types.js';

/**
 * A protected value's `category` is a plain string; the ledger wants one of
 * the known categories. An unrecognised one is recorded as `transparency`,
 * which no grant covers, so an unclassifiable row is visible to the subject
 * and to whoever caused it, and to nobody else. Fail closed, not open.
 */
function categoryOf(raw: string | undefined): LedgerCategory {
    return (ALL_CATEGORIES as readonly string[]).includes(raw ?? '') ? (raw as LedgerCategory) : 'transparency';
}

export interface DeliveryReceipt {
    readonly deliveryId: string;
    readonly fieldCount: number;
    readonly sealedCount: number;
    readonly channel: 'linked-device';
    readonly recipientDisplayName: string;
}

/**
 * Move a private payload onto the out-of-band channel and return only a
 * receipt. The receipt is safe to hand to the model.
 */
export function deliverPrivately(args: {
    store: Store;
    recipientId: PersonId;
    subjectId: PersonId;
    tool: string;
    payload: PrivatePayload;
    sealedRefs?: readonly SealedRef[];
}): DeliveryReceipt {
    const { store, recipientId, subjectId, tool, payload } = args;
    const recipient = store.requirePerson(recipientId);

    const fields = payload.fields.map(f => ({
        label: f.label,
        // The one authorised reveal. Nothing downstream of here is ever put
        // into an MCP response.
        value: revealToPrivateChannel(f.value, PRIVATE_CHANNEL_CAPABILITY)
    }));

    const sealedRefs = (args.sealedRefs ?? []).map(s => ({ label: s.label, appPath: s.appPath }));
    const sealedCategories = new Map((args.sealedRefs ?? []).map(s => [s.label, s.category]));

    const delivery: Delivery = {
        id: nextId('deliv'),
        recipientId,
        subjectId,
        createdAt: store.clock.now(),
        title: payload.title,
        tool,
        fields,
        sealedRefs,
        footnote: payload.footnote ?? null,
        readAt: null
    };
    store.deliveries.push(delivery);

    for (const f of payload.fields) {
        store.appendLedger({
            subjectId,
            actorId: recipientId,
            tool,
            channel: 'private-channel',
            // The row carries the category of the fact that moved, so a later
            // reader of the ledger is gated on the same grant that gated this
            // delivery. Hardcoding one category here was half of F3.
            category: categoryOf(f.value.category),
            what: f.value.label,
            // No display name: `actorId` says who, and whether a given reader
            // may be told who is decided when the row is rendered.
            detail: 'sent to a linked device, not spoken'
        });
    }
    for (const s of sealedRefs) {
        store.appendLedger({
            subjectId,
            actorId: recipientId,
            tool,
            channel: 'sealed-refused',
            category: categoryOf(sealedCategories.get(s.label)),
            what: s.label,
            detail: 'sealed: pointer to the app only, no value sent on any channel'
        });
    }

    return {
        deliveryId: delivery.id,
        fieldCount: fields.length,
        sealedCount: sealedRefs.length,
        channel: 'linked-device',
        recipientDisplayName: recipient.displayName
    };
}

/** Record that a private payload could NOT be delivered, and why. */
export function recordDenial(args: {
    store: Store;
    actorId: PersonId;
    subjectId: PersonId;
    tool: string;
    category: LedgerCategory;
    what: string;
    reason: string;
}): void {
    args.store.appendLedger({
        subjectId: args.subjectId,
        actorId: args.actorId,
        tool: args.tool,
        channel: 'denied',
        category: args.category,
        what: args.what,
        detail: args.reason
    });
}

/** JSON view of one person's inbox, for `GET /inbox`. Plaintext lives here. */
export function renderInbox(store: Store, personId: PersonId, markRead: boolean): unknown {
    const items = store.inboxFor(personId);
    const now = store.clock.now();
    const out = items.map(d => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        tool: d.tool,
        title: d.title,
        subject: store.person(d.subjectId)?.displayName ?? d.subjectId,
        fields: d.fields,
        sealed: d.sealedRefs,
        footnote: d.footnote,
        wasRead: d.readAt !== null
    }));
    if (markRead) {
        for (const d of items) if (d.readAt === null) d.readAt = now;
    }
    return { recipient: store.person(personId)?.displayName ?? personId, count: out.length, deliveries: out };
}
