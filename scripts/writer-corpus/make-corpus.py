#!/usr/bin/env python3
"""make-corpus.py: build the Writer round-trip corpus with LibreOffice.

Each corpus document is written here as a small hand-built flat ODT
source, then opened and saved by LibreOffice headless until its output
stops changing (the first saves fill in defaults), so every file in
tests/writer/corpus/ is a real LibreOffice save, and one that a further
LibreOffice save leaves canonically equal:

  soffice --headless --convert-to "fodt:OpenDocument Text Flat XML"
  soffice --headless --convert-to "odt:writer8"

The plan describes driving LibreOffice over UNO from its bundled python.
That python (pyuno) is an optional package and is often not installed,
while --convert-to always works and performs the same load-and-store, so
the corpus is built this way. LibreOffice runs with a throwaway profile
(-env:UserInstallation) so the user's profile and macro settings are
never touched.

The LibreOffice version goes into tests/writer/corpus/VERSION. A few
LibreOffice behaviours to know when reading the output:

  - recording of changes is on when <text:tracked-changes> carries no
    text:track-changes attribute (the ODF default is true); off is
    written as text:track-changes="false"
  - tracked-change ids (ct94...) and list xml:ids are memory addresses
    or random and differ on every save; canon.py renumbers them
  - a macro's ooo:source-code gains a line of indentation whitespace at
    its end on every save; canon.py trims it
  - a 13-large style name is shared by two families (text T1 and table
    T1); names are scoped by family, and the corpus keeps that case
  - a text:meta carrying RDFa (xhtml:about, xhtml:property) makes the
    flat ODT import fail outright in LibreOffice 26.8, so 10-unknown has
    an inline text:meta with an xml:id and no RDFa

14-lo-gui.fodt is saved from the LibreOffice window (rsid churn, view
settings) by lo-gui.xba under Xvfb, and is not built here.

Usage: python3 scripts/writer-corpus/make-corpus.py [--out DIR] [--keep-src DIR]
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canon import canonicalize  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'tests', 'writer', 'corpus')

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
    'config': 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
    'script': 'urn:oasis:names:tc:opendocument:xmlns:script:1.0',
    'ooo': 'http://openoffice.org/2004/office',
    'xhtml': 'http://www.w3.org/1999/xhtml',
    'loext': 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
    'officeooo': 'http://openoffice.org/2009/office',
}

FONTS = '''
<style:font-face style:name="Liberation Serif" svg:font-family="&apos;Liberation Serif&apos;" style:font-family-generic="roman" style:font-pitch="variable"/>
<style:font-face style:name="Liberation Sans" svg:font-family="&apos;Liberation Sans&apos;" style:font-family-generic="swiss" style:font-pitch="variable"/>
<style:font-face style:name="Liberation Mono" svg:font-family="&apos;Liberation Mono&apos;" style:font-family-generic="modern" style:font-pitch="fixed"/>
'''

#  The named styles the documents use. LibreOffice only keeps a style
#  name it can resolve, so every name a body refers to is defined here.
STYLES = '''
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text">
 <style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm" fo:keep-with-next="always"/>
 <style:text-properties style:font-name="Liberation Sans" fo:font-size="14pt"/>
</style:style>
<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
 <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.247cm" fo:line-height="115%"/>
</style:style>
<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Subtitle" style:class="chapter">
 <style:paragraph-properties fo:text-align="center"/>
 <style:text-properties fo:font-size="28pt" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Subtitle" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:class="chapter">
 <style:paragraph-properties fo:margin-top="0.106cm" fo:text-align="center"/>
 <style:text-properties fo:font-size="18pt"/>
</style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="1" style:class="text">
 <style:text-properties fo:font-size="130%" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2" style:class="text">
 <style:text-properties fo:font-size="115%" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="3" style:class="text">
 <style:text-properties fo:font-size="101%" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Heading_20_4" style:display-name="Heading 4" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="4" style:class="text">
 <style:text-properties fo:font-size="95%" fo:font-style="italic" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Heading_20_5" style:display-name="Heading 5" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="5" style:class="text">
 <style:text-properties fo:font-size="85%" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Heading_20_6" style:display-name="Heading 6" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="6" style:class="text">
 <style:text-properties fo:font-size="85%" fo:font-style="italic" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html">
 <style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm" fo:margin-top="0cm" fo:margin-bottom="0.499cm" fo:text-indent="0cm" style:auto-text-indent="false"/>
</style:style>
<style:style style:name="List" style:family="paragraph" style:parent-style-name="Text_20_body" style:class="list"/>
<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>
<style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra">
 <style:paragraph-properties fo:text-align="center"/>
 <style:text-properties fo:font-weight="bold"/>
</style:style>
<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>
<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
 <style:paragraph-properties fo:text-align="center"/>
</style:style>
<style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
 <style:text-properties fo:font-size="10pt"/>
</style:style>
<style:style style:name="Endnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra">
 <style:text-properties fo:font-size="10pt"/>
</style:style>
<style:style style:name="Contents_20_Heading" style:display-name="Contents Heading" style:family="paragraph" style:parent-style-name="Heading" style:class="index">
 <style:text-properties fo:font-size="16pt" fo:font-weight="bold"/>
</style:style>
<style:style style:name="Contents_20_1" style:display-name="Contents 1" style:family="paragraph" style:parent-style-name="Standard" style:class="index">
 <style:paragraph-properties>
  <style:tab-stops><style:tab-stop style:position="17cm" style:type="right" style:leader-style="dotted" style:leader-text="."/></style:tab-stops>
 </style:paragraph-properties>
</style:style>
<style:style style:name="Frame_20_contents" style:display-name="Frame contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>
<style:style style:name="Emphasis" style:family="text">
 <style:text-properties fo:font-style="italic"/>
</style:style>
<style:style style:name="Strong_20_Emphasis" style:display-name="Strong Emphasis" style:family="text">
 <style:text-properties fo:font-weight="bold"/>
</style:style>
<style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text">
 <style:text-properties fo:color="#000080" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/>
</style:style>
<style:style style:name="Footnote_20_Symbol" style:display-name="Footnote Symbol" style:family="text"/>
<style:style style:name="Footnote_20_anchor" style:display-name="Footnote anchor" style:family="text">
 <style:text-properties style:text-position="super 58%"/>
</style:style>
<style:style style:name="Endnote_20_Symbol" style:display-name="Endnote Symbol" style:family="text"/>
<style:style style:name="Endnote_20_anchor" style:display-name="Endnote anchor" style:family="text">
 <style:text-properties style:text-position="super 58%"/>
</style:style>
<style:style style:name="Frame" style:family="graphic">
 <style:graphic-properties text:anchor-type="paragraph" svg:x="0cm" svg:y="0cm" fo:margin-left="0.201cm" fo:margin-right="0.201cm" fo:margin-top="0.201cm" fo:margin-bottom="0.201cm" style:wrap="parallel" style:vertical-pos="top" style:vertical-rel="paragraph-content" style:horizontal-pos="center" style:horizontal-rel="paragraph-content" fo:padding="0.15cm" fo:border="0.06pt solid #000000"/>
</style:style>
'''

OUTLINE_PLAIN = '<text:outline-style style:name="Outline">' + ''.join(
    f'<text:outline-level-style text:level="{i}" style:num-format=""/>' for i in range(1, 11)) + '</text:outline-style>'

OUTLINE_NUMBERED = '<text:outline-style style:name="Outline">' + ''.join(
    f'<text:outline-level-style text:level="{i}" style:num-format="1" style:num-suffix="." text:display-levels="{min(i, 6)}">'
    f'<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">'
    f'<style:list-level-label-alignment text:label-followed-by="listtab"/></style:list-level-properties>'
    f'</text:outline-level-style>' for i in range(1, 11)) + '</text:outline-style>'

LETTER_LAYOUT = '''
<style:page-layout style:name="pm1">
 <style:page-layout-properties fo:page-width="21.59cm" fo:page-height="27.94cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm" style:writing-mode="lr-tb"/>
</style:page-layout>
'''
MASTER = '<style:master-page style:name="Standard" style:page-layout-name="pm1"/>'


def doc(body, auto='', styles='', outline=OUTLINE_PLAIN, layouts=LETTER_LAYOUT,
        master=MASTER, meta='', settings='', scripts='', fonts=''):
    ns = ' '.join(f'xmlns:{k}="{v}"' for k, v in NS.items())
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document {ns} office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta>{meta}</office:meta>
<office:settings>{settings}</office:settings>
{scripts}
<office:font-face-decls>{FONTS}{fonts}</office:font-face-decls>
<office:styles>{STYLES}{styles}{outline}</office:styles>
<office:automatic-styles>{auto}{layouts}</office:automatic-styles>
<office:master-styles>{master}</office:master-styles>
<office:body><office:text>
{body}
</office:text></office:body></office:document>
'''


def p(text, style='Text_20_body'):
    return f'<text:p text:style-name="{style}">{text}</text:p>'


def h(text, level, style=None):
    style = style or f'Heading_20_{min(level, 6)}'
    return f'<text:h text:style-name="{style}" text:outline-level="{level}">{text}</text:h>'


LOREM = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod '
         'tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, '
         'quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.')

# ---------------------------------------------------------------- 01
D01 = doc('\n'.join([
    p('The first paragraph is in the Text Body style.'),
    p('A second paragraph follows it, also Text Body.'),
    p(''),
    p('An empty Text Body paragraph sits above this one.'),
    p('This paragraph uses the Default Paragraph Style.', 'Standard'),
    p('', 'Standard'),
    p(LOREM),
    p('The last paragraph.'),
]))

# ---------------------------------------------------------------- 02
D02_BODY = '\n'.join([
    p('A Document Title', 'Title'),
    p('and its subtitle', 'Subtitle'),
] + [x for i in range(1, 7) for x in (h(f'Heading level {i}', i), p(f'Body text under heading {i}.'))])
D02 = doc(D02_BODY, outline=OUTLINE_NUMBERED)

# ---------------------------------------------------------------- 03
D03_AUTO = '''
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="T3" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="T4" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-type="double" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="T5" style:family="text"><style:text-properties style:text-underline-style="wave" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="T6" style:family="text"><style:text-properties style:text-line-through-style="solid" style:text-line-through-type="single"/></style:style>
<style:style style:name="T7" style:family="text"><style:text-properties fo:font-style="italic" fo:font-weight="bold"/></style:style>
<style:style style:name="T8" style:family="text"><style:text-properties fo:font-style="italic" fo:font-weight="bold" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color" style:text-line-through-style="solid" style:text-line-through-type="single"/></style:style>
<style:style style:name="T9" style:family="text"><style:text-properties fo:color="#c9211e" fo:background-color="#ffff00"/></style:style>
'''
D03_STYLES = '''
<style:style style:name="Lattice_20_Marker" style:display-name="Lattice Marker" style:family="text">
 <style:text-properties fo:color="#2a6099" fo:font-variant="small-caps" fo:letter-spacing="0.05cm"/>
</style:style>
'''
D03 = doc('\n'.join([
    p('Plain, <text:span text:style-name="T1">bold</text:span>, <text:span text:style-name="T2">italic</text:span>.'),
    p('Underlines: <text:span text:style-name="T3">single</text:span>, <text:span text:style-name="T4">double</text:span>, <text:span text:style-name="T5">wave</text:span>.'),
    p('A <text:span text:style-name="T6">struck</text:span> word.'),
    p('Combined: <text:span text:style-name="T7">bold italic</text:span> and <text:span text:style-name="T8">everything at once</text:span>.'),
    p('A <text:span text:style-name="T9">red on yellow</text:span> span.'),
    p('Named styles: <text:span text:style-name="Emphasis">Emphasis</text:span>, <text:span text:style-name="Strong_20_Emphasis">Strong Emphasis</text:span>, and <text:span text:style-name="Lattice_20_Marker">a custom one</text:span>.'),
    p('Nested: <text:span text:style-name="T1">bold with <text:span text:style-name="T2">italic</text:span> inside</text:span>.'),
]), auto=D03_AUTO, styles=D03_STYLES)

# ---------------------------------------------------------------- 04
def list_style(name, kind):
    levels = []
    for i in range(1, 11):
        ind = f'<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="{0.635 * i + 0.635:.3f}cm" fo:text-indent="-0.635cm" fo:margin-left="{0.635 * i + 0.635:.3f}cm"/></style:list-level-properties>'
        if kind == 'bullet':
            levels.append(f'<text:list-level-style-bullet text:level="{i}" text:bullet-char="{"•◦▪"[(i - 1) % 3]}">{ind}</text:list-level-style-bullet>')
        else:
            levels.append(f'<text:list-level-style-number text:level="{i}" style:num-suffix="." style:num-format="{"1ai"[(i - 1) % 3]}">{ind}</text:list-level-style-number>')
    return f'<text:list-style style:name="{name}">{"".join(levels)}</text:list-style>'


def li(text, sub='', style='List', attrs=''):
    return f'<text:list-item{attrs}>{p(text, style)}{sub}</text:list-item>'


def ul(items, style='L1', attrs=''):
    return f'<text:list text:style-name="{style}"{attrs}>{"".join(items)}</text:list>'


D04_AUTO = list_style('L1', 'bullet') + list_style('L2', 'number')
D04_NESTED = ul([
    li('Bullet one'),
    li('Bullet two, with children', ul([
        li('Level two', ul([
            li('Level three', ul([li('Level four, the deepest')])),
        ])),
        li('Level two again'),
    ])),
    li('Bullet three'),
])
D04 = doc('\n'.join([
    p('A bullet list, nested four levels deep:'),
    D04_NESTED,
    p('A numbered list:'),
    ul([li('First'), li('Second', ul([li('Second, a'), li('Second, b')], 'L2')), li('Third')], 'L2', ' xml:id="list-num-1"'),
    p('A paragraph interrupts the list, which then continues:'),
    ul([li('Fourth, continued'), li('Fifth')], 'L2', ' text:continue-numbering="true"'),
    p('A second, separate numbered list in the same style:'),
    ul([li('Other one', attrs=' text:start-value="1"'), li('Other two')], 'L2'),
    p('The first list continues again, past the separate one:'),
    ul([li('Sixth, continued across a list'), li('Seventh')], 'L2', ' text:continue-list="list-num-1"'),
    p('A list that restarts its numbering:'),
    ul([li('Starts again at one', attrs=' text:start-value="1"'), li('Two')], 'L2'),
    p('A list with a header:'),
    ul(['<text:list-header>' + p('The list header, not numbered', 'List') + '</text:list-header>', li('Item after the header'), li('Another item')], 'L2'),
]), auto=D04_AUTO)

# ---------------------------------------------------------------- 05
def a(href, text):
    return f'<text:a xlink:type="simple" xlink:href="{href}" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">{text}</text:a>'


D05 = doc('\n'.join([
    h('<text:bookmark text:name="intro"/>Introduction', 1),
    p('A web link: ' + a('https://example.org/page?a=1&amp;b=2', 'example.org') + '.'),
    p('A mail link: ' + a('mailto:someone@example.org', 'write to someone') + '.'),
    p('A relative link: ' + a('../other/report.fodt', 'the other report') + '.'),
    p('An internal link: ' + a('#intro', 'back to the introduction') + '.'),
    p('A script link: ' + a('javascript:alert(1)', 'do not click') + '.'),
    p('A macro link: ' + a('vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document', 'run a macro') + '.'),
    p('A link with a target frame: <text:a xlink:type="simple" xlink:href="https://example.com/" office:target-frame-name="_blank" xlink:show="new">new window</text:a>.'),
]), styles='<style:style style:name="Visited_20_Internet_20_Link" style:display-name="Visited Internet Link" style:family="text"><style:text-properties fo:color="#800000" style:text-underline-style="solid"/></style:style>')

# ---------------------------------------------------------------- 06
D06_AUTO = list_style('L1', 'number') + '''
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:break-before="page"/></style:style>
<style:style style:name="P2" style:family="paragraph" style:parent-style-name="List"><style:paragraph-properties fo:break-before="page"/></style:style>
'''
D06 = doc('\n'.join([
    p('A paragraph before the quotation.'),
    p('A quotation in the Quotations style. It is indented on both sides.', 'Quotations'),
    p('A second quoted paragraph.', 'Quotations'),
    p('This paragraph starts a new page.', 'P1'),
    ul([li('Item on the second page'), li('This item starts the third page', style='P2'), li('Last item')], 'L1'),
]), auto=D06_AUTO)

# ---------------------------------------------------------------- 07
D07_FONTS = '<style:font-face style:name="DejaVu Sans Mono" svg:font-family="&apos;DejaVu Sans Mono&apos;" style:font-family-generic="modern" style:font-pitch="fixed"/>'
D07_STYLES = '''
<style:style style:name="Report_20_Base" style:display-name="Report Base" style:family="paragraph" style:parent-style-name="Text_20_body" style:class="text">
 <style:paragraph-properties fo:margin-top="0.2cm" fo:margin-bottom="0.3cm" fo:line-height="150%" fo:text-align="justify"/>
 <style:text-properties style:font-name="Liberation Sans" fo:font-size="11pt"/>
</style:style>
<style:style style:name="Report_20_Note" style:display-name="Report Note" style:family="paragraph" style:parent-style-name="Report_20_Base" style:class="text">
 <style:paragraph-properties fo:margin-left="1.5cm" fo:margin-right="0.5cm" fo:text-indent="-0.5cm" fo:line-height="0.6cm"/>
 <style:text-properties fo:color="#355269" fo:font-style="italic"/>
</style:style>
<style:style style:name="Report_20_Code" style:display-name="Report Code" style:family="paragraph" style:parent-style-name="Report_20_Note" style:class="text">
 <style:paragraph-properties fo:text-align="start" fo:background-color="#eeeeee" fo:margin-top="0.5cm" fo:margin-bottom="0.5cm"/>
 <style:text-properties style:font-name="DejaVu Sans Mono" fo:font-size="9pt" fo:font-style="normal"/>
</style:style>
<style:style style:name="Unknown_20_Font" style:display-name="Unknown Font" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
 <style:paragraph-properties fo:text-align="center" fo:margin-top="1cm"/>
 <style:text-properties fo:font-family="&apos;Comic Neue&apos;" style:font-family-generic="script" fo:font-size="16pt" fo:text-transform="uppercase"/>
</style:style>
<style:style style:name="Right_20_Aligned" style:display-name="Right Aligned" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
 <style:paragraph-properties fo:text-align="end" fo:line-height="200%"/>
</style:style>
'''
D07 = doc('\n'.join([
    p('Base: justified, one and a half line spacing, Liberation Sans 11 pt. ' + LOREM, 'Report_20_Base'),
    p('Note: inherits Base, adds indents, a hanging first line, fixed line height and italic blue. ' + LOREM, 'Report_20_Note'),
    p('Code: inherits Note, three levels down, DejaVu Sans Mono with a font-face declaration.', 'Report_20_Code'),
    p('A font with no font-face declaration', 'Unknown_20_Font'),
    p('Right aligned with double spacing.', 'Right_20_Aligned'),
    p('Centred heading text', 'Title'),
]), styles=D07_STYLES, fonts=D07_FONTS)

# ---------------------------------------------------------------- 08
D08_AUTO = '''
<style:style style:name="Table1" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
<style:style style:name="Table1.A" style:family="table-column"><style:table-column-properties style:column-width="4cm" style:rel-column-width="15420*"/></style:style>
<style:style style:name="Table1.B" style:family="table-column"><style:table-column-properties style:column-width="8cm" style:rel-column-width="30840*"/></style:style>
<style:style style:name="Table1.C" style:family="table-column"><style:table-column-properties style:column-width="5cm" style:rel-column-width="19275*"/></style:style>
<style:style style:name="Table1.A1" style:family="table-cell"><style:table-cell-properties fo:background-color="#dddddd" fo:padding="0.097cm" fo:border="0.5pt solid #000000"/></style:style>
<style:style style:name="Table1.A2" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border-left="0.5pt solid #000000" fo:border-right="none" fo:border-top="none" fo:border-bottom="0.5pt solid #000000"/></style:style>
<style:style style:name="Table1.C2" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border="1.5pt double #2a6099"/></style:style>
<style:style style:name="Table2" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
<style:style style:name="Table2.A" style:family="table-column"><style:table-column-properties style:column-width="5.667cm" style:rel-column-width="21845*"/></style:style>
<style:style style:name="Table2.A1" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border="0.5pt solid #000000"/></style:style>
'''
def cell(content, style='Table1.A2', extra=''):
    return f'<table:table-cell table:style-name="{style}" office:value-type="string"{extra}>{content}</table:table-cell>'


D08 = doc('\n'.join([
    p('A simple table with a header row:'),
    '<table:table table:name="Table1" table:style-name="Table1">'
    '<table:table-column table:style-name="Table1.A"/><table:table-column table:style-name="Table1.B"/><table:table-column table:style-name="Table1.C"/>'
    '<table:table-header-rows><table:table-row>'
    + cell(p('Name', 'Table_20_Heading'), 'Table1.A1') + cell(p('Description', 'Table_20_Heading'), 'Table1.A1') + cell(p('Amount', 'Table_20_Heading'), 'Table1.A1')
    + '</table:table-row></table:table-header-rows>'
    '<table:table-row>' + cell(p('Apples', 'Table_20_Contents')) + cell(p('Red, from the orchard', 'Table_20_Contents')) + cell(p('12', 'Table_20_Contents'), 'Table1.C2') + '</table:table-row>'
    '<table:table-row>' + cell(p('Pears', 'Table_20_Contents')) + cell(p('', 'Table_20_Contents')) + cell(p('3', 'Table_20_Contents'), 'Table1.C2') + '</table:table-row>'
    '<table:table-row>' + cell(p('Plums', 'Table_20_Contents')) + cell(p('First paragraph in the cell.', 'Table_20_Contents') + p('Second paragraph in the cell.', 'Table_20_Contents')) + cell(p('7', 'Table_20_Contents'), 'Table1.C2') + '</table:table-row>'
    '</table:table>',
    p('A table with merged cells, which phase 1 opens as opaque:'),
    '<table:table table:name="Table2" table:style-name="Table2">'
    '<table:table-column table:style-name="Table2.A" table:number-columns-repeated="3"/>'
    '<table:table-row>' + cell(p('Spans two columns', 'Table_20_Contents'), 'Table2.A1', ' table:number-columns-spanned="2"') + '<table:covered-table-cell/>' + cell(p('C1', 'Table_20_Contents'), 'Table2.A1') + '</table:table-row>'
    '<table:table-row>' + cell(p('Spans two rows', 'Table_20_Contents'), 'Table2.A1', ' table:number-rows-spanned="2"') + cell(p('B2', 'Table_20_Contents'), 'Table2.A1') + cell(p('C2', 'Table_20_Contents'), 'Table2.A1') + '</table:table-row>'
    '<table:table-row><table:covered-table-cell/>' + cell(p('B3', 'Table_20_Contents'), 'Table2.A1') + cell(p('C3', 'Table_20_Contents'), 'Table2.A1') + '</table:table-row>'
    '</table:table>',
    p('After the tables.'),
]), auto=D08_AUTO)

# ---------------------------------------------------------------- 09
D09_LAYOUTS = '''
<style:page-layout style:name="pm1">
 <style:page-layout-properties fo:page-width="21.59cm" fo:page-height="27.94cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm" style:writing-mode="lr-tb"/>
 <style:header-style><style:header-footer-properties fo:min-height="0cm" fo:margin-bottom="0.5cm"/></style:header-style>
 <style:footer-style><style:header-footer-properties fo:min-height="0cm" fo:margin-top="0.5cm"/></style:footer-style>
</style:page-layout>
<style:page-layout style:name="pm2">
 <style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="5cm" fo:margin-right="5cm" style:writing-mode="lr-tb"/>
</style:page-layout>
<style:page-layout style:name="pm3">
 <style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21.001cm" style:print-orientation="landscape" fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="1.5cm" fo:margin-right="1.5cm" style:writing-mode="lr-tb"/>
</style:page-layout>
'''
D09_MASTER = '''
<style:master-page style:name="Standard" style:page-layout-name="pm1">
 <style:header><text:p text:style-name="Header">Quarterly report</text:p></style:header>
 <style:footer><text:p text:style-name="Footer">Page <text:page-number text:select-page="current">1</text:page-number> of <text:page-count>3</text:page-count></text:p></style:footer>
</style:master-page>
<style:master-page style:name="A4_20_Wide" style:display-name="A4 Wide" style:page-layout-name="pm2"/>
<style:master-page style:name="Landscape" style:page-layout-name="pm3"/>
'''
D09_AUTO = '''
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Text_20_body" style:master-page-name="Standard"/>
<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Text_20_body" style:master-page-name="A4_20_Wide"/>
<style:style style:name="P3" style:family="paragraph" style:parent-style-name="Text_20_body" style:master-page-name="Landscape"/>
'''
D09 = doc('\n'.join([
    p('The first page is US Letter, with a header and a footer that shows the page number.', 'P1'),
    p(LOREM),
    p('This page is A4 portrait with wide margins.', 'P2'),
    p(LOREM),
    p('This page is A4 landscape.', 'P3'),
    p(LOREM),
]), auto=D09_AUTO, layouts=D09_LAYOUTS, master=D09_MASTER)

# ---------------------------------------------------------------- 10
D10_META = '''<dc:title>Everything lattice does not understand</dc:title>
<dc:subject>Round-trip corpus</dc:subject>
<meta:keyword>lattice</meta:keyword>
<meta:user-defined meta:name="Client" meta:value-type="string">ACME</meta:user-defined>
<meta:user-defined meta:name="Reviewed" meta:value-type="boolean">true</meta:user-defined>'''
D10_SETTINGS = '<config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="RecordChanges" config:type="boolean">true</config:config-item></config:config-item-set>'
D10_SCRIPTS = '''<office:scripts><office:script script:language="ooo:Basic"><ooo:libraries><ooo:library-embedded ooo:name="Standard"><ooo:module ooo:name="Module1"><ooo:source-code>REM a macro lattice must carry and never run
Sub Main
  MsgBox &quot;hello from a macro&quot;
End Sub</ooo:source-code></ooo:module></ooo:library-embedded></ooo:libraries></office:script></office:scripts>'''
D10_AUTO = '''
<style:style style:name="Sect1" style:family="section"><style:section-properties style:editable="false"><style:columns fo:column-count="1" fo:column-gap="0cm"/></style:section-properties></style:style>
<style:style style:name="Sect2" style:family="section"><style:section-properties fo:background-color="#eeeeee"><style:columns fo:column-count="2" fo:column-gap="0.5cm"/></style:section-properties></style:style>
<style:style style:name="fr1" style:family="graphic" style:parent-style-name="Frame"><style:graphic-properties style:wrap="none" style:horizontal-pos="center" style:horizontal-rel="paragraph"/></style:style>
'''
D10_TOC = '''<text:table-of-content text:style-name="Sect1" text:protected="true" text:name="Table of Contents1">
<text:table-of-content-source text:outline-level="10">
<text:index-title-template text:style-name="Contents_20_Heading">Contents</text:index-title-template>
<text:table-of-content-entry-template text:outline-level="1" text:style-name="Contents_20_1"><text:index-entry-link-start text:style-name="Index_20_Link"/><text:index-entry-chapter/><text:index-entry-text/><text:index-entry-tab-stop style:type="right" style:leader-char="."/><text:index-entry-page-number/><text:index-entry-link-end/></text:table-of-content-entry-template>
</text:table-of-content-source>
<text:index-body>
<text:index-title text:style-name="Sect1" text:name="Table of Contents1_Head"><text:p text:style-name="Contents_20_Heading">Contents</text:p></text:index-title>
<text:p text:style-name="Contents_20_1"><text:a xlink:type="simple" xlink:href="#__RefHeading___Toc1_1" text:style-name="Index_20_Link" text:visited-style-name="Index_20_Link">Notes and fields<text:tab/>1</text:a></text:p>
<text:p text:style-name="Contents_20_1"><text:a xlink:type="simple" xlink:href="#__RefHeading___Toc2_1" text:style-name="Index_20_Link" text:visited-style-name="Index_20_Link">Review<text:tab/>1</text:a></text:p>
</text:index-body>
</text:table-of-content>'''
D10_BODY = '\n'.join([
    '<text:tracked-changes text:track-changes="true">'
    '<text:changed-region xml:id="ct1" text:id="ct1"><text:insertion><office:change-info><dc:creator>Ann Author</dc:creator><dc:date>2026-01-01T10:00:00</dc:date></office:change-info></text:insertion></text:changed-region>'
    '<text:changed-region xml:id="ct2" text:id="ct2"><text:deletion><office:change-info><dc:creator>Ann Author</dc:creator><dc:date>2026-01-01T10:05:00</dc:date></office:change-info><text:p>removed words</text:p></text:deletion></text:changed-region>'
    '</text:tracked-changes>',
    '<text:user-field-decls><text:user-field-decl office:value-type="string" office:string-value="Lattice Ltd" text:name="Company"/></text:user-field-decls>',
    D10_TOC,
    h('<text:bookmark-start text:name="__RefHeading___Toc1_1"/>Notes and fields<text:bookmark-end text:name="__RefHeading___Toc1_1"/>', 1),
    p('A footnote here<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p text:style-name="Footnote">The footnote text.</text:p></text:note-body></text:note> and an endnote here<text:note text:id="ftn2" text:note-class="endnote"><text:note-citation>i</text:note-citation><text:note-body><text:p text:style-name="Endnote">The endnote text.</text:p></text:note-body></text:note>.'),
    p('<text:bookmark-start text:name="span"/>A bookmark starts in this paragraph'),
    p('and ends in this one.<text:bookmark-end text:name="span"/> A <text:reference-mark-start text:name="ref1"/>reference mark<text:reference-mark-end text:name="ref1"/> too.'),
    p('Fields: date <text:date style:data-style-name="N37" text:date-value="2026-11-01" text:fixed="true">11/01/26</text:date>, pages <text:page-count>2</text:page-count>, company <text:user-field-get text:name="Company">Lattice Ltd</text:user-field-get>, see page <text:bookmark-ref text:reference-format="page" text:ref-name="span">1</text:bookmark-ref>, title <text:title>Everything lattice does not understand</text:title>.'),
    p('Inline metadata: <text:meta xml:id="meta1">an annotated phrase</text:meta>.'),
    '<text:section text:style-name="Sect2" text:name="TwoColumns">' + p('A section with two columns. ' + LOREM) + '</text:section>',
    '<text:section text:style-name="Sect1" text:name="Linked1"><text:section-source xlink:href="linked-source.fodt" xlink:type="simple" text:filter-name="OpenDocument Text Flat XML"/>' + p('The cached content of a linked section.') + '</text:section>',
    h('<text:bookmark-start text:name="__RefHeading___Toc2_1"/>Review<text:bookmark-end text:name="__RefHeading___Toc2_1"/>', 1),
    p('An <text:change-start text:change-id="ct1"/>inserted<text:change-end text:change-id="ct1"/> word and a deletion<text:change text:change-id="ct2"/> here.'),
    p('<office:annotation office:name="__Annotation__1"><dc:creator>Bob Reviewer</dc:creator><dc:date>2026-01-02T09:00:00</dc:date><text:p>Is this right?</text:p></office:annotation>This range has a comment<office:annotation-end office:name="__Annotation__1"/> and <office:annotation><dc:creator>Bob Reviewer</dc:creator><dc:date>2026-01-02T09:01:00</dc:date><text:p>A point comment.</text:p></office:annotation>this one has a point comment.'),
    p('<draw:frame draw:style-name="fr1" draw:name="Frame1" text:anchor-type="paragraph" svg:width="6cm" draw:z-index="0"><draw:text-box fo:min-height="1cm"><text:p text:style-name="Frame_20_contents">Text in a frame.</text:p></draw:text-box></draw:frame>A paragraph that anchors a text frame.'),
])
D10_STYLES = '''
<style:style style:name="Index_20_Link" style:display-name="Index Link" style:family="text"/>
<number:date-style style:name="N37" number:automatic-order="true"><number:month number:style="long"/><number:text>/</number:text><number:day number:style="long"/><number:text>/</number:text><number:year/></number:date-style>
<text:notes-configuration text:note-class="footnote" text:citation-style-name="Footnote_20_Symbol" text:citation-body-style-name="Footnote_20_anchor" style:num-format="1" text:start-value="0" text:footnotes-position="page" text:start-numbering-at="document"/>
<text:notes-configuration text:note-class="endnote" text:citation-style-name="Endnote_20_Symbol" text:citation-body-style-name="Endnote_20_anchor" text:master-page-name="Endnote" style:num-format="i" text:start-value="0"/>
'''
D10_MASTER = MASTER + '<style:master-page style:name="Endnote" style:page-layout-name="pm1"/>'
D10 = doc(D10_BODY, auto=D10_AUTO, styles=D10_STYLES, meta=D10_META, settings=D10_SETTINGS,
          scripts=D10_SCRIPTS, master=D10_MASTER)

# ---------------------------------------------------------------- 11
D11_FONTS = '''
<style:font-face style:name="Noto Sans CJK SC" svg:font-family="&apos;Noto Sans CJK SC&apos;" style:font-family-generic="system" style:font-pitch="variable"/>
<style:font-face style:name="Noto Naskh Arabic" svg:font-family="&apos;Noto Naskh Arabic&apos;" style:font-family-generic="system" style:font-pitch="variable"/>
'''
D11_AUTO = '''
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:text-align="end" style:writing-mode="rl-tb"/><style:text-properties style:font-name-complex="Noto Naskh Arabic" style:language-complex="ar" style:country-complex="EG"/></style:style>
<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:text-align="end" style:writing-mode="rl-tb"/><style:text-properties style:language-complex="he" style:country-complex="IL"/></style:style>
<style:style style:name="P3" style:family="paragraph" style:parent-style-name="Text_20_body"><style:text-properties style:font-name-asian="Noto Sans CJK SC" style:language-asian="zh" style:country-asian="CN"/></style:style>
<style:style style:name="T1" style:family="text"><style:text-properties style:font-name-asian="Noto Sans CJK SC" style:language-asian="ja" style:country-asian="JP"/></style:style>
'''
D11 = doc('\n'.join([
    p('مرحبا بالعالم. هذه فقرة باللغة العربية تكتب من اليمين إلى اليسار.', 'P1'),
    p('שלום עולם. זו פסקה בעברית שנכתבת מימין לשמאל.', 'P2'),
    p('你好，世界。这是一个中文段落。', 'P3'),
    p('Mixed: English, then <text:span text:style-name="T1">日本語のテキスト</text:span>, then English again.'),
    p('Emoji: 🎉 🧪 👩🏽‍💻 and a flag 🇳🇿.'),
    p('Combining marks: é (e plus acute), ñ, ǟ, Ź̵.'),
    p('A soft hyphen in extra­ordinarily and super­califragilistic.'),
]), auto=D11_AUTO, fonts=D11_FONTS)

# ---------------------------------------------------------------- 12
D12 = doc('\n'.join([
    p('Two  spaces, three<text:s text:c="2"/>spaces, and ten<text:s text:c="9"/>spaces.'),
    p('<text:s/>A leading space.'),
    p('<text:s text:c="4"/>Four leading spaces.'),
    p('A trailing space. '),
    p('Tab<text:tab/>separated<text:tab/><text:tab/>values.'),
    p('<text:tab/>A leading tab.'),
    p('Line one<text:line-break/>line two<text:line-break/><text:line-break/>line four after an empty line.'),
    p('Non breaking spaces and a narrow one.'),
    p('Mixed <text:tab/> <text:s text:c="2"/> whitespace.'),
]))

# ---------------------------------------------------------------- 13
def d13():
    rng = 0
    parts = [p('A long document for performance', 'Title')]
    words = LOREM.split()
    for ch in range(1, 91):
        parts.append(h(f'Chapter {ch}', 1))
        for sec in range(1, 4):
            parts.append(h(f'Section {ch}.{sec}', 2))
            for k in range(6):
                rng = (rng * 1103515245 + 12345) % (2 ** 31)
                w = words[rng % len(words)]
                parts.append(p(f'Paragraph {k + 1} of section {ch}.{sec}. {LOREM} '
                               f'<text:span text:style-name="T1">{w}</text:span> and '
                               f'<text:span text:style-name="T2">{words[(rng >> 8) % len(words)]}</text:span>. {LOREM}'))
            parts.append(ul([li(f'Point {i} of {ch}.{sec}') for i in range(1, 4)], 'L1'))
        parts.append('<table:table table:name="T%d" table:style-name="Table1"><table:table-column table:number-columns-repeated="3"/>' % ch
                     + ''.join('<table:table-row>' + ''.join(cell(p(f'r{r} c{c}', 'Table_20_Contents'), 'Table1.A1') for c in range(3)) + '</table:table-row>' for r in range(4))
                     + '</table:table>')
    return '\n'.join(parts)


D13_AUTO = list_style('L1', 'bullet') + '''
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Table1" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
<style:style style:name="Table1.A1" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border="0.5pt solid #000000"/></style:style>
'''
D13 = doc(d13(), auto=D13_AUTO)

DOCS = {
    '01-paragraphs': D01, '02-headings': D02, '03-inline': D03, '04-lists': D04,
    '05-links': D05, '06-quote-break': D06, '07-styles': D07, '08-tables': D08,
    '09-layout': D09, '10-unknown': D10, '11-i18n': D11, '12-whitespace': D12,
    '13-large': D13,
}


def soffice():
    for c in ('soffice', 'libreoffice'):
        if shutil.which(c):
            return shutil.which(c)
    sys.exit('make-corpus: soffice is not on PATH')


def convert(exe, profile, fmt, outdir, files):
    subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--headless', '--norestore',
                    '--convert-to', fmt, '--outdir', outdir, *files],
                   check=True, stdout=subprocess.DEVNULL, timeout=900)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--keep-src', help='also write the hand-built sources here')
    ap.add_argument('--only', help='comma-separated names, e.g. 03-inline')
    args = ap.parse_args()
    names = args.only.split(',') if args.only else list(DOCS)
    exe = soffice()
    with tempfile.TemporaryDirectory(prefix='latcorpus-') as tmp:
        src = os.path.join(tmp, 'src')
        os.makedirs(src)
        files = []
        for n in names:
            f = os.path.join(src, n + '.fodt')
            with open(f, 'w', encoding='utf-8') as fh:
                fh.write(DOCS[n])
            files.append(f)
        if args.keep_src:
            os.makedirs(args.keep_src, exist_ok=True)
            for f in files:
                shutil.copy(f, args.keep_src)
        profile = os.path.join(tmp, 'profile')
        fo, oo = os.path.join(tmp, 'fodt'), os.path.join(tmp, 'odt')
        #  LibreOffice fills in defaults over its first few saves of a
        #  hand-built source (style:writing-mode on the default graphic
        #  style on the second, draw:fill-color on the Frame style on the
        #  third). Re-save until a save canonicalizes equal to the one
        #  before, so the corpus is what LibreOffice writes from then on.
        prev = None
        for gen in range(1, 7):
            gdir = os.path.join(tmp, f'gen{gen}')
            convert(exe, profile, 'fodt:OpenDocument Text Flat XML', gdir, files)
            files = [os.path.join(gdir, n + '.fodt') for n in names]
            cur = [canonicalize(open(f, 'rb').read()) for f in files]
            if cur == prev:
                break
            prev = cur
        else:
            sys.exit('make-corpus: LibreOffice saves did not settle after 6 generations')
        print(f'make-corpus: LibreOffice output settled at generation {gen}')
        shutil.copytree(gdir, fo)
        convert(exe, profile, 'odt:writer8', oo, files)
        os.makedirs(args.out, exist_ok=True)
        for n in names:
            for d, ext in ((fo, '.fodt'), (oo, '.odt')):
                got = os.path.join(d, n + ext)
                if not os.path.exists(got):
                    sys.exit(f'make-corpus: LibreOffice did not write {n}{ext}')
                shutil.copy(got, os.path.join(args.out, n + ext))
        ver = subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--version'],
                             capture_output=True, text=True, timeout=120).stdout.strip()
    with open(os.path.join(args.out, 'VERSION'), 'w') as fh:
        fh.write(ver + '\n')
    print(f'make-corpus: wrote {len(names)} documents with {ver}')


if __name__ == '__main__':
    main()
