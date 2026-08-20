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
  =/  ra=(unit @t)  (arg:lm args.st /key)
  =/  rb=(unit @t)  (arg:lm args.st /to)
  ?.  &(?=(^ ra) ?=(^ rb))
    (pure:m [%error 'missing or invalid arguments (key, to)'])
  =/  [key=@t to=@t]  [u.ra u.rb]
  ?~  (parse-key:lm key)  (pure:m [%error 'invalid key'])
  ;<  ~  bind:m  (poke-writer:lm [%move key to])
  (pure:m [%text (crip "moved {(trip key)} -> {(trip to)}")])
--
