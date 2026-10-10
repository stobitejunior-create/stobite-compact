"""Insert effects for any channel or bus: reverb, delay, chorus, flanger, phaser, tremolo,
auto-filter, distortion, bitcrusher, pitch shift and a gain utility.

Each one is a chain module like the EQ or compressor: add it anywhere in a chain, as often as
you like. Most are built on Spotify's pedalboard (already used for plug-ins), with a wet/dry
"mix" so they can be used subtly. Channels are mono, buses stereo.
"""
import math

import numpy as np

try:
    import pedalboard as pb
except Exception:  # pragma: no cover - optional
    pb = None

KINDS = ("denoise", "reverb", "delay", "chorus", "flanger", "phaser", "tremolo", "autofilter", "distortion", "bitcrush", "pitch", "gain")

NOTE_BEATS = {"1/2": 2.0, "1/4": 1.0, "1/4d": 1.5, "1/8": 0.5, "1/8d": 0.75, "1/8t": 1 / 3, "1/16": 0.25}

tempo_fn = lambda: 120.0   # set by the mixer: the session tempo, for synced delays and tremolos


class Denoiser:
    """Removes steady background noise (hiss, hum, air-con, buzz) while leaving speech and music.

    Short overlapping FFT frames; in every frequency band the noise floor is tracked continuously
    (it follows the quietest level and creeps up slowly, so it re-learns if the noise changes).
    Bands near that floor are turned down by up to `reduction` dB; the gain is smoothed in time
    and across neighbouring bands so it doesn't warble. Adds 8 ms of delay."""

    N, HOP = 512, 128

    def __init__(self, fs, nch):
        self.fs, self.nch = fs, nch
        n = self.N
        self.win = np.sqrt(np.hanning(n + 1)[:n]).astype(np.float64)   # sqrt-Hann: analysis x synthesis = Hann
        self.inbuf = np.zeros((nch, n))
        self.outbuf = np.zeros((nch, n))
        self.pending = np.zeros((nch, 0))
        self.ready = np.zeros((nch, 0))
        bins = n // 2 + 1
        self.noise = np.full((nch, bins), 1.0)
        self.gain = np.ones((nch, bins))
        self.frames_seen = 0
        self.reduction, self.sens = 12.0, 1.0
        self.smooth = None
        self.started = False

    def set(self, p):
        self.reduction = float(np.clip(p.get("reduction", 12), 0, 40))
        self.sens = float(np.clip(p.get("sensitivity", 50), 0, 100)) / 50.0   # 1.0 = normal

    def _frame(self, frame):
        X = np.fft.rfft(frame * self.win, axis=1)
        mag = np.abs(X)
        # noise floor per band: smooth the level over ~40 ms, follow its quiet points, and let it
        # creep back up slowly (~1 dB/s) so it re-learns when the noise changes
        self.smooth = mag if self.smooth is None else 0.7 * self.smooth + 0.3 * mag
        up = 10 ** (1.0 / 20 * self.HOP / self.fs)
        self.noise = np.where(self.smooth < self.noise, self.smooth, self.noise * up)
        self.frames_seen += 1
        floor = 10 ** (-self.reduction / 20)
        # the smoothed minimum sits below the average noise: x1.6 brings it back up to the average
        level = np.maximum(self.smooth, 0.5 * mag)              # the smoothed level, but let real onsets through at once
        snr = level / np.maximum(self.noise * 1.6 * (1.0 + 1.5 * self.sens), 1e-12)
        g = np.clip(snr - 1.0, 0.0, 1.0)                      # 0 at the threshold, 1 at twice it
        g = floor + (1 - floor) * g
        g = np.convolve(g.ravel(), np.ones(3) / 3, "same").reshape(g.shape)   # smooth across bands
        att = g > self.gain                                   # open fast, close more gently
        self.gain = np.where(att, 0.4 * self.gain + 0.6 * g, 0.75 * self.gain + 0.25 * g)
        if self.frames_seen < 40:                             # learning the room for the first ~100 ms
            self.gain[:] = 1.0
        return np.fft.irfft(X * self.gain, self.N, axis=1) * self.win

    def process(self, x):
        """x: (frames, ch). Output delayed by N samples."""
        xin = np.concatenate([self.pending, x.T.astype(np.float64)], axis=1)
        out_parts = []
        pos = 0
        while xin.shape[1] - pos >= self.HOP:
            hop = xin[:, pos:pos + self.HOP]
            pos += self.HOP
            self.inbuf = np.concatenate([self.inbuf[:, self.HOP:], hop], axis=1)
            y = self._frame(self.inbuf)
            self.outbuf += y
            out_parts.append(self.outbuf[:, :self.HOP] * (self.HOP * 2 / self.N))   # Hann OLA at 75% overlap
            self.outbuf = np.concatenate([self.outbuf[:, self.HOP:], np.zeros((self.nch, self.HOP))], axis=1)
        self.pending = xin[:, pos:]
        ready = np.concatenate([self.ready] + out_parts, axis=1) if out_parts else self.ready
        frames = x.shape[0]
        if ready.shape[1] < frames:                          # the very start: pad with silence
            ready = np.concatenate([np.zeros((self.nch, frames - ready.shape[1])), ready], axis=1)
        y, self.ready = ready[:, :frames], ready[:, frames:]
        return y.T.astype(np.float32)


