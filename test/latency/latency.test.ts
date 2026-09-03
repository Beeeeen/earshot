/**
 * Latency — measured, not estimated.
 *
 * Alexa+ enforces a 500 ms round trip. The platform documentation does not say
 * whether that budget includes the network hop, so this suite measures the one
 * thing a test can measure honestly — the server-side handler — and states
 * plainly what it leaves out. See RESULTS.md, written by this file.
 *
 * WHAT IS MEASURED
 *   handler  = tool.run(args, ctx) + toCallToolResult(...)
 *              i.e. authorisation, data access, sentence construction, the
 *              private-channel delivery, the taint scans and the ledger write.
 *              This is everything src/server.ts does between parsing a
 *              tools/call and handing back a CallToolResult.
 *   run      = tool.run(...) alone. Reported because that is the number
 *              src/server.ts:141 records into `latency` and publishes at
 *              GET /metrics — it stops the clock *before* the envelope.
 *   serialise = JSON.stringify(CallToolResult), a proxy for MCP framing.
 *
 * WHAT IS NOT MEASURED
 *   - the network hop between Alexa+ and this server (unbounded, not ours)
 *   - TLS, HTTP parsing, Streamable-HTTP transport framing
 *   - OAuth bearer verification (src/auth/oauth.ts)
 *   - the model's own thinking time before and after the call
 *   So the numbers below are a floor for the round trip, not the round trip.
 *
 * Each iteration gets a freshly seeded household warmed to a realistic
 * mid-afternoon state, built outside the timed region, so that a mutating tool
 * (log_dose, report_symptom) and a ledger-reading tool (disclosure_ledger) are
 * measured against the same starting conditions every time.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
    LATENCY_BUDGET_MS,
    MARGARET,
    TOOLS,
    careSummary,
    checkAdherence,
    reportSymptom,
    summarise,
    toCallToolResult,
    type EarshotTool,
    type ToolStats
} from '../support/src.ts';
import { DANA_ASKER, SARAH_ASKER, household } from '../support/harness.ts';

const WARMUP = 50;
const ITERATIONS = 300;

const ARGS: Record<string, Record<string, unknown>> = {
    check_adherence: { window: 'week' },
    next_dose: {},
    log_dose: { slot: 'evening' },
    report_symptom: { description: 'short of breath climbing the stairs', severity: 3 },
    care_summary: {},
    who_can_see: {},
    open_solo_window: {},
    disclosure_ledger: { since: 'today' }
};

/** A household part-way through a normal day: some disclosures already made. */
function warmedHousehold() {
    const fx = household();
    const run = (tool: EarshotTool, args: Record<string, unknown>, who: typeof SARAH_ASKER): void => {
        const out = tool.run(args, { store: fx.store, asker: who });
        toCallToolResult(out, {
            store: fx.store,
            asker: who,
            subjectId: MARGARET,
            tool: tool.name,
            serverLatencyMs: 1
        });
    };
    run(careSummary, {}, SARAH_ASKER);
    run(checkAdherence, { window: 'today' }, SARAH_ASKER);
    run(reportSymptom, { description: 'a bit tired', severity: 2 }, DANA_ASKER);
    return fx;
}

interface Measurement {
    handler: number[];
    run: number[];
    serialise: number[];
}

function measure(tool: EarshotTool): Measurement {
    const args = ARGS[tool.name] ?? {};
    const out: Measurement = { handler: [], run: [], serialise: [] };

    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
        const fx = warmedHousehold(); // outside the timer
        const ctx = { store: fx.store, asker: SARAH_ASKER };
        const envCtx = {
            store: fx.store,
            asker: SARAH_ASKER,
            subjectId: tool.subjectOf(args),
            tool: tool.name,
            serverLatencyMs: 0
        };

        const t0 = process.hrtime.bigint();
        const result = tool.run(args, ctx);
        const t1 = process.hrtime.bigint();
        const wire = toCallToolResult(result, envCtx);
        const t2 = process.hrtime.bigint();
        const json = JSON.stringify(wire);
        const t3 = process.hrtime.bigint();

        assert.ok(json.length > 0);

        if (i >= WARMUP) {
            out.run.push(Number(t1 - t0) / 1e6);
            out.handler.push(Number(t2 - t0) / 1e6);
            out.serialise.push(Number(t3 - t2) / 1e6);
        }
    }
    return out;
}

