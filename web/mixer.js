// Mixer: channel / bus / FX / master strips, and the strip editor.
(() => {
  const reg = new Map();           // path key -> control with .set (strips)
  const key = p => p.join('/');
  const bind = (path, ctl) => { reg.set(key(path), ctl); return ctl; };
  let layer = 'inputs', edTarget = null, clipboard = null, edSel = {};
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
  window.destOptions = (self) => sortOpts([['none', 'None (not routed)'], ['master', 'Master (direct)'], ...S.mixer.buses.filter(b => b.id !== self).map(b => [b.id, b.name])], 2);
  // what the 48 main inputs really are: the WING, another interface chosen in Setup, or nothing connected
  window.mainInputLabel = () => {
    const i = S.info;
    if (!i || !i.devIns || i.inIsWing || !i.inName) return 'WING USB';
    return i.inName.length > 22 ? i.inName.slice(0, 21) + '…' : i.inName;
  };
  // other microphones / interfaces the computer can see (refreshed when Setup or the editor opens)
  window.INPUT_DEVICES = [];
  window.refreshInputDevices = async () => { try { INPUT_DEVICES = (await api('devices')).filter(d => d.ins > 0); } catch (e) { } };
  refreshInputDevices();
  on('info', () => refreshInputDevices());
  const devKey = d => `${d.name} (${d.api})`;
  window.inputOptions = () => {
    const n = Math.max(S.info?.nIn || 0, 48);
    const o = [['none', 'None (no input)']];
    const mainLabel = mainInputLabel();
    for (let i = 0; i < n; i++) o.push([`in:${i}`, `${mainLabel} ${i + 1}${S.info && !S.info.devIns ? ' (not connected)' : ''}`]);
    for (let k = 0; k < 4; k++) { o.push([`cable:${2 * k}`, `Cable ${k + 1} L`]); o.push([`cable:${2 * k + 1}`, `Cable ${k + 1} R`]); }
    const mainName = S.info?.inName;
    // on Windows the same mic appears once per audio system; prefer one entry per name
    const seen = new Set();
    for (const d of INPUT_DEVICES) {
      if (d.name === mainName || seen.has(d.name)) continue;
      seen.add(d.name);
      if (d.ins === 1) o.push([`dev:${devKey(d)}|0`, `🎤 ${d.name}`]);
      else for (let c = 0; c < Math.min(d.ins, 16); c++) o.push([`dev:${devKey(d)}|${c}`, `🎤 ${d.name} — input ${c + 1}`]);
    }
    return sortOpts(o, 1);
  };
  window.scOptions = () => [['', '— none —'], ...S.mixer.buses.map(b => [`bus:${b.id}`, `Bus: ${b.name}`]),
    ...S.mixer.order.map(c => [`ch:${c}`, `Ch ${c + 1}: ${S.mixer.channels[c].name}`])];
  const inputLabel = spec => {
    if (typeof spec === 'string' && spec.startsWith('dev:')) {
      const key = spec.slice(4, spec.lastIndexOf('|')), ch = +spec.slice(spec.lastIndexOf('|') + 1);
      const name = key.replace(/ \([^)]*\)$/, '');
      const d = INPUT_DEVICES.find(x => devKey(x) === key);
      return 'MIC ' + (name.length > 14 ? name.slice(0, 13) + '…' : name) + (d && d.ins > 1 ? ' ' + (ch + 1) : '');
    }
    if (typeof spec === 'string' && spec.startsWith('in:')) return 'IN ' + (+spec.slice(3) + 1) + (S.info && !S.info.devIns ? ' · off' : '');
    const o = inputOptions().find(o => o[0] === spec); return o ? o[1] : '—';
  };
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
  let mixerStale = true;
  function buildMixer() {
    if (!S.mixer) return;
    if (S.view !== 'mixer') { mixerStale = true; return; }  // built when you open the Mixer
    mixerStale = false;
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
    for (const s of stripEls) drawEqCurve(s.thumb, chainEqView(S.mixer.channels[s.c]), fs());
    for (const s of busEls) drawEqCurve(s.thumb, chainEqView(S.mixer.buses[s.i]), fs());
    if (masterEls) drawEqCurve(masterEls.thumb, chainEqView(S.mixer.master), fs());
  }

  // one small badge per processor, in chain order; click = bypass on/off
  function chainBadges(base, chainArr) {
    const wrap = h('div', { class: 'badges' });
    (chainArr || []).forEach((m, k) => {
      const info = CATALOG?.moduleTypes?.[m.type];
      const b = h('span', { class: 'badge' + (m.on !== false ? ' on' : ''), title: (k + 1) + '. ' + (m.type === 'plugin' ? m.name : info?.label || m.type) + ' (click to bypass)',
        onclick: e => { e.stopPropagation(); setParam([...base, 'chain', k, 'on'], !(getPath(S.mixer, [...base, 'chain', k, 'on']) !== false)); } },
        m.type === 'plugin' ? (m.name || 'PLUG').slice(0, 6).toUpperCase() : (info?.short || m.type.toUpperCase()));
      bind([...base, 'chain', k, 'on'], { set: v => b.classList.toggle('on', v !== false) });
      wrap.append(b);
    });
    if (!(chainArr || []).length) wrap.append(h('span', { class: 'badge' }, 'NO FX'));
    return wrap;
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

  // bypass: hear a channel / bus / master without its processing (fader, pan and sends stay)
  function bypassBtn(path, strip) {
    const b = h('button', { class: 'tog byp' + (getPath(S.mixer, path) ? ' on' : ''), title: 'Bypass: hear it without its processing', onclick: () => setParam(path, !getPath(S.mixer, path)) }, 'BYP');
    const show = v => { b.classList.toggle('on', !!v); strip.classList.toggle('bypassed', !!v); };
    bind(path, { set: show });
    setTimeout(() => show(getPath(S.mixer, path)));
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
    const badges = chainBadges(['channels', c], ch.chain);
    const gr = h('i');
    const sends = h('div', { class: 'sends' }, ...S.mixer.fx.map((f, i) => bind(P('sends', i), Knob({ label: f.name.split(' ').pop().slice(0, 6), min: -90, max: 10, value: ch.sends[i], def: -90, size: 26, format: fmt.db, color: '#3aa0ff', onChange: v => setParam(P('sends', i), v) })).el));
    const pan = bind(P('pan'), Knob({ label: 'Pan', min: -1, max: 1, value: ch.pan, def: 0, size: 28, format: fmt.pan, bipolar: true, onChange: v => setParam(P('pan'), v) }));
    const db = h('div', { class: 'db' }, fmt.db(ch.fader));
    const meter = Meter();
    el.append(h('div', { class: 'shead' }, ic, h('span', { class: 'snum' }, c + 1)), name, io,
      h('div', { class: 'eqthumb', onclick: () => openEditor(c) }, thumb), badges, h('div', { class: 'gr', title: 'Compressor gain reduction' }, gr),
      showSends ? sends : null, h('div', { class: 'cen' }, pan.el),
      h('div', { class: 'row' }, muteBtn(P('mute')), muteBtn(P('solo'), 's', 'S'), autoModeButton(String(c))),
      h('div', { class: 'row' }, bypassBtn(P('bypass'), el)),
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
      chainBadges(['buses', i], b.chain), h('div', { class: 'badges' }, badge('DUCK', P('duck', 'on'), 'Ducking (sidechain)')),
      h('div', { class: 'grs' }, h('div', { class: 'gr', title: 'Compression' }, comp), h('div', { class: 'gr lim', title: 'Limiter' }, lim), h('div', { class: 'gr duck', title: 'Ducking' }, duck)),
      h('div', { class: 'row' }, muteBtn(P('mute')), autoModeButton(`bus:${i}`)),
      h('div', { class: 'row' }, bypassBtn(P('bypass'), el)),
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
    const li = (m.chain || []).findIndex(x => x.type === 'limiter');
    const ceil = li >= 0 ? bind(['master', 'chain', li, 'ceiling'], Knob({ label: 'Ceiling', min: -6, max: 0, value: m.chain[li].ceiling, def: -1, size: 28, format: fmt.db, onChange: v => setParam(['master', 'chain', li, 'ceiling'], v) })) : null;
    const db = h('div', { class: 'db' }, fmt.db(m.fader));
    const L = Meter(), R = Meter(), gr = h('i');
    el.append(h('div', { class: 'shead' }, h('span', { class: 'sicon' }, icon('broadcast', 20))),
      h('div', { class: 'sname', onclick: () => openEditor('master') }, 'MASTER'),
      h('div', { class: 'eqthumb', onclick: () => openEditor('master') }, thumb),
      chainBadges(['master'], m.chain),
      h('div', { class: 'gr' }, gr), h('div', { class: 'cen' }, ceil ? ceil.el : null),
      h('div', { class: 'row' }, muteBtn(['master', 'mute']), autoModeButton('master')),
      h('div', { class: 'row' }, bypassBtn(['master', 'bypass'], el)),
      faderBlock(['master', 'fader'], [L, R], db), db);
    masterEls = { thumb, L, R, gr };
    return el;
  }
  // clear-all buttons: shown only when something is soloed / muted
  function mutedPaths() {
    const out = [];
    S.mixer.channels.forEach((c, i) => c.mute && out.push(['channels', i, 'mute']));
    S.mixer.buses.forEach((b, i) => b.mute && out.push(['buses', i, 'mute']));
    S.mixer.fx.forEach((f, i) => f.mute && out.push(['fx', i, 'mute']));
    return out;
  }
  window.clearSolos = () => { let n = 0; S.mixer.channels.forEach((c, i) => { if (c.solo) { setParam(['channels', i, 'solo'], false); n++; } }); emit('mixer'); toast(n ? `Cleared ${n} solo${n > 1 ? 's' : ''}` : 'Nothing soloed'); };
  window.clearMutes = () => { const ps = mutedPaths(); ps.forEach(p => setParam(p, false)); emit('mixer'); toast(ps.length ? `Unmuted ${ps.length}` : 'Nothing muted'); };
  $('#btnClearSolo').onclick = clearSolos;
  $('#btnClearMute').onclick = clearMutes;
  function updateClear() {
    if (!S.mixer) return;
    const ns = S.mixer.channels.filter(c => c.solo).length, nm = mutedPaths().length;
    const bs = $('#btnClearSolo'), bm = $('#btnClearMute');
    bs.hidden = !ns; bs.textContent = `Clear solos (${ns})`;
    bm.hidden = !nm; bm.textContent = `Clear mutes (${nm})`;
  }
  on('mixer', updateClear);
  let clrTick = 0;
  on('meters', () => { if (++clrTick % 5 === 0 && S.view === 'mixer') updateClear(); });

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
    setParam(['channels', c, 'chain'], freshChain(p.chain));
    if (p.sends) setParam(['channels', c, 'sends'], [...p.sends]);
  }
  function applyBusPreset(t, name) {
    const p = CATALOG?.busPresets?.[name]; if (!p) return;
    setParam([...pathOf(t), 'chain'], freshChain(p.chain));
  }
  window.applyBusPreset = applyBusPreset;
  window.applyChannelPreset = applyChannelPreset;

  // ---------------------------------------------------------- live updates
  on('mixer', () => { buildMixer(); if (edTarget != null) openEditor(edTarget); });
  on('catalog', () => { if (S.mixer) renderSceneBar(); });
  on('view', v => {
    if (v !== 'mixer') return;
    if (mixerStale) buildMixer();
    requestAnimationFrame(() => { sizeMeters(); redrawThumbs(); });
  });
  $('#showSends').onchange = buildMixer;
  window.addEventListener('resize', sizeMeters);
  let rebuildQueued = false;
  const rebuildSoon = () => { if (rebuildQueued) return; rebuildQueued = true; requestAnimationFrame(() => { rebuildQueued = false; buildMixer(); }); };
  on('set', path => {
    const ctl = reg.get(key(path));
    if (ctl) ctl.set(getPath(S.mixer, path));
    if (path[0] === 'channels') {
      const s = stripEls.find(s => s.c === path[1]);
      if (s && path[2] === 'chain') drawEqCurve(s.thumb, chainEqView(S.mixer.channels[s.c]), fs());
      if (['name', 'color', 'icon', 'out', 'input'].includes(path[2]) || (path[2] === 'chain' && path.length === 3)) rebuildSoon();
    }
    if (path[0] === 'buses') {
      const s = busEls.find(s => s.i === path[1]);
      if (s && path[2] === 'chain') drawEqCurve(s.thumb, chainEqView(S.mixer.buses[s.i]), fs());
      if (['name', 'color', 'out'].includes(path[2]) || (path[2] === 'chain' && path.length === 3)) rebuildSoon();
    }
    if (path[0] === 'master' && masterEls && path[1] === 'chain') drawEqCurve(masterEls.thumb, chainEqView(S.mixer.master), fs());
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
  const SCOPES = [['faders', 'Faders & pan'], ['mutes', 'Mutes'], ['processing', 'Processing chains (EQ, dynamics, plug-ins…)'],
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

  // ---------------------------------------------------------- mix settings (whole mix as files)
  $('#btnMixSettings').onclick = () => modal(async (card, close) => {
    card.classList.add('wide');
    const lib = await api('settings-library');
    const tplList = h('div', { class: 'tpl-list' });
    api('templates').then(list => list.forEach(t => tplList.append(h('div', { class: 'tpl', onclick: () => { close(); applyTemplate(t.id); } },
      h('div', { class: 'tpl-ic' }, icon('sparkle', 18)),
      h('div', { class: 'tpl-txt' }, h('b', {}, t.name), h('small', {}, t.style), h('p', {}, t.about)),
      h('button', { class: 'btn accent' }, 'Apply…'))))).catch(() => {});
    const name = h('input', { placeholder: 'Name, e.g. "Sunday mix – home"', value: (S.session?.name || 'Mix') + ' mix', style: 'flex:1' });
    const list = h('div', { class: 'list' });
    const folderInput = h('input', { type: 'file', hidden: true, multiple: true, webkitdirectory: true, onchange: async e => {
      const fd = new FormData();
      for (const f of e.target.files) if (/\.stobite-(channel|mix)$/.test(f.name)) fd.append('file', f, f.webkitRelativePath || f.name);
      const data = await tryApi('settings-upload', fd);
      close(); mapMix(data);
    } });
    card.append(h('h3', {}, 'Mix settings'),
      h('p', { class: 'hint' }, 'Carry your sound between computers. Saving makes a folder with one file per channel (e.g. “03 Piano.stobite-channel”) plus one for the buses, effects and master. Each channel file also goes into your sound library, so you can put “Piano” on any piano later.'),
      h('h4', {}, 'Templates: a whole sound in one go'), tplList,
      h('h4', {}, 'Save this mix'),
      h('div', { style: 'display:flex;gap:6px' }, name, h('button', { class: 'btn accent', onclick: async () => {
        const r = await tryApi('mix-save', { name: name.value });
        toast(`Saved ${r.channels} channels + buses, FX and master`); close();
      } }, 'Save')),
      h('h4', {}, 'Apply a saved mix'), list,
      h('div', { class: 'acts' },
        h('button', { class: 'btn', onclick: () => folderInput.click() }, icon('import', 14), 'From a folder…'), folderInput,
        ['localhost', '127.0.0.1'].includes(location.hostname) ? h('button', { class: 'btn', onclick: () => api('reveal', undefined, '?what=presets') }, 'Show folder') : null,
        h('button', { class: 'btn', onclick: close }, 'Close')));
    if (!lib.mixes.length) list.append(h('p', { class: 'hint' }, 'No saved mixes yet.'));
    for (const n of lib.mixes) list.append(h('div', { class: 'li', onclick: async () => { const d = await api('mix-read', undefined, '?name=' + encodeURIComponent(n)); close(); mapMix(d, n); } }, n, h('span', {}, 'Apply…')));
  });

  // ---- built-in templates: every channel gets the template's sound for its instrument
  const GUESS = [   // checked in order: the first match wins
    [/click|cue/, 'click'], [/pastor|preach|pulpit|sermon|speaker/, 'preacher'], [/host|\bmc\b|announce/, 'host'],
    [/choir/, 'choir'], [/bgv|\bbv|backing|harmony|alto|tenor|sop/, 'bgv'], [/worship lead|\bwl\b/, 'worship_vocal'],
    [/kick|kik|\bbd\b/, 'kick'], [/snare|snr|\bsd\b/, 'snare'], [/tom/, 'tom'], [/hat|\bhh\b/, 'hihat'],
    [/\boh\b|overhead|cymbal/, 'overhead'], [/room/, 'room'], [/perc|shaker|conga|cajon|bongo/, 'perc'],
    [/synth ?bass|\bsub\b/, 'synth_bass'], [/bass|\bbs\b/, 'bass'], [/\bag\b|acoustic|\bacc?\b/, 'ag'],
    [/\beg\b|elec|gtr|guitar/, 'eg'], [/piano|pno/, 'piano'], [/pad/, 'pad'], [/organ|\bb3\b|hammond/, 'organ'],
    [/key|synth|nord/, 'keys'], [/string|violin|viola|cello/, 'strings'], [/brass|sax|trumpet|trombone|horn/, 'brass'],
    [/track|playback|\bmtx\b|stem|backing track/, 'tracks'], [/video|media|youtube/, 'video'],
    [/crowd|audience|ambient|ambience|congregation/, 'ambient'], [/lead|\bld\b|vox|vocal|voc|sing/, 'lead_vocal'],
  ];
  const guessSound = (ch, tpl) => {
    if (ch.type && tpl.channels[ch.type]) return ch.type;
    const n = (ch.name || '').toLowerCase();
    if (/^ch \d+$/.test(n)) return '';
    for (const [re, k] of GUESS) if (re.test(n) && tpl.channels[k]) return k;
    return '';
  };
  window.applyTemplate = async function (id) {
    const tpl = await tryApi('template', undefined, '?id=' + encodeURIComponent(id));
    modal((card, close) => {
      card.classList.add('wide');
      const sounds = sortOpts([['', 'Leave as it is'], ...Object.entries(tpl.channels).map(([k, d]) => [k, d.name])], 1);
      const used = S.mixer.order.filter(c => { const ch = S.mixer.channels[c]; return ch.type || !/^Ch \d+$/.test(ch.name); });
      const shown = used.length ? used : S.mixer.order;
      const rows = shown.map(c => {
        const ch = S.mixer.channels[c], g = guessSound(ch, tpl);
        const sel_ = h('select', {}, ...sounds.map(([v, l]) => h('option', { value: v, selected: v === g }, l)));
        return { c, sel_, el: h('div', { class: 'maprow' }, icon(ch.icon || 'input', 16), h('b', {}, `${c + 1}: ${ch.name}`), h('span', { class: 'farrow' }, '→'), sel_) };
      });
      const opts = { chain: true, sends: true, routing: true, identity: false, levels: false };
      let globals = true;
      const box = (k, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts[k], onchange: e => opts[k] = e.target.checked }), label);
      const matched = rows.filter(r => r.sel_.value).length;
      card.append(h('h3', {}, tpl.name), h('p', { class: 'hint' }, tpl.style + '. ' + tpl.about),
        h('p', { class: 'hint' }, used.length ? `Each channel gets the sound for its instrument (${matched} of ${rows.length} matched from their instrument or name). Change any of them, or leave a channel as it is. Faders aren't touched.`
          : 'No channels have an instrument or name yet, so pick a sound for each one (or set the instruments in the mixer first and come back).'),
        h('div', { class: 'maplist' }, ...rows.map(r => r.el)),
        h('div', { class: 'scope' }, box('chain', 'Processing'), box('sends', 'Reverb & delay sends'), box('routing', 'Group buses'),
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: e => globals = e.target.checked }), 'Buses, reverbs, delay & master')),
        h('p', { class: 'hint' }, 'Applying replaces the processing on the channels you picked. Undo with Ctrl+Z (⌘Z on a Mac) in the mixer.'),
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: async () => {
          const assign = rows.filter(r => r.sel_.value).map(r => ({ ch: r.c, data: tpl.channels[r.sel_.value] }));
          await tryApi('settings-apply', { assign, opts, globals: globals ? tpl.globals : null });
          toast(`${tpl.name}: applied to ${assign.length} channel${assign.length === 1 ? '' : 's'}${globals ? ' + buses, effects and master' : ''}. Ctrl/⌘Z to undo.`); close();
        } }, 'Apply')));
    });
  };

  // match each saved channel to a channel here (by name, then instrument, then position), let the user adjust, apply
  function mapMix(data, title) {
    modal((card, close) => {
      card.classList.add('wide');
      const chans = data.channels || [];
      const used = new Set();
      const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const guess = d => {
        let c = S.mixer.channels.findIndex((ch, i) => !used.has(i) && norm(ch.name) === norm(d.name));
        if (c < 0 && d.type) c = S.mixer.channels.findIndex((ch, i) => !used.has(i) && ch.type === d.type);
        if (c < 0 && Number.isInteger(d.position)) { const o = S.mixer.order[d.position]; if (o != null && !used.has(o)) c = o; }
        if (c >= 0) used.add(c);
        return c;
      };
      const opts = { chain: true, sends: true, routing: true, identity: true, levels: false };
      let globals = !!data.globals;
      const box = (k, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts[k], onchange: e => opts[k] = e.target.checked }), label);
      const rows = chans.map(d => {
        const target = guess(d);
        const sel_ = h('select', {}, h('option', { value: '-1' }, '— skip —'),
          ...S.mixer.order.map(c => h('option', { value: c, selected: c === target }, `${c + 1}: ${S.mixer.channels[c].name}`)));
        return { d, sel_, el: h('div', { class: 'maprow' }, icon(d.icon || 'input', 16), h('b', {}, d.name), h('span', { class: 'hint' }, (d.chain || []).map(m => CATALOG?.moduleTypes?.[m.type]?.short || m.type).join(' → ')), h('span', { class: 'farrow' }, '→'), sel_) };
      });
      card.append(h('h3', {}, 'Apply ' + (title || 'mix settings')),
        h('p', { class: 'hint' }, 'Each saved channel is matched to a channel here by name, then instrument, then position. Change any match, or skip it.'),
        h('div', { class: 'maplist' }, ...rows.map(r => r.el)),
        h('div', { class: 'scope' }, box('chain', 'Processing chains'), box('sends', 'FX sends'), box('routing', 'Bus routing'), box('identity', 'Names, icons & colours'), box('levels', 'Faders, pan & gain'),
          data.globals ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: e => globals = e.target.checked }), 'Buses, effects & master') : null),
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: async () => {
          const assign = rows.map(r => ({ ch: +r.sel_.value, data: r.d })).filter(a => a.ch >= 0);
          await tryApi('settings-apply', { assign, opts, globals: globals ? data.globals : null });
          toast(`Applied to ${assign.length} channels${globals ? ' + buses, effects and master' : ''}`); close();
        } }, 'Apply')));
    });
  }
  window.mapMix = mapMix;

  // ---------------------------------------------------------- editor
  // Every channel, bus and the master has a processing CHAIN: an ordered list of modules.
  // The sound goes through them top to bottom. Add any module any number of times,
  // switch each on/off, duplicate, remove, and drag to reorder.
  let edLive = null, edCtl = new Map(), edRefresh = () => { };
  const MOD_HELP = { eq: 'eq', gate: 'gate', comp: 'comp', deess: 'deess', dyneq: 'dyneq', trans: 'trans', sat: 'sat', tune: 'tune', mbc: 'mbc', limiter: 'limiter', width: 'stereo', plugin: 'inserts' };
  const modInfo = t => CATALOG?.moduleTypes?.[t] || { label: t, short: t.toUpperCase() };
  window.newModuleId = () => 'm' + Math.random().toString(36).slice(2, 9);
  window.freshChain = ch => JSON.parse(JSON.stringify(ch || [])).map(m => ({ ...m, id: newModuleId() }));
  const MOD_DEFAULTS = {
    eq: () => ({ hpf: { on: false, freq: 80, slope: 24 }, lpf: { on: false, freq: 16000, slope: 12 }, bands: [
      { type: 'lowshelf', freq: 100, gain: 0, q: 0.7, on: true, slope: 12 }, { type: 'bell', freq: 400, gain: 0, q: 1, on: true, slope: 12 },
      { type: 'bell', freq: 2500, gain: 0, q: 1, on: true, slope: 12 }, { type: 'highshelf', freq: 8000, gain: 0, q: 0.7, on: true, slope: 12 }] }),
    gate: () => ({ thr: -50, range: 40, att: 1, rel: 120 }),
    comp: () => ({ thr: -18, ratio: 3, knee: 6, att: 10, rel: 150, makeup: 0, mix: 100, range: 30, sc: '' }),
    deess: () => ({ freq: 6500, thr: -28, range: 8 }),
    dyneq: () => ({ sc: '', bands: [{ on: true, type: 'bell', freq: 250, q: 1.2, gain: 0, thr: -24, range: -3, att: 10, rel: 150 },
      { on: false, type: 'bell', freq: 3500, q: 2, gain: 0, thr: -26, range: -3, att: 3, rel: 100 }] }),
    trans: () => ({ attack: 2, sustain: 0 }),
    sat: () => ({ flavor: 'tape', drive: 3, mix: 100 }),
    tune: () => ({ amount: 100, speed: 40, voice: 'any', scale: 'song' }),
    mbc: () => ({ x1: 180, x2: 3500, bands: [{ thr: -20, ratio: 2, att: 30, rel: 250, gain: 0, range: 3 }, { thr: -18, ratio: 1.5, att: 20, rel: 200, gain: 0, range: 2 }, { thr: -22, ratio: 2, att: 10, rel: 150, gain: 0, range: 3 }] }),
    width: () => ({ width: 100, balance: 0 }),
    limiter: () => ({ ceiling: -1, threshold: 0, gain: 0, lookahead: 1.5, release: 150, truepeak: true }),
  };
  const defaultsFor = type => MOD_DEFAULTS[type] ? MOD_DEFAULTS[type]() : JSON.parse(JSON.stringify(CATALOG?.moduleDefaults?.[type] || {}));
  window.makeModule = (type, extra = {}) => ({ id: newModuleId(), type, on: true, ...defaultsFor(type), ...extra });
  const eqView = m => ({ hpf: m.hpf, lpf: m.lpf, eq: { on: m.on !== false, bands: m.bands } });

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
    const help = topic => !window.openGuide ? null : h('button', { class: 'help', title: 'What does this do?', onclick: () => openGuide(topic) }, '?');
    const panel = (title, topic, togglePath, ...kids) => h('div', { class: 'panel' }, h('h4', {}, title, help(topic), togglePath ? T(togglePath) : null), ...kids);
    const byp = $('#edBypass');
    byp.hidden = kind === 'fx';
    byp.classList.toggle('on', !!st.bypass);
    byp.textContent = st.bypass ? 'Bypassed' : 'Bypass';
    byp.onclick = () => { const v = !getPath(S.mixer, P('bypass')); setParam(P('bypass'), v); byp.classList.toggle('on', v); byp.textContent = v ? 'Bypassed' : 'Bypass'; };
    $('#edName').value = st.name;
    $('#edName').disabled = kind === 'master';
    $('#edName').onchange = e => kind !== 'master' && setParam(P('name'), e.target.value);
    const body = $('#edBody');
    const same = !$('#editor').hidden && body.dataset.target === String(t);
    body.classList.toggle('static', same);  // no fade-in when just refreshing
    body.dataset.target = String(t);
    body.innerHTML = '';
    const live = { mods: {}, nav: {} };
    const fns = { redraws: [] };

    // ---- signal flow breadcrumb
    const flow = h('div', { class: 'flow' });
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
    const chainWords = () => (st.chain || []).filter(m => m.on !== false).map(m => modInfo(m.type).short).join(' → ') || 'no processing';
    if (kind === 'ch') { flow.append(step(inputLabel(st.input), 'in'), arrow(), step(st.name, 'cur'), arrow(), step(chainWords()), arrow()); chainFrom(st.out); }
    else if (kind === 'bus') { flow.append(step('Channels routed here', 'in'), arrow(), step(st.name, 'cur'), arrow(), step(chainWords()), arrow()); chainFrom(st.out); }
    else if (kind === 'fx') { flow.append(step('Channel sends', 'in'), arrow(), step(st.name, 'cur'), arrow()); chainFrom(st.out); }
    else flow.append(step('Broadcast & buses', 'in'), arrow(), step(chainWords(), 'cur'), arrow(), step('Main outputs / stream', 'out'));

    if (kind === 'fx') {
      body.classList.remove('ed2');
      body.append(h('div', { class: 'panel full' }, flow));
      buildFxEditor(t, st, body, P, K, T, S_, panel, live); finishEditor(t, kind, st, live, fns); return;
    }
    body.classList.add('ed2');

    // ---- the sections: input / each module / ducking / sends
    const ioPanel = () => {
      if (kind === 'ch') {
        const presetSel = h('select', { onchange: e => { if (e.target.value) { applyChannelPreset(t, e.target.value); openEditor(t); toast('Loaded ' + e.target.value + ' starting point'); } } },
          h('option', { value: '' }, 'Load a starting preset…'), ...sortOpts(Object.keys(CATALOG?.channelPresets || {}).map(n => [n, n])).map(([n]) => h('option', { value: n }, n)));
        const inst = CATALOG?.instruments.find(i => i.key === st.type);
        return panel('Input & routing', 'input', null,
          h('div', { class: 'frow' }, h('button', { class: 'btn', onclick: () => pickFor(t) }, icon(st.icon || 'input', 18), inst ? inst.label : 'Choose instrument…'),
            h('input', { type: 'color', value: st.color, class: 'colorpick', onchange: e => setParam(P('color'), e.target.value) })),
          h('div', { class: 'f2' }, h('span', {}, 'Input'), S_(P('input'), inputOptions(), { onchange: () => setTimeout(() => openEditor(t), 1300) })),
          devStatus(st.input),
          h('div', { class: 'f2' }, h('span', {}, 'Output'), S_(P('out'), destOptions(), { onchange: () => openEditor(t) })),
          h('div', { class: 'knobs' }, K(P('trim'), { label: 'Gain / trim', min: -24, max: 24, def: 0, format: fmt.db, bipolar: true, size: 44, big: true }), T(P('phase'), 'Ø Phase')),
          presetSel,
          h('div', { class: 'frow' },
            h('button', { class: 'btn', onclick: () => saveChannelSettings(t) }, icon('export', 14), 'Save this sound…'),
            h('button', { class: 'btn', onclick: () => loadChannelSettings(t) }, icon('import', 14), 'Load a sound…')),
          h('p', { class: 'hint' }, 'Recordings always keep the raw input, before any processing.'));
      }
      const presetSel = h('select', { onchange: e => { if (e.target.value) { applyBusPreset(t, e.target.value); openEditor(t); toast('Loaded ' + e.target.value); } } },
        h('option', { value: '' }, 'Load a bus preset…'), ...Object.keys(CATALOG?.busPresets || {}).map(n => h('option', { value: n }, n)));
      return panel(kind === 'master' ? 'Master / stream' : 'Bus routing', 'buses', null,
        kind === 'bus' ? h('div', { class: 'f2' }, h('span', {}, 'Sends to'), S_(P('out'), destOptions(st.id), { onchange: () => openEditor(t) })) : null,
        kind === 'bus' ? h('div', { class: 'frow' }, h('input', { type: 'color', value: st.color, class: 'colorpick', onchange: e => setParam(P('color'), e.target.value) }),
          st.id !== 'broadcast' ? h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove bus ' + st.name + '? Anything routed to it moves to where it was going.')) { closeEd(); await tryApi('bus-remove', { id: st.id }); } } }, 'Remove bus') : null) : null,
        presetSel,
        h('div', { class: 'knobs' }, K(P('fader'), { label: 'Fader', min: -90, max: 10, def: 0, format: fmt.db, size: 40, big: true })));
    };
    const duckPanel = () => {
      live.duckBar = h('i'); live.duckTxt = h('span', { class: 'hint lc' });
      return panel('Ducking (sidechain)', 'duck', P('duck', 'on'),
        h('div', { class: 'f2' }, h('span', {}, 'Duck when'), S_(P('duck', 'src'), scOptions())),
        h('div', { class: 'knobs' }, K(P('duck', 'amount'), { label: 'Max duck', min: 0.5, max: 20, def: 2, format: v => '-' + v.toFixed(1) + 'dB', size: 38, big: true }),
          K(P('duck', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -30, format: fmt.db, size: 38, big: true }),
          K(P('duck', 'ratio'), { label: 'Ratio', min: 1, max: 20, log: true, def: 4, format: fmt.ratio, size: 32 }),
          K(P('duck', 'att'), { label: 'Attack', min: 1, max: 200, log: true, def: 15, format: fmt.ms, size: 32 }),
          K(P('duck', 'rel'), { label: 'Release', min: 50, max: 3000, log: true, def: 400, format: fmt.ms, size: 32 })),
        h('div', { class: 'grbar' }, live.duckBar), live.duckTxt,
        h('p', { class: 'hint' }, 'E.g. the Music bus dips 1–2 dB while the lead vocal sings.'));
    };
    const sendsPanel = () => panel(kind === 'ch' ? 'Sends, pan & fader' : 'Sends', 'sends', null,
      h('div', { class: 'knobs' }, ...S.mixer.fx.map((f, i) => K(P('sends', i), { label: '→ ' + f.name, min: -90, max: 10, def: -90, format: fmt.db, size: 38, color: '#3aa0ff' })),
        kind === 'ch' ? K(P('pan'), { label: 'Pan', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 44, big: true }) : null,
        kind === 'ch' ? K(P('fader'), { label: 'Fader', min: -90, max: 10, def: 0, format: fmt.db, size: 44, big: true }) : null),
      h('p', { class: 'hint' }, 'Sends feed the shared reverbs and delay (after the chain and fader). For an effect on just this sound, add it to the chain instead.'));

    const chain = st.chain || [];
    const setChain = c => { setParam(P('chain'), c); openEditor(t); };
    const moveMod = (i, d) => { const c = [...chain]; if (i + d < 0 || i + d >= c.length) return; [c[i + d], c[i]] = [c[i], c[i + d]]; setChain(c); };
    const dupMod = i => { const c = [...chain]; c.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(chain[i])), id: newModuleId() }); setChain(c); };
    const delMod = i => setChain(chain.filter((_, j) => j !== i));
    const toggleMod = i => { setParam(P('chain', i, 'on'), chain[i].on === false); openEditor(t); };
    Object.assign(fns, { move: moveMod, dup: dupMod, del: delMod });
    const sections = [{ id: 'io', label: kind === 'ch' ? 'Input & routing' : kind === 'master' ? 'Master output' : 'Bus routing', ic: kind === 'ch' ? (st.icon || 'input') : 'bus', build: () => [h('div', { class: 'panel' }, flow), ioPanel()] }];
    chain.forEach((m, i) => sections.push({ id: m.id, mod: m, i, label: m.type === 'plugin' ? (m.name || 'Plug-in') : modInfo(m.type).label,
      build: () => [modulePanel(t, kind, m, i, P, K, T, S_, help, live, fns)] }));
    if (kind === 'bus') sections.push({ id: 'duck', label: 'Ducking', ic: 'route', build: () => [duckPanel()] });
    if (kind !== 'master') sections.push({ id: 'sends', label: kind === 'ch' ? 'Sends & fader' : 'Sends', ic: 'fx', build: () => [sendsPanel()] });

    // ---- left: the signal chain, top to bottom
    const nav = h('nav', { class: 'ed-nav' });
    const pane = h('section', { class: 'ed-pane' });
    edSel = edSel || {};
    let cur = edSel[String(t)];
    if (!sections.some(x => x.id === cur)) cur = (sections[1]?.mod ? sections[1].id : 'io');
    const rows = new Map();
    const show = id => {
      cur = id; edSel[String(t)] = id;
      rows.forEach((r, k) => r.classList.toggle('on', k === id));
      const sec = sections.find(x => x.id === id) || sections[0];
      pane.innerHTML = ''; live.mods = {}; live.duckBar = null; fns.redraws.length = 0;
      pane.append(...sec.build());
      pane.scrollTop = 0;
    };
    nav.append(h('div', { class: 'ed-navh' }, 'Signal chain'));
    for (const sec of sections) {
      if (sec.id === 'duck' || sec.id === 'sends') nav.append(h('div', { class: 'ed-gap' }));
      let row;
      if (sec.mod) {
        const m = sec.mod, i = sec.i, on = m.on !== false;
        const meter = h('i');
        live.nav[m.id] = meter;
        row = h('div', { class: 'ed-row mod' + (on ? '' : ' off'), draggable: 'true', title: 'Drag to reorder · right-click for more' },
          h('span', { class: 'ed-num' }, i + 1),
          h('span', { class: 'ed-lbl' }, sec.label),
          h('span', { class: 'ed-meter' }, meter),
          h('button', { class: 'ed-pow' + (on ? ' on' : ''), title: on ? 'On (click to bypass)' : 'Off (click to turn on)', onclick: e => { e.stopPropagation(); toggleMod(i); } }, '⏻'));
        row.addEventListener('contextmenu', e => { e.preventDefault(); contextMenu(e, [
          { label: on ? 'Turn off' : 'Turn on', run: () => toggleMod(i) },
          { label: 'Move up', run: () => moveMod(i, -1), disabled: i === 0 }, { label: 'Move down', run: () => moveMod(i, 1), disabled: i === chain.length - 1 },
          { label: 'Duplicate', run: () => dupMod(i) }, '-', { label: 'Remove', danger: true, run: () => delMod(i) }]); });
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-mod', String(i)); row.classList.add('dragging'); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-mod')) { e.preventDefault(); row.classList.add('dropto'); } });
        row.addEventListener('dragleave', () => row.classList.remove('dropto'));
        row.addEventListener('drop', e => { e.preventDefault(); const from = +e.dataTransfer.getData('text/x-mod'); if (isNaN(from) || from === i) return; const c = [...chain]; const [x] = c.splice(from, 1); c.splice(i, 0, x); setChain(c); });
      } else {
        row = h('div', { class: 'ed-row' }, icon(sec.ic, 15), h('span', { class: 'ed-lbl' }, sec.label));
      }
      row.addEventListener('click', () => show(sec.id));
      rows.set(sec.id, row);
      nav.append(row);
      if (sec.id === 'io') nav.append(h('div', { class: 'ed-wire' }));
      if (sec.mod && sec.i === chain.length - 1 || (sec.id === 'io' && !chain.length)) {
        nav.append(h('button', { class: 'ed-add', onclick: e => addEffectMenu(e, kind, ty => {
          if (ty === 'plugin') return pickPlugin(P('chain'));
          const m = makeModule(ty); edSel[String(t)] = m.id; setChain([...objOf(t).chain, m]);
        }) }, '+ Add effect'));
      }
    }
    body.append(nav, pane);
    show(cur);
    finishEditor(t, kind, st, live, fns);
  };

  // the effect picker, grouped like Logic's plug-in menu
  const EFFECT_GROUPS = [
    ['EQ & filter', ['eq', 'dyneq', 'autofilter']],
    ['Dynamics', ['comp', 'gate', 'deess', 'trans', 'mbc', 'limiter']],
    ['Reverb & delay', ['reverb', 'delay']],
    ['Modulation', ['chorus', 'flanger', 'phaser', 'tremolo']],
    ['Pitch', ['tune', 'pitch']],
    ['Colour & distortion', ['sat', 'distortion', 'bitcrush']],
    ['Utility & stereo', ['gain', 'width']],
  ];
  function addEffectMenu(e, kind, pick) {
    const types = CATALOG?.moduleTypes || {};
    const ok = k => types[k] && (kind === 'ch' ? types[k].ch : types[k].bus);
    const items = EFFECT_GROUPS.map(([g, ks]) => ({ label: g, items: ks.filter(ok).map(k => ({ label: types[k].label, run: () => pick(k) })) })).filter(x => x.items.length);
    items.push('-', { label: 'Plug-in (VST3 / AU)…', run: () => pick('plugin') });
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4 }, items);
  }

  // A panel for one module. P(...) addresses the strip; M(...) the module.
  function modulePanel(t, kind, m, i, P, K, T, S_, help, live, fns) {
    const M = (...p) => P('chain', i, ...p);
    const label = m.type === 'plugin' ? (m.name || 'Plug-in') : modInfo(m.type).label;
    const kids = [];
    const slopeOpts = [[12, '12 dB/oct'], [24, '24 dB/oct'], [48, '48 dB/oct']];
    const reading = h('span', { class: 'hint lc modread' });
    live.mods[m.id] = { type: m.type, el: reading };
    const bar = (cls = '') => { const i_ = h('i'); live.mods[m.id].bar = i_; return h('div', { class: 'grbar ' + cls }, i_); };
    if (m.type === 'eq') {
      const graph = h('canvas', { class: 'eqgraph' });
      let active = -1, edEq = null;
      const redraw = () => { edEq = drawEqCurve(graph, eqView(getPath(S.mixer, M())), S.info?.sr || 48000, { grid: true, nodes: true, active, spectrum: live.spec }); };
      fns.redraws.push(redraw);
      graph.addEventListener('pointerdown', e => {
        const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (!edEq) return;
        let best = -1, bd = 22;
        getPath(S.mixer, M('bands')).forEach((b, j) => { const d = Math.hypot(edEq.fx(b.freq) - x, edEq.gy(['notch', 'hp', 'lp'].includes(b.type) ? 0 : b.gain) - y); if (d < bd) { bd = d; best = j; } });
        if (best < 0) return;
        active = best; graph.setPointerCapture(e.pointerId);
        const bp = M('bands', best);
        const mv = ev => {
          const xx = clamp(ev.clientX - r.left, 0, edEq.W), yy = clamp(ev.clientY - r.top, 0, edEq.H);
          const f = Math.round(20 * Math.pow(1000, xx / edEq.W));
          const gn = Math.round(clamp((edEq.H / 2 - yy) / (edEq.H / 2 - 4) * edEq.range, -18, 18) * 10) / 10;
          setParam([...bp, 'freq'], f); edCtl.get(key([...bp, 'freq']))?.set(f);
          if (!['notch', 'hp', 'lp'].includes(getPath(S.mixer, [...bp, 'type']))) { setParam([...bp, 'gain'], gn); edCtl.get(key([...bp, 'gain']))?.set(gn); }
          redraw();
        };
        const up = () => { graph.removeEventListener('pointermove', mv); graph.removeEventListener('pointerup', up); active = -1; redraw(); };
        graph.addEventListener('pointermove', mv); graph.addEventListener('pointerup', up);
      });
      const gArmed = wheelGuard(graph);
      graph.addEventListener('wheel', e => {
        if (!edEq || !gArmed(e)) return; e.preventDefault();
        const r = graph.getBoundingClientRect(), x = e.clientX - r.left;
        let best = 0, bd = 1e9; getPath(S.mixer, M('bands')).forEach((b, j) => { const d = Math.abs(edEq.fx(b.freq) - x); if (d < bd) { bd = d; best = j; } });
        const qp = M('bands', best, 'q'); const q = clamp((getPath(S.mixer, qp) || 1) * (e.deltaY > 0 ? 0.92 : 1.08), 0.1, 10);
        setParam(qp, Math.round(q * 100) / 100); edCtl.get(key(qp))?.set(q); redraw();
      }, { passive: false });
      graph.addEventListener('dblclick', e => {
        const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        getPath(S.mixer, M('bands')).forEach((b, j) => { if (Math.hypot(edEq.fx(b.freq) - x, edEq.gy(b.gain) - y) < 14) { setParam(M('bands', j, 'gain'), 0); edCtl.get(key(M('bands', j, 'gain')))?.set(0); } });
        redraw();
      });
      const TYPE_OPTS = [['bell', 'Bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf'], ['notch', 'Notch'], ['hp', 'High-pass'], ['lp', 'Low-pass']];
      const bands = h('div', { class: 'eqbands' });
      (m.bands || []).forEach((b, j) => {
        const bp = M('bands', j), isCut = b.type === 'hp' || b.type === 'lp';
        bands.append(h('div', { class: 'eqband', style: `border-color:${BAND_COLORS[j % 4]}` },
          h('div', { class: 'frow' }, S_([...bp, 'type'], TYPE_OPTS, { onchange: () => setTimeout(() => openEditor(t), 30) }), T([...bp, 'on'], String(j + 1))),
          h('div', { class: 'knobs' }, K([...bp, 'freq'], { label: 'Freq', min: 20, max: 20000, log: true, def: b.freq, format: fmt.hz, size: 30, color: BAND_COLORS[j % 4] }),
            isCut ? S_([...bp, 'slope'], slopeOpts, { num: true }) : K([...bp, 'gain'], { label: 'Gain', min: -18, max: 18, def: 0, format: fmt.db, size: 30, bipolar: true, color: BAND_COLORS[j % 4] }),
            isCut ? null : K([...bp, 'q'], { label: 'Q', min: 0.1, max: 10, log: true, def: 1, format: fmt.q, size: 30, color: BAND_COLORS[j % 4] }))));
      });
      kids.push(
        h('div', { class: 'cutrow' }, T(M('hpf', 'on'), 'Low cut'), K(M('hpf', 'freq'), { label: 'Freq', min: 20, max: 1000, log: true, def: 80, format: fmt.hz, size: 34 }), S_(M('hpf', 'slope'), slopeOpts, { num: true }),
          T(M('lpf', 'on'), 'High cut'), K(M('lpf', 'freq'), { label: 'Freq', min: 1000, max: 20000, log: true, def: 16000, format: fmt.hz, size: 34 }), S_(M('lpf', 'slope'), slopeOpts, { num: true })),
        graph, bands, h('p', { class: 'hint' }, 'Drag points · scroll over a point = width · double-click = flat. Keep the low end for kick and bass.'));
    } else if (m.type === 'gate') {
      kids.push(h('div', { class: 'knobs' }, K(M('thr'), { label: 'Threshold', min: -80, max: 0, def: -50, format: fmt.db, size: 38, big: true }),
        K(M('range'), { label: 'Range', min: 3, max: 80, def: 40, format: v => '-' + Math.round(v) + 'dB', size: 38, big: true }),
        K(M('att'), { label: 'Attack', min: 0.1, max: 50, log: true, def: 1, format: fmt.ms, size: 32 }),
        K(M('rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 120, format: fmt.ms, size: 32 })), bar(),
        h('p', { class: 'hint' }, 'Small range (6–15 dB) works as a gentle expander; a large range is a hard gate.'));
    } else if (m.type === 'comp') {
      const cg = h('canvas', { class: 'compgraph' });
      const drawComp = () => {
        const c = getPath(S.mixer, M()), dpr = devicePixelRatio || 1, W = 100, H = 100;
        if (!c) return;
        cg.width = W * dpr; cg.height = H * dpr; const g = cg.getContext('2d'); g.scale(dpr, dpr);
        g.strokeStyle = CV.grid; for (let d = -60; d <= 0; d += 12) { const p = (d + 60) / 60 * W; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, H); g.moveTo(0, H - p); g.lineTo(W, H - p); g.stroke(); }
        g.beginPath();
        for (let x = 0; x <= W; x++) {
          const inp = -60 + x / W * 60, over = inp - c.thr, k = Math.max(c.knee, 0.01), sl = 1 - 1 / c.ratio;
          const red = Math.min(over <= -k / 2 ? 0 : over >= k / 2 ? over * sl : sl * (over + k / 2) ** 2 / (2 * k), c.range ?? 60);
          const out = inp - red + c.makeup;
          const y = H - (out + 60) / 60 * H; x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.strokeStyle = c.on !== false ? '#f76b15' : '#555'; g.lineWidth = 2; g.stroke();
      };
      fns.redraws.push(drawComp);
      kids.push(h('div', { class: 'compwrap' }, h('div', {}, cg, bar()), h('div', { class: 'knobs' },
        K(M('thr'), { label: 'Threshold', min: -60, max: 0, def: -18, format: fmt.db, size: 38, big: true }),
        K(M('ratio'), { label: 'Ratio', min: 1, max: 20, log: true, def: 3, format: fmt.ratio, size: 38, big: true }),
        K(M('att'), { label: 'Attack', min: 0.1, max: 200, log: true, def: 10, format: fmt.ms, size: 30 }),
        K(M('rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 150, format: fmt.ms, size: 30 }),
        K(M('knee'), { label: 'Knee', min: 0, max: 24, def: 6, format: v => v.toFixed(0) + 'dB', size: 30 }),
        K(M('makeup'), { label: 'Makeup', min: 0, max: 24, def: 0, format: fmt.db, size: 30 }),
        K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 30 }),
        K(M('range'), { label: 'Max GR', min: 1, max: 40, def: 30, format: v => Math.round(v) + 'dB', size: 30 }))),
        kind !== 'ch' ? h('div', { class: 'f2' }, h('span', {}, 'Sidechain from'), S_(M('sc'), scOptions())) : null,
        h('p', { class: 'hint' }, 'Mix below 100% = parallel compression. Two gentle compressors in a row often sound smoother than one hard one.'));
    } else if (m.type === 'deess') {
      kids.push(h('div', { class: 'knobs' }, K(M('freq'), { label: 'Frequency', min: 3000, max: 12000, log: true, def: 6500, format: fmt.hz, size: 36, big: true }),
        K(M('thr'), { label: 'Threshold', min: -60, max: 0, def: -28, format: fmt.db, size: 36, big: true }),
        K(M('range'), { label: 'Max cut', min: 1, max: 20, def: 8, format: v => '-' + v.toFixed(0) + 'dB', size: 30 })), bar());
    } else if (m.type === 'dyneq') {
      const dyn = h('div', { class: 'dynbands' });
      (m.bands || []).forEach((b, j) => {
        const bp = M('bands', j);
        dyn.append(h('div', { class: 'dynband' }, h('div', { class: 'frow' }, T([...bp, 'on'], 'Band ' + (j + 1)),
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
      kids.push(dyn, kind !== 'ch' ? h('div', { class: 'f2' }, h('span', {}, 'Sidechain from'), S_(M('sc'), scOptions())) : null,
        h('p', { class: 'hint' }, 'Acts only when that band gets loud. Negative range cuts, positive boosts.'));
    } else if (m.type === 'trans') {
      kids.push(h('div', { class: 'knobs' }, K(M('attack'), { label: 'Attack', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 38, big: true }),
        K(M('sustain'), { label: 'Sustain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 38, big: true })),
        h('p', { class: 'hint' }, '+Attack = more stick and punch. −Sustain = tighter, less ring.'));
    } else if (m.type === 'sat') {
      kids.push(h('div', { class: 'frow' }, S_(M('flavor'), [['tape', 'Tape'], ['tube', 'Tube'], ['console', 'Console'], ['soft', 'Soft clip']])),
        h('div', { class: 'knobs' }, K(M('drive'), { label: 'Drive', min: 0, max: 18, def: 3, format: v => '+' + v.toFixed(1) + 'dB', size: 38, big: true, color: '#ffb366' }),
          K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#ffb366' })),
        h('p', { class: 'hint' }, 'Aim for density you feel, not distortion you hear.'));
    } else if (m.type === 'tune') {
      const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const note = h('div', { class: 'tune-note' }, '—'), needle = h('i'), txt = h('div', { class: 'hint' }, 'Sing or play to see the pitch');
      Object.assign(live.mods[m.id], { note, needle, txt });
      kids.push(h('div', { class: 'tune-read' }, note, h('div', { class: 'tune-meter' }, h('b'), needle), txt),
        h('div', { class: 'f2' }, h('span', {}, 'Song key'), h('div', { class: 'frow' },
          S_(['song', 'key'], KEYS.map(k => [k, k])), S_(['song', 'scale'], [['major', 'Major'], ['minor', 'Minor'], ['harmonic minor', 'Harmonic minor'], ['pentatonic', 'Pentatonic']]))),
        h('div', { class: 'f2' }, h('span', {}, 'Notes'), S_(M('scale'), [['song', 'Song key'], ['chromatic', 'Any note']])),
        h('div', { class: 'f2' }, h('span', {}, 'Voice'), S_(M('voice'), [['any', 'Any'], ['soprano', 'Soprano'], ['alto', 'Alto'], ['tenor', 'Tenor'], ['baritone', 'Baritone / bass']])),
        h('div', { class: 'knobs' },
          K(M('speed'), { label: 'Retune speed', min: 0, max: 400, def: 40, format: v => v < 1 ? 'Robot' : Math.round(v) + 'ms', size: 38, big: true, color: '#b18cff' }),
          K(M('amount'), { label: 'Amount', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#b18cff' })),
        h('div', { class: 'quick' },
          h('button', { class: 'mini', onclick: () => { setParam(M('speed'), 80); setParam(M('amount'), 60); openEditor(t); } }, 'Natural'),
          h('button', { class: 'mini', onclick: () => { setParam(M('speed'), 30); setParam(M('amount'), 100); openEditor(t); } }, 'Polished'),
          h('button', { class: 'mini', onclick: () => { setParam(M('speed'), 0); setParam(M('amount'), 100); openEditor(t); } }, 'Hard (effect)')));
    } else if (m.type === 'mbc') {
      kids.push(h('div', { class: 'knobs' }, K(M('x1'), { label: 'Low/mid split', min: 60, max: 800, log: true, def: 180, format: fmt.hz, size: 34 }),
        K(M('x2'), { label: 'Mid/high split', min: 1000, max: 10000, log: true, def: 3500, format: fmt.hz, size: 34 })),
        h('div', { class: 'mbbands' }, ...(m.bands || []).map((b, j) => h('div', { class: 'mbband' }, h('b', {}, ['Low', 'Mid', 'High'][j]),
          h('div', { class: 'knobs' },
            K(M('bands', j, 'thr'), { label: 'Threshold', min: -50, max: 0, def: -20, format: fmt.db, size: 30 }),
            K(M('bands', j, 'ratio'), { label: 'Ratio', min: 1, max: 10, log: true, def: 2, format: fmt.ratio, size: 30 }),
            K(M('bands', j, 'att'), { label: 'Attack', min: 1, max: 200, log: true, def: 20, format: fmt.ms, size: 30 }),
            K(M('bands', j, 'rel'), { label: 'Release', min: 20, max: 1500, log: true, def: 200, format: fmt.ms, size: 30 }),
            K(M('bands', j, 'range'), { label: 'Range', min: 1, max: 20, def: 3, format: v => '-' + v.toFixed(0) + 'dB', size: 30 }),
            K(M('bands', j, 'gain'), { label: 'Gain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 30 }))))));
    } else if (m.type === 'width') {
      kids.push(h('div', { class: 'knobs' }, K(M('width'), { label: 'Width', min: 0, max: 200, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#3aa0ff' }),
        K(M('balance'), { label: 'Balance', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 38, big: true })),
        h('p', { class: 'hint' }, 'Wider than 120% risks mono problems on phones; check the correlation meter on the Master tab.'));
    } else if (m.type === 'limiter') {
      kids.push(h('div', { class: 'knobs' },
        K(M('threshold'), { label: 'Threshold', min: -12, max: 0, def: 0, format: fmt.db, size: 36, big: true }),
        K(M('ceiling'), { label: 'Ceiling', min: -6, max: 0, def: -1, format: fmt.db, size: 36, big: true }),
        K(M('release'), { label: 'Release', min: 10, max: 1000, log: true, def: 150, format: fmt.ms, size: 30 }),
        K(M('lookahead'), { label: 'Lookahead', min: 0.5, max: 5, def: 1.5, format: v => v.toFixed(1) + 'ms', size: 30 }),
        K(M('gain'), { label: 'Input gain', min: -12, max: 12, def: 0, format: fmt.db, bipolar: true, size: 30 })),
        h('div', { class: 'frow' }, T(M('truepeak'), 'True peak')), bar('lim'),
        h('p', { class: 'hint' }, 'A safety net that should only catch the loudest peaks (1–3 dB).'));
    } else if (m.type === 'reverb') {
      kids.push(h('div', { class: 'knobs' },
        K(M('size'), { label: 'Size', min: 0, max: 100, def: 60, format: v => Math.round(v) + '%', size: 46, big: true }),
        K(M('damping'), { label: 'Darkness', min: 0, max: 100, def: 50, format: v => Math.round(v) + '%', size: 38 }),
        K(M('width'), { label: 'Width', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38 }),
        K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 25, format: v => Math.round(v) + '%', size: 46, big: true, color: '#3aa0ff' })),
        h('p', { class: 'hint' }, 'A reverb just for this sound. For a shared space across many channels, use the sends to the FX returns.'));
    } else if (m.type === 'delay') {
      kids.push(h('div', { class: 'frow' }, T(M('sync'), 'Sync to tempo'), S_(M('note'), NOTE_OPTS.map(([v, l]) => [v, l + ' note']))),
        h('div', { class: 'knobs' },
          K(M('time'), { label: 'Time (unsynced)', min: 10, max: 2000, log: true, def: 375, format: fmt.ms, size: 38 }),
          K(M('feedback'), { label: 'Repeats', min: 0, max: 95, def: 30, format: v => Math.round(v) + '%', size: 44, big: true }),
          K(M('lowcut'), { label: 'Low cut', min: 20, max: 2000, log: true, def: 200, format: fmt.hz, size: 34 }),
          K(M('highcut'), { label: 'High cut', min: 1000, max: 20000, log: true, def: 6000, format: fmt.hz, size: 34 }),
          K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 20, format: v => Math.round(v) + '%', size: 44, big: true, color: '#3aa0ff' })),
        h('p', { class: 'hint' }, 'Synced delays follow the tempo in the header. Cutting the lows and highs of the repeats keeps them behind the dry sound.'));
    } else if (m.type === 'chorus' || m.type === 'flanger' || m.type === 'phaser') {
      const fl = m.type === 'flanger', ph = m.type === 'phaser';
      kids.push(h('div', { class: 'knobs' },
        K(M('rate'), { label: 'Rate', min: 0.05, max: 10, log: true, def: ph ? 0.5 : fl ? 0.25 : 0.8, format: v => v.toFixed(2) + ' Hz', size: 40, big: true }),
        K(M('depth'), { label: 'Depth', min: 0, max: 100, def: fl ? 60 : 30, format: v => Math.round(v) + '%', size: 40, big: true }),
        ph ? K(M('centre'), { label: 'Centre', min: 100, max: 8000, log: true, def: 1300, format: fmt.hz, size: 34 })
          : K(M('delay'), { label: 'Delay', min: 0.5, max: 30, log: true, def: fl ? 1.5 : 7, format: v => v.toFixed(1) + ' ms', size: 34 }),
        K(M('feedback'), { label: 'Feedback', min: -95, max: 95, def: fl ? 50 : 0, format: v => Math.round(v) + '%', bipolar: true, size: 34 }),
        K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 50, format: v => Math.round(v) + '%', size: 40, big: true, color: '#3aa0ff' })),
        h('p', { class: 'hint' }, ph ? 'A sweeping, swirling notch: great on pads, keys and electric guitar.' : fl ? 'A jet-like sweep from a very short, fed-back delay.' : 'Thickens a sound with slightly detuned copies: guitars, pads, backing vocals.'));
    } else if (m.type === 'tremolo') {
      kids.push(h('div', { class: 'frow' }, T(M('sync'), 'Sync to tempo'), S_(M('note'), NOTE_OPTS.map(([v, l]) => [v, l + ' note'])),
          S_(M('shape'), [['sine', 'Smooth'], ['square', 'Choppy']]), kind !== 'ch' ? T(M('pan'), 'Auto-pan') : null),
        h('div', { class: 'knobs' },
          K(M('rate'), { label: 'Rate', min: 0.1, max: 20, log: true, def: 4, format: v => v.toFixed(1) + ' Hz', size: 42, big: true }),
          K(M('depth'), { label: 'Depth', min: 0, max: 100, def: 50, format: v => Math.round(v) + '%', size: 42, big: true })));
    } else if (m.type === 'autofilter') {
      kids.push(h('div', { class: 'frow' }, S_(M('mode'), [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']])),
        h('div', { class: 'knobs' },
          K(M('cutoff'), { label: 'Cutoff', min: 40, max: 16000, log: true, def: 1000, format: fmt.hz, size: 46, big: true }),
          K(M('resonance'), { label: 'Resonance', min: 0, max: 95, def: 30, format: v => Math.round(v) + '%', size: 38 }),
          K(M('rate'), { label: 'Sweep rate', min: 0.02, max: 10, log: true, def: 0.5, format: v => v.toFixed(2) + ' Hz', size: 38 }),
          K(M('depth'), { label: 'Sweep', min: 0, max: 5, def: 2, format: v => v.toFixed(1) + ' oct', size: 38 }),
          K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, color: '#3aa0ff' })),
        h('p', { class: 'hint' }, 'Set Sweep to 0 for a fixed filter, e.g. a “telephone” band-pass or a slow low-pass build.'));
    } else if (m.type === 'distortion') {
      kids.push(h('div', { class: 'frow' }, S_(M('flavor'), [['overdrive', 'Overdrive (smooth)'], ['fuzz', 'Fuzz (hard clip)']])),
        h('div', { class: 'knobs' },
          K(M('drive'), { label: 'Drive', min: 0, max: 40, def: 12, format: v => '+' + Math.round(v) + ' dB', size: 46, big: true }),
          K(M('tone'), { label: 'Tone', min: 500, max: 16000, log: true, def: 6000, format: fmt.hz, size: 38 }),
          K(M('output'), { label: 'Output', min: -24, max: 6, def: -6, format: fmt.db, bipolar: true, size: 38 }),
          K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, color: '#3aa0ff' })));
    } else if (m.type === 'bitcrush') {
      kids.push(h('div', { class: 'knobs' },
        K(M('bits'), { label: 'Bits', min: 2, max: 16, def: 8, format: v => Math.round(v) + ' bit', size: 44, big: true }),
        K(M('downsample'), { label: 'Downsample', min: 1, max: 32, def: 1, format: v => '÷' + Math.round(v), size: 38 }),
        K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 100, format: v => Math.round(v) + '%', size: 38, color: '#3aa0ff' })));
    } else if (m.type === 'pitch') {
      kids.push(h('div', { class: 'knobs' },
        K(M('semitones'), { label: 'Shift', min: -24, max: 24, def: 12, format: v => (v > 0 ? '+' : '') + Math.round(v) + ' st', bipolar: true, size: 46, big: true }),
        K(M('mix'), { label: 'Mix', min: 0, max: 100, def: 50, format: v => Math.round(v) + '%', size: 42, big: true, color: '#3aa0ff' })),
        h('p', { class: 'hint' }, '+12 / −12 adds an octave above / below; mix it under the original for a thicker sound. For tuning a voice, use Auto-tune.'));
    } else if (m.type === 'gain') {
      kids.push(h('div', { class: 'knobs' }, K(M('gain'), { label: 'Gain', min: -48, max: 24, def: 0, format: fmt.db, bipolar: true, size: 46, big: true })),
        h('div', { class: 'frow' }, T(M('invert'), 'Ø Invert phase'), kind !== 'ch' ? T(M('mono'), 'Mono') : null));
    } else if (m.type === 'plugin') {
      const params = h('div', { class: 'params' }, m.failed ? h('p', { class: 'err' }, 'This plug-in isn’t installed on this computer, so it is skipped. Settings are kept for when it is.') : 'Loading settings…');
      if (!m.failed) (async () => {
        const ps = await api('plugin-params', undefined, '?mid=' + encodeURIComponent(m.id)).catch(() => []);
        params.innerHTML = '';
        if (!ps.length) params.append(h('p', { class: 'hint' }, 'This plug-in exposes no settings.'));
        for (const p of ps) {
          const rng = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: p.value });
          const tv = h('span', { class: 'pv' }, p.text + (p.label ? ' ' + p.label : ''));
          rng.oninput = () => api('plugin-param', { path: M(), key: p.key, v: +rng.value });
          rng.onchange = async () => { const fresh = await api('plugin-params', undefined, '?mid=' + encodeURIComponent(m.id)); const q = fresh.find(x => x.key === p.key); if (q) tv.textContent = q.text + (q.label ? ' ' + q.label : ''); };
          params.append(h('label', {}, h('span', {}, p.name), rng, tv));
        }
      })();
      kids.push(h('p', { class: 'hint', title: m.path }, m.path), params);
    }
    const on = m.on !== false;
    const wide = m.type === 'eq' || m.type === 'mbc' || (m.type === 'dyneq' && kind !== 'ch');
    return h('div', { class: 'panel module' + (wide ? ' wide' : '') + (on ? '' : ' off'), id: 'mod-' + m.id },
      h('h4', {}, h('b', { class: 'cnum' }, i + 1), label, help(MOD_HELP[m.type] || 'chain'), reading,
        h('button', { class: 'tog g' + (on ? ' on' : ''), title: 'Bypass this processor', onclick: () => { setParam(M('on'), !on); openEditor(t); } }, on ? 'ON' : 'OFF'),
        fns.move ? h('span', { class: 'modacts' },
          h('button', { class: 'mini', title: 'Move earlier in the chain', onclick: () => fns.move(i, -1) }, '↑'),
          h('button', { class: 'mini', title: 'Move later in the chain', onclick: () => fns.move(i, 1) }, '↓'),
          h('button', { class: 'mini', title: 'Duplicate', onclick: () => fns.dup(i) }, '⧉'),
          h('button', { class: 'mini danger', title: 'Remove', onclick: () => fns.del(i) }, '✕')) : null),
      ...kids);
  }

  function finishEditor(t, kind, st, live, fns = {}) {
    edLive = m => {
      // spectrum behind every EQ in this channel's chain
      if (kind === 'ch' && m.csp) {
        const prev = live.spec;
        live.spec = prev && prev.length === m.csp.length ? m.csp.map((v, i) => Math.max(v, prev[i] - 1.5)) : m.csp;
        fns.redraws.forEach(f => f());
      }
      const mods = m.mods || {};
      // the chain list: a small activity bar beside each processor
      for (const [mid, bar] of Object.entries(live.nav || {})) {
        const v = mods[mid];
        const amt = typeof v === 'number' ? v : Array.isArray(v) ? Math.max(0, ...v.map(x => Math.abs(+x) || 0)) : 0;
        bar.style.width = Math.min(100, amt * 8) + '%';
      }
      for (const [mid, ui] of Object.entries(live.mods || {})) {
        const v = mods[mid];
        if (ui.type === 'tune') {
          if (v) {
            ui.note.textContent = v.note;
            ui.needle.style.left = `calc(50% + ${clamp(v.cents, -50, 50)}%)`;
            ui.needle.style.background = Math.abs(v.cents) < 10 ? 'var(--green)' : Math.abs(v.cents) < 25 ? 'var(--yellow)' : 'var(--red)';
            ui.txt.textContent = `${v.hz} Hz · sung ${v.cents > 0 ? '+' : ''}${v.cents} cents · corrected ${v.shift > 0 ? '+' : ''}${v.shift} cents`;
          }
        } else if (typeof v === 'number') {
          if (ui.bar) ui.bar.style.width = Math.min(100, v * 6) + '%';
          ui.el.textContent = v > 0.1 ? (ui.type === 'gate' ? (v > 3 ? '● closed' : '○ open') : `-${v.toFixed(1)} dB`) : '';
        } else if (Array.isArray(v) && ui.type === 'mbc') ui.el.textContent = 'low ' + v[0] + ' · mid ' + v[1] + ' · high ' + v[2] + ' dB';
        else if (Array.isArray(v) && ui.type === 'dyneq') ui.el.textContent = v.some(x => Math.abs(x) > 0.1) ? v.map(x => (x > 0 ? '+' : '') + x).join(' / ') + ' dB' : '';
      }
      if (live.duckBar) {
        const d = kind === 'fx' ? (m.fxd?.[+String(t).slice(3)] || 0) : (m.bm?.[st.id]?.duck || 0);
        live.duckBar.style.width = Math.min(100, d * 8) + '%'; live.duckTxt.textContent = d > 0.1 ? `ducking -${d.toFixed(1)} dB` : '';
      }
    };
    const baseKey = key(pathOf(t));
    edRefresh = path => {
      const k = key(path);
      if (k === baseKey + '/chain') return openEditor(t);   // chain changed elsewhere (e.g. a phone)
      if (!(k === baseKey || k.startsWith(baseKey + '/'))) return;
      const c = edCtl.get(k); if (c) c.set(getPath(S.mixer, path));
      if (path.includes('chain')) fns.redraws.forEach(f => f());
    };
    const target = kind === 'ch' ? 'ch:' + t : kind === 'bus' ? 'bus:' + st.id : kind === 'master' ? 'master' : null;
    send({ t: 'focus', ch: kind === 'ch' ? t : null, target });
    $('#editor').hidden = false;
    requestAnimationFrame(() => fns.redraws.forEach(f => f()));
  }

  function devStatus(spec) {
    if (typeof spec !== 'string' || !spec.startsWith('dev:')) return null;
    const key = spec.slice(4, spec.lastIndexOf('|'));
    const st = S.info?.extraInputs?.[key];
    if (!st) return h('p', { class: 'hint' }, 'Opening this microphone…');
    if (st === 'ok') return h('p', { class: 'ok', style: 'font-size:12px;margin:2px 0' }, '● Microphone connected. It has its own clock, so keep important sources on the WING.');
    return h('p', { class: 'err', style: 'font-size:12px;margin:2px 0' }, 'This microphone can’t be opened: ' + st);
  }

  // ---------------------------------------------------------- channel sound files
  async function saveChannelSettings(c) {
    const ch = S.mixer.channels[c];
    const name = prompt('Save this channel’s sound as (e.g. "Piano – Sunday"):', ch.name);
    if (!name) return;
    const r = await tryApi('channel-save', { ch: c, name });
    toast(`Saved “${name}”: apply it to any channel with “Load a sound…”`);
    return r;
  }
  window.loadChannelSettings = function (c) {
    modal(async (card, close) => {
      const lib = await api('settings-library');
      const list = h('div', { class: 'list' });
      const opts = { chain: true, sends: true, routing: true, identity: false, levels: false };
      const box = (k, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: opts[k], onchange: e => opts[k] = e.target.checked }), label);
      const apply = async data => {
        await tryApi('settings-apply', { assign: [{ ch: c, data }], opts });
        toast(`Applied “${data.name}” to ${S.mixer.channels[c].name}`); close(); setTimeout(() => openEditor(c), 150);
      };
      const file = h('input', { type: 'file', accept: '.stobite-channel,application/json', hidden: true, onchange: async e => {
        const fd = new FormData(); for (const f of e.target.files) fd.append('file', f, f.name);
        const r = await tryApi('settings-upload', fd); if (r.channels[0]) apply(r.channels[0]);
      } });
      card.append(h('h3', {}, 'Load a sound onto ' + S.mixer.channels[c].name),
        h('p', { class: 'hint' }, 'Sounds you saved (from any channel or any computer). Applying replaces this channel’s processing chain.'),
        h('div', { class: 'scope' }, box('chain', 'Processing chain'), box('sends', 'FX sends'), box('routing', 'Bus routing'), box('identity', 'Name, icon & colour'), box('levels', 'Fader, pan & gain')),
        list,
        h('div', { class: 'acts' },
          h('button', { class: 'btn', onclick: () => file.click() }, icon('import', 14), 'From a file…'), file,
          ['localhost', '127.0.0.1'].includes(location.hostname) ? h('button', { class: 'btn', onclick: () => api('reveal', undefined, '?what=presets') }, 'Show folder') : null,
          h('button', { class: 'btn', onclick: close }, 'Cancel')));
      if (!lib.channels.length) list.append(h('p', { class: 'hint' }, 'No saved sounds yet. Use “Save this sound…” on a channel you like.'));
      for (const n of lib.channels) list.append(h('div', { class: 'li', onclick: async () => apply(await api('channel-read', undefined, '?name=' + encodeURIComponent(n))) }, n,
        h('span', {}, h('button', { class: 'mini', onclick: async e => { e.stopPropagation(); if (confirm('Delete saved sound ' + n + '?')) { await api('channel-delete', { name: n }); close(); loadChannelSettings(c); } } }, '✕'))));
    });
  };

  function buildFxEditor(t, st, body, P, K, T, S_, panel, live) {
    const isRev = ['plate', 'hall', 'room'].includes(st.type), isDelay = st.type === 'delay';
    const knobs = Object.keys(st.params).filter(k => FX_PARAMS[k]).map(k => { const p = FX_PARAMS[k]; return K(P('params', k), { label: p[0], min: p[1], max: p[2], log: !!p[4], def: st.params[k], format: p[3], size: 36, color: '#3aa0ff' }); });
    body.append(h('div', { class: 'panel wide' }, h('h4', {}, isRev ? 'Reverb' : isDelay ? 'Delay' : 'Effect', window.openGuide ? h('button', { class: 'help', onclick: () => openGuide(isDelay ? 'delay' : 'reverb') }, '?') : null),
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

  const closeEd = () => { $('#editor').hidden = true; edTarget = null; edLive = null; send({ t: 'focus', ch: null, target: null }); };
  $('#edClose').onclick = closeEd;
  const stepEd = d => {
    if (typeof edTarget === 'number') { const o = S.mixer.order, i = o.indexOf(edTarget); openEditor(o[(i + d + o.length) % o.length]); }
    else if (String(edTarget).startsWith('bus:')) { const ids = S.mixer.buses.map(b => b.id), i = ids.indexOf(edTarget.slice(4)); openEditor('bus:' + ids[(i + d + ids.length) % ids.length]); }
    else if (String(edTarget).startsWith('fx:')) { const n = S.mixer.fx.length, i = +edTarget.slice(3); openEditor('fx:' + ((i + d + n) % n)); }
  };
  // the editor is a window over a dimmed page: Esc, a click outside, or ✕ closes it; ← → move between channels
  const edEl = $('#editor'), edBack = $('#edBack');
  new MutationObserver(() => { edBack.hidden = edEl.hidden; }).observe(edEl, { attributes: true, attributeFilter: ['hidden'] });
  edBack.addEventListener('pointerdown', e => { e.preventDefault(); closeEd(); });
  document.addEventListener('keydown', e => {
    if (edEl.hidden || !$('#modal').hidden || document.querySelector('.ctx')) return;
    const typing = e.target.matches?.('input:not([type=checkbox]):not([type=color]), textarea, select');
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (typing) e.target.blur(); closeEd(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); stepEd(e.key === 'ArrowLeft' ? -1 : 1); }
  }, true);
  // ← → on the mixer page scroll through the strips
  document.addEventListener('keydown', e => {
    if (S.view !== 'mixer' || !edEl.hidden || !$('#modal').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches?.('input, textarea, select') || (window.welcomeOpen && welcomeOpen())) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const sc = $('#strips'), d = e.key === 'ArrowLeft' ? -1 : 1;
    const stripW = sc.querySelector('.strip')?.getBoundingClientRect().width || 100;
    sc.scrollBy({ left: d * (e.shiftKey ? sc.clientWidth * 0.9 : stripW * 3), top: d * (e.shiftKey ? sc.clientHeight * 0.9 : 0), behavior: 'smooth' });
  }, true);
  $('#edPrev').onclick = () => stepEd(-1);
  $('#edNext').onclick = () => stepEd(1);
  const COPYABLE = ['chain', 'sends', 'trim', 'phase', 'duck'];
  $('#edCopy').onclick = () => { clipboard = JSON.parse(JSON.stringify(objOf(edTarget))); toast('Copied ' + clipboard.name + ' settings'); };
  $('#edPaste').onclick = () => {
    if (!clipboard) return toast('Copy a strip first', true);
    const base = pathOf(edTarget), cur = objOf(edTarget);
    for (const k of COPYABLE) if (clipboard[k] !== undefined && cur[k] !== undefined) setParam([...base, k], k === 'chain' ? freshChain(clipboard.chain) : JSON.parse(JSON.stringify(clipboard[k])));
    openEditor(edTarget); toast('Pasted');
  };
  $('#edReset').onclick = () => {
    if (!confirm('Clear this strip’s processing chain back to a flat EQ?')) return;
    const base = pathOf(edTarget), s = objOf(edTarget);
    setParam([...base, 'chain'], [makeModule('eq')]);
    if (s.trim !== undefined) setParam([...base, 'trim'], 0);
    openEditor(edTarget);
  };

  async function pickPlugin(chainPath) {
    modal(async (card, close) => {
      const list = h('div', { class: 'list', style: 'max-height:50vh' });
      const q = h('input', { placeholder: 'Search plug-ins…', style: 'width:100%' });
      card.append(h('h3', {}, 'Add a plug-in to the chain'), h('p', { class: 'hint' }, 'Your installed VST3' + (navigator.platform.includes('Mac') ? ' and Audio Unit' : '') + ' plug-ins. It goes at the end of the chain; drag it where you want it.'), q, list, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel')));
      list.append('Scanning…');
      const ps = await api('plugins');
      const render = () => {
        list.innerHTML = '';
        const f = ps.filter(p => p.name.toLowerCase().includes(q.value.toLowerCase()));
        if (!f.length) list.append(h('p', { class: 'hint' }, 'No plug-ins found in the standard folders.'));
        for (const p of f) list.append(h('div', { class: 'li', onclick: () => {
          const cur = getPath(S.mixer, chainPath) || [];
          setParam(chainPath, [...cur, makeModule('plugin', { path: p.path, name: p.name, params: {} })]);
          toast('Added ' + p.name); close(); setTimeout(() => edTarget != null && openEditor(edTarget), 400);
        } }, p.name, h('span', {}, p.kind)));
      };
      q.oninput = render; render();
    });
  }
  window.pickFor = pickFor;
})();
