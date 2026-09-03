/**
 * Earshot — the single exit from the domain to the wire.
 *
 * Every tool result passes through `toCallToolResult`. This is the one place
 * where the invariant is enforced at runtime, and it enforces it by throwing.
 *
 * What leaves over MCP:
 *   - the spoken sentence
 *   - a delivery receipt (an id and a count), if a private payload was routed
 *     to the asker's own device
 *   - pointers into the app for sealed facts (label only, never a value)
 *   - the server-side latency for this call
 *
 * What never leaves over MCP: any protected value, in any form. The private
 * payload is handed to src/protocol/private-channel.ts, which writes it to a
 * different endpoint entirely. Nothing in this file can read a protected
 * value — it does not hold a reveal capability.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { assertNoTaint, assertNoTaintDeep } from '../core/protected.js';
import type { ToolResult } from '../core/result.js';
import type { Asker } from '../domain/authz.js';
import type { Store } from '../domain/store.js';
import type { PersonId } from '../domain/types.js';
import { ledgerCategoryOf } from '../tools/scopes.js';
import { deliverPrivately } from './private-channel.js';
import { LATENCY_BUDGET_MS, round } from './timing.js';

/** Shared output schema for all eight tools. */
export const EARSHOT_OUTPUT_SHAPE = {
    spoken: z.string().describe('The complete answer, as it should be said out loud. This is all you get.'),
    channel: z
        .enum(['spoken-only', 'spoken+private-delivery', 'spoken+app-pointer', 'spoken-under-solo-window'])
        .describe('Which channels this answer used.'),
    privateDelivery: z
        .object({
            deliveryId: z.string(),
            fieldCount: z.number(),
            recipient: z.string(),
            channel: z.literal('linked-device')
        })
        .nullable()
        .describe(
            'Receipt for detail sent out-of-band to the asker\'s own device. The detail itself is NOT in this response and cannot be retrieved by any tool.'
        ),
    notifiedOthers: z
        .array(z.object({ recipient: z.string(), deliveryId: z.string(), fieldCount: z.number() }))
        .describe('People other than the asker who received an out-of-band copy, because they hold a grant.'),
    sealedPointers: z
        .array(z.object({ label: z.string(), appPath: z.string() }))
        .describe('Facts that exist but are not delivered on any channel. Only openable in the Earshot app.'),
    underSoloWindow: z.boolean().describe('True if the asker declared they are alone and private facts were spoken.'),
    serverLatencyMs: z.number().describe('Wall time inside this tool handler, milliseconds.'),
    data: z.record(z.string(), z.unknown()).nullable().describe('Non-sensitive structured mirror of the spoken answer.'),
    note: z.string().nullable().describe('Guidance for the assistant about what it may and may not say.')
};

/**
 * The output schema is metadata: it reaches the model through `tools/list`,
 * outside every tool call and outside the envelope's own scans. It is built
 * from string literals here, so this can only fire if someone edits one of
 * them into a protected value — which is exactly the edit worth catching.
 * Same reasoning as the metadata scan in tools/kit.ts (F9).
 */
for (const [key, schema] of Object.entries(EARSHOT_OUTPUT_SHAPE)) {
    assertNoTaint(key, 'EARSHOT_OUTPUT_SHAPE key');
    const described = (schema as { description?: unknown }).description;
    if (typeof described === 'string') assertNoTaint(described, `EARSHOT_OUTPUT_SHAPE.${key}.description`);
}

export interface EnvelopeContext {
    readonly store: Store;
    readonly asker: Asker;
    readonly subjectId: PersonId;
    readonly tool: string;
    readonly serverLatencyMs: number;
}

const NOTE_PRIVATE =
    'The detail is not in this response. It was sent to the asker\'s own device. ' +
    'Say only the `spoken` field. Do not offer to read out details you do not have — you do not have them.';
const NOTE_SEALED =
    'A sealed fact was requested. There is no value in this response and no tool can produce one. ' +
    'Say only the `spoken` field.';
const NOTE_SOLO =
    'The asker opened a solo window, so private detail is included in `spoken` on purpose. ' +
    'This was recorded in the disclosure ledger.';

