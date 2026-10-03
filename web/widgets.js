// Reusable controls: knobs, faders, meters + value formatting.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const fmt = {
  db: v => v <= -89.9 ? '-∞' : (v > 0 ? '+' : '') + v.toFixed(1),
  hz: v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + '',
  ms: v => v < 10 ? v.toFixed(1) + 'ms' : Math.round(v) + 'ms',
  ratio: v => v >= 20 ? '∞:1' : v.toFixed(1) + ':1',
  pan: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100),
  q: v => v.toFixed(2),
  pct: v => Math.round(v * 100) + '%',
  num: v => v.toFixed(2),
};

// --- fader dB taper (console-style: 0 dB at 75%)
const FT = [[0, -90], [0.06, -60], [0.17, -40], [0.32, -25], [0.47, -15], [0.6, -8], [0.75, 0], [1, 10]];
function dbToPos(db) {
  if (db <= -90) return 0;
  for (let i = 1; i < FT.length; i++) if (db <= FT[i][1]) {
    const [p0, d0] = FT[i - 1], [p1, d1] = FT[i];
    return p0 + (db - d0) / (d1 - d0) * (p1 - p0);
  }
  return 1;
}
function posToDb(p) {
  p = clamp(p, 0, 1);
  if (p <= 0.002) return -90;
  for (let i = 1; i < FT.length; i++) if (p <= FT[i][0]) {
    const [p0, d0] = FT[i - 1], [p1, d1] = FT[i];
    return d0 + (p - p0) / (p1 - p0) * (d1 - d0);
  }
  return 10;
}
// meter: linear peak -> 0..1 height (-60..+6 dBFS)
const meterPos = lin => lin <= 0.001 ? 0 : clamp((20 * Math.log10(lin) + 60) / 66, 0, 1);

// pointer drag helper (mouse + touch), dy/dx since start
function drag(el, { start, move, end }) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const ctx = start ? start(e) : null;
    const mv = ev => move && move(ev, ev.clientX - sx, ev.clientY - sy, ctx);
    const up = ev => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      end && end(ev, ctx);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// --- Knob
function Knob({ label = '', min = 0, max = 1, value = 0, def, log = false, step = 0, format = fmt.num, size = 34, color = '#f76b15', big = false, bipolar = false, onChange }) {
  def = def ?? value;
  const toN = v => log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  const fromN = n => { n = clamp(n, 0, 1); let v = log ? min * Math.pow(max / min, n) : min + n * (max - min); if (step) v = Math.round(v / step) * step; return v; };
  const r = size / 2 - 3, cx = size / 2, cy = size / 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  const arc = (a0, a1) => {
    const p = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
  };
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
  svg.innerHTML = `<path d="${arc(A0, A1)}" stroke="#2c3036" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path class="v" stroke="${color}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="${r - 5}" fill="#1c1f23" stroke="#3a3f47"/>
    <line class="p" stroke="#e8e9eb" stroke-width="2" stroke-linecap="round"/>`;
  const vEl = h('div', { class: 'kv' });
  const el = h('div', { class: 'knob' + (big ? ' big' : ''), title: label }, svg, vEl, label ? h('div', { class: 'kl' }, label) : null);
  let cur = value;
  const draw = () => {
    const n = clamp(toN(cur), 0, 1);
    const a = A0 + n * (A1 - A0);
    const mid = A0 + (bipolar ? 0.5 : 0) * (A1 - A0);
    const path = svg.querySelector('.v');
    if (Math.abs(a - mid) < 0.01) path.setAttribute('d', ''); else path.setAttribute('d', a > mid ? arc(mid, a) : arc(a, mid));
    const ln = svg.querySelector('.p');
    ln.setAttribute('x1', cx + (r - 12) * Math.cos(a) * 0.3); ln.setAttribute('y1', cy + (r - 12) * Math.sin(a) * 0.3);
    ln.setAttribute('x2', cx + (r - 6) * Math.cos(a)); ln.setAttribute('y2', cy + (r - 6) * Math.sin(a));
    vEl.textContent = format(cur);
  };
  const set = (v, emit) => { cur = v; draw(); if (emit) onChange && onChange(v); };
  drag(el, {
    start: () => toN(cur),
    move: (e, dx, dy, n0) => set(fromN(n0 - dy / (e.shiftKey ? 600 : 160)), true),
  });
  el.addEventListener('dblclick', () => set(def, true));
  el.addEventListener('wheel', e => { e.preventDefault(); set(fromN(toN(cur) - Math.sign(e.deltaY) / (e.shiftKey ? 400 : 60)), true); }, { passive: false });
  draw();
  let busy = false;
  el.addEventListener('pointerdown', () => busy = true);
  el.addEventListener('pointerup', () => busy = false);
  return { el, set: v => { if (busy || Math.abs(v - cur) < 1e-6) return; const from = toN(cur), to = toN(v); tween(from, to, 160, n => { cur = fromN(n); draw(); }, () => { cur = v; draw(); }); }, get: () => cur };
}

