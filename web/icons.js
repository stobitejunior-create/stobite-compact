// Line icons (24x24, stroke = currentColor). Transport, UI and an instrument library.
const ICONS = {
  // ---- transport / ui
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  start: '<path d="M6 6v12"/><path d="M18 6.5v11L9.5 12z" fill="currentColor" stroke="none"/>',
  back: '<path d="M12 7v10L4.5 12zM20 7v10l-7.5-5z" fill="currentColor" stroke="none"/>',
  fwd: '<path d="M12 7v10l7.5-5zM4 7v10l7.5-5z" fill="currentColor" stroke="none"/>',
  loop: '<path d="M4 12a6 6 0 0 1 6-6h8"/><path d="M15 3l3 3-3 3"/><path d="M20 12a6 6 0 0 1-6 6H6"/><path d="M9 21l-3-3 3-3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  zoomin: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8.5v5M8.5 11h5"/>',
  zoomout: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11h5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevl: '<path d="M15 5l-7 7 7 7"/>', chevr: '<path d="M9 5l7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
  out: '<path d="M4 12h11M11 7l5 5-5 5"/><path d="M20 5v14"/>',
  mixer: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="11" width="4" height="3" rx="1"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  metronome: '<path d="M8.5 3h7l3.5 18H5z"/><path d="M12 16l5-9"/><path d="M7 17h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  drag: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
  split: '<path d="M12 3v18"/><path d="M5 8l-3 4 3 4M19 8l3 4-3 4"/>',
  marker: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
  import: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  export: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 19h16"/>',
  cable: '<path d="M4 7h4v4H4zM16 13h4v4h-4z"/><path d="M8 9h3a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3"/>',
  route: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6c6 0 6 6 10 6M7 18c6 0 6-6 10-6"/>',
  scene: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v5M16 5v5"/>',
  // ---- instruments & sources
  mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  mic2: '<circle cx="15.5" cy="8.5" r="4"/><path d="M12.6 11.4L5 19l1.5 1.5 7.6-7.6"/><path d="M13 6l5 5"/>',
  choir: '<circle cx="6" cy="8" r="2.2"/><circle cx="12" cy="6.5" r="2.4"/><circle cx="18" cy="8" r="2.2"/><path d="M2.5 18c0-3 1.6-5 3.5-5s3.5 2 3.5 5M8.5 18c0-4 1.6-6.5 3.5-6.5s3.5 2.5 3.5 6.5M14.5 18c0-3 1.6-5 3.5-5s3.5 2 3.5 5"/>',
  pulpit: '<path d="M5 10h14l-2.5 11h-9z"/><path d="M8 14h8"/><path d="M12 10V6.5"/><circle cx="12" cy="4.5" r="1.8"/>',
  headset: '<path d="M4.5 13v-1a7.5 7.5 0 0 1 15 0v1"/><rect x="3" y="12.5" width="3.5" height="6" rx="1.5"/><rect x="17.5" y="12.5" width="3.5" height="6" rx="1.5"/><path d="M6.5 17.5c1 2.5 3.5 3 6.5 3"/>',
  kick: '<circle cx="12" cy="11" r="8"/><circle cx="12" cy="11" r="3.2"/><path d="M6 19l-2 3M18 19l2 3"/>',
  snare: '<ellipse cx="12" cy="10" rx="8" ry="2.8"/><path d="M4 10v5.5c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8V10"/><path d="M7 3.5l3.5 5M17.5 3l-3 5.5"/>',
  tom: '<ellipse cx="12" cy="7" rx="7" ry="2.6"/><path d="M5 7v10c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V7"/><path d="M8.5 9.5v9M15.5 9.5v9"/>',
  hihat: '<path d="M3 8.5c3-1.6 15-1.6 18 0M3 11.5c3 1.6 15 1.6 18 0"/><path d="M12 3.5v5M12 12.5V21M8.5 21h7"/>',
  cymbal: '<path d="M2.5 9c4-3 15-3 19 0-4 1.6-15 1.6-19 0z"/><path d="M12 10.3V21M8 21h8"/><circle cx="12" cy="7.6" r="0.9" fill="currentColor"/>',
  room: '<path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-5h6v5"/><path d="M15.5 9.5a3 3 0 0 1 0 4M17.5 8a5.5 5.5 0 0 1 0 7"/>',
  perc: '<path d="M7 4h10l-1.5 16h-7z"/><ellipse cx="12" cy="4" rx="5" ry="1.5"/><path d="M8 9h8"/>',
  bass: '<path d="M14.5 9.5L20 4l1 1-5.5 5.5"/><path d="M15 10c-3-2-7-1-8.5 1.5S4 17 6 19s5.5 1 7.5-.5S16.5 13 14 10z"/><path d="M8.5 15.5l2-2M17.5 3.5l1 1"/>',
  eguitar: '<path d="M13.5 10.5L20 4l1 1-6.5 6.5"/><path d="M13 10.5l-2.5-1.5-2 2.5-3 .5-1.5 3 2.5 4.5 4.5 1.5 3-1.5-.5-3 2.5-2z"/><path d="M8.5 15.5l2-2"/>',
  aguitar: '<path d="M14 10l6-6 1 1-6 6"/><path d="M14.5 10.5c-1.5-2-4.5-2-5.5 0-.7 1.3-2.8.8-4 2.6-1.6 2.4.1 5.2 1.5 6.4s4 3 6.4 1.4c1.8-1.2 1.3-3.3 2.6-4 2-1 2-4-1-6.4z"/><circle cx="10" cy="15" r="1.8"/>',
  piano: '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M7 5v14M11.5 5v14M16.5 5v14"/><path d="M5.5 5v8h3V5M14 5v8h3V5" fill="currentColor"/>',
  keys: '<rect x="2.5" y="8" width="19" height="11" rx="1.5"/><path d="M6.5 8v11M10.5 8v11M14.5 8v11M18 8v11"/><circle cx="6" cy="5" r="1.2"/><circle cx="10" cy="5" r="1.2"/><path d="M14 5h6"/>',
  pad: '<path d="M2.5 14c2.5-6 4.5-6 7 0s4.5 6 7 0 3.5-5 5-3"/><path d="M2.5 9c2-3 3.5-3 5 0" opacity=".6"/>',
  organ: '<path d="M4 21V11M8 21V7M12 21V4M16 21V7M20 21V11"/><path d="M3 21h18"/><path d="M4 11h0M8 7h0M12 4h0" stroke-width="3" stroke-linecap="round"/>',
  violin: '<path d="M15 9l5.5-5.5"/><path d="M14 9.5c-1-1.6-3.4-1.8-4.6-.5-.8.9-.2 2-1.4 2.6-1.6.8-3.4 1.4-3.4 4.2 0 2.6 2.2 4.2 4.6 4.2 2.8 0 3.4-1.8 4.2-3.4.6-1.2 1.7-.6 2.6-1.4 1.3-1.2 1.1-3.6-.5-4.6z"/><path d="M8 13l3 3"/>',
  trumpet: '<path d="M3 10h11l5-4v12l-5-4H3z"/><path d="M6 14v3M9 14v3M12 14v3"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.2"/><path d="M2.5 19h19l-1.5-4h-16z"/><path d="M10 10l2-2 2 2"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  click: '<path d="M8 21h8l-1.8-16h-4.4z"/><path d="M12 15l4.5-7.5"/><circle cx="16.5" cy="7.5" r="1" fill="currentColor"/><path d="M9 17h6"/>',
  audience: '<circle cx="7" cy="8" r="2.5"/><circle cx="17" cy="8" r="2.5"/><circle cx="12" cy="11" r="2.5"/><path d="M2.5 19c0-3.5 2-5.5 4.5-5.5S11.5 15.5 11.5 19M12.5 19c0-3.5 2-5.5 4.5-5.5s4.5 2 4.5 5.5M7 21c0-3 2.2-5 5-5s5 2 5 5"/>',
  synth: '<rect x="2.5" y="7" width="19" height="12" rx="1.5"/><circle cx="7" cy="11" r="1.6"/><circle cx="12" cy="11" r="1.6"/><path d="M16 10v3M19 10v3"/><path d="M4.5 15.5h15"/>',
  bus: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="10" cy="18" r="1.5" fill="currentColor"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  fx: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  speaker: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="14" r="3.5"/><circle cx="12" cy="7" r="1.3"/>',
  input: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><circle cx="12" cy="15" r="1" fill="currentColor"/>',
};

