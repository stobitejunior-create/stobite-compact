// Core: connection, shared state, transport, views, shortcuts.
const S = { info: null, mixer: null, session: null, tr: { playing: false, recording: false, playhead: 0 }, wing: {}, meters: null, view: 'edit' };
const bus = {};
const on = (ev, fn) => (bus[ev] = bus[ev] || []).push(fn);
const emit = (ev, d) => (bus[ev] || []).forEach(fn => { try { fn(d); } catch (e) { console.error(e); } });

let ws, wsOpen = false;
const pending = new Map();
let flushQueued = false;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { wsOpen = true; $('#netDot').className = 'dot ok'; };
  ws.onclose = () => { wsOpen = false; $('#netDot').className = 'dot bad'; setTimeout(connect, 1000); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'hello':
        S.info = m.info; S.mixer = m.mixer; S.session = m.session; S.tr = m.transport; S.wing = m.wing || {};
        emit('info'); emit('mixer'); emit('session'); emit('transport'); emit('wing');
        break;
      case 'm': S.meters = m; S.tr.playhead = m.ph; S.tr.playing = m.pl; S.tr.recording = m.rc; emit('meters', m); break;
      case 'set': applyPath(S.mixer, m.path, m.v); emit('set', m.path); break;
      case 'mixer': S.mixer = m.mixer; emit('mixer'); break;
      case 'session': S.session = m.session; emit('session'); break;
      case 'transport': Object.assign(S.tr, m); emit('transport'); break;
      case 'info': S.info = m.info; emit('info'); break;
      case 'export': emit('export', m.job); break;
      case 'wing': S.wing[m.addr] = m.v; emit('wingval', m); break;
      case 'assist': emit('assist', m); break;
      case 'valign': emit('valign', m); break;
      case 'loading': emit('loading', m); break;
      case 'compare': S.compare = m.on; S.compareMatch = m.match; emit('compare'); break;
      case 'error': toast(m.msg, true); break;
      case 'toast': toast(m.msg, false, m.long ? 9000 : 0); break;
    }
  };
}
const send = m => wsOpen && ws.send(JSON.stringify(m));

function applyPath(obj, path, v) {
  let n = obj;
  for (let i = 0; i < path.length - 1; i++) n = n[path[i]];
  n[path[path.length - 1]] = v;
}
const getPath = (obj, path) => path.reduce((n, k) => n?.[k], obj);

// Mixer parameter change: update locally, coalesce sends to one per frame per path.
const LINKED = new Set(['chain', 'sends', 'trim', 'fader', 'mute', 'solo', 'bypass', 'out', 'pan', 'type', 'icon', 'color']);
const freshIds = c => JSON.parse(JSON.stringify(c)).map(m => ({ ...m, id: 'm' + Math.random().toString(36).slice(2, 9) }));
function linkedTwin(path, v) {
  if (path[0] !== 'channels') return null;
  const c = +path[1], p = S.mixer?.channels?.[c]?.link;
  if (!Number.isInteger(p) || !S.mixer.channels[p] || !LINKED.has(path[2])) return null;
  if (path.length === 3 && path[2] === 'pan') return [['channels', p, 'pan'], -v];
  if (path.length === 3 && path[2] === 'chain') return [['channels', p, 'chain'], freshIds(v)];
  if (path[2] === 'chain' && path.length > 3) {   // a setting inside the chain: same module on the other side
    const mine = S.mixer.channels[c].chain?.[+path[3]], theirs = S.mixer.channels[p].chain?.[+path[3]];
    if (!mine || !theirs || mine.type !== theirs.type) return null;
  }
  return [['channels', p, ...path.slice(2)], JSON.parse(JSON.stringify(v ?? null))];
}
function setParam(path, v, fromTwin) {
  if (!fromTwin) { const tw = linkedTwin(path, v); if (tw) setTimeout(() => setParam(tw[0], tw[1], true)); }
  if (S.info?.locked) { toast('The mix is locked for the service. Unlock it with the padlock at the top.', true); return; }
  applyPath(S.mixer, path, v);
  pending.set(path.join('/'), { path, v });
  if (!flushQueued) {
    flushQueued = true;
    // a short timer (not requestAnimationFrame) so changes still go out from a background tab or a dimmed phone
    setTimeout(() => {
      flushQueued = false;
      for (const { path, v } of pending.values()) send({ t: 'set', path, v });
      pending.clear();
    }, 16);
  }
  emit('set', path);
}

