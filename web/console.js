// Remote control of the WING console itself (OSC over the network).
(() => {
  const BANKS = { ch: 40, aux: 8, bus: 16, main: 4 };
  let bank = 'ch', ctl = new Map(), timer = null;

  function build() {
    const box = $('#wingStrips'); box.innerHTML = ''; ctl.clear();
    for (let n = 1; n <= BANKS[bank]; n++) {
      const base = `/${bank}/${n}`;
      const name = h('div', { class: 'sname' }, S.wing[base + '/name'] || `${bank.toUpperCase()} ${n}`);
      const db = h('div', { class: 'db' }, fmt.db(S.wing[base + '/fdr'] ?? -90));
      const fader = Fader({ value: S.wing[base + '/fdr'] ?? -90, onChange: v => { send({ t: 'wing', a: 'set', addr: base + '/fdr', v }); db.textContent = fmt.db(v); } });
      const mute = h('button', { class: 'tog m' + (S.wing[base + '/mute'] ? ' on' : ''), onclick: () => { const v = S.wing[base + '/mute'] ? 0 : 1; S.wing[base + '/mute'] = v; mute.classList.toggle('on', !!v); send({ t: 'wing', a: 'set', addr: base + '/mute', v }); } }, 'MUTE');
      box.append(h('div', { class: 'wstrip' }, name, mute, h('div', { class: 'fz' }, fader.el), db));
      ctl.set(base + '/fdr', v => { fader.set(v); db.textContent = fmt.db(v); });
      ctl.set(base + '/mute', v => mute.classList.toggle('on', !!v));
      ctl.set(base + '/name', v => name.textContent = v || `${bank.toUpperCase()} ${n}`);
    }
    query();
  }
  function query() {
    if (!S.info?.wing?.ip) return;
    const addrs = [];
    for (let n = 1; n <= BANKS[bank]; n++) addrs.push(`/${bank}/${n}/fdr`, `/${bank}/${n}/mute`, `/${bank}/${n}/name`);
    send({ t: 'wing', a: 'query', addrs });
  }
  on('wingval', m => { const f = ctl.get(m.addr); if (f) f(m.v); });
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
