#!/usr/bin/env python3
"""canon.py: canonical form of a LibreOffice flat ODT save, for no-loss checks.

Two LibreOffice saves of the same document differ in ways that carry no
content: the settings block, meta dates and generator, editing time and
statistics, officeooo:rsid attributes, the numbering of automatic styles,
and ids that are memory addresses (tracked changes, xml:id on lists).
canon.py removes that churn so two saves of the same content compare
equal, and an edit shows as exactly what it changed:

  - office:settings is dropped
  - meta:generator, meta:creation-date, dc:date, meta:editing-duration,
    meta:editing-cycles, meta:print-date, meta:printed-by and
    meta:document-statistic are dropped from office:meta
  - every officeooo:*rsid attribute is dropped
  - xml:id and text:id values are renumbered in document order, and the
    attributes that point at them (text:change-id, text:continue-list,
    text:ref-name) follow
  - automatic styles are renamed by a hash of their content (references
    to other automatic styles hashed through), references are rewritten,
    duplicates that become identical are merged, and
    office:automatic-styles is sorted by the new names
  - trailing whitespace in a macro's ooo:source-code is trimmed (it
    grows by one indentation on every LibreOffice save)
  - whitespace-only text between block elements is dropped; text inside
    paragraph content is kept exactly
  - the result is C14N 2.0

LibreOffice rewrites relative links (text:a, a linked section's source)
relative to wherever it saves, so compare saves made in directories at
the same depth, as writer-roundtrip.mjs does. canon.py leaves links alone.

It refuses a document with a DOCTYPE or an entity declaration. It is for
LibreOffice output, not for hostile input.

Usage:
  canon.py FILE                 canonical XML on stdout
  canon.py FILE -o OUT          canonical XML to OUT
  canon.py --counts FILE        per-element-name counts of the canonical
                                form, as JSON
  canon.py --self-test [DIR]    re-save every DIR/*.fodt (default the corpus)
                                with LibreOffice twice, in two runs, and
                                assert the canonical forms are identical
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

N = {
    'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'meta': 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'xlink': 'http://www.w3.org/1999/xlink',
    'officeooo': 'http://openoffice.org/2009/office',
    'xml': 'http://www.w3.org/XML/1998/namespace',
}


def q(prefix, local):
    return '{%s}%s' % (N[prefix], local)


META_DROP = {q('meta', 'generator'), q('meta', 'creation-date'), q('dc', 'date'),
             q('meta', 'editing-duration'), q('meta', 'editing-cycles'), q('meta', 'print-date'),
             q('meta', 'printed-by'), q('meta', 'document-statistic')}

#  elements whose children are mixed content: whitespace in them is text
MIXED = {q('text', x) for x in ('p', 'h', 'span', 'a', 'meta', 'ruby-base', 'ruby-text',
                                 'index-title-template', 'note-citation')}

ID_DEFS = {q('xml', 'id'), q('text', 'id')}
ID_REFS = {q('text', 'change-id'), q('text', 'continue-list'), q('text', 'ref-name')}

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.normpath(os.path.join(HERE, '..', '..', 'tests', 'writer', 'corpus'))


class Refused(Exception):
    pass


def local(tag):
    return tag.rsplit('}', 1)[-1]


def is_style_ref(attr):
    n = local(attr)
    return n.endswith('style-name') or n == 'page-layout-name'


def parse(data):
    if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
        raise Refused('DOCTYPE or ENTITY declaration')
    nsmap = []
    for ev, item in ET.iterparse(io.BytesIO(data), events=('start-ns',)):
        nsmap.append(item)
    return ET.fromstring(data), nsmap


def kind_of(el):
    """paragraph, text, table-cell ... for style:style, else the tag"""
    if el.tag == q('style', 'style'):
        return el.attrib.get(q('style', 'family'), 'style')
    return local(el.tag)


#  which family a style reference on an element means, when a name is
#  used by more than one family
ELEMENT_FAMILY = {
    'p': 'paragraph', 'h': 'paragraph', 'span': 'text', 'a': 'text', 'section': 'section',
    'list': 'list-style', 'table': 'table', 'table-column': 'table-column',
    'table-row': 'table-row', 'table-cell': 'table-cell', 'covered-table-cell': 'table-cell',
    'frame': 'graphic', 'ruby': 'ruby', 'index-title': 'section', 'table-of-content': 'section',
}


def ref_key(cands, e, a):
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    n = local(a)
    if n == 'page-layout-name':
        want = 'page-layout'
    elif n == 'list-style-name':
        want = 'list-style'
    elif n in ('visited-style-name',):
        want = 'text'
    elif n == 'parent-style-name' or n == 'next-style-name':
        want = kind_of(e)
    elif n == 'data-style-name':
        hit = [c for c in cands if c[0].endswith('-style') and c[0] != 'list-style']
        return hit[0] if hit else sorted(cands)[0]
    else:
        want = ELEMENT_FAMILY.get(local(e.tag))
    hit = [c for c in cands if c[0] == want]
    return hit[0] if hit else sorted(cands)[0]


def canon_tree(root):
    parent = {c: p for p in root.iter() for c in p}

    #  settings, meta churn, rsids
    for el in list(root):
        if el.tag == q('office', 'settings'):
            root.remove(el)
        elif el.tag == q('office', 'meta'):
            for m in list(el):
                if m.tag in META_DROP:
                    el.remove(m)
    for el in root.iter():
        for a in [a for a in el.attrib if a.startswith('{%s}' % N['officeooo']) and a.endswith('rsid')]:
            del el.attrib[a]

    #  LibreOffice adds indentation to the end of a macro's source on
    #  every save
    for el in root.iter('{http://openoffice.org/2004/office}source-code'):
        if el.text:
            el.text = el.text.rstrip()

    #  ids, renumbered in document order
    ids = {}
    for el in root.iter():
        for a in ID_DEFS:
            v = el.attrib.get(a)
            if v is not None and v not in ids:
                ids[v] = 'id%d' % (len(ids) + 1)
    for el in root.iter():
        for a in ID_DEFS | ID_REFS:
            v = el.attrib.get(a)
            if v is not None and v in ids:
                el.attrib[a] = ids[v]

    #  automatic styles, renamed by content. Names are scoped by family
    #  (LibreOffice can write a text style T1 and a table style T1 in one
    #  document), so a style is keyed by (kind, name) and a reference is
    #  resolved to a kind from the element and attribute that carry it.
    autos = root.find(q('office', 'automatic-styles'))
    if autos is not None:
        sname = q('style', 'name')
        byname = {}
        for el in autos:
            if sname in el.attrib:
                byname[(kind_of(el), el.attrib[sname])] = el
        names = {}
        for k in byname:
            names.setdefault(k[1], []).append(k)
        resolve = lambda e, a, v: ref_key(names.get(v), e, a)
        memo, busy = {}, set()

        def digest(key):
            if key in memo:
                return memo[key]
            if key in busy:
                return 'cycle'
            busy.add(key)
            clone = ET.fromstring(ET.tostring(byname[key]))
            del clone.attrib[sname]
            for e in clone.iter():
                for a, v in list(e.attrib.items()):
                    if is_style_ref(a):
                        r = resolve(e, a, v)
                        if r:
                            e.attrib[a] = '@' + digest(r)
            for e in clone.iter():
                e.attrib = dict(sorted(e.attrib.items()))
                if e.text is not None and not e.text.strip():
                    e.text = None
                if e.tail is not None and not e.tail.strip():
                    e.tail = None
            h = hashlib.sha256(ET.tostring(clone)).hexdigest()[:10]
            busy.discard(key)
            memo[key] = h
            return h

        rename = {k: 'A' + k[0] + '-' + digest(k) for k in byname}
        for el in root.iter():
            for a, v in list(el.attrib.items()):
                if is_style_ref(a):
                    r = resolve(el, a, v)
                    if r:
                        el.attrib[a] = rename[r]
        for k, el in byname.items():
            el.attrib[sname] = rename[k]
        kids = list(autos)
        for k in kids:
            autos.remove(k)
        seen = set()
        for k in sorted(kids, key=lambda k: (k.attrib.get(sname, ''), local(k.tag))):
            key = ET.tostring(k)
            if key in seen:
                continue
            seen.add(key)
            autos.append(k)

    #  whitespace between blocks
    parent = {c: p for p in root.iter() for c in p}
    for el in root.iter():
        if el.tag not in MIXED and el.text is not None and not el.text.strip():
            el.text = None
        p = parent.get(el)
        if p is not None and p.tag not in MIXED and el.tail is not None and not el.tail.strip():
            el.tail = None
    return root


def canonicalize(data):
    root, nsmap = parse(data)
    for prefix, uri in nsmap:
        if prefix and prefix != 'xml':
            ET.register_namespace(prefix, uri)
    canon_tree(root)
    return ET.canonicalize(ET.tostring(root, encoding='unicode'))


def counts(text):
    c = {}
    for m in re.finditer(r'<([A-Za-z_][\w.-]*:[\w.-]+|[A-Za-z_][\w.-]*)[\s>/]', text):
        c[m.group(1)] = c.get(m.group(1), 0) + 1
    return dict(sorted(c.items()))


def soffice():
    exe = shutil.which('soffice') or shutil.which('libreoffice')
    if not exe:
        sys.exit('canon: soffice is not on PATH')
    return exe


def resave(exe, files, outdir, profile):
    subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--headless', '--norestore',
                    '--convert-to', 'fodt:OpenDocument Text Flat XML', '--outdir', outdir, *files],
                   check=True, stdout=subprocess.DEVNULL, timeout=900)


def self_test(d):
    exe = soffice()
    files = sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('.fodt'))
    fails = 0
    with tempfile.TemporaryDirectory(prefix='latcanon-') as tmp:
        a, b = os.path.join(tmp, 'a'), os.path.join(tmp, 'b')
        resave(exe, files, a, os.path.join(tmp, 'pa'))
        resave(exe, files, b, os.path.join(tmp, 'pb'))
        for f in files:
            n = os.path.basename(f)
            ca = canonicalize(open(os.path.join(a, n), 'rb').read())
            cb = canonicalize(open(os.path.join(b, n), 'rb').read())
            raw_same = open(os.path.join(a, n), 'rb').read() == open(os.path.join(b, n), 'rb').read()
            ok = ca == cb
            print(('  ok   - ' if ok else '  FAIL - ') + f'{n}: two re-saves canonicalize equal'
                  + ('' if ok else ' (first difference at %d)' % next(i for i, (x, y) in enumerate(zip(ca + '\0', cb + '\1')) if x != y))
                  + ('' if raw_same else ' (raw saves differ)'))
            fails += not ok
            #  canonicalizing is idempotent on its own output's shape
            again = canonicalize(ca.encode())
            ok2 = again == ca
            print(('  ok   - ' if ok2 else '  FAIL - ') + f'{n}: canonical form is a fixed point')
            fails += not ok2
    print(f'\n{fails} check(s) FAILED' if fails else '\nall checks passed')
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file', nargs='?')
    ap.add_argument('-o', '--out')
    ap.add_argument('--counts', action='store_true')
    ap.add_argument('--self-test', nargs='?', const=CORPUS, metavar='DIR')
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test(args.self_test))
    if not args.file:
        ap.error('a FILE is needed')
    try:
        text = canonicalize(open(args.file, 'rb').read())
    except Refused as e:
        sys.exit(f'canon: refused: {e}')
    if args.counts:
        print(json.dumps(counts(text)))
    elif args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
