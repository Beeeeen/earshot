/**
 * ATTACK — launder a classification, then walk the result out through a path
 * that is allowed to speak.
 *
 * This is the Blindfold shape. In Blindfold, four individually-permitted
 * filters narrowed a cohort to one person and an ungrouped aggregate walked
 * around the k-anonymity check. Here the equivalent is `composePrivate`: a
 * *permitted composition* that re-labels its inputs and, in doing so, launders
 * a `sealed` value into a `private` one — after which every downstream check
 * sees a well-formed private value and waves it through.
 *
 * Both reveal functions have a runtime classification check:
 *     if (box.classification !== 'private') throw ...
 * `composePrivate` has none. The asymmetry is the bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    SARAH,
    composePrivate,
    deliverPrivately,
    openSoloWindow,
    priv,
    renderInbox,
    revealToPrivateChannel,
    say,
    sealed,
    underSolo
} from '../support/src.ts';
import { household } from '../support/harness.ts';

const ADDRESS = '1184 Alameda de las Pulgas, Apt 3B, Burlingame CA 94010';
const INSURANCE = 'BCBSCA-7742-118-903';

/** How a future tool author reaches this: an `unknown`-typed value, or one cast. */
function launder(sealedValue: unknown) {
    return composePrivate('note', 'medication', [sealedValue as never]);
}

test(
    'FINDING F1: composePrivate has no runtime classification check, so sealed becomes private',
    { todo: 'F1 — mirror the reveal functions: throw on a non-private part' },
    () => {
        const address = sealed(ADDRESS, 'home address', 'identity');
        let laundered: ReturnType<typeof composePrivate> | null = null;
        assert.throws(
            () => {
                laundered = launder(address);
            },
            /sealed/,
            `composePrivate accepted a sealed part and returned a ${laundered?.classification} value`
        );
    }
);

test(
    'FINDING F1a: the laundered value passes revealToPrivateChannel, which refuses sealed directly',
    { todo: 'F1 — the sealed tier is defeated by one hop through the composition primitive' },
    () => {
        const address = sealed(ADDRESS, 'home address', 'identity');

        // Directly: refused, as designed.
        assert.throws(() => revealToPrivateChannel(address as never, PRIVATE_CHANNEL_CAPABILITY), /refused sealed/);

        // Through composePrivate: allowed.
        const laundered = launder(address);
        const out = revealToPrivateChannel(laundered, PRIVATE_CHANNEL_CAPABILITY);
        assert.ok(!out.includes(ADDRESS), `the sealed value came back out as plaintext: ${out}`);
    }
);

test(
    'FINDING F1b: the laundered value is delivered on the private channel and appears in the inbox',
    { todo: 'F1 — spec says sealed never travels, "連私人通道都不給"' },
    () => {
        const fx = household();
        const insurance = sealed(INSURANCE, 'insurance member number', 'identity');

        deliverPrivately({
            store: fx.store,
            recipientId: SARAH,
            subjectId: MARGARET,
            tool: 'care_summary',
            payload: { title: 'Summary', fields: [{ label: 'Reference', value: launder(insurance) }] }
        });

        const inbox = JSON.stringify(renderInbox(fx.store, SARAH, false));
        assert.ok(!inbox.includes(INSURANCE), `a sealed fact is sitting in the inbox: ${INSURANCE}`);
    }
);

test(
    'FINDING F1c: chained with a solo window, a sealed value is SPOKEN ALOUD',
    { todo: 'F1 — this is the full chain: composePrivate + solo window = invariant violated' },
    () => {
        const fx = household();
        const address = sealed(ADDRESS, 'home address', 'identity');
        const win = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');

        // Directly, a solo window refuses a sealed value, exactly as documented.
        assert.throws(() => underSolo({ store: fx.store, window: win, tool: 'care_summary' })`${address as never}`, /refused sealed/);

        // One hop through the permitted composition primitive, and it speaks.
        const spoken = underSolo({ store: fx.store, window: win, tool: 'care_summary' })`Her address is ${launder(address)}.`;
        assert.ok(
            !spoken.includes(ADDRESS),
            `a sealed value was said out loud: ${JSON.stringify(spoken)}`
        );
    }
);

