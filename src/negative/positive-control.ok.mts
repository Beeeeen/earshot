// @expect: OK
// @what: Positive control — proves the negative harness is not simply broken.
//
// Everything a tool legitimately does, in one file. If this fails to compile,
// every "MUST fail" result above is meaningless.

import { priv, sealed, composePrivate } from '../core/protected.js';
import type { PrivateField, ToolResult, SealedRef } from '../core/result.js';
import { say, joinSpoken } from '../core/spoken.js';

const medicationName = priv('Furosemide', 'medication name', 'medication');
const strength = priv('40 mg', 'dose', 'medication');
const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');

const field: PrivateField = {
    label: '8:00 AM',
    value: composePrivate('medication and dose', 'medication', [medicationName, ' ', strength])
};

const ref: SealedRef = { label: address.label, category: address.category, appPath: '/contact' };

const takenAt = '8:07 AM';

export const r: ToolResult = {
    spoken: joinSpoken(say`Yes, taken at ${takenAt}.`, say`Details are on your phone.`),
    privately: { title: 'Today', fields: [field] },
    sealedRefs: [ref],
    data: { taken: 1, missed: 0, onTime: true }
};
