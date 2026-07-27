/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-read'
++  description  'Read one knowledge entry: body, tags, updated time.'
++  parameters
  ^-  (map @t parameter-def:tools)
  %-  ~(gas by *(map @t parameter-def:tools))
  :~  ['key' [%string 'Entry key, e.g. "user/ai-models"']]
  ==
++  required  ~['key']
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  st=tool-state:tools  bind:m  (get-state-as:io ,tool-state:tools)
  =/  parsed=(each @t tang)
    %-  mule  |.
    (~(dog jo:json-utils [%o args.st]) /key so:dejs:format)
  ?:  ?=(%| -.parsed)
    (pure:m [%error 'missing or invalid: key'])
  =/  key=@t  p.parsed
  =/  kp=(unit path)  (parse-key:lm key)
  ?~  kp  (pure:m [%error 'invalid key'])
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  =/  e=(unit know-entry:lk)  (~(get by es) u.kp)
  ?~  e  (pure:m [%error 'not found'])
  (pure:m [%text (en:json:html (entry-json:lm u.kp u.e))])
--
