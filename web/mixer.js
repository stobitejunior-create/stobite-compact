// Mixer: channel / bus / FX / master strips, and the strip editor.
(() => {
  const reg = new Map();           // path key -> control with .set (strips)
  const key = p => p.join('/');
  const bind = (path, ctl) => { reg.set(key(path), ctl); return ctl; };
  let layer = 'inputs', edTarget = null, clipboard = null;
  let stripEls = [], busEls = [], fxEls = [], masterEls = null;
  const fs = () => S.info?.sr || 48000;

  // ---------------------------------------------------------- targets
  const busIdx = id => S.mixer.buses.findIndex(b => b.id === id);
  function pathOf(t) {
    if (t === 'master') return ['master'];
    if (typeof t === 'string' && t.startsWith('bus:')) return ['buses', busIdx(t.slice(4))];
    if (typeof t === 'string' && t.startsWith('fx:')) return ['fx', +t.slice(3)];
    return ['channels', +t];
  }
  const objOf = t => getPath(S.mixer, pathOf(t));
  window.mixerPathOf = pathOf;

  // ---------------------------------------------------------- option lists
  window.destOptions = (self) => [['master', 'Master (direct)'], ...S.mixer.buses.filter(b => b.id !== self).map(b => [b.id, b.name]), ['none', '— not routed —']];
  window.inputOptions = () => {
    const n = Math.max(S.info?.nIn || 0, 48);
    const o = [];
    for (let i = 0; i < n; i++) o.push([`in:${i}`, `WING USB ${i + 1}`]);
    for (let k = 0; k < 4; k++) { o.push([`cable:${2 * k}`, `Cable ${k + 1} L`]); o.push([`cable:${2 * k + 1}`, `Cable ${k + 1} R`]); }
    o.push(['none', '— none —']);
    return o;
  };
  window.scOptions = () => [['', '— none —'], ...S.mixer.buses.map(b => [`bus:${b.id}`, `Bus: ${b.name}`]),
    ...S.mixer.order.map(c => [`ch:${c}`, `Ch ${c + 1}: ${S.mixer.channels[c].name}`])];
  const inputLabel = spec => { const o = inputOptions().find(o => o[0] === spec); return o ? o[1].replace('WING USB', 'IN') : '—'; };
  const destName = id => id === 'master' ? 'Master' : id === 'none' ? 'Off' : (S.mixer.buses.find(b => b.id === id)?.name || id);
  const destColor = id => id === 'master' ? '#e8e9eb' : (S.mixer.buses.find(b => b.id === id)?.color || '#555');
  window.destName = destName; window.destColor = destColor; window.inputLabel = inputLabel;

  function sel(path, options, extra = {}) {
    const cur = getPath(S.mixer, path);
    return h('select', { class: extra.cls || '', title: extra.title || '', onchange: e => { setParam(path, extra.num ? +e.target.value : e.target.value); extra.onchange && extra.onchange(e.target.value); } },
      ...options.map(([v, l]) => h('option', { value: v, selected: String(cur) === String(v) }, l)));
  }

  // ---------------------------------------------------------- banks / layers
  function buildBanks() {
    const n = S.mixer.channels.length, b = $('#mixBank'); b.innerHTML = '';
    const opts = [['inputs', 'Inputs']];
    for (let i = 0; i < n; i += 16) opts.push([`${i}`, `${i + 1}–${Math.min(n, i + 16)}`]);
    opts.push(['buses', 'Buses'], ['fx', 'FX']);
    for (const [v, l] of opts) b.append(h('button', { class: layer === v ? 'on' : '', onclick: () => { layer = v; buildMixer(); } }, l));
  }
  function layerChannels() {
    const order = S.mixer.order;
    if (layer === 'inputs') return order;
    if (/^\d+$/.test(layer)) return order.slice(+layer, +layer + 16);
    return [];
  }

  // ---------------------------------------------------------- strips
  function buildMixer() {
    if (!S.mixer) return;
    reg.clear(); stripEls = []; busEls = []; fxEls = [];
    buildBanks();
    const box = $('#strips'); box.innerHTML = '';
    const showSends = $('#showSends').checked;
    if (layer === 'buses') S.mixer.buses.forEach((b, i) => box.append(busStrip(b, i)));
    else if (layer === 'fx') S.mixer.fx.forEach((f, i) => box.append(fxStrip(f, i)));
    else layerChannels().forEach(c => box.append(channelStrip(c, showSends)));
    if (layer === 'buses') box.append(h('button', { class: 'strip addbus', onclick: async () => { const n = prompt('Name for the new bus', 'New Bus'); if (n) await tryApi('bus-add', { name: n }); } }, icon('plus', 22), 'Add bus'));
    const mb = $('#mstrips'); mb.innerHTML = '';
    mb.append(masterStrip());
    requestAnimationFrame(() => { redrawThumbs(); sizeMeters(); });
    soloHint();
    renderSceneBar();
  }
  window.buildMixer = buildMixer;
  function sizeMeters() { $$('#view-mixer .meter').forEach(m => m.style.setProperty('--h', m.clientHeight + 'px')); }
  function redrawThumbs() {
    for (const s of stripEls) drawEqCurve(s.thumb, S.mixer.channels[s.c], fs());
    for (const s of busEls) drawEqCurve(s.thumb, S.mixer.buses[s.i], fs());
    if (masterEls) drawEqCurve(masterEls.thumb, S.mixer.master, fs());
  }

  function badge(label, path, title) {
    const b = h('span', { class: 'badge' + (getPath(S.mixer, path) ? ' on' : ''), title: title || 'Toggle ' + label, onclick: e => { e.stopPropagation(); setParam(path, !getPath(S.mixer, path)); } }, label);
    bind(path, { set: v => b.classList.toggle('on', !!v) });
    return b;
  }
  function faderBlock(path, meters, dbEl) {
    const fader = bind(path, Fader({ value: getPath(S.mixer, path), onChange: v => { setParam(path, v); dbEl.textContent = fmt.db(v); } }));
    const fset = fader.set; fader.set = v => { fset(v); dbEl.textContent = fmt.db(v); };
    return h('div', { class: 'fz' }, fader.el, ...meters.map(m => m.el));
  }
  function muteBtn(path, cls = 'm', label = 'M') {
    const b = h('button', { class: `tog ${cls}` + (getPath(S.mixer, path) ? ' on' : ''), onclick: () => setParam(path, !getPath(S.mixer, path)) }, label);
    bind(path, { set: v => { b.classList.toggle('on', !!v); if (cls === 's') soloHint(); } });
    return b;
  }

  function channelStrip(c, showSends) {
    const ch = S.mixer.channels[c];
    const P = (...p) => ['channels', c, ...p];
    const el = h('div', { class: 'strip ch', draggable: 'true' });
    const ic = h('button', { class: 'sicon', title: 'What is on this channel? (instrument library)', onclick: () => pickFor(c) }, icon(ch.icon || 'input', 20));
    const name = h('div', { class: 'sname', style: `background:${ch.color}`, onclick: () => openEditor(c), title: `Open ${ch.name}` }, ch.name);
    const io = h('div', { class: 'io' },
      h('span', { class: 'inlbl', title: 'Input (change it in the channel editor)' }, inputLabel(ch.input)),
      h('span', { class: 'outlbl', style: `--c:${destColor(ch.out)}`, title: 'Goes to this bus' }, '→ ' + destName(ch.out)));
    const thumb = h('canvas');
    const badges = h('div', { class: 'badges' },
      badge('HPF', P('hpf', 'on'), 'Low cut'), badge('GATE', P('gate', 'on')), badge('EQ', P('eq', 'on')), badge('COMP', P('comp', 'on')),
      badge('DS', P('deess', 'on'), 'De-esser'), badge('DYN', P('dyneq', 'on'), 'Dynamic EQ'), badge('TR', P('trans', 'on'), 'Transient shaper'), badge('SAT', P('sat', 'on'), 'Saturation'), badge('TUNE', P('tune', 'on'), 'Auto-tune (pitch correction)'));
    const gr = h('i');
    const sends = h('div', { class: 'sends' }, ...S.mixer.fx.map((f, i) => bind(P('sends', i), Knob({ label: f.name.split(' ').pop().slice(0, 6), min: -90, max: 10, value: ch.sends[i], def: -90, size: 26, format: fmt.db, color: '#3aa0ff', onChange: v => setParam(P('sends', i), v) })).el));
    const pan = bind(P('pan'), Knob({ label: 'Pan', min: -1, max: 1, value: ch.pan, def: 0, size: 28, format: fmt.pan, bipolar: true, onChange: v => setParam(P('pan'), v) }));
    const db = h('div', { class: 'db' }, fmt.db(ch.fader));
    const meter = Meter();
    el.append(h('div', { class: 'shead' }, ic, h('span', { class: 'snum' }, c + 1)), name, io,
      h('div', { class: 'eqthumb', onclick: () => openEditor(c) }, thumb), badges, h('div', { class: 'gr', title: 'Compressor gain reduction' }, gr),
      showSends ? sends : null, h('div', { class: 'cen' }, pan.el),
      h('div', { class: 'row' }, muteBtn(P('mute')), muteBtn(P('solo'), 's', 'S'), autoModeButton(String(c))),
      faderBlock(P('fader'), [meter], db), db);
    dragReorder(el, c);
    stripEls.push({ el, thumb, gr, meter, name, c });
    return el;
  }

  // drag a channel strip onto another to move it there
  let dragFrom = null;
  function dragReorder(el, c) {
    el.addEventListener('dragstart', e => { dragFrom = c; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.strip.dropto').forEach(x => x.classList.remove('dropto')); });
    el.addEventListener('dragover', e => { if (dragFrom != null && dragFrom !== c) { e.preventDefault(); el.classList.add('dropto'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dropto'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (dragFrom == null || dragFrom === c) return;
      const from = dragFrom; dragFrom = null;
      moveChannel(from, c);
    });
  }
  window.moveChannel = (from, to) => {
    const order = S.mixer.order.filter(x => x !== from);
    order.splice(order.indexOf(to), 0, from);
    setParam(['order'], order);
  };

  function busStrip(b, i) {
    const P = (...p) => ['buses', i, ...p];
    const el = h('div', { class: 'strip bus' });
    const name = h('div', { class: 'sname', style: `background:${b.color}`, onclick: () => openEditor('bus:' + b.id) }, b.name);
    const thumb = h('canvas');
    const comp = h('i'), lim = h('i'), duck = h('i');
    const L = Meter(), R = Meter();
    const db = h('div', { class: 'db' }, fmt.db(b.fader));
    el.append(h('div', { class: 'shead' }, h('span', { class: 'sicon' }, icon(b.kind === 'broadcast' ? 'broadcast' : b.kind === 'fx' ? 'fx' : 'bus', 20))),
      name,
      h('div', { class: 'io' }, h('span', { class: 'outlbl', style: `--c:${destColor(b.out)}` }, '→ ' + destName(b.out))),
      h('div', { class: 'eqthumb', onclick: () => openEditor('bus:' + b.id) }, thumb),
      h('div', { class: 'badges' }, badge('EQ', P('eq', 'on')), badge('COMP', P('comp', 'on')), badge('SAT', P('sat', 'on')), badge('DYN', P('dyneq', 'on')),
        badge('MB', P('mbc', 'on'), 'Multiband compressor'), badge('LIM', P('limiter', 'on')), badge('DUCK', P('duck', 'on'), 'Ducking (sidechain)')),
      h('div', { class: 'grs' }, h('div', { class: 'gr', title: 'Compression' }, comp), h('div', { class: 'gr lim', title: 'Limiter' }, lim), h('div', { class: 'gr duck', title: 'Ducking' }, duck)),
      h('div', { class: 'row' }, muteBtn(P('mute')), autoModeButton(`bus:${i}`)),
      faderBlock(P('fader'), [L, R], db), db);
    busEls.push({ el, thumb, comp, lim, duck, L, R, id: b.id, i });
    return el;
  }

  const FX_PARAMS = {
    predelay_ms: ['Pre-delay', 0, 200, fmt.ms], decay: ['Decay', 0.05, 0.98, fmt.pct], size: ['Size', 0, 1, fmt.pct], damping: ['Damping', 0, 1, fmt.pct],
    width: ['Width', 0, 100, v => Math.round(v) + '%'], early: ['Early ref.', 0, 1, fmt.pct], lowcut: ['Low cut', 20, 1000, fmt.hz, true], highcut: ['High cut', 1000, 20000, fmt.hz, true],
    time_ms: ['Time', 20, 2000, fmt.ms], feedback: ['Feedback', 0, 0.95, fmt.pct],
    rate_hz: ['Rate', 0.05, 8, v => v.toFixed(2) + 'Hz'], depth: ['Depth', 0, 1, fmt.pct], centre_delay_ms: ['Delay', 1, 30, fmt.ms],
    centre_frequency_hz: ['Freq', 200, 5000, fmt.hz, true], semitones: ['Detune', 0, 0.5, v => v.toFixed(2) + 'st'], delay_ms: ['Delay', 1, 60, fmt.ms],
  };
  const FX_TYPE_OPTS = [['plate', 'Plate'], ['hall', 'Hall'], ['room', 'Room'], ['delay', 'Delay'], ['chorus', 'Chorus'], ['phaser', 'Phaser'], ['doubler', 'Doubler']];
  const NOTE_OPTS = [['1/2', '1/2'], ['1/4', '1/4'], ['1/4d', '1/4 dotted'], ['1/8', '1/8'], ['1/8d', '1/8 dotted'], ['1/8t', '1/8 triplet'], ['1/16', '1/16']];
  function fxStrip(f, i) {
    const P = (...p) => ['fx', i, ...p];
    const el = h('div', { class: 'strip fx' });
    const name = h('div', { class: 'sname', onclick: () => openEditor('fx:' + i) }, f.name);
    const params = h('div', { class: 'sends' });
    const show = f.type === 'delay' ? ['feedback', 'lowcut', 'highcut', 'width'] : ['predelay_ms', 'decay', 'damping', 'early'];
    for (const k of show.filter(k => k in f.params)) {
      const p = FX_PARAMS[k];
      params.append(bind(P('params', k), Knob({ label: p[0].split(' ')[0], min: p[1], max: p[2], log: !!p[4], value: f.params[k], size: 26, format: p[3], color: '#3aa0ff', onChange: v => setParam(P('params', k), v) })).el);
    }
    const db = h('div', { class: 'db' }, fmt.db(f.ret));
    const meter = Meter(), duck = h('i');
    el.append(h('div', { class: 'shead' }, h('span', { class: 'sicon' }, icon('fx', 20))), name,
      sel(P('type'), FX_TYPE_OPTS, { cls: 'mini-sel', onchange: () => setTimeout(buildMixer, 60) }),
      f.type === 'delay' ? sel(P('params', 'note'), NOTE_OPTS, { cls: 'mini-sel' }) : null,
      params, h('div', { class: 'row' }, badge('DUCK', P('duck', 'on'), 'Duck when the sidechain source is active')),
      h('div', { class: 'gr duck', title: 'Ducking' }, duck),
      h('div', { class: 'row' }, muteBtn(P('mute')), autoModeButton(`fx:${i}`)),
      faderBlock(P('ret'), [meter], db), db);
    fxEls.push({ el, meter, duck, i });
    return el;
  }

  function masterStrip() {
    const m = S.mixer.master;
    const el = h('div', { class: 'strip master' });
    const thumb = h('canvas');
    const ceil = bind(['master', 'limiter', 'ceiling'], Knob({ label: 'Ceiling', min: -6, max: 0, value: m.limiter.ceiling, def: -1, size: 28, format: fmt.db, onChange: v => setParam(['master', 'limiter', 'ceiling'], v) }));
    const db = h('div', { class: 'db' }, fmt.db(m.fader));
    const L = Meter(), R = Meter(), gr = h('i');
    el.append(h('div', { class: 'shead' }, h('span', { class: 'sicon' }, icon('broadcast', 20))),
      h('div', { class: 'sname', onclick: () => openEditor('master') }, 'MASTER'),
      h('div', { class: 'eqthumb', onclick: () => openEditor('master') }, thumb),
      h('div', { class: 'badges' }, badge('EQ', ['master', 'eq', 'on']), badge('COMP', ['master', 'comp', 'on']), badge('SAT', ['master', 'sat', 'on']),
        badge('MB', ['master', 'mbc', 'on']), badge('LIM', ['master', 'limiter', 'on'])),
      h('div', { class: 'gr' }, gr), h('div', { class: 'cen' }, ceil.el),
      h('div', { class: 'row' }, muteBtn(['master', 'mute']), autoModeButton('master')),
      faderBlock(['master', 'fader'], [L, R], db), db);
    masterEls = { thumb, L, R, gr };
    return el;
  }
  function soloHint() { $('#soloHint').textContent = S.mixer.channels.some(c => c.solo) ? 'SOLO on: other channels are silent in the mix' : ''; }

  function pickFor(c) {
    pickInstrument(S.mixer.channels[c].type, (it, opt) => {
      const P = (...p) => ['channels', c, ...p];
      if (!it) { setParam(P('icon'), ''); setParam(P('type'), ''); return; }
      setParam(P('icon'), it.icon); setParam(P('type'), it.key); setParam(P('color'), it.color);
      if (/^Ch \d+$/.test(S.mixer.channels[c].name)) setParam(P('name'), it.label);
      if (opt.preset) {
        if (it.bus) setParam(P('out'), it.bus);
        if (it.preset) applyChannelPreset(c, it.preset);
      }
      toast(`${S.mixer.channels[c].name}: ${it.label}${opt.preset && it.preset ? ' (preset loaded, routed to ' + destName(it.bus) + ')' : ''}`);
      if (edTarget === c) openEditor(c);
    });
  }
  function applyChannelPreset(c, name) {
    const p = CATALOG?.channelPresets?.[name]; if (!p) return;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'sends') setParam(['channels', c, 'sends'], [...v]);
      else setParam(['channels', c, k], { ...S.mixer.channels[c][k], ...JSON.parse(JSON.stringify(v)) });
    }
  }
  function applyBusPreset(t, name) {
    const p = CATALOG?.busPresets?.[name]; if (!p) return;
    const base = pathOf(t), cur = objOf(t);
    for (const [k, v] of Object.entries(p)) setParam([...base, k], { ...cur[k], ...JSON.parse(JSON.stringify(v)) });
  }
  window.applyChannelPreset = applyChannelPreset;

  // ---------------------------------------------------------- live updates
  on('mixer', () => { buildMixer(); if (edTarget != null) openEditor(edTarget); });
  on('catalog', () => { if (S.mixer) renderSceneBar(); });
  on('view', v => v === 'mixer' && requestAnimationFrame(() => { sizeMeters(); redrawThumbs(); }));
  $('#showSends').onchange = buildMixer;
  window.addEventListener('resize', sizeMeters);
  let rebuildQueued = false;
  const rebuildSoon = () => { if (rebuildQueued) return; rebuildQueued = true; requestAnimationFrame(() => { rebuildQueued = false; buildMixer(); }); };
  on('set', path => {
    const ctl = reg.get(key(path));
    if (ctl) ctl.set(getPath(S.mixer, path));
    if (path[0] === 'channels') {
      const s = stripEls.find(s => s.c === path[1]);
      if (s && ['eq', 'hpf', 'lpf'].includes(path[2])) drawEqCurve(s.thumb, S.mixer.channels[s.c], fs());
      if (['name', 'color', 'icon', 'out', 'input'].includes(path[2])) rebuildSoon();
    }
    if (path[0] === 'buses') {
      const s = busEls.find(s => s.i === path[1]);
      if (s && ['eq', 'hpf', 'lpf'].includes(path[2])) drawEqCurve(s.thumb, S.mixer.buses[s.i], fs());
      if (['name', 'color', 'out'].includes(path[2])) rebuildSoon();
    }
    if (path[0] === 'master' && masterEls && ['eq', 'hpf', 'lpf'].includes(path[1])) drawEqCurve(masterEls.thumb, S.mixer.master, fs());
    if (path[0] === 'fx' && ['type', 'name'].includes(path[2])) rebuildSoon();
    if (path[0] === 'order') { rebuildSoon(); emit('order'); }
    if (edTarget != null) edRefresh(path);
  });
  on('meters', m => {
    if (S.view === 'mixer') {
      for (const s of stripEls) { s.meter.set(m.p[s.c] / 1000); s.gr.style.width = Math.min(100, (m.gr[s.c] || 0) * 5) + '%'; }
      for (const s of busEls) {
        const v = m.b?.[s.id], bm = m.bm?.[s.id];
        if (v) { s.L.set(v[0] / 1000); s.R.set(v[1] / 1000); }
        if (bm) { s.comp.style.width = Math.min(100, bm.gr * 6) + '%'; s.lim.style.width = Math.min(100, bm.lim * 6) + '%'; s.duck.style.width = Math.min(100, bm.duck * 8) + '%'; }
      }
      for (const s of fxEls) { s.meter.set(m.fx[s.i] / 1000); s.duck.style.width = Math.min(100, (m.fxd?.[s.i] || 0) * 8) + '%'; }
      if (masterEls) { masterEls.L.set(m.m[0] / 1000); masterEls.R.set(m.m[1] / 1000); masterEls.gr.style.width = Math.min(100, Math.max(m.mgr, m.lim) * 5) + '%'; }
    }
    if (edTarget != null && edLive) edLive(m);
    if (m.au) {
      for (const [c, v] of Object.entries(m.au.f)) reg.get(`channels/${c}/fader`)?.set(v);
      for (const [c, v] of Object.entries(m.au.p)) reg.get(`channels/${c}/pan`)?.set(v);
      for (const [c, v] of Object.entries(m.au.m)) reg.get(`channels/${c}/mute`)?.set(v >= 0.5);
      if (m.au.M != null) reg.get('master/fader')?.set(m.au.M);
    }
    if (m.av) for (const [p, v] of Object.entries(m.av)) {
      const path = p.split('/').map(x => /^\d+$/.test(x) ? +x : x);
      if (path[0] !== 'ins') { applyPath(S.mixer, path, v); reg.get(p)?.set(v); }
    }
  });
  on('session', () => $$('.strip .tog.auto').forEach(b => b.dispatchEvent(new Event('repaint'))));

  // ---------------------------------------------------------- scenes
  const SCOPES = [['faders', 'Faders & pan'], ['mutes', 'Mutes'], ['eq', 'EQ & filters'], ['dynamics', 'Dynamics, saturation, limiter'],
    ['sends', 'FX sends'], ['fx', 'FX settings'], ['routing', 'Routing']];
  const DEF_SCOPE = ['faders', 'mutes', 'sends', 'fx'];
  function sceneScope() { try { return JSON.parse(localStorage.getItem('stobite.sceneScope')) || DEF_SCOPE; } catch (e) { return DEF_SCOPE; } }
  function sceneSafe() { try { return JSON.parse(localStorage.getItem('stobite.sceneSafe')) || []; } catch (e) { return []; } }
  async function renderSceneBar() {
    let list = [];
    try { list = await api('scenes'); } catch (e) { }
    const bar = $('#sceneBar'); bar.innerHTML = '';
    for (const n of list.slice(0, 10)) bar.append(h('button', { class: 'scene-chip', title: 'Recall ' + n + ' (' + sceneScope().join(', ') + ')', onclick: () => recall(n) }, n));
  }
  async function recall(n) {
    await tryApi('scene-load', { name: n, scope: sceneScope(), safe: sceneSafe() });
    toast(`Recalled “${n}”: ${sceneScope().join(', ')}`);
  }
  $('#btnScenes').onclick = () => modal(async (card, close) => {
    card.classList.add('wide');
    const names = (CATALOG?.sceneNames || []);
    const name = h('input', { placeholder: 'Scene name', style: 'flex:1' });
    const scope = sceneScope(), safe = new Set(sceneSafe());
    const scopeBox = h('div', { class: 'scope' }, ...SCOPES.map(([k, l]) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: scope.includes(k), onchange: e => {
      const s = new Set(sceneScope()); e.target.checked ? s.add(k) : s.delete(k);
      try { localStorage.setItem('stobite.sceneScope', JSON.stringify([...s])); } catch (er) { }
      renderSceneBar();
    } }), l)));
    const safeBox = h('div', { class: 'safe-list' }, ...S.mixer.order.map(c => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: safe.has(c), onchange: e => {
      e.target.checked ? safe.add(c) : safe.delete(c);
      try { localStorage.setItem('stobite.sceneSafe', JSON.stringify([...safe])); } catch (er) { }
    } }), S.mixer.channels[c].name)));
    const list = h('div', { class: 'list' });
    card.append(h('h3', {}, 'Scenes'),
      h('p', { class: 'hint' }, 'Save the mix as a scene (Worship, Preaching…). Recalling changes only the parts ticked below; everything else stays as it is.'),
      h('div', { style: 'display:flex;gap:6px' }, name, h('button', { class: 'btn accent', onclick: async () => { if (!name.value) return; await tryApi('scene-save', { name: name.value }); toast('Saved scene ' + name.value); close(); renderSceneBar(); } }, 'Save current mix')),
      h('div', { class: 'quick' }, ...names.map(n => h('button', { class: 'mini', onclick: () => name.value = n }, n))),
      h('h4', {}, 'Recall changes'), scopeBox,
      h('details', {}, h('summary', {}, 'Recall-safe channels (scenes never touch these)'), safeBox),
      h('h4', {}, 'Saved scenes'), list,
      h('div', { class: 'acts' }, h('button', { class: 'btn danger', onclick: async () => { if (confirm('Reset every channel and bus to flat defaults?')) { await tryApi('mixer-reset', {}); close(); } } }, 'Reset mixer'), h('button', { class: 'btn', onclick: close }, 'Close')));
    const sc = await api('scenes');
    if (!sc.length) list.append(h('p', { class: 'hint' }, 'No scenes yet.'));
    for (const s of sc) list.append(h('div', { class: 'li' }, s,
      h('span', {}, h('button', { class: 'mini', onclick: async () => { await recall(s); close(); } }, 'Recall'), ' ',
        h('button', { class: 'mini', onclick: async () => { await tryApi('scene-load', { name: s }); toast('Loaded everything from ' + s); close(); } }, 'Load all'), ' ',
        h('button', { class: 'mini', onclick: async () => { if (confirm('Delete scene ' + s + '?')) { await api('scene-delete', { name: s }); close(); renderSceneBar(); } } }, '✕'))));
  });

  // ---------------------------------------------------------- editor
  let edLive = null, edCtl = new Map(), edRefresh = () => { };
  window.openEditor = function (t) {
    if (t == null) return;
    const base = pathOf(t);
    if (base[1] < 0) return;
    edTarget = t;
    edCtl = new Map();
    const st = objOf(t);
    const kind = t === 'master' ? 'master' : String(t).startsWith('bus:') ? 'bus' : String(t).startsWith('fx:') ? 'fx' : 'ch';
    const P = (...p) => [...base, ...p];
    const K = (p, opts) => { const k = Knob({ ...opts, value: getPath(S.mixer, p) ?? opts.def ?? 0, onChange: v => setParam(p, v) }); edCtl.set(key(p), k); return k.el; };
    const T = (p, label = 'ON') => { const b = h('button', { class: 'tog g' + (getPath(S.mixer, p) ? ' on' : ''), onclick: () => setParam(p, !getPath(S.mixer, p)) }, label); edCtl.set(key(p), { set: v => b.classList.toggle('on', !!v) }); return b; };
    const S_ = (p, options, extra) => { const s = sel(p, options, extra); edCtl.set(key(p), { set: v => s.value = v }); return s; };
    const help = topic => h('button', { class: 'help', title: 'What does this do?', onclick: () => openGuide(topic) }, '?');
    const panel = (title, topic, togglePath, ...kids) => h('div', { class: 'panel' }, h('h4', {}, title, help(topic), togglePath ? T(togglePath) : null), ...kids);
    $('#edName').value = st.name;
    $('#edName').disabled = kind === 'master';
    $('#edName').onchange = e => kind !== 'master' && setParam(P('name'), e.target.value);
    const body = $('#edBody'); body.innerHTML = '';
    const live = {};

    // ---- signal flow breadcrumb
    const flow = h('div', { class: 'flow panel full' });
    const step = (label, cls, onclick) => h(onclick ? 'button' : 'span', { class: 'fstep ' + (cls || ''), onclick }, label);
    const arrow = () => h('span', { class: 'farrow' }, '→');
    const chainFrom = d => {
      let guard = 0;
      while (d && d !== 'none' && guard++ < 8) {
        const dd = d;
        flow.append(step(destName(dd), 'bus', dd === 'master' ? () => openEditor('master') : () => openEditor('bus:' + dd)), arrow());
        if (dd === 'master') break;
        d = S.mixer.buses.find(b => b.id === dd)?.out;
      }
      flow.append(step('Stream out', 'out'));
    };
    if (kind === 'ch') { flow.append(step(inputLabel(st.input), 'in'), arrow(), step(st.name, 'cur'), arrow(), step('EQ · dynamics · inserts'), arrow(), step('sends → FX'), arrow()); chainFrom(st.out); }
    else if (kind === 'bus') { flow.append(step('Channels routed here', 'in'), arrow(), step(st.name, 'cur'), arrow()); chainFrom(st.out); }
    else if (kind === 'fx') { flow.append(step('Channel sends', 'in'), arrow(), step(st.name, 'cur'), arrow()); chainFrom(st.out); }
    else flow.append(step('Broadcast & buses', 'in'), arrow(), step('Master chain', 'cur'), arrow(), step('Main outputs / stream', 'out'), arrow(), step('Virtual cables', 'out'));
    body.append(flow);

    if (kind === 'fx') { buildFxEditor(t, st, body, P, K, T, S_, panel, live); finishEditor(t, kind, st, live); return; }

    // ---- input / routing
    if (kind === 'ch') {
      const presetSel = h('select', { onchange: e => { if (e.target.value) { applyChannelPreset(t, e.target.value); openEditor(t); toast('Loaded ' + e.target.value + ' starting point'); } } },
        h('option', { value: '' }, 'Load a starting preset…'), ...Object.keys(CATALOG?.channelPresets || {}).map(n => h('option', { value: n }, n)));
      const inst = CATALOG?.instruments.find(i => i.key === st.type);
      body.append(panel('Input & routing', 'input', null,
        h('div', { class: 'frow' }, h('button', { class: 'btn', onclick: () => pickFor(t) }, icon(st.icon || 'input', 18), inst ? inst.label : 'Choose instrument…'),
          h('input', { type: 'color', value: st.color, class: 'colorpick', onchange: e => setParam(P('color'), e.target.value) })),
        h('div', { class: 'f2' }, h('span', {}, 'Input'), S_(P('input'), inputOptions())),
        h('div', { class: 'f2' }, h('span', {}, 'Output bus'), S_(P('out'), destOptions(), { onchange: () => openEditor(t) })),
        presetSel,
        h('div', { class: 'knobs' }, K(P('trim'), { label: 'Gain / trim', min: -24, max: 24, def: 0, format: fmt.db, bipolar: true, size: 40, big: true }), T(P('phase'), 'Ø Phase')),
        h('p', { class: 'hint' }, 'Recording always captures the raw input, before any of this processing.')));
    } else {
      const presetSel = h('select', { onchange: e => { if (e.target.value) { applyBusPreset(t, e.target.value); openEditor(t); toast('Loaded ' + e.target.value); } } },
        h('option', { value: '' }, 'Load a bus preset…'), ...Object.keys(CATALOG?.busPresets || {}).map(n => h('option', { value: n }, n)));
      body.append(panel(kind === 'master' ? 'Master / stream' : 'Bus routing', 'buses', null,
        kind === 'bus' ? h('div', { class: 'f2' }, h('span', {}, 'Sends to'), S_(P('out'), destOptions(st.id), { onchange: () => openEditor(t) })) : null,
        kind === 'bus' ? h('div', { class: 'frow' }, h('input', { type: 'color', value: st.color, class: 'colorpick', onchange: e => setParam(P('color'), e.target.value) }),
          st.id !== 'broadcast' ? h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove bus ' + st.name + '? Anything routed to it moves to where it was going.')) { closeEd(); await tryApi('bus-remove', { id: st.id }); } } }, 'Remove bus') : null) : null,
        presetSel,
        h('div', { class: 'knobs' }, K(P('width'), { label: 'Width', min: 0, max: 200, def: 100, format: v => Math.round(v) + '%', size: 36 }),
          K(P('balance'), { label: 'Balance', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 36 }),
          K(P('fader'), { label: 'Fader', min: -90, max: 10, def: 0, format: fmt.db, size: 36 }))));
    }

    // ---- filters
    const slopeOpts = [[12, '12 dB/oct'], [24, '24 dB/oct'], [48, '48 dB/oct']];
    body.append(panel('Low cut / high cut', 'hpf', null,
      h('div', { class: 'cutrow' }, T(P('hpf', 'on'), 'Low cut'), K(P('hpf', 'freq'), { label: 'Freq', min: 20, max: 1000, log: true, def: 80, format: fmt.hz, size: 36 }), S_(P('hpf', 'slope'), slopeOpts, { num: true })),
      h('div', { class: 'cutrow' }, T(P('lpf', 'on'), 'High cut'), K(P('lpf', 'freq'), { label: 'Freq', min: 1000, max: 20000, log: true, def: 16000, format: fmt.hz, size: 36 }), S_(P('lpf', 'slope'), slopeOpts, { num: true })),
      h('p', { class: 'hint' }, 'Leave the low end to kick and bass: cut lows on vocals, guitars, keys, overheads and FX.')));

    // ---- EQ
    const graph = h('canvas', { class: 'eqgraph' });
    let activeBand = -1, liveSpec = null, edEq = null;
    const bands = h('div', { class: 'eqbands' });
    const TYPE_OPTS = [['bell', 'Bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf'], ['notch', 'Notch'], ['hp', 'High-pass'], ['lp', 'Low-pass']];
    st.eq.bands.forEach((b, i) => {
      const bp = P('eq', 'bands', i);
      const isCut = b.type === 'hp' || b.type === 'lp';
      bands.append(h('div', { class: 'eqband', style: `border-color:${BAND_COLORS[i]}` },
        h('div', { class: 'frow' }, S_([...bp, 'type'], TYPE_OPTS, { onchange: () => setTimeout(() => openEditor(t), 30) }), T([...bp, 'on'], String(i + 1))),
        h('div', { class: 'knobs' }, K([...bp, 'freq'], { label: 'Freq', min: 20, max: 20000, log: true, def: b.freq, format: fmt.hz, size: 30, color: BAND_COLORS[i] }),
          isCut ? S_([...bp, 'slope'], slopeOpts, { num: true }) : K([...bp, 'gain'], { label: 'Gain', min: -18, max: 18, def: 0, format: fmt.db, size: 30, bipolar: true, color: BAND_COLORS[i] }),
          isCut ? null : K([...bp, 'q'], { label: 'Q', min: 0.1, max: 10, log: true, def: 1, format: fmt.q, size: 30, color: BAND_COLORS[i] }))));
    });
    const redrawEq = () => { edEq = drawEqCurve(graph, objOf(t), fs(), { grid: true, nodes: true, active: activeBand, spectrum: liveSpec }); };
    graph.addEventListener('pointerdown', e => {
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (!edEq) return;
      let best = -1, bd = 22;
      objOf(t).eq.bands.forEach((b, i) => { const d = Math.hypot(edEq.fx(b.freq) - x, edEq.gy(['notch', 'hp', 'lp'].includes(b.type) ? 0 : b.gain) - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      activeBand = best; graph.setPointerCapture(e.pointerId);
      const bp = P('eq', 'bands', best);
      if (!getPath(S.mixer, P('eq', 'on'))) setParam(P('eq', 'on'), true);
      const mv = ev => {
        const xx = clamp(ev.clientX - r.left, 0, edEq.W), yy = clamp(ev.clientY - r.top, 0, edEq.H);
        const f = Math.round(20 * Math.pow(1000, xx / edEq.W));
        const gn = Math.round(clamp((edEq.H / 2 - yy) / (edEq.H / 2 - 4) * edEq.range, -18, 18) * 10) / 10;
        setParam([...bp, 'freq'], f); edCtl.get(key([...bp, 'freq']))?.set(f);
        if (!['notch', 'hp', 'lp'].includes(getPath(S.mixer, [...bp, 'type']))) { setParam([...bp, 'gain'], gn); edCtl.get(key([...bp, 'gain']))?.set(gn); }
        redrawEq();
      };
      const up = () => { graph.removeEventListener('pointermove', mv); graph.removeEventListener('pointerup', up); activeBand = -1; redrawEq(); };
      graph.addEventListener('pointermove', mv); graph.addEventListener('pointerup', up);
      redrawEq();
    });
    graph.addEventListener('wheel', e => {
      if (!edEq) return; e.preventDefault();
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left;
      let best = 0, bd = 1e9; objOf(t).eq.bands.forEach((b, i) => { const d = Math.abs(edEq.fx(b.freq) - x); if (d < bd) { bd = d; best = i; } });
      const qp = P('eq', 'bands', best, 'q'); const q = clamp((getPath(S.mixer, qp) || 1) * (e.deltaY > 0 ? 0.92 : 1.08), 0.1, 10);
      setParam(qp, Math.round(q * 100) / 100); edCtl.get(key(qp))?.set(q); redrawEq();
    }, { passive: false });
    graph.addEventListener('dblclick', e => {
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      objOf(t).eq.bands.forEach((b, i) => { if (Math.hypot(edEq.fx(b.freq) - x, edEq.gy(b.gain) - y) < 14) { setParam(P('eq', 'bands', i, 'gain'), 0); edCtl.get(key(P('eq', 'bands', i, 'gain')))?.set(0); } });
      redrawEq();
    });
    body.append(h('div', { class: 'panel wide' }, h('h4', {}, 'Parametric EQ', help('eq'), h('span', { class: 'hint lc' }, 'drag points · scroll = width · double-click = flat'), T(P('eq', 'on'))), graph, bands));

    // ---- dynamics
    if (kind === 'ch') {
      live.gate = h('span', { class: 'hint lc' });
      body.append(panel('Gate / expander', 'gate', P('gate', 'on'),
        h('div', { class: 'knobs' }, K(P('gate', 'thr'), { label: 'Threshold', min: -80, max: 0, def: -50, format: fmt.db, size: 38, big: true }),
          K(P('gate', 'range'), { label: 'Range', min: 3, max: 80, def: 40, format: v => '-' + Math.round(v) + 'dB', size: 38, big: true }),
          K(P('gate', 'att'), { label: 'Attack', min: 0.1, max: 50, log: true, def: 1, format: fmt.ms, size: 32 }),
          K(P('gate', 'rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 120, format: fmt.ms, size: 32 })), live.gate,
        h('p', { class: 'hint' }, 'Small range (6–15 dB) works as a gentle expander; a large range is a hard gate.')));
    }
    const cg = h('canvas', { class: 'compgraph' });
    live.grbar = h('i'); live.grTxt = h('span', { class: 'hint lc' });
    const drawComp = () => {
      const c = objOf(t).comp, dpr = devicePixelRatio || 1, W = 100, H = 100;
      cg.width = W * dpr; cg.height = H * dpr; const g = cg.getContext('2d'); g.scale(dpr, dpr);
      g.strokeStyle = '#1f2328'; for (let d = -60; d <= 0; d += 12) { const p = (d + 60) / 60 * W; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, H); g.moveTo(0, H - p); g.lineTo(W, H - p); g.stroke(); }
      g.beginPath();
      for (let x = 0; x <= W; x++) {
        const inp = -60 + x / W * 60, over = inp - c.thr, k = Math.max(c.knee, 0.01), sl = 1 - 1 / c.ratio;
        const red = Math.min(over <= -k / 2 ? 0 : over >= k / 2 ? over * sl : sl * (over + k / 2) ** 2 / (2 * k), c.range ?? 60);
        const out = inp - (c.on ? red : 0) + (c.on ? c.makeup : 0);
        const y = H - (out + 60) / 60 * H; x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = c.on ? '#f76b15' : '#555'; g.lineWidth = 2; g.stroke();
    };
    body.append(h('div', { class: 'panel' }, h('h4', {}, 'Compressor', help('comp'), live.grTxt, T(P('comp', 'on'))),
      h('div', { class: 'compwrap' }, h('div', {}, cg, h('div', { class: 'grbar' }, live.grbar)), h('div', { class: 'knobs' },
        K(P('comp', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -18, format: fmt.db, size: 38, big: true }),
        K(P('comp', 'ratio'), { label: 'Ratio', min: 1, max: 20, log: true, def: 3, format: fmt.ratio, size: 38, big: true }),
        K(P('comp', 'att'), { label: 'Attack', min: 0.1, max: 200, log: true, def: 10, format: fmt.ms, size: 30 }),
        K(P('comp', 'rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 150, format: fmt.ms, size: 30 }),
        K(P('comp', 'knee'), { label: 'Knee', min: 0, max: 24, def: 6, format: v => v.toFixed(0) + 'dB', size: 30 }),
        K(P('comp', 'makeup'), { label: 'Makeup', min: 0, max: 24, def: 0, format: fmt.db, size: 30 }),
        K(P('comp', 'mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 30 }),
        K(P('comp', 'range'), { label: 'Max GR', min: 1, max: 40, def: 30, format: v => Math.round(v) + 'dB', size: 30 }))),
      kind !== 'ch' ? h('div', { class: 'f2' }, h('span', {}, 'Sidechain from'), S_(P('comp', 'sc'), scOptions())) : null,
      h('p', { class: 'hint' }, 'Mix below 100% = parallel compression: punch and density without losing dynamics.')));

    if (kind === 'ch') {
      live.dsBar = h('i'); live.dsTxt = h('span', { class: 'hint lc' });
      body.append(panel('De-esser', 'deess', P('deess', 'on'),
        h('div', { class: 'knobs' }, K(P('deess', 'freq'), { label: 'Frequency', min: 3000, max: 12000, log: true, def: 6500, format: fmt.hz, size: 36, big: true }),
          K(P('deess', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -28, format: fmt.db, size: 36, big: true }),
          K(P('deess', 'range'), { label: 'Max cut', min: 1, max: 20, def: 8, format: v => '-' + v.toFixed(0) + 'dB', size: 30 })),
        h('div', { class: 'grbar' }, live.dsBar), live.dsTxt));
      const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      live.tuneNote = h('div', { class: 'tune-note' }, '—');
      live.tuneNeedle = h('i');
      live.tuneTxt = h('div', { class: 'hint' }, 'Sing or play to see the pitch');
      body.append(panel('Auto-tune (pitch correction)', 'tune', P('tune', 'on'),
        h('div', { class: 'tune-read' }, live.tuneNote, h('div', { class: 'tune-meter', title: 'How far off the singer is: centre = in tune' }, h('b'), live.tuneNeedle), live.tuneTxt),
        h('div', { class: 'f2' }, h('span', {}, 'Song key'), h('div', { class: 'frow' },
          S_(['song', 'key'], KEYS.map(k => [k, k])), S_(['song', 'scale'], [['major', 'Major'], ['minor', 'Minor'], ['harmonic minor', 'Harmonic minor'], ['pentatonic', 'Pentatonic']]))),
        h('div', { class: 'f2' }, h('span', {}, 'Notes'), S_(P('tune', 'scale'), [['song', 'Song key (recommended)'], ['chromatic', 'Any note (chromatic)']])),
        h('div', { class: 'f2' }, h('span', {}, 'Voice'), S_(P('tune', 'voice'), [['any', 'Any'], ['soprano', 'Soprano'], ['alto', 'Alto'], ['tenor', 'Tenor'], ['baritone', 'Baritone / bass']])),
        h('div', { class: 'knobs' },
          K(P('tune', 'speed'), { label: 'Retune speed', min: 0, max: 400, def: 40, format: v => v < 1 ? 'Robot' : Math.round(v) + 'ms', size: 38, big: true, color: '#b18cff' }),
          K(P('tune', 'amount'), { label: 'Amount', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#b18cff' })),
        h('div', { class: 'quick' },
          h('button', { class: 'mini', onclick: () => { setParam(P('tune'), { ...objOf(t).tune, on: true, speed: 80, amount: 60 }); openEditor(t); } }, 'Natural'),
          h('button', { class: 'mini', onclick: () => { setParam(P('tune'), { ...objOf(t).tune, on: true, speed: 30, amount: 100 }); openEditor(t); } }, 'Polished'),
          h('button', { class: 'mini', onclick: () => { setParam(P('tune'), { ...objOf(t).tune, on: true, speed: 0, amount: 100 }); openEditor(t); } }, 'Hard (effect)')),
        h('p', { class: 'hint' }, 'Set the song key first. For worship, “Natural” (slow speed, partial amount) fixes pitchy notes without sounding tuned. Adds about 15 ms of delay to this channel only.')));
      body.append(panel('Transient shaper', 'trans', P('trans', 'on'),
        h('div', { class: 'knobs' }, K(P('trans', 'attack'), { label: 'Attack', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 38, big: true }),
          K(P('trans', 'sustain'), { label: 'Sustain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 38, big: true })),
        h('p', { class: 'hint' }, '+Attack = more stick and punch. −Sustain = tighter drums, less ring.')));
    }

    // ---- dynamic EQ
    const dynBands = h('div', { class: 'dynbands' });
    (st.dyneq?.bands || []).forEach((b, i) => {
      const bp = P('dyneq', 'bands', i);
      dynBands.append(h('div', { class: 'dynband' }, h('div', { class: 'frow' }, T([...bp, 'on'], 'Band ' + (i + 1)),
        S_([...bp, 'type'], [['bell', 'Bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf']])),
        h('div', { class: 'knobs' },
          K([...bp, 'freq'], { label: 'Freq', min: 20, max: 20000, log: true, def: 1000, format: fmt.hz, size: 30 }),
          K([...bp, 'q'], { label: 'Q', min: 0.2, max: 8, log: true, def: 1.5, format: fmt.q, size: 30 }),
          K([...bp, 'thr'], { label: 'Threshold', min: -60, max: 0, def: -24, format: fmt.db, size: 30 }),
          K([...bp, 'range'], { label: 'Range', min: -12, max: 12, def: -3, format: fmt.db, bipolar: true, size: 30 }),
          K([...bp, 'gain'], { label: 'Static', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 30 }),
          K([...bp, 'att'], { label: 'Attack', min: 0.5, max: 100, log: true, def: 5, format: fmt.ms, size: 30 }),
          K([...bp, 'rel'], { label: 'Release', min: 20, max: 1000, log: true, def: 120, format: fmt.ms, size: 30 }))));
    });
    body.append(h('div', { class: 'panel' + (kind === 'ch' ? '' : ' wide') }, h('h4', {}, 'Dynamic EQ', help('dyneq'), T(P('dyneq', 'on'))), dynBands,
      kind !== 'ch' ? h('div', { class: 'f2' }, h('span', {}, 'Sidechain from'), S_(P('dyneq', 'sc'), scOptions())) : null,
      h('p', { class: 'hint' }, 'Acts only when that band gets loud: tames harshness, mud or boom without dulling the quiet parts. Negative range cuts, positive boosts.')));

    // ---- saturation
    body.append(panel('Saturation', 'sat', P('sat', 'on'),
      h('div', { class: 'frow' }, S_(P('sat', 'type'), [['tape', 'Tape'], ['tube', 'Tube'], ['console', 'Console'], ['soft', 'Soft clip']])),
      h('div', { class: 'knobs' }, K(P('sat', 'drive'), { label: 'Drive', min: 0, max: 18, def: 3, format: v => '+' + v.toFixed(1) + 'dB', size: 38, big: true, color: '#ffb366' }),
        K(P('sat', 'mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#ffb366' })),
      h('p', { class: 'hint' }, 'Aim for density you feel, not distortion you hear.')));

    // ---- bus-only: multiband, limiter, ducking, chain order
    if (kind !== 'ch') {
      live.mbc = h('div', { class: 'hint' });
      body.append(h('div', { class: 'panel wide' }, h('h4', {}, 'Multiband compressor', help('mbc'), T(P('mbc', 'on'))),
        h('div', { class: 'knobs' }, K(P('mbc', 'x1'), { label: 'Low/mid split', min: 60, max: 800, log: true, def: 180, format: fmt.hz, size: 34 }),
          K(P('mbc', 'x2'), { label: 'Mid/high split', min: 1000, max: 10000, log: true, def: 3500, format: fmt.hz, size: 34 })),
        h('div', { class: 'mbbands' }, ...(st.mbc?.bands || []).map((b, i) => h('div', { class: 'mbband' }, h('b', {}, ['Low', 'Mid', 'High'][i]),
          h('div', { class: 'knobs' },
            K(P('mbc', 'bands', i, 'thr'), { label: 'Threshold', min: -50, max: 0, def: -20, format: fmt.db, size: 30 }),
            K(P('mbc', 'bands', i, 'ratio'), { label: 'Ratio', min: 1, max: 10, log: true, def: 2, format: fmt.ratio, size: 30 }),
            K(P('mbc', 'bands', i, 'att'), { label: 'Attack', min: 1, max: 200, log: true, def: 20, format: fmt.ms, size: 30 }),
            K(P('mbc', 'bands', i, 'rel'), { label: 'Release', min: 20, max: 1500, log: true, def: 200, format: fmt.ms, size: 30 }),
            K(P('mbc', 'bands', i, 'range'), { label: 'Range', min: 1, max: 20, def: 3, format: v => '-' + v.toFixed(0) + 'dB', size: 30 }),
            K(P('mbc', 'bands', i, 'gain'), { label: 'Gain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 30 }))))),
        live.mbc));
      live.limTxt = h('span', { class: 'hint lc' }); live.limBar = h('i');
      body.append(panel('Limiter', 'limiter', P('limiter', 'on'),
        h('div', { class: 'knobs' },
          K(P('limiter', 'threshold'), { label: 'Threshold', min: -12, max: 0, def: 0, format: fmt.db, size: 36, big: true }),
          K(P('limiter', 'ceiling'), { label: 'Ceiling', min: -6, max: 0, def: -1, format: fmt.db, size: 36, big: true }),
          K(P('limiter', 'release'), { label: 'Release', min: 10, max: 1000, log: true, def: 150, format: fmt.ms, size: 30 }),
          K(P('limiter', 'lookahead'), { label: 'Lookahead', min: 0.5, max: 5, def: 1.5, format: v => v.toFixed(1) + 'ms', size: 30 }),
          K(P('limiter', 'gain'), { label: 'Input gain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 30 })),
        h('div', { class: 'frow' }, T(P('limiter', 'truepeak'), 'True peak'), live.limTxt), h('div', { class: 'grbar' }, live.limBar),
        h('p', { class: 'hint' }, 'A safety net that should only catch the loudest peaks (1–3 dB). If it works harder, turn the mix down.')));
      if (kind === 'bus') {
        live.duckBar = h('i'); live.duckTxt = h('span', { class: 'hint lc' });
        body.append(panel('Ducking (sidechain)', 'duck', P('duck', 'on'),
          h('div', { class: 'f2' }, h('span', {}, 'Duck when'), S_(P('duck', 'src'), scOptions())),
          h('div', { class: 'knobs' }, K(P('duck', 'amount'), { label: 'Max duck', min: 0.5, max: 20, def: 2, format: v => '-' + v.toFixed(1) + 'dB', size: 34, big: true }),
            K(P('duck', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -30, format: fmt.db, size: 34, big: true }),
            K(P('duck', 'ratio'), { label: 'Ratio', min: 1, max: 20, log: true, def: 4, format: fmt.ratio, size: 30 }),
            K(P('duck', 'att'), { label: 'Attack', min: 1, max: 200, log: true, def: 15, format: fmt.ms, size: 30 }),
            K(P('duck', 'rel'), { label: 'Release', min: 50, max: 3000, log: true, def: 400, format: fmt.ms, size: 30 })),
          h('div', { class: 'grbar' }, live.duckBar), live.duckTxt,
          h('p', { class: 'hint' }, 'Example: the Music bus dips 1–2 dB while the Lead Vocal sings, or while the preacher talks over a pad.')));
      }
      const NAMES = { eq: ['EQ & filters', ['eq', 'on']], comp: ['Compressor', ['comp', 'on']], sat: ['Saturation', ['sat', 'on']], dyneq: ['Dynamic EQ', ['dyneq', 'on']],
        mbc: ['Multiband', ['mbc', 'on']], width: ['Width / balance', null], limiter: ['Limiter', ['limiter', 'on']] };
      const chainBox = h('div', { class: 'chain-list' });
      const renderChain = () => {
        chainBox.innerHTML = '';
        const chain = objOf(t).chain || Object.keys(NAMES);
        chain.forEach((m, i) => {
          const [label, onp] = NAMES[m] || [m, null];
          const row = h('div', { class: 'chain-item', draggable: 'true' }, icon('drag', 14), h('span', { class: 'n' }, `${i + 1}. ${label}`),
            onp ? T(P(...onp)) : h('span', { class: 'hint' }, 'always'),
            h('button', { class: 'mini', disabled: i === 0, onclick: () => { const c = [...chain]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setParam(P('chain'), c); renderChain(); } }, '↑'),
            h('button', { class: 'mini', disabled: i === chain.length - 1, onclick: () => { const c = [...chain]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; setParam(P('chain'), c); renderChain(); } }, '↓'));
          row.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', String(i)));
          row.addEventListener('dragover', e => e.preventDefault());
          row.addEventListener('drop', e => { e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'); const c = [...chain]; const [x] = c.splice(from, 1); c.splice(i, 0, x); setParam(P('chain'), c); renderChain(); });
          chainBox.append(row);
        });
      };
      renderChain();
      body.append(panel('Processing order', 'chain', null, chainBox, h('p', { class: 'hint' }, 'Drag (or use the arrows) to reorder. Each ON switch bypasses that processor instantly.')));
    }

    // ---- sends
    if (kind !== 'master') {
      body.append(panel('Sends & output', 'sends', null,
        h('div', { class: 'knobs' }, ...S.mixer.fx.map((f, i) => K(P('sends', i), { label: '→ ' + f.name, min: -90, max: 10, def: -90, format: fmt.db, size: 34, color: '#3aa0ff' })),
          kind === 'ch' ? K(P('pan'), { label: 'Pan', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 38, big: true }) : null,
          kind === 'ch' ? K(P('fader'), { label: 'Fader', min: -90, max: 10, def: 0, format: fmt.db, size: 38, big: true }) : null),
        h('p', { class: 'hint' }, 'Sends feed the shared reverbs and delay. Lead vocal: a little plate and delay. Backing vocals: more hall.')));
    }

    body.append(insertsPanel(t, kind, st, panel));
    finishEditor(t, kind, st, live, { redrawEq, drawComp, setSpec: s => { liveSpec = s; } });
  };

  function finishEditor(t, kind, st, live, fns = {}) {
    edLive = m => {
      if (kind === 'ch') {
        const gr = m.gr[t] || 0;
        live.grbar.style.width = Math.min(100, gr * 5) + '%'; live.grTxt.textContent = gr > 0.1 ? `-${gr.toFixed(1)} dB` : '';
        live.gate.textContent = objOf(t).gate.on ? ((m.gg[t] || 0) > 3 ? '● closed' : '○ open') : '';
        const ds = m.ds?.[t] || 0; live.dsBar.style.width = Math.min(100, ds * 8) + '%'; live.dsTxt.textContent = ds > 0.1 ? `-${ds.toFixed(1)} dB` : '';
        const at = m.at?.[t];
        if (live.tuneNote) {
          if (at) {
            live.tuneNote.textContent = at.note;
            live.tuneNeedle.style.left = `calc(50% + ${clamp(at.cents, -50, 50)}%)`;
            live.tuneNeedle.style.background = Math.abs(at.cents) < 10 ? 'var(--green)' : Math.abs(at.cents) < 25 ? 'var(--yellow)' : 'var(--red)';
            live.tuneTxt.textContent = `${at.hz} Hz · sung ${at.cents > 0 ? '+' : ''}${at.cents} cents · corrected ${at.shift > 0 ? '+' : ''}${at.shift} cents`;
          } else if (!objOf(t).tune.on) { live.tuneNote.textContent = '—'; live.tuneTxt.textContent = 'Turn on to detect pitch'; }
        }
        if (m.csp && fns.setSpec) {
          const prev = live._spec;
          live._spec = prev && prev.length === m.csp.length ? m.csp.map((v, i) => Math.max(v, prev[i] - 1.5)) : m.csp;
          fns.setSpec(live._spec); fns.redrawEq();
        }
      } else if (kind === 'bus' || kind === 'master') {
        const bm = kind === 'master' ? m.mm : m.bm?.[st.id];
        if (!bm) return;
        live.grbar.style.width = Math.min(100, bm.gr * 6) + '%'; live.grTxt.textContent = bm.gr > 0.1 ? `-${bm.gr.toFixed(1)} dB` : '';
        live.limBar.style.width = Math.min(100, bm.lim * 6) + '%'; live.limTxt.textContent = bm.lim > 0.1 ? `limiting -${bm.lim.toFixed(1)} dB` : '';
        if (live.duckBar) { live.duckBar.style.width = Math.min(100, bm.duck * 8) + '%'; live.duckTxt.textContent = bm.duck > 0.1 ? `ducking -${bm.duck.toFixed(1)} dB` : ''; }
        if (live.mbc) live.mbc.textContent = bm.mbc ? 'Gain reduction: low ' + bm.mbc[0] + ' · mid ' + bm.mbc[1] + ' · high ' + bm.mbc[2] + ' dB' : '';
      } else if (kind === 'fx' && live.duckBar) {
        const d = m.fxd?.[+String(t).slice(3)] || 0; live.duckBar.style.width = Math.min(100, d * 8) + '%'; live.duckTxt.textContent = d > 0.1 ? `ducking -${d.toFixed(1)} dB` : '';
      }
    };
    const baseKey = key(pathOf(t));
    edRefresh = path => {
      const k = key(path);
      if (!(k === baseKey || k.startsWith(baseKey + '/'))) return;
      const c = edCtl.get(k); if (c) c.set(getPath(S.mixer, path));
      if (fns.drawComp && path.includes('comp')) fns.drawComp();
      if (fns.redrawEq && (path.includes('eq') || path.includes('hpf') || path.includes('lpf'))) fns.redrawEq();
    };
    send({ t: 'focus', ch: kind === 'ch' ? t : null });
    $('#editor').hidden = false;
    requestAnimationFrame(() => { fns.redrawEq && fns.redrawEq(); fns.drawComp && fns.drawComp(); });
  }

  function buildFxEditor(t, st, body, P, K, T, S_, panel, live) {
    const isRev = ['plate', 'hall', 'room'].includes(st.type), isDelay = st.type === 'delay';
    const knobs = Object.keys(st.params).filter(k => FX_PARAMS[k]).map(k => { const p = FX_PARAMS[k]; return K(P('params', k), { label: p[0], min: p[1], max: p[2], log: !!p[4], def: st.params[k], format: p[3], size: 36, color: '#3aa0ff' }); });
    body.append(h('div', { class: 'panel wide' }, h('h4', {}, isRev ? 'Reverb' : isDelay ? 'Delay' : 'Effect', h('button', { class: 'help', onclick: () => openGuide(isDelay ? 'delay' : 'reverb') }, '?')),
      h('div', { class: 'frow' }, S_(P('type'), FX_TYPE_OPTS, { onchange: () => setTimeout(() => openEditor(t), 60) }),
        isDelay ? S_(P('params', 'note'), NOTE_OPTS.map(([v, l]) => [v, l + ' note'])) : null,
        isDelay ? T(P('params', 'sync'), 'Tempo sync') : null, isDelay ? T(P('params', 'pingpong'), 'Ping-pong') : null),
      isDelay ? h('div', { class: 'frow' }, h('span', { class: 'hint' }, 'Song tempo (BPM)'), h('input', { type: 'number', min: 30, max: 240, step: 1, value: S.mixer.tempo, style: 'width:80px', onchange: e => setParam(['tempo'], +e.target.value) }),
        h('button', { class: 'btn', onclick: tapTempo }, 'Tap tempo')) : null,
      h('div', { class: 'knobs' }, ...knobs, K(P('ret'), { label: 'Return level', min: -90, max: 10, def: -6, format: fmt.db, size: 40, big: true }))));
    live.duckBar = h('i'); live.duckTxt = h('span', { class: 'hint lc' });
    body.append(panel('Ducking', 'duck', P('duck', 'on'),
      h('div', { class: 'f2' }, h('span', {}, 'Duck when'), S_(P('duck', 'src'), scOptions())),
      h('div', { class: 'knobs' }, K(P('duck', 'amount'), { label: 'Max duck', min: 0.5, max: 24, def: 6, format: v => '-' + v.toFixed(1) + 'dB', size: 34, big: true }),
        K(P('duck', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -35, format: fmt.db, size: 34, big: true }),
        K(P('duck', 'att'), { label: 'Attack', min: 1, max: 200, log: true, def: 10, format: fmt.ms, size: 30 }),
        K(P('duck', 'rel'), { label: 'Release', min: 50, max: 3000, log: true, def: 450, format: fmt.ms, size: 30 })),
      h('div', { class: 'grbar' }, live.duckBar), live.duckTxt,
      h('p', { class: 'hint' }, 'Delay ducked by the lead vocal stays quiet while they sing and blooms in the gaps between lines.')));
    body.append(panel('Output', 'buses', null, h('div', { class: 'f2' }, h('span', {}, 'Return goes to'), S_(P('out'), destOptions(), {}))));
  }
  let taps = [];
  function tapTempo() {
    const now = performance.now(); taps = taps.filter(x => now - x < 3000); taps.push(now);
    if (taps.length >= 3) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); const bpm = Math.round(60000 / iv); setParam(['tempo'], bpm); toast('Tempo ' + bpm + ' BPM'); }
  }

  function insertsPanel(t, kind, st, panel) {
    const insBox = h('div', { class: 'ins' });
    const paramBox = h('div', { class: 'params' });
    const target = kind === 'master' ? 'master' : kind === 'bus' ? 'bus:' + st.id : String(t);
    (st.inserts || []).forEach((spec, i) => {
      insBox.append(h('div', { class: 'item' + (spec.failed ? ' failed' : '') },
        h('span', { class: 'n', title: spec.path, onclick: () => showParams(i) }, spec.name),
        h('button', { class: 'tog g' + (spec.bypass ? '' : ' on'), title: 'Bypass', onclick: () => api('insert-bypass', { target, idx: i, v: !spec.bypass }) }, spec.bypass ? 'OFF' : 'ON'),
        h('button', { class: 'tog', title: 'Edit', onclick: () => showParams(i) }, '⚙'),
        h('button', { class: 'tog m', title: 'Remove', onclick: () => api('insert-remove', { target, idx: i }) }, '✕')));
    });
    async function showParams(i) {
      paramBox.innerHTML = 'Loading…';
      const ps = await tryApi('insert-params', undefined, `?target=${encodeURIComponent(target)}&idx=${i}`);
      paramBox.innerHTML = '';
      if (!ps.length) paramBox.append(h('p', { class: 'hint' }, 'This plug-in exposes no parameters.'));
      for (const p of ps) {
        const rng = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: p.value });
        const tv = h('span', { class: 'pv' }, p.text + (p.label ? ' ' + p.label : ''));
        rng.oninput = () => api('insert-param', { target, idx: i, key: p.key, v: +rng.value });
        rng.onchange = async () => { const fresh = await api('insert-params', undefined, `?target=${encodeURIComponent(target)}&idx=${i}`); const q = fresh.find(x => x.key === p.key); if (q) tv.textContent = q.text + (q.label ? ' ' + q.label : ''); };
        paramBox.append(h('label', {}, h('span', {}, p.name), rng, tv));
      }
    }
    return panel('Inserts (VST3 / AU plug-ins)', 'inserts', null, insBox,
      h('button', { class: 'btn', style: 'margin-top:6px', onclick: () => pickPlugin(target) }, icon('plus', 14), 'Add plug-in'), paramBox);
  }

  const closeEd = () => { $('#editor').hidden = true; edTarget = null; edLive = null; send({ t: 'focus', ch: null }); };
  $('#edClose').onclick = closeEd;
  const stepEd = d => {
    if (typeof edTarget === 'number') { const o = S.mixer.order, i = o.indexOf(edTarget); openEditor(o[(i + d + o.length) % o.length]); }
    else if (String(edTarget).startsWith('bus:')) { const ids = S.mixer.buses.map(b => b.id), i = ids.indexOf(edTarget.slice(4)); openEditor('bus:' + ids[(i + d + ids.length) % ids.length]); }
    else if (String(edTarget).startsWith('fx:')) { const n = S.mixer.fx.length, i = +edTarget.slice(3); openEditor('fx:' + ((i + d + n) % n)); }
  };
  $('#edPrev').onclick = () => stepEd(-1);
  $('#edNext').onclick = () => stepEd(1);
  const COPYABLE = ['hpf', 'lpf', 'eq', 'comp', 'gate', 'deess', 'dyneq', 'trans', 'sat', 'tune', 'sends', 'trim', 'mbc', 'limiter', 'chain', 'width'];
  $('#edCopy').onclick = () => { clipboard = JSON.parse(JSON.stringify(objOf(edTarget))); toast('Copied ' + clipboard.name + ' settings'); };
  $('#edPaste').onclick = () => {
    if (!clipboard) return toast('Copy a strip first', true);
    const base = pathOf(edTarget), cur = objOf(edTarget);
    for (const k of COPYABLE) if (clipboard[k] !== undefined && cur[k] !== undefined) setParam([...base, k], JSON.parse(JSON.stringify(clipboard[k])));
    openEditor(edTarget); toast('Pasted');
  };
  $('#edReset').onclick = () => {
    if (!confirm('Turn off all processing on this strip?')) return;
    const base = pathOf(edTarget), s = objOf(edTarget);
    for (const k of ['hpf', 'lpf', 'comp', 'gate', 'deess', 'dyneq', 'trans', 'sat', 'mbc']) if (s[k]) setParam([...base, k], { ...s[k], on: false });
    if (s.eq) setParam([...base, 'eq'], { on: true, bands: s.eq.bands.map(b => ({ ...b, gain: 0 })) });
    if (s.trim !== undefined) setParam([...base, 'trim'], 0);
    openEditor(edTarget);
  };

  async function pickPlugin(target) {
    modal(async (card, close) => {
      const list = h('div', { class: 'list', style: 'max-height:50vh' });
      const q = h('input', { placeholder: 'Search plug-ins…', style: 'width:100%' });
      card.append(h('h3', {}, 'Add plug-in'), h('p', { class: 'hint' }, 'Your installed VST3' + (navigator.platform.includes('Mac') ? ' and Audio Unit' : '') + ' plug-ins. Their settings appear here as sliders.'), q, list, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel')));
      list.append('Scanning…');
      const ps = await api('plugins');
      const render = () => {
        list.innerHTML = '';
        const f = ps.filter(p => p.name.toLowerCase().includes(q.value.toLowerCase()));
        if (!f.length) list.append(h('p', { class: 'hint' }, 'No plug-ins found in the standard folders.'));
        for (const p of f) list.append(h('div', { class: 'li', onclick: async () => {
          list.innerHTML = 'Loading ' + p.name + '…';
          try { await api('insert-add', { target, path: p.path }); toast('Added ' + p.name); } catch (e) { toast(p.name + ': ' + e.message, true); }
          close();
        } }, p.name, h('span', {}, p.kind)));
      };
      q.oninput = render; render();
    });
  }
  window.pickFor = pickFor;
})();
