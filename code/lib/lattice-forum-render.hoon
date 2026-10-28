::  lib/lattice-forum-render: the forum's server-rendered Sail pages,
::  ported from furum's render-* arms. Board page (ranked, paginated),
::  thread, submit form and mod page. Pure: each arm takes the board and a
::  +ctx and answers a manx.
::
::  Not here: furum's own theme, the icon, the push service worker, image
::  upload, follow, notifications and the registry and payment views. The
::  page links the stylesheet at ctx's theme href, which the caller takes
::  from lattice's nearest-ancestor theme; the layout css below only uses
::  the theme's css variables.
::
::  Every body, title and name goes in as a Sail text node or attribute,
::  and +en-xml:html escapes both, so a post cannot inject markup.
::
/<  *   /lib/lattice-forum-types.hoon
/<  fr  /lib/lattice-forum-rules.hoon
|%
::  +ctx: who is looking and where the pages live
::
::    who:    the viewing ship (our, for the owner's own view)
::    authed: may the viewer act (show vote, reply, delete forms)
::    now:    for "3h ago" and the hot rank
::    base:   url path of the board, no trailing slash; every link and
::            form action hangs off it
::    theme:  href of the theme stylesheet, or "" for none
::
+$  ctx  [who=@p authed=? now=@da base=tape theme=tape]
+$  sort-mode  ?(%hot %new %top)
::
++  per-page  30
::
++  forum-css
  ^-  @t
  '''
  * { box-sizing: border-box; }
  body { font-family: Verdana, Geneva, sans-serif; font-size: 16px;
         color: var(--text,#111); background: var(--bg,#fafafa); margin: 0; line-height: 1.55; }
  .ct { padding: 16px; max-width: 960px; overflow-wrap: break-word; }
  a { color: var(--link,#1a6ed8); }
  hr { border: 0; border-top: 1px solid var(--border-soft,#8884); }
  .ti a { text-decoration: none; font-size: 18px; color: var(--text,#111); }
  .host { font-size: 14px; color: var(--muted,#8a8a8a); word-break: break-all; }
  .me { color: var(--muted,#8a8a8a); font-size: 14px; padding-left: 5px; }
  .me a { color: var(--muted,#8a8a8a); }
  .cm { border-left: 2px solid var(--border-soft,#8884); padding-left: 12px; margin: 10px 0 10px 12px; }
  .cm-meta { color: var(--muted,#8a8a8a); font-size: 14px; margin-bottom: 5px; }
  .va { color: var(--muted,#8a8a8a); cursor: pointer; border: none; background: none;
        padding: 0; font-size: 18px; }
  .rw { padding: 5px 0; display: flex; align-items: baseline; }
  .rk { min-width: 24px; text-align: right; margin-right: 6px;
        color: var(--muted,#8a8a8a); font-size: 15px; flex-shrink: 0; }
  .rw > div { min-width: 0; flex: 1; }
  textarea, input[type=text], input[type=url], input[type=number], select {
    background: var(--raised,#8881); color: var(--text,#111); border: 1px solid var(--border,#8886); }
  textarea { width: 100%; max-width: 540px; height: 160px; font-family: monospace; font-size: 16px; }
  input[type=text], input[type=url] { width: 100%; max-width: 440px; font-size: 16px; padding: 5px; }
  .btn { margin-top: 10px; padding: 8px 24px; cursor: pointer;
         background: var(--accent,#1a6ed8); color: var(--on-accent,#fff); border: none; font-size: 16px; }
  .post-body { padding: 12px 0; white-space: pre-wrap; line-height: 1.6; }
  table.mod { border-collapse: collapse; }
  table.mod td, table.mod th { padding: 8px 16px; text-align: left; border-bottom: 1px solid var(--border-soft,#8884); }
  .sort { font-size: 14px; color: var(--muted,#8a8a8a); margin-bottom: 10px; }
  .sort a { color: var(--link,#1a6ed8); text-decoration: none; }
  .sort strong { color: var(--text,#111); }
  .img-preview { margin: 4px 0; font-size: 14px; }
  .img-preview img { max-width: 100%; max-height: 512px; margin-top: 6px; display: block; }
  .pinned { background: var(--raised,#8881); border-left: 3px solid var(--accent,#1a6ed8); padding-left: 8px; }
  .pin-tag { font-size: 12px; color: var(--accent,#1a6ed8); font-weight: bold;
             text-transform: uppercase; margin-right: 8px; }
  .board-layout { display: flex; gap: 24px; }
  .board-main { flex: 1; min-width: 0; }
  .board-sidebar { width: 280px; flex-shrink: 0; padding: 12px 16px;
                   background: var(--pop,#fafafa); color: var(--text,#111);
                   border: 1px solid var(--border,#8886); border-radius: 4px;
                   font-size: 14px; white-space: pre-wrap; align-self: flex-start; }
  .board-sidebar h4 { margin: 0 0 8px 0; font-size: 14px; color: var(--muted,#8a8a8a); text-transform: uppercase; }
  .mobile-sidebar { display: none; margin-bottom: 12px; font-size: 14px; }
  .faint { color: var(--muted,#8a8a8a); }
  @media (max-width: 768px) {
    .ct { padding: 8px; }
    .board-layout { flex-direction: column; }
    .board-sidebar { display: none; }
    .mobile-sidebar { display: block; }
  }
  '''
::
::  +commafy: 10000 -> "10,000"
::
++  commafy
  |=  n=@ud
  ^-  tape
  =/  raw=tape  (skip (a-co:co n) |=(c=@ =(c '.')))
  =/  len=@ud  (lent raw)
  ?:  (lte len 3)  raw
  =/  idx=@ud  0
  =/  out=tape  ~
  |-
  ?:  =(idx len)  out
  =/  pos=@ud  (sub len (add idx 1))
  =/  ch=@  (snag idx raw)
  ?:  &((gth pos 0) =(0 (mod pos 3)))
    $(idx +(idx), out (weld out [ch ',' ~]))
  $(idx +(idx), out (snoc out ch))
::
++  time-ago
  |=  [now=@da then=@da]
  ^-  tape
  ?:  (lte now then)  "just now"
  =/  parts=tarp  (yell (sub now then))
  ?:  (gth d.parts 0)  "{(a-co:co d.parts)}d ago"
  ?:  (gth h.parts 0)  "{(a-co:co h.parts)}h ago"
  ?:  (gth m.parts 0)  "{(a-co:co m.parts)}m ago"
  "{(a-co:co s.parts)}s ago"
::
++  points-of
  |=  [up=(set @p) dn=(set @p)]
  ^-  @ud
  =/  u=@ud  ~(wyt in up)
  =/  d=@ud  ~(wyt in dn)
  ?:((gte u d) (sub u d) 0)
::
::  +safe-url: http(s) only; guards against javascript: and friends
::
++  safe-url
  |=  url=@t
  ^-  ?
  =/  lu=tape  (cass (trip url))
  |(=((scag 7 lu) "http://") =((scag 8 lu) "https://"))
::
++  safe-href
  |=  url=@t
  ^-  tape
  ?:((safe-url url) (trip url) "#")
::
++  is-image-url
  |=  url=@t
  ^-  ?
  =/  u=tape  (cass (trip url))
  ?.  |(=((scag 7 u) "http://") =((scag 8 u) "https://"))  %.n
  =/  exts=(list tape)
    ~[".jpg" ".jpeg" ".png" ".gif" ".webp" ".svg" ".bmp"]
  |-
  ?~  exts  %.n
  ?^  (find i.exts u)  %.y
  $(exts t.exts)
::
++  image-preview
  |=  url=tape
  ^-  manx
  ;details.img-preview
    ;summary: show image
    ;img(src url, alt "image", loading "lazy");
  ==
::
++  extract-url
  |=  text=tape
  ^-  [url=tape rest=tape]
  =/  url=tape  ~
  |-
  ?~  text  [(flop url) ~]
  ?:  ?|  =(i.text ' ')
          =(i.text '\0a')
          =(i.text '\09')
          =(i.text '<')
          =(i.text '>')
      ==
    [(flop url) text]
  $(text t.text, url [i.text url])
::
::  +first-url: where the first http(s) url starts
::
++  first-url
  |=  txt=tape
  ^-  (unit @ud)
  =/  https-idx  (find "https://" txt)
  =/  http-idx   (find "http://" txt)
  ?~  https-idx  http-idx
  ?~  http-idx   https-idx
  `(min u.https-idx u.http-idx)
::
++  extract-image-urls
  |=  text=@t
  ^-  (list tape)
  =/  txt=tape  (trip text)
  =/  acc=(list tape)  ~
  |-
  =/  url-idx=(unit @ud)  (first-url txt)
  ?~  url-idx  (flop acc)
  =/  [url=tape rest=tape]  (extract-url (slag u.url-idx txt))
  ?:  (is-image-url (crip url))
    $(txt rest, acc [url acc])
  $(txt rest)
::
::  +linkify: text with its urls as anchors (text stays escaped)
::
++  linkify
  |=  txt=tape
  ^-  marl
  =/  url-idx=(unit @ud)  (first-url txt)
  ?~  url-idx
    ?~  txt  ~
    ~[;/(txt)]
  =/  before=tape  (scag u.url-idx txt)
  =/  [url=tape rest=tape]  (extract-url (slag u.url-idx txt))
  =/  link=manx  ;a(href url, target "_blank", rel "noopener noreferrer"): {url}
  =/  prefix=marl  ?~(before ~ ~[;/(before)])
  (weld prefix [link (linkify rest)])
::
++  linkify-div
  |=  [cls=tape text=tape]
  ^-  manx
  [[%div ~[[%class cls]]] (linkify text)]
::
::  +sort-hot: by hot score, each post scored once. Never call
::  +hot-before per pair: furum measured 46 s sorting 700 posts that way.
::  The key is [n d post]; a beats b when n.a*d.b > n.b*d.a, newer first
::  at a tie (which also keeps +sort off its quadratic case on a board of
::  unvoted posts, which all score 0).
::
++  sort-hot
  |=  [now=@da posts=(list post)]
  ^-  (list post)
  =/  keyed=(list [n=@ud d=@ud p=post])
    %+  turn  posts
    |=  p=post
    =/  s  (hot-score:fr now p)
    [n.s d.s p]
  %+  turn
    %+  sort  keyed
    |=  [a=[n=@ud d=@ud p=post] b=[n=@ud d=@ud p=post]]
    =/  l=@ud  (mul n.a d.b)
    =/  r=@ud  (mul n.b d.a)
    ?.  =(l r)  (gth l r)
    (gth created.p.a created.p.b)
  |=([* * p=post] p)
::
++  sort-new
  |=  posts=(list post)
  ^-  (list post)
  (sort posts |=([a=post b=post] (gth created.a created.b)))
::
++  sort-top
  |=  posts=(list post)
  ^-  (list post)
  %+  sort  posts
  |=  [a=post b=post]
  =/  va  (points-of up-votes.a down-votes.a)
  =/  vb  (points-of up-votes.b down-votes.b)
  ?:  =(va vb)  (gth created.a created.b)
  (gth va vb)
::
++  sort-by
  |=  [mode=sort-mode now=@da posts=(list post)]
  ^-  (list post)
  ?-  mode
    %hot  (sort-hot now posts)
    %new  (sort-new posts)
    %top  (sort-top posts)
  ==
::
::  +parse-sort / +parse-page: from the request's query args
::
++  parse-sort
  |=  args=(map @t @t)
  ^-  sort-mode
  ?+  (~(gut by args) 'sort' 'hot')  %hot
    %'hot'  %hot
    %'new'  %new
    %'top'  %top
  ==
::
++  parse-page
  |=  args=(map @t @t)
  ^-  @ud
  =/  n=(unit @ud)  ((slat %ud) (~(gut by args) 'page' '1'))
  ?~(n 1 ?:((lth u.n 1) 1 u.n))
::
++  rank-list-offset
  |=  [posts=(list post) offset=@ud]
  ^-  (list [@ud post])
  =/  idx=@ud  +(offset)
  |-
  ?~  posts  ~
  [[idx i.posts] $(posts t.posts, idx +(idx))]
::
++  paginate
  |=  [page=@ud lst=(list post)]
  ^-  [total=@ud paged=(list post)]
  [(lent lst) (scag per-page (slag (mul (dec page) per-page) lst))]
::
++  render-pagination
  |=  [base-url=tape page=@ud total=@ud]
  ^-  manx
  ?:  =(total 0)  ;span;
  =/  total-pages=@ud
    (add (div total per-page) ?:((gth (mod total per-page) 0) 1 0))
  ?:  (lte total-pages 1)  ;span;
  =/  has-prev=?  (gth page 1)
  =/  has-next=?  (lth page total-pages)
  ;div.sort
    ;+  ?.  has-prev  ;span;
        ;a(href "{base-url}page={(a-co:co (dec page))}"): prev
    ;+  ?:  &(has-prev has-next)  ;span: {" | "}
        ;span;
    ;+  ?.  has-next  ;span;
        ;a(href "{base-url}page={(a-co:co +(page))}"): next
    ;+  ;/("  ")
    ;span.me: page {(a-co:co page)} of {(a-co:co total-pages)}
  ==
::
::  +flatten-comments: depth-first, oldest sibling first, [depth comment]
::
++  flatten-comments
  |=  comments=(map comment-id comment)
  ^-  (list [@ud comment])
  =/  by-parent=(map (unit comment-id) (list comment))
    %+  roll  ~(val by comments)
    |=  [c=comment acc=(map (unit comment-id) (list comment))]
    (~(put by acc) parent.c [c (~(gut by acc) parent.c ~)])
  (walk-children 0 ~ by-parent)
::
++  walk-children
  |=  [depth=@ud parent=(unit comment-id) by-parent=(map (unit comment-id) (list comment))]
  ^-  (list [@ud comment])
  =/  kids=(list comment)
    %+  sort  (~(gut by by-parent) parent ~)
    |=([a=comment b=comment] (lth created.a created.b))
  %-  zing
  %+  turn  kids
  |=  c=comment
  [[depth c] (walk-children +(depth) `id.c by-parent)]
