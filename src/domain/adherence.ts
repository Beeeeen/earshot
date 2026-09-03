/** Earshot — adherence arithmetic. Every number a tool speaks is computed here from rows. */

import { addLocalDays, startOfLocalDay } from '../core/tz.js';
import type { Store } from './store.js';
import type { DoseEvent, PersonId } from './types.js';

export interface Slice {
    readonly from: Date;
    readonly to: Date;
    readonly all: readonly DoseEvent[];
    readonly taken: readonly DoseEvent[];
    readonly missed: readonly DoseEvent[];
    readonly pending: readonly DoseEvent[];
    /** Doses whose time has passed, i.e. taken + missed. The denominator. */
    readonly due: number;
    /** taken / due, or null when nothing was due yet. */
    readonly rate: number | null;
    /** Minutes late, averaged over taken doses. */
    readonly meanMinutesLate: number | null;
    readonly latestTaken: DoseEvent | null;
}

export function sliceDoses(store: Store, subjectId: PersonId, from: Date, to: Date): Slice {
    const all = store.dosesBetween(subjectId, from, to);
    const taken = all.filter(d => d.status === 'taken');
    const missed = all.filter(d => d.status === 'missed');
    const pending = all.filter(d => d.status === 'pending');
    const due = taken.length + missed.length;

    const lateness = taken
        .filter(d => d.takenAt !== null)
        .map(d => ((d.takenAt as Date).getTime() - d.scheduledAt.getTime()) / 60000);

    const latestTaken =
        taken
            .filter(d => d.takenAt !== null)
            .sort((a, b) => (b.takenAt as Date).getTime() - (a.takenAt as Date).getTime())[0] ?? null;

    return {
        from,
        to,
        all,
        taken,
        missed,
        pending,
        due,
        rate: due === 0 ? null : taken.length / due,
        meanMinutesLate: lateness.length === 0 ? null : lateness.reduce((a, b) => a + b, 0) / lateness.length,
        latestTaken
    };
}

export function todaySlice(store: Store, subjectId: PersonId, timeZone: string): Slice {
    const now = store.clock.now();
    const from = startOfLocalDay(now, timeZone);
    const to = addLocalDays(from, 1, timeZone);
    return sliceDoses(store, subjectId, from, to);
}

export function weekSlice(store: Store, subjectId: PersonId, timeZone: string): Slice {
    const now = store.clock.now();
    const todayStart = startOfLocalDay(now, timeZone);
    const from = addLocalDays(todayStart, -6, timeZone);
    const to = addLocalDays(todayStart, 1, timeZone);
    return sliceDoses(store, subjectId, from, to);
}

/** Doses in the morning/evening slot of the local day containing `at`. */
export function slotDoses(store: Store, subjectId: PersonId, timeZone: string, slot: 'morning' | 'evening'): DoseEvent[] {
    const s = todaySlice(store, subjectId, timeZone);
    return s.all.filter(d => {
        const h = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(d.scheduledAt)) % 24;
        return slot === 'morning' ? h < 12 : h >= 12;
    });
}

/** "on time" | "a little late" | "late" — a spoken-class judgement, no numbers attached. */
export function punctuality(meanMinutesLate: number | null): 'on time' | 'a few minutes late' | 'late' | 'unknown' {
    if (meanMinutesLate === null) return 'unknown';
    if (meanMinutesLate <= 15) return 'on time';
    if (meanMinutesLate <= 45) return 'a few minutes late';
    return 'late';
}
