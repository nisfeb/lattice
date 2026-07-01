::  Minimal obelisk result types — the subset the lattice nexus needs to read
::  %obelisk query results off its /server fact. The full sur/obelisk-ast.hoon is
::  ~1200 lines of urQL AST; we only mold cmd-result -> rows. `dime` is a base
::  type ([p=@ta q=@]). Mirror obelisk's sur/obelisk-ast.hoon result section — if
::  obelisk's result shape changes, follow it here.
::
|%
+$  cmd-result  [%results (list result)]
+$  result
  $%  [%action action=@t]
      [%relation relation=@t]
      [%message msg=@t]
      [%vector-count count=@ud]
      [%server-time date=@da]
      [%security-time date=@da]
      [%schema-time date=@da]
      [%data-time date=@da]
      [%result-set set=(list vector)]
  ==
+$  vector-cell  [p=@tas q=dime]
+$  vector  [%vector (lest vector-cell)]
::  obk-req: a serialized obelisk-query request poked at the obelisk owner fiber
::  (/cat/obelisk.sig). The owner runs the query against its single /server sub
::  (one at a time — no cross-caller result contamination), then writes the result
::  to the caller's result grub named by the absolute rail [res-pax res-nom],
::  firing the caller's keep-wave. All base types so the mark stays grubbery-free.
+$  obk-req  [db=@tas urql=tape res-pax=path res-nom=@ta]
--
