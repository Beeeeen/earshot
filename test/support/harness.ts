/**
 * Shared fixtures. Everything is deterministic: a fixed clock at DEMO_INSTANT
 * and the seeded household, so counts asserted in the suites are the counts a
 * demo run produces.
 */

import {
    DANA,
    DEMO_INSTANT,
    FixedClock,
    MARGARET,
    SARAH,
    TOM,
    seedHousehold,
    toCallToolResult,
    type Asker,
    type EarshotTool,
    type PersonId,
    type ToolResult
} from './src.ts';

export const ALL_SCOPES = ['care.read', 'care.write', 'solo.open', 'ledger.read'] as const;

/** An asker as `src/server.ts` builds one from a verified access token. */
export function asker(personId: PersonId, deviceSessionId = 'echo-living-room', displayName?: string): Asker {
    return {
        personId,
        displayName: displayName ?? personId,
        deviceSessionId,
        scopes: [...ALL_SCOPES]
    };
}

export const SARAH_ASKER = asker(SARAH, 'echo-kitchen', 'Sarah');
export const DANA_ASKER = asker(DANA, 'echo-bedroom', 'Dana');
export const TOM_ASKER = asker(TOM, 'echo-porch', 'Tom');
export const MARGARET_ASKER = asker(MARGARET, 'echo-living-room', 'Margaret');

export interface Fixture {
    clock: InstanceType<typeof FixedClock>;
    store: ReturnType<typeof seedHousehold>;
}

/** A fresh household frozen at the demo instant. */
export function household(): Fixture {
    const clock = new FixedClock(DEMO_INSTANT);
    return { clock, store: seedHousehold(clock) };
}

/**
 * Run a tool exactly as `src/server.ts` does: `tool.run(...)` then the envelope.
 * Returns both halves so a suite can assert on the domain result and on the
 * bytes that actually leave over MCP.
 */
export function callTool(
    fx: Fixture,
    tool: EarshotTool,
    args: Record<string, unknown>,
    who: Asker
): { out: ToolResult; wire: ReturnType<typeof toCallToolResult> } {
    const out = tool.run(args, { store: fx.store, asker: who });
    const wire = toCallToolResult(out, {
        store: fx.store,
        asker: who,
        subjectId: tool.subjectOf(args),
        tool: tool.name,
        serverLatencyMs: 1
    });
    return { out, wire };
}

/** Every string that leaves over MCP for one call, flattened. */
export function wireStrings(wire: ReturnType<typeof toCallToolResult>): string[] {
    const out: string[] = [];
    const walk = (v: unknown): void => {
        if (typeof v === 'string') {
            out.push(v);
            return;
        }
        if (Array.isArray(v)) {
            for (const x of v) walk(x);
            return;
        }
        if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                out.push(k);
                walk(x);
            }
        }
    };
    walk(wire);
    return out;
}

/** Capture whatever a function writes to stdout, including via console.log. */
export function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
    };
    try {
        fn();
    } finally {
        (process.stdout as { write: unknown }).write = original;
    }
    return chunks.join('');
}

/**
 * The plaintext facts the demo household holds, written out here so the attack
 * suite can assert "this string never appears" without unsealing anything.
 * Kept in sync with src/domain/seed.ts by `seed-plaintext-is-current` in
 * test/attack/metadata.test.ts, so a change to the seed fails loudly rather
 * than silently making the attack assertions vacuous.
 */
export const PLAINTEXT = {
    medNames: ['Furosemide', 'Metoprolol succinate', 'Apixaban', 'Atorvastatin', 'Potassium chloride'],
    strengths: ['40 mg', '25 mg', '5 mg', '20 mg', '20 mEq'],
    diagnosis: 'Congestive heart failure, NYHA class II; persistent atrial fibrillation',
    prescriber: 'Dr. Alan Whitfield, Bay Cardiology Associates',
    vitals: 'BP 118/72, HR 74 irregular, weight 61.4 kg (up 0.8 kg since Sunday)',
    insurance: 'BCBSCA-7742-118-903',
    address: '1184 Alameda de las Pulgas, Apt 3B, Burlingame CA 94010',
    chart: 'Full cardiology chart, 41 pages, last updated 2026-09-30 by Bay Cardiology Associates'
} as const;

/** Every protected plaintext in the demo household, as one list. */
export function allPlaintext(): string[] {
    return [
        ...PLAINTEXT.medNames,
        ...PLAINTEXT.strengths,
        PLAINTEXT.diagnosis,
        PLAINTEXT.prescriber,
        PLAINTEXT.vitals,
        PLAINTEXT.insurance,
        PLAINTEXT.address,
        PLAINTEXT.chart
    ];
}

/** Assert no protected plaintext appears anywhere in `haystack`. */
export function findPlaintext(haystack: string): string[] {
    const hay = haystack.toLowerCase();
    return allPlaintext().filter(secret => hay.includes(secret.toLowerCase()));
}
