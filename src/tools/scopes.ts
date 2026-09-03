/**
 * OAuth scope required per tool.
 *
 * Scopes gate *what a linked client may attempt*. They do not decide what a
 * person may see — that is the grant table. A token with `care.read` still
 * gets nothing about Margaret if the grant table has no row for its holder.
 */

import type { Scope } from '../auth/oauth.js';

export const TOOL_SCOPES: Readonly<Record<string, Scope>> = {
    check_adherence: 'care.read',
    next_dose: 'care.read',
    log_dose: 'care.write',
    report_symptom: 'care.write',
    care_summary: 'care.read',
    who_can_see: 'care.read',
    open_solo_window: 'solo.open',
    disclosure_ledger: 'ledger.read'
};
