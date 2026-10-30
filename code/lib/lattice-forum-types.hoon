::  lib/lattice-forum-types: the forum's types, ported from furum's
::  sur/furum.hoon and cut to boards, posts, threaded comments, votes,
::  roles and moderation. Payment, following and the registry are not here.
::
|%
::  identity types
::
+$  board-name    @tas
+$  post-id       @ud
+$  comment-id    @ud
+$  role          ?(%mod %poster %reader)
::
::  board metadata
::
+$  board-info
  $:  name=board-name
      title=@t
      description=@t
      host=@p
      created=@da
      default-role=role
      public=?
  ==
::
::  a post
::
+$  post
  $:  id=post-id
      author=@p
      title=@t
      url=(unit @t)
      body=(unit @t)
      created=@da
      up-votes=(set @p)
      down-votes=(set @p)
      comment-count=@ud
  ==
::
::  a comment
::
+$  comment
  $:  id=comment-id
      parent=(unit comment-id)
      author=@p
      body=@t
      created=@da
      up-votes=(set @p)
      down-votes=(set @p)
  ==
::
::  vote target discriminator
::
+$  vote-target
  $%  [%post id=post-id]
      [%comment post=post-id id=comment-id]
  ==
::
::  auto-prune: drop posts scoring under min-score once older than after
::
+$  prune-config
  $:  min-score=@ud
      after=@dr
  ==
::
::  full board state (on the host ship)
::
+$  board
  $:  info=board-info
      roles=(map @p role)
      next-post-id=post-id
      posts=(map post-id post)
      comments=(map post-id (map comment-id comment))
      next-comment-ids=(map post-id comment-id)
      pinned=(set post-id)
      sidebar=@t
      prune=(unit prune-config)
  ==
::
::  the board card, as stored: a version tag and the board's info
::
+$  card  [%1 board-info]
::
::  actions: pokes to a board host
::
+$  action
  $%  ::  board management (host ship only)
      [%create-board name=board-name title=@t description=@t default-role=role]
      [%delete-board name=board-name]
      ::  moderation
      [%set-role name=board-name who=@p =role]
      [%edit-board-info name=board-name title=@t description=@t]
      ::  content
      [%new-post name=board-name title=@t url=(unit @t) body=(unit @t)]
      [%edit-post name=board-name id=post-id title=@t body=(unit @t)]
      [%delete-post name=board-name id=post-id]
      ::  comments
      [%new-comment name=board-name post=post-id parent=(unit comment-id) body=@t]
      [%delete-comment name=board-name post=post-id id=comment-id]
      ::  votes
      [%upvote name=board-name target=vote-target]
      [%downvote name=board-name target=vote-target]
      [%remove-vote name=board-name target=vote-target]
      ::  board settings
      [%pin-post name=board-name id=post-id pinned=?]
      [%set-sidebar name=board-name sidebar=@t]
      [%set-public name=board-name public=?]
      [%set-prune name=board-name prune=(unit prune-config)]
  ==
--
