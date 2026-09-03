/**
 * Earshot — protected values.
 *
 * THE INVARIANT
 * -------------
 *   A protected value can never appear in a spoken string.
 *
 * This module is where that is made true. There are three layers, and it is
 * important to be precise about which layer stops what, because overclaiming
 * here would be worse than the guarantee being narrower.
 *
 *  LAYER 1 — impossible to express (compile error).
 *    `Protected<T>` is an opaque object type. It is deliberately NOT an
 *    intersection with `T`, so `Protected<string>` is not a `string`.
 *    The only builder for spoken text (`say` in ./spoken.ts) accepts
 *    `Speakable = string | number | SpokenText`. `Protected<T>` is not
 *    assignable to any of those, so
 *
 *        say`she took ${dose}`          // dose: Protected<string>
 *
 *    is a compile error, and
 *
 *        { spoken: `she took ${dose}` } // plain template literal
 *
 *    is also a compile error, because `spoken` is `SpokenText` (a branded
 *    string) and a plain `string` is not assignable to it. Both are proven by
 *    the negative-compilation suite in src/negative/.
 *
 *  LAYER 2 — no plaintext escape route at runtime.
 *    The payload lives in an ECMAScript `#private` field. There is no
 *    reflective path to it: not `Object.keys`, not spread, not
 *    `JSON.stringify`, not `structuredClone`, not `util.inspect`, not
 *    `Object.getOwnPropertyDescriptors`. `toString`, `toJSON`, `valueOf` and
 *    `[Symbol.toPrimitive]` are all overridden to return a *taint marker*, not
 *    the value. So even the deliberate laundering attempts —
 *    `String(p)`, `p + ''`, `` `${p as any}` ``, `JSON.stringify(p)` — yield
 *    the marker. The plaintext leaves this module through exactly two named
 *    functions (see LAYER 3).
 *
 *  LAYER 3 — two audited reveal paths, and a tripwire on everything else.
 *    `revealToPrivateChannel()` is used only by the out-of-band delivery
 *    channel, which never touches the MCP response. `revealUnderSoloWindow()`
 *    is used only by the solo-window escape hatch and writes a ledger entry
 *    per field. Every other exit is guarded by `assertNoTaint()`, which scans
 *    for the marker and THROWS. It does not redact and it does not filter —
 *    silently repairing a leak is the theatre this project exists to avoid.
 *
 *  WHERE THE GUARANTEE DEGRADES — read this, it is the honest part.
 *    Layer 1 stops accidental interpolation, which is the realistic failure
 *    mode. It cannot stop a developer who writes `String(p)` or `p as any`,
 *    because TypeScript has no way to forbid a call to `String`. Those
 *    attempts are caught at Layer 2/3 instead: they produce a marker and the
 *    tripwire throws. So the precise claim is:
 *
 *      - "protected value reaches a spoken string" — prevented at Layer 2.
 *        There is no expression in TypeScript or JavaScript, short of
 *        importing one of the two named reveal functions, that turns a
 *        Protected<T> back into its plaintext.
 *      - "protected value is *referenced* in a spoken string" — prevented at
 *        Layer 1 for ordinary code, and detected-and-thrown at Layer 3 for
 *        code that casts its way around Layer 1.
 *
 *    We do not claim the second one is impossible to express. It is a
 *    compile error, and a compile error is not the same thing as impossible.
 */

import { randomBytes } from 'node:crypto';

/** How a fact may travel. This is a property of the data, decided at seed time. */
export type Classification = 'spoken' | 'private' | 'sealed';

/** The two classifications that require wrapping. `spoken` facts are plain values. */
export type ProtectedClass = 'private' | 'sealed';

/**
 * Taint marker format. Reserved: no legitimate spoken string ever contains it.
 * U+27E6 / U+27E7 are MATHEMATICAL WHITE SQUARE BRACKETs — not reachable from a
 * speech-to-text pipeline, and not typeable by accident.
 */
const MARKER_OPEN = '⟦earshot:';
const MARKER_CLOSE = '⟧';

/** Matches any taint marker. Used by the tripwire at every channel exit. */
export const TAINT_PATTERN = /⟦earshot:[0-9a-f]{16}⟧/g;

declare const PROTECTED_PAYLOAD: unique symbol;
declare const PROTECTED_CLASS: unique symbol;

