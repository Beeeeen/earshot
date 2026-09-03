/**
 * The two audited reveal paths.
 *
 * Claims under test, from src/core/protected.ts:
 *   - each reveal function requires its own capability token;
 *   - a caller who does not hold one cannot manufacture one;
 *   - `sealed` values are refused (the docstrings say "at the type level";
 *     the code also refuses at runtime, and that runtime refusal is what a
 *     test can actually prove, so that is what is asserted here).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    PRIVATE_CHANNEL_CAPABILITY,
    RevealCapability,
    SOLO_WINDOW_CAPABILITY,
    composePrivate,
    priv,
    revealToPrivateChannel,
    revealUnderSoloWindow,
    sealed
} from './support/src.ts';

const MED = priv('Furosemide', 'medication name', 'medication');
const ADDRESS = sealed('1184 Alameda de las Pulgas, Apt 3B, Burlingame CA 94010', 'home address', 'identity');

test('revealToPrivateChannel returns the plaintext with the right capability', () => {
    assert.equal(revealToPrivateChannel(MED, PRIVATE_CHANNEL_CAPABILITY), 'Furosemide');
});

test('revealUnderSoloWindow returns the plaintext with the right capability', () => {
    assert.equal(revealUnderSoloWindow(MED, SOLO_WINDOW_CAPABILITY), 'Furosemide');
});

test('the two capabilities are not interchangeable', () => {
    assert.throws(
        () => revealToPrivateChannel(MED, SOLO_WINDOW_CAPABILITY),
        /revealToPrivateChannel: wrong capability/
    );
    assert.throws(
        () => revealUnderSoloWindow(MED, PRIVATE_CHANNEL_CAPABILITY),
        /revealUnderSoloWindow: wrong capability/
    );
});

test('a forged capability object is rejected by both reveal paths', () => {
    const forgeries: unknown[] = [
        {},
        { ok: true },
        Object.create(RevealCapability.prototype) as object,
        null,
        undefined,
        'PRIVATE_CHANNEL_CAPABILITY'
    ];
    for (const fake of forgeries) {
        assert.throws(
            () => revealToPrivateChannel(MED, fake as InstanceType<typeof RevealCapability>),
            /wrong capability/,
            `revealToPrivateChannel accepted ${JSON.stringify(fake)}`
        );
        assert.throws(
            () => revealUnderSoloWindow(MED, fake as InstanceType<typeof RevealCapability>),
            /wrong capability/,
            `revealUnderSoloWindow accepted ${JSON.stringify(fake)}`
        );
    }
});

test('RevealCapability cannot be constructed without the module-private guard', () => {
    for (const guess of [undefined, null, {}, Symbol('earshot.reveal.guard'), Symbol.for('earshot.reveal.guard')]) {
        assert.throws(
            () => new RevealCapability(guess as never),
            /RevealCapability is not constructible/,
            `constructed with ${String(guess)}`
        );
    }
});

test('the guard symbol is not reachable through the global symbol registry', () => {
    // `CAPABILITY_GUARD` is `Symbol(...)`, not `Symbol.for(...)`, so
    // `Symbol.for` cannot recover it. Pinned because switching one for the
    // other would silently make the guard forgeable.
    assert.throws(() => new RevealCapability(Symbol.for('earshot.reveal.guard') as never));
});

test('revealToPrivateChannel refuses a sealed value at runtime', () => {
    assert.throws(
        () => revealToPrivateChannel(ADDRESS as never, PRIVATE_CHANNEL_CAPABILITY),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /refused sealed value "home address"/);
            assert.ok(!err.message.includes('Alameda'), 'the refusal must not quote the value');
            return true;
        }
    );
});

test('revealUnderSoloWindow refuses a sealed value at runtime', () => {
    assert.throws(
        () => revealUnderSoloWindow(ADDRESS as never, SOLO_WINDOW_CAPABILITY),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /refused sealed value "home address"/);
            assert.ok(!err.message.includes('Alameda'));
            return true;
        }
    );
});

test('the sealed refusal fires before the capability is even consulted... it does not', () => {
    // Ordering matters for the error a caller sees: the capability is checked
    // first, so a wrong-capability call on a sealed value reports the
    // capability, not the classification. Pinned so the message stays stable.
    assert.throws(
        () => revealToPrivateChannel(ADDRESS as never, SOLO_WINDOW_CAPABILITY),
        /wrong capability/
    );
});

test('composePrivate builds a private value without the parts ever leaving as plaintext', () => {
    const strength = priv('40 mg', 'dose', 'medication');
    const composed = composePrivate('medication and dose', 'medication', [MED, ' ', strength, ' — taken 8:07 AM']);

    assert.equal(composed.classification, 'private');
    assert.equal(composed.label, 'medication and dose');
    assert.equal(composed.category, 'medication');
    assert.match(String(composed), /^⟦earshot:[0-9a-f]{16}⟧$/);
    assert.equal(
        revealToPrivateChannel(composed, PRIVATE_CHANNEL_CAPABILITY),
        'Furosemide 40 mg — taken 8:07 AM'
    );
});

test('composePrivate accepts plain scalars alongside protected parts', () => {
    const severity = priv(4, 'severity', 'symptom');
    const composed = composePrivate('severity', 'symptom', [severity, ' out of 5']);
    assert.equal(revealToPrivateChannel(composed, PRIVATE_CHANNEL_CAPABILITY), '4 out of 5');
});
