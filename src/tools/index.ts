/** Earshot — the eight tools. */

import { careSummary, reportSymptom } from './care.js';
import type { EarshotTool } from './kit.js';
import { checkAdherence, logDose, nextDose } from './medication.js';
import { disclosureLedger, openSoloWindowTool, whoCanSee } from './transparency.js';

export const TOOLS: readonly EarshotTool[] = [
    checkAdherence,
    nextDose,
    logDose,
    reportSymptom,
    careSummary,
    whoCanSee,
    openSoloWindowTool,
    disclosureLedger
];

export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name);

export function toolByName(name: string): EarshotTool | undefined {
    return TOOLS.find(t => t.name === name);
}

export { checkAdherence, nextDose, logDose, reportSymptom, careSummary, whoCanSee, openSoloWindowTool, disclosureLedger };
export type { EarshotTool } from './kit.js';
