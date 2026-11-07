::  Unit tests for /lib/lattice-skills (the shared skill store).  Run with:
::    -test %/tests/lib/lattice-skills ~
::
/+  *test, *lattice-skills
|%
::  the writer's second look at a key's skill save
++  test-key-check
  =/  plain=skill  ['---\0aname: a\0a---\0ax' ~ ~2026.1.1 ~]
  =/  core=skill  plain(tags (sy 'core' ~))
  =/  sen=skill  plain(body '---\0aname: a\0asensitive: yes\0a---\0ax')
  ;:  weld
    (expect-eq !>(`(unit tape)`~) !>((key-check ~ | | ~)))
    (expect-eq !>(`(unit tape)`~) !>((key-check `plain | | ~)))
    (expect !>(?=(^ (key-check `core & | ~))))
    (expect !>(?=(^ (key-check `sen | | ~))))
    (expect !>(?=(^ (key-check `plain & & ~))))
    (expect !>(?=(^ (key-check `sen & | `'---\0aname: a\0a---\0ay'))))
    (expect-eq !>(`(unit tape)`~) !>((key-check `sen & | `'---\0aname: a\0asensitive: yes\0a---\0ay')))
  ==
++  good
  ^-  @t
  '---\0aname: deploy\0adescription: Deploy lattice to a fleet ship\0a---\0a# Steps\0a1. build\0a'
++  sk
  |=  [body=@t tags=(set @t)]
  ^-  skill
  [body ~ ~2026.11.5 tags]
::  ==  names and paths
++  test-name-ok
  ;:  weld
    (expect !>((name-ok 'deploy')))
    (expect !>((name-ok 'pdf-forms-2')))
    (expect !>((name-ok 'a')))
    (expect !>(!(name-ok '')))
    (expect !>(!(name-ok 'Deploy')))
    (expect !>(!(name-ok '-deploy')))
    (expect !>(!(name-ok 'deploy-')))
    (expect !>(!(name-ok 'de--ploy')))
    (expect !>(!(name-ok 'de_ploy')))
    (expect !>(!(name-ok '../etc')))
    (expect !>(!(name-ok 'a/b')))
    (expect !>(!(name-ok '.')))
    (expect !>(!(name-ok (crip (reap 65 'a')))))
    (expect !>((name-ok (crip (reap 64 'a')))))
  ==
::  a path never climbs out of its skill and never names code
++  test-path-ok
  ;:  weld
    (expect !>((path-ok 'reference.md')))
    (expect !>((path-ok 'references/FORMS.md')))
    (expect !>((path-ok 'data/schema.json')))
    (expect !>((path-ok 'a/b/c.yaml')))
    (expect !>((path-ok 'notes.txt')))
    (expect !>((path-ok 'conf.YML')))
    (expect !>(!(path-ok '')))
    (expect !>(!(path-ok '../x.md')))
    (expect !>(!(path-ok 'a/../../x.md')))
    (expect !>(!(path-ok './x.md')))
    (expect !>(!(path-ok '/etc/x.md')))
    (expect !>(!(path-ok 'a//x.md')))
    (expect !>(!(path-ok 'a/')))
    (expect !>(!(path-ok 'run.sh')))
    (expect !>(!(path-ok 'tool.py')))
    (expect !>(!(path-ok 'page.html')))
    (expect !>(!(path-ok 'lib.hoon')))
    (expect !>(!(path-ok 'x.md.js')))
    (expect !>(!(path-ok 'README')))
    (expect !>(!(path-ok 'a b.md')))
    (expect !>(!(path-ok 'a\\b.md')))
    (expect !>(!(path-ok (crip (weld (reap 200 'a') ".md")))))
  ==
::  ==  front matter
++  test-check
  =/  long=@t  (rap 3 '---\0aname: x\0adescription: ' (crip (reap 1.025 'd')) '\0a---\0abody' ~)
  =/  edge=@t  (rap 3 '---\0aname: x\0adescription: ' (crip (reap 1.024 'd')) '\0a---\0abody' ~)
  ;:  weld
    (expect-eq !>(`(unit @t)`~) !>((check 'deploy' good)))
    (expect !>(?=(^ (check 'other' good))))
    (expect !>(?=(^ (check 'deploy' '# no front matter'))))
    (expect !>(?=(^ (check 'x' '---\0adescription: d\0a---\0a'))))
    (expect !>(?=(^ (check 'x' '---\0aname: x\0a---\0abody'))))
    (expect !>(?=(^ (check 'x' '---\0aname: x\0adescription:\0a---\0abody'))))
    (expect !>(?=(^ (check 'x' long))))
    (expect-eq !>(`(unit @t)`~) !>((check 'x' edge)))
    ::  quoted values are unquoted
    (expect-eq !>(`(unit @t)`~) !>((check 'x' '---\0aname: "x"\0adescription: \'d\'\0a---\0a')))
  ==
