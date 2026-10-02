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

- **Record:** up to 48 channels at once to 24-bit WAV, one file per channel. Arm or disarm per track.
- **Edit:** waveform timeline with split, trim, move between tracks, fades, clip gain, mute, and duplicate. **Range delete with ripple** removes a gap across every track at once. Markers, unlimited undo/redo, audio import, and **loop playback** of a selected range (⟳ or L).
- **Automation:** each track and the master has an **A** button that cycles Off → Read (green, plays back moves) → Touch (yellow, records your fader, pan and mute moves while playing, from this computer or a phone). Use the toolbar "Automation" menu to show volume, pan or mute curves. Click to add a point, drag to move it, and Alt-click or double-click to delete it. Exports include automation.
- **Mix:** every channel has trim, polarity, 12/24 dB low cut, high cut, a gate, a 4-band parametric EQ with a draggable curve, a compressor with a gain-reduction meter, a **de-esser**, a live spectrum behind the EQ, pan, mute/solo, and 4 sends to Hall, Plate, Delay and Chorus effects (each can be switched to reverb, plate, delay, chorus, phaser or doubler). It also has starting-point presets (Vocal, Kick, Bass, Acoustic, Keys, Speech), channel copy/paste, and **VST3 / Audio Unit plug-ins**.
- **Master:** EBU R128 loudness meter (momentary, short-term and integrated LUFS) with a history graph against your target, spectrum analyser, peak meters, phase correlation, and a mastering chain (tone EQ → glue compressor → saturation → stereo width → limiter). **Auto-level** sets the output gain toward the target. **Export mastered mix** measures the mix and hits the target exactly (for example −14 LUFS for YouTube and livestreams).
- **Export:** stereo WAV or MP3, or **separate tracks** with your edits applied, ready to open in Logic, Pro Tools or Cubase.
- **Scenes:** save and recall the whole mixer.
- **WING tab:** moves the real WING faders and mutes over the network for channels, aux, bus and main. There is no delay, so the room hears changes instantly.
- **Remote:** open the address shown in Setup (for example `http://192.168.1.35:8730`) on any phone. Every connected device stays in sync. You can set a PIN if guests use the Wi-Fi.
- **Undo:** ⌘Z undoes edits in the Edit view and mixer changes in the Mixer and Master views or the channel editor.

## Two ways to fix the room sound from outside

1. **WING tab (recommended for live).** Your phone moves the console's own faders. There is zero added delay.
2. **USB returns.** In Setup, turn on "Send each processed channel back to the WING" and set the WING channel sources to USB. The WING then uses this app's EQ, compression and effects live. It adds a few milliseconds of delay, so use a 64–128 buffer.

## Files

Sessions, recordings, scenes and exports are saved in `~/Stobite Compact/`. Recording all 48 channels uses about 25 GB per hour, so disarm unused channels.

## Shortcuts

Space play/stop · R record · L loop · A cycle automation view · S split · ⌫ delete · V/B/G pointer/blade/range · M marker · ⌘Z / ⇧⌘Z undo/redo · ⌘S save · +/−/0 zoom · ←/→ jump between markers · F follow playhead · ⌘/Ctrl-scroll zoom
