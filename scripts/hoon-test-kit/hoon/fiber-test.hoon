::  lib/fiber-test: drive a grubbery fiber in a unit test.
::
::    A fiber is $-(input output): one input in, darts and a verb out. This
::    runs one the way grubbery does - %cont steps again at once, %wait and
::    %skip wait for the next input - and answers the darts that have one
::    right answer in a test, so a test sees what the fiber DID (every dart
::    it sent, how it stopped) without a ship:
::
::    - a dart to a road the $world refuses is vetoed;
::    - a poke of /sys/bowl.sig (now, our, entropy) is answered from the
::      $world, the way grubbery answers it: a %poke back, and an ack;
::    - a poke with a mark the $world nacks is refused (%pack with err);
::    - every other poke is acked, as if it landed, and a %make is made.
::
::    Anything else (a peek, a keen, a timer) is left unanswered, and the
::    run stops %wait with the fiber blocked on it. +feed answers it and
::    carries on. Nothing here knows any app.
::
::    Installed on a test desk by listing it in hoon-test.conf's FILES:
::      scripts/hoon-test-kit/hoon/fiber-test.hoon=lib/fiber-test.hoon
::    with grubbery's nexus and tarball on the desk (SHIP_FILES).
::
/+  nexus, tarball
|%
::  refuse: roads a weir refuses (a path prefix of the target, e.g.
::  /sys/behn or /sys/bowl.sig). A dart to one is answered %veto, which is
::  how grubbery answers a road outside the weir.
::  nack: poke marks whose pokes are refused on consumption, the way a
::  crashed, waiting fiber refuses them (a %pack carrying an error).
+$  world  [now=@da eny=@uvJ our=ship refuse=(list path) nack=(list blot:tarball)]
++  a-world  `world`[~2026.1.1 0v1 ~zod ~ ~]
::
+$  intake  intake:fiber:nexus
+$  trail
  $:  darts=(list dart:nexus)   ::  every dart sent, oldest first
      end=?(%done %fail %wait)  ::  how the run stopped
      err=tang                  ::  %fail: the fiber's error
      state=vase                ::  the fiber's state when it stopped
      queue=(list intake)       ::  answers not yet taken
      here=process:fiber:nexus  ::  the process as it stopped, for +feed
  ==
::
::  +run: start a process (a spool given its prod) with this state, and
::  drive it until it finishes or waits on something only a test can answer.
::
++  run
  |=  [w=world p=process:fiber:nexus st=vase]
  ^-  trail
  (drive w p st ~ ~ ~)