::  YAML block descriptions, folded and literal
++  test-block-description
  =/  folded=@t  '---\0aname: x\0adescription: >\0a  Use when a\0a  task matches\0aallowed-tools: Read\0a---\0abody'
  =/  literal=@t  '---\0aname: x\0adescription: |-\0a  one\0a  two\0a---\0abody'
  ;:  weld
    (expect-eq !>('Use when a task matches') !>((describe folded)))
    (expect-eq !>('one\0atwo') !>((describe literal)))
    (expect-eq !>(`(unit @t)`~) !>((check 'x' folded)))
  ==
::  a stamp sets provenance and keeps every other front matter line
++  test-stamp
  =/  body=@t  '---\0aname: x\0adescription: >\0a  folded\0aallowed-tools: Read\0aauthor: forged\0a---\0abody'
  =/  out=@t  (stamp ~ body 'claude-laptop' 'agent' ~2026.11.5 |)
  =/  s=skill  (sk out ~)
  ;:  weld
    (expect-eq !>('claude-laptop') !>((meta s 'author')))
    (expect-eq !>('agent') !>((meta s 'source')))
    (expect-eq !>('2026-11-05') !>((meta s 'created')))
    (expect-eq !>('Read') !>((meta s 'allowed-tools')))
    (expect-eq !>('folded') !>((describe out)))
    (expect-eq !>(|) !>((sensitive s)))
    (expect-eq !>('body') !>(rest:(fm out)))
    (expect-eq !>(`(unit @t)`~) !>((check 'x' out)))
  ==
::  created is the old skill's; superseded-by and the sensitive mark carry
++  test-stamp-carries
  =/  old=skill
    (sk '---\0aname: x\0adescription: d\0acreated: 2026-01-02\0asuperseded-by: y\0a---\0aold' ~)
  =/  out=@t  (stamp `old '---\0aname: x\0adescription: d2\0asuperseded-by: \0a---\0anew' 'k' 'agent' ~2026.11.5 &)
  =/  s=skill  (sk out ~)
  ;:  weld
    (expect-eq !>('2026-01-02') !>((meta s 'created')))
    (expect-eq !>('y') !>((meta s 'superseded-by')))
    (expect-eq !>(&) !>((sensitive s)))
    (expect-eq !>(`(unit @t)``'y') !>((super s)))
  ==
