// The shipless reader's one script (src/render.rs): back, forward and
// try again. Nothing else runs in a reader page, and no inline script
// is allowed there.
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-go]');
  if (!b) return;
  var go = b.getAttribute('data-go');
  if (go === 'back') history.back();
  else if (go === 'forward') history.forward();
  else if (go === 'retry') location.reload();
});
