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
    ['masterAssist', 'Mix', 'Master to target…', null, () => masterAssistant()],
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
