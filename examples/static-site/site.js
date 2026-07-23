// Live filter for the site nav — an example of a JS asset imported by a page.
(function () {
  var f = document.querySelector(".site .filter");
  if (!f) return;
  f.addEventListener("input", function () {
    var q = f.value.toLowerCase();
    document.querySelectorAll(".site .nav li").forEach(function (li) {
      var hit = li.textContent.toLowerCase().indexOf(q) >= 0;
      li.style.display = hit ? "" : "none";
    });
  });
})();
