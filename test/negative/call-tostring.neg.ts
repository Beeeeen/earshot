// Layer 1: toString / valueOf / toJSON are typed `never`, so calling them is an error.
import { priv } from '../../src/core/protected.js';

const dose = priv('40 mg', 'dose', 'medication');
// @expect TS2349
export const bad = dose.toString();
