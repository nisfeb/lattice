// The shipless reader's one script (src/render.rs): back, forward, reload
// and try again, and Enter in the address bar. Nothing else runs in a
// reader page, and no inline script is allowed there.
//
// A reload is fresh (src/reader.rs): the page as /read?url=<u>&fresh=1, or
// the home as /?fresh=1, which drop what the engine keeps for the page's
// ship and come back to the plain address. Links, back and forward read
// as they always did.
(function () {
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
})();
