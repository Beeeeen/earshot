/**
 * ATTACK — the surfaces nobody put a tripwire on.
 *
 * The envelope scans `spoken`, `data`, `sealedRefs` and the assembled
 * `structuredContent`. Everything else that reaches the model or the operator
 * is unscanned: tool names, tool titles, tool descriptions, input-schema
 * descriptions, and the server's own instructions block. A model reads all of
 * those, and can narrate any of them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    LeakError,
    MARGARET,
    PRIVATE_CHANNEL_CAPABILITY,
    SARAH,
    TAINT_PATTERN,
    TOOLS,
    assertNoTaint,
    assertNoTaintDeep,
    careSummary,
    checkAdherence,
    defineTool,
    markerOf,
    priv,
    renderInbox,
    revealToPrivateChannel,
    say,
    toCallToolResult
} from '../support/src.ts';
import { SARAH_ASKER, callTool, findPlaintext, household } from '../support/harness.ts';

const DOSE = priv('Furosemide 40 mg', 'medication name', 'medication');

// ---------------------------------------------------------------------------
// F9 — tool metadata is never scanned
// ---------------------------------------------------------------------------

test(
    'FINDING F9: defineTool never scans tool metadata, so a marker reaches tools/list',
    { todo: 'F9 — run assertNoTaint over name/title/description/inputShape inside defineTool' },
    () => {
        // A tool whose description was built from a protected value. The
        // envelope scans results; nothing scans registration. `tools/list` is
        // read by the model on every session, outside any tool call.
        assert.throws(
            () =>
                defineTool({
                    name: 'check_adherence_detailed',
                    title: `What ${String(DOSE)} was taken`,
                    description: `Reports adherence for ${String(DOSE)}, including the strength.`,
                    inputShape: {},
                    run: () => ({ spoken: say`ok` })
                }),
            LeakError,
            `defineTool accepted metadata containing ${markerOf(DOSE)} without complaint`
        );
    }
);

test(
    'FINDING F9a: and a scan would not catch the plaintext version anyway',
    { todo: 'F9a — depends on F0/F2: plaintext carries no marker, so no scan can see it' },
    () => {
        const fx = household();
        const med = fx.store.medsFor(MARGARET)[0];
        assert.ok(med);
        const plaintext = (med.name as unknown as { unseal(): string }).unseal();

        const t = defineTool({
            name: 'x',
            title: 'x',
            description: `Ask about ${plaintext} specifically.`,
            inputShape: {},
            run: () => ({ spoken: say`ok` })
        });

        assert.deepEqual(
            findPlaintext(t.description),
            [],
            `a medication name sits in a tool description the model reads verbatim: ${t.description}. ` +
                'A marker scan at defineTool would not have caught this one, which is why F0 and F2 matter ' +
                'more than any additional tripwire.'
        );
    }
);

test('DEFENDED: the eight shipped tools carry no protected value in their metadata', () => {
    for (const t of TOOLS) {
        const metadata = JSON.stringify({ name: t.name, title: t.title, description: t.description });
        assert.deepEqual(findPlaintext(metadata), [], `${t.name} metadata`);
        assert.ok(!TAINT_PATTERN.test(metadata));
        TAINT_PATTERN.lastIndex = 0;
    }
});

test('DEFENDED: every shipped description tells the model the detail is not in the response', () => {
    // The prompt-side defence: the model cannot narrate what it does not have,
    // and the descriptions say so rather than relying on it inferring so.
    const withPrivateHalf = ['check_adherence', 'report_symptom', 'care_summary', 'disclosure_ledger'];
    for (const name of withPrivateHalf) {
        const t = TOOLS.find(x => x.name === name);
        assert.ok(t, name);
        assert.match(
            t.description,
            /not (present )?in this response|out-of-band|not be said out loud|goes to the asker|is a receipt/i,
            `${name} does not tell the model where the detail went`
        );
    }
});

// ---------------------------------------------------------------------------
// F11 — the partial commit
// ---------------------------------------------------------------------------

test(
    'FINDING F11: a late tripwire failure leaves the private delivery already committed',
    { todo: 'F11 — scan before delivering, or roll back; "Nothing was disclosed" must be true' },
    () => {
        const fx = household();
        const before = fx.store.deliveries.length;

        // A result whose spoken half is clean and whose *data* is tainted. The
        // envelope scans `data` before delivering, so build the failure the
        // other way: taint only the assembled structuredContent, via `note`...
        // which is not caller-controlled. The reachable version is a throw
        // inside deliverPrivately for a later notify recipient.
        const good = careSummary.run({}, { store: fx.store, asker: SARAH_ASKER });
        assert.throws(
            () =>
                toCallToolResult(
                    {
                        ...good,
                        notify: [
                            { recipientId: SARAH, payload: good.privately! },
                            { recipientId: 'nobody-with-this-id', payload: good.privately! }
                        ]
                    },
                    { store: fx.store, asker: SARAH_ASKER, subjectId: MARGARET, tool: 'care_summary', serverLatencyMs: 1 }
                ),
            /unknown person/
        );

        assert.equal(
            fx.store.deliveries.length,
            before,
            `the call failed, src/server.ts answers "Nothing was disclosed", and ` +
                `${fx.store.deliveries.length - before} deliveries were already written to the store`
        );
    }
);

// ---------------------------------------------------------------------------
// F12 / F14 — sharp edges on the tripwire itself
// ---------------------------------------------------------------------------

test(
    'FINDING F12: the exported TAINT_PATTERN is a stateful global regex',
    { todo: 'F12 — export a factory, or drop the /g flag from the exported copy' },
    () => {
        const tainted = `she took ${String(DOSE)} today`;
        const first = TAINT_PATTERN.test(tainted);
        const second = TAINT_PATTERN.test(tainted);
        TAINT_PATTERN.lastIndex = 0;

        assert.equal(
            first,
            second,
            'the same string tests true then false, because /g carries lastIndex across calls. ' +
                'assertNoTaint uses String#match and is safe; any consumer reaching for .test() is not.'
        );
    }
);

test('DEFENDED: assertNoTaint is itself immune to the lastIndex trap', () => {
    const tainted = `she took ${String(DOSE)} today`;
    for (let i = 0; i < 5; i++) {
        assert.throws(() => assertNoTaint(tainted, 'repeat'), LeakError, `iteration ${i} did not throw`);
    }
});

test(
    'FINDING F14: assertNoTaintDeep does not look inside a Map or a Set',
    { todo: 'F14 — walk Map/Set, or document the deep scan as own-enumerable-only' },
    () => {
        assert.throws(
            () => assertNoTaintDeep({ index: new Map([['dose', DOSE]]) }, 'envelope'),
            LeakError,
            'a Protected inside a Map is invisible to the "belt and braces" deep scan'
        );
    }
);

test('DEFENDED: a Map-held Protected does not actually reach the wire', () => {
    // The gap above is a completeness gap, not a live leak: JSON.stringify
    // renders a Map as {}, so nothing escapes even unscanned. Recorded so the
    // severity claim stays honest.
    assert.equal(JSON.stringify({ index: new Map([['dose', DOSE]]) }), '{"index":{}}');
});

test(
    'FINDING F14a: assertNoTaintDeep skips a function-valued toJSON that would run on serialisation',
    { todo: 'F14a — the deep scan and JSON.stringify disagree about what is reachable' },
    () => {
        const smuggler = { toJSON: () => 'Furosemide 40 mg' };
        assert.throws(
            () => assertNoTaintDeep({ data: smuggler }, 'envelope'),
            () => false,
            `the deep scan passed an object whose serialisation is ${JSON.stringify(smuggler)} — ` +
                'the scan walks own enumerable properties, JSON.stringify calls toJSON'
        );
    }
);

test('DEFENDED: SpokenData forbids the toJSON smuggler at compile time', () => {
    // The runtime gap above is only reachable by casting past `SpokenData`,
    // which is scalars only. Pinned in test/negative/protected-into-data.neg.ts.
    const fx = household();
    const { wire } = callTool(fx, checkAdherence, {}, SARAH_ASKER);
    const data = (wire.structuredContent as { data: Record<string, unknown> }).data;
    for (const v of Object.values(data)) {
        assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null, `data holds a ${typeof v}`);
    }
});

// ---------------------------------------------------------------------------
// error text and refusal text — attacked, and holding
// ---------------------------------------------------------------------------

test('DEFENDED: no refusal text quotes the fact it is refusing', () => {
    const fx = household();
    for (const tool of TOOLS) {
        const { out } = callTool(fx, tool, { description: 'x' }, { ...SARAH_ASKER, personId: 'stranger' });
        assert.deepEqual(findPlaintext(out.spoken as string), [], `${tool.name} refusal`);
    }
});

test('DEFENDED: a reveal refusal names the label, never the value', () => {
    const fx = household();
    const sealedFacts = fx.store.sealed.get(MARGARET);
    assert.ok(sealedFacts);
    try {
        revealToPrivateChannel(sealedFacts.homeAddress as never, PRIVATE_CHANNEL_CAPABILITY);
        assert.fail('should have refused');
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.match(err.message, /refused sealed value "home address"/);
        assert.deepEqual(findPlaintext(err.message), []);
    }
});
test('DEFENDED: a LeakError message names markers, never payloads', () => {
    try {
        say`dose ${DOSE as unknown as string}`;
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof LeakError);
        assert.deepEqual(findPlaintext(err.message), []);
        assert.match(err.message, /⟦earshot:[0-9a-f]{16}⟧/);
    }
});

test('DEFENDED: the inbox is the only rendering that contains plaintext', () => {
    const fx = household();
    callTool(fx, careSummary, {}, SARAH_ASKER);

    const inbox = JSON.stringify(renderInbox(fx.store, SARAH, false));
    assert.ok(findPlaintext(inbox).length > 0, 'sanity: the second channel really does carry the detail');

    // ...and nothing else does.
    assert.deepEqual(findPlaintext(JSON.stringify(fx.store.ledger)), []);
    assert.deepEqual(findPlaintext(JSON.stringify(fx.store.soloWindows)), []);
    assert.deepEqual(findPlaintext(JSON.stringify(fx.store.symptoms)), []);
});

test('DEFENDED: a tool name cannot be used to smuggle a value through toolByName', () => {
    for (const t of TOOLS) {
        assert.match(t.name, /^[a-z_]+$/, `${t.name} is not a plain identifier`);
    }
});
