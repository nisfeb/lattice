/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-untag'
++  description  'Remove a tag from an entry.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Entry key']]
      ['tag' [%string 'Tag to remove']]
  ==
++  required  ~['key' 'tag']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  parsed=(each [@t @t] tang)
    %-  mule  |.
    :-  (~(dog jo:json-utils [%o args.st]) /key so:dejs:format)
    (~(dog jo:json-utils [%o args.st]) /tag so:dejs:format)
  ?:  ?=(%| -.parsed)
    (pure:m [%error 'missing or invalid arguments (key, tag)'])
  =/  [key=@t tag=@t]  p.parsed
  ?~  (parse-key:lm key)  (pure:m [%error 'invalid key'])
  ;<  ~  bind:m  (poke-writer:lm [%untag key tag])
  (pure:m [%text (crip "untagged {(trip key)} -{(trip tag)}")])
--
