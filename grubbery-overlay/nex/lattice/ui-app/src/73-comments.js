  // ── comments inbox: <lat-comments> ───────────────────────────────────────
  // Comments arrive from OTHER ships, and until now the workspace had no view
  // of them. The reader rendered a thread per page, so finding out anyone had
  // replied meant visiting each published page. This is the owner's side: what
  // came in, across every page, newest first, with a way to remove one.
  //
  // Reuses the .aclwrap/.aclbar/.aclbody overlay styles rather than growing a
  // second set that would drift from them.
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="dialog" aria-modal="true" aria-label="comments">
  <div class="aclbar">
    <h2>Comments</h2>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="cmclose">close</button>
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
      if (!r.ok) { st('comments failed ' + r.status, false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  function renderComments(total) {
    const host = $('cmlist');
    if (!host) return;
    host.textContent = '';
    host.className = '';
    $('cmsum').textContent = inbox.length
      ? inbox.length + (total > inbox.length ? ' of ' + total : '') + ' comment'
        + (total === 1 ? '' : 's')
      : '';
    if (!inbox.length) {
      host.className = 'aclempty';
      // say WHY it might be empty. Comments are opt-in per page, so "none yet"
      // and "never enabled anywhere" look identical and mean different things
      host.textContent = 'No comments. They are opt-in per page — turn them on '
        + 'from a page’s sharing controls.';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of inbox) {
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
        if (!r || !r.ok) { st('remove failed' + (r ? ' ' + r.status : ''), false); return; }
        st('comment removed');
        loadComments();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      // the page it landed on, clickable. The point of an inbox is getting
      // to the thing being talked about
      const on = document.createElement('a');
      on.className = 'gname';
      on.textContent = c.page;
      on.style.cursor = 'pointer';
      on.onclick = () => { cmClose(); openPage(c.page); };
      card.appendChild(on);

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
  // "Seen" is a high-water mark, not a per-comment flag: the @da the items
  // carry is zero-padded and fixed-width, so a lexical compare orders them and
  // one string in localStorage replaces a set that would need pruning.
  const seenKey = 'cmtSeen';
  const lastSeen = () => { try { return localStorage[seenKey] || ''; } catch { return ''; } };
  const markSeen = (when) => { try { if (when) localStorage[seenKey] = when; } catch {} };

  function paintUnread(n) {
    const b = $('cmt');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    b.title = n > 0
      ? n + ' new comment' + (n === 1 ? '' : 's') + ' from other ships'
      : 'comments from other ships';
  }

  // Counts without rendering, so it can run on a refresh without the pane open.
  // The pier serialises, so every count costs a real request in the same queue
  // the user's saves are waiting in. A badge is not worth that: it is throttled
  // to one count a minute no matter how often a sync asks for it. Opening the
  // panel does not go through here, so reading is always immediate.
  const BADGE_MS = 60000;
  let badgeAt = 0;

  async function refreshCommentBadge() {
    if (Date.now() - badgeAt < BADGE_MS) return;
    badgeAt = Date.now();
    let d = null;
    try {
      const r = await fetch(api + '/comments-inbox');
      if (!r.ok) return;                 // a failed count is not worth reporting
      d = await r.json();
    } catch { return; }
    const items = d.items || [];
    const mark = lastSeen();
    paintUnread(items.filter((c) => String(c.when || '') > mark).length);
  }

  const cmOpen = () => {
    $('cmwrap').hidden = false;
    // opening IS reading: mark everything currently in the inbox as seen
    loadComments().then(() => {
      const newest = inbox.reduce((a, c) => (String(c.when) > a ? String(c.when) : a), lastSeen());
      markSeen(newest);
      paintUnread(0);
    });
  };
  const cmClose = () => { $('cmwrap').hidden = true; };
  $('cmclose').onclick = cmClose;
  $('cmreload').onclick = loadComments;
  $('cmt').onclick = cmOpen;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('cmwrap').hidden) cmClose();
  });