const measurements = new Map<string, Measurement>();
const handlerStats: ToolStats[] = [];
const runStats: ToolStats[] = [];
const serialiseStats: ToolStats[] = [];

for (const tool of TOOLS) {
    const m = measure(tool);
    measurements.set(tool.name, m);
    // Percentiles come from the project's own summarise(), so the number that
    // goes in the README is produced by the code that ships.
    handlerStats.push(summarise(tool.name, m.handler));
    runStats.push(summarise(tool.name, m.run));
    serialiseStats.push(summarise(tool.name, m.serialise));
}

const slowest = [...handlerStats].sort((a, b) => b.p95 - a.p95)[0] as ToolStats;

test('every tool was measured over the declared number of iterations', () => {
    assert.equal(handlerStats.length, 8, 'all eight tools measured');
    for (const s of handlerStats) {
        assert.equal(s.count, ITERATIONS, `${s.tool}: expected ${ITERATIONS} samples, got ${s.count}`);
    }
});

test('every tool stays inside the 500 ms platform budget at P95', () => {
    for (const s of handlerStats) {
        assert.ok(s.p95 < LATENCY_BUDGET_MS, `${s.tool} P95 = ${s.p95} ms, budget ${LATENCY_BUDGET_MS} ms`);
    }
});

test('no single measured call exceeded the budget', () => {
    for (const s of handlerStats) {
        assert.equal(s.overBudget, 0, `${s.tool} had ${s.overBudget} calls over ${LATENCY_BUDGET_MS} ms (max ${s.max} ms)`);
    }
});

test('the whole handler leaves at least 90% of the budget for the network hop', () => {
    // The claim that matters for the README: even the slowest tool spends a
    // small fraction of the ceiling, so the round trip is dominated by things
    // this project does not control.
    assert.ok(
        slowest.p95 < LATENCY_BUDGET_MS * 0.1,
        `slowest tool ${slowest.tool} P95 = ${slowest.p95} ms, which is more than 10% of the budget`
    );
});

test('serialisation is a rounding error next to the handler', () => {
    for (const s of serialiseStats) {
        assert.ok(s.p95 < 5, `${s.tool} serialise P95 = ${s.p95} ms`);
    }
});

test(
    'FINDING F17: /metrics records the handler without its envelope',
    { todo: 'F17 — record after toCallToolResult, or document metrics as run-only' },
    () => {
        // src/server.ts:141 does `latency.record(tool.name, elapsed)` and then
        // calls `toCallToolResult`, so the published figure omits the taint
        // scans, the private-channel delivery and the ledger write.
        const gaps = handlerStats.map(h => {
            const r = runStats.find(x => x.tool === h.tool) as ToolStats;
            return { tool: h.tool, missingP95: Math.round((h.p95 - r.p95) * 1000) / 1000 };
        });
        const worst = [...gaps].sort((a, b) => b.missingP95 - a.missingP95)[0];

        assert.equal(
            worst?.missingP95,
            0,
            `the number published at /metrics and in structuredContent.serverLatencyMs understates the handler ` +
                `by up to ${worst?.missingP95} ms (${worst?.tool}); per-tool gaps: ` +
                gaps.map(g => `${g.tool} +${g.missingP95}`).join(', ')
        );
    }
);

test('the results table is written to RESULTS.md', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), 'RESULTS.md');
    writeFileSync(path, renderMarkdown(), 'utf8');
    assert.ok(renderMarkdown().includes('| check_adherence |'));
});

function fmt(n: number): string {
    return n.toFixed(3);
}

