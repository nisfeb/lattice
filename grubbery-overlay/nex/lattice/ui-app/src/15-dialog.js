  // ── in-app dialogs, NEVER browser-native prompt/confirm/alert ────────────
  // <lat-dialog> owns the dialog's markup AND wiring. The shell only carries
  // the tag, so the served HTML can never be missing an element this file
  // expects (the old cache-skew guards existed exactly for that gap).
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts, dlgKind;
  let dlgDone = null;
  let dlgFrom = null;   // focus to hand back on close
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    //  hand focus back to where it was before the dialog took it. Hiding the
    //  focused element drops focus to body, which loses a keyboard or screen
    //  reader user's place. The element may have been removed meanwhile
    //  (a tree re-render replaces its rows), hence the isConnected guard.
    const f = dlgFrom; dlgFrom = null;
    if (f && f.isConnected) f.focus();
    const d = dlgDone; dlgDone = null; d(v);
  };
  const dlgOpen = (msg, okLabel) => {
    dlgFrom = document.activeElement;
    dlgMsg.textContent = msg;
    $('dlgok').textContent = okLabel || 'ok';
    dlg.hidden = false;
    return new Promise((res) => { dlgDone = res; });
  };
  // ask: text-input dialog → string | null (cancel)
  const ask = (msg, value, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = false;
    dlgKind.hidden = true;
    dlgIn.value = value || '';
    const p = dlgOpen(msg, okLabel);
    dlgIn.focus();
    dlgIn.setSelectionRange(dlgIn.value.length, dlgIn.value.length);
    return p;
  };
  //  askNameKind: a name AND the kind to save it as, in one dialog.
  //
  //  The kind used to be reachable only from the bar, which the desktop shell
  //  hides. So the one place a desktop user names a file was also the one
  //  place they could not say what it was, and everything arrived as md.
  //
  //  Options are cloned from the bar's own picker rather than restated, so a
  //  kind added there (tex was) appears here with no second edit.
  const askNameKind = async (msg, value, okLabel, kind) => {
    dlgKind.textContent = '';
    const src = $('pkind');
    if (src) for (const o of src.options) dlgKind.appendChild(o.cloneNode(true));
    dlgKind.value = kind || (src && src.value) || 'md';
    let seed = value || '';
    let note = '';
    for (;;) {
      dlgSel.hidden = true;
      dlgIn.hidden = false;
      dlgKind.hidden = false;
      dlgIn.value = seed;
      const p = dlgOpen(note + msg, okLabel);
      dlgIn.focus();
      dlgIn.setSelectionRange(dlgIn.value.length, dlgIn.value.length);
      const raw = await p;
      const picked = dlgKind.value;
      dlgKind.hidden = true;
      if (raw === null) return null;
      const name = raw.trim().replace(/^\/+|\/+$/g, '');
      if (!name) return null;
      if (validName(name)) return { name, kind: picked };
      seed = name;
      note = 'lowercase letters, digits and - . _ ~ only, no spaces. ';
    }
  };
  // askName: ask() for a path-like name, re-prompting until the server would
  // accept it. Every one of these prompts feeds a route that enforces
  // +valid-name, and a rejection came back as a bare status code ("folder
  // failed 400") that never said what was wrong. Returns the CLEANED name,
  // so callers do not each re-implement the trim and slash strip.
  const askName = async (msg, value, okLabel) => {
    let seed = value || '';
    let note = '';
    for (;;) {
      const raw = await ask(note + msg, seed, okLabel);
      if (raw === null) return null;
      const name = raw.trim().replace(/^\/+|\/+$/g, '');
      if (!name) return null;
      if (validName(name)) return name;
      seed = name;
      note = 'lowercase letters, digits and - . _ ~ only, no spaces. ';
    }
  };
  // askConfirm: yes/no dialog → boolean
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  // askChoice: pick one of a list -> the chosen value, or null on cancel.
  // Rendered as real buttons in the app's own style, NEVER a <select>. A
  // select opens an OS-drawn list, which is a browser-native popup, and this
  // UI does not use those anywhere.
  const askChoice = (msg, options, okLabel) => {
    dlgIn.hidden = true;
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgOpts.textContent = '';
    dlgOpts.hidden = false;
    $('dlgok').hidden = true;          // each option is its own commit button
    const p = dlgOpen(msg, okLabel);
    const btns = options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlgopt' + (i === 0 ? ' on' : '');
      b.textContent = o;
      b.dataset.val = o;
      b.onclick = () => dlgClose(o);
      dlgOpts.appendChild(b);
      return b;
    });
    if (btns[0]) btns[0].focus();
    // arrow keys move between options. Enter takes the focused one
    dlgOpts.onkeydown = (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
        for (const b of btns) b.classList.remove('on');
        btns[n].classList.add('on');
        btns[n].focus();
      }
    };
    return p.then((v) => {
      dlgOpts.hidden = true;
      $('dlgok').hidden = false;
      return v;
    });
  };
  customElements.define('lat-dialog', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<!-- labelled by the prompt itself: dlgmsg carries the question, so it is
     the accessible name, like the aria-label on the overlay siblings -->
<div class="dlg" id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgmsg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <!-- every prompt that shows this asks for a name of some kind -->
    <input id="dlginput" aria-label="name" autocomplete="off" spellcheck="false">
    <!-- the kind to save as. Only askNameKind shows it. -->
    <select id="dlgkind" class="dlgkind" aria-label="page kind" hidden></select>
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
      dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
      dlgSel = $('dlgsel'); dlgOpts = $('dlgopts'); dlgKind = $('dlgkind');
      $('dlgform').onsubmit = (e) => {
        e.preventDefault();
        dlgClose(!dlgSel.hidden ? dlgSel.value : dlgIn.hidden ? '' : dlgIn.value);
      };
      $('dlgcancel').onclick = () => dlgClose(null);
      dlg.onclick = (e) => { if (e.target === dlg) dlgClose(null); };
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dlg.hidden) dlgClose(null);
      });
    }
  });
  // stale-shell guard: a cached index.html predating <lat-dialog> still
  // carries the literal #dlg block, which would shadow the component's ids.
  // Swap it out so dialogs keep working during the skew window (the service
  // worker caches the shell and this file independently).
  if (!document.querySelector('lat-dialog')) {
    const stale = document.getElementById('dlg');
    if (stale) stale.remove();
    document.body.appendChild(document.createElement('lat-dialog'));
  }
