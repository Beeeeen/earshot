#!/usr/bin/env node
/**
 * Earshot — one command, one number.
 *
 *   npm run test:all
 *
 * The number it prints is the number that goes in the README and the video, so
 * it is assembled from things that actually ran:
 *
 *   1. a real `tsc` build of src/                            (1 check)
 *   2. src/negative/ — files that MUST fail to compile,
 *      each with the exact error code it claims             (counted by the suite)
 *   3. src/selftest/ — protected values, domain, tools,
 *      end-to-end over real HTTP + OAuth + MCP, latency     (counted by the suite)
 *   4. test/ — whatever the test directory holds, run with
 *      node:test and counted from its TAP output            (counted by node:test)
 *
 * Nothing is estimated and nothing is added by hand. If a suite does not run,
 * its checks are not counted, and the run fails loudly rather than quietly
 * reporting a smaller number.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const RESET = '[0m';

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const SKIP_BUILD = argv.includes('--no-build');

/** @typedef {{ name: string, passed: number, failed: number, ms: number, note?: string }} SuiteResult */

/** @type {SuiteResult[]} */
const suites = [];
let latency = null;

function heading(text) {
    console.log(`\n${BOLD}${text}${RESET}`);
    console.log(`${DIM}${'─'.repeat(Math.max(20, text.length))}${RESET}`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, echo?: boolean }} [opts]
 * @returns {Promise<{ code: number, out: string }>}
 */
function run(cmd, args, opts = {}) {
    return new Promise(resolvePromise => {
        const child = spawn(cmd, args, {
            cwd: ROOT,
            env: { ...process.env, ...(opts.env ?? {}) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const collect = chunk => {
            const text = chunk.toString();
            out += text;
            if (opts.echo && !QUIET) process.stdout.write(text);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('close', code => resolvePromise({ code: code ?? 1, out }));
        child.on('error', err => resolvePromise({ code: 1, out: String(err) }));
    });
}

// ---------------------------------------------------------------------------
// 1. build
// ---------------------------------------------------------------------------

async function build() {
    heading('1. Build (tsc, strict + exactOptionalPropertyTypes)');
    if (SKIP_BUILD) {
        console.log(`${YELLOW}skipped (--no-build)${RESET}`);
        return true;
    }
    const t0 = Date.now();
    const r = await run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
    const ms = Date.now() - t0;
    if (r.code !== 0) {
        console.log(`${RED}✗ src/ does not compile${RESET}`);
        console.log(r.out);
        suites.push({ name: 'build', passed: 0, failed: 1, ms });
        return false;
    }
    console.log(`${GREEN}✓${RESET} src/ compiles cleanly ${DIM}${ms} ms${RESET}`);
    suites.push({ name: 'build', passed: 1, failed: 0, ms });
    return true;
}

// ---------------------------------------------------------------------------
// 2 + 3. the self-test (includes the negative-compilation suite)
// ---------------------------------------------------------------------------

async function selftest() {
    heading('2. Self-test (types, domain, tools, end-to-end, latency)');
    const t0 = Date.now();
    const r = await run(process.execPath, [join(ROOT, 'dist', 'selftest', 'run.js')], { echo: true });
    const ms = Date.now() - t0;

    const line = r.out.split('\n').reverse().find(l => l.startsWith('SELFTEST_RESULT '));
    if (!line) {
        console.log(`${RED}✗ the self-test did not report a result${RESET}`);
        if (QUIET) console.log(r.out);
        suites.push({ name: 'selftest', passed: 0, failed: 1, ms });
        return false;
    }
    const parsed = JSON.parse(line.slice('SELFTEST_RESULT '.length));
    latency = parsed.latency ?? null;
    suites.push({ name: 'selftest', passed: parsed.passed, failed: parsed.failed, ms });
    return r.code === 0 && parsed.failed === 0;
}

// ---------------------------------------------------------------------------
// 4. whatever lives in test/
// ---------------------------------------------------------------------------

function findTestFiles(dir) {
    if (!existsSync(dir)) return [];
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...findTestFiles(full));
        else if (/\.(test|spec)\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
    }
    return out.sort();
}

async function externalTests() {
    heading('3. test/ suites');
    const files = findTestFiles(join(ROOT, 'test'));
    if (files.length === 0) {
        console.log(`${DIM}no files in test/ yet — nothing counted from there${RESET}`);
        suites.push({ name: 'test/', passed: 0, failed: 0, ms: 0, note: 'empty' });
        return true;
    }
    console.log(`${DIM}${files.length} file(s): ${files.map(f => relative(ROOT, f)).join(', ')}${RESET}`);

    const needsStrip = files.some(f => /\.m?ts$/.test(f));
    const args = ['--test'];
    if (needsStrip) args.push('--experimental-strip-types', '--disable-warning=ExperimentalWarning');
    args.push(...files);

    const t0 = Date.now();
    const r = await run(process.execPath, args, { echo: true, env: { EARSHOT_DEMO: '1' } });
    const ms = Date.now() - t0;

    const pass = Number(/^# pass (\d+)/m.exec(r.out)?.[1] ?? '0');
    const fail = Number(/^# fail (\d+)/m.exec(r.out)?.[1] ?? '0');
    if (pass === 0 && fail === 0) {
        console.log(`${RED}✗ test/ produced no TAP counts — treating as a failure${RESET}`);
        suites.push({ name: 'test/', passed: 0, failed: 1, ms });
        return false;
    }
    console.log(`${DIM}node:test reported ${pass} pass, ${fail} fail${RESET}`);
    suites.push({ name: 'test/', passed: pass, failed: fail, ms });
    return r.code === 0 && fail === 0;
}

// ---------------------------------------------------------------------------

async function main() {
    const t0 = Date.now();
    console.log(`${BOLD}Earshot — full verification${RESET}`);
    console.log(`${DIM}node ${process.version} · ${ROOT}${RESET}`);

    let ok = await build();
    if (ok) ok = (await selftest()) && ok;
    else console.log(`\n${YELLOW}skipping the self-test because the build failed${RESET}`);
    if (ok) ok = (await externalTests()) && ok;

    const passed = suites.reduce((n, s) => n + s.passed, 0);
    const failed = suites.reduce((n, s) => n + s.failed, 0);
    const ms = Date.now() - t0;

    heading('Summary');
    for (const s of suites) {
        const mark = s.failed > 0 ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
        const note = s.note ? ` ${DIM}(${s.note})${RESET}` : '';
        console.log(`  ${mark} ${s.name.padEnd(12)} ${String(s.passed).padStart(4)} passed  ${String(s.failed).padStart(3)} failed  ${DIM}${s.ms} ms${RESET}${note}`);
    }

    if (latency) {
        console.log(
            `\n  ${DIM}measured round-trip latency, ${latency.iterations} calls per tool, ` +
                `budget ${latency.budgetMs} ms:${RESET}`
        );
        const worst = latency.roundTrip.reduce((a, b) => (b.p95 > a.p95 ? b : a));
        console.log(
            `  worst p95: ${BOLD}${worst.p95.toFixed(1)} ms${RESET} (${worst.tool}); ` +
                `worst single call: ${BOLD}${latency.worstRoundTripMs.toFixed(1)} ms${RESET}; ` +
                `over budget: ${latency.roundTrip.reduce((n, r) => n + r.overBudget, 0)}`
        );
    }

    console.log('');
    if (failed > 0) {
        console.log(`${RED}${BOLD}${failed} checks failed${RESET}, ${passed} passed, ${ms} ms`);
        process.exit(1);
    }
    console.log(`${GREEN}${BOLD}${passed} checks passed${RESET} in ${ms} ms`);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