::
++  role-to-text
  |=  =role
  ^-  @t
  ?-  role
    %mod     'moderator'
    %poster  'poster'
    %reader  'reader'
  ==
::
::  +page-shell: the forum page's BODY content (the ".ct" block). The whole
::  html document, themed head and shared reader bar are reassembled in
::  app.hoon (+forum-doc): the reader chrome, +pwa-head and +nav-script all
::  live there as tape, and a library cannot call app.hoon arms nor inject
::  their tape into a manx without +en-xml escaping it. So this arm answers
::  only the body manx; app.hoon serializes it and wraps it. `forum-css`
::  stays owned here, exposed for the app.hoon wrapper to inline. `c` and
::  `title` are kept in the sample so the render arms call this unchanged.
::
++  page-shell
  |=  [c=ctx title=@t content=marl nav=(unit [href=tape label=tape])]
  ^-  manx
  =/  nav-node=manx
    ?~  nav  ;span;
    ;span
      ;+  ;/("  |  ")
      ;a(href href.u.nav): {label.u.nav}
    ==
  ;div.ct
    ;div.faint
      ;+  ;/("forum")
      ;+  nav-node
    ==
    ;*  content
  ==
::
::  +vote-form: the up-arrow form for a post or comment target value
::
++  vote-form
  |=  [c=ctx target=tape]
  ^-  manx
  ?.  authed.c  ;span;
  ;form(method "post", action "{base.c}/vote", style "display:inline")
    ;input(type "hidden", name "target", value target);
    ;input(type "hidden", name "dir", value "up");
    ;button.va(type "submit"): ▲
  ==
