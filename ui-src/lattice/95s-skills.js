  // ── skills: a tool tab drawn by ui-app/skills.js, loaded on first open ───
  // The skills store (SKILL.md and its files, the /skill* routes). Reached
  // from the Knowledge toolbar and the palette. skills.js holds the whole
  // view, so app.js carries only this.
  const skWrap = document.createElement('div');
  skWrap.className = 'aclwrap';
  skWrap.id = 'skwrap';
  skWrap.hidden = true;
  skWrap.setAttribute('role', 'region');
  skWrap.setAttribute('aria-label', 'skills');
  toolStash.append(skWrap);
  let skLoad = null;
  const skReady = () => (window.LatSkills ? Promise.resolve(window.LatSkills)
    : skLoad || (skLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { skLoad = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/skills.js?h=' + SKILLS_H;
      s.onload = () => (window.LatSkills ? ok(window.LatSkills) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  TOOLS.skills = { name: 'Skills', icon: 'skill', wrap: 'skwrap',
    load: () => skReady().then((k) => k.show(skWrap, { api, st, ask, askConfirm, askDanger, md: mdToHtml }),
      () => st('skills.js did not load', false)) };
  $('kskills').onclick = () => toolOpen('skills');
  clickAction('kskills', 'Skills', 'Knowledge toolbar');
