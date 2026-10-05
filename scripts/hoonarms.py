"""hoonarms.py: how depth-check.py and weir-check.py read Hoon source.

Each kept its own arm splitter and comment stripper, and they disagreed.
weir-check cut every line at its first `::`, so a `::` inside a cord (a CSS
selector like `::-webkit-scrollbar`) dropped the rest of that line. The
rule here finds strings BEFORE it looks for a comment, as depth-check did.
"""
import re

_CORD = re.compile(r"'[^']*'")
_TAPE = re.compile(r'"[^"]*"')
_ARM = re.compile(r'^\+\+  ([a-z][a-z0-9-]*)')


def _comment_at(line):
    """where the line's :: comment starts, or -1. Cords and tapes are
    blanked to spaces first, so the offsets still index the real line."""
    fill = lambda m: m.group()[0] + ' ' * (len(m.group()) - 2) + m.group()[0]
    return _TAPE.sub(fill, _CORD.sub(fill, line)).find('::')


def code(line):
    """the line with its comment cut and its cords and tapes emptied, so
    neither prose nor string text can read as a call"""
    i = _comment_at(line)
    line = line[:i] if i >= 0 else line
    return _TAPE.sub('""', _CORD.sub("''", line))


def uncomment(text):
    """every line of `text` with its comment cut, strings kept whole: the
    roads weir-check looks for are spelled in cords"""
    out = []
    for line in text.split('\n'):
        i = _comment_at(line)
        out.append(line[:i] if i >= 0 else line)
    return '\n'.join(out)


def arms(lines):
    """arm name -> its lines, the `++  name` line first. A name defined
    twice keeps its last body, and lines before the first arm belong to none."""
    out, cur = {}, None
    for line in lines:
        m = _ARM.match(line)
        if m:
            cur = m.group(1)
            out[cur] = []
        if cur is not None:
            out[cur].append(line)
    return out


if __name__ == '__main__':
    assert code("(foo 'a::b')  ::  (bar)") == "(foo '')  "
    assert code('"it\'s" :: x') == '"" '
    assert uncomment("[%& %& /sys %'a::b']  ::  note\n++  x") == "[%& %& /sys %'a::b']  \n++  x"
    assert uncomment(':root::-webkit {}') == ':root'
    a = arms(['junk', '++  one  1', '  body', '++  two', '++  one', '  last'])
    assert a == {'one': ['++  one', '  last'], 'two': ['++  two']}, a
    print('hoonarms ok')