// --- Fader (dB)
function Fader({ value = 0, height = 180, onChange }) {
  const cap = h('div', { class: 'cap' });
  const ticks = h('div', { class: 'ticks' });
  for (const d of [10, 0, -10, -20, -30, -40, -60]) ticks.append(h('i', { class: d === 0 ? 'z' : '', style: `top:${(1 - dbToPos(d)) * 100}%` }));
  const el = h('div', { class: 'fader' }, h('div', { class: 'track' }), ticks, cap);
  let cur = value;
  const place = () => { cap.style.top = `calc(8px + (100% - 16px) * ${1 - dbToPos(cur)})`; };
  const set = (v, emit) => { cur = Math.round(v * 10) / 10; place(); if (emit) onChange && onChange(cur); };
  drag(el, {
    start: e => {
      const rect = el.getBoundingClientRect();
      const capRect = cap.getBoundingClientRect();
      // jump to click unless grabbing the cap
      if (e.clientY < capRect.top - 4 || e.clientY > capRect.bottom + 4) {
        set(posToDb(1 - (e.clientY - rect.top - 8) / (rect.height - 16)), true);
      }
      return { p: dbToPos(cur), hgt: rect.height - 16 };
    },
    move: (e, dx, dy, c) => set(posToDb(c.p - dy / c.hgt * (e.shiftKey ? 0.2 : 1)), true),
  });
  el.addEventListener('dblclick', () => set(0, true));
  el.addEventListener('wheel', e => { e.preventDefault(); set(posToDb(dbToPos(cur) - Math.sign(e.deltaY) * 0.01), true); }, { passive: false });
  place();
  let dragging = false;
  el.addEventListener('pointerdown', () => { dragging = true; el.classList.add('drag'); });
  const rel = () => { dragging = false; el.classList.remove('drag'); };
  el.addEventListener('pointerup', rel); el.addEventListener('pointercancel', rel);
  return { el, set: v => { if (!dragging) { el.classList.add('glide'); set(v, false); clearTimeout(el._g); el._g = setTimeout(() => el.classList.remove('glide'), 260); } }, get: () => cur };
}

// --- Meter (peak with hold). One shared animation loop gives smooth
// broadcast-style ballistics: instant rise, eased fall, peak hold.
const _meters = new Set();
let _mLast = performance.now();
function _meterLoop(now) {
  const dt = Math.min(0.1, (now - _mLast) / 1000); _mLast = now;
  for (const m of _meters) m._tick(dt, now);
  requestAnimationFrame(_meterLoop);
}
requestAnimationFrame(_meterLoop);
function Meter() {
  const bar = h('i'), hold = h('b');
  const el = h('div', { class: 'meter' }, bar, hold);
  let target = 0, cur = 0, hv = 0, ht = 0, shown = -1, shownH = -1;
  const api = {
    el,
    set(lin) { target = meterPos(lin); },
    size() { el.style.setProperty('--h', el.clientHeight + 'px'); },
    _tick(dt, now) {
      if (!el.isConnected) { _meters.delete(api); return; }
      cur = target >= cur ? target : Math.max(target, cur - dt * 0.36); // ~24 dB/s fall over a 66 dB scale
      if (cur >= hv || now - ht > 1600) { hv = Math.max(cur, hv - dt * 0.5); if (cur >= hv) ht = now; }
      if (Math.abs(cur - shown) > 0.002) { bar.style.clipPath = `inset(${((1 - cur) * 100).toFixed(2)}% 0 0 0)`; shown = cur; }
      if (Math.abs(hv - shownH) > 0.002) {
        hold.style.transform = `translateY(${-hv * el.clientHeight}px)`;
        hold.style.opacity = hv > 0.01 ? 1 : 0;
        hold.style.background = hv > 0.9 ? 'var(--red)' : 'var(--yellow)';
        shownH = hv;
      }
    },
  };
  _meters.add(api);
  return api;
}

