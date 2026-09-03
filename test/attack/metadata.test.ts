/**
 * ATTACK — reconstruct a protected value from the metadata that IS spoken.
 *
 * This is where Blindfold's worst bug lived, in a different costume. There,
 * four individually-permitted filters narrowed a cohort to one person. Here,
 * the fields the design declares safe to say aloud — `spokenHandle`, `label`,
 * `category`, the schedule, and the counts in a spoken receipt — are not
 * independent of the protected values they stand in for.
 *
 * The invariant is stated as "a protected value never appears in a spoken
 * string". It is worth being precise about what these tests show:
 *   - the strong version, a *verbatim substring* leak, is real and provable
 *     (F7: "the morning potassium" vs "Potassium chloride");
 *   - the inference version is a design property, and is measured here rather
 *     than asserted rhetorically.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DANA,
    HOUSEHOLD_TZ,
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    SARAH,
    careSummary,
    checkAdherence,
    nextDose,
    revealToPrivateChannel,
    whoCanSee
} from '../support/src.ts';
import { DANA_ASKER, PLAINTEXT, SARAH_ASKER, callTool, household } from '../support/harness.ts';

/** Every spoken-class string the domain holds about a medication. */
function speakableMedFacts(fx: ReturnType<typeof household>) {
    return fx.store.medsFor(MARGARET).map(m => ({
        handle: m.spokenHandle,
        schedule: m.schedule,
        nameLabel: m.name.label,
        nameCategory: m.name.category,
        // read only so the test can compare; never spoken by any tool
        secretName: revealToPrivateChannel(m.name, PRIVATE_CHANNEL_CAPABILITY),
        secretIndication: revealToPrivateChannel(m.indication, PRIVATE_CHANNEL_CAPABILITY)
    }));
}

test('the seed still holds the plaintext this suite reasons about', () => {
    // Without this, every "the secret does not appear" assertion below could
    // pass simply because the seed changed. Fails loudly instead.
    const fx = household();
    const facts = speakableMedFacts(fx);
    assert.equal(facts.length, 5);
    assert.deepEqual(facts.map(f => f.secretName).sort(), [...PLAINTEXT.medNames].sort());
    assert.equal(
        revealToPrivateChannel(fx.store.clinical.get(MARGARET)!.diagnosis, PRIVATE_CHANNEL_CAPABILITY),
        PLAINTEXT.diagnosis
    );
});

// ---------------------------------------------------------------------------
// F7 — the spoken handle contains the protected name
// ---------------------------------------------------------------------------

test(
    'FINDING F7: a spoken-class handle contains the protected medication name verbatim',
    { todo: 'F7 — rename to a class-free handle, e.g. "the morning mineral tablet"' },
    () => {
        const fx = household();
        const offenders: string[] = [];

        for (const f of speakableMedFacts(fx)) {
            // Compare token by token: "Potassium chloride" vs "the morning potassium".
            for (const token of f.secretName.split(/\s+/)) {
                if (token.length >= 4 && f.handle.toLowerCase().includes(token.toLowerCase())) {
                    offenders.push(`${JSON.stringify(f.handle)} contains "${token}" from ${JSON.stringify(f.secretName)}`);
                }
            }
        }

        assert.deepEqual(offenders, [], offenders.join('; '));
    }
);

test(
    'FINDING F7a: every spoken handle names the drug class, which is the protected indication restated',
    { todo: 'F7a — a handle should identify the slot, not the pharmacology' },
    () => {
        const fx = household();
        // A listener who hears the handle learns the pharmacological class.
        // The class maps one-to-one onto the protected `indication` for all five.
        const CLASS_WORDS = ['water pill', 'heart pill', 'blood thinner', 'cholesterol', 'potassium'];
        const disclosing = speakableMedFacts(fx).filter(f =>
            CLASS_WORDS.some(w => f.handle.toLowerCase().includes(w))
        );

        assert.deepEqual(
            disclosing.map(f => f.handle),
            [],
            `${disclosing.length} of 5 spoken handles disclose the drug class: ${disclosing.map(f => f.handle).join(', ')}`
        );
    }
);

