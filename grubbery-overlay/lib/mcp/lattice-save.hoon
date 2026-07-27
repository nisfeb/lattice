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
  =/  parsed=(each [@t @t] tang)
    %-  mule  |.
    :-  (~(dog jo:json-utils [%o args.st]) /key so:dejs:format)
    (~(dog jo:json-utils [%o args.st]) /body so:dejs:format)
  ?:  ?=(%| -.parsed)
    (pure:m [%error 'missing or invalid arguments (key, body)'])
  =/  [key=@t body=@t]  p.parsed
  ?~  (parse-key:lm key)  (pure:m [%error 'invalid key'])
  ?:  =('' body)  (pure:m [%error 'empty body'])
  ;<  ~  bind:m  (poke-writer:lm [%save key body])
  (pure:m [%text (crip "saved {(trip key)}")])
--
