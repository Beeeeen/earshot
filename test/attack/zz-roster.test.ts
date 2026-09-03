/**
 * The findings roster.
 *
 * Every test in this repo that is expected to fail is marked `{ todo: ... }`,
 * so `node --test` reports it as `not ok ... # TODO`, counts it under `# todo`,
 * and exits 0. That keeps the suite green while `src/` belongs to another
 * agent — but it also means a counter that reads only `# pass` and `# fail`
 * (as `scripts/test-all.mjs` does) will not see the findings at all.
 *
 * So this file enumerates them from the source, checks that every known-failing
 * test is labelled with a finding id, and prints the roster where the runner's
 * echoed output will carry it. If someone deletes a finding test, the count
 * here drops and this check fails.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Distinct top-level findings, and where each is proven. */
const EXPECTED_FINDINGS: Record<string, string> = {
    F0: 'attack/unseal.test.ts — unseal() is a public method returning plaintext',
    F1: 'attack/laundering.test.ts — composePrivate has no runtime classification check',
    F2: 'attack/laundering.test.ts — reveal capabilities are exported constants',
    F3: 'attack/ledger.test.ts — the ledger re-labels every row as `medication`',
    F4: 'attack/solo-abuse.test.ts — underSolo re-checks neither asker nor device',
    F5: 'attack/injection.test.ts — the leak alarm is remotely triggerable',
    F6: 'attack/injection.test.ts — caller text is spoken verbatim',
    F7: 'attack/metadata.test.ts — spokenHandle carries the protected medication name',
    F8: 'attack/metadata.test.ts — the spoken item count sizes the protected set',
    F9: 'attack/surface.test.ts — tool metadata is never scanned',
    F10: 'attack/injection.test.ts — subjectOf and the tool bodies disagree',
    F11: 'attack/surface.test.ts — a late failure leaves deliveries committed',
    F12: 'attack/surface.test.ts — TAINT_PATTERN is a stateful global regex',
    F14: 'attack/surface.test.ts — assertNoTaintDeep skips Maps, Sets and toJSON',
    F15: 'compile.test.ts — RESOLVED mid-review: src/negative/ landed; kept as a regression check',
    F17: 'latency/latency.test.ts — /metrics omits the envelope'
};

function testFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...testFiles(full));
        else if (/\.test\.ts$/.test(entry)) out.push(full);
    }
    return out.sort();
}

interface TodoTest {
    file: string;
    name: string;
    finding: string | null;
}

function collectTodos(): TodoTest[] {
    const out: TodoTest[] = [];
    const self = fileURLToPath(import.meta.url);
    for (const file of testFiles(TEST_ROOT)) {
        if (file === self) continue; // this file quotes the pattern it searches for
        const src = readFileSync(file, 'utf8');
        // test( 'name', { todo: ... }  — across one or more lines
        const re = /test\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*\{\s*todo:/gs;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const name = (m[2] as string).replace(/\\'/g, "'");
            const finding = /\b(F\d+)[a-z]?\b/.exec(name)?.[1] ?? null;
            out.push({ file: relative(TEST_ROOT, file).replace(/\\/g, '/'), name, finding });
        }
    }
    return out;
}

const todos = collectTodos();

test('every known-failing test carries a finding id', () => {
    const unlabelled = todos.filter(t => t.finding === null);
    assert.deepEqual(
        unlabelled.map(t => `${t.file}: ${t.name}`),
        [],
        'a todo test with no F-number cannot be tracked or triaged'
    );
});

test('every finding on the roster has at least one test proving it', () => {
    const proven = new Set(todos.map(t => t.finding));
    const missing = Object.keys(EXPECTED_FINDINGS).filter(f => !proven.has(f));
    assert.deepEqual(missing, [], 'a roster entry with no test is an unsubstantiated claim');
});

test('no finding test exists outside the roster', () => {
    const known = new Set(Object.keys(EXPECTED_FINDINGS));
    const strays = [...new Set(todos.map(t => t.finding))].filter(f => f && !known.has(f));
    assert.deepEqual(strays, [], 'add it to EXPECTED_FINDINGS so the report stays complete');
});

test('the roster is printed so a pass/fail-only counter cannot hide it', () => {
    const byFinding = new Map<string, number>();
    for (const t of todos) {
        if (t.finding) byFinding.set(t.finding, (byFinding.get(t.finding) ?? 0) + 1);
    }

    const lines = [
        '',
        '='.repeat(78),
        `EARSHOT QA — ${Object.keys(EXPECTED_FINDINGS).length} distinct findings, ${todos.length} failing assertions.`,
        'These are reported as TAP "# TODO", so they do NOT appear in `# pass` or `# fail`.',
        'scripts/test-all.mjs counts only those two, and will therefore under-report.',
        '='.repeat(78)
    ];
    for (const [id, where] of Object.entries(EXPECTED_FINDINGS)) {
        lines.push(`  ${id.padEnd(4)} ${String(byFinding.get(id) ?? 0).padStart(2)} test(s)  ${where}`);
    }
    lines.push('='.repeat(78), '');
    console.log(lines.join('\n'));

    assert.equal(todos.length, 38, 'the number of failing assertions changed — update the roster deliberately');
});
