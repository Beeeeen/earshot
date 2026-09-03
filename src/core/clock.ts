/**
 * Injectable clock. The demo household must load deterministically, and
 * latency tests must not be at the mercy of wall-clock drift, so nothing in
 * the domain calls `Date.now()` directly.
 */
export interface Clock {
    now(): Date;
}

export class SystemClock implements Clock {
    now(): Date {
        return new Date();
    }
}

export class FixedClock implements Clock {
    #at: Date;
    constructor(at: Date) {
        this.#at = at;
    }
    now(): Date {
        return new Date(this.#at.getTime());
    }
    advance(ms: number): void {
        this.#at = new Date(this.#at.getTime() + ms);
    }
    set(at: Date): void {
        this.#at = new Date(at.getTime());
    }
}

/**
 * The instant the demo household is frozen at: Wednesday 14 October 2026,
 * 2:05 PM in Burlingame, California (21:05 UTC, PDT = UTC-7).
 * Morning doses are behind us; evening doses are not yet due. That is the
 * moment where "did Mum take her pills today?" is a real question.
 */
export const DEMO_INSTANT = new Date('2026-10-14T21:05:00.000Z');

/**
 * Resolve the clock for this process.
 * `EARSHOT_FIXED_NOW=<iso>` or `EARSHOT_DEMO=1` freeze time.
 */
export function resolveClock(env: NodeJS.ProcessEnv = process.env): Clock {
    const iso = env['EARSHOT_FIXED_NOW'];
    if (iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) throw new Error(`EARSHOT_FIXED_NOW is not a valid date: ${iso}`);
        return new FixedClock(d);
    }
    if (env['EARSHOT_DEMO'] === '1') return new FixedClock(DEMO_INSTANT);
    return new SystemClock();
}
