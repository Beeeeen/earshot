/** Seed determinism, the grant table, and the solo window's five-minute floor. */

import { DEMO_INSTANT, FixedClock } from '../core/clock.js';
import { priv } from '../core/protected.js';
import { todaySlice, weekSlice } from '../domain/adherence.js';
import { NO_DEVICE_SESSION, canAsk, canReceivePrivate, viewersOf } from '../domain/authz.js';
import { openSoloWindowTool } from '../tools/index.js';
import { DANA, HOUSEHOLD_TZ, MARGARET, SARAH, TOM, seedHousehold } from '../domain/seed.js';
import { SOLO_WINDOW_MS, activeSoloWindow, closeSoloWindow, openSoloWindow, underSolo } from '../domain/solo.js';
import { assert, check, equal, excludes, group, includes, throws } from './harness.js';

export async function run(): Promise<void> {
    group('demo household');

    await check('the seeded household loads deterministically', () => {
        const a = seedHousehold(new FixedClock(DEMO_INSTANT));
        const b = seedHousehold(new FixedClock(DEMO_INSTANT));
        equal(a.doses.length, b.doses.length, 'dose count must be reproducible');
        const key = (s: typeof a): string =>
            s.doses.map(d => `${d.medicationId}@${d.scheduledAt.toISOString()}=${d.status}`).join('|');
        equal(key(a), key(b), 'the full dose ledger must be byte-identical across seeds');
    });

    await check('the dose history is generated, not hardcoded', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        // 5 medications, 7 dose-slots per day, 7 days.
        equal(s.medications.size, 5, 'five medications');
        const perDay = [...s.medications.values()].reduce((n, m) => n + m.schedule.length, 0);
        equal(perDay, 7, 'seven scheduled doses per day');
        equal(s.doses.length, perDay * 7, 'seven days of history');
    });

    await check('adherence arithmetic adds up (due = taken + missed)', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const w = weekSlice(s, MARGARET, HOUSEHOLD_TZ);
        equal(w.due, w.taken.length + w.missed.length, 'due must equal taken + missed');
        equal(w.all.length, w.due + w.pending.length, 'every dose is taken, missed or pending');
        assert(w.rate !== null && w.rate > 0.9 && w.rate < 1, `week adherence should be high but imperfect, got ${w.rate}`);
        equal(w.missed.length, 2, 'the seeded pattern misses exactly two doses in the week');
    });

    await check('at the demo instant, the morning is done and the evening is pending', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const t = todaySlice(s, MARGARET, HOUSEHOLD_TZ);
        equal(t.missed.length, 0, 'nothing missed today');
        equal(t.taken.length, 4, 'four morning doses taken');
        equal(t.pending.length, 3, 'three evening doses still pending');
    });

    group('grant table');

    await check('Tom the neighbour has an account and no grant', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        assert(s.person(TOM) !== undefined, 'Tom must exist as an account');
        equal(s.grantFor(TOM, MARGARET), undefined, 'Tom must have no grant row');
        equal(canAsk(s, TOM, MARGARET).allowed, false, 'Tom must not be able to ask');
    });

    await check('Sarah may receive private medication and diagnosis facts', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        assert(canReceivePrivate(s, SARAH, MARGARET, 'medication').allowed, 'Sarah: medication');
        assert(canReceivePrivate(s, SARAH, MARGARET, 'diagnosis').allowed, 'Sarah: diagnosis');
    });

    await check('Dana the aide may see medications but not the diagnosis', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        assert(canReceivePrivate(s, DANA, MARGARET, 'medication').allowed, 'Dana: medication is granted');
        equal(canReceivePrivate(s, DANA, MARGARET, 'diagnosis').allowed, false, 'Dana: diagnosis is not granted');
        equal(canReceivePrivate(s, DANA, MARGARET, 'clinician').allowed, false, 'Dana: prescriber is not granted');
        includes(canReceivePrivate(s, DANA, MARGARET, 'diagnosis').reason, 'diagnosis', 'the refusal must say what is missing');
    });

    await check('no grant can be at sealed level, in the data or in the type', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        // Grant.level is typed `'spoken' | 'private'`. `'sealed'` is not one of
        // the options, so a sealed grant cannot be written down at all. This
        // check confirms the seeded rows agree with that type.
        for (const g of s.grants) {
            assert(g.level === 'spoken' || g.level === 'private', `unexpected grant level: ${String(g.level)}`);
        }
        equal(s.grants.length, 3, 'three grants, all below sealed');
    });

    await check('who-can-see enumerates exactly the granted viewers', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const v = viewersOf(s, MARGARET);
        equal(v.length, 3, 'Margaret, Sarah and Dana hold grants');
        assert(!v.some(x => x.person.id === TOM), 'Tom must not appear');
    });

    group('solo window');

    await check('a solo window opens for five minutes exactly', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const s = seedHousehold(clock);
        const w = openSoloWindow(s, SARAH, MARGARET, 'device-A');
        equal(w.expiresAt.getTime() - w.openedAt.getTime(), SOLO_WINDOW_MS, 'must be 5 minutes');
        equal(SOLO_WINDOW_MS, 300_000, 'five minutes is 300000 ms');
    });

    await check('a solo window expires on its own', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const s = seedHousehold(clock);
        openSoloWindow(s, SARAH, MARGARET, 'device-A');
        assert(activeSoloWindow(s, SARAH, MARGARET, 'device-A') !== undefined, 'open at t+0');
        clock.advance(4 * 60_000);
        assert(activeSoloWindow(s, SARAH, MARGARET, 'device-A') !== undefined, 'still open at t+4min');
        clock.advance(61_000);
        equal(activeSoloWindow(s, SARAH, MARGARET, 'device-A'), undefined, 'closed at t+5min01s');
    });

    await check('a solo window is bound to one device', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        assert(activeSoloWindow(s, SARAH, MARGARET, 'kitchen-echo') !== undefined, 'open on the kitchen device');
        equal(activeSoloWindow(s, SARAH, MARGARET, 'bedroom-echo'), undefined, 'not open on the bedroom device');
    });

    await check('a solo window is bound to one asker', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        equal(activeSoloWindow(s, DANA, MARGARET, 'kitchen-echo'), undefined, "Sarah's window is not Dana's");
    });

    await check('closing early revokes it immediately', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const w = openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        closeSoloWindow(s, w);
        equal(activeSoloWindow(s, SARAH, MARGARET, 'kitchen-echo'), undefined, 'must be closed');
    });

    await check('opening a second window on a device supersedes the first', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const first = openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        assert(first.revokedAt !== null, 'the first window must be revoked');
    });

    await check('underSolo speaks a private value and writes one ledger row per field', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const s = seedHousehold(clock);
        const w = openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        const before = s.ledger.length;
        const name = priv('Furosemide', 'medication name', 'medication');
        const strength = priv('40 mg', 'dose', 'medication');
        const spoken = underSolo({ store: s, window: w, tool: 'test' })`She took ${name} ${strength}.`;
        includes(spoken, 'Furosemide 40 mg', 'a solo window really does speak the value');
        equal(s.ledger.length - before, 2, 'one ledger row per revealed field');
        assert(
            s.ledger.slice(before).every(e => e.channel === 'solo-window'),
            'solo rows must be marked as such'
        );
        excludes(
            s.ledger.slice(before).map(e => `${e.what} ${e.detail}`).join(' '),
            'Furosemide',
            'the ledger records the kind of fact, never the fact'
        );
    });

    await check('underSolo refuses to speak after the window expires', async () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const s = seedHousehold(clock);
        const w = openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        const speak = underSolo({ store: s, window: w, tool: 'test' });
        clock.advance(SOLO_WINDOW_MS + 1000);
        const name = priv('Furosemide', 'medication name', 'medication');
        await throws(() => speak`She took ${name}.`, 'SoloWindowExpired', 'an expired window must not speak');
    });

    await check('underSolo refuses to speak after an early close', async () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const s = seedHousehold(clock);
        const w = openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        const speak = underSolo({ store: s, window: w, tool: 'test' });
        closeSoloWindow(s, w);
        const name = priv('Furosemide', 'medication name', 'medication');
        await throws(() => speak`She took ${name}.`, 'SoloWindowExpired', 'a revoked window must not speak');
    });

    await check('a solo window refuses to open when the transport gives no device id', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const asker = {
            personId: SARAH,
            displayName: 'Sarah',
            deviceSessionId: NO_DEVICE_SESSION,
            scopes: ['solo.open']
        };
        const out = openSoloWindowTool.run({}, { store, asker });
        includes(out.spoken, "can't do that here", 'it must refuse, not silently unlock every device');
        equal(store.soloWindows.length, 0, 'and no window is created');
        assert(
            store.ledger.some(e => e.channel === 'denied' && e.tool === 'open_solo_window'),
            'the refusal is on the record'
        );
    });

    await check('opening a solo window is itself written to the ledger', () => {
        const s = seedHousehold(new FixedClock(DEMO_INSTANT));
        const before = s.ledger.length;
        openSoloWindow(s, SARAH, MARGARET, 'kitchen-echo');
        equal(s.ledger.length - before, 1, 'opening must be recorded');
        equal(s.ledger[s.ledger.length - 1]?.channel, 'solo-window', 'recorded on the solo-window channel');
    });
}
