// Routing map: Inputs -> Channels -> Group buses -> Music/Vocal/Speech/FX -> Broadcast -> Master -> Outputs & cables.
(() => {
  let showAll = false;
  const nodes = new Map(); // id -> element (for drawing links)

  function depthOf(bid) {
    const buses = S.mixer.buses; let d = 0, cur = bid; const seen = new Set();
    while (cur && cur !== 'master' && cur !== 'none' && !seen.has(cur)) { seen.add(cur); cur = buses.find(b => b.id === cur)?.out; d++; }
    return d;
  }

  function render() {
    if (!S.mixer || S.view !== 'routing') return;
    const box = $('#routing'); box.innerHTML = ''; nodes.clear();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('links');
    const cols = h('div', { class: 'rcols' });
    box.append(h('div', { class: 'toolbar rbar' },
      h('b', {}, 'Signal flow'), h('span', { class: 'hint' }, 'Change any “→” to re-route. Drag channels in the Mixer or Edit view to reorder them.'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', title: 'Loads gentle starting processing on the vocal, drum, music, preaching and broadcast buses and the master', onclick: applyTemplate }, icon('broadcast', 15), 'Load worship broadcast template'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: showAll, onchange: e => { showAll = e.target.checked; render(); } }), 'Show unnamed channels')), svg, cols);

    // ---- channels
    const chCol = h('div', { class: 'rcol' }, h('h4', {}, icon('input', 14), 'Inputs → Channels'));
    for (const c of S.mixer.order) {
      const ch = S.mixer.channels[c];
      if (!showAll && /^Ch \d+$/.test(ch.name) && !ch.type) continue;
      const row = h('div', { class: 'rnode ch', style: `--c:${ch.color}` },
        h('span', { class: 'rin' }, inputLabel(ch.input)),
        h('button', { class: 'ric', title: 'Instrument', onclick: () => pickFor(c) }, icon(ch.icon || 'input', 16)),
        h('span', { class: 'rname', onclick: () => openEditor(c) }, ch.name),
        routeSel(['channels', c, 'out'], destOptions(), ch.out));
      nodes.set('ch:' + c, row);
      chCol.append(row);
    }
    if (chCol.children.length === 1) chCol.append(h('p', { class: 'hint' }, 'Name your channels or pick instruments (Mixer → channel icon) and they appear here. Tick “Show unnamed channels” to see all 48.'));
    // fx returns
    const fxCol = h('div', { class: 'rgroup' }, h('h4', {}, icon('fx', 14), 'FX returns'));
    S.mixer.fx.forEach((f, i) => {
      const row = h('div', { class: 'rnode fx' }, h('span', { class: 'rname', onclick: () => openEditor('fx:' + i) }, f.name), routeSel(['fx', i, 'out'], destOptions(), f.out));
      nodes.set('fx:' + i, row); fxCol.append(row);
    });
    chCol.append(fxCol);
    cols.append(chCol);

    // ---- buses by depth (deepest first)
    const depths = {};
    for (const b of S.mixer.buses) (depths[depthOf(b.id)] = depths[depthOf(b.id)] || []).push(b);
    const levels = Object.keys(depths).map(Number).sort((a, b) => b - a);
    for (const lv of levels) {
      const col = h('div', { class: 'rcol' }, h('h4', {}, icon('bus', 14), lv >= 3 ? 'Group buses' : lv === 2 ? 'Music · Vocals · Speech · FX' : lv === 1 ? 'Broadcast' : 'Buses'));
      for (const b of depths[lv]) {
        const i = S.mixer.buses.indexOf(b);
        const feeders = S.mixer.channels.filter(c => c.out === b.id).length + S.mixer.buses.filter(x => x.out === b.id).length + S.mixer.fx.filter(f => f.out === b.id).length;
        const proc = ['comp', 'sat', 'dyneq', 'mbc', 'limiter', 'duck'].filter(k => b[k]?.on).map(k => ({ comp: 'COMP', sat: 'SAT', dyneq: 'DYN', mbc: 'MB', limiter: 'LIM', duck: 'DUCK' })[k]);
        const node = h('div', { class: 'rnode bus', style: `--c:${b.color}` },
          h('div', { class: 'rtop' }, icon(b.kind === 'broadcast' ? 'broadcast' : 'bus', 16), h('span', { class: 'rname', onclick: () => openEditor('bus:' + b.id) }, b.name), h('span', { class: 'rcount' }, feeders + ' in')),
          h('div', { class: 'rproc' }, ...(proc.length ? proc : ['no processing']).map(p => h('span', { class: 'badge' + (proc.length ? ' on' : '') }, p))),
          routeSel(['buses', i, 'out'], destOptions(b.id), b.out));
        nodes.set('bus:' + b.id, node); col.append(node);
      }
      cols.append(col);
    }

    // ---- master & outputs
    const mcol = h('div', { class: 'rcol' }, h('h4', {}, icon('broadcast', 14), 'Master → outputs'));
    const m = S.mixer.master;
    const mproc = ['eq', 'comp', 'sat', 'dyneq', 'mbc', 'limiter'].filter(k => m[k]?.on).map(k => k.toUpperCase());
    const mnode = h('div', { class: 'rnode master' }, h('div', { class: 'rtop' }, h('span', { class: 'rname', onclick: () => openEditor('master') }, 'Master')),
      h('div', { class: 'rproc' }, ...mproc.map(p => h('span', { class: 'badge on' }, p))));
    nodes.set('master', mnode); mcol.append(mnode);
    const cfg = S.info?.cfg || {};
    const out1 = h('div', { class: 'rnode out' }, icon('speaker', 16), h('span', { class: 'rname' }, `Main out ${+cfg.main_l + 1}–${+cfg.main_r + 1}`), h('span', { class: 'hint' }, S.info?.outName || ''));
    nodes.set('out:main', out1); mcol.append(out1);
    if (cfg.mon_l >= 0) { const o = h('div', { class: 'rnode out' }, icon('headset', 16), h('span', { class: 'rname' }, `Monitor ${+cfg.mon_l + 1}–${+cfg.mon_r + 1}`)); nodes.set('out:mon', o); mcol.append(o); }
    // cables
    const srcOpts = [['none', '— off —'], ['master', 'Master (stream mix)'], ...S.mixer.buses.map(b => [`bus:${b.id}`, 'Bus: ' + b.name]), ...S.mixer.order.map(c => [`ch:${c}`, 'Ch: ' + S.mixer.channels[c].name])];
    S.mixer.cables.forEach((cb, k) => {
      const node = h('div', { class: 'rnode cable' }, icon('cable', 16), h('span', { class: 'rname' }, cb.name),
        h('select', { onchange: e => { setParam(['cables', k, 'src'], e.target.value); render(); } }, ...srcOpts.map(([v, l]) => h('option', { value: v, selected: cb.src === v }, l))),
        h('span', { class: 'hint' }, `returns as input “Cable ${k + 1} L/R”`));
      nodes.set('cable:' + k, node); mcol.append(node);
    });
    cols.append(mcol);
    requestAnimationFrame(() => drawLinks(svg, box));
  }

  function applyTemplate() {
    if (!confirm('Load the worship broadcast template onto the buses and master? Channel settings are not changed.')) return;
    const plan = { lead: 'Vocal Bus', bgv: 'Vocal Bus', drums: 'Drum Bus', music: 'Music Bus', speech: 'Speech Bus', broadcast: 'Broadcast Bus' };
    const put = (base, cur, preset) => { for (const [k, v] of Object.entries(CATALOG.busPresets[preset])) setParam([...base, k], { ...cur[k], ...JSON.parse(JSON.stringify(v)) }); };
    S.mixer.buses.forEach((b, i) => { if (plan[b.id]) put(['buses', i], b, plan[b.id]); });
    const mi = S.mixer.buses.findIndex(b => b.id === 'music');
    if (mi >= 0) setParam(['buses', mi, 'duck'], { ...S.mixer.buses[mi].duck, on: true, src: 'bus:lead', amount: 1.5, thr: -32 });
    put(['master'], S.mixer.master, 'Worship Master');
    toast('Worship broadcast template loaded: adjust to taste');
    render();
  }

  function routeSel(path, options, cur) {
    return h('select', { class: 'rsel', style: `--c:${destColor(cur)}`, onchange: e => { setParam(path, e.target.value); render(); } },
      ...options.map(([v, l]) => h('option', { value: v, selected: cur === v }, '→ ' + l)));
  }

  function drawLinks(svg, box) {
    const br = box.getBoundingClientRect();
    svg.setAttribute('width', box.scrollWidth); svg.setAttribute('height', box.scrollHeight);
    svg.innerHTML = '';
    const link = (a, b, color, dashed) => {
      const ea = nodes.get(a), eb = nodes.get(b); if (!ea || !eb) return;
      const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
      const x1 = ra.right - br.left + box.scrollLeft, y1 = ra.top + ra.height / 2 - br.top + box.scrollTop;
      const x2 = rb.left - br.left + box.scrollLeft, y2 = rb.top + rb.height / 2 - br.top + box.scrollTop;
      const dx = Math.max(40, (x2 - x1) / 2);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      p.setAttribute('stroke', color); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('opacity', '.55');
      if (dashed) p.setAttribute('stroke-dasharray', '4 4');
      svg.append(p);
    };
    const target = d => d === 'master' ? 'master' : 'bus:' + d;
    S.mixer.order.forEach(c => { const ch = S.mixer.channels[c]; if (ch.out !== 'none') link('ch:' + c, target(ch.out), destColor(ch.out)); });
    S.mixer.fx.forEach((f, i) => link('fx:' + i, target(f.out), '#5b8def', true));
    S.mixer.buses.forEach(b => { if (b.out !== 'none') link('bus:' + b.id, target(b.out), destColor(b.out)); });
    link('master', 'out:main', '#e8e9eb'); link('master', 'out:mon', '#9aa0a8', true);
    S.mixer.cables.forEach((cb, k) => {
      if (cb.src === 'master') link('master', 'cable:' + k, '#3aa0ff', true);
      else if (cb.src.startsWith('bus:')) link(cb.src, 'cable:' + k, '#3aa0ff', true);
    });
  }

  on('view', v => v === 'routing' && render());
  on('mixer', render);
  on('info', render);
  on('set', p => { if (S.view === 'routing' && (['out', 'name', 'icon', 'color', 'input'].includes(p[2]) || p[0] === 'order' || p[0] === 'cables')) render(); });
  window.addEventListener('resize', () => S.view === 'routing' && render());
})();
