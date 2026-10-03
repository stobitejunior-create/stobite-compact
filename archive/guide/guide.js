// The Guide: what every part of the app does, and how to use it to mix a worship livestream.
(() => {
  const G = [
    ['start', 'The big picture', `
      <p>Stobite Compact is a <b>second mixer that sits beside your WING</b>. The WING keeps mixing the room (FOH). This app receives every channel raw over USB, records it, and builds a <b>separate broadcast mix</b> for the livestream. Nothing you do here changes the WING or the room sound.</p>
      <div class="gflow"><span>WING inputs</span>→<span>Channel strip</span>→<span>Group bus</span>→<span>Music / Vocal / Speech / FX</span>→<span>Broadcast</span>→<span>Master</span>→<span>Stream</span></div>
      <p><b>Work through it in that order.</b> First get each channel sounding right on its own (filter, EQ, dynamics). Then balance the groups. Then shape the overall broadcast. Finally, check loudness on the Master tab.</p>
      <ul><li><b>Edit</b>: record, play back and edit the multitrack, and draw automation.</li>
      <li><b>Mixer</b>: channel strips, buses, FX returns and master, with layers across the top.</li>
      <li><b>Routing</b>: a map of where every signal goes. Change any arrow to re-route.</li>
      <li><b>Master</b>: loudness (LUFS), true peak, spectrum, stereo checks and the final chain.</li>
      <li><b>Setup</b>: audio interface, outputs, virtual cables, the phone remote and the guide to connecting the WING.</li></ul>
      <p>On a Mac, closing the window only hides it (like Notes): recording and audio keep running. Click the Dock icon to bring it back; Quit (⌘Q) saves and exits.</p>`],
    ['input', 'Inputs, raw recording and channel order', `
      <p>One USB cable from the WING carries up to 48 channels. Each channel strip has an <b>Input</b> (WING USB 1–48 or a virtual cable). Change it to point any strip at any input, and drag strips to reorder them. The WING never changes.</p>
      <p><b>Other microphones:</b> a channel's Input menu also lists every other microphone or interface the computer can see (built-in mic, USB mic, webcam, a second interface), marked 🎤. Each is opened only while a channel uses it. It runs on its own clock, so it is great for an extra ambience or backup mic, but keep the main sources on the WING.</p>
      <p><b>Recording is always raw.</b> The app writes each channel's input to disk <i>before</i> trim, EQ, dynamics or faders. You can always go back and remix from untouched audio. To keep the WING's own faders out of it, set its USB outputs to send the channel <b>direct outs pre-fader</b> (Setup has the steps).</p>
      <p><b>Copy names from the WING</b> (Setup) reads the console's channel names and colours over the network. It only reads; it never sends anything back.</p>
      <p><b>Gain / trim</b> is the first knob a signal meets. Aim for channel peaks around −18 to −10 dBFS. Healthy level here makes every processor after it behave predictably.</p>`],
    ['hpf', 'Low cut / high cut (and why they matter so much)', `
      <p>A <b>low cut</b> (high-pass filter) removes rumble below a frequency. Most sources make low-frequency energy you don't need: stage thump, breath pops, room boom, amp rumble. Across 20 mics it builds into a muddy, boomy mix that eats the limiter's headroom.</p>
      <p><b>The rule:</b> the bottom octave belongs to kick and bass. Cut everything else. Typical starting points:</p>
      <table class="gt"><tr><td>Lead vocal</td><td>90–120 Hz</td></tr><tr><td>Backing vocals</td><td>120–160 Hz</td></tr><tr><td>Preaching mic</td><td>100–140 Hz</td></tr><tr><td>Acoustic guitar</td><td>100–150 Hz</td></tr><tr><td>Electric guitar</td><td>80–120 Hz</td></tr><tr><td>Keys / pads</td><td>80–200 Hz</td></tr><tr><td>Overheads</td><td>150–300 Hz</td></tr><tr><td>Kick / bass</td><td>30–40 Hz (rumble only)</td></tr></table>
      <p>Sweep the low cut up until the source starts to thin out, then back off a little. <b>Slope:</b> 12 dB/oct is gentle, 24 is standard, 48 is surgical.</p>
      <p>A <b>high cut</b> (low-pass) tames fizz and hiss above a frequency. It's useful on electric guitar (10–12 kHz), bass and kick bleed.</p>`],
    ['eq', 'Parametric EQ', `
      <p>EQ boosts or cuts frequency ranges. <b>Freq</b> picks where, <b>Gain</b> how much, and <b>Q</b> how wide (low Q = broad and musical, high Q = narrow and surgical). Drag the dots on the graph, scroll over a dot to change its width, and double-click to reset. The blue haze behind the curve is the live sound of that channel.</p>
      <p><b>Band types:</b> Bell (a hill or dip), Low/High shelf (tilts everything below/above), Notch (kills one frequency, e.g. a ring), and High/Low-pass (an extra cut filter, with slope).</p>
      <p><b>A frequency map for worship:</b></p>
      <table class="gt"><tr><td>40–80 Hz</td><td>weight: kick and bass only</td></tr><tr><td>200–400 Hz</td><td>mud and boxiness: the most common cut</td></tr><tr><td>500 Hz–1 kHz</td><td>honk and nasal tones</td></tr><tr><td>2–5 kHz</td><td>presence and intelligibility: vocals live here</td></tr><tr><td>5–8 kHz</td><td>sibilance and harshness</td></tr><tr><td>10–16 kHz</td><td>air and sparkle</td></tr></table>
      <p><b>Cut before you boost.</b> Make narrow cuts and broad, gentle boosts (1–3 dB). If you're boosting more than 6 dB, the problem is usually the mic, its position or the source. To make the vocal sit on top, cut a little 2–4 kHz from guitars and keys instead of boosting the vocal more.</p>`],
    ['gate', 'Gate / expander', `
      <p>A gate turns a channel down when it falls below the <b>Threshold</b>. It cleans up spill: snare and tom mics hearing the rest of the kit, or a pastor's mic hearing the band.</p>
      <ul><li><b>Range</b>: how much it turns down. 6–15 dB is an <i>expander</i> (gentle and natural). 30+ dB is a hard gate.</li><li><b>Attack</b>: how fast it opens. Keep it short (0.5–2 ms) for drums.</li><li><b>Release</b>: how fast it closes. Long enough for the drum to ring naturally (100–300 ms).</li></ul>
      <p>On a preaching mic, use a gentle expander (about 12 dB range) instead of a hard gate, so the start of words isn't chopped off.</p>`],
    ['comp', 'Compressor', `
      <p>A compressor turns loud moments down so the level stays steady. That makes a vocal sit in the same place in the mix whether it's whispered or belted.</p>
      <ul><li><b>Threshold</b>: the level where it starts working. Lower = more compression.</li>
      <li><b>Ratio</b>: how hard. 2:1 is gentle glue; 3–5:1 is typical for vocals; 8:1+ is heavy.</li>
      <li><b>Attack</b>: how quickly it grabs. Slower (10–30 ms) lets transients punch through; faster smooths them.</li>
      <li><b>Release</b>: how quickly it lets go. 100–250 ms is musical for most sources.</li>
      <li><b>Knee</b>: how gradually it starts. Soft (6–10 dB) is smoother.</li>
      <li><b>Makeup</b>: adds level back after compression.</li>
      <li><b>Mix</b>: below 100% is <b>parallel compression</b>, which blends untouched signal back in. You get density and sustain without flattening the dynamics. It's great on the drum bus.</li>
      <li><b>Max GR</b>: caps how much it can ever turn down.</li></ul>
      <p><b>Watch the orange gain-reduction bar.</b> A lead vocal typically wants 3–6 dB on loud phrases; bus compressors 1–3 dB. If the bar never relaxes, you're over-compressing.</p>
      <p>On buses, <b>Sidechain from</b> lets another source drive the compressor (see Ducking).</p>`],
    ['deess', 'De-esser', `
      <p>Tames harsh <i>s</i>, <i>sh</i> and <i>t</i> sounds. It listens only above the <b>Frequency</b> (5–8 kHz for most voices) and turns the voice down briefly when sibilance crosses the <b>Threshold</b>. Use it on every vocal and the preaching mic. Brightening EQ and compression both make sibilance worse, so set the de-esser after them.</p>
      <p>Aim for 3–6 dB of reduction on the worst "s" sounds. More than that makes the singer sound lispy.</p>`],
    ['dyneq', 'Dynamic EQ', `
      <p>An EQ band that only moves when its frequency range gets loud. It's the cleanest way to fix problems that come and go:</p>
      <ul><li><b>Harshness</b>: a band at 2.5–4 kHz cuts only on the loud, shouty notes.</li><li><b>Mud</b>: 200–350 Hz cuts when the band builds up and stays open when it's sparse.</li><li><b>Boomy bass notes</b>: 80–150 Hz, so one note doesn't jump out.</li><li><b>Presence</b>: a positive range lifts the vocal only when it's being covered.</li></ul>
      <p><b>Range</b> is how far it moves (negative = cut, positive = boost). <b>Static</b> is a fixed boost or cut that's always there. Threshold, Attack and Release work like a compressor. On buses you can drive it from a <b>sidechain</b>: for example, the Music bus can dip 2–4 kHz only while the Lead Vocal sings, making room for the words.</p>`],
    ['tune', 'Auto-tune (pitch correction)', `
      <p>Auto-tune listens to a vocal, works out which note is being sung, and gently pulls it to the nearest note in the <b>song's key</b>.</p>
      <ul><li><b>Song key / scale</b>: set this for each song (it's shared by all tuned channels). If the key is wrong, it will pull singers to the wrong notes.</li>
      <li><b>Retune speed</b>: how quickly a note is pulled into tune. 60–120 ms is natural and keeps slides and vibrato. 20–40 ms sounds polished and modern. 0 ms is the hard, robotic “auto-tune effect”.</li>
      <li><b>Amount</b>: how much of the way to correct. 50–70% leaves the human character in.</li>
      <li><b>Voice</b>: limits the detection range so it doesn't get confused by the band bleeding into the mic.</li>
      <li><b>Notes: any note</b> corrects to the nearest semitone when you don't know the key.</li></ul>
      <p>The readout shows the note and how far off it was: green means within 10 cents, yellow within 25, red further. It only affects the broadcast; recordings stay raw, so you can decide later. Use it on lead and backing vocals, never on instruments or speech.</p>`],
    ['trans', 'Transient shaper', `
      <p>Changes the <b>attack</b> (the initial hit) and <b>sustain</b> (the ring after it) without compression. +Attack gives a kick or snare more click and punch. −Sustain tightens boomy toms and roomy drums. Small amounts (±2–4 dB) go a long way.</p>`],
    ['sat', 'Saturation', `
      <p>Adds gentle harmonics, the "warmth" and density of analogue gear. It makes sources feel fuller and more present at the same level, and helps small speakers (phones and laptops are where most people hear your stream) reproduce bass.</p>
      <ul><li><b>Tape</b>: smooth and rounded, glues things together.</li><li><b>Tube</b>: warm with even harmonics, lovely on vocals and bass.</li><li><b>Console</b>: subtle grit and density, good on buses.</li><li><b>Soft clip</b>: clean until the very top, then rounds peaks off.</li></ul>
      <p>Use <b>Mix</b> to blend it in. If you can clearly hear distortion, it's too much.</p>`],
    ['sends', 'Sends and FX returns', `
      <p>Instead of a reverb on every channel, all channels share a few effects. Each channel <b>sends</b> some of its signal to an effect, and the effect's output (the <b>return</b>) comes back into the mix through the FX bus. It saves CPU and puts everyone in the same "room".</p>
      <ul><li><b>Vocal Plate</b>: short and bright, keeps the lead vocal present and up-front.</li><li><b>Vocal Hall</b>: big and spacious, the worship ambience. Backing vocals get more of this than the lead.</li><li><b>Instrument Verb</b>: a room for guitars, keys and snare.</li><li><b>Delay</b>: tempo-synced echoes, ducked by the lead vocal.</li></ul>`],
    ['reverb', 'Reverb', `
      <ul><li><b>Pre-delay</b>: a gap before the reverb starts. 20–60 ms keeps the vocal clear in front of its own space.</li><li><b>Decay</b>: how long the tail lasts.</li><li><b>Size</b>: how big the room feels (spacing of the early reflections).</li><li><b>Damping</b>: darkens the tail over time, like soft surfaces.</li><li><b>Width</b>: stereo spread.</li><li><b>Early reflections</b>: the first bounces off nearby walls. They give depth and placement.</li><li><b>Low cut / high cut</b>: the return's EQ. Cutting lows (200–400 Hz) keeps reverb from muddying the mix; cutting highs (6–9 kHz) stops it sounding splashy.</li></ul>
      <p><b>The big worship sound</b> is mostly long, bright-but-filtered halls on backing vocals and pads, plus a shorter plate and delay on the lead. Turn the reverb up until you can just hear it, then back it off a touch. If you can clearly hear the reverb on its own, it's too loud.</p>`],
    ['delay', 'Delay', `
      <p>Echoes timed to the song. Set the <b>tempo</b> (type it or tap it) and pick a note value: <b>1/4</b> (one per beat), <b>1/8</b>, <b>dotted 1/8</b> (the classic worship guitar and vocal delay), <b>1/2</b>, or set a time in ms with sync off.</p>
      <ul><li><b>Feedback</b>: how many repeats.</li><li><b>Low/high cut</b>: filtered repeats sit behind the dry voice instead of competing.</li><li><b>Ping-pong</b>: repeats bounce left and right.</li><li><b>Width</b>: stereo spread.</li></ul>
      <p>It's <b>ducked by the Lead Vocal</b> by default: the delay stays quiet while the vocalist sings and swells up in the gaps at the end of each line.</p>`],
    ['duck', 'Ducking and sidechain', `
      <p>Ducking turns one thing down automatically while another is active. You pick the <b>source</b> (a channel or bus) under “Duck when”:</p>
      <ul><li><b>Music bus ducked by the Lead Vocal</b>, 1–2 dB: the band politely steps back when the singer comes in.</li><li><b>Music bus ducked by Preaching</b>, 3–6 dB: a pad under the pastor never covers the words.</li><li><b>Delay or reverb ducked by the Lead Vocal</b>: clear while singing, lush in the gaps.</li></ul>
      <p><b>Threshold</b> is how loud the source must be, <b>Max duck</b> how far to go down, and <b>Attack / Release</b> how quickly it dips and recovers (a slow release of 300–600 ms sounds natural). Bus compressors and dynamic EQs can use a sidechain too.</p>`],
    ['buses', 'Buses (groups)', `
      <p>A bus is a sub-mix. Channels go to group buses (Drums, Bass, Guitars, Keys, Lead Vocal, Backing Vocals, Preaching). Those feed bigger buses: Music, then Broadcast, then Master. On the way you can:</p>
      <ul><li>ride a whole section with one fader (e.g. all backing vocals),</li><li>process it as a unit: <b>drum bus</b> compression with parallel mix for punch, gentle <b>music bus</b> glue, a <b>vocal bus</b> for consistency and air,</li><li>duck the music under vocals and speech.</li></ul>
      <p>Each bus has filters, EQ, compressor, saturation, dynamic EQ, multiband, width/balance, limiter, ducking, sends and plug-ins. You can choose the <b>processing order</b> and bypass anything instantly. The Routing tab shows the whole tree.</p>
      <p><b>Broadcast</b> is the livestream mix: everything ends up here, and it stays fully independent of the WING's room mix.</p>`],
    ['mbc', 'Multiband compressor', `
      <p>Splits the sound into low, mid and high bands and compresses each separately. The bass can be controlled without the vocals pumping, and harsh cymbals can be tamed without dulling the whole mix. Set the two <b>split</b> frequencies, then give each band its own threshold, ratio, attack, release, <b>range</b> (maximum gain reduction) and makeup gain.</p>
      <p>On the Broadcast bus, use it gently: 1–3 dB of reduction per band at most. Its job is consistency, not loudness.</p>`],
    ['limiter', 'Limiter and true peak', `
      <p>The final safety net that stops the stream clipping.</p>
      <ul><li><b>Ceiling</b>: the absolute maximum output. Use −1 dB for streaming.</li><li><b>Threshold</b>: lowering it pushes the mix harder into the limiter (louder, but more squashed).</li><li><b>Lookahead</b>: it sees peaks coming (adds about 1.5 ms of delay) so it can catch them transparently.</li><li><b>Release</b>: how quickly it recovers.</li><li><b>True peak</b>: measures between the samples. That's how YouTube and Facebook measure, and why a −0.1 dB peak can still distort after encoding.</li></ul>
      <p><b>The rule:</b> a limiter that's constantly working 4+ dB is crushing your dynamics. Get loudness from good balance and gentle bus compression, and let the limiter only kiss the peaks.</p>`],
    ['loudness', 'Loudness: LUFS, true peak, loudness range', `
      <p><b>LUFS</b> measures loudness the way ears hear it, not just peaks. Platforms turn loud streams down to their target, so making it louder doesn't win; it just costs dynamics.</p>
      <ul><li><b>Momentary</b> (0.4 s): the moment-to-moment reading.</li><li><b>Short-term</b> (3 s): what to watch while mixing.</li><li><b>Integrated</b>: the average over the whole service. This is the number platforms use.</li><li><b>True peak</b>: the loudest point between samples. Keep it at or below −1 dBTP.</li><li><b>Loudness range (LRA)</b>: how much the loudness varies. 6–12 LU feels dynamic and alive; under 4 LU is squashed.</li></ul>
      <p><b>Targets:</b> church livestreams sit well around <b>−14 LUFS integrated</b> (YouTube's level). Go to −12 to −10 if your worship needs more energy on phone speakers, but keep true peak at −1 dBTP. The Master tab's export can hit the target exactly.</p>`],
    ['stereo', 'Stereo image and mono compatibility', `
      <p><b>Width</b> spreads or narrows a bus; <b>Balance</b> shifts it left or right. Keep kick, bass, lead vocal and preaching in the <b>centre</b>. Spread guitars, keys, pads and backing vocals out to the sides.</p>
      <p>The <b>correlation meter</b> shows how mono-safe the mix is. Near +1 is solid. Around 0 is very wide. <b>Below 0</b> means parts will cancel on a mono phone speaker. If you get a warning, reduce width or check for a channel with its polarity flipped.</p>
      <p>Use the Master tab's <b>Mono</b> button to hear what a phone hears, and <b>Side</b> to hear only the stereo edges. These checks only affect the monitor output if you've set separate monitor outputs in Setup.</p>`],
    ['automation', 'Automation', `
      <p>Automation records moves over time so the mix performs itself on playback. Every channel, bus, FX return and the master has an <b>A</b> button:</p>
      <ul><li><b>Off</b>: ignores automation.</li><li><b>Read</b> (green): plays back the moves; the faders move by themselves.</li><li><b>Touch</b> (yellow): while playing, any fader, pan, mute, send, FX level, ducking or plug-in move you make is recorded. Let go and it returns to what was recorded.</li></ul>
      <p>In the Edit view choose <b>Automation: Volume / Pan / Mute / Send</b> to see and draw the curves. Click to add a point, drag to move it, and Alt-click to delete it. Use it for intentional transitions: lifting the hall send into a bridge, pulling the band down for prayer, opening the delay on the last chorus.</p>`],
    ['scenes', 'Scenes', `
      <p>A scene is a snapshot of the mixer, e.g. <i>Pre-Service, Worship, Worship Quiet, Prayer, Preaching, Altar Call, Closing</i>. Saved scenes appear as quick buttons along the top of the Mixer.</p>
      <p><b>Recall changes</b> controls what a recall touches: faders, mutes, EQ, dynamics, sends, FX or routing. For example, you can recall just faders and mutes when moving from Worship to Preaching, without undoing an EQ fix you made five minutes ago. <b>Recall-safe</b> channels are never changed by scenes, which is perfect for the preaching mic you're riding by hand.</p>`],
    ['chain', 'Processing chains (and why order matters)', `
      <p>Every channel, bus and the master has a <b>processing chain</b>: a list of processors the sound passes through, top to bottom. You build it yourself: <b>+ Add a processor</b> (EQ, compressor, gate, de-esser, dynamic EQ, transient shaper, saturation, auto-tune, plug-ins; on buses also multiband, width and limiter). Use any processor more than once: two gentle compressors often sound smoother than one hard one.</p>
      <p>The numbered list shows the order. <b>Drag</b> (or use ↑ ↓) to reorder, <b>ON/OFF</b> bypasses one instantly, ⧉ duplicates, ✕ removes. The badges on each mixer strip show the chain in order too.</p>
      <p><b>Order changes the sound:</b> an EQ cut <i>before</i> a compressor changes what the compressor reacts to; the same cut <i>after</i> it just turns that range down. Common orders: vocal = EQ (cuts) → compressor → de-esser → EQ (air) → saturation; drums = gate → EQ → compressor → saturation; master = EQ → glue compressor → saturation → multiband → width → limiter. Keep a limiter last.</p>`],
    ['carry', 'Taking a service home, and back to church', `
      <ol><li><b>At church:</b> record the service. Edit → Export → <b>Project file</b> makes one <i>.stobite</i> file with every recording, edit, marker, automation and the whole mix. Copy it to a USB stick or cloud drive.</li>
      <li><b>At home:</b> Edit → Import (or drag the file onto the timeline, or Setup → Open a project file). Everything appears exactly as it was.</li>
      <li><b>Mix it</b> until it sounds great.</li>
      <li><b>Save the sound:</b> Mixer → <b>Mix settings</b> → Save. You get a folder with one file per channel (e.g. <i>03 Piano.stobite-channel</i>) and one for the buses, effects and master. Each channel file is also added to your sound library.</li>
      <li><b>Back at church:</b> Mix settings → Apply (or From a folder…). Each saved channel is matched to the live channel with the same name (then the same instrument, then the same position); check the matches, choose what to take (chains, sends, routing, names, levels, buses/effects/master), and Apply. The piano gets everything you did at home, live.</li></ol>
      <p><b>One channel at a time:</b> in any channel's editor, <b>Save this sound…</b> stores just that channel (e.g. “Piano – warm”), and <b>Load a sound…</b> puts a saved sound on any channel. Your favourite piano sound then works on any piano, on any computer.</p>`],
    ['remote', 'The phone remote and the network', `
      <p>The app's window talks to its audio engine through a small server inside the app. With <b>Phone remote</b> off (Setup), that server only answers this computer, so nothing on the network can see it. Turn it on to mix from a phone or tablet on the same Wi-Fi, and set a PIN if guests use the Wi-Fi.</p>`],
    ['inserts', 'Plug-ins (inserts)', `<p>Add your own VST3 or Audio Unit plug-ins to any channel, bus or the master. Their settings appear as sliders, can be bypassed instantly, and can be automated in Touch mode.</p>`],
    ['edit', 'Recording and editing', `
      <ul><li>Arm tracks with <b>R</b> on each track (or <b>Arm all</b>) and press record. Every armed channel records its raw input to its own 24-bit WAV.</li><li><b>Split</b> (S), <b>Blade</b> tool (B), and drag clip edges to trim. Drag the yellow squares on a selected clip to fade it.</li><li><b>Range</b> tool (G): drag across tracks, then Delete with <b>Ripple</b> on to remove a section from every track and close the gap (cutting out the offering, for example).</li><li>Drag audio files from Finder or Explorer onto the timeline to import them.</li><li><b>Loop</b> (L) a section to dial in a mix while it repeats.</li><li><b>Export</b>: a stereo mix with loudness targeting, or separate tracks to open in Logic, Pro Tools or Cubase.</li></ul>`],
    ['cables', 'Virtual cables', `
      <p>Four stereo cables that work like a VB-Cable. Route any source (the Master, a bus, a channel) <i>into</i> a cable, and it's available as an <i>input</i> on any channel, both "speaker" and "microphone". Uses: an alternative mix as a separate feed, a click/cue mix, or resampling a bus.</p>
      <p>To send a cable to <b>other apps</b> (OBS, Zoom, YouTube Studio), attach a system loopback device in Setup: <b>BlackHole 16ch</b> on Mac (cable 1 = channels 1–2, cable 2 = 3–4…) or <b>VB-Audio Virtual Cable</b> on Windows. In OBS, add that device as an audio input.</p>`],
    ['recipe', 'Recipe: a big, polished worship broadcast', `
      <ol>
      <li><b>Name and route.</b> Click each channel's icon and pick the instrument. This loads a gentle preset and sends it to the right bus.</li>
      <li><b>Gain.</b> Get every input peaking −18 to −10 dBFS.</li>
      <li><b>Low cuts everywhere</b> except kick and bass.</li>
      <li><b>Lead vocal first.</b> Clean up 250–400 Hz, add presence around 3 kHz and air at 12 kHz. Compress 4:1 with 3–6 dB of reduction, de-ess, add a touch of tube, send a little to the plate and the delay.</li>
      <li><b>Build the band around it:</b> kick and bass for weight, then keys/pads wide and filtered, guitars in the sides with a 2–4 kHz dip so the vocal owns that range, backing vocals wider and wetter than the lead.</li>
      <li><b>Drum bus:</b> 4:1 at 50% mix for punch, light tape saturation.</li>
      <li><b>Music bus:</b> gentle 1.5:1 glue (1–2 dB), duck 1–2 dB from the Lead Vocal bus.</li>
      <li><b>Reverb:</b> long hall on BGVs and pads, plate on the lead. Return EQ cutting below 250 Hz and above 8 kHz.</li>
      <li><b>Broadcast bus:</b> load “Broadcast Bus”. Watch the multiband and limiter: 1–3 dB each, no more.</li>
      <li><b>Master:</b> target −14 LUFS short-term on the loudest choruses, true peak ≤ −1 dBTP, LRA above 6 LU.</li>
      <li><b>Check mono and phone speakers.</b> If the vocal disappears in mono, reduce width.</li>
      <li><b>Save scenes</b> for Worship and Preaching, and use automation for the moments that matter.</li></ol>
      <p><b>Less is more:</b> if something sounds processed, back everything off by half. Clarity, dynamics and a confident lead vocal are what make the big broadcast sound.</p>`],
    ['preach', 'Recipe: preaching', `
      <p>Preaching mic → <b>Preaching</b> bus → Broadcast. Load the <i>Preaching Mic</i> preset:</p>
      <ul><li>Low cut 100–140 Hz (removes stage thump and proximity boom).</li><li>Cut 200–400 Hz (mud) and lift 2.5–4 kHz (intelligibility).</li><li>De-ess at about 6 kHz.</li><li>Compress 3–4:1 so whispers and shouts both land, with a gentle expander for room noise.</li><li>The Preaching bus limiter catches shouts.</li></ul>
      <p>Turn on <b>Music bus ducking from the Preaching bus</b> so worship pads under the sermon always sit underneath the words.</p>`],
  ];

  function render(focus) {
    const box = $('#guide'); box.innerHTML = '';
    const nav = h('nav', { class: 'gnav' }, ...G.map(([id, title]) => h('a', { href: '#g-' + id, onclick: e => { e.preventDefault(); $('#g-' + id).scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, title)));
    const body = h('div', { class: 'gbody' }, h('h2', {}, 'Guide'), h('p', { class: 'hint' }, 'What every part of Stobite Compact does, plus practical recipes for worship and preaching broadcasts. The “?” buttons in the editor jump straight to the matching section.'));
    for (const [id, title, html] of G) { const sec = h('section', { id: 'g-' + id, class: 'gsec' }, h('h3', {}, title)); sec.insertAdjacentHTML('beforeend', html); body.append(sec); }
    box.append(nav, body);
    if (focus) requestAnimationFrame(() => { const el = $('#g-' + focus); if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } });
  }
  window.openGuide = topic => { $('#editor').hidden = true; showView('guide'); render(topic); };
  on('view', v => { if (v === 'guide' && !$('#guide').children.length) render(); });
})();
