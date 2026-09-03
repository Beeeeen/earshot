/**
 * Authorisation — the same question, asked by different linked accounts,
 * answered from the grant table and nothing else.
 *
 * The seeded grants (src/domain/seed.ts):
 *   Sarah    private: medication, schedule, diagnosis, symptom, vitals, clinician
 *   Dana     private: medication, schedule, symptom
 *   Margaret private: everything, including identity
 *   Tom      no row at all — and "an empty row is not the same as no row"
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ALL_SCOPES,
    DANA_ASKER,
    MARGARET_ASKER,
    SARAH_ASKER,
    TOM_ASKER,
    callTool,
    findPlaintext,
    household,
    wireStrings
} from './support/harness.ts';
import {
    DANA,
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    SARAH,
    TOM,
    canAsk,
    canReceivePrivate,
    canReceiveSealed,
    careSummary,
    checkAdherence,
    revealToPrivateChannel,
    viewersOf,
    whoCanSee
} from './support/src.ts';

// ---------------------------------------------------------------------------
// the grant table itself
// ---------------------------------------------------------------------------

test('canAsk follows the grant table, and a missing row is a denial', () => {
    const { store } = household();
    assert.equal(canAsk(store, SARAH, MARGARET).allowed, true);
    assert.equal(canAsk(store, DANA, MARGARET).allowed, true);
    assert.equal(canAsk(store, MARGARET, MARGARET).allowed, true, 'the subject may always ask about herself');

    const tom = canAsk(store, TOM, MARGARET);
    assert.equal(tom.allowed, false);
    assert.equal(tom.reason, 'no grant on file');
});

test('canReceivePrivate is per category, per viewer', () => {
    const { store } = household();
    const table: [string, string, boolean][] = [
        [SARAH, 'medication', true],
        [SARAH, 'diagnosis', true],
        [SARAH, 'vitals', true],
        [SARAH, 'clinician', true],
        [SARAH, 'identity', false],
        [DANA, 'medication', true],
        [DANA, 'schedule', true],
        [DANA, 'symptom', true],
        [DANA, 'diagnosis', false],
        [DANA, 'clinician', false],
        [DANA, 'vitals', false],
        [MARGARET, 'identity', true],
        [TOM, 'medication', false]
    ];
    for (const [viewer, category, expected] of table) {
        const d = canReceivePrivate(store, viewer, MARGARET, category as never);
        assert.equal(d.allowed, expected, `${viewer} / ${category}: expected allowed=${expected}, got ${d.reason}`);
    }
});

test('a denial reason is safe to say aloud and never quotes the fact', () => {
    const { store } = household();
    for (const viewer of [SARAH, DANA, TOM]) {
        for (const category of ['medication', 'diagnosis', 'vitals', 'clinician', 'identity'] as const) {
            const d = canReceivePrivate(store, viewer, MARGARET, category);
            assert.deepEqual(findPlaintext(d.reason), [], `reason leaked: ${d.reason}`);
        }
    }
});

test('sealed is never granted through the grant table, to anyone', () => {
    const d = canReceiveSealed();
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'sealed facts are only available in the Earshot app');
});

test('viewersOf lists exactly the rows on file, sorted, with no fact attached', () => {
    const { store } = household();
    const viewers = viewersOf(store, MARGARET);
    assert.deepEqual(viewers.map(v => v.person.displayName), ['Dana', 'Margaret', 'Sarah']);
    assert.deepEqual(
        viewers.find(v => v.person.id === DANA)?.categories,
        ['medication', 'schedule', 'symptom']
    );
    assert.ok(!viewers.some(v => v.person.id === TOM));
    assert.deepEqual(findPlaintext(JSON.stringify(viewers)), []);
});

// ---------------------------------------------------------------------------
// the same question, four accounts
// ---------------------------------------------------------------------------

/** The private card each account actually receives, as plaintext, read off the second channel. */
function cardFor(fx: ReturnType<typeof household>, who: typeof SARAH_ASKER): string[] {
    const { out } = callTool(fx, careSummary, {}, who);
    return (out.privately?.fields ?? []).map(
        f => `${f.label}: ${revealToPrivateChannel(f.value, PRIVATE_CHANNEL_CAPABILITY)}`
    );
}

test('care_summary: Sarah, Dana, Margaret and Tom get four different answers', () => {
    const sarah = cardFor(household(), SARAH_ASKER);
    const dana = cardFor(household(), DANA_ASKER);
    const margaret = cardFor(household(), MARGARET_ASKER);
    const tom = cardFor(household(), TOM_ASKER);

    const labels = (card: string[]): string[] => [...new Set(card.map(l => l.split(':')[0] as string))].sort();

    assert.deepEqual(labels(sarah), ['Adherence, last 7 days', 'Diagnosis', 'Latest vitals', 'Medication', 'Prescriber']);
    assert.deepEqual(labels(dana), ['Adherence, last 7 days', 'Medication']);
    assert.deepEqual(labels(margaret), ['Adherence, last 7 days', 'Diagnosis', 'Latest vitals', 'Medication', 'Prescriber']);
    assert.deepEqual(tom, [], 'no grant on file means no card at all');

    assert.notDeepEqual(sarah, dana);
    assert.equal(sarah.length, 9);
    assert.equal(dana.length, 6);
});

