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
  =/  counts=(map @t @ud)
    %+  roll  ~(tap by es)
    |=  [[kp=path e=know-entry:lk] acc=(map @t @ud)]
    %+  roll  ~(tap in tags.e)
    |=  [t=@t a=(map @t @ud)]
    (~(put by a) t +((~(gut by a) t 0)))
  =/  jon=json
    [%o (~(run by counts) |=(n=@ud (numb:enjs:format n)))]
  (pure:m [%text (en:json:html jon)])
--
