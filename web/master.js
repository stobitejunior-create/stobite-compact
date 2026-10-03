// Mastering: loudness (LUFS), spectrum, correlation, and the master chain.
(() => {
  const TARGETS = [[-10, 'Energetic livestream  −10'], [-12, 'Worship livestream  −12'], [-14, 'Streaming / YouTube  −14'], [-16, 'Apple Music / podcasts  −16'], [-18, 'Gentle / dynamic  −18'], [-23, 'Broadcast (EBU R128)  −23']];
  const hist = []; // short-term LUFS history (10 per second)
  const corrHist = [];
  let built = false, specCanvas, histCanvas, spec = null, specHold = null, els = {}, ctl = new Map();
  const M = () => S.mixer.master;
  const lufsTxt = v => v <= -70 ? '—' : v.toFixed(1);

  function build() {
    if (!S.mixer) return;
    const box = $('#masterView'); box.innerHTML = ''; ctl.clear();
    const K = (path, o) => { const k = Knob({ ...o, value: getPath(S.mixer, path), onChange: v => setParam(path, v) }); ctl.set(path.join('/'), k); return k.el; };
    const T = (path, label) => { const b = h('button', { class: 'tog g' + (getPath(S.mixer, path) ? ' on' : ''), onclick: () => setParam(path, !getPath(S.mixer, path)) }, label); ctl.set(path.join('/'), { set: v => b.classList.toggle('on', !!v) }); return b; };

    // loudness card
    els.mom = h('div', { class: 'lu-num' }, '—'); els.short = h('div', { class: 'lu-num' }, '—'); els.int = h('div', { class: 'lu-num big' }, '—');
    els.delta = h('div', { class: 'lu-delta' });
    const target = h('select', { onchange: e => { setParam(['master', 'target'], +e.target.value); paintHist(); } }, ...TARGETS.map(([v, l]) => h('option', { value: v, selected: M().target == v }, l)));
    histCanvas = h('canvas', { class: 'hist' });
    box.append(h('div', { class: 'card lu-card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Loudness'), h('span', { class: 'grow' }), target,
        h('button', { class: 'btn', onclick: () => { api('loudness-reset', {}); hist.length = 0; toast('Loudness measurement reset'); } }, 'Reset')),
      h('div', { class: 'lu-row' },
        h('div', { class: 'lu' }, h('span', {}, 'Momentary'), els.mom, h('small', {}, 'LUFS · 0.4 s')),
        h('div', { class: 'lu' }, h('span', {}, 'Short-term'), els.short, h('small', {}, 'LUFS · 3 s')),
        h('div', { class: 'lu main' }, h('span', {}, 'Integrated'), els.int, els.delta)),
      h('div', { class: 'lu-row small' },
        h('div', { class: 'lu' }, h('span', {}, 'True peak (max)'), els.tp = h('div', { class: 'lu-num sm' }, '—'), h('small', {}, 'dBTP · keep ≤ ' + (M().tp_max ?? -1))),
        h('div', { class: 'lu' }, h('span', {}, 'Loudness range'), els.lra = h('div', { class: 'lu-num sm' }, '—'), h('small', {}, 'LU · 6–12 feels dynamic')),
        h('div', { class: 'lu' }, h('span', {}, 'RMS'), els.rms = h('div', { class: 'lu-num sm' }, '—'), h('small', {}, 'dBFS'))),
      histCanvas));

    // meters card
    els.pkL = h('div', { class: 'pk' }); els.pkR = h('div', { class: 'pk' });
    els.corr = h('i'); els.corrTxt = h('span');
    const mL = Meter(), mR = Meter(); els.mL = mL; els.mR = mR;
    mL.el.classList.add('wide'); mR.el.classList.add('wide');
    box.append(h('div', { class: 'card meters-card' }, h('h3', {}, 'Output'),
      h('div', { class: 'big-meters' }, h('div', { class: 'bm' }, mL.el, els.pkL, h('small', {}, 'L')), h('div', { class: 'bm' }, mR.el, els.pkR, h('small', {}, 'R'))),
      h('div', { class: 'corr-wrap' }, h('div', { class: 'corr-lbl' }, h('small', {}, '−1'), h('small', {}, 'Phase correlation'), h('small', {}, '+1')), h('div', { class: 'corr' }, els.corr), els.corrTxt),
      els.monoWarn = h('div', { class: 'warnbox', hidden: true }, 'Mono problem: parts of the mix cancel on mono phone speakers. Reduce width or check for a channel with its phase flipped.'),
      h('div', { class: 'monmode' }, h('small', {}, 'Listen check'), h('div', { class: 'seg' }, ...[['stereo', 'Stereo'], ['mono', 'Mono'], ['side', 'Side'], ['left', 'L'], ['right', 'R']].map(([v, l]) =>
        h('button', { class: (S.mixer.monitor || 'stereo') === v ? 'on' : '', onclick: e => { setParam(['monitor'], v); $$('.monmode .seg button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); if (v !== 'stereo' && !(S.info?.cfg?.mon_l >= 0)) toast('Heads up: no separate monitor outputs set, so this also affects the stream output', true); } }, l))))));

    // spectrum card
    specCanvas = h('canvas', { class: 'spec' });
    box.append(h('div', { class: 'card spec-card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Spectrum'), h('span', { class: 'grow' }), h('span', { class: 'hint' }, 'master output · orange = master EQ')), specCanvas));

    // chain
    const eqThumb = h('canvas');
    els.eqThumb = eqThumb;
    els.gr = h('i'); els.lim = h('i');
    // the master chain, in its real order; each stage shows its main controls
    const MP = (k, ...p) => ['master', 'chain', k, ...p];
    const stage = (m, k) => {
      const info = CATALOG?.moduleTypes?.[m.type] || { label: m.type };
      const kids = [];
      if (m.type === 'eq') kids.push(h('div', { class: 'eqthumb big', onclick: () => openEditor('master') }, eqThumb));
      else if (m.type === 'comp') { kids.push(h('div', { class: 'knobs' }, K(MP(k, 'thr'), { label: 'Threshold', min: -40, max: 0, def: -12, format: fmt.db, size: 38, big: true }),
        K(MP(k, 'ratio'), { label: 'Ratio', min: 1, max: 10, log: true, def: 2, format: fmt.ratio, size: 38, big: true }),
        K(MP(k, 'makeup'), { label: 'Makeup', min: 0, max: 12, def: 0, format: fmt.db, size: 30 })), h('div', { class: 'grbar', title: 'Gain reduction' }, els.gr)); }
      else if (m.type === 'sat') kids.push(h('div', { class: 'knobs' }, K(MP(k, 'drive'), { label: 'Drive', min: 0, max: 12, def: 1.5, format: v => '+' + v.toFixed(1) + 'dB', size: 38, big: true, color: '#ffb366' }),
        K(MP(k, 'mix'), { label: 'Mix', min: 0, max: 100, def: 50, format: v => Math.round(v) + '%', size: 30, color: '#ffb366' })));
      else if (m.type === 'width') kids.push(h('div', { class: 'knobs' }, K(MP(k, 'width'), { label: 'Width', min: 0, max: 200, def: 100, format: v => Math.round(v) + '%', size: 38, big: true, color: '#3aa0ff' }),
        K(MP(k, 'balance'), { label: 'Balance', min: -1, max: 1, def: 0, format: fmt.pan, bipolar: true, size: 30 })));
      else if (m.type === 'limiter') { kids.push(h('div', { class: 'knobs' }, K(MP(k, 'threshold'), { label: 'Threshold', min: -12, max: 0, def: 0, format: fmt.db, size: 38, big: true }),
        K(MP(k, 'ceiling'), { label: 'Ceiling', min: -6, max: 0, def: -1, format: fmt.db, size: 38, big: true })),
        h('div', { class: 'frow' }, T(MP(k, 'truepeak'), 'True peak')), h('div', { class: 'grbar', title: 'Limiter gain reduction' }, els.lim)); }
      else kids.push(h('button', { class: 'btn', onclick: () => openEditor('master') }, 'Open settings'));
      return h('div', { class: 'stage' + (m.on === false ? ' off' : '') }, h('div', { class: 'stage-h' }, h('b', {}, String(k + 1)), m.type === 'plugin' ? m.name : info.label, T(MP(k, 'on'), 'ON')), ...kids);
    };
    const chain = h('div', { class: 'chain' }, ...(M().chain || []).map(stage),
      h('div', { class: 'stage' }, h('div', { class: 'stage-h' }, h('b', {}, '→'), 'Output'), h('div', { class: 'knobs' }, K(['master', 'fader'], { label: 'Output', min: -30, max: 12, def: 0, format: fmt.db, size: 38, big: true })),
        h('button', { class: 'btn', onclick: () => openEditor('master') }, 'Reorder / add…')));
    box.append(h('div', { class: 'card chain-card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Mastering chain'), h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: autoMaster, title: 'Sets gentle glue, ceiling and output gain toward the target from what is playing now' }, '✦ Auto-level to target'),
      h('button', { class: 'btn accent', onclick: () => openExport(undefined, undefined, M().target) }, 'Export mastered mix…')), chain));
    built = true;
    requestAnimationFrame(() => { sizeCanvases(); drawEqCurve(eqThumb, chainEqView(M()), S.info?.sr || 48000); mL.size(); mR.size(); });
  }

  function autoMaster() {
    const st = hist.filter(v => v > -60).slice(-150);
    if (st.length < 30) return toast('Play some of the mix first (at least 3 seconds) so I can measure it', true);
    const avg = st.reduce((a, b) => a + b, 0) / st.length;
    const need = M().target - avg;
    const ch = [...(M().chain || [])];
    const ci = ch.findIndex(x => x.type === 'comp');
    if (ci < 0) ch.splice(1, 0, makeModule('comp', { thr: -14, ratio: 2, att: 30, rel: 200 })); else ch[ci] = { ...ch[ci], on: true };
    const li = ch.findIndex(x => x.type === 'limiter');
    if (li < 0) ch.push(makeModule('limiter', { ceiling: -1, truepeak: true })); else ch[li] = { ...ch[li], on: true, ceiling: -1, truepeak: true };
    setParam(['master', 'chain'], ch);
    const out = clamp(Math.round((M().fader + need) * 10) / 10, -30, 12);
    setParam(['master', 'fader'], out);
    build();
    toast(`Output set to ${fmt.db(out)} dB to reach about ${M().target} LUFS`);
  }

  function sizeCanvases() {
    for (const c of [specCanvas, histCanvas]) if (c) { const d = devicePixelRatio || 1; c.width = c.clientWidth * d; c.height = c.clientHeight * d; }
  }

  function paintSpec() {
    if (!specCanvas || !spec) return;
    const c = specCanvas, g = c.getContext('2d'), d = devicePixelRatio || 1, W = c.width / d, H = c.height / d;
    g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
    const yOf = db => clamp((1 - (db + 90) / 90) * H, 0, H);
    g.strokeStyle = '#1b1e22'; g.fillStyle = '#4b515a'; g.font = '10px system-ui';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.log(f / 20) / Math.log(1000) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(fmt.hz(f), x + 3, H - 4); }
    for (const db of [-12, -24, -36, -48, -60, -72]) { const y = yOf(db); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(db, 3, y - 2); }
    const n = spec.length, bw = W / n;
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#ffb366'); grad.addColorStop(0.5, '#f76b15'); grad.addColorStop(1, 'rgba(247,107,21,.15)');
    g.fillStyle = grad;
    for (let i = 0; i < n; i++) { const y = yOf(spec[i]); g.fillRect(i * bw + 1, y, bw - 2, H - y); }
    g.fillStyle = '#e8e9eb';
    for (let i = 0; i < n; i++) g.fillRect(i * bw + 1, yOf(specHold[i]) - 1, bw - 2, 2);
    // master EQ curve overlay
    const secs = stripSections(chainEqView(M()), S.info?.sr || 48000);
    if (secs.length) {
      g.beginPath();
      for (let x = 0; x <= W; x += 3) { const f = 20 * Math.pow(1000, x / W); const y = H * 0.35 - responseDb(secs, f, S.info?.sr || 48000) * 3; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = 'rgba(247,107,21,.9)'; g.lineWidth = 2; g.stroke();
    }
  }

  function paintHist() {
    if (!histCanvas) return;
    const c = histCanvas, g = c.getContext('2d'), d = devicePixelRatio || 1, W = c.width / d, H = c.height / d;
    g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
    const lo = -40, hi = -4, yOf = v => H - (clamp(v, lo, hi) - lo) / (hi - lo) * H;
    g.fillStyle = '#4b515a'; g.font = '10px system-ui'; g.strokeStyle = '#1b1e22';
    for (const v of [-35, -28, -21, -14, -7]) { const y = yOf(v); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(v, 3, y - 2); }
    const ty = yOf(M().target);
    g.fillStyle = 'rgba(62,207,110,.08)'; g.fillRect(0, yOf(M().target + 1), W, yOf(M().target - 1) - yOf(M().target + 1));
    g.setLineDash([4, 4]); g.strokeStyle = '#3ecf6e'; g.beginPath(); g.moveTo(0, ty); g.lineTo(W, ty); g.stroke(); g.setLineDash([]);
    const n = Math.min(hist.length, Math.floor(W)), start = hist.length - n;
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = W - n + i, y = yOf(hist[start + i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = '#ffb366'; g.lineWidth = 1.8; g.stroke();
    g.lineTo(W, H); g.lineTo(W - n, H); g.closePath(); g.fillStyle = 'rgba(247,107,21,.12)'; g.fill();
  }

  on('meters', m => {
    if (m.lu) { hist.push(m.lu[1]); if (hist.length > 3000) hist.splice(0, hist.length - 3000); }
    if (S.view !== 'master' || !built) return;
    if (m.lu) {
      els.mom.textContent = lufsTxt(m.lu[0]); els.short.textContent = lufsTxt(m.lu[1]);
      const cv = clamp(m.lu[2], -1, 1);
      els.corr.style.left = cv < 0 ? `${50 + cv * 50}%` : '50%'; els.corr.style.width = `${Math.abs(cv) * 50}%`;
      els.corr.style.background = cv < 0 ? 'var(--red)' : 'var(--green)';
      els.corrTxt.textContent = cv.toFixed(2);
      corrHist.push(cv); if (corrHist.length > 60) corrHist.shift();
      const avg = corrHist.reduce((a, b) => a + b, 0) / corrHist.length;
      els.monoWarn.hidden = !(corrHist.length > 20 && avg < -0.05 && m.lu[1] > -50);
    }
    if (m.tpx != null && els.tp) { els.tp.textContent = m.tpx <= -100 ? '—' : m.tpx.toFixed(1); els.tp.style.color = m.tpx > (M().tp_max ?? -1) ? 'var(--red)' : ''; }
    if (m.lra != null && els.lra) els.lra.textContent = m.lra ? m.lra.toFixed(1) : '—';
    if (m.mr != null && els.rms) els.rms.textContent = m.mr > 0 ? (20 * Math.log10(m.mr / 1000)).toFixed(1) : '—';
    if (m.li != null) {
      els.int.textContent = lufsTxt(m.li);
      if (m.li > -70) {
        const dlt = m.li - M().target;
        els.delta.textContent = Math.abs(dlt) < 1 ? '✓ on target' : `${dlt > 0 ? '+' : ''}${dlt.toFixed(1)} LU ${dlt > 0 ? 'too loud' : 'too quiet'}`;
        els.delta.className = 'lu-delta ' + (Math.abs(dlt) < 1 ? 'ok' : Math.abs(dlt) < 3 ? 'warn' : 'bad');
      } else { els.delta.textContent = 'play audio to measure'; els.delta.className = 'lu-delta'; }
    }
    els.mL.set(m.m[0] / 1000); els.mR.set(m.m[1] / 1000);
    const pk = v => v <= 0.0001 ? '-∞' : (20 * Math.log10(v / 1000)).toFixed(1);
    els.pkL.textContent = pk(m.m[0]); els.pkR.textContent = pk(m.m[1]);
    els.pkL.classList.toggle('clip', m.m[0] >= 990); els.pkR.classList.toggle('clip', m.m[1] >= 990);
    els.gr.style.width = Math.min(100, m.mgr * 8) + '%';
    els.lim.style.width = Math.min(100, m.lim * 8) + '%';
    if (m.sp) {
      if (!spec) { spec = m.sp.slice(); specHold = m.sp.slice(); }
      for (let i = 0; i < m.sp.length; i++) {
        spec[i] = m.sp[i] > spec[i] ? spec[i] + (m.sp[i] - spec[i]) * 0.6 : spec[i] - Math.min(3, spec[i] - m.sp[i]); // fast rise, smooth fall
        specHold[i] = Math.max(specHold[i] - 0.6, spec[i]);
      }
      paintSpec();
    }
    paintHist();
  });
  on('view', v => {
    send({ t: 'spectrum', on: v === 'master' });
    if (v === 'master') build();
  });
  on('mixer', () => { if (S.view === 'master') build(); });
  on('set', path => {
    if (path[0] !== 'master' || S.view !== 'master') return;
    const c = ctl.get(path.join('/')); if (c) c.set(getPath(S.mixer, path));
    if (path[1] === 'chain' && els.eqThumb) drawEqCurve(els.eqThumb, chainEqView(M()), S.info?.sr || 48000);
    if (path.length === 2 && path[1] === 'chain') build();
  });
  window.addEventListener('resize', () => { if (S.view === 'master') { sizeCanvases(); paintHist(); } });
})();
