/**
 * ATTACK — read the transparency log to learn what you are not allowed to know.
 *
 * `disclosure_ledger` is the tool that says what was disclosed and how. It is
 * meant to be loud, and mostly it should be. But its private card is built
 * like this (src/tools/transparency.ts:148):
 *
 *     value: priv(`${r.what} — ${CHANNEL_PHRASE[r.channel]} ...`, 'ledger entry', 'medication')
 *
 * Every row, whatever it was about, is re-labelled into the `medication`
 * category — and the tool gates on `canAsk` only, never on
 * `canReceivePrivate`. So a viewer who is denied `diagnosis`, `clinician` and
 * `vitals` receives rows naming exactly those, because the aggregate view
 * carries a single hardcoded category instead of the categories of the facts
 * it summarises.
 *
 * This is the Blindfold bug in its purest local form: an ungrouped aggregate
 * walking around the per-category check the whole design rests on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DANA,
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    canReceivePrivate,
    careSummary,
    checkAdherence,
    disclosureLedger,
    reportSymptom,
    revealToPrivateChannel
} from '../support/src.ts';
import { DANA_ASKER, SARAH_ASKER, TOM_ASKER, callTool, findPlaintext, household } from '../support/harness.ts';

/**
 * Sarah looks at everything; then Dana asks the ledger what happened.
 *
 * Order matters: `disclosure_ledger` renders `rows.slice(0, 40)` of a
 * newest-first list, so the care_summary rows have to be the most recent to be
 * in the card at all. (That silent truncation is F3d — the spoken count
 * reports every row while the itemised card stops at forty.)
 */
function busyDay() {
    const fx = household();
    callTool(fx, checkAdherence, { window: 'today' }, SARAH_ASKER);
    callTool(fx, careSummary, {}, SARAH_ASKER);
    return fx;
}

function ledgerCardFor(fx: ReturnType<typeof household>, who: typeof DANA_ASKER): string[] {
    const { out } = callTool(fx, disclosureLedger, { since: 'today' }, who);
    return (out.privately?.fields ?? []).map(f => revealToPrivateChannel(f.value, PRIVATE_CHANNEL_CAPABILITY));
}

test(
    'FINDING F3: the ledger card names categories the reader is explicitly denied',
    { todo: 'F3 — filter rows by canReceivePrivate on the *row\'s* category' },
    () => {
        const fx = busyDay();
        for (const category of ['diagnosis', 'clinician', 'vitals'] as const) {
            assert.equal(canReceivePrivate(fx.store, DANA, MARGARET, category).allowed, false);
        }

        const card = ledgerCardFor(fx, DANA_ASKER).join('\n');
        const disclosed = ['diagnosis', 'prescriber', 'latest vitals'].filter(w => card.includes(w));

        assert.deepEqual(
            disclosed,
            [],
            `Dana holds no diagnosis/clinician/vitals grant and was handed rows naming: ${disclosed.join(', ')}`
        );
    }
);

test(
    'FINDING F3a: every ledger row is re-classified into the medication category',
    { todo: 'F3a — carry the originating category through the ledger row' },
    () => {
        const fx = busyDay();
        const { out } = callTool(fx, disclosureLedger, {}, DANA_ASKER);
        const categories = [...new Set((out.privately?.fields ?? []).map(f => f.value.category))];

        assert.ok(
            categories.length > 1 || categories[0] !== 'medication',
            `all ${(out.privately?.fields ?? []).length} rows are labelled "${categories.join(',')}" ` +
                'regardless of what they were about, so any medication-level check passes them'
        );
    }
);

test(
    'FINDING F3b: disclosure_ledger never consults canReceivePrivate at all',
    { todo: 'F3b — canAsk is the wrong gate for a private-channel payload' },
    () => {
        // Behavioural proof rather than a source grep: give the asker a grant
        // that covers *nothing* the ledger contains and see the card arrive.
        const fx = busyDay();
        const danaGrant = fx.store.grantFor(DANA, MARGARET);
        assert.ok(danaGrant);
        // Narrow Dana's grant to a single category with no rows on this day.
        (danaGrant as { categories: readonly string[] }).categories = ['schedule'];

        const card = ledgerCardFor(fx, DANA_ASKER);
        assert.deepEqual(
            card,
            [],
            `a viewer granted only "schedule" still received ${card.length} ledger rows about medication, diagnosis and vitals`
        );
    }
);

