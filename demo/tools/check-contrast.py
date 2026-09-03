"""
Palette gate for Earshot. The palette was chosen by running this, not by eye.

    python demo/tools/check-contrast.py

Three different questions need three different metrics, which is why this is
longer than a one-liner:

  1. "Can you read this text?"        -> WCAG 2.1 relative-luminance ratio.
  2. "Are these two panes different   -> CIE L* difference. A luminance RATIO is
      surfaces?"                          meaningless for two near-black greys.
  3. "Can you tell the SPOKEN chip    -> CIEDE2000 dE, in normal vision AND under
      from the PRIVATE chip?"             simulated dichromacy (Vienot 1999).
                                          Amber vs cyan scores 1.08:1 on WCAG and
                                          is still obviously different -- WCAG is
                                          the wrong tool for hue separation.

State in this UI is never carried by colour alone (each state also has its own
glyph, its own word and its own column), so the dichromacy floor is set where
colour stops being a *useful* redundant cue rather than where it becomes the
only cue.
"""
import sys
import math


# ---------------------------------------------------------------- colour maths
def _srgb_to_lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lin(h):
    return tuple(_srgb_to_lin(c) for c in rgb(h))


def luminance(h):
    r, g, b = lin(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def wcag(a, b):
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _lin_to_xyz(r, g, b):
    return (0.4124 * r + 0.3576 * g + 0.1805 * b,
            0.2126 * r + 0.7152 * g + 0.0722 * b,
            0.0193 * r + 0.1192 * g + 0.9505 * b)


_WP = (0.95047, 1.00000, 1.08883)


def lab(h, rgb_lin=None):
    x, y, z = _lin_to_xyz(*(rgb_lin if rgb_lin else lin(h)))

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x / _WP[0]), f(y / _WP[1]), f(z / _WP[2])
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def ciede2000(l1, l2):
    L1, a1, b1 = l1
    L2, a2, b2 = l2
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7))) if Cb > 0 else 0
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if (a1p or b1) else 0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if (a2p or b2) else 0
    dLp, dCp = L2 - L1, C2p - C1p
    if C1p * C2p == 0:
        dhp = 0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    else:
        dhp = h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp) / 2)
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    else:
        hbp = (h1p + h2p + 360) / 2 if (h1p + h2p) < 360 else (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30))
         + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6))
         - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dTh = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) if Cbp > 0 else 0
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dTh)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                     + Rt * (dCp / Sc) * (dHp / Sh))


# Vienot, Brettel & Mollon 1999 dichromat simulation, in linear sRGB.
_LMS = ((0.31399022, 0.63951294, 0.04649755),
        (0.15537241, 0.75789446, 0.08670142),
        (0.01775239, 0.10944209, 0.87256922))
_LMS_INV = ((5.47221206, -4.6419601, 0.16963708),
            (-1.1252419, 2.29317094, -0.1678952),
            (0.02980165, -0.19318073, 1.16364789))
_SIM = {
    'protanopia':   ((0, 1.05118294, -0.05116099), (0, 1, 0), (0, 0, 1)),
    'deuteranopia': ((1, 0, 0), (0.9513092, 0, 0.04866992), (0, 0, 1)),
    'tritanopia':   ((1, 0, 0), (0, 1, 0), (-0.86744736, 1.86727089, 0)),
}


def _mul(m, v):
    return tuple(sum(m[i][j] * v[j] for j in range(3)) for i in range(3))


def simulate(h, kind):
    v = _mul(_LMS, lin(h))
    v = _mul(_SIM[kind], v)
    return _mul(_LMS_INV, v)


def lab_cvd(h, kind):
    return lab(None, rgb_lin=[max(0.0, min(1.0, c)) for c in simulate(h, kind)])


# ------------------------------------------------------------------ the palette
P = {
    'page':      '#070A0D',   # page ground, behind everything
    'room':      '#151A20',   # LEFT pane  - the spoken channel
    'roomcard':  '#1D242C',
    'phone':     '#0C1216',   # RIGHT pane - the private channel (device screen)
    'phonecard': '#152026',
    'ledger':    '#101519',   # bottom strip
    'ink':       '#F3F6F8',
    'ink2':      '#B9C6D0',
    'ink3':      '#8496A3',
    'amber':     '#FFB627',   # SPOKEN   - everyone within earshot hears it
    'cyan':      '#4FE0D2',   # PRIVATE  - asker's own device only
    'rose':      '#FF7A88',   # REFUSED  - would not fit either channel
    'violet':    '#BBA5FF',   # SEALED   - not even the private channel
    # There is deliberately no fifth 'success green'. A green sits ~15 dE from
    # cyan in normal vision and ~6 dE from rose under deuteranopia, i.e. it is
    # confusable with both the PRIVATE chip and the REFUSED chip. The verifier
    # PASS state reuses cyan (it means 'stayed on the private channel') and the
    # headline counter is set in plain ink, which no vision type can confuse.
}

