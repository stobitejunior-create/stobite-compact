// Setup: a few clear sections (like System Settings), one shown at a time.
// Everyday settings up front; rarely-touched ones folded under "Advanced"; long how-tos in Help.
(() => {
  let devices = [];
  let tab = 'audio';
  try { tab = localStorage.getItem('stobite.setupTab') || 'audio'; } catch (e) { /* storage off */ }

  const SECTIONS = [
    ['audio', 'Audio', 'wave'],
    ['stream', 'Stream & listen', 'out'],
    ['wing', 'WING', 'mixer'],
    ['remote', 'Phone remote', 'phone'],
    ['look', 'Appearance', 'sun'],
    ['storage', 'Storage', 'folder'],
    ['help', 'Help', 'book'],
  ];

  // ---- small building blocks
  const row = (label, control, sub) => h('div', { class: 'srow' },
    h('div', { class: 'srow-l' }, h('span', {}, label), sub ? h('small', {}, sub) : null), h('div', { class: 'srow-c' }, control));
  const toggle = (on, onchange) => {
    const inp = h('input', { type: 'checkbox', checked: !!on, onchange: e => onchange(e.target.checked, e.target) });
    return h('label', { class: 'switch' }, inp, h('i'));
  };
  const group = (title, ...kids) => h('div', { class: 'sgroup' }, title ? h('h4', {}, title) : null, ...kids);
  const advanced = (...kids) => { const d = h('details', { class: 'sadv' }, h('summary', {}, 'Advanced'), ...kids); return d; };
  const status = (kind, text) => h('div', { class: 'sstatus ' + kind }, h('i'), h('span', {}, text));
  const devName = d => `${d.name} (${d.api})`;

  async function render() {
    if (!S.info) return;
    const i = S.info, c = i.cfg;
    try { devices = await api('devices'); } catch (e) { /* keep last list */ }
    lastShown = shown();
    const box = $('#setup');
    const body = box.querySelector('.s-body'), keepScroll = body ? body.scrollTop : 0;
    box.innerHTML = '';

    const nav = h('nav', { class: 's-nav' }, ...SECTIONS.map(([id, label, ic]) =>
      h('button', { class: id === tab ? 'on' : '', onclick: () => { tab = id; try { localStorage.setItem('stobite.setupTab', id); } catch (e) { } render(); } },
        icon(ic, 16), h('span', { class: 'lbl' }, label), id === 'audio' ? h('em', { class: 'sdot ' + (i.status === 'running' ? (i.devIns ? 'ok' : 'warn') : 'bad') }) : null)));
    const content = h('div', { class: 's-body' }, h('div', { class: 's-inner' }, ...SECTION_BUILDERS[tab](i, c)));
    box.append(nav, content);
    if (body) requestAnimationFrame(() => { content.scrollTop = keepScroll; });
  }

  // ---- the sections
  const SECTION_BUILDERS = {
    audio(i, c) {
      const sel = (kind) => {
        const key = kind === 'input' ? 'ins' : 'outs';
        const s = h('select', {}, h('option', { value: 'none', selected: c[kind] === 'none' }, 'None'),
          h('option', { value: '', selected: !c[kind] }, kind === 'input' ? 'Auto (the WING)' : 'Auto'));
        for (const d of sortDevices(devices.filter(d => d[key] > 0)))
          s.append(h('option', { value: devName(d), selected: c[kind] === devName(d) || c[kind] === d.name }, `${d.wing ? '★ ' : ''}${d.name} · ${d[key]} ch (${d.api})`));
        s.onchange = () => save({ [kind]: s.value || null });
        return s;
      };
      const st = i.status !== 'running' ? status('bad', i.error || 'Audio is off')
        : i.devIns && i.inIsWing ? status('ok', `WING connected · ${i.devIns} channels · ${i.sr / 1000} kHz`)
        : i.devIns ? status('ok', `${i.inName} · ${i.devIns} channels`)
        : status('warn', 'No WING connected. It connects by itself when plugged in.');
      return [
        h('h2', {}, 'Audio'),
        st,
        i.audioNote ? h('p', { class: 'snote warn' }, i.audioNote) : null,
        group(null,
          row('Input', sel('input'), 'Where the channels come from'),
          row('Output', sel('output'), 'The audio interface'),
          advanced(
            row('Sample rate', num(c, 'sr', [[44100, '44.1 kHz'], [48000, '48 kHz (WING)'], [96000, '96 kHz']])),
            row('Buffer', num(c, 'block', [[64, '64'], [128, '128'], [256, '256 (recommended)'], [512, '512 (safest)'], [1024, '1024']]), 'Raise if you hear clicks'),
            row('', h('button', { class: 'btn', onclick: async () => { await tryApi('audio-restart', {}); refresh(); } }, 'Restart audio')))),
      ];
    },

    stream(i, c) {
      const outs = Math.max(i.devOuts, 2);
      const outOpts = [...Array(outs).keys()].map(n => [n, 'Output ' + (n + 1)]);
      return [
        h('h2', {}, 'Stream & listen'),
        group('Livestream',
          row('Stream output', streamSel(i), 'For OBS and Zoom'),
          i.streamOutError ? h('p', { class: 'snote bad' }, i.streamOutError)
            : i.streamOutName ? status('ok', `Sending the mix to ${i.streamOutName}`)
            : h('p', { class: 'snote' }, 'Pick “CABLE Input” to livestream. Setup steps are in Help.')),
        group('Listening',
          i.outIsWing ? row('Headphones', listenSel(i), i.listenError ? 'Couldn’t open it' : i.listenName ? 'On this computer' : 'Off') : null,
          row('Live monitoring', toggle(c.monitor_live, v => save({ monitor_live: v })), 'Hear the inputs when not playing back')),
        group(null, advanced(
          i.outIsWing ? row('Send mix to the WING', toggle(c.wing_return, (v, el) => {
            if (v && !confirm('Send the mix back into the WING?\n\nOnly if its USB returns aren’t patched into channels that come back over USB, or it will screech. The app cuts the sound if it does.')) { el.checked = false; return; }
            save({ wing_return: v });
          }), 'Off is safest') : null,
          row('Main out L / R', h('div', { class: 'pair' }, num(c, 'main_l', [[-1, 'None'], ...outOpts]), num(c, 'main_r', [[-1, 'None'], ...outOpts]))),
          row('Monitor out L / R', h('div', { class: 'pair' }, num(c, 'mon_l', [[-1, 'Same as main'], ...outOpts]), num(c, 'mon_r', [[-1, 'Same as main'], ...outOpts])), 'For mono / side checks'),
          row('Channel returns', toggle(c.direct_outs, v => save({ direct_outs: v })), 'Each processed channel back out'),
          c.direct_outs ? row('Returns start at', num(c, 'direct_offset', [[-1, 'None'], ...outOpts])) : null,
          cablesRows(i, c))),
      ];
    },

    wing(i, c) {
      const ip = h('input', { placeholder: 'IP address (blank = search)', value: c.wing_ip || '' });
      const out = h('p', { class: 'snote' });
      return [
        h('h2', {}, 'WING'),
        group('Channel names',
          h('p', { class: 'snote' }, 'Copy names, colours and order from the console. Read-only.'),
          row('Console', h('div', { class: 'pair' }, ip, h('button', { class: 'btn accent', onclick: () => copyNames(ip.value.trim(), out) }, 'Copy names'))),
          out,
          row('Channel order', h('button', { class: 'btn', onclick: matchOrder }, 'Match WING order'), 'Ch 1 = USB 1, and so on')),
        group('Remote control',
          row('Show WING tab', toggle(c.show_wing, v => save({ show_wing: v })), 'Move the console’s faders from here'),
          h('p', { class: 'snote' }, 'Faders snapping back? Turn off Remote Lock on the WING (Setup → Remote).')),
      ];
    },

    remote(i, c) {
      return [
        h('h2', {}, 'Phone remote'),
        group(null,
          row('Allow phones', toggle(i.remote, v => save({ remote: v })), 'On the same Wi-Fi'),
          i.remote ? (i.urls.length ? h('div', {}, h('p', { class: 'snote' }, 'Open this on a phone or tablet:'), ...i.urls.map(u => h('span', { class: 'url' }, u)))
            : status('bad', 'This computer isn’t on a network')) : null,
          row('PIN', h('input', { type: 'password', placeholder: i.hasPin ? '•••• (type to change)' : 'None', onchange: e => save({ pin: e.target.value }) }), 'Recommended on guest Wi-Fi')),
      ];
    },

    look(i, c) {
      const cur = c.theme || 'auto';
      const seg = h('div', { class: 'seg' }, ...[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
        h('button', { class: v === cur ? 'on' : '', onclick: () => { applyTheme(v); save({ theme: v }); } }, l)));
      return [h('h2', {}, 'Appearance'), group(null, row('Theme', seg, 'Auto follows the computer'))];
    },

    storage(i, c) {
      const projIn = h('input', { type: 'file', accept: '.stobite', hidden: true, onchange: e => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; } });
      const local = ['localhost', '127.0.0.1'].includes(location.hostname);
      return [
        h('h2', {}, 'Storage'),
        group(null,
          row('Folder', h('span', { class: 'path' }, i.home)),
          local ? row('', h('button', { class: 'btn', onclick: () => api('reveal') }, 'Show in Finder / Explorer')) : null,
          row('Projects', h('div', { class: 'pair' }, h('button', { class: 'btn', onclick: () => showWelcome(true) }, 'All projects'),
            h('button', { class: 'btn', onclick: () => projIn.click() }, 'Open a file…'), projIn)),
          h('p', { class: 'snote' }, 'Recording uses about 0.5 GB per channel per hour. Only armed channels are recorded.')),
      ];
    },

    help() {
      const guide = (title, open, ...steps) => h('details', { class: 'sguide', open }, h('summary', {}, title), h('ol', {}, ...steps.map(s => h('li', {}, ...[].concat(s)))));
      const b = t => h('b', {}, t);
      return [
        h('h2', {}, 'Help'),
        guide('Connect the WING', true,
          ['One USB cable (USB-A/C to ', b('USB-B'), ') into the WING’s ', b('back-panel USB'), ' port. It carries all 48 channels.'],
          ['Windows: install the ', b('WING USB driver'), ' (behringer.com), then pick the ASIO device. Mac: nothing to install.'],
          ['On the WING: ', b('Routing → USB'), ', send the channel ', b('direct outs (pre-fader)'), ' to USB 1–48.'],
          ['Optional: plug in its Ethernet to copy channel names.']),
        guide('Livestream with OBS and Zoom', false,
          ['Install ', b('VB-Audio Virtual Cable'), ' and restart. Use “CABLE Input”, not “CABLE In 16ch”.'],
          ['Here: ', b('Stream output = CABLE Input'), '.'],
          ['Music from Windows: keep it going to the WING (Behringer USB 1-8).'],
          ['OBS: Settings → Audio, turn ', b('Desktop Audio and Mic off'), '. Add ', b('Audio Input Capture → CABLE Output'), '.'],
          ['OBS videos: Monitoring Device = the WING; on the video, ', b('Monitor Only (mute output)'), '. Add a Render Delay filter if its sound is late.'],
          ['Zoom: microphone ', b('CABLE Output'), ', turn on ', b('Original sound for musicians'), '. Speaker = the monitor screen.']),
        guide('If it screeches', false,
          ['The app cuts all sound and shows a red banner when its output comes back in.'],
          ['Usually the WING sends the app’s returns into a channel that comes back over USB. Fix that routing, or turn off ', b('Send mix to the WING'), '.'],
          ['Then press ', b('Unmute'), '.']),
      ];
    },
  };

  // ---- pieces shared by sections
  const num = (c, k, opts) => h('select', { onchange: e => save({ [k]: isNaN(+e.target.value) ? e.target.value : +e.target.value }) },
    ...opts.map(([v, l]) => h('option', { value: v, selected: c[k] == v }, l)));

  function streamSel(i) {
    const cur = i.cfg.stream_out || '';
    const outs = devices.filter(d => d.outs > 0 && !d.wing && d.api !== 'ASIO');
    // one entry per device name, preferring WASAPI on Windows (lowest latency of the shared drivers)
    const rank = { 'Windows WASAPI': 0, 'Core Audio': 0, 'MME': 1, 'Windows DirectSound': 2, 'Windows WDM-KS': 3 };
    const best = new Map();
    for (const d of outs) { const k = d.name.replace(/ \(.*$/, ''); const b = best.get(k); if (!b || (rank[d.api] ?? 9) < (rank[b.api] ?? 9)) best.set(k, d); }
    const list = sortDevices([...best.values()]);
    const s = h('select', { onchange: e => save({ stream_out: e.target.value }) }, h('option', { value: '' }, 'Off'));
    // VB-Cable on Windows shows two doors into the same cable: the stereo "CABLE Input" is the one to use
    const many = d => /\b(8|16|32)ch\b/i.test(d.name);
    for (const d of list) {
      const v = devName(d), virt = /cable|virtual|voicemeeter/i.test(d.name);
      s.append(h('option', { value: v, selected: v === cur }, (virt && !many(d) ? '★ ' : '') + d.name + (virt && !many(d) ? ' (use this)' : '')));
    }
    if (cur && !list.some(d => devName(d) === cur)) s.append(h('option', { value: cur, selected: true }, cur + ' (not connected)'));
    return s;
  }

  function listenSel(i) {
    const cur = i.cfg.listen ?? 'auto';
    const opts = [['auto', 'This computer'], ['', 'Off'], ...sortDevices(devices.filter(d => d.outs > 0 && !d.wing && d.api !== 'ASIO')).map(d => [devName(d), d.name])];
    return h('select', { onchange: e => save({ listen: e.target.value }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  }

  function cablesRows(i, c) {
    const cb = i.cables || {};
    const pick = (key, kind) => {
      const k = kind === 'input' ? 'ins' : 'outs';
      return h('select', { onchange: e => save({ [key]: e.target.value || null }) }, h('option', { value: '' }, 'None (internal)'),
        ...sortDevices(devices.filter(d => d[k] > 0)).map(d => h('option', { value: devName(d), selected: c[key] === devName(d) || c[key] === d.name }, d.name)));
    };
    return h('div', { class: 'ssub' }, h('h5', {}, 'Virtual cables'),
      h('p', { class: 'snote' }, 'Send a bus out and back in as a channel input. Not needed for OBS.'),
      row('Cable out', pick('cable_out', 'output')), row('Cable in', pick('cable_in', 'input')),
      cb.status === 'error' ? h('p', { class: 'snote bad' }, cb.error) : null);
  }

  async function copyNames(ip, out) {
    out.textContent = 'Reading from the WING…';
    try {
      const r = await api('wing-names', { ip });
      let n = 0;
      r.channels.forEach((w, k) => {
        const c = S.mixer.channels.findIndex(ch => ch.input === `in:${k}`);
        if (c < 0 || !w.name) return;
        setParam(['channels', c, 'name'], w.name);
        if (typeof w.col === 'number' && WING_COLORS[w.col - 1]) setParam(['channels', c, 'color'], WING_COLORS[w.col - 1]);
        n++;
      });
      out.textContent = `Copied ${n} names from ${r.ip}.`;
    } catch (e) { out.textContent = e.message; }
  }

  function matchOrder() {
    if (!confirm('Set Ch 1 = USB 1, Ch 2 = USB 2 … and the original order?')) return;
    S.mixer.channels.forEach((ch, c) => setParam(['channels', c, 'input'], `in:${c}`));
    setParam(['order'], S.mixer.channels.map((_, c) => c));
    toast('Matched WING order');
  }

  const WING_COLORS = ['#3f6ad8', '#29a3d9', '#1fb5a6', '#3ec46d', '#9fcc3b', '#e6c229', '#f08a24', '#e5484d', '#e85d9e', '#a35bd8', '#7a7f8a', '#cfd2d6'];

  async function save(patch) {
    const r = await tryApi('config', patch);
    S.info = r; emit('info');
    toast('Saved');
  }
  async function refresh() { S.info = await api('info'); emit('info'); }
  // Redraw only when something this page shows has changed: a full redraw resets dropdowns,
  // the scroll position and anything half-typed.
  const shown = () => { const i = S.info || {}; return JSON.stringify([i.status, i.error, i.audioNote, i.devIns, i.devOuts, i.inName, i.outName, i.inIsWing, i.sr, i.cfg, i.extraInputs, i.remote, i.urls, i.cables, i.wing && i.wing.ip, i.outIsWing, i.listenName, i.listenError, i.streamOutName, i.streamOutError, i.home]); };
  let lastShown = '';
  on('info', () => { if (S.view !== 'setup') return; const k = shown(); if (k !== lastShown) render(); });
  on('view', v => v === 'setup' && refresh());
})();