// ---- theme: Auto (follow the computer) / Light / Dark. Canvases read their colours from CSS.
window.CV = {};
const CV_KEYS = { bg: 'bg', row1: 'row1', row2: 'row2', sep: 'sep', grid: 'grid', ruler: 'ruler', ruleLine: 'rule-line', text: 'text',
  label: 'label', wave: 'wave', waveSel: 'wave-sel', muted: 'muted', tick: 'tick', lane: 'lane' };
function readCV() { const cs = getComputedStyle(document.documentElement); for (const [k, v] of Object.entries(CV_KEYS)) CV[k] = cs.getPropertyValue('--cv-' + v).trim(); }
window.applyTheme = (t) => {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  try { localStorage.setItem('stobite.theme', t || 'auto'); } catch (e) { /* storage off */ }
  readCV();
  const dark = getComputedStyle(root).colorScheme.includes('dark');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0e0f11' : '#f3f4f6');
  emit('theme');
};
on('theme', () => { if (S.mixer) emit('mixer'); });   // strips redraw their EQ thumbnails
try { applyTheme(localStorage.getItem('stobite.theme') || 'auto'); } catch (e) { applyTheme('auto'); }
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(document.documentElement.dataset.theme || 'auto'));

// A–Z with numbers in order ("USB 2" before "USB 10"); the first `pinned` entries (None, Auto…) stay on top.
const abc = (a, b) => String(a).replace(/^[^\p{L}\p{N}]+/u, '').localeCompare(String(b).replace(/^[^\p{L}\p{N}]+/u, ''), undefined, { numeric: true, sensitivity: 'base' });
window.sortOpts = (opts, pinned = 0) => [...opts.slice(0, pinned), ...opts.slice(pinned).sort((x, y) => abc(x[1], y[1]))];
window.sortDevices = list => [...list].sort((x, y) => abc(x.name, y.name) || abc(x.api, y.api));

async function api(name, body, query = '') {
  const opts = body instanceof FormData ? { method: 'POST', body } : body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch('/api/' + name + query, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const tryApi = async (...a) => { try { return await api(...a); } catch (e) { toast(e.message, true); throw e; } };

function toast(msg, err, ms) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' error' : ''); t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, ms || (err ? 5000 : 2200));
}

function modal(build) {
  const m = $('#modal'), card = $('#modalCard');
  card.innerHTML = '';
  const close = () => { m.hidden = true; card.innerHTML = ''; };
  build(card, close);
  m.hidden = false;
  m.onclick = e => { if (e.target === m) close(); };
  return close;
}

