/**
 * Layer 2 and Layer 3 of the guarantee, exercised for real.
 *
 * Layer 1 (the compile errors) is proved by src/negative/ and checked by
 * negative.check.ts. These are the runtime properties: that there is no
 * stringification path back to the plaintext, and that the tripwire throws.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import {
    LeakError,
    PRIVATE_CHANNEL_CAPABILITY,
    RevealCapability,
    SOLO_WINDOW_CAPABILITY,
    assertNoTaint,
    assertNoTaintDeep,
    composePrivate,
    isProtected,
    markerOf,
    priv,
    revealToPrivateChannel,
    revealUnderSoloWindow,
    sealed
} from '../core/protected.js';
import { say } from '../core/spoken.js';
import { assert, check, equal, excludes, group, includes, throws } from './harness.js';

const SECRET = 'Furosemide-40mg-CHF';

export async function run(): Promise<void> {
    group('protected values');

    const p = priv(SECRET, 'medication name', 'medication');
    // `as any` throughout: every one of these is a deliberate attempt to
    // launder the value past the type system. That is the point.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const anyP = p as any;

    await check('String(protected) yields a taint marker, not the value', () => {
        const s = String(anyP);
        excludes(s, SECRET, 'String() must not expose the payload');
        includes(s, '⟦earshot:', 'String() must yield the taint marker');
    });

    await check('template interpolation of a cast protected value yields a marker', () => {
        const s = `she took ${anyP}`;
        excludes(s, SECRET, 'template literal must not expose the payload');
        includes(s, '⟦earshot:', 'template literal must yield the taint marker');
    });

    await check('string concatenation yields a marker', () => {
        excludes(anyP + '', SECRET, 'concatenation must not expose the payload');
    });

    await check('JSON.stringify of a protected value yields a marker', () => {
        excludes(JSON.stringify(anyP), SECRET, 'toJSON must not expose the payload');
    });

    await check('JSON.stringify of an object containing one yields a marker', () => {
        excludes(JSON.stringify({ med: anyP, nested: { deep: [anyP] } }), SECRET, 'nested serialisation must not leak');
    });

    await check('object spread does not copy the payload', () => {
        excludes(JSON.stringify({ ...anyP }), SECRET, 'spread must not expose the payload');
    });

    await check('Object.keys / getOwnPropertyNames do not expose the payload', () => {
        excludes(Object.keys(anyP).join(','), SECRET, 'enumerable keys must not leak');
        excludes(Object.getOwnPropertyNames(anyP).join(','), SECRET, 'own property names must not leak');
        excludes(JSON.stringify(Object.getOwnPropertyDescriptors(anyP)), SECRET, 'descriptors must not leak');
    });

    await check('util.inspect / console.log does not expose the payload', () => {
        excludes(inspect(anyP, { depth: 10, showHidden: true }), SECRET, 'inspect must not leak');
    });

    await check('structuredClone does not carry the payload', () => {
        let text: string;
        try {
            text = JSON.stringify(structuredClone(anyP));
        } catch {
            text = '(structuredClone refused)';
        }
        excludes(text, SECRET, 'structuredClone must not leak');
    });

    await check('the protected wrapper is frozen', () => {
        assert(Object.isFrozen(anyP), 'protected values must be frozen');
    });

    await check('the taint marker is stable and unique per value', () => {
        const q = priv(SECRET, 'medication name', 'medication');
        equal(markerOf(p), markerOf(p), 'marker must be stable for one value');
        assert(markerOf(p) !== markerOf(q), 'two protected values must not share a marker');
    });

    await check('isProtected recognises wrapped values and rejects plain ones', () => {
        assert(isProtected(p), 'isProtected must recognise a wrapped value');
        assert(!isProtected(SECRET), 'isProtected must reject a plain string');
        assert(!isProtected({ label: 'fake' }), 'isProtected must reject a look-alike object');
    });

    group('the tripwire');

    await check('assertNoTaint throws on a marker', async () => {
        await throws(() => assertNoTaint(`she took ${anyP}`, 'test'), 'LeakError', 'a marker must trip the wire');
    });

    await check('assertNoTaint passes clean text', () => {
        assertNoTaint('Yes, taken at 8:07 AM.', 'test');
    });

    await check('assertNoTaintDeep finds a protected value nested in an object', async () => {
        await throws(
            () => assertNoTaintDeep({ a: [{ b: p }] }, 'test'),
            'LeakError',
            'a nested protected value must trip the wire'
        );
    });

    await check('assertNoTaintDeep finds a marker in a nested string', async () => {
        await throws(() => assertNoTaintDeep({ a: [`x ${anyP}`] }, 'test'), 'LeakError', 'nested marker must trip');
    });

    await check('say() throws if a marker reaches it through a cast', async () => {
        await throws(() => say`she took ${String(anyP)}`, 'LeakError', 'say must refuse tainted input');
    });

    await check('LeakError names the marker but never the payload', async () => {
        let e: unknown;
        try {
            assertNoTaint(`x ${anyP}`, 'test');
        } catch (err) {
            e = err;
        }
        assert(e instanceof LeakError, 'expected a LeakError');
        excludes((e as LeakError).message, SECRET, 'the error message itself must not leak');
        includes((e as LeakError).message, '⟦earshot:', 'the error must name the marker');
    });

    group('reveal capabilities');

    await check('revealToPrivateChannel returns the payload with the right capability', () => {
        equal(revealToPrivateChannel(p, PRIVATE_CHANNEL_CAPABILITY), SECRET, 'the private channel must be able to read');
    });

    await check('revealToPrivateChannel refuses the solo-window capability', async () => {
        await throws(
            () => revealToPrivateChannel(p, SOLO_WINDOW_CAPABILITY),
            'wrong capability',
            'capabilities must not be interchangeable'
        );
    });

    await check('revealUnderSoloWindow refuses the private-channel capability', async () => {
        await throws(
            () => revealUnderSoloWindow(p, PRIVATE_CHANNEL_CAPABILITY),
            'wrong capability',
            'capabilities must not be interchangeable'
        );
    });

    await check('RevealCapability cannot be constructed from outside', async () => {
        await throws(
            () => new (RevealCapability as unknown as new (g: unknown) => unknown)(Symbol('guess')),
            'not constructible',
            'the capability constructor must be guarded'
        );
    });

    await check('a sealed value is refused by both reveal paths at runtime too', async () => {
        const s = sealed('BCBSCA-7742-118-903', 'insurance member number', 'identity');
        await throws(
            () => revealToPrivateChannel(s as never, PRIVATE_CHANNEL_CAPABILITY),
            'refused sealed',
            'sealed must not travel on the private channel even when cast'
        );
        await throws(
            () => revealUnderSoloWindow(s as never, SOLO_WINDOW_CAPABILITY),
            'refused sealed',
            'sealed must not be speakable even when cast'
        );
    });

    group('the vault');

    await check('unseal() is a tombstone: it returns a redaction, never the payload', () => {
        const secret = priv(SECRET, 'medication name', 'medication');
        const door = secret as unknown as { unseal(): string };
        const out = door.unseal();
        excludes(out, SECRET, 'the public unseal() door must not hand back the payload');
        includes(out, 'withheld', 'and it should say what it is withholding');
        // ...and it does not fabricate a marker either, so nothing downstream
        // mistakes a redaction for a leak.
        excludes(out, '\u27e6earshot:', 'a redaction is not a taint marker');
    });

    await check('unseal() opens a sealed value no more than a private one', () => {
        const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');
        const out = (address as unknown as { unseal(): string }).unseal();
        excludes(out, 'Alameda', 'a sealed payload must not come back out of any public method');
    });

    await check('the payload is not an own property, a symbol key or a descriptor', () => {
        const secret = priv(SECRET, 'medication name', 'medication') as unknown as object;
        equal(Object.getOwnPropertyNames(secret).join(','), 'label,category,classification', 'three metadata fields only');
        equal(Object.getOwnPropertySymbols(secret).length, 0, 'no own symbol-keyed data');
        excludes(JSON.stringify(Object.getOwnPropertyDescriptors(secret)), SECRET, 'no descriptor carries the payload');
    });

    await check('a reveal capability appears only at its definition site and its two sanctioned callers', () => {
        // The tokens are module exports, so the language does not enforce
        // "held by these two only" (finding F2, documented in the module doc
        // of core/protected.ts). What CAN be enforced is that no third module
        // in the shipped tree quietly acquires one, and this check fails the
        // suite when one does. The self-test and the compile fixtures are
        // excluded: neither ships, and both exist to exercise these very
        // functions.
        // Resolve the *source* tree, not wherever this file is running from:
        // the self-test runs out of dist/, whose .d.ts files would otherwise
        // be scanned instead of the code they describe.
        let root = dirname(fileURLToPath(import.meta.url));
        while (!existsSync(join(root, 'package.json'))) {
            const up = dirname(root);
            assert(up !== root, 'could not find the repository root from the self-test');
            root = up;
        }
        const srcRoot = join(root, 'src');
        const allowed = new Set(['core/protected.ts', 'protocol/private-channel.ts', 'domain/solo.ts']);
        const skip = ['selftest', 'negative'];

        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) {
                    if (skip.includes(entry)) continue;
                    out.push(...walk(full));
                } else if (/\.m?ts$/.test(entry)) {
                    out.push(full);
                }
            }
            return out;
        };

        const holders = walk(srcRoot)
            .filter(f => /PRIVATE_CHANNEL_CAPABILITY|SOLO_WINDOW_CAPABILITY/.test(readFileSync(f, 'utf8')))
            .map(f => relative(srcRoot, f).replace(/\\/g, '/'))
            .sort();

        for (const f of holders) {
            assert(allowed.has(f), `${f} holds a reveal capability; only ${[...allowed].join(', ')} may`);
        }
        assert(holders.length === allowed.size, `expected ${allowed.size} holders, found ${holders.length}: ${holders.join(', ')}`);
    });

    group('composition inside the vault');

    await check('composePrivate returns a protected value, not a string', () => {
        const strength = priv('40 mg', 'dose', 'medication');
        const composed = composePrivate('medication and dose', 'medication', [p, ' ', strength]);
        assert(isProtected(composed), 'composition must stay protected');
        excludes(String(composed as unknown as string), SECRET, 'composition must not stringify to the payload');
        equal(
            revealToPrivateChannel(composed, PRIVATE_CHANNEL_CAPABILITY),
            `${SECRET} 40 mg`,
            'composition must preserve the parts for the private channel'
        );
    });
    await check('composePrivate refuses a sealed part at runtime, not only at compile time', async () => {
        const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');
        await throws(
            () => composePrivate('note', 'medication', [address as never]),
            'refused sealed',
            'a composition must not launder a sealed value into a private one'
        );
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
