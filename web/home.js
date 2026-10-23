// Welcome screen: shown when the app opens (like Logic, CapCut or Pixelmator). Pick a project or
// make a new one and it gets out of the way. Bring it back with the logo, the project name in the
// header, or Cmd/Ctrl+O.
(() => {
  let items = [], query = '', manual = false;
  const root = $('#welcome');
  const ago = t => {
    const s = Date.now() / 1000 - t;
    if (s < 90) return 'just now';
    const n = (v, unit) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
    if (s < 3600) return n(Math.round(s / 60), 'minute');
    if (s < 86400) return n(Math.round(s / 3600), 'hour');
    if (s < 86400 * 7) return n(Math.round(s / 86400), 'day');
    return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const dur = s => { s = Math.round(s || 0); const h_ = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h_ ? `${h_} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
  const size = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round((b || 0) / 1e3)) + ' KB';

  window.welcomeOpen = () => !root.hidden;

  window.showWelcome = function (byUser = false) {
    manual = byUser;
    root.hidden = false;
    root.classList.remove('leaving');
    load();
  };
  window.hideWelcome = function () {
    if (root.hidden) return;
    root.classList.add('leaving');
    setTimeout(() => { root.hidden = true; root.classList.remove('leaving'); }, 220);
  };

  async function load() {
    try { items = await api('projects'); } catch (e) { items = []; }
    render();
  }
  // the progress card while a project opens: reading its tracks' waveforms is most of the wait on a long service
  function loader(name) {
    const pc = progressCard(name, [['Opening', 1]]);
    const off = on('loading', m => { if ((m.stage || 'open') === 'open') pc.stage(0, m.progress, m.msg); });
    return () => { off(); pc.done(); };
  }
  async function openProject(name) {
    if (S.session?.name !== name) {
      const done = loader(name);
      try { await tryApi('session-open', { name }); } finally { done(); }
      toast('Opened ' + name);
    }
    hideWelcome();
    showView('edit');
  }
  async function del(it) {
    const mac = navigator.platform.includes('Mac');
    const msg = `Delete the project “${it.name}”?\n\n${it.tracks || 0} tracks, ${dur(it.seconds)} of audio, ${size(it.bytes)}.\n\n` +
      (mac ? 'It goes to the Trash, so you can still recover it from there.' : 'This permanently deletes its recordings.');
    if (!confirm(msg)) return;
    const r = await tryApi('session-delete', { name: it.name });
    toast(r.where === 'trash' ? `“${it.name}” moved to the Trash` : `“${it.name}” deleted`);
    load();
  }
  window.newProject = function () {
    modal((card, close) => {
      const name = h('input', { value: 'Service ' + new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), style: 'width:100%' });
      const go = async () => { await tryApi('session-new', { name: name.value }); close(); toast('Created ' + name.value); hideWelcome(); showView('edit'); };
      name.onkeydown = e => { if (e.key === 'Enter') go(); };
      card.append(h('h3', {}, 'New project'), h('p', { class: 'hint' }, 'A project holds one service: its recordings, edits and mix.'), name,
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: go }, 'Create')));
      setTimeout(() => { name.focus(); name.select(); }, 50);
    });
  };

  function render() {
    root.innerHTML = '';
    const file = h('input', { type: 'file', accept: '.stobite', hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { await importProject(f); hideWelcome(); showView('edit'); } } });
    const search = h('input', { class: 'wl-search', placeholder: 'Search projects…', value: query, oninput: e => { query = e.target.value; renderGrid(); } });
    const grid = h('div', { class: 'proj-grid' });
    const current = S.session && !S.session.scratch ? S.session.name : null;   // null: no project open
    const side = h('aside', { class: 'wl-side' },
      h('div', { class: 'wl-brand' }, h('span', { class: 'logo big' }, 'S'), h('div', {}, h('div', { class: 'wl-title' }, 'Stobite ', h('b', {}, 'Compact')), h('div', { class: 'hint' }, 'Record, mix and master the service'))),
      h('button', { class: 'wl-act accent', onclick: newProject }, icon('plus', 18), h('span', {}, h('b', {}, 'New project'), h('small', {}, 'Start a new service'))),
      h('button', { class: 'wl-act', onclick: () => file.click() }, icon('import', 18), h('span', {}, h('b', {}, 'Open a project file…'), h('small', {}, 'A .stobite file from another computer'))), file,
      h('span', { class: 'grow' }),
      manual && current ? h('button', { class: 'wl-act ghost', onclick: hideWelcome }, icon('arrowLeft', 18), h('span', {}, h('b', {}, 'Back to ' + current), h('small', {}, 'Esc'))) : null);
    const main = h('section', { class: 'wl-main' },
      h('div', { class: 'wl-head' }, h('h2', {}, 'Recent projects'), h('span', { class: 'grow' }), search),
      grid);
    root.append(h('div', { class: 'wl-panel' }, side, main));
    function renderGrid() {
      grid.innerHTML = '';
      const list = items.filter(it => it.name.toLowerCase().includes(query.toLowerCase()));
      if (!list.length) grid.append(h('div', { class: 'proj-empty' }, items.length ? 'No projects match your search.' : 'No projects yet. Make a new one to get started.'));
      list.forEach((it, n) => {
        const isOpen = manual && it.name === current;
        const card = h('div', { class: 'proj' + (isOpen ? ' current' : ''), style: `animation-delay:${Math.min(n, 12) * 25}ms`, onclick: () => openProject(it.name), title: 'Open ' + it.name },
          h('div', { class: 'proj-top' }, h('span', { class: 'proj-ic' }, icon('record', 14)), h('b', {}, it.name), isOpen ? h('span', { class: 'pill' }, 'Open now') : null),
          h('div', { class: 'proj-meta' }, h('span', {}, ago(it.modified)), h('span', {}, dur(it.seconds)), h('span', {}, `${it.tracks || 0} track${it.tracks === 1 ? '' : 's'}`), h('span', {}, size(it.bytes))),
          h('div', { class: 'proj-acts' },
            h('button', { class: 'btn accent', onclick: e => { e.stopPropagation(); openProject(it.name); } }, 'Open'),
            h('button', { class: 'btn danger', title: 'Delete this project', onclick: e => { e.stopPropagation(); del(it); } }, 'Delete')));
        grid.append(card);
      });
    }
    renderGrid();
    if (innerWidth > 760) setTimeout(() => search.focus(), 60);
  }

  on('session', () => { if (welcomeOpen()) load(); });
  $('#brandHome').onclick = () => showWelcome(true);
  $('#sessName').onclick = () => showWelcome(true);
  $('#sessName').title = 'Switch project (Ctrl/Cmd+O)';
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'o') { e.preventDefault(); showWelcome(true); }
    else if (mod && k === 'n') { e.preventDefault(); newProject(); }
    else if (e.key === 'Escape' && welcomeOpen() && manual && S.session && !S.session.scratch && $('#modal').hidden) hideWelcome();
  }, true);
})();
