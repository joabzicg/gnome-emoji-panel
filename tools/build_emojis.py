#!/usr/bin/env python3
"""Generate the emoji data files used by the extension.

Usage:
    python3 tools/build_emojis.py EMOJI_TEST OUT_DIR [--max-version 15.1]
        [--annotations LANG=annotations.json,annotationsDerived.json ...]

EMOJI_TEST is Unicode's emoji-test.txt:
    https://unicode.org/Public/emoji/latest/emoji-test.txt

Annotations are CLDR's emoji names and keywords (cldr-json), e.g. for pt:
    https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/pt/annotations.json
    https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-derived-full/annotationsDerived/pt/annotations.json
The first language given provides the names shown in the panel; every
language adds search keywords.

Writes OUT_DIR/emojis.json (groups) and OUT_DIR/keywords.json
({emoji: [display name, "name|name", "keyword|keyword|..."]}, the last two
lowercased and without accents).

Skin tone variants and the "Component" group are skipped, and emojis newer
than --max-version (default 15.1, what Ubuntu 24.04's Noto Color Emoji draws)
are left out so the panel never shows empty boxes.
"""
import argparse
import json
import os
import re
import unicodedata

SKIN_TONES = {'1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'}


def normalize(text):
    text = unicodedata.normalize('NFD', text.lower())
    return ''.join(c for c in text if unicodedata.category(c) != 'Mn')


def bare(emoji):
    return emoji.replace('️', '')


def read_groups(path, max_version):
    groups, current = [], None
    for line in open(path, encoding='utf-8'):
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
    return groups


def read_annotations(paths):
    """Merge CLDR annotation files into {bare emoji: (name, [keywords])}."""
    merged = {}
    for path in paths:
        data = json.load(open(path, encoding='utf-8'))
        root = data.get('annotations') or data.get('annotationsDerived')
        for emoji, entry in root['annotations'].items():
            name = (entry.get('tts') or [''])[0]
            merged[bare(emoji)] = (name, entry.get('default', []))
    return merged


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('emoji_test')
    parser.add_argument('out_dir')
    parser.add_argument('--max-version', default='15.1')
    parser.add_argument('--annotations', action='append', default=[],
                        metavar='LANG=FILE[,FILE]')
    args = parser.parse_args()

    max_version = tuple(int(n) for n in args.max_version.split('.'))
    groups = read_groups(args.emoji_test, max_version)
    languages = [read_annotations(spec.split('=', 1)[1].split(','))
                 for spec in args.annotations]

    keywords = {}
    for group in groups:
        for emoji in group['emojis']:
            names, words = [], []
            for annotations in languages:
                name, kws = annotations.get(bare(emoji), ('', []))
                if name:
                    names.append(name)
                words += kws
            if not names:
                continue
            name_text = '|'.join(dict.fromkeys(normalize(n) for n in names))
            word_text = '|'.join(dict.fromkeys(normalize(w) for w in words if w))
            keywords[emoji] = [names[0], name_text, word_text]

    with open(os.path.join(args.out_dir, 'emojis.json'), 'w', encoding='utf-8') as f:
        json.dump(groups, f, ensure_ascii=False, separators=(',', ':'))
    if languages:
        with open(os.path.join(args.out_dir, 'keywords.json'), 'w', encoding='utf-8') as f:
            json.dump(keywords, f, ensure_ascii=False, separators=(',', ':'))

    total = sum(len(g['emojis']) for g in groups)
    print(f'{total} emojis in {len(groups)} groups, {len(keywords)} with names')


if __name__ == '__main__':
    main()
