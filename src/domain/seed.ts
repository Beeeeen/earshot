/**
 * Earshot — the demo household.
 *
 * Margaret Chen, 78, lives alone in Burlingame. Her daughter Sarah checks in
 * from Seattle. Dana comes three mornings a week as a home health aide. Tom
 * from next door has an Earshot account because he waters the plants; he has
 * no grant, and the system says so out loud.
 *
 * Nothing here is hardcoded output. The dose history is *generated* from the
 * schedule plus an explicit adherence pattern, so every count a tool speaks is
 * computed from these rows at call time.
 */

import type { Clock } from '../core/clock.js';
import { priv, sealed } from '../core/protected.js';
import { addLocalDays, fromLocal, localParts, parseHHMM } from '../core/tz.js';
import { Store, nextId, resetIdCounter } from './store.js';
import type { DoseEvent, Grant, Medication, Person } from './types.js';

export const MARGARET = 'margaret';
export const SARAH = 'sarah';
export const DANA = 'dana';
export const TOM = 'tom';

export const HOUSEHOLD_TZ = 'America/Los_Angeles';

/** How many days of dose history the demo household carries. */
export const HISTORY_DAYS = 7;

const PEOPLE: readonly Person[] = [
    {
        id: MARGARET,
        displayName: 'Margaret',
        role: 'subject',
        relationship: 'the person being cared for',
        timeZone: HOUSEHOLD_TZ,
        hasLinkedDevice: true
    },
    {
        id: SARAH,
        displayName: 'Sarah',
        role: 'family',
        relationship: 'daughter',
        timeZone: 'America/Los_Angeles',
        hasLinkedDevice: true
    },
    {
        id: DANA,
        displayName: 'Dana',
        role: 'aide',
        relationship: 'home health aide',
        timeZone: HOUSEHOLD_TZ,
        hasLinkedDevice: true
    },
    {
        id: TOM,
        displayName: 'Tom',
        role: 'unlinked',
        relationship: 'neighbour',
        timeZone: HOUSEHOLD_TZ,
        hasLinkedDevice: false
    }
];

interface MedSpec {
    id: string;
    name: string;
    strength: string;
    indication: string;
    instructions: string;
    schedule: string[];
    handle: string;
}

/**
 * A realistic regimen for congestive heart failure with atrial fibrillation.
 *
 * `spokenHandle` is what the assistant may say aloud when it must distinguish
 * one item from another. It names the *slot* — time of day and position in the
 * list — and nothing clinical: "the first morning one", not "the morning water
 * pill". The earlier handles named the drug class, which is the protected
 * `indication` restated in plainer words, and "the morning potassium" carried
 * a word out of the protected `name` verbatim. Class-free handles also close
 * the inference route: handle + schedule no longer reconstructs
 * loop-diuretic + potassium + rate-control + anticoagulant, i.e. the protected
 * diagnosis at coarser resolution. See test/attack/metadata.test.ts (F7).
 *
 * The residual disclosure is deliberate and stated: the handles reveal how
 * many items exist and at which times, because a person who is told "take the
 * second morning one" needs exactly that much to act.
 */
const MEDS: readonly MedSpec[] = [
    {
        id: 'med_furosemide',
        name: 'Furosemide',
        strength: '40 mg',
        indication: 'fluid retention from congestive heart failure',
        instructions: 'Take in the morning. Expect extra trips to the bathroom for about four hours.',
        schedule: ['08:00'],
        handle: 'the first morning one'
    },
    {
        id: 'med_metoprolol',
        name: 'Metoprolol succinate',
        strength: '25 mg',
        indication: 'heart rate control in atrial fibrillation',
        instructions: 'Take with food, morning and evening. Do not stop suddenly.',
        schedule: ['08:00', '20:00'],
        handle: 'the first of the twice-daily pair'
    },
    {
        id: 'med_apixaban',
        name: 'Apixaban',
        strength: '5 mg',
        indication: 'stroke prevention in atrial fibrillation',
        instructions: 'Twice daily, twelve hours apart. Report any unusual bruising.',
        schedule: ['08:00', '20:00'],
        handle: 'the second of the twice-daily pair'
    },
    {
        id: 'med_atorvastatin',
        name: 'Atorvastatin',
        strength: '20 mg',
        indication: 'cholesterol',
        instructions: 'Take in the evening.',
        schedule: ['20:00'],
        handle: 'the evening one'
    },
    {
        id: 'med_potassium',
        name: 'Potassium chloride',
        strength: '20 mEq',
        indication: 'replacing potassium lost to the water pill',
        instructions: 'Take with a full glass of water, in the morning.',
        schedule: ['08:00'],
        handle: 'the second morning one'
    }
];

const CLINICAL = {
    diagnosis: 'Congestive heart failure, NYHA class II; persistent atrial fibrillation',
    prescriber: 'Dr. Alan Whitfield, Bay Cardiology Associates',
    vitals: 'BP 118/72, HR 74 irregular, weight 61.4 kg (up 0.8 kg since Sunday)'
} as const;

const SEALED_FACTS = {
    insurance: 'BCBSCA-7742-118-903',
    address: '1184 Alameda de las Pulgas, Apt 3B, Burlingame CA 94010',
    chart: 'Full cardiology chart, 41 pages, last updated 2026-09-30 by Bay Cardiology Associates'
} as const;

/**
 * Every plaintext string in the demo household that must never appear on the
 * MCP channel. Built from the same literals used to seed the store, so the
 * leak scan cannot drift out of sync with the data it is scanning for.
 *
 * The self-test greps raw HTTP response bodies for these. That is the
 * end-to-end proof: not "the type says so", but "the bytes on the wire do not
 * contain it".
 */
