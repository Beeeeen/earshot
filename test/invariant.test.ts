/**
 * LAYER 2 — "no plaintext escape route at runtime".
 *
 * src/core/protected.ts makes two distinct claims in its module doc, and this
 * suite keeps them apart on purpose, because they are not the same claim:
 *
 *   (a) The *stringification* paths — `toString`, `toJSON`, `valueOf`,
 *       `[Symbol.toPrimitive]`, `util.inspect` — return the taint marker.
 *       So `String(p)`, `p + ''`, `` `${p as any}` ``, `JSON.stringify(p)` and
 *       `console.log(p)` all yield the marker.
 *
 *   (b) The *reflective* paths — `Object.keys`, spread, `structuredClone`,
 *       `Object.getOwnPropertyDescriptors` — have no route to the payload.
 *       Note the claim is "no route to the payload", NOT "yields the marker".
 *       They yield the three public metadata fields and nothing else. See
 *       `reflection-yields-no-marker` at the bottom: that difference matters,
 *       because a reflected copy is invisible to the tripwire.
 */

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';

import { TAINT_PATTERN, isProtected, markerOf, priv, protect, sealed } from './support/src.ts';
import { captureStdout } from './support/harness.ts';

const SECRET = 'Furosemide 40 mg';
const NUMERIC_SECRET = 41;

function fresh() {
    return priv(SECRET, 'medication name', 'medication');
}

/** A marker is `⟦earshot:` + 16 hex + `⟧` and contains no part of the payload. */
function assertIsMarker(actual: string, secret: string = SECRET): void {
    assert.match(actual, /^⟦earshot:[0-9a-f]{16}⟧$/, `expected a bare taint marker, got ${JSON.stringify(actual)}`);
    assert.ok(!actual.includes(secret), 'marker must not contain the payload');
}

// ---------------------------------------------------------------------------
// (a) stringification paths yield the marker
// ---------------------------------------------------------------------------

test('String(p) yields the taint marker, not the plaintext', () => {
    assertIsMarker(String(fresh()));
});

test("p + '' yields the taint marker", () => {
    const p = fresh();
    const joined = (p as unknown as string) + '';
    assertIsMarker(joined);
});

test('template interpolation via `as any` yields the taint marker', () => {
    const p = fresh();
    const s = `${p as unknown as string}`;
    assertIsMarker(s);
});

test('JSON.stringify(p) yields the taint marker', () => {
    const raw = JSON.stringify(fresh());
    assert.equal(typeof raw, 'string');
    assertIsMarker(JSON.parse(raw as string) as string);
});

test('JSON.stringify of a structure containing p yields the marker in place of the value', () => {
    const p = fresh();
    const encoded = JSON.stringify({ card: { dose: p }, list: [p] });
    assert.ok(!encoded.includes(SECRET));
    const decoded = JSON.parse(encoded) as { card: { dose: string }; list: string[] };
    assertIsMarker(decoded.card.dose);
    assertIsMarker(decoded.list[0] as string);
});

test('util.inspect(p) yields the taint marker', () => {
    assertIsMarker(inspect(fresh()));
});

test('util.inspect at depth, inside a container, yields the marker', () => {
    const p = fresh();
    const text = inspect({ fields: [{ value: p }] }, { depth: 8 });
    assert.ok(!text.includes(SECRET), `inspect leaked: ${text}`);
    assert.match(text, TAINT_PATTERN);
});

test('console.log(p) writes the taint marker to stdout, never the plaintext', () => {
    const p = fresh();
    const written = captureStdout(() => {
        console.log(p);
        console.log('dose is %s', p);
        console.log({ nested: p });
    });
    assert.ok(!written.includes(SECRET), `console.log leaked: ${written}`);
    const markers = written.match(TAINT_PATTERN) ?? [];
    assert.equal(markers.length, 3, `expected three markers, got ${markers.length}: ${written}`);
});

test('valueOf and Symbol.toPrimitive both route to the marker', () => {
    const p = fresh() as unknown as { valueOf(): string; [Symbol.toPrimitive](hint: string): string };
    assertIsMarker(p.valueOf());
    for (const hint of ['string', 'number', 'default']) {
        assertIsMarker(p[Symbol.toPrimitive](hint));
    }
});

test('a numeric payload also stringifies to the marker, never to the number', () => {
    const p = protect(NUMERIC_SECRET, 'severity', 'symptom', 'private');
    const s = String(p);
    assert.match(s, /^⟦earshot:[0-9a-f]{16}⟧$/);
    assert.ok(!s.includes('41'));
    assert.ok(Number.isNaN(Number(p as unknown as number)));
});

test('the marker is per-instance, so two wrappings of the same value differ', () => {
    const a = fresh();
    const b = fresh();
    assert.notEqual(markerOf(a), markerOf(b));
    assert.equal(markerOf(a), String(a));
});

test('Symbol.toStringTag reports Protected, so a bare object print is identifiable', () => {
    assert.equal(Object.prototype.toString.call(fresh()), '[object Protected]');
});

