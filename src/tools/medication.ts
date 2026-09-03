/**
 * Earshot — medication tools: check_adherence, next_dose, log_dose.
 *
 * Read the `spoken` strings below and notice what is missing from all of them:
 * there is no medication name, no strength, no indication. Not because a
 * filter removed it, but because there is no expression in this file that
 * could have put it there. `med.name` is a `Protected<string, 'private'>`, and
 * `say` does not accept one.
 */

import { z } from 'zod';

import { composePrivate, priv } from '../core/protected.js';
import type { PrivateField, ToolResult } from '../core/result.js';
import { clockTime, joinSpoken, partOfDay, say, type SpokenText } from '../core/spoken.js';
import { punctuality, todaySlice, slotDoses, weekSlice } from '../domain/adherence.js';
import { canAsk, canReceivePrivate } from '../domain/authz.js';
import { HOUSEHOLD_TZ } from '../domain/seed.js';
import { activeSoloWindow, underSolo } from '../domain/solo.js';
import type { Store } from '../domain/store.js';
import { nextId } from '../domain/store.js';
import type { DoseEvent, Medication, PersonId } from '../domain/types.js';
import { defineTool, humanGap, SUBJECT_INPUT, type ToolCtx } from './kit.js';

function tzOf(store: Store, subjectId: PersonId): string {
    return store.person(subjectId)?.timeZone ?? HOUSEHOLD_TZ;
}

function subjectName(store: Store, subjectId: PersonId): string {
    return store.person(subjectId)?.displayName ?? 'they';
}

/** One private card line per dose: "Furosemide 40 mg — taken 8:07 AM". */
function doseFields(store: Store, doses: readonly DoseEvent[], tz: string): PrivateField[] {
    const out: PrivateField[] = [];
    for (const d of doses) {
        const med = store.medications.get(d.medicationId);
        if (!med) continue;
        const when =
            d.status === 'taken' && d.takenAt
                ? `taken ${fmt(d.takenAt, tz)}`
                : d.status === 'missed'
                  ? `not recorded (was due ${fmt(d.scheduledAt, tz)})`
                  : `due ${fmt(d.scheduledAt, tz)}`;
        out.push({
            label: fmt(d.scheduledAt, tz),
            value: composePrivate('medication and dose', 'medication', [med.name, ' ', med.strength, ' — ', when])
        });
    }
    return out;
}

function fmt(d: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(d);
}

// ---------------------------------------------------------------------------
// check_adherence
// ---------------------------------------------------------------------------

