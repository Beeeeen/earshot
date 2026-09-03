// The control: this file MUST compile clean. Without it, "the negative files
// produced errors" proves nothing about whether tsc was actually checking.
import { composePrivate, priv, revealToPrivateChannel, PRIVATE_CHANNEL_CAPABILITY } from '../../src/core/protected.js';
import type { PrivateField, ToolResult } from '../../src/core/result.js';
import { say } from '../../src/core/spoken.js';

const name = priv('Furosemide', 'medication name', 'medication');
const strength = priv('40 mg', 'dose', 'medication');

export const field: PrivateField = {
    label: '8:00 AM',
    value: composePrivate('medication and dose', 'medication', [name, ' ', strength])
};
export const ok: ToolResult = { spoken: say`Yes, taken at ${'8:07 AM'}.`, privately: { title: 'Today', fields: [field] } };
export const plaintext: string = revealToPrivateChannel(name, PRIVATE_CHANNEL_CAPABILITY);
