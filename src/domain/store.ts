/**
 * Earshot — the data layer.
 *
 * In-process, in-memory, synchronous. This is a deliberate design choice, not
 * a shortcut: Alexa+ enforces a 500 ms round-trip ceiling on MCP tools, and a
 * network hop to a database spends a third of that budget before any work
 * happens. Every read below is a Map lookup or a filter over a few dozen rows,
 * so tool latency is dominated by JSON serialisation and the HTTP hop.
 */

import type { Clock } from '../core/clock.js';
import type {
    ClinicalContext,
    Delivery,
    DoseEvent,
    Grant,
    LedgerEntry,
    Medication,
    Person,
    PersonId,
    SealedFacts,
    SoloWindow,
    SymptomReport
} from './types.js';

let counter = 0;
/** Deterministic-ish id. Prefixed so ledger rows read well. */
export function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter.toString(36).padStart(4, '0')}`;
}

export function resetIdCounter(): void {
    counter = 0;
}

export class Store {
    readonly people = new Map<PersonId, Person>();
    readonly grants: Grant[] = [];
    readonly medications = new Map<string, Medication>();
    readonly doses: DoseEvent[] = [];
    readonly symptoms: SymptomReport[] = [];
    readonly clinical = new Map<PersonId, ClinicalContext>();
    readonly sealed = new Map<PersonId, SealedFacts>();
    readonly ledger: LedgerEntry[] = [];
    readonly deliveries: Delivery[] = [];
    readonly soloWindows: SoloWindow[] = [];

    /**
     * Written as an explicit field rather than a TypeScript parameter
     * property: parameter properties are erased-with-emit syntax, which
     * `node --test --experimental-strip-types` refuses
     * (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). This one line was enough to make
     * `src/` unloadable under the runner the package declares.
     */
    readonly clock: Clock;

    constructor(clock: Clock) {
        this.clock = clock;
    }

    person(id: PersonId): Person | undefined {
        return this.people.get(id);
    }

    requirePerson(id: PersonId): Person {
        const p = this.people.get(id);
        if (!p) throw new Error(`unknown person: ${id}`);
        return p;
    }

    medsFor(subjectId: PersonId): Medication[] {
        return [...this.medications.values()].filter(m => m.subjectId === subjectId);
    }

    grantsForSubject(subjectId: PersonId): Grant[] {
        return this.grants.filter(g => g.subjectId === subjectId);
    }

    grantFor(viewerId: PersonId, subjectId: PersonId): Grant | undefined {
        return this.grants.find(g => g.viewerId === viewerId && g.subjectId === subjectId);
    }

    /** Doses scheduled within [from, to). */
    dosesBetween(subjectId: PersonId, from: Date, to: Date): DoseEvent[] {
        const lo = from.getTime();
        const hi = to.getTime();
        return this.doses
            .filter(d => d.subjectId === subjectId && d.scheduledAt.getTime() >= lo && d.scheduledAt.getTime() < hi)
            .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    }

    /** The next dose that is still pending, at or after `at`. */
    nextPending(subjectId: PersonId, at: Date): DoseEvent | undefined {
        return this.doses
            .filter(d => d.subjectId === subjectId && d.status === 'pending' && d.scheduledAt.getTime() >= at.getTime())
            .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];
    }

    /** The most recent dose whose scheduled time has passed. */
    mostRecentDue(subjectId: PersonId, at: Date): DoseEvent | undefined {
        return this.doses
            .filter(d => d.subjectId === subjectId && d.scheduledAt.getTime() <= at.getTime())
            .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())[0];
    }

    replaceDose(next: DoseEvent): void {
        const i = this.doses.findIndex(d => d.id === next.id);
        if (i >= 0) this.doses[i] = next;
        else this.doses.push(next);
    }

    appendLedger(e: Omit<LedgerEntry, 'id' | 'at'>): LedgerEntry {
        const row: LedgerEntry = { id: nextId('led'), at: this.clock.now(), ...e };
        this.ledger.push(row);
        return row;
    }

    /** Newest first, with the same insertion-order tiebreak as `inboxFor`. */
    ledgerFor(subjectId: PersonId, since: Date): LedgerEntry[] {
        return this.ledger
            .map((e, i) => ({ e, i }))
            .filter(x => x.e.subjectId === subjectId && x.e.at.getTime() >= since.getTime())
            .sort((a, b) => b.e.at.getTime() - a.e.at.getTime() || b.i - a.i)
            .map(x => x.e);
    }

    /**
     * Newest first. The tiebreak on insertion order matters: under a fixed
     * clock every delivery in a session shares a timestamp, and a plain
     * date sort would leave them in arrival order, i.e. oldest first.
     */
    inboxFor(recipientId: PersonId): Delivery[] {
        return this.deliveries
            .map((d, i) => ({ d, i }))
            .filter(x => x.d.recipientId === recipientId)
            .sort((a, b) => b.d.createdAt.getTime() - a.d.createdAt.getTime() || b.i - a.i)
            .map(x => x.d);
    }

    delivery(id: string): Delivery | undefined {
        return this.deliveries.find(d => d.id === id);
    }
}
