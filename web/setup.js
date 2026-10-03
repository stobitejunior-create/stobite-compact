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
      const s = h('select', {}, kind === 'input' ? h('option', { value: '' }, 'Auto: the WING only (never the computer’s mic)') : h('option', { value: '' }, 'Auto'));
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
        i.devIns && i.inIsWing ? h('p', { class: 'ok' }, `★ WING connected: ${i.devIns} inputs`) :
          i.devIns ? h('p', { class: 'ok' }, `Main inputs: ${i.inName} (${i.devIns})`) :
          h('p', { class: 'warn-line' }, 'No WING connected, so channels set to WING inputs are silent (your computer’s microphone is never used unless you pick it on a channel). Plug in the WING and it connects by itself within a few seconds.'),
        h('div', { class: 'f' }, h('span', {}, 'Input (record from)'), sel('input')),
        h('div', { class: 'f' }, h('span', {}, 'Output (listen on)'), sel('output')),
        h('div', { class: 'f' }, h('span', {}, 'Sample rate'), num('sr', [[44100, '44.1 kHz'], [48000, '48 kHz (WING default)'], [96000, '96 kHz']])),
        h('div', { class: 'f' }, h('span', {}, 'Buffer'), num('block', [[64, '64 — lowest latency'], [128, '128'], [256, '256 — recommended'], [512, '512 — safest with lots of processing'], [1024, '1024']])),
        h('p', { class: 'hint' }, 'If the CPU meter goes red or you hear clicks, raise the buffer to 512.'),
        h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, h('button', { class: 'btn', onclick: async () => { await tryApi('audio-restart', {}); S.info = await api('info'); emit('info'); } }, 'Restart audio'))),

      h('div', { class: 'card' }, h('h3', {}, 'Outputs'),
        h('div', { class: 'f' }, h('span', {}, 'Stream / main L'), num('main_l', outOpts)),
        h('div', { class: 'f' }, h('span', {}, 'Stream / main R'), num('main_r', outOpts)),
        h('div', { class: 'f' }, h('span', {}, 'Monitor L'), num('mon_l', [[-1, 'Same as main'], ...outOpts])),
        h('div', { class: 'f' }, h('span', {}, 'Monitor R'), num('mon_r', [[-1, 'Same as main'], ...outOpts])),
        h('p', { class: 'hint' }, 'Separate monitor (headphone) outputs let you use Mono / Side checks without affecting the stream.'),
        h('label', { class: 'chk', style: 'margin:8px 0' }, h('input', { type: 'checkbox', checked: c.monitor_live, onchange: e => save({ monitor_live: e.target.checked }) }), 'Live monitoring — hear the inputs through the mixer when not playing back'),
        h('label', { class: 'chk', style: 'margin:8px 0' }, h('input', { type: 'checkbox', checked: c.direct_outs, onchange: e => save({ direct_outs: e.target.checked }) }), 'Send each processed channel back to the WING (USB returns)'),
        h('div', { class: 'f' }, h('span', {}, 'Returns start at'), num('direct_offset', outOpts)),
        h('p', { class: 'hint' }, 'Off by default. Only turn this on if you deliberately want the WING to use this computer\'s processing (it adds a few milliseconds of delay). Normally the WING keeps the room, and this app is a separate broadcast mix.')),

      wingChannelsCard(i),
      cablesCard(i, devices),

      h('div', { class: 'card' }, h('h3', {}, 'WING console control (optional)'),
        h('p', {}, 'Stobite Compact never changes your WING. If you ever want to move the WING\'s own faders from a phone, you can turn on the WING tab here.'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!c.show_wing, onchange: e => save({ show_wing: e.target.checked }) }), 'Show the WING tab (remote-controls the console)')),

      h('div', { class: 'card' }, h('h3', {}, 'Phone remote'),
        h('label', { class: 'chk', style: 'margin:4px 0 8px' }, h('input', { type: 'checkbox', checked: !!i.remote, onchange: e => save({ remote: e.target.checked }) }), h('b', {}, 'Let phones and tablets on the Wi-Fi connect')),
        i.remote ? h('p', {}, 'On any phone, tablet or laptop on the same Wi-Fi, open:') : h('p', { class: 'hint' }, 'Off: only this computer can use the app, and nothing on the network can see it. Turn on when you want to mix from your phone.'),
        ...(!i.remote ? [] : i.urls.length ? i.urls.map(u => h('span', { class: 'url' }, u)) : [h('p', { class: 'err' }, 'This computer has no network address — connect it to the Wi-Fi.')]),
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
          h('li', {}, h('b', {}, 'Optional:'), ' connect the WING\'s ', h('b', {}, 'Ethernet'), ' port to your router so this app can read its channel names (read-only).')),
        h('p', { class: 'hint' }, 'Need more than 48 channels, or a long run? A WING-DANTE card + network cable also works and appears as an audio device the same way (with Dante Virtual Soundcard).')),

      h('div', { class: 'card' }, h('h3', {}, 'Storage'),
        h('p', {}, 'Sessions and recordings are saved in:'), h('span', { class: 'url', style: 'font-size:12px' }, i.home),
        h('p', { class: 'hint' }, 'Recording all 48 channels uses about 25 GB per hour (24-bit WAV). Only armed channels are recorded — disarm unused channels in the Edit view to save space.')),
    );
  }

  function wingChannelsCard(i) {
    const ip = h('input', { placeholder: 'WING IP (blank = search)', value: i.cfg.wing_ip || '', style: 'flex:1' });
    const out = h('div', { class: 'hint' });
    return h('div', { class: 'card' }, h('h3', {}, 'Channels from the WING'),
      h('p', {}, 'Every channel arrives raw from the WING (USB 1–48). Make this mixer a mirror of the WING’s layout: names, colours and order. It only ', h('b', {}, 'reads'), ' from the console and never changes it.'),
      h('div', { style: 'display:flex;gap:6px' }, ip, h('button', { class: 'btn accent', onclick: async () => {
        out.textContent = 'Reading channel names from the WING…';
        try {
          const r = await api('wing-names', { ip: ip.value.trim() });
          let n = 0;
          r.channels.forEach((w, k) => {
            const c = S.mixer.channels.findIndex(ch => ch.input === `in:${k}`);
            if (c < 0 || !w.name) return;
            setParam(['channels', c, 'name'], w.name);
            if (typeof w.col === 'number' && WING_COLORS[w.col - 1]) setParam(['channels', c, 'color'], WING_COLORS[w.col - 1]);
            n++;
          });
          out.textContent = `Copied ${n} channel names from the WING at ${r.ip}.`;
        } catch (e) { out.textContent = e.message; }
      } }, 'Copy names from WING')),
      out,
      h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: () => {
          if (!confirm('Set every channel to its matching WING USB input (Ch 1 = USB 1 …) and the original order?')) return;
          S.mixer.channels.forEach((ch, c) => setParam(['channels', c, 'input'], `in:${c}`));
          setParam(['order'], S.mixer.channels.map((_, c) => c));
          toast('Matched WING order');
        } }, 'Match WING order'),
        h('span', { class: 'hint' }, 'Rearrange by dragging strips in the Mixer or track names in Edit; change any channel’s input in its editor.')));
  }

  function cablesCard(i, devices) {
    const c = i.cfg, cb = i.cables || {};
    const devName = d => `${d.name} (${d.api})`;
    const pick = (key, kind) => {
      const k = kind === 'input' ? 'ins' : 'outs';
      return h('select', { onchange: e => save({ [key]: e.target.value || null }) }, h('option', { value: '' }, 'None (internal only)'),
        ...devices.filter(d => d[k] > 0).map(d => h('option', { value: devName(d), selected: c[key] === devName(d) || c[key] === d.name }, `${d.name} — ${d[k]} ch`)));
    };
    const isMac = navigator.platform.includes('Mac');
    return h('div', { class: 'card' }, h('h3', {}, icon('cable', 16), ' Virtual cables'),
      h('p', {}, 'Four stereo cables that act like a speaker and a microphone at once. Route any bus or the master into a cable (Routing tab), and it comes back as an input (“Cable 1 L/R”) on any channel.'),
      h('div', { class: 'f' }, h('span', {}, 'Cable device (out)'), pick('cable_out', 'output')),
      h('div', { class: 'f' }, h('span', {}, 'Cable device (in)'), pick('cable_in', 'input')),
      h('p', { class: cb.status === 'error' ? 'err' : 'hint' }, cb.status === 'device' ? `● Connected: ${cb.names.filter(Boolean).join(' / ')}` : cb.status === 'error' ? 'Cable device error: ' + cb.error : 'Running internally (no system device attached).'),
      h('p', { class: 'hint' }, 'To feed OBS, Zoom or another app, attach a system loopback device. ', isMac
        ? h('span', {}, 'On Mac install ', h('b', {}, 'BlackHole 16ch'), ' (Terminal: ', h('code', {}, 'brew install blackhole-16ch'), '), restart this app, and pick “BlackHole 16ch” for both. Cable 1 = BlackHole 1–2, Cable 2 = 3–4, and so on.')
        : h('span', {}, 'On Windows install ', h('b', {}, 'VB-Audio Virtual Cable'), ' (vb-audio.com). Choose “CABLE Input” as the out device and “CABLE Output” as the in device.')));
  }

  function sessionsCard(i) {
    const list = h('div', { class: 'list' });
    for (const s of i.sessions) list.append(h('div', { class: 'li' + (s.name === S.session?.name ? ' cur' : ''), onclick: async () => { if (s.name === S.session?.name) return; await tryApi('session-open', { name: s.name }); toast('Opened ' + s.name); refresh(); } }, s.name, h('span', {}, new Date(s.modified * 1000).toLocaleString())));
    const name = h('input', { placeholder: 'New session name e.g. Sunday 5 Oct', style: 'flex:1' });
    const projIn = h('input', { type: 'file', accept: '.stobite', hidden: true, onchange: e => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; } });
    return h('div', { class: 'card' }, h('h3', {}, 'Sessions'),
      h('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, name, h('button', { class: 'btn accent', onclick: async () => { await tryApi('session-new', { name: name.value }); toast('New session created'); refresh(); } }, 'New')),
      list,
      h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: () => projIn.click() }, icon('import', 14), 'Open a project file…'), projIn,
        ['localhost', '127.0.0.1'].includes(location.hostname) ? h('button', { class: 'btn', onclick: () => api('reveal') }, 'Show session folder') : null),
      h('p', { class: 'hint' }, 'Take a service home: Edit → Export → Project file. It holds every recording and the whole mix in one .stobite file.'));
  }

  const WING_COLORS = ['#3f6ad8', '#29a3d9', '#1fb5a6', '#3ec46d', '#9fcc3b', '#e6c229', '#f08a24', '#e5484d', '#e85d9e', '#a35bd8', '#7a7f8a', '#cfd2d6'];

  async function save(patch) {
    const r = await tryApi('config', patch);
    S.info = r; emit('info');
    toast('Saved');
  }
  async function refresh() { S.info = await api('info'); emit('info'); }
  on('info', () => { if (S.view === 'setup') render(); });
  on('view', v => v === 'setup' && refresh());
})();
