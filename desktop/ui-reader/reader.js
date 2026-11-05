// The shipless reader's one script (src/render.rs): back, forward, reload
// and try again, Enter in the address bar, and asking again while a page
// is checking whether it takes comments. Nothing else runs in a reader
// page, and no inline script is allowed there.
//
// A reload is fresh (src/reader.rs): the page as /read?url=<u>&fresh=1, or
// the home as /?fresh=1, which drop what the engine keeps for the page's
// ship and come back to the plain address. Links, back and forward read
// as they always did.
(function () {
  // The loading line: every read blocks until the engine answers (a new
  // comet's first read takes seconds), and the page left stays up till
  // then. So a navigation leaving this page draws a thin line along the
  // top and spins Reload once it has run BUSY_MS, which a quick read never
  // reaches. The next page, or the reader's error page, takes its place;
  // a leave that never lands (a download) lets go by BUSY_MAX.
  var BUSY_MS = 180, BUSY_MAX = 30000, show = 0, cap = 0;
  var line = function () {
    document.documentElement.classList.add('lbusy');
    if (document.body) document.body.setAttribute('aria-busy', 'true');
  };
  var stop = function () {
    clearTimeout(show); clearTimeout(cap);
    document.documentElement.classList.remove('lbusy');
    if (document.body) document.body.removeAttribute('aria-busy');
  };
  var start = function () {
    clearTimeout(show); clearTimeout(cap);
    show = setTimeout(line, BUSY_MS);
    cap = setTimeout(stop, BUSY_MAX);
  };
  // links, the address bar, Back, Forward, Reload and the webview's own
  // steps alike; a page brought back from the cache is not loading
  addEventListener('beforeunload', start);
  addEventListener('pageshow', function (e) { if (e.persisted) stop(); });
  var here = function () {
    var q = new URLSearchParams(location.search);
    return location.pathname === '/read' ? q.get('url') : null;
  };
  // an address as the reader reads it (reader.rs's `address`)
  var norm = function (a) {
    a = (a || '').trim();
    return a.charAt(0) === '~' ? 'urb://' + a : a;
  };
  var reload = function () {
    var u = here();
    if (u !== null) location.replace('/read?url=' + encodeURIComponent(u) + '&fresh=1');
    else if (location.pathname === '/') location.replace('/?fresh=1');
    else location.reload();
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-go]');
    if (!b) return;
    var go = b.getAttribute('data-go');
    if (go === 'back') history.back();
    else if (go === 'forward') history.forward();
    else if (go === 'reload' || go === 'retry') reload();
  });
  // Ctrl+R and F5, and Cmd+R on macOS
  document.addEventListener('keydown', function (e) {
    var r = (e.key === 'r' || e.key === 'R') && (e.ctrlKey || e.metaKey) && !e.altKey;
    if (r || (e.key === 'F5' && !e.altKey)) {
      e.preventDefault();
      reload();
    }
  }, true);
  // the address of the page already shown, entered again, is a reload
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.classList || !f.classList.contains('addr')) return;
    var u = here(), v = f.elements.url ? norm(f.elements.url.value) : '';
    if (u === null || v === '' || v !== norm(u)) return;
    e.preventDefault();
    location.replace('/read?url=' + encodeURIComponent(v) + '&fresh=1');
  });
  // a page or board whose host hadn't said whether it takes the reader's
  // writes says it is checking: ask twice more, a little apart, and show
  // the answer when it comes (a reload, unless something is typed)
  var check = document.querySelector('[data-check]');
  var waits = [500, 2000];
  var ask = function () {
    var wait = waits.shift();
    if (wait === undefined) return check.remove();
    setTimeout(function () {
      fetch(check.getAttribute('data-check'), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) {
          if (t !== 'answered') return ask();
          var typed = Array.prototype.some.call(document.querySelectorAll('.talk-form textarea, .write-form textarea, .write-form input'), function (f) {
            return f.value !== '';
          });
          if (typed) check.remove();
          else location.replace(location.href);
        }, ask);
    }, wait);
  };
  if (check) ask();
})();
