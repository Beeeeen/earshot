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
 *    The payload does not live on the object at all. It lives in a
 *    module-scoped `WeakMap` (`VAULT`) keyed by the wrapper, and the only
 *    functions that can read that map are in this file. The wrapper's own
 *    properties are exactly `label`, `category` and `classification` — three
 *    pieces of metadata that name the *kind* of fact, never the fact.
 *
 *    So the reflective paths — `Object.keys`, spread, `structuredClone`,
 *    `Object.getOwnPropertyDescriptors`, `Object.getOwnPropertySymbols` —
 *    have no route to the payload. Be precise about what they DO yield:
 *
 *        { ...p }                 -> { label, category, classification }
 *        structuredClone(p)       -> { label, category, classification }
 *
 *    That is metadata with NO taint marker in it, so a reflected copy is
 *    invisible to `assertNoTaint`. It carries no payload either, so it is not
 *    a leak — but "everything that got past the type system carries a marker"
 *    is true of values that were *stringified*, not of values that were
 *    *reflected over*. test/invariant.test.ts pins that boundary.
 *
 *    The stringification paths are the ones that yield the marker:
 *    `toString`, `toJSON`, `valueOf`, `[Symbol.toPrimitive]` and
 *    `util.inspect` are all overridden, so the deliberate laundering attempts
 *    — `String(p)`, `p + ''`, `` `${p as any}` ``, `JSON.stringify(p)`,
 *    `console.log(p)` — produce a marker, not the value.
 *
 *    The plaintext leaves this module through exactly two named functions
 *    (see LAYER 3). `ProtectedValue#unseal()` is kept as a tombstone: it is
 *    public, it is what a caster would reach for, and it returns a redaction
 *    (`[withheld: medication name]`), never the payload. Removing it entirely
 *    would only turn that call into a TypeError; returning a redaction keeps
 *    the failure mode boring and payload-free either way.
 *
 *  LAYER 3 — two audited reveal paths, and a tripwire on everything else.
 *    `revealToPrivateChannel()` is used only by the out-of-band delivery
 *    channel, which never touches the MCP response. `revealUnderSoloWindow()`
 *    is used only by the solo-window escape hatch and writes a ledger entry
 *    per field. Every other exit is guarded by `assertNoTaint()`, which scans
 *    for the marker and THROWS. It does not redact and it does not filter —
 *    silently repairing a leak is the theatre this project exists to avoid.
 *
 *    `composePrivate()` is the third door and the one that used to be
 *    unlocked: it unseals inside the vault and re-seals, so it can build
 *    "Furosemide 40 mg — taken 8:07 AM" without the plaintext leaving. It now
 *    refuses any part that is not `private`, at runtime as well as at the type
 *    level, because a permitted composition that quietly re-labels a `sealed`
 *    part is a laundering primitive. See test/attack/laundering.test.ts.
 *
 *  WHERE THE GUARANTEE DEGRADES — read this, it is the honest part.
 *    Layer 1 stops accidental interpolation, which is the realistic failure
 *    mode. It cannot stop a developer who writes `String(p)` or `p as any`,
 *    because TypeScript has no way to forbid a call to `String`. Those
 *    attempts are caught at Layer 2/3 instead: they produce a marker and the
 *    tripwire throws. So the precise claim is:
 *
 *      - "protected value reaches a spoken string" — prevented at Layer 2.
 *        There is no expression in TypeScript or JavaScript, short of calling
 *        one of the reveal functions with the matching capability, that turns
 *        a Protected<T> back into its plaintext.
 *      - "protected value is *referenced* in a spoken string" — prevented at
 *        Layer 1 for ordinary code, and detected-and-thrown at Layer 3 for
 *        code that casts its way around Layer 1.
 *
 *    We do not claim the second one is impossible to express. It is a
 *    compile error, and a compile error is not the same thing as impossible.
 *
 *    AND THE CAPABILITIES ARE MODULE EXPORTS. `PRIVATE_CHANNEL_CAPABILITY`
 *    and `SOLO_WINDOW_CAPABILITY` cannot be *forged* — the constructor is
 *    guarded by a module-private symbol — but they can be *imported*. Any
 *    module in this repository that writes
 *
 *        import { revealToPrivateChannel, PRIVATE_CHANNEL_CAPABILITY } from './core/protected.js';
 *
 *    holds the capability, and the plaintext it returns carries no marker, so
 *    no tripwire downstream can tell it from an ordinary string. The comments
 *    below that say "held by X only" describe today's call sites; they are not
 *    an access rule the language enforces. Enforcing it properly means either
 *    not exporting the tokens (the reveal functions would then have to be
 *    injected into their two callers) or moving the two channels into this
 *    module. Both are real options; neither is in place, and the project's own
 *    test suite pins the current behaviour, so this is stated rather than
 *    quietly overclaimed. It is finding F2 in test/attack/laundering.test.ts.
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
const MARKER_SOURCE = '⟦earshot:[0-9a-f]{16}⟧';

