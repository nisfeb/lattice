  // ── never a second editor in a frame ─────────────────────────────────────
  // The editor owns its window. Loaded in a frame (a link the shell did not
  // catch, a redirect, a script), it would run a second set of buffers,
  // autosave and stream over the same tab list and drafts in localStorage,
  // and closing that frame would drop its unsaved work unasked. So it does
  // not start. When the frame is one of the shell's own (24-tools.js), the
  // shell opens the address as a tab of its own; the frame says so either
  // way, and nothing else of this file runs.
  if (window.top !== window) {
    let sent = false;
    try { sent = !!(window.top.latFrameEditor && window.top.latFrameEditor(location.href)); } catch {}
    const p = document.createElement('p');
    p.style.cssText = 'font:15px system-ui,sans-serif;margin:2rem;color:var(--text,inherit)';
    p.textContent = sent ? 'Opened in the editor. ' : 'The editor runs in a window of its own. ';
    const a = document.createElement('a');
    if (sent) {
      a.href = '#';
      a.textContent = 'Back';
      a.onclick = (e) => { e.preventDefault(); history.back(); };
    } else {
      a.href = location.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open the editor';
    }
    p.append(a);
    document.title = 'Lattice';
    document.body.replaceChildren(p);
    return;
  }
