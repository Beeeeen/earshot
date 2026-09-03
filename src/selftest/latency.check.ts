/**
 * Measured latency. Not estimated, not modelled.
 *
 * Alexa+ enforces a 500 ms round trip. What is timed here is the whole thing
 * as a client sees it: HTTP request out, JSON-RPC decoded, bearer token
 * verified, grant table consulted, sentence built, private payload routed to
 * the other channel, ledger written, response serialised, HTTP response in.
 *
 * The table this prints is the table that goes in the README.
 */

import { DEMO_INSTANT, FixedClock } from '../core/clock.js';
import { SARAH } from '../domain/seed.js';
import { startServer, type EarshotServerHandle } from '../server.js';
import { LATENCY_BUDGET_MS, summarise, type ToolStats } from '../protocol/timing.js';
import { assert, check, group } from './harness.js';
import { connectMcp, linkAccount } from './client.js';

/** Iterations per tool. Enough for a p95 to mean something without padding the run. */
const N = Number(process.env['EARSHOT_LATENCY_N'] ?? 40);
const WARMUP = 5;

export interface LatencyReport {
    readonly iterations: number;
    readonly budgetMs: number;
    readonly roundTrip: readonly ToolStats[];
    readonly serverSide: readonly ToolStats[];
    readonly worstRoundTripMs: number;
}

let report: LatencyReport | null = null;

export function latencyReport(): LatencyReport | null {
    return report;
}

const CALLS: { name: string; arguments: Record<string, unknown> }[] = [
    { name: 'check_adherence', arguments: {} },
    { name: 'check_adherence', arguments: { window: 'week' } },
    { name: 'next_dose', arguments: {} },
    { name: 'log_dose', arguments: { slot: 'evening' } },
    { name: 'report_symptom', arguments: { description: 'A bit dizzy standing up', severity: 2 } },
    { name: 'care_summary', arguments: {} },
    { name: 'who_can_see', arguments: {} },
    { name: 'open_solo_window', arguments: {} },
    { name: 'disclosure_ledger', arguments: { since: 'week' } }
];

export async function run(): Promise<void> {
    group('latency (measured, real round trips)');

    let handle: EarshotServerHandle | null = null;
    try {
        handle = await startServer({ port: 0, clock: new FixedClock(DEMO_INSTANT) });
        const sarah = await linkAccount(handle.url, SARAH);
        const session = await connectMcp(handle.url, sarah.accessToken);

        const samples = new Map<string, number[]>();

        for (const call of CALLS) {
            // Short, stable labels: this table is read off a screen in the video.
            const suffix = Object.entries(call.arguments)
                .map(([, v]) => String(v))
                .join(',')
                .slice(0, 14);
            const key = suffix.length > 0 ? `${call.name} [${suffix}]` : call.name;
            const xs: number[] = [];
            for (let i = 0; i < N + WARMUP; i++) {
                const t0 = process.hrtime.bigint();
                await session.client.callTool({ name: call.name, arguments: call.arguments });
                const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                if (i >= WARMUP) xs.push(ms);
            }
            samples.set(key, xs);
        }

        const roundTrip = [...samples.entries()].map(([k, xs]) => summarise(k, xs));
        const serverSide = handle.latency.all();
        const worst = Math.max(...roundTrip.map(r => r.max));

        report = {
            iterations: N,
            budgetMs: LATENCY_BUDGET_MS,
            roundTrip,
            serverSide,
            worstRoundTripMs: worst
        };

        for (const stat of roundTrip) {
            await check(`${stat.tool}: p95 ${stat.p95} ms is inside the ${LATENCY_BUDGET_MS} ms budget`, () => {
                assert(
                    stat.p95 < LATENCY_BUDGET_MS,
                    `p95 was ${stat.p95} ms over ${stat.count} calls (min ${stat.min}, max ${stat.max})`
                );
            });
        }

        await check(`no single call in ${roundTrip.reduce((a, r) => a + r.count, 0)} exceeded the budget`, () => {
            const offenders = roundTrip.filter(r => r.max >= LATENCY_BUDGET_MS);
            assert(
                offenders.length === 0,
                `over budget: ${offenders.map(o => `${o.tool} max ${o.max} ms`).join('; ')}`
            );
        });

        await check('server-side handler time is a small fraction of the round trip', () => {
            const serverMax = Math.max(...serverSide.map(s => s.p95));
            assert(serverMax < LATENCY_BUDGET_MS / 2, `server-side p95 was ${serverMax} ms`);
        });

        await session.close();
    } finally {
        if (handle) await handle.close();
    }
}
