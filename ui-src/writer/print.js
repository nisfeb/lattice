//  print.js: Print or PDF for a Writer page (plan, Task 12). The page is
//  render()'s document with the first master page's size and margins as
//  @page, printed from a frame that runs no script.

//  @page and the print rules. The lengths come from styles.js's layout,
//  so each went through the strict length grammar; Letter and 2 cm when
//  the document says nothing usable.
export function printCss(l) {
  const m = (v) => v || '2cm';
  return `@page{size:${l.width && l.height ? l.width + ' ' + l.height : 'letter'};`
    + `margin:${m(l.marginTop)} ${m(l.marginRight)} ${m(l.marginBottom)} ${m(l.marginLeft)}}`
    + '@media print{html,body{background:none}.lw-sheet{max-width:none!important;padding:0!important;box-shadow:none}'
    + '.lw-doc .lw-pb{break-before:page;border:0;margin:0;padding:0}.lw-doc .lw-pb::before,.lw-doc .fodt-op::before{display:none}'
    + '.lw-doc .fodt-op{border:0;background:none;padding:0}}';
}

//  print an HTML document: a frame of its own, same origin so print() can
//  be called, no allow-scripts so nothing in it runs
export function printFrame(html) {
  for (const f of document.querySelectorAll('iframe[data-lw-print]')) f.remove();
  const f = document.createElement('iframe');
  f.setAttribute('data-lw-print', '');
  f.setAttribute('sandbox', 'allow-same-origin allow-modals');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  f.onload = () => f.contentWindow.print();
  f.srcdoc = html;
  document.body.append(f);
}
