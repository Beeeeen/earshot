/**
 * Earshot — transparency tools: who_can_see, disclosure_ledger, open_solo_window.
 *
 * These three are the ones that are *supposed* to be loud. Who has access to
 * your medical information is not a secret from you, and it should not require
 * a screen to find out. Likewise what has been said aloud in your living room.
 */

import { z } from 'zod';

import { priv } from '../core/protected.js';
import type { PrivateField, ToolResult } from '../core/result.js';
import { clockTime, joinSpoken, say, type SpokenText } from '../core/spoken.js';
import { addLocalDays, startOfLocalDay } from '../core/tz.js';
import { NO_DEVICE_SESSION, canAsk, viewersOf } from '../domain/authz.js';
import { HOUSEHOLD_TZ } from '../domain/seed.js';
import { SOLO_WINDOW_MS, activeSoloWindow, closeSoloWindow, openSoloWindow, secondsRemaining } from '../domain/solo.js';
import type { Store } from '../domain/store.js';
import type { LedgerChannel, PersonId } from '../domain/types.js';
import { defineTool, SUBJECT_INPUT } from './kit.js';

function tzOf(store: Store, subjectId: PersonId): string {
    return store.person(subjectId)?.timeZone ?? HOUSEHOLD_TZ;
}
function nameOf(store: Store, id: PersonId): string {
    return store.person(id)?.displayName ?? id;
}



// ---------------------------------------------------------------------------
// who_can_see
// ---------------------------------------------------------------------------

export const whoCanSee = defineTool({
    name: 'who_can_see',
    title: 'Who has access to this person’s information',
    description:
        'Say out loud who currently holds a grant over the person being cared for, and what each of them ' +
        'can see. This is deliberately speakable: knowing who can see your medical information is not ' +
        'itself a disclosure, and asking should not require a screen.',
    inputShape: { ...SUBJECT_INPUT },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const who = nameOf(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) {
            return {
                spoken: say`I can't tell you that. You don't have access to ${who}'s care information.`,
                data: { denied: true }
            };
        }

        const viewers = viewersOf(store, subjectId);
        if (viewers.length === 0) {
            return { spoken: say`Nobody has access to ${who}'s information right now.`, data: { count: 0 } };
        }

        const parts: SpokenText[] = viewers.map(v => {
            const self = v.person.id === asker.personId ? ' — that\'s you' : '';
            const scope =
                v.level === 'spoken'
                    ? 'only whether things were taken and when'
                    : v.categories.length >= 6
                      ? 'everything'
                      : // NOTE: reads slightly better as `humanList([...v.categories])`
                        // ("medication, schedule and symptom"), but test/authz.test.ts:219
                        // pins this exact string. Changing it needs a matching one-line
                        // edit there, and test/ is owned by another agent.
                        v.categories.join(' and ');
            return say`${v.person.displayName}, ${v.person.relationship}${self}: ${scope}.`;
        });

        const head = say`${viewers.length === 1 ? 'One person has' : `${viewers.length} people have`} access to ${who}'s information.`;
        const tail = say`${who} can change any of this in the Earshot app.`;

        return {
            spoken: joinSpoken(head, ...parts, tail),
            data: {
                count: viewers.length,
                viewers: viewers.map(v => `${v.person.displayName} (${v.level}: ${v.categories.join('/')})`)
            }
        };
    }
});

// ---------------------------------------------------------------------------
// disclosure_ledger
// ---------------------------------------------------------------------------

const CHANNEL_PHRASE: Record<LedgerChannel, string> = {
    spoken: 'said out loud',
    'private-channel': 'sent to a phone instead of being said',
    'sealed-refused': 'kept in the app and not sent anywhere',
    denied: 'refused because there was no access',
    'solo-window': 'said out loud while you told me you were alone'
};

