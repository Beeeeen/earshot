// Layer 1: structuredContent is scalars only, so a Protected cannot be mirrored there.
import { priv } from '../../src/core/protected.js';
import type { SpokenData } from '../../src/core/result.js';

const dose = priv('40 mg', 'dose', 'medication');
// @expect TS2322
export const bad: SpokenData = { dose };
