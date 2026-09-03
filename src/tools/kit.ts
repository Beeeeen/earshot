/** Earshot — shared tool plumbing. */

import { z } from 'zod';

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

export function defineTool<S extends z.ZodRawShape>(t: {
    name: string;
    title: string;
    description: string;
    inputShape: S;
    readOnly?: boolean;
    run: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => ToolResult;
}): EarshotTool {
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
