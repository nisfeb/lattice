/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-tag'
++  description  'Add a cross-cutting tag to an entry.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Entry key']]
      ['tag' [%string 'Tag to add']]
  ==
++  required  ~['key' 'tag']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  ra=(unit @t)  (arg:lm args.st /key)
  =/  rb=(unit @t)  (arg:lm args.st /tag)
  ?.  &(?=(^ ra) ?=(^ rb))
    (pure:m [%error 'missing or invalid arguments (key, tag)'])
  =/  [key=@t tag=@t]  [u.ra u.rb]
  ?~  (parse-key:lm key)  (pure:m [%error 'invalid key'])
  ;<  ~  bind:m  (poke-writer:lm [%tag key tag])
  (pure:m [%text (crip "tagged {(trip key)} +{(trip tag)}")])
--