++  test-supersede
  =/  out=@t  (supersede good 'deploy-v2')
  ;:  weld
    (expect-eq !>(`(unit @t)``'deploy-v2') !>((super (sk out ~))))
    (expect-eq !>(`(unit @t)`~) !>((super (sk (supersede out '') ~))))
  ==
::  ==  permissions
::
::  an agent's SKILL.md with allowed-tools, hooks, shell or an unknown
::  field is a 403; the fields that grant nothing pass
++  test-agent-grants
  =/  ok=@t
    %-  crip
    ;:  weld  "---\0aname: x\0adescription: >\0a  folded\0a"
      "disable-model-invocation: true\0adisallowed-tools: Bash\0a"
      "metadata:\0a  allowed-tools: Bash\0a# allowed-tools: Bash\0a"
      "author: k\0asource: agent\0a---\0aallowed-tools: Bash in the body\0a"
    ==
  =/  bad
    |=  extra=tape
    (crip :(weld "---\0aname: x\0adescription: d\0a" extra "---\0abody"))
  =/  no
    |=  b=@t
    ^-  ?
    =/  r  (perm-refuse & ~ b '')
    &(?=(^ r) =(403 code.u.r))
  ;:  weld
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse & ~ ok '')))
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse & ~ good '')))
    (expect !>((no (bad "allowed-tools: Bash\0a"))))
    (expect !>((no (bad "allowed-tools:\0a  - Bash\0a"))))
    (expect !>((no (bad "hooks:\0a  PreToolUse: []\0a"))))
    (expect !>((no (bad "shell: powershell\0a"))))
    ::  spellings a YAML reader takes as the same key
    (expect !>((no (bad "\"allowed-tools\": Bash\0a"))))
    (expect !>((no (bad "allowed-tools : Bash\0a"))))
    (expect !>((no (bad "? allowed-tools\0a: Bash\0a"))))
    (expect !>((no (bad "<<: *grant\0a"))))
    (expect !>((no (bad "Allowed-Tools: Bash\0a"))))
    ::  a field Claude Code may add later is the owner's until listed
    (expect !>((no (bad "grant-everything: yes\0a"))))
    ::  the ship's mark is never the writer's
    (expect !>((no (bad "permissions-by: owner\0a"))))
    ::  a close a strict reader reads past
    (expect !>((no '---\0aname: x\0adescription: d\0a--- \0aallowed-tools: Bash\0a---\0abody')))
    (expect !>((no '---\0aname: x\0adescription: d\0a---x\0aallowed-tools: Bash\0a---\0abody')))
    (expect !>((no '---\0aname: x\0adescription: d\0a---x\0aallowed-tools: Bash')))
    ::  a shell line Claude Code runs on load, in SKILL.md or a file
    (expect !>(?=(^ (perm-refuse & ~ (crip "{(trip good)}- now: !`id`\0a") ''))))
    (expect !>(?=(^ (perm-refuse & ~ (crip "{(trip good)}!`id`\0a") ''))))
    (expect !>(?=(^ (perm-refuse & ~ (crip "{(trip good)}```!\0aid\0a```\0a") ''))))
    (expect !>(?=(^ (perm-refuse & ~ (crip "{(trip good)}  ~~~~ !\0aid\0a~~~~\0a") ''))))
    (expect !>(?=(^ (perm-refuse & ~ good '!`id`'))))
    ::  one that stays text
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse & ~ (crip "{(trip good)}KEY=!`id` and wow!\0a```sh\0a!x\0a```\0a") '')))
    ::  the owner is never refused
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse | ~ (bad "allowed-tools: Bash\0a") '')))
  ==
::  the owner's save marks the grant hers; a key may not edit it after
++  test-owner-grants
  =/  body=@t  '---\0aname: x\0adescription: d\0aallowed-tools: Bash(git:*)\0a---\0a1. push'
  =/  mine=@t  (owner-mark ~ body ~2026.11.6)
  =/  s=skill  (sk mine ~)
  =/  edit=@t  '---\0aname: x\0adescription: d\0a---\0a1. rm -rf'
  =/  r  (perm-refuse & `s edit '')
  ;:  weld
    (expect !>((owner-perms s)))
    (expect-eq !>('2026-11-06') !>((meta s 'permissions-set')))
    (expect-eq !>('Bash(git:*)') !>((meta s 'allowed-tools')))
    (expect-eq !>('1. push') !>(rest:(fm mine)))
    ::  a key's edit, even one that drops the grant, is refused
    (expect !>(&(?=(^ r) =(403 code.u.r))))
    (expect !>(?=(^ (perm-refuse & `s mine ''))))
    ::  the owner edits it, and the mark keeps its day
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse | `s edit '')))
    =/  again=skill  (sk (owner-mark `s mine ~2026.12.1) ~)
    (expect-eq !>('2026-11-06') !>((meta again 'permissions-set')))
    ::  with the grant gone the mark goes too
    (expect !>(!(owner-perms (sk (owner-mark `s edit ~2026.12.1) ~))))
    (expect !>(!(owner-perms (sk (owner-mark ~ good ~2026.12.1) ~))))
    ::  the owner's shell line marks it hers, so the mirror keeps it
    (expect !>((owner-perms (sk (owner-mark ~ (crip "{(trip good)}!`date`\0a") ~2026.12.1) ~))))
    ::  a save with nothing to mark is verbatim
    (expect-eq !>('---\0a---x\0ab') !>((owner-mark ~ '---\0a---x\0ab' ~2026.12.1)))
    (expect-eq !>(good) !>((owner-mark ~ good ~2026.12.1)))
  ==
