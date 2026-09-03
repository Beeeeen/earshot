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
import type { Delivery, PersonId } from '../domain/types.js';

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
            what: f.value.label,
            detail: `sent to ${recipient.displayName}'s linked device, not spoken`
        });
    }
    for (const s of sealedRefs) {
        store.appendLedger({
            subjectId,
            actorId: recipientId,
            tool,
            channel: 'sealed-refused',
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
    what: string;
    reason: string;
}): void {
    args.store.appendLedger({
        subjectId: args.subjectId,
        actorId: args.actorId,
        tool: args.tool,
        channel: 'denied',
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
