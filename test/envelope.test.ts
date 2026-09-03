/**
 * The wire — what actually leaves over MCP.
 *
 * src/protocol/envelope.ts calls itself "the single exit from the domain to
 * the wire" and "the one place where the invariant is enforced at runtime".
 * This suite drives all eight real tools through it and asserts on the bytes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
    LATENCY_BUDGET_MS,
    LeakError,
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    SARAH,
    TOOLS,
    checkAdherence,
    careSummary,
    priv,
    renderInbox,
    reportSymptom,
    revealToPrivateChannel,
    say,
    toCallToolResult
} from './support/src.ts';

/** Arguments that exercise each tool's happy path. */
const ARGS: Record<string, Record<string, unknown>> = {
    check_adherence: { window: 'today' },
    next_dose: {},
    log_dose: { slot: 'evening' },
    report_symptom: { description: 'short of breath climbing the stairs', severity: 3 },
    care_summary: {},
    who_can_see: {},
    open_solo_window: {},
    disclosure_ledger: { since: 'today' }
};

test('no protected plaintext leaves over MCP, for any tool, for any account', () => {
    for (const tool of TOOLS) {
        for (const who of [SARAH_ASKER, DANA_ASKER, MARGARET_ASKER, TOM_ASKER]) {
            const fx = household();
            const { wire } = callTool(fx, tool, ARGS[tool.name] ?? {}, who);
            const leaked = findPlaintext(JSON.stringify(wire));
            assert.deepEqual(leaked, [], `${tool.name} as ${who.personId} put ${leaked.join(', ')} on the wire`);
        }
    }
});

test('no taint marker leaves over MCP, for any tool, for any account', () => {
    for (const tool of TOOLS) {
        for (const who of [SARAH_ASKER, DANA_ASKER, TOM_ASKER]) {
            const fx = household();
            const { wire } = callTool(fx, tool, ARGS[tool.name] ?? {}, who);
            assert.ok(!/⟦earshot:/.test(JSON.stringify(wire)), `${tool.name} put a marker on the wire`);
        }
    }
});

test('the MCP response carries a receipt, never the payload', () => {
    const fx = household();
    const { wire } = callTool(fx, checkAdherence, { window: 'today' }, SARAH_ASKER);
    const sc = wire.structuredContent as Record<string, unknown>;

    assert.equal(sc['channel'], 'spoken+private-delivery');
    assert.deepEqual(Object.keys(sc['privateDelivery'] as object).sort(), [
        'channel',
        'deliveryId',
        'fieldCount',
        'recipient'
    ]);
    assert.equal((sc['privateDelivery'] as { recipient: string }).recipient, 'Sarah');
    assert.ok((sc['privateDelivery'] as { fieldCount: number }).fieldCount > 0);
    assert.match(String(sc['note']), /The detail is not in this response/);
});

test('the private payload is on the second channel, and only there', () => {
    const fx = household();
    const { out, wire } = callTool(fx, checkAdherence, { window: 'today' }, SARAH_ASKER);

    assert.ok(out.privately, 'the domain result holds the protected card');
    assert.ok(!JSON.stringify(wire).includes('privately'), 'and the wire does not carry it');

    const inbox = JSON.stringify(renderInbox(fx.store, SARAH, false));
    assert.ok(inbox.includes('Furosemide'), 'the plaintext is on GET /inbox');
    assert.ok(!JSON.stringify(wire).includes('Furosemide'));
});

test('content and structuredContent carry the same spoken sentence and nothing more', () => {
    const fx = household();
    const { out, wire } = callTool(fx, checkAdherence, {}, SARAH_ASKER);
    assert.deepEqual(wire.content, [{ type: 'text', text: out.spoken as string }]);
    assert.equal((wire.structuredContent as Record<string, unknown>)['spoken'], out.spoken);
});

test('_meta reports the latency against the documented budget', () => {
    const fx = household();
    const out = checkAdherence.run({}, { store: fx.store, asker: SARAH_ASKER });
    const wire = toCallToolResult(out, {
        store: fx.store,
        asker: SARAH_ASKER,
        subjectId: MARGARET,
        tool: 'check_adherence',
        serverLatencyMs: 12.3456789
    });
    assert.equal(wire._meta?.['earshot/latencyBudgetMs'], LATENCY_BUDGET_MS);
    assert.equal(wire._meta?.['earshot/serverLatencyMs'], 12.346, 'rounded to three decimals');
    assert.equal(wire._meta?.['earshot/withinBudget'], true);
});

