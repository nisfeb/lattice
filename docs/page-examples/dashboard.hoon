::  dashboard — composition. Embeds the rendered VIEWS of other pages (clock and
::  counter) in a layout. `view-of` makes a view-dependency: this page re-renders
::  whenever an embedded page changes, and each rendered view arrives in `deps`
::  (pulled out by `shown`). Own pages only — a peer's markup is never embedded.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
%+  needs
  %-  html  %-  crip
  ;:  weld
    "<div style=\"display:grid;gap:12px;max-width:32rem\">"
    "<section><h3>clock</h3>"    (trip (shown deps %clock))    "</section>"
    "<section><h3>counter</h3>"  (trip (shown deps %counter))  "</section>"
    "</div>"
  ==
~[(view-of %clock) (view-of %counter)]
