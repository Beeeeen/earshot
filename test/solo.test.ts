/**
 * The solo window — the single exception to the invariant.
 *
 * Claims under test, from src/domain/solo.ts:
 *   - 5 minutes, then gone;
 *   - one asker;
 *   - one device;
 *   - `private` only, never `sealed`;
 *   - every field revealed writes its own ledger row.
 *
 * The device/asker binding is asserted here against `activeSoloWindow`, which
 * is where it is actually enforced. That `underSolo` itself re-checks neither
 * is F4, proven in test/attack/solo-abuse.test.ts.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DANA,
    MARGARET,
    SARAH,
    SOLO_WINDOW_MS,
    SoloWindowExpired,
    activeSoloWindow,
    closeSoloWindow,
    openSoloWindow,
    priv,
    say,
    secondsRemaining,
    sealed,
    underSolo
} from './support/src.ts';
import { household } from './support/harness.ts';

const DEVICE = 'echo-kitchen';

test('a solo window lasts exactly five minutes', () => {
    const { store, clock } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);

    assert.equal(SOLO_WINDOW_MS, 5 * 60 * 1000);
    assert.equal(win.expiresAt.getTime() - win.openedAt.getTime(), SOLO_WINDOW_MS);
    assert.equal(secondsRemaining(store, win), 300);

    clock.advance(SOLO_WINDOW_MS - 1);
    assert.ok(activeSoloWindow(store, SARAH, MARGARET, DEVICE), 'still live one millisecond before expiry');

    clock.advance(1);
    assert.equal(activeSoloWindow(store, SARAH, MARGARET, DEVICE), undefined, 'gone at the expiry instant');
    assert.equal(secondsRemaining(store, win), 0);
});

test('a solo window is bound to one asker', () => {
    const { store } = household();
    openSoloWindow(store, SARAH, MARGARET, DEVICE);

    assert.ok(activeSoloWindow(store, SARAH, MARGARET, DEVICE));
    assert.equal(activeSoloWindow(store, DANA, MARGARET, DEVICE), undefined, "Sarah's window must not open anything for Dana");
    assert.equal(activeSoloWindow(store, MARGARET, MARGARET, DEVICE), undefined);
});

test('a solo window is bound to one device', () => {
    const { store } = household();
    openSoloWindow(store, SARAH, MARGARET, 'echo-kitchen');

    assert.ok(activeSoloWindow(store, SARAH, MARGARET, 'echo-kitchen'));
    assert.equal(
        activeSoloWindow(store, SARAH, MARGARET, 'echo-bedroom'),
        undefined,
        'a window opened on the kitchen Echo must not unlock the bedroom one'
    );
});

test('a solo window is bound to one subject', () => {
    const { store } = household();
    openSoloWindow(store, SARAH, MARGARET, DEVICE);
    assert.equal(activeSoloWindow(store, SARAH, 'someone-else', DEVICE), undefined);
});

test('opening a second window on the same device revokes the first', () => {
    const { store } = household();
    const first = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const second = openSoloWindow(store, SARAH, MARGARET, DEVICE);

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.revokedAt, null);
    assert.equal(second.revokedAt, null);
    assert.equal(activeSoloWindow(store, SARAH, MARGARET, DEVICE)?.id, second.id);
});

test('closing a window early takes effect immediately', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    closeSoloWindow(store, win);

    assert.notEqual(win.revokedAt, null);
    assert.equal(activeSoloWindow(store, SARAH, MARGARET, DEVICE), undefined);
    assert.throws(() => underSolo({ store, window: win, tool: 't' })`anything`, SoloWindowExpired);
});

test('underSolo speaks a protected value while the window is live', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const dose = priv('Furosemide 40 mg', 'medication name', 'medication');

    const spoken = underSolo({ store, window: win, tool: 'check_adherence' })`She took ${dose} at 8:07.`;
    assert.equal(spoken, 'She took Furosemide 40 mg at 8:07.');
});

test('underSolo writes one ledger row per protected field revealed', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const before = store.ledger.length;

    const name = priv('Furosemide', 'medication name', 'medication');
    const strength = priv('40 mg', 'dose', 'medication');
    underSolo({ store, window: win, tool: 'check_adherence' })`${name} ${strength}, taken at ${'8:07 AM'}.`;

    const rows = store.ledger.slice(before);
    assert.equal(rows.length, 2, 'two protected values interpolated, two rows — the plain string adds none');
    for (const row of rows) {
        assert.equal(row.channel, 'solo-window');
        assert.equal(row.actorId, SARAH);
        assert.equal(row.subjectId, MARGARET);
        assert.equal(row.tool, 'check_adherence');
        assert.match(row.detail, new RegExp(`solo window ${win.id}`));
    }
    assert.deepEqual(rows.map(r => r.what), ['medication name', 'dose']);
});

test('the ledger row names the kind of fact, never the fact', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const before = store.ledger.length;
    underSolo({ store, window: win, tool: 'care_summary' })`${priv('Furosemide', 'medication name', 'medication')}`;

    const row = store.ledger[before];
    assert.ok(row);
    assert.equal(row.what, 'medication name');
    assert.ok(!JSON.stringify(row).includes('Furosemide'));
});

test('opening a window is itself recorded in the ledger', () => {
    const { store } = household();
    const before = store.ledger.length;
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);

    const row = store.ledger[before];
    assert.ok(row);
    assert.equal(row.channel, 'solo-window');
    assert.equal(row.tool, 'open_solo_window');
    assert.equal(row.what, 'solo window opened');
    assert.match(row.detail, /5 minutes, this device only/);
    assert.ok(row.detail.includes(win.expiresAt.toISOString()));
});

test('underSolo re-checks liveness at the moment of speech, not at authorisation', () => {
    const { store, clock } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);

    // The tool authorised while the window was live...
    const speak = underSolo({ store, window: win, tool: 'check_adherence' });
    assert.ok(activeSoloWindow(store, SARAH, MARGARET, DEVICE));

    // ...and the window expired before the sentence was built.
    clock.advance(SOLO_WINDOW_MS);
    assert.throws(() => speak`${priv('Furosemide', 'medication name', 'medication')}`, SoloWindowExpired);
});

test('an expired window discloses nothing, not even a partial sentence', () => {
    const { store, clock } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    clock.advance(SOLO_WINDOW_MS + 1);
    const before = store.ledger.length;

    let spoken: string | undefined;
    assert.throws(() => {
        spoken = underSolo({ store, window: win, tool: 't' })`prefix ${priv('Furosemide', 'medication name', 'medication')} suffix`;
    }, SoloWindowExpired);

    assert.equal(spoken, undefined);
    assert.equal(store.ledger.length, before, 'no ledger row for a reveal that did not happen');
});

test('a solo window refuses a sealed value at runtime', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');

    assert.throws(
        () => underSolo({ store, window: win, tool: 'care_summary' })`${address as never}`,
        /refused sealed value "home address"/
    );
});

test('a sealed value refused mid-sentence writes no ledger row for it', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const before = store.ledger.length;

    assert.throws(() => {
        underSolo({ store, window: win, tool: 'care_summary' })`${priv('Furosemide', 'medication name', 'medication')} then ${sealed(
            'BCBSCA-7742-118-903',
            'insurance member number',
            'identity'
        ) as never}`;
    }, /refused sealed value/);

    const rows = store.ledger.slice(before);
    assert.equal(rows.length, 1, 'the private part was revealed and logged; the sealed part aborted the sentence');
    assert.equal(rows[0]?.what, 'medication name');
});

test('underSolo passes plain speakables through without a ledger row', () => {
    const { store } = household();
    const win = openSoloWindow(store, SARAH, MARGARET, DEVICE);
    const before = store.ledger.length;

    const spoken = underSolo({ store, window: win, tool: 't' })`Next at ${say`8:00 PM`}, in ${6} hours.`;
    assert.equal(spoken, 'Next at 8:00 PM, in 6 hours.');
    assert.equal(store.ledger.length, before);
});
