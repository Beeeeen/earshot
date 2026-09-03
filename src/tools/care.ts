/**
 * Earshot — care tools: report_symptom, care_summary.
 *
 * `care_summary` is the clearest case in the codebase: everything it produces
 * is private, so its spoken half is a receipt and nothing more. The summary
 * itself is not in the MCP response at all — it is on the asker's device,
 * behind their own OAuth token.
 */

import { z } from 'zod';

import { composePrivate, priv } from '../core/protected.js';
import type { Notification, PrivateField, SealedRef, ToolResult } from '../core/result.js';
import { joinSpoken, say, type SpokenText } from '../core/spoken.js';
import { punctuality, weekSlice } from '../domain/adherence.js';
import { canAsk, canReceivePrivate } from '../domain/authz.js';
import { HOUSEHOLD_TZ } from '../domain/seed.js';
import { activeSoloWindow, underSolo } from '../domain/solo.js';
import { nextId, type Store } from '../domain/store.js';
import type { GrantCategory, PersonId, SymptomReport } from '../domain/types.js';
import { defineTool, SUBJECT_INPUT } from './kit.js';

function tzOf(store: Store, subjectId: PersonId): string {
    return store.person(subjectId)?.timeZone ?? HOUSEHOLD_TZ;
}
function nameOf(store: Store, id: PersonId): string {
    return store.person(id)?.displayName ?? id;
}
function fmt(d: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone
    }).format(d);
}

/** Everyone other than `exclude` who holds a grant covering `category`. */
function recipientsFor(store: Store, subjectId: PersonId, category: GrantCategory, exclude: PersonId): PersonId[] {
    return store
        .grantsForSubject(subjectId)
        .filter(g => g.viewerId !== exclude && g.level === 'private' && g.categories.includes(category))
        .map(g => g.viewerId)
        .filter(id => store.person(id)?.hasLinkedDevice === true);
}

// ---------------------------------------------------------------------------
// report_symptom
// ---------------------------------------------------------------------------

export const reportSymptom = defineTool({
    name: 'report_symptom',
    title: 'Record a symptom',
    description:
        'Record something the person is feeling, and notify the people who hold a grant for symptoms. ' +
        'The spoken confirmation says that it was recorded and who was told — never what was recorded. ' +
        'The description itself is delivered out-of-band and is not present in this response.',
    readOnly: false,
    inputShape: {
        ...SUBJECT_INPUT,
        description: z.string().min(1).describe('What the person reported, in their own words.'),
        severity: z.number().int().min(1).max(5).optional().describe('1 = barely noticeable, 5 = severe. Default 2.')
    },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = nameOf(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) {
            store.appendLedger({
                subjectId,
                actorId: asker.personId,
                tool: 'report_symptom',
                channel: 'denied',
                what: 'symptom report',
                detail: 'no grant on file'
            });
            return {
                spoken: say`I can't record that. You don't have access to ${who}'s care information.`,
                data: { denied: true }
            };
        }

        // HONESTY NOTE, and it belongs in the code rather than only the README:
        // `description` arrives as a plain string, which means the model has
        // already seen it — the user said it out loud, in the room, before any
        // of this ran. Earshot cannot unsay that. What it does control is
        // everything downstream: the moment the words land here they become
        // `Protected<string, 'private'>`, so they cannot be echoed back in the
        // confirmation, cannot appear in a later care_summary read aloud, and
        // cannot be recovered from the ledger. The invariant covers what
        // Earshot says, not what the user says.
        const severity = args.severity ?? 2;
        const report: SymptomReport = {
            id: nextId('sym'),
            subjectId,
            reportedBy: asker.personId,
            reportedAt: store.clock.now(),
            description: priv(args.description, 'symptom description', 'symptom'),
            severity: priv(severity, 'severity', 'symptom'),
            needsAttention: severity >= 3
        };
        store.symptoms.push(report);

        const card = (title: string): { title: string; fields: PrivateField[]; footnote: SpokenText } => ({
            title,
            fields: [
                { label: 'Reported', value: priv(fmt(report.reportedAt, tz), 'time reported', 'symptom') },
                { label: 'By', value: priv(nameOf(store, asker.personId), 'reporter', 'symptom') },
                { label: 'What', value: report.description },
                { label: 'Severity', value: composePrivate('severity', 'symptom', [report.severity, ' out of 5']) }
            ],
            footnote: say`Sent quietly. Nothing about this was said out loud.`
        });

        const others = recipientsFor(store, subjectId, 'symptom', asker.personId);
        const notify: Notification[] = others.map(id => ({
            recipientId: id,
            payload: card(`${who} reported something`)
        }));

        const names = others.map(id => nameOf(store, id));
        const told: SpokenText | '' =
            names.length === 0
                ? say`No one else has access to symptom reports right now.`
                : names.length === 1
                  ? say`${names[0] as string} has it on their phone.`
                  : say`${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string} have it on their phones.`;

        const urgency: SpokenText | '' = report.needsAttention
            ? say`I've marked it as something to look at.`
            : say``;

        const symptomGrant = canReceivePrivate(store, asker.personId, subjectId, 'symptom');
        const base: ToolResult = {
            spoken: joinSpoken(say`Noted.`, urgency, told),
            notify,
            data: {
                recorded: true,
                needsAttention: report.needsAttention,
                notified: names.length,
                at: report.reportedAt.toISOString()
            }
        };

        if (!symptomGrant.allowed) return base;
        return { ...base, privately: card(`Recorded for ${who}`) };
    }
});

