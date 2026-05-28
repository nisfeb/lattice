::  /lib/catalog — urQL schema generators for the lattice content catalog.
::
::  The catalog is a federation-ready index of network content discovered
::  by crawling publishers' /manifest endpoints and listening to per-ship
::  /catalog update streams. It lives in %obelisk alongside the existing
::  `knowledge`/`tags` tables (in the same `lattice` database), with a
::  `catalog_*` prefix to keep the namespace clean.
::
::  See /docs/catalog.md for the design rationale, the pull-based
::  classifier pipeline that fills `category`/`tags` over time, and the
::  federation plan that lights up `source != our` rows in v2.
::
::  These gates are pure — they emit urQL strings the agent will poke
::  into %obelisk via the existing `%obelisk-action` `[%tape2 %lattice _]`
::  envelope (see +obelisk-create-urql in /lib/lattice.hoon for the
::  precedent). INSERT/UPDATE/DELETE helpers — one per relevant crawler
::  event, mirroring +mirror-urql — land in a follow-up PR with the
::  crawler implementation.
::
|%
::  +catalog-create-urql: (re)create the catalog tables. CREATE TABLE is
::  atomic in obelisk and fails harmlessly if a table already exists, so
::  this is safe to poke at every agent boot — matching the existing
::  +obelisk-create-urql pattern for the knowledge/tags tables.
::
::  Natural keys throughout. `source` is the @p that vouches for the row:
::  `our` for content this ship crawled itself, another @p for catalog
::  rows imported from a peer's /catalog-query in the federation v2 plan
::  — so a single `(publisher, path)` can have multiple rows, one per
::  vouching source. Identical `hash` from independent sources is
::  cross-corroboration and a future ranking signal.
::
::  Column-by-column notes:
::    catalog_pages.category   — '' (empty cord) until classified.
::    catalog_pages.cat_source — '' | 'rule' | 'llm' | 'rule-fallback' |
::                               'manual' | 'imported'. '' = not yet
::                               classified; the classifier pipeline
::                               writes one of the non-empty values.
::    catalog_pages.confidence — 0.0 when no confidence value is set;
::                               the LLM path writes 0.0-1.0.
::    catalog_pages.hash       — `sham` over the body cord (128-bit @uvH,
::                               matching state.manifest's hash type so
::                               the schemas stay congruent). Lets the
::                               crawler skip re-analyzing on no-change.
::    catalog_links.is_internal — 1 if target_url resolves to another
::                                catalog_pages row, 0 otherwise.
::                                (@ud as a boolean — obelisk's @f
::                                support is unverified at the schema-PR
::                                stage; will swap if confirmed.)
::    catalog_manifests        — caches each publisher's last /manifest
::                                hash for sweep diffing without re-fetch.
::    catalog_pending          — the classifier queue. `reason` is one
::                                of 'new' | 'changed' | 'requested' |
::                                'low-confidence'.
::
++  catalog-create-urql
  ^-  tape
  %-  zing
  :~  "CREATE TABLE catalog_pages (source @p, publisher @p, path @t, url @t, title @t, fetched @da, hash @uvH, category @t, cat_source @t, confidence @rs, word_count @ud, body_lines @ud) PRIMARY KEY (source, publisher, path);"
      "CREATE TABLE catalog_headings (source @p, publisher @p, path @t, position @ud, depth @ud, text @t) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog_links (source @p, publisher @p, path @t, position @ud, target_url @t, label @t, is_internal @ud) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog_tags (source @p, publisher @p, path @t, tag @t) PRIMARY KEY (source, publisher, path, tag);"
      "CREATE TABLE catalog_manifests (publisher @p, scanned @da, hash @uvH, raw @t) PRIMARY KEY (publisher);"
      "CREATE TABLE catalog_pending (source @p, publisher @p, path @t, queued @da, attempts @ud, reason @t) PRIMARY KEY (source, publisher, path);"
  ==
--
