/**
 * One definition of the mark and the palette, imported by every renderer, so
 * the app icon, the carousel image and the Devpost thumbnail cannot drift.
 *
 * The palette mirrors demo/tokens.css and is gated by demo/tools/check-contrast.py.
 * The two extra entries here are for the near-white tile only: #FFB627 lands at
 * 1.7:1 on white, which is invisible, so the dark-theme icon uses ochre and
 * deep teal instead. Those two were picked by measurement -- 5.45:1 and 5.88:1
 * on #F2F6F7, and 36.7 CIEDE2000 apart from each other (>=23.6 under every
 * simulated dichromacy) so they stay tellable apart.
 */

export const C = {
  page: '#070A0D',
  tile: '#101519',
  ink: '#F3F6F8',
  ink2: '#B9C6D0',
  ink3: '#8496A3',
  amber: '#FFB627',
  cyan: '#4FE0D2',
  rose: '#FF7A88',
  violet: '#BBA5FF',
  // Near-white tile variants. #FFB627 is 1.7:1 on white -- invisible -- so the
  // dark-theme icon swaps in these two, chosen by measurement: 5.46:1 and
  // 5.88:1 on #F2F6F7, 44.4 CIEDE2000 apart, >=23.4 under every dichromacy.
  light: '#F2F6F7',
  amberOn: '#A34A00',
  cyanOn: '#046B62',
  inkOn: '#101519',
};

/**
 * The mark: two sound arcs that stop, and a phone that carries on.
 *
 * Laid out on a 100x100 grid around a single vertical centre line at y=50, with
 * both arcs struck from one virtual source at x=4 so they read as one sound
 * radiating rather than two unrelated commas. Measured margins with the stroke
 * included are 12.1 / 11.5 / 14.4 / 14.4, i.e. balanced, which matters because
 * an off-centre mark is the thing that makes an icon look homemade.
 *
 * Both arcs are full opacity. A faded outer arc reads as a *different colour*
 * rather than a quieter one once the tile is 64px, which muddies the two-colour
 * story the mark exists to tell.
 *
 * Stroke weight is a parameter: a 64px tile needs a heavier line than a 241px
 * one to survive downsampling.
 */
export function mark({ arc, phone, w = 8 }) {
  return `
  <g fill="none" stroke-linecap="round">
    <path d="M16.6 32.0 A22 22 0 0 1 16.6 68.0" stroke="${arc}" stroke-width="${w}"/>
    <path d="M25.8 18.9 A38 38 0 0 1 25.8 81.1" stroke="${arc}" stroke-width="${w}"/>
    <rect x="58" y="21" width="26" height="58" rx="8" stroke="${phone}" stroke-width="${w}"/>
  </g>
  <rect x="65.5" y="28" width="11" height="5" rx="2.5" fill="${phone}"/>`;
}

/** A complete square icon tile, both themes. */
export function iconSvg(theme, px) {
  const dark = theme === 'light';           // light-theme icon = dark tile
  const bg = dark ? C.tile : C.light;
  const arc = dark ? C.amber : C.amberOn;
  const phone = dark ? C.cyan : C.cyanOn;
  // Heavier line at small sizes so the arcs do not thin out when downsampled.
  const w = px <= 72 ? 9.5 : px <= 126 ? 8.5 : 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
               width="${px}" height="${px}" shape-rendering="geometricPrecision">
    <rect width="100" height="100" fill="${bg}"/>
    ${mark({ arc, phone, w })}
  </svg>`;
}

/** Inline @font-face block pointing at the vendored fonts, for offline renders. */
export function fontFace(fontsUrl) {
  return `
  @font-face { font-family: 'Inter'; font-weight: 400 800; font-display: block;
    src: url('${fontsUrl}/Inter-latin.woff2') format('woff2'); }
  @font-face { font-family: 'JetBrains Mono'; font-weight: 400 700; font-display: block;
    src: url('${fontsUrl}/JetBrainsMono-latin.woff2') format('woff2'); }
  `;
}

export const SANS = `'Inter', 'Segoe UI', system-ui, sans-serif`;
export const MONO = `'JetBrains Mono', ui-monospace, Consolas, monospace`;
