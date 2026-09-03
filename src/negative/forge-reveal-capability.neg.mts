// @expect: TS2345
// @what: A reveal capability cannot be constructed by a caller.
//
// The two reveal functions demand a capability object whose constructor is
// guarded by a module-private symbol. Nobody outside src/core/protected.ts can
// produce the argument.

import { RevealCapability } from '../core/protected.js';

export const forged = new RevealCapability(Symbol('not the guard'));
