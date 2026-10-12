// Every command in one place: keyboard shortcuts, the menu bar (via runCmd), right-click menus
// and the shortcuts sheet all use this list, so they always agree.
(() => {
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

  // key: { k: key name, mod: Cmd (Mac) / Ctrl (Windows), shift, alt, ctrl: the real Control key }
  const C = [
    // File
    ['newProject', 'File', 'New project…', { k: 'n', mod: 1 }, () => newProject()],
    ['openProject', 'File', 'Open project…', { k: 'o', mod: 1 }, () => showWelcome(true)],
    ['importAudio', 'File', 'Import audio…', { k: 'i', mod: 1, shift: 1 }, () => { showView('edit'); $('#btnImport').click(); }],
    ['save', 'File', 'Save', { k: 's', mod: 1 }, () => api('save', {}).then(() => toast('Saved'))],
    ['exportMix', 'File', 'Export…', { k: 'e', mod: 1 }, () => openExport()],
    ['mixSettings', 'File', 'Mix settings & templates…', { k: 'm', mod: 1, shift: 1 }, () => { showView('mixer'); [...$$('button')].find(b => b.textContent.includes('Mix settings'))?.click(); }],
    // Edit
    ['undo', 'Edit', 'Undo', { k: 'z', mod: 1 }, () => undo(false)],
    ['redo', 'Edit', 'Redo', { k: 'z', mod: 1, shift: 1 }, () => undo(true)],
    ['cut', 'Edit', 'Cut', { k: 'x', mod: 1 }, () => TL.cut(), 'edit'],
    ['copy', 'Edit', 'Copy', { k: 'c', mod: 1 }, () => TL.copy(), 'edit'],
    ['paste', 'Edit', 'Paste', { k: 'v', mod: 1 }, () => TL.paste(), 'edit'],
    ['duplicate', 'Edit', 'Duplicate', { k: 'd', mod: 1 }, () => TL.duplicate(), 'edit'],
    ['delete', 'Edit', 'Delete', { k: 'backspace' }, () => TL.delete(), 'edit'],
    ['selectAll', 'Edit', 'Select all', { k: 'a', mod: 1 }, () => TL.selectAll(), 'edit'],
    ['split', 'Edit', 'Split at playhead', { k: 't', mod: 1 }, () => TL.split(), 'edit'],
    ['join', 'Edit', 'Join clips', { k: 'j', mod: 1 }, () => TL.join(), 'edit'],
    ['normalize', 'Edit', 'Normalize', null, () => TL.normalize(), 'edit'],
    ['reverse', 'Edit', 'Reverse', null, () => TL.reverse(), 'edit'],
    ['muteClip', 'Edit', 'Mute / unmute clip', { k: 'm', ctrl: 1 }, () => TL.mute(), 'edit'],
    ['renameClip', 'Edit', 'Rename clip…', null, () => TL.rename(), 'edit'],
    ['marker', 'Edit', 'Add marker', { k: 'm' }, () => TL.marker(), 'edit'],
    // Transport
    ['play', 'Transport', 'Play / pause', { k: ' ' }, () => tr('toggle')],
    ['record', 'Transport', 'Record', { k: 'r' }, () => $('#btnRec').click()],
    ['stop', 'Transport', 'Stop', null, () => $('#btnStop').click()],
    ['toStart', 'Transport', 'Go to start', { k: 'enter' }, () => tr('locate', { pos: 0 })],
    ['back', 'Transport', 'Back 5 seconds', { k: ',' }, () => $('#btnBack').click()],
    ['forward', 'Transport', 'Forward 5 seconds', { k: '.' }, () => $('#btnFwd').click()],
    ['cycle', 'Transport', 'Cycle (loop)', { k: 'c' }, () => toggleLoop()],
    ['metronome', 'Transport', 'Metronome', { k: 'k' }, () => toggleCfg('metronome', 'Metronome')],
    ['countIn', 'Transport', 'Count-in', { k: 'k', shift: 1 }, () => toggleCfg('countin', 'Count-in')],
    ['tempo', 'Transport', 'Tempo & time signature…', null, () => tempoDialog()],
    ['tuner', 'Transport', 'Tuner…', { k: 'u', mod: 1 }, () => openTuner()],
    ['recPlayhead', 'Transport', 'Record from the playhead (takes)', null, () => toggleRecFrom()],
    ['alignMics', 'Mix', 'Align mics & check polarity…', null, () => alignMics()],
    ['findSongs', 'File', 'Find songs & sermon…', null, () => findSongs()],
    ['videoAlign', 'File', 'Line up with a video…', null, () => videoAlign()],
    ['masterAssist', 'Mix', 'Master to target…', null, () => masterAssistant()],
    ['drumTriggers', 'Mix', 'Drum triggers…', null, () => drumTriggers()],
    ['hpCorrect', 'Mix', 'Headphone correction on / off', { k: 'h', alt: 1, shift: 1 }, () => toggleHp()],
    ['lock', 'Mix', 'Lock / unlock the mix (service lock)', { k: 'l', mod: 1, shift: 1 }, () => toggleLock()],
    ['clearSolos', 'Mix', 'Clear all solos', { k: 's', alt: 1, shift: 1 }, () => clearSolos()],
    ['clearMutes', 'Mix', 'Clear all mutes', { k: 'm', alt: 1, shift: 1 }, () => clearMutes()],
    ['compare', 'View', 'Compare before / after', { k: '\\' }, () => setCompare(!S.compare)],
    // View
    ['viewEdit', 'View', 'Edit', { k: '1', mod: 1 }, () => showView('edit')],
    ['viewMixer', 'View', 'Mixer', { k: '2', mod: 1 }, () => showView('mixer')],
    ['viewRouting', 'View', 'Routing', { k: '3', mod: 1 }, () => showView('routing')],
    ['viewMaster', 'View', 'Master', { k: '4', mod: 1 }, () => showView('master')],
    ['viewSetup', 'View', 'Setup', { k: ',', mod: 1 }, () => showView('setup')],
    ['zoomIn', 'View', 'Zoom in', { k: '=', mod: 1 }, () => TL.zoomIn(), 'edit'],
    ['zoomOut', 'View', 'Zoom out', { k: '-', mod: 1 }, () => TL.zoomOut(), 'edit'],
    ['fit', 'View', 'Zoom to fit', { k: 'z' }, () => TL.fit(), 'edit'],
    ['snap', 'View', 'Snap to grid', { k: 'g', mod: 1 }, () => TL.toggleSnap(), 'edit'],
    ['beats', 'View', 'Bars & beats ruler', null, () => TL.toggleBeats(), 'edit'],
    ['follow', 'View', 'Follow playhead', { k: 'f' }, () => TL.toggleFollow(), 'edit'],
    ['toolPointer', 'View', 'Pointer tool', { k: 'v' }, () => TL.tool('select'), 'edit'],
    ['toolBlade', 'View', 'Blade tool', { k: 'b' }, () => TL.tool('blade'), 'edit'],
    ['toolRange', 'View', 'Range tool', { k: 'g' }, () => TL.tool('range'), 'edit'],
    // Help
    ['shortcuts', 'Help', 'Keyboard shortcuts', { k: '/', mod: 1 }, () => shortcutsSheet()],
    ['help', 'Help', 'Help & guides', null, () => { showView('setup'); try { localStorage.setItem('stobite.setupTab', 'help'); } catch (e) { } emit('info'); }],
  ];

  const keyName = k => ({ ' ': 'Space', backspace: '⌫', enter: '↩', ',': ',', '.': '.', '/': '/', '=': '+', '-': '−' }[k] || k.toUpperCase());
  const show = key => {
    if (!key) return '';
    if (MAC) return (key.ctrl ? '⌃' : '') + (key.alt ? '⌥' : '') + (key.shift ? '⇧' : '') + (key.mod ? '⌘' : '') + keyName(key.k);
    return [(key.mod || key.ctrl) && 'Ctrl', key.alt && 'Alt', key.shift && 'Shift', keyName(key.k)].filter(Boolean).join('+');
  };
  window.CMD = {};
  for (const [id, group, title, key, run, where] of C) CMD[id] = { id, group, title, key, run, where, keys: show(key) };
  window.runCmd = id => { const c = CMD[id]; if (!c) return; if (c.where === 'edit' && S.view !== 'edit' && !['cut', 'copy', 'paste', 'selectAll'].includes(id)) showView('edit'); c.run(); };

  function undo(redo) {
    const ae = document.activeElement;
    if (ae && ae.matches('input, textarea')) return document.execCommand(redo ? 'redo' : 'undo');
    const mixerView = S.view === 'mixer' || S.view === 'master' || !$('#editor').hidden;
    send({ t: mixerView ? (redo ? 'mixredo' : 'mixundo') : (redo ? 'redo' : 'undo') });
  }
  async function toggleCfg(key, label) {
    const v = !S.info?.cfg?.[key];
    S.info = await tryApi('config', { [key]: v }); emit('info');
    toast(`${label} ${v ? 'on' : 'off'}`);
  }

  // ---- keyboard: one listener, before the older per-view ones
  document.addEventListener('keydown', e => {
    if (e.target.matches?.('input, textarea, select') || (window.welcomeOpen && welcomeOpen())) return;
    if (!$('#modal').hidden || document.querySelector('.ctx')) return;
    const mod = MAC ? e.metaKey : e.ctrlKey, ctrl = MAC ? e.ctrlKey : false;
    const k = e.key === ' ' ? ' ' : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    // with Option held a Mac types a different character (⌥S = ß), so use the physical key
    const phys = e.altKey && /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3).toLowerCase() : k;
    const keyOf = { '+': '=', '_': '-', '?': '/' }[phys] || phys;
    for (const c of Object.values(CMD)) {
      const kk = c.key; if (!kk) continue;
      if (kk.k !== keyOf && !(kk.k === 'backspace' && keyOf === 'delete')) continue;
      if (!!kk.mod !== mod || !!kk.shift !== e.shiftKey || !!kk.alt !== e.altKey || !!kk.ctrl !== ctrl) continue;
      if (c.where === 'edit' && S.view !== 'edit') continue;      // editing keys only act on the timeline
      if (kk.k === 'r' && e.repeat) return;
      e.preventDefault(); e.stopImmediatePropagation();
      c.run();
      return;
    }
  }, true);

  // Edit → Cut / Copy / Paste chosen with the mouse (Mac menu bar): text boxes keep their own copy
  // and paste; on the timeline they act on clips.
  for (const ev of ['copy', 'cut', 'paste']) document.addEventListener(ev, e => {
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
    if (S.view !== 'edit' || !window.TL) return;
    e.preventDefault();
    TL[ev]();
  });

  // ---- right-click menu (used by the timeline, track headers, and anything else)
  window.contextMenu = (e, items) => {
    document.querySelectorAll('.ctx').forEach(m => m.remove());
    const menus = [];   // open menus, by depth (0 = main, 1 = submenu)
    const closeFrom = d => { while (menus.length > d) menus.pop().remove(); };
    const build = (list, x, y, d) => {
      closeFrom(d);
      const m = h('div', { class: 'ctx' });
      for (const it of list) {
        if (it === '-') { m.append(h('div', { class: 'ctx-sep' })); continue; }
        const row = h('div', { class: 'ctx-i' + (it.disabled ? ' off' : '') + (it.danger ? ' danger' : '') },
          h('span', { class: 'ctx-ck' }, it.check ? '✓' : ''), h('span', { class: 'ctx-l' }, it.label), h('span', { class: 'ctx-k' }, it.items ? '›' : it.keys || ''));
        row.onmouseenter = () => {
          m.querySelectorAll('.ctx-open').forEach(x => x.classList.remove('ctx-open'));
          if (it.items) { const r = row.getBoundingClientRect(); row.classList.add('ctx-open'); build(it.items, r.right - 4, r.top - 5, d + 1); }
          else closeFrom(d + 1);
        };
        if (!it.items && !it.disabled) row.onclick = () => { close(); it.run(); };
        m.append(row);
      }
      document.body.append(m);
      menus.push(m);
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
      m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
    };
    const close = () => { closeFrom(0); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', esc, true); };
    const outside = ev => { if (!ev.target.closest('.ctx')) close(); };
    const esc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(); } };
    build(items, e.clientX, e.clientY, 0);
    setTimeout(() => { addEventListener('pointerdown', outside, true); addEventListener('keydown', esc, true); });
    addEventListener('blur', close, { once: true });
  };

  // ---- the shortcuts sheet
  window.shortcutsSheet = () => modal((card, close) => {
    card.classList.add('wide');
    const groups = {};
    for (const c of Object.values(CMD)) if (c.keys) (groups[c.group] = groups[c.group] || []).push(c);
    card.append(h('h3', {}, 'Keyboard shortcuts'),
      h('div', { class: 'kb-grid' }, ...Object.entries(groups).map(([g, list]) => h('div', { class: 'kb-col' }, h('h4', {}, g),
        ...list.map(c => h('div', { class: 'kb-row' }, h('span', {}, c.title), h('kbd', {}, c.keys)))))),
      h('div', { class: 'acts' }, h('button', { class: 'btn accent', onclick: close }, 'Done')));
  });

  // ---- tuner: the raw input of any channel, as note + cents
  window.openTuner = (ch) => modal((card, close) => {
    card.classList.add('tuner-card');
    const chans = S.mixer.order.filter(c => { const x = S.mixer.channels[c]; return x.input && x.input !== 'none'; });
    let cur = ch ?? (window.__tunerCh ?? chans.find(c => /bass|guitar|gtr|keys|piano|vox|vocal/i.test(S.mixer.channels[c].name + ' ' + (S.mixer.channels[c].type || ''))) ?? chans[0]);
    let a4 = +(window.__tunerA4 || 440);
    const sel = h('select', { onchange: e => { cur = +e.target.value; start(); } }, ...chans.map(c => h('option', { value: c, selected: c === cur }, `${c + 1}: ${S.mixer.channels[c].name}`)));
    const ref = h('input', { type: 'number', min: 415, max: 466, step: 1, value: a4, style: 'width:70px', onchange: e => { a4 = clamp(+e.target.value || 440, 415, 466); start(); } });
    const note = h('div', { class: 'tn-note' }, '–'), oct = h('sub', {}), cents = h('div', { class: 'tn-cents' }, 'Play one note'), hz = h('div', { class: 'tn-hz' });
    const needle = h('i', { class: 'tn-needle' });
    const scale = h('div', { class: 'tn-scale' }, ...[-50, -25, 0, 25, 50].map(v => h('span', { style: `left:${50 + v}%` }, v > 0 ? '+' + v : v)), needle);
    const start = () => { window.__tunerCh = cur; window.__tunerA4 = a4; send({ t: 'tuner', ch: cur, a4 }); };
    let last = 0;
    const onM = m => {
      if (!document.body.contains(card)) return;
      const t = m.tn;
      if (!t) return;
      if (!t.note) { if (performance.now() - last > 600) { card.classList.remove('intune'); needle.style.opacity = .25; } return; }
      last = performance.now();
      note.firstChild.textContent = t.note; oct.textContent = t.oct;
      const c = clamp(t.cents, -50, 50);
      needle.style.left = (50 + c) + '%'; needle.style.opacity = 1;
      const ok = Math.abs(t.cents) <= 3;
      card.classList.toggle('intune', ok);
      cents.textContent = ok ? 'In tune' : (t.cents > 0 ? `${t.cents} cents sharp ↓` : `${-t.cents} cents flat ↑`);
      hz.textContent = `${t.hz.toFixed(1)} Hz`;
    };
    note.append(oct);
    on('meters', onM);
    const stop = () => { send({ t: 'tuner', ch: null }); };
    card.append(h('h3', {}, 'Tuner'),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Listen to'), h('small', {}, 'The raw input, before any processing')), sel),
      h('div', { class: 'tn-face' }, note, scale, cents, hz),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Reference A'), h('small', {}, 'Hz')), ref),
      h('div', { class: 'acts' }, h('button', { class: 'btn accent', onclick: () => { stop(); close(); } }, 'Done')));
    const mo = new MutationObserver(() => { if (!document.body.contains(card) || $('#modal').hidden) { stop(); mo.disconnect(); } });
    mo.observe($('#modal'), { attributes: true, childList: true, subtree: false });
    start();
  });

  // ---- master to target: analyse the project and set the master chain
  window.masterAssistant = () => modal((card, close) => {
    card.classList.add('wide');
    let target = -14, style = 'balanced';
    const targets = [[-14, 'Streaming / YouTube / livestream', '−14 LUFS'], [-16, 'Apple Music / podcasts', '−16 LUFS'], [-18, 'Gentle, dynamic', '−18 LUFS'], [-23, 'Broadcast (EBU R128)', '−23 LUFS'], [-11, 'Loud', '−11 LUFS']];
    const tsel = h('select', { onchange: e => target = +e.target.value }, ...targets.map(([v, l, n]) => h('option', { value: v, selected: v === target }, `${l} (${n})`)));
    const seg = h('div', { class: 'seg' }, ...[['balanced', 'Balanced'], ['warm', 'Warm'], ['bright', 'Bright']].map(([v, l]) => {
      const b = h('button', { class: v === style ? 'on' : '', onclick: () => { style = v; seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); } }, l); return b; }));
    const bar = h('div', { class: 'progress' }, h('i'));
    const stage = h('p', { class: 'hint' });
    const out = h('div');
    const go = h('button', { class: 'btn accent' }, 'Analyse & set master');
    card.append(h('h3', {}, 'Master to target'),
      h('p', { class: 'hint' }, 'Listens to the busiest parts of this project, then sets the master: corrective EQ, glue compression, gentle multiband, width and a true-peak limiter, landing on your loudness target. One undo puts it back.'),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Target'), h('small', {}, 'Where it will be heard')), tsel),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Character')), seg),
      bar, stage, out,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'), go));
    let busy = false;
    const listener = m => {
      if (!document.body.contains(card)) return;
      if (m.progress != null) { bar.firstChild.style.width = (m.progress * 100) + '%'; stage.textContent = m.stage || ''; }
      if (m.error) { busy = false; go.disabled = false; stage.textContent = ''; out.innerHTML = ''; out.append(h('p', { class: 'err' }, m.error)); }
      if (m.done) {
        busy = false; go.disabled = false; bar.firstChild.style.width = '100%'; stage.textContent = '';
        const r = m.report, f = v => (v > 0 ? '+' : '') + (+v).toFixed(1);
        out.innerHTML = '';
        out.append(h('div', { class: 'ma-res' },
          h('div', {}, h('small', {}, 'Before'), h('b', {}, `${r.before.lufs} LUFS`), h('span', {}, `peaks ${r.before.tp} dBTP`)),
          h('div', { class: 'ma-arrow' }, '→'),
          h('div', {}, h('small', {}, 'After'), h('b', {}, `${r.after.lufs} LUFS`), h('span', {}, `peaks ${r.after.tp} dBTP`))),
          h('ul', { class: 'ma-notes' }, ...r.notes.map(n => h('li', {}, n)), h('li', {}, `Glue compression ${f(r.glue)} dB, limiter ${f(r.limiter)} dB`)),
          h('div', { class: 'frow' },
            h('button', { class: 'btn', onpointerdown: () => setCompare(true), onpointerup: () => setCompare(false), onpointerleave: () => S.compare && setCompare(false) }, 'Hold to hear before'),
            h('button', { class: 'btn', onclick: () => { send({ t: 'mixundo' }); toast('Master put back'); close(); } }, 'Undo'),
            h('button', { class: 'btn', onclick: () => { close(); showView('mixer'); openEditor('master'); } }, 'Open the master chain')));
      }
    };
    on('assist', listener);
    go.onclick = async () => {
      if (busy) return;
      busy = true; go.disabled = true; out.innerHTML = ''; bar.firstChild.style.width = '2%'; stage.textContent = 'Starting…';
      try { await api('master-assist', { target, style }); }
      catch (e) { busy = false; go.disabled = false; stage.textContent = ''; out.append(h('p', { class: 'err' }, e.message)); }
    };
  });

  // ---- record from the playhead (takes) instead of after the last recording
  window.toggleRecFrom = async () => {
    const atEnd = S.info?.cfg?.rec_at_end !== false;
    S.info = await tryApi('config', { rec_at_end: !atEnd }); emit('info');
    toast(atEnd ? 'Recording starts at the playhead: record again over a part to make another take (right-click a clip → Takes)' : 'Recording starts after the last recording', false, 6000);
  };

  // ---- headphone correction: on with the last model used, or off
  window.toggleHp = async () => {
    const c = S.info?.cfg || {};
    if (!c.hp_model && !c.hp_last) {
      showView('setup'); try { localStorage.setItem('stobite.setupTab', 'stream'); } catch (e) { } emit('info');
      return toast('Pick your headphones under Listening');
    }
    S.info = await tryApi('config', { hp_model: c.hp_model ? '' : c.hp_last }); emit('info');
    toast(c.hp_model ? 'Headphone correction off' : 'Headphone correction: ' + c.hp_last);
  };

  // ---- drum triggers for the whole kit: a sample on every kick, snare and tom hit
  window.drumTriggers = () => modal(async (card, close) => {
    card.classList.add('wide');
    const lists = window.SAMPLES || await loadSamples() || { builtin: [], user: [] };
    const all = [...lists.builtin, ...lists.user];
    const kinds = { kick: 'kick', snare: 'snare', tom: 'tom' };
    const guess = c => kinds[c.type] || (/kick|bd\b|bass ?drum/i.test(c.name) ? 'kick' : /snare|sd\b/i.test(c.name) ? 'snare' : /tom/i.test(c.name) ? 'tom' : null);
    const drums = S.mixer.order.map(i => ({ i, c: S.mixer.channels[i], k: guess(S.mixer.channels[i]) })).filter(x => x.k);
    if (!drums.length) {
      card.append(h('h3', {}, 'Drum triggers'), h('p', { class: 'hint' }, 'No kick, snare or tom channels found. Set a channel’s instrument to Kick, Snare or Tom, or add a Drum trigger from its effects.'),
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close')));
      return;
    }
    const toms = ['tom-high', 'tom-mid', 'tom-floor'];
    let ti = 0;
    const DET = { kick: [30, 150], snare: [150, 8000], tom: [60, 1200] };
    const rows = drums.map(({ i, c, k }) => {
      const cur = (c.chain || []).find(m => m.type === 'trigger');
      const def = k === 'kick' ? 'builtin:kick-punchy' : k === 'snare' ? 'builtin:snare-tight' : 'builtin:' + toms[Math.min(ti++, 2)];
      const on = h('input', { type: 'checkbox', checked: !!cur && cur.on !== false });
      const smp = h('select', {}, ...all.map(([v, l]) => h('option', { value: v, selected: v === (cur?.sample || def) }, l)));
      const mix = h('input', { type: 'range', min: 0, max: 100, value: cur?.mix ?? 50 });
      const pct = h('span', { class: 'hint' }, mix.value + '%');
      mix.oninput = () => { pct.textContent = mix.value + '%'; };
      return { i, k, cur, on, smp, mix, el: h('div', { class: 'al-row' }, on, h('b', {}, `${i + 1}: ${c.name}`), smp, h('span', { class: 'hint' }, 'Mix'), mix, pct) };
    });
    card.append(h('h3', {}, 'Drum triggers'),
      h('p', { class: 'hint' }, 'Adds a sample to every hit. Fine-tune each one in its channel.'),
      ...rows.map(r => r.el),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: () => {
        let n = 0;
        for (const r of rows) {
          const chain = [...(S.mixer.channels[r.i].chain || [])];
          const at = chain.findIndex(m => m.type === 'trigger');
          if (!r.on.checked) {
            if (at >= 0 && chain[at].on !== false) { chain[at] = { ...chain[at], on: false }; setParam(['channels', r.i, 'chain'], chain); }
            continue;
          }
          const [lo, hi] = DET[r.k];
          const set = { on: true, sample: r.smp.value, mix: +r.mix.value };
          if (at >= 0) chain[at] = { ...chain[at], ...set };
          else chain.unshift(makeModule('trigger', { ...set, det_lo: lo, det_hi: hi, sensitivity: r.k === 'tom' ? 40 : 50 }));
          setParam(['channels', r.i, 'chain'], chain);
          n++;
        }
        toast(n ? `Triggers on ${n} drum${n > 1 ? 's' : ''}` : 'Triggers off'); close();
      } }, 'Apply')));
  });

  // ---- mic alignment & polarity
  window.alignMics = () => modal((card, close) => {
    card.classList.add('wide');
    const used = new Set((S.session?.clips || []).map(c => c.track));
    const chans = S.mixer.order.filter(c => used.has(c) && !S.mixer.channels[c].mute);
    if (!chans.length) { card.append(h('h3', {}, 'Align mics'), h('p', { class: 'hint' }, 'Record something first: alignment is measured on the recording.'), h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'))); return; }
    const nm = c => `${c + 1}: ${S.mixer.channels[c].name}`;
    const drums = ['kick', 'snare', 'tom', 'hihat', 'overhead', 'room', 'perc'];
    let ref = chans.find(c => ['overhead', 'room'].includes(S.mixer.channels[c].type)) ?? chans[0];
    const refSel = h('select', { onchange: e => { ref = +e.target.value; } }, ...chans.map(c => h('option', { value: c, selected: c === ref }, nm(c))));
    const picks = new Set(chans.filter(c => c !== ref && drums.includes(S.mixer.channels[c].type)));
    const list = h('div', { class: 'dca-list' }, ...chans.map(c => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: picks.has(c), onchange: e => e.target.checked ? picks.add(c) : picks.delete(c) }), nm(c))));
    const out = h('div');
    const go = h('button', { class: 'btn accent', onclick: async () => {
      const cs = [...picks].filter(c => c !== ref);
      if (!cs.length) return toast('Tick the mics to check', true);
      go.disabled = true; out.innerHTML = ''; out.append(h('p', { class: 'hint' }, 'Listening to the recording…'));
      try {
        const res = await api('align', { ref, chans: cs });
        out.innerHTML = '';
        const rows = res.map(r => {
          const sure = r.match >= 0.3, earlier = r.delay_ms > 0.05;
          const apply = h('input', { type: 'checkbox', checked: sure && (earlier || r.flip) });
          const what = !sure ? 'Not enough shared sound to tell' :
            [earlier ? `delay ${r.delay_ms.toFixed(2)} ms` : r.delay_ms < -0.05 ? `arrives ${(-r.delay_ms).toFixed(2)} ms after the reference (leave it)` : 'already lined up',
             r.flip ? 'flip polarity' : null].filter(Boolean).join(' · ');
          return { r, apply, el: h('div', { class: 'al-row' + (sure ? '' : ' weak') }, apply, h('b', {}, nm(r.ch)), h('span', {}, what), h('span', { class: 'hint' }, `match ${Math.round(r.match * 100)}%`)) };
        });
        out.append(h('p', { class: 'hint' }, `Measured on ${res[0]?.start ?? 0} s into the recording against ${nm(ref)}.`), ...rows.map(x => x.el),
          h('div', { class: 'acts' }, h('button', { class: 'btn accent', onclick: () => {
            let n = 0;
            for (const { r, apply } of rows) if (apply.checked) {
              if (r.delay_ms > 0.05) setParam(['channels', r.ch, 'delay'], Math.round(r.delay_ms * 100) / 100);
              if (r.flip) setParam(['channels', r.ch, 'phase'], !S.mixer.channels[r.ch].phase);
              n++;
            }
            toast(n ? `Aligned ${n} mic${n > 1 ? 's' : ''}. Use A/B or the channel bypass to compare.` : 'Nothing changed'); close();
          } }, 'Apply ticked')));
      } catch (e) { out.innerHTML = ''; out.append(h('p', { class: 'err' }, e.message)); }
      go.disabled = false;
    } }, 'Analyse');
    card.append(h('h3', {}, 'Align mics & check polarity'),
      h('p', { class: 'hint' }, 'Close mics hear a drum a moment before the overheads; a mic wired the other way round cancels the others. Both make the kit thin and hollow. This compares each mic with a reference on the recording.'),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Reference'), h('small', {}, 'Usually the overheads or room mic')), refSel),
      h('h4', {}, 'Check these mics'), list, out,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'), go));
  });

  // ---- find songs & sermon -> markers
  window.findSongs = () => modal(async (card, close) => {
    card.append(h('h3', {}, 'Find songs & sermon'), h('p', { class: 'hint' }, 'Looking through the recording…'));
    let secs = [];
    try { secs = await api('find-sections'); } catch (e) { card.append(h('p', { class: 'err' }, e.message)); return; }
    card.lastChild.remove();
    const mm = s => { const t = Math.round(s / (S.session?.sr || 48000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    if (!secs.length) { card.append(h('p', { class: 'hint' }, 'Nothing found. Set each channel’s instrument (and the preacher’s mic) so songs and speaking can be told apart.'), h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'))); return; }
    const rows = secs.map(sc => { const name = h('input', { value: sc.name }); const on = h('input', { type: 'checkbox', checked: true }); return { sc, name, on, el: h('div', { class: 'al-row' }, on, name, h('span', { class: 'hint' }, `${mm(sc.start)} – ${mm(sc.end)}`)) }; });
    card.append(h('p', { class: 'hint' }, 'Rename them if you like, then add them as markers. Each marker starts a section you can export on its own (Export → Each section).'), ...rows.map(r => r.el),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: () => {
        const keep = rows.filter(r => r.on.checked);
        keep.forEach((r, i) => {
          send({ t: 'edit', op: 'marker', args: { pos: r.sc.start, name: r.name.value || r.sc.name } });
          const next = keep[i + 1];
          if (!next || next.sc.start - r.sc.end > (S.session?.sr || 48000) * 2) send({ t: 'edit', op: 'marker', args: { pos: r.sc.end, name: '(gap)' } });
        });
        toast(`Added ${keep.length} section${keep.length === 1 ? '' : 's'}`); close();
      } }, 'Add as markers')));
  });

  // ---- line up with a livestream video
  window.videoAlign = () => modal((card, close) => {
    const file = h('input', { type: 'file', accept: 'video/*,audio/*,.mp4,.mov,.m4a,.mp3,.wav' });
    const bar = h('div', { class: 'progress' }, h('i')), out = h('div'), stage = h('p', { class: 'hint' });
    const listener = m => { if (document.body.contains(card) && m.progress != null) { bar.firstChild.style.width = (40 + m.progress * 60) + '%'; stage.textContent = 'Matching the sound…'; } };
    on('valign', listener);
    const go = h('button', { class: 'btn accent', onclick: () => {
      const f = file.files[0]; if (!f) return toast('Choose the video (or its audio) first', true);
      go.disabled = true; out.innerHTML = ''; stage.textContent = 'Reading the file…';
      const fd = new FormData(); fd.append('file', f, f.name);
      const x = new XMLHttpRequest();
      x.upload.onprogress = e => { if (e.lengthComputable) bar.firstChild.style.width = (e.loaded / e.total * 40) + '%'; };
      x.onload = () => {
        go.disabled = false; stage.textContent = ''; bar.firstChild.style.width = '100%';
        let r; try { r = JSON.parse(x.responseText); } catch (e) { r = { error: 'Something went wrong' }; }
        if (x.status >= 400 || r.error) { out.append(h('p', { class: 'err' }, r.error || 'Could not read that file')); return; }
        const sr = S.session?.sr || 48000, t = Math.abs(r.offset), mm = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
        out.append(h('p', {}, r.offset >= 0 ? `The video starts ${mm} into the recording.` : `The video starts ${mm} before the recording.`),
          h('p', { class: 'hint' }, r.match >= 0.15 ? 'A clear match.' : 'A weak match: check it in your video editor.'),
          h('div', { class: 'frow' }, h('button', { class: 'btn accent', onclick: async () => {
            const start = Math.round(r.offset * sr), end = start + Math.round(r.length * sr);
            await tryApi('export', { kind: 'video', fmt: 'wav', depth: '24', start, end });
            toast('Exporting the mix lined up with the video (Exports folder). Put it on the video in your editor, starting at 0.', false, 8000); close();
          } }, 'Export the mix for this video')));
      };
      x.onerror = () => { go.disabled = false; out.append(h('p', { class: 'err' }, 'Upload failed')); };
      x.open('POST', '/api/video-align'); x.send(fd);
    } }, 'Find where it starts');
    card.append(h('h3', {}, 'Line up with a video'),
      h('p', { class: 'hint' }, 'Choose the livestream recording (or any video of the service). The app finds where it starts in this recording by matching the sound, then exports your mix the same length, ready to drop onto the video.'),
      file, bar, stage, out, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Close'), go));
  });

  // ---- tempo, time signature, tap tempo
  window.tempoDialog = () => modal((card, close) => {
    const bpmIn = h('input', { type: 'number', min: 30, max: 300, step: 1, value: Math.round(+S.mixer?.tempo || 120), style: 'width:90px' });
    const ts = S.mixer?.timesig || [4, 4];
    const sig = h('select', {}, ...[[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [12, 8]].map(([a, b]) => h('option', { value: `${a}/${b}`, selected: a === ts[0] && b === ts[1] }, `${a}/${b}`)));
    const taps = [];
    const tap = h('button', { class: 'btn', onclick: () => {
      const now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
      taps.push(now); if (taps.length > 6) taps.shift();
      if (taps.length > 1) bpmIn.value = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
    } }, 'Tap');
    card.append(h('h3', {}, 'Tempo'),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Tempo (BPM)'), h('small', {}, 'Tap along to set it')), h('div', { class: 'pair', style: 'max-width:200px' }, bpmIn, tap)),
      h('div', { class: 'srow' }, h('div', { class: 'srow-l' }, h('span', {}, 'Time signature')), sig),
      h('p', { class: 'hint' }, 'Used by the metronome, count-in, snap to grid, the bars ruler and tempo-synced delays.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn accent', onclick: () => {
        setParam(['tempo'], clamp(+bpmIn.value || 120, 30, 300));
        setParam(['timesig'], sig.value.split('/').map(Number));
        close(); setTimeout(() => emit('tlstate'), 50);
      } }, 'Set')));
  });

  // ---- header: metronome, count-in, tempo chip, clock format
  const metro = h('button', { class: 'tbtn', id: 'btnMetro', title: 'Metronome (K)', onclick: () => runCmd('metronome') }, icon('metronome', 18));
  const count = h('button', { class: 'tbtn count', id: 'btnCount', title: 'Count-in before recording (⇧K)', onclick: () => runCmd('countIn') }, '1234');
  const tempo = h('button', { class: 'pill tempo', title: 'Tempo & time signature', onclick: () => tempoDialog() });
  // A/B: click to switch, or hold to hear "before" only while held (like a photo editor)
  window.setCompare = on => send({ t: 'compare', on: !!on });
  const ab = h('button', { class: 'tbtn ab', id: 'btnAB', title: 'Before / after (\\): click to switch, hold to peek. Only what you hear changes, never the stream.' }, 'A/B');
  let holdT = 0, held = false;
  ab.onpointerdown = () => { held = false; holdT = setTimeout(() => { held = true; setCompare(true); }, 300); };
  ab.onpointerup = ab.onpointerleave = e => {
    clearTimeout(holdT);
    if (held) { held = false; setCompare(false); }
    else if (e.type === 'pointerup') setCompare(!S.compare);
  };
  on('compare', () => {
    ab.classList.toggle('on', !!S.compare);
    ab.textContent = S.compare ? 'BEFORE' : 'A/B';
    document.body.classList.toggle('comparing', !!S.compare);
  });
  $('#btnLoop').after(metro, count, ab);
  // ---- service lock: the padlock freezes the mix; play / stop / record keep working
  const lockBtn = h('button', { class: 'tbtn lockb', id: 'btnLock', title: 'Service lock: freeze the mix so nothing changes by accident (⇧⌘L)', onclick: () => toggleLock() }, icon('unlock', 17));
  $('#top .status')?.prepend(lockBtn);
  window.toggleLock = async () => {
    const on = !S.info?.locked;
    let pin = '';
    if (!on) {
      if (S.info?.hasPin) { pin = prompt('Enter the PIN to unlock the mix'); if (pin === null) return; }
      else if (!confirm('Unlock the mix? Changes will be possible again.')) return;
    }
    try { await api('lock', { on, pin }); toast(on ? 'Mix locked for the service' : 'Mix unlocked'); }
    catch (e) { toast(e.message, true); }
  };
  on('info', () => {
    const lk = !!S.info?.locked;
    document.body.classList.toggle('locked', lk);
    lockBtn.classList.toggle('on', lk);
    lockBtn.innerHTML = ''; lockBtn.append(icon(lk ? 'lock' : 'unlock', 17));
  });
  $('#clock').after(tempo);
  let clockBars = false;
  try { clockBars = localStorage.getItem('stobite.clock') === 'bars'; } catch (e) { }
  $('#clock').title = 'Click to switch between time and bars.beats';
  $('#clock').onclick = () => { clockBars = !clockBars; try { localStorage.setItem('stobite.clock', clockBars ? 'bars' : 'time'); } catch (e) { } paint(); };
  function paint() {
    const c = S.info?.cfg || {};
    metro.classList.toggle('on', !!c.metronome); count.classList.toggle('on', !!c.countin);
    const ts = S.mixer?.timesig || [4, 4];
    tempo.textContent = `${Math.round(+S.mixer?.tempo || 120)} · ${ts[0]}/${ts[1]}`;
    const clock = $('#clock');
    if (S.tr.counting) clock.textContent = 'Count-in…';
    else if (clockBars && window.barsBeats) clock.textContent = barsBeats(S.tr.playhead);
  }
  on('info', paint); on('mixer', paint); on('tlstate', paint); on('transport', paint); on('meters', paint);
})();
