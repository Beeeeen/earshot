/**
 * LAYER 3 — the tripwire throws, and does NOT quietly repair.
 *
 * The claim under test, from src/core/protected.ts:
 *
 *   "Every other exit is guarded by `assertNoTaint()`, which scans for the
 *    marker and THROWS. It does not redact and it does not filter — silently
 *    repairing a leak is the theatre this project exists to avoid."
 *
 * So this suite proves two things about every guarded exit: that it throws,
 * and that nothing downstream of the throw contains a redacted-and-continued
 * version of the same string.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    LeakError,
    assertNoTaint,
    assertNoTaintDeep,
    joinSpoken,
    markerOf,
    priv,
    say,
    sealed,
    spokenError
} from './support/src.ts';

const DOSE = priv('Furosemide 40 mg', 'medication name', 'medication');

test('assertNoTaint throws a LeakError on a tainted string', () => {
    const text = `she took ${String(DOSE)} today`;
    assert.throws(
        () => assertNoTaint(text, 'unit'),
        (err: unknown) => {
            assert.ok(err instanceof LeakError);
            assert.equal((err as InstanceType<typeof LeakError>).name, 'LeakError');
            assert.equal((err as InstanceType<typeof LeakError>).where, 'unit');
            assert.deepEqual((err as InstanceType<typeof LeakError>).markers, [markerOf(DOSE)]);
            return true;
        }
    );
});

test('assertNoTaint passes clean text through untouched', () => {
    assert.doesNotThrow(() => assertNoTaint('Yes. Everything due so far today was taken, on time.', 'unit'));
    assert.doesNotThrow(() => assertNoTaint('', 'unit'));
});

test('assertNoTaint reports every marker it finds, not just the first', () => {
    const a = priv('a', 'l', 'c');
    const b = priv('b', 'l', 'c');
    try {
        assertNoTaint(`${String(a)} and ${String(b)}`, 'unit');
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof LeakError);
        assert.equal(err.markers.length, 2);
        assert.deepEqual([...err.markers].sort(), [markerOf(a), markerOf(b)].sort());
    }
});

test('the tripwire returns void on success — it has no repaired-string return value', () => {
    // A function that redacted would have to hand the caller a cleaned string.
    // `assertNoTaint` returns undefined, so there is no repaired value to use.
    assert.equal(assertNoTaint('clean', 'unit'), undefined);
});

test('say() throws rather than emitting a redacted sentence', () => {
    let spoken: string | undefined;
    assert.throws(() => {
        spoken = say`She took ${DOSE as unknown as string} this morning.`;
    }, LeakError);
    assert.equal(spoken, undefined, 'no sentence may be produced at all — not even a redacted one');
});

test('joinSpoken() throws rather than dropping the offending fragment', () => {
    const clean = say`Yes, taken.`;
    const dirty = `detail: ${String(DOSE)}` as unknown as ReturnType<typeof say>;
    assert.throws(() => joinSpoken(clean, dirty), LeakError);
});

test('the LeakError message names the location and the markers, and carries no plaintext', () => {
    try {
        say`dose ${DOSE as unknown as string}`;
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof LeakError);
        assert.ok(err.message.includes('say()'));
        assert.ok(err.message.includes(markerOf(DOSE)));
        assert.ok(!err.message.includes('Furosemide'), 'the error must not print the value it caught');
    }
});

test('spokenError refuses to launder a tainted message', () => {
    // The realistic misuse: a handler catches a LeakError and tries to speak
    // its message. The message contains markers, so the guard fires again.
    let caught: unknown;
    try {
        say`dose ${DOSE as unknown as string}`;
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof LeakError);
    assert.throws(() => spokenError(caught.message, 'check_adherence', 1), LeakError);
});

test('spokenError passes a clean refusal through', () => {
    const r = spokenError('I could not tell who is asking.', 'check_adherence', 3);
    assert.equal(r.isError, true);
    assert.deepEqual(r.content, [{ type: 'text', text: 'I could not tell who is asking.' }]);
});

test('assertNoTaintDeep flags a Protected held by reference, before it is ever stringified', () => {
    assert.throws(
        () => assertNoTaintDeep({ data: { dose: DOSE } }, 'envelope'),
        (err: unknown) => err instanceof LeakError && (err as InstanceType<typeof LeakError>).markers[0] === markerOf(DOSE)
    );
});

test('assertNoTaintDeep walks arrays, nested objects and object keys', () => {
    assert.throws(() => assertNoTaintDeep([1, 'ok', [{ x: String(DOSE) }]], 'envelope'), LeakError);
    assert.throws(() => assertNoTaintDeep({ [`k${String(DOSE)}`]: 'value' }, 'envelope'), LeakError);
    assert.doesNotThrow(() => assertNoTaintDeep({ a: [1, 2, 'clean'], b: { c: null } }, 'envelope'));
});

test('assertNoTaintDeep flags a sealed value too', () => {
    const s = sealed('BCBSCA-7742-118-903', 'insurance member number', 'identity');
    assert.throws(() => assertNoTaintDeep({ sealedRefs: [{ label: 'x', value: s }] }, 'envelope'), LeakError);
});

test('a thrown LeakError is not recoverable into a partially-cleaned result', () => {
    // Pin the "no quiet repair" claim end to end: after the throw, the caller
    // holds nothing. There is no API that returns the text minus the markers.
    const build = (): string => say`dose ${DOSE as unknown as string}`;
    let result: string | null = null;
    try {
        result = build();
    } catch {
        // deliberately empty
    }
    assert.equal(result, null);
});
