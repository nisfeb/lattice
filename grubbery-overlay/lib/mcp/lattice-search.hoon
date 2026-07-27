/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-search'
++  description  'Case-insensitive substring search across entry keys and bodies.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['query' [%string 'Substring to search for']]
  ==
++  required  ~['query']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  parsed=(each @t tang)
    %-  mule  |.
    (~(dog jo:json-utils [%o args.st]) /query so:dejs:format)
  ?:  ?=(%| -.parsed)
    (pure:m [%error 'missing or invalid: query'])
  =/  query=@t  p.parsed
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  =/  hits=(map path know-entry:lk)
    %-  ~(gas by *(map path know-entry:lk))
    %+  skim  ~(tap by es)
    |=  [kp=path e=know-entry:lk]
    ?|  (has-sub:lm query (spat kp))
        (has-sub:lm query body.e)
    ==
  (pure:m [%text (en:json:html (list-json:lm hits))])
--
