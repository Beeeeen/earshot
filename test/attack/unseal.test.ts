/**
 * ATTACK — get the plaintext out of a Protected without a capability.
 *
 * src/core/protected.ts, Layer 2:
 *   "The plaintext leaves this module through exactly two named functions."
 * and, in WHERE THE GUARANTEE DEGRADES:
 *   "There is no expression in TypeScript or JavaScript, short of importing
 *    one of the two named reveal functions, that turns a Protected<T> back
 *    into its plaintext."
 *
 * There is one, and it is short: `(p as any).unseal()`.
 *
 * `ProtectedValue#unseal()` is a public method on the prototype. Its comment
 * says "Only callable from this module", which is a comment, not a modifier.
 * `#payload` is genuinely private; `unseal` is the door next to it, unlocked.
 * The result carries no taint marker, so `say()` and the envelope tripwire
 * both pass it through, and it works on `sealed` values too — which no reveal
 * path allows.
 *
 * This is F0, the most severe finding in the review.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MARGARET, priv, say, sealed, toCallToolResult } from '../support/src.ts';
import { SARAH_ASKER, household } from '../support/harness.ts';

const MED = 'Furosemide';
const ADDRESS = '1184 Alameda de las Pulgas, Apt 3B, Burlingame CA 94010';

test(
    'FINDING F0: unseal() is a public prototype method and returns the plaintext',
    { todo: 'F0 — make the payload reachable only through the two capability-gated functions' },
    () => {
        const p = priv(MED, 'medication name', 'medication');
        const escaped = (p as unknown as { unseal(): string }).unseal();
        assert.notEqual(escaped, MED, `unseal() handed back the plaintext: ${escaped}`);
    }
);

test(
    'FINDING F0a: unseal() ignores the classification, so it opens sealed values too',
    { todo: 'F0 — sealed must never be unsealable outside the app' },
    () => {
        const s = sealed(ADDRESS, 'home address', 'identity');
        const escaped = (s as unknown as { unseal(): string }).unseal();
        assert.notEqual(escaped, ADDRESS, `unseal() opened a sealed value: ${escaped}`);
    }
);

test(
    'FINDING F0b: unseal() output reaches a spoken string, and no tripwire fires',
    { todo: 'F0 — this is a direct violation of the core invariant' },
    () => {
        const p = priv(MED, 'medication name', 'medication');
        // One cast, no import of a reveal function, no solo window.
        const spoken = say`She took ${(p as unknown as { unseal(): string }).unseal()} this morning.`;
        assert.ok(
            !spoken.includes(MED),
            `a protected value reached a spoken string with no error raised: ${JSON.stringify(spoken)}`
        );
    }
);

test(
    'FINDING F0c: an unsealed sealed value passes the envelope tripwire onto the MCP wire',
    { todo: 'F0 — the marker is the only thing the tripwire can see, and plaintext has none' },
    () => {
        const fx = household();
        const s = sealed(ADDRESS, 'home address', 'identity');
        const leaked = (s as unknown as { unseal(): string }).unseal();

        const wire = toCallToolResult(
            { spoken: say`Her address is ${leaked}.` },
            { store: fx.store, asker: SARAH_ASKER, subjectId: MARGARET, tool: 'care_summary', serverLatencyMs: 1 }
        );

        assert.ok(
            !JSON.stringify(wire).includes(ADDRESS),
            'the envelope shipped a sealed value: the tripwire only matches markers, and plaintext carries none'
        );
    }
);

test('the marker getter is also public, but discloses nothing', () => {
    // The sibling accessor. Public like `unseal`, but returning the marker is
    // exactly what `markerOf` is for, so this one is harmless — recorded so the
    // difference between the two is explicit rather than assumed.
    const p = priv(MED, 'medication name', 'medication');
    const marker = (p as unknown as { marker: string }).marker;
    assert.match(marker, /^⟦earshot:[0-9a-f]{16}⟧$/);
    assert.ok(!marker.includes(MED));
});

test('#payload itself remains genuinely unreachable', () => {
    // The ECMAScript private field does hold. The failure above is that a
    // public method hands out what the private field protects.
    const p = priv(MED, 'medication name', 'medication') as unknown as Record<string, unknown>;
    assert.equal(p['#payload'], undefined);
    assert.equal(Reflect.get(p, '#payload'), undefined);
    assert.deepEqual(Object.getOwnPropertyNames(p), ['label', 'category', 'classification']);
    assert.ok(!JSON.stringify(Object.getOwnPropertyDescriptors(p)).includes(MED));
});

test('a hand-built lookalike cannot unseal a real Protected', () => {
    // Guard against the obvious "fix" of moving unseal onto a subclass: an
    // attacker with the prototype but no instance state gets nothing.
    const real = priv(MED, 'medication name', 'medication');
    const proto = Object.getPrototypeOf(real) as { unseal(): string };
    const hollow = Object.create(proto) as { unseal(): string };
    assert.throws(() => hollow.unseal(), TypeError, 'a hollow instance has no private field to read');
});
