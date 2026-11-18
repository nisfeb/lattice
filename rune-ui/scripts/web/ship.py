#!/usr/bin/env python3
"""Puts the web build on a ship as pages of the owner's, and takes it off.

A ship has no route for a folder of files, but it serves an owner's own html
and js pages as they are, at /apps/lattice/f/<page>, with the right type and
in the ship's own origin. So the build goes up as pages under one folder:

  <under>/index      html: the page to open, /apps/lattice/f/<under>/index
  <under>/app        js: wasm-bindgen's loader, its imports pointed at the pages below
  <under>/s-<name>   js: each of Rune's snippets
  <under>/w0, w1...  js: the wasm, gzipped, as base64 text in pieces

  ship.py put  URL COOKIE_FILE [--under rune] [--web target/web] [--piece 900000]
  ship.py drop URL COOKIE_FILE [--under rune]
  ship.py pack OUT_DIR [--under rune] [--web target/web]     writes the pages as files, to look at

Nothing is written outside <under>. `drop` deletes that folder's pages and nothing else.
"""
import argparse, base64, gzip, os, re, sys, urllib.parse, urllib.request

INDEX = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>lattice</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:none}#status{font:16px system-ui;padding:24px;line-height:1.5}</style>
<div id="status">Loading…</div>
<script type="module">
const status = document.querySelector('#status');
if (!navigator.gpu) {
    // this client draws with WebGPU and has no other way to draw
    status.innerHTML = 'This browser has no WebGPU, which this version of lattice draws with. <a id="classic" href="/apps/lattice/app">Open lattice in the usual web client</a>.';
} else {
    try {
        const { default: init } = await import('./app');
        const parts = await Promise.all([...Array(PIECES).keys()].map((i) => import('./w' + i)));
        const gz = Uint8Array.from(atob(parts.map((p) => p.default).join('')), (c) => c.charCodeAt(0));
        const wasm = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        await init({ module_or_path: wasm });
        status.remove();
    } catch (error) {
        status.textContent = String(error);
        console.error(error);
    }
}
</script>
</html>
"""

def pages(web, piece):
    """The build as pages: name (under the folder), kind, text."""
    out = []
    app = open(os.path.join(web, 'app.js'), encoding='utf-8').read()
    snippets = {}
    for root, _, files in os.walk(os.path.join(web, 'snippets')):
        for f in files:
            if f.endswith('.js'):
                rel = './' + os.path.relpath(os.path.join(root, f), web).replace(os.sep, '/')
                name = 's-' + re.sub(r'[^a-z0-9]+', '-', f[:-3].lower()).strip('-')
                assert name not in [n for n, _ in snippets.values()], 'two snippets with one name: ' + name
                snippets[rel] = (name, open(os.path.join(root, f), encoding='utf-8').read())
    for rel, (name, text) in snippets.items():
        assert not re.search(r"""^\s*import\s.*from\s+['"]\.""", text, re.M), 'a snippet imports a file beside it: ' + rel
        # only where a file is imported from. The same text is also the name the wasm asks for its imports by, which must stay
        app = re.sub(r'''(\bfrom\s*)(['"])''' + re.escape(rel) + r'''\2''', lambda m: m.group(1) + m.group(2) + './' + name + m.group(2), app)
        out.append((name, 'js', text))
    assert not re.search(r'''\bfrom\s*['"]\./snippets/''', app), 'an import of a snippet was not pointed at its page'
    # a multiple of four characters a piece, so the pieces join into one base64 text
    b64 = base64.b64encode(gzip.compress(open(os.path.join(web, 'app_bg.wasm'), 'rb').read(), 9, mtime=0)).decode()
    piece -= piece % 4
    parts = [b64[i:i + piece] for i in range(0, len(b64), piece)]
    out += [('w%d' % i, 'js', 'export default "%s";\n' % p) for i, p in enumerate(parts)]
    out.append(('app', 'js', app))
    # last, so the page to open is there only once everything it loads is
    out.append(('index', 'html', INDEX.replace('PIECES', str(len(parts)))))
    return out

def call(url, cookie, method, path, body=None):
    req = urllib.request.Request(url + '/apps/lattice/' + path, data=body, method=method, headers={'cookie': cookie, 'origin': url})
    try:
        with urllib.request.urlopen(req, timeout=300) as r: return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('what', choices=['put', 'drop', 'pack'])
    ap.add_argument('where')
    ap.add_argument('cookie_file', nargs='?')
    ap.add_argument('--under', default='rune')
    ap.add_argument('--web', default='target/web')
    ap.add_argument('--piece', type=int, default=900000)
    a = ap.parse_args()
    assert re.fullmatch(r'[a-z0-9-]+', a.under), 'the folder is one plain name'
    if a.what == 'pack':
        os.makedirs(a.where, exist_ok=True)
        for name, kind, text in pages(a.web, a.piece):
            open(os.path.join(a.where, name + '.' + kind), 'w', encoding='utf-8').write(text)
            print('%-14s %9d' % (name + '.' + kind, len(text.encode())))
        return
    url = a.where.rstrip('/'); cookie = open(a.cookie_file).read().strip()
    if a.what == 'drop':
        code, text = call(url, cookie, 'POST', 'page-del?name=' + a.under)
        print('drop', a.under, code, text[:120]); sys.exit(0 if code == 200 else 1)
    call(url, cookie, 'POST', 'folder-new?name=' + a.under)
    total = 0
    # each put is marked with its time. A ship does not bring a deleted page back when it is saved again with the very
    # text it had: it answers 200, serves it, and leaves it out of the tree. The mark makes the text new every time
    import time
    mark = 'put %d' % time.time()
    for name, kind, text in pages(a.web, a.piece):
        text = ('<!-- %s -->\n' if kind == 'html' else '// %s\n') % mark + text
        body = text.encode(); total += len(body)
        code, said = call(url, cookie, 'POST', 'page-save?name=%s&type=%s' % (urllib.parse.quote(a.under + '/' + name, safe=''), kind), body)
        print('%-22s %9d  %s %s' % (a.under + '/' + name, len(body), code, '' if code == 200 else said[:160]))
        if code != 200: sys.exit('stopped: the ship refused ' + name)
    print('put %d bytes. Open %s/apps/lattice/f/%s/index' % (total, url, a.under))

main()