::  a grant a key stored before the check stays unmarked when the owner
::  saves it unchanged, and is marked once the owner writes it
++  test-legacy-grants
  =/  old=skill  (sk '---\0aname: x\0adescription: d\0aallowed-tools: Bash\0a---\0ab' ~)
  =/  same=@t  '---\0aname: x\0adescription: d\0aallowed-tools: Bash\0asensitive: yes\0a---\0ab'
  =/  wrote=@t  '---\0aname: x\0adescription: d\0aallowed-tools: Read\0a---\0ab'
  ;:  weld
    (expect !>(!(owner-perms old)))
    (expect !>(!(owner-perms (sk (owner-mark `old same ~2026.11.6) ~))))
    (expect !>((owner-perms (sk (owner-mark `old wrote ~2026.11.6) ~))))
    ::  a key may not save over it while it keeps the grant
    (expect !>(?=(^ (perm-refuse & `old body.old ''))))
    (expect-eq !>(`(unit [@ud @t])`~) !>((perm-refuse & `old good '')))
  ==
::  ==  sensitive and core
::  the mark reads any case, as memory's does
++  test-sensitive-case
  ;:  weld
    (expect-eq !>(&) !>((sensitive (sk '---\0aname: x\0asensitive: Yes\0a---\0ab' ~))))
    (expect-eq !>(|) !>((sensitive (sk '---\0aname: x\0asensitive: no\0a---\0ab' ~))))
  ==
++  test-sensitive-core
  ;:  weld
    (expect !>((sensitive (sk '---\0aname: x\0adescription: d\0asensitive: yes\0a---\0ab' ~))))
    (expect !>((sensitive (sk '---\0aname: x\0adescription: d\0asensitive: true\0a---\0ab' ~))))
    (expect !>(!(sensitive (sk good ~))))
    ::  only a top-level line counts, not one in the body
    (expect !>(!(sensitive (sk '---\0aname: x\0adescription: d\0a---\0asensitive: yes' ~))))
    (expect !>((is-core (sk good (sy ~['core'])))))
    (expect !>(!(is-core (sk good (sy ~['Core' 'ops'])))))
  ==
::  the index leaves sensitive skills out unless asked
++  test-index-sensitive
  =/  ss=(map @t skill)
    %-  my
    :~  ['deploy' (sk good ~)]
        ['money' (sk '---\0aname: money\0adescription: d\0asensitive: yes\0a---\0ab' ~)]
    ==
  =/  names
    |=  j=json
    ^-  (list @t)
    ?>  ?=([%o *] j)
    =/  a  (~(got by p.j) 'skills')
    ?>  ?=([%a *] a)
    %+  turn  p.a
    |=  r=json
    ?>  ?=([%o *] r)
    =/  n  (~(got by p.r) 'name')
    ?>(?=([%s *] n) p.n)
  ;:  weld
    (expect-eq !>(~['deploy']) !>((names (index ss |))))
    (expect-eq !>(~['deploy' 'money']) !>((names (index ss &))))
  ==
::  ==  files
++  test-put-file
  =/  a  (put-file ~ 'SKILL.md' good ~2026.11.5)
  ?>  ?=(%& -.a)
  =/  b  (put-file `p.a 'ref/notes.md' 'notes' ~2026.11.6)
  ?>  ?=(%& -.b)
  =/  c  (put-file ~ 'ref/notes.md' 'x' ~2026.11.5)
  ;:  weld
    (expect !>(?=(%| -.c)))
    (expect-eq !>(`(unit @t)``'notes') !>((file-of p.b 'ref/notes.md')))
    (expect-eq !>(`(unit @t)``good) !>((file-of p.b 'SKILL.md')))
    (expect-eq !>(~2026.11.6) !>(updated.p.b))
    (expect-eq !>(`(unit @t)`~) !>((file-of p.b 'other.md')))
  ==
::  a skill holds at most max-files files; rewriting one is always fine
++  test-max-files
  =/  full=skill
    :*  good
        (malt (turn (gulf 1 max-files) |=(n=@ud [(crip "f{(a-co:co n)}.md") 'x'])))
        ~2026.11.5
        ~
    ==
  =/  more  (put-file `full 'one-more.md' 'x' ~2026.11.5)
  =/  same  (put-file `full 'f1.md' 'y' ~2026.11.5)
  ;:  weld
    (expect !>(?=(%| -.more)))
    (expect !>(?=(%& -.same)))
  ==
--
