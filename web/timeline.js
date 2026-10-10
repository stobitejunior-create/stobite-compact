// Multitrack timeline: waveforms, clips, split/trim/move/fade, range edits, markers.
(() => {
  const RULER = 30;
  const T = { spp: 2048, x0: 0, y0: 0, th: 54, tool: 'select', sel: new Set(), range: null, drag: null, lastTrack: 0, follow: true, autoView: '' };
  const canvas = $('#tcanvas'), wrap = $('#tcwrap'), heads = $('#theads');
  const g = canvas.getContext('2d');
  const peaks = new Map(); // key file|level -> Uint8Array | 'loading'
  let dirty = true, W = 0, H = 0, phT = 0, phV = 0;

  const clips = () => S.session?.clips || [];
  const nch = () => S.session?.nch || 48;
  // rows are channel numbers (in mixer order) plus, in automation view, 'bus:i' / 'fx:i' / 'master' lanes
  const isAux = t => typeof t === 'string';
  function chan(t) {
    if (isAux(t)) {
      if (t === 'master') return { name: 'Master', color: '#e8e9eb', aux: true, fader: S.mixer.master.fader };
      const [k, i] = t.split(':'), o = k === 'bus' ? S.mixer.buses[+i] : S.mixer.fx[+i];
      return { name: (k === 'bus' ? 'Bus · ' : 'FX · ') + (o?.name || t), color: o?.color || '#5b8def', aux: true, fader: k === 'bus' ? o?.fader : o?.ret, mute: o?.mute, sends: o?.sends };
    }
    return S.mixer?.channels[t] || { name: 'Ch ' + (t + 1), color: '#666' };
  }
  let vis = [], chanRows = 0;
  function computeVisible() {
    const order = S.mixer?.order || [...Array(nch()).keys()];
    if ($('#hideEmpty').checked) {
      const used = new Set(clips().map(c => c.track));
      if (S.tr.recording) S.session.armed.forEach((a, i) => a && used.add(i));
      vis = order.filter(c => used.has(c));
      if (!vis.length) vis = [...order];
    } else vis = [...order];
    chanRows = vis.length;
    if (T.autoView && S.mixer) {
      const aux = [];
      if (['fader', 'mute', 'send0', 'send1', 'send2', 'send3'].includes(T.autoView)) S.mixer.buses.forEach((b, i) => aux.push('bus:' + i));
      if (['fader', 'mute'].includes(T.autoView)) S.mixer.fx.forEach((f, i) => aux.push('fx:' + i));
      if (T.autoView === 'fader') aux.push('master');
      vis = vis.concat(aux);
    }
  }
  const rowOf = track => vis.indexOf(track);
  const xOf = s => (s - T.x0) / T.spp;
  const sOf = x => Math.max(0, Math.round(T.x0 + x * T.spp));
  const yOfRow = r => RULER + r * T.th - T.y0;
  const rowAt = y => Math.floor((y - RULER + T.y0) / T.th);
  let frameQueued = false;
  const kick = () => { if (!frameQueued) { frameQueued = true; requestAnimationFrame(frame); } };
  const invalidate = () => { dirty = true; kick(); };

  // ---------------------------------------------------------- size
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    invalidate();
  }
  new ResizeObserver(resize).observe(wrap);

  // ---------------------------------------------------------- headers
  let headEls = [];
  function buildHeads() {
    computeVisible();
    heads.innerHTML = '';
    headEls = vis.map((t, r) => {
      const ch = chan(t);
      if (ch.aux) {
        const target = t === 'master' ? 'master' : t;
        const el = h('div', { class: 'thead aux', style: `top:${r * T.th}px;height:${T.th}px` },
          h('div', { class: 'col', style: `background:${ch.color}` }), icon(t === 'master' ? 'broadcast' : t.startsWith('fx') ? 'fx' : 'bus', 15),
          h('span', { class: 'tname', onclick: () => openEditor(t === 'master' ? 'master' : t.startsWith('fx') ? t : 'bus:' + S.mixer.buses[+t.split(':')[1]].id) }, ch.name), autoModeButton(target));
        heads.append(el);
        return { el, mi: null, t };
      }
      const name = h('input', { class: 'tname', value: ch.name, onchange: e => setParam(['channels', t, 'name'], e.target.value) });
      const arm = h('button', { class: 'tog r' + (S.session.armed[t] ? ' on' : ''), title: 'Arm for recording', onclick: () => { const a = [...S.session.armed]; a[t] = !a[t]; send({ t: 'edit', op: 'arm', args: { armed: a } }); } }, 'R');
      const mute = h('button', { class: 'tog m' + (ch.mute ? ' on' : ''), title: 'Mute', onclick: () => setParam(['channels', t, 'mute'], !chan(t).mute) }, 'M');
      const solo = h('button', { class: 'tog s' + (ch.solo ? ' on' : ''), title: 'Solo', onclick: () => setParam(['channels', t, 'solo'], !chan(t).solo) }, 'S');
      const mi = h('i');
      const auto = autoModeButton(String(t));
      const ic = h('button', { class: 'ticon', title: 'What is on this channel?', onclick: () => pickFor(t) }, icon(ch.icon || 'input', 16));
      const el = h('div', { class: 'thead', draggable: 'true', style: `top:${r * T.th}px;height:${T.th}px` },
        h('div', { class: 'col', style: `background:${ch.color}` }), h('span', { class: 'tnum' }, t + 1), ic, name, arm, mute, solo, auto, h('div', { class: 'hm' }, mi));
      el.ondblclick = e => { if (e.target === el) openEditor(t); };
      // drag a track header onto another to reorder (same order as the mixer)
      el.addEventListener('dragstart', e => { if (e.target.closest('input')) return e.preventDefault(); e.dataTransfer.setData('text/x-track', String(t)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-track')) { e.preventDefault(); el.classList.add('dropto'); } });
      el.addEventListener('dragleave', () => el.classList.remove('dropto'));
      el.addEventListener('drop', e => { el.classList.remove('dropto'); const from = +e.dataTransfer.getData('text/x-track'); if (!isNaN(from) && from !== t && e.dataTransfer.types.includes('text/x-track')) { e.preventDefault(); moveChannel(from, t); } });
      heads.append(el);
      return { el, mi, t };
    });
    heads.scrollTop = T.y0;
    invalidate();
  }
  on('session', () => { if (!T.drag || T.drag.type !== 'auto') buildHeads(); });
  on('mixer', buildHeads);
  on('set', p => { if ((p[0] === 'channels' && ['name', 'mute', 'solo', 'color', 'icon'].includes(p[2])) || p[0] === 'order') buildHeads(); });
  on('order', buildHeads);
  $('#hideEmpty').onchange = () => { T.y0 = 0; buildHeads(); };
  $('#trackH').onchange = e => { T.th = +e.target.value; buildHeads(); };
  $('#armAll').onclick = () => { const any = S.session.armed.some(Boolean); send({ t: 'edit', op: 'arm', args: { armed: S.session.armed.map(() => !any) } }); };
  on('meters', m => {
    for (const he of headEls) if (he.mi) he.mi.style.height = (meterPos((m.pl && !m.rc ? m.p : m.i)[he.t] / 1000) * 100) + '%';
    phV = m.ph; phT = performance.now();
    if (m.pl || m.rc) invalidate();
  });

  // ---------------------------------------------------------- peaks
  function peakLevel() { let l = 256; while (l * 2 <= T.spp) l *= 2; return l; }
  function getPeaks(file, level) {
    const k = file + '|' + level;
    const p = peaks.get(k);
    if (p) return p === 'loading' ? null : p;
    peaks.set(k, 'loading');
    fetch(`/api/peaks?file=${encodeURIComponent(file)}&spp=${level}`).then(r => r.arrayBuffer()).then(b => { peaks.set(k, new Uint8Array(b)); invalidate(); }).catch(() => peaks.delete(k));
    return null;
  }

  // ---------------------------------------------------------- geometry during drags
  function geom(c) {
    let start = c.start, len = c.length, track = c.track, fin = c.fin || 0, fout = c.fout || 0;
    const d = T.drag;
    if (d && d.ids && d.ids.includes(c.id)) {
      if (d.type === 'move') { start = Math.max(0, start + d.ds); const r = clamp(rowOf(track) + d.dr, 0, chanRows - 1); track = vis[r]; }
      else if (d.type === 'trimL') { const ns = clamp(start + d.ds, start - c.offset, start + len - 64); len -= ns - start; start = ns; }
      else if (d.type === 'trimR') { len = clamp(len + d.ds, 64, (c.fileLength || c.offset + len) - c.offset); }
      else if (d.type === 'fin') fin = clamp(fin + d.ds, 0, len);
      else if (d.type === 'fout') fout = clamp(fout - d.ds, 0, len);
    }
    return { start, len, track, fin, fout };
  }

  // ---------------------------------------------------------- draw
  function playheadNow() {
    if (!S.tr.playing && !S.tr.recording) return S.tr.playhead;
    return phV + (performance.now() - phT) / 1000 * sr();
  }
  on('theme', () => draw());
  function draw() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = CV.bg; g.fillRect(0, 0, W, H);
    const sel = T.range;
    // rows
    const r0 = Math.max(0, rowAt(RULER)), r1 = Math.min(vis.length - 1, rowAt(H));
    for (let r = r0; r <= r1; r++) {
      const y = yOfRow(r);
      g.fillStyle = r % 2 ? CV.row1 : CV.row2; g.fillRect(0, y, W, T.th);
      g.fillStyle = CV.sep; g.fillRect(0, y + T.th - 1, W, 1);
    }
    // grid lines (seconds)
    const secPx = sr() / T.spp;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find(s => s * secPx >= 90) || 3600;
    const firstSec = Math.floor(T.x0 / sr() / step) * step;
    g.fillStyle = CV.tick;
    for (let s = firstSec; ; s += step) { const x = xOf(s * sr()); if (x > W) break; if (x >= 0) g.fillRect(Math.round(x), RULER, 1, H); }
    // range
    if (sel) {
      const xa = xOf(Math.min(sel.s, sel.e)), xb = xOf(Math.max(sel.s, sel.e));
      const ra = Math.min(sel.r0, sel.r1), rb = Math.max(sel.r0, sel.r1);
      g.fillStyle = 'rgba(58,160,255,.16)'; g.fillRect(xa, yOfRow(ra), xb - xa, (rb - ra + 1) * T.th);
      g.fillStyle = 'rgba(58,160,255,.7)'; g.fillRect(xa, RULER, 1, H); g.fillRect(xb, RULER, 1, H);
    }
    // clips
    const level = peakLevel();
    for (const c of clips()) {
      const gm = geom(c);
      const r = rowOf(gm.track); if (r < r0 || r > r1) continue;
      const x = xOf(gm.start), w = gm.len / T.spp;
      if (x > W || x + w < 0) continue;
      const y = yOfRow(r) + 1, hh = T.th - 3;
      const col = chan(gm.track).color, selected = T.sel.has(c.id);
      g.fillStyle = c.mute ? CV.muted : hexA(col, selected ? 0.42 : 0.24); g.fillRect(x, y, w, hh);
      g.fillStyle = hexA(col, selected ? 1 : 0.75); g.fillRect(x, y, w, Math.min(13, hh / 3));
      // waveform
      const pk = getPeaks(c.file, level);
      if (pk && w > 1) {
        const off = c.offset + (gm.start - c.start) * (T.drag?.type === 'trimL' && T.drag.ids.includes(c.id) ? 1 : 0);
        const fileOff = T.drag?.type === 'trimL' && T.drag.ids.includes(c.id) ? c.offset + (gm.start - c.start) : c.offset;
        const top = y + 13, wh = hh - 14, mid = top + wh / 2, gain = Math.pow(10, (c.gain || 0) / 20);
        const xs = Math.max(0, Math.floor(x)), xe = Math.min(W, Math.ceil(x + w));
        g.fillStyle = c.mute ? CV.label : (selected ? CV.waveSel : CV.wave);
        for (let px = xs; px < xe; px++) {
          const a = fileOff + (px - x) * T.spp, b = a + T.spp;
          let i0 = Math.floor(a / level), i1 = Math.max(i0 + 1, Math.floor(b / level));
          let m = 0; for (let i = i0; i < i1 && i < pk.length; i++) if (pk[i] > m) m = pk[i];
          let v = (m / 255); v = v * v * gain; // undo sqrt display scaling, apply clip gain
          let env = 1;
          const pos = (px - x) * T.spp;
          if (gm.fin > 0) env *= clamp(pos / gm.fin, 0, 1);
          if (gm.fout > 0) env *= clamp((gm.len - pos) / gm.fout, 0, 1);
          const hv = Math.max(0.5, Math.sqrt(Math.min(v * env, 1)) * wh / 2);
          g.fillRect(px, mid - hv, 1, hv * 2);
        }
      }
      // fades
      if (gm.fin > 0 || gm.fout > 0) {
        g.strokeStyle = '#ffd23f'; g.lineWidth = 1.2; g.beginPath();
        if (gm.fin > 0) { g.moveTo(x, y + hh); g.lineTo(x + gm.fin / T.spp, y + 13); }
        if (gm.fout > 0) { g.moveTo(x + w - gm.fout / T.spp, y + 13); g.lineTo(x + w, y + hh); }
        g.stroke();
      }
      // name + border
      if (w > 30) { g.fillStyle = '#000'; g.font = '600 10.5px system-ui'; g.save(); g.beginPath(); g.rect(x, y, w, 13); g.clip(); g.fillText((c.gain ? `${c.name}  ${c.gain > 0 ? '+' : ''}${c.gain.toFixed(1)}dB` : c.name), Math.max(x, 0) + 4, y + 10); g.restore(); }
      g.strokeStyle = selected ? CV.waveSel : hexA(col, 0.9); g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
      if (selected && w > 24) { g.fillStyle = '#ffd23f'; g.fillRect(x + gm.fin / T.spp - 3, y + 13, 6, 6); g.fillRect(x + w - gm.fout / T.spp - 3, y + 13, 6, 6); }
    }
    // live recording blocks
    if (S.tr.recording && S.meters) {
      const recStart = playheadNow() - (S.meters.rf || 0);
      for (let t = 0; t < nch(); t++) if (S.session.armed[t]) {
        const r = rowOf(t); if (r < r0 || r > r1) continue;
        const x = xOf(recStart), x2 = xOf(playheadNow());
        g.fillStyle = 'rgba(255,77,79,.25)'; g.fillRect(x, yOfRow(r) + 1, x2 - x, T.th - 3);
        g.fillStyle = 'rgba(255,77,79,.9)'; g.fillRect(x, yOfRow(r) + 1, x2 - x, 3);
      }
    }
    if (T.autoView) drawAutomation(r0, r1);
    // ruler
    g.fillStyle = CV.ruler; g.fillRect(0, 0, W, RULER); g.fillStyle = CV.ruleLine; g.fillRect(0, RULER - 1, W, 1);
    g.fillStyle = CV.text; g.font = '10.5px ui-monospace, Menlo, monospace';
    for (let s = firstSec; ; s += step) {
      const x = xOf(s * sr()); if (x > W) break;
      if (x < -60) continue;
      g.fillRect(Math.round(x), RULER - 9, 1, 9);
      const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
      g.fillText(hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`, Math.round(x) + 3, 12);
      for (let k = 1; k < 5; k++) { const xx = xOf((s + step * k / 5) * sr()); g.fillRect(Math.round(xx), RULER - 4, 1, 4); }
    }
    // loop region
    const lp = S.session?.loop;
    if (lp && lp.end > lp.start) {
      const a = xOf(lp.start), b = xOf(lp.end);
      g.fillStyle = lp.on ? 'rgba(62,207,110,.85)' : 'rgba(154,160,168,.35)';
      g.fillRect(a, 0, b - a, 5);
      if (lp.on) { g.fillStyle = 'rgba(62,207,110,.06)'; g.fillRect(a, RULER, b - a, H); }
    }
    // markers
    for (const mk of S.session?.markers || []) {
      const x = xOf(mk.pos); if (x < -100 || x > W) continue;
      g.fillStyle = '#6e56cf'; g.fillRect(Math.round(x), 14, 1, H);
      const tw = g.measureText(mk.name).width + 8;
      g.fillRect(x, 14, tw, 13); g.fillStyle = '#fff'; g.fillText(mk.name, x + 4, 24);
    }
    // playhead
    const px = xOf(playheadNow());
    if (px >= -1 && px <= W + 1) {
      g.fillStyle = S.tr.recording ? '#ff4d4f' : '#f76b15'; g.fillRect(Math.round(px), 0, 1.5, H);
      g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.fill();
    }
  }
  // ---------------------------------------------------------- automation
  const isSend = () => T.autoView.startsWith('send');
  function autoKey(t) {
    const v = T.autoView;
    if (t === 'master') return 'master:fader';
    if (isAux(t)) {
      const [k, i] = t.split(':');
      if (k === 'bus') return v === 'mute' ? `p:buses/${i}/mute` : isSend() ? `p:buses/${i}/sends/${v.slice(4)}` : `p:buses/${i}/fader`;
      return v === 'mute' ? `p:fx/${i}/mute` : `p:fx/${i}/ret`;
    }
    if (isSend()) return `p:channels/${t}/sends/${v.slice(4)}`;
    return `ch:${t}:${v}`;
  }
  const kindOf = () => (T.autoView === 'pan' ? 'pan' : T.autoView === 'mute' ? 'mute' : 'db');
  const toN = v => kindOf() === 'db' ? dbToPos(v) : kindOf() === 'pan' ? (v + 1) / 2 : v;
  const fromN = n => { n = clamp(n, 0, 1); return kindOf() === 'db' ? Math.round(posToDb(n) * 10) / 10 : kindOf() === 'pan' ? Math.round((n * 2 - 1) * 100) / 100 : (n > 0.5 ? 1 : 0); };
  const laneY = (r, n) => yOfRow(r) + 5 + (1 - n) * (T.th - 10);
  const laneN = (r, y) => 1 - (y - yOfRow(r) - 5) / (T.th - 10);
  const curValue = t => {
    const ch = chan(t);
    if (isSend()) return ch.sends?.[+T.autoView.slice(4)] ?? -90;
    return T.autoView === 'fader' ? (ch.fader ?? 0) : T.autoView === 'pan' ? (ch.pan ?? 0) : (ch.mute ? 1 : 0);
  };
  function lanePoints(t) {
    const d = T.drag;
    if (d && d.type === 'auto' && d.track === t) return d.points;
    return S.session.automation?.[autoKey(t)] || null;
  }
  function drawAutomation(r0, r1) {
    for (let r = r0; r <= r1; r++) {
      const t = vis[r], pts = lanePoints(t);
      const y0 = yOfRow(r);
      g.fillStyle = CV.lane; g.fillRect(0, y0, W, T.th - 1);
      if (!pts || !pts.length) {
        g.setLineDash([4, 4]); g.strokeStyle = 'rgba(154,160,168,.6)'; g.lineWidth = 1;
        const y = laneY(r, toN(curValue(t))); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]);
        continue;
      }
      const step = kindOf() === 'mute';
      g.beginPath();
      let px = 0, py = laneY(r, toN(pts[0][1]));
      g.moveTo(0, py);
      for (const [pos, v] of pts) {
        const x = xOf(pos), y = laneY(r, toN(v));
        if (step) g.lineTo(x, py);
        g.lineTo(x, y); px = x; py = y;
      }
      g.lineTo(W, py);
      g.strokeStyle = '#ffd23f'; g.lineWidth = 1.8; g.stroke();
      g.lineTo(W, y0 + T.th - 1); g.lineTo(0, y0 + T.th - 1); g.closePath(); g.fillStyle = 'rgba(255,210,63,.07)'; g.fill();
      for (const [pos, v] of pts) {
        const x = xOf(pos); if (x < -6 || x > W + 6) continue;
        g.beginPath(); g.arc(x, laneY(r, toN(v)), 3.5, 0, Math.PI * 2); g.fillStyle = '#ffd23f'; g.fill();
      }
    }
  }
  function autoHit(t, r, x, y) {
    const pts = S.session.automation?.[autoKey(t)] || [];
    return pts.findIndex(([pos, v]) => Math.abs(xOf(pos) - x) < 7 && Math.abs(laneY(r, toN(v)) - y) < 7);
  }
  function sendLane(t, pts) {
    const key = autoKey(t);
    S.session.automation = { ...(S.session.automation || {}) };  // optimistic: rapid clicks build on this
    if (pts.length) S.session.automation[key] = pts.map(p => [...p]); else delete S.session.automation[key];
    send({ t: 'edit', op: 'auto', args: { key, points: pts } });
  }
  $('#autoView').onchange = e => { T.autoView = e.target.value; buildHeads(); };

  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

  // draws only when something changed, or continuously while the playhead is moving
  function frame() {
    frameQueued = false;
    if (S.view !== 'edit' || !S.session) return;
    const playing = S.tr.playing || S.tr.recording;
    if (playing && T.follow && !T.drag) {
      const px = xOf(playheadNow());
      if (px > W * 0.92 || px < 0) { T.x0 = Math.max(0, playheadNow() - W * 0.08 * T.spp); }
    }
    if (dirty || playing) { draw(); dirty = false; }
    if (playing) kick();
  }
  on('view', v => v === 'edit' && (resize(), invalidate()));
  on('session', () => { for (const id of [...T.sel]) if (!clips().some(c => c.id === id)) T.sel.delete(id); renderClipbar(); invalidate(); });
  on('transport', invalidate);

  // ---------------------------------------------------------- hit testing
  function hit(x, y) {
    const r = rowAt(y); if (r < 0 || r >= vis.length) return null;
    const t = vis[r], s = sOf(x);
    const list = clips().filter(c => c.track === t && s >= c.start && s < c.start + c.length);
    const c = list[list.length - 1];
    if (!c) return { track: t, row: r };
    const cx = xOf(c.start), cw = c.length / T.spp, cy = yOfRow(r);
    let zone = 'body';
    if (T.sel.has(c.id) && y - cy < 22) {
      if (Math.abs(x - (cx + (c.fin || 0) / T.spp)) < 7) zone = 'fin';
      else if (Math.abs(x - (cx + cw - (c.fout || 0) / T.spp)) < 7) zone = 'fout';
    }
    if (zone === 'body') { if (x - cx < 6 && cw > 14) zone = 'trimL'; else if (cx + cw - x < 6 && cw > 14) zone = 'trimR'; }
    return { track: t, row: r, clip: c, zone };
  }

  canvas.addEventListener('pointermove', e => {
    if (T.drag) return;
    const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y < RULER) { canvas.style.cursor = 'text'; return; }
    const ht = hit(x, y);
    canvas.style.cursor = T.tool === 'blade' && ht?.clip ? 'crosshair' : T.tool === 'range' ? 'text' :
      ht?.zone === 'trimL' || ht?.zone === 'trimR' ? 'ew-resize' : ht?.zone === 'fin' || ht?.zone === 'fout' ? 'col-resize' : ht?.clip ? 'grab' : 'default';
  });

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !S.session) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const sx = e.clientX, sy = e.clientY;
    if (y < RULER) {
      // markers first
      for (const mk of S.session.markers) { const mx = xOf(mk.pos); if (x >= mx && x <= mx + 80 && y >= 14) { tr('locate', { pos: mk.pos }); return; } }
      T.drag = { type: 'scrub' };
      tr('locate', { pos: sOf(x) });
    } else {
      const ht = hit(x, y);
      if (ht && !isAux(ht.track)) T.lastTrack = ht.track;
      if (T.autoView && ht && (!isAux(ht.track) || true)) {
        const t = ht.track, r = ht.row;
        const pts = (S.session.automation?.[autoKey(t)] || []).map(p => [...p]);
        let i = autoHit(t, r, x, y);
        if (i >= 0 && (e.altKey || e.detail >= 2)) { pts.splice(i, 1); sendLane(t, pts); return; }
        if (i < 0) { pts.push([sOf(x), fromN(laneN(r, y))]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex(p => p[0] === sOf(x)); }
        T.drag = { type: 'auto', track: t, row: r, points: pts, idx: i, moved: false };
      } else if (T.tool === 'blade' && ht?.clip) {
        send({ t: 'edit', op: 'split', args: e.shiftKey ? { at: sOf(x) } : { at: sOf(x), ids: [ht.clip.id] } });
        return;
      } else if (T.tool === 'select' && ht?.clip) {
        const c = ht.clip;
        if (e.shiftKey || e.metaKey) { T.sel.has(c.id) ? T.sel.delete(c.id) : T.sel.add(c.id); }
        else if (!T.sel.has(c.id)) { T.sel.clear(); T.sel.add(c.id); }
        T.range = null;
        const type = ht.zone === 'body' ? 'move' : ht.zone;
        T.drag = { type, ids: type === 'move' ? [...T.sel] : [c.id], ds: 0, dr: 0, clip: c, moved: false };
        renderClipbar();
      } else {
        if (!e.shiftKey) T.sel.clear();
        const r = clamp(rowAt(y), 0, vis.length - 1);
        T.range = { s: sOf(x), e: sOf(x), r0: r, r1: r };
        T.drag = { type: 'range', moved: false };
        renderClipbar();
      }
    }
    invalidate();
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const d = T.drag; if (!d) return;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
      if (d.type === 'scrub') tr('locate', { pos: sOf(cx) });
      else if (d.type === 'auto') {
        const p = d.points[d.idx], lo = d.idx > 0 ? d.points[d.idx - 1][0] + 1 : 0, hi = d.idx < d.points.length - 1 ? d.points[d.idx + 1][0] - 1 : Infinity;
        p[0] = clamp(sOf(cx), lo, hi); p[1] = fromN(laneN(d.row, cy));
      }
      else if (d.type === 'range') { T.range.e = sOf(cx); T.range.r1 = clamp(rowAt(cy), 0, vis.length - 1); renderClipbar(); }
      else { d.ds = Math.round(dx * T.spp); d.dr = d.type === 'move' ? Math.round(dy / T.th) : 0; }
      invalidate();
    };
    const up = ev => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      const d = T.drag; T.drag = null;
      if (!d) return;
      if (d.type === 'auto') { sendLane(d.track, d.points); invalidate(); return; }
      if (d.type === 'range') {
        if (!d.moved) { T.range = null; tr('locate', { pos: sOf(x) }); }
        else if (T.range.s > T.range.e) [T.range.s, T.range.e] = [T.range.e, T.range.s];
        renderClipbar();
      } else if (d.type !== 'scrub' && d.moved) {
        const c = d.clip;
        if (d.type === 'move') {
          const newRow = clamp(rowOf(c.track) + d.dr, 0, chanRows - 1);
          send({ t: 'edit', op: 'move', args: { ids: d.ids, delta: d.ds, trackDelta: vis[newRow] - c.track } });
        } else if (d.type === 'trimL') send({ t: 'edit', op: 'trim', args: { id: c.id, newStart: c.start + d.ds } });
        else if (d.type === 'trimR') send({ t: 'edit', op: 'trim', args: { id: c.id, newEnd: c.start + c.length + d.ds } });
        else if (d.type === 'fin') send({ t: 'edit', op: 'set', args: { ids: [c.id], fin: Math.round(clamp((c.fin || 0) + d.ds, 0, c.length)) } });
        else if (d.type === 'fout') send({ t: 'edit', op: 'set', args: { ids: [c.id], fout: Math.round(clamp((c.fout || 0) - d.ds, 0, c.length)) } });
      }
      invalidate();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  });

  canvas.addEventListener('dblclick', e => {
    const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y < RULER) {
      for (const mk of S.session.markers) { const mx = xOf(mk.pos); if (x >= mx && x <= mx + 80 && y >= 14) {
        const n = prompt('Marker name (empty to delete)', mk.name);
        if (n === null) return;
        send({ t: 'edit', op: n ? 'markerRename' : 'markerDelete', args: { id: mk.id, name: n } });
        return;
      } }
      return;
    }
    const ht = hit(x, y);
    if (ht?.clip && T.tool === 'select' && !T.autoView) send({ t: 'edit', op: 'split', args: { at: sOf(x), ids: [ht.clip.id] } });
  });

  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const mx = e.clientX - rect.left, at = T.x0 + mx * T.spp;
      zoom(Math.exp(e.deltaY * 0.01), at, mx, false);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      T.x0 = Math.max(0, T.x0 + (e.deltaX || e.deltaY) * T.spp);
      T.follow = !(S.tr.playing);
    } else {
      T.y0 = clamp(T.y0 + e.deltaY, 0, Math.max(0, vis.length * T.th - (H - RULER)));
      heads.scrollTop = T.y0;
    }
    invalidate();
  }, { passive: false });
  heads.addEventListener('wheel', e => { e.preventDefault(); T.y0 = clamp(T.y0 + e.deltaY, 0, Math.max(0, vis.length * T.th - (H - RULER))); heads.scrollTop = T.y0; invalidate(); }, { passive: false });
  // touch: two-finger pan handled by wheel on trackpads; single-finger pan on phones in empty area via range tool off
  let zoomTarget = null;
  function zoom(f, at, mx, smooth = true) {
    const goal = clamp((zoomTarget ?? T.spp) * f, 8, 1 << 20);
    if (!smooth) { T.spp = goal; if (at != null) T.x0 = Math.max(0, at - mx * T.spp); invalidate(); return; }
    zoomTarget = goal;
    const from = Math.log(T.spp), to = Math.log(goal);
    tween(0, 1, 180, k => {
      if (zoomTarget !== goal) return;
      T.spp = Math.exp(from + (to - from) * k);
      if (at != null) T.x0 = Math.max(0, at - mx * T.spp);
      invalidate();
    }, () => { if (zoomTarget === goal) zoomTarget = null; });
  }
  function fit() {
    const len = Math.max(S.session?.length || 0, sr() * 60);
    T.spp = clamp(len / Math.max(W - 40, 100), 8, 1 << 20); T.x0 = 0; invalidate();
  }
  $('#zoomIn').onclick = () => zoom(1 / 1.6, playheadNow(), xOf(playheadNow()));
  $('#zoomOut').onclick = () => zoom(1.6, playheadNow(), xOf(playheadNow()));
  $('#zoomFit').onclick = fit;

  // ---------------------------------------------------------- tools & edits
  function setTool(t) { T.tool = t; $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); }
  $$('#tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  function splitAtPlayhead() {
    const at = Math.round(playheadNow());
    const ids = [...T.sel];
    send({ t: 'edit', op: 'split', args: ids.length ? { at, ids } : { at } });
  }
  function deleteSel() {
    if (T.range && T.range.e !== T.range.s) {
      const ripple = $('#ripple').checked;
      const ra = Math.min(T.range.r0, T.range.r1), rb = Math.max(T.range.r0, T.range.r1);
      const all = ripple || (ra === 0 && rb === vis.length - 1);
      send({ t: 'edit', op: 'deleteRange', args: { start: Math.min(T.range.s, T.range.e), end: Math.max(T.range.s, T.range.e), ripple, tracks: all ? null : vis.slice(ra, rb + 1) } });
      T.range = null; renderClipbar();
    } else if (T.sel.size) { send({ t: 'edit', op: 'delete', args: { ids: [...T.sel] } }); T.sel.clear(); renderClipbar(); }
  }
  $('#btnSplit').onclick = splitAtPlayhead;
  $('#btnDelete').onclick = deleteSel;
  $('#btnUndo').onclick = () => send({ t: 'undo' });
  $('#btnRedo').onclick = () => send({ t: 'redo' });
  $('#btnMarker').onclick = () => send({ t: 'edit', op: 'marker', args: { pos: Math.round(playheadNow()) } });
  on('session', () => { $('#btnUndo').disabled = !S.session.canUndo; $('#btnRedo').disabled = !S.session.canRedo; });

  on('key', e => {
    if (S.view !== 'edit') return;
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (k === 's' && !mod) splitAtPlayhead();
    else if (k === 'backspace' || k === 'delete') { e.preventDefault(); deleteSel(); }
    else if (k === 'v') setTool('select');
    else if (k === 'b') setTool('blade');
    else if (k === 'g') setTool('range');
    else if (k === 'm') $('#btnMarker').click();
    else if (k === '=' || k === '+') $('#zoomIn').click();
    else if (k === '-') $('#zoomOut').click();
    else if (k === '0') fit();
    else if (k === 'a' && mod) { e.preventDefault(); clips().forEach(c => T.sel.add(c.id)); renderClipbar(); invalidate(); }
    else if (k === 'f') { T.follow = !T.follow; toast('Follow playhead ' + (T.follow ? 'on' : 'off')); }
    else if (k === 'a' && !mod) { const o = ['', 'fader', 'pan', 'mute']; T.autoView = o[(o.indexOf(T.autoView) + 1) % o.length]; $('#autoView').value = T.autoView; buildHeads(); }
    else if (k === 'arrowleft' || k === 'arrowright') {
      const ms = S.session.markers.map(m => m.pos).concat([0, S.session.length]).sort((a, b) => a - b), p = playheadNow();
      const t = k === 'arrowleft' ? ms.filter(m => m < p - sr() * 0.2).pop() : ms.find(m => m > p + 10);
      if (t != null) tr('locate', { pos: t });
    }
  });

  // ---------------------------------------------------------- clip bar
  function renderClipbar() {
    const bar = $('#clipbar'); bar.innerHTML = '';
    if (T.range && T.range.e !== T.range.s) {
      const a = Math.min(T.range.s, T.range.e), b = Math.max(T.range.s, T.range.e);
      bar.append(h('span', {}, h('b', {}, 'Range '), `${tc(a)} → ${tc(b)}  (${((b - a) / sr()).toFixed(2)}s)`),
        h('button', { class: 'btn', onclick: () => { tr('locate', { pos: a }); } }, 'Go to start'),
        h('button', { class: 'btn', onclick: () => send({ t: 'edit', op: 'split', args: { at: a } }) || send({ t: 'edit', op: 'split', args: { at: b } }) }, 'Split all at edges'),
        h('button', { class: 'btn danger', onclick: deleteSel }, $('#ripple').checked ? 'Delete & close gap' : 'Delete range'),
        h('button', { class: 'btn', onclick: () => { send({ t: 'edit', op: 'loop', args: { on: true, start: a, end: b } }); tr('locate', { pos: a }); } }, '⟳ Loop this'),
        h('button', { class: 'btn', onclick: () => openExport(a, b) }, 'Export range…'),
        h('button', { class: 'btn', onclick: () => { T.range = null; renderClipbar(); invalidate(); } }, 'Clear'));
      return;
    }
    const sel = clips().filter(c => T.sel.has(c.id));
    if (!sel.length) return;
    const c = sel[0];
    const ids = sel.map(c => c.id);
    const gain = h('input', { type: 'range', min: -24, max: 12, step: 0.5, value: c.gain || 0 });
    const gv = h('b', {}, fmt.db(c.gain || 0) + ' dB');
    gain.oninput = () => gv.textContent = fmt.db(+gain.value) + ' dB';
    gain.onchange = () => send({ t: 'edit', op: 'set', args: { ids, gain: +gain.value } });
    const ms = v => Math.round(v / sr() * 1000);
    const fin = h('input', { type: 'number', min: 0, step: 50, value: ms(c.fin || 0), style: 'width:80px' });
    const fout = h('input', { type: 'number', min: 0, step: 50, value: ms(c.fout || 0), style: 'width:80px' });
    fin.onchange = () => send({ t: 'edit', op: 'set', args: { ids, fin: Math.round(+fin.value / 1000 * sr()) } });
    fout.onchange = () => send({ t: 'edit', op: 'set', args: { ids, fout: Math.round(+fout.value / 1000 * sr()) } });
    bar.append(
      h('span', {}, h('b', {}, sel.length > 1 ? `${sel.length} clips` : c.name), sel.length === 1 ? `  ${chan(c.track).name} · ${tc(c.start)} · ${(c.length / sr()).toFixed(2)}s` : ''),
      h('label', {}, 'Gain', gain, gv),
      h('label', {}, 'Fade in', fin, 'ms'), h('label', {}, 'Fade out', fout, 'ms'),
      h('button', { class: 'btn', onclick: () => send({ t: 'edit', op: 'set', args: { ids, mute: !c.mute } }) }, c.mute ? 'Unmute clip' : 'Mute clip'),
      h('button', { class: 'btn', onclick: () => send({ t: 'edit', op: 'duplicate', args: { ids } }) }, 'Duplicate'),
      h('button', { class: 'btn danger', onclick: deleteSel }, 'Delete'));
  }

  // ---------------------------------------------------------- loop
  window.toggleLoop = () => {
    const lp = S.session.loop || { on: false, start: 0, end: 0 };
    if (T.range && T.range.e !== T.range.s && !lp.on) {
      const a = Math.min(T.range.s, T.range.e), b = Math.max(T.range.s, T.range.e);
      send({ t: 'edit', op: 'loop', args: { on: true, start: a, end: b } }); return;
    }
    if (lp.end - lp.start < 2048) return toast('Select a range first (Range tool, G), then press Loop', true);
    send({ t: 'edit', op: 'loop', args: { on: !lp.on } });
  };
  on('session', () => { $('#btnLoop').classList.toggle('on', !!S.session.loop?.on); $$('.thead .tog.auto').forEach(b => b.dispatchEvent(new Event('repaint'))); });

  // ---------------------------------------------------------- drag & drop audio files
  const AUDIO_RE = /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg|caf)$/i;
  wrap.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; wrap.classList.add('dropping'); } });
  wrap.addEventListener('dragleave', e => { if (e.target === wrap || e.target === canvas) wrap.classList.remove('dropping'); });
  wrap.addEventListener('drop', async e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); wrap.classList.remove('dropping');
    const proj = [...e.dataTransfer.files].find(f => f.name.endsWith('.stobite'));
    if (proj) return importProject(proj);
    const rect = canvas.getBoundingClientRect();
    const r = clamp(rowAt(e.clientY - rect.top), 0, Math.max(chanRows - 1, 0));
    let track = vis[r] ?? 0;
    const start = sOf(e.clientX - rect.left);
    const files = [...e.dataTransfer.files].filter(f => AUDIO_RE.test(f.name) || f.type.startsWith('audio/'));
    if (!files.length) return toast('Drop audio files (WAV, AIFF, FLAC, MP3)', true);
    for (const f of files) {
      const fd = new FormData(); fd.append('file', f, f.name);
      toast('Importing ' + f.name + '…');
      try { await api('import', fd, `?track=${track}&start=${start}`); } catch (err) { toast(f.name + ': ' + err.message, true); continue; }
      const next = vis[Math.min(vis.indexOf(track) + 1, chanRows - 1)];
      track = next ?? track;
    }
    toast('Imported ' + files.length + ' file' + (files.length > 1 ? 's' : ''));
  });

  // ---------------------------------------------------------- import / export
  $('#btnImport').onclick = () => $('#importFile').click();
  window.importProject = async f => {
    if (!confirm(`Open the project “${f.name}”? It is copied into your sessions and opened (the current session is saved first).`)) return;
    const fd = new FormData(); fd.append('file', f, f.name);
    toast('Opening project ' + f.name + '… (large projects take a moment)');
    const r = await tryApi('project-import', fd);
    toast('Opened project ' + r.name);
  };
  $('#importFile').onchange = async e => {
    const proj = [...e.target.files].find(f => f.name.endsWith('.stobite'));
    if (proj) { e.target.value = ''; return importProject(proj); }
    for (const f of e.target.files) {
      const fd = new FormData(); fd.append('file', f, f.name);
      toast('Importing ' + f.name + '…');
      await tryApi('import', fd, `?track=${T.lastTrack}&start=${Math.round(playheadNow())}`);
    }
    e.target.value = '';
    toast('Imported');
  };
  $('#btnExport').onclick = () => openExport();

  // ---- export formats: what each costs on disk
  const EXPORT_FORMATS = {
    wav:  { label: 'WAV', note: 'uncompressed, plays everywhere', pcm: true, depths: ['16', '24', '32f'] },
    aiff: { label: 'AIFF', note: 'uncompressed, Apple’s WAV', pcm: true, depths: ['16', '24', '32f'] },
    flac: { label: 'FLAC', note: 'lossless, about half the size', flac: true, depths: ['16', '24'] },
    mp3:  { label: 'MP3', note: 'small, plays everywhere', lossy: true, rates: [64, 96, 128, 160, 192, 224, 256, 320], def: 192 },
    opus: { label: 'Opus (.opus)', note: 'smallest for its quality; web and phones', lossy: true, rates: [64, 96, 128, 160, 192, 256], def: 128 },
  };
  const DEPTH_LABEL = { '16': '16-bit (CD)', '24': '24-bit (studio)', '32f': '32-bit float (no clipping)' };
  const RATE_HINT = { 64: 'speech only', 96: 'speech / sermon podcast', 128: 'good', 160: 'good', 192: 'very good', 224: 'very good', 256: 'excellent', 320: 'best MP3' };
  const fmtBytes = n => n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
  const fmtDur = sec => { sec = Math.round(sec); const hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
  const loadPrefs = () => { try { return JSON.parse(localStorage.getItem('stb-export') || '{}'); } catch (e) { return {}; } };
  const savePrefs = p => { try { localStorage.setItem('stb-export', JSON.stringify(p)); } catch (e) { /* private mode */ } };

  window.openExport = function (start, end, target) {
    modal(async (card, close) => {
      const pref = loadPrefs();
      const sel = (opts, val) => h('select', {}, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
      const kind = sel([['mix', 'Stereo mix (with all mixer effects)'], ['tracks', 'Separate tracks: open in Logic / Pro Tools / Cubase'],
        ['project', 'Project file (.stobite): every recording + the whole mix, to open on another computer']], pref.kind || 'mix');
      const f = h('select');
      const depth = h('select');
      const rate = h('select');
      const chans = sel([[2, 'Stereo'], [1, 'Mono (half the size; fine for a sermon podcast)']], pref.channels || 2);
      const loud = h('select', {}, h('option', { value: '' }, 'Off: keep mixer level'),
        ...[[-14, 'Streaming / YouTube / livestream (−14 LUFS)'], [-16, 'Apple Music / podcasts (−16 LUFS)'], [-18, 'Gentle / dynamic (−18 LUFS)'], [-23, 'Broadcast EBU R128 (−23 LUFS)']]
          .map(([v, l]) => h('option', { value: v, selected: target === v }, l)));
      const row = (label, el) => h('div', { class: 'f' }, h('span', {}, label), el);
      const fRow = row('Format', f), depthRow = row('Bit depth', depth), rateRow = row('Bitrate', rate), chRow = row('Channels', chans), loudRow = row('Loudness', loud);
      const sizeNum = h('div', { class: 'xsize-num' }, '…'), sizeSub = h('div', { class: 'xsize-sub' }), sizeNote = h('div', { class: 'xsize-note' });
      const sizeBox = h('div', { class: 'xsize' }, h('div', { class: 'xsize-l' }, 'Estimated file size'), sizeNum, sizeSub, sizeNote);
      const prog = h('div', { class: 'progress' }, h('i'));
      const out = h('div');
      const go = h('button', { class: 'btn accent' }, 'Export');
      card.append(h('h3', {}, 'Export'),
        h('p', { class: 'hint' }, start != null ? `Range ${tc(start)} → ${tc(end)}` : 'Whole session (all clips, with edits applied).'),
        h('div', { class: 'card' }, row('What', kind), fRow, depthRow, rateRow, chRow, loudRow),
        sizeBox, prog, out, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'), go));

      let est = null;
      try { est = await api('export-estimate', undefined, `?start=${start ?? ''}&end=${end ?? ''}`); } catch (e) { /* preview only */ }

      const fill = (el, opts, val) => { el.innerHTML = ''; opts.forEach(([v, l]) => el.append(h('option', { value: v, selected: String(v) === String(val) }, l))); };
      let shown = 0, anim = 0;
      let upTo = false;
      const showSize = (lo, hi) => {   // ease the number to its new value
        clearTimeout(anim);
        const from = shown, t0 = performance.now();
        const paint = v => { sizeNum.textContent = (upTo ? 'up to ' : '') + (hi ? '≈ ' + fmtBytes(v) + ' – ' + fmtBytes(v * hi / Math.max(lo, 1)) : lo ? fmtBytes(v) : '0 KB'); };
        const step = () => {   // timers, not animation frames: those pause when the window is in the background
          const k = Math.min((performance.now() - t0) / 260, 1), e = 1 - Math.pow(1 - k, 3);
          shown = from + (lo - from) * e;
          paint(shown);
          if (k < 1) anim = setTimeout(step, 16);
        };
        step();
      };

      const update = (rebuild) => {
        const k = kind.value;
        if (rebuild) {
          const keys = k === 'tracks' ? ['wav', 'aiff', 'flac'] : Object.keys(EXPORT_FORMATS);
          const cur = keys.includes(f.value) ? f.value : keys.includes(pref.fmt) ? pref.fmt : 'wav';
          fill(f, keys.map(x => [x, `${EXPORT_FORMATS[x].label}: ${EXPORT_FORMATS[x].note}`]), cur);
        }
        const F = EXPORT_FORMATS[f.value];
        const isMix = k === 'mix', isProj = k === 'project';
        if (F.depths) { const cur = F.depths.includes(depth.value) ? depth.value : F.depths.includes(pref.depth) ? pref.depth : '24'; fill(depth, F.depths.map(d => [d, DEPTH_LABEL[d]]), cur); }
        if (F.rates) { const cur = F.rates.includes(+rate.value) ? rate.value : F.rates.includes(+pref.kbps) ? pref.kbps : F.def; fill(rate, F.rates.map(r => [r, `${r} kbps · ${RATE_HINT[r]}`]), cur); }
        fRow.style.display = isProj ? 'none' : '';
        depthRow.style.display = !isProj && F.depths ? '' : 'none';
        rateRow.style.display = !isProj && F.rates ? '' : 'none';
        chRow.style.display = isMix ? '' : 'none';
        loudRow.style.display = isMix ? '' : 'none';
        savePrefs({ kind: k, fmt: f.value, depth: depth.value, kbps: rate.value, channels: chans.value });

        if (!est) { sizeNum.textContent = '—'; sizeSub.textContent = 'Size preview unavailable'; return; }
        const sr = est.sr, srTxt = (sr / 1000) + ' kHz';
        sizeNote.className = 'xsize-note'; sizeNote.textContent = '';
        let lo = 0, hi = 0, sub = '', note = '';
        if (isProj) {
          lo = est.projectBytes;
          sub = 'Every recording, as it is now, plus the mix';
          note = 'Exact: it is a copy of the project folder.';
        } else {
          const sec = est.seconds + (isMix ? est.tail : 0);
          const nch = isMix ? +chans.value : 1, files = isMix ? 1 : est.tracks;
          const what = isMix ? (nch === 1 ? 'mono' : 'stereo') : `${files} mono track${files === 1 ? '' : 's'}`;
          if (F.lossy) {
            lo = +rate.value * 1000 / 8 * sec * files;
            sub = `${fmtDur(sec)} · ${what} · ${F.label} ${rate.value} kbps`;
            note = f.value === 'mp3' ? 'Constant bitrate: the size is exact to within a few KB.' : 'Opus saves bits on silence and quiet talk, so this is the most it will be.';
          } else {
            const bytes = { '16': 2, '24': 3, '32f': 4 }[depth.value];
            const pcm = sec * sr * nch * bytes * files;
            sub = `${fmtDur(sec)} · ${what} · ${srTxt} · ${DEPTH_LABEL[depth.value].split(' ')[0]} ${F.label}`;
            if (F.flac) { lo = pcm * 0.45; hi = pcm * 0.7; note = 'FLAC shrinks quiet and simple sound more than loud, busy sound, so this is a range.'; }
            else { lo = pcm; note = 'Uncompressed: the size is exact.'; }
          }
          if (est.seconds <= 0) { lo = hi = 0; note = 'The timeline is empty: record or import something first.'; }
        }
        sizeSub.textContent = sub;
        sizeNote.textContent = note;
        const need = hi || lo;
        if (need > est.freeBytes * 0.95) { sizeNote.className = 'xsize-note warn'; sizeNote.textContent = `Not enough free space: ${fmtBytes(est.freeBytes)} free on this disk.`; }
        else if (need > 1e9) sizeNote.textContent += ` ${fmtBytes(est.freeBytes)} free on this disk.`;
        upTo = !isProj && f.value === 'opus';
        showSize(lo, hi);
      };
      kind.onchange = () => update(true);
      f.onchange = depth.onchange = rate.onchange = chans.onchange = () => update(false);
      update(true);

      go.onclick = async () => {
        go.disabled = true;
        try {
          if (kind.value === 'project') await api('project-export', {});
          else await api('export', { kind: kind.value, fmt: f.value, depth: depth.value, kbps: +rate.value || null, channels: +chans.value, start, end,
            target: loud.value === '' || kind.value === 'tracks' ? null : +loud.value });
        }
        catch (e) { out.innerHTML = ''; out.append(h('p', { class: 'err' }, e.message)); go.disabled = false; return; }
        const offM = (m) => { if (m.ex != null) prog.firstChild.style.width = (m.ex * 100) + '%'; };
        on('meters', offM);
        on('export', job => {
          prog.firstChild.style.width = '100%';
          out.innerHTML = '';
          if (job.error) { out.append(h('p', { class: 'err' }, job.error)); go.disabled = false; return; }
          const local = ['localhost', '127.0.0.1'].includes(location.hostname);
          out.append(h('p', { class: 'ok' }, 'Done: ' + job.file + (job.bytes ? ` (${fmtBytes(job.bytes)})` : '')),
            job.lufs != null && job.kind === 'mix' ? h('p', { class: 'hint' }, `Final loudness ${job.lufs} LUFS` + (job.gain != null ? ` (measured ${job.measured}, adjusted ${job.gain > 0 ? '+' : ''}${job.gain} dB)` : '')) : null,
            job.kind === 'project' ? h('p', { class: 'hint' }, 'Copy this one file to a USB stick or cloud drive. On the other computer: Edit → Import, or drag it onto the timeline.') : null,
            job.kind !== 'tracks' ? h('a', { class: 'btn', href: '/api/download?file=' + encodeURIComponent(job.file), style: 'display:inline-flex;align-items:center;text-decoration:none' }, 'Download') : null,
            local ? h('button', { class: 'btn', style: 'margin-left:6px', onclick: () => api('reveal', undefined, '?what=export') }, 'Show in folder') : null);
        });
      };
    });
  };
})();