/**
 * An opaque handle to a value that must not be spoken.
 *
 * `C` carries the classification in the type, so a `sealed` value is not
 * assignable where a `private` value is required — that is a compile error,
 * not a runtime check. See src/negative/sealed-into-private.neg.ts.
 *
 * `toString`, `valueOf` and `toJSON` are typed `never` (as properties, not
 * methods) so that *calling* them is a compile error: "This expression is not
 * callable. Type 'never' has no call signatures."
 */
export interface Protected<T, C extends ProtectedClass = ProtectedClass> {
    readonly [PROTECTED_PAYLOAD]: T;
    readonly [PROTECTED_CLASS]: C;
    /** Human-readable name of the *kind* of fact. Never the fact. e.g. "medication name". */
    readonly label: string;
    /** Grant category this fact belongs to. e.g. "medication", "diagnosis". */
    readonly category: string;
    readonly classification: C;
    /** Not callable: see module doc, Layer 1. */
    readonly toString: never;
    /** Not callable: see module doc, Layer 1. */
    readonly valueOf: never;
    /** Not callable: see module doc, Layer 1. */
    readonly toJSON: never;
}

/** Anything protected, regardless of payload type or classification. */
export type AnyProtected = Protected<unknown, ProtectedClass>;

/**
 * The runtime carrier. Not exported — callers only ever hold the opaque
 * `Protected<T, C>` interface.
 */
class ProtectedValue<T> {
    /** ECMAScript private field. Genuinely unreachable from outside this class. */
    readonly #payload: T;
    readonly #marker: string;

    readonly label: string;
    readonly category: string;
    readonly classification: ProtectedClass;

    constructor(payload: T, label: string, category: string, classification: ProtectedClass) {
        this.#payload = payload;
        this.#marker = `${MARKER_OPEN}${randomBytes(8).toString('hex')}${MARKER_CLOSE}`;
        this.label = label;
        this.category = category;
        this.classification = classification;
        Object.freeze(this);
    }

    /** Only callable from this module. */
    unseal(): T {
        return this.#payload;
    }

    get marker(): string {
        return this.#marker;
    }

    // --- every stringification path yields the marker, never the payload ---
    toString(): string {
        return this.#marker;
    }
    toJSON(): string {
        return this.#marker;
    }
    valueOf(): string {
        return this.#marker;
    }
    [Symbol.toPrimitive](): string {
        return this.#marker;
    }
    get [Symbol.toStringTag](): string {
        return 'Protected';
    }
    /** node:util.inspect / console.log */
    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return this.#marker;
    }
}

/**
 * Wrap a value so it cannot be spoken.
 *
 * @param payload        the sensitive value
 * @param label          the *kind* of fact, safe to say aloud ("medication name")
 * @param category       grant category ("medication" | "diagnosis" | ...)
 * @param classification 'private' (may go out-of-band) or 'sealed' (app only)
 */
export function protect<T, C extends ProtectedClass>(
    payload: T,
    label: string,
    category: string,
    classification: C
): Protected<T, C> {
    return new ProtectedValue(payload, label, category, classification) as unknown as Protected<T, C>;
}

/** Convenience: classification 'private'. */
export function priv<T>(payload: T, label: string, category: string): Protected<T, 'private'> {
    return protect(payload, label, category, 'private');
}

/** Convenience: classification 'sealed'. Never leaves the device, not even out-of-band. */
export function sealed<T>(payload: T, label: string, category: string): Protected<T, 'sealed'> {
    return protect(payload, label, category, 'sealed');
}

export function isProtected(v: unknown): v is AnyProtected {
    return v instanceof ProtectedValue;
}

/**
 * Build one protected string out of protected and plain parts, without the
 * plaintext ever leaving this module.
 *
 * Tools need to say things like "Furosemide 40 mg, taken at 8:07 AM" on the
 * private card, but a tool cannot read `med.name` to concatenate it. This is
 * the composition primitive: it unseals inside the vault and re-seals before
 * returning, so the caller still only ever holds a `Protected`.
 *
 * Sealed parts are rejected at the type level — a composition is only ever
 * `private`.
 */
export function composePrivate(
    label: string,
    category: string,
    parts: readonly (string | number | Protected<string | number, 'private'>)[]
): Protected<string, 'private'> {
    let out = '';
    for (const part of parts) {
        if (isProtected(part)) {
            out += String((part as unknown as ProtectedValue<string | number>).unseal());
        } else {
            out += String(part);
        }
    }
    return protect(out, label, category, 'private');
}