// ---------------------------------------------------------------------------
// care_summary
// ---------------------------------------------------------------------------

export const careSummary = defineTool({
    name: 'care_summary',
    title: 'Full care summary (private channel only)',
    description:
        'Produce a full care summary for someone who holds a grant. NOTHING of the summary is in this ' +
        'response: it is delivered to the asker\'s own linked device, behind their own credentials. ' +
        'The spoken half is a receipt. There is no tool that will read this summary aloud.',
    inputShape: { ...SUBJECT_INPUT },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = nameOf(store, subjectId);

        const grant = store.grantFor(asker.personId, subjectId);
        if (!grant || grant.level !== 'private') {
            store.appendLedger({
                subjectId,
                actorId: asker.personId,
                tool: 'care_summary',
                channel: 'denied',
                what: 'care summary',
                detail: grant ? 'grant covers spoken facts only' : 'no grant on file'
            });
            return {
                spoken: say`I can't put that together for you. You don't have access to ${who}'s full picture.`,
                data: { denied: true }
            };
        }

        const has = (c: GrantCategory): boolean => grant.categories.includes(c);
        const fields: PrivateField[] = [];
        const week = weekSlice(store, subjectId, tz);

        fields.push({
            label: 'Adherence, last 7 days',
            value: priv(
                `${week.taken.length} of ${week.due} scheduled doses taken (${
                    week.rate === null ? 'n/a' : `${Math.round(week.rate * 1000) / 10}%`
                }), ${punctuality(week.meanMinutesLate)}`,
                'adherence summary',
                'medication'
            )
        });

        if (has('medication')) {
            for (const med of store.medsFor(subjectId)) {
                fields.push({
                    label: 'Medication',
                    value: composePrivate('medication', 'medication', [
                        med.name,
                        ' ',
                        med.strength,
                        ' — ',
                        med.schedule.join(' and '),
                        '. ',
                        med.instructions
                    ])
                });
            }
        }

        const clinical = store.clinical.get(subjectId);
        if (clinical) {
            if (has('diagnosis')) fields.push({ label: 'Diagnosis', value: clinical.diagnosis });
            if (has('clinician')) fields.push({ label: 'Prescriber', value: clinical.prescriber });
            if (has('vitals')) fields.push({ label: 'Latest vitals', value: clinical.lastVitals });
        }

        if (has('symptom')) {
            const recent = store.symptoms
                .filter(s => s.subjectId === subjectId)
                .sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime())
                .slice(0, 5);
            for (const s of recent) {
                fields.push({
                    label: `Symptom, ${fmt(s.reportedAt, tz)}`,
                    value: composePrivate('symptom', 'symptom', [s.description, ' (severity ', s.severity, '/5)'])
                });
            }
        }

        // Sealed facts are named but never sent. Not even here.
        const sealedFacts = store.sealed.get(subjectId);
        const sealedRefs: SealedRef[] = sealedFacts
            ? [
                  { label: sealedFacts.insuranceMemberId.label, category: 'identity', appPath: `/subject/${subjectId}/insurance` },
                  { label: sealedFacts.homeAddress.label, category: 'identity', appPath: `/subject/${subjectId}/contact` },
                  { label: sealedFacts.fullChartSummary.label, category: 'identity', appPath: `/subject/${subjectId}/chart` }
              ]
            : [];

        const withheld = (['medication', 'diagnosis', 'clinician', 'vitals', 'symptom'] as GrantCategory[]).filter(
            c => !has(c)
        );

        const solo = activeSoloWindow(store, asker.personId, subjectId, asker.deviceSessionId);
        if (solo) {
            // Even alone, sealed stays sealed. `underSolo` will not accept a
            // Protected<..., 'sealed'> — that is a compile error, not a policy.
            const speak = underSolo({ store, window: solo, tool: 'care_summary' });
            const lines: SpokenText[] = [];
            if (clinical && has('diagnosis')) lines.push(speak`Diagnosis: ${clinical.diagnosis}.`);
            if (clinical && has('vitals')) lines.push(speak`Latest vitals: ${clinical.lastVitals}.`);
            if (has('medication')) {
                for (const med of store.medsFor(subjectId)) lines.push(speak`${med.name} ${med.strength}.`);
            }
            return {
                spoken: joinSpoken(
                    say`You're alone, so I'll read it.`,
                    ...lines,
                    say`The insurance number, address and full chart stay in the app. Those never get read out.`
                ),
                sealedRefs,
                underSoloWindow: true,
                data: { fields: fields.length, sealed: sealedRefs.length }
            };
        }

        const withheldLine: SpokenText | '' =
            withheld.length === 0
                ? say``
                : say`Your access doesn't cover ${withheld.join(', ')}, so that isn't in it.`;

        return {
            spoken: joinSpoken(
                say`Sent — ${fields.length === 1 ? 'one item' : `${fields.length} items`} on your phone.`,
                withheldLine,
                say`The insurance number, address and full chart are app-only; I don't send those anywhere.`
            ),
            privately: {
                title: `${who} — care summary`,
                fields,
                footnote: say`Prepared for ${nameOf(store, asker.personId)}. Not said out loud.`
            },
            sealedRefs,
            data: { fields: fields.length, sealedPointers: sealedRefs.length, withheldCategories: withheld }
        };
    }
});
