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
  =/  ra=(unit @t)  (arg:lm args.st /key)
  =/  rb=(unit @t)  (arg:lm args.st /tag)
  ?.  &(?=(^ ra) ?=(^ rb))
    (pure:m [%error 'missing or invalid arguments (key, tag)'])
  =/  [key=@t tag=@t]  [u.ra u.rb]
  =/  kp=(unit path)  (parse-key:lm key)
  ?~  kp  (pure:m [%error 'invalid key'])
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  =/  e=(unit know-entry:lk)  (~(get by es) u.kp)
  ?~  e  (pure:m [%error (crip "no entry {(trip key)}")])
  ?.  |((~(has in tags.u.e) tag) (~(has in tags.u.e) (low:lm tag)))
    (pure:m [%error (crip "no tag {(trip tag)} on {(trip key)}")])
  ;<  ~  bind:m  (poke-writer:lm [%untag key tag])
  (pure:m [%text (crip "untagged {(trip key)} -{(trip tag)}")])
--
