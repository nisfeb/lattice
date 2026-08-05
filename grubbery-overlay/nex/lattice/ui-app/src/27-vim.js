  // ── vim mode ─────────────────────────────────────────────────────────────
  // RESTORED. This shipped in 7eff5b1 and was lost in 11d7f9b, the migration
  // that deleted the editor's HTML-and-JS-in-cords: its parity audit listed
  // what survived and this was not on it, so it went silently. Recovered from
  // that commit rather than rewritten.
  //
  // It was stored base64-encoded in a hoon cord and eval'd. Here it is just a
  // source file the build concatenates, so there is no eval and no dependency.
  //
  // Self-contained, and inert unless localStorage.edVim is "1": the keydown
  // listener returns immediately when off, so the ordinary editor is untouched.
  //
  // Sorts before 45-templates.js on purpose. In normal mode it consumes keys
  // with stopImmediatePropagation, which is what keeps Enter from ALSO running
  // list continuation and Tab from inserting two spaces. Registration order
  // decides that, and the filename decides registration order.
/* ============================================================================
   VIM MODE for the lattice code editor.
   Self-contained vanilla JS, no dependencies. Operates on <textarea id="src">.
   Inline this INSIDE (or right after) the existing editor IIFE; it re-fetches
   `ta` itself so ordering is not critical.
   ============================================================================ */
