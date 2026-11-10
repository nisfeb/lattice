// markup in a model, which must stay text everywhere
label = "</code></pre><script>alert(document.cookie)</script>";
/* <img src=x onerror=alert(1)> */
echo("<b>bold</b>", label);
text("\u202e reversed", size = 5);
cube(1);
