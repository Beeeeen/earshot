// Layer 1: a Protected value cannot be interpolated into speech.
import { priv } from '../../src/core/protected.js';
import { say } from '../../src/core/spoken.js';

const dose = priv('40 mg', 'dose', 'medication');
// @expect TS2345
export const bad = say`she took ${dose}`;
