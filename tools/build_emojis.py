#!/usr/bin/env python3
"""Generate emoji-panel@joab/emojis.json from Unicode's emoji-test.txt.

Usage:
    curl -O https://unicode.org/Public/emoji/latest/emoji-test.txt
    python3 tools/build_emojis.py emoji-test.txt emoji-panel@joab/emojis.json [MAX_VERSION]

Skin tone variants and the "Component" group are skipped, and emojis newer
than MAX_VERSION (default 15.1, what Ubuntu 24.04's Noto Color Emoji draws)
are left out so the panel never shows empty boxes.
"""
import json
import re
import sys

SKIN_TONES = {'1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'}


def main():
    src, out = sys.argv[1], sys.argv[2]
    max_version = tuple(int(n) for n in (sys.argv[3] if len(sys.argv) > 3 else '15.1').split('.'))

    groups, current = [], None
    for line in open(src, encoding='utf-8'):
        if line.startswith('# group:'):
            name = line.split(':', 1)[1].strip()
            current = None if name == 'Component' else {'name': name, 'emojis': []}
            if current:
                groups.append(current)
            continue
        if not current or line.startswith('#') or '; fully-qualified' not in line:
            continue
        codes = line.split(';')[0].split()
        if SKIN_TONES.intersection(codes):
            continue
        version = re.search(r'E(\d+)\.(\d+)', line)
        if version and (int(version.group(1)), int(version.group(2))) > max_version:
            continue
        current['emojis'].append(''.join(chr(int(c, 16)) for c in codes))

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(groups, f, ensure_ascii=False, separators=(',', ':'))
    for group in groups:
        print(f"{group['name']}: {len(group['emojis'])}")


if __name__ == '__main__':
    main()
