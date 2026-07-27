/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-move'
++  description  'Rename an entry key, history preserved.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Current key']]
      ['to' [%string 'New key']]
  ==
++  required  ~['key' 'to']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  parsed=(each [@t @t] tang)
    %-  mule  |.
    :-  (~(dog jo:json-utils [%o args.st]) /key so:dejs:format)
    (~(dog jo:json-utils [%o args.st]) /to so:dejs:format)
  ?:  ?=(%| -.parsed)
    (pure:m [%error 'missing or invalid arguments (key, to)'])
  =/  [key=@t to=@t]  p.parsed
  ?~  (parse-key:lm key)  (pure:m [%error 'invalid key'])
  ;<  ~  bind:m  (poke-writer:lm [%move key to])
  (pure:m [%text (crip "moved {(trip key)} -> {(trip to)}")])
--