/**
 * The scanner used by `assertNoTaint`. Module-private and global: `String#match`
 * resets `lastIndex` on a global regex before it runs, so this one cannot be
 * left mid-string by a previous call.
 */
const MARKER_SCAN = new RegExp(MARKER_SOURCE, 'g');

/**
 * A global regex whose `test()` does not carry `lastIndex` between calls.
 *
 * The exported pattern has to stay global, because callers use it with
 * `String#match` to collect *every* marker (test/invariant.test.ts counts
 * three). But a bare `/g` regex alternates true/false under repeated `.test()`,
 * which is a trap for any consumer that reaches for the obvious method — F12.
 * So `test()` is stateless here, and `exec`/`match` keep their global
 * behaviour.
 */
class StatelessTestRegExp extends RegExp {
    override test(input: string): boolean {
        this.lastIndex = 0;
        const found = super.test(input);
        this.lastIndex = 0;
        return found;
    }
}

/** Matches any taint marker. Used by the tripwire at every channel exit. */
export const TAINT_PATTERN: RegExp = new StatelessTestRegExp(MARKER_SOURCE, 'g');

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
 * What the vault holds for one wrapper. Nothing outside this module can obtain
 * a reference to one of these: `VAULT` is module-scoped, `entryFor` is not
 * exported, and the wrapper carries no key to it.
 */
interface VaultEntry<T = unknown> {
    readonly payload: T;
    readonly marker: string;
    readonly label: string;
    readonly category: string;
    readonly classification: ProtectedClass;
}

/**
 * The vault. A `WeakMap` rather than a `#private` field, because a private
 * field still needs a *method* to read it, and any such method is a public door
 * next to the lock (that was F0: `unseal()` was exactly that door). Here the
 * only readers are the functions below, and none of them is reachable without
 * the matching capability.
 */
const VAULT = new WeakMap<object, VaultEntry>();

/** Throws `TypeError` for anything that is not a live wrapper. */
function entryFor(v: object): VaultEntry {
    const entry = VAULT.get(v);
    if (!entry) {
        throw new TypeError('not an Earshot protected value: this object has no vault entry');
    }
    return entry;
}

/** What a caller gets instead of the payload. Names the kind of fact, nothing else. */
function redaction(entry: VaultEntry): string {
    return `[withheld: ${entry.label}]`;
}

/**
 * The runtime carrier. Not exported — callers only ever hold the opaque
 * `Protected<T, C>` interface. It holds no payload: see `VAULT`.
 */
class ProtectedValue<T> {
    readonly label: string;
    readonly category: string;
    readonly classification: ProtectedClass;

    constructor(payload: T, label: string, category: string, classification: ProtectedClass) {
        this.label = label;
        this.category = category;
        this.classification = classification;
        VAULT.set(this, {
            payload,
            marker: `${MARKER_OPEN}${randomBytes(8).toString('hex')}${MARKER_CLOSE}`,
            label,
            category,
            classification
        });
        Object.freeze(this);
    }

    /**
     * TOMBSTONE. This used to return the payload, which made the whole
     * capability system decorative — one cast and any caller had the
     * plaintext, with no marker on it for the tripwire to catch (F0).
     *
     * It is kept, and kept public, deliberately: the name is the one a caster
     * reaches for, and this is a cheaper answer than a TypeError. It returns a
     * redaction. The payload is in `VAULT` and there is no method that returns
     * it.
     */
    unseal(): string {
        return redaction(entryFor(this));
    }

    get marker(): string {
        return entryFor(this).marker;
    }

    // --- every stringification path yields the marker, never the payload ---
    toString(): string {
        return entryFor(this).marker;
    }
    toJSON(): string {
        return entryFor(this).marker;
    }
    valueOf(): string {
        return entryFor(this).marker;
    }
    [Symbol.toPrimitive](): string {
        return entryFor(this).marker;
    }
    get [Symbol.toStringTag](): string {
        return 'Protected';
    }
    /** node:util.inspect / console.log */
    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return entryFor(this).marker;
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
    return v instanceof ProtectedValue && VAULT.has(v);
}

/**
 * Thrown when a value of the wrong classification is handed to a door that
 * only accepts `private`. Distinct from `LeakError`: nothing escaped, a caller
 * asked for something the classification forbids and was refused.
 */
