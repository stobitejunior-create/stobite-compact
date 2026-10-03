// Home: every project (session) with open / delete, plus new and open-from-file.
(() => {
  let items = [], query = '';
  const ago = t => {
    const s = Date.now() / 1000 - t;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    if (s < 86400) return Math.round(s / 3600) + ' hours ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' days ago';
    return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const dur = s => { s = Math.round(s || 0); const h_ = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h_ ? `${h_} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
  const size = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round((b || 0) / 1e3)) + ' KB';

  async function load() {
    try { items = await api('projects'); } catch (e) { items = []; }
    render();
  }
  async function openProject(name) {
    if (S.session?.name !== name) { await tryApi('session-open', { name }); toast('Opened ' + name); }
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
  function newProject() {
    modal((card, close) => {
      const name = h('input', { value: 'Service ' + new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), style: 'width:100%' });
      const go = async () => { await tryApi('session-new', { name: name.value }); close(); toast('Created ' + name.value); showView('edit'); };
      name.onkeydown = e => { if (e.key === 'Enter') go(); };
      card.append(h('h3', {}, 'New project'), h('p', { class: 'hint' }, 'A project holds one service: its recordings, edits and mix.'), name,
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: go }, 'Create')));
      setTimeout(() => { name.focus(); name.select(); }, 50);
    });
  }

  function render() {
    const box = $('#home'); box.innerHTML = '';
    const file = h('input', { type: 'file', accept: '.stobite', hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { await importProject(f); load(); showView('edit'); } } });
    const search = h('input', { placeholder: 'Search projects…', value: query, oninput: e => { query = e.target.value; renderGrid(); } });
    const grid = h('div', { class: 'proj-grid' });
    box.append(h('div', { class: 'home-head' },
      h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'hint' }, items.length ? `${items.length} project${items.length > 1 ? 's' : ''} · saved in your Stobite Compact folder` : 'No projects yet')),
      h('span', { class: 'grow' }), search,
      h('button', { class: 'btn', onclick: () => file.click() }, icon('import', 15), 'Open a project file…'), file,
      h('button', { class: 'btn accent', onclick: newProject }, icon('plus', 15), 'New project')), grid);
    function renderGrid() {
      grid.innerHTML = '';
      const list = items.filter(it => it.name.toLowerCase().includes(query.toLowerCase()));
      if (!list.length) grid.append(h('div', { class: 'proj-empty' }, items.length ? 'No projects match your search.' : 'Create a project, record a service, and it appears here.'));
      for (const it of list) {
        const card = h('div', { class: 'proj' + (it.current ? ' current' : ''), onclick: () => openProject(it.name), title: 'Open ' + it.name },
          h('div', { class: 'proj-top' }, h('span', { class: 'proj-ic' }, icon('record', 14)), h('b', {}, it.name), it.current ? h('span', { class: 'pill' }, 'Open now') : null),
          h('div', { class: 'proj-meta' }, h('span', {}, ago(it.modified)), h('span', {}, dur(it.seconds)), h('span', {}, `${it.tracks || 0} track${it.tracks === 1 ? "" : "s"}`), h('span', {}, size(it.bytes))),
          h('div', { class: 'proj-acts' },
            h('button', { class: 'btn accent', onclick: e => { e.stopPropagation(); openProject(it.name); } }, 'Open'),
            h('button', { class: 'btn danger', title: 'Delete this project', onclick: e => { e.stopPropagation(); del(it); } }, 'Delete')));
        grid.append(card);
      }
    }
    renderGrid();
  }

  $('#brandHome').onclick = () => showView('home');
  on('view', v => v === 'home' && load());
  on('session', () => { if (S.view === 'home') load(); });
})();