// smooth numeric tween used when another device changes a control
function tween(from, to, ms, step, done) {
  const t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  const f = now => {
    const t = Math.min(1, (now - t0) / ms);
    step(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(f); else done && done();
  };
  requestAnimationFrame(f);
}

// --- EQ math (RBJ, mirrors stobite/dsp.py)
function biquad(kind, f, g, q, fs) {
  f = clamp(f, 10, fs * 0.49); q = Math.max(q, 0.05);
  const w0 = 2 * Math.PI * f / fs, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q), A = Math.pow(10, g / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'bell') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else if (kind === 'lowshelf') { const sa = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa); a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; }
  else if (kind === 'highshelf') { const sa = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa); a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; }
  else if (kind === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (kind === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (kind === 'notch') { b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else return null;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function biquadMag(c, f, fs) {
  const w = 2 * Math.PI * f / fs, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * cw + c[2] * c2, ni = -(c[1] * sw + c[2] * s2);
  const dr = 1 + c[3] * cw + c[4] * c2, di = -(c[3] * sw + c[4] * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}
const BW_QS = { 12: [0.7071], 24: [0.5412, 1.3066], 48: [0.5098, 0.6013, 0.9, 2.5629] };
const cutSecs = (kind, f, slope, fs) => (BW_QS[slope] || BW_QS[24]).map(q => biquad(kind, f, 0, q, fs));
function stripSections(s, fs) {
  const out = [];
  if (s.hpf && s.hpf.on) out.push(...cutSecs('hp', s.hpf.freq, s.hpf.slope || 24, fs));
  if (s.lpf && s.lpf.on) out.push(...cutSecs('lp', s.lpf.freq, s.lpf.slope || 12, fs));
  if (s.eq && s.eq.on !== false) for (const b of s.eq.bands) {
    if (b.on === false) continue;
    if (b.type === 'hp' || b.type === 'lp') out.push(...cutSecs(b.type, b.freq, b.slope || 12, fs));
    else if (Math.abs(b.gain) > 0.01 || b.type === 'notch') out.push(biquad(b.type, b.freq, b.gain, b.q, fs));
  }
  return out.filter(Boolean);
}
function responseDb(secs, f, fs) { let m = 1; for (const c of secs) m *= biquadMag(c, f, fs); return 20 * Math.log10(Math.max(m, 1e-6)); }
const BAND_COLORS = ['#ff7a45', '#ffd23f', '#3ecf6e', '#3aa0ff'];

function drawEqCurve(canvas, strip, fs, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const range = opts.range || 18;
  const fx = f => Math.log(f / 20) / Math.log(1000) * W;
  const gy = d => H / 2 - d / range * (H / 2 - 4);
  if (opts.grid) {
    g.strokeStyle = '#1f2328'; g.lineWidth = 1; g.fillStyle = '#4b515a'; g.font = '10px system-ui';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(fx(f)) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(fmt.hz(f), x + 2, H - 3); }
    for (const d of [-12, -6, 6, 12]) { const y = Math.round(gy(d)) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText((d > 0 ? '+' : '') + d, 2, y - 2); }
    g.strokeStyle = '#2c3036'; g.beginPath(); g.moveTo(0, Math.round(gy(0)) + .5); g.lineTo(W, Math.round(gy(0)) + .5); g.stroke();
  }
  if (opts.spectrum) {  // live analyser behind the curve
    const sp = opts.spectrum, n = sp.length;
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < n; i++) { const x = (i + 0.5) / n * W, y = clamp((1 - (sp[i] + 84) / 84) * H, 0, H); g.lineTo(x, y); }
    g.lineTo(W, H); g.closePath();
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(58,160,255,.35)'); gr.addColorStop(1, 'rgba(58,160,255,.04)');
    g.fillStyle = gr; g.fill();
  }
  const secs = stripSections(strip, fs);
  const on = strip.eq?.on !== false || strip.hpf?.on || strip.lpf?.on;
  g.beginPath();
  for (let x = 0; x <= W; x += 2) { const f = 20 * Math.pow(1000, x / W); const y = gy(clamp(responseDb(secs, f, fs), -range * 1.5, range * 1.5)); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = on ? (opts.color || '#f76b15') : '#555'; g.lineWidth = opts.grid ? 2 : 1.4; g.stroke();
  g.lineTo(W, gy(0)); g.lineTo(0, gy(0)); g.closePath(); g.fillStyle = on ? 'rgba(247,107,21,.12)' : 'rgba(255,255,255,.04)'; g.fill();
  if (opts.nodes) {
    strip.eq.bands.forEach((b, i) => {
      const x = fx(b.freq), y = gy(['notch', 'hp', 'lp'].includes(b.type) ? 0 : b.gain);
      g.beginPath(); g.arc(x, y, i === opts.active ? 9 : 7, 0, Math.PI * 2);
      g.fillStyle = b.on === false ? '#444' : BAND_COLORS[i]; g.fill();
      g.fillStyle = '#000'; g.font = 'bold 10px system-ui'; g.textAlign = 'center'; g.fillText(i + 1, x, y + 3.5); g.textAlign = 'start';
    });
    if (strip.hpf?.on) { const x = fx(strip.hpf.freq); g.fillStyle = '#ccc'; g.beginPath(); g.arc(x, gy(-3), 5, 0, Math.PI * 2); g.fill(); }
  }
  return { fx, gy, W, H, range };
}