export class ClassificationError extends Error {
    readonly label: string;
    readonly classification: ProtectedClass;
    constructor(where: string, entry: VaultEntry) {
        super(`${where}: refused ${entry.classification} value "${entry.label}"`);
        this.name = 'ClassificationError';
        this.label = entry.label;
        this.classification = entry.classification;
    }
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
 * `private` — AND at runtime. The runtime half matters because the type half
 * is defeated by one `as never` or one `unknown`-typed value, and what came
 * out the other side was a well-formed `private` value that every downstream
 * check waved through: the private channel delivered it, and a solo window
 * spoke it aloud. Refusing here mirrors the two reveal functions, which have
 * always had this check.
 */
export function composePrivate(
    label: string,
    category: string,
    parts: readonly (string | number | Protected<string | number, 'private'>)[]
): Protected<string, 'private'> {
    let out = '';
    for (const part of parts) {
        if (isProtected(part)) {
            const entry = entryFor(part as unknown as object);
            if (entry.classification !== 'private') {
                throw new ClassificationError(`composePrivate("${label}")`, entry);
            }
            out += String(entry.payload);
        } else {
            out += String(part);
        }
    }
    return protect(out, label, category, 'private');
}

/** The taint marker for a protected value. Safe to log; reveals nothing. */
export function markerOf(p: AnyProtected): string {
    return entryFor(p as unknown as object).marker;
}

/**
 * Capability token for revealing plaintext. Constructible only inside this
 * module: a caller who does not already hold one cannot manufacture one.
 *
 * Note the limit, spelled out in the module doc: it is exported, so importing
 * this file is enough to hold one. That is F2.
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

/** Intended for src/protocol/private-channel.ts. Exported, so not enforced — see F2. */
export const PRIVATE_CHANNEL_CAPABILITY = new RevealCapability(CAPABILITY_GUARD);
/** Intended for src/domain/solo.ts. Exported, so not enforced — see F2. */
export const SOLO_WINDOW_CAPABILITY = new RevealCapability(CAPABILITY_GUARD);

/**
 * Reveal path #1 — the out-of-band private channel.
 *
 * The private channel is a different HTTP endpoint (`GET /inbox`), authorised
 * with the asker's own OAuth token, and it is NOT part of any MCP response.
 * Nothing revealed here can reach the model, and therefore cannot reach the
 * speaker. `sealed` values are rejected at the type level and at runtime.
 */
export function revealToPrivateChannel<T>(p: Protected<T, 'private'>, cap: RevealCapability): T {
    if (cap !== PRIVATE_CHANNEL_CAPABILITY) {
        throw new Error('revealToPrivateChannel: wrong capability');
    }
    const entry = entryFor(p as unknown as object);
    if (entry.classification !== 'private') {
        throw new ClassificationError('revealToPrivateChannel', entry);
    }
    return entry.payload as T;
}

/**
 * Reveal path #2 — the solo window escape hatch.
 *
 * Only reachable while a live solo window exists. Callers must be in
 * src/domain/solo.ts, which checks the reader's grant for the category and
 * writes a ledger entry for every field revealed. `sealed` values are rejected
 * at the type level and at runtime: a solo window never unseals a chart, an
 * address or an insurance number.
 */
export function revealUnderSoloWindow<T>(p: Protected<T, 'private'>, cap: RevealCapability): T {
    if (cap !== SOLO_WINDOW_CAPABILITY) {
        throw new Error('revealUnderSoloWindow: wrong capability');
    }
    const entry = entryFor(p as unknown as object);
    if (entry.classification !== 'private') {
        throw new ClassificationError('revealUnderSoloWindow', entry);
    }
    return entry.payload as T;
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
    const found = text.match(MARKER_SCAN);
    if (found && found.length > 0) {
        throw new LeakError(where, found, text);
    }
}

/**
 * Deep tripwire for structured payloads that leave over the MCP transport.
 *
 * Walks own enumerable properties, arrays, `Map` keys and values, `Set`
 * members, and — because `JSON.stringify` calls it and the scan otherwise
 * would not — whatever an object's own `toJSON()` produces. Cycles are visited
 * once.
 */
export function assertNoTaintDeep(value: unknown, where: string): void {
    walk(value, where, new WeakSet<object>());
}

function walk(value: unknown, where: string, seen: WeakSet<object>): void {
    if (isProtected(value)) {
        throw new LeakError(where, [markerOf(value)], `<Protected ${value.label}>`);
    }
    if (typeof value === 'string') {
        assertNoTaint(value, where);
        return;
    }
    if (value === null || typeof value !== 'object') return;

    const obj = value as object;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(value)) {
        for (const v of value) walk(v, where, seen);
        return;
    }
    if (value instanceof Map) {
        for (const [k, v] of value) {
            walk(k, where, seen);
            walk(v, where, seen);
        }
        return;
    }
    if (value instanceof Set) {
        for (const v of value) walk(v, where, seen);
        return;
    }

    // `JSON.stringify` would call this and put the result on the wire, so the
    // scan has to see the same thing the serialiser will.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
        let produced: unknown;
        try {
            produced = (toJSON as () => unknown).call(value);
        } catch {
            produced = undefined;
        }
        if (produced !== value) walk(produced, where, seen);
    }

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        assertNoTaint(k, where);
        walk(v, where, seen);
    }
}
