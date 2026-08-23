/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-save'
++  description  'Create or overwrite a knowledge entry. Re-saving a deleted key restores it.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Entry key, e.g. "user/ai-models"']]
      ['body' [%string 'Entry body text']]
  ==
++  required  ~['key' 'body']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  ra=(unit @t)  (arg:lm args.st /key)
  =/  rb=(unit @t)  (arg:lm args.st /body)
  ?.  &(?=(^ ra) ?=(^ rb))
    (pure:m [%error 'missing or invalid arguments (key, body)'])
  =/  [key=@t body=@t]  [u.ra u.rb]
  =/  kp=(unit path)  (parse-key:lm key)
  ?~  kp  (pure:m [%error 'invalid key'])
  ?:  =('' body)  (pure:m [%error 'empty body'])
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  =/  existed=?  (~(has by es) u.kp)
  ;<  ~  bind:m  (poke-writer:lm [%save key body])
  ?:  existed
    (pure:m [%text (crip "updated {(trip key)}")])
  (pure:m [%text (crip "created {(trip key)}")])
--
