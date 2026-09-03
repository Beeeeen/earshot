/**
 * ATTACK — abuse the one sanctioned exception.
 *
 * src/domain/solo.ts promises the exception is "small, loud and auditable":
 *   5 minutes / one asker / one device / private only / a ledger row per field.
 *
 * Four of those five hold. The device-and-asker binding does not hold where it
 * matters, because it is enforced by `activeSoloWindow()` — a *lookup helper* —
 * and not by `underSolo()`, the thing that actually speaks. `underSolo` takes a
 * `SoloWindow` object and re-checks only expiry and revocation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DANA,
    MARGARET,
    SARAH,
    SOLO_WINDOW_MS,
    SoloWindowExpired,
    TOM,
    activeSoloWindow,
    canAsk,
    canReceivePrivate,
    checkAdherence,
    openSoloWindow,
    openSoloWindowTool,
    priv,
    underSolo
} from '../support/src.ts';
import { DANA_ASKER, SARAH_ASKER, TOM_ASKER, callTool, household } from '../support/harness.ts';

const VITALS = priv('BP 118/72, HR 74 irregular', 'latest vitals', 'vitals');
const DIAGNOSIS = priv('Congestive heart failure, NYHA class II', 'diagnosis', 'diagnosis');

// ---------------------------------------------------------------------------
// F4 — the binding is in the lookup, not in the escape hatch
// ---------------------------------------------------------------------------

test(
    'FINDING F4: underSolo speaks from a window belonging to another device',
    { todo: 'F4 — underSolo must take the asker and device and re-verify them' },
    () => {
        const fx = household();
        openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');

        // The lookup does its job: nothing is live for the bedroom Echo.
        assert.equal(activeSoloWindow(fx.store, SARAH, MARGARET, 'echo-bedroom'), undefined);

        // But the window object itself is in the store, and underSolo takes it.
        const anyWindow = fx.store.soloWindows[fx.store.soloWindows.length - 1];
        assert.ok(anyWindow);
        let spoken: string | undefined;
        assert.throws(
            () => {
                spoken = underSolo({ store: fx.store, window: anyWindow, tool: 'care_summary' })`${VITALS}`;
            },
            /device|window/i,
            `underSolo spoke a private value with no device check: ${JSON.stringify(spoken)}`
        );
    }
);

test(
    'FINDING F4a: underSolo never checks that the reader is the asker who declared solitude',
    { todo: 'F4 — Sarah\'s declaration must not unlock anything for Dana' },
    () => {
        const fx = household();
        const sarahWindow = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
        assert.equal(activeSoloWindow(fx.store, DANA, MARGARET, 'echo-kitchen'), undefined);

        // Nothing in the signature carries "who is reading this out".
        const spoken = underSolo({ store: fx.store, window: sarahWindow, tool: 'care_summary' })`${DIAGNOSIS}`;
        assert.ok(
            !spoken.includes('Congestive heart failure'),
            'underSolo has no parameter for the current asker, so it cannot tell Dana from Sarah'
        );
    }
);

test(
    'FINDING F4b: the ledger attributes the disclosure to the window owner, not the reader',
    { todo: 'F4 — a misattributed audit row is worse than no row' },
    () => {
        const fx = household();
        const sarahWindow = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
        const before = fx.store.ledger.length;

        // Dana's tool call, Sarah's window.
        underSolo({ store: fx.store, window: sarahWindow, tool: 'care_summary' })`${DIAGNOSIS}`;

        const row = fx.store.ledger[before];
        assert.equal(row?.actorId, DANA, `the ledger blamed ${row?.actorId} for a disclosure another account read`);
    }
);

// ---------------------------------------------------------------------------
// F4c — opening a window is not gated on the grant table at the domain level
// ---------------------------------------------------------------------------

test(
    'FINDING F4c: openSoloWindow itself accepts an asker with no grant at all',
    { todo: 'F4c — the domain function should refuse; today only the tool checks' },
    () => {
        const fx = household();
        assert.equal(canAsk(fx.store, TOM, MARGARET).allowed, false);

        assert.throws(
            () => openSoloWindow(fx.store, TOM, MARGARET, 'echo-porch'),
            /grant|access/i,
            'the neighbour opened a solo window over Margaret at the domain layer'
        );
    }
);

test(
    'FINDING F4d: a solo window ignores grant categories entirely',
    { todo: 'F4d — revealUnderSoloWindow checks classification but never the category or the viewer' },
    () => {
        const fx = household();
        // Dana is explicitly denied diagnosis.
        assert.equal(canReceivePrivate(fx.store, DANA, MARGARET, 'diagnosis').allowed, false);

        const danaWindow = openSoloWindow(fx.store, DANA, MARGARET, 'echo-bedroom');
        const spoken = underSolo({ store: fx.store, window: danaWindow, tool: 'care_summary' })`${DIAGNOSIS}`;

        assert.ok(
            !spoken.includes('Congestive heart failure'),
            'the escape hatch bypasses the whole grant table: any private value, any category'
        );
    }
);

// ---------------------------------------------------------------------------
// what holds — attacked properly, and it holds
// ---------------------------------------------------------------------------

test('DEFENDED: racing the expiry does not win — liveness is re-checked at speech time', () => {
    const fx = household();
    const win = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
    const speak = underSolo({ store: fx.store, window: win, tool: 'care_summary' });

    // Hold the builder across the boundary and fire it one millisecond late.
    fx.clock.advance(SOLO_WINDOW_MS);
    assert.throws(() => speak`${VITALS}`, SoloWindowExpired);

    // And a millisecond earlier, it still works — so this is a real boundary,
    // not a function that always throws.
    const fx2 = household();
    const win2 = openSoloWindow(fx2.store, SARAH, MARGARET, 'echo-kitchen');
    fx2.clock.advance(SOLO_WINDOW_MS - 1);
    assert.match(underSolo({ store: fx2.store, window: win2, tool: 't' })`${VITALS}`, /BP 118\/72/);
});

test('DEFENDED: a revoked window cannot be revived by advancing to a time inside its range', () => {
    const fx = household();
    const first = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
    openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen'); // supersedes the first
    assert.throws(() => underSolo({ store: fx.store, window: first, tool: 't' })`${VITALS}`, SoloWindowExpired);
});

test('DEFENDED: through the real tool, a second device gets no solo output', () => {
    const fx = household();
    callTool(fx, checkAdherence, {}, SARAH_ASKER); // warm the store

    // Sarah declares solitude in the kitchen...
    openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
    // ...and asks from the porch. The tool looks the window up by device.
    const fromPorch = { ...SARAH_ASKER, deviceSessionId: 'echo-porch' };
    const { out } = callTool(fx, checkAdherence, {}, fromPorch);

    assert.notEqual(out.underSoloWindow, true);
    assert.ok(!(out.spoken as string).includes('Furosemide'));
});

test('DEFENDED: through the real tool, another account gets no solo output', () => {
    const fx = household();
    openSoloWindow(fx.store, SARAH, MARGARET, 'echo-bedroom');
    const { out } = callTool(fx, checkAdherence, {}, { ...DANA_ASKER, deviceSessionId: 'echo-bedroom' });
    assert.notEqual(out.underSoloWindow, true);
    assert.ok(!(out.spoken as string).includes('Furosemide'));
});

test('DEFENDED: the real open_solo_window tool refuses someone with no grant', () => {
    const fx = household();
    const before = fx.store.soloWindows.length;

    const { out } = callTool(fx, openSoloWindowTool, {}, TOM_ASKER);
    assert.equal(out.data?.['denied'], true);
    assert.match(out.spoken as string, /don't have access/);
    assert.equal(fx.store.soloWindows.length, before, 'no window was created');
});

test('DEFENDED: the real open_solo_window tool binds to the asker and device from the token', () => {
    const fx = household();
    const { out } = callTool(fx, openSoloWindowTool, {}, SARAH_ASKER);
    const win = fx.store.soloWindows[fx.store.soloWindows.length - 1];

    assert.equal(out.data?.['open'], true);
    assert.equal(out.data?.['verified'], false, 'the tool says out loud that it cannot verify solitude');
    assert.equal(win?.askerId, SARAH_ASKER.personId);
    assert.equal(win?.deviceSessionId, SARAH_ASKER.deviceSessionId);
    assert.match(out.spoken as string, /I can't tell whether you're actually alone/);
});

test('DEFENDED: solo output still cannot contain a sealed value through the real tool', () => {
    const fx = household();
    openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
    const { out, wire } = callTool(fx, checkAdherence, {}, SARAH_ASKER);

    assert.equal(out.underSoloWindow, true);
    assert.ok((out.spoken as string).includes('Furosemide'), 'the exception really did fire');
    for (const secret of ['BCBSCA-7742-118-903', 'Alameda de las Pulgas', '41 pages']) {
        assert.ok(!JSON.stringify(wire).includes(secret));
    }
});

test('DEFENDED: every value spoken under a window leaves a ledger row', () => {
    const fx = household();
    openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
    const before = fx.store.ledger.filter(e => e.channel === 'solo-window').length;

    const { out } = callTool(fx, checkAdherence, {}, SARAH_ASKER);
    const rows = fx.store.ledger.filter(e => e.channel === 'solo-window');
    const revealed = rows.length - before - 1; // minus the envelope's own "spoken answer" row

    assert.ok(revealed > 0);
    assert.equal(
        revealed,
        2 * ((out.spoken as string).match(/mg|mEq/g)?.length ?? 0),
        'two ledger rows per dose line: one for the name, one for the strength'
    );
});
