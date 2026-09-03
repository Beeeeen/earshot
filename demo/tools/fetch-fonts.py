"""
Pull the two webfonts into demo/fonts/ so the demo renders identically with the
network unplugged. A hackathon demo that reflows to Arial because the venue
wifi is down is a bad demo.

    python demo/tools/fetch-fonts.py

Keeps only the latin and latin-ext subsets, rewrites the @font-face src to a
relative path and writes demo/fonts/fonts.css. Re-run only if the fonts change.
"""
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', 'fonts'))
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
CSS_URL = ('https://fonts.googleapis.com/css2'
           '?family=Inter:wght@400..800'
           '&family=JetBrains+Mono:wght@400..700'
           '&display=block')
KEEP = ('latin', 'latin-ext')


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    return data if binary else data.decode('utf-8')


def main():
    os.makedirs(OUT, exist_ok=True)
    css = get(CSS_URL)

    blocks = re.findall(r'(/\*\s*([\w\-\[\]]+)\s*\*/\s*@font-face\s*\{[^}]*\})', css)
    if not blocks:
        print('could not parse the Google Fonts response', file=sys.stderr)
        return 1

    kept, out = [], []
    for block, subset in blocks:
        if subset not in KEEP:
            continue
        url = re.search(r'url\((https://[^)]+\.woff2)\)', block)
        fam = re.search(r"font-family:\s*'([^']+)'", block)
        if not url or not fam:
            continue
        name = '{}-{}.woff2'.format(fam.group(1).replace(' ', ''), subset)
        path = os.path.join(OUT, name)
        if not os.path.exists(path):
            with open(path, 'wb') as fh:
                fh.write(get(url.group(1), binary=True))
        kept.append(name)
        out.append(block.replace(url.group(1), './' + name))

    header = ('/* Vendored from Google Fonts by demo/tools/fetch-fonts.py so the\n'
              '   demo renders the same with no network. SIL Open Font License 1.1. */\n')
    with open(os.path.join(OUT, 'fonts.css'), 'w', encoding='utf-8') as fh:
        fh.write(header + '\n'.join(out) + '\n')

    for name in sorted(set(kept)):
        print('  {:34} {:>8,} bytes'.format(name, os.path.getsize(os.path.join(OUT, name))))
    print('wrote {} with {} @font-face rules'.format(
        os.path.join(OUT, 'fonts.css'), len(out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