function icon(name, size = 18, cls = '') {
  const span = document.createElement('span');
  span.className = 'ic ' + cls;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.input}</svg>`;
  return span;
}

// Instrument library picker. onPick(instrument, {preset: bool})
function pickInstrument(current, onPick) {
  const lib = (window.CATALOG && CATALOG.instruments) || [];
  modal((card, close) => {
    const grid = h('div', { class: 'inst-grid' });
    const usePreset = h('input', { type: 'checkbox', checked: true });
    const q = h('input', { placeholder: 'Search… (kick, vocal, keys)', style: 'width:100%' });
    const render = () => {
      grid.innerHTML = '';
      for (const it of lib.filter(i => i.label.toLowerCase().includes(q.value.toLowerCase()))) {
        grid.append(h('button', { class: 'inst' + (current === it.key ? ' on' : ''), style: `--c:${it.color}`, onclick: () => { close(); onPick(it, { preset: usePreset.checked }); } },
          icon(it.icon, 26), h('span', {}, it.label)));
      }
      grid.append(h('button', { class: 'inst', onclick: () => { close(); onPick(null, {}); } }, icon('close', 26), h('span', {}, 'None')));
    };
    q.oninput = render;
    card.classList.add('wide');
    card.append(h('h3', {}, 'What is on this channel?'),
      h('p', { class: 'hint' }, 'Sets the icon, name and colour, sends it to the right bus, and (optionally) loads a gentle starting preset you can adjust.'),
      q, grid,
      h('label', { class: 'chk' }, usePreset, 'Also load the starting preset and bus routing'),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: close }, 'Cancel')));
    render();
    setTimeout(() => q.focus(), 50);
  });
}
