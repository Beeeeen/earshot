// @expect: TS2322
// @what: A sealed value cannot be placed on the private channel.
//
// The classification is carried in the type parameter, so `sealed` data cannot
// be assigned where `private` data is expected. This is why "sealed never
// leaves the app" is a compile-time property and not a policy document.

import type { PrivateField } from '../core/result.js';
import { sealed } from '../core/protected.js';

const insuranceNumber = sealed('BCBSCA-7742-118-903', 'insurance member number', 'identity');

export const field: PrivateField = {
    label: 'Insurance',
    value: insuranceNumber
};