test(
    'FINDING F7b: handles plus schedule reconstruct the regimen, hence the protected diagnosis',
    { todo: 'F7b — accept and document, or coarsen the handles' },
    () => {
        const fx = household();
        const facts = speakableMedFacts(fx);

        // An adversary hears only spoken-class data: the handles (returned by
        // check_adherence and next_dose when several items are due) and the
        // times. Loop diuretic + potassium replacement + rate control +
        // anticoagulant is a textbook CHF-with-AF regimen.
        const heard = facts.map(f => `${f.handle} at ${f.schedule.join(' and ')}`).join('; ');
        const inferred = {
            heartFailure: /water pill/.test(heard) && /potassium/.test(heard),
            atrialFibrillation: /blood thinner/.test(heard) && /heart pill/.test(heard)
        };

        const actual = PLAINTEXT.diagnosis.toLowerCase();
        assert.ok(actual.includes('heart failure') && actual.includes('atrial fibrillation'));

        assert.ok(
            !(inferred.heartFailure && inferred.atrialFibrillation),
            `spoken-class metadata alone reconstructs the protected diagnosis (${PLAINTEXT.diagnosis}) from: ${heard}`
        );
    }
);

// ---------------------------------------------------------------------------
// F8 — counts spoken aloud are a function of the protected set
// ---------------------------------------------------------------------------

test(
    'FINDING F8: care_summary speaks an item count that reveals how many medications there are',
    { todo: 'F8 — say "sent" without the count, or count only non-derived items' },
    () => {
        const sarah = callTool(household(), careSummary, {}, SARAH_ASKER).out.spoken as string;
        const dana = callTool(household(), careSummary, {}, DANA_ASKER).out.spoken as string;

        const count = (s: string): number => Number(/Sent — (\d+) items/.exec(s)?.[1] ?? '0');
        const sarahN = count(sarah);
        const danaN = count(dana);

        // Dana's card = 1 adherence + N medications (+ symptoms, of which there
        // are none in a fresh household). So N is spoken in plain arithmetic.
        const medCount = household().store.medsFor(MARGARET).length;
        assert.equal(danaN - 1, medCount, 'sanity: the count really is a function of the medication list');

        // Difference the two accounts and the categories Dana is denied fall out.
        assert.equal(sarahN - danaN, 3, 'sanity: diagnosis + prescriber + vitals');

        assert.ok(
            false,
            `the spoken receipt discloses the size of the protected set: Sarah hears ${sarahN}, Dana hears ${danaN}, ` +
                `so a listener in the room learns Margaret takes ${medCount} medications and that a diagnosis, ` +
                `a prescriber and vitals are all on file`
        );
    }
);