test("care_summary: Dana's card carries no diagnosis, prescriber or vitals plaintext", () => {
    const dana = cardFor(household(), DANA_ASKER).join('\n');
    assert.ok(!dana.includes('Congestive heart failure'));
    assert.ok(!dana.includes('Whitfield'));
    assert.ok(!dana.includes('BP 118/72'));
    assert.ok(dana.includes('Furosemide'), 'she is granted medication, so it must be there');
});

test('care_summary: nobody, at any grant level, receives a sealed fact on any channel', () => {
    for (const who of [SARAH_ASKER, DANA_ASKER, MARGARET_ASKER, TOM_ASKER]) {
        const fx = household();
        const { out, wire } = callTool(fx, careSummary, {}, who);
        const card = (out.privately?.fields ?? [])
            .map(f => revealToPrivateChannel(f.value, PRIVATE_CHANNEL_CAPABILITY))
            .join('\n');
        const everything = [card, out.spoken as string, JSON.stringify(wire), JSON.stringify(fx.store.deliveries)].join('\n');

        for (const secret of ['BCBSCA-7742-118-903', 'Alameda de las Pulgas', '41 pages']) {
            assert.ok(!everything.includes(secret), `${who.personId} received sealed data: ${secret}`);
        }
    }
});

test('care_summary: sealed facts appear only as labels and app pointers', () => {
    const fx = household();
    const { out } = callTool(fx, careSummary, {}, SARAH_ASKER);
    assert.deepEqual(
        (out.sealedRefs ?? []).map(r => r.label),
        ['insurance member number', 'home address', 'complete medical record']
    );
    for (const ref of out.sealedRefs ?? []) {
        assert.match(ref.appPath, /^\/subject\/margaret\//);
        assert.deepEqual(findPlaintext(JSON.stringify(ref)), []);
    }
});

test('care_summary: the spoken half is a receipt for everyone, and names the withheld categories', () => {
    const sarah = callTool(household(), careSummary, {}, SARAH_ASKER).out.spoken as string;
    const dana = callTool(household(), careSummary, {}, DANA_ASKER).out.spoken as string;
    const tom = callTool(household(), careSummary, {}, TOM_ASKER).out.spoken as string;

    assert.match(sarah, /Sent — 9 items on your phone\./);
    assert.match(dana, /Your access doesn't cover diagnosis, clinician, vitals/);
    assert.match(tom, /You don't have access to Margaret's full picture/);
    for (const s of [sarah, dana, tom]) assert.deepEqual(findPlaintext(s), []);
});

test('check_adherence: the spoken answer is the same shape for everyone; the delivery is not', () => {
    const sarah = household();
    const dana = household();
    const tom = household();

    const a = callTool(sarah, checkAdherence, { window: 'today' }, SARAH_ASKER);
    const b = callTool(dana, checkAdherence, { window: 'today' }, DANA_ASKER);
    const c = callTool(tom, checkAdherence, { window: 'today' }, TOM_ASKER);

    assert.equal(a.out.spoken, b.out.spoken, 'both grant-holders hear the same non-sensitive answer');
    assert.notEqual(a.out.spoken, c.out.spoken);
    assert.match(c.out.spoken as string, /You don't have access to Margaret's care information/);

    assert.equal(sarah.store.deliveries.length, 1);
    assert.equal(dana.store.deliveries.length, 1);
    assert.equal(tom.store.deliveries.length, 0, 'a refusal delivers nothing on any channel');
});

test('check_adherence: a refusal is written to the ledger as a denial', () => {
    const fx = household();
    callTool(fx, checkAdherence, {}, TOM_ASKER);
    const denials = fx.store.ledger.filter(e => e.channel === 'denied');
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.actorId, TOM);
    assert.equal(denials[0]?.detail, 'no grant on file');
});

test('who_can_see is loud on purpose, and still carries no protected fact', () => {
    const fx = household();
    const { out, wire } = callTool(fx, whoCanSee, {}, SARAH_ASKER);
    const spoken = out.spoken as string;

    assert.match(spoken, /3 people have access to Margaret's information\./);
    assert.match(spoken, /Sarah, daughter — that's you: everything\./);
    assert.match(spoken, /Dana, home health aide: medication and schedule and symptom\./);
    assert.deepEqual(findPlaintext(spoken), []);
    for (const s of wireStrings(wire)) assert.deepEqual(findPlaintext(s), []);
});

test('who_can_see refuses someone with no grant', () => {
    const fx = household();
    const { out } = callTool(fx, whoCanSee, {}, TOM_ASKER);
    assert.match(out.spoken as string, /I can't tell you that/);
    assert.equal(out.data?.['denied'], true);
});

test('an asker carries only what an access token can establish', () => {
    // No voice print, no device-id-as-identity. `deviceSessionId` exists but is
    // used for binding a solo window, never for deciding who someone is.
    assert.deepEqual(Object.keys(SARAH_ASKER).sort(), ['deviceSessionId', 'displayName', 'personId', 'scopes']);
    assert.deepEqual([...ALL_SCOPES], SARAH_ASKER.scopes);

    const fx = household();
    const impostor = { ...TOM_ASKER, deviceSessionId: SARAH_ASKER.deviceSessionId, displayName: 'Sarah' };
    const { out } = callTool(fx, careSummary, {}, impostor);
    assert.match(out.spoken as string, /You don't have access/, 'sharing a device grants nothing');
});
