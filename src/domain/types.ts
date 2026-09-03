/** Earshot — domain model. Classification is decided here, at the data, not at answer time. */

import type { Protected } from '../core/protected.js';

export type PersonId = string;
export type Role = 'subject' | 'family' | 'aide' | 'clinician' | 'unlinked';

export interface Person {
    readonly id: PersonId;
    /** First name only. Names of household members are `spoken` class. */
    readonly displayName: string;
    readonly role: Role;
    readonly relationship: string;
    readonly timeZone: string;
    /** Whether this account has a device linked for out-of-band private delivery. */
    readonly hasLinkedDevice: boolean;
}

/**
 * Grant categories. A grant is (viewer, subject, level, categories):
 * "Sarah may see private-class medication and diagnosis facts about Margaret."
 */
export type GrantCategory = 'medication' | 'schedule' | 'diagnosis' | 'symptom' | 'vitals' | 'clinician' | 'identity';

export const ALL_CATEGORIES: readonly GrantCategory[] = [
    'medication',
    'schedule',
    'diagnosis',
    'symptom',
    'vitals',
    'clinician',
    'identity'
];

/** The explicit authorisation table. Set by the subject or their proxy. */
export interface Grant {
    readonly viewerId: PersonId;
    readonly subjectId: PersonId;
    /** Highest classification this viewer may receive. 'sealed' is never granted here. */
    readonly level: 'spoken' | 'private';
    readonly categories: readonly GrantCategory[];
    readonly grantedBy: PersonId;
    readonly grantedAt: Date;
}

export interface Medication {
    readonly id: string;
    readonly subjectId: PersonId;
    /** e.g. "Furosemide" — private. */
    readonly name: Protected<string, 'private'>;
    /** e.g. "40 mg" — private. */
    readonly strength: Protected<string, 'private'>;
    /** e.g. "why it is prescribed" — private. */
    readonly indication: Protected<string, 'private'>;
    /** e.g. "Take with food" — private. */
    readonly instructions: Protected<string, 'private'>;
    /** Local clock times, 24h "HH:MM". Times themselves are spoken class. */
    readonly schedule: readonly string[];
    /** Short spoken-class handle used when the model must refer to one of several meds. */
    readonly spokenHandle: string;
}

export type DoseStatus = 'taken' | 'missed' | 'pending';

export interface DoseEvent {
    readonly id: string;
    readonly medicationId: string;
    readonly subjectId: PersonId;
    readonly scheduledAt: Date;
    readonly takenAt: Date | null;
    readonly status: DoseStatus;
    readonly loggedBy: PersonId | null;
}

export interface SymptomReport {
    readonly id: string;
    readonly subjectId: PersonId;
    readonly reportedBy: PersonId;
    readonly reportedAt: Date;
    /** Free text as the person said it — private. */
    readonly description: Protected<string, 'private'>;
    /** 1-5 — private. */
    readonly severity: Protected<number, 'private'>;
    /** Coarse bucket, safe to say: "something to look at" vs "routine". */
    readonly needsAttention: boolean;
}

/** Facts that never travel on any channel Earshot controls. */
export interface SealedFacts {
    readonly subjectId: PersonId;
    readonly insuranceMemberId: Protected<string, 'sealed'>;
    readonly homeAddress: Protected<string, 'sealed'>;
    readonly fullChartSummary: Protected<string, 'sealed'>;
}

export interface ClinicalContext {
    readonly subjectId: PersonId;
    readonly diagnosis: Protected<string, 'private'>;
    readonly prescriber: Protected<string, 'private'>;
    readonly lastVitals: Protected<string, 'private'>;
}

/** A row in the disclosure ledger. Append-only. */
export type LedgerChannel = 'spoken' | 'private-channel' | 'sealed-refused' | 'denied' | 'solo-window';

/**
 * What kind of fact a ledger row is about.
 *
 * Every row carries the category of the thing that actually moved, so
 * `disclosure_ledger` can gate each row against the reader's own grant. It
 * used to hardcode `medication` for every row it rendered, which meant an aide
 * denied `diagnosis` was handed rows naming the diagnosis (F3).
 *
 * `transparency` is for rows about the mechanism rather than about a health
 * fact — a solo window opening, a `who_can_see` answer. It is deliberately not
 * a `GrantCategory`: no grant covers it, so those rows are visible only to the
 * person who caused them and to the subject.
 */
export type LedgerCategory = GrantCategory | 'transparency';

export interface LedgerEntry {
    readonly id: string;
    readonly at: Date;
    readonly subjectId: PersonId;
    readonly actorId: PersonId;
    readonly tool: string;
    readonly channel: LedgerChannel;
    /** The category of the fact that moved. Gates who may see this row. */
    readonly category: LedgerCategory;
    /** What kind of fact moved. Never the fact. */
    readonly what: string;
    /**
     * Free-form, non-sensitive detail: "3 fields", "category not granted".
     * Never names a person: the actor is `actorId`, and whether a reader may
     * see that name is decided when the row is rendered, not when it is
     * written.
     */
    readonly detail: string;
}

/** An out-of-band delivery waiting on the asker's linked device. */
export interface Delivery {
    readonly id: string;
    readonly recipientId: PersonId;
    readonly subjectId: PersonId;
    readonly createdAt: Date;
    readonly title: string;
    readonly tool: string;
    readonly fields: readonly { readonly label: string; readonly value: string | number }[];
    readonly sealedRefs: readonly { readonly label: string; readonly appPath: string }[];
    readonly footnote: string | null;
    readAt: Date | null;
}

/** A live solo window: the user declared they are alone. */
export interface SoloWindow {
    readonly id: string;
    readonly askerId: PersonId;
    readonly subjectId: PersonId;
    /** MCP session id — stands in for "this one device". */
    readonly deviceSessionId: string;
    readonly openedAt: Date;
    readonly expiresAt: Date;
    revokedAt: Date | null;
}
