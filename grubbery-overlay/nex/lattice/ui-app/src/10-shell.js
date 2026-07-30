// lattice app — served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  let pname, pkind, status, spinner;   // assigned by <lat-bar>   (12-bar.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme — declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  const prevBlank = () => {
    prev.removeAttribute('src');
    prev.srcdoc = '<style>:root{color-scheme:light dark}</style>';
  };
  const st = (msg, ok = true) => {
    spinner.classList.remove('on');          // any plain status ends the spin
    status.textContent = msg;
    status.style.color = ok ? '' : '#c0392b';
  };
  // stWork: a status that keeps spinning until the next plain st()
  const stWork = (msg) => {
    status.textContent = msg;
    status.style.color = '';
    spinner.classList.add('on');
  };
