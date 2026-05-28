::  /lib/lattice — pure helpers for the %lattice agent.
::
::  These are the bowl/scry-independent gates, split out of /app/lattice so they
::  can be unit-tested in /tests/lib/lattice without a running agent.
::
/-  *lattice
|%
::  +parse-urb-url: "urb://~ship/a/b" → [~ship /a/b]; bare ship → [~ship /]
++  parse-urb-url
  |=  raw=@t
  ^-  (unit [=ship =path])
  =/  s=tape  (trip raw)
  ?.  =("urb://" (scag 6 s))  ~
  =/  rest=tape  (slag 6 s)
  =/  slash=(unit @ud)  (find "/" rest)
  ?~  slash
    ?~  shp=(slaw %p (crip rest))  ~
    `[u.shp ~]
  ?~  shp=(slaw %p (crip (scag u.slash rest)))  ~
  ::  the path portion is user input; +stab crashes on an invalid knot (spaces,
  ::  unicode, empty segments), so parse it crash-safely and reject on failure.
  =/  pax=(each path tang)  (mule |.((stab (crip (slag u.slash rest)))))
  ?:(?=(%| -.pax) ~ `[u.shp p.pax])
::
::  +pub-path: /pub/<rel>/gmi from a relative @t like "notes/2026/intro".
::  Content lives under /pub, separate from the desk's /lib source libraries.
++  pub-path
  |=  rel=@t
  ^-  path
  :(welp /pub (stab (crip (weld "/" (trip rel)))) /gmi)
::
::  +req-action: the last path segment of a request url (fetch|list|save|delete)
++  req-action
  |=  req=inbound-request:eyre
  ^-  @t
  =/  parsed  (rush url.request.req ;~(plug apat:de-purl:html yque:de-purl:html))
  ?~  parsed  ''
  =/  site=(list @t)  q.-.u.parsed
  ?~  site  ''
  (rear site)
