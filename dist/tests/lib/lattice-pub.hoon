::  pure lattice-pub helper tests (faced import to avoid wildcard face clashes)
/+  *test, lp=lattice-pub
|%
++  base  `path`/lattice/pub/vault
++  test-strip-pub
  ;:  weld
    (expect-eq !>(`path`/a/gmi) !>((strip-pub:lp /pub/a/gmi)))
    (expect-eq !>(`path`/a/gmi) !>((strip-pub:lp /a/gmi)))
    (expect-eq !>(`path`~) !>((strip-pub:lp ~)))
  ==
++  test-key-to-rail
  ;:  weld
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/a %gmi]) !>((key-to-rail:lp base /pub/a/gmi)))
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/a/b %gmi]) !>((key-to-rail:lp base /pub/a/b/gmi)))
    (expect-eq !>(`(unit vrail:lp)`[~ /lattice/pub/vault/index %gmi]) !>((key-to-rail:lp base /pub/index/gmi)))
    (expect-eq !>(`(unit vrail:lp)`~) !>((key-to-rail:lp base ~)))
  ==
++  test-to-pub-row
  ;:  weld
    (expect-eq !>(`pub-row:lp`[~2026.1.1 2 (sham 'hi')]) !>((to-pub-row:lp 'hi' ~2026.1.1)))
    (expect-eq !>(`pub-row:lp`[~2026.2.2 5 (sham 'hello')]) !>((to-pub-row:lp 'hello' ~2026.2.2)))
  ==
++  test-derive-pub-index
  =/  in=(map path page:lp)  (my /pub/a/gmi^'hi' /pub/b/gmi^'hello' ~)
  =/  want=pub-index:lp
    (my /pub/a/gmi^[~2026.1.1 2 (sham 'hi')] /pub/b/gmi^[~2026.1.1 5 (sham 'hello')] ~)
  (expect-eq !>(want) !>((derive-pub-index:lp in ~2026.1.1)))
--
