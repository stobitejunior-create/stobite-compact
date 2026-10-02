// Mixer strips, FX returns, master, and the channel editor.
(() => {
  const reg = new Map(); // path key -> control with .set
  const key = p => p.join('/');
  const bind = (path, ctl) => { reg.set(key(path), ctl); return ctl; };
  let strips = [], bank = 'all', edTarget = null, clipboard = null;
  const fs = () => S.info?.sr || 48000;
  const chPath = t => t === 'master' ? ['master'] : ['channels', t];
  const strip = t => t === 'master' ? S.mixer.master : S.mixer.channels[t];

  // ---------------------------------------------------------- banks
  function buildBanks() {
    const n = S.mixer.channels.length, b = $('#mixBank'); b.innerHTML = '';
    const opts = [['all', 'All']];
    for (let i = 0; i < n; i += 16) opts.push([`${i}`, `${i + 1}–${Math.min(n, i + 16)}`]);
    for (const [v, l] of opts) b.append(h('button', { class: bank === v ? 'on' : '', onclick: () => { bank = v; buildMixer(); } }, l));
  }
  const inBank = c => bank === 'all' || (c >= +bank && c < +bank + 16);

  // ---------------------------------------------------------- strips
  function buildMixer() {
    if (!S.mixer) return;
    reg.clear();
    buildBanks();
    const box = $('#strips'); box.innerHTML = '';
    strips = [];
    const showSends = $('#showSends').checked;
    S.mixer.channels.forEach((ch, c) => {
      if (!inBank(c)) { strips.push(null); return; }
      const el = h('div', { class: 'strip' });
      const name = h('div', { class: 'sname', style: `background:${ch.color}`, onclick: () => openEditor(c), title: 'Open channel ' + (c + 1) }, ch.name);
      const thumb = h('canvas');
      const badges = h('div', { class: 'badges' },
        badge('HPF', ['channels', c, 'hpf', 'on']), badge('GATE', ['channels', c, 'gate', 'on']),
        badge('EQ', ['channels', c, 'eq', 'on']), badge('COMP', ['channels', c, 'comp', 'on']), badge('DS', ['channels', c, 'deess', 'on']));
      const gr = h('i');
      const sends = h('div', { class: 'sends' }, ...S.mixer.fx.map((f, i) => bind(['channels', c, 'sends', i], Knob({ label: f.name.slice(0, 5), min: -90, max: 10, value: ch.sends[i], def: -90, size: 26, format: fmt.db, color: '#3aa0ff', onChange: v => setParam(['channels', c, 'sends', i], v) })).el));
      const pan = bind(['channels', c, 'pan'], Knob({ label: 'Pan', min: -1, max: 1, value: ch.pan, def: 0, size: 30, format: fmt.pan, bipolar: true, onChange: v => setParam(['channels', c, 'pan'], v) }));
      const mute = h('button', { class: 'tog m' + (ch.mute ? ' on' : ''), onclick: () => setParam(['channels', c, 'mute'], !S.mixer.channels[c].mute) }, 'M');
      const solo = h('button', { class: 'tog s' + (ch.solo ? ' on' : ''), onclick: () => setParam(['channels', c, 'solo'], !S.mixer.channels[c].solo) }, 'S');
      bind(['channels', c, 'mute'], { set: v => mute.classList.toggle('on', v) });
      bind(['channels', c, 'solo'], { set: v => { solo.classList.toggle('on', v); soloHint(); } });
      const db = h('div', { class: 'db' }, fmt.db(ch.fader));
      const fader = bind(['channels', c, 'fader'], Fader({ value: ch.fader, onChange: v => { setParam(['channels', c, 'fader'], v); db.textContent = fmt.db(v); } }));
      const fset = fader.set; fader.set = v => { fset(v); db.textContent = fmt.db(v); };
      const meter = Meter();
      el.append(name, h('div', { class: 'eqthumb', onclick: () => openEditor(c) }, thumb), badges, h('div', { class: 'gr', title: 'Compressor gain reduction' }, gr),
        showSends ? sends : null, h('div', { style: 'display:flex;justify-content:center' }, pan.el), h('div', { class: 'row' }, mute, solo, autoModeButton(String(c))),
        h('div', { class: 'fz' }, fader.el, meter.el), db);
      box.append(el);
      strips.push({ el, thumb, gr, meter, name, c });
    });
    // fx returns + master
    const mb = $('#mstrips'); mb.innerHTML = '';
    S.mixer.fx.forEach((f, i) => mb.append(fxStrip(f, i)));
    mb.append(masterStrip());
    requestAnimationFrame(() => { strips.forEach(s => s && drawEqCurve(s.thumb, S.mixer.channels[s.c], fs())); allMeters.forEach(m => m.size()); });
    soloHint();
  }
  function badge(label, path) {
    const b = h('span', { class: 'badge' + (getPath(S.mixer, path) ? ' on' : ''), title: 'Toggle ' + label, onclick: () => setParam(path, !getPath(S.mixer, path)) }, label);
    bind(path, { set: v => b.classList.toggle('on', !!v) });
    return b;
  }
  function soloHint() { $('#soloHint').textContent = S.mixer.channels.some(c => c.solo) ? 'SOLO active — other channels are muted in the master' : ''; }

  let fxMeters = [], masterMeters = [], masterGr = null;
  const allMeters = [];
  function fxStrip(f, i) {
    const el = h('div', { class: 'strip fx' });
    const type = h('select', { style: 'height:24px;font-size:11px', onchange: e => { setParam(['fx', i, 'type'], e.target.value); setTimeout(() => api('info').then(() => { }), 0); } },
      ...['reverb', 'plate', 'delay', 'chorus', 'phaser', 'doubler'].map(t => h('option', { value: t, selected: f.type === t }, t)));
    const params = h('div', { class: 'sends' });
    const P = {
      room_size: ['Size', 0, 1, fmt.pct], damping: ['Damp', 0, 1, fmt.pct], width: ['Width', 0, 1, fmt.pct], predelay_ms: ['Pre', 0, 200, fmt.ms],
      time_ms: ['Time', 20, 2000, fmt.ms], feedback: ['Fdbk', 0, 0.95, fmt.pct], tone: ['Tone', 0, 1, fmt.pct],
      rate_hz: ['Rate', 0.05, 8, v => v.toFixed(2) + 'Hz'], depth: ['Depth', 0, 1, fmt.pct], centre_delay_ms: ['Delay', 1, 30, fmt.ms],
      centre_frequency_hz: ['Freq', 200, 5000, fmt.hz], semitones: ['Detune', 0, 0.5, v => v.toFixed(2) + 'st'], delay_ms: ['Delay', 1, 60, fmt.ms],
    };
    for (const [k, v] of Object.entries(f.params)) {
      const p = P[k] || [k, 0, 1, fmt.num];
      params.append(Knob({ label: p[0], min: p[1], max: p[2], value: v, size: 26, format: p[3], color: '#3aa0ff', onChange: val => setParam(['fx', i, 'params', k], val) }).el);
    }
    const mute = h('button', { class: 'tog m' + (f.mute ? ' on' : ''), onclick: () => setParam(['fx', i, 'mute'], !S.mixer.fx[i].mute) }, 'M');
    bind(['fx', i, 'mute'], { set: v => mute.classList.toggle('on', v) });
    const db = h('div', { class: 'db' }, fmt.db(f.ret));
    const fader = bind(['fx', i, 'ret'], Fader({ value: f.ret, onChange: v => { setParam(['fx', i, 'ret'], v); db.textContent = fmt.db(v); } }));
    const meter = Meter(); fxMeters[i] = meter; allMeters.push(meter);
    const name = h('input', { class: 'sname', value: f.name, style: 'background:#4c4f57;color:#eee;border:0;width:100%', onchange: e => { setParam(['fx', i, 'name'], e.target.value); buildMixer(); } });
    el.append(name, type, params, h('div', { class: 'row' }, mute), h('div', { class: 'fz' }, fader.el, meter.el), db);
    return el;
  }
  function masterStrip() {
    const m = S.mixer.master;
    const el = h('div', { class: 'strip master' });
    const thumb = h('canvas');
    const lim = h('span', { class: 'badge' + (m.limiter.on ? ' on' : ''), onclick: () => setParam(['master', 'limiter', 'on'], !S.mixer.master.limiter.on) }, 'LIMIT');
    bind(['master', 'limiter', 'on'], { set: v => lim.classList.toggle('on', v) });
    const ceil = Knob({ label: 'Ceiling', min: -12, max: 0, value: m.limiter.ceiling, def: -0.5, size: 30, format: fmt.db, onChange: v => setParam(['master', 'limiter', 'ceiling'], v) });
    const mute = h('button', { class: 'tog m' + (m.mute ? ' on' : ''), onclick: () => setParam(['master', 'mute'], !S.mixer.master.mute) }, 'M');
    bind(['master', 'mute'], { set: v => mute.classList.toggle('on', v) });
    const db = h('div', { class: 'db' }, fmt.db(m.fader));
    const fader = bind(['master', 'fader'], Fader({ value: m.fader, onChange: v => { setParam(['master', 'fader'], v); db.textContent = fmt.db(v); } }));
    const L = Meter(), R = Meter(); masterMeters = [L, R]; allMeters.push(L, R);
    masterGr = h('i');
    el.append(h('div', { class: 'sname', onclick: () => openEditor('master') }, 'MASTER'),
      h('div', { class: 'eqthumb', onclick: () => openEditor('master') }, thumb),
      h('div', { class: 'badges' }, badge('EQ', ['master', 'eq', 'on']), badge('COMP', ['master', 'comp', 'on']), lim),
      h('div', { class: 'gr' }, masterGr), h('div', { style: 'display:flex;justify-content:center' }, ceil.el), h('div', { class: 'row' }, mute, autoModeButton('master')),
      h('div', { class: 'fz' }, fader.el, L.el, R.el), db);
    el._thumb = thumb;
    requestAnimationFrame(() => drawEqCurve(thumb, S.mixer.master, fs()));
    masterThumb = thumb;
    return el;
  }
  let masterThumb = null;

  // ---------------------------------------------------------- live updates
  on('mixer', () => { buildMixer(); if (edTarget != null) openEditor(edTarget); });
  on('view', v => v === 'mixer' && requestAnimationFrame(() => {
    allMeters.forEach(m => m.size());
    strips.forEach(s => s && (s.meter.size(), drawEqCurve(s.thumb, S.mixer.channels[s.c], fs())));
    if (masterThumb) drawEqCurve(masterThumb, S.mixer.master, fs());
  }));
  $('#showSends').onchange = buildMixer;
  on('set', path => {
    const ctl = reg.get(key(path));
    if (ctl) ctl.set(getPath(S.mixer, path));
    if (path[0] === 'channels') {
      const c = path[1], s = strips[c];
      if (s && ['eq', 'hpf', 'lpf'].includes(path[2])) drawEqCurve(s.thumb, S.mixer.channels[c], fs());
      if (s && ['name', 'color'].includes(path[2])) { s.name.textContent = S.mixer.channels[c].name; s.name.style.background = S.mixer.channels[c].color; }
    }
    if (path[0] === 'master' && masterThumb && ['eq', 'hpf', 'lpf'].includes(path[1])) drawEqCurve(masterThumb, S.mixer.master, fs());
    if (path[0] === 'fx' && path[2] === 'type') setTimeout(buildMixer, 50);
    if (edTarget != null && key(path).startsWith(key(chPath(edTarget)))) edRefresh(path);
  });
  on('meters', m => {
    if (S.view === 'mixer') {
      for (const s of strips) if (s) {
        s.meter.set(m.p[s.c] / 1000);
        s.gr.style.width = Math.min(100, (m.gr[s.c] || 0) * 5) + '%';
      }
      fxMeters.forEach((mt, i) => mt && mt.set(m.fx[i] / 1000));
      masterMeters.forEach((mt, i) => mt.set(m.m[i] / 1000));
      if (masterGr) masterGr.style.width = Math.min(100, Math.max(m.mgr, m.lim) * 5) + '%';
    }
    if (edTarget != null && edLive) edLive(m);
    if (m.au) {
      for (const [c, v] of Object.entries(m.au.f)) reg.get(`channels/${c}/fader`)?.set(v);
      for (const [c, v] of Object.entries(m.au.p)) reg.get(`channels/${c}/pan`)?.set(v);
      for (const [c, v] of Object.entries(m.au.m)) reg.get(`channels/${c}/mute`)?.set(v >= 0.5);
      if (m.au.M != null) reg.get('master/fader')?.set(m.au.M);
    }
  });
  on('session', () => $$('.strip .tog.auto').forEach(b => b.dispatchEvent(new Event('repaint'))));
  window.addEventListener('resize', () => { allMeters.forEach(m => m.size()); strips.forEach(s => s && s.meter.size()); });
  setTimeout(() => strips.forEach(s => s && s.meter.size()), 300);

  // ---------------------------------------------------------- scenes
  $('#btnScenes').onclick = () => modal(async (card, close) => {
    const list = h('div', { class: 'list' });
    const name = h('input', { placeholder: 'Scene name e.g. Sunday Service', style: 'flex:1' });
    card.append(h('h3', {}, 'Mixer scenes'), h('p', { class: 'hint' }, 'Save the whole mixer (EQ, dynamics, FX, faders) and recall it any time.'),
      h('div', { style: 'display:flex;gap:6px' }, name, h('button', { class: 'btn accent', onclick: async () => { if (!name.value) return; await tryApi('scene-save', { name: name.value }); toast('Scene saved'); close(); } }, 'Save current')),
      list, h('div', { class: 'acts' }, h('button', { class: 'btn danger', onclick: async () => { if (confirm('Reset every channel to flat defaults?')) { await tryApi('mixer-reset', {}); close(); } } }, 'Reset mixer'), h('button', { class: 'btn', onclick: close }, 'Close')));
    const sc = await api('scenes');
    if (!sc.length) list.append(h('p', { class: 'hint' }, 'No scenes yet.'));
    for (const s of sc) list.append(h('div', { class: 'li', onclick: async () => { await tryApi('scene-load', { name: s }); toast('Loaded ' + s); close(); } }, s, h('span', {}, 'Load')));
  });

  // ---------------------------------------------------------- channel editor
  let edLive = null, edCtl = new Map(), edEq = null;
  window.openEditor = function (t) {
    edTarget = t;
    edCtl = new Map();
    const st = strip(t), base = chPath(t);
    const P = (...p) => [...base, ...p];
    const K = (p, opts) => { const k = Knob({ ...opts, value: getPath(S.mixer, p), onChange: v => setParam(p, v) }); edCtl.set(key(p), k); return k.el; };
    const T = (p, label, cls = 'g') => { const b = h('button', { class: `tog ${cls}` + (getPath(S.mixer, p) ? ' on' : ''), onclick: () => setParam(p, !getPath(S.mixer, p)) }, label); edCtl.set(key(p), { set: v => b.classList.toggle('on', !!v) }); return b; };
    $('#edName').value = st.name;
    $('#edName').onchange = e => t !== 'master' && setParam(P('name'), e.target.value);
    $('#edName').disabled = t === 'master';
    const body = $('#edBody'); body.innerHTML = '';
    const isMaster = t === 'master';

    // input
    if (!isMaster) {
      const color = h('input', { type: 'color', value: st.color, style: 'width:40px;height:28px;padding:0;border:0;background:none', onchange: e => setParam(P('color'), e.target.value) });
      body.append(h('div', { class: 'panel' }, h('h4', {}, 'Input', color),
        h('div', { class: 'knobs' },
          K(P('trim'), { label: 'Trim', min: -24, max: 24, def: 0, format: fmt.db, bipolar: true, size: 44, big: true }),
          h('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:center' }, T(P('phase'), 'Ø  Phase')),
        ),
        h('h4', { style: 'margin-top:12px' }, 'Low cut', T(P('hpf', 'on'), 'ON')),
        h('div', { class: 'knobs' }, K(P('hpf', 'freq'), { label: 'Freq', min: 20, max: 1000, log: true, def: 80, format: fmt.hz, size: 40, big: true }),
          h('select', { onchange: e => setParam(P('hpf', 'slope'), +e.target.value) }, h('option', { value: 12, selected: st.hpf.slope == 12 }, '12 dB/oct'), h('option', { value: 24, selected: st.hpf.slope != 12 }, '24 dB/oct'))),
        h('h4', { style: 'margin-top:12px' }, 'High cut', T(P('lpf', 'on'), 'ON')),
        h('div', { class: 'knobs' }, K(P('lpf', 'freq'), { label: 'Freq', min: 1000, max: 20000, log: true, def: 16000, format: fmt.hz, size: 40, big: true }))));
    } else {
      body.append(h('div', { class: 'panel' }, h('h4', {}, 'Master cuts'),
        h('h4', {}, 'Low cut', T(P('hpf', 'on'), 'ON')), h('div', { class: 'knobs' }, K(P('hpf', 'freq'), { label: 'Freq', min: 20, max: 300, log: true, def: 30, format: fmt.hz, size: 40, big: true })),
        h('h4', { style: 'margin-top:12px' }, 'High cut', T(P('lpf', 'on'), 'ON')), h('div', { class: 'knobs' }, K(P('lpf', 'freq'), { label: 'Freq', min: 2000, max: 20000, log: true, def: 18000, format: fmt.hz, size: 40, big: true })),
        h('h4', { style: 'margin-top:12px' }, 'Limiter', T(P('limiter', 'on'), 'ON')), h('div', { class: 'knobs' }, K(P('limiter', 'ceiling'), { label: 'Ceiling', min: -12, max: 0, def: -0.5, format: fmt.db, size: 40, big: true }))));
    }

    // EQ
    const graph = h('canvas', { class: 'eqgraph' });
    let activeBand = -1;
    const bands = h('div', { class: 'eqbands' });
    st.eq.bands.forEach((b, i) => {
      const bp = P('eq', 'bands', i);
      const type = h('select', { onchange: e => { setParam([...bp, 'type'], e.target.value); redrawEq(); } }, ...[['lowshelf', 'Low shelf'], ['bell', 'Bell'], ['highshelf', 'High shelf'], ['notch', 'Notch']].map(([v, l]) => h('option', { value: v, selected: b.type === v }, l)));
      edCtl.set(key([...bp, 'type']), { set: v => type.value = v });
      bands.append(h('div', { class: 'eqband', style: `border-color:${BAND_COLORS[i]}` }, h('div', { style: 'display:flex;gap:4px;width:100%' }, type, T([...bp, 'on'], i + 1)),
        h('div', { class: 'knobs' }, K([...bp, 'freq'], { label: 'Freq', min: 20, max: 20000, log: true, def: b.freq, format: fmt.hz, size: 32, color: BAND_COLORS[i] }),
          K([...bp, 'gain'], { label: 'Gain', min: -18, max: 18, def: 0, format: fmt.db, size: 32, bipolar: true, color: BAND_COLORS[i] }),
          K([...bp, 'q'], { label: 'Q', min: 0.1, max: 10, log: true, def: 1, format: fmt.q, size: 32, color: BAND_COLORS[i] }))));
    });
    let liveSpec = null;
    const redrawEq = () => { edEq = drawEqCurve(graph, strip(t), fs(), { grid: true, nodes: true, active: activeBand, spectrum: liveSpec }); };
    send({ t: 'focus', ch: isMaster ? null : t });
    // drag nodes on the graph
    graph.addEventListener('pointerdown', e => {
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (!edEq) return;
      let best = -1, bd = 22;
      strip(t).eq.bands.forEach((b, i) => { const d = Math.hypot(edEq.fx(b.freq) - x, edEq.gy(b.type === 'notch' ? 0 : b.gain) - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      activeBand = best; graph.setPointerCapture(e.pointerId);
      const bp = P('eq', 'bands', best);
      if (!getPath(S.mixer, [...base, 'eq', 'on'])) setParam(P('eq', 'on'), true);
      const mv = ev => {
        const xx = clamp(ev.clientX - r.left, 0, edEq.W), yy = clamp(ev.clientY - r.top, 0, edEq.H);
        const f = Math.round(20 * Math.pow(1000, xx / edEq.W));
        const gn = Math.round(clamp((edEq.H / 2 - yy) / (edEq.H / 2 - 4) * edEq.range, -18, 18) * 10) / 10;
        setParam([...bp, 'freq'], f); edCtl.get(key([...bp, 'freq']))?.set(f);
        if (getPath(S.mixer, [...bp, 'type']) !== 'notch') { setParam([...bp, 'gain'], gn); edCtl.get(key([...bp, 'gain']))?.set(gn); }
        redrawEq();
      };
      const up = () => { graph.removeEventListener('pointermove', mv); graph.removeEventListener('pointerup', up); activeBand = -1; redrawEq(); };
      graph.addEventListener('pointermove', mv); graph.addEventListener('pointerup', up);
      redrawEq();
    });
    graph.addEventListener('wheel', e => {
      if (!edEq) return; e.preventDefault();
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left;
      let best = 0, bd = 1e9; strip(t).eq.bands.forEach((b, i) => { const d = Math.abs(edEq.fx(b.freq) - x); if (d < bd) { bd = d; best = i; } });
      const qp = P('eq', 'bands', best, 'q'); const q = clamp(getPath(S.mixer, qp) * (e.deltaY > 0 ? 0.92 : 1.08), 0.1, 10);
      setParam(qp, Math.round(q * 100) / 100); edCtl.get(key(qp))?.set(q); redrawEq();
    }, { passive: false });
    graph.addEventListener('dblclick', e => {
      const r = graph.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      strip(t).eq.bands.forEach((b, i) => { if (Math.hypot(edEq.fx(b.freq) - x, edEq.gy(b.gain) - y) < 14) { setParam(P('eq', 'bands', i, 'gain'), 0); edCtl.get(key(P('eq', 'bands', i, 'gain')))?.set(0); } });
      redrawEq();
    });
    body.append(h('div', { class: 'panel wide' }, h('h4', {}, 'Equaliser', h('span', { class: 'hint', style: 'text-transform:none;letter-spacing:0' }, 'drag points · scroll = width · double-click = flat'), T(P('eq', 'on'), 'ON')), graph, bands));

    // gate
    const gateLed = h('span', { class: 'hint' });
    if (!isMaster) body.append(h('div', { class: 'panel' }, h('h4', {}, 'Gate', gateLed, T(P('gate', 'on'), 'ON')),
      h('div', { class: 'knobs' }, K(P('gate', 'thr'), { label: 'Threshold', min: -80, max: 0, def: -50, format: fmt.db, size: 40, big: true }),
        K(P('gate', 'range'), { label: 'Range', min: 3, max: 80, def: 40, format: v => '-' + Math.round(v) + 'dB', size: 40, big: true }),
        K(P('gate', 'att'), { label: 'Attack', min: 0.1, max: 50, log: true, def: 1, format: fmt.ms, size: 34 }),
        K(P('gate', 'rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 120, format: fmt.ms, size: 34 }))));

    // compressor
    const cg = h('canvas', { class: 'compgraph' });
    const grbar = h('i');
    const grTxt = h('span', { class: 'hint' });
    const drawComp = () => {
      const c = strip(t).comp, dpr = devicePixelRatio || 1, W = 110, H = 110;
      cg.width = W * dpr; cg.height = H * dpr; const g = cg.getContext('2d'); g.scale(dpr, dpr);
      g.strokeStyle = '#1f2328'; for (let d = -60; d <= 0; d += 12) { const p = (d + 60) / 60 * W; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, H); g.moveTo(0, H - p); g.lineTo(W, H - p); g.stroke(); }
      g.beginPath();
      for (let x = 0; x <= W; x++) {
        const inp = -60 + x / W * 60, over = inp - c.thr, k = Math.max(c.knee, 0.01), sl = 1 - 1 / c.ratio;
        const red = over <= -k / 2 ? 0 : over >= k / 2 ? over * sl : sl * (over + k / 2) ** 2 / (2 * k);
        const out = inp - (c.on ? red : 0) + (c.on ? c.makeup : 0);
        const y = H - (out + 60) / 60 * H; x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = c.on ? '#f76b15' : '#555'; g.lineWidth = 2; g.stroke();
    };
    const compKnobs = h('div', { class: 'knobs' },
      K(P('comp', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -18, format: fmt.db, size: 40, big: true }),
      K(P('comp', 'ratio'), { label: 'Ratio', min: 1, max: 20, log: true, def: 3, format: fmt.ratio, size: 40, big: true }),
      K(P('comp', 'att'), { label: 'Attack', min: 0.1, max: 200, log: true, def: 10, format: fmt.ms, size: 34 }),
      K(P('comp', 'rel'), { label: 'Release', min: 10, max: 2000, log: true, def: 150, format: fmt.ms, size: 34 }),
      K(P('comp', 'knee'), { label: 'Knee', min: 0, max: 24, def: 6, format: v => v.toFixed(0) + 'dB', size: 34 }),
      K(P('comp', 'makeup'), { label: 'Makeup', min: 0, max: 24, def: 0, format: fmt.db, size: 34 }));
    body.append(h('div', { class: 'panel' }, h('h4', {}, 'Compressor', grTxt, T(P('comp', 'on'), 'ON')),
      h('div', { style: 'display:flex;gap:10px;align-items:flex-start' }, h('div', {}, cg, h('div', { class: 'grbar' }, grbar)), compKnobs)));

    // de-esser
    const dsTxt = h('span', { class: 'hint' }), dsBar = h('i');
    if (!isMaster) body.append(h('div', { class: 'panel' }, h('h4', {}, 'De-esser', dsTxt, T(P('deess', 'on'), 'ON')),
      h('div', { class: 'knobs' },
        K(P('deess', 'freq'), { label: 'Frequency', min: 3000, max: 12000, log: true, def: 6500, format: fmt.hz, size: 40, big: true }),
        K(P('deess', 'thr'), { label: 'Threshold', min: -60, max: 0, def: -28, format: fmt.db, size: 40, big: true }),
        K(P('deess', 'range'), { label: 'Max cut', min: 1, max: 20, def: 8, format: v => '-' + v.toFixed(0) + 'dB', size: 34 })),
      h('div', { class: 'grbar' }, dsBar), h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Tames harsh "s" and "sh" sounds on vocals and speech.')));

    // sends / output
    if (!isMaster) {
      const presets = [
        ['Vocal', { hpf: { on: true, freq: 100, slope: 24 }, comp: { on: true, thr: -20, ratio: 3, knee: 6, att: 5, rel: 120, makeup: 3 }, bands: [[-2, 250, 1], [-2, 400, 1.2], [2.5, 3000, 1], [2, 10000, 0.7]] }],
        ['Kick', { hpf: { on: true, freq: 35, slope: 24 }, gate: { on: true, thr: -35, range: 30, att: 0.5, rel: 100 }, comp: { on: true, thr: -14, ratio: 4, knee: 4, att: 15, rel: 80, makeup: 2 }, bands: [[3, 60, 0.7], [-5, 350, 1.5], [3, 3500, 1.2], [0, 9000, 0.7]] }],
        ['Bass', { hpf: { on: true, freq: 35, slope: 24 }, comp: { on: true, thr: -18, ratio: 4, knee: 6, att: 20, rel: 150, makeup: 3 }, bands: [[2, 80, 0.7], [-3, 250, 1.2], [2, 800, 1], [0, 8000, 0.7]] }],
        ['Acoustic', { hpf: { on: true, freq: 90, slope: 24 }, comp: { on: true, thr: -18, ratio: 2.5, knee: 6, att: 10, rel: 150, makeup: 2 }, bands: [[0, 100, 0.7], [-3, 250, 1.4], [2, 5000, 1], [2, 12000, 0.7]] }],
        ['Keys', { hpf: { on: true, freq: 60, slope: 12 }, comp: { on: false }, bands: [[0, 100, 0.7], [-2, 300, 1], [1.5, 3000, 1], [1.5, 10000, 0.7]] }],
        ['Speech', { hpf: { on: true, freq: 120, slope: 24 }, gate: { on: true, thr: -55, range: 15, att: 1, rel: 250 }, comp: { on: true, thr: -22, ratio: 3.5, knee: 6, att: 5, rel: 150, makeup: 4 }, bands: [[-2, 200, 1], [-2, 500, 1.4], [3, 3500, 1], [1, 9000, 0.7]] }],
      ];
      const applyPreset = p => {
        const s = JSON.parse(JSON.stringify(strip(t)));
        s.hpf = { ...s.hpf, ...p.hpf }; s.comp = { ...s.comp, ...(p.comp || {}) }; if (p.gate) s.gate = { ...s.gate, ...p.gate };
        s.eq.on = true;
        p.bands.forEach(([gn, f, q], i) => Object.assign(s.eq.bands[i], { gain: gn, freq: f, q }));
        for (const k of ['hpf', 'comp', 'gate', 'eq']) setParam([...base, k], s[k]);
        openEditor(t);
      };
      body.append(h('div', { class: 'panel' }, h('h4', {}, 'Sends & output'),
        h('div', { class: 'knobs' }, ...S.mixer.fx.map((f, i) => K(P('sends', i), { label: '→ ' + f.name, min: -90, max: 10, def: -90, format: fmt.db, size: 36, color: '#3aa0ff' })),
          K(P('pan'), { label: 'Pan', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 40, big: true }),
          K(P('fader'), { label: 'Fader', min: -90, max: 10, def: 0, format: fmt.db, size: 40, big: true })),
        h('h4', { style: 'margin-top:12px' }, 'Starting points'),
        h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px' }, ...presets.map(([n, p]) => h('button', { class: 'btn', onclick: () => applyPreset(p) }, n)))));
    }

    // inserts
    const insBox = h('div', { class: 'ins' });
    const paramBox = h('div', { class: 'params' });
    const target = isMaster ? 'master' : String(t);
    (st.inserts || []).forEach((spec, i) => {
      insBox.append(h('div', { class: 'item' + (spec.failed ? ' failed' : '') },
        h('span', { class: 'n', title: spec.path, onclick: () => showParams(i) }, spec.name),
        h('button', { class: 'tog g' + (spec.bypass ? '' : ' on'), title: 'Bypass', onclick: () => api('insert-bypass', { target, idx: i, v: !spec.bypass }) }, spec.bypass ? 'OFF' : 'ON'),
        h('button', { class: 'tog', title: 'Edit', onclick: () => showParams(i) }, '⚙'),
        h('button', { class: 'tog m', title: 'Remove', onclick: () => api('insert-remove', { target, idx: i }) }, '✕')));
    });
    async function showParams(i) {
      paramBox.innerHTML = 'Loading…';
      const ps = await tryApi('insert-params', undefined, `?target=${target}&idx=${i}`);
      paramBox.innerHTML = '';
      if (!ps.length) paramBox.append(h('p', { class: 'hint' }, 'This plugin exposes no parameters.'));
      for (const p of ps) {
        const rng = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: p.value });
        const tv = h('span', { class: 'pv' }, p.text + (p.label ? ' ' + p.label : ''));
        rng.oninput = async () => { await api('insert-param', { target, idx: i, key: p.key, v: +rng.value }); };
        rng.onchange = async () => { const fresh = await api('insert-params', undefined, `?target=${target}&idx=${i}`); const q = fresh.find(x => x.key === p.key); if (q) tv.textContent = q.text + (q.label ? ' ' + q.label : ''); };
        paramBox.append(h('label', {}, h('span', {}, p.name), rng, tv));
      }
    }
    body.append(h('div', { class: 'panel' + (isMaster ? ' wide' : '') }, h('h4', {}, 'Plug-ins (VST3 / AU)'), insBox,
      h('button', { class: 'btn', style: 'margin-top:6px', onclick: () => pickPlugin(target) }, '+ Add plug-in'), paramBox));

    edLive = m => {
      const gr = isMaster ? m.mgr : (m.gr[t] || 0);
      grbar.style.width = Math.min(100, gr * 5) + '%';
      grTxt.textContent = gr > 0.1 ? `-${gr.toFixed(1)} dB` : '';
      if (!isMaster) {
        gateLed.textContent = st.gate.on ? ((m.gg[t] || 0) > 3 ? '● closed' : '○ open') : '';
        const ds = m.ds?.[t] || 0; dsBar.style.width = Math.min(100, ds * 8) + '%'; dsTxt.textContent = ds > 0.1 ? `-${ds.toFixed(1)} dB` : '';
      }
      if (m.csp) {  // fast rise, slow fall so short hits stay readable
        liveSpec = liveSpec && liveSpec.length === m.csp.length ? m.csp.map((v, i) => Math.max(v, liveSpec[i] - 1.5)) : m.csp;
        redrawEq();
      }
    };
    edRefresh = path => {
      const c = edCtl.get(key(path)); if (c) c.set(getPath(S.mixer, path));
      if (path.includes('comp')) drawComp();
      if (path.includes('eq') || path.includes('hpf') || path.includes('lpf')) redrawEq();
      if (path.length === base.length + 1 && ['hpf', 'comp', 'gate', 'eq'].includes(path[path.length - 1])) openEditor(t);
    };
    $('#editor').hidden = false;
    requestAnimationFrame(() => { redrawEq(); drawComp(); });
  };
  let edRefresh = () => { };
  const closeEd = () => { $('#editor').hidden = true; edTarget = null; edLive = null; send({ t: 'focus', ch: null }); };
  $('#edClose').onclick = closeEd;
  const step = d => { if (edTarget === 'master') return; const n = S.mixer.channels.length; openEditor((edTarget + d + n) % n); };
  $('#edPrev').onclick = () => step(-1);
  $('#edNext').onclick = () => step(1);
  $('#edCopy').onclick = () => { const s = JSON.parse(JSON.stringify(strip(edTarget))); clipboard = s; toast('Copied ' + s.name + ' settings'); };
  $('#edPaste').onclick = () => {
    if (!clipboard) return toast('Copy a channel first', true);
    const base = chPath(edTarget);
    for (const k of ['hpf', 'lpf', 'eq', 'comp', ...(edTarget === 'master' ? [] : ['gate', 'deess', 'trim', 'sends'])]) if (clipboard[k] !== undefined) setParam([...base, k], JSON.parse(JSON.stringify(clipboard[k])));
    openEditor(edTarget); toast('Pasted');
  };
  $('#edReset').onclick = () => {
    if (!confirm('Reset processing on this channel?')) return;
    const base = chPath(edTarget), s = strip(edTarget);
    setParam([...base, 'hpf'], { ...s.hpf, on: false }); setParam([...base, 'lpf'], { ...s.lpf, on: false });
    setParam([...base, 'eq'], { on: true, bands: s.eq.bands.map(b => ({ ...b, gain: 0 })) });
    setParam([...base, 'comp'], { ...s.comp, on: false });
    if (edTarget !== 'master') { setParam([...base, 'gate'], { ...s.gate, on: false }); setParam([...base, 'deess'], { ...s.deess, on: false }); setParam([...base, 'trim'], 0); }
    openEditor(edTarget);
  };

  async function pickPlugin(target) {
    modal(async (card, close) => {
      const list = h('div', { class: 'list', style: 'max-height:50vh' });
      const q = h('input', { placeholder: 'Search plug-ins…', style: 'width:100%' });
      card.append(h('h3', {}, 'Add plug-in'), h('p', { class: 'hint' }, 'Your installed VST3' + (navigator.platform.includes('Mac') ? ' and Audio Unit' : '') + ' plug-ins. Settings are adjusted here as sliders (plugin windows can\'t open in a browser).'), q, list, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel')));
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
})();
