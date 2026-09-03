// @expect: TS2322
// @what: A plain template literal cannot be used as spoken text.
//
// Closing the obvious hole: if `spoken` were just `string`, a developer could
// sidestep `say` entirely with a backtick string. `SpokenText` is branded, so
// an ordinary `string` is not assignable to it.

import type { ToolResult } from '../core/result.js';

const takenAt = '8:07 AM';

export const r: ToolResult = {
    spoken: `Yes, taken at ${takenAt}.`
};