// ------------------------------------------------------------ time
const sr = () => S.session?.sr || S.info?.sr || 48000;
function tc(samples) {
  const t = Math.max(0, samples / sr());
  const hh = Math.floor(t / 3600), mm = Math.floor(t / 60) % 60, ss = Math.floor(t) % 60, ms = Math.floor((t % 1) * 1000);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ------------------------------------------------------------ transport
const tr = (a, extra = {}) => {
  // moving the playhead mid-take would cut the recording short: say so instead
  if (a === 'locate' && (S.tr?.recording || S.tr?.counting)) return toast('Recording: stop first to move the playhead');
  send({ t: 'transport', a, ...extra });
};
$('#btnPlay').onclick = () => tr('toggle');
$('#btnStop').onclick = () => S.tr.playing || S.tr.recording ? tr('stop') : tr('locate', { pos: 0 });
$('#btnRec').onclick = () => {
  if (S.tr.recording) return tr('stop');
  const n = S.session.armed.filter(Boolean).length;
  if (!n) return toast('No channels armed — use "Arm all" in the Edit view', true);
  // enough disk for the service? (under 10 minutes the engine refuses on its own)
  api('rec-check').then(c => {
    const h = Math.floor(c.seconds / 3600), m = Math.floor(c.seconds / 60) % 60;
    if (c.seconds < 3 * 3600 && c.seconds >= 600 &&
        !confirm(`Only ${h ? h + ' h ' : ''}${m} min of recording space left for ${c.armed} channel${c.armed > 1 ? 's' : ''} (${c.gbPerHour} GB per hour).\n\nRecord anyway?`)) return;
    tr('record');
  }).catch(() => tr('record'));
};
$('#btnHome').onclick = () => tr('locate', { pos: 0 });
$('#btnBack').onclick = () => tr('locate', { pos: Math.max(0, S.tr.playhead - 5 * sr()) });
$('#btnFwd').onclick = () => tr('locate', { pos: S.tr.playhead + 5 * sr() });
$('#btnLoop').onclick = () => window.toggleLoop && toggleLoop();

// Automation mode button: Off -> Read -> Touch. Touch records your moves while playing.
const AUTO_MODES = ['off', 'read', 'touch'];
const autoBtns = new Map();
function autoMode(target) {
  const m = S.session?.automode?.[target];
  if (m) return m;
  const prefix = target === 'master' ? 'master:' : `ch:${target}:`;
  return Object.keys(S.session?.automation || {}).some(k => k.startsWith(prefix)) ? 'read' : 'off';
}
function paintAuto(b, target) {
  const m = autoMode(target);
  b.className = 'tog auto ' + m; b.textContent = m === 'touch' ? 'T' : m === 'read' ? 'A' : 'A';
  b.title = { off: 'Automation off (click: Read)', read: 'Automation: Read — plays back your moves (click: Touch)', touch: 'Automation: Touch — records fader/pan/mute moves while playing (click: Off)' }[m];
}
function autoModeButton(target) {
  const b = h('button', { onclick: () => {
    const next = AUTO_MODES[(AUTO_MODES.indexOf(autoMode(target)) + 1) % 3];
    S.session.automode = { ...(S.session.automode || {}), [target]: next };
    paintAuto(b, target);
    send({ t: 'edit', op: 'automode', args: { target, mode: next } });
    if (next === 'touch') toast('Touch: press play and move the fader — your moves are recorded');
  } });
  paintAuto(b, target);
  b.addEventListener('repaint', () => paintAuto(b, target));
  return b;
}

// swap data-ic placeholders for SVG icons (keeps any text label after the icon)
function applyIcons(root = document) {
  $$('[data-ic]', root).forEach(el => { if (!el.querySelector(':scope > .ic')) el.prepend(icon(el.dataset.ic, el.classList.contains('tbtn') ? 18 : 16)); });
}
applyIcons();
let playIcon = 'play';
function renderTransport() {
  $('#btnPlay').classList.toggle('on', S.tr.playing);
  const want = S.tr.playing ? 'pause' : 'play';
  if (want !== playIcon) { playIcon = want; $('#btnPlay').innerHTML = ''; $('#btnPlay').append(icon(want, 18)); }
  $('#btnRec').classList.toggle('on', S.tr.recording);
  const c = $('#clock');
  c.textContent = tc(S.tr.playhead);
  c.classList.toggle('rec', S.tr.recording);
}
on('transport', renderTransport);
on('meters', m => {
  renderTransport();
  $('#cpu').textContent = m.zz ? 'Idle' : 'CPU ' + Math.round(m.ld * 100) + '%';
  $('#cpu').title = m.zz ? 'Nothing is playing and all inputs are silent, so the audio engine is resting. It wakes instantly when sound arrives.' : 'Audio engine load (share of each audio block spent processing)';
  $('#cpu').style.color = m.ld > 0.8 ? 'var(--red)' : m.ld > 0.5 ? 'var(--yellow)' : '';
  if (m.dr) $('#cpu').title = `${m.dr} recording blocks dropped (disk too slow)`;
});
on('info', () => {
  const i = S.info;
  const want = i.cfg.theme || 'auto';
  if (want !== (document.documentElement.dataset.theme || 'auto')) applyTheme(want);
  $('#tabWing').hidden = !i.cfg.show_wing;
  if (!i.cfg.show_wing && S.view === 'console') showView('mixer');
  $('#audioDot').className = 'dot ' + (i.status === 'running' ? 'ok' : i.status === 'starting' ? 'wait' : 'bad');
  if (i.status === 'starting') toast('Starting audio… if macOS asks for microphone access, click Allow — that is how it hears the WING.');
  $('#fbBanner').hidden = !i.feedback;
  $('#fbText').textContent = (i.feedback || '').replace(/^Feedback stopped: /, '');
  $('#audioDot').title = i.status === 'running' ? `Audio running: in ${i.inName} (${i.devIns} ch), out ${i.outName}` : 'Audio: ' + (i.error || i.status);
});
$('#fbUnmute').onclick = async () => { await tryApi('feedback-reset', {}); S.info = await api('info'); emit('info'); toast('Sound back on. If it screeches again, fix the WING routing first.'); };
on('session', () => { $('#sessName').textContent = S.session.name; $('#sessName').classList.toggle('none', !!S.session.scratch); });

// ------------------------------------------------------------ views
const tabInd = h('span', { class: 'ind' });
$('#tabs').prepend(tabInd);
function moveTabInd() {
  const b = $(`#tabs button[data-view="${S.view}"]`);
  tabInd.style.opacity = b ? 1 : 0;
  if (!b) return;
  tabInd.style.width = b.offsetWidth + 'px';
  tabInd.style.transform = `translateX(${b.offsetLeft}px)`;
}
window.addEventListener('resize', moveTabInd);
new ResizeObserver(moveTabInd).observe(document.querySelector('#tabs'));
function showView(v) {
  S.view = v;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  moveTabInd(); requestAnimationFrame(moveTabInd);
  $$('.view').forEach(el => el.classList.toggle('on', el.id === 'view-' + v));
  try { localStorage.setItem('stobite.view', v); } catch (e) { }
  emit('view', v);
}
$$('#tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));
window.CATALOG = null;
fetch('/api/catalog').then(r => r.json()).then(c => { window.CATALOG = c; emit('catalog'); });

// ------------------------------------------------------------ keys
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (window.welcomeOpen && welcomeOpen()) return;   // the welcome screen has its own keys
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { e.preventDefault(); tr('toggle'); }
  else if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const mixerView = S.view === 'mixer' || S.view === 'master' || !$('#editor').hidden;
    send({ t: mixerView ? (e.shiftKey ? 'mixredo' : 'mixundo') : (e.shiftKey ? 'redo' : 'undo') });
  }
  else if (!mod && e.key.toLowerCase() === 'l') toggleLoop();
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); api('save', {}).then(() => toast('Saved')); }
  else if (e.key === 'Home' || e.key === 'Enter') tr('locate', { pos: 0 });
  else if (e.key === ',') $('#btnBack').click();
  else if (e.key === '.') $('#btnFwd').click();
  else if (!mod && e.key.toLowerCase() === 'r' && !e.repeat) $('#btnRec').click();
  else if (e.key === 'Escape') { $('#editor').hidden = true; $('#modal').hidden = true; }
  else emit('key', e);
});

// Scrolling over a focused number box must not change it (Windows/Chrome does that)
document.addEventListener('wheel', e => { if (e.target.matches?.('input[type=number]') && document.activeElement === e.target) e.target.blur(); }, { passive: true });

// Buttons shouldn't keep focus, or Space would click them as well as toggling play.
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });

window.addEventListener('load', () => {
  // the app opens on the welcome screen (like Logic); a phone remote opens straight on the mixer
  showView(innerWidth < 760 ? 'mixer' : 'edit');
  if (innerWidth >= 760) showWelcome(false);
  connect();
});