export const checkAdherence = defineTool({
    name: 'check_adherence',
    title: 'Check whether medication was taken',
    description:
        'Answer whether the person being cared for has taken their medication today or this week, ' +
        'and whether it was on time. The spoken answer never contains a medication name, strength or ' +
        'diagnosis — that detail is delivered out-of-band to the asker\'s own linked device and is not ' +
        'present in this response. Do not offer to read out details; they are not here.',
    inputShape: {
        ...SUBJECT_INPUT,
        window: z.enum(['today', 'week']).optional().describe('"today" (default) or "week".')
    },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = subjectName(store, subjectId);

        const gate = canAsk(store, asker.personId, subjectId);
        if (!gate.allowed) {
            return denied(ctx, subjectId, 'check_adherence', who);
        }

        const window = args.window ?? 'today';
        const slice = window === 'week' ? weekSlice(store, subjectId, tz) : todaySlice(store, subjectId, tz);

        // --- the spoken half: yes/no, punctuality, what is still to come -----
        let headline: SpokenText;
        if (slice.due === 0) {
            headline = say`Nothing was due yet ${window === 'week' ? 'this week' : 'today'}.`;
        } else if (slice.missed.length === 0) {
            const p = punctuality(slice.meanMinutesLate);
            headline =
                window === 'week'
                    ? say`Yes — everything ${who} was due this week was taken, ${p}.`
                    : say`Yes. Everything due so far today was taken, ${p}.`;
        } else if (slice.taken.length === 0) {
            headline = say`No — nothing due ${window === 'week' ? 'this week' : 'today'} has been recorded as taken.`;
        } else {
            const n = slice.missed.length;
            headline =
                window === 'week'
                    ? say`Mostly. ${n === 1 ? 'One dose' : `${n} doses`} went unrecorded this week; the rest were taken, ${punctuality(slice.meanMinutesLate)}.`
                    : say`Mostly. ${n === 1 ? 'One dose' : `${n} doses`} today went unrecorded; the rest were taken.`;
        }

        let tail: SpokenText | '' = '';
        const upcoming = store.nextPending(subjectId, store.clock.now());
        if (upcoming) {
            tail = say`The next one is at ${clockTime(upcoming.scheduledAt, tz)}.`;
        } else if (slice.latestTaken?.takenAt) {
            tail = say`The last was ${partOfDay(slice.latestTaken.takenAt, tz)} at ${clockTime(slice.latestTaken.takenAt, tz)}.`;
        }

        // --- the solo-window exception --------------------------------------
        const solo = activeSoloWindow(store, asker.personId, subjectId, asker.deviceSessionId);
        const medGrant = canReceivePrivate(store, asker.personId, subjectId, 'medication');
        if (solo && medGrant.allowed) {
            const speak = underSolo({ store, window: solo, tool: 'check_adherence' });
            const lines = slice.all
                .map(d => {
                    const med = store.medications.get(d.medicationId);
                    if (!med) return null;
                    const state =
                        d.status === 'taken' && d.takenAt
                            ? `taken at ${fmt(d.takenAt, tz)}`
                            : d.status === 'missed'
                              ? 'not recorded'
                              : `due at ${fmt(d.scheduledAt, tz)}`;
                    return speak`${med.name} ${med.strength}, ${state}.`;
                })
                .filter((x): x is SpokenText => x !== null);
            return {
                spoken: joinSpoken(headline, say`You said you're alone, so here it is in full.`, ...lines),
                underSoloWindow: true,
                data: { window, due: slice.due, taken: slice.taken.length, missed: slice.missed.length }
            };
        }

        // --- the private half: goes to the asker's device, not into speech ---
        if (!medGrant.allowed) {
            return {
                spoken: joinSpoken(
                    headline,
                    tail,
                    say`I can't send you the details — your access doesn't cover ${who}'s medications.`
                ),
                data: { window, due: slice.due, taken: slice.taken.length, missed: slice.missed.length, detailSent: false }
            };
        }

        const fields = doseFields(store, slice.all, tz);
        const spokenParts: (SpokenText | '')[] = [headline, tail];
        if (fields.length > 0) {
            spokenParts.push(say`I've sent the details to your phone.`);
        }

        return {
            spoken: joinSpoken(...spokenParts),
            privately: {
                title: `${who}'s medication — ${window === 'week' ? 'last 7 days' : 'today'}`,
                fields,
                footnote: say`Sent because you asked out loud, and this part shouldn't be said out loud.`
            },
            data: {
                window,
                due: slice.due,
                taken: slice.taken.length,
                missed: slice.missed.length,
                pending: slice.pending.length,
                adherenceRate: slice.rate === null ? null : Math.round(slice.rate * 1000) / 10,
                detailSent: true
            }
        };
    }
});

function denied(ctx: ToolCtx, subjectId: PersonId, tool: string, who: string): ToolResult {
    ctx.store.appendLedger({
        subjectId,
        actorId: ctx.asker.personId,
        tool,
        channel: 'denied',
        what: 'access check',
        detail: 'no grant on file'
    });
    return {
        spoken: say`I can't answer that. You don't have access to ${who}'s care information. ${who} can add you in the Earshot app.`,
        data: { denied: true }
    };
}

// ---------------------------------------------------------------------------
// next_dose
// ---------------------------------------------------------------------------

