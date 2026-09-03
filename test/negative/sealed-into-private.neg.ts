// Layer 1: a sealed value is not assignable where a private one is required.
import { sealed } from '../../src/core/protected.js';
import type { PrivateField } from '../../src/core/result.js';

const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');
// @expect TS2322
export const bad: PrivateField = { label: 'Address', value: address };
