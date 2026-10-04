# Stobite Compact

A multitrack recorder, editor, mixer and mastering app for the **Behringer WING Compact**, for Mac and Windows. It has a built-in **browser remote**, so anyone on the same Wi-Fi can mix from a phone, including from outside the room.

## The cable

**One USB cable: USB-A (or USB-C) to USB-B** (the square "printer" type).

- Plug the **B end** into the **USB port on the back panel** of the WING Compact. This is the audio-interface port. The front USB-A socket is for USB sticks.
- That single cable carries **48 channels in and 48 channels out** at 48 kHz.
- **Mac:** nothing to install. The WING appears as a 48-channel audio device.
- **Windows:** install the **WING USB/ASIO driver** from behringer.com (WING Compact → Downloads), then pick the device marked **ASIO** in Setup.
- On the WING, open **ROUTING → Outputs → USB** and send the channel **direct outs (pre-fader)** to USB 1–48. Recordings are then clean and unaffected by live fader moves.
- For the **WING tab** (remote control of the console itself), also connect the WING's **Ethernet** port to the same router as the computer and phones.

Keep the USB cable under 5 m, or use a powered/active extension.

## Shipping an update

Install the command once (see below), then from any Terminal:

```
update compact "What changed"
```

It checks the code, commits and pushes, tags the next version, waits while GitHub builds the Mac DMG and the Windows installer, downloads both to `~/Downloads/Stobite Compact vX.Y.Z`, and offers to install the new Mac app. Use `update compact --minor "..."` for bigger releases.

## Run it

| | |
|---|---|
| Mac app | `dist/Stobite Compact.app`: drag it to Applications. On first launch, click **Allow** when macOS asks for microphone access (that is how it hears the WING). |
| Mac from source | double-click `Start Stobite Compact.command` |
| Windows from source | double-click `start_windows.bat` (needs Python 3.12 from python.org) |
| Build Windows .exe | run `build_windows.bat` on a Windows PC, or push to GitHub and run the **Build apps** action (`.github/workflows/build.yml`) to get both the Mac and Windows builds |
| Rebuild Mac app | `./build_mac.sh` |

`run.py --no-browser` runs it headless. The phone remote still works.

## What's in it

Stobite Compact is a **second, independent mixer** for the livestream. The WING keeps mixing the room; this app receives every channel **raw** over USB and never changes the WING.

**Signal flow:** WING inputs → channel strip → group bus → Music / Vocal / Preaching / FX → Broadcast → Master → stream (and virtual cables). The **Routing** tab draws this map and lets you re-route anything.

- **Channels:** an input picker (any WING USB input or virtual cable), drag-to-reorder, an instrument icon library (click the icon), gain/trim, phase, 12/24/48 dB low and high cuts, 4-band parametric EQ (bell, shelves, notch, high/low-pass), gate/expander, compressor (with parallel mix), de-esser, dynamic EQ, transient shaper, saturation (tape/tube/console/soft clip), **auto-tune** (pitch correction to the song key, with retune speed, amount and voice range), pan, sends, VST3/AU inserts, and peak/RMS meters.
- **Buses:** Lead Vocal, Backing Vocals, Drums, Bass, Guitars, Keys, Other, Music, Preaching, FX and Broadcast, plus your own. Each has EQ, compressor (sidechain-able, parallel), saturation, dynamic EQ, 3-band multiband, width/balance, lookahead true-peak limiter, **ducking**, sends and inserts, in a **reorderable, bypassable chain**.
- **FX:** Vocal Plate, Vocal Hall, Instrument Verb (pre-delay, decay, size, damping, width, early reflections, return EQ) and a tempo-synced Delay (1/2, 1/4, dotted, 1/8, triplet, ms; feedback, filters, width, ping-pong, tap tempo), all duckable.
- **Master:** LUFS momentary/short-term/integrated, max true peak, loudness range, RMS, spectrum, phase correlation with a mono warning, Mono/Side/L/R listen checks, configurable targets (−10 to −23 LUFS), and loudness-targeted export.
- **Presets:** 21 source presets (Lead/Worship/Background vocal, Preaching, Kick, Snare, Toms, Hi-hat, Overheads, Room, Bass, Electric/Acoustic guitar, Piano, Keys, Pad…) and bus presets (Vocal, Drum, Music, Speech, Broadcast, Worship Master). **Load worship broadcast template** (Routing tab) sets up every bus at once.
- **Scenes:** Pre-Service, Worship, Preaching… with a **recall scope** (faders, mutes, EQ, dynamics, sends, FX, routing) and recall-safe channels.
- **Automation:** Off/Read/Touch on every channel, bus, FX return and the master: volume, pan, mute, sends, bus and FX levels, ducking, plug-in parameters.
- **Edit:** 48-track raw recording, split/trim/move/fades, ripple range delete, markers, loop, **drag-and-drop audio import**, export of the mix or separate tracks: WAV / AIFF (16, 24 or 32-bit float), FLAC (16/24), MP3 (64–320 kbps constant) or Opus (64–256 kbps), stereo or mono, with a live estimate of the file size and free disk space.
- **Virtual cables:** 4 stereo cables (speaker and microphone at once). Attach BlackHole 16ch (Mac) or VB-Cable (Windows) to send them to OBS or Zoom.
- **Phone remote:** the same app at the address shown in Setup. The optional WING tab (off by default, Setup) can control the console itself.