export const disclosureLedger = defineTool({
    name: 'disclosure_ledger',
    title: 'What has been said, and what went quietly',
    description:
        'Report what Earshot has disclosed about this person and through which channel. The spoken half ' +
        'is counts; the itemised list goes to the asker\'s linked device.',
    inputShape: {
        ...SUBJECT_INPUT,
        since: z.enum(['today', 'week']).optional().describe('"today" (default) or "week".')
    },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = nameOf(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) {
            return {
                spoken: say`I can't tell you that. You don't have access to ${who}'s care information.`,
                data: { denied: true }
            };
        }

        const now = store.clock.now();
        const todayStart = startOfLocalDay(now, tz);
        const since = args.since === 'week' ? addLocalDays(todayStart, -6, tz) : todayStart;
        const rows = store.ledgerFor(subjectId, since);

        const counts: Record<LedgerChannel, number> = {
            spoken: 0,
            'private-channel': 0,
            'sealed-refused': 0,
            denied: 0,
            'solo-window': 0
        };
        for (const r of rows) counts[r.channel] += 1;

        const period = args.since === 'week' ? 'this week' : 'today';
        const clauses: SpokenText[] = [];
        if (counts.spoken > 0) clauses.push(say`${counts.spoken} answers out loud`);
        if (counts['private-channel'] > 0)
            clauses.push(say`${counts['private-channel']} things sent to a phone instead of being said`);
        if (counts['sealed-refused'] > 0) clauses.push(say`${counts['sealed-refused']} kept app-only`);
        if (counts.denied > 0) clauses.push(say`${counts.denied} refused for lack of access`);
        if (counts['solo-window'] > 0)
            clauses.push(say`${counts['solo-window']} said aloud while you'd told me you were alone`);

        const body: SpokenText =
            clauses.length === 0
                ? say`Nothing has been disclosed about ${who} ${period}.`
                : clauses.length === 1
                  ? say`${period === 'today' ? 'Today' : 'This week'}: ${clauses[0] as SpokenText}.`
                  : say`${period === 'today' ? 'Today' : 'This week'}: ${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1] as SpokenText}.`;

        const fields: PrivateField[] = rows.slice(0, 40).map(r => ({
            label: `${clockTime(r.at, tz)} · ${r.tool}`,
            value: priv(
                `${r.what} — ${CHANNEL_PHRASE[r.channel]} (${nameOf(store, r.actorId)}). ${r.detail}`,
                'ledger entry',
                'medication'
            )
        }));

        const privately =
            fields.length > 0
                ? {
                      privately: {
                          title: `${who} — disclosure ledger, ${period}`,
                          fields,
                          footnote: say`Append-only. Earshot cannot edit this.`
                      }
                  }
                : {};

        return {
            spoken: joinSpoken(body, fields.length > 0 ? say`The itemised list is on your phone.` : say``),
            ...privately,
            data: {
                period,
                total: rows.length,
                spoken: counts.spoken,
                privateChannel: counts['private-channel'],
                sealedRefused: counts['sealed-refused'],
                denied: counts.denied,
                soloWindow: counts['solo-window']
            }
        };
    }
});

// ---------------------------------------------------------------------------
// open_solo_window
// ---------------------------------------------------------------------------

export const openSoloWindowTool = defineTool({
    name: 'open_solo_window',
    title: 'Declare that you are alone',
    description:
        'The single exception to Earshot\'s rule. The user declares nobody else is in the room; for the ' +
        'next five minutes, on this device only, for this asker only, private detail may be said aloud. ' +
        'Earshot cannot verify the claim and does not pretend to. Every use is written to the ledger.',
    readOnly: false,
    inputShape: {
        ...SUBJECT_INPUT,
        close: z.boolean().optional().describe('Set true to close an open window early ("never mind").')
    },
    run: (args, ctx): ToolResult => {
        const { store, asker } = ctx;
        const subjectId = args.subject ? String(args.subject).toLowerCase() : 'margaret';
        const tz = tzOf(store, subjectId);
        const who = nameOf(store, subjectId);

        if (!canAsk(store, asker.personId, subjectId).allowed) {
            return {
                spoken: say`I can't do that. You don't have access to ${who}'s care information.`,
                data: { denied: true }
            };
        }

        // Fail closed. A solo window that cannot be pinned to one device would
        // unlock every device in the house at once, which is the opposite of
        // what the user asked for.
        if (asker.deviceSessionId === NO_DEVICE_SESSION) {
            store.appendLedger({
                subjectId,
                actorId: asker.personId,
                tool: 'open_solo_window',
                channel: 'denied',
                what: 'solo window',
                detail: 'no device session id from the transport; cannot bind the window to one device'
            });
            return {
                spoken: say`I can't do that here. I can only open a solo window when I can tell which device you're on, and right now I can't.`,
                data: { open: false, reason: 'no-device-session' }
            };
        }

        const existing = activeSoloWindow(store, asker.personId, subjectId, asker.deviceSessionId);

        if (args.close === true) {
            if (!existing) return { spoken: say`There's no solo window open.`, data: { open: false } };
            closeSoloWindow(store, existing);
            store.appendLedger({
                subjectId,
                actorId: asker.personId,
                tool: 'open_solo_window',
                channel: 'solo-window',
                what: 'solo window closed early',
                detail: `closed by ${nameOf(store, asker.personId)}`
            });
            return { spoken: say`Closed. Back to normal.`, data: { open: false } };
        }

        if (existing) {
            const left = secondsRemaining(store, existing);
            return {
                spoken: say`Already open — ${left} more seconds, on this device.`,
                data: { open: true, secondsRemaining: left, expiresAt: existing.expiresAt.toISOString() }
            };
        }

        const win = openSoloWindow(store, asker.personId, subjectId, asker.deviceSessionId);
        return {
            spoken: joinSpoken(
                say`Alright. For the next five minutes, on this device, I'll say the details out loud.`,
                say`It closes at ${clockTime(win.expiresAt, tz)}. Say "never mind" to close it sooner.`,
                say`I can't tell whether you're actually alone — I'm taking your word for it, and I'm writing it down.`
            ),
            data: {
                open: true,
                windowId: win.id,
                expiresAt: win.expiresAt.toISOString(),
                secondsRemaining: Math.round(SOLO_WINDOW_MS / 1000),
                device: asker.deviceSessionId,
                verified: false
            }
        };
    }
});
