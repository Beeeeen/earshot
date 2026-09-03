/**
 * The compile-time half of the guarantee, verified by actually running tsc.
 *
 * Each file in src/negative/ declares the error code it must produce. A file
 * that fails to compile for the *wrong* reason (a typo, a bad import) is a
 * failed check, not a passed one — otherwise this suite would be theatre.
 *
 * The positive control must compile cleanly. Without it, "everything failed to
 * compile" would look like success.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { assert, check, group, includes } from './harness.js';

const exec = promisify(execFile);

function projectRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        dir = resolve(dir, '..');
    }
    throw new Error('could not locate the project root');
}

const TSC_FLAGS = [
    '--noEmit',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--strict',
    '--noUncheckedIndexedAccess',
    '--exactOptionalPropertyTypes',
    '--skipLibCheck'
];

async function tsc(root: string, file: string): Promise<{ code: number; out: string }> {
    const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
        const { stdout, stderr } = await exec(process.execPath, [tscBin, ...TSC_FLAGS, file], {
            cwd: root,
            maxBuffer: 8 * 1024 * 1024
        });
        return { code: 0, out: `${stdout}${stderr}` };
    } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

export async function run(): Promise<void> {
    group('negative compilation (the guarantee is a compile error)');

    const root = projectRoot();
    const dir = join(root, 'src', 'negative');
    const files = readdirSync(dir)
        .filter(f => f.endsWith('.mts'))
        .sort();

    assert(files.length >= 9, `expected the negative suite to exist, found ${files.length} files`);

    for (const file of files) {
        const full = join(dir, file);
        const header = readFileSync(full, 'utf8').split('\n').slice(0, 8).join('\n');
        const expected = /@expect:\s*(\S+)/.exec(header)?.[1];
        const what = /@what:\s*(.+)/.exec(header)?.[1] ?? file;
        assert(expected !== undefined, `${file} is missing its "// @expect:" header`);

        if (expected === 'OK') {
            await check(`positive control compiles: ${what}`, async () => {
                const r = await tsc(root, full);
                assert(r.code === 0, `the positive control must compile, but tsc said:\n${r.out}`);
            });
            continue;
        }

        await check(`${expected}: ${what}`, async () => {
            const r = await tsc(root, full);
            assert(r.code !== 0, `${file} compiled, but it must not. The guarantee is not enforced.`);
            includes(r.out, `error ${expected}`, `${file} failed to compile, but with the wrong error:\n${r.out}`);
            // The failure must be in the negative file itself, not in an import.
            includes(r.out, file, `the error must originate in ${file}, not somewhere upstream:\n${r.out}`);
        });
    }

    await check('the whole project still typechecks under the same strictness', async () => {
        const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
        try {
            await exec(process.execPath, [tscBin, '-p', join(root, 'tsconfig.json'), '--noEmit'], {
                cwd: root,
                maxBuffer: 8 * 1024 * 1024
            });
        } catch (err) {
            const e = err as { stdout?: string };
            throw new Error(`src/ does not typecheck:\n${e.stdout ?? ''}`);
        }
    });
}
