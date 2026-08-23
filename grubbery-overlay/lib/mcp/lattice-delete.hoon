/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-delete'
++  description  'Soft-delete an entry (recoverable via lattice-restore).'
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
  ::  the peek below and the poke further down are separate binds in this
  ::  fiber, so the ship's event loop can run other writer pokes between
  ::  them. A concurrent delete of key, landing in that gap, can make this
  ::  check stale: it could already be gone by the time poke-writer fires.
  ::  The %del writer re-checks (?~ old) at write time and no-ops rather
  ::  than crash on a missing grub. A raced call costs a stale "deleted"
  ::  reply on a write that quietly skipped, never a wrong delete. Truthful
  ::  except for a race beats the old answer, which lied on every no-op,
  ::  so the pre-check stays as is.
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  ?.  (~(has by es) u.kp)  (pure:m [%error (crip "no entry {(trip key)}")])
  ;<  ~  bind:m  (poke-writer:lm [%del key])
  (pure:m [%text (crip "deleted {(trip key)}")])
--