export const DEMO_SECRETS: readonly string[] = [
    ...MEDS.flatMap(m => [m.name, m.strength, m.indication, m.instructions]),
    CLINICAL.diagnosis,
    CLINICAL.prescriber,
    CLINICAL.vitals,
    SEALED_FACTS.insurance,
    SEALED_FACTS.address,
    SEALED_FACTS.chart
];

/** A few high-signal fragments, for scanning text that may have been reflowed. */
export const DEMO_SECRET_FRAGMENTS: readonly string[] = [
    'Furosemide',
    'Metoprolol',
    'Apixaban',
    'Atorvastatin',
    'Potassium chloride',
    'Congestive heart failure',
    'atrial fibrillation',
    'Whitfield',
    'Bay Cardiology',
    'BCBSCA',
    'Alameda de las Pulgas',
    '118/72'
];

/**
 * The adherence pattern, written out explicitly so the generated history is
 * reproducible and so the "missed dose" in the demo is a fact in the data
 * rather than a string in a tool.
 *
 * key: `${daysAgo}:${medId}:${HH:MM}`
 */
const MISSED: ReadonlySet<string> = new Set([
    '2:med_furosemide:08:00', //  Monday morning: skipped, and it shows in the weekly number
    '5:med_atorvastatin:20:00' // Friday evening: fell asleep early
]);

/** Deterministic "how many minutes late was this dose", derived from its key. */
function minutesLate(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 23; // 0..22 minutes
}

export interface SeedOptions {
    /** Defaults to `clock.now()`. */
    readonly asOf?: Date;
}

export function seedHousehold(clock: Clock, opts: SeedOptions = {}): Store {
    resetIdCounter();
    const store = new Store(clock);
    const now = opts.asOf ?? clock.now();

    for (const p of PEOPLE) store.people.set(p.id, p);

    for (const spec of MEDS) {
        const med: Medication = {
            id: spec.id,
            subjectId: MARGARET,
            name: priv(spec.name, 'medication name', 'medication'),
            strength: priv(spec.strength, 'dose', 'medication'),
            indication: priv(spec.indication, 'reason prescribed', 'diagnosis'),
            instructions: priv(spec.instructions, 'instructions', 'medication'),
            schedule: spec.schedule,
            spokenHandle: spec.handle
        };
        store.medications.set(med.id, med);
    }

    store.clinical.set(MARGARET, {
        subjectId: MARGARET,
        diagnosis: priv(CLINICAL.diagnosis, 'diagnosis', 'diagnosis'),
        prescriber: priv(CLINICAL.prescriber, 'prescriber', 'clinician'),
        lastVitals: priv(CLINICAL.vitals, 'latest vitals', 'vitals')
    });

    store.sealed.set(MARGARET, {
        subjectId: MARGARET,
        insuranceMemberId: sealed(SEALED_FACTS.insurance, 'insurance member number', 'identity'),
        homeAddress: sealed(SEALED_FACTS.address, 'home address', 'identity'),
        fullChartSummary: sealed(SEALED_FACTS.chart, 'complete medical record', 'identity')
    });

    const grantedAt = addLocalDays(now, -180, HOUSEHOLD_TZ);
    const grants: Grant[] = [
        {
            viewerId: SARAH,
            subjectId: MARGARET,
            level: 'private',
            categories: ['medication', 'schedule', 'diagnosis', 'symptom', 'vitals', 'clinician'],
            grantedBy: MARGARET,
            grantedAt
        },
        {
            // The aide can see what to give and when. Not why. Not who prescribed it.
            viewerId: DANA,
            subjectId: MARGARET,
            level: 'private',
            categories: ['medication', 'schedule', 'symptom'],
            grantedBy: MARGARET,
            grantedAt
        },
        {
            viewerId: MARGARET,
            subjectId: MARGARET,
            level: 'private',
            categories: ['medication', 'schedule', 'diagnosis', 'symptom', 'vitals', 'clinician', 'identity'],
            grantedBy: MARGARET,
            grantedAt
        }
        // Tom is deliberately absent. An empty row is not the same as no row.
    ];
    store.grants.push(...grants);

    store.doses.push(...generateDoses(now, store));

    return store;
}

function generateDoses(now: Date, store: Store): DoseEvent[] {
    const out: DoseEvent[] = [];
    const nowMs = now.getTime();

    for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
        const dayAnchor = addLocalDays(now, -daysAgo, HOUSEHOLD_TZ);
        const p = localParts(dayAnchor, HOUSEHOLD_TZ);
        for (const spec of MEDS) {
            for (const time of spec.schedule) {
                const [hh, mm] = parseHHMM(time);
                const scheduledAt = fromLocal(p.year, p.month, p.day, hh, mm, HOUSEHOLD_TZ);
                const key = `${daysAgo}:${spec.id}:${time}`;

                if (scheduledAt.getTime() > nowMs) {
                    out.push({
                        id: nextId('dose'),
                        medicationId: spec.id,
                        subjectId: MARGARET,
                        scheduledAt,
                        takenAt: null,
                        status: 'pending',
                        loggedBy: null
                    });
                    continue;
                }

                if (MISSED.has(key)) {
                    out.push({
                        id: nextId('dose'),
                        medicationId: spec.id,
                        subjectId: MARGARET,
                        scheduledAt,
                        takenAt: null,
                        status: 'missed',
                        loggedBy: null
                    });
                    continue;
                }

                const late = minutesLate(key);
                out.push({
                    id: nextId('dose'),
                    medicationId: spec.id,
                    subjectId: MARGARET,
                    scheduledAt,
                    takenAt: new Date(scheduledAt.getTime() + late * 60_000),
                    status: 'taken',
                    loggedBy: daysAgo === 0 || daysAgo === 3 || daysAgo === 5 ? DANA : MARGARET
                });
            }
        }
    }

    void store;
    return out;
}
