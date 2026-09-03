// Layer 1: a solo window cannot speak a sealed value.
import { sealed } from '../../src/core/protected.js';
import { underSolo, type SoloSpeechContext } from '../../src/domain/solo.js';

declare const ctx: SoloSpeechContext;
const insurance = sealed('BCBSCA-7742-118-903', 'insurance member number', 'identity');
// @expect TS2345
export const bad = underSolo(ctx)`Your number is ${insurance}.`;
