/* Lattice settings: the one look and the one tab model of both settings
 * surfaces.
 *
 *   - the ship's Settings page (+settings-html in app.hoon), served at
 *     /apps/lattice/app/settings.js and loaded by that page alone, so the
 *     editor bundle (app.js) never carries it
 *   - the desktop's manager page (desktop/ui/manager.html), which must work
 *     with no node at all and so cannot load anything from a ship. It gets a
 *     byte-identical copy at desktop/ui/settings.js, written by
 *     scripts/build-ui.mjs and checked by CI, so the two cannot drift.
 *
 * The colours are lattice's theme variables (ui-app/theme.js): --bg, --text,
 * --muted, --accent, --on-accent, --accent-tint, --border, --raised, --error,
 * --font. Each is read as var(--x, fallback), so the untouched default is
 * lattice's own look in light and in dark, and a user's theme, accent or
 * font changes both pages the same way. The manager gets the ship page's
 * resolved variables through the shell (set_theme stores them, status hands
 * them back), since it is another origin and cannot read them itself.
 *
 * Markup: .st holds a nav.st-nav of .st-group blocks (an .st-gh heading and
 * .st-tab links) and an .st-body of section.st-panel blocks, one per tab. A
 * tab with href="#id" shows panel #id. A tab with data-go="name" belongs to
 * the other surface and calls window.stGo(name), which the page defines.
 * Without this script every panel shows, one long page, as before.
 *
 * latSettings.desk(opts) adds the desktop's "This computer" group, its
 * Connection, Files and Scheduled backups tabs, to whichever page calls it.
 * Both do: the manager with no node, and the ship's Settings in the desktop,
 * which calls the shell's commands for them through the top window's
 * __TAURI__ (capabilities/workspace-remote.json says why each is safe
 * there), so those tabs sit in the editor's own Settings tab with no trip
 * to the manager page.
 *
 * Any element brought into view by scrollIntoView reveals its panel first,
 * so the editor's latOpenSettings(anchor) (24-tools.js), which scrolls the
 * frame to a section by id, lands on the right tab with no change there. */