class Effect:
    def __init__(self, kind, fs, nch):
        self.kind, self.fs, self.nch = kind, fs, nch
        self.p = {}
        self.dev = None        # the pedalboard processor, when there is one
        self.phase = 0.0       # LFO phase (tremolo, auto-filter)
        self.hold = None       # bitcrusher sample-and-hold state

    # ---- settings
    def set(self, m):
        self.p = dict(m)
        k, p = self.kind, self.p
        if k == "denoise":
            if not isinstance(self.dev, Denoiser):
                self.dev = Denoiser(self.fs, self.nch)
            self.dev.set(p)
            return
        if pb is None:
            return
        try:
            if k == "reverb":
                d = self.dev if isinstance(self.dev, pb.Reverb) else pb.Reverb()
                d.room_size = float(np.clip(p.get("size", 60) / 100, 0, 1))
                d.damping = float(np.clip(p.get("damping", 50) / 100, 0, 1))
                d.width = float(np.clip(p.get("width", 100) / 100, 0, 1))
                d.wet_level, d.dry_level = 1.0, 0.0
                self.dev = d
            elif k == "delay":
                d = self.dev if isinstance(self.dev, pb.Delay) else pb.Delay()
                d.delay_seconds = self._delay_s()
                d.feedback = float(np.clip(p.get("feedback", 30) / 100, 0, 0.95))
                d.mix = 1.0
                self.dev = d
                self._tone = self._filters(p.get("lowcut", 200), p.get("highcut", 6000))
            elif k in ("chorus", "flanger"):
                d = self.dev if isinstance(self.dev, pb.Chorus) else pb.Chorus()
                d.rate_hz = float(p.get("rate", 0.8 if k == "chorus" else 0.25))
                d.depth = float(np.clip(p.get("depth", 30 if k == "chorus" else 60) / 100, 0, 1))
                d.centre_delay_ms = float(p.get("delay", 7.0 if k == "chorus" else 1.5))
                d.feedback = float(np.clip(p.get("feedback", 0 if k == "chorus" else 50) / 100, -0.95, 0.95))
                d.mix = 1.0
                self.dev = d
            elif k == "phaser":
                d = self.dev if isinstance(self.dev, pb.Phaser) else pb.Phaser()
                d.rate_hz = float(p.get("rate", 0.5))
                d.depth = float(np.clip(p.get("depth", 50) / 100, 0, 1))
                d.centre_frequency_hz = float(p.get("centre", 1300))
                d.feedback = float(np.clip(p.get("feedback", 30) / 100, -0.95, 0.95))
                d.mix = 1.0
                self.dev = d
            elif k == "autofilter":
                mode = {"lowpass": pb.LadderFilter.Mode.LPF24, "highpass": pb.LadderFilter.Mode.HPF24,
                        "bandpass": pb.LadderFilter.Mode.BPF24}.get(p.get("mode", "lowpass"), pb.LadderFilter.Mode.LPF24)
                d = self.dev if isinstance(self.dev, pb.LadderFilter) else pb.LadderFilter()
                d.mode = mode
                d.resonance = float(np.clip(p.get("resonance", 30) / 100, 0, 0.95))
                d.drive = 1.0
                self.dev = d
            elif k == "distortion":
                self._tone = self._filters(20, p.get("tone", 6000))
            elif k == "pitch":
                d = self.dev if isinstance(self.dev, pb.PitchShift) else pb.PitchShift()
                d.semitones = float(np.clip(p.get("semitones", 12), -24, 24))
                self.dev = d
        except Exception:
            self.dev = None

    def _filters(self, lo, hi):
        if pb is None:
            return None
        return pb.Pedalboard([pb.HighpassFilter(float(max(lo, 10))), pb.LowpassFilter(float(min(hi, self.fs * 0.45)))])

    def _delay_s(self):
        p = self.p
        if p.get("sync", True):
            return float(np.clip(60.0 / max(float(tempo_fn() or 120), 20) * NOTE_BEATS.get(p.get("note", "1/4"), 1.0), 0.01, 4.0))
        return float(np.clip(p.get("time", 375) / 1000, 0.01, 4.0))

    # ---- audio
    def process(self, x, fs=None):
        """x: (frames, channels) float32. Returns the processed block (same shape)."""
        k, p = self.kind, self.p
        frames = x.shape[0]
        if frames == 0:
            return x
        mix = float(np.clip(p.get("mix", 100) / 100, 0, 1))
        if k == "denoise":
            y = self.dev.process(x)
            return (x * (1 - mix) + y * mix).astype(np.float32) if mix < 0.999 else y
        if k == "gain":
            g = 10 ** (float(p.get("gain", 0)) / 20) * (-1 if p.get("invert") else 1)
            y = x * g
            if p.get("mono") and y.shape[1] == 2:
                y[:] = y.mean(axis=1, keepdims=True)
            return y.astype(np.float32)
        if k == "tremolo":
            rate = float(p.get("rate", 4.0)) if not p.get("sync") else tempo_fn() / 60.0 / NOTE_BEATS.get(p.get("note", "1/8"), 0.5)
            depth = float(np.clip(p.get("depth", 50) / 100, 0, 1))
            ph = self.phase + 2 * math.pi * rate * np.arange(frames) / self.fs
            self.phase = float((ph[-1] + 2 * math.pi * rate / self.fs) % (2 * math.pi))
            lfo = np.sin(ph) if p.get("shape", "sine") == "sine" else np.sign(np.sin(ph))
            gl = 1 - depth * (0.5 + 0.5 * lfo)
            y = x.copy()
            if y.shape[1] == 2 and p.get("pan"):     # auto-pan: the two sides move opposite ways
                gr = 1 - depth * (0.5 - 0.5 * lfo)
                y[:, 0] *= gl; y[:, 1] *= gr
            else:
                y *= gl[:, None]
            return y.astype(np.float32)
        if k == "bitcrush":
            bits = float(np.clip(p.get("bits", 8), 2, 16))
            step = 2.0 ** (1 - bits)
            y = np.round(x / step) * step
            n = int(max(1, p.get("downsample", 1)))
            if n > 1:
                idx = (np.arange(frames) // n) * n
                y = y[np.minimum(idx, frames - 1)]
            return (x * (1 - mix) + y * mix).astype(np.float32)
        if k == "distortion":
            drive = 10 ** (float(p.get("drive", 12)) / 20)
            if p.get("flavor", "overdrive") == "fuzz":
                y = np.clip(x * drive, -1, 1)
            else:
                y = np.tanh(x * drive) / math.tanh(drive)
            if self._tone is not None:
                y = self._tone(y.T.astype(np.float32), self.fs, reset=False).T
            y *= 10 ** (float(p.get("output", 0)) / 20)
            return (x * (1 - mix) + y * mix).astype(np.float32)
        if self.dev is None:
            return x
        if k == "delay":
            want = self._delay_s()
            if abs(self.dev.delay_seconds - want) > 1e-4:     # follows tempo changes
                self.dev.delay_seconds = want
        if k == "autofilter":
            depth = float(p.get("depth", 2.0))      # octaves the cutoff sweeps
            rate = float(p.get("rate", 0.5))
            self.phase = (self.phase + 2 * math.pi * rate * frames / self.fs) % (2 * math.pi)
            self.dev.cutoff_hz = float(np.clip(float(p.get("cutoff", 1000)) * 2 ** (depth * math.sin(self.phase)), 30, self.fs * 0.45))
        y = self.dev(x.T.astype(np.float32), self.fs, reset=False).T
        if k == "delay" and self._tone is not None:
            y = self._tone(y.T.astype(np.float32), self.fs, reset=False).T
        if y.shape != x.shape:     # pitch shifting can return a different block size: keep the stream steady
            out = np.zeros_like(x)
            n = min(len(y), frames)
            out[frames - n:] = y[:n]
            y = out
        return (x * (1 - mix) + y * mix).astype(np.float32)
