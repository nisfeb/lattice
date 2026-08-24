/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-move'
++  description  'Rename an entry key. History stays behind under the old key and becomes unreachable.'
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
  =/  kp=(unit path)  (parse-key:lm key)
  ?~  kp  (pure:m [%error 'invalid key'])
  =/  tp=(unit path)  (parse-key:lm to)
  ?~  tp  (pure:m [%error 'invalid key'])
  ::  the peek below and the poke further down are separate binds in this
  ::  fiber, so the ship's event loop can run other writer pokes between
  ::  them. A concurrent move, delete, or restore of key or to, landing in
  ::  that gap, can make this check stale: the source could vanish, or to
  ::  could go live, before poke-writer fires. The %move writer re-checks
  ::  both (?~ old, ?^ liv) at write time and no-ops rather than clobber.
  ::  A raced call costs a stale "moved" reply on a write that quietly
  ::  skipped. It never moves the wrong thing. Truthful except for a race
  ::  beats the old answer, which lied on every no-op, so the pre-check
  ::  stays as is.
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  ?.  (~(has by es) u.kp)  (pure:m [%error (crip "no entry {(trip key)}")])
  ?:  (~(has by es) u.tp)  (pure:m [%error (crip "{(trip to)} already exists")])
  ;<  ~  bind:m  (poke-writer:lm [%move key to])
  (pure:m [%text (crip "moved {(trip key)} -> {(trip to)}")])
--
