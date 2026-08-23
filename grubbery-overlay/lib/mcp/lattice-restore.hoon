/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-restore'
++  description  'Undo a soft-delete.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Entry key']]
  ==
++  required  ~['key']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  raw=(unit @t)  (arg:lm args.st /key)
  ?~  raw  (pure:m [%error 'missing or invalid: key'])
  =/  key=@t  u.raw
  =/  kp=(unit path)  (parse-key:lm key)
  ?~  kp  (pure:m [%error 'invalid key'])
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  ?:  (~(has by es) u.kp)  (pure:m [%error (crip "{(trip key)} already exists")])
  =/  vr=vrail:lk  (key-to-rail:lk (weld base:lm /know/trash-vault) u.kp)
  ;<  tseen=view:nexus  bind:m  (peek:io [%& %& pax.vr nom.vr] ~)
  ?.  ?=([%file *] tseen)  (pure:m [%error (crip "not deleted: {(trip key)}")])
  ?:  (is-boom:tarball sang.tseen)
    (pure:m [%error (crip "not deleted: {(trip key)}")])
  ;<  ~  bind:m  (poke-writer:lm [%restore key])
  (pure:m [%text (crip "restored {(trip key)}")])
--