::
++  post-link
  |=  [c=ctx =post]
  ^-  manx
  =/  post-href=tape  "{base.c}/{(a-co:co id.post)}"
  ?^  url.post
    ;a(href (safe-href u.url.post), target "_blank", rel "noopener noreferrer"): {(trip title.post)}
  ;a(href post-href): {(trip title.post)}
::
::  +render-list: a board's posts, pinned first on page 1, then the rest
::  ranked by mode, 30 to a page, with the pager. Rank numbers continue
::  across pages.
::
++  render-list
  |=  [c=ctx brd=board mode=sort-mode page=@ud]
  ^-  manx
  =/  posts=(list post)  ~(val by posts.brd)
  =/  is-mod=?  (is-mod:fr who.c brd)
  =/  pinned-posts=(list post)
    (sort-new (skim posts |=(p=post (~(has in pinned.brd) id.p))))
  =/  unpinned=(list post)
    (skim posts |=(p=post !(~(has in pinned.brd) id.p)))
  =/  [total=@ud paged=(list post)]
    (paginate page (sort-by mode now.c unpinned))
  =/  pinned-rows=marl
    ?.  &(!=(~ pinned-posts) =(page 1))  ~
    %+  turn  pinned-posts
    |=  =post
    ^-  manx
    =/  post-href=tape  "{base.c}/{(a-co:co id.post)}"
    ;div(class "rw pinned")
      ;span.pin-tag: pinned
      ;div
        ;span.ti
          ;+  (post-link c post)
        ==
        ;div.me
          ;a(href post-href): {(commafy comment-count.post)} comments
          ;+  ?.  &(authed.c is-mod)  ;span;
              ;form(method "post", action "{post-href}/pin", style "display:inline")
                ;input(type "hidden", name "pinned", value "false");
                ;+  ;/(" | ")
                ;button.va(type "submit"): unpin
              ==
        ==
      ==
    ==
  =/  post-rows=marl
    ?~  paged
      ?.  ?=(~ pinned-posts)  ~
      :~  ;p.me: No posts yet.
      ==
    %+  turn  (rank-list-offset paged (mul (dec page) per-page))
    |=  [idx=@ud =post]
    ^-  manx
    =/  post-href=tape  "{base.c}/{(a-co:co id.post)}"
    ;div.rw
      ;span.rk: {(a-co:co idx)}.
      ;+  (vote-form c "post-{(a-co:co id.post)}")
      ;div
        ;span.ti
          ;+  (post-link c post)
        ==
        ;+  ?~  url.post  ;span;
            ;span.host: ({(trip u.url.post)})
        ;+  ?.  &(?=(^ url.post) (is-image-url u.url.post))  ;span;
            (image-preview (trip u.url.post))
        ;div.me
          ;+  ;/("{(commafy (points-of up-votes.post down-votes.post))} points by {(scow %p author.post)} {(time-ago now.c created.post)} | ")
          ;a(href post-href): {(commafy comment-count.post)} comments
          ;+  ?.  &(authed.c |(=(who.c author.post) is-mod))  ;span;
              ;form(method "post", action "{post-href}/delete", style "display:inline")
                ;+  ;/(" | ")
                ;button.va(type "submit"): delete
              ==
          ;+  ?.  &(authed.c is-mod)  ;span;
              ;form(method "post", action "{post-href}/pin", style "display:inline")
                ;input(type "hidden", name "pinned", value "true");
                ;+  ;/(" | ")
                ;button.va(type "submit"): pin
              ==
        ==
      ==
    ==
  ;div.board-main
    ;*  (weld pinned-rows (weld post-rows ~[(render-pagination "{base.c}?sort={(trip mode)}&" page total)]))
  ==
