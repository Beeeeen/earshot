// @expect: TS2322
// @what: SpokenText cannot be forged from a string variable.

import type { SpokenText } from '../core/spoken.js';

const fromSomewhereElse: string = 'Furosemide 40 mg';

export const forged: SpokenText = fromSomewhereElse;