test('_meta says so when a call blows the budget', () => {
    const fx = household();
    const out = checkAdherence.run({}, { store: fx.store, asker: SARAH_ASKER });
    const wire = toCallToolResult(out, {
        store: fx.store,
        asker: SARAH_ASKER,
        subjectId: MARGARET,
        tool: 'check_adherence',
        serverLatencyMs: LATENCY_BUDGET_MS + 1
    });
    assert.equal(wire._meta?.['earshot/withinBudget'], false);
});

test('the envelope throws when a tool hands it a tainted spoken string', () => {
    const fx = household();
    const dose = priv('Furosemide', 'medication name', 'medication');
    const bad = { spoken: `she took ${String(dose)}` as unknown as ReturnType<typeof say> };

    assert.throws(
        () => toCallToolResult(bad, { store: fx.store, asker: SARAH_ASKER, subjectId: MARGARET, tool: 'check_adherence', serverLatencyMs: 1 }),
        (err: unknown) => err instanceof LeakError && (err as InstanceType<typeof LeakError>).where === 'check_adherence.spoken'
    );
});

test('the envelope throws when a Protected is smuggled into structured data', () => {
    const fx = household();
    const dose = priv('Furosemide', 'medication name', 'medication');
    const bad = { spoken: say`Yes, taken.`, data: { dose } as never };

    assert.throws(
        () => toCallToolResult(bad, { store: fx.store, asker: SARAH_ASKER, subjectId: MARGARET, tool: 'check_adherence', serverLatencyMs: 1 }),
        (err: unknown) => err instanceof LeakError && (err as InstanceType<typeof LeakError>).where === 'check_adherence.data'
    );
});

test('the envelope throws on a tainted sealed pointer', () => {
    const fx = household();
    const dose = priv('Furosemide', 'medication name', 'medication');
    const bad = {
        spoken: say`Yes.`,
        sealedRefs: [{ label: `chart ${String(dose)}`, category: 'identity', appPath: '/x' }]
    };
    assert.throws(
        () => toCallToolResult(bad as never, { store: fx.store, asker: SARAH_ASKER, subjectId: MARGARET, tool: 'care_summary', serverLatencyMs: 1 }),
        (err: unknown) => err instanceof LeakError && (err as InstanceType<typeof LeakError>).where === 'care_summary.sealedRefs'
    );
});

test('every spoken answer is written to the ledger with its length, never its content', () => {
    const fx = household();
    const { out } = callTool(fx, checkAdherence, {}, SARAH_ASKER);
    const row = fx.store.ledger.find(e => e.channel === 'spoken' && e.tool === 'check_adherence');
    assert.ok(row);
    assert.equal(row.what, 'spoken answer');
    assert.equal(row.detail, `${(out.spoken as string).length} characters said aloud`);
});

test('a private delivery writes one ledger row per field, naming the label only', () => {
    const fx = household();
    callTool(fx, careSummary, {}, SARAH_ASKER);
    const rows = fx.store.ledger.filter(e => e.channel === 'private-channel');
    assert.equal(rows.length, 9);
    assert.deepEqual(
        [...new Set(rows.map(r => r.what))].sort(),
        ['adherence summary', 'diagnosis', 'latest vitals', 'medication', 'prescriber']
    );
    assert.deepEqual(findPlaintext(JSON.stringify(rows)), []);
});

test('a sealed pointer writes a sealed-refused row and sends nothing', () => {
    const fx = household();
    callTool(fx, careSummary, {}, SARAH_ASKER);
    const rows = fx.store.ledger.filter(e => e.channel === 'sealed-refused');
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.detail, 'sealed: pointer to the app only, no value sent on any channel');
});