/** The taint marker for a protected value. Safe to log; reveals nothing. */
export function markerOf(p: AnyProtected): string {
    return (p as unknown as ProtectedValue<unknown>).marker;
}

/**
 * Capability token for revealing plaintext. Constructible only inside this
 * module, and handed to exactly two call sites (see below). A caller who does
 * not already hold one cannot manufacture one.
 */
export class RevealCapability {
    readonly #ok = true;
    /** @internal */
    constructor(guard: typeof CAPABILITY_GUARD) {
        if (guard !== CAPABILITY_GUARD) throw new Error('RevealCapability is not constructible');
        void this.#ok;
    }
}
const CAPABILITY_GUARD = Symbol('earshot.reveal.guard');

/** Held by src/protocol/private-channel.ts only. */
export const PRIVATE_CHANNEL_CAPABILITY = new RevealCapability(CAPABILITY_GUARD);
/** Held by src/domain/solo.ts only. */
export const SOLO_WINDOW_CAPABILITY = new RevealCapability(CAPABILITY_GUARD);

/**
 * Reveal path #1 — the out-of-band private channel.
 *
 * The private channel is a different HTTP endpoint (`GET /inbox`), authorised
 * with the asker's own OAuth token, and it is NOT part of any MCP response.
 * Nothing revealed here can reach the model, and therefore cannot reach the
 * speaker. `sealed` values are rejected at the type level.
 */
export function revealToPrivateChannel<T>(p: Protected<T, 'private'>, cap: RevealCapability): T {
    if (cap !== PRIVATE_CHANNEL_CAPABILITY) {
        throw new Error('revealToPrivateChannel: wrong capability');
    }
    const box = p as unknown as ProtectedValue<T>;
    if (box.classification !== 'private') {
        throw new Error(`revealToPrivateChannel: refused ${box.classification} value "${box.label}"`);
    }
    return box.unseal();
}

/**
 * Reveal path #2 — the solo window escape hatch.
 *
 * Only reachable while a live solo window exists. Callers must be in
 * src/domain/solo.ts, which writes a ledger entry for every field revealed.
 * `sealed` values are rejected at the type level: a solo window never unseals
 * a chart, an address or an insurance number.
 */
export function revealUnderSoloWindow<T>(p: Protected<T, 'private'>, cap: RevealCapability): T {
    if (cap !== SOLO_WINDOW_CAPABILITY) {
        throw new Error('revealUnderSoloWindow: wrong capability');
    }
    const box = p as unknown as ProtectedValue<T>;
    if (box.classification !== 'private') {
        throw new Error(`revealUnderSoloWindow: refused ${box.classification} value "${box.label}"`);
    }
    return box.unseal();
}

/**
 * Thrown when a taint marker is found on a channel that must not carry one.
 * We throw rather than redact: a leak that is quietly repaired is a leak we
 * never learn about.
 */
export class LeakError extends Error {
    readonly markers: string[];
    readonly where: string;
    constructor(where: string, markers: string[], sample: string) {
        super(
            `LeakError: ${markers.length} protected value(s) reached "${where}". ` +
                `Markers: ${markers.join(', ')}. Offending text: ${JSON.stringify(sample.slice(0, 200))}`
        );
        this.name = 'LeakError';
        this.markers = markers;
        this.where = where;
    }
}

/**
 * The tripwire. Runs at every exit that must be spoken-safe.
 *
 * This is defence in depth for code that cast its way past the type system.
 * In correct code it never fires; src/selftest proves it fires when it should.
 */
export function assertNoTaint(text: string, where: string): void {
    TAINT_PATTERN.lastIndex = 0;
    const found = text.match(TAINT_PATTERN);
    if (found && found.length > 0) {
        throw new LeakError(where, found, text);
    }
}

/** Deep tripwire for structured payloads that leave over the MCP transport. */
export function assertNoTaintDeep(value: unknown, where: string): void {
    if (isProtected(value)) {
        throw new LeakError(where, [markerOf(value)], `<Protected ${value.label}>`);
    }
    if (typeof value === 'string') {
        assertNoTaint(value, where);
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value) assertNoTaintDeep(v, where);
        return;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            assertNoTaint(k, where);
            assertNoTaintDeep(v, where);
        }
    }
}
