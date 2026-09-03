// Layer 1: a plain template literal is not a SpokenText.
import type { ToolResult } from '../../src/core/result.js';

const time = '8:07 AM';
// @expect TS2322
export const bad: ToolResult = { spoken: `she took her pills at ${time}` };
