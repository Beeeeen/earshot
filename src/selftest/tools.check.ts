/**
 * The eight tools, driven directly, with the full envelope applied.
 *
 * The core assertion repeated for every tool: serialise the entire outgoing
 * MCP result to JSON and grep it for every plaintext secret in the demo
 * household. Not "the spoken field looks fine" — the whole payload.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { DEMO_INSTANT, FixedClock } from '../core/clock.js';
import type { Asker } from '../domain/authz.js';
import {
    DANA,
    DEMO_SECRETS,
    DEMO_SECRET_FRAGMENTS,
    MARGARET,
    SARAH,
    TOM,
    seedHousehold
} from '../domain/seed.js';
import { openSoloWindow } from '../domain/solo.js';
import type { Store } from '../domain/store.js';
import { toCallToolResult } from '../protocol/envelope.js';
import { renderInbox } from '../protocol/private-channel.js';
import { TOOLS, toolByName } from '../tools/index.js';
import { say, type SpokenText } from '../core/spoken.js';
import { assert, check, equal, excludes, group, includes, throws } from './harness.js';

function askerFor(store: Store, id: string, device = 'device-1'): Asker {
    return {
        personId: id,
        displayName: store.person(id)?.displayName ?? id,
        deviceSessionId: device,
        scopes: ['care.read', 'care.write', 'ledger.read', 'solo.open']
    };
}

interface Called {
    readonly spoken: string;
    readonly json: string;
    readonly result: CallToolResult;
}

function callTool(store: Store, name: string, args: Record<string, unknown>, askerId: string, device = 'device-1'): Called {
    const tool = toolByName(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    const asker = askerFor(store, askerId, device);
    const t0 = process.hrtime.bigint();
    const out = tool.run(args, { store, asker });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const result = toCallToolResult(out, {
        store,
        asker,
        subjectId: tool.subjectOf(args),
        tool: name,
        serverLatencyMs: ms
    });
    const first = result.content[0];
    return {
        spoken: first && first.type === 'text' ? first.text : '',
        json: JSON.stringify(result),
        result
    };
}

/** The assertion that matters. Applied to the whole serialised MCP result. */
function assertSpokenSafe(json: string, where: string): void {
    for (const secret of DEMO_SECRETS) excludes(json, secret, `${where}: a protected value reached the MCP channel`);
    for (const frag of DEMO_SECRET_FRAGMENTS) excludes(json, frag, `${where}: a protected fragment reached the MCP channel`);
    excludes(json, '⟦earshot:', `${where}: a taint marker reached the MCP channel`);
}