test(
    'FINDING F3c: the ledger discloses which accounts read what, to anyone who can ask',
    { todo: 'F3c — a care aide learning what the daughter looked at is its own disclosure' },
    () => {
        const fx = busyDay();
        const card = ledgerCardFor(fx, DANA_ASKER).join('\n');
        assert.ok(
            !card.includes('Sarah'),
            "Dana's ledger card names Sarah as the actor on every row, so it doubles as a log of another person's reading habits"
        );
    }
);

// ---------------------------------------------------------------------------
// what holds
// ---------------------------------------------------------------------------

test('DEFENDED: the ledger never stores or renders a protected value', () => {
    const fx = busyDay();
    callTool(fx, reportSymptom, { description: 'short of breath on the stairs', severity: 4 }, SARAH_ASKER);

    assert.deepEqual(findPlaintext(JSON.stringify(fx.store.ledger)), []);
    assert.ok(!JSON.stringify(fx.store.ledger).includes('short of breath'));

    const card = ledgerCardFor(fx, SARAH_ASKER).join('\n');
    assert.deepEqual(findPlaintext(card), []);
    assert.ok(!card.includes('short of breath'));
});

test('DEFENDED: the spoken half of the ledger is counts only', () => {
    const fx = busyDay();
    const { out } = callTool(fx, disclosureLedger, { since: 'today' }, SARAH_ASKER);
    const spoken = out.spoken as string;

    assert.match(spoken, /^Today: \d+ answers out loud, .*\. The itemised list is on your phone\.$/);
    assert.deepEqual(findPlaintext(spoken), []);
    assert.ok(!/diagnosis|prescriber|vitals|Furosemide/.test(spoken), 'the loud half names no category and no fact');
});

test('DEFENDED: someone with no grant gets nothing from the ledger', () => {
    const fx = busyDay();
    const { out } = callTool(fx, disclosureLedger, {}, TOM_ASKER);
    assert.equal(out.data?.['denied'], true);
    assert.equal(out.privately, undefined);
    assert.match(out.spoken as string, /I can't tell you that/);
});

test('DEFENDED: the ledger is append-only in practice — tools only ever push', () => {
    const fx = busyDay();
    const before = fx.store.ledger.map(e => e.id);
    callTool(fx, checkAdherence, {}, SARAH_ASKER);
    const after = fx.store.ledger.map(e => e.id);

    assert.deepEqual(after.slice(0, before.length), before, 'existing rows were neither edited nor reordered');
    assert.ok(after.length > before.length);
});

test('DEFENDED: a denial is recorded as loudly as a disclosure', () => {
    const fx = household();
    callTool(fx, careSummary, {}, TOM_ASKER);
    const denials = fx.store.ledger.filter(e => e.channel === 'denied');
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.what, 'care summary');
    assert.equal(denials[0]?.detail, 'no grant on file');
});

test('DEFENDED: the ledger records the channel a fact travelled on, for every channel', () => {
    const fx = household();
    callTool(fx, careSummary, {}, SARAH_ASKER);
    const channels = new Set(fx.store.ledger.map(e => e.channel));
    assert.ok(channels.has('spoken'));
    assert.ok(channels.has('private-channel'));
    assert.ok(channels.has('sealed-refused'));
});

test(
    'FINDING F3d: the itemised card silently stops at forty rows while the spoken count does not',
    { todo: 'F3d — say the number actually itemised, or paginate' },
    () => {
        const fx = household();
        callTool(fx, careSummary, {}, SARAH_ASKER);
        callTool(fx, checkAdherence, { window: 'week' }, SARAH_ASKER);

        const { out } = callTool(fx, disclosureLedger, { since: 'today' }, SARAH_ASKER);
        const total = Number(out.data?.['total'] ?? 0);
        const itemised = (out.privately?.fields ?? []).length;

        assert.equal(
            itemised,
            total,
            `the spoken half counts ${total} disclosures; the card lists ${itemised}, with no mention of the ${total - itemised} it dropped`
        );
    }
);
