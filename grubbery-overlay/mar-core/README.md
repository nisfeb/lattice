# mar-core: core-desk marks the mirror needs

These are CLAY marks for the grubbery desk itself (deploy to /mar/...,
not /gub/mar/...). They belong upstream in gwbtc/grubbery and should be
removed here once upstream ships them.

1. gall-watch.hoon and gall-leave.hoon let the dojo (and anything
   poking through clay marks) drive grubbery's gall subscription
   bridge. Without gall-watch, a fiber-initiated watch has no mark to
   convert through. gall-leave is the cure for a ZOMBIE SUBSCRIPTION:
   gall's book says live, the far agent kicked while grubbery dozed,
   rewatching crashes %watch-not-unique, and facts go nowhere. Leave,
   then watch.

The clay-marcs under ../mar-clay/obelisk/ deploy to
/gub/mar/clay/obelisk/... and translate gall pokes AT the %obelisk
desk. They must be TYPED (see the file comment).
