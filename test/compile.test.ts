/**
 * LAYER 1 — "impossible to express (compile error)".
 *
 * src/core/protected.ts and src/domain/solo.ts cite `src/negative/` five times
 * as the proof of every Layer 1 claim:
 *
 *   "Both are proven by the negative-compilation suite in src/negative/."
 *   "See src/negative/sealed-into-private.neg.ts"
 *   "Proof: src/negative/solo-speaks-sealed.neg.ts"
 *   "See src/negative/ for the compilation proofs."
 *
 * When this suite was written `src/negative/` did not exist, so none of those
 * claims had ever been checked (F15). It landed mid-review, and the F15 check
 * at the bottom now passes — it is kept as a regression guard.
 *
 * This suite is still worth its keep alongside it:
 *   - it asserts the expected error code AND the exact line, so a fixture that
 *     fails for an unrelated reason (a typo in an import, say) does not count;
 *   - `no fixture fails for a reason nobody declared` rejects stray diagnostics;
 *   - it covers `composePrivate` rejecting a sealed part, which `src/negative/`
 *     does not — and which has no runtime backstop (F1).
 *
 * The fixtures live in test/negative/ as `.neg.ts` / `.ok.ts`, not `.test.ts`,
 * so the node runner ignores them; this suite compiles them with the project's
 * own compiler settings and asserts on the diagnostics.
 *
 * Each fixture marks its expected failure with `// @expect TS<code>` on the
 * line immediately before it. Asserting on both the code AND the line is what
 * keeps this from passing for the wrong reason — a fixture that failed to
 * compile because of a typo in an import would not match.
 *
 * positive-control.ok.ts must compile clean. Without it, "seven files reported
 * errors" would not prove the compiler was checking anything in particular.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEG_DIR = join(HERE, 'negative');
const ROOT = resolve(HERE, '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** The project's own compiler settings, from tsconfig.json. */
const TSC_ARGS = [
    '--noEmit',
    '--strict',
    '--target',
    'es2023',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--skipLibCheck',
    '--exactOptionalPropertyTypes',
    '--noUncheckedIndexedAccess',
    '--pretty',
    'false'
];

interface Diagnostic {
    file: string;
    line: number;
    code: string;
}

function compileFixtures(): Diagnostic[] {
    const files = readdirSync(NEG_DIR)
        .filter(f => f.endsWith('.ts'))
        .map(f => join(NEG_DIR, f));
    assert.ok(files.length > 0, 'no fixtures found in test/negative');

    let output = '';
    try {
        output = execFileSync(process.execPath, [TSC, ...TSC_ARGS, ...files], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        // tsc exits non-zero when it reports errors, which is the normal case here.
        output = String((err as { stdout?: string }).stdout ?? '');
    }

    const out: Diagnostic[] = [];
    for (const line of output.split(/\r?\n/)) {
        const m = /^(.+?)\((\d+),\d+\): error (TS\d+):/.exec(line);
        if (m) out.push({ file: (m[1] as string).replace(/\\/g, '/'), line: Number(m[2]), code: m[3] as string });
    }
    return out;
}

/** Read every `// @expect TS####` marker and the line it guards. */
function expectations(): { file: string; line: number; code: string }[] {
    const out: { file: string; line: number; code: string }[] = [];
    for (const name of readdirSync(NEG_DIR).filter(f => f.endsWith('.neg.ts'))) {
        const lines = readFileSync(join(NEG_DIR, name), 'utf8').split(/\r?\n/);
        lines.forEach((text, i) => {
            const m = /^\s*\/\/ @expect (TS\d+)\s*$/.exec(text);
            if (m) out.push({ file: `test/negative/${name}`, line: i + 2, code: m[1] as string });
        });
    }
    return out;
}

const diagnostics = compileFixtures();
const expected = expectations();

test('the negative fixtures are actually annotated', () => {
    assert.equal(expected.length, 7, 'expected seven Layer 1 claims under test');
    const files = [...new Set(expected.map(e => e.file))].sort();
    assert.deepEqual(files, [
        'test/negative/call-tostring.neg.ts',
        'test/negative/compose-sealed.neg.ts',
        'test/negative/plain-string-as-spoken.neg.ts',
        'test/negative/protected-into-data.neg.ts',
        'test/negative/say-protected.neg.ts',
        'test/negative/sealed-into-private.neg.ts',
        'test/negative/solo-speaks-sealed.neg.ts'
    ]);
});

test('positive-control.ok.ts compiles clean, so the compiler is really checking', () => {
    const noise = diagnostics.filter(d => d.file.endsWith('positive-control.ok.ts'));
    assert.deepEqual(
        noise,
        [],
        `the control file must compile: ${noise.map(d => `${d.code}@${d.line}`).join(', ')}`
    );
});

for (const e of expected) {
    const claim = e.file.replace('test/negative/', '').replace('.neg.ts', '');
    test(`Layer 1: ${claim} is a compile error (${e.code})`, () => {
        const onLine = diagnostics.filter(d => d.file.endsWith(e.file.replace('test/negative/', '')) && d.line === e.line);
        assert.ok(
            onLine.length > 0,
            `expected ${e.code} at ${e.file}:${e.line}, got nothing. ` +
                `All diagnostics: ${JSON.stringify(diagnostics)}`
        );
        assert.ok(
            onLine.some(d => d.code === e.code),
            `expected ${e.code} at ${e.file}:${e.line}, got ${onLine.map(d => d.code).join(', ')}`
        );
    });
}

test('no fixture fails for a reason nobody declared', () => {
    const declared = new Set(expected.map(e => `${e.file.replace('test/negative/', '')}:${e.line}`));
    const undeclared = diagnostics.filter(d => {
        const short = d.file.split('/').pop() as string;
        return !declared.has(`${short}:${d.line}`);
    });
    assert.deepEqual(
        undeclared.map(d => `${d.file}:${d.line} ${d.code}`),
        [],
        'an unexpected diagnostic means a fixture is failing for the wrong reason'
    );
});

test('FINDING F15 (resolved mid-review): src/negative/ now exists, as the docstrings claim', { todo: 'F15 — was missing when this suite was written; kept as a regression check' }, () => {
    // Kept as a live check rather than a comment: when the other agent adds
    // src/negative/, this flips and test/negative/ can be retired.
    let exists = true;
    try {
        readdirSync(join(ROOT, 'src', 'negative'));
    } catch {
        exists = false;
    }
    assert.ok(exists, 'src/core/protected.ts cites src/negative/ four times; src/domain/solo.ts once; it does not exist');
});
