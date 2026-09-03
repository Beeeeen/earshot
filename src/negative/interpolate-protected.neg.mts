// @expect: TS2345
// @what: A protected value cannot be interpolated into speech.
//
// This is the central claim of the project. `med.name` is a
// Protected<string, 'private'> — an opaque object type — and `say` only
// accepts `Speakable = string | number | SpokenText`. There is no conversion.

import { say } from '../core/spoken.js';
import { priv } from '../core/protected.js';

const medicationName = priv('Furosemide', 'medication name', 'medication');

export const leaked = say`She took ${medicationName} this morning.`;
