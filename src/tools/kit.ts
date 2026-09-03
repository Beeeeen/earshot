/** Earshot — shared tool plumbing. */

import { z } from 'zod';

import { assertNoTaint } from '../core/protected.js';
import type { ToolResult } from '../core/result.js';
import { say, type SpokenText } from '../core/spoken.js';
import type { Asker } from '../domain/authz.js';
import type { Store } from '../domain/store.js';
import { MARGARET } from '../domain/seed.js';
import type { PersonId } from '../domain/types.js';

export interface ToolCtx {
    readonly store: Store;
    readonly asker: Asker;
}

export interface EarshotTool {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputShape: z.ZodRawShape;
    readonly readOnly: boolean;
    /** Which subject this call is about. Used for the ledger and authz. */
    readonly subjectOf: (args: Record<string, unknown>) => PersonId;
    readonly run: (args: Record<string, unknown>, ctx: ToolCtx) => ToolResult;
}

/**
 * Register a tool.
 *
 * The metadata is scanned here, once, at construction. `tools/list` is read by
 * the model on every session and never passes through the envelope, so a
 * description built out of a protected value would reach the model outside any
 * tool call and outside every tripwire (F9). This is the only place that
 * metadata is built, so it is the place to check it.
 *
 * Note the limit, because it is the interesting half: a marker scan catches a
 * value that was *stringified* into the metadata. It cannot catch plaintext
 * that arrived some other way — that is what makes the vault in
 * core/protected.ts matter more than any additional tripwire.
 */
export function defineTool<S extends z.ZodRawShape>(t: {
    name: string;
    title: string;
    description: string;
    inputShape: S;
    readOnly?: boolean;
    run: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => ToolResult;
}): EarshotTool {
    assertNoTaint(t.name, 'defineTool.name');
    assertNoTaint(t.title, `defineTool(${t.name}).title`);
    assertNoTaint(t.description, `defineTool(${t.name}).description`);
    for (const [key, schema] of Object.entries(t.inputShape)) {
        assertNoTaint(key, `defineTool(${t.name}).inputShape key`);
        const described = (schema as { description?: unknown }).description;
        if (typeof described === 'string') {
            assertNoTaint(described, `defineTool(${t.name}).inputShape.${key}.description`);
        }
    }

    return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputShape: t.inputShape,
        readOnly: t.readOnly ?? true,
        subjectOf: args => resolveSubject(args['subject']),
        run: (args, ctx) => t.run(args as z.infer<z.ZodObject<S>>, ctx)
    };
}

/**
 * The demo household has one subject. Resolving by name keeps the tool
 * surface honest about being multi-subject without pretending to more than
 * the seed contains.
 *
 * Every tool body resolves `subject` through here, and so does `subjectOf`,
 * which is what the envelope records against. They used to disagree — the
 * bodies did a bare `String(args.subject).toLowerCase()` — so `" Mum"` filed a
 * ledger row against Margaret while the tool refused the caller, and the
 * audit trail and the answer described different events (F10).
 */
export function resolveSubject(raw: unknown): PersonId {
    if (typeof raw !== 'string' || raw.trim() === '') return MARGARET;
    const s = raw.trim().toLowerCase();
    if (s === 'mum' || s === 'mom' || s === 'margaret' || s === 'my mother' || s === 'me') return MARGARET;
    return s;
}

/** Shared optional `subject` input. */
export const SUBJECT_INPUT = {
    subject: z
        .string()
        .optional()
        .describe('Who the question is about. Defaults to the household member being cared for.')
};

/** A refusal that is safe to say out loud. Refusing is not a disclosure. */
export function refusal(reason: string): SpokenText {
    return say`${reason}`;
}

/** Turn "in 5 hours 55 minutes" into something a person would actually say. */
export function humanGap(ms: number): SpokenText {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return say`in under a minute`;
    if (mins < 60) return say`in ${mins} minutes`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (m === 0) return h === 1 ? say`in about an hour` : say`in about ${h} hours`;
    if (h === 1) return say`in about an hour and ${m} minutes`;
    return say`in about ${h} hours`;
}
