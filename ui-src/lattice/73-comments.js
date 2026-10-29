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
<div class="aclwrap" id="cmwrap" hidden role="region" aria-label="comments">
  <div class="aclbar">
    <h2>Comments</h2>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
  </div>
  <div class="aclbody">
    <div id="cmlist"></div>
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
      const r = await fetch(api + '/comments-inbox');
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
        if (!(await askConfirm('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await fetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
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

  // ── unread ───────────────────────────────────────────────────────────────
  // A comment from another ship used to land in total silence: the inbox is
  // pull-only, so the only way to learn anyone had said anything was to open
  // it and look. That makes the feature invisible in practice.
  //
  // "Seen" is a high-water mark, not a per-comment flag. The @da stamps the
  // items carry are NOT fixed-width — scot %da leaves month and day unpadded
  // (~2026.8.9 vs ~2026.10.1) — so a raw lexical compare misorders across
  // every 9->10 boundary and the badge goes silent for months at a time.
  // daKey pads the numeric fields into a genuinely sortable string; marks
  // stored by older builds compare fine because both sides go through it.
  const daKey = (w) => String(w || '').replace(/\d+/g, (d) => d.padStart(4, '0'));
  const seenKey = 'cmtSeen';
  const lastSeen = () => { try { return localStorage[seenKey] || ''; } catch { return ''; } };
  const markSeen = (when) => { try { if (when) localStorage[seenKey] = when; } catch {} };

  // on the ribbon's inbox button: the badge, and the count in its name, so
  // a screen reader hears it too (title and label stay identical)
  function paintUnread(n) {
    const b = $('rb-inbox');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    tip(b, n > 0 ? 'Comments inbox, ' + b.dataset.n + ' unread' : 'Comments inbox');
  }

  // Counts without rendering, so it can run on a refresh without the pane open.
  // The pier serialises, so every count costs a real request in the same queue
  // the user's saves are waiting in. A badge is not worth that: it is throttled
  // to one count a minute no matter how often a sync asks for it. Opening the
  // panel does not go through here, so reading is always immediate.
  const BADGE_MS = 60000;
  let badgeAt = 0;
  // change detection: the /beacon/comments stamp as of the last full count,
  // and what that count was. Same stamp = nothing arrived = repaint the old
  // number for the price of ONE grub read, instead of the full inbox (every
  // comment body materialized — ~6s of the pier's serial time). Deletes
  // don't move the stamp, and don't need to: they can only lower a count,
  // and opening the panel recomputes for real.
  let stampSeen = null;
  let unreadSeen = 0;

  async function refreshCommentBadge() {
    if (Date.now() - badgeAt < BADGE_MS) return;
    badgeAt = Date.now();
    let stamp = null;
    try {
      // bgFetch: a badge must never queue ahead of something the user asked
      // for (this call is why page opens measured 6s+, see 10-shell.js)
      const r = await bgFetch(api + '/comments-latest');
      if (r.ok) {
        stamp = (await r.json()).latest;
        if (stamp !== null && stamp === stampSeen) { paintUnread(unreadSeen); return; }
      }
      // unknown stamp (old nexus, no comments yet) or a change: pay for the
      // real count
    } catch { return; }
    let d = null;
    try {
      const r = await bgFetch(api + '/comments-inbox');
      if (!r.ok) return;                 // a failed count is not worth reporting
      d = await r.json();
    } catch { return; }
    const items = d.items || [];
    const mark = lastSeen();
    unreadSeen = items.filter((c) => daKey(c.when) > daKey(mark)).length;
    stampSeen = stamp;
    paintUnread(unreadSeen);
  }

  const cmOpen = () => toolOpen('inbox');
  // the inbox's tab came forward (24-tools.js). Opening IS reading: mark
  // everything currently in the inbox as seen
  const cmLoad = () => {
    loadComments().then(() => {
      const newest = inbox.reduce(
        (a, c) => (daKey(c.when) > daKey(a) ? String(c.when) : a), lastSeen());
      markSeen(newest);
      // reading IS the recount: without dropping the cached stamp, the next
      // same-stamp fast path repaints the PRE-read number forever
      stampSeen = null;
      unreadSeen = 0;
      paintUnread(0);
    });
  };
  $('cmreload').onclick = loadComments;
