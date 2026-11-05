  // ── comments inbox: <lat-comments> ───────────────────────────────────────
  // Comments arrive from OTHER ships, and until now the workspace had no view
  // of them. The reader rendered a thread per page, so finding out anyone had
  // replied meant visiting each published page. This is the owner's side: what
  // came in, across every page, newest first, with a way to remove one.
  //
  // Reuses the .aclwrap/.aclbar/.aclbody styles rather than growing a second
  // set that would drift from them. It shows in a tool tab (24-tools.js).
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="region" aria-label="inbox">
  <div class="aclbar">
    <h2>Inbox</h2>
    <span class="ibtabs" role="tablist">
      <button id="ibtab-held" role="tab" data-ib="held">Held</button>
      <button id="ibtab-act" role="tab" data-ib="act">Activity</button>
      <button id="ibtab-cm" role="tab" data-ib="cm">Comments</button>
    </span>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="ibreadall" hidden>mark all read</button>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
  </div>
  <div class="aclbody">
    <div id="ibheld" hidden></div>
    <div id="ibact" hidden></div>
    <div id="cmlist" hidden></div>
  </div>
</div>`;
    }
  });

  let inbox = [];
  async function loadComments() {
    const host = $('cmlist');
    if (host && !host.childElementCount) {
      host.className = 'aclempty';
      host.textContent = 'loading…';
    }
    let d = null;
    try {
      const r = await busyFetch(api + '/comments-inbox');
      if (!r.ok) { st('comments failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  // The inbox by default. The Comments tab (76-outline.js) passes one
  // page's share of it, its own host and empty line, and its own reload,
  // and leaves out the page link, which would only point at itself.
  function renderComments(total, {
    host = $('cmlist'), items = inbox, sum = $('cmsum'), reload = loadComments,
    // say WHY it might be empty. Comments are opt-in per page, so "none yet"
    // and "never enabled anywhere" look identical and mean different things
    empty = 'No comments. They are opt-in per page: switch them on in a '
      + 'page\'s Page tab.',
    pageLink = true,
  } = {}) {
    if (!host) return;
    host.textContent = '';
    host.className = '';
    if (sum) {
      sum.textContent = items.length
        ? items.length + (total > items.length ? ' of ' + total : '') + ' comment'
          + (total === 1 ? '' : 's')
        : '';
    }
    if (!items.length) {
      host.className = 'aclempty';
      host.textContent = empty;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of items) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');
      const who = document.createElement('b');
      who.textContent = c.author;
      const del = document.createElement('button');
      del.textContent = 'remove';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askDanger('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await busyFetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
          '&id=' + encodeURIComponent(c.id), { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) { st('remove failed' + await errText(r), false); return; }
        st('comment removed');
        reload();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      // the page it landed on, clickable. The point of an inbox is getting
      // to the thing being talked about
      if (pageLink) {
        const on = document.createElement('a');
        on.className = 'gname';
        on.textContent = c.page;
        on.style.cursor = 'pointer';
        on.onclick = (e) => openIn('page', c.page, { ev: e });
        card.appendChild(on);
      }

      const body = document.createElement('div');
      body.style.whiteSpace = 'pre-wrap';
      body.style.overflowWrap = 'anywhere';
      body.textContent = c.body;
      card.appendChild(body);

      const when = document.createElement('div');
      when.className = 'aclnote';
      when.textContent = c.when;
      card.appendChild(when);
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  // ── held and activity ────────────────────────────────────────────────────
  // The inbox has three tabs. Held: comet comments waiting on a page set to
  // held, across every page (GET /held-comments), approved or rejected here
  // as in a page's Page tab. Activity: what happened to the owner, a comment
  // from another ship on one of their pages, a reply to their post or
  // comment on a board they host, and a reply on another ship's board its
  // host told this ship about (GET /notify). Each item is read or unread on
  // the ship, so every tab and device agrees. Comments: every comment, with
  // remove, as before.
  let ibTab = null;
  let held = [];
  let acts = [];
  const ago = (ms) => new Date(ms).toLocaleString();

  function ibShow(tab) {
    ibTab = tab;
    for (const b of document.querySelectorAll('#cmwrap .ibtabs button')) {
      b.setAttribute('aria-selected', String(b.dataset.ib === tab));
    }
    $('ibheld').hidden = tab !== 'held';
    $('ibact').hidden = tab !== 'act';
    $('cmlist').hidden = tab !== 'cm';
    $('ibreadall').hidden = tab !== 'act' || !acts.some((a) => !a.read);
    const sum = $('cmsum');
    if (tab === 'held') sum.textContent = held.length ? held.length + ' held' : '';
    else if (tab === 'act') {
      const n = acts.filter((a) => !a.read).length;
      sum.textContent = n ? n + ' unread' : '';
    } else renderComments(inbox.length);
  }
  for (const b of document.querySelectorAll('#cmwrap .ibtabs button')) {
    b.onclick = () => ibShow(b.dataset.ib);
  }

  function ibCard(author, label, onLabel, body, when) {
    const card = document.createElement('div');
    card.className = 'aclcard';
    const head = document.createElement('header');
    const who = document.createElement('b');
    who.textContent = author;
    head.appendChild(who);
    card.appendChild(head);
    if (label) {
      const on = document.createElement('a');
      on.className = 'gname';
      on.textContent = label;
      on.style.cursor = 'pointer';
      on.onclick = onLabel;
      card.appendChild(on);
    }
    const b = document.createElement('div');
    b.style.whiteSpace = 'pre-wrap';
    b.style.overflowWrap = 'anywhere';
    b.textContent = body;               // text, never HTML
    card.appendChild(b);
    const w = document.createElement('div');
    w.className = 'aclnote';
    w.textContent = ago(when);
    card.appendChild(w);
    return card;
  }
  const ibButton = (card, label, run) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => { b.disabled = true; await run(); b.disabled = false; };
    card.querySelector('header').appendChild(b);
    return b;
  };
  function ibEmpty(host, text) {
    host.className = 'aclempty';
    host.textContent = text;
  }

  async function loadHeld() {
    try {
      const r = await busyFetch(api + '/held-comments');
      if (!r.ok) { st('held comments failed' + await errText(r), false); return; }
      held = (await r.json()).items || [];
    } catch { st('held comments failed', false); return; }
    const host = $('ibheld');
    host.textContent = '';
    host.className = '';
    if (!held.length) {
      ibEmpty(host, 'Nothing held. Comet comments wait here when a page\'s comet '
        + 'comments are set to held in its Page tab.');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of held) {
      const card = ibCard(c.author, c.page, (e) => openIn('page', c.page, { ev: e }), c.body, c.when);
      for (const act of ['approve', 'reject']) {
        ibButton(card, act, async () => {
          const r = await mutate(api + '/comet-pending?page=' + encodeURIComponent(c.page)
            + '&id=' + encodeURIComponent(c.id) + '&do=' + act);
          if (!r || !r.ok) { st(act + ' failed' + await errText(r), false); return; }
          st(act === 'approve' ? 'comment approved' : 'comment rejected');
          await loadHeld();
          ibShow(ibTab);
          refreshInboxBadge(true);
        });
      }
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  // where an activity item points: a page of ours, a thread on a board we
  // host, or a thread on another ship's board read through this ship
  const actLabel = (a) => {
    if (a.kind === 'comment') return 'comment on ' + a.where;
    const t = a.title ? ': ' + a.title : '';
    if (a.kind === 'remote') return 'reply on ' + a.host + '/' + a.where + t;
    if (a.kind === 'reply') return 'reply on ' + a.where + t;
    return a.where;
  };
  const actOpen = (a, e) => {
    if (a.kind === 'comment' || a.kind === 'folder') return openIn('page', a.where, { ev: e });
    const tail = encodeURIComponent(a.where) + '/' + a.post;
    return browseIn(a.kind === 'remote'
      ? '/apps/lattice/forum-remote/' + a.host + '/' + tail
      : '/apps/lattice/forum/' + tail);
  };
  async function markRead(q) {
    const r = await mutate(api + '/notify-read?' + q);
    if (!r || !r.ok) { st('mark read failed' + await errText(r), false); return false; }
    return true;
  }

  async function loadActivity() {
    try {
      const r = await busyFetch(api + '/notify');
      if (!r.ok) { st('activity failed' + await errText(r), false); return; }
      acts = (await r.json()).items || [];
    } catch { st('activity failed', false); return; }
    const host = $('ibact');
    host.textContent = '';
    host.className = '';
    if (!acts.length) {
      ibEmpty(host, 'No activity yet. Comments from other ships on your pages, and '
        + 'replies to your forum posts and comments, show here.');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const a of acts) {
      const read = async () => {
        if (a.read || !(await markRead('id=' + encodeURIComponent(a.id)))) return;
        a.read = true;
        card.classList.remove('unread');
        if (mk) mk.remove();
        ibShow(ibTab);
        refreshInboxBadge(true);
      };
      const card = ibCard(a.who, actLabel(a), (e) => { read(); actOpen(a, e); }, a.body, a.when);
      card.classList.toggle('unread', !a.read);
      const mk = a.read ? null : ibButton(card, 'mark read', read);
      ibButton(card, 'open', async () => { read(); await actOpen(a); });
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }
  $('ibreadall').onclick = async () => {
    if (!(await markRead('all=1'))) return;
    st('all activity marked read');
    await loadActivity();
    ibShow('act');
    refreshInboxBadge(true);
  };

  // ── the badge ────────────────────────────────────────────────────────────
  // On the ribbon's inbox button: held comet comments plus unread activity,
  // with the count in its name so a screen reader hears it too (title and
  // label stay identical). No sound and no OS notification, by design.
  function paintUnread(n) {
    const b = $('rb-inbox');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    tip(b, n > 0 ? 'Inbox, ' + b.dataset.n + ' unread' : 'Inbox');
  }

  // GET /notify-count is two directory reads and no bodies. It runs on a
  // refresh, throttled to once a minute, and at once (`now`) when the
  // /beacon/notify stamp moves (90-sync.js) or the user acted here.
  const BADGE_MS = 60000;
  let badgeAt = 0;
  async function refreshInboxBadge(now) {
    if (!now && Date.now() - badgeAt < BADGE_MS) return;
    badgeAt = Date.now();
    let d = null;
    try {
      // bgFetch: a badge must never queue ahead of something the user asked
      // for (this call is why page opens measured 6s+, see 10-shell.js)
      const r = await bgFetch(api + '/notify-count');
      if (!r.ok) return;                 // a failed count is not worth reporting
      d = await r.json();
    } catch { return; }
    paintUnread((d.held || 0) + (d.unread || 0));
  }
  // the old name, which the refresh paths call
  const refreshCommentBadge = () => refreshInboxBadge(false);
  // A followed folder's new pages (the follow-a-folder work) would arrive as
  // activity items of kind %folder (lib/lattice-notify): the ship files
  // them, and this list and the badge show them with no change here.

  const cmOpen = () => toolOpen('inbox');
  // the inbox's tab came forward (24-tools.js): load all three tabs, and
  // show Held when something waits there, else Activity
  const cmLoad = () => {
    Promise.all([loadHeld(), loadActivity(), loadComments()]).then(() => {
      ibShow(ibTab || (held.length ? 'held' : 'act'));
      refreshInboxBadge(true);
    });
  };
  $('cmreload').onclick = cmLoad;
