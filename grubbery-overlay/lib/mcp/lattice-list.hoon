/<  tools  /lib/nex/tools.hoon
/<  lm  /lib/lattice-mcp.hoon
/<  lk  /lib/lattice-know.hoon
!:
^-  tool:tools
|%
++  name  'lattice-list'
++  description  'List all knowledge entries: keys, tags and metadata, no bodies. Cheap index call.'
++  parameters  ^-  (map @t parameter-def:tools)  ~
++  required  ~
++  handler
  ^-  tool-handler:tools
  =/  m  (fiber:fiber:nexus ,tool-result:tools)
  ^-  form:m
  ;<  es=(map path know-entry:lk)  bind:m  read-vault:lm
  (pure:m [%text (en:json:html (list-json:lm es))])
--