::
::  +run-behind: start a process the way grubbery restarts one after a
::  reload: an input already waiting reaches it BEFORE the start's null
::  kick. A first step that only sends a dart asserts it was kicked, so
::  it crashes here, and a fiber that takes its kick first holds the
::  input (%skip) and gets it once it wants it.
::
++  run-behind
  |=  [w=world p=process:fiber:nexus st=vase ahead=intake]
  ^-  trail
  =/  got  (mule |.((p [st `ahead])))
  ?:  ?=(%| -.got)  [~ %fail p.got st ~ p]
  =/  out  p.got
  =/  st2=vase  [p.st state.out]
  =/  ans  (answers w 0 darts.out)
  ?-    -.next.out
      %done  [darts.out %done ~ st2 ans p]
      %fail  [darts.out %fail err.next.out st2 ans p]
  ::  it held the input: the kick comes next, then the held input
      %skip  (drive w p st2 darts.out (weld ans ~[ahead]) ~)
  ::  it took the input and waits, or went on: the kick is still due
      %wait  (drive w p st2 darts.out ans ~)
      %cont  (drive w self.next.out st2 darts.out ans ~)
  ==
::
::  +feed: hand a stopped run the answer it is waiting for, and go on.
::
++  feed
  |=  [w=world t=trail in=intake]
  ^-  trail
  (drive w here.t state.t darts.t [in queue.t] ~)
::
++  drive
  |=  $:  w=world
          p=process:fiber:nexus
          st=vase
          darts=(list dart:nexus)
          queue=(list intake)
          skipped=(list intake)
      ==
  ^-  trail
  =/  in=(unit intake)  ~
  |-
  ::  a step that crashes is a %fail, as grubbery makes it one
  =/  got  (mule |.((p [st in])))
  ?:  ?=(%| -.got)  [darts %fail p.got st (weld skipped queue) p]
  =/  out  p.got
  =/  n=@ud  (lent darts)
  =.  darts  (weld darts darts.out)
  =.  st  [p.st state.out]
  =.  queue  (weld queue (answers w n darts.out))
  ?-    -.next.out
      %done  [darts %done ~ st (weld skipped queue) p]
      %fail  [darts %fail err.next.out st (weld skipped queue) p]
      %cont
    $(p self.next.out, in ~, queue (weld skipped queue), skipped ~)
      %wait
    =.  queue  (weld skipped queue)
    ?~  queue  [darts %wait ~ st ~ p]
    $(in `i.queue, queue t.queue, skipped ~)
      %skip
    =?  skipped  ?=(^ in)  (snoc skipped u.in)
    ?~  queue  [darts %wait ~ st skipped p]
    $(in `i.queue, queue t.queue)
  ==
::
::  +answers: what grubbery would send back for these darts. `n` makes each
::  entropy answer different, so every nonce'd wire is distinct.
::
++  answers
  |=  [w=world n=@ud ds=(list dart:nexus)]
  ^-  (list intake)
  ?~  ds  ~
  =/  d=dart:nexus  i.ds
  =/  rest  $(ds t.ds, n +(n))
  ?:  (refused w d)  [[%veto d] rest]
  ?:  ?=([%node * * %make *] d)  [[%made wire.d ~] rest]
  ?.  ?=([%node * * %poke *] d)  rest
  =/  b=bask:tarball  bask.load.d
  ?:  (lien nack.w |=(k=blot:tarball =(k p.b)))
    [[%pack wire.d `~[leaf+"fiber-test: refused"]] rest]
  ?.  =([/ %bowl-req] p.b)
    [[%pack wire.d ~] rest]
  =/  s=sage:tarball
    ?:  =(%now q.b)  [[/ %time] !>(now.w)]
    ?:  =(%our q.b)  [[/ %ship] !>(our.w)]
    [[/ %entropy] !>(`@uvJ`(mix eny.w n))]
  ::  grubbery answers a bowl read AND acks the poke that asked. The
  ::  answer goes first: +take-bowl takes either order (it drains the
  ::  trailing ack), and a +poke waiting on the ack skips the answer,
  ::  which +drive replays to it once the ack has landed.
  [[%poke *from:fiber:nexus s] [%pack wire.d ~] rest]
::
::  +refused: is this dart's target under a road the world refuses? Only
::  absolute roads can be matched: a relative one stays in the nexus.
++  refused
  |=  [w=world d=dart:nexus]
  ^-  ?
  ?.  ?=([%node * [%& *] *] d)  |
  =/  full=path
    ?-  -.p.road.d
      %&  (snoc path.p.p.road.d name.p.p.road.d)
      %|  p.p.road.d
    ==
  %+  lien  refuse.w
  |=(p=path =(p (scag (lent p) full)))
::
::  +answer-peek: answer the last peek a stopped run sent with this view
::
++  answer-peek
  |=  [w=world t=trail v=view:nexus]
  ^-  trail
  =/  ws=(list wire)
    %+  murn  darts.t
    |=  d=dart:nexus
    ?.  ?=([%node * * %peek *] d)  ~
    `wire.d
  ?>  ?=(^ ws)
  (feed w t [%peek (rear ws) v])
::
::  ── reading a trail ─────────────────────────────────────────────────
::
::  +pokes: the payloads of every poke with this mark, in order
::
++  pokes
  |=  [t=trail b=blot:tarball]
  ^-  (list [=road:tarball =noun])
  %+  murn  darts.t
  |=  d=dart:nexus
  ?.  ?=([%node * * %poke *] d)  ~
  ?.  =(b p.bask.load.d)  ~
  `[road.d q.bask.load.d]
::
::  +peeks: the road of every grub the fiber asked to read, in order
::
++  peeks
  |=  t=trail
  ^-  (list road:tarball)
  %+  murn  darts.t
  |=  d=dart:nexus
  ?.  ?=([%node * * %peek *] d)  ~
  `road.d
::
::  +responses: every HTTP response the fiber sent, as eyre-id and update
::
++  responses
  |=  t=trail
  ^-  (list [eyre-id=@ta =eyre-update:nexus])
  %+  murn  (pokes t [/ %eyre-action])
  |=  [* =noun]
  =/  a  ;;(eyre-action:nexus noun)
  ?.  ?=(%send -.a)  ~
  `[eyre-id.a eyre-update.a]
::
::  +status: the status code of the one simple response a request sent,
::  and its body as a cord
::
++  status
  |=  t=trail
  ^-  [code=@ud body=@t]
  =/  rs  (responses t)
  ?>  ?=([* ~] rs)
  =/  u=eyre-update:nexus  eyre-update.i.rs
  ?>  ?=(%simple -.u)
  :-  status-code.response-header.simple-payload.u
  ?~(data.simple-payload.u '' q.u.data.simple-payload.u)
::
::  +request: an inbound HTTP request, the state a request fiber starts in
::
++  request
  |=  [src=ship auth=? meth=@tas url=@t body=@t]
  ^-  vase
  !>  :-  src
      ^-  inbound-request:eyre
      :*  auth  |  [%ipv4 .127.0.0.1]
          ;;(method:http meth)  url  ~
          ?:(=('' body) ~ `(as-octs:mimes:html body))
      ==
--
