// @expect: TS2345
// @what: Even a solo window cannot speak a sealed value.
//
// `underSolo` accepts Protected<..., 'private'>. A sealed value is a different
// type, so the escape hatch has a floor under it that is not enforced by a
// runtime check.

import { sealed } from '../core/protected.js';
import { underSolo, type SoloSpeechContext } from '../domain/solo.js';

declare const ctx: SoloSpeechContext;

const homeAddress = sealed('1184 Alameda de las Pulgas, Apt 3B', 'home address', 'identity');

export const spoken = underSolo(ctx)`She lives at ${homeAddress}.`;