test(
    'FINDING F8a: differencing two accounts identifies which categories hold data',
    { todo: 'F8a — the count must not vary with what exists, only with what was sent' },
    () => {
        const fx = household();
        // who_can_see is deliberately loud, and tells anyone which categories
        // each viewer holds. Combined with F8's counts, the arithmetic closes.
        const viewers = callTool(fx, whoCanSee, {}, DANA_ASKER).out.spoken as string;
        assert.match(viewers, /Sarah, daughter: everything/);
        assert.match(viewers, /Dana, home health aide — that's you: medication and schedule and symptom/);

        const sarahN = Number(/Sent — (\d+) items/.exec(callTool(household(), careSummary, {}, SARAH_ASKER).out.spoken as string)?.[1]);
        const danaN = Number(/Sent — (\d+) items/.exec(callTool(household(), careSummary, {}, DANA_ASKER).out.spoken as string)?.[1]);

        assert.equal(
            sarahN,
            danaN,
            `an aide denied diagnosis/clinician/vitals can still count them: ${sarahN} - ${danaN} = ${sarahN - danaN} ` +
                'facts exist in the three categories she is not allowed to see'
        );
    }
);

// ---------------------------------------------------------------------------
// what holds
// ---------------------------------------------------------------------------

test('DEFENDED: labels and categories name the kind of fact, never the fact', () => {
    const fx = household();
    const meds = fx.store.medsFor(MARGARET);
    const clinical = fx.store.clinical.get(MARGARET)!;
    const sealedFacts = fx.store.sealed.get(MARGARET)!;

    const metadata = [
        ...meds.flatMap(m => [m.name, m.strength, m.indication, m.instructions]),
        clinical.diagnosis,
        clinical.prescriber,
        clinical.lastVitals,
        sealedFacts.insuranceMemberId,
        sealedFacts.homeAddress,
        sealedFacts.fullChartSummary
    ];

    for (const p of metadata) {
        const secret = String(
            p.classification === 'private'
                ? revealToPrivateChannel(p as never, PRIVATE_CHANNEL_CAPABILITY)
                : '<sealed>'
        );
        if (secret === '<sealed>') continue;
        assert.ok(!secret.toLowerCase().includes(p.label.toLowerCase()) || p.label.length < 4, `label ${p.label}`);
        assert.ok(
            !p.label.toLowerCase().split(/\s+/).some(w => w.length >= 5 && secret.toLowerCase().includes(w)),
            `label "${p.label}" shares a distinctive word with its own value`
        );
    }
});

test('DEFENDED: sealed labels disclose the category, not the value', () => {
    const fx = household();
    const { out } = callTool(fx, careSummary, {}, SARAH_ASKER);
    for (const ref of out.sealedRefs ?? []) {
        assert.ok(!/\d{3}/.test(ref.label), `a sealed label containing digits could be the value: ${ref.label}`);
        assert.ok(!ref.appPath.includes('BCBSCA'));
    }
});

test('DEFENDED: next_dose speaks a time and a gap, and never how many items are due', () => {
    const fx = household();
    const { out, wire } = callTool(fx, nextDose, {}, SARAH_ASKER);
    const spoken = out.spoken as string;

    assert.match(spoken, /^Next at \d{1,2}:\d{2} (AM|PM), in about \d+ hours?\.$/);
    assert.ok(!/\b(three|3|five|5) (items|medications|pills)\b/i.test(spoken));

    // `itemsDue` is in structuredContent, which the model reads — but it is a
    // count of a schedule slot, which the classification table calls spoken.
    assert.equal(typeof (wire.structuredContent as { data: { itemsDue: number } }).data.itemsDue, 'number');
});

test('DEFENDED: check_adherence speaks counts of doses, never of distinct medications', () => {
    const fx = household();
    const { out } = callTool(fx, checkAdherence, { window: 'week' }, SARAH_ASKER);
    const spoken = out.spoken as string;

    assert.deepEqual(
        [...PLAINTEXT.medNames, ...PLAINTEXT.strengths].filter(s => spoken.includes(s)),
        []
    );
    assert.match(spoken, /Mostly\. 2 doses went unrecorded this week/);
});

test('DEFENDED: repeated identical questions do not accumulate into a disclosure', () => {
    // The cheap differencing attack: ask the same thing many times and watch
    // the answer drift. It does not — the spoken answer is a pure function of
    // the store at a fixed clock.
    const fx = household();
    const answers = new Set<string>();
    for (let i = 0; i < 25; i++) {
        answers.add(callTool(fx, checkAdherence, { window: 'today' }, SARAH_ASKER).out.spoken as string);
    }
    assert.equal(answers.size, 1);
});

test('DEFENDED: asking as two accounts does not reveal a third account\'s private data', () => {
    const fxA = household();
    const fxB = household();
    const a = callTool(fxA, checkAdherence, {}, SARAH_ASKER).out.spoken as string;
    const b = callTool(fxB, checkAdherence, {}, DANA_ASKER).out.spoken as string;
    assert.equal(a, b, 'no per-viewer variation in the spoken half means nothing to difference here');
});

test('DEFENDED: the grant table itself is spoken, but grant metadata is not a fact about health', () => {
    const fx = household();
    const spoken = callTool(fx, whoCanSee, {}, SARAH_ASKER).out.spoken as string;
    for (const secret of [...PLAINTEXT.medNames, PLAINTEXT.diagnosis, PLAINTEXT.prescriber, PLAINTEXT.vitals]) {
        assert.ok(!spoken.includes(secret));
    }
    assert.ok(spoken.includes('Dana') && spoken.includes('Sarah'), 'names of household members are spoken class');
    void [SARAH, DANA, HOUSEHOLD_TZ];
});
