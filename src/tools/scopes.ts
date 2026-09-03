/**
 * OAuth scope required per tool.
 *
 * Scopes gate *what a linked client may attempt*. They do not decide what a
 * person may see — that is the grant table. A token with `care.read` still
 * gets nothing about Margaret if the grant table has no row for its holder.
 */

import type { Scope } from '../auth/oauth.js';
import type { LedgerCategory } from '../domain/types.js';

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

/**
 * What kind of fact each tool's *spoken* answer is about.
 *
 * The envelope writes one ledger row per answer, and that row needs a category
 * for the same reason every other row does: `disclosure_ledger` gates each row
 * against the reader's own grant, and a row with no category has to be either
 * shown to everyone or hidden from everyone. The three transparency tools do
 * not disclose a health fact at all, so their rows are `transparency` — no
 * grant covers that, so they are visible only to the person who caused them
 * and to the subject.
 *
 * Unlisted tools fall back to `transparency`, which is the closed direction.
 */
export const TOOL_LEDGER_CATEGORY: Readonly<Record<string, LedgerCategory>> = {
    check_adherence: 'medication',
    next_dose: 'schedule',
    log_dose: 'medication',
    report_symptom: 'symptom',
    care_summary: 'medication',
    who_can_see: 'transparency',
    open_solo_window: 'transparency',
    disclosure_ledger: 'transparency'
};

export function ledgerCategoryOf(tool: string): LedgerCategory {
    return TOOL_LEDGER_CATEGORY[tool] ?? 'transparency';
}
