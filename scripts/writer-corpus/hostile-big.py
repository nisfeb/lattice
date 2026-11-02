#!/usr/bin/env python3
"""hostile-big.py: the two machine-sized hostile Writer documents.

The rest of tests/writer/corpus/hostile/ is hand-written. These two are
too regular or too large to write by hand:

  deep-nesting.fodt    10,000 nested text:span elements in one paragraph
                       (committed, about 230 KB)
  huge-attribute.fodt  one attribute value of 50 MB (not committed;
                       generate it where a suite needs it)

Usage: python3 scripts/writer-corpus/hostile-big.py DIR [--huge]
"""
import os
import sys

ROOT = ('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
        ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
        ' office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\n'
        ' <office:body>\n  <office:text>\n')
END = '  </office:text>\n </office:body>\n</office:document>\n'
DEPTH = 10_000
HUGE = 50 * 1024 * 1024


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'deep-nesting.fodt'), 'w') as fh:
        fh.write(ROOT + '   <text:p>' + '<text:span>' * DEPTH + 'deep'
                 + '</text:span>' * DEPTH + '</text:p>\n' + END)
    if '--huge' in sys.argv:
        with open(os.path.join(out, 'huge-attribute.fodt'), 'w') as fh:
            fh.write(ROOT + '   <text:p text:style-name="')
            chunk = 'A' * (1024 * 1024)
            for _ in range(HUGE // len(chunk)):
                fh.write(chunk)
            fh.write('">A paragraph with a 50 MB attribute.</text:p>\n' + END)


if __name__ == '__main__':
    main()