export function toCallToolResult(r: ToolResult, ctx: EnvelopeContext): CallToolResult {
    // --- the tripwire ------------------------------------------------------
    // Any protected value that was cast past the type system carries a taint
    // marker. We throw. We do not redact: a leak that is quietly repaired is a
    // leak nobody ever learns about.
    assertNoTaint(r.spoken, `${ctx.tool}.spoken`);
    if (r.data) assertNoTaintDeep(r.data, `${ctx.tool}.data`);
    if (r.sealedRefs) assertNoTaintDeep(r.sealedRefs, `${ctx.tool}.sealedRefs`);

    // --- everything below this line commits or none of it does --------------
    // The deliveries and the ledger rows used to be written before the final
    // deep scan, so a failure after the first delivery left it in the store
    // while src/server.ts answered "Nothing was disclosed." — which was then
    // false (F11). The two arrays are the only mutable state this function
    // touches, so a length reset is a complete rollback.
    const deliveriesBefore = ctx.store.deliveries.length;
    const ledgerBefore = ctx.store.ledger.length;
    try {
        return commit(r, ctx);
    } catch (err) {
        ctx.store.deliveries.length = deliveriesBefore;
        ctx.store.ledger.length = ledgerBefore;
        throw err;
    }
}

function commit(r: ToolResult, ctx: EnvelopeContext): CallToolResult {
    // --- route the private half to the other channel ------------------------
    let receipt: { deliveryId: string; fieldCount: number; recipient: string; channel: 'linked-device' } | null = null;
    if (r.privately && r.privately.fields.length > 0) {
        const d = deliverPrivately({
            store: ctx.store,
            recipientId: ctx.asker.personId,
            subjectId: ctx.subjectId,
            tool: ctx.tool,
            payload: r.privately,
            ...(r.sealedRefs ? { sealedRefs: r.sealedRefs } : {})
        });
        receipt = {
            deliveryId: d.deliveryId,
            fieldCount: d.fieldCount,
            recipient: d.recipientDisplayName,
            channel: 'linked-device'
        };
    }

    // --- deliveries to third parties who hold a grant (e.g. symptom alerts) --
    const notified: { recipient: string; deliveryId: string; fieldCount: number }[] = [];
    for (const n of r.notify ?? []) {
        if (n.payload.fields.length === 0) continue;
        const d = deliverPrivately({
            store: ctx.store,
            recipientId: n.recipientId,
            subjectId: ctx.subjectId,
            tool: ctx.tool,
            payload: n.payload
        });
        notified.push({ recipient: d.recipientDisplayName, deliveryId: d.deliveryId, fieldCount: d.fieldCount });
    }

    const sealedPointers = (r.sealedRefs ?? []).map(s => ({ label: s.label, appPath: s.appPath }));
    const solo = r.underSoloWindow === true;

    const channel = solo
        ? ('spoken-under-solo-window' as const)
        : receipt || notified.length > 0
          ? ('spoken+private-delivery' as const)
          : sealedPointers.length > 0
            ? ('spoken+app-pointer' as const)
            : ('spoken-only' as const);

    // Everything said aloud is on the record.
    ctx.store.appendLedger({
        subjectId: ctx.subjectId,
        actorId: ctx.asker.personId,
        tool: ctx.tool,
        channel: solo ? 'solo-window' : 'spoken',
        category: ledgerCategoryOf(ctx.tool),
        what: 'spoken answer',
        detail: `${r.spoken.length} characters said aloud`
    });

    const structured = {
        spoken: r.spoken as string,
        channel,
        privateDelivery: receipt,
        notifiedOthers: notified,
        sealedPointers,
        underSoloWindow: solo,
        serverLatencyMs: round(ctx.serverLatencyMs),
        data: (r.data ?? null) as Record<string, unknown> | null,
        note: solo
            ? NOTE_SOLO
            : receipt || notified.length > 0
              ? NOTE_PRIVATE
              : sealedPointers.length > 0
                ? NOTE_SEALED
                : null
    };

    // Belt and braces: the whole outgoing object, not just the spoken string.
    assertNoTaintDeep(structured, `${ctx.tool}.structuredContent`);

    return {
        content: [{ type: 'text', text: r.spoken as string }],
        structuredContent: structured,
        _meta: {
            'earshot/serverLatencyMs': round(ctx.serverLatencyMs),
            'earshot/latencyBudgetMs': LATENCY_BUDGET_MS,
            'earshot/withinBudget': ctx.serverLatencyMs <= LATENCY_BUDGET_MS
        }
    };
}

/** An error the assistant may say out loud. Errors are never sensitive here. */
export function spokenError(message: string, tool: string, latencyMs: number): CallToolResult {
    assertNoTaint(message, `${tool}.error`);
    return {
        isError: true,
        content: [{ type: 'text', text: message }],
        _meta: { 'earshot/serverLatencyMs': round(latencyMs) }
    };
}
