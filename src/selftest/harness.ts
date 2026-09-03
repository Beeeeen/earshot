/**
 * A deliberately tiny check harness.
 *
 * Every check in here executes real code against a real seeded store, and
 * several drive a real HTTP server with a real MCP client. The count it prints
 * is the count that goes in the README, so it must not be padded: no check
 * asserts something trivially true, and none of them stub anything out.
 */

export interface CheckResult {
    readonly group: string;
    readonly name: string;
    readonly ok: boolean;
    readonly error: string | null;
    readonly ms: number;
}

const results: CheckResult[] = [];
let currentGroup = 'ungrouped';

export function group(name: string): void {
    currentGroup = name;
}

export async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
    const t0 = process.hrtime.bigint();
    try {
        await fn();
        results.push({
            group: currentGroup,
            name,
            ok: true,
            error: null,
            ms: Number(process.hrtime.bigint() - t0) / 1e6
        });
    } catch (err) {
        results.push({
            group: currentGroup,
            name,
            ok: false,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            ms: Number(process.hrtime.bigint() - t0) / 1e6
        });
    }
}

export function allResults(): readonly CheckResult[] {
    return results;
}

export function reset(): void {
    results.length = 0;
}

// --- assertions -------------------------------------------------------------

export class CheckFailed extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CheckFailed';
    }
}

export function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new CheckFailed(message);
}

export function equal<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new CheckFailed(`${message}\n    expected: ${format(expected)}\n    actual:   ${format(actual)}`);
    }
}

export function includes(haystack: string, needle: string, message: string): void {
    if (!haystack.includes(needle)) {
        throw new CheckFailed(`${message}\n    "${needle}" not found in: ${format(haystack)}`);
    }
}

export function excludes(haystack: string, needle: string, message: string): void {
    if (haystack.includes(needle)) {
        const at = haystack.indexOf(needle);
        throw new CheckFailed(
            `${message}\n    FOUND "${needle}" at offset ${at}: ${format(haystack.slice(Math.max(0, at - 80), at + 120))}`
        );
    }
}

export async function throws(fn: () => unknown | Promise<unknown>, match: string | RegExp, message: string): Promise<void> {
    let thrown: unknown = null;
    try {
        await fn();
    } catch (e) {
        thrown = e;
    }
    if (thrown === null) throw new CheckFailed(`${message}\n    expected a throw, got none`);
    const text = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    const ok = typeof match === 'string' ? text.includes(match) : match.test(text);
    if (!ok) throw new CheckFailed(`${message}\n    expected error matching ${String(match)}\n    actual:   ${text}`);
}

function format(v: unknown): string {
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…` : String(s);
}