export async function run(): Promise<void> {
    group('every tool is spoken-safe');

    const CALLS: { name: string; args: Record<string, unknown>; as: string }[] = [
        { name: 'check_adherence', args: {}, as: SARAH },
        { name: 'check_adherence', args: { window: 'week' }, as: SARAH },
        { name: 'next_dose', args: {}, as: SARAH },
        { name: 'log_dose', args: { slot: 'evening' }, as: MARGARET },
        { name: 'report_symptom', args: { description: 'Ankles are puffy again', severity: 3 }, as: MARGARET },
        { name: 'care_summary', args: {}, as: SARAH },
        { name: 'who_can_see', args: {}, as: SARAH },
        { name: 'open_solo_window', args: {}, as: SARAH },
        { name: 'disclosure_ledger', args: { since: 'week' }, as: SARAH }
    ];

    for (const c of CALLS) {
        await check(`${c.name}(${JSON.stringify(c.args)}) as ${c.as} leaks nothing`, () => {
            const store = seedHousehold(new FixedClock(DEMO_INSTANT));
            const out = callTool(store, c.name, c.args, c.as);
            assertSpokenSafe(out.json, c.name);
            assert(out.spoken.length > 0, 'a tool must always say something');
        });
    }

    await check('all eight tools from the spec are registered', () => {
        equal(TOOLS.length, 8, 'eight tools');
        for (const n of [
            'check_adherence',
            'next_dose',
            'log_dose',
            'report_symptom',
            'care_summary',
            'who_can_see',
            'open_solo_window',
            'disclosure_ledger'
        ]) {
            assert(toolByName(n) !== undefined, `missing tool: ${n}`);
        }
    });

    group('check_adherence');

    await check('answers the question rather than refusing it', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'check_adherence', {}, SARAH);
        includes(out.spoken, 'Yes', 'the morning doses were taken, so the answer is yes');
        includes(out.spoken, 'phone', 'and it says where the detail went');
    });

    await check('routes the detail to a delivery on the other channel', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'check_adherence', {}, SARAH);
        equal(store.deliveries.length, 1, 'one delivery created');
        const d = store.deliveries[0];
        assert(d !== undefined && d.recipientId === SARAH, 'delivered to the asker');
        assert((d?.fields.length ?? 0) >= 7, 'the card carries every dose of the day');
        const inbox = JSON.stringify(renderInbox(store, SARAH, false));
        includes(inbox, 'Furosemide', 'the private channel really does carry the medication name');
        includes(inbox, '40 mg', 'and the dose');
    });

    await check('the delivery is not visible to another household member', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'check_adherence', {}, SARAH);
        const danaInbox = JSON.stringify(renderInbox(store, DANA, false));
        excludes(danaInbox, 'Furosemide', "Sarah's delivery must not appear in Dana's inbox");
    });

    await check('Tom, who has no grant, is refused out loud', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'check_adherence', {}, TOM);
        includes(out.spoken, "can't answer", 'the refusal is spoken');
        equal(store.deliveries.length, 0, 'nothing is delivered to Tom');
        assert(
            store.ledger.some(e => e.channel === 'denied' && e.actorId === TOM),
            'the refusal is recorded'
        );
    });

    group('grant scoping');

    await check("Dana's care summary omits diagnosis and prescriber", () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'care_summary', {}, DANA);
        const inbox = JSON.stringify(renderInbox(store, DANA, false));
        includes(inbox, 'Furosemide', 'Dana is granted medications');
        excludes(inbox, 'Congestive heart failure', 'Dana is not granted the diagnosis');
        excludes(inbox, 'Whitfield', 'Dana is not granted the prescriber');
    });

    await check("Sarah's care summary includes diagnosis and prescriber", () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'care_summary', {}, SARAH);
        const inbox = JSON.stringify(renderInbox(store, SARAH, false));
        includes(inbox, 'Congestive heart failure', 'Sarah is granted the diagnosis');
        includes(inbox, 'Whitfield', 'Sarah is granted the prescriber');
    });

    await check('sealed facts never reach even the private channel', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'care_summary', {}, SARAH);
        const inbox = JSON.stringify(renderInbox(store, SARAH, false));
        for (const s of ['BCBSCA-7742-118-903', 'Alameda de las Pulgas', 'Full cardiology chart, 41 pages']) {
            excludes(inbox, s, 'sealed data must not travel on the private channel');
            excludes(out.json, s, 'sealed data must not travel on the MCP channel');
        }
        includes(out.json, 'insurance member number', 'but its existence is named');
        includes(out.json, '/insurance', 'with a pointer into the app');
    });

    group('report_symptom');

    await check('notifies the grant holder without saying what was reported', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'report_symptom', { description: 'My ankles are swollen again', severity: 4 }, MARGARET);
        excludes(out.json, 'ankles', 'the symptom text must not travel on the MCP channel');
        excludes(out.json, 'swollen', 'the symptom text must not travel on the MCP channel');
        includes(out.spoken, 'Sarah', 'but it names who was told, out loud');
        const sarah = JSON.stringify(renderInbox(store, SARAH, false));
        includes(sarah, 'swollen', "Sarah's phone really does get the words");
    });

    await check('Dana reporting a symptom notifies Sarah, not Tom', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'report_symptom', { description: 'Short of breath on the stairs', severity: 3 }, DANA);
        includes(JSON.stringify(renderInbox(store, SARAH, false)), 'Short of breath', 'Sarah is notified');
        equal(store.inboxFor(TOM).length, 0, 'Tom is not');
    });

    group('who_can_see is deliberately loud');

    await check('names everyone with a grant and what they can see', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'who_can_see', {}, SARAH);
        includes(out.spoken, 'Sarah', 'names Sarah');
        includes(out.spoken, 'Dana', 'names Dana');
        includes(out.spoken, 'Margaret', 'names Margaret');
        excludes(out.spoken, 'Tom', 'does not name someone with no grant');
        assertSpokenSafe(out.json, 'who_can_see');
    });

    group('the solo window, end to end through a tool');

    await check('without a window, check_adherence never says a medication name', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const out = callTool(store, 'check_adherence', {}, SARAH);
        excludes(out.spoken, 'Furosemide', 'no medication name in speech');
    });

    await check('with a window, check_adherence does say it, and records every word', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const store = seedHousehold(clock);
        openSoloWindow(store, SARAH, MARGARET, 'device-1');
        const out = callTool(store, 'check_adherence', {}, SARAH, 'device-1');
        includes(out.spoken, 'Furosemide', 'the escape hatch actually works');
        includes(out.json, '"underSoloWindow":true', 'and is flagged in the structured result');
        assert(
            store.ledger.filter(e => e.channel === 'solo-window').length > 5,
            'every field spoken aloud is on the record'
        );
    });

    await check("another person's device does not inherit the window", () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const store = seedHousehold(clock);
        openSoloWindow(store, SARAH, MARGARET, 'device-1');
        const out = callTool(store, 'check_adherence', {}, SARAH, 'device-2');
        excludes(out.spoken, 'Furosemide', 'the other device must stay silent');
    });

    await check('the window stops working after five minutes', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const store = seedHousehold(clock);
        openSoloWindow(store, SARAH, MARGARET, 'device-1');
        clock.advance(5 * 60_000 + 1000);
        const out = callTool(store, 'check_adherence', {}, SARAH, 'device-1');
        excludes(out.spoken, 'Furosemide', 'an expired window must not speak');
        assertSpokenSafe(out.json, 'check_adherence after expiry');
    });

    await check('even inside a solo window, sealed facts are not read out', () => {
        const clock = new FixedClock(DEMO_INSTANT);
        const store = seedHousehold(clock);
        openSoloWindow(store, SARAH, MARGARET, 'device-1');
        const out = callTool(store, 'care_summary', {}, SARAH, 'device-1');
        includes(out.spoken, 'Congestive heart failure', 'the diagnosis is spoken under a window');
        excludes(out.spoken, 'BCBSCA', 'the insurance number is not');
        excludes(out.spoken, 'Alameda de las Pulgas', 'nor the address');
    });

    group('disclosure ledger');

    await check('counts what was said aloud versus what went quietly', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'check_adherence', {}, SARAH);
        callTool(store, 'care_summary', {}, SARAH);
        const out = callTool(store, 'disclosure_ledger', {}, SARAH);
        assertSpokenSafe(out.json, 'disclosure_ledger');
        includes(out.spoken, 'out loud', 'it reports what was spoken');
        includes(out.spoken, 'sent to a phone', 'and what was not');
        const structured = out.result.structuredContent as Record<string, unknown> | undefined;
        const counts = structured?.['data'] as Record<string, number> | undefined;
        assert((counts?.['privateChannel'] ?? 0) > 0, 'private-channel disclosures were counted');
        assert((counts?.['spoken'] ?? 0) > 0, 'spoken disclosures were counted');
        assert((counts?.['total'] ?? 0) >= (counts?.['spoken'] ?? 0) + (counts?.['privateChannel'] ?? 0),
            'the total covers every channel');
    });

    await check('the ledger is append-only within a session', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        callTool(store, 'check_adherence', {}, SARAH);
        const n = store.ledger.length;
        callTool(store, 'next_dose', {}, SARAH);
        assert(store.ledger.length > n, 'entries are added');
        assert(store.ledger.slice(0, n).every((e, i) => e === store.ledger[i]), 'earlier entries are untouched');
    });

    group('the tripwire fires on the real exit path');

    await check('a ToolResult that cast a protected value into `spoken` is rejected by the envelope', async () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const med = store.medications.get('med_furosemide');
        assert(med !== undefined, 'seed must have furosemide');
        // Exactly what a developer who "just needed it to work" would write:
        // cast the protected value to string and interpolate it. The type
        // system stops this (src/negative/interpolate-protected.neg.mts); this
        // check confirms what happens if someone casts past that.
        const sabotaged = {
            spoken: `She took ${String(med.name as unknown as string)} today.` as unknown as SpokenText
        };
        const asker = askerFor(store, SARAH);
        await throws(
            () =>
                toCallToolResult(sabotaged, {
                    store,
                    asker,
                    subjectId: MARGARET,
                    tool: 'sabotage',
                    serverLatencyMs: 0
                }),
            'LeakError',
            'the envelope must throw, not redact'
        );
    });

    await check('the envelope also rejects a protected value smuggled into structuredContent', async () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const med = store.medications.get('med_furosemide');
        assert(med !== undefined, 'seed must have furosemide');
        const sabotaged = {
            spoken: say`Yes, taken.`,
            data: { name: med.name as unknown as string }
        };
        const asker = askerFor(store, SARAH);
        await throws(
            () =>
                toCallToolResult(sabotaged, {
                    store,
                    asker,
                    subjectId: MARGARET,
                    tool: 'sabotage',
                    serverLatencyMs: 0
                }),
            'LeakError',
            'structuredContent is scanned too'
        );
    });

    group('log_dose');

    await check('recording a dose changes the stored rows, not just the sentence', () => {
        const store = seedHousehold(new FixedClock(DEMO_INSTANT));
        const before = store.doses.filter(d => d.status === 'pending').length;
        const out = callTool(store, 'log_dose', { slot: 'evening' }, MARGARET);
        const after = store.doses.filter(d => d.status === 'pending').length;
        assert(after < before, `pending count must fall (${before} -> ${after})`);
        includes(out.spoken, 'Recorded', 'and it says so');
        assertSpokenSafe(out.json, 'log_dose');
    });
}
