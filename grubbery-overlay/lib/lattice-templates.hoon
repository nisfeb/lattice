::  /lib/lattice-templates — the page-tree templates the app ships. Each is a
::  list of [rel-path kind raw-body]; the nexus lays them down under
::  /template/<name>/ on writer start (if absent) and instantiates a copy under
::  /page/<your-name>/ on demand, rewriting the leading /<name> path to yours.
::
::  Templates reference their own root by the template NAME (e.g. /site), so a
::  page's own-tree deps/links rewrite cleanly when instantiated elsewhere.
::  Kept small on purpose: instantiation is one writer round-trip per page.
::
|%
::  +site: a themed static site. An auto-index home lists the content pages;
::  a css theme styles every page (nearest-theme convention); publish the whole
::  folder to the clear web with one action.
::
++  site
  ^-  (list [rel=path kind=@tas body=@t])
  :~  [/index %index '']
      :-  /welcome
      :-  %md
      '''
      # Welcome

      This is your new site, made from a template.

      Edit this page, add more markdown pages in this folder, and drop a `theme`
      css page in to restyle everything. When you are ready, **publish** the
      whole folder to the clear web in one action.
      '''
      :-  /about
      :-  %md
      '''
      # About

      A page about you or your project. Just markdown — the site turns it into a
      themed page automatically when you publish.
      '''
      :-  /theme
      :-  %css
      '''
      body{font-family:system-ui,-apple-system,sans-serif;color:#1a1a1a;background:#fafafa;margin:0}
      .site,.page{max-width:46rem;margin:0 auto;padding:2rem 1.5rem}
      .site header h1{margin:0;font-size:2rem;border-bottom:2px solid #1a6ed8;padding-bottom:.6rem}
      .site .nav{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:1rem;margin-top:1.5rem}
      .site .nav a{display:block;padding:1rem;border:1px solid #ddd;border-radius:12px;text-decoration:none;color:#1a6ed8;background:#fff;text-transform:capitalize}
      .site .nav a:hover{border-color:#1a6ed8;box-shadow:0 4px 16px #1a6ed81f}
      .page h1,.page h2{border-bottom:1px solid #eee;padding-bottom:.2rem}
      .page a,.page .home a{color:#1a6ed8}
      @media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#161616}.site .nav a{background:#242424;border-color:#444}.page h1,.page h2{border-color:#333}}
      '''
  ==
--