TEXT = [  # (fg, bg, min ratio, where)
    ('ink', 'page', 4.5, 'page headings'),
    ('ink2', 'page', 4.5, 'page meta'),
    ('ink', 'room', 4.5, 'room transcript body'),
    ('ink2', 'room', 4.5, 'room speaker labels'),
    ('ink3', 'room', 3.0, 'room timestamps (>=24px)'),
    ('ink', 'roomcard', 4.5, 'utterance text'),
    ('ink2', 'roomcard', 4.5, 'utterance meta'),
    ('ink', 'phone', 4.5, 'phone screen text'),
    ('ink2', 'phone', 4.5, 'phone secondary'),
    ('ink', 'phonecard', 4.5, 'MCP card body'),
    ('ink2', 'phonecard', 4.5, 'MCP card labels'),
    ('ink', 'ledger', 4.5, 'ledger rows'),
    ('ink2', 'ledger', 4.5, 'ledger meta'),
    ('amber', 'room', 4.5, 'SPOKEN accent'),
    ('amber', 'roomcard', 4.5, 'SPOKEN on card'),
    ('amber', 'ledger', 4.5, 'SPOKEN chip'),
    ('amber', 'page', 4.5, 'SPOKEN on page'),
    ('cyan', 'phone', 4.5, 'PRIVATE accent'),
    ('cyan', 'phonecard', 4.5, 'PRIVATE chip'),
    ('cyan', 'ledger', 4.5, 'SHIFTED chip'),
    ('cyan', 'page', 4.5, 'PRIVATE on page'),
    ('rose', 'room', 4.5, 'REFUSED in room'),
    ('rose', 'ledger', 4.5, 'REFUSED chip'),
    ('rose', 'page', 4.5, 'REFUSED on page'),
    ('violet', 'ledger', 4.5, 'SEALED chip'),
    ('violet', 'phonecard', 4.5, 'SEALED note'),
    ('cyan', 'room', 4.5, 'verifier PASS over room'),
    ('ink', 'ledger', 7.0, 'the headline counter numeral'),
]

SURFACE = [  # (a, b, min dL*, where) - adjacent grounds must read as two surfaces
    ('room', 'phone', 2.5, 'left pane vs right pane'),
    ('room', 'page', 2.5, 'pane vs page ground'),
    ('phone', 'page', 1.0, 'phone screen vs page ground'),
    ('roomcard', 'room', 3.0, 'utterance card vs pane'),
    ('phonecard', 'phone', 3.0, 'MCP card vs phone screen'),
    ('ledger', 'page', 1.5, 'ledger strip vs page ground'),
]

# Every pair of state colours that can appear in the same glance.
STATE = [('amber', 'cyan'), ('amber', 'rose'), ('amber', 'violet'),
         ('cyan', 'rose'), ('cyan', 'violet'),
         ('rose', 'violet')]
DE_NORMAL = 25.0   # unmistakable at a glance, after video compression
DE_CVD = 10.0      # still a useful redundant cue for a dichromat


def main():
    fails = []

    print('== text on ground (WCAG 2.1 contrast ratio) ==')
    for fg, bg, mn, where in TEXT:
        r = wcag(P[fg], P[bg])
        ok = r >= mn
        if not ok:
            fails.append('text {}/{} {:.2f} < {}'.format(fg, bg, r, mn))
        print('  {:6.2f} >= {:4.1f}  {}  {:>6} on {:<9} {}'.format(
            r, mn, 'ok  ' if ok else 'FAIL', fg, bg, where))

    print('\n== surface vs surface (CIE L* difference) ==')
    for a, b, mn, where in SURFACE:
        d = abs(lab(P[a])[0] - lab(P[b])[0])
        ok = d >= mn
        if not ok:
            fails.append('surface {}/{} dL*={:.2f} < {}'.format(a, b, d, mn))
        print('  {:6.2f} >= {:4.1f}  {}  {:>9} vs {:<9} {}'.format(
            d, mn, 'ok  ' if ok else 'FAIL', a, b, where))

    print('\n== state colour separation (CIEDE2000, normal + dichromacy) ==')
    print('  {:<16}{:>8}{:>8}{:>8}{:>8}'.format('pair', 'normal', 'protan', 'deuter', 'tritan'))
    for a, b in STATE:
        dn = ciede2000(lab(P[a]), lab(P[b]))
        dv = {k: ciede2000(lab_cvd(P[a], k), lab_cvd(P[b], k)) for k in _SIM}
        ok = dn >= DE_NORMAL and min(dv.values()) >= DE_CVD
        if not ok:
            fails.append('state {}/{} dE normal={:.1f} min-cvd={:.1f}'.format(
                a, b, dn, min(dv.values())))
        print('  {:<16}{:8.1f}{:8.1f}{:8.1f}{:8.1f}  {}'.format(
            a + '/' + b, dn, dv['protanopia'], dv['deuteranopia'], dv['tritanopia'],
            'ok' if ok else 'FAIL'))
    print('  floors: normal >= {}, every dichromacy >= {}'.format(DE_NORMAL, DE_CVD))

    n = len(TEXT) + len(SURFACE) + len(STATE)
    print()
    if fails:
        for f in fails:
            print('FAIL ' + f)
        print('\n{} of {} checks failed'.format(len(fails), n))
        return 1
    print('all {} checks pass'.format(n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