::
::  +render-board: the board page: header, sort bar, the list, sidebar
::
++  render-board
  |=  [c=ctx brd=board mode=sort-mode page=@ud]
  ^-  manx
  =/  info=board-info  info.brd
  =/  can-mod=?  |(=(who.c host.info) (is-mod:fr who.c brd))
  =/  sort-link
    |=  [m=sort-mode label=tape]
    ^-  manx
    ?:  =(mode m)  ;strong: {label}
    ;a(href "{base.c}?sort={(trip m)}"): {label}
  =/  header=manx
    ;div
      ;h3: {(trip title.info)}
      ;p.me: {(trip description.info)}
      ;+  ?.  authed.c  ;p;
          ;p
            ;a(href "{base.c}/submit"): submit post
            ;+  ?.  can-mod  ;span;
                ;span
                  ;+  ;/("  |  ")
                  ;a(href "{base.c}/mod"): moderate
                ==
          ==
      ;div.sort
        ;span: sort:
        ;+  (sort-link %hot "hot")
        ;+  ;/(" | ")
        ;+  (sort-link %new "new")
        ;+  ;/(" | ")
        ;+  (sort-link %top "top")
      ==
    ==
  =/  has-side=?  !=('' sidebar.brd)
  =/  side-node=manx
    ?.  has-side  ;span;
    ;aside.board-sidebar
      ;h4: Community Info
      ;*  (linkify (trip sidebar.brd))
    ==
  =/  mobile-side=manx
    ?.  has-side  ;span;
    ;details.mobile-sidebar
      ;summary: community info
      ;*  (linkify (trip sidebar.brd))
    ==
  =/  body=manx
    ;div.board-layout
      ;+  (render-list c brd mode page)
      ;+  side-node
    ==
  %^  page-shell  c  (crip "forum - {(trip title.info)}")
  [[header mobile-side body ~] `[base.c (trip title.info)]]
::
::  +render-thread: one post and its comments, nested by depth
::
++  render-thread
  |=  [c=ctx brd=board id=post-id]
  ^-  manx
  =/  info=board-info  info.brd
  =/  nav=(unit [href=tape label=tape])  `[base.c (trip title.info)]
  =/  got=(unit post)  (~(get by posts.brd) id)
  ?~  got
    %^  page-shell  c  'forum - not found'
    :_  nav
    :~  ;p.me: No such post.
    ==
  =/  =post  u.got
  =/  is-mod=?  (is-mod:fr who.c brd)
  =/  post-path=tape  "{base.c}/{(a-co:co id.post)}"
  =/  flat  (flatten-comments (~(gut by comments.brd) id ~))
  =/  is-pinned=?  (~(has in pinned.brd) id.post)
  =/  comment-form=manx
    ?.  authed.c  ;span;
    ;form(method "post", action "{post-path}/comment")
      ;textarea(name "body", placeholder "add a comment...");
      ;input.btn(type "submit", value "add comment");
    ==
  =/  post-detail=manx
    ;div
      ;+  ?.  is-pinned  ;span;
          ;span.pin-tag: pinned
      ;+  (vote-form c "post-{(a-co:co id.post)}")
      ;span.ti: {" "}{(trip title.post)}
      ;+  ?~  url.post  ;span;
          ;a(href (safe-href u.url.post), target "_blank", rel "noopener noreferrer"): {(trip u.url.post)}
      ;+  ?.  &(?=(^ url.post) (is-image-url u.url.post))  ;span;
          (image-preview (trip u.url.post))
      ;div.me
        ;+  ;/("{(commafy (points-of up-votes.post down-votes.post))} points by {(scow %p author.post)} {(time-ago now.c created.post)}")
        ;+  ?.  &(authed.c |(=(who.c author.post) is-mod))  ;span;
            ;form(method "post", action "{post-path}/delete", style "display:inline")
              ;+  ;/(" | ")
              ;button.va(type "submit"): delete post
            ==
        ;+  ?.  &(authed.c is-mod)  ;span;
            ;form(method "post", action "{post-path}/pin", style "display:inline")
              ;input(type "hidden", name "pinned", value ?:(is-pinned "false" "true"));
              ;+  ;/(" | ")
              ;button.va(type "submit"): {?:(is-pinned "unpin" "pin")}
            ==
      ==
      ;+  ?~  body.post  ;span;
          (linkify-div "post-body" (trip u.body.post))
    ==
  %^  page-shell  c  (crip "forum - {(trip title.post)}")
  :_  nav
  :~  post-detail
      ;hr;
      comment-form
      ;hr;
      ;div
        ;*  (render-comments c brd id flat is-mod)
      ==
  ==
::
::  +render-comments: depth-tagged comments, each indented 20px per level
::  and wrapped in the div of its depth
::
++  render-comments
  |=  [c=ctx brd=board pid=post-id flat=(list [@ud comment]) is-mod=?]
  ^-  marl
  %+  turn  flat
  |=  [depth=@ud cm=comment]
  ^-  manx
  ;div(style "margin-left: {(a-co:co (mul depth 20))}px", class "cm-wrap")
    ;div.cm
      ;div.cm-meta
        ;+  (vote-form c "comment-{(a-co:co pid)}-{(a-co:co id.cm)}")
        ;+  ;/(" {(scow %p author.cm)} {(commafy (points-of up-votes.cm down-votes.cm))} points {(time-ago now.c created.cm)}")
        ;+  ?.  &(authed.c |(=(who.c author.cm) is-mod))  ;span;
            ;form(method "post", action "{base.c}/{(a-co:co pid)}/delete-comment", style "display:inline")
              ;input(type "hidden", name "comment-id", value "{(a-co:co id.cm)}");
              ;+  ;/(" ")
              ;button.va(type "submit"): delete
            ==
      ==
      ;+  (linkify-div "" (trip body.cm))
      ;*  (turn (extract-image-urls body.cm) image-preview)
      ;+  ?.  authed.c  ;span;
          ;details
            ;summary.me: reply
            ;form(method "post", action "{base.c}/{(a-co:co pid)}/comment")
              ;input(type "hidden", name "parent", value "{(a-co:co id.cm)}");
              ;textarea(name "body", rows "3", cols "60");
              ;input.btn(type "submit", value "reply");
            ==
          ==
    ==
  ==
::
::  +render-submit: the new-post form
::
++  render-submit
  |=  [c=ctx name=board-name]
  ^-  manx
  %^  page-shell  c  'forum - submit'
  :_  `[base.c (trip name)]
  :~  ;h3: Submit to {(trip name)}
      ;form(method "post", action "{base.c}/submit")
        ;div
          ;label: title
          ;br;
          ;input(type "text", name "title", required "");
        ==
        ;br;
        ;div
          ;label: url (optional, for link posts)
          ;br;
          ;input(type "url", name "url");
        ==
        ;br;
        ;div
          ;label: text (optional, for text posts)
          ;br;
          ;textarea(name "body");
        ==
        ;br;
        ;input.btn(type "submit", value "submit");
      ==
  ==
::
::  +render-mod: the moderation page. The host also sees the board-level
::  settings (info, public, prune, delete).
::
++  render-mod
  |=  [c=ctx brd=board]
  ^-  manx
  =/  info=board-info  info.brd
  =/  is-host=?  =(who.c host.info)
  =/  role-section=manx
    ?:  =(0 ~(wyt by roles.brd))
      ;p.me: No explicit roles set. Everyone gets the default role.
    ;table.mod
      ;thead
        ;tr
          ;th: Ship
          ;th: Role
          ;th: Action
        ==
      ==
      ;tbody
        ;*  %+  turn  ~(tap by roles.brd)
            |=  [who=@p =role]
            ;tr
              ;td: {(scow %p who)}
              ;td: {(trip (role-to-text role))}
              ;td
                ;form(method "post", action "{base.c}/mod/remove-role", style "display:inline")
                  ;input(type "hidden", name "who", value (scow %p who));
                  ;input.btn(type "submit", value "remove");
                ==
              ==
            ==
      ==
    ==
  =/  info-section=manx
    ?.  is-host  ;span;
    ;div
      ;h4: Board Info
      ;form(method "post", action "{base.c}/mod/edit-info")
        ;div
          ;label: Title
          ;br;
          ;input(type "text", name "title", value (trip title.info), required "");
        ==
        ;br;
        ;div
          ;label: Description
          ;br;
          ;textarea(name "description", rows "3", cols "60"): {(trip description.info)}
        ==
        ;br;
        ;input.btn(type "submit", value "Save Info");
      ==
      ;hr;
    ==
  =/  pub-section=manx
    ?.  is-host  ;span;
    ;div
      ;h4: Public Access
      ;p.me: Public boards can be read without authentication.
      ;form(method "post", action "{base.c}/mod/public")
        ;p: {?:(public.info "This board is currently public." "This board is currently private.")}
        ;input.btn(type "submit", value ?:(public.info "make private" "make public"));
      ==
      ;hr;
    ==
  =/  sidebar-section=manx
    ;div
      ;h4: Community Sidebar
      ;p.me: This text appears in the sidebar on the board page. URLs will be linked automatically. Leave empty to hide.
      ;form(method "post", action "{base.c}/sidebar")
        ;textarea(name "sidebar", rows "6", cols "60"): {(trip sidebar.brd)}
        ;br;
        ;input.btn(type "submit", value "save sidebar");
      ==
      ;hr;
    ==
  =/  prune-section=manx
    ?.  is-host  ;span;
    =/  prune-score=tape  ?~(prune.brd "2" (a-co:co min-score.u.prune.brd))
    =/  prune-days=tape  ?~(prune.brd "7" (a-co:co (div after.u.prune.brd ~d1)))
    ;div
      ;h4: Auto-Prune
      ;p.me: Automatically delete posts below a minimum score after a set number of days. Pinned posts are never pruned.
      ;form(method "post", action "{base.c}/mod/prune")
        ;div(style "margin: 8px 0")
          ;label
            ;+  ?~  prune.brd  ;input(type "checkbox", name "prune-enabled", value "on");
                ;input(type "checkbox", name "prune-enabled", value "on", checked "checked");
            ;+  ;/(" Enable auto-prune")
          ==
        ==
        ;div(style "margin: 8px 0")
          ;label: Minimum score (posts below this get pruned)
          ;br;
          ;input(type "number", name "min-score", value prune-score, min "0");
        ==
        ;div(style "margin: 8px 0")
          ;label: After days
          ;br;
          ;input(type "number", name "after-days", value prune-days, min "1");
        ==
        ;input.btn(type "submit", value "save prune settings");
      ==
      ;hr;
    ==
  =/  role-form=manx
    ;form(method "post", action "{base.c}/mod/role")
      ;div
        ;label: ship (@p)
        ;br;
        ;input(type "text", name "who", required "", placeholder "~sampel-palnet");
      ==
      ;br;
      ;div
        ;label: role
        ;br;
        ;select(name "role")
          ;option(value "reader"): reader
          ;option(value "poster"): poster
          ;option(value "mod"): moderator
        ==
      ==
      ;br;
      ;input.btn(type "submit", value "set role");
    ==
  =/  delete-section=manx
    ?.  is-host  ;span;
    ;div
      ;hr;
      ;h4: Delete Board
      ;p.me: Permanently delete this board. This cannot be undone.
      ;form(method "post", action "{base.c}/mod/delete", onsubmit "return confirm('Are you sure you want to delete this board? This cannot be undone.')")
        ;input.btn(type "submit", value "delete board");
      ==
    ==
  %^  page-shell  c  (crip "forum - mod {(trip name.info)}")
  :_  `[base.c (trip title.info)]
  :~  ;h3: Moderate {(trip title.info)}
      ;p.me: Default role: {(trip (role-to-text default-role.info))}
      info-section
      pub-section
      sidebar-section
      prune-section
      ;h4: Set User Role
      role-form
      ;hr;
      ;h4: Current Roles
      role-section
      delete-section
  ==
::
::  +render-boards: the owner's board list, with a link to make one. Each
::  entry is [name title public]; base.c is the forum root, not a board.
::
++  render-boards
  |=  [c=ctx boards=(list [name=board-name title=@t public=?])]
  ^-  manx
  =/  rows=marl
    ?~  boards
      :~  ;p.me: No boards yet.
      ==
    %+  turn  boards
    |=  [name=board-name title=@t public=?]
    ^-  manx
    ;div.rw
      ;div
        ;span.ti
          ;a(href "{base.c}/{(trip name)}"): {(trip title)}
        ==
        ;span.me: {(trip name)}, {?:(public "public" "private")}
      ==
    ==
  %^  page-shell  c  'forum - boards'
  :_  ~
  :*  ;h3: Boards
      ;p.me
        ;a(href "{base.c}/_new"): create a board
      ==
      rows
  ==
::
::  +render-create: the new-board form (base.c is the forum root)
::
++  render-create
  |=  c=ctx
  ^-  manx
  %^  page-shell  c  'forum - create a board'
  :_  `[base.c "boards"]
  :~  ;h3: Create a board
      ;form(method "post", action "{base.c}/_new")
        ;div
          ;label: name (lowercase letters, digits, hyphens)
          ;br;
          ;input(type "text", name "name", required "", pattern "[a-z][a-z0-9-]*");
        ==
        ;br;
        ;div
          ;label: title
          ;br;
          ;input(type "text", name "title", required "");
        ==
        ;br;
        ;div
          ;label: description
          ;br;
          ;textarea(name "description", rows "3", cols "60");
        ==
        ;br;
        ;div
          ;label: default role
          ;br;
          ;select(name "role")
            ;option(value "poster"): poster
            ;option(value "reader"): reader
            ;option(value "mod"): moderator
          ==
        ==
        ;br;
        ;input.btn(type "submit", value "create");
      ==
  ==
--