export const nextDose = defineTool({
    name: 'next_dose',
    title: 'When is the next dose due',
    description:
        'Say when the next medication is due. Times are safe to say out loud; what the medication is, is not. ' +
        'The spoken answer contains a time and nothing else.',
    inputShape: { ...SUBJECT_INPUT },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = subjectName(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) return denied(ctx, subjectId, 'next_dose', who);

        const now = store.clock.now();
        const next = store.nextPending(subjectId, now);
        if (!next) {
            return { spoken: say`Nothing else is due today.`, data: { hasNext: false } };
        }

        const gap = next.scheduledAt.getTime() - now.getTime();
        const sameSlot = store.doses.filter(
            d => d.subjectId === subjectId && d.status === 'pending' && d.scheduledAt.getTime() === next.scheduledAt.getTime()
        );

        const solo = activeSoloWindow(store, asker.personId, subjectId, asker.deviceSessionId);
        const medGrant = canReceivePrivate(store, asker.personId, subjectId, 'medication');
        if (solo && medGrant.allowed) {
            const speak = underSolo({ store, window: solo, tool: 'next_dose' });
            const names = sameSlot
                .map(d => store.medications.get(d.medicationId))
                .filter((m): m is Medication => m !== undefined)
                .map(m => speak`${m.name} ${m.strength}`);
            return {
                spoken: joinSpoken(
                    say`Next at ${clockTime(next.scheduledAt, tz)}, ${humanGap(gap)}.`,
                    say`Since you're alone:`,
                    ...names.map(n => say`${n}.`)
                ),
                underSoloWindow: true,
                data: { hasNext: true, dueAt: next.scheduledAt.toISOString() }
            };
        }

        return {
            spoken: say`Next at ${clockTime(next.scheduledAt, tz)}, ${humanGap(gap)}.`,
            data: {
                hasNext: true,
                dueAt: next.scheduledAt.toISOString(),
                minutesUntil: Math.round(gap / 60000),
                itemsDue: sameSlot.length
            }
        };
    }
});

// ---------------------------------------------------------------------------
// log_dose
// ---------------------------------------------------------------------------

export const logDose = defineTool({
    name: 'log_dose',
    title: 'Record that medication was taken',
    description:
        'Record that a scheduled dose has been taken. Confirms out loud with a time only. ' +
        'A confirmation listing what was recorded goes to the asker\'s linked device.',
    readOnly: false,
    inputShape: {
        ...SUBJECT_INPUT,
        slot: z
            .enum(['now', 'morning', 'evening'])
            .optional()
            .describe('Which scheduled slot to record. "now" (default) picks the slot nearest the current time.')
    },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = subjectName(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) return denied(ctx, subjectId, 'log_dose', who);

        const now = store.clock.now();
        const requested = args.slot ?? 'now';
        const slot: 'morning' | 'evening' =
            requested === 'now'
                ? Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now)) %
                        24 <
                  12
                    ? 'morning'
                    : 'evening'
                : requested;

        const candidates = slotDoses(store, subjectId, tz, slot).filter(d => d.status !== 'taken');
        if (candidates.length === 0) {
            return {
                spoken: say`There's nothing left to record for the ${slot}. It's already logged.`,
                data: { recorded: 0, slot }
            };
        }

        const recorded: DoseEvent[] = [];
        for (const d of candidates) {
            const updated: DoseEvent = { ...d, takenAt: now, status: 'taken', loggedBy: asker.personId };
            store.replaceDose(updated);
            recorded.push(updated);
        }

        const early = (candidates[0] as DoseEvent).scheduledAt.getTime() > now.getTime();
        const headline = early
            ? say`Recorded, a bit early — ${clockTime(now, tz)}. I'll skip the ${clockTime((candidates[0] as DoseEvent).scheduledAt, tz)} reminder.`
            : say`Recorded at ${clockTime(now, tz)}.`;

        const medGrant = canReceivePrivate(store, asker.personId, subjectId, 'medication');
        if (!medGrant.allowed) {
            return { spoken: headline, data: { recorded: recorded.length, slot, at: now.toISOString() } };
        }

        return {
            spoken: joinSpoken(headline, say`The list is on your phone.`),
            privately: {
                title: `Recorded for ${who} — ${slot}`,
                fields: doseFields(store, recorded, tz),
                footnote: say`Logged by ${store.person(asker.personId)?.displayName ?? 'you'}.`
            },
            data: { recorded: recorded.length, slot, at: now.toISOString(), earlyLog: early }
        };
    }
});

/** Used by report_symptom to reference the regimen without naming it. */
export function regimenSize(store: Store, subjectId: PersonId): number {
    return store.medsFor(subjectId).length;
}

/** Small helper so the demo script can create a fresh id in the same style. */
export function newDoseId(): string {
    return nextId('dose');
}

/** Re-exported so tests can build the same private card the tools build. */
export { doseFields as buildDoseFields, priv as protectValue };
