/**
 * The self-test runner.
 *
 * Prints a human-readable report and, on the last line, a machine-readable
 * summary that scripts/test-all.mjs folds into the total. The number it prints
 * is the number of assertions that actually executed and passed.
 */

import { allResults, type CheckResult } from './harness.js';
import { latencyReport } from './latency.check.js';

import * as domainChecks from './domain.check.js';
import * as e2eChecks from './e2e.check.js';
import * as latencyChecks from './latency.check.js';
import * as negativeChecks from './negative.check.js';
import * as protectedChecks from './protected.check.js';
import * as toolChecks from './tools.check.js';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

const SUITES: { name: string; run: () => Promise<void> }[] = [
    { name: 'protected values', run: protectedChecks.run },
    { name: 'negative compilation', run: negativeChecks.run },
    { name: 'domain', run: domainChecks.run },
    { name: 'tools', run: toolChecks.run },
    { name: 'end to end', run: e2eChecks.run },
    { name: 'latency', run: latencyChecks.run }
];

async function main(): Promise<void> {
    const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const t0 = Date.now();

    for (const suite of SUITES) {
        if (only.length > 0 && !only.some(o => suite.name.includes(o))) continue;
        try {
            await suite.run();
        } catch (err) {
            console.error(`${RED}suite "${suite.name}" crashed:${RESET}`, err);
            process.exitCode = 1;
        }
    }

    const results = allResults();
    let lastGroup = '';
    for (const r of results) {
        if (r.group !== lastGroup) {
            console.log(`\n${BOLD}${r.group}${RESET}`);
            lastGroup = r.group;
        }
        printResult(r);
    }

    const rep = latencyReport();
    if (rep) {
        console.log(`\n${BOLD}measured latency — ${rep.iterations} calls per tool, budget ${rep.budgetMs} ms${RESET}`);
        console.log(`${DIM}  client-observed round trip (HTTP out -> HTTP in)${RESET}`);
        console.log(pad('  tool', 46) + pad('min', 9) + pad('p50', 9) + pad('p95', 9) + pad('max', 9) + 'n');
        for (const s of rep.roundTrip) {
            console.log(
                pad(`  ${s.tool}`, 46) +
                    pad(s.min.toFixed(1), 9) +
                    pad(s.p50.toFixed(1), 9) +
                    pad(s.p95.toFixed(1), 9) +
                    pad(s.max.toFixed(1), 9) +
                    String(s.count)
            );
        }
        console.log(`${DIM}  server-side handler time only${RESET}`);
        for (const s of rep.serverSide) {
            console.log(
                pad(`  ${s.tool}`, 46) +
                    pad(s.min.toFixed(1), 9) +
                    pad(s.p50.toFixed(1), 9) +
                    pad(s.p95.toFixed(1), 9) +
                    pad(s.max.toFixed(1), 9) +
                    String(s.count)
            );
        }
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const ms = Date.now() - t0;

    console.log('');
    if (failed > 0) {
        console.log(`${RED}${BOLD}${failed} check(s) failed${RESET}, ${passed} passed, ${ms} ms`);
        process.exitCode = 1;
    } else {
        console.log(`${GREEN}${BOLD}${passed} checks passed${RESET} in ${ms} ms`);
    }

    console.log(
        `SELFTEST_RESULT ${JSON.stringify({
            passed,
            failed,
            ms,
            latency: rep
                ? {
                      iterations: rep.iterations,
                      budgetMs: rep.budgetMs,
                      worstRoundTripMs: rep.worstRoundTripMs,
                      roundTrip: rep.roundTrip,
                      serverSide: rep.serverSide
                  }
                : null
        })}`
    );
}

function printResult(r: CheckResult): void {
    if (r.ok) {
        console.log(`  ${GREEN}✓${RESET} ${r.name} ${DIM}${r.ms.toFixed(1)} ms${RESET}`);
    } else {
        console.log(`  ${RED}✗ ${r.name}${RESET}`);
        for (const line of (r.error ?? '').split('\n')) console.log(`      ${RED}${line}${RESET}`);
    }
}

function pad(s: string, n: number): string {
    return s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
