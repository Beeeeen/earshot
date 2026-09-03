/**
 * Minimal IANA time-zone arithmetic on top of Intl, with no dependencies.
 * Needed because a medication schedule is written in wall-clock time ("08:00")
 * and has to survive daylight saving without dragging in a date library.
 */

interface LocalParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
    let f = FORMATTERS.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        FORMATTERS.set(timeZone, f);
    }
    return f;
}

/** Wall-clock parts of `at` as seen in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts {
    const parts = formatter(timeZone).formatToParts(at);
    const get = (t: Intl.DateTimeFormatPartTypes): number => {
        const p = parts.find(x => x.type === t);
        return p ? Number(p.value) : 0;
    };
    // Intl renders midnight as hour "24" in some ICU versions.
    const hour = get('hour') % 24;
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds (west is negative). */
export function offsetMs(at: Date, timeZone: string): number {
    const p = localParts(at, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads the given local time. */
export function fromLocal(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string
): Date {
    const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = new Date(naive - offsetMs(new Date(naive), timeZone));
    // One refinement pass handles the DST transition boundary.
    guess = new Date(naive - offsetMs(guess, timeZone));
    return guess;
}

/** Local midnight in `timeZone` for the day containing `at`. */
export function startOfLocalDay(at: Date, timeZone: string): Date {
    const p = localParts(at, timeZone);
    return fromLocal(p.year, p.month, p.day, 0, 0, timeZone);
}

/** Parse "HH:MM" into [hour, minute]. Throws on anything else. */
export function parseHHMM(s: string): [number, number] {
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) throw new Error(`bad schedule time: ${s}`);
    return [Number(m[1]), Number(m[2])];
}

/** Add `n` whole days to an instant, in local wall-clock terms. */
export function addLocalDays(at: Date, n: number, timeZone: string): Date {
    const p = localParts(at, timeZone);
    return fromLocal(p.year, p.month, p.day + n, p.hour, p.minute, timeZone);
}

/** Weekday name in the given zone, e.g. "Wednesday". */
export function weekdayName(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(at);
}