(function vimMode(){
  "use strict";

  var ta = document.getElementById("src");
  if(!ta) return;

  /* ---- persisted on/off flag (same pattern as edNT / edNC) ---- */
  var LS = "edVim";
  function vimOn(){ return localStorage.getItem(LS) === "1"; }   // default OFF

  /* ---- mode indicator element (created once, lives by the status bar) ---- */
  var ind = document.getElementById("vimInd");
  if(!ind){
    ind = document.createElement("span");
    ind.id = "vimInd";
    ind.style.cssText =
      "display:none;margin-left:8px;padding:1px 6px;border-radius:3px;"+
      "font:11px/1.6 monospace;font-weight:bold;letter-spacing:.5px;"+
      "color:#fff;background:#666;vertical-align:middle;";
    var stEl = document.getElementById("status");
    if(stEl && stEl.parentNode) stEl.parentNode.insertBefore(ind, stEl.nextSibling);
    else document.body.appendChild(ind);
  }

  /* ---- state ---- */
  var MODE = "normal";        // "normal" | "insert" | "visual"
  var pending = "";           // pending operator/prefix: d c y g r f F t T
  var count = "";             // numeric count prefix (digits as a string)
  var reg = "";               // single unnamed register contents
  var regLinewise = false;    // was the register captured linewise?
  var visAnchor = 0;          // selection anchor index for visual mode
  var visCaret = 0;           // moving head of the visual selection
  var cmdActive = false;      // ex command-line (:) active?
  var cmdBuf = "";            // the typed ex command (without the leading :)

  /* ---- fire input so the live content preview refreshes ---- */
  function fireInput(){ ta.dispatchEvent(new Event("input", { bubbles:true })); }

  /* ---- indicator ---- */
  function setInd(){
    if(!vimOn()){ ind.style.display = "none"; return; }
    ind.style.display = "inline-block";
    if(cmdActive){ ind.textContent = ":" + cmdBuf; ind.style.background = "#455a64"; return; }
    var label, bg;
    if(MODE === "insert"){ label = "-- INSERT --"; bg = "#2e7d32"; }
    else if(MODE === "visual"){ label = "-- VISUAL --"; bg = "#8e24aa"; }
    else { label = "-- NORMAL --"; bg = "#1565c0"; }
    if(pending || count) label += " " + count + pending;
    ind.textContent = label;
    ind.style.background = bg;
  }

  /* ---- caret / buffer helpers ---- */
  function val(){ return ta.value; }
  function pos(){ return ta.selectionStart; }
  function setPos(p){ p = clamp(p, 0, val().length); ta.selectionStart = ta.selectionEnd = p; }
  function setSel(a, b){ ta.selectionStart = a; ta.selectionEnd = b; }
  function clamp(n, lo, hi){ return n < lo ? lo : (n > hi ? hi : n); }

  function lineStart(p){ var v = val(); var i = v.lastIndexOf("\n", p - 1); return i + 1; }
  function lineEnd(p){ var v = val(); var i = v.indexOf("\n", p); return i < 0 ? v.length : i; }
  function lineText(p){ return val().slice(lineStart(p), lineEnd(p)); }
  function col(p){ return p - lineStart(p); }
  // In NORMAL mode the caret rests ON a char, so max column is lineEnd-1
  // (unless the line is empty, where it sits at lineStart).
  function lineLastCol(p){ var s = lineStart(p), e = lineEnd(p); return e > s ? e - 1 : s; }
  function normClamp(p){
    var ls = lineStart(p), le = lineEnd(p);
    if(le === ls) return ls;              // empty line
    return clamp(p, ls, le - 1);
  }
  function firstNonBlank(p){
    var ls = lineStart(p), le = lineEnd(p), v = val(), i = ls;
    while(i < le && (v[i] === " " || v[i] === "\t")) i++;
    return i < le ? i : ls;
  }
  // Keep caret legal for the current mode.
  function fixCaret(){
    if(MODE === "insert") return;
    var p = pos(), last = lineLastCol(p);
    if(p > last) setPos(last);
  }

  /* ============================================================================
     EDIT PRIMITIVES — use execCommand so native undo + preview both work.
     ============================================================================ */
  function tryExec(cmd, arg){
    try{
      if(cmd === "insertText") return document.execCommand("insertText", false, arg);
      if(cmd === "delete") return document.execCommand("delete", false, null);
    }catch(e){}
    return false;
  }
  // Replace [a,b) with text. execCommand keeps the native undo stack; setRangeText
  // is the fallback. Always fires input for the live preview.
  function replaceRange(a, b, text, caret){
    a = clamp(a, 0, val().length);
    b = clamp(b, 0, val().length);
    if(a > b){ var t = a; a = b; b = t; }
    ta.focus();
    setSel(a, b);
    var ok = false;
    if(a === b){
      if(text.length) ok = tryExec("insertText", text) || ta.setRangeText(text, a, b, "end") === undefined;
      else ok = true;
    } else if(text.length === 0){
      ok = tryExec("delete") || (ta.setRangeText("", a, b, "end") === undefined);
    } else {
      ok = tryExec("insertText", text) || (ta.setRangeText(text, a, b, "end") === undefined);
    }
    if(typeof caret === "number") setPos(caret);
    fireInput();
    return ok;
  }
  function insertAt(p, text){ replaceRange(p, p, text, p + text.length); }
  function deleteRange(a, b, caret){ replaceRange(a, b, "", typeof caret === "number" ? caret : Math.min(a, b)); }

  /* ---- register ---- */
  function yank(a, b, linewise){
    var v = val(); a = clamp(a, 0, v.length); b = clamp(b, 0, v.length);
    if(a > b){ var t = a; a = b; b = t; }
    var text = v.slice(a, b);
    if(linewise && text.charAt(text.length - 1) !== "\n") text += "\n";
    reg = text; regLinewise = !!linewise;
  }

  /* ============================================================================
     MODE SWITCHING
     ============================================================================ */
  function toInsert(){ MODE = "insert"; pending = ""; count = ""; setInd(); }
  function toNormal(){
    if(MODE === "insert"){                 // vim steps caret left when leaving insert
      var p = pos(), ls = lineStart(p);
      if(p > ls) setPos(p - 1);
    }
    MODE = "normal"; pending = ""; count = ""; fixCaret(); setInd();
  }
  function toVisual(){ MODE = "visual"; visAnchor = pos(); visCaret = pos(); pending = ""; count = ""; visSync(); setInd(); }

  /* ============================================================================
     VISUAL selection helpers (charwise, inclusive of char under caret)
     ============================================================================ */
  function visRange(){
    var a = visAnchor, b = visCaret;
    var lo = Math.min(a, b), hi = Math.max(a, b) + 1;
    return [lo, clamp(hi, 0, val().length)];
  }
  // Show the selection, but leave the logical caret (visCaret) as the moving head.
  function visSync(){
    if(MODE !== "visual") return;
    var r = visRange();
    // put the DOM caret AT visCaret so pos()-based motions read the right spot,
    // then extend the visible selection to cover the range.
    if(visCaret >= visAnchor) setSel(r[0], r[1]);
    else setSel(r[0], r[1]);
    // keep selectionStart at visCaret side for motion reads is not needed;
    // visual handler uses visCaret directly.
  }

  /* ============================================================================
     MOTIONS
     ============================================================================ */
  function charClass(c){
    if(c === undefined || c === "\n") return "nl";
    if(c === " " || c === "\t") return "sp";
    if(/[A-Za-z0-9_]/.test(c)) return "w";
    return "p";                            // punctuation
  }
  function wordFwd(p, n){
    var v = val(), len = v.length;
    for(var k = 0; k < n; k++){
      if(p >= len) break;
      var cls = charClass(v[p]);
      if(cls !== "sp" && cls !== "nl") while(p < len && charClass(v[p]) === cls) p++;
      while(p < len && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p++;
    }
    return clamp(p, 0, len);
  }
  function wordBack(p, n){
    var v = val();
    for(var k = 0; k < n; k++){
      if(p <= 0) break;
      p--;
      while(p > 0 && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p--;
      if(p <= 0){ p = 0; break; }
      var cls = charClass(v[p]);
      while(p > 0 && charClass(v[p - 1]) === cls) p--;
    }
    return clamp(p, 0, v.length);
  }
  function wordEnd(p, n){
    var v = val(), len = v.length;
    for(var k = 0; k < n; k++){
      if(p >= len - 1){ p = len - 1 < 0 ? 0 : len - 1; break; }
      p++;
      while(p < len && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p++;
      if(p >= len){ p = len - 1; break; }
      var cls = charClass(v[p]);
      while(p + 1 < len && charClass(v[p + 1]) === cls) p++;
    }
    return clamp(p, 0, len);
  }
  // cw behaves like ce: change to end of current word, do not eat trailing space.
  function changeWordEnd(p, n){
    var v = val();
    if(charClass(v[p]) === "sp" || charClass(v[p]) === "nl") return wordFwd(p, n);
    return clamp(wordEnd(p, n) + 1, p, v.length);
  }
  // vertical move preserving column. delta>0 down, delta<0 up.
  function vertical(p, delta){
    var v = val(), c = col(p), cur = p;
    if(delta > 0){
      for(var i = 0; i < delta; i++){
        var e = lineEnd(cur);
        if(e >= v.length) break;          // last line
        cur = e + 1;
      }
    } else {
      for(var j = 0; j < -delta; j++){
        var s = lineStart(cur);
        if(s === 0) break;                // first line
        cur = lineStart(s - 1);
      }
    }
    var ns = lineStart(cur), maxc = MODE === "visual" ? lineEnd(cur) : lineLastCol(cur);
    return clamp(ns + c, ns, maxc);
  }
  function paraFwd(p, n){
    var v = val(), len = v.length, i = p;
    for(var k = 0; k < n; k++){
      var e = lineEnd(i); i = e >= len ? len : e + 1;
      while(i < len){
        var ls = lineStart(i), le = lineEnd(i);
        if(le === ls) break;              // blank line
        i = le >= len ? len : le + 1;
      }
    }
    return clamp(i, 0, len);
  }
  function paraBack(p, n){
    var i = p;
    for(var k = 0; k < n; k++){
      var s = lineStart(i);
      i = s > 0 ? s - 1 : 0;
      i = lineStart(i);
      while(i > 0){
        var ls = lineStart(i), le = lineEnd(i);
        if(le === ls) break;              // blank line
        i = lineStart(i - 1);
      }
    }
    return clamp(i, 0, val().length);
  }
  // f/F/t/T within the current line
  function findChar(p, ch, forward, till){
    var v = val(), ls = lineStart(p), le = lineEnd(p);
    if(forward){
      for(var i = p + 1; i < le; i++) if(v[i] === ch) return till ? i - 1 : i;
    } else {
      for(var j = p - 1; j >= ls; j--) if(v[j] === ch) return till ? j + 1 : j;
    }
    return -1;
  }
  function lastLineStart(){ var v = val(); var i = v.lastIndexOf("\n"); return i === -1 ? 0 : i + 1; }
  // 1-based line addressing; returns firstNonBlank of that line.
  function gotoLine(lineNo){
    var v = val(), idx = 0, cur = 1;
    if(lineNo <= 1) return firstNonBlank(0);
    while(cur < lineNo){
      var nl = v.indexOf("\n", idx);
      if(nl === -1) return firstNonBlank(lineStart(v.length));
      idx = nl + 1; cur++;
    }
    return firstNonBlank(idx);
  }

  /* ============================================================================
     LINEWISE span helpers (for dd/cc/yy/dj/dk and operator linewise motions)
     ============================================================================ */
  // [start, end] covering `cnt` whole lines starting at the line of p,
  // where end includes the trailing newline of the last line when present.
  function lineSpan(p, cnt){
    var start = lineStart(p), end = start, v = val();
    for(var k = 0; k < cnt; k++){
      var le = lineEnd(end);
      if(le < v.length) end = le + 1;     // include the newline
      else { end = le; break; }
    }
    return [start, end];
  }
  // Linewise yank of cnt lines from p.
  function linewiseYank(p, cnt){
    var sp = lineSpan(p, cnt);
    yank(sp[0], sp[1], true);
  }
  // Linewise delete of cnt lines from p; caret -> first non-blank of resulting line.
  // Handles the last-line case (eat the preceding newline so no blank line lingers).
  function linewiseDelete(p, cnt){
    var v = val(), sp = lineSpan(p, cnt), a = sp[0], b = sp[1];
    yank(a, b, true);
    if(b >= v.length && a > 0 && v[a - 1] === "\n") a = a - 1;   // last line: eat preceding \n
    deleteRange(a, b, 0);
    setPos(firstNonBlank(clamp(a, 0, val().length)));
  }
  // Linewise change of cnt lines: blank the block down to one empty line, enter insert.
  function linewiseChange(p, cnt){
    var sp = lineSpan(p, cnt), a = sp[0], b = sp[1], v = val();
    yank(a, b, true);
    // keep one line: drop the trailing newline from the delete span if present
    var delTo = (b > a && v[b - 1] === "\n") ? b - 1 : b;
    deleteRange(a, delTo, a);
    setPos(a);
    toInsert();
  }

  /* ============================================================================
     PASTE
     ============================================================================ */
  function paste(after){
    if(reg === "") return;
    var p = pos(), v = val();
    if(regLinewise){
      var text = reg;
      if(text.charAt(text.length - 1) !== "\n") text += "\n";
      if(after){
        var le = lineEnd(p);
        if(le >= v.length){
          // last line, no trailing newline: prepend a newline, drop reg's trailing one
          insertAt(v.length, "\n" + text.replace(/\n$/, ""));
          setPos(firstNonBlank(lineStart(val().length)));
        } else {
          insertAt(le + 1, text);
          setPos(firstNonBlank(le + 1));
        }
      } else {
        var ls = lineStart(p);
        insertAt(ls, text);
        setPos(firstNonBlank(ls));
      }
    } else {
      var at = after ? (v.length === 0 || v[p] === "\n" ? p : p + 1) : p;
      insertAt(at, reg);
      setPos(normClamp(at + reg.length - 1));
    }
  }

  /* ============================================================================
     OPERATOR + MOTION (charwise) — returns {end, linewise} or null.
     ============================================================================ */
  function operatorMotion(op, key, n){
    var p = pos();
    switch(key){
      case "w": return { end: op === "c" ? changeWordEnd(p, n) : wordFwd(p, n), linewise:false };
      case "b": return { end: wordBack(p, n), linewise:false };
      case "e": return { end: wordEnd(p, n) + 1, linewise:false };
      case "h": return { end: Math.max(lineStart(p), p - n), linewise:false };
      case "l": case " ": return { end: Math.min(lineEnd(p), p + n), linewise:false };
      case "0": return { end: lineStart(p), linewise:false };
      case "^": return { end: firstNonBlank(p), linewise:false };
      case "$": return { end: lineEnd(vertical(p, n - 1)), linewise:false };
      // linewise motions on an operator: dj / dk (and cc-ish via count are handled elsewhere)
      case "j": return { linewiseFrom: p, linewiseCount: n + 1, linewise:true };
      case "k": {
        var top = p;
        for(var i = 0; i < n; i++){ var ls = lineStart(top); if(ls === 0) break; top = lineStart(ls - 1); }
        return { linewiseFrom: top, linewiseCount: countLines(top, p) + 1, linewise:true };
      }
      case "G": {
        var destStart = count ? lineStart(gotoLine(parseInt(count, 10))) : lastLineStart();
        var lo = Math.min(p, destStart);
        return { linewiseFrom: lo, linewiseCount: countLines(lo, Math.max(p, destStart)) + 1, linewise:true };
      }
      default: return null;
    }
  }
  function countLines(a, b){
    var lo = Math.min(a, b), hi = Math.max(a, b), c = 0, v = val();
    for(var i = lo; i < hi; i++) if(v[i] === "\n") c++;
    return c;
  }
  function applyCharOp(op, a, b){
    if(a > b){ var t = a; a = b; b = t; }
    yank(a, b, false);
    if(op === "y"){ setPos(normClamp(a)); return; }
    deleteRange(a, b, a);
    if(op === "c"){ setPos(a); toInsert(); }
    else fixCaret();
  }
  function applyLinewiseOp(op, from, cnt){
    if(op === "y"){ linewiseYank(from, cnt); setPos(firstNonBlank(lineStart(from))); }
    else if(op === "c"){ setPos(from); linewiseChange(from, cnt); }
    else linewiseDelete(from, cnt);   // caret handling inside
  }

  /* ============================================================================
     COUNT helper
     ============================================================================ */
  function eff(){ return count === "" ? 1 : parseInt(count, 10); }
  function reset(){ pending = ""; count = ""; }

  /* ============================================================================
     EX COMMAND LINE  ( :w  :wa  :waq  ... all save the file )
     ============================================================================ */
  function cmdSave(){
    var sb = document.getElementById("save");   // the editor's Save button
    if(!sb) return;
    if(typeof sb.onclick === "function") sb.onclick(); else sb.click();
  }
  function runCmd(raw){
    var c = raw.trim();
    if(c.charAt(c.length - 1) === "!") c = c.slice(0, -1);   // tolerate a force !
    // :w and its aliases (:wa, :waq, and the common :wq / :x) all just save.
    if(c === "w" || c === "wa" || c === "waq" || c === "wq" || c === "x"){ cmdSave(); return; }
    if(c === "") return;
    var st = document.getElementById("status");
    if(st) st.textContent = "not an editor command: :" + c;
  }
  function cmdKey(e){
    var k = e.key;
    if(k === "Escape" || (e.ctrlKey && k === "[")){ cmdActive = false; setInd(); return; }
    if(k === "Enter"){ var c = cmdBuf; cmdActive = false; setInd(); runCmd(c); return; }
    if(k === "Backspace"){
      if(cmdBuf.length === 0) cmdActive = false;   // backspace past the : exits
      else cmdBuf = cmdBuf.slice(0, -1);
      setInd(); return;
    }
    if(k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){ cmdBuf += k; setInd(); }
  }

  /* ============================================================================
     NORMAL / VISUAL key handling. Returns true if consumed.
     ============================================================================ */
  function handleKey(e){
    var k = e.key;

    // Esc / Ctrl-[ -> clear pending, drop to NORMAL from visual
    if(k === "Escape" || (e.ctrlKey && k === "[")){
      if(MODE === "visual"){ var c = pos(); MODE = "normal"; setPos(normClamp(c)); }
      reset(); setInd(); return true;
    }
    // Ctrl-R redo
    if(e.ctrlKey && (k === "r" || k === "R")){
      try{ document.execCommand("redo"); }catch(x){}
      fireInput(); reset(); fixCaret(); setInd(); return true;
    }

    // ---- pending single-char consumers: r, f/F/t/T ----
    if(pending === "r"){
      var n0 = eff(); pending = "";
      if(k.length === 1){
        var p0 = pos(), le0 = lineEnd(p0);
        if(p0 + n0 <= le0){
          var rep = ""; for(var ri = 0; ri < n0; ri++) rep += k;
          replaceRange(p0, p0 + n0, rep, p0 + n0 - 1);
        }
      }
      count = ""; setInd(); return true;
    }
    if(pending === "f" || pending === "F" || pending === "t" || pending === "T"){
      var fwd = (pending === "f" || pending === "t");
      var till = (pending === "t" || pending === "T");
      var nF = eff(); pending = "";
      if(k.length === 1){
        var base = (MODE === "visual") ? visCaret : pos();
        var target = base;
        for(var ci = 0; ci < nF; ci++){
          var r = findChar(target, k, fwd, till);
          if(r === -1){ target = base; break; }
          target = r;
        }
        if(target !== base){
          if(MODE === "visual"){ visCaret = target; visSync(); }
          else { setPos(target); fixCaret(); }
        }
      }
      count = ""; setInd(); return true;
    }
    if(pending === "g"){
      pending = "";
      if(k === "g"){
        var dest = count ? gotoLine(eff()) : firstNonBlank(0);
        if(MODE === "visual"){ visCaret = dest; visSync(); }
        else { setPos(dest); fixCaret(); }
      }
      count = ""; setInd(); return true;
    }

    // ---- digits -> count (0 is a motion when count is empty) ----
    if(/^[0-9]$/.test(k) && !(k === "0" && count === "")){
      count += k; setInd(); return true;
    }

    var n = eff();

    // ---- operator pending (d / c / y) ----
    if(pending === "d" || pending === "c" || pending === "y"){
      var op = pending;
      // doubled operator = linewise (dd, cc, yy)
      if((op === "d" && k === "d") || (op === "c" && k === "c") || (op === "y" && k === "y")){
        reset(); applyLinewiseOp(op, pos(), n); setInd(); return true;
      }
      var mv = operatorMotion(op, k, n);
      reset();
      if(mv === null){ setInd(); return true; }        // unknown motion cancels
      if(mv.linewise) applyLinewiseOp(op, mv.linewiseFrom, mv.linewiseCount);
      else applyCharOp(op, pos(), mv.end);
      setInd(); return true;
    }

    // ---- VISUAL: motions move visCaret (the head) and extend the selection ----
    if(MODE === "visual"){
      var vc = visCaret, moved = null;
      switch(k){
        case "h": case "ArrowLeft":  moved = clamp(vc - n, 0, val().length); break;
        case "l": case "ArrowRight": case " ": moved = clamp(vc + n, 0, val().length); break;
        case "j": case "ArrowDown":  moved = vertical(vc, n); break;
        case "k": case "ArrowUp":    moved = vertical(vc, -n); break;
        case "w": moved = wordFwd(vc, n); break;
        case "b": moved = wordBack(vc, n); break;
        case "e": moved = wordEnd(vc, n); break;
        case "0": moved = lineStart(vc); break;
        case "^": moved = firstNonBlank(vc); break;
        case "$": moved = lineEnd(vc); break;
        case "{": moved = paraBack(vc, n); break;
        case "}": moved = paraFwd(vc, n); break;
        case "G": moved = count ? gotoLine(n) : firstNonBlank(lastLineStart()); break;
        case "g": pending = "g"; setInd(); return true;
        case "f": case "F": case "t": case "T": pending = k; setInd(); return true;
      }
      if(moved !== null){ visCaret = clamp(moved, 0, val().length); visSync(); reset(); setInd(); return true; }

      var r2 = visRange(), a = r2[0], b = r2[1];
      switch(k){
        case "d": case "x": yank(a, b, false); deleteRange(a, b, a); MODE = "normal"; setPos(normClamp(a)); reset(); setInd(); return true;
        case "c": case "s": yank(a, b, false); deleteRange(a, b, a); MODE = "normal"; setPos(a); reset(); toInsert(); return true;
        case "y": yank(a, b, false); MODE = "normal"; setPos(normClamp(a)); reset(); setInd(); return true;
        case "p": {
          // paste over selection: snapshot register BEFORE the delete clobbers it
          var sText = reg, sLine = regLinewise;
          deleteRange(a, b, a);
          reg = sText; regLinewise = sLine;
          MODE = "normal"; setPos(a > 0 ? a - 1 : a); paste(true);
          reset(); setInd(); return true;
        }
        case "v": MODE = "normal"; setPos(normClamp(visCaret)); reset(); setInd(); return true;
      }
      // swallow any other printable key in visual
      if(k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){ reset(); setInd(); return true; }
      reset(); setInd(); return true;
    }

    // ---- NORMAL: single-key commands ----
    var p = pos();
    switch(k){
      // motions
      case "h": case "ArrowLeft":  setPos(clamp(p - n, lineStart(p), p)); fixCaret(); break;
      case "l": case "ArrowRight": case " ": setPos(clamp(p + n, p, lineLastCol(p))); break;
      case "j": case "ArrowDown":  setPos(vertical(p, n)); break;
      case "k": case "ArrowUp":    setPos(vertical(p, -n)); break;
      case "w": setPos(normClamp(wordFwd(p, n))); break;
      case "b": setPos(normClamp(wordBack(p, n))); break;
      case "e": setPos(normClamp(wordEnd(p, n))); break;
      case "0": setPos(lineStart(p)); break;
      case "^": setPos(firstNonBlank(p)); break;
      case "$": { var lp = vertical(p, n - 1); setPos(lineLastCol(lp)); break; }
      case "{": setPos(normClamp(paraBack(p, n))); break;
      case "}": setPos(normClamp(paraFwd(p, n))); break;
      case "G": setPos(count ? gotoLine(n) : firstNonBlank(lastLineStart())); break;
      case "g": pending = "g"; setInd(); return true;
      case "f": case "F": case "t": case "T": pending = k; setInd(); return true;

      // enter insert
      case "i": toInsert(); break;
      case "a": if(lineText(p).length) setPos(p + 1); toInsert(); break;
      case "I": setPos(firstNonBlank(p)); toInsert(); break;
      case "A": setPos(lineEnd(p)); toInsert(); break;
      case "o": { var le = lineEnd(p); insertAt(le, "\n"); setPos(le + 1); toInsert(); break; }
      case "O": { var ls = lineStart(p); insertAt(ls, "\n"); setPos(ls); toInsert(); break; }

      // operators (pending)
      case "d": pending = "d"; setInd(); return true;
      case "c": pending = "c"; setInd(); return true;
      case "y": pending = "y"; setInd(); return true;
      case "r": pending = "r"; setInd(); return true;

      // whole-line / end-of-line edits
      case "D": { var le2 = lineEnd(p); yank(p, le2, false); deleteRange(p, le2, p); fixCaret(); break; }
      case "C": { var le3 = lineEnd(p); yank(p, le3, false); deleteRange(p, le3, p); setPos(p); toInsert(); break; }
      case "s": {
        var le4 = lineEnd(p), end4 = clamp(p + n, p, le4);
        if(end4 > p) yank(p, end4, false);
        deleteRange(p, end4, p); setPos(p); toInsert();
        break;
      }
      case "S": linewiseChange(p, n); break;

      // char deletes
      case "x": {
        var le5 = lineEnd(p), end5 = clamp(p + n, p, le5);
        if(end5 > p){ yank(p, end5, false); deleteRange(p, end5, p); fixCaret(); }
        break;
      }
      case "X": {
        var ls6 = lineStart(p), start6 = clamp(p - n, ls6, p);
        if(start6 < p){ yank(start6, p, false); deleteRange(start6, p, start6); }
        break;
      }

      // paste
      case "p": paste(true); break;
      case "P": paste(false); break;

      // visual
      case "v": toVisual(); break;

      // ex command line (:w / :wa / :waq ...)
      case ":": cmdActive = true; cmdBuf = ""; pending = ""; count = ""; setInd(); return true;

      // undo
      case "u": try{ document.execCommand("undo"); }catch(x){} fireInput(); fixCaret(); break;

      default:
        // swallow any other printable key so it never types into the buffer
        reset(); setInd(); return true;
    }
    reset(); setInd(); return true;
  }

  /* ============================================================================
     THE TEXTAREA KEYDOWN LISTENER (capture phase — runs before the Tab handler)
     ============================================================================ */
  ta.addEventListener("keydown", function(e){
    if(!vimOn()) return;                    // vim off: native textarea (Tab, typing) unchanged

    // Never intercept the app's OWN chords. This listener is capture-phase on
    // the textarea and consumes normal-mode keys with stopImmediatePropagation,
    // so anything it does not hand back never reaches the window-level
    // handlers at all. Save was exempted from the start. Search was not, and
    // with vim on that read as "ctrl-K does nothing" rather than "vim ate it",
    // which is the kind of bug people report as a missing feature.
    //
    // Listed explicitly rather than exempting every ctrl chord: vim's own
    // Ctrl-d/u/f/b are bindings here and must keep working.
    if((e.metaKey || e.ctrlKey)
       && (e.key === "s" || e.key === "S" || e.key === "k" || e.key === "K")) return;

    if(MODE === "insert"){
      // insert mode: only Esc / Ctrl-[ is special; everything else (incl. Tab=2sp) native
      if(e.key === "Escape" || (e.ctrlKey && e.key === "[")){ e.preventDefault(); toNormal(); }
      return;
    }

    // ex command line (:w etc.): own the keyboard until Enter runs it or Esc cancels.
    if(cmdActive){
      e.preventDefault();
      e.stopImmediatePropagation();
      cmdKey(e);
      return;
    }

    // NORMAL / VISUAL: we own the keyboard. Consume everything (so Tab, letters,
    // etc. never reach the bubble-phase Tab handler or type into the buffer).
    handleKey(e);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Keep caret legal when focus lands on the textarea while in normal/visual.
  ta.addEventListener("focus", function(){ if(vimOn() && MODE !== "insert") fixCaret(); });

  /* ============================================================================
     TOGGLE BUTTON + localStorage (same flip-flag-then-reapply pattern as edNT)
     ============================================================================ */
  function applyVim(){
    if(vimOn()){
      MODE = (MODE === "insert") ? "insert" : "normal";
      ta.classList.add("vim-on");
      fixCaret();
    } else {
      MODE = "normal"; reset(); cmdActive = false;
      ta.classList.remove("vim-on");
    }
    setInd();
    if(btn) btn.textContent = "vim: " + (vimOn() ? "on" : "off");
  }
  // Global so an explicit template button `onclick="vimToggle()"` can drive it.
  window.vimToggle = function(){
    localStorage.setItem(LS, vimOn() ? "0" : "1");
    MODE = "normal"; reset();
    applyVim();
    ta.focus();
    var stEl2 = document.getElementById("status");
    if(stEl2) stEl2.textContent = "vim " + (vimOn() ? "on" : "off");
  };

  //  The toggle lives on the settings page, which is a SEPARATE document on
  //  this origin, exactly like the font and size preferences. It writes the
  //  flag and the storage event brings it here, so no button is injected into
  //  the bar (which is managed markup now).
  var btn = document.getElementById("vimToggle");
  if(btn) btn.onclick = window.vimToggle;
  window.addEventListener("storage", function(e){
    if(!e.key || e.key === LS) applyVim();
  });

  // Persist an explicit default of OFF on first run.
  if(localStorage.getItem(LS) === null) localStorage.setItem(LS, "0");
  applyVim();
})();
