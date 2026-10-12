"""Real-time pitch correction ("auto-tune") for vocal channels.

Detection: YIN on the last ~40 ms of audio (FFT autocorrelation).
Correction: snap to the nearest note of the song's key/scale, glide there at
the retune speed, then shift with a two-tap crossfading delay line (low
latency, clean for the small corrections tuning needs).
Latency is about 15 ms on corrected channels only.
"""
import math

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    "pentatonic": [0, 2, 4, 7, 9],
    "chromatic": list(range(12)),
}
VOICES = {"soprano": (180, 1100), "alto": (130, 800), "tenor": (95, 600), "baritone": (75, 450), "any": (70, 1100)}


def allowed_classes(key, scale):
    root = NOTE_NAMES.index(key) if key in NOTE_NAMES else 0
    return sorted({(root + s) % 12 for s in SCALES.get(scale, SCALES["chromatic"])})


def yin(frame, fs, fmin, fmax, threshold=0.15):
    """Returns (frequency Hz, confidence 0..1) or (0, 0) if unvoiced."""
    n = len(frame)
    tmax = min(int(fs / fmin), n // 2)
    tmin = max(int(fs / fmax), 2)
    if tmax <= tmin + 2:
        return 0.0, 0.0
    x = frame - frame.mean()
    energy = float((x * x).sum())
    if energy < 1e-6 * n:  # silence
        return 0.0, 0.0
    w = n - tmax
    size = 1 << int(math.ceil(math.log2(n + tmax)))
    X = np.fft.rfft(x, size)
    acf = np.fft.irfft(X * np.conj(np.fft.rfft(x[:w], size)), size)[: tmax + 1]
    cs = np.concatenate([[0.0], np.cumsum(x * x)])
    e0 = cs[w]
    et = cs[np.arange(tmax + 1) + w] - cs[np.arange(tmax + 1)]
    d = e0 + et - 2 * acf
    d[0] = 0
    cmnd = np.ones(tmax + 1)
    run = np.cumsum(d[1:])
    cmnd[1:] = d[1:] * np.arange(1, tmax + 1) / np.maximum(run, 1e-12)
    cand = np.nonzero(cmnd[tmin:tmax] < threshold)[0]
    if not len(cand):
        return 0.0, 0.0
    t = tmin + cand[0]
    while t + 1 < tmax and cmnd[t + 1] < cmnd[t]:  # walk to the local minimum
        t += 1
    if 1 <= t < tmax:  # parabolic interpolation
        a, b, c = cmnd[t - 1], cmnd[t], cmnd[t + 1]
        den = a - 2 * b + c
        t = t + (0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0)
    return fs / t, float(max(0.0, 1.0 - cmnd[int(round(t))]))


class PitchShifter:
    """Pitch shift by reading a delay line with two moving heads, crossfaded.

    Each head drifts through a window and jumps back by one window when it reaches the end, at a
    moment its own fade weight is zero. The window is a whole number of the voice's periods
    (pitch-synchronous), so the two heads read the same part of the waveform cycle: the crossfade
    doesn't comb-filter or wobble the level, which is what made simpler shifters sound robotic."""

    def __init__(self, fs, window_ms=24.0, base_ms=2.0):
        self.fs = fs
        self.size = 1 << 15
        self.buf = np.zeros(self.size, np.float32)
        self.w = 0
        self.base = fs * base_ms / 1000
        self.Wdef = fs * window_ms / 1000
        self.heads = [[self.base, self.Wdef], [self.base + self.Wdef / 2, self.Wdef]]   # [delay, window]
        self.synced = False

    def _window(self, period):
        if not period:
            return self.Wdef
        k = max(1, int(round(0.012 * self.fs / period)))    # half a window = k whole periods (~12 ms)
        return 2 * k * period

    def process(self, x, semitones, period=None):
        n = len(x)
        size = self.size
        ar = np.arange(n)
        self.buf[(self.w + ar) % size] = x
        rate = 1.0 - 2.0 ** (semitones / 12.0)            # how fast each head's delay changes per sample
        wt = self._window(period)
        if period and not self.synced:                    # first voice: space the heads exactly half a window apart
            self.heads = [[self.base + 0.25 * wt, wt], [self.base + 0.75 * wt, wt]]
            self.synced = True
        out = np.zeros(n, np.float64)
        wsum = np.zeros(n, np.float64)
        pre = [hd[0] for hd in self.heads]
        for i, hd in enumerate(self.heads):
            d = hd[0] + rate * (ar + 1)
            W = np.full(n, hd[1])
            other = pre[1 - i] + rate * (ar + 1)              # where the other head is at each sample
            j = (np.flatnonzero(d > self.base + hd[1]) if rate > 0 else np.flatnonzero(d < self.base) if rate < 0 else [])
            if len(j):
                j = int(j[0])
                # jump while this head is silent, landing exactly half a window from the other head:
                # the two then read the same point of the voice's cycle and crossfade cleanly
                start = other[j] - wt / 2 if rate > 0 else other[j] + wt / 2
                lo, hi = self.base, self.base + wt
                start = min(max(start, lo), hi)
                d[j:] = start + rate * (ar[j:] - j)
                W[j:] = wt
                hd[1] = wt
            p = np.clip((d - self.base) / W, 0.0, 1.0)
            wgt = np.sin(np.pi * p) ** 2
            pos = (self.w + ar) - d
            i0 = np.floor(pos).astype(np.int64)
            frac = pos - i0
            s_ = self.buf[i0 % size] * (1 - frac) + self.buf[(i0 + 1) % size] * frac
            out += s_ * wgt
            wsum += wgt
            hd[0] = float(d[-1])
        self.w = (self.w + n) % size
        return (out / np.maximum(wsum, 0.35)).astype(np.float32)


class AutoTune:
    DETECT = 2048

    def __init__(self, fs):
        self.fs = fs
        self.hist = np.zeros(self.DETECT, np.float32)
        self.shifter = PitchShifter(fs)
        self.shift = 0.0
        self.freq = 0.0
        self.target = 0.0
        self.conf = 0.0
        self.count = 0
        self.p = {}
        self.recent = []
        self.centre = None
        self.period = None

    def set_params(self, p, song):
        self.p = p
        key = song.get("key", "C")
        scale = "chromatic" if p.get("scale") == "chromatic" else song.get("scale", "major")
        self.classes = allowed_classes(key, scale)
        self.fmin, self.fmax = VOICES.get(p.get("voice", "any"), VOICES["any"])

    def _nearest(self, midi):
        best, bd = midi, 99.0
        base = math.floor(midi / 12) * 12
        for octv in (base - 12, base, base + 12):
            for c in self.classes:
                cand = octv + c
                d = abs(cand - midi)
                if d < bd:
                    best, bd = cand, d
        return best

    def process(self, x):
        n = len(x)
        self.hist = np.concatenate([self.hist[n:], x]) if n < self.DETECT else x[-self.DETECT:].copy()
        self.count += 1
        p = self.p
        if self.count % 2 == 0:  # detect every other block (~100 Hz at 256 frames)
            f, conf = yin(self.hist.astype(np.float64), self.fs, self.fmin, self.fmax)
            dt = 2 * n / self.fs * 1000                      # ms since the last detection
            if f > 0 and conf > 0.5:
                midi = 69 + 12 * math.log2(f / 440.0)
                self.recent = (self.recent + [midi])[-3:]
                midi = sorted(self.recent)[len(self.recent) // 2]   # median of 3: ignores single octave slips
                self.freq, self.conf = 440.0 * 2 ** ((midi - 69) / 12), conf
                hard = p.get("style", "natural") == "hard"
                if hard:
                    # hard tune: the note centre snaps fast (~35 ms). Chasing every wobble instantly
                    # would arrive a little late and widen vibrato instead of flattening it.
                    if self.centre is None or abs(midi - self.centre) > 0.8:
                        self.centre = midi
                    self.centre += (midi - self.centre) * (1 - math.exp(-dt / 35.0))
                    centre = self.centre
                else:
                    # natural: follow where the note is centred (~150 ms), so vibrato and scoops stay
                    if self.centre is None or abs(midi - self.centre) > 0.8:
                        self.centre = midi                   # a new note: start from where they are
                    self.centre += (midi - self.centre) * (1 - math.exp(-dt / 150.0))
                    centre = self.centre
                tgt = self._nearest(centre)
                self.target = tgt
                off = tgt - centre                           # semitones away from the note
                tol = float(p.get("humanize", 12)) / 100.0   # leave notes already this close alone
                if p.get("style", "natural") != "hard" and abs(off) < tol:
                    off = 0.0
                elif p.get("style", "natural") != "hard":
                    off = off * min(1.0, (abs(off) - tol) / max(tol, 1e-3) + 0.5)   # ease in just past the tolerance
                want = off * (float(p.get("amount", 100)) / 100.0)
                self.period = self.fs / f
            else:
                self.recent = []
                self.centre = None
                want = 0.0
                self.period = None
                self.freq, self.conf = f, conf
            speed = max(float(p.get("speed", 80)), 0.0)    # retune time in ms (0 = instant)
            k = 1.0 if speed < 1 else 1 - math.exp(-dt / speed)
            self.shift += (want - self.shift) * k
            self.shift = max(min(self.shift, 2.0), -2.0)
        return self.shifter.process(x, self.shift, getattr(self, "period", None))

    def readout(self):
        if self.freq <= 0 or self.conf <= 0.5:
            return None
        midi = 69 + 12 * math.log2(self.freq / 440.0)
        note = int(round(self.target)) if self.target else int(round(midi))
        return {"note": NOTE_NAMES[note % 12] + str(note // 12 - 1), "cents": round((midi - note) * 100),
                "shift": round(self.shift * 100), "hz": round(self.freq, 1)}
