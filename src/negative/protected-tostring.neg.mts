// @expect: TS2349
// @what: toString() on a protected value is not callable.
//
// `toString`, `valueOf` and `toJSON` are declared as properties of type
// `never`, so calling them is a compile error rather than something that
// silently produces a string.

import { priv } from '../core/protected.js';

const dose = priv('40 mg', 'dose', 'medication');

export const s = dose.toString();
