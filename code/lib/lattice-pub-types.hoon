::  /lib/lattice-pub-types: frozen types for public-page and follow marks.
::
::  Kept separate from /lib/lattice-pub so publishing logic edits never alter
::  stored-page mark code and force kernel re-checks on deploy.
::
|%
+$  page  @t
+$  pub-action
  $%  [%save-page key=@t body=@t]
      [%del-page key=@t]
  ==
+$  pub-row    [updated=@da bytes=@ud hash=@uvH]
+$  pub-index  (map path pub-row)
+$  follows    (set @p)
+$  page-sub   [ship=@p pax=path]
+$  sub-action
  $%  [%follow ship=@p]
      [%unfollow ship=@p]
      [%sub-page =page-sub]
      [%unsub-page =page-sub]
  ==
--
