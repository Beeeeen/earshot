// Layer 1: composePrivate rejects a sealed part -- at the type level only.
// The absence of a runtime backstop here is F1; see test/attack/laundering.test.ts.
import { composePrivate, sealed } from '../../src/core/protected.js';

const address = sealed('1184 Alameda de las Pulgas', 'home address', 'identity');
// @expect TS2322
export const bad = composePrivate('note', 'identity', [address]);
