// Setup page: audio devices, routing, remote access, sessions, cable guide.
(() => {
  let devices = [];
  async function render() {
    if (!S.info) return;
    const i = S.info, c = i.cfg;
    try { devices = await api('devices'); } catch (e) { }
    const box = $('#setup'); box.innerHTML = '';
    const devName = d => `${d.name} (${d.api})`;
    const sel = (kind) => {
      const key = kind === 'input' ? 'ins' : 'outs';
      const s = h('select', {}, kind === 'input' ? h('option', { value: '' }, 'Auto (finds the WING)') : h('option', { value: '' }, 'Auto'));
      for (const d of devices.filter(d => d[key] > 0)) s.append(h('option', { value: devName(d), selected: c[kind] === devName(d) || c[kind] === d.name }, `${d.wing ? '★ ' : ''}${d.name} — ${d[key]} ch (${d.api})`));
      s.onchange = () => save({ [kind]: s.value || null });
      return s;
    };
    const num = (k, opts) => { const s = h('select', { onchange: e => save({ [k]: isNaN(+e.target.value) ? e.target.value : +e.target.value }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: c[k] == v }, l))); return s; };
    const outs = Math.max(i.devOuts, 2);
    const outOpts = [...Array(outs).keys()].map(n => [n, 'Output ' + (n + 1)]);
    const wingFound = devices.some(d => d.wing && d.ins > 0);

    const statusLine = i.status === 'running'
      ? h('p', { class: 'ok' }, `● Running · in: ${i.inName} (${i.devIns} ch) · out: ${i.outName} (${i.devOuts} ch) · ${i.sr} Hz`)
      : h('p', { class: 'err' }, '● Audio stopped: ' + (i.error || 'not started'));

    box.append(
      h('div', { class: 'card' }, h('h3', {}, 'Audio interface'), statusLine,
        wingFound ? h('p', { class: 'ok' }, '★ WING detected over USB') : h('p', { class: 'hint' }, 'WING not detected — see “Connecting the WING Compact” below.'),
        h('div', { class: 'f' }, h('span', {}, 'Input (record from)'), sel('input')),
        h('div', { class: 'f' }, h('span', {}, 'Output (listen on)'), sel('output')),
        h('div', { class: 'f' }, h('span', {}, 'Sample rate'), num('sr', [[44100, '44.1 kHz'], [48000, '48 kHz (WING default)'], [96000, '96 kHz']])),
        h('div', { class: 'f' }, h('span', {}, 'Buffer'), num('block', [[64, '64 — lowest latency'], [128, '128'], [256, '256 — recommended'], [512, '512 — safest'], [1024, '1024']])),
        h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, h('button', { class: 'btn', onclick: async () => { await tryApi('audio-restart', {}); S.info = await api('info'); emit('info'); } }, 'Restart audio'))),

      h('div', { class: 'card' }, h('h3', {}, 'Routing'),
        h('div', { class: 'f' }, h('span', {}, 'Main mix left'), num('main_l', outOpts)),
        h('div', { class: 'f' }, h('span', {}, 'Main mix right'), num('main_r', outOpts)),
        h('label', { class: 'chk', style: 'margin:8px 0' }, h('input', { type: 'checkbox', checked: c.monitor_live, onchange: e => save({ monitor_live: e.target.checked }) }), 'Live monitoring — hear the inputs through the mixer when not playing back'),
        h('label', { class: 'chk', style: 'margin:8px 0' }, h('input', { type: 'checkbox', checked: c.direct_outs, onchange: e => save({ direct_outs: e.target.checked }) }), 'Send each processed channel back to the WING (USB returns)'),
        h('div', { class: 'f' }, h('span', {}, 'Returns start at'), num('direct_offset', outOpts)),
        h('p', { class: 'hint' }, 'Returns let the WING use this computer\'s EQ/compression on the live sound (set WING channel sources to USB). This adds a few milliseconds of delay; for normal live mixing use the WING tab instead, which has none.')),

      h('div', { class: 'card' }, h('h3', {}, 'Remote control from your phone'),
        h('p', {}, 'On any phone, tablet or laptop on the same Wi-Fi, open:'),
        ...(i.urls.length ? i.urls.map(u => h('span', { class: 'url' }, u)) : [h('p', { class: 'err' }, 'This computer has no network address — connect it to the Wi-Fi.')]),
        h('p', { class: 'hint' }, 'Walk into the room or outside with your phone, make changes, and they apply immediately. Everyone connected stays in sync.'),
        h('div', { class: 'f' }, h('span', {}, 'Remote PIN'), h('input', { type: 'password', placeholder: i.hasPin ? '•••• (set — type to change)' : 'none — anyone on the Wi-Fi can connect', onchange: e => save({ pin: e.target.value }) })),
        h('p', { class: 'hint' }, 'If your church Wi-Fi is open to guests, set a PIN. This computer never needs it.')),

      sessionsCard(i),

      h('div', { class: 'card' }, h('h3', {}, 'Connecting the WING Compact'),
        h('ol', {},
          h('li', {}, h('b', {}, 'Cable: one USB cable, USB-A (or USB-C) to USB-B'), ' — the square "printer" type. Plug the B end into the ', h('b', {}, 'USB port on the back panel of the WING Compact'), ' (the audio interface port — not the front USB-A socket, which is for USB sticks). That one cable carries ', h('b', {}, '48 channels in and 48 out'), ' at 48 kHz.'),
          h('li', {}, h('b', {}, 'Mac:'), ' nothing to install — the WING shows up as a 48-channel audio device.'),
          h('li', {}, h('b', {}, 'Windows:'), ' install the ', h('b', {}, 'WING USB / ASIO driver'), ' from behringer.com (WING Compact → Downloads), then restart this app. Choose the device marked “ASIO”.'),
          h('li', {}, 'On the WING: open ', h('b', {}, 'ROUTING → Outputs → USB'), '. Set USB outputs 1–40 (or 1–48) to come from the channel ', h('b', {}, 'direct outs'), ' (use "pre-fader"/"input" so recordings are clean and unaffected by the live faders).'),
          h('li', {}, 'Keep cable length under 5 m (or use a powered USB hub / active extension).'),
          h('li', {}, h('b', {}, 'For the WING tab (remote faders):'), ' connect the WING\'s ', h('b', {}, 'Ethernet'), ' port to the same router as this computer and phone.')),
        h('p', { class: 'hint' }, 'Need more than 48 channels, or a long run? A WING-DANTE card + network cable also works and appears as an audio device the same way (with Dante Virtual Soundcard).')),

      h('div', { class: 'card' }, h('h3', {}, 'Storage'),
        h('p', {}, 'Sessions and recordings are saved in:'), h('span', { class: 'url', style: 'font-size:12px' }, i.home),
        h('p', { class: 'hint' }, 'Recording all 48 channels uses about 25 GB per hour (24-bit WAV). Only armed channels are recorded — disarm unused channels in the Edit view to save space.')),
    );
  }

  function sessionsCard(i) {
    const list = h('div', { class: 'list' });
    for (const s of i.sessions) list.append(h('div', { class: 'li' + (s.name === S.session?.name ? ' cur' : ''), onclick: async () => { if (s.name === S.session?.name) return; await tryApi('session-open', { name: s.name }); toast('Opened ' + s.name); refresh(); } }, s.name, h('span', {}, new Date(s.modified * 1000).toLocaleString())));
    const name = h('input', { placeholder: 'New session name e.g. Sunday 5 Oct', style: 'flex:1' });
    return h('div', { class: 'card' }, h('h3', {}, 'Sessions'),
      h('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, name, h('button', { class: 'btn accent', onclick: async () => { await tryApi('session-new', { name: name.value }); toast('New session created'); refresh(); } }, 'New')),
      list,
      ['localhost', '127.0.0.1'].includes(location.hostname) ? h('button', { class: 'btn', style: 'margin-top:8px', onclick: () => api('reveal') }, 'Show session folder') : null);
  }

  async function save(patch) {
    const r = await tryApi('config', patch);
    S.info = r; emit('info');
    toast('Saved');
  }
  async function refresh() { S.info = await api('info'); emit('info'); }
  on('info', () => { if (S.view === 'setup') render(); });
  on('view', v => v === 'setup' && refresh());
})();
