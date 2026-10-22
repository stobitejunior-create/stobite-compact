# Stobite Compact: how everything works

What every part of the app does, how it works inside, and where the code for it lives.
Each feature is described the same way:

- **What it does** (plain words, what you hear or see)
- **How it works** (the idea behind it)
- **Code** (file, class or function, so you can find it)

Paths are relative to the project folder `~/Developer/Stobite Compact`.
Audio is processed in blocks of 256 samples (about 5 ms at 48 kHz) unless noted.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [Folder map](#2-folder-map)
3. [The audio path, step by step](#3-the-audio-path-step-by-step)
4. [A channel strip](#4-a-channel-strip)
5. [Every processor in a chain](#5-every-processor-in-a-chain)
6. [Buses, FX returns, ducking, master, cables](#6-buses-fx-returns-ducking-master-cables)
7. [Metering and loudness](#7-metering-and-loudness)
8. [Recording](#8-recording)
9. [Playback, the timeline and editing](#9-playback-the-timeline-and-editing)
10. [Automation](#10-automation)
11. [Exporting](#11-exporting)
12. [After the service: songs, alignment, video, mastering](#12-after-the-service-songs-alignment-video-mastering)
13. [Listening: headphones, stream, before/after](#13-listening-headphones-stream-beforeafter)
14. [Devices, inputs and virtual cables](#14-devices-inputs-and-virtual-cables)
15. [Safety features](#15-safety-features)
16. [The WING console remote](#16-the-wing-console-remote)
17. [Projects, presets, templates, scenes](#17-projects-presets-templates-scenes)
18. [The server and phone remote](#18-the-server-and-phone-remote)
19. [The user interface, file by file](#19-the-user-interface-file-by-file)
20. [Building, releasing and testing](#20-building-releasing-and-testing)
21. [Glossary](#21-glossary)

---

## 1. The big picture

Stobite Compact is a **separate broadcast mix** for the livestream and for recording a service. It is *not* the mix the room hears: the WING console does that. The app reads the WING's 48 USB channels, records them untouched, mixes them again with its own processing, and sends that mix to the stream (OBS/Zoom), your headphones and the exports.

```
 WING Compact (48 USB channels) ──USB──►  Audio engine (Python)  ──►  stream out (OBS / Zoom via a virtual cable)
        ▲                                   │  raw copy ──► recorder (WAV files)         headphones / speakers
        │ (nothing goes back unless          │  mixer: channels → buses → master          exports (WAV/MP3/...)
        │  "Send mix to the WING" is on)     ▼
                                       Web server (aiohttp) ◄──WebSocket──► UI (pywebview window, or a phone browser)
```

Three layers:

| Layer | Language | What it does |
|---|---|---|
| **Engine** (`stobite/`) | Python: numpy, scipy, sounddevice, pedalboard, soundfile | Real-time audio, mixing, recording, playback, export |
| **Server** (`stobite/server.py`) | Python: aiohttp | Holds the one shared "state", serves the UI, talks to every window and phone over a WebSocket |
| **UI** (`web/`) | Plain JavaScript, HTML, CSS (no framework) | Everything you see. The same files run in the Mac/Windows window and in a phone browser |

**One source of truth.** The whole mix is a single data object (`Mixer.state`: channels, buses, FX, master, tempo...). The UI changes it with small messages like "set `channels/3/fader` to -6". The server applies it to the engine, then tells every other window. Saving a project writes this object to `session.json`.

**Threads.** The audio callback (PortAudio) must never wait. Everything slow (reading files, building waveforms, exporting, scanning devices, the feedback check) runs on other threads. The callback only does numpy maths on blocks.

---

## 2. Folder map

```
run.py                     starts the engine + server, opens the app window, builds the Mac/Windows menu bar
stobite/
  engine.py                audio devices, the audio callback, transport, recording, export, config
  mixer.py                 the mixing engine: state, routing matrix, channels → buses → master
  chain.py                 processing chains: the list of modules on a strip, and how they run
  dsp.py                   low-level DSP: filters, compressor maths, limiter, loudness (LUFS), true peak
  procs.py                 higher-level processors: saturation, transient, dynamic EQ, multiband, limiter, reverb, delay, ducker
  effects.py               the "effect" modules: trigger, rider, bass, proximity, denoise, reverb, delay, chorus...
  autotune.py              pitch detection (YIN) and the pitch shifter used by auto-tune
  session.py               projects on disk: clips, edits, undo, recording, reading audio back
  server.py                web server, WebSocket messages, every /api/ route
  catalog.py               instrument list, starting presets for channels and buses
  templates.py             the "Worship: Big & Polished" template
  mastering.py             "Master to target": analyses and sets the master chain
  postservice.py           find songs/sermon, MP3 tags, line up with a video
  align.py                 mic time-alignment and polarity check
  guard.py                 feedback (loop) detector
  hpcorrect.py + headphones.json   headphone correction (AutoEq presets)
  listen.py                playing the mix on the computer's own speakers/headphones
  cables.py                four internal/virtual audio cables
  inputs.py                extra input devices (any microphone the computer sees)
  wing.py                  remote control of the WING console (OSC over the network)
  portable.py              project files, channel files, mix folders you carry between computers
web/
  index.html  style.css    the page and every style (dark and light themes)
  app.js                   shared state, WebSocket, transport, views, shortcuts
  widgets.js               knobs, faders, meters, the EQ curve drawing
  mixer.js                 mixer view and the channel editor (all the processor panels)
  timeline.js              the Edit view: waveforms, clips, export dialog
  master.js                Master view: loudness, spectrum, master chain
  routing.js               Routing map
  setup.js                 Setup pages
  console.js               WING console page
  home.js                  the welcome / project screen
  commands.js              every command: shortcuts, menus, right-click menus
  icons.js                 icon set and the instrument picker
scripts/update-compact.sh  "rebuild-compact": build, publish
build_mac.sh, build_windows.bat, Stobite Compact.spec, installer/windows.iss   packaging
```

Your data lives in `~/Stobite Compact/` (change with the `STOBITE_HOME` environment variable):
`Sessions/` (projects), `Presets/` (saved channel sounds and mixes), `Scenes/`, `Exports/`, `Samples/` (your drum samples), `config.json`.

---

## 3. The audio path, step by step

One block of audio goes through `Engine._callback` (`stobite/engine.py`), then `Mixer.process` (`stobite/mixer.py`). In order:

1. **Cables in.** The four internal cables return what was routed to them last block (`CableIO.exchange`, `cables.py`).
2. **Raw input.** `Mixer.route_inputs` picks, for every channel, the column it listens to: a WING USB input, a cable, or another device's channel. This is the **raw, untouched** audio. It is what gets recorded.
3. **Tuner tap.** If the tuner is open, the chosen channel's raw audio is copied into a buffer for it.
4. **Recording.** If recording, the raw block is pushed to the recorder queue (`Recorder.push`).
5. **Source for the mix.**
   - Playing back: the block comes from the `Feeder` (the timeline rendered ahead on another thread). Channels that have no recorded audio stay live (so a mic or cable still works during playback).
   - Otherwise: the raw inputs (if "Live monitoring" is on or you are recording), or silence.
6. **Idle sleep.** If nothing is playing or recording, every input is silent, and the mix has rung out for 3 seconds, the engine goes to sleep and does almost no work (it wakes the instant any input passes -70 dBFS).
7. **Mixer.** `Mixer.process`:
   1. Apply automation (faders, pans, mutes, master) for this position.
   2. Apply DCA group offsets.
   3. Gain (trim) and polarity flip.
   4. **Each channel's chain** (`ChannelChains.process`): the modules in the order you set.
   5. Bypassed channels are put back to their unprocessed sound.
   6. Delay compensation and any per-channel align delay.
   7. Fader, pan, mute, solo → routed by a matrix into destination buses.
   8. Sends to the FX returns (reverbs, delay).
   9. Buses, children first: each bus's chain, ducking, bus fader, then into its parent.
   10. Master: chain, master fader, safety clip, loudness measurement.
   11. Cables out (master, a bus or a channel routed to a cable).
8. **Feedback guard.** The master and the raw inputs are fed to the loop detector. If it trips, all outputs go silent.
9. **Outputs.**
   - Stream output gets the finished master (never the metronome or before/after).
   - "Hear" path: before/after compare, then headphone correction, then the metronome click, then your headphones/speakers or monitor outputs.
   - The WING gets nothing back unless "Send the mix back into the WING" is on.
10. **Move the playhead on** by one block (and wrap it round a loop).

**Silence skipping** keeps the CPU low: a channel silent for half a second skips its filters, a silent bus (1.5 s) or master is skipped entirely, an FX return that was sent nothing for 8 s is skipped.

---

## 4. A channel strip

Each of the 48 channels has: a name, colour, icon, instrument type, an input, a destination bus, **Gain**, **polarity**, **align delay**, a **processing chain**, pan, fader, mute, solo, bypass, four FX sends, and an optional stereo-pair link.
Code: `default_strip` in `mixer.py`; settings are plain data in `Mixer.state["channels"][n]`.

### Choosing an instrument adds nothing
Picking an instrument (kick, vocal...) only sets the **icon and colour**. It does not touch the chain, routing or name. The picker has an optional box, **"Also load a starting preset and bus routing"**, which is off by default; only when you tick it does it name the channel, send it to its group bus and load the starting preset. A new channel starts with an empty EQ (flat) and an off compressor, nothing else.
Code: `pickFor` in `web/mixer.js`, `pickInstrument` in `web/icons.js`, presets in `stobite/catalog.py`.

### Your own channel names
Type any label: double-click the name on a mixer strip (Enter saves, Esc cancels, empty goes back to "Ch 5"), or edit the name at the top of the channel window, or in the track list of the Edit view. The name is just text in `channels[n].name`; recordings and exports use it for file names.
Code: `renameChannel` in `web/mixer.js`.

### Input
Which signal the channel listens to: a WING USB input (`in:0`...), a virtual cable (`cable:0`...), or any microphone the computer has (`dev:Name (API)|channel`). "Auto" means the WING only. The app **never** falls back to the computer's own microphone.
Code: `Mixer.src_index`, `route_inputs`.

### Gain (trim)
Boosts or cuts the signal right at the start (-24 to +24 dB), before the processing chain, so everything after it hears the louder or quieter signal. It is the knob at the top of each mixer strip. It does not change the recording (recordings are always the raw input), and it is separate from the WING's own preamp gain (see section 16).
Code: `pre` array in `Mixer._compile` (`10^(trim/20)`, times -1 if polarity is flipped).

### Polarity (Ø)
Flips the signal upside down (multiplies by -1). Fixes a mic wired the other way, or a snare top and bottom mic cancelling each other.

### Align delay
Delays a channel by up to 20 ms (shown in ms). Used to line a close mic up with the overheads (the sound reaches the close mic first). "Align mics & check polarity" measures it for you (section 12).
Code: `Mixer._delay`.

### Delay compensation (PDC)
Some processors add delay (the denoiser, the drum trigger's confirm wait). So channels stay lined up, the mixer finds the slowest chain and delays every other channel by the difference.
Code: `effects.latency`, `Mixer._compile` (`self._chdelay`, `self.pdc`).
Not compensated: auto-tune's small variable delay.

### Fader, pan, mute, solo
- **Fader**: -90 (off) to +10 dB. Pan is constant-power: `cos/sin` of the pan angle so the loudness stays even across the stereo field (`dsp.pan_gains`).
- **Solo** silences every non-soloed channel *in the mix*. Exports and Master-to-target ignore solos on purpose.
- Faders, pans and mutes are routed through one matrix multiply (`Y = x @ M`) so 48 channels cost almost nothing.

### Sends
Four send levels per channel to the FX returns (Vocal Plate, Vocal Hall, Instrument Verb, Delay). Post-fader.

### Stereo pairs
Link two channels (L/R). The UI mirrors every setting to the partner (`linkedTwin` in `web/app.js`), and linked compressors/gates act as one, taking the louder of the two sides, so the stereo image doesn't swing (`link_pairs` in `chain.py`).

### DCA groups
One fader and mute for a set of channels. Moving a DCA adds its dB to every member's fader; their own faders don't move. Code: `Mixer._dca`.

### Bypass (per channel)
Skips the whole chain for that channel, so you can hear the difference. The "A/B" button compares the entire mix (section 13).

### Chains
The processing on a strip is an **ordered list of modules**. Add any module, any number of times; switch each on/off, duplicate, remove, drag to reorder. The sound goes through top to bottom. Details in section 5.

---

## 5. Every processor in a chain

A **chain** is a list in `channels[n].chain` (or `buses[n].chain`, `master.chain`). Each module is `{id, type, on, ...settings}`. The list of types and their defaults is in `stobite/chain.py` (`TYPES`, `DEFAULTS`).

How chains run:
- **Channels** (mono, 48 at once): `ChannelChains` runs them in "stages". Stage k = every channel's k-th module, grouped by type. Compressors, gates, de-essers, transient shapers, saturators and EQs ("banks") process **all channels of that type in one go** with numpy, so 48 compressors cost little more than a few.
- **Buses and master** (stereo): `BusChain` runs the modules in order, one object per module.
- Each module has a stable `id`, so its internal state (filter memory, envelope) survives edits.

The effect picker groups them: EQ & filter · Dynamics · Reverb & delay · Modulation · Pitch · Restoration · Drums · Colour & distortion · Utility & stereo · Plug-in.

Typical order for a vocal: *Vocal rider → EQ → Auto-tune → Compressor → De-esser → Saturation → Reverb send*.

---

### 5.1 EQ & filters (`eq`)

**What it does.** Shapes the tone. A **low cut** (high-pass) removes rumble and handling noise, a **high cut** (low-pass) removes hiss, and bands boost or cut parts of the sound (more "body", less "mud", more "presence", more "air").

**Controls.** Low cut and high cut: on/off, frequency, slope (12, 24 or 48 dB per octave). Bands (4 by default, more can be added): type (bell, low shelf, high shelf, notch, high-pass, low-pass), frequency, gain (-18 to +18 dB), Q (width). Drag the dots on the curve.

**How it works.** Each band is a *biquad* filter (the standard "RBJ cookbook" formulas), run on the audio like an equation using the last two samples. Steep cuts are several biquads in a row (Butterworth shapes: 12 dB = 1 biquad, 24 = 2, 48 = 4). All sections for a strip are stacked in one array and run by SciPy's compiled `_sosfilt` kernel (loaded alone: importing all of `scipy.signal` would cost 65 MB of RAM). The filter's memory is kept between blocks so there are no clicks. Bands at 0 dB are skipped to save work. The curve you see is calculated in JavaScript from the same formulas (`web/widgets.js: drawEqCurve`), and the live spectrum behind it comes from a ring buffer of the channel's audio.

**Code.** `dsp.biquad`, `dsp.strip_sos`, `chain.EqBank`, UI `drawEqCurve` / the `eq` branch in `modulePanel` (`web/mixer.js`).

---

### 5.2 Gate / expander (`gate`)

**What it does.** Turns the channel down when it is quiet, so a mic only "hears" when something is played. Cuts drum spill, hum between words, a talking mic's room noise.

**Controls.** Threshold (dB), Range (how far it turns down, dB), Attack (how fast it opens, ms), Release (how fast it closes, ms).

**How it works.** The block is split into steps of 32 samples (0.67 ms). For each step the loudest sample is measured in dB. If it is below the threshold the target is "turn down by Range dB", otherwise 0. That target is smoothed (one-pole filter) with the attack time when opening and the release time when closing, then converted to a gain and **ramped sample by sample across the step** so there are no clicks. A small Range (say 6-10 dB) gives a gentle "expander" instead of a hard gate.

**Code.** `chain.GateBank`, helpers `dsp._tc` (time to filter coefficient), `Dynamics._smooth`, `Dynamics._apply`.

---

### 5.3 Compressor (`comp`)

**What it does.** Makes loud parts quieter, so the level is more even and the sound "tighter" and louder overall. The most used processor on voices, bass and drums.

**Controls.**
- **Threshold**: the level above which it starts turning down.
- **Ratio**: how hard (3:1 = for every 3 dB over, 1 dB comes out).
- **Attack / Release**: how fast it reacts and recovers.
- **Knee**: how gradually it starts (soft vs hard).
- **Makeup**: gain added after, to bring the level back up.
- **Mix**: blend with the untouched signal (below 100% = **parallel compression**, the punch stays and the body grows).
- **Max GR**: the most it is allowed to turn down.
- **Sidechain** (buses only): react to another channel or bus instead of its own signal.
- **Model**: Clean, Punchy, Smooth or Glue (below).

**How it works.** Same 32-sample stepping as the gate. For each step: level in dB → how far over the threshold → a *soft knee* curve (quadratic blend around the threshold) → `reduction = over × (1 - 1/ratio)`, capped at Max GR. The reduction is smoothed with attack (when it grows) and release (when it shrinks), turned into a gain, and ramped across the step. The gain-reduction meter on the strip is this smoothed value.

**Models** (`dsp.COMP_MODELS`). Each changes how the level is *measured*, how the release *behaves*, and adds a little colour:

| Model | Detector | Release behaviour | Other | Use for |
|---|---|---|---|---|
| **Clean** (VCA) | Peak | Fixed | None | Transparent control |
| **Punchy** (FET, 1176-style) | Peak | Faster after a big hit (over 6 dB of reduction) | Light grit that grows with the reduction | Drums, bass, rock vocals; ratio 4-8, fast attack |
| **Smooth** (opto, LA-2A-style) | RMS over 10 ms | **Slower the harder it works** (0.6x to 3x) | Attack never faster than 10 ms; knee at least 10 dB; slight warmth | Vocals, bass, keys; ratio 3-4 |
| **Glue** (bus, SSL-style) | RMS over 10 ms | Fast after a transient (drop over 3 dB), slow on held level | Knee at least 4 dB; very slight colour | Drum bus, band bus, master; 2-4 dB of reduction |

The colour is `tanh` saturation scaled to the threshold (so it is "driven" in proportion to how hard the compressor works).

**Code.** `chain.CompBank` (channels), `dsp.Dynamics` (buses and the multiband), `dsp.comp_levels`, `dsp.comp_smooth`, `dsp.comp_colour`. UI: compressor curve and gain-reduction bar in `web/mixer.js`.

---

### 5.4 De-esser (`deess`)

**What it does.** Tames harsh "S" and "T" sounds (sibilance) on vocals without dulling the whole voice.

**Controls.** Frequency (where the harshness lives, 3-12 kHz, default 6.5 kHz), Threshold, Max cut (dB).

**How it works.** A copy of the signal is high-passed at the chosen frequency (4th-order Butterworth) and measured. When that "hissy" part is louder than the threshold the **whole signal** is turned down by `0.75 × (overshoot)`, up to Max cut, with a very fast attack (0.5 ms) and a 60 ms release. It is a broadband de-esser: simple, fast, and the gain reduction is only active during the sibilant.

**Code.** `chain.DeEssBank`, `dsp.DeEsser` (used for buses).

---

### 5.5 Dynamic EQ (`dyneq`)

**What it does.** An EQ band that only works when it needs to: for example cut 3 kHz harshness *only when* the singer gets loud, or duck guitars' midrange only while the lead vocal is singing.

**Controls (per band).** On, type, frequency, Q, static gain, threshold, range (negative = cut, positive = boost), attack, release. Sidechain source optional.

**How it works.** For each band a narrow band-pass filter at the band's frequency "listens" (to the signal itself or the sidechain). Its level goes through an attack/release follower. How far it is over the threshold (scaled over 6 dB) decides how much of the *range* to apply. The band's gain is `static gain + dynamic part`, and a normal biquad EQ band with that gain is applied. The live movement is shown beside the band.

**Code.** `procs.DynEQ`. In templates the guitars and keys use `sc="bus:lead"` so they step back when the lead sings.

---

### 5.6 Transient shaper (`trans`)

**What it does.** Makes the *attack* of a sound sharper or softer, and its *sustain* longer or shorter, without a threshold: snappier snare, tamer room mic, tighter kick.

**Controls.** Attack (dB, + sharper / - softer), Sustain (dB, + longer / - shorter).

**How it works.** Two envelope followers watch the level: a fast one (rises in 0.5 ms, falls in 30 ms) and a slow one (rises in 25 ms, falls in 250 ms). When the fast one is above the slow one a hit is *starting* (attack phase); when below, the sound is *ringing out* (sustain phase). The gain is `attack × (how much of an attack) + sustain × (how much of a tail)`, over a 9 dB window.

**Code.** `chain.TransBank`, `procs.Transient`.

---

### 5.7 Saturation (`sat`)

**What it does.** Adds warmth, thickness and harmonics, like pushing analogue gear: tape, tubes, a console.

**Controls.** Flavour (Tape, Tube, Console, Soft clip), Drive (dB), Mix.

**How it works.** The signal is boosted by `drive`, bent by a curve, then turned back down by the same amount (so quiet sounds pass at unity and only peaks are rounded). The curves:
- **Tape**: `tanh(g·x)/g`, symmetric, smooth rounding.
- **Tube**: `tanh(g·x + 0.12)`, slightly lopsided, so it adds even harmonics (a warm, "musical" sound).
- **Console**: a gentle cubic `u - u³/6.75`, mostly third harmonic.
- **Soft clip**: clean until near the top, then eased off.

**Code.** `procs._shape`, `chain.SatBank`.

---

### 5.8 Auto-tune (`tune`)

**What it does.** Corrects the pitch of a voice, live. **Natural** style keeps vibrato and slides and fixes only the centre of each note; **Hard** gives the obvious "effect".

**Controls.** Style (Natural / Hard), Amount (how much of the correction), Retune speed (ms to glide to the note, 0 = instant), Humanize (cents: notes already this close are left alone; hidden in Hard), Voice range (soprano... baritone, limits what pitches are searched), Scale (the song's key/scale or chromatic; the key is set in the song settings). Quick buttons: Gentle, Natural, Polished, Hard (effect). A tuner needle shows the sung note and the correction.

**How it works.**
1. **Detect pitch** about 100 times a second with **YIN** (an autocorrelation method) on the last ~43 ms. It finds how long one cycle of the voice is, so frequency = sample rate / cycle length. A median of three results ignores single wrong-octave readings.
2. **Find the note centre**. Natural: a slow average (about 150 ms) of the sung pitch, so vibrato averages out and a new note (a jump of more than 0.8 semitone) restarts it. Hard: a fast 35 ms average.
3. **Pick the target**: the nearest note of the scale (`allowed_classes`, for the song key).
4. **How far to move** = target minus centre. Humanize: if already within the tolerance, do nothing; just past it, ease in. Multiply by Amount.
5. **Glide** the correction toward that value at the retune speed (one-pole smoothing), limited to ±2 semitones.
6. **Shift the pitch** with a custom **pitch-synchronous delay-line shifter** (`PitchShifter`). Two read heads move through a short delay line at a speed that changes the pitch; their windows are one or two whole voice cycles long and offset so that when one head jumps back, the other sits at full level, with a normalised crossfade. Because the window is a whole number of cycles of the voice, there is no beating or "robot" wobble; it stays within about 1 dB of steady level.

The reason it is custom: the library shifter (Rubber Band) can't run in 256-sample live blocks.

**Code.** `stobite/autotune.py` (`yin`, `PitchShifter`, `AutoTune`), UI panel in `web/mixer.js` (the `tune` branch), the tuner readout via `ChannelChains.tune_readouts`.

---

### 5.9 Drum trigger (`trigger`)

**What it does.** Plays a **sample** (a recorded kick, snare, cymbal...) every time you hit a drum, either replacing or blending with the real drum. Like Slate Trigger. It follows how hard you hit (soft hit = softer sample).

**Controls.**
- **Sample** and an optional **Layer** sample (own level): built-in sounds or your own (Load sample...).
- **Sensitivity**: how loud a hit must be to count.
- **Mix**: sample vs the real drum.
- **Dynamics**: how much hit strength changes the sample level.
- **Volume**, **Tune** (semitones).
- **Listen from / to**: the frequency band used to detect hits.
- **Retrigger**: shortest time between hits.
- **Ignore spill**: ignore hits more than this many dB below the loudest recent hit.
- **Confirm ring** (cymbals): wait this many ms and only trigger if the sound is still ringing.
- A green light flashes on each hit.

**Built-in samples.** Generated in code (nothing to license): 3 kicks, 3 snares/rimshot, 3 toms, closed and open hi-hat, crash, ride, splash, china (`effects.builtin_samples`). Your own WAV/AIFF/FLAC/MP3 files go into `~/Stobite Compact/Samples` and are resampled and normalised on load.

**How it works.** Detection runs on a **band-limited copy** of the signal (two high-pass and two low-pass filters in a row, so the band is steep). Example: the snare mic listens 150 Hz to 8 kHz so the kick's thump (30-100 Hz) doesn't set it off. The copy's level is measured every 16 samples. A **hit** is registered when the level is
- above the threshold (from Sensitivity: 50% is about -32 dBFS), **and**
- more than 2.5 times the level 8 ms earlier (a sudden rise; a ringing tail never rises, so one hit can't fire twice), **and**
- at least the Retrigger time after the last hit, **and**
- within "Ignore spill" dB of the loudest hit it has seen (other drums bleeding in are quieter).

The hit strength measured just after the onset sets the sample's velocity relative to the loudest recent hits. The sample is played through a small voice list (up to 8 overlapping), pitch-changed by resampling if Tune is set, and blended with the dry drum by Mix.

**Confirm ring** (for cymbals in overhead mics, where snare and kick bleed is louder than the cymbal): when a candidate hit is found, the decision is held for N ms. A cymbal is still ringing at the end of that time; snare or kick bleed in an overhead has died away. If still ringing, the hit counts. To keep the sample on the beat, the real drum is delayed by the same N ms, and the mixer's delay compensation delays every other channel to match. In this mode a smaller jump (1.6x) is enough to be a candidate, because the ring test does the filtering.

**Whole kit.** Mix menu, **Drum Triggers...** finds kick, snare, tom, hi-hat and cymbal/overhead channels by instrument type or name and adds a trigger with sensible detection bands (kick 30-150 Hz, snare 150-8000, toms 60-1200, hats 3000-16000, cymbals 4000-16000 with Confirm ring 40 ms).

**Code.** `effects.Trigger`, `effects.trigger_latency`, `effects.load_sample`, server routes `samples` / `sample-upload` (`server.py`), UI `drumTriggers` (`web/commands.js`) and the `trigger` panel (`web/mixer.js`).

---

### 5.10 Proximity (`proximity`)

**What it does.** A directional mic boosts bass when the source is very close. **Tame boom** turns the lows down automatically when a singer leans into the mic. **Add closeness** does the opposite: warms a thin or distant voice.

**Controls.** Mode (Tame / Add), Amount (dB, the most it cuts or adds), "Up to" frequency (80-400 Hz).

**How it works.** Both modes use a low shelf filter. In **Add** the shelf is set to +Amount. In **Tame** the module compares the energy below 250 Hz with the energy of the voice's middle (800-3000 Hz) over about 0.3 s. It *learns the voice's normal balance* (quickly when it gets less boomy, very slowly, about a minute, when it gets more boomy), and when the lows exceed that normal balance by more than 1 dB it turns the shelf down by the excess (×1.5), up to Amount, attacking faster than it releases. The current cut is shown on the panel.

**Code.** `effects.Proximity`.

---

### 5.11 Vocal rider (`rider`)

**What it does.** Rides the level up and down like an engineer moving a fader, so every word sits at the same level. Put it *before* the compressor so the compressor works less.

**Controls.** Target level (dB), Range ± (the most it moves), Speed (ms), Ignore below (a floor so breaths and room noise aren't pulled up).

**How it works.** The module measures the voice's level over about 60 ms (mean square → dB). If above the floor, the needed move is `target - level`, limited to ±Range, and the current ride glides toward it at the Speed. In a gap below the floor the ride drifts back to 0 dB over a second or two. The gain is ramped smoothly over the block. The panel shows "riding +3.1 dB".

**Code.** `effects.Rider`.

---

### 5.12 Bass enhancer (`bass`)

**What it does.** Makes bass *audible* on phones, laptops and small speakers that can't reproduce it, by adding its harmonics (the ear fills in the missing low note). Like MaxxBass.

**Controls.** Harmonics (amount), Below (frequency of the bass to enhance, 40-250 Hz), Original lows (turn the real sub-bass down, 0 to -24 dB, to free headroom), Mix.

**How it works.** The low end (everything below the chosen frequency, two low-pass filters) is normalised by its own envelope (so the effect is the same at any level), then shaped with **Chebyshev polynomials** that create exactly the 2nd and 3rd harmonics (`0.7·T2 + 0.4·T3`, with none of the original note). That is band-passed (0.9× the frequency up to 5×) and added to the original. "Original lows" subtracts part of the real low end.

**Code.** `effects.BassEnhancer`.

---

### 5.13 Denoiser (`denoise`)

**What it does.** Removes steady background noise (hiss, hum, air-conditioning, buzz) from a mic while leaving speech and music. It learns the noise by itself.

**Controls.** Reduction (dB, the most it removes; start around 12), Sensitivity, Mix.

**How it works.** The sound is cut into overlapping 512-sample frames (hop 128, sqrt-Hann windows), turned into frequencies with an FFT. For every frequency band the module tracks the **noise floor**: it follows the quietest smoothed level and lets it creep up slowly (about 1 dB per second) so it re-learns if the noise changes. Bands near that floor are turned down by up to Reduction dB (a smoothed gate per band: fast to open, gentle to close, smoothed across neighbouring bands so it doesn't warble). The frames are rebuilt with overlap-add. The first ~100 ms are used to learn the room. It adds **384 samples (8 ms)** of delay, which the mixer compensates on the other channels.

**Code.** `effects.Denoiser`, `effects.LATENCY`.

---

### 5.14 Reverb (`reverb`)

**What it does.** Adds the sound of a space (room, hall) to a channel. (For one shared space across many channels, use the FX returns in section 6.)

**Controls.** Size, Darkness (damping), Width, Mix.

**How it works.** Pedalboard's reverb (a Freeverb-style network of comb and all-pass filters), wet only, then mixed with the dry signal by Mix.

**Code.** `effects.Effect` (`kind == "reverb"`).

### 5.15 Delay / echo (`delay`)

**What it does.** Repeats of the sound. Synced to the song's tempo (1/4, dotted 1/8, triplets...) or a time in ms.

**Controls.** Sync, Note, Time, Repeats (feedback), Low cut and High cut on the repeats (keeps them from muddying the dry sound), Mix.

**How it works.** Pedalboard's delay line with feedback; the delay time is `60 / tempo × note length`, checked every block so it follows tempo changes. The repeats pass through a high-pass and low-pass.

### 5.16 Chorus, Flanger, Phaser (`chorus`, `flanger`, `phaser`)

**What they do.** Chorus thickens a sound with slightly detuned, slightly delayed copies (guitars, pads, backing vocals). Flanger is a jet-like sweep from a very short fed-back delay. Phaser is a swirling sweep of notches (pads, keys, electric guitar).

**How they work.** A very short delay whose time is modulated by a slow LFO (Rate, Depth), blended with the dry signal. Chorus uses ~7 ms, flanger ~1.5 ms with feedback, phaser sweeps all-pass filters around a Centre frequency.

### 5.17 Tremolo / auto-pan (`tremolo`)

Rhythmically raises and lowers the volume (tremolo) or moves it left and right (auto-pan on stereo buses). Rate in Hz or synced to the tempo, Depth, shape (smooth or choppy). Implemented by multiplying by an LFO (`effects.Effect`, phase kept between blocks).

### 5.18 Auto filter (`autofilter`)

A resonant 24 dB low-pass, high-pass or band-pass filter whose cutoff is swept by an LFO (Rate, Depth in octaves, Cutoff, Resonance). Pedalboard's ladder filter, with the cutoff set every block.

### 5.19 Distortion / overdrive (`distortion`)

Overdrive (`tanh`, rounded) or fuzz (hard clip), Drive in dB, a Tone low-pass, Output level, Mix.

### 5.20 Bitcrusher (`bitcrush`)

Lo-fi: reduces the number of bits (`round(x / step)·step`) and holds samples to lower the sample rate (Downsample), Mix.

### 5.21 Pitch shifter (`pitch`)

Moves the pitch by up to ±24 semitones (for effects, octave doubles; use Mix for a blend). Pedalboard's shifter. Output blocks of a different size are padded to keep the stream steady. (It is not the auto-tune shifter; this one is for effects, not live correction.)

### 5.22 Gain / utility (`gain`)

A plain level change (dB), polarity invert, and a "mono" switch (sums L and R) for buses.

### 5.23 Multiband compressor (`mbc`, buses only)

**What it does.** Compresses low, middle and high frequencies separately, so a loud bass doesn't pump the vocal, and the highs stay controlled.

**Controls.** Two crossover frequencies (default 180 Hz and 3.5 kHz), and for each of the 3 bands: threshold, ratio, attack, release, gain, max reduction.

**How it works.** The stereo signal is split with **Linkwitz-Riley LR4** crossovers (two Butterworth filters in series) that add back up to a perfectly flat response. The low band is phase-aligned with an all-pass pair so the bands recombine properly. Six compressors (3 bands × L/R, the `Dynamics` class) work on the bands, each band gets a gain, and the three are summed.

**Code.** `procs.Multiband`.

### 5.24 Width & balance (`width`, buses only)

Width 0% = mono, 100% = as is, up to 200%. It works on mid (L+R) and side (L-R): `side × width`. Balance moves the image left/right. Over 120% can cause mono problems on phones; check the correlation meter. Code: `procs.width_balance`.

### 5.25 Limiter (`limiter`, buses only)

**What it does.** A safety net that stops peaks going over the ceiling (-1 dB by default), so the stream never clips. It should only catch the loudest 1-3 dB.

**Controls.** Threshold, Ceiling, Release, Lookahead (ms), Input gain, True peak on/off.

**How it works.** *Lookahead*: the audio is delayed by the lookahead time (1.5 ms by default) while the level of the *upcoming* signal is measured, so the gain is already turned down when a peak arrives (no overshoot). The detector can be **true-peak**: the signal is 4x oversampled with a polyphase filter first, to catch peaks that fall *between* samples and would clip after conversion. The needed reduction (`level - ceiling`) over the lookahead window is smoothed with an instant attack and the chosen release, applied, then a final hard clip guarantees nothing passes the ceiling. It adds the lookahead time as latency on that bus only.

**Code.** `procs.LookaheadLimiter`, `dsp.true_peak`.

### 5.26 Plug-in (VST3 / AU)

Hosts third-party plug-ins (including Waves, if you own them) in any chain through Pedalboard. The plug-in's own settings are stored as raw values in the module (`params`) and sent straight to it. If a plug-in isn't installed on this computer it is shown and skipped. If a plug-in crashes it is switched off for that session. Code: `mixer.Insert`, `mixer.MissingPlugin`, `Mixer._plugin`.

### 5.27 Level-of-effort at a glance

| Module | CPU | Adds delay |
|---|---|---|
| EQ, gate, comp, de-ess, trans, sat | very low (vectorised across all channels) | none |
| Auto-tune | medium (per channel) | small, variable (a few to ~25 ms), not compensated |
| Denoiser | low (~1% per channel) | 8 ms (compensated) |
| Drum trigger | low | 0 (or the Confirm time, compensated) |
| Reverb, delay, modulation, pitch | low | none (pitch may vary) |
| Limiter | low | lookahead (bus only) |

---

## 6. Buses, FX returns, ducking, master, cables

### Buses
Channels don't go straight to the output. Each goes to a **destination bus**; buses go to other buses; the last stop is the Master. Default structure (`DEFAULT_BUSES` in `mixer.py`):

```
channels ─► Lead Vocal ─┐
            Backing Vocals ┤                       ┌─► Music ───┐
            Drums ─────────┼─►(drums,bass,gtr,keys,other)       ├─► Broadcast ─► Master ─► stream
            Bass, Guitars, Keys, Other ─►          └─►           │
            Preaching ───────────────────────────────────────────┤
            FX Returns ──────────────────────────────────────────┘
```

You can add buses (Mixer, Add bus) and re-route any "→" in the Routing view. A bus can't feed itself or anything upstream of it: the mixer sorts buses so children are processed before parents (`Mixer._topo`), and a loop is treated as going to the master.

Each bus has: a chain (stereo), a fader, mute, sends, and **ducking**. Bus presets (Vocal Bus, Drum Bus, Music Bus, Speech Bus, Broadcast Bus, Worship Master) are in `catalog.BUS_PRESETS`.
Code: `Mixer.process` (the bus loop), `BusUnit`, `chain.BusChain`.

### FX returns (shared reverbs and delay)
Four shared effects: **Vocal Plate**, **Vocal Hall**, **Instrument Verb**, **Delay**. A channel's *send* knob sends a copy to one of them; the effect's wet sound is added to the FX Returns bus. One reverb shared by many channels sounds like they are in the same room, and costs the CPU once.
- **Reverb** (`procs.ReverbFX`): pre-delay, 7 early-reflection taps (more for a bigger "size"), the diffuse tail from Pedalboard's reverb, then a low-cut and high-cut on the return.
- **Delay** (`procs.StereoDelay`): tempo-synced (1/2, 1/4, dotted 1/4, 1/8, dotted 1/8, triplet 1/8, 1/16) or in ms, ping-pong, feedback, filtered repeats, width.
- Chorus, phaser and "doubler" FX types are also available (`mixer.make_fx`).
An FX return that was sent nothing for 8 seconds is skipped (its tail has died away).

### Ducking
Turns a bus (or FX return) down while a *source* is loud. Used so the **Music** bus steps back 2 dB when the lead vocal is singing, and the **Delay** return ducks 6 dB under the vocal so echoes bloom *between* words.
Controls: Source, Amount (max dB), Threshold, Ratio, Attack, Release, Mode (duck or gate).
How: the source's peak level for the block → how far over the threshold → `over × (1 - 1/ratio)`, limited to Amount, smoothed with attack/release. Code: `procs.Ducker`.

### Master
Fader, mute, **chain** (default: EQ, glue compressor off, saturation off, multiband off, width, limiter -1 dB), target loudness, loudness meters. After the chain and master fader there's a hard clip if a limiter is on, then the loudness measurement. Code: `default_master`, `Mixer.process`.

### Virtual cables (internal)
Four stereo cables. Route the master, any bus or any channel *to* a cable and it comes back as an input you can put on any channel: a "speaker" and a "microphone" at once. They can also be attached to a system loopback device (BlackHole on Mac, VB-Cable on Windows) to reach other apps. Code: `stobite/cables.py` (`CableIO`, a lock-free ring buffer between the audio callback and a second stream).

---

## 7. Metering and loudness

### Channel and bus meters
Peak and RMS per channel (input meter and post-fader meter), gain-reduction for each compressor/gate/de-esser, per-bus peak/RMS. The mixer keeps the **maximum since the last read**, so short peaks aren't missed, and the server reads and resets them 20 times a second (4 per second when the engine is asleep). Code: `Mixer.read_meters`, `Server.meter_loop`, UI `Meter` in `web/widgets.js` (-60 to +6 dBFS scale; its animation loop sleeps when nothing moves).

### Loudness (LUFS)
Implements **EBU R128 / ITU BS.1770**:
- **K-weighting**: a high-shelf (+4 dB around 1.7 kHz) and a 38 Hz high-pass, to match how loud things *seem*.
- **Momentary** = last 400 ms, **Short-term** = last 3 s, **Integrated** = the whole thing, with the two **gates** (ignore anything below -70 LUFS, then anything more than 10 LU below the average), so silence doesn't drag it down.
- **Loudness range (LRA)**: spread between the 10th and 95th percentile of short-term loudness (EBU Tech 3342).
- **True peak**: the highest peak after 4x oversampling (`dsp.true_peak`, 48-tap Kaiser interpolation filter in 4 phases), reported in dBTP. The limiter and the meter share it.
- **Correlation**: +1 = mono, 0 = wide, below 0 = parts cancel in mono (check it when using Width over 120%).
- **Spectrum**: FFT of the last 4096 master samples, 64 bands from 20 Hz to 20 kHz.
Common targets: -14 LUFS (YouTube/streaming), -16 (podcasts/Apple Music), -12 (energetic worship stream), -23 (broadcast). Code: `dsp.Loudness`; UI `web/master.js`.

---

## 8. Recording

**What it does.** Records every *armed* channel's raw input to its own mono 24-bit WAV file, at the same time, with the timeline playing behind it if you like.

**How it works.** (`session.Recorder`)
1. On Record, one WAV file per armed channel is created (`audio/T001_hhmmss_Ch05.wav`), and a note `recording.json` is written.
2. The audio callback only puts each block on a queue (`push`). A **writer thread** collects about 0.1 s at a time, writes it to the files, and builds the waveform outline (one peak value per 256 samples) that the screen draws live. If the queue were ever full (the disk can't keep up) it counts dropped blocks, shown in the UI.
3. Every 5 seconds the files are flushed to disk and the free space is checked: a warning with about 15 minutes left, a clean stop with about 1 minute left.
4. On Stop, the files are closed, peak files are saved, one **clip** per channel is added to the timeline (named "Take N"), and the note is deleted.

**Recorded signal is always raw**: before trim, EQ, compression and fader, so you can change your mind in the mix later.

**Crash-safe.** WAV files normally have a header that is only fixed when you close the file; a crash leaves them looking empty. The recorder asks the audio library (libsndfile, option `SFC_SET_UPDATE_HEADER_AUTO`) to rewrite the header after every write, and the note tells the next start what was being recorded. On opening the project, `recover_interrupted` repairs each file (`repair_wav`) and turns it into a clip named "...(recovered)". A message tells you how many tracks were recovered.

**Record position.** Recording starts at the end of the existing audio if "record at end" is on and the playhead is before it (so you never record over something by accident), otherwise at the playhead (takes). **While recording, the playhead can't be moved**: it *is* the recording's position, and moving it would cut the take short. Clicking the timeline shows "Recording: stop first to move the playhead", and the server ignores any such request too.

**Count-in and metronome.** The click is a 30 ms sine burst (1600 Hz on the first beat of the bar, 1000 Hz on the others) following the project tempo and time signature, with a count-in bar before recording starts. It goes only to your headphones/speakers, never to the stream or the recording. Code: `Engine._click`.

**Disk estimate.** About 3 bytes per sample per channel: 24 channels × 2 hours at 48 kHz ≈ 25 GB. Setup shows the estimate and time remaining (`Engine.rec_check`).

---

## 9. Playback, the timeline and editing

### Project on disk
```
Sessions/<name>/
  session.json     clips, markers, automation, loop, armed channels, take counter, and the whole mixer state
  audio/*.wav      every recording (never modified: edits are non-destructive)
  peaks/*.npy      waveform outlines for fast drawing
```
`session.json` is written atomically (to a temp file, then renamed) and the app autosaves every 10 seconds when something changed.

### Clips
A clip is a *reference*: `{id, track, file, start, offset, length, gain, fin, fout, mute, name}`. `start` is where it sits on the timeline, `offset` is where in the file it begins, `length` how much is used, `gain` its own level (dB), `fin`/`fout` fade lengths. Cutting, trimming, moving and deleting only change these numbers. The WAV files are never touched. All positions are in samples.

### Reading it back (`Reader.render`)
For a block: for each clip that overlaps, seek to `offset + (position - start)`, read, apply clip gain and the fade-in/out envelope, and add it to that clip's channel column. A separate `Feeder` thread renders 6 chunks of 4096 samples *ahead* of the audio callback, so disk reads never happen on the audio thread. Seeking flushes it and starts again; looping stitches the loop end to the loop start inside one chunk so it is seamless.

### Edit operations (`Session.edit`)
Split, delete, move (also between tracks), trim (left/right edge), set properties (gain, fades, name, mute), delete range (ripple closes the gap), duplicate, paste, normalize (sets the clip's gain so its loudest peak is at -1 dBFS), reverse, join (merge adjacent clips of the same file back together), markers (add/delete/rename), arm channels, automation points, automation mode, loop region. **Every edit saves an undo snapshot first** (up to 200) of clips, markers and automation (`_checkpoint`); undo/redo restore it. The mixer has its own, separate undo (`mixundo`) which groups a burst of moves into one step.

### Takes
Clips recorded over the same stretch of one track are *takes*. Only the un-muted one is heard; right-click a clip, then Takes, to choose which one to use (the others are muted, not deleted).

### The Edit view (`web/timeline.js`)
A canvas draws the ruler, waveforms (from the peak files at the zoom level; the waveform of a recording *in progress* comes from the live peaks), clips, markers, the loop region, the playhead (smoothed so it never jumps backwards) and automation lanes. Tools: Pointer (select/move/trim), Blade (split on click), Range (drag a time range across tracks). Snap to grid with bars-and-beats, zoom, follow playhead, right-click menus on clips, tracks and the ruler. Import audio: drag a file in, or File > Import.

---

## 10. Automation

Record fader, pan and mute moves and play them back. Per channel (and master) a mode: **Off**, **Read** (play what's recorded), **Touch** (while you hold a control it records, and it returns to the written values when you let go). Code: `Engine.touch`, `Session.auto_write`, `Session.auto_value` (interpolates between points), `Engine.auto_for` (values for this block). Channel fader/pan/mute and master fader are applied in the audio callback; buses, FX, sends and plug-in parameters are applied by a 10 ms background thread (`_auto_loop`). Lanes show in the Edit view (automation view).

---

## 11. Exporting

**What it does.** Renders the mix (or each track, each song, a podcast, a video soundtrack) to files, offline and faster than real time, using exactly the processing you hear.

**Choices (Export window).**
- **What**: the mix, separate tracks, one file per song/section (from markers), a podcast MP3, or audio for a video.
- **Range**: whole project, time selection, selected clips, loop region, each marker section, or typed times. Optional **tail** (+2 s so the reverb rings out; off for a loop so the loop length is exact).
- **Format**: WAV (16/24/32-bit float), AIFF, FLAC, MP3 (64-320 kbps), Opus; mono or stereo. A size preview updates as you change options.
- **Loudness target**: match a target in LUFS.
- **Save to**: a folder you choose (native picker on the computer; a typed path on a phone).

**How it works.** (`Engine._export`, background thread)
1. A *fresh* `Mixer` is built from a copy of your mix (so it doesn't disturb live audio), master mute off. For a podcast with "speech only", non-speaking channels are muted.
2. **Target loudness** takes two passes: pass 1 renders with the master limiter out of the way and measures the integrated loudness; the needed gain (limited to ±24 dB) is added to the master fader; pass 2 renders the real file. (If measured silence, no gain is applied.)
3. The audio is read in blocks (1024 samples when there is automation, else 4096), run through the mixer with automation applied for that position, and written with libsndfile (WAV/AIFF/FLAC/MP3/Opus).
4. **Separate tracks**: each channel's raw clips are written as individual mono files named `NN Channel name.wav` in a new folder.
5. **Sections**: one file per marker section, numbered, in a new folder. Markers whose name starts with "(" are skipped (like "(gap)").
6. **Podcast**: mono MP3 (96 kbps default), target -16 LUFS by default, with ID3 tags written in (title, speaker, church, year, comment).
7. **Video**: a mix without the tail, for putting under a video.
The last block of a range is padded with silence to a whole 256 samples (and trimmed again), because the processors work in whole steps. **An export keeps running when you close the Export window**: a pill in the header ("Exporting 43%") shows it; click it, or open Export again, to see the progress and a **Cancel export** button (cancelling removes the unfinished files). When it finishes you get a message even if the window is closed. The server announces the start and the end of every export to every window (`export` message), and the running job is also part of `info` so a newly opened window or phone sees it. Progress is pushed live; finished files can be downloaded (from a phone) or revealed in the folder.
Code: `engine.py` (`export`, `_export`, `out_format`), `session.Reader`, `postservice.tag_mp3`, UI `openExport` in `web/timeline.js`.

---

## 12. After the service: songs, alignment, video, mastering

### Find songs & sermon
Works out where each song and the sermon are, from the recording alone, and adds markers.
How: for every second, the power of the *music* channels (drums, bass, guitars, keys...) and the *speech* channels (preacher, host) is read from the peak files (so it is quick), scaled by their faders. A song is a stretch where the band is within 24 dB of its loud level, at least 45 s long, bridging gaps under 8 s (a quiet bar, a breath). The sermon is the longest stretch of speech within 20 dB of its loud level, at least 2 minutes, bridging gaps under 20 s. Code: `postservice.find_sections`, `_runs`.

### Align mics & check polarity
Close mics hear a drum a few milliseconds before the overheads; a mic wired backwards cancels the others. Both make a kit thin. For each chosen mic it cross-correlates (in the 80 Hz-5 kHz band) with the reference mic over the busiest 20 seconds, finds the lag (up to 20 ms) and whether the best match is negative (polarity flipped). You tick which results to apply: it sets that channel's Align delay and polarity. Code: `stobite/align.py` (`busiest`, `analyse`).

### Line up with a video
Finds where a video file starts relative to the recording, so the video and the clean multitrack can be put together. It reduces both to a loudness outline (200 values/s, slow changes removed) and finds the shift that matches best with an FFT cross-correlation, and reports a match confidence. Code: `postservice.video_offset`.

### Master to target (mastering)
Listens to the project and sets the master chain so the mix lands on a loudness target in a chosen character (Balanced / Warm / Bright). Steps (`stobite/mastering.py`):
1. **Pick windows**: the loudest 12-second stretches of what is actually heard (each second's energy from the peak files, scaled by faders, muted channels ignored; solos ignored; scored by the *median* second so a single loud hit doesn't fool it), spread across the service.
2. **Render** them through your current mix with the master chain bypassed; drop windows more than 10 dB quieter than the loudest (talking, a soft pad).
3. **Measure** tone in octave bands (63 Hz-16 kHz) against a reference curve of a polished modern mix, and loudness.
4. **Build a master chain**: corrective EQ (limited to ±4 dB, at 60% of the difference), a glue compressor, a gentle 3-band multiband, a little width when the mix is solidly stereo, and a true-peak limiter at -1 dB.
5. **Set the loudness**: re-render and trim the limiter drive (up to ~8 dB) and the glue compressor's makeup (up to 6 dB) until the result is within 0.3 LU of the target. Notes explain what it changed in words ("More presence", "Less boxiness").
Everything stays editable and the whole change is **one undo step**. Code: `mastering.assist`, route `master-assist` (background thread with progress).

### Worship template ("Worship: Big & Polished")
Mix > Mix settings & templates. Loads a full starting sound modelled on modern live-worship records: an upfront, glued lead vocal on a plate and a long hall, wide airy backing vocals, a big pad bed, punchy drums with a crushed room, a solid low end, guitars/keys that duck for the vocal. It matches each channel to an instrument (by type, then by name) and leaves the faders alone, because balance depends on how each source was recorded. Code: `stobite/templates.py`, `applyTemplate` in the UI.

---

## 13. Listening: headphones, stream, before/after

### Listen output (when the WING is the interface)
The WING receives no audio back by default. The mix is played on the **computer's own** speakers/headphones by a second stream (`ListenOut`, `listen.py`), with a short ring buffer (up to ~85 ms) that absorbs the difference between the two devices' clocks. Choose the device or turn it off in Setup > Stream & listen.

### Stream output (OBS / Zoom)
A second copy of the finished master sent to a chosen device, normally the virtual cable "CABLE Input", which OBS and Zoom then read as "CABLE Output". It never has the click or before/after on it. Routing recipe for church: Windows music → WING USB 1-8 → WING → app → (stream out) → cable → OBS (to the stream) and Zoom (as its microphone). Code: `Engine.start_listen`, `stream_out`.

### Headphone correction
Flattens the sound of your headphones (the way Realphones does), so a mix made on them translates to other systems. 48 popular models (Sennheiser HD 280/600/650, ATH-M30x/M40x/M50x, MDR-7506, DT 770/990, AKG K240/K271/K371, AirPods...). The corrections are **AutoEq** parametric presets (MIT licence, Jaakko Pasanen), measured by oratory1990, Crinacle, Rtings and others, tuned to the Harman target. Pick a model and an Amount (%) in Setup; toggle with ⌥⇧H.
How: the preset is a pre-gain (to avoid clipping) plus about 10 filters (bell and shelf). They are applied through Pedalboard to **only the "hear" path**: your headphones/speakers/monitor outs. Never the stream, the recording, an export, or what goes back to the WING. Costs about 0.03 ms per block. Code: `stobite/hpcorrect.py`, data `stobite/headphones.json`, applied in `Engine._callback`.

### Before / after (A/B)
The "A/B" button (key `\`) switches what you *hear* between the mix as processed and the mix with **no processing at all** (same faders, pans and bus faders, no EQ, dynamics, FX or master), like toggling an edit on a photo. The two are **level-matched** (their loudness is measured and the unprocessed one is scaled to the same level, up to ±24 dB), so louder doesn't just sound "better". Only your headphones change: the stream and recordings never hear it. Each channel and bus also has its own **bypass** button. Code: `Mixer._before`, `Mixer.compare`, WebSocket message `compare`.

### Monitor checks
Mono, mid only, side only, left only, right only, for checking mono compatibility, applied to the monitor outputs (or main outs if no monitor outs are set). Code: `engine.monitor_mix`.

### Metronome click
See section 8; it only reaches your headphones.

---

## 14. Devices, inputs and virtual cables

### Choosing devices (`engine.py`)
- **Input "Auto"** = the WING. If the WING isn't connected there is *no main input* (silent, labelled "not connected"); it never uses the computer's own microphone. A watcher thread rescans every 2 seconds and connects the moment the WING is plugged in. It restarts audio only when the operating system's device list *actually changes* (`device_fingerprint`), and never while playing or recording.
- **"None"** is the first option in every device list: Input None = output only; Output None = input only; each main L/R and "returns start at" has None too. Lists are sorted A-Z (numbers in natural order).
- **Windows drivers.** The WING's ASIO driver is tried first. If it fails to load (`PaErrorCode -9999`), the WING's other drivers are tried in order WASAPI, WDM-KS, MME, DirectSound (`input_candidates`, `API_RANK`), and Setup explains the error in plain words (`explain_audio_error`). Every thread that touches the audio library initialises COM first (`com_init`).
- Output and input must share a host API (`pair_output`).

### Other microphones (`inputs.py`)
Any microphone the computer can see (built-in, a USB mic, a webcam, a second interface) can feed a channel alongside the WING. Pick it in the channel's Input list. Each device used gets its own input stream, opened only while a channel uses it; its clock is independent, so a small buffer absorbs the difference (an occasional sample is dropped or repeated).

### Cables
Section 6.

---

## 15. Safety features

| Feature | What it does | Code |
|---|---|---|
| **No audio back into the WING by default** | The church patches the WING's USB returns into channels, so sending the mix back made a screaming feedback loop. Default: the WING gets silence. | `DEFAULT_CFG["wing_return"] = False` |
| **Feedback guard** | If the app's output comes back into one of its inputs, it cuts every output, names the channel, and waits for you to press Unmute. Detects with **GCC-PHAT** (a phase-only cross-correlation between the output and the 8 loudest inputs, 150 Hz-8 kHz, delays 4-300 ms): in a loop an input *follows* the output. It checks that the input follows the output more closely than any other input (so a PA playing a song that also comes in on its own channel isn't mistaken for a loop) and requires three checks in a row (~0.6 s). | `guard.LoopGuard` |
| **Service lock** | The padlock stops the mix and edit being changed by accident (from the computer or a phone). Playing, stopping, recording, listening still work. | `Server.locked`, `LOCKED_WS`, `OPEN_WHEN_LOCKED` |
| **Crash-safe recording** | Recordings survive a crash or power cut and are recovered on the next open. | Section 8 |
| **Disk check** | Warns about 15 minutes before the disk fills, stops cleanly with 1 minute left. | `Recorder._check_disk` |
| **Never uses the computer mic** | See section 14. | `find_device` |
| **Delete goes to the Trash** | Deleting a project moves it to the Mac Trash (permanent on Windows, with a clear warning). | `session.delete_session` |
| **Quiet startup** | The engine does not open an input until it exists; startup never blocks waiting for a microphone-permission prompt. | `Engine.start_audio` |
| **Phone remote is off by default** | The server listens only on this computer (127.0.0.1) until you switch on the phone remote; a PIN can be required. | `App.set_remote`, `App.auth` |
| **Limiter and clip** | The broadcast bus and master have limiters, and a final hard clip. | Section 5.25 |

---

## 16. The WING console remote

The WING speaks **OSC** (a simple network message format) on UDP port 2223; it answers discovery ("WING?") on port 2222. The WING tab (hidden unless switched on in Setup) controls the console itself: faders, mutes, names, and the channel's **preamp gain** (the mic input itself, `/ch/N/in/set/$g`). Changing the console has no latency, unlike sending audio through the computer.
- `wing.discover` finds consoles; `WingBridge` sends and receives.
- Replies come as text + normalised value + real value; the real value is used.
- **If the faders snap back after about 2 seconds**, the WING's **OSC Remote Lock** is on (SETUP > REMOTE > Remote Lock off). The app detects this (it asks the console what it has *now* a moment after each change, and compares) and shows a banner.
- The preamp-gain control only appears for a channel once the console reports a gain value, because that address has not yet been checked against real hardware.
Code: `stobite/wing.py`, UI `web/console.js`.

Important: this app is a **separate** broadcast mix. It does not control the room mix unless you use this tab.

---

## 17. Projects, presets, templates, scenes

- **Projects**: one per service. The **welcome screen** (like Logic) lists them; the app opens to it, and Cmd/Ctrl+O brings it back. It can be empty: the app never creates a project on its own. If no project is open, a hidden "scratch" project holds anything you record or import, and becomes a real project ("Service <date>") the moment audio is recorded or imported. Opening or importing a project shows a **progress card**: a big percentage, the stages (sending the file, unpacking recordings, opening the project), what it is doing now ("Unpacking 9.8 of 24.6 GB"), time left, and a few useful lines to read while waiting. The server reports progress with `loading` messages (`App._loading`, `portable.import_project`, `Engine.open_session`); the upload itself is measured in the browser; the card is `progressCard` in `web/app.js`. Code: `web/home.js`, `Engine.open_session`, `new_session`, `promote`, `open_scratch`.
- **Project file** (`.stobite`, zip): the whole project (recordings, edits, markers, automation, mix) to carry to another computer. **Settings file** (`.stobite-settings`): the whole mix (every channel, effect, bus, the master, tempo, key, DCAs, routing) as ONE small JSON file with **no audio** (about 100 KB), plus any of your own drum samples a trigger uses. Mixer > Mix settings > *Save a settings file* writes it to your export folder; on the other computer *Open a settings file…* replaces that computer's mix (one undo step brings the old one back). Inputs pointing at a device the other computer doesn't have show "not connected" until you pick one. Code: `portable.export_settings` / `read_settings`, routes `settings-export` / `settings-import`. **Channel file** (`.stobite-channel`): one channel's sound (chain, sends, levels, routing). **Mix folder**: one channel file per channel plus `Buses, FX and Master.stobite-mix`. Save/load a channel's sound from the channel window ("Save this sound", "Load a sound"). Code: `stobite/portable.py`.
- **Scenes**: snapshots of the mix, recalled *by part* (faders, mutes, processing, sends, FX, routing), with safe channels that don't change. Default names: Pre-Service, Worship, Worship Build, Worship Quiet, Prayer, Preaching, Altar Call, Closing, Post-Service. Code: `SCENE_SCOPES`, `merge_scene` in `server.py`.
- **Starting presets** (`catalog.CHANNEL_PRESETS`, `BUS_PRESETS`): gentle chains per instrument. They load only if you ask (see section 4).

---

## 18. The server and phone remote

`stobite/server.py` runs an aiohttp web server (port **8730**; the environment variable `STOBITE_PORT` changes it) that serves the UI files and a **WebSocket** (`/ws`) plus an HTTP API (`/api/<name>`).

**WebSocket messages** (`App.handle`):

| Message | Does |
|---|---|
| `set` `{path, v}` | Change one setting (applied to the mixer, passed to automation Touch, broadcast to others). One undo step per burst. |
| `edit` | A timeline edit (split, move, trim...). |
| `undo` `redo` `mixundo` `mixredo` | Timeline and mixer undo. |
| `transport` `{a: play/stop/record/locate/toggle}` | Transport. |
| `focus` | Which strip's live module readings the editor wants. |
| `tuner` `{ch, a4}` | Open/close the tuner on a channel. |
| `compare` | Before/after. |
| `spectrum` | Start/stop the spectrum feed. |
| `wing` `{a: set/query}` | WING console control. |

Server → UI messages: `hello` (everything on connect), `m` (meters, 20/s), `set`, `mixer`, `session`, `transport`, `info`, `export`, `wing`, `assist` (mastering progress), `valign`, `loading` (project open progress), `compare`, `error`, `toast`.

**HTTP routes** (`/api/...`): `info`, `devices`, `config`, `catalog`, `projects`, `session-new/open/delete`, `save`, `import`, `peaks`, `rec-peaks`, `rec-check`, `export`, `export-estimate`, `download`, `reveal`, `pick-folder`, `samples`, `sample-upload`, `find-sections`, `sections`, `align`, `video-align`, `master-assist`, `templates`, `template`, `settings-library`, `channel-save/read/delete`, `mix-save/read`, `settings-upload`, `settings-apply`, `project-export/import`, `plugins`, `plugin-params`, `plugin-param`, `scenes`, `scene-save/delete/load`, `mixer-reset`, `bus-add/remove`, `lock`, `feedback-reset`, `loudness-reset`, `audio-restart`, `wing-names/discover/connect`.

**Listening from the phone.** The remote can play the mix through the phone's own speakers or headphones: tap the headphones button in the header (it only shows on a phone/browser, not on the computer itself). The finished master is copied (16-bit stereo, about 1.5 Mbit/s, so use Wi-Fi) into a queue by the audio callback, sent in binary WebSocket frames every 40 ms to windows that asked (`audio` message, `App.audio_loop`), and scheduled in the browser with Web Audio a quarter second ahead so Wi-Fi hiccups don't crackle (`listenHere`, `onAudioData` in `web/commands.js`). There is about a quarter second of delay, so it is for monitoring, not for playing along. It is the mix as the stream hears it (no headphone correction, click or before/after), and silent while the engine is asleep (nothing playing and no input). Nothing is copied when nobody is listening.

**Phone remote.** Off by default. When on (Setup > Phone remote) the server listens on the network and the same UI runs in a phone's browser, optionally behind a PIN (a login page sets a cookie). Because every window is just a view of the same state, a phone and the computer always agree.

---

## 19. The user interface, file by file

The UI is plain JavaScript (no framework). Shared pieces (`web/app.js`):
- `S` is the shared state: `S.mixer` (the whole mix), `S.session`, `S.info`, `S.tr` (transport), `S.meters`.
- `on(event, fn)` / `emit(event)` is a tiny event bus.
- `setParam(path, value)` changes a setting locally **at once**, queues a send (in a 16 ms timer, *not* `requestAnimationFrame`, which stalls in background tabs), mirrors to a linked stereo partner, and is refused when the mix is locked. The server broadcasts `set` to everyone else, and each control listens (`bind`) and updates itself (knobs glide there with a small animation).
- `api(name, body)` calls an HTTP route; `tryApi` also shows an error toast.
- Theme: Auto (follow the computer), Light or Dark. Colours are CSS variables; canvas drawings read the same colours through `window.CV` and redraw when the theme changes. The choice is saved in the config (the app window can't keep browser storage).

| File | What it is |
|---|---|
| `index.html` | The page skeleton: header (logo, transport, tabs, status), the six views, the channel editor overlay. |
| `style.css` | All styling and both themes. |
| `widgets.js` | `h()` (element builder), `Knob` (drag; Shift = fine; double-click = reset; scroll only works after you click it or with Alt/Option, so scrolling the page can't change a setting), `Fader` (dB scale, jumps to a click), `Meter`, formatters (`fmt`), and `drawEqCurve` (EQ response and spectrum). |
| `app.js` | Connection, state, `setParam`, transport buttons, views, keyboard, theme, `modal`, `toast`. |
| `commands.js` | **One registry of every command** (name, menu, shortcut, action). The keyboard, the native menu bar (through `runCmd`), right-click menus and the shortcuts sheet (⌘/) all read it, so they always agree. Also: tempo dialog, tuner, Master to target dialog, align / find songs / video line-up dialogs, the whole-kit drum triggers dialog, service lock, A/B. |
| `timeline.js` | The Edit view (section 9) and the export window. |
| `mixer.js` | The Mixer view: strips (gain, EQ thumbnail, badges for the chain, compressor meter, sends, pan, mute/solo/bypass, automation mode, fader and meter), banks (Inputs, 1-16, 17-32, 33-48, Buses, FX, DCA), scenes, **and the channel editor**. |
| `master.js` | The Master view. |
| `routing.js` | The Routing map: Inputs → Channels → Group buses → Music/Speech/FX → Broadcast → Master → Outputs & cables, with the links drawn. |
| `setup.js` | Setup as a sidebar with one section at a time: Audio, Stream & listen, WING, Phone remote, Appearance, Storage, Help. Rare settings are folded under "Advanced". |
| `console.js` | The WING page. |
| `home.js` | The welcome screen, the project loader bar. |
| `icons.js` | The icon set and the instrument picker. |

**The channel editor** (`openEditor` in `mixer.js`). Click a strip's name or EQ thumbnail. A window opens, dimming the mixer behind it: **Esc**, a click outside, or the ✕ closes it, and **← →** step between channels. On the left, the **signal chain** (drag to reorder, the power icon switches a module on/off, a live activity bar shows what each is doing, + Add effect). On the right, the **panel of the selected module** (the `modulePanel` function: one branch per type, each built from knobs, selects and toggles and bound to the module's settings with `M('setting')`). The first entry is "Input & routing" (instrument, input, output, gain, align delay, polarity, stereo pair, presets, save/load a sound); the last is "Sends & fader". Header buttons: Tuner, Bypass, Copy, Paste, Reset.

**Live readings in the editor.** The server only computes per-module readings (gain reduction, trigger hits, ride amount, tune note, proximity cut) for the strip that is open (`focus`), and sends them in each meter message; `edLive` in `mixer.js` paints them.

**Keyboard shortcuts** (a few): Space play, R record, C cycle, K metronome, ⇧K count-in, ⌘Z/⇧⌘Z undo/redo, ⌘T split, ⌘J join, M marker, V/B/G tools, F follow, Z fit, `\` A/B compare, ⌘1-4 for Edit, Mixer, Routing and Master, ⌘, for Setup, ⌘/ the full list, ⌘⇧L lock, ⌥⇧S/M clear solos/mutes, ⌥⇧H headphone correction, ⌘U tuner.

**Native menu bar.** `run.py` has a `MENUS` table (File, Edit, Transport, View, Mix, Window, Help). Each item calls `runCmd(name)` in the page. On the Mac it adds the key equivalents and the real system cut/copy/paste actions.

**Accessibility of wording.** The app avoids anything that looks like "AI" branding (no sparkle icons, no "assistant" names): the mastering tool is called "Master to target".

---

## 20. Building, releasing and testing

### Run from source
```
.venv/bin/python run.py              # the app window
.venv/bin/python run.py --browser    # in the browser
.venv/bin/python run.py --no-browser # headless, for phones
```
Testing uses `STOBITE_HOME=<a scratch folder>` so your real projects are never touched, and `STOBITE_PORT=8731` so it doesn't clash with the installed app (port 8730). Audio tests use VB-Cable or synthetic signals, never your real microphones.

### Build
- Mac: `./build_mac.sh` builds `dist/Stobite-Compact-mac-Apple-Silicon.dmg` for the Mac it runs on; `./build_mac.sh intel` builds the Intel one on an Apple-silicon Mac (it runs Python as Intel under Rosetta, in `.venv-intel`). Apple-silicon and Intel need separate builds because numpy, scipy and pedalboard are compiled per chip. Uses PyInstaller (`Stobite Compact.spec`), then a disk image with an Applications shortcut.
- Windows: `build_windows.bat` on a Windows PC (Python 3.12; with Inno Setup 6 it also makes `Stobite-Compact-Setup.exe` from `installer/windows.iss`).

### Release: `rebuild-compact "what changed"` (`scripts/update-compact.sh`)
1. Checks every Python and JavaScript file for errors.
2. Works out the next version (v1.4.2 → v1.4.3; `--minor`, `--major`).
3. Builds the Apple-silicon and Intel DMGs **on this Mac** (`--no-intel` skips Intel). If a build fails, nothing has been pushed.
4. Commits, pushes, tags.
5. Publishes the GitHub release with the DMGs (`gh release create`; uploading uses no GitHub Actions minutes) and copies them to `~/Downloads/Stobite Compact vX.Y.Z`.
6. Windows is *not* built by default (to save GitHub Actions minutes). `--windows` builds it on GitHub for this release; `--windows-only` builds it for the latest release; or run `build_windows.bat` on the Windows PC for free.
7. Offers to install the new Mac app.
The GitHub workflow (`.github/workflows/build.yml`) only runs when started by hand, and builds Windows only unless the "mac" box is ticked.

### Compatibility notes
- The code must stay compatible with **Python 3.9** (the Intel build uses Xcode's Python); no `match` statements or `X | None` type hints.
- `scipy.signal` is deliberately **not** imported (the compiled filter kernel is loaded directly) to keep memory use low.
- `stobite/headphones.json` is bundled by the `.spec` file's `datas`.

---

## 21. Glossary

| Word | Meaning |
|---|---|
| **Block** | A short piece of audio (256 samples ≈ 5 ms) processed at once. |
| **Sample** | One number of audio. 48,000 per second. Also a recorded drum sound in the trigger. |
| **dB / dBFS** | Decibels; dBFS is relative to the loudest digital level (0 dBFS). Quieter is negative. |
| **LUFS** | Loudness measured the way ears hear it. -14 LUFS is typical for streaming. |
| **True peak (dBTP)** | The highest level after reconstruction between samples. Keep under -1. |
| **Latency** | Delay added by a process. |
| **PDC** | Plug-in/processing delay compensation: lining channels up when one is delayed. |
| **Biquad** | The basic filter building block (two memory values). |
| **Threshold / Ratio / Attack / Release / Knee** | Compressor settings: when it starts, how hard, how fast it starts and recovers, how gradually it starts. |
| **Sidechain** | Using another signal to control a processor. |
| **Bus** | A mixing group that channels are sent to. |
| **Send / return** | A copy of a channel sent to a shared effect, and that effect's output. |
| **Ducking** | Turning something down while another thing is loud. |
| **Parallel compression** | Blending a compressed copy with the original. |
| **Mid / Side** | Centre (L+R) and sides (L-R) of a stereo mix; Width changes the sides. |
| **Polarity** | Whether the wave is upside down. |
| **OSC** | The message format the WING speaks over the network. |
| **ASIO / WASAPI / WDM-KS / MME** | Windows audio drivers; ASIO is the lowest-delay one. |
| **YIN** | The pitch-detection method used by auto-tune and the tuner. |
| **GCC-PHAT** | A way to find the delay between two signals, used by the feedback guard. |
| **LR4** | Linkwitz-Riley crossover that splits frequencies and sums back flat. |
| **Clip** | A reference to part of a recording on the timeline. |
| **Take** | One recording pass. |