test('report_symptom notifies other grant-holders out-of-band, and says only who', () => {
    const fx = household();
    const { out, wire } = callTool(
        fx,
        reportSymptom,
        { description: 'dizzy standing up', severity: 4 },
        DANA_ASKER
    );

    assert.equal(
        out.spoken,
        "Noted. I've marked it as something to look at. Sarah and Margaret have it on their phones."
    );
    assert.ok(!(out.spoken as string).includes('dizzy'), 'who was told is speakable; what was reported is not');
    assert.ok(!JSON.stringify(wire).includes('dizzy'));

    const sarahInbox = JSON.stringify(renderInbox(fx.store, SARAH, false));
    assert.ok(sarahInbox.includes('dizzy standing up'), 'Sarah holds a symptom grant, so she gets the detail');

    const notified = (wire.structuredContent as { notifiedOthers: { recipient: string }[] }).notifiedOthers;
    assert.deepEqual(notified.map(n => n.recipient), ['Sarah', 'Margaret']);
    assert.ok(
        !notified.some(n => n.recipient === 'Dana'),
        'the reporter is not notified of her own report'
    );
});

test('renderInbox is the only place plaintext appears, and marking read is opt-out', () => {
    const fx = household();
    callTool(fx, careSummary, {}, SARAH_ASKER);

    const peek = renderInbox(fx.store, SARAH, false) as { deliveries: { wasRead: boolean }[] };
    assert.equal(peek.deliveries[0]?.wasRead, false);
    const read = renderInbox(fx.store, SARAH, true) as { deliveries: { wasRead: boolean }[] };
    assert.equal(read.deliveries[0]?.wasRead, false, 'the first read reports the state it had on arrival');
    const again = renderInbox(fx.store, SARAH, false) as { deliveries: { wasRead: boolean }[] };
    assert.equal(again.deliveries[0]?.wasRead, true);
});

test("an inbox is per person: Dana's card is not in Sarah's inbox", () => {
    const fx = household();
    callTool(fx, careSummary, {}, DANA_ASKER);
    const sarah = renderInbox(fx.store, SARAH, false) as { count: number };
    const dana = renderInbox(fx.store, 'dana', false) as { count: number };
    assert.equal(sarah.count, 0);
    assert.equal(dana.count, 1);
});

test('the delivery receipt cannot be replayed to fetch the payload over MCP', () => {
    const fx = household();
    const { wire } = callTool(fx, checkAdherence, {}, SARAH_ASKER);
    const id = (wire.structuredContent as { privateDelivery: { deliveryId: string } }).privateDelivery.deliveryId;

    // The id names a delivery, and the delivery holds plaintext — but no tool
    // takes a delivery id as input, so there is no MCP path back to it.
    assert.ok(fx.store.delivery(id));
    for (const tool of TOOLS) {
        assert.ok(
            !Object.keys(tool.inputShape).some(k => /delivery|receipt|inbox|id$/i.test(k)),
            `${tool.name} accepts a delivery-shaped input`
        );
    }
});

test('every tool declares the shared output schema keys the envelope fills', () => {
    const fx = household();
    const { wire } = callTool(fx, careSummary, {}, SARAH_ASKER);
    assert.deepEqual(Object.keys(wire.structuredContent as object).sort(), [
        'channel',
        'data',
        'note',
        'notifiedOthers',
        'privateDelivery',
        'sealedPointers',
        'serverLatencyMs',
        'spoken',
        'underSoloWindow'
    ]);
});

test('wireStrings finds nothing sensitive across all eight tools', () => {
    for (const tool of TOOLS) {
        const fx = household();
        const { wire } = callTool(fx, tool, ARGS[tool.name] ?? {}, SARAH_ASKER);
        for (const s of wireStrings(wire)) {
            assert.deepEqual(findPlaintext(s), [], `${tool.name}: ${s}`);
        }
    }
});

test('the private card really does hold what the spoken answer withheld', () => {
    // The complement of every other assertion in this file: prove the detail
    // exists and went somewhere, so "nothing leaked" is not just "nothing happened".
    const fx = household();
    const { out } = callTool(fx, careSummary, {}, SARAH_ASKER);
    const card = (out.privately?.fields ?? []).map(f => revealToPrivateChannel(f.value, PRIVATE_CHANNEL_CAPABILITY));
    const joined = card.join('\n');

    assert.ok(joined.includes('Furosemide'));
    assert.ok(joined.includes('Congestive heart failure'));
    assert.ok(joined.includes('Whitfield'));
    assert.ok(joined.includes('BP 118/72'));
    assert.ok(!(out.spoken as string).includes('Furosemide'));
});
