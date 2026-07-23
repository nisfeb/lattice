::  markdown — a page whose content is markdown, rendered to HTML. `md` covers
::  notes and docs: # headings, **bold**, *italic*, `code`, - lists, > quotes,
::  [links](url), and ``` fenced code. Content is escaped, so it is safe to
::  render (raw HTML in the source shows as text; only safe link schemes link).
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
%-  md
'''
# My Note

Some **bold** and *italic* text, `inline code`, and a
[link](https://urbit.org).

- a list item
- another one

> a blockquote
'''