test(
    'FINDING F1d: the ledger records the laundered reveal under the wrong label and category',
    { todo: 'F1 — the audit trail says "note"/"medication" for a disclosed home address' },
    () => {
        const fx = household();
        const win = openSoloWindow(fx.store, SARAH, MARGARET, 'echo-kitchen');
        const before = fx.store.ledger.length;

        underSolo({ store: fx.store, window: win, tool: 'care_summary' })`${launder(sealed(ADDRESS, 'home address', 'identity'))}`;

        const row = fx.store.ledger[before];
        assert.equal(
            row?.what,
            'home address',
            `the ledger recorded "${row?.what}" for a disclosed home address, so the audit trail is wrong too`
        );
    }
);

// ---------------------------------------------------------------------------
// F2 — the capability tokens are exported constants
// ---------------------------------------------------------------------------

test(
    'FINDING F2: importing the module grants both reveal capabilities',
    { todo: 'F2 — a token every importer already holds is a lint, not a capability' },
    () => {
        // The docstring: "Constructible only inside this module, and handed to
        // exactly two call sites... A caller who does not already hold one
        // cannot manufacture one." Manufacturing is indeed blocked. Importing
        // is not, and `import { PRIVATE_CHANNEL_CAPABILITY }` is not a
        // manufacture. "Held by src/protocol/private-channel.ts only" is a
        // comment describing current call sites, not an access rule.
        const med = priv('Furosemide', 'medication name', 'medication');
        const plaintext = revealToPrivateChannel(med, PRIVATE_CHANNEL_CAPABILITY);

        assert.notEqual(
            plaintext,
            'Furosemide',
            'any module that imports core/protected.js can unwrap any private value'
        );
    }
);

test(
    'FINDING F2a: reveal output carries no marker, so it reaches speech untouched',
    { todo: 'F2 — the tripwire cannot distinguish authorised plaintext from a leak' },
    () => {
        const med = priv('Furosemide', 'medication name', 'medication');
        const plaintext = revealToPrivateChannel(med, PRIVATE_CHANNEL_CAPABILITY);
        const spoken = say`She took ${plaintext} this morning.`;
        assert.ok(
            !spoken.includes('Furosemide'),
            `three lines of plain, compiling, cast-free TypeScript put a private value into speech: ${JSON.stringify(spoken)}`
        );
    }
);

// ---------------------------------------------------------------------------
// what the design does hold
// ---------------------------------------------------------------------------

test('DEFENDED: composePrivate never widens a private composition beyond private', () => {
    const composed = composePrivate('medication and dose', 'medication', [
        priv('Furosemide', 'medication name', 'medication'),
        ' ',
        priv('40 mg', 'dose', 'medication')
    ]);
    assert.equal(composed.classification, 'private');
    assert.match(String(composed), /^⟦earshot:[0-9a-f]{16}⟧$/);
});

test('DEFENDED: no shipped tool passes a sealed value into composePrivate', async () => {
    // F1 is a defect in the primitive, not a live leak in today's tools. This
    // pins that distinction so the severity claim stays honest: every current
    // call site composes only `private` parts.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools');

    for (const f of readdirSync(toolsDir).filter(n => n.endsWith('.ts'))) {
        const src = readFileSync(join(toolsDir, f), 'utf8');
        for (const call of src.match(/composePrivate\([\s\S]*?\)\s*\n/g) ?? []) {
            assert.ok(
                !/sealedFacts|insuranceMemberId|homeAddress|fullChartSummary/.test(call),
                `${f} composes a sealed fact: ${call.trim()}`
            );
        }
    }
});

test('DEFENDED: a sealed value cannot be laundered by re-wrapping with protect()', () => {
    // The other obvious laundering route: re-protect the marker. It yields a
    // private value whose payload is the marker, which discloses nothing.
    const address = sealed(ADDRESS, 'home address', 'identity');
    const rewrapped = priv(String(address), 'note', 'medication');
    const out = revealToPrivateChannel(rewrapped, PRIVATE_CHANNEL_CAPABILITY);
    assert.match(out, /^⟦earshot:[0-9a-f]{16}⟧$/);
    assert.ok(!out.includes(ADDRESS));
});