::
::  +query-param: url-decoded value of a query parameter, if present
++  query-param
  |=  [req=inbound-request:eyre key=@t]
  ^-  (unit @t)
  =/  parsed  (rush url.request.req ;~(plug apat:de-purl:html yque:de-purl:html))
  ?~  parsed  ~
  =/  hit  (skim `quay:eyre`+.u.parsed |=([k=@t v=@t] =(k key)))
  ?~  hit  ~
  =/  dec=(unit tape)  (de-urlt:html (trip q.i.hit))
  ?~(dec ~ `(crip u.dec))
::
::  +keen-path: ames remote-scry spar path for a publication revision.
::  Format: /g/x/<case>/lattice//1/<spur> — [cas] is the already-scotted case
::  segment (the FIRST segment), and the trailing `1` is a fixed marker gall
::  requires ([%'1' *]). [cas] is `(scot %ud n)` to address a specific revision
::  (revision-following pends until that revision publishes) or `(scot %da d)`
::  to address the latest revision as of a date (used for one-shot fetches —
::  remote scry only serves the latest revision, not arbitrary old ones).
++  keen-path
  |=  [cas=@ta spur=path]
  ^-  path
  :(welp /g/x ~[cas] /lattice ~[''] ~['1'] spur)
::
::  +mark-and-body: {"mark":..,"body":..} JSON for the fetch response
++  mark-and-body
  |=  [mark=@t body=@t]
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :~  ['mark' s+mark]
      ['body' s+body]
  ==
::
::  +generate-index: a gemtext index page listing the published file paths
++  generate-index
  |=  paths=(set path)
  ^-  @t
  =/  lines=(list @t)
    %+  turn  ~(tap in paths)
    |=  pax=path
    ::  /lib/notes/2026/intro/gmi → "=> /notes/2026/intro  notes/2026/intro"
    =/  inner=path  (snip (slag 1 pax))
    =/  shown=tape  (spud inner)
    (crip "=> {shown}  {(slag 1 shown)}")
  =/  header=(list @t)
    ~['# Index' '' 'Files published on this ship:' '']
  (of-wain:format (welp header lines))
::
::  ── web reader: render gemtext to a self-contained HTML page ──
::  Served at GET /apps/lattice so the Landscape tile opens a browsable reader
::  with no native client. Link resolution mirrors gemtext/UrbUrl.kt so the web
::  and native browsers agree on where a link points.
::
::  +ltrim: drop leading spaces (link desc sits after the url's separator run).
++  ltrim
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?:(=(' ' i.t) $(t t.t) t)
::
::  +esc: escape a tape for HTML text/attribute context.
++  esc
  |=  t=tape
  ^-  tape
  %-  zing
  %+  turn  t
  |=  c=@tD
  ^-  tape
  ?:  =('&' c)  "&amp;"
  ?:  =('<' c)  "&lt;"
  ?:  =('>' c)  "&gt;"
  ?:  =('"' c)  "&quot;"
  ~[c]
::
::  +has-prefix: does [t] start with [p]?
++  has-prefix
  |=  [p=tape t=tape]
  ^-  ?
  ?:  (lth (lent t) (lent p))  |
  =(p (scag (lent p) t))
::
::  +foreign-scheme: a non-urb scheme (https:, mailto:, …) — a ':' before any '/'.
++  foreign-scheme
  |=  t=tape
  ^-  ?
  ?:  (has-prefix "urb://" t)  |
  ?~  colon=(find ":" t)  |
  ?~  slash=(find "/" t)  &
  (lth u.colon u.slash)
::
::  +safe-ext: a link scheme safe to render as a clickable external <a> — only
::  http(s)/mailto. Anything else (javascript:, data:, …) must not be linkable.
++  safe-ext
  |=  t=tape
  ^-  ?
  ?|  (has-prefix "https://" t)
      (has-prefix "http://" t)
      (has-prefix "mailto:" t)
  ==
::
::  +parse-urb-tape: "urb://~ship/a/b" → [ship="~ship" path="/a/b"] ("" path if none).
++  parse-urb-tape
  |=  t=tape
  ^-  (unit [ship=tape path=tape])
  ?.  (has-prefix "urb://" t)  ~
  =/  rest  (slag 6 t)
  ?~  slash=(find "/" rest)  `[rest ""]
  `[(scag u.slash rest) (slag u.slash rest)]
::
::  +dir-of: the substring of [p] before its last '/', or "".
++  dir-of
  |=  p=tape
  ^-  tape
  =/  n  (lent p)
  |-  ^-  tape
  ?:  =(0 n)  ""
  ?:  =('/' (snag (dec n) p))  (scag (dec n) p)
  $(n (dec n))
::
::  +split-slash: split a tape on '/' into segments.
++  split-slash
  |=  t=tape
  ^-  (list tape)
  =|  cur=tape
  =|  out=(list tape)
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) out])
  ?:  =('/' i.t)  $(t t.t, cur ~, out [(flop cur) out])
  $(t t.t, cur [i.t cur])
::
::  +join-slash: join segments with '/'.
++  join-slash
  |=  l=(list tape)
  ^-  tape
  ?~  l  ""
  ?~  t.l  i.l
  :(weld i.l "/" $(l t.l))
::
::  +normalize-tape: resolve "." and ".." in a '/'-path, → "/normalized".
++  normalize-tape
  |=  p=tape
  ^-  tape
  =/  segs  (split-slash p)
  =|  stack=(list tape)
  |-  ^-  tape
  ?~  segs  (weld "/" (join-slash (flop stack)))
  ?:  ?|(=("" i.segs) =("." i.segs))  $(segs t.segs)
  ?:  =(".." i.segs)
    $(segs t.segs, stack ?~(stack ~ t.stack))
  $(segs t.segs, stack [i.segs stack])
::
::  +resolve-href: a gemtext link found on [current] → some absolute urb:// url
::  (navigable internally), or ~ for a foreign/web link (caller uses the raw href).
++  resolve-href
  |=  [current=tape link=tape]
  ^-  (unit tape)
  ?:  (has-prefix "urb://" link)  `link
  ?:  (foreign-scheme link)  ~
  ?~  cur=(parse-urb-tape current)  ~
  =/  combined=tape
    ?:  ?=([%'/' *] link)  link
    :(weld (dir-of path.u.cur) "/" link)
  `:(weld "urb://" ship.u.cur (normalize-tape combined))
::
::  +urb-of: rebuild a "urb://~ship/spur" tape from a ship + spur path.
++  urb-of
  |=  [=ship spur=path]
  ^-  tape
  =/  ps=tape  (trip (spat spur))
  :(weld "urb://" (trip (scot %p ship)) ?:(=("" ps) "/" ps))
::
::  +render-gmi-html: gemtext body → an HTML fragment, resolving links against
::  [current] (the url of the page being rendered).
++  render-gmi-html
  |=  [current=tape body=@t]
  ^-  tape
  ::  +shut: close an open <ul> (takes the current list state, no closure capture).
  =/  shut  |=([o=tape il=?] ^-(tape ?:(il (weld o "</ul>") o)))
  =/  lines=(list @t)  (to-wain:format body)
  =|  out=tape
  =/  pre=?  |           ::  NB: *? bunts to & (yes), so init these explicitly
  =/  inlist=?  |
  =|  prebuf=(list @t)   ::  buffered ``` lines (joined with +of-wain on close)
  |-  ^-  tape
  ?~  lines
    =?  out  pre     :(weld out "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>")
    =?  out  inlist  (weld out "</ul>")
    out
  =/  ln=tape  (trip i.lines)
  ?:  pre
    ?.  =("```" ln)  $(lines t.lines, prebuf [i.lines prebuf])
    %=  $
      lines   t.lines
      pre     |
      prebuf  ~
      out     :(weld out "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>")
    ==
  ?:  =("```" ln)
    $(lines t.lines, pre &, prebuf ~, out (shut out inlist), inlist |)
  ?:  (has-prefix "### " ln)
    $(lines t.lines, inlist |, out :(weld (shut out inlist) "<h3>" (esc (slag 4 ln)) "</h3>"))
  ?:  (has-prefix "## " ln)
    $(lines t.lines, inlist |, out :(weld (shut out inlist) "<h2>" (esc (slag 3 ln)) "</h2>"))
  ?:  (has-prefix "# " ln)
    $(lines t.lines, inlist |, out :(weld (shut out inlist) "<h1>" (esc (slag 2 ln)) "</h1>"))
  ?:  (has-prefix "=> " ln)
    =/  rest  (slag 3 ln)
    =/  sp  (find " " rest)
    =/  raw=tape   ?~(sp rest (scag u.sp rest))
    =/  desc=tape  ?~(sp rest (ltrim (slag +(u.sp) rest)))
    =/  res  (resolve-href current raw)
    =/  anchor=tape
      ?^  res
        ::  internal: route a urb:// link back through the reader
        :(weld "<a href=\"/apps/lattice?url=" (esc u.res) "\">" (esc desc) "</a>")
      ?:  (safe-ext raw)
        ::  external web/mail link — new tab, no referrer leak of our ship url
        :(weld "<a href=\"" (esc raw) "\" target=\"_blank\" rel=\"noopener noreferrer\">" (esc desc) "</a>")
      ::  any other scheme (javascript:, data:, …) is NOT linkable — a hostile
      ::  page must not get a clickable javascript: href in our session. Show text.
      (esc desc)
    $(lines t.lines, inlist |, out :(weld (shut out inlist) "<p class=\"link\">" anchor "</p>"))
  ?:  (has-prefix "* " ln)
    =/  o2  ?:(inlist out (weld out "<ul>"))
    $(lines t.lines, inlist &, out :(weld o2 "<li>" (esc (slag 2 ln)) "</li>"))
  ?:  (has-prefix "> " ln)
    $(lines t.lines, inlist |, out :(weld (shut out inlist) "<blockquote>" (esc (slag 2 ln)) "</blockquote>"))
  ?:  =("" ln)
    $(lines t.lines, inlist |, out (shut out inlist))
  $(lines t.lines, inlist |, out :(weld (shut out inlist) "<p>" (esc ln) "</p>"))
::
::  A cord ('...'), not a tape ("..."), so the CSS braces are literal — `{` opens
::  interpolation inside a tape.
++  page-css
  ^-  tape
  %-  trip
  '*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;color:#111;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#1a1a1a}}.bar{display:flex;gap:6px;padding:8px;position:sticky;top:0;background:inherit;border-bottom:1px solid #8884}.bar input{flex:1;padding:6px 8px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.bar button{padding:6px 12px;font:inherit;cursor:pointer}.bar .navbtn{padding:6px 8px;text-decoration:none;color:inherit;align-self:center;white-space:nowrap}#bm{cursor:pointer}main{max-width:46rem;margin:0 auto;padding:16px;overflow-wrap:anywhere}h1{font-size:1.6rem}h2{font-size:1.3rem}h3{font-size:1.1rem}a{color:#1a6ed8}@media(prefers-color-scheme:dark){a{color:#6db3ff}}p.link{margin:.3rem 0}blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid #8886;color:#8a8a8a}pre{background:#8881;padding:10px;overflow-x:auto;border-radius:6px;white-space:pre}ul{padding-left:1.4rem}.err{color:#c0392b}.note{margin-top:2.5rem;padding-top:1rem;border-top:1px solid #8883;font-size:.85rem;color:#8a8a8a}'
::
::  +page-js: the reader's only client-side code — bookmark sync via the ship's
::  %settings (same place the native app uses: desk "lattice", bucket
::  "bookmarks", entry "list"; value is a JSON-stringified [{url,title}]). Read is
::  a same-origin scry GET, write a channel poke. A single-quote cord, so it must
::  contain no ' or \ (uses double-quotes + backtick templates; ★/☆ are literal).
++  page-js
  ^-  tape
  %-  trip
  'var B=document.body.dataset,SHIP=B.ship||"",URL=B.url||"";function bmRead(cb){fetch("/~/scry/settings/desk/lattice.json",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null;}).then(function(d){var raw=d&&((d.desk&&d.desk.bookmarks&&d.desk.bookmarks.list)||(d.bookmarks&&d.bookmarks.list));var list=[];try{if(raw)list=JSON.parse(raw);}catch(e){}cb(list);}).catch(function(){cb([]);});}function bmWrite(list,cb){var cid="lat-bm-"+Date.now()+"-"+Math.floor(Math.random()*99999);var body=[{id:1,action:"poke",ship:SHIP.replace("~",""),app:"settings",mark:"settings-event",json:{"put-entry":{desk:"lattice","bucket-key":"bookmarks","entry-key":"list",value:JSON.stringify(list)}}}];fetch("/~/channel/"+cid,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(){if(cb)cb();}).catch(function(){if(cb)cb();});}function bmToggle(){if(!URL)return;bmRead(function(list){var i=-1,k;for(k=0;k<list.length;k++){if(list[k].url===URL){i=k;break;}}if(i>=0)list.splice(i,1);else list.push({url:URL,title:URL});bmWrite(list,function(){location.reload();});});}function bmEsc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");}function bmInit(){var star=document.getElementById("bm"),listEl=document.getElementById("bmlist");bmRead(function(list){var k,on=false;if(star&&URL){for(k=0;k<list.length;k++){if(list[k].url===URL){on=true;break;}}star.textContent=on?"★":"☆";}if(listEl){listEl.innerHTML=list.length?list.map(function(b){return `<p class="link"><a href="/apps/lattice?url=${encodeURIComponent(b.url)}">${bmEsc(b.title||b.url)}</a></p>`;}).join(""):"<p>No bookmarks yet.</p>";}});}document.addEventListener("DOMContentLoaded",bmInit);'
::
::  +render-page: wrap an HTML fragment in the reader chrome (address bar,
::  bookmark toggle, Bookmarks link, CSS, and the bookmark script). [ourpatp] is
::  this ship's "~ship" (the script needs it to poke %settings).
++  render-page
  |=  [ourpatp=tape current=tape inner=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    ::  ship + current url ride in body data-attributes (HTML-attribute context,
    ::  which +esc handles correctly) rather than a <script> string, which
    ::  HTML-escaping does NOT make safe (a \ or newline in the url would break
    ::  out of a JS string literal).
    "<title>lattice</title><style>"  page-css  "</style></head>"
    "<body data-ship=\""  (esc ourpatp)  "\" data-url=\""  (esc current)  "\">"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    "<input name=\"url\" value=\""  (esc current)
    "\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\">"
    "<button type=\"submit\">Go</button>"
    "<button type=\"button\" id=\"bm\" onclick=\"bmToggle()\" title=\"Bookmark\">&#9734;</button>"
    "<a class=\"navbtn\" href=\"/apps/lattice?view=bookmarks\">Bookmarks</a>"
    "</form><main>"  inner  "</main>"
    "<script>"  page-js  "</script></body></html>"
  ==
::
::  +render-doc: render a gemtext [body] fetched as [current] into a full page.
++  render-doc
  |=  [ourpatp=tape current=tape body=@t]
  ^-  @t
  (render-page ourpatp current (render-gmi-html current body))
::
::  +home-note: a subtle footer (own home page only) pointing at the native app,
::  so nobody mistakes this lightweight reader for the only UI.
++  home-note
  ^-  tape
  %-  zing
  :~  "<p class=\"note\">You're using the lightweight web reader. "
      "<a href=\"https://lattice.nisfeb.com\" target=\"_blank\" rel=\"noopener noreferrer\">"
      "Try the full-featured native app &rarr;</a></p>"
  ==
::
::  +render-home: like +render-doc but with the native-app note appended.
++  render-home
  |=  [ourpatp=tape current=tape body=@t]
  ^-  @t
  (render-page ourpatp current :(weld (render-gmi-html current body) home-note))
::
::  +render-error-page: a styled error page (bad url, 404, peer timeout).
++  render-error-page
  |=  [ourpatp=tape current=tape msg=tape]
  ^-  @t
  (render-page ourpatp current :(weld "<p class=\"err\">" (esc msg) "</p>"))
::
::  +render-bookmarks: the bookmarks view — a shell the script fills from %settings.
++  render-bookmarks
  |=  ourpatp=tape
  ^-  @t
  (render-page ourpatp "" "<h1>Bookmarks</h1><div id=\"bmlist\"></div>")
::
::  ── private knowledge store (programmatic agent / MCP access; NOT published) ──
::
::  +know-key: parse an agent-supplied key ("projects/x/notes") to a path, or ~
::  if it isn't a valid path-like key.
++  know-key
  |=  k=@t
  ^-  (unit path)
  =/  t=tape  (trip k)
  =/  full=tape  ?:(?=([%'/' *] t) t ['/' t])
  =/  res  (mule |.((stab (crip full))))
  ?:(?=(%& -.res) `p.res ~)
::
::  +norm-tag: normalize a tag for matching — lower-case. Tags are free-form and
::  multilingual; this just dedupes case variants (the set handles duplicates).
++  norm-tag
  |=  t=@t
  ^-  @t
  (crip (cass (trip t)))
::  +tags-json: a set of tags as a sorted JSON string array, as ['tags' a+...].
++  tags-json
  |=  tags=(set @t)
  ^-  [@t json]
  :-  'tags'
  :-  %a
  (turn (sort ~(tap in tags) aor) |=(t=@t s+t))
::
++  know-entry-json
  |=  [kp=path e=know-entry]
  ^-  json
  %-  pairs:enjs:format
  :~  ['key' s+(spat kp)]
      ['body' s+body.e]
      ['updated' s+(scot %da updated.e)]
      (tags-json tags.e)
  ==
::
::  +know-list-json: keys + metadata (no bodies) — for listing/trash views.
++  know-list-json
  |=  m=(map path know-entry)
  ^-  json
  %-  pairs:enjs:format
  :~  ['count' (numb:enjs:format ~(wyt by m))]
      :-  'keys'
      :-  %a
      %+  turn  ~(tap by m)
      |=  [kp=path e=know-entry]
      ^-  json
      %-  pairs:enjs:format
      :~  ['key' s+(spat kp)]
          ['updated' s+(scot %da updated.e)]
          ['bytes' (numb:enjs:format (met 3 body.e))]
          (tags-json tags.e)
      ==
  ==
::
::  +know-all-json: keys + bodies — for the search tool to filter client-side.
++  know-all-json
  |=  m=(map path know-entry)
  ^-  json
  %-  pairs:enjs:format
  :_  ~
  :-  'items'
  :-  %a
  %+  turn  ~(tap by m)
  |=([kp=path e=know-entry] (know-entry-json kp e))
::
::  +know-tags-json: the tag vocabulary across the store as {count, tags:[{tag,
::  count}]}, sorted by count desc then alpha. The vocabulary lets agents reuse
::  existing tags (curb sprawl); the counts are the lattice-side facet data.
++  know-tags-json
  |=  m=(map path know-entry)
  ^-  json
  =/  all=(list @t)  (zing (turn ~(val by m) |=(e=know-entry ~(tap in tags.e))))
  =/  counts=(map @t @ud)
    %+  roll  all
    |=  [t=@t acc=(map @t @ud)]
    (~(put by acc) t +((~(gut by acc) t 0)))
  %-  pairs:enjs:format
  :~  ['count' (numb:enjs:format ~(wyt by counts))]
      :-  'tags'
      :-  %a
      %+  turn
        %+  sort  ~(tap by counts)
        |=  [[a=@t x=@ud] [b=@t y=@ud]]
        ?:(=(x y) (aor a b) (gth x y))
      |=  [t=@t n=@ud]
      (pairs:enjs:format ~[['tag' s+t] ['count' (numb:enjs:format n)]])
  ==
::
::  ── explore / discovery (served synchronously from the live store) ──
::  Faceting is +know-tags-json (the vocabulary + counts). Filtering is below:
::  obelisk-independent so the Explore UI works whether or not %obelisk is up.
::
::  +split-on: split a tape on a delimiter, dropping empty segments. Parses
::  comma-separated query params, e.g. ?tags=urbit,design → ["urbit" "design"].
++  split-on
  |=  [sep=@tD t=tape]
  ^-  (list tape)
  =|  acc=(list tape)
  =|  cur=tape
  |-  ^-  (list tape)
  ?~  t
    %+  skip  (flop ?~(cur acc [(flop cur) acc]))
    |=(s=tape =(~ s))
  ?:  =(sep i.t)
    $(t t.t, cur ~, acc ?~(cur acc [(flop cur) acc]))
  $(t t.t, cur [i.t cur])
::  +parse-tags: a comma-separated tag param → a set of normalized (lower-case)
::  tags, matching how stored tags are normalized by +norm-tag.
++  parse-tags
  |=  raw=@t
  ^-  (set @t)
  (sy (turn (split-on ',' (trip raw)) |=(s=tape (norm-tag (crip s)))))
::  +matches-explore: does one live entry pass the explore filter?
::    tags  required tags (empty = no tag filter)
::    all   & = entry must carry ALL tags;  | = ANY of them
::    q     lower-cased substring sought in the key text or the body (empty = skip)
++  matches-explore
  |=  [kp=path e=know-entry tags=(set @t) all=? q=tape]
  ^-  ?
  ?&  ?|  =(~ tags)
          ?:  all
            (levy ~(tap in tags) |=(t=@t (~(has in tags.e) t)))
          (lien ~(tap in tags) |=(t=@t (~(has in tags.e) t)))
      ==
      ?|  =(~ q)
          ?|  !=(~ (find q (cass (trip (spat kp)))))
              !=(~ (find q (cass (trip body.e))))
          ==
      ==
  ==
::  +know-explore: filter the live store by tags (AND/OR) and a text query.
::  Returns a sub-map; format it with +know-list-json for the listing shape.
++  know-explore
  |=  [m=(map path know-entry) tags=(set @t) all=? q=@t]
  ^-  (map path know-entry)
  =/  ql=tape  (cass (trip q))
  %-  malt
  %+  skim  ~(tap by m)
  |=  [kp=path e=know-entry]
  (matches-explore kp e tags all ql)
::
::  ── obelisk knowledge index (metadata-only mirror; no bodies, no vectors) ──
::  obelisk (jackfoxy/obelisk) is an optional relational index for discovery. It
::  has NO scries: we poke %obelisk-action [%tape2 %lattice <urql>] and don't
::  await the result (mirror writes are fire-and-forget; rebuild via reindex).
::
::  Mirror writes are FIRE-AND-FORGET: if %obelisk isn't installed, gall just
::  negative-acks the poke (on-agent ignores it) — the store works without it.
::  +urq-esc: escape a urQL single-quoted string literal. obelisk's parser uses
::  BACKSLASH escaping (verified: 'it\'s' is accepted, 'it''s' is a parse error),
::  so a quote (39) becomes \' and a backslash (92) becomes \\. A tag is free-form
::  (norm-tag only lower-cases), so a value like it's would otherwise break or
::  inject into the mirror query; keys are path-validated and can't contain either,
::  but we escape them too as defense in depth.
++  urq-esc
  |=  s=tape
  ^-  tape
  %-  zing
  %+  turn  s
  |=  c=@tD
  ^-  tape
  ?:  =(c 39)  ~[`@tD`92 `@tD`39]   :: ' -> \'
  ?:  =(c 92)  ~[`@tD`92 `@tD`92]   :: \ -> \\
  ~[c]
::  +obelisk-create-urql: (re)create the schema. Atomic — fails harmlessly if it
::  already exists, so it's safe to poke right before a populate.
++  obelisk-create-urql
  ^-  tape
  %-  zing
  :~  "CREATE DATABASE lattice;"
      "CREATE TABLE knowledge (item @t, updated @da) PRIMARY KEY (item);"
      "CREATE TABLE tags (item @t, tag @t) PRIMARY KEY (item, tag);"
  ==
::  +obelisk-row-urql: the INSERTs mirroring one live entry (the knowledge row +
::  one tags row per tag). [k] is the item key as text.
++  obelisk-row-urql
  |=  [k=tape e=know-entry]
  ^-  tape
  =/  ek=tape  (urq-esc k)
  %-  zing
  :-  ;:(weld "INSERT INTO knowledge (item, updated) VALUES ('" ek "', " (trip (scot %da updated.e)) ");")
  %+  turn  ~(tap in tags.e)
  |=(t=@t ;:(weld "INSERT INTO tags (item, tag) VALUES ('" ek "', '" (urq-esc (trip t)) "');"))
::  +obelisk-populate-urql: rebuild the index from the live `know` map — clear
::  both tables, then re-insert every item + its tags.
++  obelisk-populate-urql
  |=  know=(map path know-entry)
  ^-  tape
  %-  zing
  :-  "TRUNCATE TABLE knowledge;TRUNCATE TABLE tags;"
  %+  turn  ~(tap by know)
  |=([kp=path e=know-entry] (obelisk-row-urql (trip (spat kp)) e))
::  +obelisk-del-item-urql: remove one item and all its tag rows from the index.
::  DELETE..WHERE is idempotent — deleting an absent item is a harmless no-op.
++  obelisk-del-item-urql
  |=  k=tape
  ^-  tape
  =/  ek=tape  (urq-esc k)
  ;:  weld
    "DELETE FROM knowledge WHERE item = '"  ek  "';"
    "DELETE FROM tags WHERE item = '"  ek  "';"
  ==
::  +mirror-urql: incremental index update for ONE applied know-action. Reads the
::  result entry from `st` (the POST-mutation state) so tag rows reflect the
::  outcome. Returns "" when there's nothing to mirror (bad key / no-op / the
::  action targeted a non-live item). Pair with a periodic +obelisk-populate-urql
::  reindex to repair any drift.
++  mirror-urql
  |=  [act=know-action st=state-9]
  ^-  tape
  ::  upsert one item's row + tags from the post-mutation state (save/restore)
  =/  upsert
    |=  key=@t
    ^-  tape
    ?~  kp=(know-key key)  ""
    ?~  live=(~(get by know.st) u.kp)  ""
    =/  k=tape  (trip (spat u.kp))
    (weld (obelisk-del-item-urql k) (obelisk-row-urql k u.live))
  ::  narrow on the action tag first — `key` sits at a different axis per branch,
  ::  so it can't be read off the bare `know-action` fork.
  ?-  -.act
      %save     (upsert key.act)
      %restore  (upsert key.act)
  ::
      %del
    ?~  kp=(know-key key.act)  ""
    (obelisk-del-item-urql (trip (spat u.kp)))
  ::
      %tag
    ?~  kp=(know-key key.act)  ""
    ?.  (~(has by know.st) u.kp)  ""
    =/  k=tape  (urq-esc (trip (spat u.kp)))
    =/  t=tape  (urq-esc (trip (norm-tag tag.act)))
    ;:  weld
      "DELETE FROM tags WHERE item = '"  k  "' AND tag = '"  t  "';"
      "INSERT INTO tags (item, tag) VALUES ('"  k  "', '"  t  "');"
    ==
  ::
      %untag
    ?~  kp=(know-key key.act)  ""
    =/  k=tape  (urq-esc (trip (spat u.kp)))
    =/  t=tape  (urq-esc (trip (norm-tag tag.act)))
    ;:(weld "DELETE FROM tags WHERE item = '" k "' AND tag = '" t "';")
  ==
::  +ob-err-json / +ob-tang-text: a {ok:false, error} object, and a tang → cord.
++  ob-err-json
  |=  msg=@t
  ^-  json
  (pairs:enjs:format ~[['ok' b+|] ['error' s+msg]])
::  +ob-dime-cord: render one typed cell for display. Text auras (t/ta/tas) ARE
::  their cord already — emit it raw (scot would knot-escape '/' etc.); other
::  auras (da dates, ud numbers, …) render via +scot.
++  ob-dime-cord
  |=  d=ob-dime
  ^-  @t
  ?:  ?=(?(%t %ta %tas) p.d)  q.d
  (scot d)
++  ob-tang-text
  |=  =tang
  ^-  @t
  %-  crip  %-  zing
  (turn tang |=(t=tank (weld ~(ram re t) " ")))
::  +obelisk-result-json: decode obelisk's raw %noun query result for the Explore
::  pane. Success is [%.y (list ob-cmd-result)] → {ok, action, relation, count,
::  columns:[…], rows:[[…]]}; error is [%.n tang] → {ok:false, error}. The raw
::  noun is clammed inside a +mule so a malformed/changed result becomes an error
::  object rather than crashing the agent.
++  obelisk-result-json
  |=  non=*
  ^-  json
  =/  res
    %-  mule
    |.  ^-  json
    ?@  non  (ob-err-json 'empty obelisk result')
    ?.  ;;(? -.non)
      (ob-err-json (ob-tang-text ;;(tang +.non)))
    (ob-results-json ;;((list ob-cmd-result) +.non))
  ?:(?=(%& -.res) p.res (ob-err-json 'unreadable obelisk result'))
::  +ob-results-json: flatten the cmd-results, pull the first %result-set's rows
::  plus action/relation/count, and render each cell with +scot (aura-aware).
++  ob-results-json
  |=  crs=(list ob-cmd-result)
  ^-  json
  =/  rs=(list ob-result)  (zing (turn crs |=(c=ob-cmd-result +.c)))
  =/  action=@t  ''
  =/  relation=@t  ''
  =/  count=(unit @ud)  ~
  =/  vecs=(list ob-vector)  ~
  |-
  ?^  rs
    %=  $
      rs        t.rs
      action    ?:(?=(%action -.i.rs) action.i.rs action)
      relation  ?:(?=(%relation -.i.rs) relation.i.rs relation)
      count     ?:(?=(%vector-count -.i.rs) `count.i.rs count)
      vecs      ?:(?=(%result-set -.i.rs) +.i.rs vecs)
    ==
  =/  cols=(list @t)
    ?~  vecs  ~
    (turn `(list ob-cell)`+.i.vecs |=(c=ob-cell p.c))
  =/  rows=(list json)
    %+  turn  vecs
    |=  v=ob-vector
    ^-  json
    a+(turn `(list ob-cell)`+.v |=(c=ob-cell s+(ob-dime-cord q.c)))
  %-  pairs:enjs:format
  :~  ['ok' b+&]
      ['action' s+action]
      ['relation' s+relation]
      ['count' (numb:enjs:format ?~(count (lent vecs) u.count))]
      ['columns' a+(turn cols |=(c=@t s+c))]
      ['rows' a+rows]
  ==
::  +migrate-8-9: state-8 → state-9 — carry every field forward and add the
::  (empty) in-flight obelisk-query slot. Pure, so on-load's upgrade is testable.
++  migrate-8-9
  |=  s=state-8
  ^-  state-9
  :*  %9  content.s  published.s  pending.s  subs.s  fetches.s
      manifest.s  home.s  browse.s  know.s  trash.s  ~
  ==
::
::  +do-know: apply a knowledge action. save = create/overwrite (+ untrash);
::  del = SOFT delete (move to recoverable trash); restore = trash → live.
::  Invalid keys / missing entries are no-ops. Never grows/publishes.
++  do-know
  |=  [now=@da act=know-action st=state-9]
  ^-  state-9
  ?-  -.act
      %save
    ?~  kp=(know-key key.act)  st
    ::  preserve tags/vector across a re-save (whether the key was live or trashed)
    =/  prior=(unit know-entry)
      ?^  e=(~(get by know.st) u.kp)  e
      (~(get by trash.st) u.kp)
    =/  =know-entry
      [body.act now ?~(prior ~ tags.u.prior) ?~(prior ~ vector.u.prior)]
    %=  st
      know   (~(put by know.st) u.kp know-entry)
      trash  (~(del by trash.st) u.kp)
    ==
  ::
      %del
    ?~  kp=(know-key key.act)  st
    ?~  e=(~(get by know.st) u.kp)  st
    %=  st
      know   (~(del by know.st) u.kp)
      trash  (~(put by trash.st) u.kp u.e)
    ==
  ::
      %restore
    ?~  kp=(know-key key.act)  st
    ?~  e=(~(get by trash.st) u.kp)  st
    %=  st
      trash  (~(del by trash.st) u.kp)
      know   (~(put by know.st) u.kp u.e)
    ==
  ::
      %tag
    ?~  kp=(know-key key.act)  st
    ?~  e=(~(get by know.st) u.kp)  st
    =.  tags.u.e  (~(put in tags.u.e) (norm-tag tag.act))
    st(know (~(put by know.st) u.kp u.e))
  ::
      %untag
    ?~  kp=(know-key key.act)  st
    ?~  e=(~(get by know.st) u.kp)  st
    =.  tags.u.e  (~(del in tags.u.e) (norm-tag tag.act))
    st(know (~(put by know.st) u.kp u.e))
  ==
--
