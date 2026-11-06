::  /lib/lattice-skills: the shared skill store (docs/agent-knowledge.md,
::  Skills). A skill is a named procedure in Anthropic's Agent Skills
::  format: SKILL.md (front matter name and description, then a markdown
::  body) plus optional reference files. Text only: md, txt, json and yaml.
::  Nothing here runs, so a skill is as safe to share as a memory.
::
::  One grub per skill, /skills/vault/<name>/skill, so a skill's files move,
::  trash and keep history together. Provenance (author, source, created,
::  verified, sensitive, superseded-by) lives in SKILL.md's front matter, as
::  memory's does, beside the name and description an agent reads.
::
::  Pure, base types only, like lattice-know, so it is unit-tested on a
::  plain desk.
::
/<  lk  /lib/lattice-know.hoon
|%
+$  skill
  $:  body=@t                 ::  SKILL.md
      files=(map @t @t)       ::  relative path to text
      updated=@da
      tags=(set @t)
  ==
::  the writer's actions. %save puts one file (SKILL.md sets the body), and
::  a new skill starts with SKILL.md. %drop removes one file.
+$  skill-action
  $%  [%save name=@t path=@t body=@t when=@da]
      [%drop name=@t path=@t]
      [%del name=@t]
      [%restore name=@t]
      [%tag name=@t tag=@t]
      [%untag name=@t tag=@t]
  ==
++  main-file  'SKILL.md'
++  skill-leaf  `@ta`%skill
::  +max-files, +max-desc: a skill's extra files, and the description's
::  bytes. Agent Skills caps the description at 1,024 characters.
++  max-files  64
++  max-desc   1.024
++  max-path   200
::  ==  names and paths
::
::  +name-ok: Agent Skills' rule. Lower-case letters, digits and single
::  hyphens, 1 to 64, not starting or ending with a hyphen. A valid name is
::  a valid @ta, so it is one path segment and cannot climb out.
++  name-ok
  |=  n=@t
  ^-  ?
  =/  t=tape  (trip n)
  ?~  t  |
  ?:  (gth (lent t) 64)  |
  ?:  =('-' i.t)  |
  ?:  =('-' (rear `tape`t))  |
  =/  dd=(unit @ud)  (find "--" `tape`t)
  ?.  =(~ dd)  |
  %+  levy  `tape`t
  |=  c=@t
  ?|  &((gte c 'a') (lte c 'z'))
      &((gte c '0') (lte c '9'))
      =('-' c)
  ==
::  +path-ok: a file inside a skill. Relative, segments of letters, digits,
::  `.`, `-` and `_`, none empty, `.` or `..`, and an allowed extension.
::  So a path never leaves its skill, and never names code.
++  path-ok
  |=  p=@t
  ^-  ?
  =/  t=tape  (trip p)
  ?:  |(=(~ t) (gth (lent t) max-path))  |
  =/  segs=(list tape)  (split t '/')
  ?.  (levy segs seg-ok)  |
  (ext-ok (rear segs))
++  seg-ok
  |=  s=tape
  ^-  ?
  =/  c=@t  (crip s)
  ?:  |(=('' c) =('.' c) =('..' c))  |
  %+  levy  s
  |=  c=@t
  ?|  &((gte c 'a') (lte c 'z'))
      &((gte c 'A') (lte c 'Z'))
      &((gte c '0') (lte c '9'))
      =('-' c)  =('_' c)  =('.' c)
  ==
::  +ext-ok: the text kinds a skill may carry. Matched lower-cased, so
::  NOTES.MD passes and notes.md.js does not.
++  ext-ok
  |=  leaf=tape
  ^-  ?
  =/  d=(unit @ud)  (find "." (flop leaf))
  ?~  d  |
  =/  ext=tape  (cass (flop (scag u.d (flop leaf))))
  (~(has in (silt `(list tape)`~["md" "txt" "json" "yaml" "yml"])) ext)
++  split
  |=  [t=tape c=@t]
  ^-  (list tape)
  =|  cur=tape
  =|  out=(list tape)
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) out])
  ?:  =(c i.t)  $(t t.t, out [(flop cur) out], cur ~)
  $(t t.t, cur [i.t cur])
::  ==  front matter
::
::  SKILL.md's front matter is YAML, and Claude Code reads it as YAML. So
::  edits here keep every line they do not set: a block description, a
::  list of allowed tools, comments. Only top-level `key: value` lines are
::  read or written.
::
::  +fm: the front matter's lines and the text after it. ~ lines when
::  there is no front matter.
++  fm
  |=  body=@t
  ^-  [has=? lines=(list @t) rest=@t]
  =/  t=tape  (trip body)
  ?.  =("---\0a" (scag 4 t))  [| ~ body]
  =/  aft=tape  (slag 4 t)
  ?:  =("---" (scag 3 aft))
    =/  tal=tape  (slag 3 aft)
    [& ~ (crip ?.(&(?=(^ tal) =(10 i.tal)) tal t.tal))]
  =/  e=(unit @ud)  (find "\0a---" aft)
  ?~  e  [| ~ body]
  =/  tail=tape  (slag (add u.e 4) aft)
  =?  tail  &(?=(^ tail) =(10 i.tail))  t.tail
  [& (to-wain:format (crip (scag u.e aft))) (crip tail)]
