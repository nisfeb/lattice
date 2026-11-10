#!/usr/bin/env python3
"""make-corpus.py: build the spreadsheet round-trip corpus with LibreOffice.

Each corpus document is written here as a small hand-built flat ODS
source, then opened and saved by LibreOffice headless three times, so
every file in tests/sheet/corpus/ is a real LibreOffice Calc save. LibreOffice computes every formula result, which
makes the cached values in the corpus the oracle for lattice's formula
engine (scripts/sheet-unit.mjs).

LibreOffice runs with a throwaway profile (-env:UserInstallation) so the
user's profile is never touched. Its version goes into
tests/sheet/corpus/VERSION.

Usage: python3 scripts/sheet-corpus/make-corpus.py [--out DIR] [--only a,b]
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'tests', 'sheet', 'corpus')

NS = {
    'office': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'style': 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'table': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    'draw': 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    'fo': 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    'xlink': 'http://www.w3.org/1999/xlink',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'meta': 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
    'number': 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
    'svg': 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    'of': 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
    'script': 'urn:oasis:names:tc:opendocument:xmlns:script:1.0',
    'ooo': 'http://openoffice.org/2004/office',
    'calcext': 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
    'loext': 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
}


def doc(tables, auto='', after='', before='', scripts=''):
    ns = ' '.join(f'xmlns:{k}="{v}"' for k, v in NS.items())
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<office:document {ns} office:version="1.3" '
            'office:mimetype="application/vnd.oasis.opendocument.spreadsheet">'
            f'{scripts}<office:automatic-styles>{auto}</office:automatic-styles>'
            f'<office:body><office:spreadsheet>{before}{tables}{after}</office:spreadsheet></office:body>'
            '</office:document>\n')


def c(v=None, f=None, style=None, extra='', kids=None, rep=None):
    """one cell: a value (str, int, float, bool), a formula, or empty"""
    a = ''
    if style:
        a += f' table:style-name="{style}"'
    if rep:
        a += f' table:number-columns-repeated="{rep}"'
    a += extra
    if f is not None:
        return f'<table:table-cell{a} table:formula={quoteattr("of:" + f)}/>'
    if v is None and kids is None:
        return f'<table:table-cell{a}/>'
    if kids is not None:
        return f'<table:table-cell{a} office:value-type="string">{kids}</table:table-cell>'
    if isinstance(v, bool):
        return (f'<table:table-cell{a} office:value-type="boolean" office:boolean-value="{str(v).lower()}">'
                f'<text:p>{str(v).upper()}</text:p></table:table-cell>')
    if isinstance(v, (int, float)):
        return f'<table:table-cell{a} office:value-type="float" office:value="{v!r}"><text:p>{v!r}</text:p></table:table-cell>'
    return f'<table:table-cell{a} office:value-type="string"><text:p>{escape(v)}</text:p></table:table-cell>'


def typed(kind, attr, val, show, style=None):
    s = f' table:style-name="{style}"' if style else ''
    return (f'<table:table-cell{s} office:value-type="{kind}" office:{attr}="{val}">'
            f'<text:p>{escape(show)}</text:p></table:table-cell>')


def row(*cells, rep=None, style=None):
    a = (f' table:number-rows-repeated="{rep}"' if rep else '') + (f' table:style-name="{style}"' if style else '')
    return f'<table:table-row{a}>{"".join(cells)}</table:table-row>'


def table(name, *rows, cols='', extra='', pre=''):
    return f'<table:table table:name={quoteattr(name)}{extra}>{pre}{cols}{"".join(rows)}</table:table>'


def d01():
    auto = ('<number:percentage-style style:name="N10"><number:number number:decimal-places="1" number:min-integer-digits="1"/>'
            '<number:text>%</number:text></number:percentage-style>'
            '<number:date-style style:name="N36"><number:year number:style="long"/><number:text>-</number:text>'
            '<number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>'
            '<number:time-style style:name="N41"><number:hours number:style="long"/><number:text>:</number:text>'
            '<number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:time-style>'
            '<number:currency-style style:name="N104"><number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol>'
            '<number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>'
            '<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style>'
            '<number:number-style style:name="N4"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>'
            + ''.join(f'<style:style style:name="{n}" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="{d}"/>'
                      for n, d in (('cePct', 'N10'), ('ceDate', 'N36'), ('ceTime', 'N41'), ('ceCur', 'N104'), ('ceFix', 'N2'), ('ceGrp', 'N4'))))
    return doc(table(
        'Values',
        row(c('kind'), c('value'), c('note')),
        row(c('text'), c('hello world')),
        row(c('integer'), c(42)),
        row(c('decimal'), c(3.14159)),
        row(c('negative'), c(-17.5)),
        row(c('big'), c(123456789012)),
        row(c('small'), c(0.000001234)),
        row(c('fixed'), c(1234.5, style='ceFix')),
        row(c('grouped'), c(1234567.891, style='ceGrp')),
        row(c('percent'), typed('percentage', 'value', '0.125', '12.5%', 'cePct')),
        row(c('currency'), typed('currency', 'value', '1234.5', '$1,234.50', 'ceCur') ),
        row(c('date'), typed('date', 'date-value', '2026-11-10', '2026-11-10', 'ceDate')),
        row(c('time'), typed('time', 'time-value', 'PT13H37M05S', '13:37:05', 'ceTime')),
        row(c('true'), c(True)),
        row(c('false'), c(False)),
        row(c('empty next'), c(), c('after a gap')),
        row(c('text that looks numeric'), c('007')),
    ), auto=auto)


def d02():
    f = lambda s: c(f=s)
    return doc(table(
        'Calc',
        row(c('a'), c('b'), c('expr'), c('result')),
        row(c(2), c(3), c('a+b'), f('=[.A2]+[.B2]')),
        row(c(10), c(4), c('a-b'), f('=[.A3]-[.B3]')),
        row(c(6), c(7), c('a*b'), f('=[.A4]*[.B4]')),
        row(c(1), c(8), c('a/b'), f('=[.A5]/[.B5]')),
        row(c(2), c(10), c('a^b'), f('=[.A6]^[.B6]')),
        row(c(5), c(0), c('a/0'), f('=[.A7]/[.B7]')),
        row(c(3), c(4), c('precedence'), f('=[.A8]+[.B8]*2-(1+[.A8])^2/4')),
        row(c(3), c(4), c('unary'), f('=-[.A9]+ +[.B9]')),
        row(c(50), c(0), c('percent op'), f('=[.A10]%')),
        row(c(3), c(4), c('a<b'), f('=[.A11]<[.B11]')),
        row(c(3), c(4), c('a>=b'), f('=[.A12]>=[.B12]')),
        row(c(3), c(3), c('a=b'), f('=[.A13]=[.B13]')),
        row(c(3), c(4), c('a<>b'), f('=[.A14]<>[.B14]')),
        row(c(3), c(4), c('if'), f('=IF([.A15]>[.B15];"big";"small")')),
        row(c(3), c(4), c('and'), f('=AND([.A16]>0;[.B16]>0)')),
        row(c(3), c(4), c('or'), f('=OR([.A17]>5;[.B17]>5)')),
        row(c(3), c(4), c('not'), f('=NOT([.A18]>[.B18])')),
        row(c('ab'), c('cd'), c('concat'), f('=[.A19]&[.B19]&"!"')),
        row(c(1), c(2), c('sum col'), f('=SUM([.A2:.A18])')),
        row(c(1), c(2), c('avg'), f('=AVERAGE([.A2:.B6])')),
        row(c(1), c(2), c('min max'), f('=MIN([.A2:.B6])+MAX([.A2:.B6])')),
        row(c(1), c(2), c('count'), f('=COUNT([.A1:.B20])')),
        row(c(1), c(2), c('counta'), f('=COUNTA([.A1:.B20])')),
        row(c(1), c(2), c('abs ref'), f('=[.$A$2]*[.B$3]+[.$A4]')),
        row(c(2.567), c(1), c('round'), f('=ROUND([.A26];[.B26])')),
        row(c(-7), c(2), c('mod int abs'), f('=MOD([.A27];[.B27])+INT([.A27]/[.B27])+ABS([.A27])')),
        row(c('Hello'), c(2), c('text fns'), f('=UPPER(LEFT([.A28];[.B28]))&LOWER(RIGHT([.A28];2))&LEN([.A28])')),
        row(c(3), c(4), c('iferror'), f('=IFERROR([.A29]/0;"n/a")')),
        row(c(3), c(4), c('chain'), f('=[.D2]+[.D3]*[.D4]')),
        row(c(3), c(4), c('sumif'), f('=SUMIF([.A2:.A18];">3")')),
        row(c(3), c(4), c('countif'), f('=COUNTIF([.B2:.B18];4)')),
        row(c(2), c(0), c('vlookup'), f('=VLOOKUP(6;[.A2:.B18];2;0)')),
        row(c(3), c(4), c('nested if'), f('=IF([.A34]>5;"hi";IF([.A34]>2;"mid";"lo"))')),
        row(c(16), c(4), c('sqrt'), f('=SQRT([.A35])+POWER([.B35];2)')),
        row(c(3), c(4), c('sumproduct'), f('=SUMPRODUCT([.A2:.A6];[.B2:.B6])')),
        row(c(3), c(4), c('string compare'), f('="abc"<"abd"')),
        row(c(3), c(4), c('unknown name'), f('=NOSUCHFUNCTION([.A38])')),
    ))


def d03():
    return doc(table(
        'Sparse',
        row(c('x', rep=3), c(), c('after')),
        row(rep=4),
        row(c(rep=2), c(7, rep=4)),
        row(rep=20),
        row(c('far')),
        row(c(rep=30), c('wide')),
        cols='<table:table-column table:number-columns-repeated="40"/>',
    ))


def d04():
    return doc(table(
        'Merged',
        row(c('title across', extra=' table:number-columns-spanned="3" table:number-rows-spanned="1"'),
            '<table:covered-table-cell table:number-columns-repeated="2"/>', c('d1')),
        row(c('tall', extra=' table:number-columns-spanned="1" table:number-rows-spanned="2"'), c(1), c(2), c(3)),
        row('<table:covered-table-cell/>', c(4), c(5), c(6)),
        row(c('block', extra=' table:number-columns-spanned="2" table:number-rows-spanned="2"'),
            '<table:covered-table-cell/>', c(7), c(8)),
        row('<table:covered-table-cell table:number-columns-repeated="2"/>', c(9), c(10)),
        row(c('sum'), c(f='=SUM([.B2:.D5])')),
    ))


def d05():
    return doc(
        table('Data', row(c('n')), row(c(1)), row(c(2)), row(c(3)))
        + table('My Sheet', row(c('total'), c(f='=SUM([$Data.A2:.A4])')), row(c('twice'), c(f='=[.B1]*2')))
        + table("It's", row(c('ref'), c(f="=[$'My Sheet'.B2]+[$Data.A2]")), row(c('self'), c(f='=[.B1]+1')))
    )


def d06():
    auto = ('<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>'
            '<style:style style:name="co2" style:family="table-column"><style:table-column-properties style:column-width="1.5cm"/></style:style>'
            '<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="1cm" style:use-optimal-row-height="false"/></style:style>'
            '<style:style style:name="ceB" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>'
            '<style:style style:name="ceI" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-style="italic"/></style:style>'
            '<style:style style:name="ceC" style:family="table-cell" style:parent-style-name="Default"><style:paragraph-properties fo:text-align="center"/></style:style>'
            '<style:style style:name="ceR" style:family="table-cell" style:parent-style-name="Default"><style:paragraph-properties fo:text-align="end"/></style:style>'
            '<style:style style:name="ceBg" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00"/><style:text-properties fo:color="#c9211e"/></style:style>'
            '<style:style style:name="ceBd" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:border="0.74pt solid #000000"/></style:style>')
    return doc(table(
        'Formats',
        row(c('bold', style='ceB'), c('italic', style='ceI'), c('centre', style='ceC'), style='ro1'),
        row(c('right', style='ceR'), c('colour', style='ceBg'), c('border', style='ceBd')),
        row(c(1, style='ceB'), c(2, style='ceBg'), c(f='=[.A3]+[.B3]', style='ceB')),
        cols='<table:table-column table:style-name="co1"/><table:table-column table:style-name="co2" table:number-columns-repeated="2"/>',
    ), auto=auto)


def d07():
    before = ('<table:content-validations><table:content-validation table:name="val1" '
              'table:condition="of:cell-content-is-between(1,10)" table:allow-empty-cell="true" table:base-cell-address="Ranges.B2"/>'
              '</table:content-validations>')
    after = ('<table:named-expressions><table:named-range table:name="Amounts" table:base-cell-address="$Ranges.$A$1" '
             'table:cell-range-address="$Ranges.$B$2:.$B$5"/>'
             '<table:named-expression table:name="Rate" table:base-cell-address="$Ranges.$A$1" table:expression="0.2"/></table:named-expressions>'
             '<table:database-ranges><table:database-range table:name="db1" table:target-range-address="Ranges.A1:Ranges.C5" '
             'table:display-filter-buttons="true"/></table:database-ranges>')
    cf = ('<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Ranges.B2:Ranges.B5">'
          '<calcext:condition calcext:apply-style-name="Default" calcext:value="&gt;3" calcext:base-cell-address="Ranges.B2"/>'
          '</calcext:conditional-format></calcext:conditional-formats>')
    v = ' table:content-validation-name="val1"'
    return doc(table(
        'Ranges',
        row(c('item'), c('amount'), c('taxed')),
        row(c('a'), c(1, extra=v), c(f='=[.B2]*(1+Rate)')),
        row(c('b'), c(2, extra=v), c(f='=[.B3]*(1+Rate)')),
        row(c('c'), c(5, extra=v), c(f='=[.B4]*(1+Rate)')),
        row(c('d'), c(8, extra=v), c(f='=[.B5]*(1+Rate)')),
        row(c('total'), c(f='=SUM(Amounts)'), c(f='=SUM([.C2:.C5])')),
        extra=' table:print-ranges="Ranges.A1:Ranges.C6"',
    ) + '', before=before, after=after).replace('</table:table>', cf + '</table:table>', 1)


def d08():
    note = ('<office:annotation office:display="false"><dc:creator>lattice</dc:creator><dc:date>2026-11-10T00:00:00</dc:date>'
            '<text:p>a cell comment</text:p></office:annotation><text:p>noted</text:p>')
    scripts = ('<office:scripts><office:script script:language="ooo:Basic"><ooo:libraries>'
               '<ooo:library-embedded ooo:name="Standard"><ooo:module ooo:name="M"><ooo:source-code>Sub Hello\n'
               'MsgBox "hi"\nEnd Sub</ooo:source-code></ooo:module></ooo:library-embedded></ooo:libraries></office:script></office:scripts>')
    pilot = ('<table:data-pilot-tables><table:data-pilot-table table:name="Pivot1" table:application-data="" '
             'table:target-range-address="Opaque.F1:Opaque.G4" table:buttons="Opaque.F1 Opaque.G1" table:show-filter-button="false">'
             '<table:source-cell-range table:cell-range-address="Opaque.A1:Opaque.B5"/>'
             '<table:data-pilot-field table:source-field-name="k" table:orientation="row"><table:data-pilot-level/></table:data-pilot-field>'
             '<table:data-pilot-field table:source-field-name="v" table:orientation="data" table:function="sum"/>'
             '</table:data-pilot-table></table:data-pilot-tables>')
    shape = ('<table:shapes><draw:rect draw:z-index="0" svg:width="3cm" svg:height="1cm" svg:x="9cm" svg:y="3cm">'
             '<text:p>a shape</text:p></draw:rect></table:shapes>')
    return doc(table(
        'Opaque',
        row(c('k'), c('v'), c(kids=note)),
        row(c('x'), c(1)),
        row(c('y'), c(2)),
        row(c('x'), c(3)),
        row(c('y'), c(4)),
        row(c('total'), c(f='=SUM([.B2:.B5])')),
        pre=shape,
    ), after=pilot, scripts=scripts)


def d09():
    link = '<text:p>see <text:a xlink:href="https://example.com/a?b=1&amp;c=2" xlink:type="simple">the site</text:a> now</text:p>'
    multi = '<text:p>line one</text:p><text:p>line two</text:p>'
    spaces = '<text:p>two<text:s text:c="3"/>gaps<text:tab/>tab<text:line-break/>break</text:p>'
    return doc(table(
        'Texte',
        row(c('français'), c('naïve café'), c('日本語のセル')),
        row(c('emoji'), c('snow ☃ and 🎉')),
        row(c('entities'), c('a < b && c > "d" \'e\'')),
        row(c('link'), c(kids=link)),
        row(c('lines'), c(kids=multi)),
        row(c('spaces'), c(kids=spaces)),
        row(c('formula text'), c(f='="<b>"&[.B3]&"</b>"')),
        row(c('rtl'), c('שלום עולם')),
    ))


def d10():
    rows = [row(c('id'), c('qty'), c('price'), c('total'))]
    for i in range(2, 1202):
        rows.append(row(c(i - 1), c((i * 7) % 13 + 1), c(round(((i * 31) % 997) / 7 + 0.25, 2)), c(f=f'=[.B{i}]*[.C{i}]')))
    rows.append(row(c('sum'), c(f='=SUM([.B2:.B1201])'), c(), c(f='=SUM([.D2:.D1201])')))
    return doc(table('Large', *rows))


DOCS = {
    '01-values': d01, '02-formulas': d02, '03-repeats': d03, '04-merged': d04, '05-sheets': d05,
    '06-formats': d06, '07-ranges': d07, '08-opaque': d08, '09-i18n': d09, '10-large': d10,
}


def soffice():
    for x in ('soffice', 'libreoffice'):
        if shutil.which(x):
            return shutil.which(x)
    sys.exit('make-corpus: soffice is not on PATH')


def convert(exe, profile, fmt, outdir, files):
    subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--headless', '--norestore',
                    '--convert-to', fmt, '--outdir', outdir, *files],
                   check=True, stdout=subprocess.DEVNULL, timeout=900)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--only')
    args = ap.parse_args()
    names = args.only.split(',') if args.only else list(DOCS)
    exe = soffice()
    with tempfile.TemporaryDirectory(prefix='latsheet-') as tmp:
        src = os.path.join(tmp, 'src')
        os.makedirs(src)
        files = []
        for n in names:
            f = os.path.join(src, n + '.fods')
            with open(f, 'w', encoding='utf-8') as fh:
                fh.write(DOCS[n]())
            files.append(f)
        profile = os.path.join(tmp, 'profile')
        #  Three saves: the first fill in LibreOffice's defaults. The output
        #  never settles byte for byte, because every save rewrites the
        #  printer setup, the page header's time field and the automatic
        #  style numbers. That churn is LibreOffice's own.
        for gen in range(1, 4):
            gdir = os.path.join(tmp, f'gen{gen}')
            convert(exe, profile, 'fods', gdir, files)
            files = [os.path.join(gdir, n + '.fods') for n in names]
            for f in files:
                if not os.path.exists(f):
                    sys.exit(f'make-corpus: LibreOffice did not write {os.path.basename(f)}')
        oo = os.path.join(tmp, 'ods')
        convert(exe, profile, 'ods', oo, files)
        os.makedirs(args.out, exist_ok=True)
        for n in names:
            shutil.copy(os.path.join(gdir, n + '.fods'), os.path.join(args.out, n + '.fods'))
            shutil.copy(os.path.join(oo, n + '.ods'), os.path.join(args.out, n + '.ods'))
        ver = subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--version'],
                             capture_output=True, text=True, timeout=120).stdout.strip()
    with open(os.path.join(args.out, 'VERSION'), 'w') as fh:
        fh.write(ver + '\n')
    print(f'make-corpus: wrote {len(names)} documents with {ver}')


if __name__ == '__main__':
    main()