## Carrying a service between church and home

- **Project file:** Edit → Export → *Project file* makes one `.stobite` file with every recording, edit, automation and the whole mix. On another computer: Edit → Import, drag it onto the timeline, or Setup → *Open a project file*.
- **A channel's sound:** in a channel's editor, *Save this sound…* stores its processing chain, sends and routing as a `.stobite-channel` file in your sound library. *Load a sound…* puts it on any channel, so your piano sound works on any piano.
- **The whole mix:** Mixer → *Mix settings* → Save makes a folder with one file per channel plus one for the buses, effects and master. Apply matches channels by name (then instrument, then position), lets you check the matches, then applies them.

## Projects home page

The app opens on a **welcome screen** (like Logic or CapCut) that closes once a project is open. It lists every service you've recorded, with when it was last changed, its length, track count and size. Open or Delete each one (on a Mac, Delete moves it to the Trash), start a **New project**, or **Open a project file** (`.stobite`) brought from another computer. To switch project later, click the logo or the project name at the top right, or press Ctrl/Cmd+O (Ctrl/Cmd+N makes a new one).

## Any microphone as an input

A channel's input can be a WING input, a virtual cable, or **any other microphone or interface the computer sees** (built-in mic, USB mic, webcam, a second interface). These have their own clock, so keep the important sources on the WING.

## Processing chains

Every channel, bus and the master has an ordered chain: add any processor as many times as you like, drag to reorder, and bypass, duplicate or remove each one. The order is the order the sound goes through.

## On a Mac

Closing the window only hides it, like Notes: recording, the audio and the phone remote keep running. Click the Dock icon to bring it back; Quit (⌘Q) saves and exits.

The **phone remote** is off by default (Setup). When off, only this computer can reach the app.

## Two ways to fix the room sound from outside

1. **WING tab (recommended for live).** Your phone moves the console's own faders. There is zero added delay.
2. **USB returns.** In Setup, turn on "Send each processed channel back to the WING" and set the WING channel sources to USB. The WING then uses this app's EQ, compression and effects live. It adds a few milliseconds of delay, so use a 64–128 buffer.

## Files

Sessions, recordings, scenes and exports are saved in `~/Stobite Compact/`. Recording uses about 0.52 GB per channel per hour (24 channels for 2 hours is about 25 GB; all 48 is about 25 GB per hour), so disarm unused channels.

## Shortcuts

Space play/stop · R record · L loop · A cycle automation view · S split · ⌫ delete · V/B/G pointer/blade/range · M marker · ⌘Z / ⇧⌘Z undo/redo · ⌘S save · +/−/0 zoom · ←/→ jump between markers · F follow playhead · ⌘/Ctrl-scroll zoom