++  un-fm
  |=  [lines=(list @t) rest=@t]
  ^-  @t
  =/  ls=tape  (zing (turn lines |=(l=@t (weld (trip l) "\0a"))))
  (crip :(weld "---\0a" ls "---\0a" (trip rest)))
::  +top-key: the key of a top-level `key: ...` line, or ~
++  top-key
  |=  l=@t
  ^-  (unit @t)
  =/  t=tape  (trip l)
  ?~  t  ~
  ?:  |(=(' ' i.t) =('\09' i.t) =('#' i.t) =('-' i.t))  ~
  =/  tt=tape  t
  =/  c=(unit @ud)  (find ":" tt)
  ?~  c  ~
  `(crip (trim-sp:lk (scag u.c tt)))
++  after-colon
  |=  l=@t
  ^-  @t
  =/  t=tape  (trip l)
  =/  c=(unit @ud)  (find ":" t)
  ?~  c  ''
  (crip (trim-sp:lk (slag +(u.c) t)))
::  +fm-get: a top-level value. A quoted value is unquoted; a block scalar
::  (`>` or `|`, with any chomping mark) joins its indented lines, folded
::  with spaces for `>` and newlines for `|`.
++  fm-get
  |=  [lines=(list @t) k=@t]
  ^-  (unit @t)
  |-  ^-  (unit @t)
  ?~  lines  ~
  ?.  =(`k (top-key i.lines))  $(lines t.lines)
  =/  v=@t  (after-colon i.lines)
  =/  vt=tape  (trip v)
  ?:  ?=([?(%'>' %'|') *] vt)
    =/  more=(list @t)
      =|  acc=(list @t)
      =/  ls  t.lines
      |-  ^-  (list @t)
      ?~  ls  (flop acc)
      =/  lt=tape  (trip i.ls)
      ?~  lt  $(ls t.ls, acc ['' acc])
      ?.  |(=(' ' i.lt) =('\09' i.lt))  (flop acc)
      $(ls t.ls, acc [(crip (trim-sp:lk lt)) acc])
    =/  kept=(list @t)  (skip more |=(a=@t =('' a)))
    =/  sep=tape  ?:(=('>' -.vt) " " "\0a")
    =/  parts=(list tape)  (turn kept trip)
    `(crip (zing `(list tape)`(join sep parts)))
  `(unquote v)
++  unquote
  |=  v=@t
  ^-  @t
  =/  t=tape  (trip v)
  ?.  (gte (lent t) 2)  v
  =/  q=@t  -.t
  ?.  &(|(=('"' q) =('\'' q)) =(q (rear t)))  v
  (crip (snip (slag 1 t)))