// ---------------------------------------------------------------------------
// (b) reflective paths have no route to the payload
// ---------------------------------------------------------------------------

test('Object.keys exposes only the three public metadata fields', () => {
    assert.deepEqual(Object.keys(fresh()), ['label', 'category', 'classification']);
});

test('spread copies no payload', () => {
    const copy = { ...(fresh() as unknown as Record<string, unknown>) };
    assert.deepEqual(copy, { label: 'medication name', category: 'medication', classification: 'private' });
    assert.ok(!JSON.stringify(copy).includes(SECRET));
});

test('structuredClone copies no payload', () => {
    const clone = structuredClone(fresh() as unknown as Record<string, unknown>);
    assert.deepEqual(clone, { label: 'medication name', category: 'medication', classification: 'private' });
    assert.ok(!JSON.stringify(clone).includes(SECRET));
});

test('Object.getOwnPropertyDescriptors exposes no payload descriptor', () => {
    const d = Object.getOwnPropertyDescriptors(fresh() as unknown as object);
    assert.deepEqual(Object.keys(d), ['label', 'category', 'classification']);
    assert.ok(!JSON.stringify(Object.values(d)).includes(SECRET));
});

test('own symbol keys expose no payload either', () => {
    const syms = Object.getOwnPropertySymbols(fresh() as unknown as object);
    assert.deepEqual(syms, [], 'a Protected should carry no own symbol-keyed data');
});

test('the instance is frozen, so label and category cannot be swapped after the fact', () => {
    const p = fresh() as unknown as { label: string };
    assert.ok(Object.isFrozen(p));
    assert.throws(() => {
        'use strict';
        p.label = 'harmless';
    }, TypeError);
});

test('no accessor on the prototype leaks the payload by coercion', () => {
    // Every member JavaScript may invoke *implicitly* — getters, and the
    // coercion methods — must yield the marker or throw. `unseal` is excluded
    // here because nothing calls it implicitly; that it is callable at all is
    // F0, proven in test/attack/unseal.test.ts.
    const p = fresh();
    const proto = Object.getPrototypeOf(p) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || name === 'unseal') continue;
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (!d) continue;
        const produced: unknown[] = [];
        try {
            if (typeof d.get === 'function') produced.push(d.get.call(p));
            if (typeof d.value === 'function') produced.push((d.value as () => unknown).call(p));
        } catch {
            continue; // a throwing accessor discloses nothing
        }
        for (const v of produced) {
            assert.ok(
                typeof v !== 'string' || !v.includes(SECRET),
                `prototype member "${name}" returned the payload: ${String(v)}`
            );
        }
    }
});

test('the payload is not reachable under any guessable property name', () => {
    const p = fresh() as unknown as Record<string, unknown>;
    for (const guess of ['payload', 'value', 'secret', 'plaintext', '#payload', 'raw', 'inner']) {
        assert.equal(typeof p[guess], 'undefined', `"${guess}" should not be a property of a Protected`);
    }
});

/**
 * The honest boundary between (a) and (b), pinned as a test so nobody later
 * assumes reflection is tripwire-visible.
 *
 * A reflected copy carries the metadata but not the marker, so `assertNoTaint`
 * cannot see it. That is not a plaintext leak — the payload is gone — but it
 * does mean "everything that got past the type system carries a marker" is
 * true only of values that were *stringified*, not of values that were
 * *reflected over*. Reported as F13.
 */
test('reflection yields no marker, so a reflected copy is invisible to the tripwire', () => {
    const p = fresh();
    const clone = structuredClone(p as unknown as Record<string, unknown>);
    const spread = { ...(p as unknown as Record<string, unknown>) };

    assert.equal(String(clone), '[object Object]');
    assert.equal(String(spread), '[object Object]');
    assert.ok(!TAINT_PATTERN.test(JSON.stringify(clone)));
    assert.ok(!isProtected(clone), 'a clone is no longer a Protected, so assertNoTaintDeep will not flag it');
    assert.ok(!isProtected(spread));

    // ...and the payload is genuinely absent, which is the claim that matters.
    assert.ok(!JSON.stringify([clone, spread]).includes(SECRET));
});

test('a sealed value behaves identically at Layer 2', () => {
    const s = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');
    assertIsMarker(String(s), '1184 Alameda de las Pulgas');
    assertIsMarker(JSON.parse(JSON.stringify(s)) as string, '1184 Alameda de las Pulgas');
    assert.ok(!inspect(s).includes('Alameda'));
    assert.equal(s.classification, 'sealed');
});

test('isProtected identifies both classifications and rejects lookalikes', () => {
    assert.ok(isProtected(priv('x', 'l', 'c')));
    assert.ok(isProtected(sealed('x', 'l', 'c')));
    assert.ok(!isProtected({ label: 'l', category: 'c', classification: 'private' }));
    assert.ok(!isProtected('⟦earshot:0123456789abcdef⟧'));
    assert.ok(!isProtected(null));
    assert.ok(!isProtected(undefined));
});
