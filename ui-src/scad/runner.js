//  runner.js: OpenSCAD in a web worker, one worker per render.
//
//  OpenSCAD's main runs once per instance, so every render is a fresh
//  worker. The wasm is compiled once per session, on the page's thread
//  while it streams in, and the compiled module is handed to each worker,
//  where instantiating it takes a few milliseconds. The loader
//  (openscad.js, an ES module) is fetched once too and handed over as a
//  blob URL, so a worker makes no request of its own: offline, both come
//  from the service worker's cache.
//
//  A render that is no longer wanted is stopped by terminating its worker,
//  and one that runs past the time limit is stopped the same way.
//
//  The worker reaches nothing: its files are the page and its includes,
//  written into OpenSCAD's virtual file system before main runs, and the
//  fonts text() draws with. Those are fetched once a session too, and go
//  in under /fonts with a fonts.conf naming that folder, so Liberation Sans
//  is the default font, as on the desktop.

const WORKER = `
const log = [];
self.onmessage = async (e) => {
  const { glue, mod, files, args, out } = e.data;
  try {
    const OpenSCAD = (await import(glue)).default;
    const inst = await OpenSCAD({
      noInitialRun: true,
      preRun: [(M) => { if (files.some(([p]) => p === '/fonts/fonts.conf')) M.ENV.FONTCONFIG_FILE = '/fonts/fonts.conf'; }],
      print: (s) => log.push([0, s]),
      printErr: (s) => log.push([1, s]),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(mod, imports).then((i) => done(i, mod));
        return {};
      },
    });
    for (const [p, t] of files) {
      const parts = p.split('/').filter(Boolean);
      let d = '';
      for (const s of parts.slice(0, -1)) {
        d += '/' + s;
        try { inst.FS.mkdir(d); } catch (x) {}
      }
      inst.FS.writeFile(p, t);
    }
    let rc = 0;
    try { rc = inst.callMain(args); }
    catch (x) {
      rc = typeof x === 'number' ? x : (x && typeof x.status === 'number' ? x.status : 1);
      if (!(x && x.name === 'ExitStatus')) log.push([1, 'OpenSCAD stopped: ' + ((x && x.message) || x)]);
    }
    let data = null;
    try { data = inst.FS.readFile(out); } catch (x) {}
    self.postMessage({ rc, log, data }, data ? [data.buffer] : []);
  } catch (x) {
    log.push([1, 'the OpenSCAD runtime failed: ' + ((x && x.message) || x)]);
    self.postMessage({ rc: -1, log, data: null });
  }
};
`;

export const TIMEOUT = 60000;

//  fontconfig's whole setup: the one folder, and a cache it may not keep
export const FONTS_CONF = '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n'
  + '<fontconfig><dir>/fonts</dir><cachedir>/tmp/fontconfig</cachedir></fontconfig>\n';

//  fonts: [[file name, url]], or none on an install from before them
export function makeRunner({ wasm, js, fonts = [] }) {
  let modP = null, glueP = null, fontP = null, workerUrl = null;
  //  a font that does not load is left out: text() then says it has none
  const fontFiles = () => fontP || (fontP = Promise.all(fonts.map(([n, u]) =>
    fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
      .then((b) => (b ? ['/fonts/' + n, new Uint8Array(b)] : null))))
    .then((l) => { const got = l.filter(Boolean); return got.length ? got.concat([['/fonts/fonts.conf', FONTS_CONF]]) : []; }));
  const module = () => modP || (modP = (async () => {
    const r = await fetch(wasm, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('the runtime answered ' + r.status);
    if (WebAssembly.compileStreaming && /application\/wasm/.test(r.headers.get('content-type') || ''))
      return WebAssembly.compileStreaming(r);
    return WebAssembly.compile(await r.arrayBuffer());
  })().catch((x) => { modP = null; throw x; }));
  const glue = () => glueP || (glueP = (async () => {
    const r = await fetch(js, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('the runtime answered ' + r.status);
    return URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
  })().catch((x) => { glueP = null; throw x; }));
  const ready = () => Promise.all([module(), glue(), fontFiles()]);
  //  one render: { promise, cancel }. The promise answers
  //  { rc, log, data, ms, timeout?, cancelled?, error? }
  function run({ files, args, out, timeout }) {
    timeout = timeout || TIMEOUT;
    let w = null, timer = 0, settle;
    const t0 = performance.now();
    const promise = new Promise((ok) => { settle = ok; });
    const end = (r) => {
      clearTimeout(timer);
      if (w) { w.terminate(); w = null; }
      const s = settle; settle = null;
      if (s) s({ ms: Math.round(performance.now() - t0), ...r });
    };
    ready().then(([mod, g, ff]) => {
      if (!settle) return;
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
      w = new Worker(workerUrl, { type: 'module' });
      w.onmessage = (e) => end(e.data);
      w.onerror = (e) => end({ rc: -1, log: [[1, 'the OpenSCAD worker failed: ' + (e.message || 'out of memory?')]], data: null, error: true });
      timer = setTimeout(() => end({ rc: -1, log: [[1, `stopped after ${Math.round(timeout / 1000)} s`]], data: null, timeout: true }), timeout);
      w.postMessage({ glue: g, mod, files: ff.concat(files), args, out });
    }, (x) => end({ rc: -1, log: [[1, 'could not load the OpenSCAD runtime: ' + ((x && x.message) || x)]], data: null, error: true }));
    return { promise, cancel: () => end({ rc: -1, log: [], data: null, cancelled: true }) };
  }
  return { run, ready };
}