function renderMarkdown(): string {
    const rows = [...handlerStats].sort((a, b) => a.tool.localeCompare(b.tool));
    const lines: string[] = [];

    lines.push('# Earshot — measured tool latency');
    lines.push('');
    lines.push(
        `Generated by \`test/latency/latency.test.ts\` on Node ${process.version} (${process.platform}/${process.arch}).`
    );
    lines.push(
        `**${WARMUP} warm-up iterations discarded, then ${ITERATIONS} measured iterations per tool** ` +
            `(${(WARMUP + ITERATIONS) * TOOLS.length} tool invocations in total). Percentiles are computed by the ` +
            "project's own `summarise()` in `src/protocol/timing.ts` (nearest-rank), so the arithmetic here is the " +
            'same arithmetic the server uses at `GET /metrics` — though the samples are not the same samples; see ' +
            'the caveat at the end.'
    );
    lines.push('');
    lines.push('## Handler latency (ms)');
    lines.push('');
    lines.push('`tool.run(...)` + `toCallToolResult(...)` — authorisation, data access, sentence building,');
    lines.push('private-channel delivery, both taint scans, and the ledger write.');
    lines.push('');
    lines.push('| Tool | min | median | P95 | max | over 500 ms |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const s of rows) {
        lines.push(`| ${s.tool} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${s.overBudget} |`);
    }
    lines.push('');
    lines.push(
        `**Slowest tool at P95: \`${slowest.tool}\` at ${fmt(slowest.p95)} ms** — ` +
            `${((slowest.p95 / LATENCY_BUDGET_MS) * 100).toFixed(1)}% of the 500 ms platform budget.`
    );
    lines.push('');
    lines.push('## What is and is not in these numbers');
    lines.push('');
    lines.push('**Measured** — everything the server does between receiving a parsed `tools/call` and');
    lines.push('returning a `CallToolResult`:');
    lines.push('');
    lines.push('- the grant-table check (`canAsk`, `canReceivePrivate`)');
    lines.push('- all data access (in-process, in-memory, synchronous by design)');
    lines.push('- spoken-sentence construction, including `say()`\'s taint scan');
    lines.push('- routing the private half to the out-of-band channel');
    lines.push('- `assertNoTaint` / `assertNoTaintDeep` over the outgoing object');
    lines.push('- the disclosure-ledger write');
    lines.push('');
    lines.push('**Not measured** — and therefore not covered by the 500 ms claim below:');
    lines.push('');
    lines.push('- the network round trip between Alexa+ and this server');
    lines.push('- TLS handshake, HTTP parsing, Streamable-HTTP transport framing');
    lines.push('- OAuth bearer-token verification (`src/auth/oauth.ts`)');
    lines.push('- JSON serialisation of the response — measured separately below');
    lines.push('- any time the model spends deciding to call the tool, or speaking the answer');
    lines.push('');
    lines.push(
        'The platform documentation does not state whether its 500 ms ceiling includes the network hop. ' +
            'These figures are a **floor** for the round trip, and the honest claim is the one about headroom: ' +
            `the server-side work is ${fmt(slowest.p95)} ms at worst, so ${fmt(LATENCY_BUDGET_MS - slowest.p95)} ms ` +
            'of the budget remains for everything this project does not control.'
    );
    lines.push('');
    lines.push('## Response serialisation (ms)');
    lines.push('');
    lines.push('`JSON.stringify(CallToolResult)`, as a proxy for transport framing cost.');
    lines.push('');
    lines.push('| Tool | min | median | P95 | max |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const s of [...serialiseStats].sort((a, b) => a.tool.localeCompare(b.tool))) {
        lines.push(`| ${s.tool} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} |`);
    }
    lines.push('');
    lines.push('## Caveat: what `GET /metrics` reports is not this number');
    lines.push('');
    lines.push('`src/server.ts` records the sample *before* calling `toCallToolResult`, so the figure it');
    lines.push('publishes — and the one in `structuredContent.serverLatencyMs` — omits the envelope: the');
    lines.push('taint scans, the private-channel delivery and the ledger write. The gap at P95:');
    lines.push('');
    lines.push('| Tool | run only (P95) | full handler (P95) | omitted |');
    lines.push('|---|---:|---:|---:|');
    for (const h of rows) {
        const r = runStats.find(x => x.tool === h.tool) as ToolStats;
        lines.push(`| ${h.tool} | ${fmt(r.p95)} | ${fmt(h.p95)} | ${fmt(h.p95 - r.p95)} |`);
    }
    lines.push('');
    lines.push('Both are far inside budget, so this is a reporting-accuracy issue rather than a performance one.');
    lines.push('');
    lines.push('## Method');
    lines.push('');
    lines.push('- `process.hrtime.bigint()` around each phase; no wall-clock arithmetic.');
    lines.push('- A fresh household is seeded and warmed to a realistic mid-afternoon state for **every**');
    lines.push('  iteration, outside the timed region, so mutating tools (`log_dose`, `report_symptom`) and');
    lines.push('  ledger-reading tools (`disclosure_ledger`) see identical starting conditions each time.');
    lines.push('- The clock is fixed at `DEMO_INSTANT`, so the data shape is identical across iterations.');
    lines.push('- Single process, no concurrency: this measures cost per call, not throughput under load.');
    lines.push('');
    return lines.join('\n');
}
