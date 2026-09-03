// @expect: TS2322
// @what: A protected value cannot be put into structuredContent either.
//
// `SpokenData` is a record of scalars. The MCP response is spoken-safe as a
// whole, not just its `spoken` field — otherwise the model would read the
// medication name out of structuredContent.

import type { ToolResult } from '../core/result.js';
import { priv } from '../core/protected.js';
import { say } from '../core/spoken.js';

const medicationName = priv('Furosemide', 'medication name', 'medication');

export const r: ToolResult = {
    spoken: say`Yes, taken.`,
    data: { medication: medicationName }
};
