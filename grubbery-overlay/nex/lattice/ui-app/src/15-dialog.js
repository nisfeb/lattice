  // ── in-app dialogs — NEVER browser-native prompt/confirm/alert ───────────
  // <lat-dialog> owns the dialog's markup AND wiring: the shell only carries
  // the tag, so the served HTML can never be missing an element this file
  // expects (the old cache-skew guards existed exactly for that gap).
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts;
  let dlgDone = null;
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    const d = dlgDone; dlgDone = null; d(v);
  };
  const dlgOpen = (msg, okLabel) => {
    dlgMsg.textContent = msg;
    $('dlgok').textContent = okLabel || 'ok';
    dlg.hidden = false;
    return new Promise((res) => { dlgDone = res; });
  };
  // ask: text-input dialog → string | null (cancel)
  const ask = (msg, value, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = false;
    dlgIn.value = value || '';
    const p = dlgOpen(msg, okLabel);
    dlgIn.focus(); dlgIn.select();
    return p;
  };
  // askConfirm: yes/no dialog → boolean
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  // askChoice: pick one of a list -> the chosen value, or null on cancel.
  // Rendered as real buttons in the app's own style, NEVER a <select>: a
  // select opens an OS-drawn list, which is a browser-native popup, and this
  // UI does not use those anywhere.
  const askChoice = (msg, options, okLabel) => {
    dlgIn.hidden = true;
    dlgSel.hidden = true;
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
    // arrow keys move between options; Enter takes the focused one
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
<div class="dlg" id="dlg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <input id="dlginput" autocomplete="off" spellcheck="false">
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
      dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
      dlgSel = $('dlgsel'); dlgOpts = $('dlgopts');
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
