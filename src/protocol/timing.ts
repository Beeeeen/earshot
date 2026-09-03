/**
 * Earshot — latency instrumentation.
 *
 * Alexa+ enforces a hard 500 ms round-trip ceiling on MCP tool calls. That is
 * not a target to aim at, it is a wall to stay behind, so every tool call is
 * timed and the numbers are exposed rather than estimated.
 *
 * Two different things are measured and they are NOT the same number:
 *   - `serverLatencyMs` — time inside the tool handler: authorisation, data
 *     access, sentence construction, private-channel delivery, serialisation.
 *     Reported per call in `structuredContent` and aggregated at GET /metrics.
 *   - round-trip — measured by the client in src/selftest/latency.check.ts,
 *     which drives a real MCP client over real HTTP. That is the number that
 *     has to be under 500 ms, and it is the one that goes in the README.
 */

/** The platform ceiling. */
export const LATENCY_BUDGET_MS = 500;

export interface Sample {
    readonly tool: string;
    readonly ms: number;
    readonly at: number;
}

export interface ToolStats {
    readonly tool: string;
    readonly count: number;
    readonly min: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly overBudget: number;
}

const MAX_SAMPLES = 2000;

export class LatencyRecorder {
    #samples: Sample[] = [];

    record(tool: string, ms: number): void {
        this.#samples.push({ tool, ms, at: Date.now() });
        if (this.#samples.length > MAX_SAMPLES) this.#samples.shift();
    }

    /** Time a synchronous or async function with a monotonic high-resolution clock. */
    async time<T>(tool: string, fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
        const t0 = process.hrtime.bigint();
        const value = await fn();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        this.record(tool, ms);
        return { value, ms };
    }

    samples(): readonly Sample[] {
        return this.#samples;
    }

    reset(): void {
        this.#samples = [];
    }

    statsFor(tool: string): ToolStats | null {
        const xs = this.#samples.filter(s => s.tool === tool).map(s => s.ms);
        if (xs.length === 0) return null;
        return summarise(tool, xs);
    }

    all(): ToolStats[] {
        const byTool = new Map<string, number[]>();
        for (const s of this.#samples) {
            const arr = byTool.get(s.tool);
            if (arr) arr.push(s.ms);
            else byTool.set(s.tool, [s.ms]);
        }
        return [...byTool.entries()].map(([tool, xs]) => summarise(tool, xs)).sort((a, b) => a.tool.localeCompare(b.tool));
    }
}

export function summarise(tool: string, xsIn: number[]): ToolStats {
    const xs = [...xsIn].sort((a, b) => a - b);
    const at = (q: number): number => {
        if (xs.length === 0) return 0;
        const i = Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1));
        return xs[i] as number;
    };
    return {
        tool,
        count: xs.length,
        min: round(xs[0] as number),
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        max: round(xs[xs.length - 1] as number),
        overBudget: xs.filter(x => x > LATENCY_BUDGET_MS).length
    };
}

export function round(n: number): number {
    return Math.round(n * 1000) / 1000;
}

/** Process-wide recorder. One per server instance in practice. */
export const latency = new LatencyRecorder();