(function () {
  'use strict';
  const CSS = [
    ':root{color-scheme:light dark;--bg:#fafafa;--text:#111}',
    '@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--text:#e6e6e6}}',
    'html{background:var(--bg)}',
    'body.st-page{margin:0;color:var(--text);background:var(--bg);font:16px/1.6 var(--font,system-ui,sans-serif)}',
    'body.st-page main{max-width:64rem}',
    '.st-top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}',
    '.st-top h1{font-size:1.5rem;margin:.3rem 0 1rem}',
    '.st{display:grid;grid-template-columns:12rem minmax(0,1fr);gap:2rem;align-items:start}',
    '.st-nav{position:sticky;top:1rem;display:flex;flex-direction:column;gap:1.1rem}',
    '.st-group{display:flex;flex-direction:column;gap:2px}',
    '.st-group[hidden]{display:none}',
    '.st-gh{font-size:.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#8a8a8a);padding:0 10px 4px}',
    '.st-tab{display:block;padding:6px 10px;border-radius:6px;color:inherit;text-decoration:none;cursor:pointer}',
    '.st-tab:hover{background:var(--raised,#8881)}',
    '.st-tab[aria-current]{background:var(--accent-tint,#1a6ed822);color:var(--accent,#1a6ed8);font-weight:500}',
    '.st-tab:focus-visible{outline:2px solid var(--accent,#1a6ed8);outline-offset:-2px}',
    '.st-panel>h2:first-child,.st-panel>:first-child>h2:first-child{margin-top:0}',
    '.st-panel h2{font-size:1.15rem;margin:2rem 0 .5rem}',
    '.st-panel[hidden]{display:none}',
    '.st-card{border:1px solid var(--border-soft,#8883);border-radius:8px;padding:14px;background:var(--raised,#8881);margin:.8rem 0}',
    '.st-card h2{margin-top:0}',
    '.st-card p{margin:.3rem 0 .7rem}',
    '.st-card summary{cursor:pointer;color:var(--muted,#8a8a8a)}',
    // the buttons below set display, which would beat the hidden attribute
    ':where(.st,.st-top) [hidden]{display:none!important}',
    ':where(.st,.st-top) :where(button,.btn){font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#8886);border-radius:8px;padding:7px 14px;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.4}',
    ':where(.st,.st-top) :where(button,.btn):hover{border-color:var(--accent,#1a6ed8)}',
    ':where(.st,.st-top) :where(button,.btn):disabled{opacity:.5;cursor:default}',
    ':where(.st) :where(button.primary){background:var(--accent,#1a6ed8);border-color:var(--accent-deep,var(--accent,#1a6ed8));color:var(--on-accent,#fff)}',
    ':where(.st) :where(button.primary):hover{background:var(--accent-deep,var(--accent,#1a6ed8))}',
    ':where(.st) :where(input:not([type=checkbox],[type=radio],[type=range]),select){font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#8886);border-radius:6px;padding:6px 9px;color-scheme:inherit}',
    ':where(.st) :where(input,select):focus{outline:none;border-color:var(--accent,#1a6ed8)}',
    ':where(.st) :where(input[type=checkbox],input[type=range]){accent-color:var(--accent,#1a6ed8)}',
    '.st .muted{color:var(--muted,#8a8a8a)}',
    '.st .err{color:var(--error,#c0392b);white-space:pre-wrap}',
    '.st .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:.4rem 0}',
    '.st .mono{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
    '.st-list{list-style:none;padding:0;margin:.5rem 0}',
    '.st-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border-soft,#8883);margin:0}',
    '.st-list li>code{flex:1;font-size:.9em}',
    '.st .dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--muted,#8a8a8a)}',
    '.st .dot.on{background:var(--accent,#1a6ed8)}.st .dot.off{background:#d68910}.st .dot.err{background:var(--error,#c0392b)}',
    '.st .chip{font-size:.78rem;padding:2px 9px;border-radius:999px;border:1px solid var(--border,#8886);color:var(--muted,#8a8a8a)}',
    '.st .chip.running{border-color:var(--accent,#1a6ed8);color:var(--accent,#1a6ed8)}',
    '.st .chip.ok{background:var(--accent,#1a6ed8);border-color:var(--accent,#1a6ed8);color:var(--on-accent,#fff)}',
    '.st .chip.failed{border-color:var(--error,#c0392b);color:var(--error,#c0392b)}',
    '.st pre.cmd{background:var(--raised,#8881);border:1px solid var(--border-soft,#8883);border-radius:8px;padding:10px 12px;overflow-x:auto;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:.5rem 0}',
    // the This computer panels (desk below)
    '.st .conn{border:1px solid var(--border-soft,#8883);border-radius:8px;padding:12px;background:var(--raised,#8881)}',
    '.st .conn .row{gap:10px;margin:0}',
    '.st #connect{max-width:32rem;margin-top:.8rem}.st #connect input{width:100%;margin-bottom:.5rem}',
    '.st #add-mount input,.st #add-backup input:not(#bk-keep){flex:1;min-width:12rem}',
    '.st #add-mount,.st #add-backup{max-width:40rem}',
    '.st #stack-list li{gap:10px}.st .tick{width:1.1em;flex:none;text-align:center}',
    '.st .tick.yes{color:var(--accent,#1a6ed8)}.st .tick.no{color:#d68910}',
    '.st #log{background:var(--raised,#8881);border:1px solid var(--border-soft,#8883);border-radius:8px;padding:10px 12px;overflow:auto;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:.5rem 0;max-height:15rem;white-space:pre-wrap;word-break:break-word}',
    '.st #log .ln{display:block}.st #need-grubbery button{white-space:nowrap}',
    '.st #backup-list li{display:block}.st #backup-list li .row{margin-top:.3rem}',
    '.st #read-status.busy::before{content:"";display:inline-block;width:.7em;height:.7em;margin-right:.4em;border-radius:50%;border:2px solid var(--accent,#1a6ed8);border-right-color:transparent;animation:st-spin 1s linear infinite;vertical-align:-1px}',
    '@keyframes st-spin{to{transform:rotate(360deg)}}',
    '@media(prefers-reduced-motion:reduce){.st #read-status.busy::before{animation:none}}',
    '.st-panel>p.lede{margin:.2rem 0 .8rem}',
    '@media(max-width:640px){.st{grid-template-columns:minmax(0,1fr);gap:1rem}',
    '.st-nav{position:static;flex-direction:row;overflow-x:auto;gap:.6rem;padding-bottom:4px;border-bottom:1px solid var(--border-soft,#8883)}',
    '.st-group{flex-direction:row;align-items:center}.st-gh{display:none}.st-tab{white-space:nowrap}}',
  ].join('');
  const style = document.createElement('style');
  style.id = 'st-css';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  const panels = () => [...document.querySelectorAll('.st-panel')];
  const tabs = () => [...document.querySelectorAll('.st-tab')];
  // show one panel and mark its tab. The address keeps the tab, so a reload
  // or a link (#keys) comes back to it.
  function show(id, keep) {
    const p = document.getElementById(id);
    if (!p || !p.classList.contains('st-panel')) return false;
    for (const q of panels()) q.hidden = q !== p;
    for (const t of tabs()) {
      if (t.getAttribute('href') === '#' + id) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
    if (!keep && location.hash !== '#' + id) {
      try { history.replaceState(history.state, '', '#' + id); } catch {}
    }
    return true;
  }
  // the panel an element sits in, shown
  function reveal(el) {
    const p = el && el.closest && el.closest('.st-panel');
    if (p && p.hidden) show(p.id);
  }
  const into = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    reveal(this);
    return into.apply(this, a);
  };
  function init() {
    if (!document.querySelector('.st')) return;
    document.body.classList.add('st-page');
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.st-tab');
      if (!t) return;
      e.preventDefault();
      const go = t.dataset.go;
      if (go) { if (typeof window.stGo === 'function') window.stGo(go); return; }
      const id = (t.getAttribute('href') || '').slice(1);
      if (show(id)) window.scrollTo(0, 0);
    });
    // the hash names a panel, or an element inside one
    const pick = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id && document.getElementById(id);
      if (el && el.classList.contains('st-panel')) return show(id, true);
      if (el && el.closest('.st-panel')) { reveal(el); el.scrollIntoView({ block: 'start' }); return true; }
      return false;
    };
    window.addEventListener('hashchange', pick);
    if (!pick()) {
      const first = panels()[0];
      if (first) show(first.id, true);
    }
  }
  // ── This computer: the desktop's own settings ───────────────────────────
  // The Connection, Files and Scheduled backups tabs, on whichever page asks.
  //   invoke  the shell's invoke (window.__TAURI__.core.invoke)
  //   listen  its event listen, for the ship-software install log; without
  //           it there is no Ship software section (the ship page: a ship
  //           serving lattice has its software)
  //   leave   runs a step that takes the window off this page, after the
  //           page's own questions about unsaved work (the editor's)
  //   shown   told whether a ship is configured, after each connection check
  //   status  handed the shell's status (the manager wears its theme)
  //   older   on the ship page, what a tab does when the shell is too old
  //           to grant these commands: go to its manager page
  // On the ship page a change goes through a native dialog in the shell
  // first (ship_page_asks in desktop/src/commands.rs); a no there comes
  // back as an error and is shown where the change was asked for.
  const DESK_NAV = '<div class="st-gh">This computer</div>'
    + '<a class="st-tab" href="#connection">Connection</a>'
    + '<a class="st-tab" href="#files">Files</a>'
    + '<a class="st-tab" href="#backups">Scheduled backups</a>';
  const DESK = ''
    + '<section class="st-panel" id="connection">'
    + '<h2 id="ship-h">Ship</h2>'
    + '<div id="conn" class="conn" hidden><div class="row"><span id="dot" class="dot"></span><div>'
    + '<div id="conn-ship"><b>checking…</b></div><div id="conn-url" class="muted mono"></div></div></div>'
    + '<div class="row" style="margin-top:.7rem"><button type="button" id="relog" hidden>Reconnect</button>'
    + '<button type="button" id="switch">Change ship</button></div></div>'
    + '<form id="connect" hidden><input id="url" placeholder="https://your-ship.example.com" required>'
    + '<input id="code" type="password" placeholder="+code" required>'
    + '<div class="row"><button class="primary">Connect</button><button type="button" id="cancel" hidden>Cancel</button>'
    + '<span id="connect-status" class="muted"></span></div></form>'
    + '<section id="reader" class="card st-card" hidden><h2 id="anon-h">Or use lattice anonymously</h2>'
    + '<p id="anon-copy">No node? You can use lattice anonymously. You can browse pages and comment on them, but you can\'t host pages without a node.</p>'
    + '<div class="row"><button type="button" id="anon" class="primary">Use anonymously</button>'
    + '<span id="read-status" class="muted" role="status"></span></div>'
    + '<details><summary>What this uses and keeps</summary><p class="muted">lattice makes a private reader identity on this computer the first time, and your comments are signed with it: the people you comment to see its name as the author. The network: HTTPS to roller.urbit.org and bootstrap.urbit.org (to make the reader identity and look up keys), and UDP to the Urbit network and the ships you read. A network that blocks UDP cannot read. lattice gets the reader ready while this page is open, and reads the start list. What it keeps, on this computer only: the reader identity, the network state, and the pages you read recently. A comment goes to the page\'s publisher and is not kept here. Connecting a node before you use lattice anonymously deletes the identity. Hosting pages, bookmarking and following need a node of your own.</p>'
    + '<div class="row"><button type="button" id="read-clear">Clear reading history</button>'
    + '<span id="read-clear-status" class="muted"></span></div></details></section>'
    + '<div id="stack" hidden><h2>Ship software</h2><ul id="stack-list" class="st-list"></ul>'
    + '<div id="need-mcp" hidden><p class="err">%mcp is not installed on this ship.</p>'
    + '<p class="muted">lattice installs the rest through %mcp, so it has to go on first, and it cannot install itself. From your ship\'s dojo:</p>'
    + '<pre class="cmd">|install ~nisfeb %mcp</pre><p class="muted">Then press check again.</p>'
    + '<button type="button" id="recheck">Check again</button></div>'
    + '<div id="need-grubbery" hidden><p class="muted">%grubbery is missing. lattice runs as a nexus inside it, so it is installed first, over Ames from a publishing ship.</p>'
    + '<div class="row"><input id="dist" spellcheck="false" autocomplete="off"><button type="button" id="go-grubbery" class="primary">Install %grubbery</button></div>'
    + '<p class="muted" style="margin:.4rem 0 0">This takes a few minutes: the whole desk transfers over Ames.</p></div>'
    + '<div id="runlog" hidden><div class="row" style="margin:.6rem 0 .4rem"><span id="run-state" class="chip">running</span>'
    + '<span id="run-secs" class="muted"></span></div><pre id="log"></pre></div></div>'
    + '</section>'
    + '<section class="st-panel" id="files"><h2>On this machine</h2>'
    + '<p class="muted lede">Ships running here can be mounted directly over lick, with no URL and no +code. The socket lives inside the pier, so being able to open it <em>is</em> the permission.</p>'
    + '<div id="local" class="muted">looking…</div><h2>Mounts</h2>'
    + '<p class="muted lede">Project the page tree as local files: edit in your own editor, search with your own tools.</p>'
    + '<p id="fuse-hint" class="err" hidden></p><ul id="mount-list" class="st-list"></ul>'
    + '<form id="add-mount"><input id="mp" placeholder="~/lattice (mountpoint)" required>'
    + '<input id="mroot" placeholder="root (blank = whole tree)"><div class="row"><button>Mount</button>'
    + '<span id="mount-status" class="err"></span></div></form></section>'
    + '<section class="st-panel" id="backups"><h2>Automatic backups</h2>'
    + '<p class="muted lede">Whole-store archives written to this machine on a schedule, the same tar the vault export makes, so anything here restores the same way. Add several: seven daily, four weekly and twelve monthly is three schedules, each keeping its own count.</p>'
    + '<p class="muted lede">These run while lattice is open. One that came due while the app was closed runs shortly after you next open it, so a period is skipped only if the app never runs during it.</p>'
    + '<ul id="backup-list" class="st-list"></ul><form id="add-backup"><div class="row">'
    + '<input id="bk-label" placeholder="name (e.g. daily)" required><select id="bk-every">'
    + '<option value="24">every day</option><option value="168">every week</option>'
    + '<option value="720">every 30 days</option><option value="1">every hour</option></select>'
    + '<input id="bk-keep" type="number" min="0" max="999" value="7" style="width:6rem" title="how many to keep, 0 keeps every one"></div>'
    + '<div class="row"><input id="bk-dir" placeholder="folder on this machine" required><button type="button" id="bk-pick">Choose…</button></div>'
    + '<div class="row"><button>Add schedule</button><span id="backup-status" class="err"></span></div></form></section>';

  function desk(o) {
    const nav = document.querySelector('.st-nav');
    const body = document.querySelector('.st-body');
    if (!nav || !body || document.getElementById('connection')) return;
    const invoke = o.invoke;
    const leave = o.leave || ((go) => go());
    const g = document.createElement('div');
    g.className = 'st-group';
    g.id = 'desk-tabs';
    g.innerHTML = DESK_NAV;
    nav.append(g);
    body.insertAdjacentHTML('beforeend', DESK);
    const $ = (id) => document.getElementById(id);
    const say = (id, text, cls) => { const e = $(id); e.textContent = text; if (cls) e.className = cls; };
    // a shell answer of the wrong shape (undefined, a string, an older
    // desktop's reply) reads as "unavailable" rather than throwing
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

    // ── connection ──
    // the login form shows only when logging in is the thing to do.
    // `connected` comes from a real authenticated request, not from "there
    // is a url in the config", the state that used to render as logged out
    const showForm = (on, cancelable) => {
      $('connect').hidden = !on;
      $('cancel').hidden = !cancelable;
      if (on) $('code').focus({ preventScroll: true });
    };
    async function refreshConn() {
      $('conn').hidden = false;
      let s;
      try { s = await invoke('connection_status'); } catch (e) { say('conn-ship', String(e)); return; }
      s = obj(s);
      if (!s) { say('conn-ship', 'connection status unavailable'); return; }
      $('url').value = s.url || $('url').value;
      $('conn-url').textContent = s.url || '';
      const dot = $('dot'), ship = $('conn-ship');
      if (s.connected) {
        dot.className = 'dot on';
        ship.innerHTML = '<b>connected</b> as ';
        ship.append(s.ship || 'your ship');
        $('relog').hidden = true; $('switch').hidden = false;
        showForm(false, false);
      } else if (s.error) {
        dot.className = 'dot err';
        ship.innerHTML = '<b>cannot reach this ship</b>';
        $('conn-url').textContent = (s.url || '') + ': ' + s.error;
        $('relog').hidden = false; $('switch').hidden = false;
        showForm(false, false);
      } else if (s.url) {
        dot.className = 'dot off';
        ship.innerHTML = '<b>signed out</b>: enter your +code to reconnect';
        $('relog').hidden = true; $('switch').hidden = false;
        showForm(true, false);
      } else {
        // never configured: the form IS the page, and there is nothing to cancel
        $('conn').hidden = true;
        showForm(true, false);
      }
      $('ship-h').textContent = s.url ? 'Ship' : 'Connect your node';
      $('anon-h').textContent = s.url ? 'Use lattice anonymously' : 'Or use lattice anonymously';
      if (o.shown) o.shown(!!s.url);
    }
    $('relog').onclick = () => showForm(true, true);
    $('switch').onclick = () => { $('url').value = ''; showForm(true, true); $('url').focus(); };
    $('cancel').onclick = () => { showForm(false, false); refreshConn(); };
    $('connect').addEventListener('submit', (e) => {
      e.preventDefault();
      say('connect-status', 'connecting…', 'muted');
      // a new ship takes the window there, so the editor asks first
      leave(async () => {
        try {
          const ship = await invoke('connect', { url: $('url').value, code: $('code').value });
          say('connect-status', 'connected as ' + ship);
          $('code').value = '';
          refreshConn();
        } catch (err) { say('connect-status', String(err), 'err'); }
      });
    });

    // ── using the app anonymously ──
    const GETTING_READY = 'Getting ready (about 10 seconds the first time).';
    let opening = false, rt = 0;
    async function refreshReader() {
      let st;
      try { st = await invoke('reader_status'); } catch { $('reader').hidden = true; return; }
      $('reader').hidden = false;
      if (opening) return;
      if (st && st.engine === 'booting') {
        say('read-status', GETTING_READY + (st.step ? ' ' + st.step + '…' : ''), 'muted busy');
        clearTimeout(rt);
        rt = setTimeout(refreshReader, 1000);
      } else if (st && st.engine === 'failed') {
        say('read-status', st.error || 'The reader couldn\'t start.', 'err');
      } else if (st && st.engine === 'ready') {
        say('read-status', 'Ready.', 'muted');
      }
    }
    $('anon').onclick = () => leave(async () => {
      const st = await invoke('reader_status').catch(() => null);
      opening = true;
      say('read-status', st && st.engine === 'ready' ? 'Opening…' : GETTING_READY, 'muted busy');
      try { await invoke('open_reader', { url: null }); } catch (err) { say('read-status', String(err), 'err'); }
      opening = false;
    });
    $('read-clear').onclick = async () => {
      try { await invoke('clear_reader_history'); say('read-clear-status', 'cleared', 'muted'); }
      catch (err) { say('read-clear-status', String(err), 'err'); }
    };

    // ── what the ship is missing, manager only ──
    // shown only when something IS missing; probed after login, because a
    // configured url says nothing about what is installed behind it
    async function refreshStack() {
      let s = null;
      try { s = await invoke('stack_status'); } catch { return; }
      s = obj(s);
      if (!s || !s.checked) return;
      const ul = $('stack-list');
      ul.textContent = '';
      for (const [name, on, note] of [
        ['%mcp', s.mcp, s.mcp_server || 'the bootstrap, which installs everything else'],
        ['%grubbery', s.grubbery, 'the framework lattice runs inside'],
        ['lattice', s.lattice, 'the app itself'],
      ]) {
        const li = document.createElement('li');
        const t = document.createElement('span');
        t.className = 'tick ' + (on ? 'yes' : 'no');
        t.textContent = on ? '✓' : '○';
        const n = document.createElement('code');
        n.textContent = name;
        const d = document.createElement('span');
        d.className = 'muted';
        d.style.flex = '1';
        d.textContent = on ? note : 'not installed';
        li.append(t, n, d);
        ul.append(li);
      }
      $('stack').hidden = s.mcp && s.grubbery && s.lattice;
      $('need-mcp').hidden = s.mcp;
      // grubbery needs %mcp to install it, so never offer that button first
      $('need-grubbery').hidden = !(s.mcp && !s.grubbery);
      if (!$('dist').value) $('dist').value = '~nisfeb';
    }
    const logLine = (text) => {
      const el = document.createElement('span');
      el.className = 'ln';
      el.textContent = text;
      $('log').append(el);
      $('log').scrollTop = $('log').scrollHeight;
    };
    if (o.listen) {
      $('recheck').onclick = refreshStack;
      // the install runs for minutes, so the shell streams its progress
      o.listen('install-progress', (e) => {
        const p = e.payload || {};
        if (p.line) logLine(p.line);
        const chip = $('run-state');
        chip.textContent = p.state || 'running';
        chip.className = 'chip ' + (p.state || 'running');
        $('run-secs').textContent = p.secs != null ? p.secs + 's' : '';
      });
      $('go-grubbery').onclick = async () => {
        const btn = $('go-grubbery');
        btn.disabled = true;
        $('runlog').hidden = false;
        $('log').textContent = '';
        try {
          await invoke('install_grubbery', { ship: $('dist').value.trim() });
          logLine('done, rechecking the ship');
          await refreshStack();
        } catch (err) {
          logLine(String(err));
          say('run-state', 'failed', 'chip failed');
        }
        btn.disabled = false;
      };
    }

    // ── files: local piers and mounts ──
    async function refreshMounts() {
      let list = [];
      try { list = arr(await invoke('list_mounts')); } catch (e) { say('mount-status', String(e)); }
      const ul = $('mount-list');
      ul.textContent = '';
      for (const m of list) {
        const li = document.createElement('li');
        const c = document.createElement('code');
        c.textContent = m.mountpoint + (m.root ? '  ←  ' + m.root : '');
        li.append(c);
        if (m.sock) {
          const tag = document.createElement('span');
          tag.className = 'muted';
          tag.textContent = 'lick · ' + (m.ship || 'local');
          li.append(tag);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Unmount';
        b.onclick = () => {
          say('mount-status', '');
          // a refusal (not mounted, the config write failed) is said, or
          // the row sits there and the button looks like it did nothing
          invoke('remove_mount', { mountpoint: m.mountpoint })
            .then(refreshMounts, (e) => say('mount-status', String(e)));
        };
        li.append(b);
        ul.append(li);
      }
    }
    // a ship is offered for lick only when its lattice socket exists; a
    // stopped pier, or one whose lattice is not up, says why instead
    async function refreshLocal() {
      const host = $('local');
      let ships = [];
      try { ships = arr(await invoke('local_ships')); } catch { ships = []; }
      host.textContent = '';
      if (!ships.length) {
        host.className = 'muted';
        host.textContent = 'no piers found under your home directory.';
        return;
      }
      host.className = '';
      const ul = document.createElement('ul');
      ul.className = 'st-list';
      for (const s of ships) {
        const li = document.createElement('li');
        const c = document.createElement('code');
        c.textContent = String(s.ship || '');
        const why = document.createElement('span');
        why.className = 'muted';
        why.style.flex = '1';
        why.textContent = s.lick ? s.pier : s.pier + (s.running ? ': lattice not running' : ': stopped');
        li.append(c, why);
        if (s.lick) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'primary';
          b.textContent = 'Mount';
          b.onclick = async () => {
            // whatever is typed in the mountpoint box wins, else ~/<ship>
            const mp = $('mp').value.trim() || '~/' + String(s.ship || '').replace(/^~/, '');
            b.disabled = true;
            try {
              await invoke('add_mount', { mountpoint: mp, root: '', sock: s.sock, ship: s.ship });
              say('mount-status', '');
              refreshMounts();
            } catch (err) { say('mount-status', String(err)); }
            b.disabled = false;
          };
          li.append(b);
        }
        ul.append(li);
      }
      host.append(ul);
    }
    $('add-mount').addEventListener('submit', async (e) => {
      e.preventDefault();
      say('mount-status', '');
      try {
        await invoke('add_mount', { mountpoint: $('mp').value, root: $('mroot').value });
        $('mp').value = ''; $('mroot').value = '';
        refreshMounts();
      } catch (err) { say('mount-status', String(err)); }
    });

    // ── scheduled backups ──
    // The list is written whole (set_backup_schedules keeps each one's
    // last_run by id, so an edit does not make it due again). Ids are made
    // here and never reused: retention matches archives by the schedule's
    // NAME, so a rename starts a fresh set rather than orphaning the old.
    let backups = [];
    const bkId = () => 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const period = (h) => (h === 24 ? 'daily' : h === 168 ? 'weekly'
      : h === 720 ? 'every 30 days' : h === 1 ? 'hourly' : 'every ' + h + 'h');
    const ago = (t) => {
      if (!t) return 'never run';
      const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
      if (s < 3600) return 'last run ' + Math.floor(s / 60) + 'm ago';
      if (s < 86400) return 'last run ' + Math.floor(s / 3600) + 'h ago';
      return 'last run ' + Math.floor(s / 86400) + 'd ago';
    };
    // every caller edits `backups` first and saves after; a refusal (or a
    // no in the shell's dialog) is said, and the redraw re-reads the stored
    // list, which drops the edit and puts the rows back in step
    const saveBackups = async () => {
      try { await invoke('set_backup_schedules', { schedules: backups }); }
      catch (e) { say('backup-status', String(e)); }
      await refreshBackups();
    };
    async function refreshBackups() {
      try { backups = arr(await invoke('backup_schedules')); } catch { backups = []; }
      const ul = $('backup-list');
      ul.textContent = '';
      for (const s of backups) {
        const li = document.createElement('li');
        const head = document.createElement('div');
        head.textContent = s.label + ': ' + period(s.every_hours) + ', '
          + (s.keep ? 'keeping ' + s.keep : 'keeping every one') + (s.enabled ? '' : ' (paused)');
        const sub = document.createElement('div');
        // the scheduler calls a run due at every_hours; this waits a full
        // hour more before calling it overdue, since the tick catches up
        // within a minute of launch, so a wider gap means the runs failed
        const overdue = s.enabled && s.every_hours > 0 && s.last_run > 0
          && Math.floor(Date.now() / 1000) - s.last_run > (s.every_hours + 1) * 3600;
        sub.className = overdue ? 'err' : 'muted';
        sub.textContent = s.dir + ' · ' + ago(s.last_run) + (overdue ? ' · the last run did not complete' : '');
        const row = document.createElement('div');
        row.className = 'row';
        const btn = (label, run) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.onclick = run;
          return b;
        };
        const now = btn('Back up now', async () => {
          say('backup-status', '');
          try { await invoke('run_backup_now', { id: s.id }); say('backup-status', 'building…'); }
          catch (e) { say('backup-status', String(e)); }
        });
        // the drill: an archive that EXISTS proves nothing, so this reads
        // the newest back the way a restore would and says what is in it
        const ver = btn('Verify latest', async () => {
          sub.textContent = 'reading the newest archive…';
          try {
            const r = obj(await invoke('verify_backup', { id: s.id }));
            if (!r) { sub.textContent = 'verify unavailable'; sub.className = 'err'; return; }
            if (!Array.isArray(r.problems)) r.problems = [];
            const bits = [r.pages + ' page(s)', r.has_share ? 'share modes' : 'NO share.json',
              r.has_know ? 'memories' : 'NO know.json'];
            sub.textContent = (r.problems.length ? '✗ ' : '✓ ') + bits.join(', ') + ' · '
              + Math.round(r.bytes / 1024) + ' KB'
              + (r.problems.length ? ': ' + r.problems.join('; ') : ', reads clean');
            sub.className = r.problems.length ? 'err' : 'muted';
          } catch (e) { sub.textContent = String(e); sub.className = 'err'; }
        });
        const pause = btn(s.enabled ? 'Pause' : 'Resume', async () => { s.enabled = !s.enabled; await saveBackups(); });
        // removing a SCHEDULE never removes its archives: they are the user's
        const del = btn('Remove', async () => { backups = backups.filter((x) => x.id !== s.id); await saveBackups(); });
        del.title = 'stops the schedule; the archives already written stay';
        row.append(now, ver, pause, del);
        li.append(head, sub, row);
        ul.append(li);
      }
      if (!backups.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'no scheduled backups yet';
        ul.append(li);
      }
    }
    $('bk-pick').onclick = async () => {
      try { const d = await invoke('pick_backup_dir'); if (d) $('bk-dir').value = d; }
      catch (e) { say('backup-status', String(e)); }
    };
    $('add-backup').onsubmit = async (e) => {
      e.preventDefault();
      say('backup-status', '');
      const label = $('bk-label').value.trim();
      const dir = $('bk-dir').value.trim();
      if (!label || !dir) { say('backup-status', 'a name and a folder are both needed'); return; }
      // two schedules sharing a name would share an archive prefix, and then
      // each would count the other's files against its own retention
      if (backups.some((b) => String(b.label || '').toLowerCase() === label.toLowerCase())) {
        say('backup-status', 'there is already a schedule called ' + label);
        return;
      }
      backups.push({ id: bkId(), label, every_hours: Number($('bk-every').value),
        keep: Math.max(0, Number($('bk-keep').value) || 0), dir, last_run: 0, enabled: true });
      await saveBackups();
      $('bk-label').value = '';
    };

    refreshConn();
    refreshReader();
    if (o.listen) refreshStack();
    refreshLocal();
    refreshMounts();
    refreshBackups();
    invoke('status').then((v) => {
      const s = obj(v) || {};
      if (o.status) o.status(s);
      if (!s.fuse_available) {
        const h = $('fuse-hint');
        h.textContent = s.hint || 'mounting is unavailable here'; h.hidden = false;
        document.querySelector('#add-mount button').disabled = true;
      }
    }, () => {
      // A desktop older than these tabs on the ship page grants none of
      // their commands. There the tabs go to its manager page as before.
      if (!o.older) return;
      for (const id of ['connection', 'files', 'backups']) $(id).remove();
      g.innerHTML = DESK_NAV.replace(/href="#([a-z]+)"/g, 'href="#" data-go="$1"');
      window.stGo = o.older;
      const p = panels()[0];
      if (p && !panels().some((q) => !q.hidden)) show(p.id, true);
    });
    // a section asked for by name before these panels were here (#backups)
    const h = location.hash.slice(1);
    if (['connection', 'files', 'backups'].includes(h)) show(h, true);
  }
  window.latSettings = { show, desk };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
