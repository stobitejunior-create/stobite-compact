// Remote control of the WING console itself (OSC over the network).
(() => {
  const BANKS = { ch: 40, aux: 8, bus: 16, main: 4 };
  let bank = 'ch', ctl = new Map(), timer = null;
  // Did the WING take the change? It answers reads even when its OSC Remote Lock throws writes away,
  // so compare what we asked for with what it reports back shortly after.
  const pending = new Map();
  const lockNote = h('div', { class: 'wing-lock', hidden: true },
    h('b', {}, 'The WING is ignoring changes from this app. '),
    'It reads fine, but its ', h('b', {}, 'OSC Remote Lock'), ' is on, so every change is thrown away and the fader snaps back. ',
    'To allow control, on the WING press ', h('b', {}, 'SETUP → REMOTE'), ' and turn ', h('b', {}, 'Remote Lock (OSC)'), ' off. ',
    'Leave it on if you want the console protected: this app never needs it for recording or the broadcast mix.');
  $('#wingStrips').before(lockNote);
  function sent(addr, v) {
    pending.set(addr, { v, t: performance.now() });
    clearTimeout(sent.timer);
    sent.timer = setTimeout(() => send({ t: 'wing', a: 'query', addrs: [...pending.keys()] }), 700);
  }
  function checkBack(addr, val) {
    const p = pending.get(addr);
    if (!p || performance.now() - p.t < 300) return;
    pending.delete(addr);
    const same = addr.endsWith('/fdr') ? (Math.abs(val - p.v) < 0.5 || (val <= -89 && p.v <= -89))
      : addr.endsWith('/$g') ? Math.abs(val - p.v) < 1.5 : (!!val === !!p.v);
    lockNote.hidden = same;
  }

  function build() {
    const box = $('#wingStrips'); box.innerHTML = ''; ctl.clear();
    for (let n = 1; n <= BANKS[bank]; n++) {
      const base = `/${bank}/${n}`;
      const name = h('div', { class: 'sname' }, S.wing[base + '/name'] || `${bank.toUpperCase()} ${n}`);
      const db = h('div', { class: 'db' }, fmt.db(S.wing[base + '/fdr'] ?? -90));
      const fader = Fader({ value: S.wing[base + '/fdr'] ?? -90, onChange: v => { send({ t: 'wing', a: 'set', addr: base + '/fdr', v }); sent(base + '/fdr', v); db.textContent = fmt.db(v); } });
      const mute = h('button', { class: 'tog m' + (S.wing[base + '/mute'] ? ' on' : ''), onclick: () => { const v = S.wing[base + '/mute'] ? 0 : 1; S.wing[base + '/mute'] = v; mute.classList.toggle('on', !!v); send({ t: 'wing', a: 'set', addr: base + '/mute', v }); sent(base + '/mute', v); } }, 'MUTE');
      // the WING's own preamp gain (the mic's headamp), on input channels. Shown once the console
      // reports it, so a firmware that names it differently doesn't get a dead knob.
      let gainEl = null;
      if (bank === 'ch') {
        const ga = base + '/in/set/$g';
        const gk = Knob({ label: 'Gain', min: -3, max: 45.5, value: S.wing[ga] ?? 0, def: 0, step: 0.5, size: 30, format: fmt.db, color: '#ffd23f',
          onChange: v => { send({ t: 'wing', a: 'set', addr: ga, v }); sent(ga, v); } });
        gainEl = h('div', { class: 'cen', title: 'Preamp gain on the WING (the mic input itself)', hidden: S.wing[ga] == null }, gk.el);
        ctl.set(ga, v => { gainEl.hidden = false; gk.set(v); });
      }
      box.append(h('div', { class: 'wstrip' }, name, gainEl, mute, h('div', { class: 'fz' }, fader.el), db));
      ctl.set(base + '/fdr', v => { fader.set(v); db.textContent = fmt.db(v); });
      ctl.set(base + '/mute', v => mute.classList.toggle('on', !!v));
      ctl.set(base + '/name', v => name.textContent = v || `${bank.toUpperCase()} ${n}`);
    }
    query();
  }
  function query() {
    if (!S.info?.wing?.ip) return;
    const addrs = [];
    for (let n = 1; n <= BANKS[bank]; n++) addrs.push(`/${bank}/${n}/fdr`, `/${bank}/${n}/mute`, `/${bank}/${n}/name`, ...(bank === 'ch' ? [`/ch/${n}/in/set/$g`] : []));
    send({ t: 'wing', a: 'query', addrs });
  }
  on('wingval', m => { checkBack(m.addr, m.v); const f = ctl.get(m.addr); if (f) f(m.v); });
  $$('#wingBank button').forEach(b => b.onclick = () => { bank = b.dataset.bank; $$('#wingBank button').forEach(x => x.classList.toggle('on', x === b)); build(); });
  on('view', v => {
    clearInterval(timer);
    if (v === 'console') { build(); timer = setInterval(query, 4000); }
  });
  on('info', () => {
    const w = S.info.wing || {};
    $('#wingState').innerHTML = w.ip ? (w.connected ? `<span class="ok">● Connected to ${w.ip}</span>` : `Waiting for ${w.ip}…`) : 'Not connected';
    if (w.ip && !$('#wingIp').value) $('#wingIp').value = w.ip;
  });
  $('#wingConnect').onclick = async () => {
    await tryApi('wing-connect', { ip: $('#wingIp').value.trim() });
    S.info = await api('info'); emit('info');
    setTimeout(async () => { S.info = await api('info'); emit('info'); build(); }, 1200);
  };
  $('#wingFind').onclick = async () => {
    $('#wingState').textContent = 'Searching the network…';
    const found = await tryApi('wing-discover', {});
    if (!found.length) { $('#wingState').innerHTML = '<span class="err">No WING found — check it is on the same network (Ethernet port on the back)</span>'; return; }
    $('#wingIp').value = found[0].ip;
    $('#wingState').textContent = `Found ${found[0].name} ${found[0].model} at ${found[0].ip}`;
    $('#wingConnect').click();
  };
})();
