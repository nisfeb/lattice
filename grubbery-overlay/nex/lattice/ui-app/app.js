// lattice app — milestone 1: prove the loop (asset grubs + JSON API).
(async function () {
  const status = document.getElementById('status');
  const tree = document.getElementById('tree');
  try {
    const r = await fetch('/apps/lattice/page-tree');
    if (!r.ok) throw new Error('page-tree ' + r.status);
    const { nodes } = await r.json();
    status.textContent = nodes.length + ' nodes';
    for (const n of nodes) {
      const li = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = n.page ? n.kind : 'folder';
      li.textContent = n.path;
      li.appendChild(kind);
      tree.appendChild(li);
    }
  } catch (e) {
    status.textContent = 'error: ' + e.message;
  }
})();
