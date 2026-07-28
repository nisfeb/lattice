/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-tags'
++  description  'The tag vocabulary with usage counts. Call before tagging to reuse existing tags.'
++  parameters  ^-  (map @t parameter-def:tools)  ~
++  required  ~
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  ::  flatten every entry's tags into ONE list, then count in a single roll.
  ::  The nested-roll version this replaces was wrong: +roll always starts from
  ::  the BUNT of its accumulator, so the inner roll discarded the outer one and
  ::  the vocabulary only ever reflected the last entry iterated. It looked
  ::  correct whenever the vault held a single tagged entry, and returned {} the
  ::  moment an untagged entry sorted last. Same shape as +know-tags-json, the
  ::  HTTP twin, which was always right.
  =/  all=(list @t)  (zing (turn ~(val by es) |=(e=know-entry:lk ~(tap in tags.e))))
  =/  counts=(map @t @ud)
    %+  roll  all
    |=  [t=@t acc=(map @t @ud)]
    (~(put by acc) t +((~(gut by acc) t 0)))
  =/  jon=json
    [%o (~(run by counts) |=(n=@ud (numb:enjs:format n)))]
  (pure:m [%text (en:json:html jon)])
--