::  +fm-put: set a top-level value in place, or add it before the closing
::  line. '' removes the line. Only for the single-line provenance fields.
++  fm-put
  |=  [lines=(list @t) k=@t v=@t]
  ^-  (list @t)
  =/  has=?  (lien lines |=(l=@t =(`k (top-key l))))
  ?:  =('' v)  (skip lines |=(l=@t =(`k (top-key l))))
  =/  line=@t  (rap 3 k ': ' v ~)
  ?.  has  (snoc lines line)
  (turn lines |=(l=@t ?:(=(`k (top-key l)) line l)))
::  +check: is this a SKILL.md for skill `name`? ~ when it is, else why
::  not. Front matter, name equal to the skill's own, a description of at
::  most +max-desc bytes, and a body after it.
++  check
  |=  [name=@t body=@t]
  ^-  (unit @t)
  =/  f  (fm body)
  ?.  has.f  `'SKILL.md needs front matter: ---, name: and description: lines, ---'
  =/  n=(unit @t)  (fm-get lines.f 'name')
  ?~  n  `'SKILL.md front matter needs name:'
  ?.  =(name u.n)  `(rap 3 'SKILL.md name: is ' u.n ', but the skill is ' name ~)
  =/  d=(unit @t)  (fm-get lines.f 'description')
  ?~  d  `'SKILL.md front matter needs description:'
  ?:  =('' u.d)  `'SKILL.md description: is empty'
  ?:  (gth (met 3 u.d) max-desc)  `'SKILL.md description: is over 1024 bytes'
  ~
::  +describe: a SKILL.md's description, '' when it has none
++  describe
  |=  body=@t
  ^-  @t
  (fall (fm-get lines:(fm body) 'description') '')
++  meta
  |=  [s=skill k=@t]
  ^-  @t
  (fall (fm-get lines:(fm body.s) k) '')
::  +sensitive, +is-core, +super: as memory's. Only the owner and cleared
::  keys see a sensitive skill; a key may not edit, supersede or untag a
::  core one.
++  sensitive
  |=  s=skill
  ^-  ?
  =/  v=@t  (meta s 'sensitive')
  |(=('yes' v) =('true' v))
++  is-core  |=(s=skill ^-(? (~(has in tags.s) 'core')))
++  super
  |=  s=skill
  ^-  (unit @t)
  =/  v=@t  (meta s 'superseded-by')
  ?:(=('' v) ~ `v)
::  +stamp: the SKILL.md a provenance save stores. The incoming text keeps
::  its own front matter (name, description and anything else), and the
::  provenance fields are set over it: created from the old skill, author
::  and source as given, verified today, the sensitive mark as sens says,
::  and superseded-by carried from the old skill, since a save cannot set
::  it (+skill-supersede does).
++  stamp
  |=  [old=(unit skill) body=@t author=@t source=@t now=@da sens=?]
  ^-  @t
  =/  f  (fm body)
  =/  ls=(list @t)  lines.f
  =/  created=@t
    =/  oc=@t  ?~(old '' (meta u.old 'created'))
    ?.  =('' oc)  oc
    (iso-day:lk ?~(old now updated.u.old))
  =.  ls  (fm-put ls 'created' created)
  =.  ls  (fm-put ls 'author' author)
  =.  ls  (fm-put ls 'source' source)
  =.  ls  (fm-put ls 'verified' (iso-day:lk now))
  =.  ls  (fm-put ls 'verified-by' author)
  =.  ls  (fm-put ls 'sensitive' ?:(sens 'yes' ''))
  =.  ls  (fm-put ls 'superseded-by' ?~(old '' (meta u.old 'superseded-by')))
  (un-fm ls rest.f)
::  +supersede: SKILL.md with superseded-by set to new ('' clears it)
++  supersede
  |=  [body=@t new=@t]
  ^-  @t
  =/  f  (fm body)
  ?.  has.f  body
  (un-fm (fm-put lines.f 'superseded-by' new) rest.f)
::  +put-file: a skill with one file written, or why not. A new skill
::  (old ~) starts with SKILL.md.
++  put-file
  |=  [old=(unit skill) path=@t body=@t now=@da]
  ^-  (each skill @t)
  ?:  =(main-file path)
    &+?~(old [body ~ now ~] u.old(body body, updated now))
  ?~  old  |+'a new skill starts with SKILL.md'
  ?:  ?&  !(~(has by files.u.old) path)
          (gte ~(wyt by files.u.old) max-files)
      ==
    |+'a skill holds at most 64 files'
  &+u.old(files (~(put by files.u.old) path body), updated now)
::  +file-of: one file's text, SKILL.md included
++  file-of
  |=  [s=skill path=@t]
  ^-  (unit @t)
  ?:  =(main-file path)  `body.s
  (~(get by files.s) path)
::  ==  JSON
++  file-list
  |=  s=skill
  ^-  json
  :-  %a
  %+  turn  (sort ~(tap by files.s) |=([a=[p=@t *] b=[p=@t *]] (aor p.a p.b)))
  |=  [p=@t b=@t]
  (pairs:enjs:format ~[['path' s+p] ['bytes' (numb:enjs:format (met 3 b))]])
++  tag-list
  |=  ts=(set @t)
  ^-  json
  a+(turn (sort ~(tap in ts) aor) |=(t=@t s+t))
::  +row: a skill's index line, without its body
++  row
  |=  [name=@t s=skill]
  ^-  json
  %-  pairs:enjs:format
  :~  ['name' s+name]
      ['description' s+(describe body.s)]
      ['tags' (tag-list tags.s)]
      ['updated' s+(scot %da updated.s)]
      ['author' s+(meta s 'author')]
      ['sensitive' b+(sensitive s)]
      ['superseded_by' =/(sp (super s) ?~(sp ~ s+u.sp))]
      ['files' (numb:enjs:format ~(wyt by files.s))]
  ==
::  +full: a skill as GET /skill answers, SKILL.md and the file list
++  full
  |=  [name=@t s=skill]
  ^-  json
  =/  r=json  (row name s)
  ?>  ?=([%o *] r)
  :-  %o
  %-  ~(gas by p.r)
  :~  ['body' s+body.s]
      ['files' (file-list s)]
  ==
::  +index: the rows a caller may list, by name. lst=| leaves sensitive
::  skills out (a key's listing, unless it is cleared and asks).
++  index
  |=  [ss=(map @t skill) sen=?]
  ^-  json
  %+  frond:enjs:format  'skills'
  :-  %a
  %+  turn
    %+  sort
      %+  skip  ~(tap by ss)
      |=([n=@t s=skill] &(!sen (sensitive s)))
    |=([a=[n=@t *] b=[n=@t *]] (aor n.a n.b))
  |=([n=@t s=skill] (row n s))
--
