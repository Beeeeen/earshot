/**
 * Earshot — spoken text.
 *
 * `SpokenText` is a branded string. A plain `string` is NOT assignable to it,
 * so a tool cannot return `{ spoken: `she took ${dose}` }` — that is a compile
 * error before anyone thinks about what `dose` holds.
 *
 * The only way to make a `SpokenText` is `say`, a tagged template whose
 * interpolated values are constrained to `Speakable`. `Protected<T>` is an
 * opaque object type and is not assignable to `Speakable`, so
 *
 *     say`she took ${dose}`     // error TS2345
 *
 * See src/negative/ for the compilation proofs.
 */

import { assertNoTaint } from './protected.js';

declare const SPOKEN_BRAND: unique symbol;

/**
 * A string that has passed through `say`. Assignable to `string` (so it
 * serialises normally); `string` is not assignable to it (so it cannot be
 * forged by an ordinary template literal).
 */
export type SpokenText = string & { readonly [SPOKEN_BRAND]: 'earshot.spoken' };

/**
 * What may be interpolated into speech.
 *
 * Note what is absent: `Protected<T>`, and any object at all. `object` is
 * excluded on purpose — `${someRecord}` would otherwise produce
 * "[object Object]" in a sentence read aloud to someone who cannot see a
 * screen, which is its own kind of failure.
 */
export type Speakable = string | number | SpokenText;

/**
 * Build speech.
 *
 *     say`Yes, taken at ${time}.`
 *
 * Runs the taint tripwire on the finished string, so any value that was cast
 * past the type system still fails loudly here rather than reaching a speaker.
 */
export function say(strings: TemplateStringsArray, ...values: Speakable[]): SpokenText {
    let out = strings[0] ?? '';
    for (let i = 0; i < values.length; i++) {
        out += String(values[i]);
        out += strings[i + 1] ?? '';
    }
    assertNoTaint(out, 'say()');
    return out as SpokenText;
}

/** Join spoken fragments with a space, dropping empties. */
export function joinSpoken(...parts: (SpokenText | '')[]): SpokenText {
    const out = parts.filter(p => p.length > 0).join(' ');
    assertNoTaint(out, 'joinSpoken()');
    return out as SpokenText;
}

/**
 * Speak a number of things without naming them: "two things", "one thing".
 * Counts are not sensitive; the things they count usually are.
 */
export function countPhrase(n: number, singular: string, plural: string): SpokenText {
    const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const word = n >= 0 && n < words.length ? (words[n] as string) : String(n);
    return say`${word} ${n === 1 ? singular : plural}`;
}

/**
 * Format a Date as a clock time a person would say out loud.
 * Times are `spoken` class per the classification table: knowing that a dose
 * is due at 8 PM does not reveal what the dose is.
 */
export function clockTime(d: Date, timeZone: string): SpokenText {
    const s = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone
    }).format(d);
    return say`${s}`;
}

/** "this morning" / "this afternoon" / "this evening" — coarse, unremarkable. */
export function partOfDay(d: Date, timeZone: string): SpokenText {
    const hour = Number(
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(d)
    );
    if (hour < 12) return say`this morning`;
    if (hour < 17) return say`this afternoon`;
    return say`this evening`;
}
